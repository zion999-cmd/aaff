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
// P0013.5 — Knowledge obligation moved into the shared contract.
//
// Before this, the two paths disagreed on professional Knowledge: the
// production prompt carried a three-layer `knowledge/INDEX.md` navigation
// step plus "form hypotheses from Knowledge + Evidence"; the replay prompt
// carried only the `Knowledge ≠ Evidence` prohibition. The 2026-09-16 audit
// measured the consequence: in the current contract era 2/28 real replay
// sessions read any knowledge page and 0/12 did on the day of the audit,
// while production was instructed to read one every turn. Replay cognition
// therefore ran on Evidence + five-dimension structure + continuity alone.
//
// The obligation below is now the SINGLE wording both prompt builders embed.
// Do not fork it per path, and do not restate it elsewhere in a prompt.
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
 * P0013.4 — Cognition continuity. The 2026-09-16 audit of a real Replay
 * trajectory found the Agent had turned continuous business cognition into
 * a per-day scorecard: every judgment was a hit/miss tally ("严格高客单 2/2",
 * "软化 3/3 未升稳态", "①命中 ②未命中"), prior cognition was re-scored item by
 * item each morning, and the reading opened with a metrics dump. The cause
 * was the contract's silence about what prior cognition IS: standing
 * understanding to be continued, not a checklist to be graded.
 *
 * This section states the role of each input in reasoning. It adds no new
 * field, no threshold, and no state machine — it removes the pressure that
 * produced one.
 */
export const COGNITION_CONTINUITY_SECTION = `## Cognition continuity — standing understanding, not a scorecard

You maintain ONE continuous reading of this business across days. Each turn updates that reading; it does not grade a checklist.

- \`prior_cognition\` is your standing understanding as of T-1. Treat it as something you hold and carry forward. You may continue it, revise it, abandon hypotheses that no longer matter, or move your attention when something genuinely new appears — silently, without announcing a verdict on each item.
- The "prior days' judgments" / \`prior_cognition\` list is NOT a list of questions you must answer back. Never convert it into per-item verdicts.

**Forbidden patterns** — these fail this contract even when the JSON is well-formed: per-day hit/miss tallies ("①命中 ②未命中", "2/2", "3/3"); classification gates or threshold ladders invented to label the day ("严格门禁", "软化口径") — do NOT invent classification gates or ladders, use a quantitative threshold ONLY when a real decision depends on it, and never as a scoring rubric; opening the reading with a metrics dump; restating yesterday's conclusion in order to confirm it; and a "recommendation" whose content is only the next tally. Numbers SUPPORT the reading; they are not the reading.

**Understanding must answer**: as of today, what do I believe is happening in this business — what has continued, what has changed, what is still unknown, and how confident am I? One business paragraph. Cross-day state, not today's numbers restated.`;

/**
 * Canonical Knowledge section. Embedded verbatim in BOTH the production
 * investigation prompt and the replay cognition prompt.
 */
export const KNOWLEDGE_ANALYSIS_SECTION = `## Knowledge — professional prior, used to read the business

Professional Knowledge lives in \`knowledge/\` (methods, rules, cases, SOPs, domain interpretation). It is a PRIOR about how businesses like this behave. It is never Evidence about what happened in this shop today.

The tree is indexed: \`knowledge/INDEX.md\` is a semantic router, and each domain has its own \`INDEX.md\`. How you search it is yours to decide.

Use it as an analysis method, not as an answer:
- Knowledge tells you HOW to read this kind of situation — which structural dimensions matter, how to tell a real anomaly from ordinary variation, what the professional diagnostic order is. Evidence tells you what is actually true for THIS shop on THIS day.
- Knowledge together with Evidence may produce a \`hypotheses[]\` entry: status \`proposed\`, with \`missing_evidence[]\` and a \`falsifier\`.
- Answer the business question with it: what most deserves the operator's attention, what the evidence means in professional terms, which hypothesis to keep or revise, what a recommendation rests on, which unknown is worth pursuing. There is no required number of knowledge references and no page you must read on a given day.

Boundary — Knowledge ≠ Evidence:
- Forbidden — \`Knowledge → manufacture current-world fact\`: a page saying "大促常见于此时段" does not make "该店参加了 8-15 活动" true. That claim belongs in \`hypotheses[]\` with explicit \`missing_evidence[]\`, never in \`observed[]\`/knownEvidence.
- Forbidden — Knowledge overriding or replacing a current metric, and Knowledge cited as proof of a causal link between two observed things.
- A claim drawn from Knowledge reaches Confirmed only via an operator record, system-stamped evidence, or historical evidence of THIS shop.`;

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

