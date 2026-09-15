// P0013.2 — Shared Analysis Contract (Production Runtime + Historical Replay).
//
// The 2026-09-14 audit (Analysis Contract audit) found both analysis paths
// converged on parser/schema/WS but had duplicated, epistemics-only prompts
// that never stated the analysis TARGET. The evidence presented was a
// day-over-day curve and industry index series; the model consequently
// produced stock-chart narration (延续/反弹/企稳/等待确认) and ended turns
// with `observe` even when business-structure evidence was simply missing.
//
// This module is the SINGLE textual contract shared by both prompt builders:
//   1. time series are Evidence, not the analysis target;
//   2. the target is explaining business STATE and business STRUCTURE;
//   3. five structure dimensions must each be covered / gapped / ruled out;
//   4. missing structure evidence => explicit Evidence Gap + acquisition
//      need (observe is NOT a legal exit when the structure question was
//      never examined); sufficient evidence => a business Judgment.
//
// Enforcement is in ./analysis-obligations.ts (fail-closed at parse).

export const BUSINESS_STRUCTURE_DIMENSIONS = [
  { key: 'product', zh: '商品结构', hint: 'SKU/SPU、Top 商品、单品集中度、商品结构变化' },
  { key: 'orders', zh: '订单结构', hint: '订单量、客单价/平均订单金额、订单大小分布、客户数、退款/大单扰动' },
  { key: 'traffic', zh: '流量结构', hint: 'UV/PV、流量来源拆分（自然/付费/活动/外部）、行业对比' },
  { key: 'conversion', zh: '转化结构', hint: 'CVR、访客→下单漏斗、加购、小样本噪声判定' },
  { key: 'operations', zh: '运营动作', hint: '活动/大促报名、价格/优惠券、投放、库存/断货、页面/链接变更' },
] as const;

export type BusinessStructureDimension = (typeof BUSINESS_STRUCTURE_DIMENSIONS)[number]['key'];

const dimensionLines = BUSINESS_STRUCTURE_DIMENSIONS.map(
  (d) => `  - "${d.key}"（${d.zh}）: ${d.hint}`,
).join('\n');

/**
 * Canonical Analysis Target section. Embedded verbatim in BOTH the
 * production investigation prompt and the replay cognition prompt. Do not
 * fork the wording per path — the whole point is one shared contract.
 */
export const ANALYSIS_TARGET_SECTION = `## Analysis Target — explain business state and STRUCTURE, not the curve

Read this ONCE; it governs every field you emit.

- Time series — daily values, day-over-day moves, industry comparison series, and any pre-computed "方向性事实" — are **Evidence**. They are inputs to diagnosis, NOT the subject of the analysis. Industry numbers are a reference frame, not an index to forecast.
- Your analysis TARGET is the shop's **business state** (is the business healthy?) and its **business structure** (products / orders / traffic / conversion / operations). A metric move is explained only when it is traced to a structural business cause or explicitly marked un-explained with the evidence still needed.
- Curve narration WITHOUT structure is not a judgment. Describing "延续 / 反弹 / 企稳 / 回升 / 上行 / 动能 / 等待确认 / 走势" as the conclusion, without saying what happened to products, orders, traffic, conversion, or operations, fails this contract.

### Mandatory business-structure coverage

You MUST address ALL FIVE dimensions in \`business_structure_coverage[]\`. For each dimension choose exactly one status:
  - "covered" — you have Evidence for it; \`note\` states the structural reading and \`evidence_refs[]\` cites the evidence;
  - "gap" — the dimension is relevant but the Evidence is missing; \`note\` says what is unknown and \`acquisition_need\` names the exact fact/capability required;
  - "not_applicable" — explain in \`note\` why the dimension cannot matter for this situation.

${dimensionLines}

### Stop-rule decision (binding)

- If ANY relevant dimension is "gap", you MUST NOT stop with \`stopReason: "observe"\`. Record every missing fact in BOTH \`evidence_gaps[]\` and \`requiredEvidence[]\`, describe the concrete acquisition need in \`investigationRequest\` (which Fabric capability or which data: source split / SKU breakdown / campaign record), and stop with \`stopReason: "missing_capability"\` when Fabric cannot supply it, or "judgment" when the available structure evidence already supports a partial judgment alongside the gaps.
- \`stopReason: "observe"\` is legal ONLY when the five dimensions have been examined, no unresolved structural gap remains, and the business reading is "normal variation — no structural change and no action warranted". A statistical-noise verdict still requires the traffic/conversion sample-size reasoning to be present in \`business_structure_coverage[]\`.
- When structure Evidence IS sufficient, you MUST output a non-empty business \`judgment\` that explains state + structure; \`stopReason: "judgment"\` rather than hiding behind observe.
- In Historical Replay you cannot acquire new data: a missing dimension is still recorded as "gap" with its acquisition_need (the data pipeline backlog for a future run) — never silently collapsed to observe.`;

/**
 * P0013.2 Evidence Resolution Contract — shared by Production + Replay.
 * Context Missing ≠ Evidence Missing. A gap may only be declared after
 * resolution against evidence the system already holds.
 */
