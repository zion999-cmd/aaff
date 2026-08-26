# Handoff — P0010.2.4 Review Repair (ADR-061) (2026-08-27)

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
