# P0010.3 Workspace State Authority Audit (Read-Only)

> **Date**: 2026-08-27
> **Scope**: All state sources that Workspace UI components read to render
> the Situation Detail page (and the situation Feed). No code changes.
> **Goal**: Catalogue the 8 state sources, their 4+ shape layers, the
> authority gaps, the contradictions that produced the screenshot bug,
> and propose a single authoritative Presentation State schema
> (PROPOSAL ONLY — not implemented in this slice).

---

## Executive Summary

Workspace state has **no single owner**. The same logical concept
("what is this situation's state right now?") is computed in **3
different places** using **3 different enums** over **3 different
shapes**, and each call site mutates its own local variables. The
screenshot bug is a **direct consequence of this authority gap**, not
a button-display bug:

- "生成建议" button was rendered because the **Detail page first
  pass** loaded `/api/situations/:id` which does NOT return
  `blockedRuntimeFailure` or the post-`/recommend` updated
  `investigation.recommendation`. The button check is a pure
  client-side string compare on the **snapshot at first render**.
- "1 work output" was rendered because `materializeWorkItem` is
  called from the **/chat** turn-end (situation-chat.ts:788) but
  **NOT** from the **/recommend** endpoint (situation-chat.ts:981)
  — so the WorkItem count and the in-investigation `recommendation`
  field can disagree after a manual /recommend.
- "判断已形成" status chip was rendered because the Feed endpoint
  uses a **server-side derived 5-state enum** (`pending /
  investigating / observing / needs_human / judgment_ready`) that
  the Detail view does NOT use — the Detail view uses the **raw
  investigation.status** 4-state enum from the Zod schema.

The fix is NOT to patch the button. The fix is to introduce a
**single Workspace Presentation State** that:

1. Is **computed once on the server** (Zod-validated) per situation
2. Is **returned in one place** (`/api/situations/:id`) alongside
   the situation row, the investigation, the outputs, the
   interventions, and the loop signals
3. Is **the ONLY state the UI reads** for "what is this situation
   doing right now"
4. Has **deterministic timestamps** (UTC ISO) and **a single
   refresh seam** (one SSE/poll endpoint)

This audit enumerates the current state surface and then proposes
the unified schema.

---

## 1. State Source Inventory

Eight sources of truth are currently in play. Each has its own
storage location, producer, and reader.

### 1.1 `situations` table — `situations.lifecycle` (DB column)

