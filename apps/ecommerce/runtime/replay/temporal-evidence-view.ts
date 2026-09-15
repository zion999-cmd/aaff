// P0013 Phase 4 — temporal-evidence-view.
//
// §3 — "No future leakage" enforced at the DATA BOUNDARY.
// The SQL is the gate. The LLM prompt is built from this filtered set only.

import type Database from 'better-sqlite3';

export interface VisibleEvidence {
  readonly id: number;
  readonly shop_id: string;
  readonly capability: string;
  readonly data_type: string;
  readonly business_date: string;
  readonly business_time_bucket: string;
  readonly acquired_at: string;
  readonly content_hash: string;
  readonly evidence_file_path: string;
  readonly content_size: number;
  readonly created_at: string;
  readonly replay_run_id: string | null;
  readonly replay_run_step_id: string | null;
}

/**
 * Return all evidence_observations rows tagged with `replay_run_id` whose
 * `business_date` is at or before the given Replay Business Date. Production
 * rows (replay_run_id IS NULL) are never returned.
 *
 * The result is consumed by the Agent prompt builder — it is the
 * authoritative "what does the Agent see at clock=T" set.
 */
export const visibleEvidenceFor = (
  db: Database.Database,
  replayRunId: string,
  businessDate: string,
): VisibleEvidence[] => {
  return db
    .prepare(
      `SELECT id, shop_id, capability, data_type, business_date,
              business_time_bucket, acquired_at, content_hash, evidence_file_path,
              content_size, created_at, replay_run_id, replay_run_step_id
       FROM evidence_observations
       WHERE replay_run_id = ?
         AND business_date <= ?
       ORDER BY business_date ASC, business_time_bucket ASC`,
    )
    .all(replayRunId, businessDate) as VisibleEvidence[];
};

/**
 * Tag the listed evidence_observation ids as "visible to this Replay run
 * at this step". Called by the ReplayRunner after a step completes, so
 * that subsequent steps can see the kernel's evidence via the temporal
 * filter. Production rows (not in the list) are NEVER touched.
 */
export const tagEvidenceAsReplayVisible = (
  db: Database.Database,
  evidenceIds: readonly number[],
  replayRunId: string,
  replayRunStepId: string,
): number => {
  if (evidenceIds.length === 0) return 0;
  // Use a parameterized IN clause. SQLite has a 999-bind limit; chunk if needed.
  const CHUNK = 500;
  let updated = 0;
  const update = db.prepare(
    `UPDATE evidence_observations
     SET replay_run_id = ?, replay_run_step_id = ?
     WHERE id = ? AND replay_run_id IS NULL`,
  );
  for (let i = 0; i < evidenceIds.length; i += CHUNK) {
    const slice = evidenceIds.slice(i, i + CHUNK);
    const tx = db.transaction((ids: readonly number[]) => {
      for (const id of ids) {
        const r = update.run(replayRunId, replayRunStepId, id);
        updated += r.changes;
      }
    });
    tx(slice);
  }
  return updated;
};
