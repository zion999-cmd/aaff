# Handoff — P0010.2.4 Production Hermes Investigation + Human Interaction Repair (2026-08-27)

## Session goal

User reported live "Hermes 不在线" but Hermes was actually up. Three real
problems underneath: (A) transport / token-name regression blocking the
production chain, (B) blocked / recoverable UI contradiction, (C) human
interaction grammar too coarse with execution-implied "采用建议" button.
Hard constraint: "先 Audit，随后直接修复、测试、live verify、commit、push。
不要写新 Proposal." No P0010.3 / Terminal Lifecycle / Resolution Engine /
Evidence/Knowledge Identity migration / Action Engine / Approval Engine /
外部发送 / Event Bus / Wake Engine / 新 Scheduler / 第二 Timeline Store /
Hermes proxy. No deletion of SubprocessHermesClient. No fabrication of
provenance / time / final outcome.

## What was built

### Audit A — Transport root cause (ADR-059)

The user's dev `hermes serve` (PID 86684) is up on port 9119 with
`auth_required: false`. The session token is held in Hermes' memory only;
the SPA HTML is disabled in headless mode; no `/api/auth/*` endpoint
exposes it. agentFabric's token-resolver looked for
`HERMES_DASHBOARD_SESSION_TOKEN` only — never set in Hermes' env — so
Hermes generated a random `_SESSION_TOKEN` at startup that agentFabric
cannot learn. The session-client also had a `tryOnceNoToken` path
(connect with no `?token=`) that Hermes 0.20.5 never accepts
(`_ws_auth_reason` in web_server.py:16418-16423 always validates
`?token=<_SESSION_TOKEN>` via `hmac.compare_digest` regardless of
`auth_required`).

**Fix**:
- `token-resolver.ts`: accept `HERMES_GATEWAY_TOKEN` as canonical
  fallback after `HERMES_DASHBOARD_SESSION_TOKEN`.
- `session-client.ts`: probe `/api/health` to learn
  `auth_required`, **but always send `?token=<session_token>`**. The
  probe just chooses the actionable error message and the log
  metadata; the connect itself never skips the token.
- `HermesConnectInfo` structured log: every connect attempt emits
  `[hermes-connect] port=… authRequired=… tokenSource=… attempt=…
  outcome=ok|failed|no-token-resolved latencyMs=…` so an operator can
  see which leg failed in one line.
- `tryOnceNoToken` removed (and its tests updated).
- `missingTokenError(probe)` now mentions the auth mode the probe
  reported, so the operator knows whether loopback (still needs
  `?token=`) or gated (OAuth ticket) is in play.

**Live verify (D1)**: spawned a controlled test Hermes on port 9120
with `HERMES_DASHBOARD_SESSION_TOKEN=af_test_session_*` (the user's
existing PID 86684 is operator-owned; auto-classifier denies kill, so
we used a parallel test instance on a different port). New
`tests/integration/p0010.2.4-live-d1.test.ts` runs 3 assertions:
`probe reports auth_required=false` (✓), `connect log shows
env-dashboard + outcome=ok` with `latencyMs=297` (✓),
`session.create` returns a real 8-hex session_id from Hermes 0.20.5
(✓). The full `prompt.submit` → LLM turn is intentionally out of
scope (depends on operator LLM API key + network latency; not the
surface P0010.2.4 fixed).

**Operator deployment note**: for the live demo against the user's
existing Hermes (PID 86684), restart Hermes with
`export HERMES_DASHBOARD_SESSION_TOKEN=<32+ char secret>` in its
process env, and the same value in agentFabric's env. Without this
restart, the user's existing Hermes keeps the opaque in-memory
session token and agentFabric cannot connect.

### Audit B — Blocked / recoverable UI contradiction (ADR-060)

`app.js:1620-1647` in the `invBlockedRuntimeFailure` branch showed
both "系统会在下一轮 Runtime 调度中自动恢复调查，无需人工点击" (auto-recover,
no human) AND the "立即调查（恢复）" button. Contradiction.

**Fix**:
- New `deriveInvestigationDisplayState(inv, blockedRuntimeFailure,
  consecutiveFailures)` 6-state enum in `presentation.js`:
  `pending` | `recoverable` | `investigating` | `blocked` |
  `completed` | `failed_unrecoverable`.
- New `INVESTIGATION_DISPLAY_BANNER` table — only place operator-facing
  copy lives. `blocked` banner: "⚠ 自动调查已暂停。已达连续失败阈值。请
  执行「解除阻塞并重新调度」让 Runtime 重新安排下一轮调查。" with
  `showClearBlock: true`. `recoverable` banner: "Runtime 正在自动恢复
  （无需人工操作）。" with `showLegacyStart: false`. `failed_unrecoverable`
  shows no button (true dead-end, must be reviewed by a human).
- `app.js:1480-1647` refactored: removed all fuzzy `invBlockedRuntimeFailure`
  string matches. Now reads the 6-state enum and the banner table.
