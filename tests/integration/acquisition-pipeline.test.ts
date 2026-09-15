// P0013.1 — dynamic acquisition pipeline integration.
//
// Boundary INSIDE (real): Express route → orchestrator → intake
// validation → candidate store → freezer → dataset catalog. Real DB,
// real filesystem, real replay router consuming the frozen dataset.
// Boundary OUTSIDE (declared fake): the Hermes turn. The injected
// TurnRunner deposits real intake files, per S0002 §2.2 this proves
// wiring only — Business Acceptance requires a real Hermes run.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import { acquisitionRouter } from '#platform/server/routes/replay-acquisition.js';
import { replayRouter } from '#platform/server/routes/replay.js';
import { listHistoricalDatasets } from '#app/runtime/replay/dataset-catalog.js';
import { markInterruptedAcquisitionJobs } from '#app/runtime/acquisition/job-store.js';
import type { TurnRunner, TurnRunArgs } from '#app/runtime/acquisition/hermes-turn-runner.js';

let db: Database.Database;
let server: Server;
let baseUrl: string;
let dataRoot: string;

const CANDIDATE_ID = 'hcand_20260913_113000_ab12cd';

const orderRow = (id: string, date: string, amt: number): Record<string, unknown> => ({
  order_id: id,
  shop_id: 11855009,
  spu_id: 3001,
  sku_id: 4001,
  sku_name: `tea ${id}`,
  sale_qty: 2,
  ord_amt: amt,
  pre_discount_amt: amt,
  sku_jd_price: amt,
  delivery_service_fee: 0,
  sku_freight_amt: 0,
  ord_type: 1,
  channel_code: 'app',
  pay_method_desc: '在线支付',
  biz_date: date,
  sale_ord_tm: `${date} 10:00:00`,
  pay_tm: `${date} 10:01:00`,
  row_kind: 'header',
});

/** Fake turn: deposit a contract-valid intake for 2026-09-03..05. */
const depositingRunner = (): TurnRunner => ({
  async runTurn(args: TurnRunArgs) {
    const intake = join(args.trajectoryDir, '..');
    mkdirSync(join(intake, 'raw'), { recursive: true });
    const days: Array<[string, number]> = [
      ['2026-09-03', 100],
      ['2026-09-04', 200],
      ['2026-09-05', 300],
    ];
    writeFileSync(
      join(intake, 'target_a_summary_decoded.json'),
      JSON.stringify({
        shop_id: '11855009',
        all_kpis_readable: {
          'GMV 成交金额': { value: 600 },
          'orders 成交单量': { value: 3 },
        },
      }),
    );
    writeFileSync(
      join(intake, 'target_a_trend_parsed.json'),
      JSON.stringify({
        shop_id: '11855009',
        xaxis: days.map(([d]) => d),
        series: [{ code: 'gmv', data: days.map(([, a]) => a) }],
        rows: days.map(([d]) => ({ date: d })),
      }),
    );
    writeFileSync(
      join(intake, 'target_b_order_detail_summary.json'),
      JSON.stringify({
        shop_id: '11855009',
        per_day: days.map(([d, amt]) => [d, { orders: 1, qty: 2, amt }]),
      }),
    );
    writeFileSync(
      join(intake, 'target_b_order_detail_parsed.json'),
      JSON.stringify(days.map(([d, amt], i) => orderRow(`o${i}`, d, amt))),
    );
    writeFileSync(join(intake, 'raw', 'source-response.json'), '{}');
    writeFileSync(
      join(intake, 'result.json'),
      JSON.stringify({
        requested_window: { start: '2026-09-03', end: '2026-09-05' },
        actual_window: { start: '2026-09-03', end: '2026-09-05', missing_dates: [] },
        domains: { trade: { status: 'complete' }, orders: { status: 'complete' } },
        gaps: [],
        artifacts: {
          summary: 'target_a_summary_decoded.json',
          trend: 'target_a_trend_parsed.json',
          order_summary: 'target_b_order_detail_summary.json',
          order_rows: 'target_b_order_detail_parsed.json',
          raw: ['raw/source-response.json'],
        },
        provenance: {
          source_system: 'JD 商智',
          source_surfaces: ['tradeSummary', 'orderDetails'],
          acquisition_method: 'integration fake runner',
          acquired_at: '2026-09-13T11:00:00+08:00',
        },
        reconciliation: { orders_gmv: 600, trade_gmv: 600, delta: 0, matches: true },
        stop_reason: 'verified_real_data',
        reuse_report: { reused: [], rediscovered: [], newly_built: [] },
      }),
    );
    writeFileSync(
      join(intake, 'candidate.json'),
      JSON.stringify({
        id: CANDIDATE_ID,
        satisfies: { need_category: 'historical_evidence', source: 'jd', domains: ['trade', 'orders'] },
        binding: { source: 'jd', system_identity: 'JD 商智' },
        input_contract: { shop_id: 'string', window: 'YYYY-MM-DD range' },
        output_contract: { canonical_files: 4 },
        method: 'per-day acquisition with dedup',
        implementation_assets: [{ kind: 'script', name: 'fake' }],
        dependencies: {
          authentication: 'browser session',
          browser_session: 'operator browser',
          environment: [],
        },
        verified_against: {
          acquisition_job_id: args.jobId,
          evidence_files: ['target_b_order_detail_summary.json'],
          verification_notes: 'integration',
        },
        limitations: [],
        provenance: {
          created_by: 'hermes',
          created_at: '2026-09-13T11:05:00+08:00',
          trajectory_path: 'trajectory/events.ndjson',
        },
        status: 'pending_review',
      }),
    );
    mkdirSync(args.trajectoryDir, { recursive: true });
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      join(args.trajectoryDir, 'events.ndjson'),
      [
        JSON.stringify({ kind: 'turn.start', at: '2026-09-13T03:00:00.000Z' }),
        JSON.stringify({ kind: 'tool.start', at: '2026-09-13T03:00:01.000Z', name: 'terminal', args: 'x' }),
        JSON.stringify({ kind: 'tool.complete', at: '2026-09-13T03:00:03.000Z', name: 'terminal', duration_s: 2.1 }),
        JSON.stringify({ kind: 'message.delta', at: '2026-09-13T03:00:04.000Z', text: 'found data' }),
      ].join('\n') + '\n',
    );
    return { sessionId: 'sess-fake', toolCallCount: 1, finalMessage: 'done' };
  },
});

