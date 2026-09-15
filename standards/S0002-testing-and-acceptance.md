# S0002 — Testing & Acceptance Standard

**Status**: Active
**Version**: 1.0
**Date**: 2026-09-04
**Companion to**: `standards/S0001-cross-agent-collaboration.md`

---

## 1. Core Principle

agentFabric strictly separates three things:

```text
Implementation
      ≠
Verification
      ≠
Business Acceptance
```

> **Tests protect implementation. Acceptance proves capability.**

Passing automated tests only prove what the tests actually covered.
It does not prove the real business capability exists.

Forbidden inferences:

```text
N/N tests PASS
        ↓
therefore capability works          ❌

code complete
        ↓
therefore Proposal complete         ❌
```

This standard codifies existing correct practice already present in the repo:
- **P0006.1** — product readiness is not unit tests.
- **P0008.6** — real Hermes Runtime acceptance.
- **P0009** — Real Product Vertical Slice / No Fake Success.
- **P0009.1** — real DB → API → Workspace DOM reconciliation.
- **ADR-063** — derived views are not persisted lifecycle.
- **ADR-064** — honest 3-layer runtime health (no single Hermes online/offline).
- **ADR-076** — kernel wiring must use real cognition, not inline stub literals.

---

## 2. Three Verification States

All development phases use the same three-layer model:

```text
Verification
│
├── Structural Verification
│
├── Integration Verification
│
└── Business Acceptance
```

### 2.1 Structural Verification

Validates the code itself and its local contracts.

Includes:
- typecheck (`npm run typecheck`)
- lint (`npm run lint`)
- unit tests
- contract tests
- schema parsing
- parser tests
- deterministic transformations
- local invariants
- architecture invariants
- isolated business logic

Allowed:
- mocks
- stubs
- fakes
- fixtures

Structural PASS only proves:

> The covered code structure, local logic, and contracts did not surface errors in the covered scope.

It does **not** prove real business capability exists.

### 2.2 Integration Verification

Validates the wiring between real implementation components across a declared boundary.

Examples:

```text
API
  → Runtime
  → Store
  → DB
```

```text
ReplayRunner
  → EvidenceStore
  → SnapshotStore
```

Principles:
- Inside the verified integration boundary, real implementations are used.
- Outside the boundary, explicitly declared mock/fake dependencies are allowed.
- Reports MUST state which dependencies are real and which are faked.

If the test is:

```text
ReplayRunner → FakeKernel
```

PASS only proves:

> ReplayRunner integrates with this FakeKernel.

It does **not** prove:

> Replay → Hermes cognition works.

### 2.3 Business Acceptance

The single source of Business Acceptance is:

> **An Accepted Proposal's Success Criteria.**

It validates the real business capability the Proposal claims to deliver.

Required (in principle):
- production entrypoint
- production wiring
- required real dependency
- real data
- actual runtime result
- semantic correctness
- provenance
- persistence/readback (when applicable)
- Workspace / operator path (when Proposal requires)

Business Acceptance is **not**:
- test count
- coverage percentage
- HTTP 200
- schema parse
- field exists
- FakeKernel output
- fixture output
- stub response

---

## 3. Acceptance Authority

This is a hard permission boundary.

> **The Implementation Agent has no authority to reinterpret, weaken, replace, or remove an Accepted Proposal's Success Criteria.**

An Accepted Proposal is:

> **An Acceptance Contract.**

The Implementation Agent (Claude Code) **may**:
- implement
- test
- verify
- collect evidence
- report PASS
- report FAIL
- report BLOCKED
- report NOT RUN

The Implementation Agent **may NOT**:
- reinterpret Success Criteria
- weaken Success Criteria
- replace Success Criteria with an easier proxy
- delete hard Success Criteria
- use structural evidence to substitute for business evidence
- use mock evidence to substitute for real evidence the Proposal requires
- lower standards because an external dependency is unavailable
- declare an unmet criterion "equivalently passed"

Example of a legal report:

```text
Structural Verification: PASS
Integration Verification: PASS
Business Acceptance: BLOCKED

Blocker:
Hermes provider unavailable.

Overall:
ACCEPTANCE BLOCKED
```

Illegal:

