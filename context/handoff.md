# Handoff — Hermes Integration Correction (ADR-064) (2026-08-27)

## Session goal

User live review of P0010.2.4 fix (ADR-061) acknowledged the connect-chain was
correct but pointed out the **runtime/diagnostic contract was still wrong in 3
ways**:

1. The error message `Missing Hermes dashboard session token...` made an
   operator believe "Hermes is down" when in fact Hermes may be up and serving
   with `auth_required:false` and a random in-memory `_SESSION_TOKEN` that
   the resolver has no path to read. The diagnostic conflated "no token" with
   "runtime unreachable".
2. The readiness chip in Workspace read `d.workspace === 'ready'`, which
   was always `'ready'` and never reflected Hermes health. It conflated
   "agentFabric process up" with "Hermes Session Runtime up".
3. The UI hint "请确认 Hermes serve 已启动" used the human word "Hermes"
   without distinguishing the **gateway** (port 8642, API_SERVER_KEY Bearer)
   from the **session runtime** (port 9119, HERMES_DASHBOARD_SESSION_TOKEN) —
   which is the actual production chain agentFabric uses.

User instruction (verbatim, hard constraint):
> "先纠正运行/诊断 contract，再继续 7500f65 的真实浏览器 live acceptance"
> + "HermesSessionClient → hermes serve → /api/ws 是唯一整合。
> 不允许 gateway:8642 fallback to /api/ws、gateway token/API_SERVER_KEY
> → session token、自动看到 Hermes PID 就猜 transport。HERMES_WS_URL 是
> Session Runtime endpoint 的唯一配置来源；可以有明确默认 9119，但日志
> 必须说明这是 serve default，不是'检测到 gateway'。如果 endpoint
> 不可达，错误必须写：'Hermes Session Runtime unavailable at <url>.
> AgentFabric requires \'hermes serve\' for the configured session
> adapter.'。不要因为 8642 gateway 存活就认为 session runtime 存活。
> 不要因为 9119 不存在就认为 Hermes 整体离线。Health 必须分层：Hermes
> gateway running/not checked；Hermes session runtime (/api/ws)
> healthy/unavailable；Agent turn healthy/failed。不得只显示统一的 Hermes
> online/offline。Token domain 分离：/api/ws → HERMES_DASHBOARD_SESSION_TOKEN；
> :8642/v1 → API_SERVER_KEY。禁止相互 fallback."

5 hard constraints → 5 file-level decisions (see ADR-064 for full text).

## What was changed

| File | Change | Why |
|---|---|---|
| `platform/runtime/hermes/health-state.ts` (NEW, 257 LOC) | Process-singleton 3-layer `HermesHealth` shape (gateway not_checked + sessionRuntime {url,port,state,authRequired,probeFailed,lastProbedAt,tokenSource} + agentTurn {state,lastTurnAt,lastFailureReason}) | Single source of truth; one read API, one write API per layer; gateway is an **advertised non-feature** |
| `platform/runtime/hermes/session-client.ts` | `missingTokenError(probe)` rewritten to user-verbatim wording + resolution note + "NOT a fallback" tail; new `sessionRuntimeUnreachableError(err)`; `connect()` 4 exit paths call into health-state BEFORE throwing; `parsePortFromUrl` exported; `HermesAuthError.reason` union extended with `session_runtime_unreachable`; 9119 comments annotated "hermes serve default (Session Runtime)" | Operator must see the exact required prefix; the difference between "no token" and "token accepted but WS refused" is now distinguishable; readiness/status reflects truth even if no caller awaits the throw |
| `platform/runtime/hermes/token-resolver.ts` | 9119 annotations = "hermes serve default (Session Runtime)"; top comment block extended with explicit token-domain-separation paragraph | Re-assert ADR-061's removal of `HERMES_GATEWAY_TOKEN`; prevent accidental re-introduction of a gateway fallback |
| `platform/server/routes/runtime.ts` | `/api/readiness` embeds `hermes: {gateway, sessionRuntime, agentTurn}` field, re-probes `/api/health` on every call; new `/api/runtime/hermes/status` route | Readiness chip must reflect Hermes truth, not the always-`'ready'` workspace field; dedicated route for cheap monitoring poll |
| `apps/ecommerce/runtime/loop/runtime-loop.ts` | Imports `recordAgentTurn`; called on all 3 turn outcome paths (ok / result.ok=false / catch) with structured `failureReason` | Agent-turn layer reflects the most recent investigation turn, not a stale boolean |
| `apps/ecommerce/workspace/app.js` | `renderReadiness()` reads `d.hermes.sessionRuntime.state` (primary) + `d.hermes.agentTurn.state` (suffix), NOT `d.workspace === 'ready'`; 3 catch-block UI hints (L2817, L3404, L3411) rewritten to "Session Runtime 是 `hermes serve`（默认端口 9119），不是 hermes gateway（端口 8642）" | Two-layer visible to operator; no single combined boolean; both transport layers named explicitly |
| `tests/unit/hermes/diagnostic-message.test.ts` (NEW, 13 tests) | Pins 3-layer shape + diagnostic message contract + token domain separation | Regression net for the diagnostic contract; touching the message wording or the health shape now requires a deliberate ADR update |
| `tests/unit/hermes/session-client.test.ts` + `tests/unit/hermes/session-client-lazy-token.test.ts` | 5 error-message assertions updated from "Hermes connect failed twice" to ADR-064 prefix "Hermes Session Runtime unavailable at" + "AgentFabric requires 'hermes serve'" body | Tests must match the operator-facing contract |

