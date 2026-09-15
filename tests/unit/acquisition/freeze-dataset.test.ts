// P0013.1 — freezeHistoricalDataset: validates intake, runs the business
// reconciliation gate, machine-emits the provenance manifest, and produces
// a catalog-discoverable frozen dataset. Fabric re-derives the actual
// window from files (never trusts labels) — Fact Integrity.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freezeHistoricalDataset,
  FreezeValidationError,
  ReconciliationMismatchError,
} from '#app/runtime/acquisition/freeze-dataset.js';
import { listHistoricalDatasets } from '#app/runtime/replay/dataset-catalog.js';
import { loadHistoricalDataset } from '#app/runtime/replay/historical-dataset.js';
import { HistoricalEvidenceNeedSchema } from '#shared/contracts/historical-evidence-need.js';
import type { HistoricalEvidenceResult } from '#shared/contracts/historical-evidence-result.js';

let dataRoot: string;
let intakeDir: string;

const fixedClock = () => new Date('2026-09-13T03:30:00.000Z'); // 11:30 Beijing

const need = HistoricalEvidenceNeedSchema.parse({
  subject: { shopId: '11855009', shopName: '祁门红茶官方旗舰店' },
  source: 'jd',
  purpose: 'historical_replay',
  window: { start: '2026-09-03', end: '2026-09-05' },
  domains: ['trade', 'orders'],
});

// ── intake builders ──────────────────────────────────────────────────

const orderRow = (
  orderId: string,
  date: string,
  amt: number,
  kind: 'header' | 'child' = 'header',
): Record<string, unknown> => ({
  order_id: orderId,
  shop_id: 11855009,
  spu_id: 1000 + Number(orderId.slice(-2)),
  sku_id: 2000 + Number(orderId.slice(-2)),
  sku_name: `tea ${orderId}`,
  sale_qty: kind === 'header' ? 2 : 1,
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
  row_kind: kind,
});

interface IntakeOpts {
  gmv?: number;
  orders?: Array<[string, number]>; // per-day [date, amt]
  omit?: string[];
  claimedActual?: { start: string | null; end: string | null; missing_dates: string[] };
}

