# Design Evolution — Long-Term Architectural Direction

> **Status: living document — maintained alongside the codebase**
> **Owners: agentFabric core team**
> **Last updated: 2026-08-27 (P0010.2.5 closure)**

This document records the **long-term architectural direction** of
agentFabric. It is **not** a session handoff and **not** a per-slice plan.
It captures the design lessons we want every contributor to internalize,
the wrong approaches we have already abandoned, and the boundary
between the platform and the agent runtime that we are not willing to
cross.

Companion documents:
- [philosophy.md](../../philosophy.md) — what we build, and why (design philosophy)
- [engineering_philosophy.md](../../engineering_philosophy.md) — how we build (engineering manifesto)
- [decisions.md](decisions.md) — concrete ADRs (date-stamped)
- [architecture_snapshot.md](architecture_snapshot.md) — the current shape of the system

If a contributor is about to write code that contradicts this document,
**stop and discuss first**. If you are about to write code that is
*consistent* with this document but the slice plan does not yet include
it, write the slice plan first.

---

## 1. The Three-Concept Invariant

The single most important architectural idea in this codebase is the
separation of three things that the system must NEVER conflate:

| Concept | What it is | Where it lives | When to use it |
|---------|-----------|----------------|----------------|
| **Knowledge** | Long-term professional expertise (rules, methods, cases, SOPs, domain interpretation) | `data/fabric-workspace/knowledge/` (indexed by `INDEX.md`) | ALWAYS read first to understand HOW to interpret a situation type |
| **Evidence** | Current fact about THIS situation (what actually happened, right now) | Provided in the prompt + acquired via Fabric | When you need to KNOW what is true for THIS situation |
| **Fabric capability** | The way to acquire new Evidence (live data from connected systems) | `data/fabric-workspace/capabilities/` + `mcp__fabric__fabric_execute_capability` | When existing Evidence is insufficient and a live query is needed |

**Knowledge ≠ Evidence.** A case from 2024 (Knowledge) does NOT replace
today's actual metric (Evidence). **Fabric** is the bridge from "I
know the framework" to "I have today's number."

**Why this is not negotiable:** every "AI hallucination" we have seen
in production traces back to a moment when one of these three
collapsed into another. The P0010.2.4 over-restriction (forbidding
Knowledge retrieval entirely to chase tool-call reduction) was the
most expensive recent example. The P0010.2.5 fix restored Knowledge
without re-collapsing the boundary. Future slices must hold the line.

**Concrete test for any new code path:** if your code is reading
`knowledge/` to answer "what is the GMV right now?", it is broken.
If your code is fabricating a numeric answer without consulting either
Knowledge (for the framework) or Fabric (for the live number), it is
broken.

---

## 2. The Three Hermes Layers

Hermes 0.20.5 exposes a layered topology that agentFabric must respect.
We do not own these layers; we sit on top of them. Conflating them
leads to misdiagnosed failures and unreachable debugging.

```
┌────────────────────────────────────────────────────────┐
│ Layer 3: Agent Turn                                    │
│   - One LLM call → one Investigation Contract          │
│   - Tools available: search_files, read_file,          │
│     list_files, mcp__fabric__fabric_*, tool_search,    │
│     tool_describe, terminal, execute_code, ...         │
│   - Boundary: no state across turns (the Runtime       │
│     persists outputs; the model does not remember)     │
└────────────────────────────────────────────────────────┘
                         ↑
┌────────────────────────────────────────────────────────┐
│ Layer 2: Session Runtime  (port 9120 in this env)      │
│   - Long-lived LLM session over a workspace cwd        │
│   - Owns: message bus, tool registry, turn scheduler   │
│   - Boundary: session.create takes ONLY                │
│     {cwd, profile, model, source: 'fabric'}. No        │
│     per-session tool allowlist, no quota, no path      │
│     sandbox. Anything we want to enforce MUST go       │
│     in the prompt OR in the post-turn contract         │
│     validation.                                        │
└────────────────────────────────────────────────────────┘
                         ↑
┌────────────────────────────────────────────────────────┐
│ Layer 1: Gateway  (port 8642 in this env)               │
│   - HTTP/WS front door                                 │
│   - Owns: auth_required flag, /api/health              │
│   - Boundary: we do not own the gateway; we are one    │
│     of many clients. If auth_required=true, we must    │
│     send ?token=...; if false, we MUST NOT.            │
└────────────────────────────────────────────────────────┘
```

**What this means for agentFabric:**