```text
Real Evidence = 0.

But the Bridge wiring works,
therefore I consider acceptance passed.
```

This is equivalent to the Implementation Agent modifying the acceptance contract.

If a Success Criterion:
- cannot be implemented
- conflicts with HEAD architecture
- is outdated
- is ambiguous
- requires changing an architecture boundary

Then:

> **STOP.**

Report to Design / Planning Agent + Human Reviewer.
Do not modify the acceptance contract yourself.

---

## 4. Completion State Machine

The unified state machine:

```text
Implementation DONE
        │
        ▼
Structural Verification
        │
       PASS
        ▼
Integration Verification
        │
       PASS
        ▼
Business Acceptance
     ┌──┼─────────┐
     ▼  ▼         ▼
   FAIL BLOCKED   PASS
     │    │         │
     ▼    ▼         ▼
NOT      ACCEPTANCE COMPLETED
COMPLETED BLOCKED
```

Therefore:

```text
代码完成 + tests green  ≠  Completed
```

And:

```text
Structural PASS
Integration PASS
Business Acceptance BLOCKED

Overall = ACCEPTANCE BLOCKED
```

Only when every Success Criterion required by the Proposal PASSes:

```text
Business Acceptance: PASS
Overall: COMPLETED
```

If the Proposal explicitly requires Human / Operator Acceptance:

Until the Human has confirmed:

```text
Business Acceptance: PENDING OPERATOR
Overall: NOT COMPLETED
```

---

## 5. Technical Test Classification

The three verification layers above can use these technical test types:

### Unit

Local function / algorithm / invariant.

Mock/Stub/Fixture allowed.
Belongs to **Structural Verification**.

### Contract

Schema / API shape / persistence contract / serialization / error contract.

Mock/Stub/Fixture allowed outside the tested contract.
Belongs to **Structural Verification**.

### Integration

Multiple real components wired together.

May mock dependencies declared to be outside the integration boundary.
Belongs to **Integration Verification**.

### Real-Path / Capability Verification

Used to provide real capability evidence for Business Acceptance.

MUST use the real path the Proposal requires.

It is **not** a separate completion authority.

The final authority remains:

> **The Proposal's Success Criteria.**

---

## 6. Production Wiring Rule

Hard rule:

> **A test MUST NOT claim a capability that it bypasses, mocks, stubs, fakes, or replaces.**

For example, production:

```text
HTTP
  → Replay
  → Hermes
```

Test:

```text
Replay
  → FakeKernel
```

This test may PASS. But it only proves:

```text
Replay + FakeKernel integration works.
```

It MUST NOT report:

```text
Historical Cognitive Replay works.
```

To prove Hermes capability:

Real Hermes MUST be exercised end-to-end.

---

## 7. Mock / Stub / Fixture Boundary

Mock / Stub / Fixture are legitimate engineering tools.

But they MUST honestly label their verification scope.

Allowed in:
- Structural Verification
- Integration Verification (when explicitly declared as outside the tested boundary)

Forbidden from impersonating Business Acceptance.

Business Acceptance paths are **especially** forbidden from:
- production route using a test stub
- FakeKernel impersonating the Agent
- hard-coded cognition
- hard-coded Evidence
- fixture impersonating live business data
- demo event impersonating runtime event
- fake success response
- fallback to mock after an external dependency fails, then displaying success

If a real dependency is unavailable:

The correct result is:

```text
BLOCKED
```

Not:

```text
PASS via fallback
```

---

## 8. Real Result Before Assertion

For tests that involve real capability, the order MUST be:

```text
real request
  → real dependency
  → actual response
  → inspect actual result
  → verify identity / time / provenance
  → verify business semantics
  → normalize / persist / render
  → assert
```

Not:

```text
construct expected fake response
  → inject response
  → assert injected value survived
  → declare capability PASS
```

The latter only belongs to Structural / Integration Verification.

---

## 9. Semantic Assertions

Weak assertions (allowed but not sufficient alone):

```text
status === 200
result !== null
typeof judgment === "string"
rows.length > 0
schema.parse succeeds
```

These can exist.

They MUST NOT be the sole evidence of Business Acceptance.

Business semantic assertions should verify, for example:

```text
requested shop == actual source shop

requested business date
  matches truthful source/business semantics

source GMV
  == normalized GMV
  == persisted Evidence GMV
  == API/Workspace GMV

evidenceRef actually exists

Replay at T
  cannot see Evidence from T+1

Hermes output
  is actual Hermes output,
  NOT fallback/stub literal
```

---

## 10. Fact Integrity

This is a hard rule:

> **It is FORBIDDEN to modify facts merely to make tests, Schema, or acceptance pass.**

Core principle:

> **Normalize representation, never normalize truth.**

Allowed normalization of representation:
- canonical field naming
- unit conversion with an explicitly defined rule
- timezone conversion with an explicitly defined source timezone
- ISO datetime formatting
- canonical entity ID with an explicit identity mapping

But normalization MUST NOT change source semantics.

Possibly legal:

```text
"2026-09-04"
  →
"2026-09-04T00:00:00+08:00"
```

Only if the contract explicitly defines that conversion.

Absolutely illegal:

```text
unknown
  → now()

missing business_date
  → today's date

unknown value
  → 0

missing Evidence
  → placeholder Evidence

provider returned 2026-08-31
  → relabel 2026-09-01 because the caller requested it

unknown shop
  → default shop

failed acquisition
  → cached/mock success without truthful provenance

inferred operator action
  → confirmed historical action

malformed semantic value
  → reasonable-looking business value merely to satisfy schema
```

If real facts cannot satisfy a Schema / Contract, the correct result is one of:

```text
INVALID
UNKNOWN
FAIL
BLOCKED
```

Not to rewrite facts to make them green.

Principles:

> **Schema may evolve to represent reality where the contract permits.**
> **Reality must never be rewritten to satisfy Schema.**

---

## 11. External Source Integrity

For external API / browser / CDP / business systems, the system MUST preserve and verify:
- requested identity
- actual source identity
- requested time
- actual source time
- source availability
- provenance
- acquisition timestamp
- truthful missing/unavailable state

**Especially forbidden**:

> When `requested date != source date`, fabricating consistency via relabeling.

If a provider has availability lag, that lag MUST be explicitly represented.

---

## 12. Agent / LLM Verification

If a Proposal capability depends on Agent / LLM, Business Acceptance MUST be able to prove:

```text
real context
  → real Agent Runtime
  → real session/model invocation
  → actual model output
  → parsing
  → persistence
  → readback
```

At minimum verify:
- invocation actually happened
- correct context entered
- forbidden context did not enter
- actual output was received
- output is not stub/fallback
- persisted cognition corresponds to actual output

FakeAgent / FakeKernel may only be used in Structural / Integration Verification.

---

## 13. No-Future / Epistemic Integrity

For temporal capabilities such as historical replay, the time boundary MUST be enforced **before** the Agent / LLM is invoked.

NOT only via prompt:

> "Please don't look at the future."

Must:

```text
available evidence <= Business Time T
        ↓
context construction
        ↓
Agent
```

Even if future data already exists on disk / DB, it MUST NOT enter the T-moment context.

Inference MUST stay inference.

Without explicit Action Evidence, an inferred operator action MUST NOT be marked as Confirmed Action.

---

## 14. Workspace / Product Acceptance

If a Proposal has a user-facing Workspace surface, Business Acceptance MUST cover the real product path:

```text
Browser / Workspace
  → production API
  → production Runtime
  → required real dependency
  → persisted result
  → production API readback
  → actual rendered UI
```

CLI / test runner MUST NOT be used to substitute for Workspace acceptance.

At minimum check:
- click path
- actual rendering
- business data correctness
- error states
- refresh/readback
- 404 / 500
- blocking console / runtime errors
- no fake success

If the Proposal requires Human Operator Acceptance, automated Browser tests MUST NOT replace the final Human PASS.

---

## 15. Failure Honesty

Real FAIL is valid evidence.

Real BLOCKED is also valid evidence.

Forbidden to make green:
- switch to fixture
- switch to mock
- bypass production path
- weaken assertion
- fallback fake
- delete failed criterion
- report unavailable as success
- modify facts to satisfy schema

Correct:

```text
FAIL
BLOCKED
UNAVAILABLE
UNKNOWN
```