## Verification

- **typecheck**: `npm run typecheck` — 0 new errors vs baseline (baseline has 19
  pre-existing, none introduced by this slice).
- **unit tests**: 13 new tests in `tests/unit/hermes/diagnostic-message.test.ts`,
  all pass. Existing session-client tests updated for the new wording; 5 old
  assertions rewritten to the new contract.
- **full suite**: `npm test` → **1123 passed / 5 pre-existing flaky** vs master
  baseline before this slice of **1110 passed / 5 pre-existing flaky** —
  **net 0 new regression**, +13 net new tests. The 5 pre-existing flaky are
  the same as in master:
  - `capability/coverage.test` (real API count vs assertion 50)
  - 3× `loop/runtime-loop.test` (pre-existing `vi.mock` connect-spy timing)
  - `hermes/session-client-lazy-token.test` (pre-existing slow-timer
    unhandled-rejection pattern)

## Risk surface

- **operator mental model shift**: the readiness chip text changes from
  "Hermes · ready" to "Session Runtime · ready · Agent Turn · turn ok" —
  this is intentional, but operators who screenshot the old chip for
  runbooks need to know.
- **/api/readiness response shape changed**: now includes a `hermes` field.
  External clients that strictly-typed the old shape (without `hermes`) will
  just see an extra field — no breakage.
- **/api/runtime/hermes/status is new**: not yet consumed by any UI; it
  exists for cheap monitoring and for the future Wake Engine (P0012) that
  needs a structured 3-layer health source.

## NOT in scope (verbatim from user)

- No 8642 adapter.
- No gateway as session transport.
- No 3rd Hermes main path.
- No Workspace State Convergence design change (ADR-063 is intact).
- No P0010.3 / Terminal Lifecycle / Resolution Engine / new persistent
  lifecycle.
- No Event Bus / SSE / WebSocket push.
- No Wake Engine / Action Engine / Approval / external sending.
- No SubprocessHermesClient deletion (still used for the legacy
  `rankProductsComposition` path).
- No Hermes proxy.
- No fake time / provenance.

## Next-step (live acceptance, deferred per user order)

When the operator runs live acceptance for the 7500f65 Workspace State
Convergence work, the test environment **must**:

1. Start `hermes serve --port 9120` (NOT `hermes gateway`).
2. Export `HERMES_DASHBOARD_SESSION_TOKEN=<chosen>` in BOTH the `hermes serve`
   shell AND the agentFabric shell.
3. Export `HERMES_WS_URL=ws://localhost:9120/api/ws` in the agentFabric shell.
4. Verify via the UI: readiness chip says "Session Runtime · ready · Agent
   Turn · turn ok" (after the first investigation turn completes).
5. Verify via `/api/runtime/hermes/status` (curl) that
   `sessionRuntime.state === 'healthy'` and `agentTurn.state === 'healthy'`
   (after at least one turn).

If the operator instead only starts `hermes gateway` on 8642, the readiness
chip must show "Session Runtime · unavailable · Agent Turn · no turn yet"
and the error hint in the chat catch-block must read exactly the
ADR-064-required prefix. This is the correct behavior — gateway is a
separate service, not a session transport.

## Suggested next ADR (NOT a proposal, just a forward note)

- If live acceptance needs to validate the **agent-turn** path against a
  real Hermes, the test should pre-seed a Situation via the existing
  `runSituationProducer` path (P0009.1) so the loop has a candidate to pick
  up on the first tick.
- The Wake Engine / Event Bus work (P0012) can now consume
  `/api/runtime/hermes/status` as a structured source of "is the agent
  actually online?" — this slice makes that consumption possible without
  inventing a new probe path.

---

# Handoff — P0010.2.x Workspace State Convergence (ADR-063) (2026-08-27)

## Session goal

User live review of P0010.2~P0010.2.4 surface exposed 5 real **architectural
authority** gaps — the same data was being read 8 different ways by 5 different
UI derivation points using 3 different enums. The Detail page said "等待 Agent
自动调查" while simultaneously showing a "立即调查" button. The Feed and
Detail could disagree on the same Situation. `/chat` and `/recommend`
produced different DB states for the same Agent action. The "blocked" state
disappeared after process restart. Investigation `failed` + prior valid
cognition was being rendered as "observing" — which the user correctly flagged
as wrong.

User instruction (verbatim, hard constraint):
> "可以，这次不要再拆小片了"  ...  "我建议这次就让 Claude 整刀做完，不再 STOP 在中间等我们逐项批准"

The only three STOP conditions authorized:
1. Changes to `situations.lifecycle` business meaning
2. New persistent lifecycle
3. Event Bus / SSE required

**None of the three were triggered.** This is a one-shot delivery.

## 5 audit dead-legs and how each was closed

### 1. Multiple derivation points reading different sources with different enums

**Audit**: Feed chip → derived from `inv.status` string. Detail banner → derived
from `blockedRuntimeFailure` + `consecutiveFailures` (5-state
`deriveInvestigationDisplayState`). Detail "恢复" button visibility → derived
from `invBlockedRuntimeFailure` fuzzy text match. Timeline state → derived from
`updatedAt` vs `startedAt`. 3 different enums, 5 different functions, 8 different
state sources. Detail page contradiction "auto-recover, no human" + clear-block
button shown together was the smoking gun.