- We talk to **Layer 2** via the `HermesSessionClient` in
  `platform/runtime/hermes/session-client.ts`. We do not bypass it
  to Layer 1 unless we are probing auth.
- We talk to **Layer 3** ONLY through the prompt we author. There
  is no API to constrain the model within a turn.
- The `tool_search` / `tool_describe` tools are **Layer 2** tools.
  They are not free at Layer 3 in the sense of cost, but they are
  unlimited in count — there is no per-session quota.
- The `search_files` / `read_file` tools are also **Layer 2** tools.
  The model can read any file under the session's `cwd` if it
  decides to. We have NO path allowlist.

This three-layer view replaces the older mental model where we
talked vaguely about "the Runtime". The old model encouraged us to
write code that tried to enforce constraints Hermes does not
enforce. The new model is honest: **the platform validates
output, the model is trusted to follow prompt contracts.**

---

## 3. Prompt Policy ≠ Runtime Enforcement

This is the single most misunderstood boundary in the system, and
the source of every "HARD CONSTRAINT" wording that later turned out
to be wishful thinking.

### What Hermes enforces (real)

- **Authentication**: if `auth_required=true`, missing/wrong token → 401.
- **Workspace cwd**: the session is bound to a directory; tools cannot
  read above it.
- **Turn completion timeout**: if a turn does not produce
  `message.complete` in time, the session surfaces a timeout.

### What Hermes does NOT enforce (prompt-level only)

- "Do not read `platform/`" — the model CAN read it. We hope it won't.
- "Call `tool_search` at most once" — there is no counter. We hope
  it doesn't spam the trace log.
- "Status vocabulary MUST be `proposed|supported|weakened|rejected`"
  — the model CAN return `confirmed`. We catch that downstream in
  `apps/ecommerce/runtime/investigation/normalize.ts` and rewrite
  to the canonical four.
- "Do not call `terminal` / `execute_code`" — those tools exist and
  work. We hope the model uses read-only Fabric tools instead.

### What this means for documentation

If you write "HARD CONSTRAINT" in a prompt, you are claiming the
system is harder than it is. The platform will appear to be more
robust than it is, and when the model drifts (it will), the failure
mode will be mysterious. **Do not write "HARD CONSTRAINT" or
"turn-failure" or "forbidden" without naming the enforcement layer.**

The right pattern is:
- **Prompt contract** (advisory) — "you are expected to follow X.
  If you cannot, return `stopReason=missing_capability`."
- **Output validation** (enforced) — `normalizeInvestigationContract`
  catches drift and either rewrites (allow-list) or fails-closed
  (`driftUnmappable`).
- **Materialization gate** (enforced) — `materializeWorkItem` will
  refuse to create an `out_<fp[:16]>` row from a contract that
  doesn't pass Zod + normalization. This is the real floor.

### What this means for product trust

Operators reading the Workspace see a `Recommendation` and a
`WorkItem`. The trust boundary they care about is "did the system
actually look at the data before saying this?" — not "did the
Runtime sandbox prevent the model from going off-script?" The
sandbox is not the trust story. The story is:

1. The model was given a structured prompt (auditable in the trace).
2. The model's raw output was normalized (canonical vocabulary).
3. The Zod-validated contract was materialized as a `WorkItem`
   (deterministic `outputId`, frozen at first successful turn).
4. The `WorkItem` links back to `evidenceRefs` and `capabilityUsed`
   so the operator can see "this Recommendation came from the
   `traffic.overview` capability and the Evidence row `ev_…`."

If any of those four links is missing, the Workspace renders an
honest gap message — not a confident guess.

---

## 4. WorkspacePresentation: a Window, Not a State

The Workspace (`apps/ecommerce/workspace/`) is a **window** onto
the persisted business state. It does not own state. It does not
derive state. It COMPUTES presentation from the persisted facts.

### What this means concretely

- **No new DB columns for UI affordances.** When a new badge needs
  to appear, the answer is a new presentation rule in
  `presentation.js`, not a new column in `situations`.
- **No "pending / recoverable / blocked_runtime_failure" string-match
  in the UI.** The fuzzy text-match was the old approach; it
  collapsed because the source of truth (`learning_contexts.body`)
  was treated as a string. The new approach is a structured
  `deriveInvestigationDisplayState(invData, blockedRuntimeFailure,
  consecutiveFailures)` helper that returns a typed enum.
- **All three states — pending / recoverable / blocked — come from
  the same three facts:** `invData` (from `learning_contexts.body`),
  `blockedRuntimeFailure` (from `consecutiveFailures` >= threshold),
  and the situation's `lifecycle`. No fourth source.

