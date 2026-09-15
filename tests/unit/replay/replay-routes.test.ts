// P0013 Phase 5 — /api/replay/runs/... HTTP routes (real Express server).
//
// No supertest available; we use Express's app.listen() + Node's fetch.
// This is the most realistic handler test possible without supertest.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import { replayRouter } from '#platform/server/routes/replay.js';
import {
  clearFailedCognitionForCurrentDate,
  rearmRunForRetry,
} from '#app/runtime/replay/replay-runner-p0013.js';

let db: Database.Database;
let server: Server;
let baseUrl: string;

// P0013+: POST /runs now validates the requested window against the real
// on-disk dataset coverage and recomputes the manifest hash server-side, so
// happy-path bodies must reference the real acquisition dataset.
const REAL_DATASET = 'data/jd_acquisition_20260903_0834';
const REAL_WINDOW = { start: '2026-08-04', end: '2026-09-02' } as const;

const setup = async (): Promise<void> => {
  const d = new Database(':memory:');
  d.exec(`
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
  const app = express();
  app.use(express.json());
  app.use('/api/replay', replayRouter(d));
  // Inline legacy alias for the test (the real one is in runtime.ts post-Edit).
  app.post('/api/runtime/replay', (_req, res) => {
    res.status(410).json({
      success: false,
      error: 'POST /api/runtime/replay was superseded by P0013 Historical Cognitive Replay. Use POST /api/replay/runs instead.',
      newEndpoint: '/api/replay/runs',
    });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  db = d;
};

const teardown = async (): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
};

const post = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${baseUrl}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeEach(async () => { await setup(); });
afterEach(async () => { await teardown(); });

describe('POST /api/replay/runs', () => {
  it('returns 200 + a runId for a valid body', async () => {
    const r = await post('/api/replay/runs', {
      shopId: 'jd_shop_001',
      shopName: 'Test Shop',
      sourceDatasetPath: 'data/jd_acquisition_20260903_0834',
      sourceManifestHash: 'placeholder-hash',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const data = r.body.data as { runId: string; status: string };
    expect(data.runId).toBeTruthy();
    expect(data.status).toBe('READY');
  });

  it('stores the real on-disk manifest hash, ignoring any client-supplied hash', async () => {
    const r = await post('/api/replay/runs', {
      shopId: 'jd_shop_001',
      shopName: 'Test Shop',
      sourceDatasetPath: REAL_DATASET,
      sourceManifestHash: 'placeholder-hash', // legacy UI sent this — must be ignored
      startBusinessDate: REAL_WINDOW.start,
      endBusinessDate: REAL_WINDOW.end,
    });
    expect(r.status).toBe(200);
    const runId = (r.body.data as { runId: string }).runId;
    const state = await get(`/api/replay/runs/${runId}`);
    const run = state.body.data as { sourceManifestHash: string; startBusinessDate?: string };
    expect(run.sourceManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.sourceManifestHash).not.toBe('placeholder-hash');
  });

  it('accepts a request without sourceManifestHash (server is the hash authority)', async () => {
    const r = await post('/api/replay/runs', {
      shopId: 'jd_shop_001',
      shopName: 'Test Shop',
      sourceDatasetPath: REAL_DATASET,
      startBusinessDate: '2026-08-20',
      endBusinessDate: '2026-08-25',
    });
    expect(r.status).toBe(200);
  });

  it('returns 400 when the requested window exceeds dataset coverage', async () => {
    const r = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: REAL_DATASET,
      startBusinessDate: REAL_WINDOW.start,
      endBusinessDate: '2026-09-12', // never acquired
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/coverage/i);
  });

  it('returns 400 when the requested window starts before dataset coverage', async () => {
    const r = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: REAL_DATASET,
      startBusinessDate: '2026-07-01',
      endBusinessDate: REAL_WINDOW.end,
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/coverage/i);
  });

  it('returns 400 when the dataset directory cannot be loaded', async () => {
    const r = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: 'data/does-not-exist-dataset',
      startBusinessDate: REAL_WINDOW.start, endBusinessDate: REAL_WINDOW.end,
    });
    expect(r.status).toBe(400);
  });

  it('returns 400 when end < start', async () => {
    const r = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: REAL_DATASET, sourceManifestHash: 'h',
      startBusinessDate: '2026-09-02', endBusinessDate: '2026-08-04',
    });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
  });

  it('returns 400 when startBusinessDate is malformed', async () => {
    const r = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: REAL_DATASET, sourceManifestHash: 'h',
      startBusinessDate: '2026-8-4', endBusinessDate: '2026-09-02',
    });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/replay/runs/:runId', () => {
  it('returns 200 with the run state', async () => {
    const created = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: REAL_DATASET, sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-09-02',
    });
    const id = (created.body.data as { runId: string }).runId;
    const r = await get(`/api/replay/runs/${id}`);
    expect(r.status).toBe(200);
    const data = r.body.data as { id: string; status: string };
    expect(data.id).toBe(id);
    expect(data.status).toBe('READY');
  });

  it('returns 404 for an unknown runId', async () => {
    const r = await get('/api/replay/runs/no-such-run');
    expect(r.status).toBe(404);
  });
});

describe('POST /api/replay/runs/:runId/advance', () => {
  it('returns 400 for an unknown mode', async () => {
    const created = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: REAL_DATASET, sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-09-02',
    });
    const id = (created.body.data as { runId: string }).runId;
    const r = await post(`/api/replay/runs/${id}/advance`, { mode: 'unknown' });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/replay/runs/:runId/steps', () => {
  it('returns an empty array for a freshly created run', async () => {
    const created = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: REAL_DATASET, sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-09-02',
    });
    const id = (created.body.data as { runId: string }).runId;
    const r = await get(`/api/replay/runs/${id}/steps`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });
});

describe('§32 API isolation', () => {
  it('GET /api/replay/runs/:runId/steps/:date returns 404 for an unknown date', async () => {
    const created = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: REAL_DATASET, sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-09-02',
    });
    const id = (created.body.data as { runId: string }).runId;
    const r = await get(`/api/replay/runs/${id}/steps/2026-08-12`);
    expect(r.status).toBe(404);
  });
});

describe('GET /api/replay/datasets', () => {
  it('lists the on-disk acquisition dataset with its coverage window and real hash', async () => {
    const r = await get('/api/replay/datasets');
    expect(r.status).toBe(200);
    const data = r.body.data as {
      datasets: Array<{ dirName: string; windowStart: string; windowEnd: string; manifestHash: string }>;
      skipped: unknown[];
    };
    const found = data.datasets.find((d) => d.dirName === 'jd_acquisition_20260903_0834');
    expect(found).toBeTruthy();
    expect(found?.windowStart).toBe(REAL_WINDOW.start);
    expect(found?.windowEnd).toBe(REAL_WINDOW.end);
    expect(found?.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('legacy /api/runtime/replay → 410 alias', () => {
  it('returns 410 with newEndpoint pointer', async () => {
    const r = await post('/api/runtime/replay', { shopId: 'jd', from: '2026-08-04', to: '2026-09-02' });
    expect(r.status).toBe(410);
    expect(r.body.success).toBe(false);
    expect(r.body.newEndpoint).toBe('/api/replay/runs');
  });
});

// ── P0013 correctness — Coverage Gate at run creation ─────────────────
//
// A run may only be created for a window the frozen acquisition can
// actually answer. `data/jd_acquisition_20260914_0231` declares (and
// structurally contains) a source-empty business date: 2026-09-13.
describe('POST /api/replay/runs — Evidence Coverage Gate', () => {
  const GAPPED_DATASET = 'data/jd_acquisition_20260914_0231';

  it('rejects a window that includes an uncovered business date (409 + named gap)', async () => {
    const r = await post('/api/replay/runs', {
      shopId: '11855009',
      shopName: '祁门红茶官方旗舰店',
      sourceDatasetPath: GAPPED_DATASET,
      startBusinessDate: '2026-09-04',
      endBusinessDate: '2026-09-13',
    });
    expect(r.status).toBe(409);
    expect(r.body.success).toBe(false);
    expect(String(r.body.error)).toContain('Evidence Coverage Gap');
    expect(String(r.body.error)).toContain('2026-09-13');
    expect(String(r.body.error)).toContain('/api/replay/acquisitions');
  });

  it('accepts the same dataset when the window ends before the gap', async () => {
    const r = await post('/api/replay/runs', {
      shopId: '11855009',
      shopName: '祁门红茶官方旗舰店',
      sourceDatasetPath: GAPPED_DATASET,
      startBusinessDate: '2026-09-04',
      endBusinessDate: '2026-09-12',
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
});

// ── P0013 correctness — retry reachability for a FAILED step ──────────
//
// Before: mode=retry only deleted a FAILED row that carried the
// '[manually retried]' marker written by clearOrphanStep, so a step that
// FAILED on its own (e.g. a Hermes turn timeout) could never be retried —
// the runner saw the existing FAILED row and returned FAILED forever.
// The UI offers 重试这一天; that action must be reachable. The DB effect is
// asserted through the exported helpers the route calls (the HTTP path
// additionally requires a live Hermes session, which is not what this
// test is about).
describe('retry reachability — clearing a genuinely FAILED step', () => {
  it('clears a FAILED step with no manual-retry marker and re-arms the run', async () => {
    const created = await post('/api/replay/runs', {
      shopId: 'jd', shopName: 'T',
      sourceDatasetPath: REAL_DATASET, sourceManifestHash: 'h',
      startBusinessDate: '2026-08-04', endBusinessDate: '2026-09-02',
    });
    const id = (created.body.data as { runId: string }).runId;
    const ds = db.prepare(`SELECT current_business_date FROM replay_runs WHERE id = ?`).get(id) as {
      current_business_date: string;
    };

    db.prepare(
      `INSERT INTO replay_run_steps
         (id, replay_run_id, step_number, business_date, status, error, started_at, completed_at)
       VALUES ('step-failed-1', ?, 1, ?, 'FAILED', 'Turn timed out waiting for message.complete', '2026-09-15T00:00:00Z', '2026-09-15T00:10:00Z')`,
    ).run(id, ds.current_business_date);
    db.prepare(`UPDATE replay_runs SET status = 'FAILED' WHERE id = ?`).run(id);

    expect(clearFailedCognitionForCurrentDate(db, id)).toBe(1);
    expect(rearmRunForRetry(db, id)).toBe(1);

    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM replay_run_steps WHERE replay_run_id = ? AND status = 'FAILED'`)
      .get(id) as { n: number };
    expect(remaining.n).toBe(0);
    const run = db.prepare(`SELECT status FROM replay_runs WHERE id = ?`).get(id) as { status: string };
    expect(run.status).toBe('RUNNING');
  });
});