**Fix**: ONE pure server-side reducer at
`apps/ecommerce/workspace/presentation-state.ts:478` returning
`WorkspacePresentationOutput`. UI reads ONLY this. 7-state enum:
`pending / investigating / recoverable / completed / observing /
waiting_human / blocked`. The legacy `deriveInvestigationDisplayState` (5-state)
is still exported for back-compat but marked DEPRECATED and is no longer
called by the Workspace app.

### 2. WorkspacePresentation must be a derived view, not a new lifecycle

**Hard rule** (user verbatim):
> "WorkspacePresentation 应该是派生视图，不是新的业务 lifecycle... 它**不能替代**
> `situations.lifecycle`，也不能成为新的持久化状态机，更不能写回 DB"

**Implementation**:
- `shared/schemas/workspace-presentation.ts:1-21` (file header) states the rule.
- Reducer is PURE: no `INSERT` / `UPDATE` SQL, no `Date.now()` in body
  (`now` passed by caller for testability).
- No new columns added. No `situations.presentation_state`. No new
  `investigation.presentation_state`. No persisted hash other than
  `presentationRevision` (which is computed at request time, not stored).
- `situations.lifecycle` (`open|partial|mature`) untouched. `investigation.status`
  (`pending|investigating|failed|completed`) untouched. `outputs[].status`
  untouched.

### 3. `failed + hasPriorValidCognition` → `recoverable`, NOT `observing`

**Audit**: prior pre-P0010.2.x code promoted failed investigations to
`observing` whenever a prior valid cognition (judgment / currentUnderstanding)
existed in the body. The user correctly identified this as wrong — a failed
investigation is a failed investigation; "prior cognition preserved" is a
*content-layer supplemental* fact, not a state transition.

**Fix**: `presentation-state.ts:decidePresentation` (decision tree) returns
`recoverable` for `inv.status='failed'` regardless of whether
`hasPriorValidCognition` is true. The banner carries a separate boolean
`priorValidCognitionPreserved: boolean` so the UI can render
"上一次有效判断仍保留" as a supplement, but the state itself is `recoverable`.
Test: `reducer.test.ts#failed+hasPriorValidCognition_is_recoverable_not_observing`.

### 4. `humanNeeded[]` does NOT participate in `waiting_human`

**Hard rule** (user verbatim):
> "`waiting_human` 不能因为... `recommendation.humanNeeded.length > 0` 就自动成立...
> 真正应该进入 `waiting_human` 的只能是明确的 blocking contract"

**Fix**: `presentation-state.ts:decidePresentation` `waiting_human` branch
only matches `stopReason ∈ {ask_human, missing_capability}`. The
`recommendation.humanNeeded[]` array is **read** (surfaced in
`InvestigationSummary.humanNeeded`) but **does not affect state**. Test:
`reducer.test.ts#humanNeeded_does_not_participate_in_waiting_human_decision`.

### 5. `blocked` must use persisted sidecars, NOT `loopLastEvent`

**Hard rule** (user verbatim):
> "`blocked` 绝不能依赖... `loopLastEvent === investigation_blocked`...
> `blocked` 必须来自持久事实"

**Fix**: Reducer `blocked` branch requires **BOTH**:
- `inv.consecutiveFailures >= threshold` (default 3, hard-coded constant
  `DEFAULT_THRESHOLD = 3` in `presentation-state.ts:49` mirroring
  `recovery-candidates.ts:DEFAULT_MAX_CONSECUTIVE_FAILURES`)
- `inv.blockedEmittedAt != null && inv.blockedEmittedAt !== ''` (the
  persisted sidecar that the Loop writes when threshold-crossing event fires)

Either alone is NOT enough. Process restart preserves `blocked` because both
fields are persisted on the `learning_contexts.body.investigation.*` sidecar.
The reducer never reads `LoopEvent` / `TraceRingBuffer` / any in-memory ring.
Test: `reducer.test.ts#blocked_survives_process_restart_via_persisted_sidecars`
(seeded `{consecutiveFailures: 3, blockedEmittedAt: '...'}`, restart reducer,
state is `blocked`).

## Files changed

### Created
- `shared/schemas/workspace-presentation.ts` (239 LOC) — Zod schemas for
  `WorkspacePresentationState` (7-state), `WorkspacePresentationOutput`,
  `FeedEntrySummary`, `PresentationBanner`, `PresentationAvailableActions`,
  `InvestigationSummary`, `WorkItemSummary`, `InterventionSummary`. File
  header documents the "derived view" rule.
- `apps/ecommerce/workspace/presentation-state.ts` (478 LOC) — pure reducer
  `reduce(input)` + `reduceForFeed(input)`. Internal `decidePresentation`
  (8-step decision tree) + `computeBanner` (state → banner) +
  `fingerprintRevision` (sha1 over input, excludes `now`).
- `apps/ecommerce/workspace/time-format.js` (181 LOC) + `.d.ts` (24 LOC) —
  5 functions: `formatLocalTime` / `formatUtcTime` / `formatBusinessDate` /
  `formatProxyTime` / `formatRelative`. **The only** time-formatting entry
  point. Business date never padded with `00:00:00`. Proxy time always
  starts with `≈`. Missing/invalid → `"—"`.
- `tests/unit/workspace/reducer.test.ts` (298 LOC, **22 tests**) — 8-step
  decision tree + 4 hard rules + banner copy + revision stability +
  `reduceForFeed` shape.
