// P0013 Task 2 Phase C — order-retrieval tests.
//
// Pins the 6 query shapes + the No-Future-Leak invariant at the function
// boundary (NOT at the caller). The data is synthetic — the test does not
// load the real P0011.x fixture (the real-fixture reconciliation lives in
// tests/integration/replay-reconciliation-real.test.ts).

import { describe, it, expect } from 'vitest';
import {
  retrieveOrders,
  computeOrderAmountDistribution,
  ALL_RETRIEVAL_QUERIES,
} from '#app/runtime/replay/order-retrieval.js';
import type { OrderDetailRow } from '#shared/contracts/historical-dataset.js';

const baseRow = (overrides: Partial<OrderDetailRow>): OrderDetailRow => ({
  order_id: '1',
  shop_id: '11855009',
  spu_id: 1,
  sku_id: 1000,
  sku_name: 'Sample',
  sale_qty: 1,
  ord_amt: 100,
  pre_discount_amt: 100,
  sku_jd_price: 100,
  delivery_service_fee: 0,
  sku_freight_amt: 0,
  ord_type: 1,
  channel_code: 'C1',
  pay_method_desc: '微信',
  biz_date: '2026-08-10',
  sale_ord_tm: '2026-08-10T10:00:00+08:00',
  pay_tm: '2026-08-10T10:05:00+08:00',
  row_kind: 'header',
  ...overrides,
});

const fixture: OrderDetailRow[] = [
  baseRow({ order_id: 'h1', biz_date: '2026-08-10', ord_amt: 100, sale_qty: 2, row_kind: 'header' }),
  baseRow({ order_id: 'h2', biz_date: '2026-08-10', ord_amt: 500, sale_qty: 1, row_kind: 'header' }),
  baseRow({ order_id: 'h3', biz_date: '2026-08-10', ord_amt: 2000, sale_qty: 3, row_kind: 'header' }),
  baseRow({ order_id: 'c1', biz_date: '2026-08-10', sku_id: 100, sku_name: 'A', ord_amt: 80, row_kind: 'child' }),
  baseRow({ order_id: 'c2', biz_date: '2026-08-10', sku_id: 200, sku_name: 'B', ord_amt: 220, row_kind: 'child' }),
  baseRow({ order_id: 'c3', biz_date: '2026-08-11', sku_id: 100, sku_name: 'A', ord_amt: 90, row_kind: 'child' }),
  // Future row — must NEVER appear when T < 2026-08-12
  baseRow({ order_id: 'hFUT', biz_date: '2026-08-12', ord_amt: 9999, row_kind: 'header' }),
];

describe('retrieveOrders — No-Future-Leak (Phase E contract)', () => {
  it('never returns rows with biz_date > upToBusinessDate, regardless of query', () => {
    for (const q of ALL_RETRIEVAL_QUERIES) {
      const params = q === 'perSkuDailyOrders' ? { skuId: 100 } : {};
      const out = retrieveOrders(fixture, '2026-08-11', q, params);
      for (const r of out) {
        expect(r.biz_date <= '2026-08-11').toBe(true);
        // The hFUT row at 2026-08-12 must NEVER appear
        expect(r.order_id).not.toBe('hFUT');
      }
    }
  });

  it('with upToBusinessDate=2026-08-12, includes the previously-future row', () => {
    const out = retrieveOrders(fixture, '2026-08-12', 'parentOrdersByDay');
    expect(out.some((r) => r.order_id === 'hFUT')).toBe(true);
  });
});

