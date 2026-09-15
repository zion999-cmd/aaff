// P0013 Task 2 — Per-order summary + AOV / average_order_amount contract.
//
// Phase A (metric semantics) + Phase B (per-order evidence seeding summary)
// + Phase H (preserve header.sale_qty ≠ sum(child.sale_qty)).
//
// All three phases live in this single pure module so the kernel's
// readEvidenceContentSummary and the seed-evidence seeding share the same
// stat computation.
//
// INVARIANTS:
//   1. PURE — no DB, no I/O, no clock. The function takes an array of
//      OrderDetailRow (already filtered to one day by the caller) and
//      returns a deterministic string.
//   2. The LABEL is selected by the data, not the LLM.
//      - GMV / parent_orders  → "平均订单金额" (Average Order Value)
//      - GMV / customers      → "客单价" (Customer AOV — only when source
//                                                provides `customers`)
//      - When customers is absent, the prompt shows the literal string
//        "—" for 客单价; the LLM must NOT compute it itself.
//   3. H ≠ S is preserved verbatim. The note is the only handling; the
//      function does NOT reconcile header.sale_qty vs sum(child.sale_qty).
//   4. Top SKU is a DERIVED STAT (deterministic min over a groupBy), not
//      a pre-sample. The full rows remain reachable via order-retrieval.ts.
//   5. The output is bounded to ~200 chars. The 1450 rows are NEVER
//      rendered to the prompt (NOT-to-do 17).

import type { OrderDetailRow } from '#shared/contracts/historical-dataset.js';
import {
  OrderEvidenceMetricsSchema,
  type OrderEvidenceMetrics,
} from '#shared/contracts/historical-dataset.js';

/** Sum of one field over a list. `undefined` is treated as 0 to keep it pure. */
const sumField = (rows: readonly OrderDetailRow[], field: 'ord_amt' | 'sale_qty'): number => {
  let s = 0;
  for (const r of rows) {
    s += r[field];
  }
  return s;
};

/**
 * Compute the Order Evidence Metrics for a single business date.
 *
 * The caller MUST pass rows that are already filtered to the day being
 * summarized (the kernel does this via `Array.prototype.filter`); the
 * function does NOT re-filter (it has no clock). The contract is local.
 *
 * @param rows     Parent + child OrderDetailRow entries for one day.
 * @param gmvOverride  Optional explicit GMV (when the caller has the
 *                     canonical GMV from `all_kpis_readable.GMV 成交金额`
 *                     — used to reconcile the daily aggregate with the
 *                     KPI summary). When omitted, GMV is computed as
 *                     sum of header.ord_amt.
 * @param customersOverride  Optional explicit customer count (from
 *                           `all_kpis_readable.customers 成交客户数`).
 *                           Pass `undefined` (not `0`) when the source
 *                           has no customer field — `0` triggers the
 *                           "customers === 0" superRefine branch and
 *                           means "explicitly zero", which is different
 *                           from "absent".
 */
export const computePerOrderMetrics = (
  rows: readonly OrderDetailRow[],
  gmvOverride?: number,
  customersOverride?: number,
): OrderEvidenceMetrics => {
  const header = rows.filter((r) => r.row_kind === 'header');
  const child = rows.filter((r) => r.row_kind === 'child');

  const gmv = gmvOverride !== undefined ? gmvOverride : sumField(header, 'ord_amt');
  const parent_orders = header.length;
  const header_units = sumField(header, 'sale_qty');
  const sku_line_count = child.length;
  const unique_skus = new Set(child.map((r) => r.sku_id)).size;

  const out: OrderEvidenceMetrics = {
    gmv,
    parent_orders,
    header_units,
    sku_line_count,
    unique_skus,
  };

  if (parent_orders > 0) {
    out.average_order_amount = gmv / parent_orders;
  }

  // Customers is OPTIONAL. Only present when source provides it.
  // customer_aov is conditional on customers > 0.
  if (customersOverride !== undefined && customersOverride > 0) {
    out.customers = customersOverride;
    out.customer_aov = gmv / customersOverride;
  }

  return OrderEvidenceMetricsSchema.parse(out);
};

/**
 * Pick the top-1 parent order (by ord_amt) and the top-1 SKU line
 * (by sum of ord_amt across child rows). Returns nulls when the day
 * has no rows of the relevant kind.
 *
 * These are DERIVED STATS — not a sample. The full row set remains
 * reachable via order-retrieval.ts.
 */