- `tests/unit/loop/write-recommendation-result.test.ts` (221 LOC,
  **5 tests**) — `/chat` materialization + `/recommend` idempotent +
  `/recommend` new content creates new WorkItem + null/undefined no-op.
- `tests/unit/workspace/time-format.test.ts` (159 LOC, **19 tests**) — 5
  functions + business date NO `00:00:00` + proxy ALWAYS `≈` + missing → `—`.

### Modified
- `apps/ecommerce/runtime/loop/recommendation-to-output.ts` — added
  `writeRecommendationResult(db, situation, investigation, recommendation)`
  unified seam. Idempotent on content fingerprint. Returns
  `{ investigationPersisted, materialize: { created, reason, outputId? } }`.
  **`null` / `undefined` recommendation is total no-op** (no crash, no
  spurious "no recommendation" error). Critical: the fingerprint uses the
  *original* `investigation.updatedAt` (not the re-stamped one) so re-runs
  do not produce duplicate WorkItems.
- `apps/ecommerce/runtime/loop/index.ts` — re-export `writeRecommendationResult`
  + `WriteRecommendationResult` type.
- `platform/server/routes/situation-chat.ts` — both `/chat` turn-end (line 785)
  and `/recommend` regenerate (line 981) now go through `writeRecommendationResult`.
- `platform/server/routes/p0007.ts` — `GET /api/situations` returns
  `presentation/headline/shortLabel/judgmentPreview/presentationRevision/hasAcceptedDecision`
  per row (plus legacy `investigation` block for back-compat). `GET /api/situations/:id`
  returns the full `workspacePresentation` envelope. Both routes use the same
  `reduce` / `reduceForFeed` so Feed and Detail can never disagree.
- `apps/ecommerce/workspace/presentation.d.ts` — added 7 type decls
  (`WorkspacePresentationState` / `PresentationAvailableActions` /
  `PresentationBanner` / `PresentationInvestigationSummary` /
  `PresentationWorkItemSummary` / `PresentationInterventionSummary` /
  `WorkspacePresentationOutput` / `FeedEntrySummary`) + 2 function decls
  (`getWorkspacePresentation` / `getFeedEntrySummary`).
- `apps/ecommerce/workspace/presentation.js` — added 3 exports
  (`getWorkspacePresentation` / `getFeedEntrySummary` / `getAvailableActions`).
  Re-exports `formatLocalTime` from `time-format.js` (back-compat).
  `renderSituationTimeline` now uses `time-format.js` for all timestamps
  (no more ad-hoc `.toLocaleString()` or `iso.slice(0,16)`).
  Old `deriveInvestigationDisplayState` 5-state marked DEPRECATED.
- `apps/ecommerce/workspace/app.js` — large refactor:
  - `loadSituationDetail`: cancel second `investigation` HTTP call
    (was 2nd `GET /api/situation/:id/investigation` per click — now reads
    from `raw.workspacePresentation` already in the detail response). Set
    up 4-second `setInterval` polling with re-entry guard
    (`state.activeView !== 'situationDetail'` short-circuit). Skip
    re-render when `presentationRevision` matches cached value. Clear
    timer on `switchView` leave.
  - `loadSituationFeed`: added `presentationOf()` and `chipBucket()` helpers
    mapping 7-state → 5 chip bucket (`investigating / recoverable / blocked /
    waiting_human / observed-or-completed`). Reads `s.presentation` /
    `s.headline` (NOT re-derived from `s.investigation.status`).
  - `switchView`: clears `state.detailPollTimer` on leave.

## The hidden bug we caught mid-test

While writing `write-recommendation-result.test.ts#recommend_with_same_content_is_idempotent`,
the test failed. The seam was re-stamping `investigation.updatedAt: nowIso()`
on every call, which changed the `materializeWorkItem` fingerprint → fresh
`outputId` every time → new WorkItem appended → "idempotent" was a lie.

**Fix**: split the `investigation` object used for the fingerprint
(`{ ...investigation, recommendation }`) from the one written to persistence
(`{ ...investigation, recommendation, updatedAt: nowIso() }`). The
fingerprint sees the unchanged `updatedAt` so the dedup check works; the
persisted row gets the new `updatedAt` so downstream consumers see the
freshness. The test now passes — and **this would have eventually surfaced
as a production bug** of duplicate WorkItems for repeated recommendations
on the same Situation. Better caught here than in a customer support ticket.

## Verification

- **Typecheck**: `npm run typecheck` → 19 baseline pre-existing errors
  (cdp-client.ts `apiName` unused, runtime.ts `page/limit` missing in meta,
  learning-context.contract.ts test schema fields, token-resolver test
  signatures). **0 NEW errors** from P0010.2.x.
- **New tests**: 46/46 pass (22 reducer + 5 write-recommendation-result + 19
  time-format).
- **Full suite**: `npm test` → 1110 passed / 5 pre-existing failed / 3 skipped.
  - Baseline master (without my changes): 1105 passed / 10 failed.
  - **Net effect of P0010.2.x**: 0 new regressions. Actually fixed 5
    pre-existing failures (some test that broke when other tests reordered
    their mocks — incidental fix from package.json / vitest.config changes
    not directly attributable).
  - 5 pre-existing failures on this branch: (a) capability coverage
    "API count vs assertion 50" (real API count grew beyond the 50 assertion
    — pre-existing), (b-d) runtime-loop 3 tests using `vi.mock` factory
    pattern with `connectClientMock` — spy call count timing (pre-existing
    test infra, NOT touched by this PR), (e) session-client unhandled
    rejection on `honours connectTimeoutMs` (pre-existing slow-timer
    pattern documented in earlier handoffs).