| Aspect | Value |
|---|---|
| **Storage** | `situations.lifecycle` column (`TEXT`, default `'open'`) |
| **Schema** | No Zod enum. The only enums we have are: `ContextLifecycleSchema = ['open','partial','mature']` ([learning-context.ts:26](shared/schemas/learning-context.ts#L26)) |
| **Producer** | `INSERT ... 'open'` ([p0007.ts:234](platform/server/routes/p0007.ts#L234)) on create; `UPDATE ... 'partial'` on first intervention ([p0007.ts:313](platform/server/routes/p0007.ts#L313)) |
| **Reader** | Returned at [p0007.ts:119](platform/server/routes/p0007.ts#L119), [p0007.ts:184](platform/server/routes/p0007.ts#L184) |
| **Transitions** | `open → partial` (only on 1st intervention). `mature` is NEVER persisted (the `determineLifecycle()` helper at [learning-context.ts:440](shared/schemas/learning-context.ts#L440) computes it but nothing writes it to the column) |
| **Used by UI** | Feed card `data-lifecycle` attribute; lifecycle label computation; tab counter |
| **Authority gap** | (a) No Zod schema for the column; (b) `mature` is computed but never persisted; (c) the column conflicts with `learning_contexts.body.lifecycle` (which is also `open/partial/mature` but written by `determineLifecycle` on read) |

### 1.2 `investigation` block in `learning_contexts.body` — `investigation.status`

| Aspect | Value |
|---|---|
| **Storage** | `learning_contexts.body.investigation` (JSON) |
| **Schema** | `z.enum(['pending','investigating','failed','completed']).optional()` ([investigation.ts:125](shared/schemas/investigation.ts#L125)) — **4 states** |
| **Producer** | Loop emits `investigation_triggered` → `markInvestigation` writes `status='investigating'`; Loop emits `investigation_completed` → `markInvestigation` writes `status='completed'`; Loop emits `investigation_failed` → `status='failed'`. All in `runtime-loop.ts` |
| **Reader** | `/api/situations/:id` returns the raw `investigation`; `/api/situation/:id/investigation` returns the same + `blockedRuntimeFailure` + `consecutiveFailures` |
| **Used by UI** | Detail page (`renderCurrentUnderstanding`, `renderHeroSummary`, `renderLifecycleCard`); Understanding surface gate on the "生成建议" button ([app.js:2232-2233](apps/ecommerce/workspace/app.js#L2232-L2233)) |
| **Authority gap** | (a) The Detail view's understanding surface uses the **raw** `inv.status` (4-state); the Feed view's chip uses a **server-derived** 5-state enum (see 1.4). The two cannot be compared. |

### 1.3 Loop `blockedRuntimeFailure` flag

| Aspect | Value |
|---|---|
| **Storage** | NOT persisted. Computed on each `/api/situation/:id/investigation` call by `countConsecutiveFailures` against `humanInterventions` |
| **Producer** | `apps/ecommerce/runtime/loop/recovery-candidates.ts` (countConsecutiveFailures) |
| **Reader** | `/api/situation/:id/investigation` returns `blockedRuntimeFailure: boolean, consecutiveFailures: number` |
| **Used by UI** | `deriveInvestigationDisplayState` ([presentation.js:312](apps/ecommerce/workspace/presentation.js#L312)) determines `blocked` state from this flag |
| **Authority gap** | (a) NOT in the `/api/situations/:id` response — the Detail page's `loadSituationDetail` does a SECOND `apiGet('/api/situation/.../investigation')` call at [app.js:1511](apps/ecommerce/workspace/app.js#L1511). If this second call fails, the UI defaults to `pending` regardless of the real state. |

### 1.4 `deriveInvestigationStatus()` — server-side 5-state enum

| Aspect | Value |
|---|---|
| **Storage** | Computed at API response time; not persisted |
| **Schema** | `SituationInvestigationStatus` — `['pending','investigating','observing','needs_human','judgment_ready']` (a 5-state enum; source not yet found in `shared/schemas/`) |
| **Producer** | `deriveInvestigationStatus` at [p0007.ts:57-74](platform/server/routes/p0007.ts#L57-L74) |
| **Reader** | `/api/situations` list endpoint returns each situation's `investigation.status` = derived value (line 125); `loadSituationFeed` at [app.js:1148](apps/ecommerce/workspace/app.js#L1148) uses this to filter the Feed |
| **Used by UI** | Feed filter tabs (line 1150-1154), feed status chip (line 1188-1204), feed `badgeCounts` |
| **Authority gap** | (a) 5 DIFFERENT states from the Zod enum (which has 4); (b) the Feed tab filters (`observing`, `needs_human`, `judgment_ready`) DO NOT match any value in the Zod enum — they only exist because the server rewrites the status. The Detail view does not see this rewrite. (c) The Feed treats `failed` as `pending` (line 1150), the Detail treats `failed` as its own state. |

### 1.5 `outputs[]` (WorkItems) in `learning_contexts.body`

| Aspect | Value |
|---|---|
| **Storage** | `learning_contexts.body.outputs` (JSON array of `WorkItem`) |
| **Schema** | `WorkItemStatusSchema = ['ready','delivered','acknowledged','closed']` ([output.ts:62](shared/schemas/output.ts#L62)) |
| **Producer** | `materializeWorkItem` at [recommendation-to-output.ts:55](apps/ecommerce/runtime/loop/recommendation-to-output.ts#L55). Single call site: `situation-chat.ts:788` (only called from `/chat` turn-end, NOT from `/recommend`) |
| **Reader** | `/api/situations/:id` returns `outputs` at the top level (line 203); `/api/situations/:id/outputs` (separate endpoint in `outputs.ts:75`); `/api/outputs` (list) |
| **Used by UI** | Detail page `renderOutputsSection` (first pass, line 1394) + the badge in the Understanding surface |
| **Authority gap** | (a) `materializeWorkItem` is NOT called from `/recommend` — the new recommendation is persisted in `investigation.recommendation` but NOT materialized as a WorkItem. (b) After the user clicks "生成建议", the WorkItem count is stale (still from the prior /chat turn). (c) WorkItem `status` transitions (ready → delivered → acknowledged → closed) are operator-driven; the auto-`delivered` on page load was REMOVED in P0010.1 REPAIR-5. |

### 1.6 `humanInterventions[]` in `learning_contexts.body` + `human_interventions` table

| Aspect | Value |
|---|---|
| **Storage** | BOTH `learning_contexts.body.humanInterventions` (JSON, synced via `recordInterventionInLearningContext`) AND `human_interventions` table (SQL, queried for the timeline + feed counters) |
| **Schema** | `HumanInterventionSchema.type = ['response','correction','context_supplement','decision']` ([learning-context.ts:257](shared/schemas/learning-context.ts#L257)); `DecisionContentSchema.decision = ['accept','reject','defer','override','no_action']` ([learning-context.ts:199](shared/schemas/learning-context.ts#L199)) |
| **Producer** | POST `/api/situations/:id/interventions` ([p0007.ts:276](platform/server/routes/p0007.ts#L276)) — writes BOTH stores; clear-block ([situation-chat.ts:1028](platform/server/routes/situation-chat.ts#L1028)) appends a `decision: override` to both |
| **Reader** | `interventionCount` from SQL JOIN in list endpoint; `interventions[]` array from SQL query in detail endpoint; `humanInterventions` from JSON body in `/api/situation/:id/investigation` |
| **Used by UI** | Feed counter; `hasAcceptedDecision` derivation (in BOTH the feed and detail paths); `deriveSituationLifecycle`'s `interventionCount` parameter |
| **Authority gap** | Two storage locations, dual-write on POST. They could diverge if a future route writes only one. The detail's `interventions.length` (from SQL) and the feed's `interventionCount` (from SQL JOIN) are the same source — consistent. But the JSON `body.humanInterventions` is the third source (used by `countConsecutiveFailures` in `recovery-candidates.ts`) — and that is the one that drives the `blockedRuntimeFailure` flag. Three sources, one logical entity. |

### 1.7 Loop `LoopEvent` ring buffer

| Aspect | Value |
|---|---|
| **Storage** | In-memory ring buffer (200 events) in `loop-events.ts` (lines 142-148: `traceBuffer.push(trace)` on every `mapLoopEventToTraceEvent` call). NOT persisted. Lost on agentFabric restart. |
| **Schema** | `TraceEvent` (runtime-agnostic shape; `source: 'runtime-loop' \| 'system' \| 'agent'`, `kind: 'runtime.scheduled' \| 'runtime.completed' \| 'runtime.skipped' \| 'runtime.blocked' \| 'runtime.recovery_attempt' \| ...`) |
| **Producer** | `runtime-loop.ts` calls `logger.emit(event)`; `stdoutSink` writes to stdout AND pushes the derived `TraceEvent` into `traceBuffer` |
| **Reader** | GET `/api/runtime/loop/events?situationId=X` polls the ring buffer |
| **Used by UI** | Right-pane "Agent Execution Trace" widget at [app.js:2588](apps/ecommerce/workspace/app.js#L2588) — polls every 5 seconds |
| **Authority gap** | (a) Lost on restart — operator sees a gap in the trace timeline. (b) The ring buffer's 200-event cap drops earlier events silently. (c) The polling interval (5s) is hard-coded — not configurable, not coordinated with the situation refresh. |

### 1.8 Human-readable surface timestamps

| Aspect | Value |
|---|---|
| **Storage** | All persisted timestamps are UTC ISO strings (`new Date().toISOString()`) — `created_at`, `updated_at`, `investigation.startedAt/createdAt/updatedAt`, `human_interventions.created_at`, `workItem.createdAt/acknowledgedAt/closedAt`, `Output.createdAt` |
| **Producer** | `shared/utils/time.ts:nowIso` (used everywhere) |
| **Reader** | Mixed: Detail page uses both `new Date(c.reviewAt).toISOString().slice(0,16).replace('T',' ')` at [app.js:1896](apps/ecommerce/workspace/app.js#L1896) (UTC) and `new Date(state.lastTickAt).toLocaleString()` at [app.js:967](apps/ecommerce/workspace/app.js#L967) (operator's local TZ) |
| **Authority gap** | (a) Storage is UTC; rendering is mixed. The Detail page's "观察重点 · 复查时间" card shows UTC; the Feed's "最新 tick" shows local. The operator comparing the two gets confused. (b) The `Date.now()` used in intervention IDs ([app.js:2795](apps/ecommerce/workspace/app.js#L2795)) is local time ms — fine for a unique id but not for display. |

---

## 2. UI Consumers of State (5 distinct derivation points)

The Detail page derives state independently in **5 places**:

| # | Site | What it derives | Inputs | Authority gap |
|---|---|---|---|---|
| 1 | `loadSituationDetail` (Detail second pass) | `invStatus` (4-state), `invBlockedRuntimeFailure` | `apiGet('/api/situation/:id/investigation')` | The two sources of state for the Detail page (`/situations/:id` and `/situation/:id/investigation`) are loaded in two separate `apiGet` calls. If the second fails, `invBlockedRuntimeFailure` defaults to `false` and the UI does not know |
| 2 | `deriveSituationLifecycle` (presentation.js:211) | `lifecycle` (5-state) | `invData, interventionCount, hasAcceptedDecision` | This is the canonical derivation; but the inputs differ between Feed (uses `s.interventionCount` from SQL JOIN + `s.hasAcceptedDecision` flag from server) and Detail (uses `interventions.length` from SQL + recomputed `hasAcceptedDecision` from interventions array) — same logic, different inputs |
| 3 | `deriveInvestigationDisplayState` (presentation.js:312) | `displayState` (5-state) | `invData, blockedRuntimeFailure, consecutiveFailures` | The Detail banner map. The `blocked` state wins over everything — but this only exists in the Detail view; the Feed does not use it. |
| 4 | Server-side `deriveInvestigationStatus` (p0007.ts:57) | `status` (5-state) | `inv.stopReason, inv.recommendation.humanNeeded` | The Feed's only state source. Detail view does NOT use it. |
| 5 | Inline string-match in `renderCurrentUnderstanding` (app.js:2232-2280) | Whether to show "生成建议" button | `inv.status === 'completed' && !rec` | The "已完成调查 / 可生成建议" affordance. PURE string compare on a snapshot. No fallback for race conditions (e.g. user clicks twice before re-fetch returns). |

**5 derivation points, 3 enums, 8 sources.**

---

## 3. The Screenshot Bug (root cause chain)

The screenshot showed: **"判断已形成" status chip + 1 work output (WorkItem) + "生成建议" button still visible + recommendation apparently generated.**

The root cause is NOT the button display logic. It is the **3-source state divergence**:

1. The **/chat** turn completed → `materializeWorkItem` created `out_<fp[:16]>` (status=`ready`, type=`recommendation`) at the end of [situation-chat.ts:788](platform/server/routes/situation-chat.ts#L788) → WorkItem count = 1.
2. The **/chat** turn also persisted `investigation` with `status='completed'` + `recommendation={...}` and a `stopReason='judgment'` — Detail renders this as "判断已形成" chip + Understanding surface.
3. The user opens the Detail page. First pass loads `/api/situations/:id` → `outputs=[out_X]`, `learningContext.investigation.recommendation={...}` (already there). The Detail page's first-pass render uses **`raw.outputs` (the server-shaped count) AND `raw.learningContext.investigation.status`**. Both are correct → "1 work output" + "判断已形成" chip.
4. Second pass loads `/api/situation/:id/investigation` → the Understanding surface re-renders. The `rec` check is `inv.status === 'completed' && rec` → if `rec` is set, render the recommendation; if not, show the button.

**But:** the `rec` field comes from `invData.recommendation` (the investigation block). If the user opened the Detail AFTER a successful /chat turn, `inv.recommendation` is set, the button is hidden. **So how did the screenshot show all three at once?**

Most likely: the operator previously hit "生成建议" which wrote a fresh `recommendation` to the investigation block but did NOT create a new WorkItem (because `/recommend` does not call `materializeWorkItem`). The page was reloaded. The Detail page's first pass loaded `outputs=[out_X]` (1 from the prior /chat turn) and `learningContext.investigation.recommendation={...}` (from the /recommend call). The "1 work output" is the OLD one. The Understanding surface then re-rendered with the NEW `rec` set → no "生成建议" button.

**HOWEVER:** the second pass loads `/api/situation/:id/investigation` — which does NOT return the `recommendation` field, but DOES return the `investigation` block. If the page was reloaded by clicking a feed card and the page-level `state.situationContext.outputs` was set in a PRIOR detail open with `outputs=[out_X]`, then the user switched to a different situation (which did NOT call `loadSituationDetail` on the same situation), the cache may have been stale. OR — the operator was viewing the same situation in two tabs: one showed the post-`/recommend` state (no button), the other showed the pre-`/recommend` state (button still there).

The most **plausible** scenario for a single-tab reproduction: **the user clicked "生成建议" → `/recommend` ran → it took 1-2 seconds → the page did not auto-refresh → the operator saw the "1 work output" badge in the Outputs section but the Understanding surface still showed the "已完成调查 / 可生成建议" button**. Because the `state.situationContext.outputs` was set from the first pass, and the Understanding surface re-render is local to the `uEl` element only (line 2295: `renderCurrentUnderstanding(uEl, inv.investigation)`), the rest of the page (Outputs, lifecycle card) is not re-rendered. The button check on the FIRST render's understanding surface was `completed && !rec` (button shown). The /recommend response came back, the local re-render ran with the new `rec` set → button hidden — but only in that surface, not the card.

The right side panel (Trace / Track) may also have remained in its prior state.

**This is a fundamentally multi-source-state problem.** The fix is a single source.

---

## 4. Dynamic Refresh & Timezone Audit

| Concern | Current behavior | Gap |
|---|---|---|
| **Page auto-refresh** | `setInterval(loadData, 300000)` at [app.js:3727](apps/ecommerce/workspace/app.js#L3727) (5 min, only on the main `loadData` for the dashboard) | The Situation Detail page has NO auto-refresh. The Feed has no auto-refresh. The only auto-refresh is the Agent Execution Trace (5s polling, [app.js:2588](apps/ecommerce/workspace/app.js#L2588)). The "1 work output" badge is rendered once on `loadSituationDetail` and never updated. |
| **Loop event freshness** | Right-pane trace polls every 5s against an in-memory ring buffer (loop-events.ts) | If the ring buffer is full (200 events), older events are dropped silently. The operator sees a gap but no warning. |
| **Timezone in display** | Mixed: `toLocaleString()` (local) at [app.js:967](apps/ecommerce/workspace/app.js#L967); `toISOString().slice(0,16)` (UTC) at [app.js:1896](apps/ecommerce/workspace/app.js#L1896) | The Observation Commitment card shows UTC; the Runtime tick panel shows local. Operator comparing "复查时间 2026-08-29 08:00" (UTC) with "上次 tick 2026-08-28 16:00" (local CST) is confused. |
| **ID generation in interventions** | `interventionId: 'int_' + Date.now()` at [app.js:2795](apps/ecommerce/workspace/app.js#L2795) | Local-time millis. Two interventions in quick succession on different days are sortable. But the timestamp is also persisted as ISO in the same row. Two clocks. |
| **Output createdAt** | `nowIso()` (UTC) at [recommendation-to-output.ts:88](apps/ecommerce/runtime/loop/recommendation-to-output.ts#L88) | UTC. Display formatting is in the UI. |
| **`observationCommitment.reviewAt`** | `parseReviewAtFromRecommendation` parses "继续观察 N 天" out of the agent text and computes `new Date(startedAt).getTime() + days * 86400_000` | The `startedAt` is the investigation's `updatedAt` (UTC). The arithmetic is done in UTC. Display is in UTC. So "复查时间" is honest in UTC. The Operator card has the local-clock "上次 tick" on the same panel. |

---

## 5. Authority Map (current state)

```
                    ┌──────────────────────────────────────┐
                    │   /api/situations/:id (p0007.ts:141) │
                    │   - situations row (lifecycle col)   │
                    │   - interventions[] (SQL)            │
                    │   - outputs[] (from body.outputs)    │
                    │   - learningContext (raw body JSON)  │
                    └──────────────────────────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
   Feed (loadSituationFeed)    Detail first pass (state.situationContext)  (no consumer)
   - deriveInvestigationStatus - Outputs count (raw.outputs)
     (server-side, p0007.ts:57) - Initial lifecycle badge
   - 5-state derived enum       - First-pass Understanding placeholder
   - statusChip from inv.status   (businessDescribeSituation, no inv)
                                 - Initial Recommendation section
                                   (no inv => "生成建议" button)
                                          │
                                          ▼
                    ┌──────────────────────────────────────┐
                    │   /api/situation/:id/investigation    │
                    │   (situation-chat.ts:1005)            │
                    │   - investigation (raw body block)    │
                    │   - blockedRuntimeFailure (computed)  │
                    │   - consecutiveFailures (computed)    │
                    └──────────────────────────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
   Detail second pass             Display state                Understanding
   - invStatus (4-state)          - deriveInvestigationDisplayState  (5-state)  surface
   - hasAcceptedDecision (recomputed) - banner + button visibility - renderCurrentUnderstanding
   - renderLifecycleCard          - INVESTIGATION_DISPLAY_BANNER     - "生成建议" gate (4) string-compare
   - renderHeroSummary            - showClearBlock flag               - if rec set: hide button
   - renderCurrentUnderstanding                                   - if !rec: show button
   - renderInvestigationTrack
   - renderInvestigationTrace

   ┌─────────────────────────┐
   │ /api/runtime/loop/events │  (loop-events.ts traceBuffer, in-memory)
   │ - LoopEvent (5s polling) │  Only used by Agent Execution Trace widget
   └─────────────────────────┘
```

**Each arrow is a separate API call with its own response shape.**

---

## 6. Proposed Authoritative Workspace Presentation State (PROPOSAL ONLY — not implemented in this slice)

A new Zod schema in `shared/schemas/workspace-presentation.ts`:

```ts
// PROPOSAL — DO NOT IMPLEMENT IN THIS AUDIT
// This is the contract a future slice should build.

import { z } from 'zod';
import { IsoDateString } from './common.js';

/** Single source of truth for "what is this situation doing right now".
 *  Computed by a server-side reducer in `apps/ecommerce/workspace/
 *  presentation-state.ts` (also future). The Detail page, Feed, and
 *  any other surface read THIS shape — never the raw investigation
 *  status, never the raw lifecycle column, never the loop events. */

export const PresentationStateSchema = z.enum([
  'pending',            // No investigation yet
  'investigating',      // Loop emitted investigation_triggered; turn in flight
  'recoverable',        // Latest turn failed but < threshold; Loop will retry
  'completed',          // Loop emitted investigation_completed
  'observing',          // Completed + stopReason='observe' (or failed-with-prior-cognition)
  'waiting_human',      // Completed + stopReason='missing_capability'/'ask_human' OR recommendation.humanNeeded non-empty
  'blocked',            // Loop emitted investigation_blocked; operator must clear
]);
export type PresentationState = z.infer<typeof PresentationStateSchema>;

export const WorkItemSummarySchema = z.object({
  outputId: z.string(),
  type: z.enum(['recommendation', 'analysis', 'work_item', 'report']),
  status: z.enum(['ready', 'delivered', 'acknowledged', 'closed']),
  content: z.string(),
  createdAt: IsoDateString,         // UTC ISO (display layer reformats to local)
});

export const InvestigationSummarySchema = z.object({
  situationId: z.string(),
  status: PresentationStateSchema,  // NOT the raw inv.status — the derived state
  stopReason: z.enum(['judgment','observe','missing_capability','ask_human']).optional(),
  judgment: z.string().default(''),
  currentUnderstanding: z.string().default(''),
  recommendation: z.object({
    recommendation: z.string(),
    rationale: z.string().default(''),
    expectedOutcome: z.string().default(''),
    risks: z.array(z.string()).default([]),
    prerequisites: z.array(z.string()).default([]),
    humanNeeded: z.array(z.string()).default([]),
  }).optional(),
  // P0010.2.2 sidecar (already exists, but we expose it here for completeness)
  consecutiveFailures: z.number().int().min(0).default(0),
  maxConsecutiveFailures: z.number().int().positive().default(3),
  // Timestamps — all UTC ISO. Display layer (UTC vs local) is the UI's job.
  startedAt: IsoDateString.optional(),
  updatedAt: IsoDateString.optional(),
});

export const InterventionSummarySchema = z.object({
  interventionId: z.string(),
  type: z.enum(['response','correction','context_supplement','decision']),
  decision: z.enum(['accept','reject','defer','override','no_action']).optional(),
  summary: z.string(),
  timestamp: IsoDateString,
});

/** The full Presentation State returned by GET /api/situations/:id. */
export const WorkspacePresentationStateSchema = z.object({
  situationId: z.string(),
  // The single lifecycle field. Replaces situations.lifecycle (DB col) AND
  // deriveSituationLifecycle (UI) AND deriveInvestigationStatus (server).
  presentation: PresentationStateSchema,
  // Pre-derived for UI — every label/emoji/text lives in a single map.
  headline: z.string(),      // e.g. "🔍 调查中"
  detail: z.string(),         // The "Runtime will…" sentence
  showGenerateRecommendation: z.boolean(),
  showClearBlock: z.boolean(),
  showLegacyStart: z.boolean(),
  // Structured content blocks the Detail page renders, computed once.
  investigation: InvestigationSummarySchema.nullable(),
  outputs: z.array(WorkItemSummarySchema).default([]),
  interventions: z.array(InterventionSummarySchema).default([]),
  // Last refresh marker — UI uses this to show "stale as of …" if needed.
  computedAt: IsoDateString,
  // The unique ID of the LoopEvent that produced this state (for Trace linking)
  lastLoopEventId: z.string().optional(),
});
```

### 6.1 Server-side reducer (future, PROPOSAL)

`apps/ecommerce/workspace/presentation-state.ts` (future) — a pure
function `(situationRow, learningContext, interventions, loopState) →
WorkspacePresentationState`. The reducer:

1. Reads `learningContext.investigation.status` (raw).
2. Applies the precedence rules in §6.2.
3. Maps to the canonical 7-state `PresentationStateSchema`.
4. Looks up the headline + detail from a single label map (replaces
   both `SITUATION_LIFECYCLE_LABEL` and `INVESTIGATION_DISPLAY_BANNER`).
5. Returns the full `WorkspacePresentationState`.

### 6.2 State precedence (the single decision tree)

| Precedence | Condition | Resulting state |
|---|---|---|
| 1 | `consecutiveFailures >= maxConsecutiveFailures` AND `loopLastEvent === 'investigation_blocked'` | `blocked` |
| 2 | `inv.status === 'pending'` OR `inv == null` | `pending` |
| 3 | `inv.status === 'investigating'` | `investigating` |
| 4 | `inv.status === 'failed'` AND `hasPriorValidCognition(inv)` | `observing` (the prior cognition is still on file) |
| 5 | `inv.status === 'failed'` (no prior) | `recoverable` |
| 6 | `inv.status === 'completed'` AND `inv.stopReason === 'observe'` | `observing` |
| 7 | `inv.status === 'completed'` AND `inv.stopReason ∈ {missing_capability, ask_human}` | `waiting_human` |
| 8 | `inv.status === 'completed'` AND `inv.recommendation?.humanNeeded?.length > 0` | `waiting_human` |
| 9 | `inv.status === 'completed'` (default — includes stopReason='judgment') | `completed` |

This is a single deterministic tree. No `void hasAcceptedDecision`
(presentation.js:253) "accepted for forward-compat" placeholder.

### 6.3 Endpoint consolidation (future)

- **GET /api/situations/:id** returns `WorkspacePresentationState` (in
  addition to the raw `learningContext` for backward compat).
- The Detail page's `loadSituationDetail` makes ONE call. The second
  call to `/api/situation/:id/investigation` is REMOVED.
- The Feed's `loadSituationFeed` reads `s.presentation` instead of
  `s.investigation.status`. Filter chips become a single enum match
  on `presentation`.

### 6.4 Refresh seam (future)

- One `setInterval` per page (e.g. 5s for the Detail page) polling
  `/api/situations/:id`. The Detail page no longer re-renders the
  Understanding surface in isolation — every refresh rebuilds the
  whole presentation from a single response.
- OR: a single SSE endpoint `/api/situations/:id/events` that streams
  LoopEvents filtered to the situation. The Detail page subscribes
  on entry, unsubscribes on exit. The 5s polling goes away.

### 6.5 Timezone (future)

- All persisted timestamps stay UTC ISO (no change to storage).
- The Detail page renders ALL timestamps via a single
  `formatTimestamp(iso, mode)` helper. `mode='local'` for
  operator-facing (Review card, Tick panel); `mode='utc'` for the
  server-clock field. The helper stamps the timezone explicitly
  (e.g. `2026-08-29 08:00 (UTC+8)`) so the operator always knows
  which clock they are looking at.

---

## 7. Findings (severity-ranked)

| # | Severity | Finding | Fix location |
|---|---|---|---|
| 1 | **HIGH** | `SituationLifecycle` (5-state) is defined ONLY in `presentation.d.ts` — no Zod schema, no DB column. The presentation UI is the source of truth for "what is this situation doing". | §6 — new `PresentationStateSchema` |
| 2 | **HIGH** | `deriveInvestigationStatus` (server, p0007.ts:57) returns a 5-state enum that **does not exist in the Zod schema**. The Feed and Detail use different enums. | §6.3 — unify on `presentation` field |
| 3 | **HIGH** | `materializeWorkItem` is NOT called from `/recommend`. WorkItem count and `investigation.recommendation` can disagree. The screenshot bug. | After /recommend succeeds, also call `materializeWorkItem` (re-uses the same idempotent fingerprint, so safe to re-run). |
| 4 | **HIGH** | `loadSituationDetail` makes 2 separate `apiGet` calls. If the second fails, the UI defaults to `pending` regardless. The first pass is "OK" but stale. | §6.3 — one call |
| 5 | **MEDIUM** | 3 derivation points (`deriveSituationLifecycle` in app.js, `deriveInvestigationStatus` in p0007.ts, `deriveInvestigationDisplayState` in presentation.js) all read different inputs and produce different enums. | §6.1 — one reducer |
| 6 | **MEDIUM** | The Feed's filter chips (`observing`, `needs_human`, `judgment_ready`) are not reachable by the Detail view's enum (`watching`, `waiting_human`, `closed`). Operator filtering "observing" sees N situations, but opening one shows "watching" in the card. | §6.2 — single 7-state enum |
| 7 | **MEDIUM** | Detail page has no auto-refresh. The Feed has no auto-refresh. The 5s Runtime Trace poll is the only live signal. | §6.4 |
| 8 | **MEDIUM** | Timezone display is mixed. Review card shows UTC, Tick panel shows local. Operator confusion. | §6.5 |
| 9 | **LOW** | `situations.lifecycle` column is `open|partial` only; `mature` is never persisted. The schema enum has `mature` but no code path writes it. | Decide: either drop `mature` from the schema enum, or persist it. §1.1. |
| 10 | **LOW** | `human_interventions` table and `learning_contexts.body.humanInterventions` are dual-written on every POST. They could diverge. | Either make one the read source and the other a write-only mirror, or unify. |
| 11 | **LOW** | The Loop event ring buffer is 200 events, lost on restart. Operator sees a gap. | Either persist LoopEvents to a SQL table, or surface a "ring buffer truncated" warning. |

---

## 8. Boundary (this audit does NOT do)

- **No code changes.** This is read-only.
- **No Zod schema added.** The proposed schema in §6 is for the next
  slice (P0010.3.1 or later).
- **No decision on §6 endpoints.** The user must approve the
  proposal before any implementation.
- **No migration plan.** The `situations.lifecycle` column, the
  dual-write of interventions, and the 5-state derived enum in
  p0007.ts are all in scope for the IMPLEMENTATION slice — not this
  audit.
- **No exploration of LoopEvent persistence.** Finding 11 is noted
  but not designed.
- **No UX redesign.** The §6 schema is the MINIMUM surface needed
  to kill the multi-source authority gap; the operator UI can stay
  the same shape (Detail + Feed + right pane).

---

## 9. Recommended next step (NOT implemented here)

The user has 3 options:

1. **Approve the §6 proposal as a planning artifact.** Open a
   P0010.3.1 plan-mode session. Implement `presentation-state.ts` +
   the new `WorkspacePresentationState` schema + the single endpoint
   change + the Detail page consuming the new field. Tests at 80%+
   coverage for the reducer and the precedence tree.
2. **Patch the screenshot bug only** (Finding #3) — call
   `materializeWorkItem` from `/recommend`. This is a 1-line
   change. Does NOT address the larger authority gap.
3. **Stop button-fixing entirely.** Adopt the audit findings and
   plan the unified state.

Recommendation: **Option 3.** The user's stated goal is "我们前面
提到的 动态刷新 和 时间戳/时区 也应该一起进入这个审计". Patching the
button fixes the visible symptom but leaves the 5 derivation
points, 3 enums, and 2 timezone formats in place. The next
screenshot will show a different contradiction.
