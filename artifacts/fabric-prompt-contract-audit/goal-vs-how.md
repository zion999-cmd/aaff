# Part E — Goal vs How violations

## The test applied

> If deleting a passage leaves Fabric's legality, safety, time boundary, evidence provenance and output
> contract intact — and only changes *how* the Agent analyses — it is probably Hermes' HOW, not Fabric's
> contract.

Applied per passage against the measured sections (`prompt-section-classification.md`), with the code
location for each.

---

## E1. What Fabric should keep owning

| # | Content | Why it survives the test | Where |
|---|---|---|---|
| 1 | **Business date, run/window identity, dataset path + manifest hash** | provenance: without it nothing downstream is auditable | kernel literals `## Run context`; `prompt.ts` `## Situation` |
| 2 | **Time boundary** — `business_time <= T`, no future days, enforced in SQL | legality + the whole point of Replay | `replay-cognition-kernel.ts` Trust Boundary; `temporal-evidence-view.ts` (`visibleEvidenceFor`) |
| 3 | **No-action boundary** — `confirmed_action: null`, `recommendation_executed` false, "proposal not action" | legality | Trust Boundary (both paths) |
| 4 | **Tool permissions** — only `fabric_replay_retrieve_orders` may acquire; `knowledge/`/`capabilities/` read-only; no live acquisition / browser | safety + provenance of what evidence may enter the analysis | Trust Boundary, `REPLAY_ORDER_RETRIEVAL_SECTION` |
| 5 | **The day's evidence** (rendered rows, ids, paths, hashes) | it is the input | `## Current evidence` |
| 6 | **Evidence Universe with declared temporal grain and subjects** | this is the *granularity/provenance contract*; without it "field exists ≠ requirement satisfied" is undecidable, and the P0013.4 sufficiency rule has nothing to check against | `heldEvidenceFor()` + `formatHeldEvidence()` |
| 7 | **Permitted retrieval vocabulary** — the 5 `query` values and their semantics | capability contract: what Fabric will and will not answer | `REPLAY_ORDER_RETRIEVAL_SECTION`; `fabric-mcp-server.mjs:131-155` |
| 8 | **Resolution vocabulary** — IN_CONTEXT / RETRIEVED / UNAVAILABLE and the "resolve before declaring a gap" rule | evidence provenance: it defines what counts as a legitimate gap | `EVIDENCE_RESOLUTION_SECTION` (shared) |
| 9 | **Legal output + stop vocabulary** — the 4 stop reasons, `observe` illegal while a dimension is gapped, `missing_capability` requires a concrete acquisition need, the 4 hypothesis statuses, zh-CN for business fields | output contract; enforced fail-closed in `parse.ts` | `shared/schemas/investigation.ts`; `analysis-obligations.ts` |
| 10 | **Required output fields** (observed_facts, refs, coverage, gaps, requirements, resolutions…) | output contract | `AnalysisObligations` + `InvestigationSchema` |
| 11 | **Provenance per claim and per threshold** — strong claims need `claim_evidence_refs`; a threshold needs a provenance tag and must not be called a confirmation rule | provenance | `## Per-claim + Threshold provenance` |
| 12 | **The Goal statement itself** — "your target is the shop's business state and business structure; curve narration without structure is not a judgment" | this is WHAT must be achieved | `ANALYSIS_TARGET_SECTION` (shared) |
| 13 | **Knowledge ≠ Evidence boundary** | provenance: stops a prior being laundered into a current fact | `KNOWLEDGE_ANALYSIS_SECTION` (shared) |
| 14 | **Acquisition execution boundaries** — real browser on :9222, reuse an existing tab, one debugger connection and one page object, never loop open-new-tab, never launch another browser | safety — the operator's foreground is a real constraint | `exploration-goal.ts` |

## E2. What should move toward Hermes