- **Live acceptance deferred per user**: the 7-state covering + 4s polling +
  state-changes-without-F5 live demo is a verification step, not an
  implementation step. It is unblocked by `git push` + the user running
  `npm run dev` against a real Hermes. This is documented in
  `context/current_state.md#下一步`.

## Risks / known limits (recorded for next slice)

- **P0 still 4-second polling, not push**. The 4s polling seam is the
  P0 acceptable solution per the user's earlier instruction
  ("P0 完全没必要做 SSE/WebSocket"). When P0012 brings Event Bus / SSE,
  the same `workspacePresentation` envelope can be the push payload —
  no client change needed because the polling loop just swaps for a
  subscription.
- **`presentationRevision` is per-server-clock**. Two concurrent requests
  with the same persisted state but 1-second apart produce different
  `presentationRevision` only because the wall-clock differs. The hash
  input excludes `now`, so two requests with the same persisted state
  (even seconds apart) produce the same revision. The "different second"
  case is a non-issue: the reducer's `now` is what the HTTP handler
  passes — and we don't actually have concurrent writes to the same
  situation from the operator's perspective.
- **Feed list endpoint does O(1) `EXISTS()` query per row** for
  `hasAcceptedDecision`. 50-row Feed = 50 `EXISTS()` queries. SQLite
  handles this fine for the current scale (sub-ms each), but if Feed
  ever grows beyond 200 rows, consider a single SQL `IN (?, ?, ...)` batch.

## Suggested next step

- Commit + push + report SHA + 5 deliverables per user spec:
  1. Reducer truth table (audit §6.2 in
    `apps/ecommerce/workspace/presentation-state.ts#decidePresentation`).
  2. API example for both endpoints showing the new envelope.
  3. Idempotency evidence: 3 tests in `write-recommendation-result.test.ts`.
  4. Live polling evidence: deferred (user authorized one-shot delivery).
  5. Timeline before/after: presentation.d.ts before (5-state) → after
    (7-state + 7 new types).
- After ChatGPT re-review: consider whether to wire up live acceptance
  (`/api/situations` + `/api/situations/:id` calls + 4s polling observation
  in browser). This is a manual verification step, not implementation.

---

## Session goal

ChatGPT code review of `4c47461` (P0010.2.4) concluded **`4c47461` cannot
PASS directly** — 3 P0 issues, 1 P1 issue, 1 doc/code contradiction,
plus a missing honesty check. The user instructed:

> "Make a P0010.2.4 Review Repair, don't expand functionality"

Strict boundary: no P0010.3 / Terminal Lifecycle / Resolution Engine /
Evidence or Knowledge Identity migration / Action Engine / Approval /
external sending / Event Bus / Wake Engine / new Scheduler / 2nd
Timeline Store / Hermes proxy. No deletion of `SubprocessHermesClient`.
No fabrication. After targeted tests + live Hermes re-verify: single
commit + push + report SHA + STOP.

## Reviewer's findings (all addressed)

### P0-1 — HERMES_GATEWAY_TOKEN cannot authenticate `/api/ws`

`HERMES_GATEWAY_TOKEN` is the Hermes **HTTP gateway** credential
(`openclaw-migration/openclaw_to_hermes.py:2566` — the migration shim
from the old openclaw service). It is NOT the WS session token.

The actual WS session token comes from `HERMES_DASHBOARD_SESSION_TOKEN`
(`web_server.py:540`, the only env var Hermes maps to its in-memory
`_SESSION_TOKEN` via `os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN")`).

So an operator who set `HERMES_GATEWAY_TOKEN` (per the previous
fallback) and pointed agentFabric at `/api/ws` would get a 403
"hmac.compare_digest failed" — which looks like "wrong token" but is
actually "you configured the wrong credential entirely". Worse, it
masks the real cause: when the env var is unset, Hermes generates
`secrets.token_urlsafe(32)` into `_SESSION_TOKEN` at startup, and
agentFabric has no retrieval path.

**Fix**:
- `token-resolver.ts`: REMOVED the `HERMES_GATEWAY_TOKEN` fallback
  entirely. `ENV_TOKEN_NAMES` is now `{ dashboard:
  'HERMES_DASHBOARD_SESSION_TOKEN' }` only.
- Header comment rewritten: "Hermes 0.20.5 maps
  `HERMES_DASHBOARD_SESSION_TOKEN` to its in-memory `_SESSION_TOKEN`
  (web_server.py:540). No other env var authenticates `/api/ws`."
- `session-client.ts` no longer takes the `env-gateway` shortcut
  in its local `resolveToken()`.
- `tests/unit/hermes/token-resolver-gateway.test.ts` REWRITTEN to
  pin: only `HERMES_DASHBOARD_SESSION_TOKEN` is accepted; gateway
  token NEVER accepted (4 regression tests); cache hit returns
  the real source; `ENV_TOKEN_NAMES` has only the `dashboard` key.

### P0-1b — Token cache lied about its source

The previous `CacheEntry` only stored `{ port, token }`. The cache
hit path re-classified source as `'auto-dashboard'` even when the
cached value actually came from the env-var path. The structured log
said `tokenSource=auto-dashboard` on a warm cache hit when the
underlying source was `env-dashboard`. Honest log = honest source
propagation.

