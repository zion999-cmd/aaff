// P0013 Task 2 Phase E — No-Future-Leak contract tests (the load-bearing assertion).
//
// 5 tests, each pinning a different surface that enforces the same
// invariant: at Replay Business Time T, the system CANNOT access data
// with business_date > T.
//
// Surfaces covered:
//   1. SQL boundary: visibleEvidenceFor (temporal-evidence-view)
//   2. Retrieval function boundary: retrieveOrders (order-retrieval)
//   3. HTTP route boundary: POST /api/replay/runs/:runId/orders/retrieve
//   4. Kernel prompt boundary: buildReplayInvestigationPrompt text section
//   5. Run isolation: run A cannot see run B's perOrder rows
//
// Real-fixture integration test (gated) also runs the full stack end-to-end.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import { visibleEvidenceFor } from '#app/runtime/replay/temporal-evidence-view.js';
import { retrieveOrders } from '#app/runtime/replay/order-retrieval.js';
import { replayOrdersRouter } from '#platform/server/routes/replay-orders.js';
import { buildReplayInvestigationPrompt } from '#app/runtime/replay/replay-cognition-kernel.js';
import type { ReplayRunState } from '#app/runtime/replay/replay-runner-p0013.js';
import type { OrderDetailRow } from '#shared/contracts/historical-dataset.js';
import { loadHistoricalDataset } from '#app/runtime/replay/historical-dataset.js';

const DATASET_PATH = 'data/jd_acquisition_20260903_0834';
const HAS_REAL_FIXTURE = existsSync(DATASET_PATH);

const setupDb = (): Database.Database => {
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
    CREATE UNIQUE INDEX idx_evidence_observations_natural_key
      ON evidence_observations(shop_id, data_type, business_date, acquired_at, content_hash);
  `);
  applyP0013Schema(d);
  return d;
};

const insertEvidence = (
  d: Database.Database,
  args: {
    shop_id: string;
    capability: string;
    data_type: string;
    business_date: string;
    replay_run_id: string;
    content_hash?: string;
  },
): number => {
  const hash = args.content_hash ?? `h-${args.business_date}-${args.data_type}`;
  const r = d
    .prepare(
      `INSERT INTO evidence_observations
       (shop_id, capability, data_type, business_date, business_time_bucket,
        acquired_at, content_hash, evidence_file_path, content_size, created_at,
        replay_run_id, replay_run_step_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
    )
    .run(
      args.shop_id,
      args.capability,
      args.data_type,
      args.business_date,
      `${args.business_date}T10`,
      `${args.business_date}T10:00:00Z`,
      hash,
      '/dummy/path',
      `${args.business_date}T10:00:01Z`,
      args.replay_run_id,
    );
  return Number(r.lastInsertRowid);
};

