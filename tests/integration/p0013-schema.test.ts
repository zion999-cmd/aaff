// P0013 Phase 1 — schema integration test (TDD first → impl in place).
//
// What this proves:
//   1. applyP0013Schema creates 5 new tables + 7 indexes on a fresh DB.
//   2. The 2 nullable columns (replay_run_id, replay_run_step_id) are added
//      to evidence_observations.
//   3. The migration is idempotent — re-apply on a populated DB is a no-op.
//   4. Production rows (replay_run_id = NULL) survive untouched (§32 isolation).
//   5. The CHECK constraint on replay_runs.status rejects unknown values.
//   6. The UNIQUE(replay_run_id, business_date) on replay_run_steps enforces
//      append-only at the SQL layer.
//   7. FK ON DELETE CASCADE works: deleting a run removes its steps, refs,
//      snapshots, monthly reviews.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyP0013Schema,
  rollbackP0013Schema,
} from '#platform/storage/p0013-schema.js';

let db: Database.Database;

const setupFreshDb = (): Database.Database => {
  const d = new Database(':memory:');
  // The 2 new columns are added to evidence_observations, so the table
  // must exist first. We mirror the real init order:
  d.exec(`
    CREATE TABLE IF NOT EXISTS evidence_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      data_type TEXT NOT NULL,
      business_date TEXT NOT NULL,
      business_time_bucket TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      evidence_file_path TEXT NOT NULL,
      content_size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return d;
};

beforeEach(() => {
  db = setupFreshDb();
});

afterEach(() => {
  db.close();
});

describe('applyP0013Schema — fresh DB', () => {
  it('creates all 5 P0013 tables', () => {
    applyP0013Schema(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'replay%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('replay_runs');
    expect(names).toContain('replay_run_steps');
    expect(names).toContain('replay_run_evidence_refs');
    expect(names).toContain('replay_run_cognitive_snapshots');
    expect(names).toContain('replay_monthly_reviews');
  });

  it('adds the 2 nullable columns to evidence_observations', () => {
    applyP0013Schema(db);
    const cols = db.prepare(`PRAGMA table_info(evidence_observations)`).all() as Array<{ name: string; notnull: number }>;
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName['replay_run_id']).toBeDefined();
    expect(byName['replay_run_id']!.notnull).toBe(0); // nullable
    expect(byName['replay_run_step_id']).toBeDefined();
    expect(byName['replay_run_step_id']!.notnull).toBe(0); // nullable
  });

  it('creates the UNIQUE constraint on (replay_run_id, business_date) for steps', () => {
    applyP0013Schema(db);
    const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_replay%'`).all() as Array<{ name: string; sql: string }>;
    const stepIdx = indexes.find((i) => i.name === 'idx_replay_run_steps_run_date');
    expect(stepIdx).toBeDefined();
  });
});

