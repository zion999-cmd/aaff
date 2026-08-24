// P0010.2 — Investigation Policy. Pure decision function that the RuntimeLoop
// uses to decide whether a given situation should be investigated this tick.
//
// Strict separation from the Loop itself:
//   Loop:    when to wake up, mutex, post-acquire pass
//   Policy:  what to do with each newly observed situation
//   (RuntimeKernel: how to get data — unchanged, reused as-is)
//
// "Meaningful new evidence" is intentionally narrow: the most recent evidence
// content_hash for the situation's window is strictly different from the
// content_hash that was in effect at the most recent completed investigation.
// Re-investigations only fire when the underlying metric actually moved —
// not just when a re-acquisition wrote a new `acquired_at` to disk. This is
// the "no wasteful investigation" guarantee in the user's spec.

import type { Database as Db } from 'better-sqlite3';
import { loadInvestigationFromLearningContext } from '#app/experience/learning-context-producer.js';

export type PolicyDecision =
  | { kind: 'investigate'; reason: 'new_situation' | 'meaningful_new_evidence' }
  | {
      kind: 'skip';
      reason: 'no_evidence' | 'no_meaningful_change' | 'waiting_human' | 'already_investigated' | 'no_situation';
    };

export interface PolicyContext {
  /** The situation id under consideration. */
  situationId: string;
  /** The content_hash of the most recent evidence for the situation's
   *  window, or null if no evidence is on file. Comparing the *content*
   *  (not the save timestamp) is what makes the "no meaningful change"
   *  decision stable across re-acquisitions of the same data. */
  latestContentHash: string | null;
  /** Set of human intervention fingerprints that should pause the loop
   *  (today: any `decision: defer` intervention). */
  waitingOnHuman?: boolean;
}

export interface InvestigationPolicy {
  shouldInvestigate(ctx: PolicyContext): PolicyDecision;
}

/**
 * Default investigation policy. Decision tree (in order):
 *
 *   1. `latestContentHash === null` → `no_evidence` (nothing to investigate).
 *   2. `ctx.waitingOnHuman`         → `waiting_human` (operator said "later").
 *   3. No prior investigation       → `new_situation` → investigate.
 *   4. Prior exists (any status) and has a contentHash sidecar:
 *      a. Prior's recorded contentHash === latestContentHash → `no_meaningful_change`.
 *      b. Prior's recorded contentHash !== latestContentHash → `meaningful_new_evidence`.
 *   5. Prior exists with no contentHash sidecar (legacy P0010.1 / pre-P0010.2):
 *      a. Prior.status='failed' → `new_situation` (give the investigation one fresh try so the sidecar gets stamped on success/failure).
 *      b. Prior.status='completed' or 'investigating' → `no_meaningful_change` (we have no honest way to detect new evidence; defaulting to skip avoids the "infinite retry" anti-pattern on completed legacy situations).
 */
export const createInvestigationPolicy = (db: Db): InvestigationPolicy => {
  return {
    shouldInvestigate(ctx: PolicyContext): PolicyDecision {
      if (!ctx.situationId) {
        return { kind: 'skip', reason: 'no_situation' };
      }
      if (!ctx.latestContentHash) {
        return { kind: 'skip', reason: 'no_evidence' };
      }
      if (ctx.waitingOnHuman) {
        return { kind: 'skip', reason: 'waiting_human' };
      }

      const prior = loadInvestigationFromLearningContext(db, ctx.situationId);
      if (!prior) {
        return { kind: 'investigate', reason: 'new_situation' };
      }
      // Prior exists. If a contentHash sidecar is on file, that is the
      // single source of truth for "is the underlying metric new?".
      const priorHash = readPriorContentHash(prior);
      if (priorHash !== null) {
        return priorHash === ctx.latestContentHash
          ? { kind: 'skip', reason: 'no_meaningful_change' }
          : { kind: 'investigate', reason: 'meaningful_new_evidence' };
      }
      // Legacy investigation (no sidecar). Completed/investigating
      // legacy data is treated as "no meaningful change" — we cannot
      // honestly compare content, and the safer default for a
      // continuous runtime is to skip rather than loop. Only failed
      // legacy gets a fresh attempt so the sidecar gets stamped and
      // future ticks can compare properly.
      if (prior.status === 'failed') {
        return { kind: 'investigate', reason: 'new_situation' };
      }
      return { kind: 'skip', reason: 'no_meaningful_change' };
    },
  };
};

/** The Investigation schema is intentionally content-agnostic — it does not
 *  store the evidence contentHash. The Loop writes a sidecar marker on the
 *  investigation (an optional `evidenceContentHash` field) so the next tick
 *  can detect "same data as last time". This function reads that field with
 *  a defensive cast so older investigations (no marker) re-investigate by
 *  default — fail-open, not fail-closed. */
const readPriorContentHash = (prior: Record<string, unknown>): string | null => {
  const value = (prior as { evidenceContentHash?: unknown }).evidenceContentHash;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * Pure helper: read the Learning Context and return whether the operator
 * has deferred the situation (a `decision: defer` human intervention). Kept
 * separate so the Policy is the only thing that owns the SkipReason
 * taxonomy and the Loop just composes the two.
 */
export const isWaitingOnHuman = (db: Db, situationId: string): boolean => {
  const row = db
    .prepare('SELECT body FROM learning_contexts WHERE situation_id = ?')
    .get(situationId) as Record<string, unknown> | undefined;
  if (!row) return false;
  let ctx: Record<string, unknown>;
  try {
    ctx = JSON.parse(String(row.body ?? '{}'));
  } catch {
    return false;
  }
  if (!Array.isArray(ctx.humanInterventions)) return false;
  return ctx.humanInterventions.some((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const r = raw as { type?: unknown; content?: { decision?: unknown } };
    return r.type === 'decision' && r.content?.decision === 'defer';
  });
};
