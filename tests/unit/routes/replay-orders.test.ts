// P0013 Task 2 Phase D — replay-orders route tests.
//
// Mounts the route against an in-memory DB + the real P0011.x fixture
// (gated). Tests the happy path, No-Future-Leak at the route layer,
// bad body, and bad query.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import { replayOrdersRouter } from '#platform/server/routes/replay-orders.js';
import { seedReplayEvidence } from '#app/runtime/replay/seed-evidence.js';

const DATASET_PATH = 'data/jd_acquisition_20260903_0834';
const HAS_REAL_FIXTURE = existsSync(DATASET_PATH);

let db: Database.Database;
let server: Server;
let baseUrl: string;

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
  app.use('/api/replay', replayOrdersRouter(d));
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

const post = async (
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${baseUrl}/api/replay${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

const createRun = (
  runId: string,
  currentBusinessDate: string,
  sourceDatasetPath: string,
): void => {
  db.prepare(
    `INSERT INTO replay_runs
     (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
      start_business_date, end_business_date, current_business_date, current_step,
      status, created_at, last_advanced_at, completed_at)
     VALUES (?, '11855009', 'S', ?, 'mh', '2026-08-04', '2026-09-02', ?, 0,
      'RUNNING', '2026-09-07T10:00:00Z', NULL, NULL)`,
  ).run(runId, sourceDatasetPath, currentBusinessDate);
};

describe('replay-orders route — Phase D', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('404s when the run does not exist', async () => {
    const { status, json } = await post('/runs/no-such-run/orders/retrieve', {
      businessDate: '2026-08-10',
      query: 'parentOrdersByDay',
    });
    expect(status).toBe(404);
    expect(json.success).toBe(false);
    expect(String(json.error)).toContain('not found');
  });

  it('400s on bad businessDate format', async () => {
    createRun('r1', '2026-08-10', '/nope');
    const { status, json } = await post('/runs/r1/orders/retrieve', {
      businessDate: '08-10-2026',
      query: 'parentOrdersByDay',
    });
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/businessDate|YYYY-MM-DD/);
  });

  it('400s on bad query', async () => {
    createRun('r1', '2026-08-10', '/nope');
    const { status } = await post('/runs/r1/orders/retrieve', {
      businessDate: '2026-08-10',
      query: 'madeUpQuery',
    });
    expect(status).toBe(400);
  });

  it('400s on No-Future-Leak (route layer)', async () => {
    createRun('r1', '2026-08-18', '/nope');
    const { status, json } = await post('/runs/r1/orders/retrieve', {
      businessDate: '2026-08-19',
      query: 'parentOrdersByDay',
    });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('No-Future-Leak');
  });

  const itIfFixture = HAS_REAL_FIXTURE ? it : it.skip;
  itIfFixture(
    'happy path: returns all parent orders with biz_date <= 2026-09-01 (real fixture)',
    async () => {
      createRun('r1', '2026-09-01', DATASET_PATH);
      seedReplayEvidence(db, 'r1', DATASET_PATH, '11855009', '2026-09-07T10:00:00Z');
      const { status, json } = await post('/runs/r1/orders/retrieve', {
        businessDate: '2026-09-01',
        query: 'parentOrdersByDay',
      });
      expect(status).toBe(200);
      const data = json.data as { rows: Array<{ biz_date: string }>; meta: { totalMatched: number } };
      // Up-to-09-01 is the cumulative count of all parent orders <= 09-01.
      // Of those, exactly 37 are on 2026-09-01 itself (verified separately).
      expect(data.meta.totalMatched).toBe(1321);
      expect(data.rows.every((r) => r.biz_date <= '2026-09-01')).toBe(true);
      const on0901 = data.rows.filter((r) => r.biz_date === '2026-09-01');
      expect(on0901.length).toBe(37);
    },
  );

  itIfFixture(
    'topContributingOrders respects default N=10 (real fixture, 09-01)',
    async () => {
      createRun('r1', '2026-09-01', DATASET_PATH);
      const { status, json } = await post('/runs/r1/orders/retrieve', {
        businessDate: '2026-09-01',
        query: 'topContributingOrders',
      });
      expect(status).toBe(200);
      const data = json.data as { rows: unknown[]; meta: { totalMatched: number } };
      expect(data.meta.totalMatched).toBe(10);
      expect(data.rows.length).toBe(10);
    },
  );

  itIfFixture(
    'perSkuDailyOrders with skuId returns only matching child rows (real fixture, 09-01)',
    async () => {
      createRun('r1', '2026-09-01', DATASET_PATH);
      const { status, json } = await post('/runs/r1/orders/retrieve', {
        businessDate: '2026-09-01',
        query: 'perSkuDailyOrders',
        queryParams: { skuId: 10076147649602 },
      });
      expect(status).toBe(200);
      const data = json.data as { rows: Array<{ sku_id: number }> };
      expect(data.rows.every((r) => r.sku_id === 10076147649602)).toBe(true);
      expect(data.rows.length).toBeGreaterThan(0);
    },
  );

  itIfFixture(
    'skuGmvContribution returns rows sorted desc by ord_amt (real fixture, up-to 09-01)',
    async () => {
      createRun('r1', '2026-09-01', DATASET_PATH);
      const { status, json } = await post('/runs/r1/orders/retrieve', {
        businessDate: '2026-09-01',
        query: 'skuGmvContribution',
      });
      expect(status).toBe(200);
      const data = json.data as { rows: Array<{ ord_amt: number }> };
      for (let i = 1; i < data.rows.length; i += 1) {
        expect(data.rows[i]!.ord_amt).toBeLessThanOrEqual(data.rows[i - 1]!.ord_amt);
      }
    },
  );
});