### The `situations.lifecycle` column is the recovery-queue index, not a state machine

This is the single most important clarification after the P0010.2.5
audit. The column is:

- A **filter** for the Loop's recovery scan (Line 115 of
  `recovery-candidates.ts`: `WHERE s.lifecycle IN ('open', 'partial')`).
- A **denormalized cache** of "is this situation waiting for an
  investigation turn?" — the truth lives in
  `learning_contexts.body.investigation.status` and
  `humanInterventions.length`.

It is **not** a Terminal Lifecycle. It is **not** the
P0010.3 / Resolution Engine state. There is no `closed`,
`resolved`, or `archived` value. The canonical set is exactly
`{open, partial, mature}`, mirroring `ContextLifecycleSchema`. Any
other value is a bug.

The `closed` semantics (when P0010.3 lands) will be a SEPARATE
column or a separate state machine, not a 4th value of this one.
We refuse to overload this column because the recovery scan
depends on its stable, narrow set of values.

### Why this matters for the future

P0010.3 / Terminal Lifecycle will introduce:
- A `situations.closed_at` timestamp.
- A `situations.final_outcome` enum.
- A `situations.archive` boolean.

None of these will touch the `lifecycle` column. They will sit
ALONGSIDE it. The recovery scan will gain a second WHERE clause
filtering out archived situations, and the Loop's "should I
trigger a new investigation?" decision will use the lifecycle
column AS-IS. This keeps the existing recovery logic stable while
we add the new state machine in parallel.

---

## 5. LoopEvent ≠ Persistent State Fact

The Runtime Loop emits trace events (`tick`, `investigation triggered`,
`investigation failed`, `recovery eligible`, `investigation blocked`)
into a structured log. These events are:

- **Trace.** They describe what the Loop just did.
- **Observable.** They appear in the Workspace's "Runtime 状态" panel.

They are **NOT** persistent state. They are not the source of truth
for "is this situation blocked?" or "did this investigation
succeed?" The source of truth is always:

- `learning_contexts.body.investigation.status` for the current
  investigation state.
- `learning_contexts.body.investigation.consecutiveFailures` for
  the failure count.
- `learning_contexts.body.investigation.blockedEmittedAt` for the
  "blocked event has fired" flag.
- `situations.lifecycle` for the recovery-queue index.

A `LoopEvent` is a side-effect, like a log line. It can be lost
without data loss. The persistent fields above cannot.

### What this means concretely

- A future `Event Bus` (when one exists) MUST NOT become the
  source of truth. The event bus carries the same payload that
  the persistent fields carry, but if a subscriber is down, the
  persistent fields are still correct.
- A future "real-time WebSocket feed" (when one exists) MUST NOT
  become a read path for the Loop's recovery decision. The Loop
  reads SQLite, not the WebSocket.

This is why "LoopEvent ≠ persistent state fact" is the first
thing we write in this section. The two look similar in shape
(a record with `kind`, `situationId`, `timestamp`), but the
difference is fundamental: a LoopEvent can be replayed from a
log; a persistent state fact is what the next Loop tick will
read.

---

## 6. Recommendation Must Materialize as Output

A `Recommendation` that the operator can read in the Workspace is
a **materialized `Output`** — a row in `learning_contexts.body.outputs[]`
with a deterministic `outputId = out_<fp[:16]>`.

This is not optional. It is not "a future improvement". It is the
only way the Workspace can show a stable, linkable, ack-able
recommendation.

### What this means concretely

- `materializeWorkItem` runs at the end of every successful
  `runInvestigationTurn`. If the Investigation Contract passes
  Zod + normalization, the WorkItem is created BEFORE the turn
  returns.
- The `outputId` is deterministic — same situation + same
  recommendation fingerprint = same `outputId`. Re-runs do not
  create duplicates.
- The `Recommendation`'s `recommendation` (text) MUST come from
  the Investigation Contract's `recommendation.recommendation`
  field, NOT from a separate prompt call. The single source of
  truth is the contract.
- The `Recommendation`'s `rationale` MUST reference the
  `findings[].evidenceRefs` that support it. Operators verify
  recommendations by clicking through the evidence chain.

### The "apply" trap

A `Recommendation` is a **suggestion**, not an action. The
"采用建议" / "已纳入考量" button in the Workspace is a **disposition
record**, not an execution trigger. The current `decision/accept`
intervention writes the operator's disposition to
`human_interventions` and is consumed by the NEXT investigation
turn as ONE input. It does not trigger any external action.

