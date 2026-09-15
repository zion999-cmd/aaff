// P0013.3 — /api/replay/runs/:id/enrichments HTTP contract (no Hermes
// needed; enrichment persistence + invalidation are local DB ops).
// Re-run endpoints are exercised at the runner level with a fake kernel
// (enrichment-rerun.test.ts); the route is thin glue.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import { replayRouter } from '#platform/server/routes/replay.js';
import { createReplayRun } from '#app/runtime/replay/replay-runner-p0013.js';

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
  `);
  applyP0013Schema(d);
  const app = express();
  app.use(express.json());
  app.use('/api/replay', replayRouter(d));
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${baseUrl}${path}`);
  return { status: r.status, body: await r.json() };
};

let runId: string;

beforeEach(async () => {
  await setup();
  const run = createReplayRun(db, {
    shopId: '11855009',
    shopName: '祁门红茶官方旗舰店',
    sourceDatasetPath: 'data/jd_acquisition_20260903_0834',
    sourceManifestHash: 'testhash',
    startBusinessDate: '2026-08-10',
    endBusinessDate: '2026-08-12',
  });
  runId = run.id;
});
afterEach(async () => {
  await teardown();
});

describe('POST /runs/:id/enrichments', () => {
  it('appends a fact enrichment (201) and lists it via GET', async () => {
    const r = await post(`/api/replay/runs/${runId}/enrichments`, {
      businessDate: '2026-08-11',
      kind: 'fact',
      content: '当天真实发生：新品上架',
    });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
    expect(r.body.data.enrichment.source).toBe('operator');
    expect(r.body.data.enrichment.content).toBe('当天真实发生：新品上架');

    const listed = await get(`/api/replay/runs/${runId}/enrichments`);
    expect(listed.body.data.enrichments).toHaveLength(1);
    expect(listed.body.data.enrichedDates).toEqual(['2026-08-11']);

    const oneDay = await get(`/api/replay/runs/${runId}/enrichments?businessDate=2026-08-11`);
    expect(oneDay.body.data.enrichments).toHaveLength(1);
    const otherDay = await get(`/api/replay/runs/${runId}/enrichments?businessDate=2026-08-10`);
    expect(otherDay.body.data.enrichments).toHaveLength(0);
  });

  it('rejects invalid kind / empty content / bad date with 400', async () => {
    const badKind = await post(`/api/replay/runs/${runId}/enrichments`, {
      businessDate: '2026-08-11',
      kind: 'guess',
      content: 'x',
    });
    expect(badKind.status).toBe(400);
    const empty = await post(`/api/replay/runs/${runId}/enrichments`, {
      businessDate: '2026-08-11',
      kind: 'fact',
      content: '   ',
    });
    expect(empty.status).toBe(400);
    const badDate = await post(`/api/replay/runs/${runId}/enrichments`, {
      businessDate: '2026-09-30',
      kind: 'fact',
      content: 'x',
    });
    expect(badDate.status).toBe(400);
    expect(badDate.body.error).toMatch(/outside run window/);
  });

  it('rerun without mode is rejected 400 and stale replay needs Hermes (route exists)', async () => {
    const bad = await post(`/api/replay/runs/${runId}/rerun`, { mode: 'nope' });
    expect(bad.status).toBe(400);
    // mode=stale with no stale cognition → NO_STALE (no Hermes call needed)
    const noStale = await post(`/api/replay/runs/${runId}/rerun`, { mode: 'stale' });
    expect(noStale.status).toBe(200);
    expect(noStale.body.data.result.status).toBe('NO_STALE');
  });
});