const writeIntake = (opts: IntakeOpts = {}) => {
  const days = opts.orders ?? [
    ['2026-09-03', 100],
    ['2026-09-04', 200],
    ['2026-09-05', 300],
  ];
  const total = days.reduce((s, [, amt]) => s + amt, 0);
  const gmv = opts.gmv ?? total;

  const summary = {
    shop_id: '11855009',
    all_kpis_readable: {
      'GMV 成交金额': { value: gmv },
      'orders 成交单量': { value: days.length },
    },
  };
  const trend = {
    shop_id: '11855009',
    xaxis: days.map(([d]) => d),
    series: [{ code: 'gmv', data: days.map(([, a]) => a) }],
    rows: days.map(([d]) => ({ date: d })),
  };
  const perDay = days.map(([d, amt]) => [d, { orders: 1, qty: 2, amt }]);
  const rows = days.map(([d, amt], i) => orderRow(`900${i}`, d, amt));

  const files: Record<string, unknown> = {
    'target_a_summary_decoded.json': summary,
    'target_a_trend_parsed.json': trend,
    'target_b_order_detail_summary.json': { shop_id: '11855009', per_day: perDay },
    'target_b_order_detail_parsed.json': rows,
  };
  for (const [name, body] of Object.entries(files)) {
    if (!opts.omit?.includes(name)) {
      writeFileSync(join(intakeDir, name), JSON.stringify(body));
    }
  }

  const result: HistoricalEvidenceResult = {
    requested_window: { start: '2026-09-03', end: '2026-09-05' },
    actual_window:
      opts.claimedActual ??
      { start: '2026-09-03', end: '2026-09-05', missing_dates: [] },
    domains: { trade: { status: 'complete' }, orders: { status: 'complete' } },
    gaps: [],
    artifacts: {
      summary: 'target_a_summary_decoded.json',
      trend: 'target_a_trend_parsed.json',
      order_summary: 'target_b_order_detail_summary.json',
      order_rows: 'target_b_order_detail_parsed.json',
      raw: [],
    },
    provenance: {
      source_system: 'JD 商智 (jdsz.jd.com)',
      source_surfaces: ['tradeSummary', 'orderDetails'],
      acquisition_method: 'blind exploration',
      acquired_at: '2026-09-13T11:00:00+08:00',
    },
    reconciliation: {
      orders_gmv: total,
      trade_gmv: gmv,
      delta: gmv - total,
      matches: Math.abs(gmv - total) <= 1,
    },
    stop_reason: 'verified_real_data',
    reuse_report: { reused: [], rediscovered: [], newly_built: [] },
  };
  return result;
};

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'af-freeze-root-'));
  intakeDir = join(dataRoot, '_acquisition_intake', 'hacq_test');
  mkdirSync(intakeDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('freezeHistoricalDataset — happy path', () => {
  it('freezes a validated dataset, catalog discovers it, loader roundtrips it', () => {
    const result = writeIntake();
    const out = freezeHistoricalDataset({
      dataRoot,
      intakeDir,
      need,
      result,
      jobId: 'hacq_test',
      candidateId: 'hcand_20260913_113000_ab12cd',
      clock: fixedClock,
    });

    expect(out.datasetDirName).toMatch(/^jd_acquisition_20260913_1130/);
    expect(out.actualWindow).toMatchObject({
      start: '2026-09-03',
      end: '2026-09-05',
      days: 3,
      missingDates: [],
    });

    const catalog = listHistoricalDatasets(dataRoot);
    expect(catalog.datasets).toHaveLength(1);
    expect(catalog.datasets[0]).toMatchObject({
      windowStart: '2026-09-03',
      windowEnd: '2026-09-05',
      manifestHash: out.manifestHash,
      shopId: '11855009',
    });

    const loaded = loadHistoricalDataset(out.datasetDir);
    expect(loaded.manifestHash).toBe(out.manifestHash);
    expect(loaded.orderDetails.perDay['2026-09-04']?.amt).toBe(200);
  });

  it('machine manifest carries file hashes, method, reconciliation, candidate id and v2 marker', () => {
    const result = writeIntake();
    const out = freezeHistoricalDataset({
      dataRoot,
      intakeDir,
      need,
      result,
      jobId: 'hacq_test',
      candidateId: 'hcand_20260913_113000_ab12cd',
      clock: fixedClock,
    });
    const manifest = JSON.parse(readFileSync(join(out.datasetDir, 'PROVENANCE_MANIFEST.json'), 'utf8'));
    expect(manifest.manifest_version).toBe('2.0');
    expect(manifest.acquisition_run_id).toBe('hacq_test');
    expect(manifest.candidate_id).toBe('hcand_20260913_113000_ab12cd');
    expect(manifest.shop.shop_name).toBe('祁门红茶官方旗舰店');
    expect(manifest.file_hashes['target_b_order_detail_parsed.json']).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.reconciliation.matches).toBe(true);
  });

  it('copies referenced raw artifacts into the frozen dir', () => {
    const result = writeIntake();
    mkdirSync(join(intakeDir, 'raw'), { recursive: true });
    writeFileSync(join(intakeDir, 'raw', 'source-response.json'), '{"x":1}');
    result.artifacts.raw = ['raw/source-response.json'];
    const out = freezeHistoricalDataset({
      dataRoot,
      intakeDir,
      need,
      result,
      jobId: 'hacq_test',
      clock: fixedClock,
    });
    expect(existsSync(join(out.datasetDir, 'raw', 'source-response.json'))).toBe(true);
  });
});

describe('freezeHistoricalDataset — gate failures', () => {
  it('throws FreezeValidationError when a canonical file is missing and freezes nothing', () => {
    const result = writeIntake({ omit: ['target_a_trend_parsed.json'] });
    expect(() =>
      freezeHistoricalDataset({ dataRoot, intakeDir, need, result, jobId: 'hacq_test', clock: fixedClock }),
    ).toThrow(FreezeValidationError);
    expect(listHistoricalDatasets(dataRoot).datasets).toHaveLength(0);
  });

  it('throws ReconciliationMismatchError when orders money disagrees with trade GMV', () => {
    const result = writeIntake({ gmv: 9999 });
    expect(() =>
      freezeHistoricalDataset({ dataRoot, intakeDir, need, result, jobId: 'hacq_test', clock: fixedClock }),
    ).toThrow(ReconciliationMismatchError);
    expect(listHistoricalDatasets(dataRoot).datasets).toHaveLength(0);
  });

  it('rejects a self-reported actual window that contradicts the files', () => {
    const result = writeIntake({
      claimedActual: { start: '2026-09-01', end: '2026-09-05', missing_dates: [] },
    });
    expect(() =>
      freezeHistoricalDataset({ dataRoot, intakeDir, need, result, jobId: 'hacq_test', clock: fixedClock }),
    ).toThrow(FreezeValidationError);
  });

  it('reports missing dates truthfully for a partial window', () => {
    const result = writeIntake({
      orders: [
        ['2026-09-03', 100],
        ['2026-09-05', 300],
      ],
      claimedActual: { start: '2026-09-03', end: '2026-09-05', missing_dates: ['2026-09-04'] },
    });
    const out = freezeHistoricalDataset({
      dataRoot,
      intakeDir,
      need,
      result,
      jobId: 'hacq_test',
      clock: fixedClock,
    });
    expect(out.actualWindow.missingDates).toEqual(['2026-09-04']);
    const catalog = listHistoricalDatasets(dataRoot);
    expect(catalog.datasets[0]?.missingDates).toBe(1);
  });
});
