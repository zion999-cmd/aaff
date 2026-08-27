# Deferred Technical Decisions

> **Status: living document — maintained alongside the codebase**
> **Owners: agentFabric core team**
> **Last updated: 2026-08-27 (P0010.2.5 closure)**

This document records the **technical decisions we have deliberately
NOT made** — features / capabilities / systems that we have
identified as needed, scoped at a high level, and parked behind a
deliberate boundary. Each entry has:

- **What** — what the deferred system would do.
- **Why deferred** — the reason it is parked, not skipped.
- **Trigger** — what would change the decision (a real user need,
  a measured bottleneck, an external dependency landing).
- **Boundary honored** — what we are NOT doing in the meantime
  that a partial implementation might be tempted to do.

This document is the companion to [design-evolution.md](design-evolution.md)
(which describes the long-term direction) and
[decisions.md](decisions.md) (which records concrete ADRs).
Anything in this document is **deliberately** open, not forgotten.

---

## DTD-001 — Hermes Filesystem Sandbox (NOT BUILT)

**What:** A real filesystem sandbox at the Hermes Session Runtime
layer that constrains the Agent to a curated read-only view of the
Workspace (e.g. `knowledge/`, `capabilities/`, the situation's own
investigation files) and denies reads on `platform/`, `apps/`,
`shared/`, `tests/`, `README`, `AGENTS.md`, `package.json`.

**Why deferred:**
- Hermes 0.20.5 does not expose a per-session path allowlist. The
  `session.create` RPC takes only `{cwd, profile, model, source}` —
  no `allowed_paths`, no `denied_paths`, no `tool_filter`.
- Building our own sandbox would mean either: (a) wrapping every
  `search_files` / `read_file` call with a filter in our `HermesClient`
  (does not exist as a hook point), or (b) writing a tool-proxy
  shim that intercepts calls before they reach Hermes. Both add
  significant code surface and a new failure mode.

**Trigger:** When Hermes exposes a path-allowlist API, or when the
business case for "prevent the Agent from reading source code"
becomes measurable (e.g. a real production drift that we can only
attribute to source-file reading).

**Boundary honored:**
- The current prompt contract says "do not read `platform/`" but
  this is **prompt-level, not enforced**. See
  [design-evolution.md §3](design-evolution.md) and
  the "ADVISORY" sections in `apps/ecommerce/runtime/investigation/prompt.ts`.
- We do NOT write an in-process tool filter that pretends to be a
  sandbox. That would be the worst of both worlds — it would give
  a false sense of security AND add a new failure mode.
- We do NOT pre-process the Workspace directory to remove source
  code from the `cwd`. The Agent must be able to read the
  capability specs under `data/fabric-workspace/`, and the source
  code lives alongside them in the same tree.

---

## DTD-002 — Hermes Tool-Call Quota (NOT ENFORCED)

**What:** A per-session tool-call quota enforced by the Runtime
(e.g. "max 30 tool calls per turn", "max 1 `tool_search` per
session", "max 5 `fabric_execute_capability` calls per turn").

**Why deferred:**
- Hermes 0.20.5 does not expose a per-session quota API. The
  `session.create` RPC takes only `{cwd, profile, model, source}`.
- The current P0010.2.4 "at most once" / "at most N" rules in
  the prompt are **recommendations, not enforcement**. They are
  P0010.2.5-clarified as such.
- The real cost driver today is the LLM token bill, not the
  per-turn tool count. Quota design is upstream of cost
  optimization, and we do not have a measured cost problem yet.

**Trigger:** When Hermes exposes a quota API, OR when our LLM
spend reaches a budget threshold that we cannot hit with prompt
contracts alone.

**Boundary honored:**
- The prompt contract is honest: "recommended once per session
  (no Runtime quota enforcement)".
- We do NOT write our own call counter that "feels like" a quota.
  An in-process counter is not a quota — it does not stop the
  model from making a 31st call, it only stops us from recording
  the 31st call. That is silent data loss, not enforcement.
- We do NOT optimize for "fewer tool calls" at the cost of model
  ground truth. The P0010.2.4 over-restriction is the cautionary
  tale.

---

## DTD-003 — Situation Terminal Lifecycle (P0010.3)

**What:** A formal Terminal Lifecycle for situations with:
- `situations.closed_at` timestamp.
- `situations.final_outcome` enum
  (`resolved` / `auto-resolved` / `merged` / `superseded` /
  `dismissed` / `unresolvable`).
- `situations.archive` boolean.
- A Resolution Engine that decides "this situation is done — close
  it" based on rules (operator action, no movement for N ticks,
  human disposition is `decision/reject` with no follow-up, etc.).