| # | Content | Size | Why it is HOW | Where |
|---|---|---|---|---|
| 1 | **`## Investigation Workflow`** — the 9-step order | 2,628 B (Replay) / 2,769 B (Prod) | prescribing the order of reasoning. Deleting it changes nothing about legality, boundaries or the output contract — the Agent would simply analyse in its own order | kernel literal; `prompt.ts` |
| 2 | **`### Mandatory business-structure coverage` metric hints** | part of 3,640 B | *which* metrics constitute "orders structure" (`订单量、客单价、订单大小分布、客户数、退款/大单扰动`) is domain analysis strategy | `BUSINESS_STRUCTURE_DIMENSIONS` in `analysis-contract.ts:34` |
| 3 | **`### Decision-changing Evidence`** — "REALISTIC CHANCE of changing your Hypothesis/Judgment/Recommendation", plus the four invalid grounds | 834 B | a definition of analytical relevance. Valuable, but it is professional judgement about what evidence matters | `EVIDENCE_SUFFICIENCY_SECTION` |
| 4 | **Sufficiency reasoning** — "does the remaining Unknown still have a realistic chance of changing the current Judgment?" | part of 594 B + 1,034 B | method. The *contract* part is only "there is no score, and a gap does not block completing the turn" | `EVIDENCE_SUFFICIENCY_SECTION` |
| 5 | **`## Cognition continuity` forbidden-pattern catalogue** | 1,927 B | instruction on how to *write* a reading (no tallies, no metrics-dump opening, no restating yesterday). Style/method | `COGNITION_CONTINUITY_SECTION` |
| 6 | **`## Knowledge` navigation + "use as method"** | 1,973 B | routing the Agent into professional method. The *boundary* (items 13 above) must stay; the navigation prescription is method | `KNOWLEDGE_ANALYSIS_SECTION` |
| 7 | **`## Recommendation kind` mapping table** | 1,354 B (Prod) | a stopReason→kind heuristic. The contract part is one sentence: "kind describes what the operator should do, and is independent of why you stopped" | `prompt.ts` |
| 8 | **`## Knowledge guidance (post-script)`** | 1,444 B (Prod) | additional professional framing created for Production only | `prompt.ts` |
| 9 | **`### Tool Surface — Read by Purpose` + ALLOWED/ADVISORY blocks** | ~2,300 B (Prod) | tool-*use* strategy. The permission part is item 4 above and is already in the Trust Boundary | `prompt.ts:300-316` |
| 10 | **`## Epistemic Layers` worked examples** | 4 worked examples | how to classify a statement. The layer *names* are output contract (`epistemic_layers` is a schema field); the examples are instruction | kernel literal; `prompt.ts` |
| 11 | **`exploration-goal.ts` Step 1 "inventory existing assets before exploring (required)"** | part of a 124-line builder | the file's own header says Fabric "never supplies … the methods"; requiring an inventory-first strategy is exactly a method, even though "prefer reuse" is a reasonable preference | `exploration-goal.ts:41-49` |
| 12 | **`## Output Language` field-by-field enumeration** | 2,144 B (Prod) vs 256 B (Replay) | pure over-specification of a one-line rule; the Replay version proves the terseness suffices | `prompt.ts` |

## E3. The borderline, stated rather than forced

- **Stop *semantics* vs stop *justification*.** Which stop values are legal, and when `observe` is
  illegal, is contract. *Whether the remaining unknown matters enough to keep investigating* is
  judgement. The current text mixes both in one section; the audit does not propose a split, only records
  that the mix exists.
- **`ANALYSIS_TARGET_SECTION`.** The Goal statement ("state and structure, not the curve") is Fabric's.
  The five-dimension completeness requirement is a contract Fabric chose to impose (it is checkable and
  enforced). The per-dimension hints inside it are HOW. One constant, three classes.
- **`## Epistemic Layers`.** Because `epistemic_layers` is a required output field, *some* statement of
  the layers must stay in Fabric. The arguable HOW is the worked-example prose, not the table.

## E4. The cleanest in-repo statement of the principle — and where it is crossed

`apps/ecommerce/runtime/acquisition/exploration-goal.ts:1-6` says, in Fabric's own words:

> Fabric gives the executing agent a business NEED + an EVIDENCE CONTRACT + execution boundaries.
> It never supplies endpoint names, token names, signing machinery, concrete script filenames, or the
> methods discovered in the first acquisition (SC3). The agent chooses HOW; Fabric verifies WHAT came
> back. The forbidden-vocabulary contract test pins this.

The **forbidden vocabulary is genuinely enforced** (a contract test pins it), so Fabric does not hand
over endpoints or signing. But the same prompt then prescribes a 3-step method, an inventory-first
requirement, and exact output filenames. So the file both states the principle and crosses it — which is
the audit's finding in miniature: *Fabric is disciplined about not leaking the answer, and undisciplined
about not prescribing the method.*
