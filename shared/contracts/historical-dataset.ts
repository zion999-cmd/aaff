// P0013 — Historical Dataset contract (Zod schemas).
//
// P0013 §5/§6: the input is a fixed-shape on-disk P0011.x snapshot. The
// contract MUST match the real JSON exactly; we do NOT invent fields.
// `.passthrough()` on top-level objects allows future P0011.x schema
// evolution without breaking the loader.

import { z } from 'zod';

export const YMD: RegExp = /^\d{4}-\d{2}-\d{2}$/;
const ymd = z.string().regex(YMD, 'must be YYYY-MM-DD');

/** P0011.x uses string shop_id in some files and integer in others. */
const idLike = z.union([z.string(), z.number()]).transform((v) => String(v));

const shop = z.object({
  shop_id: idLike,
  shop_name: z.string().min(1),
  verified_in_page_screenshot: z.boolean().optional(),
});

const timeWindow = z
  .object({
    start: ymd,
    end: ymd,
    days: z.number().int().nonnegative(),
    label: z.string().optional(),
    comparison_window: z
      .object({
        start: ymd,
        end: ymd,
        label: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((w, ctx) => {
    if (w.start > w.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `time_window.start (${w.start}) must be <= end (${w.end})`,
        path: ['start'],
      });
    }
  });

export const ProvenanceManifestSchema = z
  .object({
    manifest_version: z.string(),
    acquired_at: z.string(),
    acquisition_run_id: z.string(),
    shop,
    time_window: timeWindow,
  })
  .passthrough();

const kpi = z.object({
  value: z.number(),
  compare_pct: z.number().optional(),
  compare_abs: z.number().optional(),
});

export const TradeOverviewSummarySchema = z
  .object({
    shop_id: idLike,
    all_kpis_readable: z.record(z.string(), kpi),
  })
  .passthrough();

const trendSeries = z.object({
  code: z.string(),
  // P0013.1: source genuinely returns null for un-finalized / unavailable
  // metric points (e.g. T+0 not yet snapshotted, absent industry baseline).
  // null is a truthful value — never coerced to 0 (S0002 §10).
  data: z.array(z.number().nullable()),
});

const trendRow = z
  .object({
    date: ymd,
  })
  .passthrough();

export const TrendPerDaySchema = z
  .object({
    shop_id: idLike,
    xaxis: z.array(ymd),
    series: z.array(trendSeries),
    rows: z.array(trendRow),
  })
  .passthrough();

const perDayEntry = z.tuple([
  ymd,
  z.object({
    orders: z.number().int().nonnegative(),
    qty: z.number().nonnegative(),
    amt: z.number().nonnegative(),
  }),
]);

export const OrderDetailPerDaySummarySchema = z
  .object({
    shop_id: idLike,
    endpoint: z.string().optional(),
    unique_orders: z.number().int().nonnegative().optional(),
    rows_total: z.number().int().nonnegative().optional(),
    per_day: z.array(perDayEntry),
    completeness_check: z
      .object({
        every_day_queried: z.boolean().optional(),
        all_days_returned_data: z.boolean().optional(),
        all_per_day_calls_succeeded: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

/**
 * Real P0011.x child rows omit `is_same_member` and `pay_method_code` —
 * the fields are only meaningful on the parent. We make them optional.
 * `order_id` and `shop_id` may be either string or integer across files.
 */
export const OrderDetailRowSchema = z
  .object({
    order_id: idLike,
    shop_id: idLike,
    spu_id: z.number(),
    sku_id: z.number(),
    sku_name: z.string(),
    sale_qty: z.number(),
    ord_amt: z.number(),
    pre_discount_amt: z.number(),
    sku_jd_price: z.number(),
    delivery_service_fee: z.number(),
    sku_freight_amt: z.number(),
    ord_type: z.number(),
    is_same_member: z.number().optional(),
    channel_code: z.string(),
    pay_method_code: z.number().optional(),
    pay_method_desc: z.string(),
    biz_date: ymd,
    sale_ord_tm: z.string(),
    pay_tm: z.string(),
    row_kind: z.enum(['header', 'child']),
  })
  .passthrough();

export type ProvenanceManifest = z.infer<typeof ProvenanceManifestSchema>;
export type TradeOverviewSummary = z.infer<typeof TradeOverviewSummarySchema>;
export type TrendPerDay = z.infer<typeof TrendPerDaySchema>;
export type OrderDetailPerDaySummary = z.infer<typeof OrderDetailPerDaySummarySchema>;
export type OrderDetailRow = z.infer<typeof OrderDetailRowSchema>;

// ─── P0013 Task 2 — Order Evidence Metrics (Phase A) ──────────────────────
//
// The P0011.x source gives us multiple denominators with DIFFERENT semantics.
// The LLM must NOT collapse them into one "AOV" label.
//
//   - parent_orders: count of unique parent orders (header rows).
//                    Average Order Value = GMV / parent_orders
//                    Chinese label: 平均订单金额 (NOT 客单价)
//   - customers:     number of unique customers (JD `customers 成交客户数`).
//                    Only present when the source KPI includes it.
//                    Customer AOV = GMV / customers
//                    Chinese label: 客单价 (only when customers > 0)
//
// `customer_aov` is conditional: it is NEVER emitted when `customers` is
// absent or zero. `average_order_amount` is emitted whenever `parent_orders > 0`.
//
// This schema pins the contract. The kernel prompt's `内容:` line renders
// the labels deterministically from these fields — the LLM does not get
// to choose.

export const OrderEvidenceMetricsSchema = z
  .object({
    gmv: z.number().nonnegative(),
    parent_orders: z.number().int().nonnegative(),
    header_units: z.number().nonnegative(),
    sku_line_count: z.number().int().nonnegative(),
    unique_skus: z.number().int().nonnegative(),
    average_order_amount: z.number().nonnegative().optional(),
    customers: z.number().int().nonnegative().optional(),
    customer_aov: z.number().nonnegative().optional(),
  })
  .superRefine((m, ctx) => {
    if (m.average_order_amount === undefined && m.parent_orders > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'average_order_amount must be set when parent_orders > 0 (denominator cannot be silent)',
        path: ['average_order_amount'],
      });
    }
    if (m.customers !== undefined && m.customers === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customers must be > 0 when present (else customer_aov is undefined)',
        path: ['customers'],
      });
    }
    if (m.customer_aov !== undefined && (m.customers === undefined || m.customers === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customer_aov requires customers > 0 (else label must be 平均订单金额, not 客单价)',
        path: ['customer_aov'],
      });
    }
  });

export type OrderEvidenceMetrics = z.infer<typeof OrderEvidenceMetricsSchema>;
