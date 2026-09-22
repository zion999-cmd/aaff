// P0013.4 — Evidence Temporal Grain registry (Fabric-owned).
//
// WHY THIS EXISTS
//
// The proposal's central test is: "有 UV 不等于满足 UV Requirement." The
// frozen P0013 dataset contains a real instance of exactly this trap. Its
// acquisition requested
//
//     startDate=2026-09-02 & endDate=2026-09-13
//
// and the trade-summary endpoint answered with ONE row whose UV (45124) and
// CVR (0.0936) are aggregates over that whole 12-day range, stamped at the
// range END. The fields genuinely exist and are genuinely true — and they
// still cannot answer "what was 09-03's UV?".
//
// Nothing in the schema previously recorded this. `evidence_observations`
// carries capability / data_type / business_date, and a 12-day aggregate and
// a 1-day reading are indistinguishable at that level. So the ONLY honest
// way for Fabric to adjudicate a sufficiency claim is an explicit
// declaration of what each kind of evidence is — which is what this file is.
//
// SCOPE — this is a DECLARATION OF SHAPE, never of value. It states what each
// kind covers in business time and which indicators it carries. It contains
// no business thresholds, no interpretation of any number, and no claim
// about whether any reading is good or bad. Values are read from the
// evidence files at prompt time, as before.
//
// PROVENANCE of the declarations below (structural inspection only):
//   data/jd_acquisition_20260914_0231/target_a_summary_decoded.json
//     → 1 row, date_range 2026-09-02..2026-09-13, 12 decoded KPIs
//   data/jd_acquisition_20260914_0231/target_a_trend_parsed.json
//     → 12 rows, one per business_date, 3 series (shop GMV + industry GMV)
//   data/jd_acquisition_20260914_0231/target_b_order_detail_summary.json
//     → per_day[{orders,qty,amt}] for each of 12 business dates
//   data/jd_acquisition_20260914_0231/PROVENANCE_MANIFEST.json
//     → "12/12 per-day getDealOrders calls succeeded"
//
// FAIL-CLOSED DEFAULT: a capability/data_type pair not listed here has grain
// `unknown`, and `unknown` can never satisfy a requirement that names a
// business time. Recording a new acquisition kind means declaring it here —
// the alternative (assuming it is daily) is the exact over-claim this
// proposal exists to prevent.

import type { EvidenceTemporalGrain } from '#shared/schemas/investigation.js';

/** One declared evidence kind: what it covers, and what it carries. */
export interface EvidenceKindDeclaration {
  readonly capability: string;
  readonly data_type: string;
  readonly grain: EvidenceTemporalGrain;
  /**
   * Matching aliases — ONE TOKEN PER ENTRY, so containment works.
   *
   * Real Hermes acceptance (2026-09-20) settled this the hard way: the Agent
   * emitted the requirement subject "订单金额分布/Top 单/SKU 贡献" for
   * evidence the run genuinely holds, and a grouped alias list
   * ("订单金额 order_amount") failed containment against it — a false
   * negative that rejected a correct turn. Aliases must be individual
   * tokens, because a requirement's subject is a free-form composite the
   * Agent writes, not a vocabulary term.
   *
   * Matching is bidirectional substring over a normalized (lowercased,
   * punctuation-stripped) string, so "UV" matches the alias "uv" and
   * "店铺访客数" matches the alias "访客数".
   */
  readonly subjectAliases: readonly string[];
  /**
   * The same subjects grouped for HUMAN/Agent reading, one entry per
   * indicator family. Display only — never matched against. Kept separate
   * from `subjectAliases` because the two have opposite requirements:
   * matching wants maximal granularity, the rendered inventory wants to stay
   * short enough that it is not truncated (the traffic indicators this rule
   * turns on were the ones a truncated list was dropping).
   */
  readonly subjectLabels: readonly string[];
  /** Human-readable note rendered into the Agent prompt. */
  readonly note: string;
}

/**
 * Canonical grain declarations. Ordered most-specific last; lookup is exact
 * on (capability, data_type).
 */
