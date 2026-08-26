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
//
// P0010.2.2 — Recovery:
//   The policy is the single decision point for the Loop's recovery pass.
//   `recoveryHint` is set by the Loop's per-tick `listRecoverableCandidates`
//   scan (see ./recovery-candidates.ts) for situations the situation
//   producer did NOT emit on this tick. The hint is purely cosmetic for the
//   `reason` field (operator log readability); the actual go/no-go decision
//   is still content-driven + threshold-driven.
//
//   `blocked_runtime_failure` is the ONE skip reason that breaks the
//   "continuous investigation" cadence: N consecutive failed attempts
//   (default 3) with no intervening operator accept/reject/override → the
//   policy stops firing investigation on that situation. The operator
//   must explicitly POST /api/situation/:id/clear-block to resume. This
//   is the "operator-attention-required" surface of the self-healing
//   runtime — not a silent infinite retry on a broken Hermes.

import type { Database as Db } from 'better-sqlite3';
import { loadInvestigationFromLearningContext, loadLearningContext } from '#app/experience/learning-context-producer.js';
import {
  countConsecutiveFailures,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  type RecoveryKind,
} from './recovery-candidates.js';

export type PolicyDecision =
  | {
      kind: 'investigate';
      reason:
        | 'new_situation'
        | 'meaningful_new_evidence'
        | 'recovery_no_investigation'
        | 'recovery_interrupted'
        | 'recovery_failed_retryable';
    }
  | {
      kind: 'skip';
      reason:
        | 'no_evidence'
        | 'no_meaningful_change'
        | 'waiting_human'
        | 'already_investigated'
        | 'no_situation'
        | 'blocked_runtime_failure';
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
  /**
   * P0010.2.2 — set by the Loop's recovery scan when the situation was
   * NOT in the producer's current-tick output. Drives the cosmetic
   * `reason` field so the operator can see WHY the Loop is investigating
   * a brand-new situation that the producer didn't create this tick.
   * Has no effect on the actual go/no-go decision — that's still
   * content-driven. The hint just makes the log line honest.
   */
  recoveryHint?: RecoveryKind;
  /**
   * P0010.2.2 — number of consecutive failed attempts since the last
   * operator accept/reject/override. Computed by
   * `listRecoverableCandidates`; passed in so the policy can decide
   * blocked-vs-retry without re-querying the DB. The Loop computes this
   * once and threads it through.
   */
  consecutiveFailures?: number;
  /**
   * P0010.2.2 — max allowed before `blocked_runtime_failure`. Defaults to
   * 3 (matching `DEFAULT_MAX_CONSECUTIVE_FAILURES` in recovery-candidates).
   * The Loop passes this from its options so test seams can override.
   */
  maxConsecutiveFailures?: number;
}

export interface InvestigationPolicy {
  shouldInvestigate(ctx: PolicyContext): PolicyDecision;
}

/**
 * Default investigation policy. Decision tree (in order):
 *
 *   1. `latestContentHash === null` → `no_evidence` (nothing to investigate).
 *   2. `ctx.waitingOnHuman`         → `waiting_human` (operator said "later").
 *   3. P0010.2.2 — consecutive failures >= max → `blocked_runtime_failure`
 *      (operator must explicitly clear the block via /clear-block).
 *   4. No prior investigation       → `new_situation` → investigate.
 *   5. Prior exists (any status) and has a contentHash sidecar:
 *      a. Prior's recorded contentHash === latestContentHash → `no_meaningful_change`.
 *      b. Prior's recorded contentHash !== latestContentHash → `meaningful_new_evidence`.
 *   6. Prior exists with no contentHash sidecar (legacy P0010.1 / pre-P0010.2):
 *      a. Prior.status='failed' → `new_situation` (give the investigation one fresh try so the sidecar gets stamped on success/failure).
 *      b. Prior.status='completed' or 'investigating' → `no_meaningful_change` (we have no honest way to detect new evidence; defaulting to skip avoids the "infinite retry" anti-pattern on completed legacy situations).
 *
 * P0010.2.2 — Recovery reason rewriting:
 *   Steps 4-6 may return an `investigate` decision; if the Loop supplied a
 *   `recoveryHint` (meaning the situation came from the recovery scan, not
 *   the producer), the `reason` is rewritten to `recovery_*` so the log
 *   line honestly attributes why the Loop fired. The decision is the
 *   same — investigate. The hint just changes the operator-facing reason.
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
      const maxFailures = ctx.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
      // Compute the failure count from the prior learning context if the
      // Loop didn't supply one. The Loop pre-computes this for recovered
      // candidates; for new_situation path, prior is null and the count
      // is irrelevant. `humanInterventions` lives on the context (not the
      // investigation), so we need the full context here.
      const failureCount =
        ctx.consecutiveFailures ?? (() => {
          if (!prior) return 0;
          const fullCtx = loadLearningContext(db, ctx.situationId);
          return fullCtx
            ? countConsecutiveFailures(fullCtx as unknown as Record<string, unknown>)
            : 0;
        })();
      if (failureCount >= maxFailures) {
        return { kind: 'skip', reason: 'blocked_runtime_failure' };
      }

      let decision: PolicyDecision;
      if (!prior) {
        decision = { kind: 'investigate', reason: 'new_situation' };
      } else {
        // Prior exists. If a contentHash sidecar is on file, that is the
        // single source of truth for "is the underlying metric new?".
        const priorHash = readPriorContentHash(prior);
        if (priorHash !== null) {
          decision = priorHash === ctx.latestContentHash
            ? { kind: 'skip', reason: 'no_meaningful_change' }
            : { kind: 'investigate', reason: 'meaningful_new_evidence' };
        } else if (prior.status === 'failed') {
          // Legacy investigation (no sidecar) — failed. Give the
          // investigation one fresh try so the sidecar gets stamped on
          // success/failure.
          decision = { kind: 'investigate', reason: 'new_situation' };
        } else {
          // Completed or investigating legacy (no sidecar). We cannot
          // honestly compare content, and the safer default for a
          // continuous runtime is to skip rather than loop.
          decision = { kind: 'skip', reason: 'no_meaningful_change' };
        }
      }

      // Recovery-hint rewriting: the recovery scan emits hints only for
      // situations the producer did NOT create this tick (see
      // recovery-candidates.ts). The hint encodes a stronger signal than
      // the content comparison:
      //   - 'no_investigation'    — never had a complete turn; content is
      //                              by definition "new" to the Agent.
      //   - 'interrupted'         — prior turn died mid-flight on this
      //                              content. The natural decision is
      //                              skip (same content) but the recovery
      //                              scan has evidence the prior turn
      //                              never finished. Drive a fresh turn.
      //   - 'failed_retryable'    — same content, but the last attempt
      //                              failed. Below the block threshold, so
      //                              retrying on the same content is the
      //                              explicit operator intent (the recovery
      //                              scan only emits retryable candidates
      //                              when failureCount < maxFailures).
      // We rewrite the reason (or upgrade skip → investigate) based on
      // the hint, because the hint is the runtime's authoritative
      // judgment that this situation needs the next turn.
      if (ctx.recoveryHint) {
        if (ctx.recoveryHint === 'no_investigation') {
          return { kind: 'investigate', reason: 'recovery_no_investigation' };
        }
        if (ctx.recoveryHint === 'interrupted') {
          return { kind: 'investigate', reason: 'recovery_interrupted' };
        }
        if (ctx.recoveryHint === 'failed_retryable') {
          return { kind: 'investigate', reason: 'recovery_failed_retryable' };
        }
      }
      return decision;
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