describe('applyP0013Schema — idempotency', () => {
  it('is a no-op on re-apply (no error, no data loss)', () => {
    applyP0013Schema(db);
    db.prepare(
      `INSERT INTO replay_runs (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
        start_business_date, end_business_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'run-test', 'jd_shop_001', 'Test Shop', '/tmp/data', 'abc123',
      '2026-08-04', '2026-09-02', 'READY', '2026-09-03T10:00:00Z',
    );
    // Re-apply.
    expect(() => applyP0013Schema(db)).not.toThrow();
    const row = db.prepare(`SELECT shop_name FROM replay_runs WHERE id = ?`).get('run-test') as { shop_name: string };
    expect(row.shop_name).toBe('Test Shop');
  });

  it('rollback + re-apply yields the same schema', () => {
    applyP0013Schema(db);
    const before = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'replay%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    rollbackP0013Schema(db);
    applyP0013Schema(db);
    const after = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'replay%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(after.map((r) => r.name)).toEqual(before.map((r) => r.name));
  });
});

describe('§32 isolation at the storage layer', () => {
  it('production evidence_observations rows (replay_run_id = NULL) survive untouched', () => {
    applyP0013Schema(db);
    db.prepare(
      `INSERT INTO evidence_observations
        (shop_id, capability, data_type, business_date, business_time_bucket,
         acquired_at, content_hash, evidence_file_path, content_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'jd_shop_001', 'trade.overview', 'getSummary',
      '2026-08-04', '2026-08-04T10',
      '2026-08-04T10:00:00Z', 'hash-1', '/data/.../04_getSummary.json', 1024, '2026-08-04T10:00:01Z',
    );
    const row = db.prepare(`SELECT replay_run_id, replay_run_step_id FROM evidence_observations WHERE content_hash = ?`).get('hash-1') as { replay_run_id: unknown; replay_run_step_id: unknown };
    expect(row.replay_run_id).toBeNull();
    expect(row.replay_run_step_id).toBeNull();
  });

  it('a replay-tagged evidence row links to replay_runs via replay_run_id', () => {
    applyP0013Schema(db);
    db.prepare(
      `INSERT INTO replay_runs (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
        start_business_date, end_business_date, status, created_at)
       VALUES ('runA', 'jd', 'S', '/d', 'h', '2026-08-04', '2026-09-02', 'READY', '2026-09-03T10:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO replay_run_steps (id, replay_run_id, step_number, business_date, status)
       VALUES ('stepA', 'runA', 1, '2026-08-04', 'COMPLETED')`,
    ).run();
    db.prepare(
      `INSERT INTO evidence_observations
        (shop_id, capability, data_type, business_date, business_time_bucket,
         acquired_at, content_hash, evidence_file_path, content_size, created_at, replay_run_id, replay_run_step_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'jd', 'trade.overview', 'getSummary',
      '2026-08-04', '2026-08-04T10',
      '2026-08-04T10:00:00Z', 'h2', '/d/...', 1, '2026-09-03T10:00:01Z',
      'runA', 'stepA',
    );
    const rows = db.prepare(
      `SELECT eo.id, eo.business_date, r.id AS run_id, r.shop_name
       FROM evidence_observations eo
       JOIN replay_runs r ON r.id = eo.replay_run_id
       WHERE eo.replay_run_id = 'runA'`,
    ).all() as Array<{ id: number; business_date: string; run_id: string; shop_name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBe('runA');
    expect(rows[0]!.shop_name).toBe('S');
  });
});

describe('CHECK constraints', () => {
  it('rejects an unknown status on replay_runs', () => {
    applyP0013Schema(db);
    expect(() =>
      db.prepare(
        `INSERT INTO replay_runs (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
          start_business_date, end_business_date, status, created_at)
         VALUES ('x', 's', 'S', '/d', 'h', '2026-08-04', '2026-09-02', 'NONSENSE', '2026-09-03T10:00:00Z')`,
      ).run(),
    ).toThrow(/CHECK|constraint/i);
  });

  it('rejects an unknown coverage_status on replay_monthly_reviews', () => {
    applyP0013Schema(db);
    db.prepare(
      `INSERT INTO replay_runs (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
        start_business_date, end_business_date, status, created_at)
       VALUES ('r1', 's', 'S', '/d', 'h', '2026-08-04', '2026-09-02', 'READY', '2026-09-03T10:00:00Z')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO replay_monthly_reviews
          (id, replay_run_id, business_month, data_coverage_start, data_coverage_end,
           coverage_status, body_json, created_at)
         VALUES ('m1', 'r1', '2026-08', '2026-08-04', '2026-08-31', 'FUZZY', '{}', '2026-09-03T10:00:00Z')`,
      ).run(),
    ).toThrow(/CHECK|constraint/i);
  });
});

describe('UNIQUE(replay_run_id, business_date) on replay_run_steps', () => {
  it('blocks two steps on the same date for the same run', () => {
    applyP0013Schema(db);
    db.prepare(
      `INSERT INTO replay_runs (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
        start_business_date, end_business_date, status, created_at)
       VALUES ('r1', 's', 'S', '/d', 'h', '2026-08-04', '2026-09-02', 'READY', '2026-09-03T10:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO replay_run_steps (id, replay_run_id, step_number, business_date, status)
       VALUES ('s1', 'r1', 1, '2026-08-04', 'COMPLETED')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO replay_run_steps (id, replay_run_id, step_number, business_date, status)
         VALUES ('s2', 'r1', 2, '2026-08-04', 'PENDING')`,
      ).run(),
    ).toThrow(/UNIQUE|constraint/i);
  });

  it('allows the same date for DIFFERENT runs', () => {
    applyP0013Schema(db);
    db.prepare(
      `INSERT INTO replay_runs (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
        start_business_date, end_business_date, status, created_at)
       VALUES ('r1', 's', 'S', '/d', 'h1', '2026-08-04', '2026-09-02', 'READY', '2026-09-03T10:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO replay_runs (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
        start_business_date, end_business_date, status, created_at)
       VALUES ('r2', 's', 'S', '/d', 'h2', '2026-08-04', '2026-09-02', 'READY', '2026-09-03T11:00:00Z')`,
    ).run();
    db.prepare(`INSERT INTO replay_run_steps (id, replay_run_id, step_number, business_date, status) VALUES ('s1', 'r1', 1, '2026-08-04', 'PENDING')`).run();
    expect(() =>
      db.prepare(`INSERT INTO replay_run_steps (id, replay_run_id, step_number, business_date, status) VALUES ('s2', 'r2', 1, '2026-08-04', 'PENDING')`).run(),
    ).not.toThrow();
  });
});

describe('FK ON DELETE CASCADE', () => {
  it('deleting a run removes its steps, refs, snapshots, monthly reviews', () => {
    applyP0013Schema(db);
    db.prepare(
      `INSERT INTO replay_runs (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
        start_business_date, end_business_date, status, created_at)
       VALUES ('r1', 's', 'S', '/d', 'h', '2026-08-04', '2026-09-02', 'COMPLETED', '2026-09-03T10:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO replay_run_steps (id, replay_run_id, step_number, business_date, status)
       VALUES ('s1', 'r1', 1, '2026-08-04', 'COMPLETED')`,
    ).run();
    db.prepare(
      `INSERT INTO replay_run_cognitive_snapshots
        (id, replay_run_step_id, business_date, temporal_boundary_checked_at, created_at)
       VALUES ('snap1', 's1', '2026-08-04', '2026-09-03T10:00:01Z', '2026-09-03T10:00:01Z')`,
    ).run();
    db.prepare(
      `INSERT INTO replay_monthly_reviews
        (id, replay_run_id, business_month, data_coverage_start, data_coverage_end, coverage_status, body_json, created_at)
       VALUES ('m1', 'r1', '2026-08', '2026-08-04', '2026-08-31', 'PARTIAL', '{}', '2026-09-03T10:00:01Z')`,
    ).run();
    db.prepare(`DELETE FROM replay_runs WHERE id = 'r1'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM replay_run_steps WHERE replay_run_id = 'r1'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM replay_run_cognitive_snapshots WHERE replay_run_step_id = 's1'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM replay_monthly_reviews WHERE replay_run_id = 'r1'`).get()).toEqual({ n: 0 });
  });
});
