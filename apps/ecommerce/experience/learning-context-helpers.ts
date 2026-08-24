// P0010.2 — Extracted read/write helpers for the `learning_contexts.body`
// JSON column. Previously local to `platform/server/routes/outputs.ts`; the
// RuntimeLoop and the recommendation-to-output materializer also need them,
// so they live in a shared module that the Output route re-exports for
// backwards compatibility (no other call sites today, but the surface is now
// reusable).
//
// Why here and not in `platform/storage/`: the JSON body is shaped by the
// `learning_context` schema (the `LearningContextBody` type), which is an
// Ecommerce concern. The RuntimeLoop's `materializeWorkItem` writes a
// WorkItem into `body.outputs[]` and the helper handles the
// JSON-parse-or-default contract.

import type { Database as Db } from 'better-sqlite3';
import { nowIso } from '#shared/utils/time.js';

export interface LearningContextBodyRead {
  row: { body: string };
  ctx: Record<string, unknown>;
}

/**
 * Read the LearningContext body for a situation, ensuring the
 * JSON is parsed and `outputs` is always an array. Returns null when the
 * situation has no learning_context row (caller treats that as 404).
 */
export const readLearningContextBody = (
  db: Db,
  situationId: string,
): LearningContextBodyRead | null => {
  const row = db
    .prepare('SELECT body FROM learning_contexts WHERE situation_id = ?')
    .get(situationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  let ctx: Record<string, unknown>;
  try {
    ctx = JSON.parse(String(row.body ?? '{}'));
  } catch {
    return null;
  }
  if (!Array.isArray(ctx.outputs)) ctx.outputs = [];
  return { row: { body: String(row.body) }, ctx };
};

/**
 * Write a (possibly mutated) LearningContext body back. Stamps `updated_at`.
 * The caller is responsible for the immutability contract — pass a shallow
 * clone with the change applied.
 */
export const writeLearningContextBody = (
  db: Db,
  situationId: string,
  ctx: Record<string, unknown>,
): void => {
  const now = nowIso();
  db.prepare('UPDATE learning_contexts SET body = ?, updated_at = ? WHERE situation_id = ?').run(
    JSON.stringify(ctx),
    now,
    situationId,
  );
};
