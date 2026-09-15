// P0013 correctness — Coverage Gate (Evidence Contract).
//
// Root cause this pins:
//   1. coverage was derived from the trend x-axis ONLY, so a business date
//      present in the axis but carrying a null source value / no per-day
//      aggregate (and declared a gap by the acquisition itself) was treated
//      as covered;
//   2. the replay path never consulted coverage at all: POST /runs checked
//      window bounds only, and the runner ran cognition for whatever date
//      the clock pointed at.
//
// Result before the fix: Replay happily ran the Agent on an empty business
// day. After the fix: such a date is a Coverage Gap — no cognition runs, the
// run stops BLOCKED, and resolution goes through P0013.1 acquisition.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import {
  loadHistoricalDataset,
  businessDateCoverageOf,
} from '#app/runtime/replay/historical-dataset.js';
import {
  createReplayRun,
  runReplayRunStep,
  runReplayRunToCompletion,
  getReplayRunState,
  type KernelStepResult,
} from '#app/runtime/replay/replay-runner-p0013.js';

/** Dataset with a real source-empty day: 09-13 (null GMV, no order rows). */
const GAPPED_DATASET = 'data/jd_acquisition_20260914_0231';
/** Accepted reference dataset: every day covered, must not regress. */
const COMPLETE_DATASET = 'data/jd_acquisition_20260903_0834';

let db: Database.Database;

const setupDb = (): Database.Database => {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE jd_raw_data (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE jd_dataset_metadata (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE jd_collection_runs (id INTEGER PRIMARY KEY AUTOINCREMENT);
    CREATE TABLE signals (id TEXT PRIMARY KEY);
    CREATE TABLE situations (id TEXT PRIMARY KEY);
    CREATE TABLE human_interventions (id TEXT PRIMARY KEY);
    CREATE TABLE learning_contexts (
      id TEXT PRIMARY KEY, situation_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE evidence_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT NOT NULL, capability TEXT NOT NULL, data_type TEXT NOT NULL,
      business_date TEXT NOT NULL, business_time_bucket TEXT NOT NULL,
      acquired_at TEXT NOT NULL, content_hash TEXT NOT NULL, evidence_file_path TEXT NOT NULL,
      content_size INTEGER NOT NULL, created_at TEXT NOT NULL,
      replay_run_id TEXT, replay_run_step_id TEXT
    );
  `);
  applyP0013Schema(d);
  return d;
};

beforeEach(() => {
  db = setupDb();
});
afterEach(() => {
  db.close();
});

const makeRun = (start: string, end: string, dataset = GAPPED_DATASET) =>
  createReplayRun(db, {
    shopId: '11855009',
    shopName: '祁门红茶官方旗舰店',
    sourceDatasetPath: dataset,
    sourceManifestHash: 'testhash',
    startBusinessDate: start,
    endBusinessDate: end,
  });

describe('per-business-date coverage predicate (Evidence Contract)', () => {
  it('reports a source-empty day inside the dataset window as UNCOVERED with reasons', () => {
    const ds = loadHistoricalDataset(GAPPED_DATASET);
    const gap = businessDateCoverageOf(ds, '2026-09-13');
    expect(gap).not.toBeNull();
    expect(gap?.covered).toBe(false);
    expect(gap?.reasons).toContain('trend_value_missing');
    expect(gap?.reasons).toContain('declared_evidence_gap');
    expect(ds.coverage.missingBusinessDates).toContain('2026-09-13');
  });

  it('reports a day WITH real data as covered (09-12 has 97 orders)', () => {
    const ds = loadHistoricalDataset(GAPPED_DATASET);
    const covered = businessDateCoverageOf(ds, '2026-09-12');
    expect(covered?.covered).toBe(true);
    expect(covered?.reasons).toEqual([]);
  });

  it('does not regress the accepted complete dataset (every day covered)', () => {
    const ds = loadHistoricalDataset(COMPLETE_DATASET);
    expect(ds.coverage.missingBusinessDates).toEqual([]);
    expect(ds.coverage.byBusinessDate.every((c) => c.covered)).toBe(true);
  });

  it('returns null for a date outside the dataset window', () => {
    const ds = loadHistoricalDataset(GAPPED_DATASET);
    expect(businessDateCoverageOf(ds, '2026-07-01')).toBeNull();
  });
});

describe('runner Coverage Gate', () => {
  it('does NOT run cognition for an uncovered date: run stops BLOCKED, kernel never called', async () => {
    const run = makeRun('2026-09-04', '2026-09-13');
    let kernelCalls = 0;
    const kernel = async (): Promise<KernelStepResult> => {
      kernelCalls += 1;
      throw new Error('kernel must not be called for an uncovered date');
    };

    // Advance through every covered day (09-04..09-12) — cognition runs
    // normally for all of them; the cursor then points at the gap day.
    for (let i = 0; i < 9; i += 1) {
      const r = await runReplayRunStep(db, run.id, async () => ({
        evidenceObservationIds: [],
        investigation: {
          currentUnderstanding: `understanding day ${i}`,
          judgment: `judgment ${i}`,
          unknowns: [],
          evidenceAcquired: [],
          recommendation: { kind: 'observe', recommendation: 'watch' },
          confirmedAction: null,
        },
      }));
      expect(r.status).toBe('COMPLETED');
    }
    expect(getReplayRunState(db, run.id).currentBusinessDate).toBe('2026-09-13');

    // The next calendar day (09-13) has no evidence → gate must fire.
    const blocked = await runReplayRunStep(db, run.id, kernel);
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.blockedBusinessDate).toBe('2026-09-13');
    expect(kernelCalls).toBe(0);

    const state = getReplayRunState(db, run.id);
    expect(state.status).toBe('BLOCKED');
    expect(state.blockedBusinessDate).toBe('2026-09-13');
    expect(state.blockedReason).toContain('trend_value_missing');

    // No step row was written for the blocked date: no cognition happened.
    const stepRows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM replay_run_steps
          WHERE replay_run_id = ? AND business_date = '2026-09-13'`,
      )
      .get(run.id) as { n: number };
    expect(stepRows.n).toBe(0);
  });

  it('continuous replay stops at the gap instead of running past it', async () => {
    const run = makeRun('2026-09-11', '2026-09-13');
    const result = await runReplayRunToCompletion(db, run.id, async () => ({
      evidenceObservationIds: [],
      investigation: {
        currentUnderstanding: 'u',
        judgment: 'j',
        unknowns: [],
        evidenceAcquired: [],
        recommendation: { kind: 'observe', recommendation: 'watch' },
        confirmedAction: null,
      },
    }));
    expect(result.status).toBe('BLOCKED');
    // 09-11 + 09-12 executed, then the gap stopped the loop.
    expect(result.totalSteps).toBe(3);
    expect(getReplayRunState(db, run.id).status).toBe('BLOCKED');
  });

  it('a fully covered window still replays normally (no false gate)', async () => {
    const run = makeRun('2026-09-04', '2026-09-12');
    const result = await runReplayRunToCompletion(db, run.id, async () => ({
      evidenceObservationIds: [],
      investigation: {
        currentUnderstanding: 'u',
        judgment: 'j',
        unknowns: [],
        evidenceAcquired: [],
        recommendation: { kind: 'observe', recommendation: 'watch' },
        confirmedAction: null,
      },
    }));
    expect(result.status).toBe('COMPLETED');
    expect(getReplayRunState(db, run.id).status).toBe('COMPLETED');
    expect(getReplayRunState(db, run.id).blockedBusinessDate).toBeNull();
  });
});
