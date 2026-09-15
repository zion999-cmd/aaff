// P0013 Phase 2 — Historical Dataset loader.
//
// §6 (raw is immutable), §35 (no P0011.x reopening), §4 (source truthfulness).
//
// The loader must:
//   1. Open the P0011.x rootPath, read PROVENANCE_MANIFEST.json first.
//   2. Compute a sha256 hash of the manifest content; record it on the
//      returned dataset (Phase 1 stores this in replay_runs.source_manifest_hash).
//   3. Read the 4 canonical files (target_a_summary_decoded, target_a_trend_parsed,
//      target_b_order_detail_summary, target_b_order_detail_parsed) — fail
//      closed on any missing file or any parse failure. NO fallback to mock.
//   4. Return a frozen object so callers cannot mutate the dataset.
//   5. Coverage: compute missingBusinessDates (calendar days in window not
//      present in xaxis).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadHistoricalDataset,
  HistoricalDatasetContractError,
} from '#app/runtime/replay/historical-dataset.js';

const REAL_FIXTURE = 'data/jd_acquisition_20260903_0834';

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'p0013-historical-'));
  // Hand-craft a minimal valid dataset for unit tests.
  mkdirSync(join(tmpRoot, 'sub'), { recursive: true });
  writeFileSync(join(tmpRoot, 'PROVENANCE_MANIFEST.json'), JSON.stringify({
    manifest_version: '1.0',
    acquired_at: '2026-09-03T08:43:52+08:00',
    acquisition_run_id: 'unit-test',
    shop: { shop_id: 'jd_shop_001', shop_name: 'Test Shop' },
    time_window: { start: '2026-08-04', end: '2026-08-08', days: 5 },
  }));
  writeFileSync(join(tmpRoot, 'target_a_summary_decoded.json'), JSON.stringify({
    shop_id: 'jd_shop_001',
    all_kpis_readable: { 'GMV 成交金额': { value: 100, compare_pct: 0.1 } },
  }));
  writeFileSync(join(tmpRoot, 'target_a_trend_parsed.json'), JSON.stringify({
    shop_id: 'jd_shop_001',
    xaxis: ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-08'],
    series: [{ code: 'merchant', data: [1, 2, 3, 4] }],
    rows: [
      { date: '2026-08-04', merchant_gmv: 1 },
      { date: '2026-08-05', merchant_gmv: 2 },
      { date: '2026-08-06', merchant_gmv: 3 },
      { date: '2026-08-08', merchant_gmv: 4 },
    ],
  }));
  writeFileSync(join(tmpRoot, 'target_b_order_detail_summary.json'), JSON.stringify({
    shop_id: 'jd_shop_001',
    unique_orders: 10,
    rows_total: 12,
    per_day: [
      ['2026-08-04', { orders: 2, qty: 3, amt: 100 }],
      ['2026-08-05', { orders: 3, qty: 4, amt: 200 }],
    ],
  }));
  writeFileSync(join(tmpRoot, 'target_b_order_detail_parsed.json'), JSON.stringify([]));
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadHistoricalDataset — synthetic tmp fixture', () => {
  it('returns a frozen HistoricalDataset object', () => {
    const ds = loadHistoricalDataset(tmpRoot);
    expect(Object.isFrozen(ds)).toBe(true);
  });

  it('reads shop + window from the manifest', () => {
    const ds = loadHistoricalDataset(tmpRoot);
    expect(ds.shop.shopId).toBe('jd_shop_001');
    expect(ds.shop.shopName).toBe('Test Shop');
    expect(ds.window.start).toBe('2026-08-04');
    expect(ds.window.end).toBe('2026-08-08');
    expect(ds.window.days).toBe(5);
  });

  it('produces a non-empty manifestHash (sha256 of manifest content)', () => {
    const ds = loadHistoricalDataset(tmpRoot);
    expect(ds.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the trade overview decoded KPIs', () => {
    const ds = loadHistoricalDataset(tmpRoot);
    expect(ds.tradeOverview.decoded.shop_id).toBe('jd_shop_001') // synthetic fixture uses string;
    expect(ds.tradeOverview.decoded.all_kpis_readable['GMV 成交金额']?.value).toBe(100);
  });

  it('reads the trend per-day series', () => {
    const ds = loadHistoricalDataset(tmpRoot);
    expect(ds.trend.xaxis).toEqual(['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-08']);
  });

  it('reads the order details per-day summary', () => {
    const ds = loadHistoricalDataset(tmpRoot);
    expect(ds.orderDetails.perDay['2026-08-04']?.orders).toBe(2);
    expect(ds.orderDetails.perDay['2026-08-05']?.amt).toBe(200);
  });

  it('exposes the parsed rows array', () => {
    const ds = loadHistoricalDataset(tmpRoot);
    expect(ds.orderDetails.rows).toEqual([]);
  });

  it('computes coverage with missing business dates (08-07 absent from xaxis)', () => {
    const ds = loadHistoricalDataset(tmpRoot);
    // Window 08-04..08-08 (5 days). xaxis has 08-04, 08-05, 08-06, 08-08.
    // 08-07 is the only missing day.
    expect(ds.coverage.missingBusinessDates).toContain('2026-08-07');
    expect(ds.coverage.days).toBe(5);
  });
});

describe('loadHistoricalDataset — error paths (fail closed)', () => {
  it('throws HistoricalDatasetContractError if the manifest is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p0013-empty-'));
    expect(() => loadHistoricalDataset(dir)).toThrow(HistoricalDatasetContractError);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws if the manifest is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p0013-bad-'));
    writeFileSync(join(dir, 'PROVENANCE_MANIFEST.json'), 'not json');
    expect(() => loadHistoricalDataset(dir)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws if a canonical file is missing — names the file in the error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p0013-partial-'));
    writeFileSync(join(dir, 'PROVENANCE_MANIFEST.json'), JSON.stringify({
      manifest_version: '1.0',
      acquired_at: '2026-09-03T08:43:52+08:00',
      acquisition_run_id: 'unit',
      shop: { shop_id: 'jd_shop_001', shop_name: 'T' },
      time_window: { start: '2026-08-04', end: '2026-08-08', days: 5 },
    }));
    // Intentionally write only 3 of 4 canonical files.
    writeFileSync(join(dir, 'target_a_summary_decoded.json'), JSON.stringify({ shop_id: 'jd_shop_001', all_kpis_readable: {} }));
    writeFileSync(join(dir, 'target_a_trend_parsed.json'), JSON.stringify({ shop_id: 'jd_shop_001', xaxis: [], series: [], rows: [] }));
    writeFileSync(join(dir, 'target_b_order_detail_summary.json'), JSON.stringify({ shop_id: 'jd_shop_001', per_day: [] }));
    // target_b_order_detail_parsed.json is missing.
    try {
      loadHistoricalDataset(dir);
      expect.fail('expected throw');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(HistoricalDatasetContractError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/target_b_order_detail_parsed\.json/);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadHistoricalDataset — REAL P0011.x fixture (skipped if missing)', () => {
  it('loads the real on-disk dataset and reports the canonical numbers', () => {
    const ds = loadHistoricalDataset(REAL_FIXTURE);
    expect(ds.shop.shopId).toBe('11855009');
    expect(ds.shop.shopName).toBe('祁门红茶官方旗舰店');
    expect(ds.window.start).toBe('2026-08-04');
    expect(ds.window.end).toBe('2026-09-02');
    expect(ds.window.days).toBe(30);
    expect(ds.orderDetails.rows.length).toBe(2412);
    expect(ds.trend.xaxis.length).toBe(30);
  });
});
