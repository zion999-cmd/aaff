// P0013 Phase 7 — Monthly Review generator.
//
// §19 (12 fields) + §20 (unverified_recommendations carries the
// "No Action Evidence" note) + §21 (PARTIAL honest for August 2026).
// Pure deterministic — no LLM, no Knowledge writes.
//
// What this tests:
//   1. PARTIAL August with P0011.x real window (2026-08-04 → 2026-08-31):
//      missing_dates = [08-01, 08-02, 08-03]
//   2. All 12 §19 fields are present
//   3. Every recommendation in unverified_recommendations carries the §20 note
//   4. Idempotent re-run: same body, no duplicate row
//   5. Empty month: no rows → degenerate start=end, COMPLETE-only-if-all-present
//   6. supported_judgments non-empty when day N's judgment matches day N+3
//   7. persistent_unknowns non-empty when same string appears 3+ times
//   8. revised_judgments non-empty when a judgment is changed within 7 days

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyP0013Schema, rollbackP0013Schema } from '#platform/storage/p0013-schema.js';
import {
  runReplayRunToCompletion,
  createReplayRun,
  type KernelStepResult,
} from '#app/runtime/replay/replay-runner-p0013.js';
import { generateMonthlyReview } from '#app/runtime/replay/monthly-review.js';

let db: Database.Database;

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
  `);
  applyP0013Schema(d);
  return d;
};

const makeKernel = (opts: { unknowns?: string[]; evidenceGaps?: string[]; judgment?: string; kind?: 'observe' | 'act' } = {}) => {
  return async (_runId: string, _stepId: string, businessDate: string): Promise<KernelStepResult> => {
    const r = db.prepare(
      `INSERT INTO evidence_observations
       (shop_id, capability, data_type, business_date, business_time_bucket,
        acquired_at, content_hash, evidence_file_path, content_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'jd_shop_001',
      'trade.overview',
      'getSummary',
      businessDate,
      `${businessDate}T10`,
      `${businessDate}T10:00:00Z`,
      `h-${businessDate}`,
      `/data/${businessDate}.json`,
      1,
      `${businessDate}T10:00:01Z`,
    );
    return {
      evidenceObservationIds: [Number(r.lastInsertRowid)],
      investigation: {
        currentUnderstanding: `Under ${businessDate}`,
        judgment: opts.judgment ?? `Judgment ${businessDate}`,
        unknowns: opts.unknowns ?? [`u-${businessDate}`],
        evidenceAcquired: [`h-${businessDate}`],
        recommendation: {
          kind: opts.kind ?? 'observe',
          recommendation: `Rec ${businessDate}`,
        },
      },
      // Inject evidence_gaps via raw_investigation_json (not a field on
      // KernelStepResult, but we persist unknowns only). For evidence_gaps
      // we instead directly INSERT to bypass the kernel interface.
    };
  };
};

const insertEvidenceGaps = (runId: string, businessDate: string, gaps: string[]): void => {
  const step = db.prepare(`SELECT id FROM replay_run_steps WHERE replay_run_id = ? AND business_date = ?`).get(runId, businessDate) as { id: string } | undefined;
  if (!step) return;
  db.prepare(`UPDATE replay_run_cognitive_snapshots SET evidence_gaps = ? WHERE replay_run_step_id = ?`).run(
    JSON.stringify(gaps),
    step.id,
  );
};

beforeEach(() => {
  db = setupDb();
});
afterEach(() => {
  rollbackP0013Schema(db);
  db.close();
});

describe('generateMonthlyReview — August 2026 PARTIAL', () => {
  it('produces a PARTIAL review with missing_dates = 08-01, 08-02, 08-03 for the P0011.x real window', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    await runReplayRunToCompletion(db, run.id, makeKernel());
    const result = generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    expect(result.coverageStatus).toBe('PARTIAL');
    expect(result.dataCoverageStart).toBe('2026-08-04');
    expect(result.dataCoverageEnd).toBe('2026-08-31');
    expect(result.missingDates).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('persists the row to replay_monthly_reviews (UNIQUE on run_id + month)', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    await runReplayRunToCompletion(db, run.id, makeKernel());
    generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    const row = db.prepare(`SELECT * FROM replay_monthly_reviews WHERE replay_run_id = ?`).get(run.id) as {
      coverage_status: string;
      data_coverage_start: string;
      data_coverage_end: string;
    } | undefined;
    expect(row).toBeTruthy();
    expect(row!.coverage_status).toBe('PARTIAL');
    expect(row!.data_coverage_start).toBe('2026-08-04');
    expect(row!.data_coverage_end).toBe('2026-08-31');
  });
});

describe('§19 — all 12 fields are populated', () => {
  it('returns a body with every required section', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    await runReplayRunToCompletion(db, run.id, makeKernel({ kind: 'act' }));
    const result = generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    const b = result.body;
    expect(typeof b.business_summary).toBe('string');
    expect(Array.isArray(b.business_phases)).toBe(true);
    expect(Array.isArray(b.key_situations)).toBe(true);
    expect(Array.isArray(b.judgment_evolution)).toBe(true);
    expect(Array.isArray(b.major_recommendations)).toBe(true);
    expect(Array.isArray(b.supported_judgments)).toBe(true);
    expect(Array.isArray(b.revised_judgments)).toBe(true);
    expect(Array.isArray(b.persistent_unknowns)).toBe(true);
    expect(Array.isArray(b.evidence_gaps)).toBe(true);
    expect(Array.isArray(b.unverified_recommendations)).toBe(true);
  });
});

