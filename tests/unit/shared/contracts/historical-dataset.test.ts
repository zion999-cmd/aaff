// P0013 Phase 2 — Historical Dataset contract (Zod schemas).
//
// The contract is the boundary between the on-disk P0011.x JSON files and
// everything else in P0013. It must:
//   1. Accept real P0011.x JSON shapes (positive cases).
//   2. Reject anything else (negative cases).
//   3. Be `.strict()` — extra fields fail closed.

import { describe, it, expect } from 'vitest';
import {
  ProvenanceManifestSchema,
  TradeOverviewSummarySchema,
  TrendPerDaySchema,
  OrderDetailPerDaySummarySchema,
  OrderDetailRowSchema,
  YMD,
} from '#shared/contracts/historical-dataset.js';

describe('YMD regex', () => {
  it('accepts canonical YYYY-MM-DD', () => {
    expect(YMD.test('2026-08-04')).toBe(true);
    expect(YMD.test('2026-12-31')).toBe(true);
  });
  it('rejects non-conforming strings', () => {
    expect(YMD.test('2026-8-4')).toBe(false);
    expect(YMD.test('2026/08/04')).toBe(false);
    expect(YMD.test('not-a-date')).toBe(false);
    expect(YMD.test('')).toBe(false);
  });
});

describe('ProvenanceManifestSchema', () => {
  it('accepts a minimal valid manifest', () => {
    const r = ProvenanceManifestSchema.safeParse({
      manifest_version: '1.0',
      acquired_at: '2026-09-03T08:43:52+08:00',
      acquisition_run_id: 'run-1',
      shop: { shop_id: '11855009', shop_name: 'S' },
      time_window: { start: '2026-08-04', end: '2026-09-02', days: 30 },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an end-before-start window', () => {
    const r = ProvenanceManifestSchema.safeParse({
      manifest_version: '1.0',
      acquired_at: '2026-09-03T08:43:52+08:00',
      acquisition_run_id: 'run-1',
      shop: { shop_id: '11855009', shop_name: 'S' },
      time_window: { start: '2026-09-02', end: '2026-08-04', days: -29 },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a bad YYYY-MM-DD in the window', () => {
    const r = ProvenanceManifestSchema.safeParse({
      manifest_version: '1.0',
      acquired_at: '2026-09-03T08:43:52+08:00',
      acquisition_run_id: 'run-1',
      shop: { shop_id: '11855009', shop_name: 'S' },
      time_window: { start: '2026-8-4', end: '2026-09-02', days: 30 },
    });
    expect(r.success).toBe(false);
  });
});

describe('TradeOverviewSummarySchema', () => {
  it('accepts the 12-KPI structure', () => {
    const r = TradeOverviewSummarySchema.safeParse({
      shop_id: '11855009',
      all_kpis_readable: {
        'GMV 成交金额': { value: 195136.89, compare_pct: 0.42 },
        'orders 成交单量': { value: 1450, compare_pct: 0.97 },
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-numeric value', () => {
    const r = TradeOverviewSummarySchema.safeParse({
      shop_id: '11855009',
      all_kpis_readable: {
        'GMV 成交金额': { value: 'not-a-number', compare_pct: 0.42 },
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('TrendPerDaySchema', () => {
  it('accepts a 30-row trend with 3 series', () => {
    const r = TrendPerDaySchema.safeParse({
      shop_id: '11855009',
      xaxis: Array.from({ length: 30 }, (_, i) => `2026-08-${String(4 + i).padStart(2, '0')}`),
      series: [
        { code: 'merchant', data: Array(30).fill(0) },
        { code: 'industry', data: Array(30).fill(0) },
        { code: 'preIndustry', data: Array(30).fill(0) },
      ],
      rows: Array.from({ length: 30 }, (_, i) => ({
        date: `2026-08-${String(4 + i).padStart(2, '0')}`,
        merchant_gmv: 1000 + i,
      })),
    });
    expect(r.success).toBe(true);
  });
});

describe('OrderDetailPerDaySummarySchema', () => {
  it('accepts the per-day array shape', () => {
    const r = OrderDetailPerDaySummarySchema.safeParse({
      shop_id: '11855009',
      unique_orders: 1450,
      rows_total: 2412,
      per_day: [
        ['2026-08-04', { orders: 23, qty: 41, amt: 3961.21 }],
        ['2026-08-05', { orders: 21, qty: 44, amt: 6804.36 }],
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe('OrderDetailRowSchema', () => {
  it('accepts a parent row', () => {
    const r = OrderDetailRowSchema.safeParse({
      order_id: '3609430017741362',
      shop_id: '11855009',
      spu_id: 10023923194464,
      sku_id: 10103006726696,
      sku_name: '茶',
      sale_qty: 2,
      ord_amt: 79.2,
      pre_discount_amt: 0,
      sku_jd_price: 99.0,
      delivery_service_fee: 0,
      sku_freight_amt: 0,
      ord_type: 0,
      is_same_member: 0,
      channel_code: 'app',
      pay_method_code: 4,
      pay_method_desc: '在线支付',
      biz_date: '2026-09-02',
      sale_ord_tm: '2026-09-02 23:30:26',
      pay_tm: '2026-09-02 23:30:28',
      row_kind: 'header',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a row_kind that is not header/child', () => {
    const r = OrderDetailRowSchema.safeParse({
      order_id: '1',
      shop_id: '11855009',
      spu_id: 1,
      sku_id: 1,
      sku_name: 'x',
      sale_qty: 1,
      ord_amt: 0,
      pre_discount_amt: 0,
      sku_jd_price: 0,
      delivery_service_fee: 0,
      sku_freight_amt: 0,
      ord_type: 0,
      is_same_member: 0,
      channel_code: 'app',
      pay_method_code: 4,
      pay_method_desc: '在线支付',
      biz_date: '2026-09-02',
      sale_ord_tm: '2026-09-02 23:30:26',
      pay_tm: '2026-09-02 23:30:28',
      row_kind: 'unknown',
    });
    expect(r.success).toBe(false);
  });
});
