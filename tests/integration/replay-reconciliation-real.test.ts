// P0013 Task 2 Phase I — Real data reconciliation test.
//
// For each of the 4 audit dates (08-10 / 08-18 / 09-01 / 09-02), compute
// the Order Evidence Metrics from the raw P0011.x dataset and compare to
// what `renderPerOrderSummary` produces. The numbers MUST match exactly —
// same dataset, same logic. Any delta is a real bug.
//
// This test is the GATE for the LLM's "average order amount" claim
// (Phase A semantic fix): the prompt's value is what the LLM sees, so it
// MUST be the same number that an independent recomputation produces.
//
// Gated on the real fixture; skipped when the dataset is absent.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { loadHistoricalDataset } from '#app/runtime/replay/historical-dataset.js';
import {
  computePerOrderMetrics,
  computeTopContributors,
  renderPerOrderSummary,
} from '#app/runtime/replay/per-order-summary.js';

const DATASET_PATH = 'data/jd_acquisition_20260903_0834';
const HAS_REAL_FIXTURE = existsSync(DATASET_PATH);

const itIfFixture = HAS_REAL_FIXTURE ? it : it.skip;

interface ExpectedRow {
  readonly businessDate: string;
  readonly parent_orders: number;
  readonly sku_lines: number;
  readonly unique_skus: number;
  readonly gmv: number;
  readonly header_units: number;
  readonly sku_units: number;
  readonly average_order_amount: number;
  readonly top_sku_id: number;
  readonly top_sku_amt: number;
  readonly top_sku_pct: number;
  readonly top_order_amt: number;
}

// Reference numbers computed independently from the parsed P0011.x data
// (see recon.py in the planning notes). ANY change here MUST be
// accompanied by a corresponding change in the production logic, not the
// other way around (CLAUDE.md "Never modify source facts merely to
// satisfy tests").
const EXPECTED: readonly ExpectedRow[] = [
  {
    businessDate: '2026-08-10',
    parent_orders: 23,
    sku_lines: 20,
    unique_skus: 12,
    gmv: 5175.16,
    header_units: 45,
    sku_units: 31,
    average_order_amount: 225.01,
    top_sku_id: 10120900397848,
    top_sku_amt: 1900.00,
    top_sku_pct: 36.7,
    top_order_amt: 1900.00,
  },
  {
    businessDate: '2026-08-18',
    parent_orders: 30,
    sku_lines: 28,
    unique_skus: 14,
    gmv: 4978.54,
    header_units: 51,
    sku_units: 35,
    average_order_amount: 165.95,
    top_sku_id: 10128447475894,
    top_sku_amt: 571.65,
    top_sku_pct: 11.5,
    top_order_amt: 571.65,
  },
  {
    businessDate: '2026-09-01',
    parent_orders: 37,
    sku_lines: 45,
    unique_skus: 15,
    gmv: 10609.95,
    header_units: 106,
    sku_units: 88,
    average_order_amount: 286.76,
    top_sku_id: 10076147649602,
    top_sku_amt: 3513.89,
    top_sku_pct: 33.1,
    top_order_amt: 2201.04,
  },
  {
    businessDate: '2026-09-02',
    parent_orders: 129,
    sku_lines: 30,
    unique_skus: 12,
    gmv: 5875.00,
    header_units: 146,
    sku_units: 31,
    average_order_amount: 45.54,
    top_sku_id: 10114242621660,
    top_sku_amt: 1625.59,
    top_sku_pct: 27.7,
    top_order_amt: 420.00,
  },
];