**Why deferred:**
- P0010.3 is its own slice. It deserves its own planning pass
  with full audit of "what does 'done' mean for a Situation?"
- The current `situations.lifecycle` column is a
  **recovery-queue index**, NOT a Terminal Lifecycle. Overloading
  it with a `closed` / `resolved` value would couple the recovery
  scan to the Terminal Lifecycle in a way that makes both harder
  to evolve.
- The P0010.2.5 audit found 1 historical row with
  `situations.lifecycle='completed'`. That value was NOT
  deliberately planted — it was drift. The P0010.2.5 trigger
  (in `applySituationLifecycleGuard`) now blocks any non-canonical
  value at the write boundary. The trigger does NOT introduce a
  new business state machine.

**Trigger:** P0010.3 slice plan is approved, with full audit
matrix (A-J like P0010.2.2) covering Producer → Persistence →
Trigger → API → Workspace Consumer → Live Verified.

**Boundary honored:**
- We do NOT add a `closed` value to `situations.lifecycle`.
- We do NOT add a `situations.closed_at` column.
- We do NOT add a "Resolution Engine" code path.
- The disabled "Situation 归档" button in the Workspace remains
  a stub. It is NOT a feature; it is a placeholder.

---

## DTD-004 — Human Intervention Dual Storage (already in place, but documented as deliberate)

**What:** Human interventions are stored in BOTH
`human_interventions` (relational) and
`learning_contexts.body.humanInterventions[]` (denormalized JSON)
in a single transaction.

**Status:** ALREADY IMPLEMENTED in P0007. This entry is here to
document the choice so future contributors don't try to "fix" the
dual storage.

**Why this is the right shape:**
- The relational table is the source of truth. It supports
  querying ("show me all corrections in the last 30 days"),
  filtering by `actor_id`, and joining against `reviews`.
- The denormalized body copy is the read path. The next
  investigation turn calls `formatPriorHumanGuidance`, which
  walks the body copy. No JOIN, no extra query, the prompt is
  ready in O(interventions).
- The two stay in lockstep because the writer updates BOTH in
  one transaction (`recordInterventionInLearningContext`).

**What we do NOT do:**
- We do NOT add an "event channel" that fires when an
  intervention is written. The Workspace polls on its normal
  refresh cadence. An event channel would be a latency
  optimization, not a correctness requirement.
- We do NOT use the relational table as the read path for the
  prompt. The prompt must read the body copy so the JSON shape
  is stable.
- We do NOT "sync" the two via an event bus. They are written
  together in one transaction. If the transaction commits, both
  are correct. If it rolls back, neither exists. There is no
  third state.

---

## DTD-005 — LoopEvent Persistence (NOT a source of truth)

**What:** Today, the Runtime Loop emits structured trace events
(`tick`, `investigation triggered`, `investigation failed`,
`recovery eligible`, `investigation blocked`) into a structured
log. These events are **trace**, not persistent state. The
source of truth for "is this situation blocked?" is always the
persistent fields in `learning_contexts.body.investigation.*` and
`situations.lifecycle`.

**Why this is deliberate:**
- A LoopEvent is a side-effect, like a log line. It can be lost
  without data loss. The persistent fields cannot.
