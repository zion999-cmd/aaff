// P0010.2 — Materialize a Recommendation into a WorkItem. The single fix
// for audit dead-leg #3 (Recommendation written to `body.investigation.*`
// was never mirrored to `body.outputs[]`).
//
// Idempotency: a deterministic `outputId` is derived from a fingerprint of
// the recommendation content. Re-running with the same judgment produces
// the same `outputId` and the dedup check is a single linear-time
// `outputs.some(o => o.outputId === ...)` scan. No new SQL column, no
// migration, no random suffix drift across the persistence boundary.

import type { Database as Db } from 'better-sqlite3';
import type { Recommendation } from '#shared/schemas/investigation.js';
import type { LearningContext, Situation } from '#shared/schemas/learning-context.js';
import { nowIso } from '#shared/utils/time.js';
import { fingerprint } from '#shared/utils/crypto.js';
import type { WorkItem } from '#shared/schemas/output.js';
import {
  readLearningContextBody,
  writeLearningContextBody,
} from '#app/experience/learning-context-helpers.js';
import { storeInvestigationInLearningContext } from '#app/experience/learning-context-producer.js';

export type MaterializeResult =
  | { created: true; outputId: string }
  | {
      created: false;
      reason: 'no_investigation' | 'no_recommendation' | 'duplicate';
      outputId?: string;
    };

/**
 * Minimal shape of an Investigation the materializer reads. The function
 * only inspects (recommendation, judgment, updatedAt) — it does NOT need
 * the full Knowledge-Guided Investigation contract (hypotheses, findings,
 * etc.) because the dedup fingerprint is over the recommendation content
 * only. This keeps the test surface small and the call site honest: the
 * single caller in `routes/situation-chat.ts` passes the full
 * `LearningContext['investigation']` (it satisfies this Pick<>), and tests
 * can pass a minimal object.
 */
export interface InvestigationLike {
  recommendation?: Recommendation | undefined;
  judgment?: string | undefined;
  updatedAt?: string | undefined;
}

/**
 * Persist a `recommendation` WorkItem for a situation's completed
 * investigation, idempotently. The fingerprint is over the
 * (situationId, recommendation, rationale, judgment, updatedAt) tuple, so:
 *   - same content → same outputId → no duplicate
 *   - new judgment  → different outputId → new output
 *
 * Returns a structured result. The Loop uses the `created` flag to
 * decide whether to emit the `output_created` event.
 */
export const materializeWorkItem = (
  db: Db,
  situationId: string,
  investigation: InvestigationLike | null | undefined,
): MaterializeResult => {
  if (!investigation) return { created: false, reason: 'no_investigation' };
  const recommendation = investigation.recommendation;
  if (!recommendation) return { created: false, reason: 'no_recommendation' };

  const sig = fingerprint({
    situationId,
    recommendation: recommendation.recommendation,
    rationale: recommendation.rationale,
    judgment: investigation.judgment ?? '',
    updatedAt: investigation.updatedAt ?? '',
  });
  const outputId = `out_${sig.slice(0, 16)}`;

  const read = readLearningContextBody(db, situationId);
  if (!read) return { created: false, reason: 'no_investigation' };

  const existing = (read.ctx.outputs ?? []) as WorkItem[];
  if (existing.some((o) => o.outputId === outputId)) {
    return { created: false, reason: 'duplicate', outputId };
  }

  const output: WorkItem = {
    outputId,
    situationId,
    type: 'recommendation',
    status: 'ready',
    content: recommendation.recommendation,
    resultRef: { kind: 'learning_context', ref: situationId },
    createdAt: nowIso(),
  };

  // Immutable update — the body is the source of truth, the row's body
  // string is rewritten atomically.
  const next: Record<string, unknown> = { ...read.ctx, outputs: [...existing, output] };
  writeLearningContextBody(db, situationId, next);

  return { created: true, outputId };
};