describe('Phase I — Real data reconciliation (4 audit dates)', () => {
  itIfFixture('all 4 dates reconcile exactly against the independent recomputation', () => {
    const dataset = loadHistoricalDataset(DATASET_PATH);
    const rowsByDay = new Map<string, typeof dataset.orderDetails.rows>();
    for (const r of dataset.orderDetails.rows) {
      const cur = rowsByDay.get(r.biz_date) ?? [];
      cur.push(r);
      rowsByDay.set(r.biz_date, cur);
    }

    for (const exp of EXPECTED) {
      const dayRows = rowsByDay.get(exp.businessDate) ?? [];
      const metrics = computePerOrderMetrics(dayRows);
      const tops = computeTopContributors(dayRows, metrics.gmv);

      // Core metrics
      expect(metrics.parent_orders, `parent_orders @ ${exp.businessDate}`).toBe(
        exp.parent_orders,
      );
      expect(metrics.sku_line_count, `sku_lines @ ${exp.businessDate}`).toBe(exp.sku_lines);
      expect(metrics.unique_skus, `unique_skus @ ${exp.businessDate}`).toBe(exp.unique_skus);
      expect(metrics.gmv, `gmv @ ${exp.businessDate}`).toBeCloseTo(exp.gmv, 2);
      expect(metrics.header_units, `header_units @ ${exp.businessDate}`).toBe(
        exp.header_units,
      );
      expect(
        metrics.average_order_amount,
        `average_order_amount @ ${exp.businessDate}`,
      ).toBeCloseTo(exp.average_order_amount, 2);

      // Top contributors
      expect(tops.top_sku?.sku_id, `top_sku_id @ ${exp.businessDate}`).toBe(exp.top_sku_id);
      expect(tops.top_sku?.ord_amt, `top_sku_amt @ ${exp.businessDate}`).toBeCloseTo(
        exp.top_sku_amt,
        2,
      );
      expect(tops.top_sku?.pct_of_gmv, `top_sku_pct @ ${exp.businessDate}`).toBeCloseTo(
        exp.top_sku_pct / 100,
        3,
      );
      expect(tops.top_order?.ord_amt, `top_order_amt @ ${exp.businessDate}`).toBeCloseTo(
        exp.top_order_amt,
        2,
      );

      // H/S asymmetry: preserved verbatim
      const skuUnits = dayRows
        .filter((r) => r.row_kind === 'child')
        .reduce((s, r) => s + r.sale_qty, 0);
      expect(skuUnits, `sku_units @ ${exp.businessDate}`).toBe(exp.sku_units);
      expect(metrics.header_units === skuUnits, `H=S @ ${exp.businessDate}`).toBe(false);
    }
  });

  itIfFixture('renderPerOrderSummary uses 平均订单金额 (not 客单价) — all 4 dates', () => {
    const dataset = loadHistoricalDataset(DATASET_PATH);
    const rowsByDay = new Map<string, typeof dataset.orderDetails.rows>();
    for (const r of dataset.orderDetails.rows) {
      const cur = rowsByDay.get(r.biz_date) ?? [];
      cur.push(r);
      rowsByDay.set(r.biz_date, cur);
    }

    for (const exp of EXPECTED) {
      const dayRows = rowsByDay.get(exp.businessDate) ?? [];
      const summary = renderPerOrderSummary(dayRows, exp.businessDate);
      // The label is data-driven: 客单价 shows ONLY when customers is set.
      // The P0011.x source has no customers field, so 客单价=— and the
      // actual GMV/orders number appears under 平均订单金额.
      expect(summary, `summary contains 平均订单金额 @ ${exp.businessDate}`).toContain(
        `平均订单金额=${exp.average_order_amount.toFixed(2)}`,
      );
      expect(summary, `summary contains 客单价=— @ ${exp.businessDate}`).toContain('客单价=—');
      expect(summary, `summary explicitly NOT 客单价=number @ ${exp.businessDate}`).not.toMatch(
        /客单价=\d/,
      );
    }
  });

  itIfFixture('renderPerOrderSummary H≠S note preserved for all 4 dates', () => {
    const dataset = loadHistoricalDataset(DATASET_PATH);
    const rowsByDay = new Map<string, typeof dataset.orderDetails.rows>();
    for (const r of dataset.orderDetails.rows) {
      const cur = rowsByDay.get(r.biz_date) ?? [];
      cur.push(r);
      rowsByDay.set(r.biz_date, cur);
    }

    for (const exp of EXPECTED) {
      const dayRows = rowsByDay.get(exp.businessDate) ?? [];
      const summary = renderPerOrderSummary(dayRows, exp.businessDate);
      expect(summary, `H≠S note @ ${exp.businessDate}`).toContain('(note: H≠S by source design)');
    }
  });

  itIfFixture('reconciliation table (for Phase L final report)', () => {
    const dataset = loadHistoricalDataset(DATASET_PATH);
    const rowsByDay = new Map<string, typeof dataset.orderDetails.rows>();
    for (const r of dataset.orderDetails.rows) {
      const cur = rowsByDay.get(r.biz_date) ?? [];
      cur.push(r);
      rowsByDay.set(r.biz_date, cur);
    }
    const lines: string[] = [
      '| business_date | parent_orders | sku_lines | unique_skus | gmv | aov | H | S | Δ | top_sku_id | top_sku_amt | top_sku_% | top_order_amt |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const exp of EXPECTED) {
      const dayRows = rowsByDay.get(exp.businessDate) ?? [];
      const metrics = computePerOrderMetrics(dayRows);
      const tops = computeTopContributors(dayRows, metrics.gmv);
      const skuUnits = dayRows
        .filter((r) => r.row_kind === 'child')
        .reduce((s, r) => s + r.sale_qty, 0);
      lines.push(
        `| ${exp.businessDate} | ${metrics.parent_orders} | ${metrics.sku_line_count} | ${metrics.unique_skus} | ${metrics.gmv.toFixed(2)} | ${(metrics.average_order_amount ?? 0).toFixed(2)} | ${metrics.header_units} | ${skuUnits} | ${metrics.header_units - skuUnits} | ${tops.top_sku?.sku_id ?? '—'} | ${tops.top_sku?.ord_amt.toFixed(2) ?? '—'} | ${tops.top_sku ? (tops.top_sku.pct_of_gmv * 100).toFixed(1) : '—'} | ${tops.top_order?.ord_amt.toFixed(2) ?? '—'} |`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n=== Phase I reconciliation table ===\n' + lines.join('\n'));
  });
});
