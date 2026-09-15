// P0013.1 — acquisition_jobs persistence.
//
// A dynamic historical acquisition is a minute-scale async job: the HTTP
// request returns immediately, a real Hermes turn runs out of band, and
// the Workspace polls job status. Job rows are the durable state machine;
// the full tool trajectory lives under the intake directory on disk.

import type Database from 'better-sqlite3';
import type { AcquisitionJobStatus } from '#platform/storage/p0013-schema.js';
import type { HistoricalEvidenceNeed } from '#shared/contracts/historical-evidence-need.js';

export interface AcquisitionJobRow {
  readonly id: string;
  readonly shopId: string;
  readonly shopName: string;
  readonly requestedStart: string;
  readonly requestedEnd: string;
  readonly status: AcquisitionJobStatus;
  readonly failureCode: string | null;
  readonly errorMessage: string | null;
  readonly hermesSessionId: string | null;
  readonly intakeDir: string;
  readonly goalText: string;
  readonly datasetDir: string | null;
  readonly datasetDirName: string | null;
  readonly manifestHash: string | null;
  readonly candidateId: string | null;
  readonly actualStart: string | null;
  readonly actualEnd: string | null;
  readonly turnNote: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

interface JobRowRaw {
  id: string;
  shop_id: string;
  shop_name: string;
  requested_start: string;
  requested_end: string;
  status: AcquisitionJobStatus;
  failure_code: string | null;
  error_message: string | null;
  hermes_session_id: string | null;
  intake_dir: string;
  goal_text: string;
  dataset_dir: string | null;
  dataset_dir_name: string | null;
  manifest_hash: string | null;
  candidate_id: string | null;
  actual_start: string | null;
  actual_end: string | null;
  turn_note: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const mapRow = (r: JobRowRaw): AcquisitionJobRow => ({
  id: r.id,
  shopId: r.shop_id,
  shopName: r.shop_name,
  requestedStart: r.requested_start,
  requestedEnd: r.requested_end,
  status: r.status,
  failureCode: r.failure_code,
  errorMessage: r.error_message,
  hermesSessionId: r.hermes_session_id,
  intakeDir: r.intake_dir,
  goalText: r.goal_text,
  datasetDir: r.dataset_dir,
  datasetDirName: r.dataset_dir_name,
  manifestHash: r.manifest_hash,
  candidateId: r.candidate_id,
  actualStart: r.actual_start,
  actualEnd: r.actual_end,
  turnNote: r.turn_note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

export interface CreateJobInput {
  readonly id: string;
  readonly need: HistoricalEvidenceNeed;
  readonly intakeDir: string;
  readonly goalText: string;
  readonly nowIso: string;
}

export const insertAcquisitionJob = (
  db: Database.Database,
  input: CreateJobInput,
): AcquisitionJobRow => {
  db.prepare(
    `INSERT INTO acquisition_jobs
       (id, shop_id, shop_name, requested_start, requested_end, status,
        intake_dir, goal_text, created_at, updated_at)
     VALUES
       (@id, @shop_id, @shop_name, @requested_start, @requested_end, 'QUEUED',
        @intake_dir, @goal_text, @now, @now)`,
  ).run({
    id: input.id,
    shop_id: input.need.subject.shopId,
    shop_name: input.need.subject.shopName,
    requested_start: input.need.window.start,
    requested_end: input.need.window.end,
    intake_dir: input.intakeDir,
    goal_text: input.goalText,
    now: input.nowIso,
  });
  return getAcquisitionJob(db, input.id) as AcquisitionJobRow;
};

export const getAcquisitionJob = (
  db: Database.Database,
  id: string,
): AcquisitionJobRow | null => {
  const row = db
    .prepare(`SELECT * FROM acquisition_jobs WHERE id = ?`)
    .get(id) as JobRowRaw | undefined;
  return row ? mapRow(row) : null;
};

export const listRecentAcquisitionJobs = (
  db: Database.Database,
  limit = 20,
): AcquisitionJobRow[] => {
  const rows = db
    .prepare(`SELECT * FROM acquisition_jobs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as JobRowRaw[];
  return rows.map(mapRow);
};

/** QUEUED/RUNNING rows left by a crashed/restarted process become INTERRUPTED. */
export const markInterruptedAcquisitionJobs = (db: Database.Database, nowIso: string): number => {
  const info = db
    .prepare(
      `UPDATE acquisition_jobs
         SET status = 'INTERRUPTED',
             failure_code = 'SERVER_RESTARTED',
             updated_at = @now,
             finished_at = @now
       WHERE status IN ('QUEUED','RUNNING')`,
    )
    .run({ now: nowIso });
  return info.changes;
};

interface UpdateInput {
  readonly status: AcquisitionJobStatus;
  readonly failureCode?: string | null;
  readonly errorMessage?: string | null;
  readonly hermesSessionId?: string | null;
  readonly datasetDir?: string | null;
  readonly datasetDirName?: string | null;
  readonly manifestHash?: string | null;
  readonly candidateId?: string | null;
  readonly actualStart?: string | null;
  readonly actualEnd?: string | null;
  readonly turnNote?: string | null;
  readonly finished?: boolean;
}

export const updateAcquisitionJob = (
  db: Database.Database,
  id: string,
  patch: UpdateInput,
  nowIso: string,
): AcquisitionJobRow => {
  const sets = ['status = @status', 'updated_at = @now'];
  const params: Record<string, string | null> = { id, now: nowIso, status: patch.status };
  const columns: Array<[keyof UpdateInput, string]> = [
    ['failureCode', 'failure_code'],
    ['errorMessage', 'error_message'],
    ['hermesSessionId', 'hermes_session_id'],
    ['datasetDir', 'dataset_dir'],
    ['datasetDirName', 'dataset_dir_name'],
    ['manifestHash', 'manifest_hash'],
    ['candidateId', 'candidate_id'],
    ['actualStart', 'actual_start'],
    ['actualEnd', 'actual_end'],
    ['turnNote', 'turn_note'],
  ];
  for (const [key, col] of columns) {
    if (patch[key] !== undefined) {
      sets.push(`${col} = @${col}`);
      params[col] = (patch[key] as string | null) ?? null;
    }
  }
  if (patch.finished) sets.push('finished_at = @now');
  db.prepare(`UPDATE acquisition_jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getAcquisitionJob(db, id) as AcquisitionJobRow;
};
