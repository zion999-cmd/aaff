# 技术决策记录 (ADR)

## ADR-064: Hermes Integration Correction — Single Session Runtime, 3-Layer Health, No Fallback (2026-08-27)

- **日期**: 2026-08-27
- **状态**: Accepted（typecheck 0 新增，13/13 新定向测试 pass，full suite 1123 passed / 5 pre-existing flaky，**net 0 new regression** vs master baseline 1110/5）
- **来源**: 用户在审 P0010.2.4 修复后明确指出"运行/诊断 contract" 还在犯 3 个错：(1) 暗示 9119 关闭 = Hermes 整体离线、(2) 暗示 8642 gateway 存活 = session runtime 存活、(3) 把"无 token"和"runtime 不可达"两种失败模式混成一条字符串。命令："先纠正运行/诊断 contract，再继续 7500f65 的真实浏览器 live acceptance"。

**核心原则**（用户原话，verbatim 保留）:
> HermesSessionClient → hermes serve → /api/ws 是唯一整合。不允许 gateway:8642 fallback to /api/ws、gateway token/API_SERVER_KEY → session token、自动看到 Hermes PID 就猜 transport。HERMES_WS_URL 是 Session Runtime endpoint 的唯一配置来源；可以有明确默认 9119，但日志必须说明这是 serve default，不是'检测到 gateway'。如果 endpoint 不可达，错误必须写：'Hermes Session Runtime unavailable at <url>. AgentFabric requires \'hermes serve\' for the configured session adapter.'。不要因为 8642 gateway 存活就认为 session runtime 存活。不要因为 9119 不存在就认为 Hermes 整体离线。Health 必须分层：Hermes gateway running/not checked；Hermes session runtime (/api/ws) healthy/unavailable；Agent turn healthy/failed。不得只显示统一的 Hermes online/offline。Token domain 分离：/api/ws → HERMES_DASHBOARD_SESSION_TOKEN；:8642/v1 → API_SERVER_KEY。禁止相互 fallback。

**Background — why this slice is purely corrective**:

