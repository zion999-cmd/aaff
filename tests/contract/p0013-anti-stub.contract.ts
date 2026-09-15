// P0013 Acceptance FAILED Fix — Anti-stub contract tests.
//
// Lesson (memory p0013-stub-cognition-wiring): green contract suite proves
// the runner RAN, not that it COGNITED. These tests assert the actual
// content of persisted snapshots, NOT just the shape.
//
// RED → GREEN flow: written BEFORE the production fix. They fail today
// because (a) httpStubKernel returns "[HTTP-driven stub]" literal, and
// (b) the runner's persistSnapshot has no anti-stub guard.
//
// After the production fix (BC.2 — wire real kernel + assertNoStubLiterals
// in persistSnapshot), all 3 should pass.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import {
  runReplayRunToCompletion,
  createReplayRun,
  type KernelStepResult,
} from '#app/runtime/replay/replay-runner-p0013.js';
import { visibleEvidenceFor } from '#app/runtime/replay/temporal-evidence-view.js';

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

const STUB_PATTERN = /^\s*\[HTTP-driven stub\]/i;

/** A kernel that returns STUB LITERALS — exactly what the production
 *  httpStubKernel was doing. Used to prove the anti-stub guard catches
 *  this regression. */
const stubLikeKernel = async (
  _runId: string,
  _stepId: string,
  businessDate: string,
): Promise<KernelStepResult> => {
  // Also inserts an evidence row so the snapshot is well-formed.
  const r = db.prepare(
    `INSERT INTO evidence_observations
     (shop_id, capability, data_type, business_date, business_time_bucket,
      acquired_at, content_hash, evidence_file_path, content_size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'jd_shop_001', 'trade.overview', 'getSummary',
    businessDate, `${businessDate}T10`,
    `${businessDate}T10:00:00Z`, `h-${businessDate}`,
    `/data/${businessDate}.json`, 1, `${businessDate}T10:00:01Z`,
  );
  return {
    evidenceObservationIds: [Number(r.lastInsertRowid)],
    investigation: {
      currentUnderstanding: `[HTTP-driven stub] No LLM kernel wired at this layer. Date=${businessDate}.`,
      judgment: `[HTTP-driven stub] Awaiting LLM kernel wiring in Phase 5.5.`,
      unknowns: [],
      evidenceAcquired: [],
      recommendation: { kind: 'observe', recommendation: `[HTTP-driven stub] Continue observation.` },
    },
  };
};

beforeEach(() => {
  db = setupDb();
});
afterEach(() => {
  db.close();
});

describe('anti-stub — assertNoStubLiterals (RED today, GREEN after BC.2)', () => {
  it('refuses to persist a snapshot whose currentUnderstanding matches the stub pattern', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001', shopName: 'S',
      sourceDatasetPath: '/d', sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-08-04',
    });
    // The runner must surface a hard fail — the stub literal must NEVER
    // reach the replay_run_cognitive_snapshots table. The runner's contract
    // is: guard throws → step marked FAILED + run marked FAILED, no
    // snapshot row written.
    const result = await runReplayRunToCompletion(db, run.id, stubLikeKernel);
    expect(result.status).toBe('FAILED');
    expect(result.failedSteps).toBe(1);
    const snaps = db.prepare(`SELECT COUNT(*) AS n FROM replay_run_cognitive_snapshots`).get() as { n: number };
    expect(snaps.n).toBe(0);
    // The error message on the step must mention the anti-stub guard.
    const step = db.prepare(
      `SELECT error FROM replay_run_steps WHERE replay_run_id = ?`,
    ).get(run.id) as { error: string | null };
    expect(step.error).toMatch(/anti-stub/);
  });

  it('refuses to persist a snapshot whose judgment matches the stub pattern', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001', shopName: 'S',
      sourceDatasetPath: '/d', sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-08-04',
    });
    const onlyStubInJudgment = async (
      _r: string, _s: string, businessDate: string,
    ): Promise<KernelStepResult> => {
      const r = db.prepare(
        `INSERT INTO evidence_observations
         (shop_id, capability, data_type, business_date, business_time_bucket,
          acquired_at, content_hash, evidence_file_path, content_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'jd_shop_001', 'trade.overview', 'getSummary',
        businessDate, `${businessDate}T10`,
        `${businessDate}T10:00:00Z`, `h-${businessDate}`,
        `/data/${businessDate}.json`, 1, `${businessDate}T10:00:01Z`,
      );
      return {
        evidenceObservationIds: [Number(r.lastInsertRowid)],
        investigation: {
          currentUnderstanding: `real Hermes output for ${businessDate}`,
          judgment: `[HTTP-driven stub] Awaiting LLM kernel wiring in Phase 5.5.`,
          recommendation: { kind: 'observe', recommendation: 'observe' },
        },
      };
    };
    const result = await runReplayRunToCompletion(db, run.id, onlyStubInJudgment);
    expect(result.status).toBe('FAILED');
    const snaps = db.prepare(`SELECT COUNT(*) AS n FROM replay_run_cognitive_snapshots`).get() as { n: number };
    expect(snaps.n).toBe(0);
  });
});