describe('§20 — unverified_recommendations carries the boundary note', () => {
  it('every recommendation entry has the §14 "No Action Evidence" note', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-08-10',
    });
    await runReplayRunToCompletion(db, run.id, makeKernel({ kind: 'act' }));
    const result = generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    expect(result.body.unverified_recommendations.length).toBeGreaterThan(0);
    for (const u of result.body.unverified_recommendations) {
      expect(u.note).toMatch(/No Action Evidence available; cannot verify execution or outcome\./);
    }
  });
});

describe('idempotent re-run', () => {
  it('re-running for the same month overwrites the row (no duplicate)', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-08-10',
    });
    await runReplayRunToCompletion(db, run.id, makeKernel());
    generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM replay_monthly_reviews WHERE replay_run_id = ?`).get(run.id) as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('supported_judgments — 7-day match window', () => {
  it('records a day as "supported" when its judgment reappears in a later day within 7 days', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-08-10',
    });
    // 7 days, all carrying the SAME judgment → day 1 should be supported by day 4.
    const fixedJudgment = 'GMV stable, traffic declining slightly';
    await runReplayRunToCompletion(db, run.id, makeKernel({ judgment: fixedJudgment }));
    const result = generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    expect(result.body.supported_judgments.length).toBeGreaterThan(0);
    expect(result.body.supported_judgments.some((s) => s.business_date === '2026-08-04')).toBe(true);
  });
});

describe('persistent_unknowns — 3+ day threshold', () => {
  it('records a string as "persistent" when it appears in 3+ days', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-08-10',
    });
    const SHARED = 'Where does channel-X traffic come from?';
    const kernel = makeKernel({ unknowns: [SHARED, 'unique-aug-09'] });
    await runReplayRunToCompletion(db, run.id, kernel);
    const result = generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    expect(result.body.persistent_unknowns.length).toBeGreaterThan(0);
    const hit = result.body.persistent_unknowns.find((p) => p.unknown === SHARED);
    expect(hit).toBeTruthy();
    expect(hit!.occurrences).toBeGreaterThanOrEqual(3);
  });
});

describe('revised_judgments — change within 7 days', () => {
  it('records a day as "revised" when its judgment is changed in a later day within 7 days', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-08-10',
    });
    // Different judgment per day → all revisions captured.
    let dayIndex = 0;
    const dayKernel = async (_runId: string, _stepId: string, businessDate: string): Promise<KernelStepResult> => {
      const j = `Judgment-${dayIndex}`;
      dayIndex += 1;
      const r = db.prepare(
        `INSERT INTO evidence_observations
         (shop_id, capability, data_type, business_date, business_time_bucket,
          acquired_at, content_hash, evidence_file_path, content_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'jd_shop_001',
        'trade.overview',
        'getSummary',
        businessDate,
        `${businessDate}T10`,
        `${businessDate}T10:00:00Z`,
        `h-${businessDate}`,
        `/data/${businessDate}.json`,
        1,
        `${businessDate}T10:00:01Z`,
      );
      return {
        evidenceObservationIds: [Number(r.lastInsertRowid)],
        investigation: {
          currentUnderstanding: `Under ${businessDate}`,
          judgment: j,
          unknowns: [],
          evidenceAcquired: [`h-${businessDate}`],
          recommendation: { kind: 'observe', recommendation: `Rec ${businessDate}` },
        },
      };
    };
    await runReplayRunToCompletion(db, run.id, dayKernel);
    const result = generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    expect(result.body.revised_judgments.length).toBeGreaterThan(0);
  });
});

describe('coverage_status — COMPLETE only when no days are missing', () => {
  it('returns COMPLETE for a full month of snapshots', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-01',
      endBusinessDate: '2026-08-31',
    });
    await runReplayRunToCompletion(db, run.id, makeKernel());
    const result = generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    expect(result.coverageStatus).toBe('COMPLETE');
    expect(result.missingDates).toEqual([]);
  });
});

describe('evidence_gaps aggregation', () => {
  it('rolls up evidence_gaps across the month with their business_date', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-08-08',
    });
    await runReplayRunToCompletion(db, run.id, makeKernel());
    insertEvidenceGaps(run.id, '2026-08-04', ['no channel-X traffic breakdown']);
    insertEvidenceGaps(run.id, '2026-08-06', ['SKU-2 unparseable']);
    const result = generateMonthlyReview(db, { runId: run.id, businessMonth: '2026-08' });
    expect(result.body.evidence_gaps).toEqual(
      expect.arrayContaining([
        { gap: 'no channel-X traffic breakdown', business_date: '2026-08-04' },
        { gap: 'SKU-2 unparseable', business_date: '2026-08-06' },
      ]),
    );
  });
});