describe('retrieveOrders — 6 query shapes', () => {
  it('parentOrdersByDay returns only header rows for the slice', () => {
    const out = retrieveOrders(fixture, '2026-08-11', 'parentOrdersByDay');
    expect(out.length).toBe(3);
    expect(out.every((r) => r.row_kind === 'header')).toBe(true);
  });

  it('skuLinesByDay returns only child rows for the slice', () => {
    const out = retrieveOrders(fixture, '2026-08-11', 'skuLinesByDay');
    expect(out.length).toBe(3); // c1, c2, c3
    expect(out.every((r) => r.row_kind === 'child')).toBe(true);
  });

  it('skuGmvContribution groups by sku_id, sorts desc, sums ord_amt + sale_qty', () => {
    const out = retrieveOrders(fixture, '2026-08-11', 'skuGmvContribution');
    // SKU 100: c1 (80) + c3 (90) = 170
    // SKU 200: c2 (220)
    expect(out.length).toBe(2);
    // Sorted desc by ord_amt
    expect(out[0]?.sku_id).toBe(200);
    expect(out[0]?.ord_amt).toBe(220);
    expect(out[1]?.sku_id).toBe(100);
    expect(out[1]?.ord_amt).toBe(170);
    expect(out[1]?.sale_qty).toBe(2);
  });

  it('orderAmountDistribution returns header rows (histogram is derived)', () => {
    const out = retrieveOrders(fixture, '2026-08-11', 'orderAmountDistribution');
    expect(out.every((r) => r.row_kind === 'header')).toBe(true);
  });

  it('topContributingOrders default N=10, sorted desc by ord_amt', () => {
    const out = retrieveOrders(fixture, '2026-08-11', 'topContributingOrders');
    expect(out.length).toBe(3); // only 3 headers, not 10
    expect(out[0]?.order_id).toBe('h3'); // 2000
    expect(out[1]?.order_id).toBe('h2'); // 500
    expect(out[2]?.order_id).toBe('h1'); // 100
  });

  it('topContributingOrders respects caller N override', () => {
    const out = retrieveOrders(fixture, '2026-08-11', 'topContributingOrders', { topN: 1 });
    expect(out.length).toBe(1);
    expect(out[0]?.order_id).toBe('h3');
  });

  it('perSkuDailyOrders filters to a specific sku_id', () => {
    const out = retrieveOrders(fixture, '2026-08-11', 'perSkuDailyOrders', { skuId: 100 });
    expect(out.every((r) => r.sku_id === 100)).toBe(true);
    expect(out.length).toBe(2);
  });

  it('perSkuDailyOrders throws when skuId is missing', () => {
    expect(() => retrieveOrders(fixture, '2026-08-11', 'perSkuDailyOrders')).toThrow(
      /requires params\.skuId/,
    );
  });

  it('returns [] when no rows match the slice', () => {
    const out = retrieveOrders(fixture, '2026-08-09', 'parentOrdersByDay');
    expect(out).toEqual([]);
  });
});

describe('computeOrderAmountDistribution', () => {
  it('buckets header rows into 5 fixed buckets', () => {
    const headers: OrderDetailRow[] = [
      baseRow({ order_id: 'a', ord_amt: 5, row_kind: 'header' }),
      baseRow({ order_id: 'b', ord_amt: 30, row_kind: 'header' }),
      baseRow({ order_id: 'c', ord_amt: 80, row_kind: 'header' }),
      baseRow({ order_id: 'd', ord_amt: 300, row_kind: 'header' }),
      baseRow({ order_id: 'e', ord_amt: 800, row_kind: 'header' }),
    ];
    const dist = computeOrderAmountDistribution(headers);
    expect(dist.length).toBe(5);
    const by = Object.fromEntries(dist.map((b) => [b.label, b]));
    expect(by['<10']?.count).toBe(1);
    expect(by['10-50']?.count).toBe(1);
    expect(by['50-100']?.count).toBe(1);
    expect(by['100-500']?.count).toBe(1);
    expect(by['500+']?.count).toBe(1);
  });

  it('ignores child rows', () => {
    const rows: OrderDetailRow[] = [
      baseRow({ order_id: 'h', ord_amt: 5, row_kind: 'header' }),
      baseRow({ order_id: 'c', ord_amt: 5000, row_kind: 'child' }),
    ];
    const dist = computeOrderAmountDistribution(rows);
    const total = dist.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(1);
  });
});