You MUST address ALL FIVE dimensions in \`business_structure_coverage[]\` — this is a COMPLETENESS check (did you look at the whole business, and where is evidence missing?), NOT a scorecard. Each \`note\` states the structural reading for today in one clause; do not restate yesterday's verdict for the dimension, and do not invent a grading scale. For each dimension choose exactly one status:
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
2. **RETRIEVED** — the prompt is insufficient but the system HOLDS the evidence and it can be obtained through the read-only surface this prompt declares. Record \`source\`, \`query\`, and the \`retrieved_refs\` you used. It is a gap only if that surface cannot answer it.
3. **UNAVAILABLE** — neither the prompt nor retrievable held evidence can answer it. THIS is the only state that may produce an \`evidence_gaps[]\` entry + \`acquisition_need\`. \`note\` must say what was tried and why it is unanswerable.

Hard rules:
- A question answerable from held evidence MUST NOT appear in \`evidence_gaps[]\`. "Not in my prompt" is a retrieval need (RETRIEVED), not an evidence gap (UNAVAILABLE).
- Do NOT bypass the retrieval surface to obtain EVIDENCE: EVIDENCE may only enter through the retrieval tools named in this prompt. (Reading \`knowledge/\` is a separate, allowed action.)
- Historical Replay retrieval still obeys business_time <= T (the server enforces it; future data is never returned).
- Every "gap" coverage dimension and every \`evidence_gaps[]\` entry MUST have a matching UNAVAILABLE \`evidence_resolutions[]\` record. Every RETRIEVED record MUST have non-empty \`retrieved_refs\` and the retrieved evidence reflected in the analysis.`;

/**
 * Replay-specific order retrieval binding (the V1 binding of the contract
 * above). Production resolves held evidence through its live capability
 * tool; Replay resolves order detail through this read-only tool.
 */
export const REPLAY_ORDER_RETRIEVAL_SECTION = `### Replay V1 retrieval binding — order evidence

For orders-structure needs (price/amount bands, ex-top1 GMV/AOV, top contributing orders, full SKU mix / per-SKU contribution, per-day parent orders or SKU lines) the system HOLDS the full frozen order rows. The per-order line in "Current evidence" is only a 1-line summary; it is NOT the whole evidence. Resolve via the read-only tool:

- \`fabric_replay_retrieve_orders\` with {runId (the run_id in Run context), businessDate (<= current business date), query}. **Slice semantics:** the returned rows are the VISIBLE SLICE \`biz_date <= businessDate\` — cumulative up to T, never future — and each row carries its own \`date\`, so a single day's figure is a subset of what comes back, not the whole of it:
  - "parentOrdersByDay" — parent-order rows visible up to T (amount distribution / ex-top1 analysis)
  - "topContributingOrders" — top-N orders within the visible slice (set topN)
  - "skuLinesByDay" — SKU child lines visible up to T
  - "skuGmvContribution" — GMV/units aggregated by SKU over the visible slice (SKU mix)
  - "perSkuDailyOrders" — lines for one skuId
  The tool also returns compact order_amount_bands (0-50/50-100/100-300/300-1000/1000+ counts) and n/gmv aggregates over the returned slice.
- Mark such needs RETRIEVED (source "order_replay_retrieval", query = the query name, retrieved_refs = order ids / SKU ids used) and base the judgment on the retrieved rows.
- Questions the rows cannot answer even after retrieval — buyer identity / 企业采购, refund/cancel status, after-sale adjustments (the frozen rows have no such fields) — are genuinely UNAVAILABLE: record the attempted retrieval and keep them as true evidence gaps.`;

/**
 * P0013.4 — Question-Driven Investigation & Evidence Sufficiency.
 *
 * 2026-09-20. After the Hermes Memory/Skill contamination was isolated, a
 * clean Replay over 09-02→09-12 still produced `observe` on 11/11 days. The
 * residue was structural, not contamination: the contract let \"a field is
 * missing\" stand in for \"an investigation is warranted\", so every day
 * produced the same missing-field list, none of it was pursued, and the
 * reading never advanced. This section supplies the missing semantics chain:
 *
 *     Business Question → Decision-changing Evidence → Evidence Requirement
 *          → Sufficiency → (existing P0013.2 Resolution) → Judgment / Stop
 *
 * It is deliberately load-bearing on ABSENCE. A day with no material
 * business question is a valid day, and saying so is the correct answer —
 * so nothing here may be "fixed" by making the Agent invent one per day.
 */
