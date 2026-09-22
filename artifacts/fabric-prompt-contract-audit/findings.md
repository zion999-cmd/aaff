# Findings — three conclusions only

Read-only audit. No code changed, no prompt rewritten, no capability added, no Hermes/Skill/Memory
touched, P0013.4 acceptance status unchanged.

---

## KEEP IN FABRIC

These survive the "delete it and Fabric is still legal, safe, bounded and auditable" test.

1. **Time boundary** — `business_time <= T`, no future days, enforced in SQL, not only in prose
   (`temporal-evidence-view.ts:visibleEvidenceFor`).
2. **No-action boundary** — `confirmed_action: null`; Replay never executes.
3. **Tool permissions** — the single permitted acquisition tool, read-only `knowledge/`/`capabilities/`,
   no live acquisition, and the acquisition-session execution boundaries (real browser :9222, reuse a tab,
   one debugger connection / one page object).
4. **Provenance** — run id, dataset path, manifest hash, evidence ids/paths/hashes, `claim_evidence_refs`,
   threshold provenance, `Knowledge ≠ Evidence`.
5. **Evidence Universe with declared temporal grain and subjects** — the contract that makes
   "field exists ≠ requirement satisfied" decidable; without it the P0013.4 sufficiency rule has nothing
   to check against.
6. **Resolution + stop + output vocabulary** — IN_CONTEXT/RETRIEVED/UNAVAILABLE; the 4 stop reasons and
   their legality rules; the 4 hypothesis statuses; required output fields; zh-CN for business prose.
   All already enforced fail-closed in `parse.ts` + `analysis-obligations.ts`.
7. **The Goal statement** — "explain business state and STRUCTURE; curve narration is not a judgment"
   (`ANALYSIS_TARGET_SECTION`, shared byte-identically by both paths).

## MOVE TOWARD HERMES

Content that is method, strategy, heuristic or writing-style, and whose removal would leave every
boundary above intact.

1. **`## Investigation Workflow`** — a 9-step prescribed order (2.6–2.8 KB, authored twice).
2. **The metric hints inside `Mandatory business-structure coverage`** — which metrics constitute each
   dimension.
3. **`### Decision-changing Evidence`** + **Sufficiency reasoning** — definitions of analytical relevance.
4. **`## Cognition continuity`'s forbidden-pattern catalogue** — how to write a reading.
5. **`## Knowledge` navigation / "use as method"** — keep the boundary, move the method.
6. **Production-only HOW**: `## Recommendation kind` table (1,354 B), `## Knowledge guidance (post-script)`
   (1,444 B), `### Tool Surface — Read by Purpose` + ADVISORY blocks (~2,300 B).
7. **`## Epistemic Layers` worked examples** — keep the layer names (they are schema fields), move the
   how-to-classify prose.
8. **`exploration-goal.ts` Step 1 "inventory before exploring (required)"** — a method requirement in a
   file whose own header says Fabric "never supplies … methods".
9. **`## Output Language` field-by-field enumeration** — Replay's 256 B version proves one line suffices.

**Total identifiable HOW ≈ 9.3 KB of the 33.3 KB Replay prompt (28 %) and ≈ 13 KB of the 39.0 KB
Production prompt.**

Evidence that the boundary is real and movable: the P0013.4 light variant keeps every KEEP item above and
drops the HOW scaffolding, at **4.5 KB instead of 33.3 KB (87 % smaller)** — and in the 11-day manual
Light experiment Hermes still carried cognition across days, revised hypotheses on new evidence, reversed
a prior judgment, and closed a phase.

## ENGINEERING GAP

Not prompt problems: evidence, capability and runtime facts.

1. **DATA ABSENT** — daily UV/PV, daily CVR/加购/funnel, traffic source, operations (campaigns/coupons/
   price/stock), inventory, refunds, buyer type. Verified from the captured HTTP calls: both `getSummary`
   calls requested the **whole** range (`2026-09-02..2026-09-13`) and returned a single row
   (`body.size = 1`); both `getTrend` calls requested only 3 GMV-family indicators.