export const EVIDENCE_KIND_DECLARATIONS: readonly EvidenceKindDeclaration[] = Object.freeze([
  {
    capability: 'trade.overview',
    data_type: 'getSummary',
    grain: 'window_aggregate',
    subjectAliases: [
      'gmv', '成交金额', '订单金额', 'orders', '成交单量', '订单量', 'customers', '成交客户数',
      'sku_pieces', '成交商品件数', '商品件数', 'aov', '客单价',
      'cvr', '转化率', 'pv', '浏览量', 'uv', '访客数',
      'avg_stay', '平均停留时长', 'cart_pieces', '加购件数',
      'cart_users', '加购客户数', 'cart_uv_rate', '加购率',
    ],
    subjectLabels: [
      '成交金额 GMV', '成交单量 orders', '成交客户数 customers', '成交商品件数 sku_pieces',
      '客单价 AOV', '转化率 CVR', '浏览量 PV', '访客数 UV', '平均停留时长 avg_stay',
      '加购件数 cart_pieces', '加购客户数 cart_users', '加购率 cart_uv_rate',
    ],
    note:
      'ONE row summarizing the whole requested range (its business_date is the range END); ' +
      'per-day values are NOT present. Cannot answer a single-day question.',
  },
  {
    capability: 'trade.overview',
    data_type: 'getTrend',
    grain: 'daily',
    subjectAliases: ['gmv', '成交金额', 'industry_gmv', '行业成交金额', 'pre_industry_gmv', '上期行业成交金额'],
    subjectLabels: ['成交金额 GMV', '行业成交金额 industry_gmv', '上期行业成交金额 pre_industry_gmv'],
    note: 'one row per business_date, but only the GMV / industry-GMV series — no traffic or conversion series.',
  },
  {
    capability: 'order.overview',
    data_type: 'perDaySummary',
    grain: 'daily',
    subjectAliases: ['orders', '成交单量', '订单量', 'order_amount', '订单金额', 'gmv', '成交金额', 'sku_pieces', '成交商品件数'],
    subjectLabels: ['成交单量 orders', '订单金额 order_amount', '成交商品件数 sku_pieces'],
    note: 'one row per business_date: that day’s orders / qty / amount.',
  },
  {
    capability: 'order.overview',
    data_type: 'perOrder',
    grain: 'daily',
    subjectAliases: [
      'order_amount', '订单金额', '订单金额分布', 'aov', '客单价',
      'top单', 'top', '头部订单', 'sku', 'sku_mix', '商品结构', '商品分布',
      'order_id', '订单明细', '子单', 'parent_orders', '订单行',
    ],
    subjectLabels: [
      '订单金额 order_amount', '客单价 AOV',
      '订单明细 order_id 子单 parent_orders', '商品结构 SKU 分布 sku_mix',
    ],
    note:
      'one row per business_date holding that day’s per-order lines (each line carries its own date); ' +
      'subject to the buyer/refund fields the frozen order payload does not contain.',
  },
]);

const KIND_INDEX: ReadonlyMap<string, EvidenceKindDeclaration> = new Map(
  EVIDENCE_KIND_DECLARATIONS.map((d) => [`${d.capability}/${d.data_type}`, d]),
);

/** Look up the declaration for a capability/data_type pair. */
export const findEvidenceKindDeclaration = (
  capability: string,
  data_type: string,
): EvidenceKindDeclaration | null => KIND_INDEX.get(`${capability}/${data_type}`) ?? null;

/**
 * The grain of a kind. Unlisted kinds are `unknown` — never assumed daily.
 */
export const resolveEvidenceGrain = (
  capability: string,
  data_type: string,
): EvidenceTemporalGrain => findEvidenceKindDeclaration(capability, data_type)?.grain ?? 'unknown';

/**
 * Normalize a free-text subject for matching: lowercase, strip whitespace and
 * punctuation that varies between an LLM's phrasing and the declaration.
 */
export const normalizeSubject = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[\s_\-/·、，,。.()（）\[\]【】:：]+/gu, '');

/**
 * Does a requirement's subject match a kind's declared subjects?
 * Bidirectional containment, because the Agent writes "店铺 UV 访客数" while
 * the declaration says "uv".
 */
export const subjectMatchesKind = (
  subject: string,
  kind: Pick<EvidenceKindDeclaration, 'subjectAliases'>,
): boolean => {
  const needle = normalizeSubject(subject);
  if (needle.length === 0) return false;
  return kind.subjectAliases.some((alias) => {
    const a = normalizeSubject(alias);
    if (a.length === 0) return false;
    return needle.includes(a) || a.includes(needle);
  });
};

/** Does ANY declared kind carry this subject? Distinguishes "held elsewhere" from "never collected". */
export const isSubjectDeclaredAnywhere = (subject: string): boolean =>
  EVIDENCE_KIND_DECLARATIONS.some((d) => subjectMatchesKind(subject, d));