export const EVIDENCE_SUFFICIENCY_SECTION = `## Question-driven investigation & Evidence Sufficiency

Read this ONCE. It governs \`business_questions[]\`, \`evidence_requirements[]\`, and the relationship between \`stopReason\` and what you actually hold.

### Business Question — what are you trying to decide?

A Business Question is a problem your CURRENT judgment needs solved. It is not a description of a missing field.

- BAD (a field-missing description): "UV/CVR 数据是多少？" — naming a column is not a question.
- GOOD (a question a decision turns on): "09-03 的礼盒大单是自然需求、活动驱动，还是少量异常订单造成的不可重复脉冲？"

**A Business Question is ALLOWED NOT TO EXIST.** If today's evidence raises nothing whose answer would change your reading, then say so — \`business_questions: []\`, normal-variation reading, \`stopReason: "observe"\` — and stop. There is NO obligation to produce a question on any day, and manufacturing one to satisfy this contract is a contract violation, not diligence.

### Decision-changing Evidence — the test every requirement must pass

> Decision-changing Evidence = evidence that, if obtained, has a REALISTIC CHANCE of changing your current Hypothesis, Judgment or Recommendation.

Every \`evidence_requirements[]\` entry MUST trace to a Business Question or Hypothesis via its \`question\` field, and MUST state its \`decision_relevance\` — what would change if it arrived.

These are NOT sufficient reasons to open a requirement, and emitting one on these grounds fails the contract:
- the data happens to exist;
- a field is missing;
- it "might help" / "would make the analysis more complete";
- a structural dimension is nominally uncovered but nothing about it would change your reading.

A requirement nobody can act on is worse than no requirement: it makes the gap list look like progress.

### Evidence Requirement — semantics, not field names

State what the evidence must be, not merely which column it is. \`evidence_requirements[]\` carries:

\`\`\`
question              — the Business Question / Hypothesis this traces to (REQUIRED)
subject               — what it must be about (UV / 客单价 / 活动记录 / 订单明细 …)
required_semantics    — what it must state beyond the subject
business_time         — "YYYY-MM-DD" or "YYYY-MM-DD..YYYY-MM-DD"
temporal_grain        — "daily" | "window_aggregate" | "any"
scope                 — whole shop / one SKU / one channel
provenance_expectation— where it would have to come from to be admissible here
decision_relevance    — what would change (REQUIRED)
status                — "satisfied" | "unsatisfied" | "unresolvable"
\`\`\`

**A field existing is NOT a requirement being satisfied.** The inventory in this prompt declares, per evidence kind, its temporal grain and the subjects it carries. The canonical case, and you will meet it:

> The evidence universe holds ONE trade-summary row whose UV/CVR are aggregates over the whole 09-02..09-13 window — the fields genuinely exist and are genuinely true. They still CANNOT answer "09-03 当天的 UV 是多少？". A \`daily\` requirement at 09-03 is not satisfied by a \`window_aggregate\` stamped at 09-13, no matter how real those numbers are.

So check grain, business time, scope and subject against what the inventory actually declares BEFORE writing \`status: "satisfied"\`. Fabric verifies a \`satisfied\` claim against those declared facts and REJECTS the turn when the evidence cannot carry the requirement. Declaring \`unsatisfied\` or \`unresolvable\` honestly is always safe; over-claiming is not.

### Evidence Sufficiency — a semantic judgment, never a score

Sufficiency asks: **is what you already hold enough to stand behind your current judgment under this Business Question?**

It is NOT a completeness measure. There is no percentage, no ratio, no threshold, no "N of M resolved". Do not compute one and do not report one.

A structural dimension may stay "gap", an Unknown may stay Unknown, and the investigation may still be complete — the governing question is:

> Does the remaining Unknown still have a realistic chance of changing the current Judgment? If it does not, stop.

### Resolution and Sufficiency are DIFFERENT questions

- **Evidence Resolution (already in this contract)** answers "was the evidence FOUND?" — IN_CONTEXT / RETRIEVED / UNAVAILABLE.
- **Sufficiency (this section)** answers "is what we have ENOUGH for this question?" — satisfied / unsatisfied / unresolvable.

Do not merge them into one state, and do not build a second retrieval path. When a requirement is \`unsatisfied\` and the system might already hold the evidence, resolve it through the EXISTING Evidence Resolution rules above and record the attempt in \`evidence_resolutions[]\`.

Fabric checks both directions of your sufficiency claim against what the run actually holds: a requirement you mark \`satisfied\` must be one the declared evidence can carry, and one you leave \`unsatisfied\` must not be one the held evidence already answers. A requirement that is genuinely open — because the evidence does not exist yet at this business date, or was never collected — is an honest open item and needs no resolution record.

### What counts as investigation progress

Progress is **evidence changing your cognitive state** — nothing else. It looks like: a hypothesis strengthened, weakened or rejected; a judgment changed; a recommendation changed; a question resolved; or a question confirmed unresolvable.

It is NOT: days elapsed, questions asked, tools called, unknowns retired, or any count of resolved-vs-open items. Never introduce a fixed count, score, gate or per-day state machine to represent it.

### Stop semantics — stopping is not failure

Reuse the existing \`stopReason\`. There is no second stop vocabulary. All of these are legal, honest stops:
- the evidence is sufficient → the current judgment stands (\`judgment\`);
- the decision-changing evidence cannot be obtained → record it explicitly as a requirement with \`status: "unresolvable"\` and an Evidence Gap, and stop (\`missing_capability\`);
- there is no material Business Question today → \`observe\`;
- further evidence would not change the judgment → stop.

**Unbounded investigation is the failure mode here, not caution.** An Agent that keeps opening requirements it cannot act on, or that re-lists the same unknowns every day, has failed this contract — not demonstrated thoroughness.`;

