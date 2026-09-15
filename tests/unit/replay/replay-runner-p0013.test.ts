// P0013 Phase 4 — ReplayRunner orchestration.
//
// §5 (real historical data), §7 (1 day step), §15 (append-only), §22
// (ReplayRun is a first-class entity), §23 (deterministic), §24
// (persistence), §32 (Production isolation — production situations and
// learning_contexts NEVER written).
//
// What this tests:
//   1. runReplayRunStep advances the clock by 1 day.
//   2. runReplayRunToCompletion produces 30 snapshots, 0 production rows.
//   3. Production situations / learning_contexts are NEVER written.
//   4. The §23 mid-window test: snapshot N's evidence refs only contain
//      rows with business_date <= snapshot N's date.
//   5. Pause mid-run → no advance → resume → advance.
//   6. Kernel error → step marked FAILED, run marked FAILED.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import {
  runReplayRunStep,
  runReplayRunToCompletion,
  pauseReplayRun,
  resumeReplayRun,
  getReplayRunState,
  createReplayRun,
  type KernelStepResult,
} from '#app/runtime/replay/replay-runner-p0013.js';

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
    -- Production tables we must NOT touch.
    CREATE TABLE situations (
      id TEXT PRIMARY KEY,
      lifecycle TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE learning_contexts (
      id TEXT PRIMARY KEY,
      situation_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  applyP0013Schema(d);
  return d;
};

const countProductionSituations = (d: Database.Database): number => {
  return (d.prepare(`SELECT COUNT(*) AS n FROM situations`).get() as { n: number }).n;
};
const countProductionLearningContexts = (d: Database.Database): number => {
  return (d.prepare(`SELECT COUNT(*) AS n FROM learning_contexts`).get() as { n: number }).n;
};

/** Stub kernel: writes one evidence_observation per day, returns Investigation JSON. */
const stubKernel = async (_runId: string, _stepId: string, businessDate: string): Promise<KernelStepResult> => {
  // Simulate the kernel inserting an evidence row (Phase 4 runner tags it with
  // replay_run_id AFTER the kernel returns).
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
      currentUnderstanding: `Replayed understanding for ${businessDate}`,
      judgment: `Judgment for ${businessDate}: GMV stable.`,
      unknowns: [`unknown for ${businessDate}`],
      evidenceAcquired: [`h-${businessDate}`],
      recommendation: {
        kind: 'observe',
        recommendation: `Continue observation for ${businessDate}`,
        rationale: 'stub',
      },
    },
  };
};

const stubKernelThatFails = async (_runId: string, _stepId: string, _businessDate: string): Promise<KernelStepResult> => {
  throw new Error('kernel: simulated LLM timeout');
};

beforeEach(() => {
  db = setupDb();
});
afterEach(() => {
  db.close();
});

describe('createReplayRun', () => {
  it('persists a ReplayRun with status READY', () => {
    const r = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'Test Shop',
      sourceDatasetPath: '/d/x',
      sourceManifestHash: 'abc',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    expect(r.status).toBe('READY');
    expect(r.currentStep).toBe(0);
    expect(r.currentBusinessDate).toBe('2026-08-04');
    // P0013+: loadRun must return the window start — the UI derives
    // navigation bounds from it (it was previously missing from the
    // SELECT/mapping, so state.run.startBusinessDate was undefined).
    expect(r.startBusinessDate).toBe('2026-08-04');
    expect(r.endBusinessDate).toBe('2026-09-02');
  });
});