- A future `Event Bus` (DTD-006) will carry the same payload
  that the persistent fields carry, but the Event Bus will be a
  **distribution mechanism** for the trace, not a replacement
  for the persistent fields.

**Trigger:** N/A — this is a documentation entry, not a
deferred feature. Future contributors MUST NOT propose an event
bus that becomes a source of truth.

**Boundary honored:**
- A LoopEvent can be replayed from a log; a persistent state fact
  is what the next Loop tick will read. See
  [design-evolution.md §5](design-evolution.md).
- The recovery decision in `recovery-candidates.ts` reads
  SQLite, not the log.
- A "real-time WebSocket feed" (when one exists) MUST NOT become
  a read path for the Loop's recovery decision.

---

## DTD-006 — Event Bus / SSE / WebSocket Feed (NOT BUILT)

**What:** A real-time event bus that fans out LoopEvents to
subscribers (Workspace UI, future monitoring, future
notification integrations like Feishu / WeCom / Email /
Telegram). Likely implemented as SSE on top of an in-process
event emitter, with the persistent fields as the read path.

**Why deferred:**
- P0 polling at 4s is acceptable per the P0010.2.x audit
  (ADR-063). We have not measured a UX gap that polling does
  not solve.
- A real event bus has a non-trivial failure surface: what
  happens if a subscriber is down? Do we replay events? What
  if the bus is full? Do we drop oldest or newest? These
  design questions are out of scope for the current slice.
- The external integration boundary (Feishu / WeCom / Email /
  Telegram) is its own deferred item. Building the bus without
  the integration target is premature.

**Trigger:** When polling latency becomes a measured UX problem,
OR when the first external integration target (likely Feishu
notification) is approved with its own slice plan.

**Boundary honored:**
- We do NOT use LoopEvents as a read path for the Loop's own
  recovery decision (DTD-005).
- We do NOT add WebSocket / SSE routes that pretend to be
  authoritative.
- We do NOT build a message broker (Kafka, Redis Streams, etc.)
  in this repo. The Loop is in-process; the bus is in-process.

---

## DTD-007 — Wake Engine / Event-Driven Loop (NOT BUILT)

**What:** A Wake Engine that lets an external event (a new
Signal arriving, a new Operator intervention being recorded) wake
the Loop immediately, instead of waiting for the next 60s tick.

**Why deferred:**
- The current contract is that a `human_intervention` is NOT a
  wake signal. It is consumed by the NEXT turn that happens for
  some other reason (a `meaningful_new_evidence` contentHash
  change, a recovery-scan pick, a tick-driven re-investigation).
  This is documented in `formatPriorHumanGuidance` and
  `investigation-policy.ts`.
- Changing that contract is a design decision with significant
  product implications: it changes the meaning of "I gave the
  Agent feedback" from "the next natural turn will see it" to
  "I just triggered a new turn". Operators may rely on either
  interpretation.
- The current 60s tick is fast enough that the natural-turn
  path is acceptable.

**Trigger:** When operator feedback is measured to be "stale" by
more than 60s, OR when a specific feature needs immediate
re-investigation on feedback.

**Boundary honored:**
- We do NOT add a "trigger immediate re-investigation" button
  to the Workspace without a design pass.
- We do NOT make the Loop reactive to a `human_intervention`
  insert trigger.
- The current "feedback ≠ wake" contract is explicit in
  `apps/ecommerce/runtime/investigation/prompt.ts` (the comment
  block in `formatPriorHumanGuidance`).

---

## DTD-008 — Action Engine (NOT BUILT)

**What:** A real execution pathway that turns a `Recommendation`
into an external action — e.g. "Apply this discount to JD
Product 10072459317818", "Send this Feishu message to the
operations team", "Pause this 京东快车 campaign".

**Why deferred:**
- The current `decision/accept` intervention is a **disposition
  record**, not an execution cue. Operators need to be able to
  say "I will deal with this" without us acting on their behalf.