This is enforced by the `formatPriorHumanGuidance` contract:

- The prompt re-affirms the `executionDisabled` invariant
  inline whenever a `decision/accept` is surfaced.
- The platform has no `Action Engine`, no `Approval` route, and
  no external-sending pathway. A `decision/accept` cannot
  accidentally become an order.

When (not if) Action Engine is built, it will be a separate
**capability** with its own confirmation flow. A `decision/accept`
will become one of MANY possible triggers, not the only one, and
it will require an explicit second-step confirmation.

---

## 7. Fabric — The Agent's Eyes and Hands (Toward "万物皆插件")

**Fabric** is the bridge between the Agent's intent ("I need
yesterday's traffic source for this SKU") and the outside world
(JD, Tmall, ERP, Webhook, future MCP). Every fact the Agent reads
about a real, current business entity MUST come through a Fabric
capability call.

### The future: 万物皆插件 ("everything-as-plugin")

The long-term direction is that the Operator's Workspace will
expose a plugin catalog. New data sources, new tools, new
integrations will be added without changing agentFabric core.
The contract for a Fabric capability is:

```yaml
id: trade.overview
name: 店铺成交概览
description: 拉取某个店铺在某个时间窗口的成交总额/订单量/客单价
inputs:
  shopId: string
  window: { start: date, end: date }
outputs:
  gmv: number
  orders: number
  aov: number
errors:
  - transient: 5xx from upstream
  - permanent: 4xx with no retry value
  - missing_capability: not registered
```

A new capability is a new file in `data/fabric-workspace/capabilities/`
+ a new registered connector. The Agent learns about it by reading
`capabilities/INDEX.md` and asking `fabric_list_capabilities` when
uncertain. The Agent invokes it via `mcp__fabric__fabric_execute_capability`
with the spec's `id` and the required `inputs`.

### Why this matters now

The current production capabilities are 10 in number, all ecommerce:
`customer.*`, `industry.*`, `marketing.*`, `product.*`, `service.*`,
`supply_chain.*`, `trade.*`, `traffic.*`. They cover the first
business loop. As we add finance, supply chain, and customer
service, the same contract applies — new capabilities, same
boundary.