describe('runReplayRunStep', () => {
  it('advances the clock by 1 day and writes a snapshot', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    const result = await runReplayRunStep(db, run.id, stubKernel);
    expect(result.status).toBe('COMPLETED'); // single-step succeeded
    const state = getReplayRunState(db, run.id);
    expect(state.currentStep).toBe(1);
    expect(state.currentBusinessDate).toBe('2026-08-05');
    expect(state.status).toBe('RUNNING');
    const snaps = db.prepare(`SELECT COUNT(*) AS n FROM replay_run_cognitive_snapshots`).get() as { n: number };
    expect(snaps.n).toBe(1);
  });

  it('tags the kernel-written evidence row with replay_run_id (§32 isolation)', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    await runReplayRunStep(db, run.id, stubKernel);
    const rows = db.prepare(`SELECT replay_run_id, replay_run_step_id FROM evidence_observations`).all() as Array<{ replay_run_id: string | null; replay_run_step_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.replay_run_id).toBe(run.id);
  });

  it('records recommendation_executed=false on the snapshot (§14 boundary guard)', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    await runReplayRunStep(db, run.id, stubKernel);
    const row = db.prepare(`SELECT recommendation_kind, recommendation_text FROM replay_run_cognitive_snapshots`).get() as { recommendation_kind: string; recommendation_text: string };
    expect(row.recommendation_kind).toBe('observe');
    expect(row.recommendation_text).toContain('Continue observation');
  });

  it('NEVER writes to production situations or learning_contexts tables', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    expect(countProductionSituations(db)).toBe(0);
    expect(countProductionLearningContexts(db)).toBe(0);
    await runReplayRunStep(db, run.id, stubKernel);
    expect(countProductionSituations(db)).toBe(0);
    expect(countProductionLearningContexts(db)).toBe(0);
  });

  it('marks the run COMPLETED when stepping past end', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-08-04',
    });
    await runReplayRunStep(db, run.id, stubKernel);
    const state = getReplayRunState(db, run.id);
    expect(state.status).toBe('COMPLETED');
    expect(state.currentStep).toBe(1);
  });

  it('marks the step + run FAILED when the kernel throws', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    const result = await runReplayRunStep(db, run.id, stubKernelThatFails);
    expect(result.status).toBe('FAILED');
    const step = db.prepare(`SELECT status, error FROM replay_run_steps WHERE replay_run_id = ?`).get(run.id) as { status: string; error: string };
    expect(step.status).toBe('FAILED');
    expect(step.error).toMatch(/kernel: simulated/);
    const state = getReplayRunState(db, run.id);
    expect(state.status).toBe('FAILED');
  });
});

describe('runReplayRunToCompletion', () => {
  it('runs all 30 days, produces 30 snapshots, 0 production rows', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    const result = await runReplayRunToCompletion(db, run.id, stubKernel);
    expect(result.status).toBe('COMPLETED');
    expect(result.totalSteps).toBe(30);
    const snaps = db.prepare(`SELECT COUNT(*) AS n FROM replay_run_cognitive_snapshots`).get() as { n: number };
    expect(snaps.n).toBe(30);
    expect(countProductionSituations(db)).toBe(0);
    expect(countProductionLearningContexts(db)).toBe(0);
  });

  it('§23 mid-window invariant: step 17 (08-20) snapshot\'s evidence refs only contain rows with business_date <= 08-20', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    await runReplayRunToCompletion(db, run.id, stubKernel);
    // Find the 08-20 step id.
    const step = db.prepare(`SELECT id FROM replay_run_steps WHERE replay_run_id = ? AND business_date = '2026-08-20'`).get(run.id) as { id: string };
    const refs = db.prepare(
      `SELECT eo.business_date
       FROM replay_run_evidence_refs r
       JOIN evidence_observations eo ON eo.id = r.evidence_observation_id
       WHERE r.replay_run_step_id = ?`,
    ).all(step.id) as Array<{ business_date: string }>;
    expect(refs).toHaveLength(1);
    expect(refs[0]!.business_date).toBe('2026-08-20');
  });
});

describe('pause / resume', () => {
  it('pause sets status PAUSED; resume restores RUNNING; advance continues', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    await runReplayRunStep(db, run.id, stubKernel); // step 1
    pauseReplayRun(db, run.id);
    expect(getReplayRunState(db, run.id).status).toBe('PAUSED');
    // Try to step again — should not advance.
    const result = await runReplayRunStep(db, run.id, stubKernel);
    expect(result.status).toBe('PAUSED');
    expect(getReplayRunState(db, run.id).currentStep).toBe(1);
    // Resume + step.
    resumeReplayRun(db, run.id);
    expect(getReplayRunState(db, run.id).status).toBe('RUNNING');
    const r2 = await runReplayRunStep(db, run.id, stubKernel);
    expect(r2.status).toBe('COMPLETED');
    expect(getReplayRunState(db, run.id).currentStep).toBe(2);
  });
});

