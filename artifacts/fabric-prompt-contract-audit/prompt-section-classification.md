# Part B — Prompt responsibility classification

Classified on the **Replay heavy prompt** (the main cognition path), measured by
`scripts/audit-prompt-inventory.ts` with zero evidence injected, i.e. contract prose only: **33,299 B /
329 lines**. Sizes in the "empty" column are prose; the "real day" column adds the day's data.

Legend: `GOAL` · `CONTRACT` · `CONTEXT` · `EVIDENCE` · `CAPABILITY_DESCRIPTION` · `OUTPUT_SCHEMA` ·
`HOW/SKILL` · `REDUNDANT`.

**Sections can legitimately carry two classes** (e.g. a rule plus an example of how to apply it); where
that happens both are listed and the split is stated. The audit's concern is not that a section has a
HOW component, but whether the HOW component is *load-bearing for Fabric*.

| Section | empty B | real-day B | Class | Why |
|---|---|---|---|---|
| preamble (`business day is …`) | 83 | 83 | `GOAL` | identifies the turn's subject |
| `## Runtime Trust Boundary` | 1,136 | 1,136 | `CONTRACT` | no-future, no-action (`confirmed_action: null`), read-only paths, **tool permissions** |
| `## Run context` | 238 | 238 | `CONTEXT` | run/shop/dataset identity |
| `## Current evidence` | 184 | 1,340 → 13,323 | `EVIDENCE` | the day's real facts (the only true data block) |
| `## Evidence Universe` | 834 | 2,527 | `EVIDENCE` + `CAPABILITY_DESCRIPTION` | what the frozen set holds, each kind's **declared temporal grain + subjects** — this is what makes "field exists ≠ requirement satisfied" decidable |
| `## Operator enrichments` | 1,652 | 1,652 | `CONTEXT` (rules only when rows exist) | empty-state is 1 line; the other ~1,600 B are 6 explanation bullets — `HOW/REDUNDANT` **when there are zero enrichments** |
| `## Evidence Resolution` | 1,701 | 1,773 | `CONTRACT` + `HOW/SKILL` | the three resolution states are contract; the ladder *as a prescribed procedure* is method |
| `## Question-driven & Sufficiency` (5 subsections) | 4,334 | 4,334 | `CONTRACT` + `HOW/SKILL` | required fields / legal stops are contract; "what makes a question material", "decision-changing", "when the remaining Unknown no longer matters" are analytical judgement |
| `### Replay V1 retrieval binding` | 1,763 | 1,814 | `CAPABILITY_DESCRIPTION` + `CONTRACT` | the permitted tool, its 5 `query` values, the `date == T` filtering rule |
| `## Prior days' judgments` | 92 | 152+ | `CONTEXT` | placeholder on day 1 |
| `## Prior Cognition` | 582 | 639+ | `CONTEXT` + `CONTRACT` | carried state + the T-1-does-not-auto-upgrade invariant |
| `## Epistemic Layers` | 1,365 | 1,415 | `CONTRACT` + `HOW/SKILL` | L1–L5 discipline is contract; the 4 worked examples are how-to |
| `## Knowledge` | 1,973 | 2,036 | `HOW/SKILL` + `CONTRACT` | navigation + "use as method" is method; `Knowledge ≠ Evidence` + "reaches Confirmed only via …" is a hard boundary |
| `## Per-claim + Threshold provenance` | 627 | 694 | `CONTRACT` | every strong claim needs refs; thresholds need provenance |
| `## Three concepts` | 401 | 439 | `REDUNDANT` | repeats `confirmed_action: null` / Observed-vs-Inferred already in the Trust Boundary |
| `## Output language` | 256 | 306 | `OUTPUT_SCHEMA` | zh-CN for business fields, canonical English for status values |
| `## Cognition continuity` | 1,927 | 1,995 | `HOW/SKILL` + `REDUNDANT` | "standing understanding, not a scorecard" is method; the forbidden-pattern catalogue duplicates rules also present in Threshold-provenance and Sufficiency |
| `## Analysis Target` (+ coverage + stop-rule) | 3,640 | 3,790 | `GOAL` + `CONTRACT` + `HOW/SKILL` | the target ("explain state and structure") is the **Goal**; 5-dimension completeness + stop legality are contract; *which* dimensions matter and their hint text is analysis strategy |
| `## Investigation Workflow` | 2,628 | 2,654 | `HOW/SKILL` | 9 prescribed steps — a method, start to finish |
| `## Formal output obligations` | 922 | 978 | `OUTPUT_SCHEMA` + `REDUNDANT` | already enforced fail-closed by `validateAnalysisObligations` at parse time |
| `## Output shape` | 4,813 | 4,952 | `OUTPUT_SCHEMA` + `REDUNDANT` | already enforced by `InvestigationSchema` (`shared/schemas/investigation.ts`) |

### Aggregate (empty-prompt basis, 33,299 B)

| class | bytes | share | note |
|---|---|---|---|
| `OUTPUT_SCHEMA` | ~5,991 | 18 % | of which ~4,813 B is a JSON template the schema already validates |
| `HOW/SKILL` | ~9,300 | 28 % | Workflow, Knowledge, analysis strategy, resolution ladder, continuity |
| `CONTRACT` | ~8,400 | 25 % | boundaries, permissions, provenance, stop legality, grain semantics |
| `EVIDENCE` + `CONTEXT` | ~1,350 | 4 % | the placeholders; on a real day `EVIDENCE` grows to 12–28 % of the prompt |
| `REDUNDANT` (overlapping the above) | ~5,400 | 16 % | Three concepts, obligations, output shape, continuity's forbidden-pattern catalogue |

### Where Fabric is teaching Hermes how to analyse — concrete instances

This is the audit's central question, so the instances are listed individually:

1. **`## Investigation Workflow`** (2,628 B) — a 9-step method: read evidence → read Knowledge →
   hold prior cognition → form ≤3 hypotheses → ask what changed → resolve before declaring gaps →
   question-driven step → stop → emit. Fabric is prescribing the order of reasoning, not a constraint
   on the answer.
2. **`### Mandatory business-structure coverage`** hints — `"orders"（订单结构）: 订单量、客单价/平均订单金额、
   订单大小分布、客户数、退款/大单扰动`. The *requirement* to cover five dimensions is a completeness
   contract; the hint list is Fabric telling Hermes which metrics matter — analysis strategy.
3. **`### Decision-changing Evidence`** — the definition of what makes an evidence request legitimate
   ("REALISTIC CHANCE of changing your current Hypothesis, Judgment or Recommendation") is analytical
   judgement cast as a rule.
4. **`## Knowledge`** + (Production-only) **`## Knowledge guidance (post-script)`** — routing Hermes into
   professional method.
5. **`## Cognition continuity`** — "opening the reading with a metrics dump", "a recommendation whose
   content is only the next tally" — this is instruction on *how to write a reading*.
6. **`## Recommendation kind`** (Production, 1,354 B) — a stopReason→kind mapping table plus worked
   guidance; a formatting/behaviour heuristic rather than a boundary.
7. **`## Epistemic Layers`** worked examples — how to classify a statement into L1–L5.
8. **`## Output Language`** (Production: 2,144 B vs Replay's 256 B) — the Production version spends
   8× the bytes enumerating which fields must be Chinese; a much terser statement carries the same rule.

**Pattern:** Fabric repeatedly converts "we want good analysis" into "here is the analysis procedure".
Each instance individually is defensible; collectively they are ~28 % of the prompt and they are the part
that most plausibly belongs to Hermes' skills.
