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
