// P0013.3 — Historical Evidence Enrichment: append-only store, stale
// invalidation, single-day re-run and continuous replay from the
// earliest stale date. Fake kernel (parser obligations are exercised
// separately on the real parse boundary); real frozen dataset on disk
// is never modified.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import {
  createReplayRun,
  runReplayRunStep,
  rerunHistoricalStep,
  resetRunToEarliestStale,
  getReplayRunState,
  type KernelStepResult,
} from '#app/runtime/replay/replay-runner-p0013.js';
import {
  appendEnrichment,
  listEnrichmentsForRun,
  visibleEnrichmentsAt,
  enrichedDates,
  EnrichmentValidationError,
} from '#app/runtime/replay/enrichment-store.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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

const DATASET = 'data/jd_acquisition_20260903_0834';
const START = '2026-08-10';
const END = '2026-08-12';

const stubKernel = async (
  _runId: string,
  _stepId: string,
  businessDate: string,
): Promise<KernelStepResult> => {
  const r = db
    .prepare(
      `INSERT INTO evidence_observations
       (shop_id, capability, data_type, business_date, business_time_bucket,
        acquired_at, content_hash, evidence_file_path, content_size, created_at)
       VALUES ('11855009','trade.overview','getSummary',?,?,'2026-09-03T10:00:00Z',?,?,1,?)`,
    )
    .run(businessDate, `${businessDate}T10`, `h-${businessDate}`, `/d/${businessDate}.json`, `${businessDate}T10:00:01Z`);
  return {
    evidenceObservationIds: [Number(r.lastInsertRowid)],
    investigation: {
      currentUnderstanding: `understanding ${businessDate}`,
      judgment: `judgment ${businessDate}`,
      unknowns: [],
      evidenceAcquired: [`h-${businessDate}`],
      recommendation: { kind: 'observe', recommendation: 'watch', rationale: 'stub' },
      confirmedAction: null,
    },
  };
};

beforeEach(() => {
  db = setupDb();
});
afterEach(() => {
  db.close();
});

const makeRun = () =>
  createReplayRun(db, {
    shopId: '11855009',
    shopName: '祁门红茶官方旗舰店',
    sourceDatasetPath: DATASET,
    sourceManifestHash: 'testhash',
    startBusinessDate: START,
    endBusinessDate: END,
  });

const runToCompletion = async (runId: string) => {
  // Three explicit steps (window is 3 days).
  for (let i = 0; i < 3; i += 1) {
    const r = await runReplayRunStep(db, runId, stubKernel);
    if (r.status !== 'COMPLETED') throw new Error(`step failed: ${r.error ?? ''}`);
  }
};

