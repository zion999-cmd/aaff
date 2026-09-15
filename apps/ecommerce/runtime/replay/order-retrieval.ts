// P0013 Task 2 Phase C — Order retrieval over the frozen P0011.x rows.
//
// 6 query shapes, all subject to the No-Future-Leak invariant at the
// function boundary (`upToBusinessDate`). The LLM does NOT pre-sample;
// the caller asks for one of 6 shapes and the function returns the
// matching rows.
//
// HARD INVARIANT:
//   1. The filter `r.biz_date <= upToBusinessDate` is enforced INSIDE
//      this function, NOT by the caller. A caller passing future dates
//      still gets only the visible slice.
//   2. The function is PURE — no I/O, no clock, no DB. The caller passes
//      the (already-loaded) row array.
//   3. The function does NOT import from connectors/skills/knowledge/policy.
//      It is a pure data utility over OrderDetailRow[].
//   4. topContributingOrders has a DEFAULT N=10; the N is overridable
//      by the caller. The default is the operator-facing API default,
//      NOT a sample-as-only-access. The full 1450 rows remain reachable
//      via `parentOrdersByDay` (no N).
//   5. The function does NOT reconcile header.sale_qty vs child.sale_qty.
//      Pass-through only.

import type { OrderDetailRow } from '#shared/contracts/historical-dataset.js';

export type RetrievalQuery =
  | 'parentOrdersByDay'
  | 'skuLinesByDay'
  | 'skuGmvContribution'
  | 'orderAmountDistribution'
  | 'topContributingOrders'
  | 'perSkuDailyOrders';

export const ALL_RETRIEVAL_QUERIES: readonly RetrievalQuery[] = [
  'parentOrdersByDay',
  'skuLinesByDay',
  'skuGmvContribution',
  'orderAmountDistribution',
  'topContributingOrders',
  'perSkuDailyOrders',
] as const;

export interface RetrievalQueryParams {
  readonly skuId?: number;
  readonly topN?: number;
}

export type RetrievalResult = ReadonlyArray<OrderDetailRow>;

const applyNoFutureLeak = (
  rows: readonly OrderDetailRow[],
  upToBusinessDate: string,
): OrderDetailRow[] => {
  return rows.filter((r) => r.biz_date <= upToBusinessDate);
};

export const retrieveOrders = (
  allRows: readonly OrderDetailRow[],
  upToBusinessDate: string,
  query: RetrievalQuery,
  params: RetrievalQueryParams = {},
): RetrievalResult => {
  const visible = applyNoFutureLeak(allRows, upToBusinessDate);

  switch (query) {
    case 'parentOrdersByDay':
      return visible.filter((r) => r.row_kind === 'header');

    case 'skuLinesByDay':
      return visible.filter((r) => r.row_kind === 'child');

    case 'skuGmvContribution': {
      const skuSum = new Map<number, { amt: number; qty: number; sample: OrderDetailRow }>();
      for (const r of visible) {
        if (r.row_kind !== 'child') continue;
        const cur = skuSum.get(r.sku_id);
        if (cur) {
          cur.amt += r.ord_amt;
          cur.qty += r.sale_qty;
        } else {
          skuSum.set(r.sku_id, { amt: r.ord_amt, qty: r.sale_qty, sample: r });
        }
      }
      const out: OrderDetailRow[] = [];
      for (const { amt, qty, sample } of skuSum.values()) {
        out.push({ ...sample, ord_amt: amt, sale_qty: qty });
      }
      out.sort((a, b) => b.ord_amt - a.ord_amt);
      return out;
    }

    case 'orderAmountDistribution':
      return visible.filter((r) => r.row_kind === 'header');

    case 'topContributingOrders': {
      const n = params.topN ?? 10;
      const headers = visible.filter((r) => r.row_kind === 'header');
      const sorted = [...headers].sort((a, b) => b.ord_amt - a.ord_amt);
      return sorted.slice(0, n);
    }

    case 'perSkuDailyOrders': {
      if (params.skuId === undefined) {
        throw new Error(
          "retrieveOrders: 'perSkuDailyOrders' requires params.skuId (number)",
        );
      }
      const target = params.skuId;
      return visible.filter(
        (r) => r.row_kind === 'child' && r.sku_id === target,
      );
    }

    default: {
      const _exhaustive: never = query;
      throw new Error(`retrieveOrders: unknown query "${String(_exhaustive)}"`);
    }
  }
};

export interface OrderAmountBucket {
  readonly label: string;
  readonly min: number;
  readonly maxExclusive: number | null;
  readonly count: number;
  readonly totalAmt: number;
}

export const computeOrderAmountDistribution = (
  rows: readonly OrderDetailRow[],
): readonly OrderAmountBucket[] => {
  const buckets: Array<{ label: string; min: number; max: number | null; count: number; amt: number }> = [
    { label: '<10', min: 0, max: 10, count: 0, amt: 0 },
    { label: '10-50', min: 10, max: 50, count: 0, amt: 0 },
    { label: '50-100', min: 50, max: 100, count: 0, amt: 0 },
    { label: '100-500', min: 100, max: 500, count: 0, amt: 0 },
    { label: '500+', min: 500, max: null, count: 0, amt: 0 },
  ];
  for (const r of rows) {
    if (r.row_kind !== 'header') continue;
    for (const b of buckets) {
      const inLow = r.ord_amt >= b.min;
      const inHigh = b.max === null || r.ord_amt < b.max;
      if (inLow && inHigh) {
        b.count += 1;
        b.amt += r.ord_amt;
        break;
      }
    }
  }
  return buckets.map((b) => ({
    label: b.label,
    min: b.min,
    maxExclusive: b.max,
    count: b.count,
    totalAmt: b.amt,
  }));
};