/**
 * P0013.5 — Epistemic discipline. ONE canonical text for both paths.
 *
 * Before this, Production and Replay each authored their own copy of the
 * L1–L5 layers, and Production's was 68% longer because it carried four worked
 * examples ("a statement that says 8-14 是 88 大促 … is a Knowledge Prior").
 * Those examples tell the Agent *how to classify a statement* — Execution HOW —
 * and they had already drifted from the Replay copy. The layer table itself is
 * epistemology, i.e. contract, and it is now stated once.
 */
export const EPISTEMIC_DISCIPLINE_SECTION = `## Epistemic discipline — keep the layers distinct

| layer | what it is | what it requires |
|---|---|---|
| L1 Observed Fact | a direct read of the evidence in front of you | ≥1 \`evidence_refs[]\` |
| L2 Pattern | an inductive form over several observed facts | \`based_on[]\` ≥2 obs OR \`pattern_type: candidate\` |
| L3 Hypothesis | a causal / mechanism explanation | \`supporting_evidence_refs[]\` + \`missing_evidence[]\` + a \`falsifier\` |
| L4 Confirmed | a claim with explicit confirmation | \`confirmed_evidence_refs[]\` ≥1 (operator / system / historical evidence of THIS shop) |
| L5 Judgment | a decision grounded in L1–L4 | known / inferred / unknown + decision + confidence_basis |

- A statement whose support is a prior about how businesses like this behave is a **Knowledge Prior**, not a current fact about this shop.
- Unsupported confirmation language ("确认" / "已确认" / "definitely" / "confirmed") is **not** Confirmed unless \`confirmed_evidence_refs[]\` is populated.
- Keep Observed, Inferred and Unknown distinct in the fields that carry them. Never let an inference be read, or written, as an observation.`;

/**
 * P0013.5 — Provenance. ONE canonical text for both paths (they previously
 * split it as "Per-claim provenance (Phase C)" + "Threshold provenance
 * (Phase E)" on one path and a merged paragraph on the other, 627 B vs 1,825 B).
 */
export const PROVENANCE_SECTION = `## Provenance — every strong claim carries its basis

- Strong claims (numeric / temporal / consecutive / alternation / stable / baseline / recovery / anomaly / confirmation / reversal / causal) must carry \`claim_evidence_refs[].evidence_refs[]\`. Empty = Evidence Gap.
- Quantitative thresholds must carry \`thresholds[]\` with a provenance: heuristic | evidence_derived | knowledge_rule | operator_rule | business_policy. A heuristic must not be phrased as a "confirmation rule", and a threshold is worth stating only when a real operator decision depends on it — never as a way to classify the day.`;

/**
 * P0013.5 — Output contract. ONE canonical text for both paths.
 *
 * Replaces three previously separate blocks: the 4.3–4.8 KB \`## Output shape\`,
 * the duplicated \`## Formal output obligations\`, and the path-specific
 * \`## Output Language\` sections (2,144 B on Production vs 256 B on Replay for
 * the same rule). What is deleted is the per-field PROSE: the shape, the field
 * legality and the required-field set are all enforced by
 * \`InvestigationSchema\` + \`validateAnalysisObligations\` at parse time, which
 * is the authority. What remains is the field skeleton the model cannot infer
 * plus the rules a validator cannot check (language, the no-action boundary).
 */