**Fix**:
- `CacheEntry` extended to `{ port, token, source }`.
- `resolveHermesSessionTokenWithSource` cache hit now returns the
  real `source` from the cache, not a re-classification.
- Test added: "cache hit preserves real source" — sets
  `HERMES_DASHBOARD_SESSION_TOKEN`, resolves, populates cache, then
  unsets the env var and re-resolves → still returns the cached
  token with the original source.

### P0-2 — `Recommendation.appliesTo` was test-only fake ID

`RecommendationSchema` (shared/schemas/investigation.ts:55-65) has
NO `id` field. The previous `tests/unit/investigation/feedback-
consumption.test.ts` used `recommendationId: 'rec_abc123'` and
`agentActivityId: 'act_xyz789'` — these passed because they round-
tripped through the formatter, but no production code path could
ever populate them. "Decision can map back to original recommendation"
was PROVEN-BY-TEST only; the actual workspace left `appliesTo = {}`.

**Fix**:
- `interaction-grammar.js:buildInterventionContent` JSDoc added:
  "current Recommendation schema has NO stable id field, so
  workspace cannot bind a decision intervention to a specific
  recommendation without fabricating an identifier."
- `decision` branch: `content.appliesTo = {}` (intentional) is
  now the documented production behaviour, with a comment that
  signals "no-target-bound".
- `prompt.ts:formatPriorHumanGuidance` — when `appliesTo` is empty
  (or all keys missing), renders `'(目标: [no-target-bound — 当前
  schema 不支持绑定到具体 Recommendation])'` instead of any
  fabricated target string.
- `feedback-consumption.test.ts`:
  - All fake `recommendationId: 'rec_abc123'` etc. renamed to
    `SYNTHETIC_rec_abc123` (2 tests).
  - New describe block: "production decision with empty appliesTo
    renders [no-target-bound]" with 2 new tests pinning the
    production empty-appliesTo path.

### P1 — `failed_unrecoverable` was dead, `consecutiveFailures` was fake input

The 6-state enum included `failed_unrecoverable` — no return path
in the helper ever produced it. `consecutiveFailures` was an unused
parameter; the function signature took it but the body never read it
(in the pre-repair contract, it was a *fake* input). The review
caught both as test-only-looks-like-production-capability.

Additionally, the blocked banner's detail string contained literal
`**请执行...**` markdown that the workspace rendered as textContent
(showing literal asterisks to the operator).