describe('appendEnrichment', () => {
  it('appends fact/action/operator_feedback records (append-only) and lists them', () => {
    const run = makeRun();
    appendEnrichment(db, run.id, { businessDate: '2026-08-11', kind: 'fact', content: ' 当天上新礼盒装 ' });
    appendEnrichment(db, run.id, { businessDate: '2026-08-11', kind: 'operator_feedback', content: '运营判断为礼赠需求' });
    const rows = listEnrichmentsForRun(db, run.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.content).toBe('当天上新礼盒装');
    expect(rows[0]?.source).toBe('operator');
    expect(rows.map((r) => r.kind)).toEqual(['fact', 'operator_feedback']);
    expect(enrichedDates(db, run.id)).toEqual(['2026-08-11']);
  });

  it('rejects bad kind, empty content and out-of-window dates', () => {
    const run = makeRun();
    expect(() =>
      appendEnrichment(db, run.id, { businessDate: '2026-08-11', kind: 'x' as never, content: 'a' }),
    ).toThrow(EnrichmentValidationError);
    expect(() =>
      appendEnrichment(db, run.id, { businessDate: '2026-08-11', kind: 'fact', content: '   ' }),
    ).toThrow(EnrichmentValidationError);
    expect(() =>
      appendEnrichment(db, run.id, { businessDate: '2026-08-01', kind: 'fact', content: 'a' }),
    ).toThrow(/outside run window/);
  });

  it('presets an enrichment on a NEVER-replayed future date without creating stale rows (consumed naturally at T)', () => {
    const run = makeRun();
    // No steps at all (run created, zero replay).
    const { staleDates } = appendEnrichment(db, run.id, {
      businessDate: '2026-08-12',
      kind: 'action',
      content: 'preset action for the last day',
    });
    expect(staleDates).toEqual([]);
    const staleCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM replay_run_steps WHERE replay_run_id=? AND enrichment_stale_at IS NOT NULL`)
        .get(run.id) as { n: number }
    ).n;
    expect(staleCount).toBe(0);
    // Preset is visible at T but not before.
    expect(visibleEnrichmentsAt(db, run.id, '2026-08-11')).toHaveLength(0);
    expect(visibleEnrichmentsAt(db, run.id, '2026-08-12').map((r) => r.content)).toEqual([
      'preset action for the last day',
    ]);
  });

  it('only exposes enrichments with business_date <= T (same boundary as evidence)', () => {
    const run = makeRun();
    appendEnrichment(db, run.id, { businessDate: '2026-08-10', kind: 'fact', content: 'f10' });
    appendEnrichment(db, run.id, { businessDate: '2026-08-12', kind: 'action', content: 'a12' });
    expect(visibleEnrichmentsAt(db, run.id, '2026-08-10').map((r) => r.content)).toEqual(['f10']);
    expect(visibleEnrichmentsAt(db, run.id, '2026-08-12').map((r) => r.content)).toEqual(['f10', 'a12']);
  });
});

describe('stale invalidation + re-runs', () => {
  it('marks T and later COMPLETED steps stale, leaves earlier days fresh; reruns one day; then replays the stale tail', async () => {
    const run = makeRun();
    await runToCompletion(run.id);
    expect(getReplayRunState(db, run.id).status).toBe('COMPLETED');

    // Baseline: frozen manifest hash before enrichment/rerun.
    const manifestPath = `${DATASET}/PROVENANCE_MANIFEST.json`;
    const beforeHash = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');

    const { staleDates } = appendEnrichment(db, run.id, {
      businessDate: '2026-08-11',
      kind: 'action',
      content: '当天 10:00 上线满 300 减 40',
    });
    expect(staleDates).toEqual(['2026-08-11', '2026-08-12']);
    const stamped = db
      .prepare(`SELECT business_date, enrichment_stale_at FROM replay_run_steps WHERE replay_run_id=? ORDER BY business_date`)
      .all(run.id) as Array<{ business_date: string; enrichment_stale_at: string | null }>;
    expect(stamped.map((s) => Boolean(s?.enrichment_stale_at))).toEqual([false, true, true]);

    // Single-day re-run: T becomes fresh, T+1 stays stale; clock untouched.
    const one = await rerunHistoricalStep(db, run.id, '2026-08-11', stubKernel);
    expect(one.status).toBe('COMPLETED');
    const afterDay = db
      .prepare(`SELECT business_date, enrichment_stale_at FROM replay_run_steps WHERE replay_run_id=? ORDER BY business_date`)
      .all(run.id) as Array<{ business_date: string; enrichment_stale_at: string | null }>;
    expect(afterDay.map((s) => Boolean(s?.enrichment_stale_at))).toEqual([false, false, true]);
    // One fresh snapshot for 08-11 carrying the new run.
    const snaps = db
      .prepare(
        `SELECT COUNT(*) AS n FROM replay_run_cognitive_snapshots snap
           JOIN replay_run_steps st ON st.id = snap.replay_run_step_id
          WHERE st.replay_run_id=? AND st.business_date='2026-08-11'`,
      )
      .get(run.id) as { n: number };
    expect(snaps.n).toBe(1);
    expect(getReplayRunState(db, run.id).status).toBe('COMPLETED');

    // Continuous replay from earliest stale = 08-12 only.
    const reset = resetRunToEarliestStale(db, run.id);
    expect(reset?.businessDate).toBe('2026-08-12');
    expect(getReplayRunState(db, run.id).currentBusinessDate).toBe('2026-08-12');
    const tailStep = await runReplayRunStep(db, run.id, stubKernel);
    expect(tailStep.status).toBe('COMPLETED');
    expect(getReplayRunState(db, run.id).status).toBe('COMPLETED');
    const finalStamps = db
      .prepare(`SELECT COUNT(*) AS n FROM replay_run_steps WHERE replay_run_id=? AND enrichment_stale_at IS NOT NULL`)
      .get(run.id) as { n: number };
    expect(finalStamps.n).toBe(0);

    // The frozen dataset manifest is byte-identical (never mutated).
    const afterHash = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
    expect(afterHash).toBe(beforeHash);
  });

  it('resetRunToEarliestStale returns null when nothing is stale', async () => {
    const run = makeRun();
    await runToCompletion(run.id);
    expect(resetRunToEarliestStale(db, run.id)).toBeNull();
  });
});
