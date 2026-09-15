// P0013 — Historical Cognitive Replay storage layer.
//
// §22 (Replay Run is a first-class entity) + §24 (persistence) + §32
// (Production / Replay isolation at the storage layer). The replay_run_id
// partition key is the canonical isolation boundary: production rows
// (situations, learning_contexts, evidence_observations) stay UNCHANGED;
// replay rows are tagged with replay_run_id and live in their own tables.
//
// NOT INCLUDED: this file does NOT modify production tables. It adds new
// tables and adds 2 nullable TEXT columns to evidence_observations via a
// PRAGMA-guarded ALTER (matching the pattern in p0007-schema.ts:280-293).
// It does NOT add `source_kind` columns to situations / signals / etc. —
// the nullable replay_run_id on evidence_observations is the only bridge,
// and a run is scoped by replay_run_id at every query site.

import type Database from 'better-sqlite3';

/** P0013 §22 Replay Run status enum (mirrored in shared/utils/replay-clock.ts). */
export const REPLAY_RUN_STATUSES = [
  'READY',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  // Coverage Gap: the frozen acquisition cannot satisfy the Evidence
  // Contract for the business date the run reached. No cognition ran.
  'BLOCKED',
] as const;
export type ReplayRunStatus = typeof REPLAY_RUN_STATUSES[number];

/** P0013 §7 Daily Replay Step status enum. */
export const REPLAY_STEP_STATUSES = [
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'SKIPPED_NO_DATA',
] as const;
export type ReplayStepStatus = typeof REPLAY_STEP_STATUSES[number];

/** P0013 §21 Monthly Review coverage enum. */
export const REPLAY_COVERAGE_STATUSES = ['COMPLETE', 'PARTIAL'] as const;
export type ReplayCoverageStatus = typeof REPLAY_COVERAGE_STATUSES[number];

/** P0013.1 dynamic historical acquisition job lifecycle. */
export const ACQUISITION_JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'INTERRUPTED',
] as const;
export type AcquisitionJobStatus = typeof ACQUISITION_JOB_STATUSES[number];

/**
 * DDL for the 5 new P0013 tables. Each statement is idempotent (IF NOT
 * EXISTS). Applied via `db.exec(STATEMENTS.join(';\n'))` exactly like the
 * P0007 schema.
 */