const emptyRunner = (): TurnRunner => ({
  async runTurn(args: TurnRunArgs) {
    mkdirSync(args.trajectoryDir, { recursive: true });
    return { sessionId: 'sess-fake', toolCallCount: 0, finalMessage: 'nothing' };
  },
});

/** Deposits a complete valid intake, THEN throws like a lost turn.complete. */
const throwingDepositingRunner = (): TurnRunner => {
  const inner = depositingRunner();
  return {
    async runTurn(args: TurnRunArgs) {
      await inner.runTurn(args);
      throw new Error('submitTurnAndCollect timed out (turn.complete not observed)');
    },
  };
};

const setup = async (runner: TurnRunner): Promise<void> => {
  dataRoot = mkdtempSync(join(tmpdir(), 'af-acq-int-'));
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
  app.use('/api/replay', acquisitionRouter(d, { dataRoot, turnRunner: runner }));
  app.use('/api/replay', replayRouter(d, { dataRoot }));
  await new Promise<void>((resolveReady) => {
    server = app.listen(0, '127.0.0.1', () => resolveReady());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  db = d;
};

const teardown = async (): Promise<void> => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dataRoot, { recursive: true, force: true });
};

const postJson = async (path: string, body: unknown) => {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

const getJson = async (path: string) => {
  const r = await fetch(`${baseUrl}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

const pollJob = async (jobId: string, retries = 40): Promise<Record<string, any>> => {
  for (let i = 0; i < retries; i += 1) {
    const r = await getJson(`/api/replay/acquisitions/${jobId}`);
    const job = r.body.data;
    if (['SUCCEEDED', 'FAILED', 'BLOCKED', 'INTERRUPTED'].includes(job.status)) return job;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  throw new Error('job did not reach a terminal state');
};

const gapBody = {
  shopId: '11855009',
  shopName: '祁门红茶官方旗舰店',
  startBusinessDate: '2026-09-03',
  endBusinessDate: '2026-09-05',
};

describe('P0013.1 acquisition pipeline (real route/freezer/catalog; fake Hermes turn)', () => {
  beforeEach(async () => {
    await setup(depositingRunner());
  });
  afterEach(async () => {
    await teardown();
  });

  it('gap request → job SUCCEEDED → frozen dataset discoverable → replay run consumes it', async () => {
    const created = await postJson('/api/replay/acquisitions', gapBody);
    expect(created.status).toBe(201);
    expect(created.body.data.gap.gapSegments).toEqual([
      { start: '2026-09-03', end: '2026-09-05' },
    ]);

    const job = await pollJob(created.body.data.jobId);
    expect(job.status).toBe('SUCCEEDED');
    expect(job.actualStart).toBe('2026-09-03');
    expect(job.actualEnd).toBe('2026-09-05');
    expect(job.candidateId).toBe(CANDIDATE_ID);
    expect(job.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(job.datasetDir.startsWith(dataRoot)).toBe(true);

    const catalog = listHistoricalDatasets(dataRoot);
    expect(catalog.datasets).toHaveLength(1);
    expect(catalog.datasets[0]).toMatchObject({
      windowStart: '2026-09-03',
      windowEnd: '2026-09-05',
      manifestHash: job.manifestHash,
    });
    expect(existsSync(join(dataRoot, 'capability-candidates', `${CANDIDATE_ID}.json`))).toBe(true);

    // The frozen product is consumable through the normal Replay path.
    const run = await postJson('/api/replay/runs', {
      shopId: '11855009',
      shopName: '祁门红茶官方旗舰店',
      sourceDatasetPath: job.datasetDir,
      startBusinessDate: '2026-09-03',
      endBusinessDate: '2026-09-05',
    });
    expect(run.status).toBe(200);
    expect(run.body.success).toBe(true);

    // Trajectory observability: the minute-scale turn must expose its
    // event tail for operator progress + SC10 audit.
    const events = await getJson(`/api/replay/acquisitions/${job.id}/events`);
    expect(events.status).toBe(200);
    expect(events.body.data.started).toBe(true);
    expect(events.body.data.toolCalls).toBe(1);
    const kinds = events.body.data.events.map((e: Record<string, unknown>) => e.kind);
    expect(kinds).toContain('tool.start');
    expect(kinds).toContain('message.delta');
  });

  it('rejects a window already covered with 409', async () => {
    // First acquisition succeeds; an identical need is then covered.
    const first = await postJson('/api/replay/acquisitions', gapBody);
    await pollJob(first.body.data.jobId);
    const again = await postJson('/api/replay/acquisitions', gapBody);
    expect(again.status).toBe(409);
  });
});

describe('P0013.1 failure honesty', () => {
  beforeEach(async () => {
    await setup(emptyRunner());
  });
  afterEach(async () => {
    await teardown();
  });

  it('INTAKE_INCOMPLETE turn → FAILED/INTAKE_INVALID and freezes nothing', async () => {
    const created = await postJson('/api/replay/acquisitions', gapBody);
    const job = await pollJob(created.body.data.jobId);
    expect(job.status).toBe('FAILED');
    expect(job.failureCode).toBe('INTAKE_INVALID');
    expect(job.datasetDir).toBeNull();
    expect(listHistoricalDatasets(dataRoot).datasets).toHaveLength(0);
  });

  it('validates the need body (400 on bad date)', async () => {
    const r = await postJson('/api/replay/acquisitions', { ...gapBody, endBusinessDate: '09-12' });
    expect(r.status).toBe(400);
  });

  it('orphan jobs left RUNNING are marked INTERRUPTED on restart', () => {
    const created = db
      .prepare(
        `INSERT INTO acquisition_jobs
           (id, shop_id, shop_name, requested_start, requested_end, status,
            intake_dir, goal_text, created_at, updated_at)
         VALUES ('hacq_orphan','11855009','shop','2026-09-03','2026-09-05','RUNNING',
                 '/tmp/x','g', '2026-09-13T00:00:00Z','2026-09-13T00:00:00Z')`,
      )
      .run();
    expect(created.changes).toBe(1);
    expect(markInterruptedAcquisitionJobs(db, '2026-09-13T01:00:00Z')).toBe(1);
    const row = db.prepare(`SELECT status, failure_code FROM acquisition_jobs WHERE id='hacq_orphan'`).get() as {
      status: string;
      failure_code: string;
    };
    expect(row.status).toBe('INTERRUPTED');
    expect(row.failure_code).toBe('SERVER_RESTARTED');
  });
});

describe('P0013.1 timeout salvage (runner throws after depositing complete intake)', () => {
  beforeEach(async () => {
    await setup(throwingDepositingRunner());
  });
  afterEach(async () => {
    await teardown();
  });

  it('turn timeout with complete deliverables still freezes; note recorded', async () => {
    const created = await postJson('/api/replay/acquisitions', gapBody);
    const job = await pollJob(created.body.data.jobId);
    expect(job.status).toBe('SUCCEEDED');
    expect(job.turnNote).toMatch(/turn lifecycle error/);
    expect(listHistoricalDatasets(dataRoot).datasets).toHaveLength(1);
  });
});