All are better than:

```text
FAKE PASS
```

---

## 16. Proposal Success Criteria Mapping

Before Implementation starts, Claude MUST read the Accepted Proposal and map Success Criteria to verification methods.

Example:

```text
SC1 schema invariant
  → Structural

SC2 DB / runtime wiring
  → Integration

SC3 real JD acquisition
  → Business Acceptance / real path

SC4 real Hermes cognition
  → Business Acceptance / real path

SC5 operator sees result in Workspace
  → Business Acceptance / Human Operator
```

Claude may design the specific test method.

Claude has NO authority to change the criterion itself.

---

## 17. Automated Test Count

From now on:

```text
60/60 PASS
```

only means:

> These 60 tests did not surface any failure.

It MUST NOT be interpreted as:

> Feature complete.

Project State / Handoff MUST NOT only report a mixed test count.

Must at minimum report:

```text
Structural Verification:
- typecheck:
- unit:
- contract:

Integration Verification:
- ...

Business Acceptance:
- ...

Overall:
- ...
```

Test count is regression evidence, NOT completion authority.

---

## 18. Coverage

Coverage is an implementation quality / regression signal.

Coverage does NOT prove:
- production wiring
- external dependency
- business semantics
- Workspace behavior
- Agent invocation
- capability completion

It is forbidden to use a coverage threshold as Proposal completion evidence.

---

## 19. Review / Close Gate

S0001:

```text
Development
  → Review
  → Close
```

Formally interpreted as:

```text
Development
  ↓
Structural Verification
  ↓
Integration Verification
  ↓
Proposal Success Criteria / Business Acceptance
  ↓
Human Operator Acceptance where required
  ↓
Review
  ↓
Close
```

For any required Success Criterion, if the state is:

```text
FAIL
BLOCKED
NOT RUN
PENDING
```

The Proposal MUST NOT be Closed.

---

## 20. Reporting Standard

When Claude completes a stage of work, it reports uniformly:

## Changed

- files
- behavior

## Structural Verification

- typecheck
- unit
- contract
- architecture invariants

## Integration Verification

- tested wiring
- real dependencies
- mocked dependencies
- results

## Business Acceptance

For each Proposal Success Criterion:
- criterion
- evidence
- PASS / FAIL / BLOCKED / NOT RUN

## Operator Acceptance

- PASS / FAIL / PENDING / N/A

## Known Blockers

## Overall

One of:

```text
IMPLEMENTING

IMPLEMENTED — VERIFICATION PENDING

ACCEPTANCE BLOCKED

BUSINESS ACCEPTANCE PASS — OPERATOR PENDING

COMPLETED
```

---

## 21. Fresh Session Requirement

A fresh Implementation Agent MUST be able to determine from repository documents alone:
- role
- Project State
- Proposal authority
- development workflow
- testing rules
- mock/stub boundaries
- acceptance authority
- Fact Integrity
- completion semantics

No previous conversation / session memory may be required.

> **Project State > Conversation.**

---

## Appendix A — Relationship to existing ADRs

S0002 codifies, does not replace, the following precedent already in `context/decisions.md`:

| Existing decision | What S0002 codifies |
|---|---|
| P0006.1 (product readiness is not unit tests) | §2 / §17 — test count is regression evidence, not completion |
| P0008.6 (real Hermes Runtime acceptance) | §6 / §12 — real Agent, not fake, in Business Acceptance |
| P0009 (Real Product Vertical Slice / No Fake Success) | §7 / §15 — failure is valid evidence, no fallback fake |
| P0009.1 (real DB → API → Workspace DOM reconciliation) | §11 / §14 — External Source Integrity + Workspace acceptance |
| ADR-063 (derived view, not persisted lifecycle) | §9 — semantic assertion, not state |
| ADR-064 (3-layer runtime health) | §20 reporting — separate layer reports, not a single "Hermes online" boolean |
| ADR-076 (no inline kernel stub literal) | §6 / §7 — production wiring rule, no FakeKernel in Business Acceptance |

When a future ADR conflicts with S0002, S0002 is the higher authority for testing/acceptance; the ADR should be updated to align or be explicitly noted as an exception.
