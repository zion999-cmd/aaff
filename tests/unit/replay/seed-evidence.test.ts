// P0013 Task 2 Phase B — seedReplayEvidence() now writes 4 capabilities.
//
// The seed previously wrote 3 (getSummary / getTrend / perDaySummary).
// Phase B adds `order.overview/perOrder` (one row per business_date)
// pointing to `target_b_order_detail_parsed.json` with a per-day
// content_hash. The natural-key UNIQUE INDEX requires distinct hashes
// per (shop_id, data_type, business_date, acquired_at, content_hash).
//
// Invariants pinned here:
//   1. Total rows = 1 (getSummary) + 30 (getTrend) + 30 (perDaySummary)
//      + 30 (perOrder) = 91 rows for one Replay run.
//   2. perOrder rows are visible via visibleEvidenceFor (SQL filter).
//   3. Idempotent: re-seeding the same run does NOT produce duplicates.
//   4. Each perOrder row's content_hash is distinct (per-day derived).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import { seedReplayEvidence } from '#app/runtime/replay/seed-evidence.js';
import { visibleEvidenceFor } from '#app/runtime/replay/temporal-evidence-view.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DATASET_PATH = 'data/jd_acquisition_20260903_0834';
const HAS_REAL_FIXTURE = existsSync(DATASET_PATH);

const setupDb = (): Database.Database => {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE evidence_observations (
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
      created_at TEXT NOT NULL,
      replay_run_id TEXT,
      replay_run_step_id TEXT
    );
    CREATE UNIQUE INDEX idx_evidence_observations_natural_key
      ON evidence_observations(shop_id, data_type, business_date, acquired_at, content_hash);
  `);
  applyP0013Schema(d);
  return d;
};

describe('seedReplayEvidence — Phase B (perOrder evidence)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  const runIfFixture = (name: string, fn: () => void): void => {
    if (!HAS_REAL_FIXTURE) {
      it.skip(`${name} (gated — real P0011.x fixture not present)`, () => {});
      return;
    }
    it(name, fn);
  };

  runIfFixture('seeds 91 rows (1 + 30 + 30 + 30) for one Replay run', () => {
    const result = seedReplayEvidence(
      db,
      'run-phaseB-1',
      DATASET_PATH,
      '11855009',
      '2026-09-07T10:00:00Z',
    );
    expect(result.totalRowsInserted).toBe(91);
    const byKind = Object.fromEntries(
      result.byCapabilityDataType.map((x) => [`${x.capability}|${x.dataType}`, x.rows]),
    );
    expect(byKind['trade.overview|getSummary']).toBe(1);
    expect(byKind['trade.overview|getTrend']).toBe(30);
    expect(byKind['order.overview|perDaySummary']).toBe(30);
    expect(byKind['order.overview|perOrder']).toBe(30);
  });

  runIfFixture('perOrder rows are visible via visibleEvidenceFor at any T', () => {
    seedReplayEvidence(
      db,
      'run-phaseB-2',
      DATASET_PATH,
      '11855009',
      '2026-09-07T10:00:00Z',
    );
    const visible = visibleEvidenceFor(db, 'run-phaseB-2', '2026-08-04');
    const perOrderRows = visible.filter((v) => v.data_type === 'perOrder');
    expect(perOrderRows.length).toBe(1);
    expect(perOrderRows[0]?.business_date).toBe('2026-08-04');
    expect(perOrderRows[0]?.capability).toBe('order.overview');
  });

  runIfFixture('perOrder rows respect the temporal filter (no future leak)', () => {
    seedReplayEvidence(
      db,
      'run-phaseB-3',
      DATASET_PATH,
      '11855009',
      '2026-09-07T10:00:00Z',
    );
    const visible = visibleEvidenceFor(db, 'run-phaseB-3', '2026-08-10');
    const perOrderDates = visible
      .filter((v) => v.data_type === 'perOrder')
      .map((v) => v.business_date)
      .sort();
    expect(perOrderDates).toEqual([
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
      '2026-08-10',
    ]);
  });

  runIfFixture('re-seeding the same run is idempotent (natural-key UNIQUE INDEX)', () => {
    const first = seedReplayEvidence(
      db,
      'run-phaseB-4',
      DATASET_PATH,
      '11855009',
      '2026-09-07T10:00:00Z',
    );
    const second = seedReplayEvidence(
      db,
      'run-phaseB-4',
      DATASET_PATH,
      '11855009',
      '2026-09-07T10:00:00Z',
    );
    expect(first.totalRowsInserted).toBe(91);
    expect(second.totalRowsInserted).toBe(0);
    const total = (
      db.prepare('SELECT COUNT(*) AS c FROM evidence_observations').get() as { c: number }
    ).c;
    expect(total).toBe(91);
  });

  runIfFixture('perOrder content_hash is distinct per day (UNIQUE INDEX constraint)', () => {
    seedReplayEvidence(
      db,
      'run-phaseB-5',
      DATASET_PATH,
      '11855009',
      '2026-09-07T10:00:00Z',
    );
    const rows = db
      .prepare(
        `SELECT business_date, content_hash FROM evidence_observations
         WHERE capability = 'order.overview' AND data_type = 'perOrder'
         ORDER BY business_date ASC`,
      )
      .all() as Array<{ business_date: string; content_hash: string }>;
    expect(rows.length).toBe(30);
    const hashes = new Set(rows.map((r) => r.content_hash));
    expect(hashes.size).toBe(30);
  });

  runIfFixture('perOrder rows all point to the same parsed file (one source)', () => {
    seedReplayEvidence(
      db,
      'run-phaseB-6',
      DATASET_PATH,
      '11855009',
      '2026-09-07T10:00:00Z',
    );
    const rows = db
      .prepare(
        `SELECT DISTINCT evidence_file_path FROM evidence_observations
         WHERE capability = 'order.overview' AND data_type = 'perOrder'`,
      )
      .all() as Array<{ evidence_file_path: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.evidence_file_path).toBe(join(DATASET_PATH, 'target_b_order_detail_parsed.json'));
  });
});
