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
import { nowIso } from '#shared/utils/time.js';
import { fingerprint } from '#shared/utils/crypto.js';
import type { WorkItem } from '#shared/schemas/output.js';
import {
  readLearningContextBody,
  writeLearningContextBody,
} from '#app/experience/learning-context-helpers.js';

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