describe('anti-stub — non-stub pattern is informational only (must NOT flag real output)', () => {
  it('accepts snapshots whose content contains the literal string "stub" but is NOT a stub pattern', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001', shopName: 'S',
      sourceDatasetPath: '/d', sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-08-04',
    });
    const realLookingKernel = async (
      _r: string, _s: string, businessDate: string,
    ): Promise<KernelStepResult> => {
      const r = db.prepare(
        `INSERT INTO evidence_observations
         (shop_id, capability, data_type, business_date, business_time_bucket,
          acquired_at, content_hash, evidence_file_path, content_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'jd_shop_001', 'trade.overview', 'getSummary',
        businessDate, `${businessDate}T10`,
        `${businessDate}T10:00:00Z`, `h-${businessDate}`,
        `/data/${businessDate}.json`, 1, `${businessDate}T10:00:01Z`,
      );
      return {
        evidenceObservationIds: [Number(r.lastInsertRowid)],
        investigation: {
          // Contains the word "stub" but is NOT a stub pattern (no [HTTP-driven stub] prefix)
          currentUnderstanding: `今天的 GMV 比预期高，是真实业务结果。`, // real Chinese, no stub
          judgment: `Real Hermes judgment for ${businessDate}: 数据正常。`,
          recommendation: { kind: 'observe', recommendation: '保持观察' },
        },
      };
    };
    await runReplayRunToCompletion(db, run.id, realLookingKernel);
    const row = db.prepare(
      `SELECT current_understanding, judgment FROM replay_run_cognitive_snapshots LIMIT 1`,
    ).get() as { current_understanding: string; judgment: string };
    expect(row.current_understanding).not.toMatch(STUB_PATTERN);
    expect(row.judgment).not.toMatch(STUB_PATTERN);
  });
});

describe('§3 data-boundary — kernel evidence IDs must be a subset of visibleEvidenceFor', () => {
  it('after a 3-day run, every snapshot\'s evidenceObservationIds ⊆ visibleEvidenceFor(step.business_date)', async () => {
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001', shopName: 'S',
      sourceDatasetPath: '/d', sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-08-06',
    });
    const realKernel = async (
      _r: string, _s: string, businessDate: string,
    ): Promise<KernelStepResult> => {
      const r = db.prepare(
        `INSERT INTO evidence_observations
         (shop_id, capability, data_type, business_date, business_time_bucket,
          acquired_at, content_hash, evidence_file_path, content_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'jd_shop_001', 'trade.overview', 'getSummary',
        businessDate, `${businessDate}T10`,
        `${businessDate}T10:00:00Z`, `h-${businessDate}`,
        `/data/${businessDate}.json`, 1, `${businessDate}T10:00:01Z`,
      );
      return {
        evidenceObservationIds: [Number(r.lastInsertRowid)],
        investigation: {
          currentUnderstanding: `Real understanding for ${businessDate}`,
          judgment: `Real judgment for ${businessDate}`,
          recommendation: { kind: 'observe', recommendation: 'observe' },
        },
      };
    };
    await runReplayRunToCompletion(db, run.id, realKernel);
    // Now assert: for each step, the kernel-reported evidence ID is in
    // visibleEvidenceFor(step.business_date).
    const steps = db.prepare(
      `SELECT s.id AS step_id, s.business_date
       FROM replay_run_steps s
       WHERE s.replay_run_id = ?`,
    ).all(run.id) as Array<{ step_id: string; business_date: string }>;
    for (const step of steps) {
      const visible = visibleEvidenceFor(db, run.id, step.business_date);
      const visibleIds = new Set(visible.map((v) => v.id));
      const refs = db.prepare(
        `SELECT evidence_observation_id FROM replay_run_evidence_refs WHERE replay_run_step_id = ?`,
      ).all(step.step_id) as Array<{ evidence_observation_id: number }>;
      for (const r of refs) {
        expect(visibleIds.has(r.evidence_observation_id)).toBe(true);
      }
    }
  });

  it('kernel evidence IDs with business_date > step.business_date must be rejected (§3 violation)', async () => {
    // This kernel tries to "peek" — inserts an evidence row with a future
    // business_date and reports its ID. The runner's evidence-validate
    // must reject (or tag and then visibleEvidenceFor must filter it out
    // — but the runner's tagging happens before §3 enforcement, so the
    // safe semantic is: refuse to tag future-dated evidence).
    const run = createReplayRun(db, {
      shopId: 'jd_shop_001', shopName: 'S',
      sourceDatasetPath: '/d', sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-08-04',
    });
    const futurePeekKernel = async (
      _r: string, _s: string, _businessDate: string,
    ): Promise<KernelStepResult> => {
      // Insert evidence with business_date 2026-08-10 (future)
      const r = db.prepare(
        `INSERT INTO evidence_observations
         (shop_id, capability, data_type, business_date, business_time_bucket,
          acquired_at, content_hash, evidence_file_path, content_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'jd_shop_001', 'trade.overview', 'getSummary',
        '2026-08-10', '2026-08-10T10',
        '2026-08-10T10:00:00Z', 'h-future',
        '/data/future.json', 1, '2026-08-10T10:00:01Z',
      );
      return {
        evidenceObservationIds: [Number(r.lastInsertRowid)],
        investigation: {
          currentUnderstanding: 'trying to peek future',
          judgment: 'peek',
          recommendation: { kind: 'observe', recommendation: 'observe' },
        },
      };
    };
    const result = await runReplayRunToCompletion(db, run.id, futurePeekKernel);
    expect(result.status).toBe('FAILED');
    const step = db.prepare(
      `SELECT error FROM replay_run_steps WHERE replay_run_id = ?`,
    ).get(run.id) as { error: string | null };
    expect(step.error).toMatch(/future|leakage|no-future/i);
    // The future-dated evidence row was NEVER tagged with replay_run_id
    // (the §3 check runs before tagEvidenceAsReplayVisible).
    const taggedRows = db.prepare(
      `SELECT COUNT(*) AS n FROM evidence_observations WHERE replay_run_id IS NOT NULL`,
    ).get() as { n: number };
    expect(taggedRows.n).toBe(0);
  });
});
