# Part C — Replay vs Production cognition

Measured with `scripts/audit-prompt-inventory.ts` on both shipped builders, zero evidence injected:
**Production 38,995 B / 394 lines** · **Replay heavy 33,299 B / 329 lines**.
(The light variant is 4,513 B; it is not wired to either runtime.)

## C1. Which contract is shared?

Six constants, imported by **both** prompt builders, embedded verbatim in each:

| shared constant (`apps/ecommerce/runtime/investigation/analysis-contract.ts`) | bytes | Production | Replay |
|---|---|---|---|
| `ANALYSIS_TARGET_SECTION` (target + 5-dimension coverage + stop-rule) | 3,640 | ✅ | ✅ |
| `EVIDENCE_RESOLUTION_SECTION` | ~1,700 | ✅ | ✅ |
| `EVIDENCE_SUFFICIENCY_SECTION` (Business Question / Decision-changing / Requirement / Sufficiency / Resolution≠Sufficiency / progress / stop) | 5,217 | ✅ | ✅ |
| `KNOWLEDGE_ANALYSIS_SECTION` | 1,973 | ✅ | ✅ |
| `COGNITION_CONTINUITY_SECTION` | 1,927 | ✅ | ✅ |
| `ANALYSIS_OUTPUT_OBLIGATIONS` | 922 | ✅ | ✅ |
| `REPLAY_ORDER_RETRIEVAL_SECTION` | 1,763 | — | ✅ (Replay-only by design) |
| `BUSINESS_STRUCTURE_DIMENSIONS`, `formatPriorCognitionSection` | — | ✅ | ✅ |

Verified by import analysis, not by reading the rendered text:
`prompt.ts:11-18` and `replay-cognition-kernel.ts:57-66` import the same six names.

**This is the audit's good news**: the cognition semantics that P0013.2/P0013.4/P0013.5 introduced —
structure target, evidence resolution, question-driven sufficiency, Knowledge obligation, continuity —
are genuinely one source, not two copies.

## C2. Which contract was copied anyway?

Everything below is **authored twice**, in two files, with no shared constant. Sizes are the measured
section sizes in each prompt.

| Section | Production | Replay | divergence |
|---|---|---|---|
| `Runtime Trust Boundary` | 973 B | 1,136 B | Replay adds the SQL `<= T` sentence; Production adds capability/permission text |
| `Epistemic Layers` | 2,300 B | 1,365 B | Production's is 68 % larger (extra worked examples); same L1–L5 table |
| `Per-claim provenance` + `Threshold provenance` | 756 + 1,069 = 1,825 B | 627 B (merged) | Production splits into two sections and expands; Replay keeps two terse lines |
| `Three Concepts` | 1,181 B | 401 B | same three concepts, 3× the prose in Production |
| `Output Language` | 2,144 B | 256 B | Production enumerates field-by-field; Replay states the rule |
| `Investigation Workflow` | 2,769 B | 2,628 B | two near-identical 9-step procedures |
| `Output shape` | 4,269 B | 4,813 B | two JSON templates over the same `InvestigationSchema` |
| `Prior Cognition` | 725 B | 582 B | same invariant, different wording |
| Situation / Run context | `## Situation`, `## Prior Human Guidance` | `## Run context`, enrichments | inherently different (see C6) |
| **Production-only** | `Tool Surface — Read by Purpose` + 3 ALLOWED/ADVISORY blocks (~2,300 B), `## Recommendation kind` 1,354 B, `## Knowledge guidance (post-script)` 1,444 B | — | Replay has no equivalents (tool rules live in its Trust Boundary; there is no recommendation-kind table) |

**~13,500 B of rule text is maintained twice.** The two versions have already drifted in wording and in
emphasis (3× difference in `Three Concepts`, 8× in `Output Language`), which is exactly the failure the
P0013.5 Knowledge work fixed for one section earlier.

## C3. Production prompt size

**38,995 B with zero evidence** — i.e. **larger than the Replay heavy prompt** even before any evidence
is injected. Production's evidence block (`## Current evidence`) is a 97-byte heading in the empty case;
in real turns it carries the situation's evidence summary. Production is the heavier of the two.

## C4. Does Production have the same duplication?