export interface TopContributors {
  readonly top_sku:
    | null
    | {
        readonly sku_id: number;
        readonly sku_name: string;
        readonly ord_amt: number;
        readonly pct_of_gmv: number;
      };
  readonly top_order:
    | null
    | {
        readonly order_id: string;
        readonly ord_amt: number;
        readonly pct_of_gmv: number;
      };
}

export const computeTopContributors = (
  rows: readonly OrderDetailRow[],
  gmv: number,
): TopContributors => {
  if (rows.length === 0 || gmv <= 0) {
    return { top_sku: null, top_order: null };
  }

  // Top SKU: group child rows by sku_id, sum ord_amt.
  const skuAgg = new Map<number, { sku_name: string; amt: number }>();
  for (const r of rows) {
    if (r.row_kind !== 'child') continue;
    const cur = skuAgg.get(r.sku_id);
    if (cur) {
      cur.amt += r.ord_amt;
    } else {
      skuAgg.set(r.sku_id, { sku_name: r.sku_name, amt: r.ord_amt });
    }
  }
  let topSku: TopContributors['top_sku'] = null;
  for (const [sku_id, v] of skuAgg) {
    if (topSku === null || v.amt > topSku.ord_amt) {
      topSku = {
        sku_id,
        sku_name: v.sku_name,
        ord_amt: v.amt,
        pct_of_gmv: v.amt / gmv,
      };
    }
  }

  // Top order: max ord_amt over header rows.
  let topOrder: TopContributors['top_order'] = null;
  for (const r of rows) {
    if (r.row_kind !== 'header') continue;
    if (topOrder === null || r.ord_amt > topOrder.ord_amt) {
      topOrder = {
        order_id: String(r.order_id),
        ord_amt: r.ord_amt,
        pct_of_gmv: r.ord_amt / gmv,
      };
    }
  }

  return { top_sku: topSku, top_order: topOrder };
};

/** Truncate a string to `n` chars with a trailing ellipsis when shortened. */
const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * Render the 1-line summary that the kernel embeds in the prompt.
 *
 * Bounded to ~200 chars. The H≠S note is preserved verbatim (Phase H).
 *
 * The LABEL ("平均订单金额" vs "客单价") is selected by the data:
 *   - average_order_amount is always shown when present
 *   - 客单价 is shown ONLY when customer_aov is present
 */
export const renderPerOrderSummary = (
  rows: readonly OrderDetailRow[],
  businessDate: string,
  gmvOverride?: number,
  customersOverride?: number,
): string => {
  const metrics = computePerOrderMetrics(rows, gmvOverride, customersOverride);
  const { top_sku, top_order } = computeTopContributors(rows, metrics.gmv);

  // H/S asymmetry — preserved verbatim. Don't reconcile.
  const sku_units = sumField(rows.filter((r) => r.row_kind === 'child'), 'sale_qty');
  const hNote = metrics.header_units !== sku_units ? '(note: H≠S by source design)' : '(consistent)';

  // Label selection — data-driven, NOT LLM-driven.
  const aovPart =
    metrics.average_order_amount !== undefined
      ? `平均订单金额=${metrics.average_order_amount.toFixed(2)}`
      : '平均订单金额=—';
  const customerAovPart =
    metrics.customer_aov !== undefined ? `客单价=${metrics.customer_aov.toFixed(2)}` : '客单价=—';

  const topSkuPart = top_sku
    ? `top_sku=${top_sku.sku_id}:${truncate(top_sku.sku_name, 24)} ¥${top_sku.ord_amt.toFixed(2)} (${(top_sku.pct_of_gmv * 100).toFixed(1)}%)`
    : 'top_sku=—';
  const topOrderPart = top_order
    ? `top_order=¥${top_order.ord_amt.toFixed(2)} (${(top_order.pct_of_gmv * 100).toFixed(1)}%)`
    : 'top_order=—';

  return (
    `parent_orders=${metrics.parent_orders} | sku_lines=${metrics.sku_line_count} | ` +
    `unique_skus=${metrics.unique_skus} | ${topSkuPart} | ${topOrderPart} | ` +
    `header_units=${metrics.header_units} | sku_units=${sku_units} ${hNote} | ` +
    `${aovPart} | ${customerAovPart} | gmv=${metrics.gmv.toFixed(2)} | date=${businessDate}`
  );
};