const STATEMENTS: readonly string[] = [
  // ── replay_runs ──
  `CREATE TABLE IF NOT EXISTS replay_runs (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL,
    shop_name TEXT NOT NULL,
    source_dataset_path TEXT NOT NULL,
    source_manifest_hash TEXT NOT NULL,
    start_business_date TEXT NOT NULL,
    end_business_date TEXT NOT NULL,
    current_business_date TEXT,
    current_step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'READY'
      CHECK (status IN ('READY','RUNNING','PAUSED','COMPLETED','FAILED','BLOCKED')),
    created_at TEXT NOT NULL,
    last_advanced_at TEXT,
    completed_at TEXT,
    -- Coverage Gap detail (status = 'BLOCKED'): which business date could
    -- not be answered by the frozen acquisition, and why.
    blocked_business_date TEXT,
    blocked_reason TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_replay_runs_shop_created
    ON replay_runs (shop_id, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_replay_runs_status
    ON replay_runs (status)`,

  // ── replay_run_steps ──
  `CREATE TABLE IF NOT EXISTS replay_run_steps (
    id TEXT PRIMARY KEY,
    replay_run_id TEXT NOT NULL
      REFERENCES replay_runs(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    business_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','SKIPPED_NO_DATA')),
    cognition_snapshot_id TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE (replay_run_id, business_date)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_replay_run_steps_run_date
    ON replay_run_steps (replay_run_id, business_date)`,

  `CREATE INDEX IF NOT EXISTS idx_replay_run_steps_status
    ON replay_run_steps (replay_run_id, status)`,

  // ── replay_run_evidence_refs ──
  `CREATE TABLE IF NOT EXISTS replay_run_evidence_refs (
    replay_run_step_id TEXT NOT NULL
      REFERENCES replay_run_steps(id) ON DELETE CASCADE,
    evidence_observation_id INTEGER NOT NULL
      REFERENCES evidence_observations(id) ON DELETE CASCADE,
    PRIMARY KEY (replay_run_step_id, evidence_observation_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_replay_run_evidence_refs_obs
    ON replay_run_evidence_refs (evidence_observation_id)`,

  // ── replay_run_cognitive_snapshots ──
  `CREATE TABLE IF NOT EXISTS replay_run_cognitive_snapshots (
    id TEXT PRIMARY KEY,
    replay_run_step_id TEXT NOT NULL UNIQUE
      REFERENCES replay_run_steps(id) ON DELETE CASCADE,
    business_date TEXT NOT NULL,
    observed_facts TEXT NOT NULL DEFAULT '[]',
    current_understanding TEXT NOT NULL DEFAULT '',
    judgment TEXT NOT NULL DEFAULT '',
    recommendation_kind TEXT NOT NULL DEFAULT 'observe',
    recommendation_text TEXT NOT NULL DEFAULT '',
    unknowns TEXT NOT NULL DEFAULT '[]',
    evidence_gaps TEXT NOT NULL DEFAULT '[]',
    supporting_evidence_refs TEXT NOT NULL DEFAULT '[]',
    temporal_boundary_checked_at TEXT NOT NULL,
    raw_investigation_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_replay_snapshots_run_date
    ON replay_run_cognitive_snapshots (replay_run_step_id, business_date)`,

  // ── replay_monthly_reviews ──
  `CREATE TABLE IF NOT EXISTS replay_monthly_reviews (
    id TEXT PRIMARY KEY,
    replay_run_id TEXT NOT NULL
      REFERENCES replay_runs(id) ON DELETE CASCADE,
    business_month TEXT NOT NULL,
    data_coverage_start TEXT NOT NULL,
    data_coverage_end TEXT NOT NULL,
    coverage_status TEXT NOT NULL
      CHECK (coverage_status IN ('COMPLETE','PARTIAL')),
    missing_dates TEXT NOT NULL DEFAULT '[]',
    body_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (replay_run_id, business_month)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_replay_monthly_reviews_run
    ON replay_monthly_reviews (replay_run_id)`,

  // ── acquisition_jobs (P0013.1 dynamic historical acquisition) ──
  `CREATE TABLE IF NOT EXISTS acquisition_jobs (
    id TEXT PRIMARY KEY,
    shop_id TEXT NOT NULL,
    shop_name TEXT NOT NULL,
    requested_start TEXT NOT NULL,
    requested_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED'
      CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED','INTERRUPTED')),
    failure_code TEXT,
    error_message TEXT,
    hermes_session_id TEXT,
    intake_dir TEXT NOT NULL,
    goal_text TEXT NOT NULL,
    dataset_dir TEXT,
    dataset_dir_name TEXT,
    manifest_hash TEXT,
    candidate_id TEXT,
    actual_start TEXT,
    actual_end TEXT,
    turn_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_status
    ON acquisition_jobs (status)`,

  `CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_shop_created
    ON acquisition_jobs (shop_id, created_at DESC)`,

  // ── replay_evidence_enrichments (P0013.3 historical enrichment) ──
  //
  // Operator-provided, append-only records for a historical business
  // date: fact (objective reality), action (operational action taken),
  // operator_feedback (human judgment — explicitly NOT Observed Fact).
  // Never edits the frozen dataset; the replay kernel sees only rows
  // with business_date <= T (same Business Time boundary as evidence).
  `CREATE TABLE IF NOT EXISTS replay_evidence_enrichments (
    id TEXT PRIMARY KEY,
    replay_run_id TEXT NOT NULL
      REFERENCES replay_runs(id) ON DELETE CASCADE,
    business_date TEXT NOT NULL
      CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    kind TEXT NOT NULL CHECK (kind IN ('fact','action','operator_feedback')),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    source TEXT NOT NULL DEFAULT 'operator',
    created_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_replay_enrichments_run_date
    ON replay_evidence_enrichments (replay_run_id, business_date, created_at)`,
];

/**
 * Apply P0013 schema. Idempotent. Safe to call on a fresh DB or an existing
 * one (every CREATE is `IF NOT EXISTS`; the 2 evidence_observations columns
 * are guarded by `PRAGMA table_info`).
 */