// ---- P0010.2.x — unified Recommendation → Output seam --------------------
//
// Both `/chat` (turn-end) and `/recommend` (manual regenerate) must end
// with this single function. Before this seam existed, the two routes had
// inconsistent post-write steps: `/chat` materialized a WorkItem, `/recommend`
// only wrote the recommendation to the investigation block — leaving the
// detail page with a real recommendation but no corresponding Output, the
// exact bug that produced the "已生成建议 + 生成建议 按钮" contradiction.
//
// Invariants (audit §6.8, ADR-040):
//   * Any path that produces a complete Recommendation MUST end with this
//     function. The decision "is there an Output" is bound to "does a
//     Recommendation exist", not to which HTTP route produced it.
//   * `materializeWorkItem` is idempotent on content fingerprint, so calling
//     this twice with the same Recommendation is a no-op for outputs[].
//   * The function never throws — failure is reported via the return value
//     so the route can choose to surface it (or not) without losing the
//     investigation write.

export interface WriteRecommendationResult {
  /** True iff the investigation row was updated with the new recommendation. */
  investigationPersisted: boolean;
  /** Materialize result. `no_recommendation` is returned (not thrown) when
   *  the caller passes `null` for `recommendation` — the seam is total. */
  materialize: MaterializeResult;
}

/**
 * The unified seam for "a Recommendation is now the Agent's final answer".
 *
 *  1. If `recommendation` is null/undefined, return early with
 *     `{ investigationPersisted: false, materialize: { created: false, reason: 'no_recommendation' } }`
 *     so the caller does not have to branch.
 *  2. Otherwise persist the recommendation onto the investigation block
 *     (via `storeInvestigationInLearningContext`).
 *  3. Run `materializeWorkItem` so a `recommendation` WorkItem exists
 *     in `outputs[]`. Same fingerprint → no duplicate.
 *
 * Both `/chat` (situation-chat.ts turn-end) and `/recommend`
 * (situation-chat.ts manual regenerate) MUST call this function. The two
 * call sites used to drift; this is the convergence. Passing
 * `recommendation = null` is the safe no-op path for turns that complete
 * without producing a recommendation (the prior code used to skip the
 * `materializeWorkItem` call entirely in that branch, which left the
 * audit dead-leg #3 latent in the code even when the bug was not hit).
 */
export const writeRecommendationResult = (
  db: Db,
  situation: Situation,
  investigation: NonNullable<LearningContext['investigation']>,
  recommendation: Recommendation | null | undefined,
): WriteRecommendationResult => {
  if (!recommendation) {
    return {
      investigationPersisted: false,
      materialize: { created: false, reason: 'no_recommendation' },
    };
  }

  // Step 1 — write the recommendation onto the investigation block.
  // We keep the rest of the investigation fields (judgment, hypotheses,
  // findings, etc.) intact; only `recommendation` and `updatedAt` change.
  const nextInvestigation: NonNullable<LearningContext['investigation']> = {
    ...investigation,
    recommendation,
    updatedAt: nowIso(),
  };
  let investigationPersisted = false;
  try {
    storeInvestigationInLearningContext(db, situation, nextInvestigation);
    investigationPersisted = true;
  } catch {
    // Persist failure is reported but does not block materialization.
    // The route can choose to surface this; the Loop policy treats
    // "no investigation row" as `skip` so the worst case is "the next
    // tick re-investigates and re-tries" — still correct.
    investigationPersisted = false;
  }

  // Step 2 — materialize the WorkItem. Idempotent on fingerprint.
  //
  // CRITICAL: the fingerprint MUST use the *original* investigation
  // `updatedAt` (the one that came in with `investigation`), NOT the
  // `nextInvestigation.updatedAt` we just stamped. Otherwise every
  // re-run of the seam would generate a fresh `outputId` and produce
  // duplicate WorkItems — exactly the audit dead-leg #3 we are
  // trying to fix. The seam re-stamps `updatedAt` only for the
  // persisted record; the fingerprint sees the unchanged `updatedAt`
  // (or no `updatedAt`) so the dedup check works.
  const fingerprintInvestigation = {
    ...investigation,
    recommendation,
  };
  const materialize = materializeWorkItem(db, situation.situationId, fingerprintInvestigation);

  return { investigationPersisted, materialize };
};