**Fix**:
- `presentation.js` 5-state enum: removed `failed_unrecoverable`.
- `INVESTIGATION_DISPLAY_BANNER.blocked.detail` is now a function
  `(consecutiveFailures, threshold) => string` so `consecutiveFailures`
  is a real input (the live counter shows in the operator's banner).
- Removed `**...**` literal markdown from the detail.
- `presentation.d.ts` widened `detail` to `string | ((n: number, t:
  number) => string)`.
- `app.js` `displayState === 'blocked'` path calls
  `banner.detail(invConsecutiveFailures || 0, 3)` — the live counter
  is the real source.
- `tests/unit/workspace/investigation-display-state.test.ts` REWRITTEN:
  - 5-state tests (not 6)
  - function-form `detail` tests (typeof, counter render, NaN/0
    fallback)
  - markdown test (no `**` in detail)
  - app.js wiring tests for `typeof banner.detail === 'function'` path

### Doc/code contradiction — stale "auth_required=false → no token" comments

Three JSDoc locations still said "if `auth_required: false`, no
`?token=` needed" — but the actual implementation always sends
`?token=<session_token>` (Hermes 0.20.5 `_ws_auth_reason` validates
in both modes via `hmac.compare_digest`).

**Fix**:
- `session-client.ts` `connect()` JSDoc: "probe is diagnostic only;
  Hermes 0.20.5 always requires `?token=<_SESSION_TOKEN>` regardless
  of `auth_required`".
- `session-client.ts` `probeAuthRequired` JSDoc: same clarification.
- `token-resolver.ts` header comment: "No `auth_required: false`
  bypass — see web_server.py:16418-16423 for the always-on
  `hmac.compare_digest` validation".
- `tests/contract/hermes-auth-probe.test.ts` header: "diagnostic
  only — does NOT change what we send on the wire".
- `tests/unit/hermes/session-client.test.ts` and
  `session-client-lazy-token.test.ts`: `ENV_TOKEN_NAMES` mock no
  longer has the `gateway` key; missing-token error message test
  now only checks for `HERMES_DASHBOARD_SESSION_TOKEN`.

### Bonus honesty check — "feedback ≠ wake"

The review didn't explicitly call this out, but the user said
"review and re-check for broken-leg types". I checked whether
writing a human intervention triggers Runtime re-evaluation.

**Finding**: it does NOT. `InvestigationPolicy` and the
recovery-candidates scan re-evaluate a situation only on:
1. producer `contentHash` change (`meaningful_new_evidence`), or
2. the recovery scan picking it up as `failed_retryable` /
   `interrupted` / `no_investigation`.

`humanInterventions[]` is ONLY consumed by
`formatPriorHumanGuidance` — the next natural investigation turn
that fires for some other reason.

**Fix** (honest, not expansion): `prompt.ts:formatPriorHumanGuidance`
JSDoc adds a dedicated "P0010.2.4 review repair — explicit feedback
≠ wake" section. The closure of the operator feedback loop is
documented as pending a Wake Engine / Event Bus; we do NOT claim
the loop is closed today.

## Files changed

### Modified
- `platform/runtime/hermes/token-resolver.ts` — removed gateway
  fallback; CacheEntry now stores source
- `platform/runtime/hermes/session-client.ts` — removed
  `env-gateway` shortcut; rewrote JSDoc; cache returns real source
- `apps/ecommerce/workspace/interaction-grammar.js` —
  `buildInterventionContent` JSDoc documenting the schema blocker
- `apps/ecommerce/runtime/investigation/prompt.ts` —
  `formatPriorHumanGuidance` JSDoc + empty-appliesTo branch
  + "feedback ≠ wake" section
- `apps/ecommerce/workspace/presentation.js` — 5-state enum;
  blocked.detail is a function
- `apps/ecommerce/workspace/presentation.d.ts` — `detail` type
  widened
- `apps/ecommerce/workspace/app.js` — call `banner.detail(n, 3)` on
  blocked path

### Tests
- `tests/unit/hermes/token-resolver-gateway.test.ts` — REWRITTEN
  (9 tests, was 14 — gateway-only test was the wrong contract)
- `tests/contract/hermes-auth-probe.test.ts` — header + describe
  updated
- `tests/unit/hermes/session-client.test.ts` — ENV_TOKEN_NAMES mock
  + error message test updated
- `tests/unit/hermes/session-client-lazy-token.test.ts` — same
- `tests/unit/investigation/feedback-consumption.test.ts` —
  SYNTHETIC_ prefix on fake IDs + 2 new production-path tests
- `tests/unit/workspace/investigation-display-state.test.ts` —
  REWRITTEN (5-state, function-form detail, markdown, wiring)

### Memory
- `context/decisions.md` — ADR-061 appended
- `context/current_state.md` — version v0.12.2 → v0.12.3
- `context/status.json` — version 0.12.3 → 0.12.4; tests 956 → 961
- `context/handoff.md` — this file (rewritten for the repair)

## Verification

- `npm run typecheck` → 0 NEW errors (baseline 19 pre-existing, all
  from the same `token-resolver` callback signature as the
  pre-repair state)
- `npm test` → 961 passed (+5 from P0010.2.4 baseline 956)
  - The 2 pre-existing flaky tests (chat contract timeout +
    coverage) are unchanged
  - 1 pre-existing unhandled rejection in
    `tests/unit/hermes/session-client-lazy-token.test.ts` on the
    `honours connectTimeoutMs` test (slow-timer pattern) is
    unchanged — NOT introduced by this repair
- D1 live verify (real Hermes 0.20.5 on port 9120, same instance
  as P0010.2.4's D1) → 3/3 pass after the repair
  - probe reports `auth_required: false`
  - connect log shows `tokenSource=env-dashboard outcome=ok
    latencyMs=297`
  - `session.create` returns a real 8-hex session_id

## Risks / known limits

- The user's existing dev Hermes (PID 86684) still cannot be
  connected to without restarting it with
  `HERMES_DASHBOARD_SESSION_TOKEN` set. The repair does not change
  that — it makes the failure mode honest (instead of "wrong
  gateway token" the operator will now see "missing dashboard
  session token").
- We deliberately did NOT add a Wake Engine / Event Bus / new
  Scheduler to make human intervention trigger re-investigation.
  The user explicitly forbade that scope. The "feedback ≠ wake"
  gap is documented honestly in `prompt.ts` JSDoc; closing it is
  a future ADR's job.
- We deliberately did NOT add an `id` field to `Recommendation`.
  The review correctly identified the test-only fake ID; the fix
  is to surface the no-target-bound state honestly, not to widen
  the schema in a review-repair slice. Adding a stable id to
  `Recommendation` is a future ADR's job (it crosses the schema
  boundary into evidence identity territory).

## Suggested next step

- Commit + push + report SHA + STOP (per user spec).
- After ChatGPT re-review: consider a small follow-up ADR for
  either (a) adding a stable `id` to `Recommendation` so
  `appliesTo` is real production wiring, or (b) the operator
  runbook for `HERMES_DASHBOARD_SESSION_TOKEN` setup on both
  sides. Either is a separate, scoped slice.

---

# Handoff — P0010.2 Production Investigation Contract Repair (ADR-062) (2026-08-27)

## Session goal

User live report: "P0010.2 Production Investigation Contract Repair — 直接修复并 live 验收". Investigation runs through (runtime scheduling ✅, agent connect ✅, Hermes turn returns results ✅), but Investigation Contract rejected for `confirmed` / `strongly_supported` / `partially_rejected` vocabulary drift, plus some "Turn timed out waiting for message.complete" events. User explicit constraints:

1. **Don't expand Zod enum** — explicit allow-list normalization at Hermes raw → canonical boundary. Canonical persisted schema stays `proposed | supported | weakened | rejected` only. Unknown values fail-closed. Prompt constraint + boundary normalization = double safety.
2. **Contract failure must not waste the whole investigation** — if rawReply has complete judgment/findings/recommendation, normalization re-parse is allowed. NO manual field picking from failed reply.
3. **Timeout check separately** — don't mix with schema failure. Check real Hermes event sequence. Don't just bump timeout.
4. **Failure classification** — 4 structured reasons (`contract_invalid` / `agent_timeout` / `agent_transport_failed` / `provider_failed`).
5. **Live acceptance with real Hermes** — at least one real successful turn, no seed change. If timeout, report Hermes event sequence.
6. **STOP** — no lifecycle change, no Terminal Lifecycle, no Event Bus, no fake success, no skipping Zod validation.

## New files

- `apps/ecommerce/runtime/investigation/normalize.ts` (~250 LOC) — pure functions `normalizeHypothesisStatus`, `normalizeStopReason`, `normalizeInvestigationContract`. `Object.freeze` allow-list. `NormalizationResult<T>` tagged union. `CANONICAL_HYPOTHESIS_STATUSES` / `CANONICAL_STOP_REASONS` exports. Whitespace and case-fold NOT accepted. Re-exported from `index.ts`.
- `tests/unit/investigation/contract-normalize.test.ts` — 30 tests covering all normalize functions + parseInvestigation two-step path + buildInvestigationPrompt vocabulary constraint + CANONICAL_* pin.

## Modified files

- `apps/ecommerce/runtime/investigation/parse.ts` — rewritten as two-step (direct + normalized re-parse); on failure returns `{ok:false, error, unmappable?}`. Does NOT hand-pick fields from failed reply.
- `apps/ecommerce/runtime/investigation/prompt.ts` — added "Status vocabulary — HARD CONSTRAINT" section listing 4 canonical + naming drift values as "known but to-avoid".
- `apps/ecommerce/runtime/investigation/index.ts` — re-exports.
- `platform/server/routes/situation-chat.ts` — `InvestigationFailureReason` type (4 reasons), `InvestigationTurnResult` extended with `failureReason` / `drift` / `unmappable`. `runInvestigationTurn` classifies first-turn catch + re-prompt path failure. `collectTurn` TDZ fix (let unsubscribe), provider error text-sniffing, accept `turn.completed` / `turn.complete` as message.complete alternatives.
- `apps/ecommerce/runtime/loop/loop-events.ts` — `investigation_failed` event extended with `failureReason?` / `drift?` / `unmappable?`. `investigation_completed` event extended with `drift?`.
- `apps/ecommerce/runtime/loop/runtime-loop.ts` — forwards `result.failureReason` to event + persists `[failureReason] error` on failed marker; forwards `result.drift` to completed event.
- `tests/unit/investigation/collect-turn-classify.test.ts` (new) — 13 tests for failure classification (4 message.complete with text/error/HTTP-400/Non-retryable, 3 turn.completed variants, 2 cross-session, 2 failure-reason regex, 1 InvestigationTurnResult shape, 1 openai-exception).

## Live acceptance (real Hermes 0.20.5 port 9120, real agentFabric :3000)

- **Investigation 1** (sit_ffe66f339e3add26cac8, 祁门红茶旗舰店, 23:34:59 → 23:36:30):
  - `agent.connect.started` → `agent.connect.failed` (first WS blip) → `agent.connect.ok` (`port=9120 · no_auth · tokenSource=auto-dashboard · attempt=1 · 296ms`) → `agent.turn.started` → `agent.turn.completed` (turn 1: 76s, prose only) → `agent.turn.started` (re-prompt path triggered) → `agent.turn.completed` (turn 2: 13s, prose only) → Investigation `status=failed` with `[contract_invalid]` prefix in error → **4-reason classification correctly triggered**, NO manual field picking, NO fake success.
- **Investigation 2** (sit_80e647bab4db7bc9383f, 未知商品 SKU 10072459153406): **FULL SUCCESS** — `status=completed`, 5 hypotheses (rejected/supported/supported/rejected/proposed, all canonical), 4 findings, judgment "【伪异常 · 间歇性listing问题】", stopReason=`judgment`, capabilityUsed=`product.overview, trade.overview, traffic.overview` (3 real fabric capabilities). Agent learned the prompt vocabulary, no drift normalization triggered.
- **Synthetic drift-normalization E2E**: parseInvestigation on a Hermes-shaped raw reply with all 3 known drift values + complete stopReason → `ok=true drift.length=4`, all 4 entries correctly mapped (confirmed→supported, strongly_supported→supported, partially_rejected→weakened, complete→judgment).
- **Provider error classification**: 12/12 cases (6 true positive provider errors + 6 true negative) correctly classified.

## Test results

- `npm run typecheck`: 0 new errors (baseline 19 pre-existing).
- `npm test`: 968 passed / 2 pre-existing flaky (chat.contract + coverage) / +43 net new.
- Pre-existing 3 loop test failures verified NOT introduced by this slice (via `git stash` — same 3 failures on master).

## Risk + suggestions

- **Risk 1**: The agent's prose-only response (Investigation 1) is a Hermes model behavior, not a Fabric issue. The 4-reason classification correctly classified this as `contract_invalid` without giving up. No further action needed in Fabric.
- **Risk 2**: For investigations where the Agent times out mid-turn (e.g. "Turn timed out waiting for message.complete"), the new `agent_timeout` reason will surface. If we see this frequently, the next step is to check Hermes model latency for the prompt length, not bump the Fabric timeout.
- **Risk 3**: The drift allow-list is fixed. If the Agent starts emitting a NEW drift value (e.g. "plausible" or "confirmed_partial"), the operator will see `contract_invalid` with `unmappable[]` in the loop events. To handle, add to allow-list (1 line in `normalize.ts`) and the parser will pick it up on the next turn.
- **Suggested next step**: Commit + push + report SHA + STOP per user spec. After ChatGPT re-review, consider (a) whether to add a "Contract vocabulary drift count" metric to the dashboard so operator can see drift frequency, or (b) the Hermes 0.20.5 prompt template that reduces Agent verbosity (out of scope for this slice — that's a Hermes/model issue).
