// P0013 Task 2 — Per-order summary tests (Phase A + Phase H).
//
// Pins:
//   - Phase A: average_order_amount vs customer_aov labels. The data
//     selects the label, NOT the LLM. When customers is absent, the
//     output uses "平均订单金额" (not "客单价"). When customers > 0, both
//     labels appear. When customers === 0, the contract refuses (the
//     superRefine rejects).
//   - Phase H: header_units ≠ sku_units is preserved verbatim. The
//     summary includes the literal note "(note: H≠S by source design)".
//   - Phase B: renderPerOrderSummary is bounded and deterministic.

import { describe, it, expect } from 'vitest';
import {
  computePerOrderMetrics,
  computeTopContributors,
  renderPerOrderSummary,
} from '#app/runtime/replay/per-order-summary.js';
import { OrderEvidenceMetricsSchema } from '#shared/contracts/historical-dataset.js';
import type { OrderDetailRow } from '#shared/contracts/historical-dataset.js';

const headerRow = (overrides: Partial<OrderDetailRow> = {}): OrderDetailRow => ({
  order_id: '100',
  shop_id: '11855009',
  spu_id: 1,
  sku_id: 1000,
  sku_name: 'Sample',
  sale_qty: 2,
  ord_amt: 200,
  pre_discount_amt: 200,
  sku_jd_price: 100,
  delivery_service_fee: 0,
  sku_freight_amt: 0,
  ord_type: 1,
  channel_code: 'C1',
  pay_method_desc: '微信',
  biz_date: '2026-09-01',
  sale_ord_tm: '2026-09-01T10:00:00+08:00',
  pay_tm: '2026-09-01T10:05:00+08:00',
  row_kind: 'header',
  ...overrides,
});

const childRow = (overrides: Partial<OrderDetailRow> = {}): OrderDetailRow => ({
  order_id: '100',
  shop_id: '11855009',
  spu_id: 1,
  sku_id: 1000,
  sku_name: 'Sample',
  sale_qty: 2,
  ord_amt: 200,
  pre_discount_amt: 200,
  sku_jd_price: 100,
  delivery_service_fee: 0,
  sku_freight_amt: 0,
  ord_type: 1,
  channel_code: 'C1',
  pay_method_desc: '微信',
  biz_date: '2026-09-01',
  sale_ord_tm: '2026-09-01T10:00:00+08:00',
  pay_tm: '2026-09-01T10:05:00+08:00',
  row_kind: 'child',
  ...overrides,
});

describe('OrderEvidenceMetricsSchema — Phase A contract', () => {
  it('accepts a minimal valid metrics object', () => {
    const r = OrderEvidenceMetricsSchema.safeParse({
      gmv: 1000,
      parent_orders: 5,
      header_units: 10,
      sku_line_count: 8,
      unique_skus: 3,
      average_order_amount: 200,
    });
    expect(r.success).toBe(true);
  });

  it('REJECTS when parent_orders > 0 but average_order_amount is missing', () => {
    const r = OrderEvidenceMetricsSchema.safeParse({
      gmv: 1000,
      parent_orders: 5,
      header_units: 10,
      sku_line_count: 8,
      unique_skus: 3,
    });
    expect(r.success).toBe(false);
  });

  it('REJECTS customer_aov without customers (label-source contract)', () => {
    const r = OrderEvidenceMetricsSchema.safeParse({
      gmv: 1000,
      parent_orders: 5,
      header_units: 10,
      sku_line_count: 8,
      unique_skus: 3,
      average_order_amount: 200,
      customer_aov: 200, // customers missing
    });
    expect(r.success).toBe(false);
  });

  it('REJECTS customers === 0 (must be omitted, not zero)', () => {
    const r = OrderEvidenceMetricsSchema.safeParse({
      gmv: 1000,
      parent_orders: 5,
      header_units: 10,
      sku_line_count: 8,
      unique_skus: 3,
      average_order_amount: 200,
      customers: 0,
      customer_aov: 200,
    });
    expect(r.success).toBe(false);
  });

  it('ACCEPTS customers > 0 with customer_aov', () => {
    const r = OrderEvidenceMetricsSchema.safeParse({
      gmv: 1000,
      parent_orders: 5,
      header_units: 10,
      sku_line_count: 8,
      unique_skus: 3,
      average_order_amount: 200,
      customers: 4,
      customer_aov: 250,
    });
    expect(r.success).toBe(true);
  });
});

describe('computePerOrderMetrics', () => {
  it('emits average_order_amount = GMV / parent_orders when customers absent', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ ord_amt: 200, sale_qty: 2 }),
      headerRow({ order_id: '101', ord_amt: 800, sale_qty: 4 }),
    ];
    const m = computePerOrderMetrics(rows);
    expect(m.gmv).toBe(1000);
    expect(m.parent_orders).toBe(2);
    expect(m.header_units).toBe(6);
    expect(m.average_order_amount).toBe(500);
    expect(m.customers).toBeUndefined();
    expect(m.customer_aov).toBeUndefined();
  });

  it('emits BOTH average_order_amount and customer_aov when customers > 0', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ ord_amt: 200, sale_qty: 2 }),
      headerRow({ order_id: '101', ord_amt: 800, sale_qty: 4 }),
    ];
    const m = computePerOrderMetrics(rows, undefined, 4);
    expect(m.average_order_amount).toBe(500);
    expect(m.customers).toBe(4);
    expect(m.customer_aov).toBe(250);
  });

  it('uses gmvOverride when provided (reconciles with KPI summary)', () => {
    const rows: OrderDetailRow[] = [headerRow({ ord_amt: 100, sale_qty: 1 })];
    const m = computePerOrderMetrics(rows, 200); // explicit GMV differs
    expect(m.gmv).toBe(200);
    expect(m.average_order_amount).toBe(200); // GMV / parent_orders
  });

  it('counts sku_lines and unique_skus from child rows only', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ order_id: '1', ord_amt: 300 }),
      childRow({ sku_id: 10, ord_amt: 100 }),
      childRow({ sku_id: 10, ord_amt: 100 }),
      childRow({ sku_id: 20, ord_amt: 100 }),
    ];
    const m = computePerOrderMetrics(rows);
    expect(m.sku_line_count).toBe(3);
    expect(m.unique_skus).toBe(2);
  });

  it('returns parent_orders=0 metrics with no average_order_amount', () => {
    const m = computePerOrderMetrics([]);
    expect(m.parent_orders).toBe(0);
    expect(m.average_order_amount).toBeUndefined();
  });
});