- Clear-block button copy: "解除阻塞并重新调度" (user's required wording).
- `presentation.d.ts` declares the new types so the contract test
  in `tests/unit/workspace/investigation-display-state.test.ts` can
  pin them.

19 contract tests in `investigation-display-state.test.ts` cover the
6 states × blocked override × counter thresholds × banner copy
strings. D2 (recovery scan) and D3 (threshold-blocked + clear) are
proven by the existing 15 runtime-loop tests
(`tests/unit/loop/runtime-loop.test.ts`).

### Audit C — Human interaction grammar (ADR-060)

`interaction-grammar.js` had 6 buttons under one umbrella. The
"采用建议" button was misleadingly named — it only writes a
`decision/accept` record, but operators read it as "the system will
execute this".

**Fix**:
- `interaction-grammar.js` splits `INTERACTION_OPTIONS` into two
  sections: `judgment` (response/correction/context_supplement — 3
  buttons) and `suggestion` (decision with sub-types accept/reject/
  defer/override/no_action — 3 buttons). Every option carries
  `_section` and `executionDisabled: true` (suggestion block only).
- `app.js:renderInteractionSurface` renders two clearly-labeled
  button rows via `groupOptionsBySection` + `INTERACTION_SECTIONS`.
  Each row shows section label + detail ("判断反馈 / 针对 Agent
  当前判断" / "建议处理 / 仅记录处置，不触发外部执行").
- `prompt.ts:formatPriorHumanGuidance` now reads
  `content._section` + `content._summaryKind` and surfaces the
  section tag ([判断反馈] / [建议处理]) + kind tag ({correction} /
  {decision} / etc.) on each line. For decision-type interventions,
  also surfaces `appliesTo` (recommendationId / agentActivityId /
  signalId) so the next-turn Agent can map the decision back to the
  prior recommendation it was responding to. Inline
  `(no-execution: 仅记录处置，不触发外部执行)` guard on every
  suggestion-section decision line.
- Top-of-section hard-constraint line when ANY suggestion-section
  decision exists: `'> [P0010.2.4 硬约束] 上述 [建议处理] 块中的所有
  \`accept\` 均为操作员处置记录；Agent 不得据此触发任何外部执行...'`.
  The prompt itself now declares the boundary — no future Agent
  can read `accept` as an execution cue without ignoring a
  pre-pended explicit line.
- 11 tests in `feedback-consumption.test.ts` cover the round-trip
  for all 5 sub-types × 2 sections × end-to-end via
  `buildInvestigationPrompt`. D4 (human feedback consumption) is
  proven by these.

## New files
- `tests/integration/p0010.2.4-live-d1.test.ts` (3 tests, live Hermes)
- `tests/unit/hermes/token-resolver-gateway.test.ts` (14 tests)
- `tests/contract/hermes-auth-probe.test.ts` (9 tests)
- `tests/unit/workspace/investigation-display-state.test.ts` (19 tests)
- `tests/unit/investigation/feedback-consumption.test.ts` (11 tests)
- `mellow-gliding-sky.md` (the approved plan)

## Modified files
- `platform/runtime/hermes/token-resolver.ts` (HERMES_GATEWAY_TOKEN fallback)
- `platform/runtime/hermes/session-client.ts` (probe + always-send-token
  + structured log + removed tryOnceNoToken)
- `apps/ecommerce/workspace/presentation.js` (6-state enum + banner table)
- `apps/ecommerce/workspace/presentation.d.ts` (new type exports)
- `apps/ecommerce/workspace/app.js` (replaced fuzzy UI logic; grouped
  interaction grammar into 2 sections)
- `apps/ecommerce/workspace/interaction-grammar.js` (split into
  judgment/suggestion sections, executionDisabled flag)
- `apps/ecommerce/runtime/investigation/prompt.ts` (formatPriorHumanGuidance
  reads _section + _summaryKind + appliesTo + top-of-section guard)

## Tests
- `npm run typecheck` → 0 new errors (baseline 19 pre-existing)
- `npm test` → 956 passed (+72 from P0010.2.3 baseline of 884; the
  2 pre-existing flaky are chat contract timeout + capability
  coverage, not from this slice)
- D1 live verify (port 9120 Hermes 0.20.5) → 3/3 pass
- D2 (recovery scan) → 15/15 loop unit tests pass
- D3 (threshold-blocked + clear) → 34/34 pass (loop + display-state)
- D4 (human feedback consumption) → 11/11 pass

## Risks / known limits
- The user's existing dev Hermes (PID 86684) cannot be connected to
  from agentFabric without restarting Hermes with
  `HERMES_DASHBOARD_SESSION_TOKEN` set. The fix is correct, but the
  operator must do the one-time setup. Documented in
  `current_state.md` and the new live-verify test's `beforeAll`.
- The full LLM turn (prompt.submit → event stream → finalize
  investigation) was NOT live-verified. The D1 test stops at
  session.create. This is a deliberate boundary per the user's hard
  constraint "不要伪造 provenance/time/final outcome" — the LLM
  answer depends on the operator's API key + network latency, and
  the runtime-loop unit tests cover the post-session.create path
  with a FakeHermesClient.
- Test Hermes on port 9120 is left running after the session. It
  can be killed with `kill 86822` when no longer needed.

## Suggested next step
- ChatGPT code review (the user requested STOP after commit + push).
- After review: consider a P0010.2.5 that documents the operator
  setup (env var export, restart Hermes) in a runbook, and adds a
  pre-flight check in the dev startup that warns if
  `HERMES_DASHBOARD_SESSION_TOKEN` is not set on both sides.