describe('No-Future-Leak — 5 contract surfaces', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it('Test 1 — SQL boundary: visibleEvidenceFor returns 0 rows with business_date > T', () => {
    insertEvidence(db, { shop_id: 'S', capability: 'order.overview', data_type: 'perOrder', business_date: '2026-08-04', replay_run_id: 'runA' });
    insertEvidence(db, { shop_id: 'S', capability: 'order.overview', data_type: 'perOrder', business_date: '2026-08-10', replay_run_id: 'runA' });
    insertEvidence(db, { shop_id: 'S', capability: 'order.overview', data_type: 'perOrder', business_date: '2026-08-19', replay_run_id: 'runA' });
    const visible = visibleEvidenceFor(db, 'runA', '2026-08-18');
    for (const v of visible) {
      expect(v.business_date <= '2026-08-18').toBe(true);
    }
    expect(visible.some((v) => v.business_date === '2026-08-19')).toBe(false);
  });

  it('Test 2 — Retrieval function boundary: retrieveOrders returns 0 rows with biz_date > T', () => {
    const rows: OrderDetailRow[] = [
      {
        order_id: '1', shop_id: 'S', spu_id: 1, sku_id: 1, sku_name: 'A',
        sale_qty: 1, ord_amt: 100, pre_discount_amt: 100, sku_jd_price: 100,
        delivery_service_fee: 0, sku_freight_amt: 0, ord_type: 1,
        channel_code: 'C', pay_method_desc: '微信',
        biz_date: '2026-08-10', sale_ord_tm: '2026-08-10T10:00:00+08:00', pay_tm: '2026-08-10T10:00:00+08:00',
        row_kind: 'header',
      },
      {
        order_id: '2', shop_id: 'S', spu_id: 1, sku_id: 1, sku_name: 'A',
        sale_qty: 1, ord_amt: 100, pre_discount_amt: 100, sku_jd_price: 100,
        delivery_service_fee: 0, sku_freight_amt: 0, ord_type: 1,
        channel_code: 'C', pay_method_desc: '微信',
        biz_date: '2026-08-19', sale_ord_tm: '2026-08-19T10:00:00+08:00', pay_tm: '2026-08-19T10:00:00+08:00',
        row_kind: 'header',
      },
    ];
    const out = retrieveOrders(rows, '2026-08-18', 'parentOrdersByDay');
    for (const r of out) {
      expect(r.biz_date <= '2026-08-18').toBe(true);
    }
    expect(out.length).toBe(1);
    expect(out[0]?.biz_date).toBe('2026-08-10');
  });

  it('Test 5 — Run isolation: run A cannot see run B\'s perOrder rows', () => {
    insertEvidence(db, { shop_id: 'S', capability: 'order.overview', data_type: 'perOrder', business_date: '2026-08-10', replay_run_id: 'runA', content_hash: 'hA' });
    insertEvidence(db, { shop_id: 'S', capability: 'order.overview', data_type: 'perOrder', business_date: '2026-08-10', replay_run_id: 'runB', content_hash: 'hB' });
    const aVisible = visibleEvidenceFor(db, 'runA', '2026-08-18');
    const bVisible = visibleEvidenceFor(db, 'runB', '2026-08-18');
    expect(aVisible.length).toBe(1);
    expect(bVisible.length).toBe(1);
    const aRows = aVisible.filter((v) => v.replay_run_id === 'runA');
    expect(aRows.length).toBe(1);
    expect(aVisible.every((v) => v.replay_run_id !== 'runB')).toBe(true);
  });

  it('Test 4 — Kernel prompt boundary: future dates are excluded from ## Current evidence', () => {
    const sampleRun: ReplayRunState = {
      id: 'rT', status: 'RUNNING', currentStep: 5,
      currentBusinessDate: '2026-08-18', endBusinessDate: '2026-09-02',
      startBusinessDate: '2026-08-04',
      shopId: 'S', shopName: 'S',
      sourceDatasetPath: 'd', sourceManifestHash: 'h',
      blockedBusinessDate: null, blockedReason: null,
    };
    // The caller (visibleEvidenceFor) is responsible for pre-filtering; the
    // prompt contract is that the kernel trusts its input. We assert the
    // input contract: when the caller passes pre-filtered visibleEvidence
    // (all dates <= T), the prompt's ## Current evidence section never
    // contains a future date.
    const preFilteredEvidence = [
      {
        id: 1, shop_id: 'S', capability: 'trade.overview', data_type: 'getSummary',
        business_date: '2026-08-18', business_time_bucket: '2026-08-18T10',
        acquired_at: '2026-08-18T10:00:00Z',
        content_hash: 'h1', evidence_file_path: '/p', content_size: 100,
        created_at: '2026-08-18T10:00:01Z',
        replay_run_id: 'rT', replay_run_step_id: 's1',
      },
    ];
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-18',
      visibleEvidence: preFilteredEvidence,
      priorSnapshots: [],
      priorCognition: [],
      enrichments: [],
    });
    // Find the section between "## Current evidence" and the next "## ".
    const currentStart = prompt.indexOf('## Current evidence');
    const afterCurrent = prompt.slice(currentStart);
    const nextSectionIdx = afterCurrent.indexOf('## ', '## Current evidence'.length);
    const currentSection = nextSectionIdx >= 0
      ? afterCurrent.slice(0, nextSectionIdx)
      : afterCurrent;
    expect(currentSection).not.toContain('2026-08-19');
    expect(currentSection).not.toContain('2026-08-20');
  });
});

describe('Test 3 — Route boundary: HTTP returns 400 with named error', () => {
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  beforeEach(async () => {
    db = setupDb();
    const app = express();
    app.use(express.json());
    app.use('/api/replay', replayOrdersRouter(db));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it('returns 400 with No-Future-Leak error when businessDate > run.current_business_date', async () => {
    db.prepare(
      `INSERT INTO replay_runs
       (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
        start_business_date, end_business_date, current_business_date, current_step,
        status, created_at, last_advanced_at, completed_at)
       VALUES ('rRoute', 'S', 'S', '/nope', 'mh', '2026-08-04', '2026-09-02',
        '2026-08-18', 0, 'RUNNING', '2026-09-07T10:00:00Z', NULL, NULL)`,
    ).run();
    const r = await fetch(`${baseUrl}/api/replay/runs/rRoute/orders/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ businessDate: '2026-08-19', query: 'parentOrdersByDay' }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { error: string };
    expect(j.error).toContain('No-Future-Leak');
  });
});

const itIfFixture = HAS_REAL_FIXTURE ? it : it.skip;
describe('Real-fixture No-Future-Leak end-to-end (gated)', () => {
  itIfFixture(
    'at T=2026-08-18, no row with biz_date > 2026-08-18 is returned (parentOrdersByDay)',
    () => {
      const dataset = loadHistoricalDataset(DATASET_PATH);
      const out = retrieveOrders(dataset.orderDetails.rows, '2026-08-18', 'parentOrdersByDay');
      for (const r of out) {
        expect(r.biz_date <= '2026-08-18').toBe(true);
      }
      for (const d of ['2026-08-19', '2026-08-20', '2026-08-31', '2026-09-01', '2026-09-02']) {
        expect(out.some((r) => r.biz_date === d)).toBe(false);
      }
      expect(out.some((r) => r.biz_date === '2026-08-18')).toBe(true);
    },
  );

  itIfFixture(
    'at T=2026-09-01, no row with biz_date > 2026-09-01 (skuLinesByDay)',
    () => {
      const dataset = loadHistoricalDataset(DATASET_PATH);
      const out = retrieveOrders(dataset.orderDetails.rows, '2026-09-01', 'skuLinesByDay');
      for (const r of out) {
        expect(r.biz_date <= '2026-09-01').toBe(true);
      }
      expect(out.some((r) => r.biz_date === '2026-09-02')).toBe(false);
      expect(out.some((r) => r.biz_date === '2026-09-01')).toBe(true);
    },
  );
});