2. **WRONG GRAIN** — the one summary row is a 12-day aggregate stamped at the range end (09-13), so for a
   run ending 09-12 it is **never visible**, only declared with `0 visible at T`.
3. **NOT EXPOSED / NOT IMPLEMENTED** — Fabric's index declares **11** capabilities; **1** is `verified`
   (`trade.overview`), **1** has a dedicated acquire function (`acquireJdTradeOverviewViaCDP`), and
   `acquireJdTrafficOverviewViaCDP` **does not exist**. The Replay world holds 2 capabilities / 4 data
   types. A capability being *listed* is currently indistinguishable from *obtainable* for the Agent.
4. **BROKEN (client wiring, not retrieval)** — `parentOrdersByDay → Fabric execution failed: fetch failed`
   → `MCP server 'fabric' is unreachable after 6 consecutive failures`. Reproduce: call the retrieval tool
   while no Fabric server listens on `FABRIC_BASE_URL` (default `http://localhost:3000`,
   `fabric-mcp-server.mjs:15`; POST at `:369`; catch-all at `:477`; Hermes breaker at
   `tools/mcp_tool.py:6086`). Impact: every order-structure question silently degrades to UNAVAILABLE and
   then reads as a data gap. **Not fixed.**
5. **PROMPT framing** — the Agent cannot distinguish "not collected for this run" from "not collectable by
   Fabric"; both render as the same gap language. This one *is* partly a prompt issue, but the fix is a
   statement of capability reach, not more procedure.

---

## Answer to the audit's architectural question

**The evidence supports the split, and the current code only partly holds it.**

- **Holds**: the six shared constants in `analysis-contract.ts` are imported by both prompt builders and
  embedded verbatim — the cognition semantics introduced by P0013.2/P0013.4/P0013.5 are genuinely one
  contract, not two. Time, action, permission and provenance boundaries are stated and enforced in code.
- **Does not hold**: ~13.5 KB of rule text is authored twice (Epistemic Layers, provenance, Workflow,
  Output shape, Three Concepts, Output Language) and has already drifted (3× difference in Three Concepts,
  8× in Output Language); and ~28 % of the Replay prompt is method — a prescribed 9-step workflow, metric
  hints, analytical relevance tests and writing-style rules. Fabric is, in effect, using prompt volume to
  guarantee analysis quality.

**`Fabric defines Goal + Contract + Evidence Boundary` / `Hermes owns How` is the right target, and the
light experiment is empirical evidence that it is achievable** — the same session, same evidence, same
boundaries, 87 % less prompt, cognition still continuous.

## Candidate next proposals (not started)

| # | proposal | why now |
|---|---|---|
| 1 | **De-fork the shared contract** — move the 6 forked sections into `analysis-contract.ts` | drift already happened once (P0013.5 Knowledge); ~13.5 KB maintained twice |
| 2 | **Split HOW out of the prompt into a Hermes Skill** — Workflow, metric hints, relevance tests, writing style | the light experiment shows the KEEP set suffices; this makes the boundary explicit rather than implicit |
| 3 | **Capability reach statement** — have Fabric state, per run, what it can and cannot obtain, instead of the Agent inferring it from a maturity icon | fixes the "not collected vs not collectable" collapse without new data |
| 4 | **Stop restating the schema in the prompt** — `## Output shape` (4.3–4.8 KB) and `## Formal output obligations` (0.9 KB) are already enforced at parse time | largest single redundant block; a minimal field list would do |
| 5 | **Acquisition shape for traffic/conversion** — decide whether per-day KPI acquisition is in scope | single-day `getSummary` is already the production call shape (`cdp-client.ts:353-358`), so the missing daily UV/PV is an acquisition-shape decision, not a source limit |

None of the above was implemented.