export const applyP0013Schema = (db: Database.Database): void => {
  // 1) 5 new tables + indexes.
  db.exec(STATEMENTS.join(';\n'));

  // 2) 2 nullable columns on evidence_observations — the only bridge that
  //    connects Replay to the existing evidence store. Production rows
  //    keep `replay_run_id = NULL` (§32 isolation at the data layer).
  const hasEvidenceColumn = (col: string): boolean => {
    const rows = db.prepare(`PRAGMA table_info(evidence_observations)`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === col);
  };
  for (const col of ['replay_run_id', 'replay_run_step_id']) {
    if (!hasEvidenceColumn(col)) {
      db.exec(`ALTER TABLE evidence_observations ADD COLUMN ${col} TEXT`);
    }
  }

  // P0013.1 — acquisition_jobs existed briefly without turn_note.
  const hasJobColumn = (col: string): boolean => {
    const rows = db.prepare(`PRAGMA table_info(acquisition_jobs)`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === col);
  };
  if (!hasJobColumn('turn_note')) {
    db.exec(`ALTER TABLE acquisition_jobs ADD COLUMN turn_note TEXT`);
  }

  // P0013.3 — stale marker on replay_run_steps (set when an enrichment
  // invalidates cognition at/after a business date).
  const stepCols = db.prepare(`PRAGMA table_info(replay_run_steps)`).all() as Array<{ name: string }>;
  if (!stepCols.some((r) => r.name === 'enrichment_stale_at')) {
    db.exec(`ALTER TABLE replay_run_steps ADD COLUMN enrichment_stale_at TEXT`);
  }

  // P0013 correctness patch — replay_runs gained the BLOCKED status and the
  // coverage-gap columns. SQLite cannot ALTER a CHECK constraint, so an
  // existing table is rebuilt in place (create-copy-drop-rename). Idempotent:
  // skipped entirely once the table already allows 'BLOCKED'.
  migrateReplayRunsForBlockedStatus(db);
};

/** True when an existing replay_runs CHECK already permits 'BLOCKED'. */
const replayRunsAllowsBlocked = (db: Database.Database): boolean => {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'replay_runs'`)
    .get() as { sql: string | null } | undefined;
  return typeof row?.sql === 'string' && row.sql.includes("'BLOCKED'");
};

const replayRunsHasColumn = (db: Database.Database, column: string): boolean => {
  const cols = db.prepare(`PRAGMA table_info(replay_runs)`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
};

/**
 * Bring an existing replay_runs table up to the current contract:
 *   - status CHECK gains 'BLOCKED'
 *   - blocked_business_date / blocked_reason columns
 * Rows are preserved verbatim. Runs inside a transaction; FK enforcement is
 * disabled for the swap only (replay_run_steps references replay_runs).
 */
const migrateReplayRunsForBlockedStatus = (db: Database.Database): void => {
  const needsStatus = !replayRunsAllowsBlocked(db);
  const needsColumns =
    !replayRunsHasColumn(db, 'blocked_business_date') || !replayRunsHasColumn(db, 'blocked_reason');
  if (!needsStatus && !needsColumns) return;

  const foreignKeysWereOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
  if (foreignKeysWereOn) db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`CREATE TABLE replay_runs_migrated (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        shop_name TEXT NOT NULL,
        source_dataset_path TEXT NOT NULL,
        source_manifest_hash TEXT NOT NULL,
        start_business_date TEXT NOT NULL,
        end_business_date TEXT NOT NULL,
        current_business_date TEXT,
        current_step INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'READY'
          CHECK (status IN ('READY','RUNNING','PAUSED','COMPLETED','FAILED','BLOCKED')),
        created_at TEXT NOT NULL,
        last_advanced_at TEXT,
        completed_at TEXT,
        blocked_business_date TEXT,
        blocked_reason TEXT
      )`);
      const carried = needsColumns
        ? `id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
           start_business_date, end_business_date, current_business_date, current_step,
           status, created_at, last_advanced_at, completed_at`
        : `id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
           start_business_date, end_business_date, current_business_date, current_step,
           status, created_at, last_advanced_at, completed_at, blocked_business_date, blocked_reason`;
      db.exec(`INSERT INTO replay_runs_migrated (${carried}) SELECT ${carried} FROM replay_runs`);
      db.exec(`DROP TABLE replay_runs`);
      db.exec(`ALTER TABLE replay_runs_migrated RENAME TO replay_runs`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_replay_runs_shop_created
                 ON replay_runs (shop_id, created_at DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_replay_runs_status ON replay_runs (status)`);
    });
    tx();
  } finally {
    if (foreignKeysWereOn) db.pragma('foreign_keys = ON');
  }
};

/**
 * Roll back P0013 schema (used by integration tests only; not exposed to
 * production runtime). Drops the 5 tables + the 2 evidence_observations
 * columns. There is no production migration that calls this.
 */
export const rollbackP0013Schema = (db: Database.Database): void => {
  for (const table of [
    'acquisition_jobs',
    'replay_monthly_reviews',
    'replay_run_cognitive_snapshots',
    'replay_run_evidence_refs',
    'replay_run_steps',
    'replay_runs',
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  // SQLite cannot drop columns safely in older versions. We leave the
  // 2 nullable TEXT columns on evidence_observations. Rollback is a
  // test-only helper; the test recreates a fresh DB if it needs to.
};
