# Part D — Stable layer vs dynamic layer vs runtime-enforced

Three destinations, decided by *when* the content changes and *whether code already enforces it*.

| destination | test | why it matters |
|---|---|---|
| **Stable Fabric Layer** | identical on every turn of every run of this path | one source of truth; prefix-cacheable; bounded context |
| **Dynamic Turn Layer** | changes per business day or per run | the turn's actual input |
| **Runtime-Enforced Only** | a validator, schema, SQL filter or tool gate already rejects violations | prose about it is pure debt |

---

## D.1 Stable Fabric Layer

Everything here is byte-identical today across all 11 days of a Replay run (measured: 335 of 405 lines
are identical between day 1 and day 11). It should be authored **once**, as a shared, versioned block.

| # | content | current bytes (Replay) | currently where |
|---|---|---|---|
| 1 | Fabric **role + goal statement** ("explain business state and structure; curve narration is not a judgment") | 1,272 (GOAL) | `ANALYSIS_TARGET_SECTION` + preamble |
| 2 | **Business-time / No-Future semantics** | ~1,136 | kernel `Runtime Trust Boundary` (forked) |
| 3 | **Action boundary** — proposal not action, `confirmed_action: null` | (inside #2) + 401 | Trust Boundary + `Three concepts` (duplicate) |
| 4 | **Provenance rules** — evidence ids, dataset path + manifest hash, `claim_evidence_refs`, threshold provenance | 627 + part of #2 | kernel literal + shared obligations |
| 5 | **Evidence semantics** — `Knowledge ≠ Evidence`; grain ≠ field exists; IN_CONTEXT/RETRIEVED/UNAVAILABLE; `operator_feedback` is not an Observed Fact; no causation from temporal order | ~3,870 | Universe + Resolution + Knowledge + enrichments (split across 4 places) |
| 6 | **Exploration methodology** — five-dimension metric hints, Decision-changing test, Sufficiency judgement, stopping rule, falsification awareness | ~6,542 | Analysis Target coverage + Question-driven family + continuity |
| 7 | **Epistemic discipline** — L1–L5 names, observed/inferred/unknown separation | ~700 | kernel literal (forked) |
| 8 | **Output contract** — required fields, canonical stop/status vocabulary, business prose in zh-CN | ~1,356 + 256 | kernel literal + shared obligations |
| 9 | **Capability description** — the permitted tool and its query vocabulary | ~1,034 | `REPLAY_ORDER_RETRIEVAL_SECTION` |
| 10 | **Evidence Universe inventory** — which kinds exist, their declared grain and subjects | ~700 | `heldEvidenceFor()` rendering (90 % stable; only the "visible at T" counts move) |

**Total stable layer: ~17–19 KB**, currently emitted as prose inside every daily turn's user message.

Two structural observations:

- **It is already ~90 % identical every day, yet it is re-sent every day.** In a reused session Hermes'
  prefix cache absorbs the cost — measured **94–100 % cache hit** on every main-turn call — so this is
  mostly a *context-window* and *maintenance* cost, not a token-cost one. In a fresh session (the manual
  11-day experiment, or any one-shot run) it is a full re-prefill.
- **The stable layer is currently scattered across three files and ten sections**, and two of its parts
  (role/goal, epistemic discipline, trust boundary) are maintained once per path → the drift documented in
  `replay-vs-production.md`.

## D.2 Dynamic Turn Layer

| content | changes per | current bytes (Replay) |
|---|---|---|
| this turn's business date / T | turn | (inside preamble) |
| **Current evidence** — the day's rows | turn | 184 empty → **1,340–13,323 real** |
| Evidence Universe **availability counts** (`N visible at T`) | turn | (inside the 700) |
| carried state from the previous business day (`prior_cognition`) | turn | 582 → grows with prior days |
| operator enrichments | turn | 1,652 (empty-state here) |
| current Business Questions / Evidence Requirements / unknowns | turn | produced by the Agent, not injected |
| run window, run id, shop, dataset path + manifest hash | run | (inside `Run context` 238) |
| available capabilities | run/dataset | (inside the Universe) |

**On a real day the dynamic layer is 1.3–15 KB and the stable layer ~18 KB** — i.e. the prompt is
~55–93 % stable text even on the busiest day. The light variant's 4.5 KB is essentially the dynamic layer
plus a trimmed stable core.

## D.3 Runtime-Enforced Only — do not restate in prose

| rule | enforced by | prose currently spent on it |
|---|---|---|
| business_time ≤ T | SQL `visibleEvidenceFor` + route-level 400 (`replay-orders.ts:88`) | part of `Runtime Trust Boundary`; the Agent could not violate it if it tried |
| JSON shape / field types | `InvestigationSchema` (`shared/schemas/investigation.ts`) | `## Output shape` **4,813 B Replay / 4,269 B Production** |
| required fields (observed_facts, coverage, gaps, refs) | `validateAnalysisObligations` (`analysis-obligations.ts`) | `## Formal output obligations` **922 B** |
| exact enum values (4 stop reasons, 4 hypothesis statuses, requirement status, grain) | Zod enums + parser fail-closed | stated in ≥3 places |
| a `satisfied` claim that the held evidence cannot carry | `evaluateRequirementSufficiency` | part of `Evidence Requirement` (1,736 B) |
| tool permissions (no live acquisition, no browser, read-only paths) | MCP surface + tool layer (measured: `execute_code` blocked by the consent gate) | ~300 B of the Trust Boundary, plus Production's whole Tool Surface |
| gap ⇒ matching UNAVAILABLE resolution | `analysis-obligations.ts` §5 | part of `Evidence Resolution` |

**Estimate: ~6.5 KB of the Replay prompt (≈20 %) and ~7.2 KB of Production (≈18 %) state rules that a
validator, schema, SQL filter or tool gate already enforces.** This is the `REDUNDANT` category in
`revised-findings.md`, together with the duplicated prose.

## D.4 What this implies

A minimal architecture consistent with the boundary would be:

```text
STABLE FABRIC LAYER   (authored once, shared by both paths, versioned)
  role/goal · time+action boundary · provenance · evidence semantics
  · exploration methodology · epistemic discipline · output contract
        ↓
DYNAMIC TURN LAYER    (per business day / per run)
  T · evidence · universe availability · carried state · enrichments
        ↓
RUNTIME-ENFORCED      (no prose at all)
  schema · enums · obligations · SQL time filter · tool gates
```

That is a description of the target, **not a proposal to implement now** — no code was changed.
