# Heavy Replay prompt — where every byte comes from

Task 1 deliverable. Frozen at commit `7667d74`. Read-only analysis: no prompt was changed to produce
this document.

Measured on `prompts/day-2026-09-02-prompt.txt` (36,159 B). Percentages are share of that file.

---

## 1. The generator chain

```
apps/ecommerce/runtime/replay/replay-cognition-kernel.ts:605
  buildReplayInvestigationPrompt({ run, businessDate, visibleEvidence,
                                   priorSnapshots, priorCognition,
                                   enrichments, heldEvidence })   → string
        ↑ called by
  createReplayCognitionKernel(...)  :878   — the per-day kernel
        ↑ constructed by
  platform/server/routes/replay.ts:181 ensureSession()   — one kernel per run
        ↑ sent by
  client.submitPrompt(sessionId, prompt)   — ONE user message per business day
```

The builder is a pure function over its arguments; it performs no DB access. Everything it emits comes
from (a) literals inside that file, or (b) the imported shared contract, or (c) the arguments — which
are the injections listed in §3.

## 2. Block-by-block anatomy

"Repeats daily?" = byte-identical on every business day (measured: 335 of 405 lines are identical
between day 1 and day 11).

| # | Block | Bytes | Share | Source | Role | Repeats daily? | Kind |
|---|---|---|---|---|---|---|---|
| 1 | preamble | 94 | 0.3% | kernel literal | date + run identity | date changes | necessary (identifies the day) |
| 2 | `Runtime Trust Boundary` | 1,162 | 3.2% | kernel literal | **No-Future + tool permissions + no-action** | except T | **necessary (changes what the Agent may do)** |
| 3 | `Run context` | 383 | 1.1% | kernel literal + `run` | run/dataset identity | T changes | necessary |
| 4 | `Current evidence` | 1,340 → 13,323 | 3.7% → 28% | `visibleEvidenceFor()` + `formatVisibleEvidence()` | **the day's real data** | grows with T | **necessary (business data)** |
| 5 | `Evidence Universe` | 2,527 | 7.0% | `heldEvidenceFor()` + `formatHeldEvidence()` | what the frozen dataset holds + declared grain | mostly static | **necessary (grain semantics)** |
| 6 | `Operator enrichments` | 1,735 | 4.8% | `visibleEnrichmentsAt()` | human context | empty here | necessary when present; 6 bullets are explanation |
| 7 | `Evidence Resolution` | 1,773 | 4.9% | `EVIDENCE_RESOLUTION_SECTION` (shared) | the retrieval ladder | **yes** | rule (procedure) |
| 8 | `Question-driven …` (8 subsections) | 7,900 | 21.8% | `EVIDENCE_SUFFICIENCY_SECTION` (shared) + kernel literals | **P0013.4** — BQ / requirement / sufficiency / stop | **yes** | rule + repeated explanation |
| 9 | `Replay V1 retrieval binding` | 1,814 | 5.0% | `REPLAY_ORDER_RETRIEVAL_SECTION` (shared) | the one permitted acquisition tool + query names | **yes** | necessary (tool contract) |
| 10 | `Prior days' judgments` | 152 | 0.4% | `formatPriorSnapshots()` | prior state | grows | unnecessary on day 1 (placeholder) |
| 11 | `Prior Cognition` | 639 | 1.8% | `formatPriorCognitionSection()` (shared) | T-1 state, epistemic invariant | grows | partly necessary |
| 12 | `Epistemic Layers` | 1,415 | 3.9% | kernel literal | L1–L5 table + 4 example rules | **yes** | rule + explanation |
| 13 | `Knowledge` | 2,036 | 5.6% | `KNOWLEDGE_ANALYSIS_SECTION` (shared) | nav + Knowledge ≠ Evidence boundary | **yes** | rule |
| 14 | `Per-claim provenance + Threshold` | 694 | 1.9% | kernel literal | claim refs + threshold provenance | **yes** | rule |
| 15 | `Three concepts` | 439 | 1.2% | kernel literal | Observed / Inferred / Confirmed Action | **yes** | **duplicate** (repeats #2's `confirmed_action: null`) |
| 16 | `Output language` | 306 | 0.8% | kernel literal | zh-CN | **yes** | rule |
| 17 | `Cognition continuity` | 1,995 | 5.5% | `COGNITION_CONTINUITY_SECTION` (shared) | forbidden-pattern catalogue | **yes** | rule + explanation, partly duplicated by #8/#14 |
| 18 | `Analysis Target` + coverage + stop-rule | 3,790 | 10.5% | `ANALYSIS_TARGET_SECTION` (shared) + kernel literals | **the business goal** + 5-dimension matrix | **yes** | rule (goal — load-bearing) |
| 19 | `Investigation Workflow` | 2,654 | 7.3% | kernel literal | 9 prescribed steps | **yes** | procedure |
| 20 | `Formal output obligations` | 978 | 2.7% | `ANALYSIS_OUTPUT_OBLIGATIONS` (shared) | required fields | **yes** | format |
| 21 | `Output shape` | 4,952 | 13.7% | kernel literal, mirroring `shared/schemas/investigation.ts` | **the full JSON template** | **yes** | format |

### The headline split

| category | bytes | share |
|---|---|---|
| **the day's own data** (#4, #5, #3, #1) | ~4,344 | **12%** |
| contract / procedure / format (repeated every day) | ~31,800 | **88%** |

## 3. The source files, and what each is responsible for

| file | responsibility | injected into the prompt? |
|---|---|---|
| `apps/ecommerce/runtime/replay/replay-cognition-kernel.ts` | assembles the prompt; owns ~55% of its bytes as literals; renders evidence + universe | **yes** |
| `apps/ecommerce/runtime/investigation/analysis-contract.ts` | the 5 shared section constants + output obligations — **embedded verbatim in BOTH the Production and the Replay prompt** | **yes** (~15,000 B — 41%) |
| `apps/ecommerce/runtime/replay/temporal-evidence-view.ts` | `visibleEvidenceFor()` (the ≤T slice) and `heldEvidenceFor()` (the universe) | data source |
| `apps/ecommerce/runtime/replay/enrichment-store.ts` | `visibleEnrichmentsAt()` | data source |
| `apps/ecommerce/runtime/replay/seed-evidence.ts` | decides which dataset files become evidence rows at all | upstream of everything |
| `shared/schemas/investigation.ts` | the contract the reply must satisfy; the `## Output shape` literal mirrors it | indirectly (as text) |
| `apps/ecommerce/runtime/replay/replay-prompt-light.ts` | **NEW** — the experimental light variant (this task) | not by default |

### Not from Fabric at all

Two large inputs shape a Replay turn but are **not** in the prompt and not authored by Fabric:

| input | size (measured in real runs) | who provides it |
|---|---|---|
| `skill_view investigation-contract-output` | 17,206 chars | Hermes' own profile skills |
| `skill_view business-anomaly-investigation` | 28,670 chars | Hermes' own profile skills |
| Hermes system prompt (skill index, memories, toolset) | not measured here | Hermes |

So a day's real context is roughly **36 KB prompt + up to ~46 KB of skills the model chose to load**
— the "heavy prompt" is only about half of what the model reads.

## 4. What follows for a lightweight variant

The 88% is where the weight is, and the largest single items are exactly the ones a lightweight variant
could drop without touching the business goal: `## Output shape` (13.7%), the Question-driven
explanations (21.8%, of which the *rules* are a small part), `Investigation Workflow` (7.3%),
`Cognition continuity` (5.5%), and the duplicated `Three concepts` (1.2%).

The blocks that must survive any variant are #2 (boundaries/permissions), #3/#1 (identity and date),
#4/#5 (the evidence and what is held), #9 (the tool contract), and the **goal** in #18 — because
removing any of those changes what the Agent may do or what it is being asked for, rather than how
much prose it reads.