- An Action Engine without a real confirmation flow is a
  footgun. The "second-step confirmation" (e.g. "You are about
  to apply a 30% discount to 12 SKUs across 2 campaigns. Type
  the product count to confirm.") is not yet designed.
- We don't have the data on what `decision/accept` actually
  leads to. Premature optimization.

**Trigger:** When the first integration target (likely 京东快车
campaign pause, since it has an idempotent operation and a clear
rollback) is approved with its own slice plan, including:
- A two-step confirmation flow design.
- An audit log of every applied action (who, when, what, why).
- A rollback story (or an explicit "no rollback — log only" for
  irreversible operations like "send email").
- A new `apply_*` Fabric capability with its own error model
  (transient / permanent / human_needed).

**Boundary honored:**
- The prompt contract re-affirms the `executionDisabled`
  invariant inline whenever a `decision/accept` is surfaced.
- The platform has no `Action Engine`, no `Approval` route, and
  no external-sending pathway.
- We do NOT add a "apply" button to the Workspace that hides
  the second-step confirmation.
- See DTD-001 + DTD-002 for related deferrals.

---

## DTD-009 — Fabric Capability / Plugin Evolution (LONG-TERM)

**What:** The Fabric capability surface evolves from "10
hardcoded capabilities under `data/fabric-workspace/capabilities/`"
to a real plugin catalog with:
- Runtime registration (a new connector appears without code
  change).
- Operator-visible plugin catalog in the Workspace.
- Per-capability observability (last call, error rate, p50/p95
  latency, cost if measurable).
- Per-capability capability gating (a connector can be disabled
  at the platform level without code change).

This is the **万物皆插件** ("everything-as-plugin") long-term
direction. See [design-evolution.md §7](design-evolution.md).

**Why deferred:**
- The 10 hardcoded capabilities cover the first business loop.
  We have not yet needed the runtime registration path.
- Per-capability observability requires a metrics pipeline that
  does not exist.
- The "operator-visible plugin catalog" is a Workspace surface
  that competes with the Situation feed for attention. Without
  a measured operator need, it is design debt.

**Trigger:** When the second business loop (finance, supply
chain, customer service) needs its own capability set, OR when
the first 3rd-party connector integration is requested.

**Boundary honored:**
- We do NOT add a "plugin SDK" in this repo. A new capability
  is a new file in `data/fabric-workspace/capabilities/` and a
  new entry in the registry, not a runtime plugin.
- We do NOT add per-capability observability without a metrics
  pipeline.
- We do NOT add an operator-facing plugin catalog without
  measured need.

---

## DTD-010 — Knowledge Growth from Validated Experience (NOT BUILT)

**What:** A pathway that takes a validated Experience
(`humanInterventions` with `decision/accept`, or
`WorkItem.status='acknowledged'`) and promotes it into the
Knowledge library (`data/fabric-workspace/knowledge/`) as a
case-log entry. The validation contract would define:
- What kind of Experience qualifies (which `decision/accept`?
  with what operator? for what kind of situation?).
- How the promotion is reviewed (who approves? what
  accountability?).
- How Knowledge is versioned (Knowledge has versions like
  Skills do).

**Why deferred:**
- The validation contract is the hard part. A naive "promote
  every `decision/accept`" is wrong — operators accept
  recommendations for many reasons ("I'll handle it manually",
  "looks right but I want to think about it", "the customer
  already called"). Only some of these are "this is now a
  reusable pattern".
- Knowledge versioning is a real engineering problem. We don't
  have it today.
- The Knowledge / Evidence boundary must NOT collapse. A
  promoted Experience is "this worked in case X" — it is
  Knowledge, not Evidence. The next Agent reading it must not
  confuse "case from 2026" with "today's actual metric".

**Trigger:** When the operator base stabilizes enough that we
have measured "patterns the operator always accepts" with
confidence, OR when a 3rd party requests "I want my team's
playbooks in your system".

**Boundary honored:**
- We do NOT auto-promote `decision/accept` into Knowledge.
- We do NOT add a "promote to Knowledge" button to the
  Workspace without a validation contract.
- The Knowledge / Evidence / Fabric boundary is
  non-negotiable. See [design-evolution.md §1](design-evolution.md).

---

## DTD-011 — Partial-Day / Temporal Comparability Fake Situations (NEXT HIGH PRIORITY)

**What:** A class of false-positive Situations is currently
generated by the detection rules when the dashboard and the
underlying metrics disagree on partial-day vs full-day
comparisons. The classic case: "GMV is 71% down" when in fact
the dashboard was last refreshed at 09:00 and the comparison
day had a different 09:00-vs-full-day shape.

This produces:
- Real-looking `meaningful_change` Situations for noise.
- Investigations that conclude "no real change".
- Operator trust erosion ("the system cries wolf again").

**Status:** NEXT HIGH PRIORITY. This is not "we don't know
about it" — it is "we know about it and we have not fixed it
yet". The current `detectSituations` rules assume full-day
data on both sides of the comparison, which is a documented
limitation. The P0009.1 detection rules emit the situation
honestly; the false-positive is in the upstream signal
ingestion, not in the detection logic.

**Why deferred from P0010.2.5:**
- P0010.2.5 was a closure / correction slice. The fix is
  non-trivial and would benefit from a dedicated audit pass
  covering: signal freshness, dashboard refresh cadence,
  partial-day window detection, and the "downstream consumer
  trust" question.
- A naive "add a `isPartialDay` flag" would just shift the
  problem. The right fix likely involves: (a) making the
  detection rules window-aware (compare same-window-vs-same-
  window when both are partial), (b) suppressing the
  Situation when both days are partial and the comparison is
  unreliable, (c) emitting a "partial-day" tag on the
  Situation so the Workspace can render an honest "low
  confidence" badge.

**Trigger:** This is the next slice candidate after P0010.2.5
closure. It SHOULD be planned as its own slice (P0010.2.6 or
P0010.3-prep).

**Boundary honored:**
- We do NOT silently fix this in P0010.2.5 — it deserves its
  own slice.
- We do NOT add a heuristic "if gmv is exactly 0, skip" — that
  hides a class of real signals (e.g. a 0-GMV day is a real
  business event worth investigating).
- We do NOT add an "ignore partial days" knob to the
  detection config. The right fix is a model change, not a
  knob.

---

## DTD Summary Table

For convenience:

| ID | What | Status | Trigger |
|----|------|--------|---------|
| DTD-001 | Hermes filesystem sandbox | NOT BUILT | Hermes exposes path-allowlist API |
| DTD-002 | Hermes tool-call quota | NOT ENFORCED | Hermes exposes quota API, or cost threshold |
| DTD-003 | Situation Terminal Lifecycle | DEFERRED to P0010.3 | P0010.3 slice plan |
| DTD-004 | Human intervention dual storage | ALREADY DONE (P0007) | N/A — documentation entry |
| DTD-005 | LoopEvent persistence (NOT a source of truth) | DOCUMENTED | N/A — boundary entry |
| DTD-006 | Event Bus / SSE / WebSocket | NOT BUILT | Polling is a measured UX problem |
| DTD-007 | Wake Engine / event-driven loop | NOT BUILT | Operator feedback is measured stale |
| DTD-008 | Action Engine | NOT BUILT | First integration target approved |
| DTD-009 | Fabric plugin evolution (万物皆插件) | LONG-TERM | 2nd business loop or 3rd-party connector |
| DTD-010 | Knowledge growth from Experience | NOT BUILT | Validation contract + Knowledge versioning |
| DTD-011 | Partial-day / temporal comparability | **NEXT HIGH PRIORITY** | P0010.2.6 slice |

DTD-011 is the only entry that is "next", not "someday". The
other 9 are deliberate boundaries we are willing to maintain
for a long time.