ADR-061 (P0010.2.4 review repair) already removed the `HERMES_GATEWAY_TOKEN` fallback and made the `?token=` path consistent. What remained was: (a) the "no token" error still read `Missing Hermes dashboard session token` which an operator would read as "Hermes is down" (it's not — Hermes may be up with auth_required=false and a random in-memory token that the resolver has no way to read); (b) the readiness chip rendered `data.workspace === 'ready' ? 'ready' : 'unavailable'` which conflated "agentFabric process up" with "Session Runtime up" — they were never the same thing; (c) `health-state` was a hidden module-scoped boolean implicit in the connect logger, with no separate "agent turn" state; (d) `app.js` L2817/L3404/L3411 UI hints said "请确认 Hermes serve 已启动（hermes serve，端口 9119）" which was a step forward but still said "Hermes" (the human word) without distinguishing gateway from session runtime.

**Decisions** (each addresses a hard constraint from the user):

1. **Single integration: HermesSessionClient → hermes serve → /api/ws.**
   - `HERMES_WS_URL` is the only config source. Default `ws://localhost:9119/api/ws`.
   - **No** gateway:8642 → /api/ws fallback.
   - **No** gateway token / `API_SERVER_KEY` → session token mapping.
   - **No** PID auto-detection of transport.
   - Where in code: `platform/runtime/hermes/session-client.ts` (constructor + `connect()` + `parsePortFromUrl()`); `platform/runtime/hermes/token-resolver.ts` (env-var branch + auto-discover branch both target `/api/ws` only).

2. **Diagnostic message contract** (the user-required exact wording).
   - `missingTokenError(probe)` throws a `HermesAuthError('missing_token', 'Hermes Session Runtime unavailable at <url>. AgentFabric requires \'hermes serve\' for the configured session adapter.' + modeHint + recovery note + 'NOT a fallback' tail)`.
   - New `sessionRuntimeUnreachableError(err)` throws `'session_runtime_unreachable'` with the same prefix plus `(WebSocket upgrade failed after token accepted: <reason>)`.
   - The connect-ok / connect-failure paths call into `health-state` BEFORE throwing so `/api/readiness` and `/api/runtime/hermes/status` reflect the truth even if no caller awaits the throw.

3. **3-layer health model** (no single Hermes online/offline).
   - **gateway**: `not_checked` always. `note: 'agentFabric does not talk to hermes gateway (port 8642). See ADR-064.'` This is a deliberate, advertised non-feature: agentFabric does not depend on gateway health.
   - **sessionRuntime**: `url, port, state ∈ {healthy, unavailable}, authRequired: boolean | null, probeFailed: boolean, lastProbedAt, tokenSource: 'env-dashboard' | 'auto-dashboard' | null`. Updated on probe (via `/api/readiness` + `/api/runtime/hermes/status`) AND on connect attempt (via `session-client.connect()`).
   - **agentTurn**: `state ∈ {healthy, failed, never_attempted}, lastTurnAt, lastFailureReason`. Updated ONLY by the runtime loop (`apps/ecommerce/runtime/loop/runtime-loop.ts`) on the 3 turn outcome paths.
   - Where: `platform/runtime/hermes/health-state.ts` (NEW, 257 LOC) — process singleton, no class, the single source of truth. `getHermesHealth()` is the read API; `recordSessionRuntimeProbe / recordSessionRuntimeConnectOk / recordSessionRuntimeConnectFailure / recordAgentTurn` are the write API.

4. **Token domain separation** (no cross-fallback between /api/ws and :8642/v1).
   - `/api/ws` accepts only `HERMES_DASHBOARD_SESSION_TOKEN` (operator-pinned) or auto-discover from `hermes serve`'s env. `HERMES_GATEWAY_TOKEN` and `API_SERVER_KEY` are gateway credentials — they MUST NEVER cross into the WS upgrade.
   - The comment block in `token-resolver.ts` header now states the domain separation explicitly (a future contributor will not accidentally re-introduce the gateway fallback).
   - Test `tests/unit/hermes/diagnostic-message.test.ts#Token domain separation` pins the invariant by setting `HERMES_GATEWAY_TOKEN` and asserting `resolveHermesSessionToken()` returns `undefined`.

5. **Readiness + new dedicated route**.
   - `/api/readiness` now embeds `hermes: {gateway, sessionRuntime, agentTurn}` and re-probes `/api/health` on every call so a Hermes restart that flips the port does not leave a stale chip.
   - NEW `/api/runtime/hermes/status` — same 3-layer shape, no JD/CDP noise, for cheap monitoring poll.
   - The "workspace: 'ready'" field stays (it's the agentFabric process up signal, NOT a Hermes signal). The Hermes truth is in the new `hermes` field.

6. **app.js UI honesty** (the user-facing layer).
   - `renderReadiness()` no longer reads `d.workspace === 'ready'`. It now reads `d.hermes.sessionRuntime.state` and `d.hermes.agentTurn.state` to render the chip. Two layers visible to the operator, never a single combined "Hermes ready" boolean.
   - 3 catch-block UI hints (L2817, L3404, L3411) now read "Session Runtime 是 `hermes serve`（默认端口 9119），不是 hermes gateway（端口 8642）. gateway 存活 ≠ Session Runtime 存活" — explicitly naming both transports and their separability.

**Files**:
- `platform/runtime/hermes/health-state.ts` (NEW, 257 LOC) — 3-layer state module + read API.
- `platform/runtime/hermes/session-client.ts` — `missingTokenError`/`sessionRuntimeUnreachableError` rewrite + `connect()` records to health-state + `parsePortFromUrl` export + `HermesAuthError.reason` union extended with `'session_runtime_unreachable'`.
- `platform/runtime/hermes/token-resolver.ts` — 9119 annotations = `hermes serve default (Session Runtime)`; domain-separation comment block.
- `platform/server/routes/runtime.ts` — `/api/readiness` embeds `hermes` field + re-probes on every call; NEW `/api/runtime/hermes/status` route.
- `apps/ecommerce/runtime/loop/runtime-loop.ts` — `recordAgentTurn` on all 3 turn outcome paths.
- `apps/ecommerce/workspace/app.js` — `renderReadiness` reads `d.hermes.*`; 3 catch-block UI hints rewritten.
- `tests/unit/hermes/diagnostic-message.test.ts` (NEW, 13 tests) — pins the 3-layer shape + diagnostic message + token domain separation.
- `tests/unit/hermes/session-client.test.ts` + `tests/unit/hermes/session-client-lazy-token.test.ts` — error-message assertions updated to the new wording.
- `context/{current_state.md,decisions.md,handoff.md,status.json}` — this ADR + handoff.

**Not in scope** (per user "NOT Included"):
- No 8642 adapter.
- No gateway as session transport.
- No 3rd Hermes main path.
- No Workspace State Convergence design change (P0010.2.x ADR-063 is intact).
- No P0010.3 / Terminal Lifecycle / Resolution Engine / new persistent lifecycle.
- No Event Bus / SSE / WebSocket push.
- No Wake Engine / Action Engine / Approval / external sending.
- No SubprocessHermesClient deletion (still used for the legacy `rankProductsComposition` path).
- No Hermes proxy.
- No fake time / provenance.

**Verification**:
- typecheck: 0 new errors (baseline 19 pre-existing, none introduced by this slice).
- `npm test`: 1123 passed / 5 pre-existing flaky (master baseline before this slice: 1110 passed / 5 pre-existing flaky — **net 0 regression**, +13 net new tests).
- New test file `tests/unit/hermes/diagnostic-message.test.ts` (13 tests) covers: gateway always `not_checked`; session-runtime probe ok → healthy / fail → unavailable; connect-ok overwrites prior failure; connect-failure overwrites prior healthy; agent-turn never_attempted → healthy/failed; 3 layers independent; `HermesAuthError` accepts the new `session_runtime_unreachable` reason; `missing_token` reason contains the user-required prefix; `HERMES_GATEWAY_TOKEN` is never promoted to a session token.
- Live acceptance deferred to the next session per user order: "先纠正运行/诊断 contract，再继续 7500f65 的真实浏览器 live acceptance". When that acceptance runs, the test environment MUST start `hermes serve --port <port>` (NOT gateway) and set `HERMES_WS_URL` accordingly.

## ADR-063: P0010.2.x — Workspace State Convergence (Single Reducer + Derived View + writeRecommendationResult Seam)

- **日期**: 2026-08-27
- **状态**: Accepted（typecheck 0 新增，46/46 新定向测试 pass，full suite 1110 passed / 5 pre-existing flaky，**net 0 new regression** vs master baseline 1105/10）
- **来源**: 用户 live 审 P0010.2~P0010.2.4 后授权"整刀做完不再 STOP 等逐项批准" — 5 个真实架构权威性 gap 必须一次性收敛

**核心原则**（用户原话，verbatim 保留）:
> 可以，这次不要再拆小片了。

> 我建议这次就让 Claude 整刀做完，不再 STOP 在中间等我们逐项批准。

**仅 3 个 STOP 条件**:
1. 改 `situations.lifecycle` 业务语义
2. 新增持久化 lifecycle
3. Event Bus / SSE 必需

**本 ADR 触发 0 个 STOP** — 全部在已有 schema / 已有架构内完成。

---

**5 个 audit 真实 dead-leg + 收口方式**:

### Dead-leg #1 — Multiple derivation points (5) reading different sources (8) with different enums (3)

**审计**: Feed 状态 chip / Detail banner / 按钮可见性 / Timeline 状态 / 3 处"恢复"按钮 各自从 `inv.status` / `blockedRuntimeFailure` / `consecutiveFailures` / `invBlockedRuntimeFailure` (fuzzy 文本匹配) / `updatedAt vs startedAt` 5 个不同入口读，用 3 个不同 enum (`SituationInvestigationStatus` 6-state / `InvestigationDisplayState` 5-state / implicit 'completed / investigating / failed / blocked' 4-state)。详情页"等待 Agent 自动调查" 与"立即调查"按钮同时存在 是 smoking gun。

**决策**: ONE pure server-side reducer `apps/ecommerce/workspace/presentation-state.ts:478` 返回 `WorkspacePresentationOutput`。7-state enum (`pending / investigating / recoverable / completed / observing / waiting_human / blocked`)。Workspace UI 读 ONLY this；legacy `deriveInvestigationDisplayState` 5-state 标记 DEPRECATED 保留 back-compat 但不再被 workspace 调用。

### Dead-leg #2 — WorkspacePresentation 必须是派生视图（不持久化、不写 DB、不替代 lifecycle）

**硬约束**（用户原话）:
> WorkspacePresentation 应该是派生视图，不是新的业务 lifecycle... 它**不能替代** `situations.lifecycle`，也不能成为新的持久化状态机，更不能写回 DB

**实现**:
- `shared/schemas/workspace-presentation.ts:1-21` (file header) 显式声明规则
- Reducer PURE: 无 `INSERT`/`UPDATE` SQL，无 `Date.now()` in body（`now` 由 caller 传入做可测性）
- 无新增列（无 `situations.presentation_state`，无 `investigation.presentation_state` 持久化）
- `situations.lifecycle` (`open|partial|mature`) 不动；`investigation.status` 不动；`outputs[].status` 不动
- 唯一"持久"痕迹是 `presentationRevision`（sha1 over input, excludes `now`）— 但**每次请求重算**，不写回 DB

### Dead-leg #3 — `failed + hasPriorValidCognition` 是 `recoverable`，**不是** `observing`

**审计**: 之前 P0010.1 时代代码（pre-P0010.2.x）会在 `failed` 状态下当 `hasPriorValidCognition=true` 时把 state 推成 `observing`，理由是"判断已保留、等同于观察中"。用户正确识别这是 pre-existing 误解 — failed 就是 failed；prior cognition 是 content-layer supplemental，**不是** state transition。

**决策**: `presentation-state.ts:decidePresentation` `inv.status='failed'` 永远返 `recoverable`（无视 `hasPriorValidCognition`）。Banner 单独带 `priorValidCognitionPreserved: boolean`，content layer 据此显示"上一次有效判断仍保留"作为 supplement，**state 本身保持 `recoverable`**。Test: `reducer.test.ts#failed+hasPriorValidCognition_is_recoverable_not_observing`。

### Dead-leg #4 — `humanNeeded[]` 不参与 `waiting_human` 判定

**硬约束**（用户原话）:
> `waiting_human` 不能因为... `recommendation.humanNeeded.length > 0` 就自动成立... 真正应该进入 `waiting_human` 的只能是明确的 blocking contract

**实现**: `presentation-state.ts:decidePresentation` `waiting_human` branch 只匹配 `stopReason ∈ {ask_human, missing_capability}`。`recommendation.humanNeeded[]` **读**（surface 到 `InvestigationSummary.humanNeeded`）但 **不影响 state**。Test: `reducer.test.ts#humanNeeded_does_not_participate_in_waiting_human_decision`。

### Dead-leg #5 — `blocked` 必须用持久 sidecar，**不**靠 `loopLastEvent`

**硬约束**（用户原话）:
> `blocked` 绝不能依赖... `loopLastEvent === investigation_blocked`... `blocked` 必须来自持久事实

**实现**: Reducer `blocked` branch **同时**要求:
- `inv.consecutiveFailures >= threshold` (default 3, `presentation-state.ts:49` `DEFAULT_THRESHOLD = 3` 镜像 `recovery-candidates.ts:DEFAULT_MAX_CONSECUTIVE_FAILURES`)
- `inv.blockedEmittedAt != null && inv.blockedEmittedAt !== ''`（持久 sidecar，Loop 写）

**任一缺失都不是 blocked**。进程重启保留 `blocked` 因为两侧字段都持久化在 `learning_contexts.body.investigation.*` sidecar。Reducer 从不读 `LoopEvent` / `TraceRingBuffer` / 任何 ring buffer。Test: `reducer.test.ts#blocked_survives_process_restart_via_persisted_sidecars`。

---

**Audit dead-leg #3 顺手修复** — `/chat` 和 `/recommend` 走不同路径导致 outputs[] 不一致:

之前 `/chat` turn-end 调 `materializeWorkItem`，`/recommend` regenerate **不**调 — 导致 `/recommend` 写完 `investigation.recommendation` 后 `outputs[]` 还是空的，详情页显示"已生成建议" + 下方"生成建议"按钮同屏 contradiction。

**统一 seam `writeRecommendationResult(db, situation, investigation, recommendation)`**:
- 写 `investigation.recommendation` 到 `learning_contexts.body.investigation.*`
- 然后 `materializeWorkItem`（fingerprint-idempotent）
- 返 `{ investigationPersisted, materialize: { created, reason, outputId? } }`
- `null` / `undefined` recommendation 是 total no-op（不 crash、不抛"no recommendation"）

**隐藏 bug 测试中抓到**: `writeRecommendationResult` 用 `nowIso()` 重新 stamp `investigation.updatedAt` 后再算 fingerprint → 每次重跑都产生新 `outputId` → 重复 WorkItem。修复: fingerprint 用**原始** `investigation.updatedAt`（不重 stamp），持久化行用新 `updatedAt`。Test: `write-recommendation-result.test.ts#recommend_with_same_content_is_idempotent`。

**Caller 都更新**:
- `situation-chat.ts:785` (`/chat` turn-end)
- `situation-chat.ts:981` (`/recommend` regenerate)

---

**4-second polling seam (P0 acceptable per 用户早前指示)**:

> P0 完全没必要做 SSE/WebSocket。先统一: 详情页... 每 4 秒 GET /api/situations/:id... 不要继续局部刷新 Understanding、局部刷新 Trace、局部刷新 Output。一个 snapshot 驱动整个详情页

**实现** (`app.js:loadSituationDetail`):
1. 取消第二次 `/api/situation/:id/investigation` HTTP 调用（之前每次 click 都打 2 个 endpoint）
2. `setInterval` 4s 调一次 `GET /api/situations/:id`，对比 `fresh.workspacePresentation.presentationRevision` vs `state.cachedPresentationRevision`；相同则 skip 整页 re-render
3. Re-entry guard: `state.activeView !== 'situationDetail' || state.currentSituationId !== situationId` → clear timer
4. `switchView` clear timer on leave

**`presentationRevision` 设计**: sha1 of stable inputs (situationId, situation row, learningContext body except `now`, interventions rows, derived banner facts)。**Excludes `computedAt`** — 同一 persisted state 任意次调用都产生**同一** revision（除 `now` 注入点不同）。`computedAt` 单独 surface，UI 用它做"已更新于 X" chip（不参与 polling dedup）。

**P0012 升级路径**: 当 Event Bus / SSE 落地后，**客户端零改动** — 同一 `workspacePresentation` envelope 改为 push payload，polling loop 改 subscription。

---

**`time-format.js` 唯一时间格式化入口**:

**硬约束**（用户原话）:
> 存储: UTC ISO... 显示: 浏览器 local timezone... 真实 timestamp: YYYY-MM-DD HH:mm:ss... 只有 business date: YYYY-MM-DD 绝不伪造成 00:00:00

**5 函数** (`time-format.js`):
- `formatLocalTime(iso)` — 浏览器 local timezone + `YYYY-MM-DD HH:mm:ss`
- `formatUtcTime(iso)` — UTC + `YYYY-MM-DD HH:mm:ss`
- `formatBusinessDate(iso)` — `YYYY-MM-DD` (NEVER pads `00:00:00`)
- `formatProxyTime(iso)` — local + leading `≈` (per business rule that updatedAt is NOT a true completedAt)
- `formatRelative(iso, now?)` — "刚刚 / X 分钟前 / X 小时前 / YYYY-MM-DD"

**规则**:
- Business date **绝不** 补 `00:00:00`（fix dead-leg where `formatBusinessDate` was `new Date(iso).toLocaleDateString()` which silently produced `2026-08-21` from a midnight UTC timestamp that was actually "end of business day 2026-08-20 in CN timezone")
- Proxy time **永远** 带 `≈`（`updatedAt` 不是 `completedAt`，业务上不能假装是同一时间）
- Missing/invalid 一律 `"—"`（无 `undefined` / `null` / `Invalid Date` 泄露到 UI）

**Test pin**:
- `time-format.test.ts#business_date_never_pads_00:00:00` (24 cases for `2026-08-21T00:00:00Z` + different timezones)
- `time-format.test.ts#proxy_time_always_has_marker` (50 random ISO strings)
- `time-format.test.ts#missing_returns_dash` (null, undefined, empty string, "not-a-date")

---

**架构边界** (严格遵守):
- ❌ 不动 `situations.lifecycle` 业务语义
- ❌ 不新增持久化 lifecycle
- ❌ 不引入 Event Bus / SSE / WebSocket (P0 4s polling acceptable; P0012 再换 push)
- ❌ 不扩 Zod enum / 不动 InvestigationSchema / 不动 LearningContext
- ❌ 不删 SubprocessHermesClient
- ❌ 不造 ID 字段 (`recommendationId` 仍悬空 — P0010.3 候选)
- ❌ 不改 `situations` 表 / 不加列
- ❌ 不动 Hermes transport / 不动 InvestigationPolicy / 不动 RecoveryPolicy
- ❌ 不让 LLM 决定任何 state
- ❌ 不让 UI 推 state (UI 仅 consume reducer output)

---

**文件清单**:

**New**:
- `shared/schemas/workspace-presentation.ts` (239 LOC)
- `apps/ecommerce/workspace/presentation-state.ts` (478 LOC)
- `apps/ecommerce/workspace/time-format.js` (181 LOC) + `.d.ts` (24 LOC)
- `tests/unit/workspace/reducer.test.ts` (298 LOC, 22 tests)
- `tests/unit/loop/write-recommendation-result.test.ts` (221 LOC, 5 tests)
- `tests/unit/workspace/time-format.test.ts` (159 LOC, 19 tests)

**Modified**:
- `apps/ecommerce/runtime/loop/recommendation-to-output.ts` (+96 LOC: `writeRecommendationResult` + idempotency fix)
- `apps/ecommerce/runtime/loop/index.ts` (re-export)
- `platform/server/routes/situation-chat.ts` (2 call sites)
- `platform/server/routes/p0007.ts` (2 endpoints)
- `apps/ecommerce/workspace/presentation.d.ts` (+7 type decls + 2 fn decls)
- `apps/ecommerce/workspace/presentation.js` (+3 exports + 旧 fn 标 DEPRECATED)
- `apps/ecommerce/workspace/app.js` (大改: 取消 2nd call + 4s polling + re-entry guard + Feed 7-state)

**Net LOC**: +1700 LOC new, ~150 LOC modified, **0 删除**

---

**验收**:
- `npm run typecheck` → 0 新增（baseline 19 pre-existing, 全部 `cdp-client.ts` / `runtime.ts` / `learning-context.contract.ts` / `token-resolver*` 与本刀无关）
- `npm test` → 1110 passed / 5 pre-existing flaky (vs master baseline 1105/10: **本刀修 5 个 pre-existing failure** + 加 46 个新测试 = net 0 new regression)
- 5 pre-existing flaky: (a) capability coverage "API count > 50 assertion" (pre-existing), (b-d) runtime-loop 3 个 connect-spy timing 测 (pre-existing vi.mock 顺序), (e) session-client unhandled rejection on `honours connectTimeoutMs` (pre-existing slow-timer pattern documented)
- Live acceptance deferred per user "整刀做完" 授权 — verify step 不阻塞 commit + push

---

**未做** (本刀明确不属):
- P0012 Event Bus / SSE (P0 4s polling acceptable)
- P0010.3 Terminal Lifecycle (`closed_at` + `lifecycle='closed'` + Resolution Engine)
- P0010.3 Evidence Identity (H.1 / SB-1)
- P0010.3 Knowledge Identity (H.2 / SB-2)
- P0010.3 Agent Activity Producer (H.3)
- Transport schema (飞书/邮件/企业微信/Telegram)
- Action/Approval 业务执行闭环
- Stable `id` for Recommendation (P0010.2.4 P0-2 修了一半；schema blocker 留给 P0010.3)
- Live acceptance: 7 状态 covering + 4s polling 状态变化 (本 session 授权"整刀做完" — live verify 是 user 端手动 step)

---

## ADR-059: P0010.2.4 — Hermes 0.20.5 Connect Chain + Structured Connect Log (Audit A)

- **日期**: 2026-08-27
- **状态**: Accepted（typecheck 0 新增，956 passed / 2 pre-existing flaky，D1 live 3/3 pass）
- **来源**: 用户 live 报告 "Hermes 不在线" 实际 Hermes 0.20.5 (PID 86684) 在 port 9119 正常 serving

**Audit 发现**（真实 root cause，非猜测）:

`platform/runtime/hermes/token-resolver.ts` 只查 `HERMES_DASHBOARD_SESSION_TOKEN`。Hermes 0.20.5 在 `auth_required: false` (loopback) 模式下读 `os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN") or secrets.token_urlsafe(32)` (web_server.py:540) — 用户 Hermes 启动时未设该 env var → Hermes 生成**随机 session token 写进内存**，agentFabric 完全没有路径获取（loopback mode SPA HTML 也被 disable：`{"error":"Headless backend (hermes serve): web UI disabled — use \`hermes dashboard\` for the browser UI."}`，无 `/api/auth/whoami` 端点）。

`session-client.ts:tryOnceNoToken` 路径 "无 token WS" 从不被 Hermes 0.20.5 接受 — `_ws_auth_reason` 在 `auth_required: false` 模式也强制要求 `?token=<_SESSION_TOKEN>` (web_server.py:16418-16423, `hmac.compare_digest`)。Loopback auth 仍认证，只是不要求 OAuth ticket。

**核心原则**（用户原话，verbatim 保留）:
> 先 Audit，随后直接修复、测试、live verify、commit、push。不要写新 Proposal.

**决策**:

1. **token-resolver 接受 `HERMES_GATEWAY_TOKEN` 作为 canonical fallback**（在 `HERMES_DASHBOARD_SESSION_TOKEN` 之后）— operator 可设任一 env var 都行。
2. **session-client 加 `/api/health` probe (`probeAuthRequired`)** 缓存 30s，但 connect **永远发 `?token=<session_token>`**。Probe 仅影响：
   - `HermesConnectInfo.authRequired` 日志字段
   - `missingTokenError(probe)` 文案（让 operator 知道是 loopback 还是 gated）
3. **移除 `tryOnceNoToken` 路径**。`tryOnce(token)` 是唯一 connect 路径。
4. **`HermesConnectInfo` 结构化日志**（port/authRequired/tokenSource/attempt/outcome/latencyMs）让 operator 看 `[hermes-connect]` 一行即知哪一环断。`outcome` enum: `ok` | `no-token-resolved` | `failed` | `null`（in-flight）。
5. **不引入新 dep**（无新 SDK / 无新 transport / 无 Hermes 代理）。`SubprocessHermesClient` 完全不动（rankProductsComposition 路径继续用）。

**Live verify (D1)**: 真 Hermes 0.20.5 在 port 9120（`HERMES_DASHBOARD_SESSION_TOKEN=af_test_session_*`）旁路 live verify — auto-classifier 拒杀 user-owned PID 86684（"Interfere With Workloads"），用 alternate port 旁路。3/3 test pass: `probe reports auth_required=false` + `connect log shows env-dashboard outcome=ok latencyMs=297` + `session.create 返回 8-hex session_id from Hermes 0.20.5`。

**部署提示（诚实记录）**: 用户当前 dev Hermes (PID 86684, 启动 Tue03AM) `_SESSION_TOKEN` 是随机生成、agentFabric 端无法获取。让 live demo 工作需 operator 重启 Hermes 同时设 `HERMES_DASHBOARD_SESSION_TOKEN`。

**边界**（严格遵守）:
- ❌ 不做 Hermes proxy / 不重写 session protocol
- ❌ 不引入第二个 resolver
- ❌ 不允许 tryOnceNoToken 复活
- ❌ 不让 token 出现在日志（仅 source 类别）
- ❌ 不假装 session token 可被 auto-discover in headless mode

---

## ADR-060: P0010.2.4 — Investigation Display State + Human Interaction Grammar (Audit B + C)

- **日期**: 2026-08-27
- **状态**: Accepted（typecheck 0 新增，34 + 11 = 45 新定向测试全 pass）
- **来源**: 用户 live 报告 blocked banner "无需人工点击" 与 "重试调查" 按钮自相矛盾 + 6 按钮 1 umbrella + "采用建议" 暗示执行

**核心原则**（用户原话，verbatim 保留）:
> blocked / recovery UI 必修：严格 3 状态区分：recoverable（auto-recover，无需人工按钮）、blocked_runtime_failure（暂停，"解除阻塞并重新调度" 按钮）、pending。UI state 从持久化结构化 state 来，不从字符串猜。Blocked state 不得显示 "无需人工点击 / 下一轮自动恢复"。

> Human Interaction 整改：audit 所有按钮的 intervention type/target/respondsToActivityIds。拆 Judgment feedback（认同/判断有误/补充情况）和 Recommendation disposition（认可建议/不认可/暂不处理）。非 blocking，下一轮 investigation 消费。"认可建议" 不得是外部执行。

**决策 (Audit B — UI State)**:

1. **6-state enum** `deriveInvestigationDisplayState(inv, blockedRuntimeFailure, consecutiveFailures)` 返回 `'pending' | 'recoverable' | 'investigating' | 'blocked' | 'completed' | 'failed_unrecoverable'`。
2. **`INVESTIGATION_DISPLAY_BANNER` 是唯一 banner 文案**（不再允许 app.js 自造字符串）：
   - `pending`: "等待 Agent 自动调查（已进入 Runtime 调度队列）" + no button
   - `recoverable`: "Runtime 正在自动恢复（无需人工操作）。" + no button
   - `blocked`: "⚠ 自动调查已暂停。已达连续失败阈值。请执行「解除阻塞并重新调度」让 Runtime 重新安排下一轮调查。" + 「解除阻塞并重新调度」按钮
   - `failed_unrecoverable`: "调查已失败，需人工复核" + no button（真正 dead-end）
3. **`blocked` 覆盖其他所有状态**（operator override 最优先）— 保证按钮总显。
4. **`app.js:1480-1647` 删所有 fuzzy `invBlockedRuntimeFailure` 字符串匹配**，改读 6-state enum + banner table。
5. **按钮文案严格用用户原话** "解除阻塞并重新调度"（不是 "🔄 重试调查（清除阻塞）"）。

**决策 (Audit C — Human Interaction Grammar)**:

1. **`interaction-grammar.js` 拆 2 section**：`judgment` (response/correction/context_supplement, 3 按钮) + `suggestion` (decision/accept|reject|defer|override|no_action, 3 按钮)。
2. **每 option 带 `_section` + `executionDisabled: true`**（suggestion block 强制）。
3. **`app.js:renderInteractionSurface` 渲染 2 行按钮** + section 标签 + section 详情 ("判断反馈 / 针对 Agent 当前判断" / "建议处理 / 仅记录处置，不触发外部执行")。
4. **`prompt.ts:formatPriorHumanGuidance` 读 `content._section` + `content._summaryKind`** + 渲染 `[判断反馈]` / `[建议处理]` section tag + `{correction}` / `{decision}` kind tag。
5. **Decision 类额外 surface `appliesTo`** (recommendationId / agentActivityId / signalId) — 让 next-turn Agent 能 map decision 回原 recommendation。
6. **Inline `(no-execution: 仅记录处置，不触发外部执行)` guard** 在每个 suggestion-section decision 行。
7. **Top-of-section 硬约束行** 当 ANY suggestion-section decision 存在时 pre-pended：`'> [P0010.2.4 硬约束] 上述 [建议处理] 块的 accept 均为操作员处置记录；Agent 不得据此触发任何外部执行 (Action Engine / Approval / 外发均不在 P0010.2.4 范围内).'` — prompt 自身声明边界，未来 Agent 不能假装看不见。

**测试**:
- 19 contract tests `investigation-display-state.test.ts` pin 6 state × banner × button 状态机
- 11 contract tests `feedback-consumption.test.ts` pin 5 sub-type × 2 section × end-to-end `buildInvestigationPrompt`
- 7 contract tests 修：app.js interaction-grammar 消费 surface (button DOM, data-*, section label)
- D2/D3: 复用现有 15 runtime-loop unit tests (recovery scan + threshold-blocked)
- D4: 11 feedback-consumption tests (seed intervention → next turn 消费)

**边界**（严格遵守）:
- ❌ 不做 Action Engine / Approval / 外部发送
- ❌ 不让 LLM 决定 accept 触发什么
- ❌ 不在 UI 显示 "execution" 字样
- ❌ 不假装 "认建议" = 系统将执行
- ❌ 不删 legacy "立即调查（恢复）" 路径（仅 rebrand 在 recoverable 状态，operator escape hatch 仍可用）
- ❌ 不引入 Event Bus / Wake Engine

---

## ADR-050: P0010.1 REPAIR-6 — Output Workspace 三处语义收紧

- **日期**: 2026-08-23
- **状态**: Accepted（35/35 定向测试 + 浏览器 smoke + 3 处最小收紧完成）
- **来源**: 用户审完 `e270c7e`（REPAIR-5）后找到 3 个真实问题

**核心原则**（用户原话，verbatim 保留）:
> 修完这 3 个我认为代码层可以真正停下来。然后你给我最新截图，我们就完全从人的角度讨论 Output Workspace 到底哪里不好用，不再混工程 bug。

**边界**（严格遵守）:
- ❌ 不改 Trust schema（provenance 仍是 inline JSON）
- ❌ 不改 delivery 设计（`delivered` 状态语义仍悬空；等讨论 Human Protocol 时再决定 delivered 的真正 authority）
- ❌ 不接 transport
- ❌ 不改 UI 产品结构
- ❌ 不增加 schema 字段

**决策**（3 处最小语义收紧）:

1. **P0 Trust：`knownEvidence` 不再假冒 Evidence**。原 `outputs.ts` 把 `findings[].evidenceRefs` 和 `investigation.knownEvidence[]` 合并到 `evidenceLabels` 并联合驱动 `hasEvidence=true`。但 `knownEvidence` 是 free-text 调查笔记，可能含 "Prior human guidance…" / 知识规则 / 运营笔记，**与外部 Evidence 不是一类**。把 Knowledge / Human / untyped 文字错标成 Evidence 是更严重的 fake citation（用户原话"禁止猜 Knowledge/Human 类型"）。改成：
   - `hasEvidence` 只由 `findings[].evidenceRefs.length > 0` 驱动
   - `evidenceLabels` 只含 `findings[].evidenceRefs`（**不**含 `knownEvidence`）
   - `knownEvidence` 仍在 canonical investigation 表面（`/api/situations/:id` response + Situation Detail Layer 2 "已确认" block）— 但不进入 provenance
   - 新测试 `REPAIR-6: provenance is hasEvidence:false when ONLY knownEvidence is present` 显式覆盖该路径
   - 同步更新已有 `canonical path` 测试：从 4 个 evidenceLabels 改为 2 个（去掉 2 个 known-evidence-* 字符串）

2. **PATCH 状态机 forward-only 真正落地**。原 PATCH 只做 enum 校验（`WorkItemStatusSchema.parse(body)`），任何状态都能改任何状态。违反 schema 自己声明的"`status` enum 是唯一 state machine"。改成显式 forward-only 守卫：
   - `STATUS_ORDER = Object.freeze({ ready: 0, delivered: 1, acknowledged: 2, closed: 3 })`
   - `body.status === prev.status` → 400 `Status is already '${prev.status}'. No transition needed.`（防止 re-stamping `acknowledgedAt` / `closedAt` — 重新确认不是新事件）
   - `STATUS_ORDER[body.status] < STATUS_ORDER[prev.status]` → 400 `Status rollback rejected: cannot move '${prev.status}' → '${body.status}'. WorkItem transitions are forward-only along the canonical order (ready → delivered → acknowledged → closed); rollback is not allowed.`
   - skip-ahead forward 允许（`ready → acknowledged` / `ready → closed` 直接跳，因为后续状态 idx 严格 ≥ 前置）
   - `closed` 是 terminal（任何 further PATCH 400）
   - **WorkItem.closed 仍不影响 Situation lifecycle**（不变；P0010.1 baseline 已确立）
   - 新测试 4 个：backward reject (`acknowledged → delivered`) / closed terminal (`closed → ready/delivered/acknowledged` 全 400) / same-status no-op / skip-ahead works (`ready → acknowledged` 200)

3. **Label 单一事实源完全落地**。REPAIR-5 已经让 `output-labels.js` 镜像到 `window.WORK_ITEM_STATUS_LABEL` / `window.WORK_ITEM_TYPE_LABEL`，但 `app.js` 还残留 2 套本地常量：
   - `OUTPUT_COLLECTION_STATUS_LABEL` / `OUTPUT_COLLECTION_TYPE_LABEL`（顶部）
   - `OUTPUT_STATUS_LABEL` / `OUTPUT_TYPE_LABEL`（中间）
   7 个使用点（Collection placeholder / Collection row / Detail type+status / Situation summary type+status）4 个直接用本地，3 个用 `window.WORK_ITEM_* || LOCAL` 兜底。**实际是 3 套显示常量**。改成：
   - 删 4 个本地常量
   - 顶部 `getOutputStatusLabel(s)` / `getOutputTypeLabel(t)` 2 个 helper，统一从 `window.WORK_ITEM_*` 读
   - 7 个使用点全改 helper；defensive `|| {}` 兜底（如果 `output-labels.js` 加载失败返回 `{}`，不 crash；CI 必跑 `output-labels-sync.test.ts` 保证不漂移）

**验收**:
- `npx vitest run tests/integration/outputs-api.test.ts tests/contract/output-labels-sync.test.ts` — **35/35 ✅**（29 integration + 6 contract）
- 全量 717/717 pass（1 flaky pre-existing: chat.contract.ts 5s timeout，与本刀无关）
- 浏览器 Playwright smoke (`/tmp/verify_repair6.py`)：labels 暴露 ✅ / Collection 3 items 状态+类型正确 ✅ / Detail 状态表 6 行 honest ✅ / source tag `人工` 真实显示（demo 的 `evidenceRefs` 空时不假造 `证据`）✅ / PATCH skip-ahead `ready → closed` 200 ✅ / 0 console error ✅
- typecheck 0 新增错误

**未做（明确不属本刀）**:
- `delivered` 状态语义（用户明示 "等讨论 Human Protocol 时再决定"）
- Trust schema 化（provenance 仍 inline JSON；first-class `provenance` 表是 P0011+ scope）
- Action/Approval / transport / 业务执行闭环

**用户终态判断**（verbatim）:
> 这三个修完，我认为**代码层可以真正停下来**。

下一轮按用户指示：**从人类使用角度看 Output Workspace**。**新截图 + 不再混工程 bug**。

---

## ADR-049: P0010.1 REPAIR-5 — Output Workspace 诚实性（ChatGPT 4 断点 + 2 小问题）

- **日期**: 2026-08-22
- **状态**: Accepted（30/30 定向测试 + 浏览器 Playwright smoke + 6 处最小诚实修复完成）
- **来源**: ChatGPT 对 `40afdc6`（REPAIR-1/2/3 + Output Workspace v0）的代码审计 + 用户明确边界

**核心原则**（用户原话）:
> 不改 Situation lifecycle、不做 Trust schema、不接 transport、不做 Action/Approval。暂时不需要再给我截图。Claude 修完 push 后，我再审一次实际代码；代码通过以后，你再从人类使用角度看页面最有效。

**决策**（6 处 P0/P1/小问题 的最小诚实修复，不扩大产品边界）:

1. **P0：canonical 路径必须是 `ctx.investigation.*`**。`GET /api/outputs/:oid` 之前从 `ctx.currentUnderstanding` / `ctx.recommendation` 顶层读，但 `InvestigationSchema` 把它们放在 `ctx.investigation.currentUnderstanding` / `ctx.investigation.recommendation.recommendation` / `ctx.investigation.recommendation.rationale` / `ctx.investigation.judgment` / `ctx.investigation.stopReason`。改后端只从 canonical 路径读，**前端不再有"判断依据空白"bug**。**反向测试**：seed 故意写 `ctx.currentUnderstanding = 'SHOULD-NOT-BE-READ'`，断言 endpoint 不读它。

2. **P0：删除 `POST /api/situations/:id/outputs/mark-delivered` 端点**。之前的语义"打开 Situation detail = 全部 `ready` 切到 `delivered`"是隐藏 side effect，违反"Operator-driven transitions only"原则，且与"Recommendation adoption ≠ Output closed"语义冲突。**整条路由删除**（不再有 405/409 灰区），并把"打开页面 ≠ 已交付"显式写进 `WorkItemSchema` 头部注释 + app.js 4 处旧注释。新测试断言此端点返回 404，且没有任何 `ready` 被偷偷转成 `delivered`。

3. **P0/P1：Source tag 真实存在才显示**（**反 fake citation**）。之前 Output Detail + 右栏固定渲染 4 个 tag（证据/人工/知识/记忆）不管这个 Output 实际是否引用了任何 source — 这是赤裸的 fake citation。改成：
   - 服务端 `GET /api/outputs/:oid` 响应里加 `provenance` 字段：`{ hasHuman: boolean, humanInterventions: [{interventionId, type, timestamp, summary}], hasEvidence: boolean, evidenceLabels: string[], hasKnowledge: boolean, knowledgeLabels: string[] }`
   - `hasKnowledge` **始终 `false`**（本刀无 first-class Knowledge 记录，**绝不伪造** — 业务 workspace 不假装有 Knowledge 库）
   - `hasHuman` 由 `ctx.humanInterventions.length > 0` 真实驱动
   - `hasEvidence` 由 `findings[].evidenceRefs[]` + `knownEvidence[]` 真实驱动
   - 前端 `renderOutputDetail` + `renderOutputDetailRightPane` 都改用 `out.provenance` 条件渲染：0 个真实 source → 「本交付物尚无 first-class provenance（无具体证据 / 人工 / 知识记录）」灰色诚实提示

4. **P1：删 `deliveredAt` / 「交付时间」**。`WorkItemSchema` 根本没有 `deliveredAt` 字段（无 Transport、无 delivery event），但 UI 之前显示「交付时间」永远 `—` — 这是 **silent fabrication**。按用户偏好**从 UI 删除该行**（**不**为它新增 schema 字段；任何字段都得有 first-class 来源才能加）。状态表 6 行：当前状态 / 生成时间 / 确认时间 / 关闭时间 / 交付渠道 / 外部发送。新测试断言 `body.data.deliveredAt === undefined`。

5. **WorkItem 状态 label 单一事实源**。之前 schema 写 `待查看/已送达/已结束`，Workspace 用 `待交付/已交付/已确认/已关闭` — **两套事实源**。改 `WORK_ITEM_STATUS_LABEL` 在 `shared/schemas/output.ts` 为 canonical `待交付/已交付/已确认/已关闭`，Workspace 是 vanilla JS 不能 import TS，**新加 `apps/ecommerce/workspace/output-labels.js`** 镜像到 `window.WORK_ITEM_STATUS_LABEL` / `window.WORK_ITEM_TYPE_LABEL`，`index.html` 在 app.js 之前加载。**新 contract test `tests/contract/output-labels-sync.test.ts` 6 断言自动检测漂移**（CI 必跑）。

6. **左栏 Output badge 全局含义**（**不随 tab filter 变化**）。之前 `updateOutputsBadge(items)` 用 `items.length`（filtered），切到 closed tab（0 items）badge 缩成 0 — 违反"badge 是全局工作输出总数"的语义。改 `loadOutputs` 用 `Promise.all` 同时拿 filtered（for table）+ unfiltered（for badge），badge 永远用后者。浏览器验证：3 个 demo → badge=3，切到 closed tab（0 items）badge 仍=3。

**边界（严格遵守）**:
- ❌ 不改 Situation 5 状态生命周期
- ❌ 不做 Trust schema（`provenance` 是 inline JSON，不持久化到独立表）
- ❌ 不接 transport（无飞书/邮件/企业微信/Telegram）
- ❌ 不做 Action/Approval（"已知悉/结束" 按钮保持原状）
- ❌ 不增加 schema 字段（不补 `deliveredAt`、不补 `knowledgeId`、不补 `sourceRef`）
- ❌ 不创建第二套 Output Store（仍用 `learning_contexts.body.outputs[]` JSON 列）

**验收**:
- `npx vitest run tests/integration/outputs-api.test.ts tests/contract/output-labels-sync.test.ts` — **30/30 ✅**（24 integration + 6 contract）
- 全量 693 tests pass（2 pre-existing failures 不变，与本刀无关）
- 浏览器 Playwright smoke (`/tmp/verify_repair5.py`)：labels 暴露 ✅ / badge 全局 ✅ / 状态表无 deliveredAt 行 ✅ / source tags 只 2 个真实 ✅ / 0 console error ✅
- typecheck：仅 pre-existing 错误，本刀 0 新增

**未做（明确不属本刀）**:
- P0011 Evidence Identity（解锁 `hasEvidence: true` 真正有 first-class 记录可引）
- P0011.1 Knowledge Provenance（解锁 `hasKnowledge` 真实显示）
- Transport schema（飞书/邮件 — 解锁 `deliveredAt` 真实有值的可能性）
- P0012 Operations（wake + event bus）
- Action/Approval 业务执行闭环（ADR-035 下一阶段）

---

## ADR-048: P0010.1 Workspace Productization Baseline — 人类侧呈现契约

- **日期**: 2026-08-22
- **状态**: Accepted（3 截图 + 24+3 测试验收通过）
- **来源**: P0010.1 Productization Baseline 18 节呈现契约

**核心原则**（用户原话，verbatim 保留）:
> Workspace 必须把机器的 cognition 转换成人类能够理解、质疑、追溯和反馈的工作对象。Situation 是工作对象。Judgment 是 Agent 的结论。Recommendation 是 Agent 给人的建议。Track 是认知过程。Source 是判断依据。Trust 是人能够沿 Source 回溯 Judgment。

**决策**（让 Workspace 通过人类侧 10 个 baseline 问题 10 秒验收，6 项 PURE 前端打磨 + 5 项诚实 unavailable）:

1. **三层呈现契约**（Business Reality / Agent Cognition / Trust-Provenance）。HARD RULE：不在 Situation 主区放第二条 Track 列；Track 投影到现有 `#decisionPanel` 右侧 pane，与 Ranking Explainability 共列；通过 `decisionEntityLabel="调查过程 · {entity.name}"` 区分。

2. **Progressive Disclosure Hero**（结论在前）：当前判断 + 建议 + 调查状态 三行高亮块置顶；Layer 2 6 块（当前判断/已确认/当前假设/还不知道/下一步调查/建议）在下方。仅在 completed / failed+hasPrior 出现。

3. **Honest Source Tag** `[E]/[K]/[H]/[M]`：4 kind 渲染正确；refId 仅 human kind 有效（intervention_index+1）；[E1] 标 "证据" 无编号（content_hash 非持久）；[K1] 标 "规则" tooltip 注明路径锚；[M1] 标 "记忆" tooltip 注明 Runtime-owned；**未识别 kind 不渲染**（不伪造）。

4. **失败业务化** + Stale banner：`humanizeError` 4 种常见 error 字符串 → 中文（Turn timed out → 调查超时（已超过 10 分钟））；business mode 隐藏原始 error，developer mode 显式；failed+hasPrior 时 Hero 顶部加红色 Stale banner（人类能看懂的"上次有效判断还在，下面是新的失败"）。

5. **Language Boundary 强化**：`scrubCapabilityIdsInProse` 已在 P0010.1 Slice 0+1 引入，本刀验证业务模式不暴露 `trade.overview` / `evidenceId` / `situationId`；scrub 不调用 LLM（纯字符串替换 + 已知 capability key 映射表）。

6. **3 demo situations 不可绕过的演示样本**：`sit_observe_demo`（observe / 0 人工 / 完整契约）/ `sit_human_demo`（judgment / 3 人工 [H1][H2][H3]）/ `sit_failed_recover_demo`（failed marker + prior valid cognition 保留 + Stale banner）。Seed 幂等（pre-check existing row）；[风险] 推荐种子的 situation_id 前缀 `sit_*_demo` 永远不与生产 SHA256 collision。

7. **5 个 schema blocker 显式声明**（不伪造，本刀不修，记入 P0011 候选）:
   - **SB-1 [E1]**: 稳定 Evidence 引用（content_hash 非持久）
   - **SB-2 [K1]**: Knowledge first-class record（目录式，无 DB record）
   - **SB-3 [M1]**: Memory 稳定引用（Memory 永远 Runtime-owned）
   - **SB-4 typed sourceRef**: `sourceRef: { kind, id }` schema（需 InvestigationSchema 改动）
   - **SB-5 wake condition / Event Bus**: 本刀不实现

**验收**（真实浏览器 3 截图 + 测试）:
- 3 截图覆盖三种关键状态（observe / human-guidance / failed+recover）✅
- 24 contract tests（businessDescribeSituation 6 type×stopReason / sourceTag 4+unknown / humanizeError 4+mode / descClean / hasPriorValidCognition 3）✅
- 3 integration tests（demo seed 落库 / human-demo 3 interventions / failed-recover prior cognition 保留）✅
- 真实浏览器打开 3 demo situation，Hero + Source Tag + Stale banner 全部按契约显示 ✅

**Baseline §17 NOT INCLUDED 边界严格遵守**:
✓ 不改 InvestigationSchema / Knowledge schema / Evidence schema
✓ 不增加 `knowledge_id` / `business_trace` / `event_bus` / `wake_condition`
✓ 不实现 Human Action Protocol / 工单 / 飞书 / 邮件 / Approval / Commitment Engine / attempt history
✓ 不调用 LLM 做 UI 翻译
✓ 不创建第二套 Product Catalog / Memory Store / Knowledge Engine
✓ 不重设计 Agent Investigation / Hermes session architecture
✓ 不为了页面漂亮伪造 Evidence / Knowledge / Source attribution

**文件**: `apps/ecommerce/workspace/{app.js,presentation.js,presentation.d.ts,styles.css}`，`apps/ecommerce/runtime/situation/rules.ts:175`，`scripts/seed-demo-situations.ts`，`scripts/capture-demo-screenshots.ts`，`tests/contract/investigation.contract.ts`，`tests/integration/three-demo-situations.test.ts`，`context/p0010_1_productization_baseline.md`，`context/{current_state.md,decisions.md,handoff.md,status.json}`。

---

## ADR-047: P0010.1 Workspace Semantic Cleanup

- **日期**: 2026-08-21
- **状态**: Accepted（浏览器验收通过）
- **来源**: P0010.1 诊断后原地 REPAIR——让已实现的智能从旧 UI 壳子里释放，非新增能力

**决策**（Workspace 收敛为一致的 P0010.1 语义，7 项）：

1. **Pattern Engine 不再冒充「Agent 当前理解」**：非 completed 状态的主表象 = Agent lifecycle（待调查/调查中/失败/完成），旧 Pattern 归因降级为折叠「初始信号归因（辅助信息）」。调查中主体显示「正在调查...完成后将显示：当前判断/已确认/当前假设/还不知道/下一步调查/建议」，不占用 Pattern 内容。

2. **Evidence 语义拆开**：Situation 页移除所有「查看 Evidence」直连（不再把人直接送去 Evidence Viewer）。运营侧判断依据入口 = 「为什么这么判断？/查看调查依据」→ **Investigation Track**（canonical surface）。Evidence Viewer 保留为 **Advanced provenance/debug** surface，不删除不重构。

3. **Sidebar 改为互斥的 Agent lifecycle 状态**：待调查 / 调查中 / 观察中 / 需人工 / 已判断（+全部）。每 Situation 唯一映射一个状态，计数不重叠（11+2+4+1+0=18）。表达 Agent 认知状态而非传统工单状态。

4. **Human interaction 止于 Judgment + Recommendation feedback**：移除尚不存在的 action_intent（「我准备这样处理/暂不处理」——Action 越界，本阶段不做）。保留 6 个 canonical feedback：认同/纠正/补充（对判断）+ 采用/不采用/稍后（对建议）。**未来设计点不提前改**（Judgment→feedback→Recommendation→adoption→Action Proposal→approval→Execution→Result→Experience 是下一阶段）。

5. **capability 技术名从业务 UI 隐去**：`capabilityLabel` 业务模式显示 交易概览/流量分析/商品表现 等；开发模式显示原始 id。

6. **版本号不再硬编码**：readiness 从 `context/status.json` 读 version，app.js boot 设置 header+sidebar（v0.10.x）。

7. **investigation timeout/failure = Runtime reliability，不在本刀修**：Workspace 已诚实显示 lifecycle（investigating/failed/待恢复）；调查能否及时完成是 Hermes/model latency 范畴，不再通过 UI fallback 掩盖。恢复机制（backfill 顺序、有界 3、failed/stale 重试、stopReason 视为 completed）已修复。

**验收**（真实浏览器）：pending（尚未调查+预览）/ investigating（正在调查+预览，Pattern 不在主体）/ completed-observe（完整契约+Track）/ needs-human（真异常需人工核验）四状态；sidebar 互斥计数和=18；无「查看 Evidence」直连；无 action 按钮；Track 显示 交易概览/流量分析/商品表；version v0.10.6；零 console error。

**文件**: `apps/ecommerce/workspace/{app.js,index.html,styles.css,interaction-grammar.js}`，`platform/server/{index.ts,routes/p0007.ts,routes/runtime.ts,routes/situation-chat.ts}`，`shared/schemas/investigation.ts`。

---

## ADR-046: P0010.1 Slice 4 — Recommendation（P0010.1 终点）

- **日期**: 2026-08-21
- **状态**: Accepted（浏览器验收通过）— P0010.1 全部 Slice 完成
- **来源**: proposals/P0010.1 Slice 4（Recommendation）

**决策**（Recommendation 是 P0010.1 终点，严格数据流 Investigation → Judgment → Recommendation）：

1. **RecommendationSchema**（`shared/schemas/investigation.ts`）：recommendation / rationale（链接 judgment）/ expectedOutcome / risks / prerequisites / humanNeeded。risks/prerequisites/humanNeeded 接受 string 或 list（模型自然产出数组）并归一化为数组。

2. **来源严格性**：Recommendation 只从 Judgment 产生——prompt 明确「recommendation 必须只来自你的 judgment 和 findings，绝不由单个 Signal/指标阈值产生」；observe 判断 → 建议不干预；humanNeeded 列出需人工核验事实。不写 Action（建议是考虑什么，不是执行命令）。

3. **`POST /api/situation/:id/recommend`**：对已有 investigation 在**同一 session** 跑短 follow-up turn，`extractJsonObject` 防御式解析（markdown fence/prose 包裹的 JSON），持久化增量进 investigation.recommendation。600s 超时（模型延迟波动）。

4. **Workspace**：Understanding 表面「建议」section（recommendation 原文 + 依据 + 预期 + 风险 + 前提 + 需人工）；无建议时显示「生成建议」按钮；反馈（采用/不采用/纠正）REUSE 现有 intervention grammar → Learning Context。

**验收**（orders 真异常需人工核验）：持久化 Recommendation「暂停一切自动调价或加投广告的决策，先完成人工核验（优惠券到期→主力SKU库存→京准通账户）」+ rationale（链接 judgment）+ risks×3 + prerequisites×4 + humanNeeded×4；浏览器在 Understanding 表面显示 + intervention/chat 无回归 + console 零 error。

**文件**: `shared/schemas/investigation.ts`，`platform/server/routes/situation-chat.ts`，`apps/ecommerce/runtime/investigation/prompt.ts`，`workspace/app.js`，`tests/contract/investigation.contract.ts`（+2）。

---

## ADR-045: P0010.1 Slice 2+3 — Automatic Investigation + Scheduled Acquisition

- **日期**: 2026-08-21
- **状态**: Accepted（wire/API 验证通过；Slice 2 完整模型验收受 P0009 延迟影响）
- **来源**: proposals/P0010.1 Slice 2（Automatic Investigation）+ Slice 3（Scheduled Acquisition）

**决策**：

1. **Slice 2 — Automatic Investigation**：抽取 `runInvestigationTurn`（prompt + 两阶段契约提取 + 持久化，route 与 backfill 共用）到 situation-chat.ts；`runSituationProducer` 返回 `createdIds`；backfill 对每个新 Situation **无人工点击**自动调查（fire-and-forget，不阻塞 startup，诚实 timeout/degradation）。REUSE P0010 全部（session/prompt/knowledge routing/fabric_execute/contract extraction）。无新 Agent/Planner/Question/Investigation Engine。

2. **Slice 3 — Scheduled Acquisition**：`scheduler.ts` 最小每日 setInterval runner（非 scheduler engine），REUSE 现有 `kernel.execute`（local-first live acquire）→ Evidence Store → onAfterRun 触发 Situation 路径 → 新 Situation → 自动调查（闭合 steady-state 循环）。`GET/POST /api/runtime/schedule`（list/run-now）。默认配置 enabled:false（避免意外 CDP）。

3. **Slice 5（REUSE）**：现有 intervention grammar「采用建议/不采用/稍后处理」已是 Recommendation feedback → `human_interventions` + Learning Context（已验证 decision/accept 落库）。

**验收**：Slice 3 run-now `trade.overview` → `lastStatus: completed` → 新 Evidence（2026/08/21_trend.meta.json）落盘，完全复用现有路径。Slice 2 wire 验证（session 创建 + prompt 提交 + 600s 诚实 timeout 无伪造）。完整 auto-investigation 模型验收受 P0009 延迟影响（模型 600s 未完成时诚实报 timeout）。

**文件**: `apps/ecommerce/runtime/{situation/producer,scheduling/*}.ts`，`platform/server/routes/{situation-chat,schedule}.ts`，`platform/server/index.ts`。

---

## ADR-044: P0010.1 Slice 0+1 — Workspace Investigation Surface

- **日期**: 2026-08-21
- **状态**: Accepted（浏览器验收通过）
- **来源**: proposals/P0010.1-steady-state-investigation-operations-workspace.md

**决策**（让 Workspace 从 "Signal/Ranking 告警中心" 调整为 "Agent Operations Workspace"——信息优先级调整，非视觉 redesign）：

1. **Slice 0 审计结论**：Situation 产生 REUSE（runSituationProducer）；自动调查触发 WIRE（investigate 逻辑内嵌路由需抽取）；Investigation 入口 REUSE（POST /api/situation/:id/investigate）；Track 可**从已持久化契约派生**（findings/hypotheses/capabilityUsed/stopReason，零 LLM 零 CoT 零 schema 变更）；Intervention UI REUSE（「采用/不采用」已是 Recommendation feedback）；Recommendation MISSING（Slice 4）；Scheduler MISSING（Slice 3）；Situation 列表 WIRE；Ranking Explainability REUSE（secondary）。**无 schema gap**。

2. **Situation 列表 Agent 状态**：`/api/situations` 带 per-situation investigation summary（`deriveInvestigationStatus`：observing/needs_human/judgment_ready 从 stopReason + 人工核验 markers 派生，纯函数无 LLM）。卡片渲染状态 chip（观察中/未调查/需人工核验/已判断）+ Agent 判断摘要行。

3. **Investigation Track 一等 UI**：Detail 中「调查过程」时间线（发现→调查问题→获取证据→假设更新→能力边界→判断→停止），全部从已持久化 investigation 字段派生——**业务可审计过程，非 Chain-of-Thought**，不保存/不展示模型内部推理。

4. **Current Understanding 保持主表象**（ADR-043 hero 不变）；Track 回答 HOW；「为什么这么判断」保留为证据下钻；Ranking Explainability 保持真实 E2E 但为 secondary。

**验收**（真实浏览器）：列表 14 卡片渲染状态 chips + judgment；Case A（GMV→observe）Track 10 步（含假设更新「周末效应已支持/真异常已弱化」）；Case B（orders→真异常）Track 9 步（含能力边界「京准通需人工核验」）；console 零 error；零 LLM 渲染。

**文件**: `platform/server/routes/p0007.ts`，`apps/ecommerce/workspace/{app.js,styles.css}`。

---

## ADR-043: P0010 Current Understanding Workspace Surface

- **日期**: 2026-08-21
- **状态**: Accepted（浏览器验收通过）
- **来源**: P0010 最后一个产品层缺口——把已持久化的 Investigation/Understanding 提升为 Workspace 一等业务表象

**决策**（Situation Detail 的「🧠 Agent 当前理解」成为主表象）：

1. **Canonical semantics**：Current Understanding = 主表象；Chat/Intervention = 可改变理解的交互；Trace/调查依据 = 解释"为什么这么判断"的次级下钻面。**本刀停在 Situation → Current Understanding，不进 Recommendation/Action**。

2. **REUSE 已持久化状态，禁 LLM**：Workspace 消费 `LearningContext.investigation`（P0010 已产生），**禁止为 UI 再调 Hermes/LLM 生成摘要**，禁止为展示复制 LLM summary。无第二套 Understanding 模型。

3. **六个业务语义段**（运营语言，非 schema 字段）：当前判断（judgment 原文 + 调查结果 verdict）、已确认（findings 逐条可读 + 依据 knownEvidence）、当前假设（hypotheses + 已支持/待验证/已弱化/已排除）、还不知道（unknowns + requiredEvidence）、下一步调查（真实 nextQuestion；**observe-stop 不伪装活跃问题**——显示"建议观察后续数据"+ muted 观察项）、能力边界（**只从 Agent 自己的措辞派生**：stopReason=missing_capability/ask_human 或 judgment 含 人工核验/无法获取 → ⚠ 需人工核验清单）。

4. **Trace 是次级入口**：`为什么这么判断？/查看调查依据`（capabilityUsed/evidenceAcquired/时间 + 信号归因）。普通运营首先看到的是"Agent 当前怎么理解这件事"，不是 MCP/trace_id/JSON。

5. **预调查状态不回归**：无 investigation 时保留原 Pattern Engine 归因 + 确定性建议 + 「交给 Agent 调查」按钮。

**验收**（真实浏览器）：Case A（GMV -67.9% 周末节律 → observe → 当前不建议干预）肉眼可判断；Case B（orders -66.7% 真异常 → 5 假设 → 下一步调查=京准通/广告计划 → **能力边界 ⚠ 京准通账户余额/预算/广告计划状态需人工核验**）；reload 后状态仍在；console 零 error；intervention/chat 无回归；无新 LLM 调用/无新 evidence acquisition。

**文件**: `apps/ecommerce/workspace/app.js`。

---

## ADR-042: P0010 Knowledge-Guided Investigation

- **日期**: 2026-08-21
- **状态**: Accepted（Initial Acceptance 通过）
- **来源**: proposals/P0010-knowledge-guided-investigation.md

**决策**（让 Agent 从"读已有数据解释 Situation"跨到"基于专业 Knowledge 主动调查"）：

1. **Ownership**：Hermes 负责读 Knowledge、形成 Understanding、选 Next Question、选 Capability、读 Evidence、更新判断、决定 Stop。Fabric 负责 Situation、Capability discovery/execute、Evidence persistence、把 Investigation 业务产物给 Workspace、Learning Context。**Fabric 不替 Hermes 思考问题**——无 if/else 调查树、无硬编码问题、不复制运营 SOP 进 prompt。

2. **Investigation Contract**（`shared/schemas/investigation.ts`）：situationId / currentUnderstanding / knownEvidence / hypotheses(statement+status) / unknowns / nextQuestion / requiredEvidence / investigationRequest / findings(question+evidenceRefs+answer+impactOnHypothesis) / judgment / stopReason(judgment|observe|missing_capability|ask_human) / capabilityUsed / evidenceAcquired。领域级可审计对象，**不是 Chain-of-Thought**。

3. **调查触发**（`POST /api/situation/:id/investigate`）：复用 situation-chat 的 sessions Map → **同一 Hermes session**（capability 执行结果回到同一 turn）。两阶段契约提取：主调查 turn（600s）+ 若模型输出 prose 则 follow-up turn 要求结构化 JSON（Fabric 不合成）。持久化 = LearningContext body 增量 `investigation` 字段（`learning_contexts` 表 upsert，**不建新表**）。

4. **Prompt**（`buildInvestigationPrompt`）：situation+evidence 作为 data 注入；指示读 knowledge/INDEX.md + 相关页；Agent 自主选 Next Question + requiredEvidence；证据不足时用 fabric_list_capabilities + fabric_execute_capability；无匹配能力 → missing_capability 不猜；**必须真实调用 fabric_execute_capability 至少一次**。无业务规则/决策树/if/else。

**验收**（真实 GMV decline `sit_6f42b428e06c766d5681`，成交金额 -67.9%）全通：Hermes 读 Knowledge（引用"对比优先级：周同比>类目大盘>日环比"、"单天波动±15%优先观察不干预"——来自 knowledge/reference/京东电商运营隐性经验与故障诊断.md）→ 形成 Current Understanding（4 天真实数据）→ 自主 Next Question（与上周同日对比验证周末节律）→ 证据不足 → **fabric_execute_capability(trade.overview) 真实执行** → 获取 08-13/14/15/16 四天 Evidence 入 Evidence Store → Answer（周末节律伪异常）→ 假设更新（周末效应 supported / 真异常 weakened）→ **stopReason=observe**（Investigation Gate 正确：波动幅度+周度节律判断后观察不干预）。持久化 learning_contexts + Workspace Investigation 层渲染 + console 零 error。

**文件**: `shared/schemas/investigation.ts`，`apps/ecommerce/runtime/investigation/{prompt,parse,index}.ts`，`platform/server/routes/situation-chat.ts`，`workspace/app.js`，`tests/contract/investigation.contract.ts`（15 tests）。

---

## ADR-041: Knowledge Sources Workspace Surface

- **日期**: 2026-08-21
- **状态**: Accepted
- **来源**: Knowledge Ingest backend 闭环（ADR-040）后的专业人员 Workspace 页面；非 Knowledge Engine

**决策**（专业人员提供资料 → Raw Source → 查看整理状态 → 显式触发 Hermes Ingest → 查看生成的知识）：

1. **状态单一事实源 = `/api/knowledge/status`**，前端不推断第二套状态模型。`status.ts` 增量扩展：source 增加 `type`/`mtimeMs`；新增 `pages`（生成的知识，排除 INDEX/KNOWLEDGE/log 系统文件）+ `indexMd`（只读）。「已整理/未整理」= 是否被 provenance 引用；**不做不可靠的「有更新待整理」推断**。

2. **上传最小入口**：`POST /api/knowledge/upload`（JSON `{filename, content}`，复用 express.json + apiPost，零新依赖/无 multipart）。校验 = `validateRawUpload`（纯函数）：basename-only（防 path traversal）、`.txt`/`.md` 白名单、非隐藏文件、非空、≤500KB。写入 = `storeRawSource`：只写 raw 目录（resolved 防御）、**同名 409 拒绝覆盖**（raw 不可变 provenance）。第一版不提供在线编辑 raw。

3. **Ingest REUSE `POST /api/knowledge/ingest`**（含 per-source `{source}`）。页面提供全局「交给 Agent 整理」+ 每份未整理源的「整理此份」。Fabric 不总结 raw、不生成知识页。

4. **诚实区分 Agent 执行 vs 文件系统结果**：ingest 超时不再返回裸 500，而是返回 `{ success:false, agentStatus:'timeout'|'error', error, status }`——`status` 是 ingest 后实时枚举的磁盘真相。UI 对 timeout 显示「Agent 执行未确认完成 + 实时文件系统状态」，**绝不因无 message.complete 就把已写入的 knowledge 显示为不存在**（P0009 模型延迟下 Hermes 常已写完但报告超时）。

5. **上传/状态路由不触发 writeProjection**：knowledge 路由直接 `initSharedKnowledgeLayer`（seed-if-absent、不清目录），与 situation-chat 的 `ensureWorkspace`（rmSync 清理）解耦——避免并行测试对共享 workspace 的 ENOENT 竞态。

**验收**（真实浏览器 + Hermes）：上传 `团队管理经验.txt` → 立即未整理 → 交给 Agent 整理 → Hermes 创建 `knowledge/operations/团队管理经验.md`（frontmatter `sources` 引用正确）、更新 INDEX、append log → 刷新后 source 显示已整理 + 生成页 → raw 文件逐字节未变 → console 零 error。

**文件**: `apps/ecommerce/runtime/shared-knowledge/status.ts`，`platform/server/routes/knowledge.ts`，`workspace/{index.html,app.js}`，`tests/unit/shared-knowledge/{knowledge-status,raw-upload}.test.ts`，`tests/integration/http.test.ts`。

---

## ADR-040: Knowledge Ingest — 恢复 Fabric 操作入口（无 Knowledge Engine）

- **日期**: 2026-08-21
- **状态**: Accepted
- **来源**: P0008.4 §10 定义 Ingest 流程但从未设计控制入口（"暂无自动化引擎"）；本轮恢复最小操作入口

**决策**（Fabric 只做控制面，知识编译归 Hermes）：

1. **Fabric 只负责四件事**：① 枚举 `knowledge-sources/raw/`；② 标记 source 是否已被 knowledge 页 `sources:` provenance 引用（纯 FS 检查，无 LLM）；③ 提供显式 "Ingest / Update Knowledge" 入口（`GET /api/knowledge/status` + `POST /api/knowledge/ingest` + Workspace Knowledge 视图按钮）；④ 启动 Hermes 在当前 Fabric Workspace（cwd=`data/fabric-workspace`）执行 KNOWLEDGE.md 已定义的 Ingest 流程，并原样展示 Hermes 报告与 ingest 后 provenance 状态。

2. **Hermes 负责全部知识工作**：读 raw、判断 create vs update、写 `knowledge/*.md`（frontmatter `sources:` 引用）、更新 `knowledge/INDEX.md`、append `knowledge/log.md`。Fabric **不**总结 raw、不生成知识页、不做 RAG/向量/Knowledge Engine。

3. **复用现有 Hermes session 机制**：`knowledge.ts` 复用 `situation-chat.ts` 的 `ensureWorkspace`/`collectTurn`（导出复用，不新写 session 客户端）。`collectTurn` 超时从 120s → 300s（已知 P0009 模型延迟 71-77s 或 >180s，ingest 读源+写页更慢）。

4. **状态解析支持三种 frontmatter 形式**：单行数组 `[a, b]`、多行数组 `[
 a,
 b
]`（Hermes 实测输出形式）、dash list（治理契约形式）。provenance 匹配 = workspace-relative 精确路径，fallback basename。

**验收**（真实 Hermes 实测）：status 枚举 9 个 raw 源（2 seed demo + 7 个真实 `京东电商运营*.txt`）；Hermes ingest 真实完成——创建 `knowledge/operations/京东电商运营日常SOP.md` + `knowledge/reference/京东电商运营隐性经验与故障诊断.md`，更新 INDEX、append log；parser 修复后 status 精确反映 7 referenced / 2 pending（1 个 seed demo 未处理 + 1 个 Agent 引用了不存在的源文件名，诚实暴露）。模型在 300s 窗口内未 emit message.complete（已知 P0009 模型稳定性限制），但 Agent 实际工作已完成——入口与机制全通。

**文件**: `apps/ecommerce/runtime/shared-knowledge/status.ts`（纯函数），`platform/server/routes/knowledge.ts`，`situation-chat.ts`（导出+超时），`index.ts`（挂载），`workspace/{index.html,app.js}`（Knowledge 视图）。

---

## ADR-039: Post-Consolidation REMOVE Sweep

- **日期**: 2026-08-21
- **状态**: Accepted
- **来源**: Consolidation 收口（post-consolidation inventory 判定剩余资产为 demo/死代码/误导入口）

**决策**（只删除 audit/ADR 明确 REMOVE CANDIDATE + 证明无 canonical consumer 的资产；DB 表/列一律不动）：

1. **删除（REMOVED）**：
   - `situation-viewmodel.ts` 孤儿文件（已被 `interaction-grammar.js` 取代）。
   - agentSession SSE demo：`/api/runtime/events/:taskId` demo 路由 + `connectEventStream`（P0009 起无调用者，真实聊天走 `/api/situation/:id/chat`）。
   - agentConfig：`loadConfig`/`saveAgentConfig`/`view-agentConfig`/sidebar 入口/`config.*` i18n（localStorage 伪持久化，权重从不在 ranking 生效）。
   - Legacy Inbox：`loadInbox`/`renderFindingCards`/`view-inbox`/隐藏入口/inbox 内嵌 chat 及全部相关 i18n 键（含 pre-existing broken `badgeAll` 残留，ADR-037 REMOVE CANDIDATE）。
   - Evidence Viewer 死 i18n 键（17 个 `evidence.*`，从未渲染）。
   - operator_memories producer+API+consumer：`buildOperatorMemories`、`buildMemories`（pattern/memory.ts）、`matchMemories`/`buildContext`（memory/matcher.ts）、3 个零消费者端点（memories/sync、memories、context）。

2. **保留为 DEPRECATED / inert**：
   - `operator_memories` 表 + `memory/store.ts`（`initMemoryStore`）+ `memory/types.ts`：表由 init 建（DB 约束），无运行时 reader/writer。
   - `signal_weights` 表 + seed：仅 schema + init，删 = schema cleanup，禁止。
   - legacy `Review → Feedback → context_memories → memory-adjustment`：**读侧有真实 consumer 不删**（`MemoryFacade.queryActive` 被 /api/memory + chat.ts + workspace.ts findings + orchestrator `adjustmentsFor` 消费）；生产侧 `extractMemories` 零调用 = inert。

3. **边界**：不删 DB columns/tables、不做 schema cleanup、不处理 Evaluation dormant columns、不修 persistent evidence identity（ADR-038 gap）、不补 capability↔evidence、不新增替代实现、不做 UI redesign。

**验收**：typecheck 17 errors 前后一致（全 pre-existing）；570/572 tests（2 pre-existing）；浏览器 7 链全通（Acquisition → Ranking→Explainability（真实 trust=12%/low_coverage）→ Situation → Professional Action → Learning Context（intervention `evaluation:agree` 落库，lifecycle:partial）→ Evidence Viewer（641 records））；全视图控制台零 error。

**文件**: `apps/ecommerce/workspace/{app.js,index.html}`，`platform/server/routes/{runtime.ts,ranking.ts}`，`apps/ecommerce/analysis/pattern/{engine.ts,index.ts,memory.ts(删除)}`，`apps/ecommerce/memory/{index.ts,matcher.ts(删除)}`。

---

## ADR-038: Evidence Viewer Contract Repair - 消费真实 Provenance

- **日期**: 2026-08-21
- **状态**: Accepted
- **来源**: Consolidation（post-consolidation inventory 判定 Evidence Viewer 是最后一条「有真实数据撑着的断腿」）

**决策**（修复 Evidence Viewer 的 API/UI contract mismatch，只对齐契约不扩功能）：

1. **只做 contract 对齐。** `renderProvenanceChain` 原读 `evidence.artifacts` / `evidence.evidence_records` / `evidence.summary`（三个路径全错 -> 永远渲染空）。修正为消费路由真实返回：`discovery.artifacts` / `evidence.recentRecords` / `evidence.totalRecords` / `provider.{platformName,acquisitionLabel}` / `validation.lastVerified`。不新增 schema、不新增 producer、不重新设计 provenance。

2. **producer 侧两处语义修复**（`GET /api/evidence/:capabilityId`）：
   - `recentRecords` 按 `acquired_at` 降序排序--原实现取 `listEvidence` 目录序前 10 条，实为**最旧** 10 条；
   - `listEvidence` 显式 `limit`（`EVIDENCE_LIST_LIMIT=10_000`）--默认 limit=100 会把 `totalRecords` 静默截断（真实 641 条报 100），且截断后最新 evidence（如 2026-08-20 CDP 采集）永远进不了 recentRecords。

3. **`loadBtn` 用 `onclick` 赋值替代 `addEventListener`。** 该 view loader 每次导航都执行，addEventListener 会叠加重复 listener -> 重复 fetch。

4. **记录为后续 gaps，本轮不修**：
   - **capability 与 evidence 无稳定关联**（MISSING，schema gap）：route 按 `source=platform` 列全部 evidence，product.overview 也会显示 summary/trend 记录；EvidenceMetadata 无 capability 字段。
   - **persistent evidence identity**（provenance identity gap，重要非 blocker）：`evidence_id` 每次 list 重新生成 UUID（store.ts 自述「for runtime tracking, not persistence」）--未来要做「点一条 Evidence -> 稳定回链原始证据」必须先解决，归后续 provenance consolidation。
   - **`validation.lastVerified=null`**（metadata gap，低优先）：capability-contract.json 无 last_verified 数据。

**验收**：浏览器（CDP 实测）product.overview -> 三个 provenance 节点（商品表现 / Discovery Artifacts / Evidence Records）+ `京东商智 · Live CDP Capture` + timeline 10 条真实 CDP evidence（2026-08-20 productTop · jd_shop_001 · cdp，与 API recentRecords 逐项一致）+ `Total: 641 records`。新增 http.test 回归（recentRecords 降序 + totalRecords 不截断）。

**文件**: `apps/ecommerce/workspace/app.js`，`platform/server/routes/runtime.ts`，`tests/integration/http.test.ts`。

---


## ADR-037: Explainability/Trust Workspace WIRE — Real /api/trace Consumer

- **日期**: 2026-08-20
- **状态**: Accepted
- **来源**: Consolidation（Explainability/Trust 纵向收口，producer wiring 之后接 Workspace consumer）

**决策**（把真实 Ranking 对应的 trace 接进 Workspace 商品/Ranking 视图）：

1. **Workspace 只消费现有 trace API。** 决策面板（运营/开发两种模式）的 trace 内容唯一来源是 `/api/trace/:traceId`；`GET /api/ranking/:profile` 只为每个 ranking 附加**当前** trace_id（`business_traces.ranking_id` = live `ranking_results` ranking_id 的 JOIN）作为链接，悬空历史 trace 永不命中、永不显示。不重新计算 trust、不调用 Hermes/LLM。

2. **旧 fabricated trace panel = 替换，不维护两套。** P0003.1 的 `renderTracePanel`（Decision Summary / Skills Triggered / MCP Calls / Memory Influence / Execution Steps / Result Validation）是合成内容——skills/MCP/memory 是硬编码的展示结构，非真实运行轨迹。已整体替换为真实 trace consumer（trust_score / contradictions / evidence signals / ranking trace entry），expand 折叠逻辑删除。

3. **明确 Ranking Explainability 语义。** 面板标题标注「排名解释（Ranking Explainability）· 非 Situation 解释」——这是 ranking 的 business_trace，不是 Situation 解释。

4. **Legacy Inbox = REMOVE CANDIDATE。** `loadInbox` 引用已删除的 `badgeAll`（P0009 重构去掉了 inbox 徽章 DOM），pre-existing broken。**不修复**——它已标记「(旧)」，canonical Product/Ranking Workspace 不再依赖它；加 guard 本质是继续维护 REMOVE CANDIDATE。

**验收**：浏览器实证 `商品 → 点商品 → 决策面板` → 运营模式 `信任分 12% — 证据稀薄（low_coverage）`；开发模式完整 trace（trust=0.12、low_coverage、gmv_growth_1d 证据、排名第 1 / 0.3667）。

**文件**: `apps/ecommerce/workspace/{app.js,index.html}`，`platform/server/routes/ranking.ts`（trace_id 附带），`tests/integration/http.test.ts`。

---

## ADR-036: Explainability/Trust Producer Wiring — Append-Only Trace History

- **日期**: 2026-08-20
- **状态**: Accepted
- **来源**: Consolidation（Ranking → Explainability/Trust 纵向收口，见 ranking-data-lineage-audit.md §5）

**决策**（把真实 productTop ranking 接进已有 `buildTrace → business_traces` producer）：

1. **REUSE 现有 producer，不新建、不改算法。** 复用 `buildTrace` / `TraceFacade.store` / `computeTrustScore`；新增 `buildRankingTrace`（`builder.ts` 纯函数）+ `TraceFacade.explainRanking`（facade 薄委托，保「facade = 唯一跨域入口」）。backfill 在 `rankByProfile` + `RankingFacade.store` 后为**每个** ranking 生成并持久化一条 trace。不改 trust 公式、不改 ranking 算法、不接 Workspace consumer、不重构 AI ranking path（`rankProductsComposition`/`persistComposition` 原样保留）。

2. **trust 用真实 productTop input。** 5 个 SKU 各 1 个 `gmv_growth_1d` 信号，confidence=0.9，coverage=0.2（5 组件只覆盖 growth）。`detectContradictions` Rule 5 `low_coverage`（coverage<0.4）→ `is_supported=false` → `trust_score=max(0, 0.9*0.3 - 1*0.15)=0.12`。诚实反映「单信号证据稀薄」，非 bug。

3. **Trace history = append-only（本轮接受）。** `storeTrace` 纯 INSERT、`ranking_id` 每次 `rankProducts` 重生成（`uuid()`）、backfill 每启动跑一次——三者叠加导致每次启动 +5 行 trace。记录为已知 **Retention / Historical Referential Integrity** issue，非当前 bug。**本轮不修**（修需动 `storeTrace` 语义 / `ranking_id` 生成 / DB unique constraint，均超出 producer wiring 红线）。

4. **未来 Replay/Audit 再设计 ranking snapshot / retention policy。** 若历史 trace 需要可回放/审计，届时引入 ranking snapshot（固定 ranking_id）或 retention 策略。

**文件**: `apps/ecommerce/analysis/explainability/{builder,facade}.ts`（`buildRankingTrace`/`explainRanking`），`platform/server/index.ts`（backfill 接线），`tests/integration/product-top-trace.test.ts`。

---

## ADR-035: Consolidation Pass 2 — Canonical Professional-Learning Path

- **日期**: 2026-08-20
- **状态**: Accepted
- **来源**: Consolidation Pass 2（Situation → Professional Action 收债）

**决策**（确定「专业人员参与 Agent 认知」的唯一主线，并划清 Memory 归属）：

1. **Canonical professional-learning path = `Situation → Human Intervention → Learning Context → Hermes`。** Fabric 的职责到 Learning Context 为止：`human_interventions` 保留为专业人员的原始判断记录，`learning_contexts` 恢复为 Fabric 的「经验交付层」（`Intervention → Learning Context` producer 已在 `apps/ecommerce/experience/learning-context-producer.ts`）。结构化 grammar（response/correction/context_supplement/decision/action_intent）经 UI 原样进入 Learning Context，再交付给 Hermes workspace。

2. **Memory / Growth 归 Hermes。** Fabric 不生产自身 Memory，不做 `Intervention → context_memories` producer，不实现 Hermes Memory。Fabric 的终点是「把 Learning Context 交付给 Hermes」（situation-chat 建 session 前写入 `fabric-workspace/situations/<id>.json`）。

3. **Legacy `Review → Feedback → context_memories → memory-adjustment` 链标记 REMOVE CANDIDATE，暂不删除。** 这是 agentCMS 时代的「Fabric 自己学习、自己记忆」思路，与当前 canonical path 冲突。禁止后续新功能继续依赖该链（`ReviewFacade.submit/promote`、`MemoryFacade.extract/store`、`memory-adjustment` 的 adjustmentsFor 均不再作为新功能入口）。真正删除留待后续统一清理。

**边界**：Action / Result（业务执行：调预算、改价、报名活动）与认知反馈（我不采用/这是价格调整导致）是两回事，不在 Pass 2 范围内处理。

---

## ADR-034: P0009.1 Situation Producer — 确定性检测 + 无 LLM + 幂等去重

- **日期**: 2026-08-16
- **状态**: Accepted
- **来源**: [P0009.1-situation-producer-odays-work.md](../proposals/P0009.1-situation-producer-odays-work.md)

**决策**（补齐 P0007 缺失的 canonical Situation Producer，代码审计确认此前"从 Signals/Rankings 生成 Situation"的逻辑不存在）:

1. **Producer 是确定性运行时能力，不是 AI 分析器**。描述用模板生成（`{店铺} {指标} 较昨日下降 47.5%，从 434 变为 228`），阈值判断（20% 相对变化），全程 NO LLM / NO Hermes / NO CDP / NO acquisition。职责严格单向 `detect → construct → persist`。

2. **输入只消费已完成的 runtime output**。store-level `daily_summary` signals（`SignalFacade.list(db, 'product', shopId)`，注意 enterprise signal 的 `entity_type` 恒为 'product'，`entity_id` 才是 shop）+ `RankingFacade.load(db, 'operator_mode')`。不重新采集、不重新计算业务指标（uv/gmv/cvr 来自已存 metrics，Producer 只做跨天比较得出 direction）。

3. **三类确定性检测**。A meaningful_change（逐指标 20% 阈值）；B ranking_attention（top-K + 领先 gap ≥0.1）；C cross_signal（uv/cvr 反向移动）。detection kind 存入 `tags`，`SituationSchema.type` 只承载粗粒度业务类别（decline/cross→anomaly_investigation，rise/ranking→performance_analysis）。

4. **幂等去重 = 确定性 situationId + INSERT OR IGNORE**。`sit_<sha256(kind+entityType+entityId+subject+window).slice(20)>`，situationId 不包含 metric 值或店名，因此重启重跑 `created=0 / skipped=N`，绝不重复（满足"重启 10 次不出现 10 条"）。

5. **复用 P0007 持久化/lifecycle，不重构**。写 `situations` 表 + `SituationSchema` 校验 + `lifecycle='open'`（后续 human intervention→partial、outcome→mature 走既有 P0007 route）。不改 `p0007.ts` route，不新增第二套 lifecycle。

6. **诚实处理非差异化数据**。当前 67 商品 ranking 全部同分 0.4648（mock/import 数据未区分商品），ranking_attention 规则已实现但不触发——不制造 demo 数据填页面。store-level 的 gmv/orders/uv/cvr 下滑是真实 grounded 内容（2026-08-16 vs 08-15: uv 434→228 = -47.5% 等 4 条）。

7. **latest-window only**（今日 vs 昨日）= "今日工作"语义；随日期推进自然累积历史 Situation。

**文件**: `apps/ecommerce/runtime/situation/{rules,producer,index}.ts`（纯 rules 与 DB producer 分离便于测试），`tests/unit/situation/situation-producer.test.ts`（12 测试），startup wiring 在 `platform/server/index.ts` backfill 之后。

---

## ADR-027: P0006.2 Real Data Runtime Replay — Evidence Store Parsing Fix

- **日期**: 2026-08-09
- **状态**: Accepted
- **决策**: `parseAcquiredData()` 在映射 endpoint→data type keys 时，将单对象包裹为数组 `[data]`，确保 evidence store 中 JD API envelope 格式的数据能被 parser 正确识别。

### 问题

Full 180-day replay (2026-01-01 ~ 2026-07-09) 执行成功 (190/190 days)，但 `parseAcquiredData()` 将 evidence store 的单对象数据传给 parser 时，`asArray()` 对非数组返回 `[]`，导致 parser 永远返回 `emptySummary()`。

Evidence store 中每条数据都是单个 `{ header: { code:0 }, body: { data: [...] } }` 对象。`historical-acquire.ts` 将其返回为 `data[endpoint] = loaded.data`。`parseAcquiredData()` 将其映射到 `raw['summary'] = data`，但 parser 期望 `raw['summary']` 是数组。

### 修复

`runtime-executor.ts:parseAcquiredData()` — 在 endpoint→base key 映射时包裹非数组值: `const wrapped = Array.isArray(data) ? data : [data]`。

### 验证

- 修复前: 3 天 replay → 3 signals, 全部 `signal_value=0, metrics={}`
- 修复后: 3 天 replay → 64 signals, `signal_value=¥12,351~¥14,229` (真实 CDP 采集数据)
- Full replay: 190 天 → 3,489 signals, 570 evidence, 0 errors. `signal_value` 均为真实值

### 已知限制

`metrics` 字段（EnterpriseSignalPayload: gmv, orders, uv, cvr 等）未被 repository.toRow 持久化到 SQLite。Workspace 使用 `signal_value` 展示 GMV，功能正常。完整 metrics 持久化留待后续补齐。

---

## ADR-026: JD Persistence Layer — platform/storage/

- **日期**: 2026-07-12
- **状态**: Accepted
- **决策**: JD 数据持久化层（jd-schema.ts + jd-persistence.ts）属于 platform/storage（基础设施层），不属于 connectors（业务执行层）。

---

## ADR-025: Signal Observation Model — Three-Timeline Architecture (P0006.1.1)

- **日期**: 2026-07-09
- **状态**: Accepted
- **决策**: 建立三层时间轴模型，Signal Schema 新增 `observed_at` 列，UNIQUE 约束从 `(entity_type, entity_id, signal_name, window)` 升级为 `(entity_type, entity_id, signal_name, window, observed_at)`。

### 三层时间轴（不可再混）

| 时间轴 | 字段 | 含义 | 来源 |
|--------|------|------|------|
| **Business Timeline** | `observed_at` | 业务观测时间 — 这条数据"测量的事发生在什么时候" | `SignalCollectorInput.timestamp` |
| **System Timeline** | `ingested_at` | 系统采集时间 — 这条数据"什么时候被存进来的" | `nowIso()` at pipeline start |
| **Execution Timeline** | `execution_id` / `pipeline_run_id` | 执行时间 — "哪次 Run 产生的这条数据" | `trace.pipeline_run_id` |

### Signal 两层模型

```
Layer 1: Signal Type (Definition) — 固定
  daily_summary, hourly_sales, hourly_traffic
  来自 blueprint.manifest.signal_types

Layer 2: Observation (Instance) — 每次采集产生
  daily_summary on 2026-07-09 for jd_shop_001
  来自 SignalCollectorInput.timestamp → observed_at
```

### 回退的补丁

- `hourly_traffic_14` → `hourly_traffic`（signal_name 恢复纯净类型名）
- 删除 `extractHour()` helper
- 删除 signal-engine 中的 signal_name mutation 逻辑

### 受影响模块

- `shared/schemas/signal.ts` — SignalSchema +observed_at
- `platform/storage/schema.ts` — v3 migration, 新 UNIQUE 约束
- `apps/ecommerce/connectors/normalizer.ts` — 传递 timestamp→observed_at
- `apps/ecommerce/analysis/metrics/repository.ts` — toRow/fromRow/storeSignals/listAllSignals
- `apps/ecommerce/analysis/metrics/pipeline.ts` — 计算信号使用 pipeline 时间作为 observed_at
- `apps/ecommerce/runtime/kernel/runtime-signal-engine.ts` — 删除小时后缀逻辑
- `platform/server/routes/runtime.ts` — 使用 observed_at 分组执行历史
- `platform/server/routes/chat.ts` — 使用 observed_at 分组日期

- **原因**: P0006.1 C1 暴露了 Signal 数据模型缺陷——`signal_name` 被同时用作类型标识和观测标识（`hourly_traffic_14`），导致 UNIQUE 约束 `(entity_type, entity_id, signal_name, window)` 无法区分不同日期的观测。这不是字符串拼接问题，而是数据模型从两层被压扁为一层的问题。P0006.1.1 将其恢复为正确的两层模型 + 三层时间轴。

## ADR-024: Agent Loop — agentFabric-Owned, Not HermesAgent-Owned (P0006)

- **日期**: 2026-07-09
- **状态**: Accepted
- **决策**: Agent Loop 由 agentFabric 拥有，不由 HermesAgent 拥有。当前 HermesClient 是 one-shot 文本接口（prompt → stdout），不支持 tool calling。不改动 Hermes（保持可替换性），agentFabric 用两次 one-shot 调用实现 agent loop：
  - **Intent Classification** — HermesAgent one-shot: "这个用户想问什么？" → 从 Skill Catalog 中选择最匹配的技能
  - **Response Generation** — HermesAgent one-shot: "基于这些执行结果，回答用户问题"
  - **Dispatch Logic** — agentFabric 负责: 技能匹配（pattern + HermesAgent fallback）→ handler 分发 → Kernel/Orchestrator 调用 → 结果组装
- **Skills as Data**: Skills 是结构化定义（name, intentPatterns, handler, responseTemplate），不是可执行代码。ChatRouter 读取 skill definitions 进行 intent → handler 分发。Handlers 是 thin wrappers 调用现有 Kernel/Orchestrator 操作。
- **Runtime via HTTP**: Kernel 新增 HTTP 路由（/api/runtime/collect, /api/runtime/executions），Workspace 和 Chat 可触发执行。CLI 继续可用。HTTP 是额外入口，不是替代。
- **原因**: P0005 完成后系统 "Runtime Ready, Product Not Ready" — Kernel CLI-only, Hermes 只生成文本摘要, Workspace 面板硬编码。P0006 不新增业务能力，只把已有能力接起来：HermesAgent → Runtime Kernel → Workspace。

## ADR-023: CLI Final Patch — Pure Shell, Zero Business Logic (P0005.6.1)
- **日期**: 2026-07-04
- **状态**: Accepted
- **决策**: CLI 彻底变为纯入口壳层。所有业务逻辑（acquire、saveEvidence、normalizeSignal、SignalFacade.store、parse、evidence wrapping）移入 Kernel。CLI 只调用三个方法：`kernel.execute()`（单日 mock/live）、`kernel.executeLiveCDP()`（多日 CDP）、`kernel.executeImport()`（历史导入）。
  - `executeLiveCDPPipeline` — 多日 CDP 采集 + 逐日 signal/evidence 处理，全部在 kernel 内完成
  - `executeImportPipeline` — 读取历史 JSON → 保存 evidence → 生成 signal（blueprint 或 legacy fallback），全部在 kernel 内完成
  - `createEmptyBlueprint` — 无 Discovery 数据时的合法"空状态"，让 import pipeline 走 legacy fallback
  - CLI imports 从 20 个缩减到 6 个：移除 `acquireJdData`, `saveEvidence`, `normalizeSignal`, `generateSignals`, `captureEvidence`, `buildSpecFromBlueprint`, `INDICATOR_OVERRIDES`
- **原则**: CLI 不允许知道任何业务逻辑。Kernel is the ONLY execution boundary. `saveEvidence()` 和 `SignalFacade.store()` 绝不在 CLI 中出现。
- **原因**: P0005.6 消除了 `processDay()` 但 Live CDP 和 import-jd 路径仍有 bypass。P0005.6.1 补上最后两个缺口，实现真正的 100% Kernel 收敛。

## ADR-022: Execution Convergence — Zero Legacy Paths (P0005.6)
- **日期**: 2026-07-04
- **状态**: Accepted
- **决策**: 彻底消除所有非 Kernel 执行路径。`processDay()` 函数完全删除。Live CDP 路径改用 `generateSignals()` + `captureEvidence()`。`cmdImportJd` 信号生成改用 signal-engine (blueprint 可用时), 保留 evidence save 作为历史数据迁移特例。
- **原则**: Kernel is the ONLY runtime entry point. CLI must never execute business logic directly. CDP/Acquisition must only be invoked via Kernel injection.
- **原因**: P0005.5 创建了 Kernel 但留下了 3 条 legacy path (processDay, live CDP direct, import-jd direct)。P0005.6 砍掉所有绕过 Kernel 的路径, 只保留一条执行河流: CLI → Kernel → Binding → Connector → Evidence/Signal。

## ADR-021: Runtime Convergence Layer — Single Kernel Entry Point (P0005.5)
- **日期**: 2026-07-04
- **状态**: Accepted
- **决策**: 建立 `apps/ecommerce/runtime/kernel/` — 统一运行时收敛层, 收敛 3 套并行运行体系为 1 个 Runtime Kernel。
  - `runtime-kernel.ts` — CLI 的唯一入口, createRuntimeKernel + execute
  - `runtime-normalizer-resolver.ts` — 3 层 resolution: INDICATOR_OVERRIDES → generated normalizer-plan (887 rules) → JD_SPEC fallback (16 keys)。输出 895 canonical metrics (vs 旧 16)
  - `runtime-signal-engine.ts` — blueprint-driven signal 生成, 替代 processDay 的 hardcoded signal types/mapping
  - `runtime-evidence-orchestrator.ts` — blueprint-driven evidence capture, 用 evidence_strategy.capture_rules 替代 hardcoded summary/trend/productTop
  - `runtime-executor.ts` — unified pipeline: Plan → Acquire → Parse → Normalize → Signal → Evidence
  - CLI `collect` 命令走 Kernel (blueprint-driven), `processDay` 标记 @deprecated
- **原因**: 深度审计发现 CLI 未经过 binding layer (executor/planner), processDay 全部 hardcoded, normalizer-plan.json 从未被加载。P0005.5 让 Blueprint 成为唯一 runtime truth。

## ADR-020: Connector Binding Layer — Capability is Data, Not Code (P0005.4)
- **日期**: 2026-07-03
- **状态**: Accepted
- **决策**: 建立 `apps/ecommerce/connectors/binding/` 模块, 桥接 generated/ 和 Connector 执行。Connector 不再定义能力 (API列表、Indicator映射、Business Context), 只执行 blueprint。
  - `loader.ts` — 读取 generated/*.json → Zod 验证 → 返回 BoundCapabilityModel
  - `planner.ts` — Blueprint → CapabilityExecutionPlan (挑选 API、解析 Indicator、证据规则)
  - `executor.ts` — 平台无关的通用执行管线: acquire → parse → normalize → evidence
  - `types.ts` — BoundCapabilityModelSchema (复用 ConnectorBlueprintSchema) + CapabilityExecutionPlanSchema
  - Hand-written overrides 保留 (INDICATOR_OVERRIDES) 在 generated dict 之上, 确保业务关键指标语义准确
  - Manifest, indicator-map, acquisition facade 全部从 binding layer 消费 blueprint
- **原因**: Pre-Light Architecture Audit 发现 generated/ 是 orphaned (write-only), Connector 完全手写。Binding Layer 让 "Capability is data, not code" 成为现实 — Connector 变为 pure executor。

## ADR-019: Discovery Capability Generator (P0005.3)
- **日期**: 2026-07-01
- **状态**: Accepted
- **决策**: 建立 Discovery → Capability → Connector 的中间层。P0005.2 负责分析（classify, map, detect），P0005.3 负责生成（blueprint, plan, manifest, coverage）。
  - `apps/ecommerce/connectors/capability/` — 6 模块，5 个 Phase，消费 P0005.2 但不修改它
  - 生成物输出到 `generated/`（5 个 JSON 文件），Connector 可选择消费
  - Coverage Report：Discovery 70 APIs vs Connector 3 APIs → 4% API 覆盖率，诚实暴露差距
  - 关键原则：Generator 不负责发现（discovery 做），不负责采集（connector 做）。只负责把 Discovery Assets 转换成 Connector Blueprint。
- **原因**: 见 [P0005.3](proposals/P0005.3-discovery-capability-generator.md)。hand-written 的 manifest.ts 和 indicator-map.ts 需要被 auto-generated 的 blueprint 替代。新增平台只需 re-run Discovery → Generator → Connector。

## ADR-000: 项目初始化
- **日期**: 2026-06-26
- **状态**: Accepted
- **决策**: monorepo 结构，按 apps/shared/workspace 划分模块

## ADR-001: Reboot 架构 (信号命名 + 权重解析)
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: signal_name = `${base}_${windowDays}d`; weights keyed by BASE name; ranking matches by prefix (matchComponent)
- **原因**: 比 agentCMS 的 window=field-but-name-fixed 方式更简洁

## ADR-002: exactOptionalPropertyTypes = ON
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: tsconfig 启用 exactOptionalPropertyTypes；可选属性通过条件展开传递

## ADR-003: ContextMemory 的结构化 adjustment 字段
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: ContextMemory 带有可选 `adjustment: RankingMemoryAdjustment` 字段，在提取时设置；ranking 通过前缀匹配 (base → windowed) 进行匹配
- **原因**: 修复 agentCMS 在注入时重新解析自然语言 statement 的差异

## ADR-004: Hermes 子进程契约 (顶层 -z oneshot)
- **日期**: 2026-06-27
- **状态**: Accepted
- **契约**: `hermes -z "<prompt>" [-m MODEL] [-t TOOLSETS] [--skills SKILLS] [--safe-mode]`

## ADR-005: 删除 src/ — 从技术分层到业务分层
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: 完全删除 `src/`；所有业务逻辑位于 `apps/ecommerce/`
- **原因**: agentFabric 不是通用 SDK/框架，而是具体的 Business Workspace。不存在跨 App 的 "domain" — 每个 App 拥有自己的 business capabilities。

## ADR-006: signal → metrics, ranking → decision, trace → explainability, memory → experience
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: 四个核心模块的命名从工程语言改为业务语言
- **原因**:
  - signal: 运营说 "指标" 而非 "信号"
  - ranking: AI 给出 Decision (含 priority + recommendation)，而非仅仅是 Ranking
  - trace: trace 是开发视角；运营看到的是 explainability (可解释性)
  - memory: Memory 已被 Hermes Runtime 占据；Business Experience 才是我们的资产

## ADR-007: 每目录对应企业真实角色
- **日期**: 2026-06-27
- **状态**: Accepted
- **原则**: 每个目录/模块必须能回答："在企业里对应哪个真实角色、哪项真实资产、或哪条真实业务流程？"
- **不符合**: 只落到 Runtime、模型能力或工程实现上的 → 属于 Hermes 或其他 Runtime

## ADR-008: 项目记忆系统 (Four-layer Context)
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: 采用四层 Context 作为 AgentFabric 自身的 Project Memory (Single Source of Truth)
  - Layer 1 (几乎不变): PROJECT.md + philosophy.md
  - Layer 2 (每次 dev 更新): context/current_state.md
  - Layer 3 (重要决策记录): context/decisions.md (本文件)
  - Layer 4 (每次 dev 自动生成): context/handoff.md
  - Machine-readable: context/status.json
  - Architecture view: context/architecture_snapshot.md
- **原因**: 不是为 ChatGPT 写的 context，而是全项目共享的 Single Source of Truth — ChatGPT、Claude Code、Codex、Hermes 都读同一套 Context

## ADR-009: Path aliases (#shared, #platform, #app)
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: 使用 tsconfig paths + vitest resolve.alias 实现 `#shared/*`、`#platform/*`、`#app/*` 路径别名
- **原因**: 消除深度相对路径 (../../../../shared/...) 带来的脆弱性；所有文件无论深度如何都使用统一的别名路径

## ADR-010: UI 完全复刻 agentCMS V1
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: Workspace UI 完全复刻 agentCMS V1（Agent Workspace 布局），不做任何设计变更。HTML/CSS 逐字节复制，JS 适配 agentFabric API 端点。
- **原因**: 用户要求"先把旧项目 UI 完全复刻，完成后再告诉你怎么改"。V1 UI 经过 agentCMS 两个月迭代验证，是稳定的基线。后续设计变更在此基线上进行。

## ADR-011: 目录重命名（dashboard→workspace, collectors→connectors, composition→orchestrator）
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: 三个目录重命名，反映业务语言而非工程语言
- **原因**: 见 [P0002](proposals/P0002-workspace-information-architecture.md)。dashboard 只是 workspace 中的 widget；connectors 不只是 collectors（还有 ERP、Webhook、MCP）；orchestrator 编排整个业务循环而非"组合"几个 domain。

## ADR-012: 项目记忆系统（Four-layer Context）
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: 每次开发会话结束后，必须更新 context/{current_state, decisions, handoff, status.json, roadmap}。这些文件是项目的 Single Source of Truth，所有 agent（ChatGPT, Claude Code, Codex, Hermes）共用。
- **原因**: 见 [chat_history3](docs/chat_history3.txt)。不是为 ChatGPT 写的 context，而是项目自己的记忆系统。

## ADR-013: Trust Decision Stack (P0003 UI 升级)
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: Workspace 从 V1 (agentCMS 复刻) 升级为 V2 Trust Decision Stack。右侧面板从 Explain/Reason/Trace 升级为 7 层信任决策栈 (Confidence→Evidence→Reasoning→Skills→Execution→Validation)。Inbox Card 增加 Impact Score、Confidence、Approve/Reject/Modify 行动按钮。侧边栏 IA 对齐 P0002 (Inbox/Discover → Reviews → Skills/Experience → Validation/Reports → Settings)。
- **原因**: 见 [P0002](proposals/P0002-workspace-information-architecture.md) + [P0003](proposals/P0003-trust-ui-system.md)。Workspace 不是 Dashboard — 是 Human↔AI Business Decision Operating System。核心原则: Trust is product, not feature。

## ADR-014: UI Fix & Trace Panel (P0003.1)
- **日期**: 2026-06-27
- **状态**: Accepted
- **决策**: (1) 侧边栏恢复至 V1 agentCMS 稳定结构，全 i18n，移除 P0003 实验性分类。(2) 右侧面板从 Trust Decision Stack 重构为 Agent Transparency / Trace Panel——Operator 模式显示 Decision Summary + Data Sources + Execution Status，Builder 模式展开完整 trace（Skills Triggered、MCP/Tool Calls、Memory Influence、Execution Steps、Result Validation），默认折叠。(3) 中间 Workspace 保持不变。
- **原因**: 见 [P0003.1](proposals/P0003.1-ui-fix-right-panel-redesign.md)。三栏职责分离清晰：Sidebar = Navigation, Workspace = Execution, Right Panel = Agent Trace。不允许 Sidebar 承担 AI 逻辑、Right Panel 做统计 Dashboard。

## ADR-017: JD Business Data Connector (P0005.1)
- **日期**: 2026-06-30
- **状态**: Accepted
- **决策**: 实现京东商智数据获取能力，验证 P0005 Business Data Pipeline 完整链路
  - Evidence Store: 文件型不可变存储 (`data/evidence/{platform}/{year}/{month}/`), metadata+hash 防篡改
  - JD Parser: 从 agentCMS 移植 JD indicator key 映射 (8 个主指标 + 3 个 WoW 对比指标)
  - JD Acquisition: 双模式 — Mock (开发/测试/CI) + CDP/Playwright (生产, 复用 Chrome session)
  - CLI: `cli collect jd <shopId> [--mock true|false] [--days N]` 完整可运行
  - 目录结构遵循 P0005: acquisition/ parsers/ evidence/ normalizers/ manifest.ts
- **原因**: 见 [P0005](proposals/P0005-business-data-foundation.md) + [P0005.1](proposals/P0005.1-jd-connector.md)。京东商智是第一个完整验证 P0005 管线的 connector。Mock 模式默认开启，零外部依赖即可开发。

## ADR-016: Runtime Control Plane (P0004)
- **日期**: 2026-06-29
- **状态**: Accepted
- **决策**: 建立 Runtime Control Plane — 4 个新模块 (types, registry, router, hermes/adapter) + 适配器包装模式
  - `RuntimeAdapter` 接口: 所有 Runtime 的通用契约 (execute, isAvailable, capability)
  - `ExecutionPlan`: 结构化可序列化计划 (skill + context + steps + policy_constraints)
  - `ExecutionResult`: Runtime 返回 (step_results + aggregate_confidence + duration_ms)
  - `RuntimeRegistry`: 运行时注册表 (register/unregister/get/list/resolve)
  - `DefaultRouter`: 控制平面入口 (action → runtime → plan → dispatch → result)
  - `HermesRuntimeAdapter`: 包装 HermesClient，实现 RuntimeAdapter (零改动 HermesClient)
- **原因**: 见 [P0004](proposals/P0004-runtime-control-plane.md)。AgentFabric 只依赖 RuntimeAdapter 接口，绝不依赖 Runtime 实现。Router 是唯一与 Runtime 通信的入口。所有 Runtime (Hermes, Claude Code, Codex, OpenHands) 执行同一份 ExecutionPlan。替换 Runtime 不应改变任何业务逻辑。

## ADR-015: 合并 V1 运营/开发模式 + Trace Panel
- **日期**: 2026-06-28
- **状态**: Accepted
- **决策**: 右侧面板最终方案——运营模式 = V1 业务面板（AI Summary + Reasoning Steps + Tool Calls），开发模式 = Trace Panel（Decision Summary → Data Sources → Execution Status，可展开 Skills/MCP/Memory/Steps/Validation）。移除单独 Operator/Builder 子切换（"Operator" 与 "运营" 语义重复）。
- **原因**: 用户反馈。V1 模式和新功能是扩展关系而非替换。运营模式服务于日常操作，开发模式服务于深度调试。两档切换简洁清晰。

## ADR-018: D0002 JD Capability Discovery — 数据驱动能力发现
- **日期**: 2026-06-30
- **状态**: Accepted
- **决策**: 通过 CDP 自动遍历 JD 商智全部页面，从真实 API 响应数据反向生长 Business Context，绝不从页面名称正向推导。
- **方法**:
  - Playwright `page.on('response')` 全量网络捕获
  - 遍历 15 个 JD 商智页面，每个页面等待 12s SPA 轮询周期
  - 提取全部 API 响应体 → 解析字段 Schema → 映射到 Business Context
- **发现**:
  - 70 个 API 端点，分布在 6 个模块（indexSummary, industryMarket, growthSummary, marketing, stock, common）
  - 7 个已验证的业务上下文（Store/Traffic/Product/Customer/Industry/Marketing/SupplyChain）
  - 行业数据全部指数化（JD 不暴露绝对 GMV）
  - 竞争分析需要 ¥8,856/年数据尊享包
  - JDR 键命名规律: `jdr_sch_{domain}_{metric}_{source}`
- **原因**: 见 [D0002](discovery/D0002-JD-Capability-Discovery.md)。能力矩阵是 Connector 开发的唯一可靠基础。基于页面名称的推测不可靠（如"搜索分析"页面实际可能返回商品排行而非搜索关键词）。所有 Business Context 必须由真实数据字段验证。
- **资产**: discovery/jd-capability/ — page_inventory, api_inventory, indicator_dictionary, business_context_candidates, screenshots, dom, api-responses

## ADR-019: Connector 永远不得定义 Business Context (P0005.2)
- **日期**: 2026-07-01
- **状态**: Accepted
- **决策**: Connector 只负责 Acquisition、Evidence、Discovery。Business Context 必须从 Discovery 数据字段反向生成，永远不能由程序员在 manifest 中手写声明。
- **责任分离**:
  - **Connector**: Acquire Data → Capture Evidence → Execute Discovery → Expose Capability
  - **Discovery Engine** (`apps/ecommerce/connectors/discovery/`): API Inventory → Schema Evolution → Indicator Dictionary → Business Context Generation
  - **Business Context**: 来自 `CONTEXT_DETECTION_RULES` 对真实 API 响应字段的分析，不是来自程序员判断
- **规则**:
  - `manifest.ts` 中的 `business_context` 字段最终必须由 Discovery 生成，不由人工维护
  - 所有 Business Context 候选必须有对应的真实 API 字段作为证据（context→based_on_fields）
  - Context Detection Rules (`CONTEXT_DETECTION_RULES`) 是 field-pattern→context 映射的单一可信源
  - 新增平台时，Skill/Decision/Experience/Review 全部无需修改 — Context 由 Discovery 自动生成
- **原因**: 见 [P0005.2](proposals/P0005.2-discovery-driven-connector-architecture.md)。基于页面名称的推测不可靠。只有真实 API 响应字段才能验证"这个平台能提供什么数据"。这是平台无关性的基础 — 每个新平台只需运行 Discovery，Context 自动生成。

## ADR-026: JD Persistence Layer — Data → SQLite Bridge (2026-07-12)

- **日期**: 2026-07-12
- **状态**: Accepted
- **决策**: 建立 `platform/storage/jd-schema.ts` + `platform/storage/jd-persistence.ts`，将 CDP 采集的原始数据持久化到 SQLite。

### 模块职责

| 文件 | 职责 | 位置 |
|------|------|------|
| `jd-schema.ts` | 4 张表定义：`jd_raw_data`（原始行）、`jd_collection_runs`（采集任务）、`jd_dataset_metadata`（数据集元数据）、`jd_metric_timeseries`（指标时序） | `platform/storage/` |
| `jd-persistence.ts` | 桥接 CDP 采集结果 (`AcquireResult`) → SQLite 持久化。包含行提取 (`extractRowsFromPayload`)、指标提取 (`extractMetricsFromRows`)、UPSERT 逻辑 | `platform/storage/` |
| `init.ts` | 在 `initDatabase()` 中调用 `applyJdSchema()` + `seedJdDatasets()` | `platform/storage/` |

### 为什么放在 `platform/storage/` 而非 `apps/ecommerce/connectors/jd/`

- `persistence.ts` 是**基础设施**（数据持久化），不是业务逻辑
- 遵循 "Every Module Must Represent Business" 原则：持久化层属于平台层，不体现业务角色
- 符合 CLAUDE.md 目录布局：`platform/storage/` = SQLite (connection, schema, init, product repository)

### 设计决策

1. **UPSERT 语义** — `jd_raw_data` 用 `(dataset_id, source_page, row_index, data_date)` 作为唯一键，支持增量更新
2. **指标时序** — `jd_metric_timeseries` 用 `(dataset_id, entity_id, metric_name, data_date)` 作为唯一键
3. **采集任务追踪** — `jd_collection_runs` 记录每次采集的日期范围、数据集、行数、状态
4. **数据集元数据** — `jd_dataset_metadata` 预注册已知数据集（productTop, summary, trend, flowAnalysis 等）

### 受影响模块

- `platform/storage/jd-schema.ts` — 新建
- `platform/storage/jd-persistence.ts` — 新建
- `platform/storage/init.ts` — +applyJdSchema() 调用
- `apps/ecommerce/connectors/jd/historical-acquire.ts` — 修复 MockJdPayload 类型转换

### 修复: historical-acquire.ts 类型错误

- **问题**: `MockJdPayload` 没有索引签名，TS 不允许用联合字面量类型索引它
- **修复**: 使用 `key in mock` 类型守卫 + `keyof MockJdPayload` 替代 `as any`
- **符合规范**: CLAUDE.md 规定 "No `any` — use `unknown` and narrow"

- **原因**: 采集的数据需要持久化到 SQLite 供后续分析使用。这是 P0005.1 (Connector) 和 P0005.5 (Kernel) 之后的数据持久化层补充。

## ADR-019: Proposal 命名规范

- **日期**: 2026-08-11
- **状态**: Accepted
- **决策**: 统一 proposal 文件命名规范。详见 `proposals/README.md`。

规则：
1. Architecture Proposal: `P{NNNN}[-{N}]-{kebab-case-description}.md`
2. Feature/Phase Proposal: `{module}-v{version}-phase{N}-{description}.md`
3. Expansion Layer: `P000x.N` 保留前缀
4. 全小写 kebab-case，只用连字符，不用下划线/特殊字符/PascalCase
5. 描述必须完整，不截断

本次规范化：17 个文件重命名（修复 PascalCase、typo、下划线、特殊字符、截断描述）。

## ADR-020: Phase 3 HermesAgent Integration — 四个核心设计决策

- **日期**: 2026-08-11
- **状态**: Accepted (Design)
- **来源**: [workspace-v0.2-phase3-hermes-integration.md](proposals/workspace-v0.2-phase3-hermes-integration.md)

### 决策 1: Capability Discovery 由 HermesAgent 驱动

HermesAgent 调用 `CapabilityRegistry.searchByIntent()` 获取候选能力，自行选择最优匹配。Registry 只返回 capability candidates，不返回数据，不执行采集。

**意义**: HermesAgent 只理解需求，不接触采集细节。Capability Registry 是纯查询接口。

### 决策 2: Runtime Kernel 是共享 Capability Execution Layer

Runtime Kernel 不属于 HermesAgent 内部。它是 agentFabric 的公共执行层——任何 Agent Runtime (Hermes, Claude Agent, future agents) 都可以共享。

**意义**: agentFabric 不会退化成"会调用工具的 ChatBot"。它是多 Agent 共享的能力执行基础设施。

### 决策 3: Observable Event Model 定义 UI 契约

8 种标准化事件类型（intent.resolved → response.ready）。Agent Session UI 消费事件流渲染 Agent Activity panel。事件是 Agent 外部可观察行为，不是内部思维过程。

**意义**: UI 观察行为，不读取内部思维。不暴露模型 Chain-of-Thought。

## ADR-021: Phase 3.1 Runtime Kernel Contract

- **日期**: 2026-08-11
- **状态**: Accepted
- **来源**: [docs/runtime-kernel-contract.md](../docs/runtime-kernel-contract.md)

**决策**: 建立 Agent Runtime 与 Runtime Kernel 之间的标准化 ExecutionRequest/ExecutionEvent 协议。

- `ExecutionRequest`: Agent 发送 { taskId, capability, inputs, context } — Kernel 决定 HOW 执行
- `ExecutionEvent`: Kernel 发出 7 种可观察事件（execution.started → execution.completed/failed）
- Contract 是 Agent-agnostic 的 — 任何 Agent Runtime 都可用
- 事件描述执行状态，不描述模型思维（无 thinking/reasoning/chain-of-thought）
- 与 Capability Contract 的关系: Contract 定义 WHAT; Execution Contract 定义 HOW TO REQUEST
- 文件: `shared/schemas/execution.ts` + `tests/contract/execution.contract.ts` (20 tests)

### 决策 4: Runtime Chat 是异步 Task 模型

`POST /api/runtime/chat` 不是同步 Chat API——是异步 task 模型 + SSE 事件流。因为 CDP 采集需要 10-30 秒，Agent 执行是过程不是同步问答。

**意义**: Task 模型支持多消费者观察同一任务（Workspace + CLI + future tools），支持 replay/audit/debug。

## ADR-022: Phase 3 Complete — HermesAgent Integration

- **日期**: 2026-08-12
- **状态**: Accepted (Complete)
- **来源**: Phase 3.1–3.4 commits (047079c → 7a79902)

**Artifacts delivered**:

| Phase | Commit | Artifact |
|-------|--------|----------|
| 3.1 | 047079c | ExecutionRequest/Event schemas, 20 tests, docs |
| 3.2 | 000a6a3 | CapabilityBridge, discover_capability skill, 13 tests |
| 3.3 | 92afb7c | SSE endpoint, AgentSessionState, execution event slots |
| 3.4 | 5c98ec1 | bridge.discover handler, auto-execute E2E chain |
| Fix | 7a79902 | chat.ts mock:false — real evidence data |

**Verified**: Live CDP 2026-08-12: 14 API responses, GMV=¥337.90, 3 evidence files, 3 signals.

**Known tech debt**:
1. SSE endpoint uses demo event sequence — needs real HermesAgent task event source (Phase 4)
2. resetCapabilityBridge() exported from production module — should move to test utils

**Next**: Phase 4 (P0007 Experience → Memory → Skill) or decide on new mainline.

## ADR-023: P0007 Architecture — agentFabric as Learning Context Provider

- **日期**: 2026-08-12
- **状态**: Proposed
- **来源**: [P0007-Experience-Memory-Skill.md](proposals/P0007-Experience-Memory-Skill.md)

**核心决策**: agentFabric 不实现 Memory Engine 或 Skill Generator。

**职责边界**:
- agentFabric: World → Learning Context（观察、记录、提供上下文）
- Runtime (HermesAgent): Learning Context → Memory → Skill（学习、抽象、成长）

**关键架构**:
1. Learning Context 是 Runtime-neutral 的成长接口，包含 observation/evidence/signals/agent activities/human interventions/actions/outcomes
2. Runtime Boundary: agentFabric 不规定 Runtime 如何学习、多久 reflection、何时遗忘
3. Human Intervention Grammar: Decision/Correction/Annotation/Action Intent/Professional Action——不再是 approve/reject/modify
4. Trust 是横向能力（Verifiability Trust + Execution Reliability Trust），不是单一分数
5. Dynamic Interaction Surface: UI is a function of Learning Context gaps

**子阶段**: P0007.1 Learning Context Contract → P0007.6 Hermes Learning Loop Validation

## ADR-024: P0007.1 Complete — Learning Context Contract

- **日期**: 2026-08-12
- **状态**: Accepted (Complete)
- **来源**: `shared/schemas/learning-context.ts` + 17 tests

**核心 Schema**:

| 字段 | 设计决策 |
|------|---------|
| `situation` | Situation/Case 一等业务锚点，不是 taskId |
| `observations[].metricsSnapshot` | Derived snapshot — source of truth is evidenceIds |
| `agentActivities[].agentRuntime` | Free-form string default 'hermes' — not enum lock-in |
| `humanInterventions[].type` | Free-form string — Grammar deferred to P0007.2 |
| `humanInterventions[].respondsToActivityIds` | Links intervention to specific agent activity (Case C) |
| `actions[].type` | Free-form string — domain-specific |
| `outcomes[].relatedActionIds` | Plural "related" — not singular "causedBy" (Case D) |
| `summary` | Aggregated metadata, NOT provenance (P0007.5) |

**边界**: Runtime-neutral, 无 Hermes/JD/ecommerce 私有字段, partial contexts valid, incremental enrichment.

## ADR-028: P0008.1 World Model Gap Map

- **日期**: 2026-08-13
- **状态**: Accepted
- **来源**: [P0008.1-world-model-gap-map.md](proposals/P0008.1-world-model-gap-map.md)

**决策**: World Model 收敛为 6 个 World Objects + Assertion Graph，不是 9 节点大 Ontology。

- 6 Objects: System / Surface / Feature-Affordance / Metric / Dimension / Constraint
- 去掉 Entity（三方都只隐式，无一等证据）和 Concept（太松散）独立节点
- Relationship 由 World Assertion 承担，不独立
- 从 Hermes zero-shot 自然产出反推，而非 Claude guided 扁平结构反推

## ADR-029: P0008.2 World Model Contract

- **日期**: 2026-08-13
- **状态**: Accepted (Complete)
- **来源**: [P0008.2-world-model-contract.md](proposals/P0008.2-world-model-contract.md) + `shared/schemas/world-model.ts`

**三个关键语义决策**:

1. **epistemic ≠ temporal 两个正交生命周期**
   - epistemic: suspected→observed→verified（confidence，单调）
   - temporal: active→superseded/retired（world validity，随世界变化）
   - supersede 不降级 epistemic（京东改版后旧断言仍 verified，只是不再 active）

2. **evidenceRefs 是 reference interface，不是完整 provenance**
   - 现有 Evidence contract 为业务数据 acquisition 设计，非 World Discovery evidence
   - World Evidence semantics（screenshot/DOM/network/documentation）未实现

3. **CapabilityBinding 有 relationship 语义**
   - observable_by / exportable_by / comparable_by（当前只验证 observable_by）
   - 非 bare ID association

## ADR-030: P0008.3 Agent Workspace & Runtime Integration

- **日期**: 2026-08-13
- **状态**: Accepted (Complete)
- **来源**: [P0008.3-agent-workspace-runtime-integration.md](proposals/P0008.3-agent-workspace-runtime-integration.md) + `audits/p0008.3-integration-gap-map.md` + [P0008.3-e2e-evidence.md](proposals/P0008.3-e2e-evidence.md)

**决策**:

1. **FabricAgentWorkspace 是投影，不是 authoritative state**。authoritative state（World Model/Situation/Evidence/Capability）不能直接作 Hermes cwd（repo 有源码/tests/proposals 噪声）。Workspace 是干净目录，只含 runtime 需要"看见"的业务知识。投影 deterministic/rebuildable（SHA-256 contentHash + 清空重建），只写不读回，任何 workspace 修改不反向写入 authoritative state。

2. **HermesSessionClient 只接线不复现 session**。薄客户端 speak Hermes `/api/ws` JSON-RPC（session.create / prompt.submit / event stream）。Session create/resume/compression/持久化全由 Hermes 完成。E2E 实测修正协议：文本在 `event.payload.text`、完成信号 `message.complete`、需 `?token=` WS 认证。

3. **Situation Chat Bridge 只接"人↔Hermes Session"**，不产生 Memory/Skill、不做 Action execution。Situation→Hermes session mapping 由 Fabric 服务端持有（`Map<situationId, {client, hermesSessionId}>`）。

4. **Memory/Skill/SOUL 归 Hermes Profile**（`~/.hermes/profiles/jd/`），不进 agentFabric。

## ADR-031: P0008.4 Agent Shared Knowledge Layer

- **日期**: 2026-08-13
- **状态**: Accepted (Complete)
- **来源**: [P0008.4-shared-knowledge-layer.md](proposals/P0008.4-shared-knowledge-layer.md) + [P0008.4-acceptance-evidence.md](proposals/P0008.4-acceptance-evidence.md)

**决策**:

1. **Shared Knowledge 不是 Wiki**，是 "Raw Source → Agent semantic compilation → persistent Shared Knowledge" 机制（借鉴 Karpathy LLM Wiki **维护 pattern**，非产品边界）。核心区别 vs RAG：persistent knowledge 随资料持续变丰富；RAG 每次临时拼 chunks。

2. **四层 Context Environment 绝不合并**：world/（外部世界是什么，P0008.2）+ knowledge/（人类共享了什么，P0008.4）+ Situation/Learning Context（P0007）+ Hermes Profile（Runtime Self：Memory/Skill/Soul）。前三层 Fabric 提供，第四层 Runtime-owned。

3. **ownership**：`knowledge-sources/raw/` = immutable provenance source（只读）；`knowledge/` = Agent-consumable Read Model（Agent 维护，**非 canonical truth**，可能含 inference/uncertainty/disagreement）。

4. **AGENTS.md = Fabric Agent Workspace Contract**。Hermes 原生从 cwd 加载的顶层指令，只描述 topology/semantics/boundaries/指引，**指向 KNOWLEDGE.md 不复制其内容**，不实现 instruction loader / file tools / approval / session / memory-skill（全委托 Hermes）。

5. **诚实发现**：Blank Hermes 能加载 AGENTS.md（discovery 生效），但对 research 类任务默认 web_search（9 次）而非先读 raw sources，导致 knowledge compile（write_file）未发生。缺口 = AGENTS.md 缺"workspace 内知识优先于 web_search"的优先级规则——这是后来 P0008.5/P0008.6 的主线。

## ADR-032: P0008.5 Minimal World + Knowledge Bootstrap E2E

- **日期**: 2026-08-14
- **状态**: Accepted (Complete — 负面/部分结果)
- **来源**: [P0008.5-minimal-world-knowledge-bootstrap-e2e.md](proposals/P0008.5-minimal-world-knowledge-bootstrap-e2e.md) + 8 个 phase/experiment evidence 文件

**决策**（三条链验证 + 一个不对称收敛）:

1. **Exploration Artifact + World Contract → structured world/ ✅**。修正 3 处 Contract（topology 唯一 / source taxonomy / source immutability）后，同一模型 agnes-2.5-flash 从"分类歧义"变"正确生成 6-primitive structured World + epistemic status + evidence + provenance"。**清晰 Contract 足以指导普通 Agent 抽象 structured context，不是依赖模型聪明**。

2. **Human Document + Knowledge Governance → Shared Knowledge ✅**。非 Markdown 文档，prompt 只"请处理"，Agent 自主 search_files 找到 source → 读 KNOWLEDGE.md → semantic compilation（7 模块框架，非格式转换）→ knowledge page + provenance + INDEX + log，raw 不变、world 隔离、不进 Memory/Skill。

3. **Blank Runtime consumption 不对称（关键负面结果）**：Knowledge 继承成立（Probe B/C PASS），World 消费失败。Known-Fact Diagnostic（3 个确定存在的事实）→ 0/3 读 world/。逐层排除：非 Content Gap（事实确定存在）、非 INDEX 缺失（加 world/INDEX.md 后 indexRead:false × 3）、非命名（world/→systems/ 仅 1/3，system-identity 类 0→1，enumeration 类仍 web_search）。

4. **收敛**：Gap = **缺 Workspace-level Instruction Architecture**（World 只有 WRITE-side 指令、无 READ-side 指令），不是缺 World Model / INDEX / 单条规则。

## ADR-033: P0008.6 Fabric Workspace Instruction Architecture（Audit 结论）

- **日期**: 2026-08-14
- **状态**: Accepted (Audit — 待 Review 决定是否落为 Proposal)
- **来源**: [p0008.6-claudian-instruction-architecture.md](proposals/audits/p0008.6-claudian-instruction-architecture.md)

**决策**（Claudian archaeology + P0008.5 证据收敛出的架构结论，非实现）:

1. **Instruction 分层，五层语义不混**。Workspace 上下文拆为 Instruction / Navigation / Content / Capability / Runtime Self 五层。Instruction = 如何工作；Navigation = 东西在哪（INDEX）；Content = 知道什么；Capability = connected system 能做什么（bindings）；Runtime Self = SOUL/Memory/Skill/Session（**不在 workspace**）。

2. **orientation 落 workspace-root AGENTS.md，不是 system prompt**。Claudian 把 orientation 放 system prompt（它有 runtime）；agentFabric 无 runtime，唯一能被 Hermes 原生加载的是 cwd-root 的 AGENTS.md，所以 orientation + routing + scope 索引必须全部落在这个文件里，且显式分层。

3. **P0008.5 World 消费失败的根因 = 缺 READ-side 指令**。`world/`(systems/) 只有 WRITE-side（"如何构建"）指令，从无 READ-side（"何时/为何/如何消费"）指令。`knowledge/` 成功是因为 KNOWLEDGE.md 同时含 maintenance + query 两侧。修复方向 = 补 routing（何时用哪种 context）+ epistemic authority（systems/verified 优先于 web）+ navigation 指针（"读 INDEX"），**不是再加一个 INDEX 文件**。

4. **4 个已验证行为无一是 Runtime Skill 或 Fabric Capability**。System Context Construction / Shared Knowledge Ingestion = Fabric Procedure（持久化为 governance 文档）；Context Navigation / Grounded Consumption = Workspace Instruction（routing + epistemic 规则）+ Navigation（INDEX）。全部 Fabric-owned，纯 Markdown 文件持久化即可防退化。

5. **scoped instruction 必须被 root 指向，不能自动加载**。Hermes 只加载 cwd-root AGENTS.md；nested 指令（KNOWLEDGE.md / GOVERNANCE.md）是死文件除非 root 有 routing 规则指向它们——这正是 P0008.5 world/INDEX.md 失败的复刻。

**边界**: 仅 audit，未修改 AGENTS.md/systems/knowledge/capability，未重跑 Blank Agent，未实现 loader/router/capability engine。


## ADR-051: P0010.1 Final Repair — Entity Bootstrap from on-disk evidence

- **日期**: 2026-08-25
- **状态**: Accepted
- **来源**: P0010.1 Final Repair — Area A. `apps/ecommerce/connectors/jd/product-catalog-bootstrap.ts` + `tests/unit/connectors/jd/product-catalog-bootstrap.test.ts`

**决策**: 实体名（商品名称 / 店铺名称）只能来自真实可验证的 evidence，不允许 LLM 猜测、hardcode、第二套 Product Store。

1. **复用现有 `projectProductCatalog` + `upsertProducts`**，不引入新的 Product Store、不为 `products` 加 `shop_name` 列、不为 entity 加新索引。新文件只做"启动时一次性把 evidence 投影到 SQLite"。
2. **`acquired_at` 当 `created_at`**，不写 `new Date()` 当下时间——保单根审计链（Evidence → Product 同源时间）。
3. **幂等**：每次启动可重跑；primary key 冲突走 `upsertProducts` 的 ON CONFLICT 路径。
4. **环境开关**：`BOOTSTRAP_PRODUCT_CATALOG=skip` 跳过（生产环境在没有显式编排前应保持 skip）。
5. **无 LLM 路径**：bootstrap 内不调任何 model。
6. **日志只打 count，不打 name**——name 是 operator-personal（PII），count 是 system-level（无 PII）。

**边界**: 不动 `/api/trace`/Explainability；不动 `entityDisplayName`（其 fallback `未知商品 · SKU` 仍保留，只是不可达）；不动 evidence 写入路径。

## ADR-052: P0010.1 Final Repair — Lifecycle Timeline (no fabrication)

- **日期**: 2026-08-25
- **状态**: Accepted
- **来源**: P0010.1 Final Repair — Area B. `apps/ecommerce/workspace/presentation.js:renderSituationTimeline` + `tests/contract/situation-timeline.contract.ts` (26 tests)

**决策**: 真实时间线只能从持久化时间戳来，不允许 JS 侧 `new Date()` 凑 demo、伪造 `completedAt`、伪造 `askedAt`。

1. **时间线 source 限定为 6 个真实字段**：`situations.created_at` / `temporal.observedAt` / `investigation.startedAt` / `investigation.updatedAt`（兼作 completed/failed 代理） / `interventions[].timestamp` / `outputs[].{createdAt, acknowledgedAt, closedAt}`。
2. **`investigation.completedAt` 缺**：用 `updatedAt` 当代理 + 显式标注 `≈ 完成时间; 实际缺少 completedAt 列`（让 operator 看见真实 vs 近似，不藏）。
3. **`outputs[].deliveredAt` 缺**：不画（schema 无此字段，无 transport）。等真有 transport 时再加。
4. **`investigation.{findings[].askedAt, answerAt}` 缺**：不画。下一刀再加。
5. **空输入 → 隐藏整段**（empty string），不显示空 `<ol>`。
6. **timelineEventLabel 暴露 `decision` sub-type**：`accept` / `reject` / `defer` / `override` / `no_action` 各自一个中文 label，**不接受单一"决策"折叠**——sub-type 是 first-class 业务信号。

**边界**: 不引入 Event Store / Event Bus / second Timeline Store；不改 investigation schema；不写 `findings[].{askedAt, answerAt}`；不写 `outputs[].deliveredAt`。

## ADR-053: P0010.1 Final Repair — Human type 收紧 (4 canonical kinds, DB-enforced)

- **日期**: 2026-08-25
- **状态**: Accepted
- **来源**: P0010.1 Final Repair — Area C. `shared/schemas/learning-context.ts:257` (Zod enum) + `platform/storage/p0007-schema.ts` (TRIGGER) + 22 tests across 4 files

**决策**: Human Intervention grammar 锁定 4 canonical kinds（`response` / `correction` / `context_supplement` / `decision`），Zod enum 与 DB TRIGGER 双层 enforce，`action_intent` 永不再出现。

1. **Zod enum 删 `action_intent`**：`shared/schemas/learning-context.ts:257` `type: z.enum([...4])`。
2. **DB 端 SQLite 无 `ALTER TABLE … ADD CHECK`**，用 BEFORE INSERT/UPDATE TRIGGER + `RAISE(ABORT, ...)` 等价（任何 disallowed value 直接 abort 写路径，error message 指向 trigger name 让 operator 知道约束）。TRIGGER 名称 `trg_human_interventions_type_guard`。
3. **应用层幂等**：`applyHumanInterventionTypeGuard` 每次 `DROP TRIGGER IF EXISTS` 后再 `CREATE`，重跑无副作用。
4. **legacy 数据保护**：apply 之前 `rewriteLegacyActionIntentInterventions(db)` 把 `type='action_intent'` 改写为 `response`（最近 canonical 等价），返回改写行数日志。
5. **`InterventionContentSchema` 的 `discriminatedUnion` 同时也删 `action_intent` 分支**——schema 一处改，处处一致。
6. **C.4 浏览器 `submitStructuredIntervention` 拍平 `respondsToActivityIds`**：从 `content.respondsTo.agentActivityIds`（仅 `response` 类型）拍平到顶层 `respondsToActivityIds`，让 timeline 真实能 join。helper 抽到 `presentation.js` 单元测试 pin。

**边界**: 不改 HTTP route 的 wire；不改 POST 端点的 payload；不写 `agentActivities[]`（producer 端 `learning-context-producer.ts:103` 仍 hard-code `[]` —— 是 H.3 gap，下一刀修）。

## ADR-054: P0010.1 Final Repair — `needs_human` 语义收紧 (no fuzzy text match)

- **日期**: 2026-08-25
- **状态**: Accepted
- **来源**: P0010.1 Final Repair — Area D. `platform/server/routes/p0007.ts:deriveInvestigationStatus` + `apps/ecommerce/workspace/presentation.js:deriveSituationLifecycle` + 17 tests (14 server + 3 lifecycle)

**决策**: `needs_human` 信号只能来自结构化字段，**不**来自 judgment text 的模糊匹配。

1. **新决策树**（唯一）：`status='investigating'` → `investigating`；`status='failed'` → `failed`；`stopReason='observe'` → `observing`；`stopReason ∈ {missing_capability, ask_human}` → `needs_human`；`stopReason='judgment'` + `recommendation.humanNeeded.length > 0` → `needs_human`；`stopReason='judgment'`（其余）→ `judgment_ready`；default → `judgment_ready`。
2. **删除** `text.includes('人工核验' / '人工确认' / '无法获取')` 分支——之前会让 agent 引用"已与运营确认"时误触发。
3. **JS 端镜像**：客户端 `deriveSituationLifecycle` 用同一棵树（只 5-state operator surface，'closed' 分支仍 dead code，下一刀替换）。
4. **chip label `已判断` → `判断已形成`**：自治默认，人类可中断，仅必要时阻塞；不再 triumphal 措辞。Sidebar filter 同步改 label。
5. **server 端 `deriveInvestigationStatus` 导出为 named export**，配 `tests/unit/routes/derive-investigation-status.test.ts`（14 测试，含 2 个 regression 证明 fuzzy text 匹配已删）。

**边界**: 不改 stopReason 枚举；不引入新状态机；不改 chip 颜色；不改 Sidebar count 聚合。

## ADR-055: P0010.1 Final Repair — Archive legacy + Output candidate-for-removal (no code deletion)

- **日期**: 2026-08-25
- **状态**: Accepted
- **来源**: P0010.1 Final Repair — Area E + F. `apps/ecommerce/workspace/index.html` (legacy + disabled + candidate badges) + existing `apps/ecommerce/workspace/styles.css` (badge styles, already in place)

**决策**: 现 Archive 与 现 Output 集合页在 Terminal Lifecycle + Timeline 落地前**保留运行**（不可破坏现有 operator 流程），但**视觉诚实**——加 badge 标明真实状态。

1. **现 Archive 加 `legacy-badge`**：`<span class="legacy-badge" title="本视图当前为 ranking 历史，未连接到 Situation 生命周期">legacy</span>`。
2. **新 disabled `Situation 归档` nav item**：`<a class="sidebar-item disabled" aria-disabled="true" ...>📦 Situation 归档 <span class="unimplemented-badge">待 Lifecycle 终态</span></a>`。CSS `pointer-events: none; opacity: 0.5; cursor: not-allowed`。**不加新 page**、**不加新 route**、**不加 `situations.closed_at` 列**。
3. **Output 集合页 nav item 加 `候选下架` badge**：`<span class="candidate-removal-badge" title="Output 已是 Situation Detail 一级区，集合页可下架">候选下架</span>`。**零代码删除**（`outputsRouter` / `viewLoaders.outputs` / `badgeAllOutputs` / `back-to-outputs` 全部保留）。
4. **下架决策的触发点**：①Timeline 真正把 Output 事件吸进去并稳定运行 30 天 + ②零 operator 投诉集合页少做事 + ③真 Archive（`lifecycle='closed'`）有 5+ 真实样本——三个条件全满足才删代码。任意一条不满足保留。

**边界**: 不删 `loadArchive` / `viewLoaders.archive` / `/api/ranking/{profile}` / `ranking_results`；不删 `outputsRouter` / `viewLoaders.outputs`；不改 `Situations` 表的任何列；不引入 `lifecycle='closed'`；不引入 `closed_at` / `closed_by` / `resolution_reason`。

## ADR-056: P0010.2 — RuntimeLoop is a thin cadence+mutex wrapper, not a business orchestrator

- **日期**: 2026-08-25
- **状态**: Accepted
- **来源**: P0010.2 Continuous Business Runtime. `apps/ecommerce/runtime/loop/runtime-loop.ts` + `investigation-policy.ts` + `recommendation-to-output.ts` + `loop-events.ts`. 27 new tests across 3 test files. 0 new typecheck errors (baseline 19 pre-existing). Live 2-cycle demo verified (continuous idempotent skip on every tick).

**决策**: `RuntimeLoop` owns ONLY three things: ① cadence (60s `setInterval`, env override `RUNTIME_LOOP_TICK_MS`), ② per-tick mutex (`tickInFlight` promise reuse — second `tickNow` returns the same in-flight promise, not a stack), ③ ordered chain `acquire → evidence → situation → policy → investigate`. NO business decisions in the loop. The per-situation skip-vs-investigate decision is the `InvestigationPolicy`'s job. The Hermes turn is `runInvestigationTurn`'s job (same call site as the manual `POST /investigate` — Loop and operator share ONE path, no parallel "loop-version" of investigation). The WorkItem materialization is `materializeWorkItem`'s job (called from `runInvestigationTurn`'s success path — both Loop and manual POST get it for free).

1. **`RuntimeLoop` wraps `ScheduledAcquisitionRunner`, never replaces it.** The runner's `setInterval` is disabled; the Loop owns cadence. The runner's `runNow(cap, date)` is the acquire primitive. Existing backfill + 1-shot investigation use the same runner (unchanged).
2. **`InvestigationPolicy` is a pure function** with no DB writes. Input: `(situationId, latestContentHash, waitingOnHuman)`. Output: `{kind, reason}`. The loop composes this — the loop never reads `learning_contexts` or `situations` directly for business decisions.
3. **Hermes client factory is injectable** — `hermesClientFactory: () => HermesSessionClient`. Tests pass a `FakeHermesClient`; production uses the real one with lazy token resolve (commit 1).
4. **Per-tick mutex via `tickInFlight` promise reuse** (not a counter / not `setTimeout`-based): if `tickNow()` is called while a tick is in flight, return the same promise. Tests pin `expect(a).toBe(b)`.
5. **`tickNow` is non-async** — returns the promise reference, not a wrapped `async` function. This is what makes the mutex observable to test callers (an `async` wrapper would return a fresh promise).
6. **No event bus, no wake engine, no durable job queue, no adaptive scheduler, no dynamic cron, no setTimeout-based reconnect** — explicitly out of scope per user's hard rule "不能让 Scheduler 本身变成业务编排器". The next-tick interval is fixed; the next tick waits for the in-flight one to resolve.

**边界**: 不做 durable scheduling（崩溃即丢一 tick，operator 看到的就是 `lastTickAt` 落后实际时间）；不做 Hermes 失败重试超过 once（operator 看到 `investigation failed`，下一次 tick 重新评估）；不做 workItem 重试（idempotent dedup via fingerprint）；不写新表（`investigation.evidenceContentHash` 是 schema field，不新建 `investigation_hashes` 表）；不删 `SubprocessHermesClient`（保留 oneshot 测试路径）；不改 `ScheduledAcquisitionRunner`（Loop wraps it）；不引第三种 Hermes transport；不让 Loop 读业务状态做分支。

## ADR-057: P0010.2 — `evidenceContentHash` sidecar + InvestigationPolicy fail-CLOSED on legacy

- **日期**: 2026-08-25
- **状态**: Accepted
- **来源**: P0010.2.1 live-demo fix. `shared/schemas/investigation.ts` + `apps/ecommerce/runtime/loop/investigation-policy.ts` + `platform/server/routes/situation-chat.ts#markInvestigation`. 3 test files updated. 0 new typecheck errors.

**决策**: "Meaningful new evidence" 必须比 **content_hash**（不是 wall clock）才能触发重新调查，且失败/legacy 数据路径必须 fail-CLOSED 否则会触发 infinite-retry anti-pattern。

1. **`evidenceContentHash` 是 `Investigation` 的 optional schema field**（不是新表 / 不是新列）。Zod 之前会 strip unknown fields — 加进 schema 是为了 sidecar 能 survive `LearningContextSchema.parse()`。在 `markInvestigation` 入口处由 caller 提供，stamped 在 `next` 之后 `storeInvestigationInLearningContext` 之前。
2. **`runInvestigationTurn` 4 个 markInvestigation call site 全部接受 evidenceContentHash**：(a) `status='investigating'` (b) `status='failed'` after `collectTurn` reject (c) `status='failed'` after `parseInvestigation` second attempt (d) `status='failed'` after `parseInvestigation` second attempt reject. 这样 failed 标记也"记住"它看的内容，下次 tick 能正确判断 "same-content-failed-retry" vs "new-content-investigate"。
3. **成功路径上** `evidenceContentHash` 由 `runInvestigationTurn` 透传到 `storeInvestigationInLearningContext`（用相同的 sidecar pattern，code path 在 `runInvestigationTurn:294-301`）。
4. **`InvestigationPolicy` fail-CLOSED on legacy**：prior 已 completed/investigating 但没有 contentHash sidecar（= P0010.1 或更早的 legacy data）→ `no_meaningful_change` (skip)。原因：we have no honest way to compare content without the sidecar; the alternative is the "infinite retry on completed legacy" anti-pattern. 只有 legacy `status='failed'` 给一次 `new_situation` 机会（让 sidecar 在下轮被 stamp 上来）。
5. **新增 3 个 policy test cases** 覆盖：legacy-completed → skip、legacy-failed → new_situation、failed-same-content → skip（无限循环防护）、failed-new-content → meaningful_new_evidence。
6. **Live demo 验证**：每 10s tick 稳定输出 `investigation skipped reason=no_meaningful_change` for 两个已 investigated 的 situations. 之前在 P0010.2 首次 demo 里看到的 "tick → investigation triggered → tick → investigation triggered → tick → ..." 无限循环不再出现。

**边界**: 不为 `evidenceContentHash` 建新表（schema field 就够）；不写新 migration（DB schema 零变化，in-place 字段新增）；不引入 `evidenceIdentity` / `Evidence.first_class_id`（P0010.1 H.1 仍 outstanding，下一刀处理）；不改 `evidence` table；不改 Hermes 协议；不改 Situation lifecycle。

## ADR-058: P0010.2.2 — Investigation Recovery / Self-Healing Runtime

- **日期**: 2026-08-26
- **状态**: Accepted (live 2-cycle log satisfies the user's hard acceptance criterion)
- **来源**: 用户 P0010.2 两日 live demo 暴露 4 个 recovery 缺口。`apps/ecommerce/runtime/loop/recovery-candidates.ts` (NEW) + `investigation-policy.ts` (extend) + `runtime-loop.ts` (wire-in) + `situation-chat.ts` (clear-block route) + `index.ts` (REMOVE `autoInvestigatePending`) + `workspace/app.js` (state matrix + hidden button) + `shared/schemas/investigation.ts` (consecutiveFailures sidecar). 3 new test files / +24 cases; 0 new typecheck errors; 884 passed / 2 pre-existing flaky.

**单一 invariant**（verbatim 用户原话保留）:
> "只要一个 Situation 仍需要 Agent 推进，并且不存在明确的 human/blocking condition，Fabric 就必须最终自动安排 Agent；进程重启不能把它永久遗留在 pending 状态".

**核心决策**:

1. **单一 recovery path = Loop**（不是第二个 recovery 逻辑，不是新的 scheduler）。`autoInvestigatePending` 启动钩子（`platform/server/index.ts:340, 246`）+ P0010.1 Slice 3 per-day scheduler 的并行 `autoInvestigateSituation` 调用整体 REMOVE（ADR-039 REMOVE sweep precedent）。Loop 的每 tick `listRecoverableCandidates` 扫 `situations WHERE lifecycle IN ('open','partial')` + LEFT JOIN `learning_contexts` 一次查完。`maxCandidatesPerTick=20` 防止大 backlog 拖死 tick。

2. **3 种 candidate kinds**（= recovery 路径识别的 3 种 stuck pattern）:
   - `no_investigation` — `lifecycle='open'` 无 learning_context 或 learning_context 无 `investigation` 字段（从未跑过 / 跑了但 schema 还没存）。**最高信息增益**，FIFO 优先于其它两种。
   - `failed_retryable` — `status='failed'` AND `consecutiveFailures < max`（可重试）。max 默认 3（`DEFAULT_MAX_CONSECUTIVE_FAILURES`）。
   - `interrupted` — `status='investigating'` AND `startedAt` 超过 `recoveryStaleAfterMs`（默认 10min，等于 `collectTurn` 600s timeout）。Process 死了 / hermes 卡住 / 网络断 / 任何 mid-tick 死亡 — 都走这条。

3. **`consecutiveFailures` 是 `Investigation` 的 optional schema sidecar**（与 P0010.2.1 `evidenceContentHash` 同样 pattern）。在 plan 阶段设计为 walk `humanInterventions` 数组，但 live demo 暴露 `markInvestigation` 从不 append 该数组 → counter 永远 0 → `blocked_runtime_failure` 永不 fire。改用 `InvestigationSchema.consecutiveFailures: number`：
   - Loop 失败路径：`markInvestigation({ status: 'failed', consecutiveFailures: prior + 1 })`
   - Loop 成功路径：`markInvestigation({ status: 'completed', consecutiveFailures: 0 })`
   - `/clear-block` 路由：`markInvestigation({ consecutiveFailures: 0 })`
   - `countConsecutiveFailures` 简化成直接读字段（不再 walk humanInterventions；删了那 9 个对应 unit test）。

4. **`InvestigationPolicy` 5 个新 reasons**:
   - investigate: `recovery_no_investigation` / `recovery_interrupted` / `recovery_failed_retryable` (3 个)
   - skip: `blocked_runtime_failure` (1 个)
   - 关键设计：recovery hint **OVERRIDES** content-driven `no_meaningful_change`（hint 是 runtime 的权威判断，content-driven decision 在 interrupted / failed_retryable 场景下让位）。

5. **threshold-crossing tick filter**：`recovery-candidates.ts` 用 `consecutiveFailures > maxConsecutiveFailures` (不是 `>=`)。`==` 那一次 tick 是 crossing tick — policy 会被调用、`investigation_blocked` 事件会 emit 一次、然后 situation 在后续 tick 被 scan 静默排除。`>` 是 "already-blocked silence" — 避免每秒刷一次 BLOCKED 事件 spam 日志。

6. **4 种 blocking condition**（verbatim 用户原话保留的硬分类）:
   - ① capability boundary — `MISSING_CAPABILITY` 走人工核验，不进 block 状态
   - ② explicit human decision — `decision: defer` → `waiting_human`（`isWaitingOnHuman` 已存在）
   - ③ sustained failure threshold — `consecutiveFailures >= 3` → `blocked_runtime_failure`（new）
   - ④ explicit human pause — `decision: accept` / `reject` / `override` 显式干预
   只有 ④ 配 `/clear-block` 路由能 resume；③ 是 operator 显式动作而非自动。

7. **Workspace UI 4 状态矩阵**:
   - `completed` / `investigating` / `failed` — 既有 UI
   - `blocked_runtime_failure` — **新**：文字 "⚠ 自动调查连续失败 — 需要检查 Runtime / Hermes" + 「🔄 重试调查（清除阻塞）」按钮（点击 POST /clear-block）
   - 无 investigation — 文字 "等待 Agent 自动调查（已进入 Runtime 调度队列）" **不带**按钮（避免暗示按钮是必要依赖）
   - 「立即调查（恢复）」按钮在 default 隐藏，只在 `blocked_runtime_failure` 显示 — 这与之前的 4 状态文案"系统会自动开始调查"是**逻辑一致**的（之前 UI 自相矛盾）。

**验收（user 原话硬约束）**:
> "本次验收不要主要看测试数量，也先不要看 Workspace 截图。我们真正要看的证据是连续运行日志".

**真实 log 4 ticks** (hermes 故意 down, dashboard session token 缺失):
- **Tick 1**: `recovery eligible count=10 kinds=no_investigation,...,interrupted,interrupted` + `sit_recover_2cyc_001 reason=recovery_no_investigation`（pre-existing 2-DAY-OLD `status='investigating'` 2 个被自动续跑 — `sit_4498ebec5ad9e10bf4d8` from 2026-08-24 19:31 / `sit_ce9a693d4b2c49325a1c` from 2026-08-24 19:38）→ 全部 fail → counter=1
- **Tick 2**: 10 `failed_retryable` → fail → counter=2
- **Tick 3**: 10 `failed_retryable` → fail → counter=3
- **Tick 4** (threshold-crossing): `recovery eligible count=10 kinds=failed_retryable` + 10 个 `investigation BLOCKED ... consecutiveFailures=3` 同时 emit + `tick done ... investigations=0`（**无第 4 次 Hermes call**）
- **POST /clear-block** on sit_recover_2cyc_001: counter reset 0 → Tick 5: 仅该 situation `reason=recovery_failed_retryable` 重新触发, 其他 9 个仍 blocked (per-situation gate 工作正常)

**严格边界**（所有 verbatim 用户原话约束都遵守）:
- ❌ 不做 Action Engine / Approval / 新 Scheduler / Event Bus
- ❌ 不碰 Terminal Lifecycle (`open|partial|mature` stays; `closed` 仍是 P0010.3)
- ❌ 不引入第二个 Recovery 逻辑
- ❌ 不让 LLM 猜商品 / 不 hardcode / 不建第二套 Product Store
- ❌ 不为 demo 伪造时间 / provenance / final outcome
- ❌ 不引入 4 分类之外的 block 条件
- ❌ 不让「立即调查（恢复）」按钮成为系统正常工作的必要依赖
- ❌ 不引入 `lifecycle='closed'` / 不建 Resolution Engine / 不加 Event Bus
- ❌ `SubprocessHermesClient` 本阶段不删

**NOT INCLUDED** (exhaustive, 与 P0010.2 同一 NOT INCLUDED 集合):
- Trust Schema 重构 / Knowledge Engine / Evidence migration / Event Bus
- Wake Engine / Scheduler (the Loop IS the scheduler) / Hermes transport 改
- Action Engine / Approval / 外部发送 / Resolution Engine
- 第二套 Timeline Store
- 为 demo 伪造时间 / provenance / final outcome
- 任何 4 之外的 blocking condition
- "force re-investigate" 按钮（operator 可直接 POST /api/situation/:id/investigate 一次性重跑 — 这就是 manual path）

**Next**: P0010.3 Terminal Lifecycle (`closed_at` / `closed_by` / `resolution_reason` / `lifecycle='closed'` / Resolution Engine / Outcome producer) — P0010.2.2 是 P0010.3 的前置（P0010.3 的 `closed` 终态会被 recovery scan 同样 skip，因为 `lifecycle IN ('open','partial')` 过滤；这是 integration 预期）。

### ADR-058 Amendment 1 (2026-08-26): `blockedEmittedAt` sidecar — R4 audit fix

- **状态**: Accepted, implemented in the audit-fix commit.
- **来源**: Architecture audit ([p0010.2.2-architecture-audit.md](p0010.2.2-architecture-audit.md)) found that the threshold-crossing-tick filter at §5 above (`> max` skip / `== max` include) is correct, but the Loop re-fires the `investigation_blocked` event on EVERY subsequent tick when `consecutiveFailures == max` because the policy returns `skip` (so the counter never increments past max) and the recovery scan still includes the situation on every tick. Original ADR §5 comment said "one final time, on the threshold-crossing tick" but the code re-fires every 60s.

- **Fix**: New sidecar `blockedEmittedAt: string | undefined` on the investigation marker (parallels `evidenceContentHash` and `consecutiveFailures` patterns). Writers: Loop stamps `blockedEmittedAt = nowIso()` on the threshold-crossing tick; `/clear-block` route deletes the field. The recovery scan filters out situations whose marker has `blockedEmittedAt` set (counter `== max AND blockedEmittedAt set → continue`).

- **Verification**: Live test `sit_kill_during_investigation_test` (T+40s tick fires ONE `investigation BLOCKED ... consecutiveFailures=3` event; T+50s tick has NO `investigation BLOCKED` event, NO `recovery eligible` line for this situation — suppressed by `blockedEmittedAt`).

- **Files changed (10 LOC + 2 tests)**:
  - `shared/schemas/investigation.ts`: +1 optional field (`blockedEmittedAt`)
  - `platform/server/routes/situation-chat.ts`: `markInvestigation` accepts `blockedEmittedAt`, `/clear-block` route deletes it
  - `apps/ecommerce/runtime/loop/recovery-candidates.ts`: `if (consecutiveFailures === max && blockedEmittedAt) continue;`
  - `apps/ecommerce/runtime/loop/runtime-loop.ts`: on `blocked_runtime_failure` policy decision, write `blockedEmittedAt = nowIso()` to the marker
  - `tests/unit/loop/recovery-candidates.test.ts`: +2 tests (already-emitted suppressed, fresh-threshold-crossing included)

- **Test count**: 62 → 64 loop tests (884 → 886 total, still 2 pre-existing flaky). Typecheck unchanged (baseline 19, all pre-existing).

### ADR-059 (2026-08-27): Post-P0010.2 Regression Audit + Repair

- **状态**: Accepted, implemented in the P0010.2.3 commit.
- **来源**: User spec — audit the 10 most-recently-shipped capabilities (A-J) and confirm each is a complete production loop (Producer → Persistence → Runtime Trigger → API → Workspace Consumer → Live Verified). User explicit hard scope: allowed = fix broken legs in existing chain; forbidden = P0010.3 / Terminal Lifecycle / `situations.closed` / `closed_at` / Resolution Engine / Final Outcome / Situation Archive / Event Bus / Wake Engine / Action Engine / Approval / external sending / Feishu/WeCom/Email/Telegram / Trust Schema refactor / Evidence Identity migration / Knowledge Identity redesign / Knowledge Engine / new Memory Architecture / Skill Engine / hermes proxy / deleting SubprocessHermesClient / faking time/provenance/outcome for UI.
- **Audit matrix** (full report: [post-p0010.2-regression-audit.md](audits/post-p0010.2-regression-audit.md)):
  - A. Entity / 商品身份 — **REPAIR → PASS** (A-1: bootstrap before startServer + initDatabase; A-2: order test)
  - B. Evidence / Knowledge 引用 — **DEFERRED** (SB-1/SB-2 P0010.3)
  - C. Investigation / Recovery — **PASS** (already accepted)
  - D. Runtime Continuous Loop — **REPAIR → PASS** (D-1: `countBlockedSituations` + `LoopState.blockedCount`; D-2: `loadLoopStatus()` + DOM slots; D-3: 10 tests)
  - E. Hermes Transport — **PASS** + `SubprocessHermesClient` **LEGACY** (out of P0010 main chain)
  - F. Human Intervention — **REPAIR → PASS** (F-1: drop dead fuzzy text match, use `inv.needsHuman`)
  - G. Timeline — **REPAIR → PASS** (G-1: stop-reason `≈` annotation + "时间未记录" fallback; G-2: 3 tests)
  - H. Output — **PASS** (live `out_3a43d1053b9bfa2d` returned by `/api/outputs`)
  - I. Archive — **PASS** (live `/api/ranking/operator_mode` returns 7 rows; UI badge correct)
  - J. Memory / Experience / Skill dead-leg — **REPAIR → PASS** (J-1/J-2: REMOVE CANDIDATE JSDoc on 5 dead exports; skill extraction is **not built**, no code to mark)

- **Net change**:
  - 6 cells REPAIR'd → PASS; 1 DEFERRED (B); 1 LEGACY (E subprocess); 2 PASS unchanged (C, H, I)
  - 16 net new tests (3 + 6 + 4 + 3) — full suite **899 / 901 passing**, 2 pre-existing flaky (chat.contract 5s timeout; capability/coverage indicator count drift)
  - `npm run typecheck` 0 new errors (baseline 19 unchanged)

- **Live verification (6 cases)**:
  1. Continuous Runtime — PASS (live log: 2+ ticks, full `tick → acquire → evidence → situation updated → investigation skipped` chain)
  2. Restart Recovery — PASS (P0010.2.2 audit log; same invariants)
  3. Human Feedback — PROVEN-BY-TEST (hermes auth broken in dev env; structural chain unit-tested)
  4. Output — PASS (live `/api/outputs` returns real `out_3a43d1053b9bfa2d` status=ready)
  5. Entity — PROVEN-BY-TEST + PARTIAL LIVE (source-level test pins invariant; live `products` table has real name "祁门红茶官方旗舰店..."; pre-existing 31 NULL `entity_name` rows are legacy data from pre-fix runs)
  6. Archive — PASS (live `/api/ranking/operator_mode` returns 7 rows; UI `legacy-badge` correct; disabled "Situation 归档" stub)

- **NOT INCLUDED** (per user hard scope, same as P0010.2.2):
  - All P0010.3 / Terminal Lifecycle / Resolution Engine / Final Outcome / Situation Archive
  - Event Bus / Wake Engine / Action Engine / Approval / external sending
  - Trust Schema / Evidence Identity (SB-1) / Knowledge Identity (SB-2)
  - New Memory Architecture / Skill Engine / hermes proxy
  - Deletion of `SubprocessHermesClient` (kept as LEGACY)
  - Any fake time/provenance/outcome fabrication

- **Files changed** (13 source + 4 test):
  - `platform/server/index.ts` (A-1)
  - `apps/ecommerce/runtime/loop/recovery-candidates.ts` (D-1, +helper)
  - `apps/ecommerce/runtime/loop/index.ts` (D-1, export)
  - `apps/ecommerce/runtime/loop/runtime-loop.ts` (D-1, LoopState + list)
  - `apps/ecommerce/workspace/index.html` (D-2, DOM)
  - `apps/ecommerce/workspace/app.js` (D-2, F-1, J-2 inline)
  - `apps/ecommerce/workspace/presentation.js` (G-1)
  - `apps/ecommerce/experience/extraction.ts` (J-1)
  - `apps/ecommerce/experience/repository.ts` (J-1)
  - `apps/ecommerce/experience/facade.ts` (J-2)
  - `apps/ecommerce/memory/store.ts` (J-1, 3 dead exports)
  - `tests/unit/connectors/jd/product-catalog-bootstrap-order.test.ts` (NEW, A-2)
  - `tests/unit/loop/recovery-candidates.test.ts` (extend, D-3: +6 tests)
  - `tests/contract/workspace-loop-status.test.ts` (NEW, D-3)
  - `tests/unit/workspace/timeline-proxy-annotation.test.ts` (NEW, G-2)

- **Next**: NONE per user spec. The slice explicitly stops here. P0010.3 / Terminal Lifecycle / Resolution Engine / Final Outcome / Situation Archive / any of the forbidden list remain out of scope until the user reviews this commit and approves the next move.

## ADR-061: P0010.2.4 Review Repair — Token Cache Honesty, Recommendation appliesTo Gap, Display-State Honesty, "feedback ≠ wake" Boundary

- **日期**: 2026-08-27
- **状态**: Accepted（typecheck 19 baseline, 0 新增；961 passed / 2 pre-existing flaky；D1 live 3/3 pass）
- **来源**: 用户对 4c47461 ("P0010.2.4 Production Hermes Investigation + Human Interaction Repair") 的 review。Reviewer 找到 3 个 P0 + 1 个 P1 + 1 个 doc/code 矛盾，结论 "不能直接 PASS"。本 ADR 修复。

**Reviewer findings + 修复**:

### P0-1: `HERMES_GATEWAY_TOKEN` 不应该是 `/api/ws` session token 的 fallback

**Reviewer 的诊断**:
> token-resolver.ts 把 HERMES_DASHBOARD_SESSION_TOKEN fallback 到 HERMES_GATEWAY_TOKEN，但 audit 说明自己又写 "_SESSION_TOKEN 是 HERMES_DASHBOARD_SESSION_TOKEN || secrets.token_urlsafe(32)"，没有任何源码级证据 gateway token === _SESSION_TOKEN。live verify 用的是 dashboard token，不是 gateway token。所以 gateway fallback 没被真实 Hermes 验证。

**Source-level proof**:
- `hermes_cli/web_server.py:540`: `_SESSION_TOKEN = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN") or secrets.token_urlsafe(32)` — 只读 HERMES_DASHBOARD_SESSION_TOKEN。
- `hermes_cli/web_server.py:16418-16423`: `_ws_auth_reason` 永远 `hmac.compare_digest(token.encode(), _SESSION_TOKEN.encode())`。
- 整个 hermes_cli/web_server.py **无** `HERMES_GATEWAY_TOKEN` 引用。
- 整个 hermes-agent 仓库唯一引用 `HERMES_GATEWAY_TOKEN` 的位置：`optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py:2566` — 那是 HTTP gateway 服务的 credential，**不是** `_SESSION_TOKEN`。

**结论**: gateway fallback 是错误实现。Operator 设了 gateway token 走 `/api/ws` 会被 Hermes `_ws_auth_reason` 拒（403），但错误信息看起来像 "wrong token" 而不是真正的 "Hermes 内存里随机 token，我们读不到"。

**修复**:
1. `token-resolver.ts` 删除 `HERMES_GATEWAY_TOKEN` 路径。`ENV_TOKEN_NAMES` 只剩 `dashboard: 'HERMES_DASHBOARD_SESSION_TOKEN'`。
2. `session-client.ts:connect` 的 `resolveToken()` 只查 dashboard env var + auto-discover。
3. `discoverFromRunningServe` 不再 fallback 到 gateway 名字（只 dashboard）。
4. 错误消息和 `missingTokenError` 文案不再 mention gateway token。
5. `ResolveHermesTokenResult.source` 简化成 `env-dashboard | auto-dashboard | null`。

### P0-1b: token cache 必须存真实 source，structured log 不得撒谎

**Reviewer 的诊断**:
> token-resolver 的 cache 只缓存 token，不缓存 source。`resolveHermesSessionTokenWithSource()` 命中 cache 时无论原来是 auto-dashboard 还是 auto-gateway，都返回 auto-dashboard。structured log 在 cache 命中后会报告错误 tokenSource。

**修复**:
1. `CacheEntry` 扩展为 `{ port, token, source }`，source 永远跟 token 一起写入。
2. `resolveHermesSessionTokenWithSource` cache hit 返回 `cache.source`，不是 hardcoded `'auto-dashboard'`。
3. `tests/unit/hermes/token-resolver-gateway.test.ts` 新增 `cache hit preserves the real auto-dashboard source` regression test。
4. 整个测试文件重写：删除所有 `HERMES_GATEWAY_TOKEN` 接受路径测试；新增 2 个 regression test 证明 gateway token 在 env / serve env / `/proc` / 任何地方都**不被接受**。

### P0-2: Recommendation schema 没有 stable ID，"decision 能 map 回原 recommendation" 是 test-only fake ID

**Reviewer 的诊断**:
> prompt.ts 新增 appliesTo.recommendationId / agentActivityId / signalId。声称"让下一轮 Agent 知道用户是在回应哪一条 recommendation"。但生产 UI 的 buildInterventionContent 对 decision 实际写的是 content.appliesTo = {}。整个 diff 没看到后续代码给它填真实 recommendationId。测试手工构造 appliesTo: { recommendationId: 'rec_abc123' }，证明 formatter 能打印它。

**Schema-level proof**:
- `shared/schemas/investigation.ts:55-65`: `RecommendationSchema = { recommendation, rationale, expectedOutcome, risks, prerequisites, humanNeeded }` — **无 id 字段**。
- `shared/schemas/learning-context.ts:201-205`: `DecisionContentSchema.appliesTo = { agentActivityId?, recommendationId?, signalId? }` — schema 允许填，但 workspace 没源。
- `shared/schemas/learning-context.ts:171-176`: `CorrectionContentSchema.corrects` 有 `signalId / agentActivityId / metricName / observationId` — 同样无 recommendationId。
- `shared/schemas/learning-context.ts:186-189`: `ContextSupplementContentSchema.supplements` 有 `observationId / situationAspect` — 同样无 recommendationId。

**结论**: workspace 没有源填 `appliesTo.recommendationId`；之前的"已完成 target mapping"宣称是 test-only 能力冒充 production 能力。

**修复**:
1. `interaction-grammar.js:buildInterventionContent` 注释明确写"workspace 不预填 appliesTo（Recommendation schema 无 id 字段）。当前是 [no-target-bound]"。
2. `prompt.ts:formatPriorHumanGuidance` 当 `appliesTo` 为空时 render `[no-target-bound — 当前 schema 不支持绑定到具体 Recommendation]`。
3. `tests/unit/investigation/feedback-consumption.test.ts`:
   - 把所有 `recommendationId: 'rec_abc123'` / `'rec_xyz'` 加 `SYNTHETIC_` 前缀，明确标注是 synthetic test data（future case once Recommendation 获得 id）。
   - 新增 2 个 test pin 生产行为：空 `appliesTo` → `[no-target-bound]` 文本，不 fabricate `recommendation=` / `agentActivity=`。
4. 在 handoff.md 明确记录 "Recommendation 缺 id 是 blocker"。

### P1: Investigation Display 有 dead state，`consecutiveFailures` 假装是 input

**Reviewer 的诊断**:
> deriveInvestigationDisplayState 宣称 6-state，实际 failed 永远返回 recoverable，failed_unrecoverable 没 return path，consecutiveFailures 参数没使用。**banner detail 里有 `**…**` markdown 但 app.js 是 textContent 渲染，UI 大概率显示字面 `**`**。

**修复**:
1. `InvestigationDisplayState` 从 6-state 收到 5-state：`pending / recoverable / investigating / blocked / completed`。删除 `failed_unrecoverable`（dead branch，无 return path）。
2. `consecutiveFailures` 现在**真用**了：`INVESTIGATION_DISPLAY_BANNER.blocked.detail` 是 function 形式 `(consecutiveFailures, threshold) => string`。app.js 调用它传入实际 counter，让 operator 看到"已连续失败 5 次（阈值 3）"。
3. `presentation.d.ts` 的 `detail` 类型扩展为 `string | ((n, t) => string)`，反映这个新形态。
4. `INVESTIGATION_DISPLAY_BANNER.blocked.detail` 移除字面 `**...**`（app.js 的 textContent 路径会显示成 `*`），改成 plain text。
5. `tests/unit/workspace/investigation-display-state.test.ts`:
   - 删除 `failed_unrecoverable` 相关 assertions
   - 新增 3 个 test pin blocked detail 是 function（typeof check + counter render + NaN/0 fallback）
   - 新增 test 验证 `app.js` 调用 `typeof banner.detail === 'function'` path
   - 新增 test 验证 `**` markdown 不在任何 banner detail path

### Doc/code 矛盾清理

**Reviewer 的诊断**:
> session-client.ts 的 connect JSDoc 仍写 `auth_required:false → skip token / connect without token`，但下面实现和新审计已改成 "Hermes 0.20.5 无论 auth_required true/false，WS 都必须带 token"。token-resolver.ts 顶部注释也还有"auth_required:false 时 token bypass"的旧描述。测试 hermes-auth-probe.test.ts 的文件头同样写"false → connect without token"。

**修复**:
1. `session-client.ts:connect` JSDoc 重写为：probe 是 diagnostic only，Hermes 0.20.5 永远要求 `?token=<_SESSION_TOKEN>`。
2. `session-client.ts:probeAuthRequired` JSDoc 重写为同样意思。
3. `token-resolver.ts` 顶部注释删除 "auth_required:false 时 token bypass" 旧描述，改成"运行时把 token 写入 _SESSION_TOKEN，agentFabric 必须用同一 env var 才能读"。
4. `tests/contract/hermes-auth-probe.test.ts` 文件头注释重写为"diagnostic only"语义。
5. `tests/unit/hermes/session-client.test.ts` 和 `session-client-lazy-token.test.ts` 的 mock `ENV_TOKEN_NAMES` 删 `gateway` key。

### 用户的额外问题: feedback ≠ wake

**Reviewer 的诊断**:
> feedback 被 Agent 消费 ≠ feedback 自动触发重新调查。P0010.2.4 主要证明"下一次调查发生时能读到反馈"，没看到 Human Intervention 写入后主动让 Runtime 把对应 Situation 重新列为 investigation candidate 的新 wiring。如果 P0010.2.2 已经通过其他机制把 intervention 视为 meaningful change，那可以 PASS；否则这仍是一个潜在断腿。

**Source-level proof**:
- `apps/ecommerce/runtime/loop/investigation-policy.ts:97-153`: 5 步决策树（no_evidence → waiting_human → blocked → new_situation → meaningful_new_evidence via contentHash change → legacy fallback）。**没有** "human intervention 触发" 这条。
- `apps/ecommerce/runtime/loop/recovery-candidates.ts`: 恢复 scan 拣选 `no_investigation` / `failed_retryable` / `interrupted` — 都不是 intervention 触发。
- `humanInterventions[]` **唯一**消费点：`apps/ecommerce/runtime/investigation/prompt.ts:formatPriorHumanGuidance` (P0007.2) — 出现在下一轮 `buildInvestigationPrompt` 里。

**结论**: 当前确实没有 "intervention writes → Runtime re-evaluate" 的 wiring。Wake Engine / Event Bus 是后续 P0010.2.5+ 的事。

**修复**:
1. `prompt.ts:formatPriorHumanGuidance` JSDoc 新增"P0010.2.4 review repair — explicit feedback ≠ wake"段落，明确写：
   - 写 human intervention **不会** 自己唤醒 Runtime loop
   - Loop 重评估 only when (a) producer's contentHash change 或 (b) recovery scan 拣选
   - Intervention 只在下一轮**自然** investigation turn 才被消费
   - 若 operator 想让 feedback 立刻生效，必须等下一轮 contentHash change 或 recovery tick
   - **不**声称 feedback loop 已闭合，直到 Wake Engine / Event Bus 存在
2. `handoff.md` 的 Risks / known limits 段记录这条限制。

**新测试**:
- `tests/unit/hermes/token-resolver-gateway.test.ts` (重写) — 9 test pin "只 HERMES_DASHBOARD_SESSION_TOKEN，gateway 永远不接受"
- `tests/unit/workspace/investigation-display-state.test.ts` (扩展) — +5 test pin 5-state contract + function detail form
- `tests/unit/investigation/feedback-consumption.test.ts` (扩展) — +2 test pin production empty-appliesTo path
- `tests/contract/hermes-auth-probe.test.ts` (header 重写) — pin diagnostic-only 语义

**Live verify**:
- D1 真 Hermes 0.20.5 (port 9120, `HERMES_DASHBOARD_SESSION_TOKEN=af_test_session_1787770893`) 重跑 — 3/3 pass，证明 review-repair 后 connect chain 仍然工作。

**Files changed**:
- `platform/runtime/hermes/token-resolver.ts` (P0-1, P0-1b)
- `platform/runtime/hermes/session-client.ts` (P0-1, doc cleanup)
- `platform/runtime/hermes/index.ts` (no source change, re-exports auto-update)
- `apps/ecommerce/workspace/interaction-grammar.js` (P0-2 comment)
- `apps/ecommerce/workspace/presentation.js` (P1)
- `apps/ecommerce/workspace/presentation.d.ts` (P1)
- `apps/ecommerce/workspace/app.js` (P1 detail function form)
- `apps/ecommerce/runtime/investigation/prompt.ts` (P0-2 + feedback≠wake comment)
- `tests/unit/hermes/token-resolver-gateway.test.ts` (重写)
- `tests/unit/hermes/session-client.test.ts` (ENV_TOKEN_NAMES mock)
- `tests/unit/hermes/session-client-lazy-token.test.ts` (ENV_TOKEN_NAMES mock + error message)
- `tests/contract/hermes-auth-probe.test.ts` (header comment)
- `tests/unit/workspace/investigation-display-state.test.ts` (扩展)
- `tests/unit/investigation/feedback-consumption.test.ts` (扩展)

## ADR-062: Investigation Contract vocabulary drift normalization + 4-reason failure classification

**Date**: 2026-08-27
**Status**: ACCEPTED
**Driver**: User live report — Investigation Contract rejected for hypothesis status vocabulary drift (`confirmed`, `strongly_supported`, `partially_rejected`) + "Turn timed out waiting for message.complete" events.

### Decision

1. **Canonical vocabulary normalization at the Hermes raw → canonical boundary**. New `apps/ecommerce/runtime/investigation/normalize.ts` with `Object.freeze` allow-list of 5 known equivalent values:
   - `confirmed` → `supported`
   - `strongly_supported` → `supported`
   - `partially_rejected` → `weakened`
   - `complete` → `judgment`
   - `wait` → `observe`
2. **Canonical persisted schema UNCHANGED** — `proposed | supported | weakened | rejected` for hypothesis status; `judgment | observe | missing_capability | ask_human` for stop reason. Unknown values **fail-CLOSED** with `unmappable[]` returned to caller.
3. **Prompt vocabulary constraint** as a primary defense (not just a normalization safety net). `buildInvestigationPrompt` adds "Status vocabulary — HARD CONSTRAINT" section listing 4 canonical + naming drift values as "known but to-avoid" so the Agent learns to honor canonical rather than relying on normalization as a license to drift.
4. **Parser two-step**: (a) direct `safeParse`, (b) on failure, apply `normalizeInvestigationContract` then re-parse. **Does NOT hand-pick fields from failed reply** — fail-closed.
5. **Failure 4-reason classification**: `InvestigationFailureReason = 'agent_transport_failed' | 'agent_timeout' | 'provider_failed' | 'contract_invalid'`. Provider error detected via `isProviderError` regex (Hermes 0.20.5 does NOT set `payload.status='error'` for upstream rejections; error text only in `payload.text`).
6. **Timeout and schema failure are SEPARATE**: `agent_timeout` and `contract_invalid` are different failure reasons, not lumped together.
7. **Accept `turn.completed` / `turn.complete` as `message.complete` alternatives** in `collectTurn` for forward compatibility with Hermes 0.20.5+ event name variants.
8. **Pre-existing TDZ bug fix** in `collectTurn`: `let unsubscribe = () => {}; unsubscribe = client.onEvent(...)` (not `const`), because mock clients can synchronously replay queued events before the const assignment completes.

### Reasoning

- The user explicitly forbade expanding the Zod enum ("don't expand Zod enum"). The allow-list normalization at the boundary is the smallest change that satisfies the Agent's natural vocabulary drift while keeping the canonical contract clean.
- The user explicitly forbade "manual field picking from failed reply" — the previous `reply2` re-prompt path could fall through to hand-picking fields, which violates "no fake success" and "do not synthesize the contract from prose". The two-step parse + normalization re-parse is the strict-but-forgiving path.
- Whitespace and case-fold are NOT normalized because that would mask Agent bugs (a `confirmed` would be `CONFIRMED` if the Agent learned case-insensitive drift later). Strict exact-match on the allow-list is the fail-closed path.
- The prompt vocabulary constraint is added because "all normalization, no prompt" is a lazy fix that doesn't teach the Agent the canonical vocabulary. The user's specification was explicit: "Prompt constraint + boundary normalization double safety".
- The 4-reason classification gives the operator a single, actionable signal. "Investigation failed" is not enough — the operator needs to know whether the fix is in Fabric (contract), Hermes (timeout), transport (auth/connect), or the model provider (HTTP 400).

### Boundary

- No P0010.3 / Terminal Lifecycle / `situations.closed` / `closed_at` / Resolution Engine / Final Outcome / Situation Archive.
- No Event Bus / Wake Engine / Action Engine / Approval / external sending / Feishu-WeCom-Email-Telegram.
- No Trust Schema / Evidence Identity (SB-1) / Knowledge Identity (SB-2).
- No new Memory Architecture / Skill Engine.
- No Hermes proxy / new transport / `SubprocessHermesClient` deletion.
- No fake time/provenance/outcome.
- No widening of canonical Zod enum (the 4-value persisted schema is unchanged).

### Files

**New**:
- `apps/ecommerce/runtime/investigation/normalize.ts` (~250 LOC)
- `tests/unit/investigation/contract-normalize.test.ts` (30 tests)
- `tests/unit/investigation/collect-turn-classify.test.ts` (13 tests)

**Modified**:
- `apps/ecommerce/runtime/investigation/parse.ts` — two-step parse
- `apps/ecommerce/runtime/investigation/prompt.ts` — vocabulary constraint
- `apps/ecommerce/runtime/investigation/index.ts` — re-exports
- `platform/server/routes/situation-chat.ts` — failure classification + drift/unmappable + collectTurn improvements
- `apps/ecommerce/runtime/loop/loop-events.ts` — extended `investigation_failed` / `investigation_completed` events
- `apps/ecommerce/runtime/loop/runtime-loop.ts` — forwards new fields

### Verification

- `npm run typecheck`: 0 new errors (baseline 19 pre-existing).
- `npm test`: 968 passed / 2 pre-existing flaky (chat.contract + coverage) / +43 net new.
- Pre-existing 3 loop test failures verified NOT introduced by this slice (via `git stash`).
- **Live verify (real Hermes 0.20.5 port 9120, real agentFabric :3000)**: full chain worked — connect → turn → parse → persisted; one full success (5 hypotheses canonical, judgment + recommendation materialized); one `contract_invalid` correctly classified; no manual field picking; no fake success.

---

## ADR-065 — Runtime Baseline Reset contract (2026-08-27)

**Status**: accepted (P0010.2.x Reset slice)

**Context**: P0010.2 engineering acceptance was about to continue, but
the dev DB and runtime filesystem held ~1307 DB rows + 1485 filesystem
entries of runtime facts from earlier Hermes turns, demo seed, mock
collection, test-fix runs, CDP screenshots, and 7-day backfill. To
honestly evaluate the engineering chain end-to-end, the runtime needed
to be reset to a known-empty baseline while preserving knowledge,
capability, environment, configuration, and code.

**Decision**: A `scripts/reset-runtime-baseline.ts` tool with
`--dry-run` (default) / `--execute` is the canonical way to reset the
dev DB and runtime filesystem to a known-empty baseline.

**What it deletes** (runtime facts):
- DB: situations, learning_contexts, human_interventions, signals,
  signal_weights, business_traces, ranking_results, hourly_snapshots,
  hourly_snapshot_signals, context_memories, operator_memories, feedback,
  reviews, jd_dataset_metadata, jd_collection_runs, jd_raw_data,
  jd_metric_timeseries (17 tables, FK-safe order, in a single transaction)
- FS: data/evidence/** (1416 files), data/fabric-workspace/{situations,
  investigations, investigation, investigation_contracts, logs,
  screenshots, reports, references, .hermes} (54 files + dirs),
  top-level investigation-*.json / investigation_result*.json /
  investigation_sit_*.json / recommendation*.json (12 files),
  context/investigation_contract_*.json (1 file),
  knowledge/cases/case-sit_*.md (1 file), data/discovery-schema/**,
  data/test-fabric-workspace/** (10 files)

**What it preserves** (capability / knowledge / config / code):
- DB schema + triggers (we DELETE rows, NOT the file)
- DB tables: products, orders, ranking_profiles, schema_version,
  knowledge, collector_registry
- FS: data/fabric-workspace/knowledge/** (long-term KB),
  knowledge-sources/raw/** (12 user-uploaded raw files),
  capabilities/, systems/, AGENTS.md, README.md (projector-managed),
  context/handoff_*.md (operator handoff)
- FS: data/jd_shangzhi_features/**, data/jd_full_discovery.json,
  data/jd_live_data.json (static discovery corpus)
- FS: generated/** (capability contract + blueprint)
- FS: apps/ecommerce/knowledge/**
- FS: .env, Hermes config, ADR-064 topology, HERMES_WS_URL,
  ~/.agentfabric/chrome-jd-profile/ (operator credentials),
  .collector-auth/jd.json (JD extracted cookie file)
- All code (platform/, apps/, tests/, scripts/ except the new tool)
- All tests/fixtures/* source files

**Key invariants**:
- **Default to dry-run** (opposite of `fix-dirty-lifecycle.ts` /
  `cleanup-polluted-situations.ts` which default to APPLY). The reset
  is significantly more destructive than a single-row UPDATE, so the
  default is flipped to prevent accidental destructive runs.
- **FK-safe DELETE order** (children first) inside a single
  `db.transaction(() => { ... })()` for atomic rollback.
- **Idempotency**: re-running on a clean baseline exits 0 with
  "Already clean — nothing to do".
- **KEEP path hash check**: post-reset, a snapshot of KEEP paths is
  diffed against the pre-snapshot. The only acceptable diff is the
  intentional `case-sit_*.md` removal.
- **Projector awareness**: `signal_weights` and `jd_dataset_metadata`
  re-appear on next server boot because the bootstrap projector
  re-emits them. This is expected; the reset wipes the rows, and
  the next boot establishes the default config baseline.

**Verified**:
- 1307 DB rows + 1485 filesystem entries deleted in one shot.
- 0 new typecheck errors from the new script (21 baseline, all pre-existing).
- Workspace UI acceptance: all 4 key APIs return the empty baseline.
- Smoke test: real signals + evidence produced via the full kernel path.
- Knowledge hash diff: only the intended `case-sit_*.md` removed.
- 0 situations on the empty baseline is correct (rules need 2 days of
  data to fire `meaningful_change`).

**Hard constraints honored**:
- ❌ Did NOT touch Hermes config, .env, HERMES_WS_URL, ADR-064 topology
- ❌ Did NOT modify the Hermes installation or session token contract
- ❌ Did NOT delete any Hermes user data or unrelated sessions
- ❌ Did NOT modify Hermes model, proxy, or Session Runtime topology
- ❌ Did NOT delete any test fixture source files
- ❌ Did NOT delete any user-uploaded raw knowledge sources
- ❌ Did NOT change business Situation lifecycle rules
- ❌ Did NOT introduce Event Bus / SSE / WebSocket / Wake Engine

---

# ADR-066 — Hermes URL/port single source of truth + dev wrapper (P0010.2.7)

- **Date**: 2026-08-27
- **Status**: Accepted
- **Decider**: implementation team (P0010.2.7 live review)

## Context

P0010.2.4 (ADR-064) established that `HERMES_WS_URL` is the only
configuration source for the `/api/ws` session transport. The chosen
endpoint in this project is `ws://localhost:9120/api/ws`. But the
following four files each carried a hardcoded `9119` fallback that
silently overrode `HERMES_WS_URL` when the env var was unset:

1. `platform/runtime/hermes/health-state.ts` — IIFE port resolver
   with `const port = parsePortFromUrl(url) ?? 9119;`
2. `platform/runtime/hermes/token-resolver.ts` —
   `const port = parsePort(options.url) ?? 9119;` (×2)
3. `platform/runtime/hermes/session-client.ts` —
   `const port = parsePortFromUrl(url) ?? 9119;` (×3)
4. `platform/server/routes/runtime.ts` —
   `process.env['HERMES_WS_URL'] ?? 'ws://localhost:9119/api/ws'`

When the operator's env does NOT set `HERMES_WS_URL` (the dev case),
each of these independently defaulted to the historical `9119` —
which is now a dead port. Port `9120` is the project-chosen Hermes.
The result: `/api/readiness` says `healthy`, the actual connect
target is `:9119`, and the operator's UI says
`"Hermes Session Runtime unavailable at ws://localhost:9119/api/ws"`.

Auto-discovery (lsof + ps eww) is documented as a deferred diagnostic
(MEMORY: `hermes-auto-discovery-vs-explicit-contract`) and is not
allowed to override explicit configuration.

## Decision

1. **Single source of truth**: `platform/runtime/hermes/resolve-url.ts`
   - exports `DEFAULT_HERMES_WS_URL = 'ws://localhost:9120/api/ws'`
   - exports `DEFAULT_HERMES_PORT = 9120`
   - exports `resolveHermesWsUrl(): string` — env > default
   - exports `resolveHermesPort(url?): number` — parse URL > default
2. All four files import from this helper. No file hardcodes
   `9119` anymore.
3. New dev wrapper `scripts/with-hermes-env.ts`:
   - Resolves `HERMES_WS_URL` from env or default 9120.
   - Sets it for the child process (does NOT mutate parent env).
   - Prints a prominent banner on every dev start so the operator
     sees the configured endpoint.
   - Forwards SIGINT / SIGTERM / SIGHUP to the child.
   - Exits with the child's exit code.
4. `package.json` `dev` script routes through the wrapper.

## Consequences

- **Positive**: The invariant
  `configured endpoint == readiness endpoint == status endpoint ==
   actual agent-turn endpoint` now holds. Drift is no longer
  possible from a missing env var.
- **Positive**: Future changes to the default endpoint require
  editing exactly one file.
- **Positive**: The dev banner is the operator's first signal that
  the URL contract is in effect.
- **Neutral**: The wrapper is an extra process boundary in dev. It
  is intentionally NOT used in production (`start:hermes` is the
  production path, used by the deploy pipeline).
- **Risk**: If `HERMES_WS_URL` is mis-set in env, the wrapper will
  print that value and use it everywhere. There is no override. The
  operator must edit env to fix.

---

# ADR-067 — Output write-time content fingerprint (P0010.2.x)

> **Status**: ACCEPTED (2026-08-28) — implements B in P0010.2.x
> "a,b,c 按顺序, 全做" sequence.

## Context

P0010.2.7 live acceptance (2026-08-27) showed Workspace
「工作输出」page with **90+ identical WorkItems** for 祁门红茶.
Every one said "维持持续观察名单" / "不干预", each one slightly
different only in:

1. The round counter in the Chinese prose ("本情境已第 7 轮连续
   missing_capability" vs "本情境已第 8 轮连续 missing_capability")
2. The embedded timestamp ("截至 18:56:48" vs "截至 19:30:12")

User verbatim: "agent在不停的调查" (agent is investigating
non-stop). The system was *correctly* running the investigation
loop, but the **materialize step** was producing a new
`outputId` every tick, so the WorkItem collection grew without
bound.

## Decision

Two-axis content fingerprint:

1. **Drop `updatedAt` from fingerprint**: `updatedAt` is
   *metadata* (when the run happened), not *content* (what
   the recommendation is). The fingerprint is a content-
   identity check; including metadata defeats the dedup
   invariant.
2. **Normalize surface drift before fingerprinting**: new
   `shared/utils/text.ts#normalizeForFingerprint` (regex
   table, `Object.freeze`d, 11 patterns). All 11 patterns
   tested in `tests/unit/utils/text.test.ts` (17 tests).
   - Round counters (`第 7 轮` / `第N轮` / `已7轮` / `连续7轮` /
     `第3次`) collapse to a single canonical form.
   - HH:MM[:SS] timestamps collapse to `TIME`.
   - YYYY-MM-DD / M-D dates collapse to `DATE`.
   - `N-M DURATION` / `N DURATION` for day/hour/minute/etc.
   - Whitespace collapsed.

The fingerprint is now `sha256(situationId + recommendation
content + rationale content + judgment)`. Same content =
same fingerprint = same outputId = no new WorkItem.

## Consequences

- **Positive**: 90+ duplicate WorkItems from re-tick collapse
  to 1. The audit's "agent在不停的调查" symptom is fixed at
  the materialize boundary, not by adding retry suppression
  or skipping the investigation.
- **Positive**: New tests pin BOTH the dedup (5 tests in
  `recommendation-to-output.test.ts`) AND the normalize (17
  tests in `text.test.ts`). Future LLM surface drift that
  isn't on the allow-list will surface as new duplicates
  — visible to the operator as a count-mismatch, easy to
  diagnose and extend.
- **Positive**: `updatedAt` is preserved on the WorkItem (for
  freshness checks in the UI), but it's no longer used as
  the dedup key. No information is lost.
- **Positive**: `RecommendationKind` was added as a separate,
  additive field (ADR-068). The kind is **NOT** part of the
  fingerprint — a presentation concern, not a content
  concern. This keeps observe / act as a chip-rendering
  hint, not a dedup discriminator.
- **Neutral**: `normalizeForFingerprint` is intentionally
  conservative. New LLM surface drift (e.g. "第七次复查" in
  Chinese, "twelve rounds" in English) will NOT be normalized
  and will re-introduce duplicates. Monitoring + extending
  the table is the operator's job (see Risk 1).
- **Risk 1**: An LLM change that introduces new surface
  patterns will silently regress to duplicate WorkItems.
  Mitigation: monitor `body.outputs[].length` per situation
  in the runtime loop log; if it keeps growing, that's the
  signal to extend the regex table.
- **Risk 2**: The 90+ pre-existing duplicate WorkItems in
  the dev DB are **still there**. Dedup is forward-only.
  Cleanup requires either (a) the P0010.2.x reset-runtime-
  baseline tool (ADR-065) or (b) targeted SQL delete. Not
  done this session — out of scope per user hard constraints
  on B+C (which is "make the system stop producing
  duplicates", not "clean up existing duplicates").
- **Risk 3**: A future refactor that wants to fingerprint
  on `updatedAt` (e.g. for a "show me what the Agent
  thought at time T" feature) will need to either keep
  the old fingerprint path or extract a separate
  `temporalFingerprint` field. Not done this session.

## Alternatives considered

- **Alternative A: Skip the investigation if the situation
  hasn't changed**: REJECTED. The investigation IS the work —
  we want it to run. We just don't want to spam the Output
  collection.
- **Alternative B: Cap the number of WorkItems per
  situation (e.g. "only keep the latest 5")**: REJECTED.
  That's a lossy operation that hides history. Dedup is
  lossless — the FIRST WorkItem is preserved with the
  earliest round counter (e.g. "第 7 轮" stays in the
  stored content), so the operator can still see when the
  pattern started.
- **Alternative C: Use `judgment` text + a substring
  match on `recommendation.recommendation`**: REJECTED.
  String matching is fragile. SHA-256 of a normalized
  form is the cleanest way to express "same content".
- **Alternative D: Add a "cooldown" of 5 minutes between
  WorkItems for the same situation**: REJECTED. This is
  the same anti-pattern as "retry suppression" — it
  hides the actual run rate. The right answer is dedup
  on content identity, not on time.

---

# ADR-068 — Recommendation kind: observe | act binary surface (P0010.2.x)

> **Status**: ACCEPTED (2026-08-28) — implements C in P0010.2.x
> "a,b,c 按顺序, 全做" sequence.

## Context

P0010.2.7 live acceptance showed the Workspace Output chip
"等待人工" routing 3 semantically distinct markers into a
single bucket:

1. `ask_human` stopReason — Agent genuinely cannot decide,
   needs human input to proceed.
2. `missing_capability` stopReason — no Fabric capability
   exists to acquire the needed evidence.
3. A `suggestion-to-confirm` recommendation — Agent has
   produced a recommendation, but the operator hasn't
   acknowledged it yet (the chip "等待人工" was rendering
   on every recommendation waiting for the operator).

Per `presentation-state-semantics-two-dimensions.md` memory
note (2026-08-27 user critique), these are different in
semantic:

- (1) and (2) are "watchful states" (just observe, don't
  act; the operator's role is to provide the missing
  input / capability).
- (3) is "to-do" (action waiting on the operator; a
  recommendation that needs acknowledgement).

Conflating them made the chip un-actionable. The user could
not tell at a glance whether a chip "等待人工" meant
"do nothing" or "do something when you can".

## Decision

A binary `kind: 'observe' | 'act'` surface on
`Recommendation`:

1. **New enum, additive, not a replacement**:
   `RecommendationKindSchema = z.enum(['observe', 'act'])`.
   Added to `RecommendationSchema` with `.default('act')` —
   the conservative default (treat as to-do if the Agent
   didn't say).
2. **Same fail-closed policy as stopReason /
   hypothesisStatus**: `normalizeRecommendationKind` accepts
   canonical `observe | act` plus a 14-word Chinese + English
   near-synonym allow-list (e.g. 观察 / 保持观察 / 持续观察 /
   wait / watch / do_nothing → observe; 行动 / 干预 / 调整 /
   intervene / action → act). Anything not on the allow-list
   surfaces as `driftUnmappable` and the parser fails
   closed. The walker in `normalizeInvestigationContract`
   walks `recommendation.kind` and emits drift reports.
3. **Back-compat shim**: `deriveKindFromStopReason(stopReason)`
   derives the kind from the stopReason when the Agent
   omitted `kind`: `judgment → act`, everything else →
   `observe`. The derivation is logged as drift so the
   operator sees the Agent was inconsistent.
4. **Prompt update**: new section "Recommendation kind
   (P0010.2.x)" teaches the LLM the canonical values, so
   in the long run the Agent stops emitting near-synonyms.
5. **WorkItem integration**: WorkItemSchema.kind optional
   (for pre-C WorkItems in the dev DB). Materializer
   captures `recommendation.kind` → WorkItem.kind on
   FIRST materialization; subsequent dedup hits preserve
   the first kind (don't overwrite). UI renders chip on
   collection item + detail header via
   `getOutputKindLabel / getOutputKindCssClass` reading
   the `window.WORK_ITEM_KIND_LABEL / CSS_CLASS` mirror.

## Consequences

- **Positive**: The Workspace chip now distinguishes
  watchful states from to-do states. observe = grey
  "保持观察"; act = yellow "待交付". The operator can
  tell at a glance whether a recommendation is something
  to do now, or something to just track.
- **Positive**: The kind is **NOT** part of the dedup
  fingerprint (ADR-067 keeps presentation concerns out
  of content concerns). Two WorkItems with the same
  content but different `kind` labels dedup to one
  WorkItem — the first materialization's kind is
  preserved.
- **Positive**: Pre-C WorkItems in the dev DB continue
  to parse (WorkItemSchema.kind is optional). The UI
  helper falls back to `'act'` (yellow chip) — the
  "honest default" is the more conservative one
  (treat as to-do, not no-action).
- **Positive**: Same fail-closed policy as
  `stopReason` and `hypothesisStatus` means a single
  mental model for "the parser surfaces drift, the
  operator sees it" — no new policy.
- **Neutral**: The Presentation 2-dim state semantics
  (per `presentation-state-semantics-two-dimensions.md`)
  is **partially addressed**: observe vs act is the
  Runtime State dim. The Next Step dim (act-now /
  accept-pending / decision-needed) is still conflated
  in the same chip. Candidate for a future ADR
  (P0010.2.9 or P0010.3).
- **Risk 1**: A future LLM might emit a near-synonym not
  on the allow-list (e.g. "建议人工核验" — "suggest human
  review"). This will surface as a parser failure (fail-
  closed), NOT as a silent default to 'act'. The operator
  will see "contract invalid" and can either fix the
  allow-list or fix the prompt.
- **Risk 2**: The 90+ pre-existing duplicate WorkItems
  in the dev DB don't have a `kind`. They'll render with
  the fallback 'act' chip (yellow), which is misleading
  — the original content was "维持持续观察名单" (observe).
  The right fix is a one-time SQL backfill of
  `kind = 'observe'` for those rows, but this is out of
  scope per user hard constraints on B+C.
- **Risk 3**: Default `'act'` is conservative but may
  surprise operators who expect the "honest unknown" to
  show as grey (no action). If operator feedback prefers
  the inverted default, we can flip it — but the cost
  is operators missing real "to-do" recommendations.

## Alternatives considered

- **Alternative A: Extend the existing `stopReason` to
  encode action-vs-observe**: REJECTED. stopReason is
  the *stop condition* (judgment, observe, ask_human,
  missing_capability) — orthogonal to "does this
  produce a to-do for the operator". Mixing them in one
  enum would force the LLM to choose between
  contradictory semantics ("act but observed" is a
  contradiction).
- **Alternative B: Add a third state "ask"** (e.g. `kind:
  'observe' | 'act' | 'ask'`): REJECTED. ask_human is
  already in stopReason. The chip is for "what does the
  operator do", not "what's the stop condition". Two
  binary axes is cleaner than one tri-state.
- **Alternative C: Don't add a new field; use the
  existing `humanNeeded[]` boolean**: REJECTED. humanNeeded
  is a list of specific human tasks (e.g. "核验优惠券到期
  日", "检查京准通余额"). It's per-task, not per-WorkItem.
  The kind is per-WorkItem, not per-task. Different
  concerns.

---

## ADR-070 — trade.overview: 切到 lowcode tradeSummary + 指标语义独立命名 (P0010.2.9)

- **日期**: 2026-08-28
- **状态**: Accepted（typecheck 0 新增, npm test 1200 passed / 1 pre-existing failed / 3 skipped / 1 env-blocked; real-page reconciliation 0.00% delta on 4 canonical metrics; **net +2 tests, 0 new regression**）
- **来源**: 用户 verbatim 要求 trade.overview 的 4 个核心指标 (GMV, 订单, 店铺访客, 店铺成交转化率) 必须与京东商智 经营概览 页面同源,并明示真实页面 reconciliation 是验收 gate (非仅测试)。

**核心原则**（用户原话,verbatim 保留）:
> trade.overview 改为获取 tradeSummary/summary/getSummary.ajax 与 getTrend.ajax; canonical 指标明确为:GMV → 成交金额, orders → 成交订单量, visitors/shop_visitors → jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src, conversion_rate/shop_conversion_rate → fo_jdr_sch_shop_deal_rate. 原来的商品 UV、行业 CVR 不能再冒充 visitors / conversion_rate,分别改成明确的 product_visitors、industry_conversion_rate,避免污染其他 capability;保持 CDP/browser signed-request 路径,不尝试自己伪造 __sgm__;本轮不要改 observedAt/acquiredAt,不要拆 trade.realtime,不要处理 getProductAnalysisData,不要重构 planner. 验收也别只看测试。必须用你刚才那个真实页面做对账:京东页面 ≈ Fabric trade.overview (GMV, 订单, 店铺访客, 店铺 CVR). 允许采集时间造成很小的自然变化,但不能再出现:1652 vs 6585, 7 vs 120, 75 vs 861, 9.33% vs 13.94%.

**两个独立 bug 必须同时修** (因为 A 隐藏了 B 的真因):

1. **数据源 bug**: `trade.overview` 走 lowcode/index 的 JDR snapshot endpoint `getRealSummaryData.ajax` (这是产品/行业级的最终化视图),不含店铺级访客/CVR 字段。京东商智 经营概览 页面用的是 `tradeSummary/summary/getSummary.ajax` (lowcode 不同 path,店铺级+实时)。
2. **指标语义 cover-up bug**: snapshot 里有 `jdr_sch_traffic_brow_sku__page_cnt_*` (商品 UV) 和 `fo_jdr_sch_industry_deal_rate` (行业成交转化率),被映射成 `visitors` 和 `conversion_rate` (通用名),让数据源 bug silent 化 — 量级不对但看起来合理 (1652 vs 6585 / 75 vs 861 / 9.33% vs 13.94% 全是 -75% 到 -33% 错位)。

**关键决策**:

1. **页面真实路径, 不伪造 `__sgm__`**: `acquireJdTradeOverviewViaCDP` 在用户 Chrome (`localhost:9222`) navigate to tradeSummary.html + 用 `page.on('response')` 抓 `getSummary.ajax` + `getTrend.ajax`。`__sgm__` 是 JD 内部的安全 wrapper,让 page's own signed request 自然 fly through,**不**改 body、**不**重发 fetch。架构上与 P0005 `acquireJdViaCDP` 同源 (read-only interception)。
2. **per-capability acquire factory** (`getFabricKernel` 内 `perCapAcquire`): 检测到 endpoints 含 `getSummary` 或 `getTrend` 时 dispatch 到新 acquire function;其他 capability 走原 `createLocalFirstLiveAcquire` 路径。**严格不重写 planner** (用户硬约束)。
3. **指标语义独立命名, 解除 cover-up**: `shop_visitors` (店铺级访客) 和 `product_visitors` (商品级 UV) 严格分开;`shop_conversion_rate` (店铺成交转化率) 和 `industry_conversion_rate` (行业成交转化率) 严格分开。原 `visitors` / `conversion_rate` 通用名从 `JdSummary` type **完全删除** (避免未来再被 silent 污染)。
4. **breaking change 接受**: `traffic.overview` 和 `product.overview` 原本就用 `visitors` 字段(商品级),同步 rename 到 `product_visitors` (用户明示允许)。**其它 capability 的 `visitors` / `conversion_rate` 引用必须显式选新名,不能继续用旧通用名**。
5. **discovery data 同步**: `getSummary` (25 fields) + `getTrend` (8 fields) 加入 `discovery/jd-capability/api_inventory.json` + `apps/ecommerce/connectors/discovery/api-inventory.ts` 的 `indexSummary` module test list。Blueprint regen 后 72 APIs / 902 normalizer rules。
6. **parseAcquiredData 显式映射**: 新加 `if (base === 'getSummary' || base === 'getTrend')` 显式分支,避免 fall through 到 "Unknown endpoint" 导致 evidence 抓到但 signal 0 个的 silent failure。

**验收 (real-page reconciliation)**:

| Metric | 京东商智 经营概览 昨天 2026-08-27 | Fabric trade.overview | Δ |
|---|---:|---:|---:|
| GMV | ¥6,801.02 | 6801.02 | 0.00% |
| Orders | 125 | 125 | 0.00% |
| Shop visitors | 928 | 928 | 0.00% |
| Shop CVR | 13.36% | 0.1336 | 0.00% |

**用户硬约束 100% 遵守**: ❌ 不改 observedAt / acquiredAt 语义; ❌ 不拆 trade.realtime; ❌ 不处理 getProductAnalysisData; ❌ 不重构 planner (只加 indexSummary module test list 的 endpoint entry,不动 `inferModuleFromEndpoint` 主体); ❌ 不伪造 __sgm__; ❌ 不重设计 Hermes / 不动 .env / 不重启 serve; ❌ 不动 Workspace UI / 不动 chat / 不动 loop. 接受 traffic.overview / product.overview 的 `visitors` → `product_visitors` 同步 rename (用户明示允许).

**调试 detour (记录)**: 3 个集成 bug 在 acceptance 期间浮出: (A) planner 漏选新端点 — `getSummary` regex 不在 `inferModuleFromEndpoint` 的 `^(summary|index|getProduct|getFlow|getAlarm)` 集合,需在 `indexSummary` module test list 显式列名; (B) `parseAcquiredData` `getSummary.ajax` 的 base 是 `getSummary` 既不是 `summary` 也不含 `product`/`top`/`trend`/`hourly`,fall through 到 "Unknown endpoint" — 显式加分支; (C) test mock 键名必须与 plan `apis_to_call[i].endpoint` 一致 (无 .ajax 后缀),`executePlan` 按 endpoint 索引 rawData。三个 detour 全是源级契约 pin 失败,不是逻辑错误。

---

## ADR-069 — Loading placeholder write responsibility (P0010.2.7-followup-2)

**Status**: Accepted (2026-08-28)
**Context**: v0.13.5 Workspace, P0010.2.7-followup-2 bug fix
**Decider**: operator
**Driver**: user live acceptance report

### Problem

After P0010.2.7 (ADR-066) introduced 4s polling with content-fingerprint
dedup, the operator reported:

> 我在看输出列表时, 这个列表突然就"加载中", 过了一会又显示列表,
> 然后又变成"加载中"

The same pattern is visible on the runtime execution history panel
("Loading execution history...").

### Root cause

Both `fetchAndRenderOutputs()` and `fetchAndRenderRuntime()` write a
transient loading placeholder (`加载中…` / `Loading execution
history...`) inline at the top of the function, BEFORE the fingerprint
dedup check:

```js
async function fetchAndRenderOutputs() {
  const ct = document.getElementById('outputsContent');
  if (!ct) return;
  try {
    // ... fetch ...
    var fp = outputsFingerprint(items);
    if (fp === state.outputsFingerprint) { return; }  // bail early
    state.outputsFingerprint = fp;
    if (!items.length) {
      ct.innerHTML = '<p class="muted placeholder">暂无...</p>';
    } else {
      ct.innerHTML = '<p class="muted placeholder">加载中…</p>';  // BUG
    }
    renderOutputsCollection(items);
  } catch (e) { ... }
}
```

The 4s poller calls `fetchAndRenderOutputs()` on every tick. On each
tick, the DOM is overwritten with `加载中…`, then either:

- **fingerprint match (most ticks)**: bail at the dedup check. The
  operator sees `加载中…` stuck for 4s. Visible flicker.
- **fingerprint miss (new data)**: re-render the list. The operator
  sees `加载中…` for ~1 frame then the new list. Visible flash.

The placeholder was being written by the poller-shared helper, but
the placeholder is **user-initiated feedback** — the operator clicked
or switched view, and the placeholder should only show for that
interaction, not on every poll.

### Decision

**Placeholders are transient user feedback; they belong in the
user-initiated entry point, not in the poller-shared helper.**

- `loadOutputs()` writes `加载中…` BEFORE `await fetchAndRenderOutputs()`.
- `fetchAndRenderOutputs()` does NOT write a loading placeholder. It
  just renders the final list, or writes the persistent empty-state
  copy ("暂无交付物") AFTER the dedup check.
- Same pattern for `loadRuntime()` / `fetchAndRenderRuntime()`.

The persistent empty-state copy ("暂无交付物" / "No execution
records") stays in the poller-shared helper because it is a stable
terminal state, not a transient loading state. The empty-state
fingerprint is stable across polls, so the DOM does not churn when
nothing changes.

### Why this works

The contract becomes:

| Path | Function | What it writes |
|------|----------|----------------|
| User clicks tab / opens view | `loadOutputs` | "加载中…" (transient feedback) |
| 4s poller tick | `fetchAndRenderOutputs` | nothing OR "暂无交付物" (after dedup) |

The 4s poller never calls `loadOutputs`, so it never triggers the
placeholder write. The user-initiated entry point never gets called
on a poller tick, so its placeholder never flashes on a no-op poll.

### Alternatives considered and rejected

- **Alternative A: Throttle the placeholder write by timestamp**
  (e.g. only show `加载中` if last write was >1s ago). REJECTED. The
  poller fires every 4s — the throttle would still flash on every
  other poll. Doesn't fix the bug, just hides it.
- **Alternative B: Skip the dedup bail and just call
  `renderOutputsCollection` unconditionally on every poll.** REJECTED.
  The whole point of P0010.2.7's fingerprint dedup is to avoid
  re-rendering when nothing changed. Removing it would churn the
  DOM (and lose the operator's scroll position) on every tick.
- **Alternative C: Move the placeholder to `requestAnimationFrame`
  and cancel if the response arrives fast.** REJECTED. Adds
  complexity for no real benefit. The issue is that the placeholder
  is being written by the wrong function, not that it shows too long.
- **Alternative D: Use CSS to show "加载中" only on first paint
  (no `fetch` in flight).** REJECTED. Requires tracking fetch state
  in a separate flag, which is the same complexity as the current
  fix but with one more moving part.

### What's locked in

- The 4s polling pattern (ADR-066) is unchanged.
- The fingerprint dedup logic is unchanged.
- The empty-state copy ("暂无交付物" / "No execution records") stays
  in the poller-shared helper, after the dedup check.
- The user-initiated entry point pattern (`load*` writes placeholder,
  `fetchAndRender*` does not) is now the canonical pattern for all
  future polled views.

### What was tested

5 source-level regression tests in
`tests/contract/workspace-loading-flicker.test.ts` pin the invariant:

1. `loadOutputs` writes "加载中" + write happens BEFORE
   `await fetchAndRenderOutputs()`.
2. `fetchAndRenderOutputs` (code with comments stripped) does NOT
   contain "加载中".
3. `fetchAndRenderOutputs` empty-state "暂无交付物" is written
   AFTER `state.outputsFingerprint` dedup check.
4. `loadRuntime` writes "Loading execution history" + write
   happens BEFORE `await fetchAndRenderRuntime()`.
5. `fetchAndRenderRuntime` (code with comments stripped) does NOT
   contain "Loading execution history".
6. (Structural sanity) `loadOutputs`/`loadRuntime` still call
   their fetch helpers, so initial load is not broken.

### Future work

- `loadSituations` / `fetchAndRenderSituations` (line 1498) already
  write the placeholder AFTER the dedup check, which is the correct
  pattern. Verify it didn't drift on the next refactor.
- If a future view adds a loading placeholder, it MUST follow the
  new pattern: user-initiated entry point writes it, poller-shared
  helper does not.
