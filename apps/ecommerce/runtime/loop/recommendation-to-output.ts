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
import { normalizeForFingerprint } from '#shared/utils/text.js';
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
 * only inspects (recommendation, judgment) — it does NOT need the full
 * Knowledge-Guided Investigation contract (hypotheses, findings,
 * updatedAt, etc.) because the dedup fingerprint is over the normalized
 * recommendation content + judgment. `updatedAt` is intentionally
 * excluded from the fingerprint (it is re-run metadata, not content —
 * see the materializeWorkItem docstring for the full reasoning). This
 * keeps the test surface small and the call site honest: the single
 * caller in `routes/situation-chat.ts` passes the full
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
 * (situationId, recommendation-normalized, rationale-normalized,
 * judgment) tuple, so:
 *   - same essential content → same outputId → no duplicate
 *   - new judgment  → different outputId → new output
 *
 * P0010.2.x — Why `updatedAt` is NOT in the fingerprint:
 *   `updatedAt` is metadata (when the investigation ran), not content
 *   (what the recommendation is). A re-investigation on the same
 *   Situation with a different `updatedAt` (the typical pattern:
 *   re-tick every 60s) was producing a new `outputId` on every tick,
 *   accumulating 90+ near-identical WorkItems in the audit. Dropping
 *   `updatedAt` from the fingerprint means "the same judgment + the
 *   same advice" stays the same WorkItem regardless of when the
 *   turn ran.
 *
 * P0010.2.x — Why text is NORMALIZED before fingerprinting:
 *   The LLM produces surface variations across re-runs of the same
 *   judgment — round counters ("第 7 轮" → "第 8 轮"), embedded
 *   timestamps ("18:56:48"), date stamps ("2026-08-27"), and
 *   durations ("3 天" → "5 天"). These are NOT part of the
 *   recommendation substance; they are re-run metadata. The stored
 *   WorkItem content keeps the FULL text (so the Operator sees the
 *   round count if they look), but the fingerprint sees the
 *   normalized form so two re-runs collapse to one WorkItem.
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
    recommendation: normalizeForFingerprint(recommendation.recommendation),
    rationale: normalizeForFingerprint(recommendation.rationale),
    judgment: investigation.judgment ?? '',
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
    // P0010.2.x — capture the recommendation kind at materialization
    // time. The Zod default on RecommendationSchema is 'act' (so a
    // non-C Agent that never set `kind` still materializes as a
    // yellow-chip to-do, matching the historical behavior). The
    // boundary normalizer in `runtime/investigation/normalize.ts`
    // may have rewritten `kind` to a derived value before it
    // reached this materializer; we just read the post-rewrite
    // canonical value.
    ...(recommendation.kind ? { kind: recommendation.kind } : {}),
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
  // P0010.2.x — `updatedAt` is no longer part of the fingerprint (it was
  // metadata, not content — see `materializeWorkItem`'s docstring), so we
  // no longer need the prior "preserve the original updatedAt" dance to
  // avoid a fresh outputId per re-run. The investigation we pass here
  // carries the post-stamp `updatedAt`, but `materializeWorkItem` does
  // not include `updatedAt` in the fingerprint, so re-runs with the
  // same judgment + same advice still dedup correctly.
  const materialize = materializeWorkItem(db, situation.situationId, {
    ...investigation,
    recommendation,
  });

  return { investigationPersisted, materialize };
};