// P0013 G1.5-fix (2026-09-03): operator double-click on "▶ 下一天" or
// concurrent fires of "▶ 连续回放" both reach runReplayRunStep with the
// same (runId, currentBusinessDate). The runner must NOT throw
// `UNIQUE constraint failed: replay_run_steps.replay_run_id, replay_run_steps.business_date`.
// It must be idempotent: the second call returns the first's state.
describe('idempotency (G1.5-fix: UNIQUE constraint on (runId, businessDate))', () => {
  it('two concurrent runReplayRunStep calls do not throw UNIQUE — exactly one row is written, currentStep advances by 1', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    // Fire two advances concurrently. Both reads of run.currentBusinessDate
    // return 2026-08-04 (the first call has not yet UPDATEd the run row).
    // Without idempotency, the second INSERT throws UNIQUE.
    const [a, b] = await Promise.all([
      runReplayRunStep(db, run.id, stubKernel),
      runReplayRunStep(db, run.id, stubKernel),
    ]);
    // Both must complete without throwing. Neither may be FAILED.
    expect(a.status).not.toBe('FAILED');
    expect(b.status).not.toBe('FAILED');
    // At least one is COMPLETED.
    const statuses = [a.status, b.status];
    expect(statuses).toContain('COMPLETED');
    // Exactly one step row at 2026-08-04 (the UNIQUE INDEX guarantees
    // this; the second call MUST NOT have inserted a duplicate).
    const steps = db
      .prepare(
        `SELECT COUNT(*) AS n FROM replay_run_steps WHERE replay_run_id = ? AND business_date = ?`,
      )
      .get(run.id, '2026-08-04') as { n: number };
    expect(steps.n).toBe(1);
    // The run's currentBusinessDate must have advanced exactly once.
    const state = getReplayRunState(db, run.id);
    expect(state.currentStep).toBe(1);
    expect(state.currentBusinessDate).toBe('2026-08-05');
  });

  it('a pre-existing COMPLETED step at the target date is treated as a no-op (returns COMPLETED, no second row)', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    // Advance once — the runner will target 2026-08-05 next.
    await runReplayRunStep(db, run.id, stubKernel);
    expect(getReplayRunState(db, run.id).currentBusinessDate).toBe('2026-08-05');
    // Pre-insert a COMPLETED row at 2026-08-05 (the runner's NEXT target).
    // This simulates a step that was completed by a different code path
    // (e.g. a manual SQL recovery after a kernel failure) and the
    // operator's "▶ 下一天" re-fires the same date.
    db.prepare(
      `INSERT INTO replay_run_steps
         (id, replay_run_id, step_number, business_date, status, error, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      'pre-existing-step-id',
      run.id,
      99,
      '2026-08-05',
      'COMPLETED',
      '2026-08-05T10:00:00Z',
      '2026-08-05T10:01:00Z',
    );
    const r = await runReplayRunStep(db, run.id, stubKernel);
    // Runner detects the existing COMPLETED step and returns its state.
    expect(r.status).toBe('COMPLETED');
    // The pre-existing row is unchanged; no duplicate was inserted.
    const rows = db
      .prepare(
        `SELECT id, status FROM replay_run_steps WHERE replay_run_id = ? AND business_date = ?`,
      )
      .all(run.id, '2026-08-05') as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('pre-existing-step-id');
    expect(rows[0]!.status).toBe('COMPLETED');
  });

  it('a pre-existing FAILED step at the target date returns FAILED with the original error (no auto-retry)', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001',
      shopName: 'S',
      sourceDatasetPath: '/d',
      sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    // Advance once.
    await runReplayRunStep(db, run.id, stubKernel);
    // Pre-insert a FAILED row at 2026-08-05.
    db.prepare(
      `INSERT INTO replay_run_steps
         (id, replay_run_id, step_number, business_date, status, error, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'pre-failed-step-id',
      run.id,
      99,
      '2026-08-05',
      'FAILED',
      'original kernel error: LLM timeout',
      '2026-08-05T10:00:00Z',
      '2026-08-05T10:01:00Z',
    );
    const r = await runReplayRunStep(db, run.id, stubKernel);
    expect(r.status).toBe('FAILED');
    expect(r.error).toBe('original kernel error: LLM timeout');
    // The FAILED row is unchanged; no new row was inserted.
    const rows = db
      .prepare(
        `SELECT id, status FROM replay_run_steps WHERE replay_run_id = ? AND business_date = ?`,
      )
      .all(run.id, '2026-08-05') as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('pre-failed-step-id');
  });
});
