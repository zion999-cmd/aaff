// P0010.2 — Investigation Policy. Pure decision function that the RuntimeLoop
// uses to decide whether a given situation should be investigated this tick.
//
// Strict separation from the Loop itself:
//   Loop:    when to wake up, mutex, post-acquire pass
//   Policy:  what to do with each newly observed situation
//   (RuntimeKernel: how to get data — unchanged, reused as-is)
//
// "Meaningful new evidence" is intentionally narrow: it is `max evidence
// timestamp` strictly greater than the most recent investigation.updatedAt
// for the situation. Re-investigations only fire when the world has actually
// changed since the last completed turn. This is the "no wasteful
// investigation" guarantee in the user's spec.

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
  /** The most recent evidence timestamp for the situation's window, or
   *  null if no evidence is on file. */
  latestEvidenceAt: string | null;
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
 *   1. `latestEvidenceAt === null` → `no_evidence` (nothing to investigate).
 *   2. `ctx.waitingOnHuman`        → `waiting_human` (operator said "later").
 *   3. No prior investigation      → `new_situation` → investigate.
 *   4. Prior exists, status='failed' → `new_situation` (treat as a fresh attempt).
 *   5. Prior exists, status='completed' or 'investigating':
 *      a. `latestEvidenceAt > prior.updatedAt` → `meaningful_new_evidence`.
 *      b. else → `no_meaningful_change`.
 */
export const createInvestigationPolicy = (db: Db): InvestigationPolicy => {
  return {
    shouldInvestigate(ctx: PolicyContext): PolicyDecision {
      if (!ctx.situationId) {
        return { kind: 'skip', reason: 'no_situation' };
      }
      if (!ctx.latestEvidenceAt) {
        return { kind: 'skip', reason: 'no_evidence' };
      }
      if (ctx.waitingOnHuman) {
        return { kind: 'skip', reason: 'waiting_human' };
      }

      const prior = loadInvestigationFromLearningContext(db, ctx.situationId);
      if (!prior) {
        return { kind: 'investigate', reason: 'new_situation' };
      }
      if (prior.status === 'failed') {
        return { kind: 'investigate', reason: 'new_situation' };
      }
      // prior exists and is completed / investigating — compare evidence
      // timestamp to the prior's updatedAt.
      if (prior.updatedAt && ctx.latestEvidenceAt > prior.updatedAt) {
        return { kind: 'investigate', reason: 'meaningful_new_evidence' };
      }
      return { kind: 'skip', reason: 'no_meaningful_change' };
    },
  };
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
