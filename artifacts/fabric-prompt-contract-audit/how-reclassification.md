# Part A — Reclassifying the first pass's "HOW/SKILL"

Second-pass, read-only. The first audit's `HOW/SKILL` bucket was a single category; it conflated two
things that sit on **opposite sides** of the boundary:

| | definition | owner |
|---|---|---|
| `EXPLORATION_METHODOLOGY` | how this **domain** should be explored: which dimensions matter, what makes a question worth asking, what evidence would change a judgement, when evidence is sufficient, when to stop, what alternative explanations to keep alive | **Fabric** |
| `EXECUTION_HOW` | how **this run** is carried out: which tool first, how many times, retry policy, parallelism, search strategy, task decomposition, control flow | **Hermes** |

Method: every section the first pass labelled HOW/SKILL was re-allocated byte-by-byte between these two
(plus the categories it actually belonged to). The allocation is explicit and checkable in
`scripts/audit-prompt-ownership.py` — each section's allocations must sum to its measured size.

## A.1 The bucket, recomputed

The first pass's HOW/SKILL sections, re-scored: **17,413 B total**.

| new category | bytes | share of bucket |
|---|---|---|
| `EXPLORATION_METHODOLOGY` | 6,542 | **37 %** |
| `EXECUTION_HOW` | 3,838 | **22 %** |
| `EVIDENCE_SEMANTICS` | 2,750 | 15 % |
| `CONTRACT` | 1,951 | 11 % |
| `OUTPUT_SCHEMA` | 1,100 | 6 % |
| `REDUNDANT` | 1,027 | 5 % |
| `GOAL` | 205 | 1 % |

**The first pass's conclusion — "~28 % of the prompt is HOW and should move to Hermes" — was too broad.
Of that bucket, only 22 % is Hermes execution HOW. The largest single part (37 %) is Fabric-owned
exploration methodology that the first pass had mislabelled as method-to-remove.**

## A.2 Section-by-section

| Section | B | Verdict | Reasoning |
|---|---|---|---|
| `## Investigation Workflow` | 2,628 | **MIXED** — 2,100 `EXECUTION_HOW` / 528 `METHODOLOGY` | The *ordering* ("1. read evidence → 2. read Knowledge → 3. … → 9. emit") and the one concrete tool directive ("call `fabric_replay_retrieve_orders`") are execution control flow. But steps 4/5/7 restate methodology: form ≤3 hypotheses, ask what today's evidence *changes*, raise a Business Question only if its answer moves the judgement. |
| `## Knowledge` | 1,973 | **MIXED** — 800 `METHODOLOGY` / 673 `EXECUTION_HOW` / 500 `EVIDENCE_SEMANTICS` | "Knowledge tells you HOW to read this kind of situation; Evidence tells you what is true here" is methodology. "Read `INDEX.md` → domain `INDEX.md` → the ONE most relevant page, do not scan the directory" is a **search strategy** = execution. `Knowledge ≠ Evidence` is evidence semantics. |
| `## Cognition continuity` | 1,927 | **MIXED** — 900 `METHODOLOGY` / 1,027 `REDUNDANT` | "You maintain ONE continuous reading; carry the prior forward silently; understanding must answer what continued / changed / is still unknown" = epistemic methodology, Fabric-owned. The forbidden-pattern catalogue (no `2/2`, no `门禁`, no metrics-dump opening) is writing style — prompt debt, and partly duplicated by Threshold-provenance and Sufficiency. |
| `## Evidence Resolution` | 1,701 | **MIXED** — 850 `EVIDENCE_SEMANTICS` / 400 `EXECUTION_HOW` / 251 `CONTRACT` / 200 `OUTPUT_SCHEMA` | The three states and "Context Missing ≠ Evidence Missing" are evidence semantics. "Retrieve it via the available read-only retrieval surface, then continue" is a procedure. "Every RETRIEVED record must carry `retrieved_refs`" is contract, enforced at parse. |
| `## Question-driven family` | 4,334 | **MIXED** — ~2,100 `METHODOLOGY` / ~700 `EVIDENCE_SEMANTICS` / ~900 `OUTPUT_SCHEMA` / ~400 `CONTRACT` | Business Question materiality, the Decision-changing-Evidence test, Sufficiency-as-judgement and "what counts as progress" are all exploration methodology. The requirement **field list** is output schema; the grain rule is evidence semantics. |
| `## Epistemic Layers` | 1,365 | **MIXED** — 700 `CONTRACT` / 665 `EXECUTION_HOW` | `epistemic_layers` is a required output field, so the layer names are contract. The four worked examples tell the Agent *how to classify a statement* — execution-level. |
| `## Analysis Target` + `Mandatory coverage` | 2,350 | **MIXED** — 984 `GOAL` / 766 `METHODOLOGY` / 600 `CONTRACT` | The target ("state and structure, not the curve") is the Goal. The per-dimension metric hints (`订单量、客单价、订单大小分布、客户数、退款/大单扰动`) are **domain exploration methodology** — this is Fabric saying which variables carry business meaning. The five-dimension requirement itself is checkable contract. |
| `## Stop semantics` | 762 | **MIXED** — 400 `CONTRACT` / 362 `METHODOLOGY` | The legal stop vocabulary is contract. "Unbounded investigation is the failure mode, not thoroughness" is methodology. |
| elsewhere (Decision-changing, Sufficiency, progress, Resolution≠Sufficiency) | 2,309 | **METHODOLOGY** (834 + 594 + 485 + 396) | These answer "what evidence would change this judgement" and "is what I hold enough" — the definition of domain methodology. |

## A.3 What this changes

1. **The first pass overstated Fabric's overreach.** The genuinely Hermes-owned share of the *contract-only*
   Replay prompt is **4,401 B / 13.2 %**, not ~28 %.
2. **Fabric's ownership is broader than "Contract"** and legitimately includes a large methodology layer:
   **6,542 B / 19.7 %** of the Replay prompt is exploration methodology, and it is the part that
   *cannot* be dropped without the Agent losing domain direction.
3. **The real problem is not ownership, it is volume, duplication and mixing**: `REDUNDANT` at 25.1 % is
   now the single largest block in the Replay prompt, larger than `CONTRACT`.