describe('computeTopContributors', () => {
  it('picks the top SKU by sum(ord_amt) across child rows', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ order_id: '1', ord_amt: 1000 }),
      childRow({ sku_id: 10, sku_name: 'A', ord_amt: 600 }),
      childRow({ sku_id: 20, sku_name: 'B', ord_amt: 400 }),
    ];
    const t = computeTopContributors(rows, 1000);
    expect(t.top_sku).not.toBeNull();
    expect(t.top_sku?.sku_id).toBe(10);
    expect(t.top_sku?.ord_amt).toBe(600);
    expect(t.top_sku?.pct_of_gmv).toBeCloseTo(0.6);
  });

  it('picks the top order by max(ord_amt) over header rows', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ order_id: '1', ord_amt: 100 }),
      headerRow({ order_id: '2', ord_amt: 800 }),
      headerRow({ order_id: '3', ord_amt: 200 }),
    ];
    const t = computeTopContributors(rows, 1100);
    expect(t.top_order?.order_id).toBe('2');
    expect(t.top_order?.pct_of_gmv).toBeCloseTo(800 / 1100);
  });

  it('returns nulls when rows are empty', () => {
    const t = computeTopContributors([], 0);
    expect(t.top_sku).toBeNull();
    expect(t.top_order).toBeNull();
  });
});

describe('renderPerOrderSummary — Phase A label selection', () => {
  it('uses 平均订单金额 when customers is absent', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ order_id: '1', ord_amt: 100 }),
      headerRow({ order_id: '2', ord_amt: 200 }),
    ];
    const s = renderPerOrderSummary(rows, '2026-09-01');
    expect(s).toContain('平均订单金额=150.00');
    expect(s).toContain('客单价=—'); // explicit "no customer data"
    // Negative assertion: the LABEL "客单价=NUMBER" must NOT appear.
    expect(s).not.toMatch(/客单价=\d/);
  });

  it('uses 客单价 only when customers > 0', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ order_id: '1', ord_amt: 100 }),
      headerRow({ order_id: '2', ord_amt: 200 }),
    ];
    const s = renderPerOrderSummary(rows, '2026-09-01', undefined, 2);
    expect(s).toContain('平均订单金额=150.00');
    expect(s).toMatch(/客单价=150\.00/);
  });
});

describe('renderPerOrderSummary — Phase H header.sale_qty vs sum(child.sale_qty)', () => {
  it('emits the H≠S note when header_units ≠ sum(child.sale_qty)', () => {
    // Real P0011.x example: H=2, S=1 (one child row for the same order)
    const rows: OrderDetailRow[] = [
      headerRow({ order_id: '1', ord_amt: 100, sale_qty: 2 }),
      childRow({ order_id: '1', ord_amt: 100, sale_qty: 1 }),
    ];
    const s = renderPerOrderSummary(rows, '2026-09-01');
    expect(s).toContain('header_units=2');
    expect(s).toContain('sku_units=1');
    expect(s).toContain('(note: H≠S by source design)');
    expect(s).not.toContain('(consistent)');
  });

  it('emits (consistent) when header_units === sum(child.sale_qty)', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ order_id: '1', ord_amt: 100, sale_qty: 2 }),
      childRow({ order_id: '1', ord_amt: 60, sale_qty: 1 }),
      childRow({ order_id: '1', ord_amt: 40, sale_qty: 1 }),
    ];
    const s = renderPerOrderSummary(rows, '2026-09-01');
    expect(s).toContain('header_units=2');
    expect(s).toContain('sku_units=2');
    expect(s).toContain('(consistent)');
  });
});

describe('renderPerOrderSummary — Phase B bounds + determinism', () => {
  it('output is bounded to ~250 chars (no row dump)', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ order_id: '1', ord_amt: 100 }),
      childRow({ sku_id: 10, ord_amt: 100 }),
    ];
    const s = renderPerOrderSummary(rows, '2026-09-01');
    expect(s.length).toBeLessThan(400);
  });

  it('is deterministic (same input → same output)', () => {
    const rows: OrderDetailRow[] = [
      headerRow({ order_id: '1', ord_amt: 100 }),
      childRow({ sku_id: 10, ord_amt: 100 }),
    ];
    const a = renderPerOrderSummary(rows, '2026-09-01');
    const b = renderPerOrderSummary(rows, '2026-09-01');
    expect(a).toBe(b);
  });

  it('returns a non-empty summary even with empty rows', () => {
    const s = renderPerOrderSummary([], '2026-09-01');
    expect(s).toContain('parent_orders=0');
    expect(s).toContain('top_sku=—');
    expect(s).toContain('top_order=—');
  });
});