The Agent is not expected to "know JD's API" or "know Tmall's
data model". The Agent is expected to read the capability spec,
call the capability, and interpret the result via Knowledge
(judgment framework) + Evidence (this run's actual numbers).

### The "loop" closes here

The Business Loop (the unit of product value) is:

```
Signal (cdp/jd connector) → Situation (detection) →
  Investigation (Agent + Knowledge + Fabric) →
    WorkItem (Recommendation) → Operator Review →
      Human Feedback (decision/accept|reject|defer) →
        Next Investigation (consumes the feedback)
```

Fabric is the ONLY external integration. Every other step is
internal to agentFabric. The Loop's value comes from the
**structure of the cycle**, not from the cleverness of any one
turn. A loop with weak turns but clean feedback is better than
a loop with strong turns and no feedback path.

---

## 8. The Recovery Queue — Single Source of Truth

The Recovery Queue is the Loop's "what should I work on next?"
list. It is built by `listRecoverableCandidates` in
`apps/ecommerce/runtime/loop/recovery-candidates.ts`.

### What goes IN the queue

- `no_investigation` — situation has a learning_context but no
  investigation ever ran. Will trigger one fresh.
- `interrupted` — investigation was in progress, agentFabric
  was killed mid-turn, and the previous tick's contract is
  stale. Will retry with the same prompt.
- `failed_retryable` — investigation's `status='failed'`,
  `consecutiveFailures` < threshold. Will retry.

### What stays OUT

- `situations.lifecycle NOT IN ('open', 'partial')` — this is
  the FIRST filter. The canonical set is `{open, partial, mature}`
  but mature is also excluded because a mature learning_context
  has already produced enough context to be considered "done
  enough for now" (not Terminal — just "not eligible for an
  automatic re-investigation").
- `investigation.status='completed'` (already succeeded) or
  `investigation.stopReason` (terminal within the current
  Investigation model). The Loop doesn't re-run a successful
  turn.
- `consecutiveFailures >= threshold` — the situation is
  `blocked_runtime_failure` and needs the operator to
  POST `/api/situation/:id/clear-block`.

### The mismatch the audit found (P0010.2.5)

A historical row had `situations.lifecycle='completed'` (a
non-canonical value) and `investigation.status='failed'` with
`consecutiveFailures=1`. The recovery queue filtered the row OUT
because of the bad lifecycle, even though it should have retried
it. The dirty data was a one-row bug; the design lesson is:

> The recovery queue's filter is conservative. It would rather
> MISS a recoverable situation than pick up noise. When you add
> a new value to `situations.lifecycle`, you MUST update the
> recovery-candidates filter atomically. They are coupled.

The P0010.2.5 fix added a trigger on `situations.lifecycle` to
prevent non-canonical values from being written in the first
place. This is the only kind of "schema enforcement" we are
willing to do at the DB layer — it does not introduce a new
business state machine, it enforces the existing canonical
vocabulary at the write boundary.

---

## 9. Human Intervention — Dual Storage, One Truth

A human intervention is stored in TWO places:

1. **`human_interventions` table** — structured row with
   `intervention_id`, `situation_id`, `actor_id`, `type`, `content`,
   `summary`, `timestamp`. This is the relational source of truth
   and supports querying ("show me all corrections in the last
   30 days").
2. **`learning_contexts.body.humanInterventions[]`** — denormalized
   copy, written by `recordInterventionInLearningContext` every
   time a new row is inserted. This is what the next
   investigation turn reads via `formatPriorHumanGuidance`.

The two stay in lockstep because the writer updates BOTH in a
single transaction. The reader ONLY reads (2) — never (1) — so
the next-turn prompt never has to do a JOIN. This is the
"denormalize for read, normalize for write" pattern.

### What the dual storage is NOT

- It is NOT a fallback. If the body JSON is corrupt, the
  relational row is the source of truth, and the body is
  rewritten. We never "trust the body" alone.
- It is NOT a sync problem to solve with an event bus. The
  dual write is in one SQL transaction. The `human_interventions`
  trigger ensures the `type` is canonical, the relational row
  is durable, and the body copy is written in the same
  transaction. If the transaction commits, both are correct.

### Future: when Human Intervention becomes "live"

A future P0010.x slice (out of P0010.2.5 scope) may add an
**Event** channel: when an intervention is written, an
`intervention_recorded` event fires for any in-flight UI to
re-render. This is OPTIONAL — the UI today polls on its
normal refresh cadence. The event channel is a latency
optimization, not a correctness requirement.

---

## 10. Wrong Approaches We Have Already Abandoned

Documenting these prevents future contributors from re-proposing them.

### "Hard constraint in the prompt"

The P0010.2.4 over-restriction used "HARD CONSTRAINT" and
"turn-failure" wording to forbid Knowledge retrieval. The
intent was to reduce tool-call count. The result was a
hallucination-prone agent that lost its professional grounding.
The audit found the actual fix was to restore Knowledge and
let the model pick. The P0010.2.5 closure replaces "HARD
CONSTRAINT" with honest wording ("prompt-level contract +
output-side normalization").

**Lesson:** Performance optimizations that "lock down" the
model in the prompt almost always collapse the Knowledge /
Evidence / Fabric boundary. Optimize by reducing *unnecessary*
calls, not by removing the model's ability to ground itself.

### "Action Engine now"

P0010.2.2 audit considered wiring "Apply Recommendation"
into an Action Engine. It was deferred because:
- The current `decision/accept` intervention is a **disposition
  record**, not an execution cue. Operators need to be able to
  say "I will deal with this" without us acting.
- An Action Engine without a real confirmation flow is a
  footgun. The "second-step confirmation" is not yet built.
- We don't have the data on what `decision/accept` actually
  leads to. Premature optimization.

**Lesson:** When the user-facing action is "Apply this
recommendation" and the system has no way to roll back or
audit, do not build the apply path. The disposition record
is the right product surface until we can do better.

### "Event Bus as the source of truth"

P0010.2.2 audit considered an Event Bus for the Loop. The
clarification that emerged: events are trace, persistent
fields are truth. The Event Bus would be a distribution
mechanism for the trace, not a replacement for the
persistent fields. We deferred the Event Bus to focus on
making the existing chain production-ready.

**Lesson:** The cheap version of an Event Bus is "a `for`
loop over a SQLite table". Build that first, see if it
suffices, then optimize.

### "Situation 归档 in Workspace"

The disabled "Situation 归档" button in the Workspace was
a stub for P0010.3. It is NOT a feature we are building
under the Recovery Queue umbrella. P0010.3 will introduce
a Terminal Lifecycle with `closed_at`, `final_outcome`, and
`archive` columns. Until then, "归档" is misleading.

**Lesson:** Don't ship a UI affordance for a future feature
just because the design has been sketched. A disabled button
with no backend is a documentation debt — operators will
click it, see nothing, and ask why. Either build the
backend or remove the affordance.

### "auto-recover, no human action" copy in a blocked state

The earlier UI showed a contradiction: in the
`blocked_runtime_failure` state, the banner said "the
system will auto-recover, no human action needed" while
the very next branch showed a "clear block" button. The
user correctly called this out. The fix (P0010.2.4) was a
strict three-state derived enum with one banner per
state and no fuzzy text-match.

**Lesson:** If the UI's state has TWO interpretations
(an auto-recover one and a human-action one), the source
of truth is wrong, not the UI. Fix the source. UI
"middle ground" copies like "auto-recover, but if you
want to intervene…" are a smell.

### "completed as a lifecycle value"

The P0010.2.5 audit found 1 historical row with
`situations.lifecycle='completed'`. This was a one-time
bug, but the user pushed back: "if it's not in
ContextLifecycleSchema, why is it in the column?"
The fix is the trigger + the data fix + the documented
canonical set. Future writers MUST go through the trigger.

**Lesson:** Free-form TEXT columns in a system with a
documented canonical enum are a bug magnet. Either:
- Add a CHECK constraint / trigger at the DB layer, OR
- Add a Zod refine on every write path, OR
- Convert the column to the Zod schema's type.

Pick one. The trigger pattern (mirrored from
`human_interventions.type`) is the lightweight option that
preserves the IF NOT EXISTS schema semantics.

---

## 11. Open Questions (for the next 3-6 months)

These are NOT in scope for P0010.2.5, but they are the
questions this document is meant to keep visible:

- **P0010.3 / Terminal Lifecycle.** The `closed_at`,
  `final_outcome`, `archive` columns, the Resolution Engine,
  the partial-day temporal comparability, and the "fake
  Situation" from page-1-vs-page-2 dashboard differences.
  See `context/roadmap.md` and the Deferred Technical
  Decisions doc.
- **Action Engine.** A real execution pathway with a
  second-step confirmation, an audit log, and a rollback
  story. Not before the confirmation flow is designed.
- **Event Bus / SSE.** A distribution mechanism for Loop
  events. The persistent fields stay the source of truth;
  the event bus is a fanout. Build only if polling is a
  measured bottleneck.
- **Wake Engine / Event-driven loop.** Today, the Loop
  wakes on a 60s interval. A Wake Engine would let an
  external event (new Signal, new Operator intervention)
  trigger a tick. The current contract is that a
  `human_intervention` is NOT a wake signal — it is
  consumed by the NEXT turn that happens for some other
  reason. Changing that contract requires a careful design
  pass.
- **Knowledge growth.** Today, Knowledge is hand-curated
  markdown under `data/fabric-workspace/knowledge/`. The
  long-term direction is that validated Experience can be
  promoted into Knowledge, but the validation contract
  (which Experience qualifies) is not yet defined.
- **Plugin catalog (万物皆插件).** A UI surface for the
  operator to see what capabilities are available, what
  their contract is, and what the latest run looked like.
  Today, the INDEX.md is the only catalog.

Each of these is **out of scope for P0010.2.5 closure** and
**out of scope for the next 1-2 slices**. They are listed
here so we do not forget they exist.

---

## 12. Reading Order for New Contributors

If you are new to this codebase, read in this order:

1. [CLAUDE.md](../../CLAUDE.md) — the high-level "what this is"
2. [philosophy.md](../../philosophy.md) — the design philosophy
3. [engineering_philosophy.md](../../engineering_philosophy.md) — the engineering manifesto
4. **This document** — the long-term direction, including the
   mistakes we are not willing to repeat
5. [architecture_snapshot.md](architecture_snapshot.md) — the current shape
6. [decisions.md](decisions.md) — the ADRs in chronological order
7. The current slice plan in [current_state.md](current_state.md)
   and [roadmap.md](roadmap.md)

By the time you finish (4), you should be able to answer:

- Why is `Knowledge ≠ Evidence ≠ Fabric` non-negotiable?
- What is the difference between prompt policy and Runtime
  enforcement?
- Why does the Workspace read from `learning_contexts.body`
  and not from a `WorkspacePresentation` table?
- What is the difference between a `LoopEvent` and a
  persistent state fact?
- Why doesn't `situations.lifecycle='closed'` exist?

If you can answer all five, you have internalized the
boundary. Welcome to the codebase.