export const OUTPUT_CONTRACT_SECTION = `## Output contract

Emit ONE JSON object — no markdown fences, no prose around it. The schema is the authority on shape and legality; a reply that violates it is rejected at parse time, so this section states only the field skeleton and the rules the schema cannot check.

{
  "situationId": "<run-id>-<business-date>",
  "business_date": "YYYY-MM-DD",
  "currentUnderstanding": "<简中 — 一段话 — 你对今天业务的当前理解>",
  "observed_facts": ["<L1 fact>"],              "supporting_evidence_refs": ["<ev id>"],
  "knownEvidence": ["<简中>"],                   "evidenceAcquired": ["<简中>"],
  "hypotheses": [{"statement": "<简中>", "status": "proposed"|"supported"|"weakened"|"rejected"}],
  "unknowns": ["<简中>"],                        "evidence_gaps": ["<unresolved structural fact>"],
  "business_questions": [{"question": "<简中>", "bears_on": "<简中>", "decision_relevance": "<简中>"}],
  "evidence_requirements": [{"question": "<简中>", "subject": "<简中>", "required_semantics": "<简中>", "business_time": "YYYY-MM-DD | A..B | \"\"", "temporal_grain": "daily|window_aggregate|any", "scope": "<简中>", "provenance_expectation": "<简中>", "decision_relevance": "<简中>", "status": "satisfied"|"unsatisfied"|"unresolvable"}],
  "evidence_resolutions": [{"need": "<简中>", "dimension": "product|orders|traffic|conversion|operations", "result": "IN_CONTEXT|RETRIEVED|UNAVAILABLE", "source": "", "query": "", "retrieved_refs": [], "note": ""}],
  "business_structure_coverage": [{"dimension": "product|orders|traffic|conversion|operations", "status": "covered|gap|not_applicable", "note": "<简中>", "evidence_refs": [], "acquisition_need": ""}],
  "epistemic_layers": {"observed": [{"statement": "", "evidence_refs": []}], "patterns": [{"statement": "", "pattern_type": "candidate|established", "based_on": []}], "hypotheses": [{"statement": "", "status": "", "supporting_evidence_refs": [], "missing_evidence": [], "falsifier": ""}], "confirmed": [{"statement": "", "confirmed_evidence_refs": [], "confirmed_by": "operator|system|historical_evidence", "confirmed_at": ""}], "judgment_basis": {"known": [], "inferred": [], "unknown": [], "decision": "", "confidence_basis": ""}},
  "claim_evidence_refs": [{"claim": "", "evidence_refs": [], "missing_evidence": [], "claim_type": "numeric|temporal|campaign|operation|consecutive|alternation|stable|baseline|recovery|anomaly|confirmation|reversal|causal|pattern|hypothesis|other"}],
  "thresholds": [{"statement": "", "provenance": "heuristic|evidence_derived|knowledge_rule|operator_rule|business_policy", "basis_refs": []}],
  "prior_cognition": [{"business_date": "", "kind": "prior_hypothesis|prior_judgment|prior_recommendation", "content": "", "status_at_t_minus_1": "", "status_at_t": "", "new_evidence_refs": []}],
  "findings": [{"question": "", "evidenceRefs": [], "answer": "", "impactOnHypothesis": ""}],
  "judgment": "<简中>",
  "stopReason": "judgment"|"observe"|"missing_capability"|"ask_human",
  "recommendation": {"kind": "observe"|"act", "recommendation": "<简中 — 建议做什么>", "rationale": "", "expectedOutcome": "", "risks": [], "prerequisites": [], "humanNeeded": []},
  "capabilityUsed": "<capability name> or null", "nextQuestion": "", "requiredEvidence": [], "investigationRequest": "",
  "confirmed_action": null
}

- Business-facing prose is in **Simplified Chinese**; canonical status values (\`judgment\` / \`observe\` / \`missing_capability\` / \`ask_human\`, and the hypothesis statuses) stay in canonical English.
- \`confirmed_action\` is always null and \`recommendation_executed\` must be omitted or false: your output is a proposal, never an execution.`;

/**
 * Output-obligations paragraph appended near each prompt's JSON shape.
 * observed_facts / evidence_gaps / supporting_evidence_refs move from
 * optional convention to formal obligation (2026-09-14 contract revision).
 */
export const ANALYSIS_OUTPUT_OBLIGATIONS = `## Formal output obligations

The following fields are REQUIRED and are checked fail-closed at parse time — a reply missing them is
rejected, so do not emit an empty placeholder: \`observed_facts[]\` (≥1 Evidence-supported L1 fact),
\`supporting_evidence_refs[]\`, \`business_structure_coverage[]\` (exactly one entry per dimension),
\`evidence_gaps[]\` (non-empty whenever any dimension is "gap"). If a fact is genuinely unknowable, say so
in \`evidence_gaps\`.`

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