export const EVIDENCE_RESOLUTION_SECTION = `## Evidence Resolution — resolve held evidence BEFORE declaring a gap

Context Missing ≠ Evidence Missing. Before writing any entry into \`evidence_gaps[]\` or marking a \`business_structure_coverage\` dimension "gap", you MUST run Evidence Resolution for that need and record it in \`evidence_resolutions[]\`:

1. **IN_CONTEXT** — the evidence already present in this prompt answers the need. Use it; do NOT emit a gap.
2. **RETRIEVED** — the prompt is insufficient but the system HOLDS the evidence: retrieve it via the available read-only retrieval surface, then continue the analysis. Record \`source\`, \`query\`, and the \`retrieved_refs\` you used. Only treat as a gap if retrieval itself fails/returns nothing.
3. **UNAVAILABLE** — neither the prompt nor retrievable held evidence can answer it. THIS is the only state that may produce an \`evidence_gaps[]\` entry + \`acquisition_need\`. \`note\` must say what was tried and why it is unanswerable.

Hard rules:
- A question answerable from held evidence MUST NOT appear in \`evidence_gaps[]\`. "Not in my prompt" is a retrieval need (RETRIEVED), not an evidence gap (UNAVAILABLE).
- Do NOT read arbitrary files or bypass the retrieval surface. Use only the retrieval tools named in this prompt.
- Historical Replay retrieval still obeys business_time <= T (the server enforces it; future data is never returned).
- Every "gap" coverage dimension and every \`evidence_gaps[]\` entry MUST have a matching UNAVAILABLE \`evidence_resolutions[]\` record. Every RETRIEVED record MUST have non-empty \`retrieved_refs\` and the retrieved evidence reflected in the analysis.`;

/**
 * Replay-specific order retrieval binding (the V1 binding of the contract
 * above). Production resolves held evidence through its live capability
 * tool; Replay resolves order detail through this read-only tool.
 */
export const REPLAY_ORDER_RETRIEVAL_SECTION = `### Replay V1 retrieval binding — order evidence

For orders-structure needs (price/amount bands, ex-top1 GMV/AOV, top contributing orders, full SKU mix / per-SKU contribution, per-day parent orders or SKU lines) the system HOLDS the full frozen order rows. The per-order line in "Current evidence" is only a 1-line summary; it is NOT the whole evidence. Resolve via the read-only tool:

- \`fabric_replay_retrieve_orders\` with {runId (the run_id in Run context), businessDate (<= current business date), query}. Retrieved rows are the VISIBLE SLICE \`biz_date <= businessDate\` (cumulative up to T, never future); each row carries its own \`date\`, so for a SINGLE day's price bands filter rows to \`date == businessDate\` yourself:
  - "parentOrdersByDay" — parent-order rows visible up to T (amount distribution / ex-top1 analysis)
  - "topContributingOrders" — top-N orders within the visible slice (set topN)
  - "skuLinesByDay" — SKU child lines visible up to T
  - "skuGmvContribution" — GMV/units aggregated by SKU over the visible slice (SKU mix)
  - "perSkuDailyOrders" — lines for one skuId
  The tool also returns compact order_amount_bands (0-50/50-100/100-300/300-1000/1000+ counts) and n/gmv aggregates over the returned slice.
- Mark such needs RETRIEVED (source "order_replay_retrieval", query = the query name, retrieved_refs = order ids / SKU ids used) and base the judgment on the retrieved rows — e.g. compute ex-top1 AOV and price bands yourself from the rows.
- Questions the rows cannot answer even after retrieval — buyer identity / 企业采购, refund/cancel status, after-sale adjustments (the frozen rows have no such fields) — are genuinely UNAVAILABLE: record the attempted retrieval and keep them as true evidence gaps.`;

/**
 * Output-obligations paragraph appended near each prompt's JSON shape.
 * observed_facts / evidence_gaps / supporting_evidence_refs move from
 * optional convention to formal obligation (2026-09-14 contract revision).
 */
export const ANALYSIS_OUTPUT_OBLIGATIONS = `## Formal output obligations (shared Analysis Contract)

The following fields are REQUIRED on every completed turn (they were optional before; they are obligations now):
- \`observed_facts[]\`: at least one Evidence-supported L1 fact (also populate \`epistemic_layers.observed[]\`).
- \`supporting_evidence_refs[]\`: the evidence ids each strong claim relies on (same id space shown in the evidence lines / observations).
- \`business_structure_coverage[]\`: exactly one entry per dimension — product, orders, traffic, conversion, operations (see Analysis Target).
- \`evidence_gaps[]\`: every unresolved structural fact. Non-empty whenever any coverage dimension is "gap".
A reply missing these obligations fails the Investigation Contract and will be rejected — do not emit an empty placeholder; if a fact is genuinely unknowable, say so in evidence_gaps.`;

/** Render the shared Prior Cognition section (used by both prompt paths). */
export const formatPriorCognitionSection = (
  entries: ReadonlyArray<{
    business_date?: string;
    kind: string;
    content: string;
    status_at_t_minus_1: string;
  }>,
): string => {
  if (entries.length === 0) {
    return '(no prior cognition — first turn for this situation/day)';
  }
  return entries
    .map(
      (e) =>
        `- [${e.business_date ?? 'prior-turn'}] kind=${e.kind} status_at_t_minus_1=${e.status_at_t_minus_1} content=${e.content}`,
    )
    .join('\n');
};