Yes, and slightly more of it:

- the same 5-dimension coverage matrix and the same stop-rule as Replay (shared — fine);
- **plus** its own copies of Epistemic Layers / provenance / Workflow / Output shape / Three Concepts
  (forked);
- **plus** three sections Replay has no equivalent of (`Tool Surface`, `Recommendation kind`,
  `Knowledge guidance (post-script)`), two of which are procedure or heuristic;
- `## Output shape` (4,269 B) duplicates `InvestigationSchema`, and `## Formal output obligations`
  (922 B) duplicates `validateAnalysisObligations` — both are already enforced fail-closed at parse time
  (`apps/ecommerce/runtime/investigation/parse.ts:87,106`).

## C5. Does Production write analysis method into Fabric?

Yes — the same pattern as Replay, plus its own instances:

| instance | where | class |
|---|---|---|
| `## Investigation Workflow` (9 steps) | both | HOW |
| `### Mandatory business-structure coverage` metric hints | both (shared) | HOW |
| `## Recommendation kind` mapping table + guidance | Production only, 1,354 B | HOW/heuristic |
| `## Knowledge guidance (post-script)` | Production only, 1,444 B | HOW |
| `### Tool Surface — Read by Purpose` + ALLOWED/ADVISORY blocks | Production only, ~2,300 B | HOW (tool-use strategy) |
| `## Output Language` field-by-field enumeration | Production only | format, over-specified |

## C6. How do Situation / Evidence / Skill / Knowledge reach Hermes in each path?

| input | Production | Replay |
|---|---|---|
| **Situation** | real: `## Situation` section (id, entity, type, description) + `## Prior Human Guidance` | **none** — Replay has no Situation object; the turn is a daily reading |
| **Evidence** | `## Current evidence` rendered from the situation's evidence refs; acquisition is a **live capability call** (`fabric_execute_capability`) | `## Current evidence` rendered from `visibleEvidenceFor(runId, T)` — SQL-filtered frozen rows; acquisition is the read-only `fabric_replay_retrieve_orders` |
| **Evidence Universe** | `capabilities/INDEX.md` — the 11-capability catalog with maturity icons, read by the Agent via `read_file` | `heldEvidenceFor()` rendered inline as `## Evidence Universe of this run` |
| **Skill** | via Hermes' own `skill_view` (Fabric does not author skills) | same |
| **Knowledge** | `knowledge/INDEX.md` navigation, **plus** a Fabric-authored `Knowledge guidance (post-script)` | `knowledge/INDEX.md` navigation only |
| **Continuity** | prior completed investigation's `prior_cognition` injected into the next turn | every prior day's `prior_cognition` (SQL `business_date < T`, no LIMIT) |
| **Clock** | wall clock / current business date | Business Time with `business_time <= T` enforced in SQL |

Both paths therefore reach Hermes the **same way** for Skill (Hermes-owned) and **differently** for
Evidence (live acquisition vs frozen retrieval + universe) — a difference that is inherent to Replay,
not an inconsistency.

## C7. Should the two paths share one minimal stable contract?

**On the evidence: yes for what is already shared, and yes for the forked prose — with one caveat.**

- The six shared constants prove the mechanism works and is maintained. Everything they cover
  (target, coverage, stop legality, resolution, sufficiency, Knowledge obligation, continuity,
  output obligations) is genuinely one contract today.
- The ~13,500 B of forked rule text (C2) is the *same semantics* written twice; there is no
  Replay-specific reason for `Epistemic Layers`, `per-claim/threshold provenance`, `Three Concepts`,
  `Output shape` or `Investigation Workflow` to differ. Sharing them removes a drift surface that has
  already bitten once (the P0013.5 Knowledge fork).
- The caveat: the *minimal* contract should not be "the current shared text, shared everywhere".
  Of the shared bytes, `ANALYSIS_OUTPUT_OBLIGATIONS` (922 B) and much of `ANALYSIS_TARGET_SECTION` are
  restatements of what `parse.ts` + `shared/schemas/investigation.ts` already enforce. A minimal stable
  contract is better built by deciding what Fabric must *state* than by merging everything that exists.

This is an analysis, not a refactor proposal; no change was made.
