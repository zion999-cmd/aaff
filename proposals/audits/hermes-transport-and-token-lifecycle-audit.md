# Hermes Transport & Token Lifecycle Audit (post-f7e64fc)

- **日期**: 2026-08-25
- **类型**: 只读 Hermes Transport + Token Cache Lifecycle Audit
- **核心问题 1 (Transport)**: agentFabric 当前所有通往 Hermes 的 production code path 是 oneshot（`hermes -z` 子进程）还是 sessionful（`/api/ws` WebSocket）？P0008.3 → f7e64fc 的迁移进行到什么程度？
- **核心问题 2 (Token Cache)**: f7e64fc 引入的 token auto-discovery cache 在 24/7 部署下能不能活？`hermes serve` 重启 / token rotate / `hermes serve` 启动晚于 agentFabric 时，cache 会不会 stale？
- **事实优先级**: 实际代码 > API > Tests > Proposal / context docs
- **范围**: 跟 [runtime-execution-chain-audit.md](./runtime-execution-chain-audit.md) (2026-08-25) 配对，那份回答「链路上每跳的真实触发点」，这份回答「Hermes 客户端的 transport + 身份验证通道在持续运行下能不能稳」。

---

## 0. 结论（先答两个核心问题）

### Transport

> **3 个 production 路径仍走 oneshot，4 个 production 路径已走 sessionful，4 个 test 路径走 stub。** 调用方层面迁移 ~57% 完成——`/api/situation/.../{chat,recommend,investigate}`、`/api/knowledge/ingest`、`autoInvestigateSituation` 已全部 sessionful；legacy `/api/chat`、`/api/ranking` AI summary、`hermes --version` readiness probe 仍 oneshot。**新 `HermesSessionClient` 类是真正被采用的，不是孤儿代码。**

### Token Cache

> **f7e64fc 的 token cache 在 5 个 realistic failure mode 里 4 个是 STALE 的。** 唯一的 production cache 写入路径是模块加载时的 eager auto-discovery + constructor 读 snapshot；唯一清空 cache 的函数 `_resetTokenCache` 是 test-only（5 个测试引用，0 个生产引用）。**对于 P0010.2「agentFabric 长跑 + hermes serve 独立重启」的部署形态，token cache 是 latent bug，不是已解决的问题。**

---

## 1. Transport — Call-site 全表（production + test，每个真到 Hermes 客户端的调用方）

| File:Line | Call site | Hermes class / spawn | 分类 | Trigger（谁调它） |
|---|---|---|---|---|
| `platform/runtime/hermes/index.ts:26` | `new SubprocessHermesClient()` | `SubprocessHermesClient` | **ONESHOT**（factory default, prod） | `createHermesClient()`（无 env override） |
| `platform/runtime/hermes/index.ts:25` | `new StubHermesClient()` | `StubHermesClient` | **STUB**（factory default, test） | `createHermesClient()` 当 `HERMES_CLIENT=stub` 或 `NODE_ENV=test` / `VITEST=true` |
| `platform/runtime/hermes/subprocess-client.ts:38` | `spawnSync(HERMES_BIN, ['--version'])` | `hermes --version` probe | **ONESHOT**（同步探测） | `isAvailable()` on `SubprocessHermesClient` |
| `platform/runtime/hermes/subprocess-client.ts:50` | `spawn(HERMES_BIN, args, …)` (args 含 `-z <prompt>`) | `hermes -z` subprocess | **ONESHOT**（真 CLI） | `SubprocessHermesClient.oneShot()` |
| `platform/server/index.ts:253` | `new HermesSessionClient()` → `connect()` → `createSession()` → `runInvestigationTurn()` | `HermesSessionClient` | **SESSIONFUL**（production） | P0010.1 `autoInvestigateSituation` + backfill 恢复循环 |
| `platform/server/routes/situation-chat.ts:340` | `new HermesSessionClient(...)` + `connect()` + `createSession()` + `submitPrompt()` + `collectTurn()` | `HermesSessionClient` | **SESSIONFUL**（production） | `POST /api/situation/:id/chat` |
| `platform/server/routes/situation-chat.ts:416` | `new HermesSessionClient(...)` + 同上 | `HermesSessionClient` | **SESSIONFUL**（production） | `POST /api/situation/:id/recommend` |
| `platform/server/routes/situation-chat.ts:499` | `new HermesSessionClient(...)` + `runInvestigationTurn()` | `HermesSessionClient` | **SESSIONFUL**（production） | `POST /api/situation/:id/investigate` |
| `platform/server/routes/knowledge.ts:103` | `new HermesSessionClient(...)` + `connect()` + `createSession()` (cached in module-scope `ingestSession`) + `submitPrompt()` + `collectTurn()` | `HermesSessionClient` | **SESSIONFUL**（production） | `POST /api/knowledge/ingest` |
| `platform/server/routes/chat.ts:284` | `createHermesClient()` → `matchIntent(message, hermes)` | `HermesClient.oneShot` (default `SubprocessHermesClient` in prod) | **ONESHOT**（production） | `POST /api/chat`（legacy chat） |
| `platform/server/routes/chat.ts:284` | `createHermesClient()` → `generateResponse(match.skill, …, hermes)` | `HermesClient.oneShot` (default `SubprocessHermesClient` in prod) | **ONESHOT**（production） | 同上（`generateResponse` 在 `apps/ecommerce/skills/registry.ts:196`） |
| `platform/server/routes/ranking.ts:28` | `createHermesClient()` + `HermesRuntimeAdapter(hermesClient)` | `HermesClient.oneShot` (default `SubprocessHermesClient` in prod) | **ONESHOT**（production） | `POST /api/ranking` AI summary 路径（via Router dispatch 或 `summarizeTopResult`） |
| `apps/ecommerce/orchestrator.ts:103` | `hermes ?? createHermesClient()` → `summarizeTopResult` | `HermesClient.oneShot` (default `SubprocessHermesClient` in prod) | **ONESHOT**（production） | `rankProductsComposition` 直接路径（当 no Router injected） |
| `apps/ecommerce/orchestrator.ts:158` | `client.oneShot(HermesOneShotRequestSchema.parse({ prompt }))` | `HermesClient.oneShot` (default `SubprocessHermesClient` in prod) | **ONESHOT**（production） | `summarizeTopResult` — top-ranked product 的 AI summary |
| `apps/ecommerce/skills/registry.ts:142` | `hermes.oneShot(HermesOneShotRequestSchema.parse({ prompt, safeMode: true }))` | `HermesClient.oneShot` | **ONESHOT**（prod; STUB in test） | `matchIntent` — Hermes intent classification fallback（被 `/api/chat` 用） |
| `apps/ecommerce/skills/registry.ts:196` | `hermes.oneShot(HermesOneShotRequestSchema.parse({ prompt }))` | `HermesClient.oneShot` | **ONESHOT**（prod; STUB in test） | `generateResponse` — Hermes NL response 生成（被 `/api/chat` 用） |
| `platform/runtime/hermes/adapter.ts:62` | `this.client.oneShot(req)` (in `HermesRuntimeAdapter.executeStep`) | `HermesClient.oneShot` | **ONESHOT**（production） | Router dispatch for `summarize_top_ranking`（被 `/api/ranking` 用） |
| `apps/ecommerce/workspace/app.js:2409` | `apiPost('/api/situation/jd_shop_001/chat', { message })`（HTTP） | → `HermesSessionClient` (server) | **SESSIONFUL**（production） | 「P0009: canonical Situation Chat wired into the primary Agent Session view」 (comment at line 2390) |
| `apps/ecommerce/workspace/app.js:1258` | `apiPost('/api/situation/' + situationId + '/chat', { message })`（HTTP） | → `HermesSessionClient` (server) | **SESSIONFUL**（production） | 「追问 Agent — 发送 follow-up 问题到 Hermes situation-chat 桥」 (comment at 1247) |
| `apps/ecommerce/workspace/app.js:2102,2244` | `apiPost('/api/situation/:id/recommend' / '/investigate')`（HTTP） | → `HermesSessionClient` (server) | **SESSIONFUL**（production） | Operator-initiated recommendation / investigation on a situation |
| `tests/unit/hermes/session-client.test.ts:65,75,85,…` | `new HermesSessionClient(...)` with mock WebSocket | `HermesSessionClient` (mocked) | **TEST** | `tests/unit/hermes/session-client.test.ts` |
| `tests/contract/hermes-client.contract.ts:8,23` | `new StubHermesClient()` / `createHermesClient()` | `StubHermesClient` | **STUB (TEST)** | Hermes client contract test |
| `tests/unit/runtime-router.test.ts:14,89,131` | `new StubHermesClient()` | `StubHermesClient` | **STUB (TEST)** | Runtime router tests |
| `tests/contract/runtime-adapter.contract.ts:11` | `new StubHermesClient()` | `StubHermesClient` | **STUB (TEST)** | Runtime adapter contract test |
| `tests/integration/router-runtime.test.ts:13` | `new StubHermesClient()` | `StubHermesClient` | **STUB (TEST)** | Router integration test |

**Production-only 真实调用 Hermes 的（去掉 tests + stubs）:**

- ONESHOT (3): `/api/chat`, `/api/ranking` AI summary, `HermesRuntimeAdapter.execute` (`ranking` 一处 bottom-edge)
- SESSIONFUL (4): Situation chat, situation recommendation, situation investigation, knowledge ingest, 加 P0010.1 `autoInvestigateSituation` = 5 call sites

---

## 2. `createHermesClient` — 何时选哪个

`platform/runtime/hermes/index.ts:17-27`:

```ts
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export const createHermesClient = (): HermesClient => {
  const mode = process.env.HERMES_CLIENT ?? (isTest ? 'stub' : 'subprocess');
  if (mode === 'stub') return new StubHermesClient();
  return new SubprocessHermesClient();
};
```

- **Production default** (`NODE_ENV !== 'test'`, 无 `HERMES_CLIENT`): `SubprocessHermesClient`（oneshot, `hermes -z`）。
- **Test default**: `StubHermesClient`（canned echo）。
- **Override**: `HERMES_CLIENT=stub` → `StubHermesClient`; 任何其他值 → `SubprocessHermesClient`。
- **没有 env switch 选 `HermesSessionClient`**——sessionful 客户端是直接 `new HermesSessionClient(...)` 构造（绕过 factory），所有 sessionful call site 都这样做。

`createHermesClient()` 的生产调用方（拿到 oneshot 的）: `platform/server/routes/chat.ts:284`, `platform/server/routes/ranking.ts:28`, `apps/ecommerce/orchestrator.ts:103`。

---

## 3. `/api/ws` adoption 状态

**已迁移（sessionful, 真实）:**

- `POST /api/situation/:id/chat` — `platform/server/routes/situation-chat.ts:340` (consumed by `apps/ecommerce/workspace/app.js:1258,2409`)
- `POST /api/situation/:id/recommend` — `situation-chat.ts:416` (`app.js:2102`)
- `POST /api/situation/:id/investigate` — `situation-chat.ts:499` (`app.js:2244`)
- `POST /api/knowledge/ingest` — `platform/server/routes/knowledge.ts:103`
- `autoInvestigateSituation`（P0010.1 后台恢复）— `platform/server/index.ts:253`

**仍 oneshot — P0010.2 应优先迁移的:**

- `POST /api/chat`（legacy chat, intent classification + NL response）— `platform/server/routes/chat.ts:284` → `matchIntent` (`apps/ecommerce/skills/registry.ts:142`) + `generateResponse` (`apps/ecommerce/skills/registry.ts:196`)。factory 返 `SubprocessHermesClient`，所以真 Hermes 调用是 `hermes -z <prompt>`——全 stateless，零 event stream。
- `POST /api/ranking`（AI summary 路径）— `platform/server/routes/ranking.ts:28` → `HermesRuntimeAdapter.executeStep` (`platform/runtime/hermes/adapter.ts:62`)，或 → `apps/ecommerce/orchestrator.ts:158` `summarizeTopResult` 直接调。两者都 `client.oneShot()`。
- `hermesClient.isAvailable()` probe — `subprocess-client.ts:38` 用 `spawnSync(HERMES_BIN, ['--version'])`。单次 sync probe 不是真 call site，但它是 oneshot subprocess，没有 sessionful 对应物。

---

## 4. Stub usage — test-only（好）

- `StubHermesClient` 只在 `createHermesClient` factory 命中 `HERMES_CLIENT=stub` 或 test env，或直接在四个 test files 里实例化：`tests/contract/hermes-client.contract.ts:8`, `tests/unit/runtime-router.test.ts:14,89,131`, `tests/contract/runtime-adapter.contract.ts:11`, `tests/integration/router-runtime.test.ts:13`。
- **Stub 没渗到生产代码路径**。`Phase-3-Closeout-Review.md:71` 已记录这点。
- Production flag `HERMES_CLIENT=stub` 存在但 `platform/server/index.ts:266-294` `main()` 从不 set 它。

---

## 5. 仍 oneshot 的「理由」（一句一条）

- `POST /api/chat` (`chat.ts:284` → `matchIntent` / `generateResponse`): 单 prompt + 单 text reply，零 event stream，零 session continuity 需要。迁移在 `proposals/audits/p0008.3-integration-gap-map.md:219` 明确列了 TODO 但未做。
- `POST /api/ranking` AI summary (`ranking.ts:28` / `orchestrator.ts:158` / `adapter.ts:62`): fire-and-forget for explanation；无 UX surface 渲 event stream；prompt 全 synthesized（templated ranking summary）非 user conversation。
- `hermes --version` probe (`subprocess-client.ts:38`): 纯 readiness check，零 model call。
- `hermes -z` 本身 (`subprocess-client.ts:50`): 整个 `SubprocessHermesClient` 就是 oneshot 实现，没有「理由」可给。

---

## 6. Top 3 迁移候选（给 P0010.2）

1. **`POST /api/chat` → `HermesSessionClient`** (`platform/server/routes/chat.ts:284`): operator-facing 的 NL 入口；迁它让 chat panel 「always-on」并 expose Hermes event stream（tool calls, status, partial text）——「Continuous Runtime」最高 leverage 的 UX 赢。
2. **`POST /api/ranking` AI summary → sessionful** (`ranking.ts:28` + `adapter.ts:62` + `orchestrator.ts:158`): 把 top-ranking summary reroute 到已有的 `/api/situation/.../chat` session，让 operator 读 ranking 时可以在同一 session 追问——「ranking 是 conversation 的起点」的自然 glue。
3. **替换 `hermes --version` oneshot probe 为 `/api/ws` health check** (`subprocess-client.ts:38` + `isAvailable()` consumers): 一旦 sessionful 是唯一生产路径，`isAvailable()` 应该用 `client.connect()` against `/api/ws`，让 readiness 信号反映生产流量用的那条路径。

---

## 7. Token Cache Lifecycle — Failure-mode matrix（f7e64fc 5 个失败模式）

| # | Failure mode | Verdict | Citation |
|---|---|---|---|
| 1 | `hermes serve` 重启，**同** token | **RE-RESOLVES — 但只在第一次调用，不是自动**。如果第一次 `connect()` 成功，token 是 stale-but-equal，cached value 仍能用。Operator 不会拿到 fresh value。**STALE-by-design**: 零主动 refresh。 | `token-resolver.ts:57-62` (cache check), `session-client.ts:95` (constructor reads snapshot) |
| 2 | `hermes serve` 重启，**新** token (rotation) | **STALE (cache hit, will fail)**。agentFabric 拿旧 token。`connect()` 的 `onerror` 拒 `WebSocket error connecting to ${this.url}: ${e}`——**零** 401/403 detection，**零** re-resolve，**零** retry。Operator 看到 generic WebSocket error。 | `token-resolver.ts:57-62`, `session-client.ts:118` |
| 3 | `hermes serve` **晚于** agentFabric 启动 | **STALE (cache hit, will fail)**。模块加载时 eager auto-discovery 跑 `discoverFromRunningServe(9119)`，返 `undefined`（无 listener），存 `cache = { port: 9119, token: undefined }` (`token-resolver.ts:60-62`)。cache entry 存在但 `token: undefined`。每次后续 `resolveHermesSessionToken()` 都返 `undefined`（cache hit）。`connect()` 拒 "Missing Hermes dashboard session token" 且**永不重试** discovery。 | `token-resolver.ts:60-62`, `session-client.ts:101-110` |
| 4 | `hermes serve` 在**非默认端口** | **RE-RESOLVES (好)，但只在端口 mismatch 时**。`session-client.ts:86-87` default 是 `ws://localhost:9119/api/ws`，`port` 硬编码 9119（**不**从 `options.url` parse）。`HermesSessionClient` URL 可被 `options.url` override，但 `token-resolver.ts:48` 正确从 URL extract port: `parsePort(options.url) ?? 9119`。如果传非默认端口 URL，per-port cache key 匹配那端口。如果没传 URL，cache 永远是 9119。**用默认端口的 user 永远到不了 9120 上的 hermes serve。** | `session-client.ts:86-87`, `token-resolver.ts:48,57` |
| 5 | agentFabric 长跑，hermes serve 重启 10 次 | **STALE (cache hit, #2 之后都 fail)**。第一次 cache value 在模块加载时写入（或第一次显式 `resolveHermesSessionToken()`），从不 refresh。PID 79723 → 88888 → 99999，cache 仍说 "token from PID 79723"。零 TTL，零 file watcher，零 IPC。 | `token-resolver.ts:37,57-62` |
| 6 | Cache invalidation policy | **None**。零 TTL，零 file watcher，零 IPC，零 `cache.refresh()`。唯一 mutator: (a) `cache = { port, token: discovered }` write at `token-resolver.ts:61`，(b) `_resetTokenCache` at `token-resolver.ts:67`。 | `token-resolver.ts:37,57-67` |
| 7 | `_resetTokenCache` 在 tests 外被调 | **零生产调用方**。Grep: re-export at `platform/runtime/hermes/index.ts:14`, definition at `token-resolver.ts:66`, **5 个 test-only 引用** at `tests/unit/hermes/session-client.test.ts:13,194,213` and `tests/unit/hermes/token-resolver.test.ts:123,248`。**生产路径零 invalidation**。 | grep result |
| 8 | 每次 `new HermesSessionClient({...})` — 会 re-resolve 吗？ | **No**。Constructor at `session-client.ts:95` 读 `options.token ?? process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? resolvedToken`。`resolvedToken` 是 module-level snapshot，在模块加载时设置**一次** (`session-client.ts:66-73`)。Resolver 本身也不再被调——只读 cached snapshot。 | `session-client.ts:85-96,66-73` |
| 9 | `connect()` 失败 — 错误信息 actionable? | **No**。WS error: `WebSocket error connecting to ${this.url}: ${e}` (`session-client.ts:118`)。Missing token: 4 行 guide 说 "export HERMES_DASHBOARD_SESSION_TOKEN ... or start hermes serve"——但**不**说 "你的 cached token stale; restart agentFabric"。这正是 operator 需要的，但缺。 | `session-client.ts:101-110, 118` |
| 10 | 多实例 agentFabric | **Per-process cache, by design — 但 correctness hazard**。两个 agentFabric 进程在不同时间启动会看到不同 token（如果 hermes serve 在中间 rotated）。两个进程不会在 token 上达成一致。各自按自己节奏 fail/succeed。 | `token-resolver.ts:37` (module-level `cache`) |
| 11 | WebSocket reconnect on `onclose` | **No reconnect, no retry, no re-resolve**。`ws.onclose` at `session-client.ts:120-126` 只 reject pending requests 并 clear。**零** setTimeout，**零** exponential backoff，**零** `cache.refresh()`，**零** `new WebSocket(...)`。唯一恢复路径是 caller 重新调 `connect()`，而 caller 仍用**同一个 stale token**。 | `session-client.ts:120-126` |

---

## 8. Cache invalidation surface（全部）

| Function / site | Purpose | Production caller? |
|---|---|---|
| `cache = { port, token: discovered }` at `token-resolver.ts:61` | Write on first miss（或 port mismatch） | Yes — eager at module load + any `resolveHermesSessionToken()` call with 不同 port |
| `cache = null` at `token-resolver.ts:67` (`_resetTokenCache`) | Test escape hatch | **No** — 5 test refs, 0 prod refs (全仓 grep 确认) |
| `resolvedToken = t` at `session-client.ts:69` | Write eager auto-discovery result | Yes — 模块加载时**一次**，之后 never |
| `resolvedToken = undefined` at `session-client.ts:72` | Write eager auto-discovery failure | Yes — 模块加载时**一次**，之后 never |
| `this.token = options.token ?? process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? resolvedToken` at `session-client.ts:95` | Read snapshot, no mutation | Yes — per-constructor; reads stale |

**List 塌缩成: 一次 module-lifetime write，一次 per-constructor read，一个 test-only reset。零 production-grade invalidation surface。**

---

## 9. Connect failure handling（`session-client.ts:99-128`）

```ts
connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!this.token) { reject(new Error('Missing Hermes dashboard session token. ...')); return; }
    const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error(`WebSocket error connecting to ${this.url}: ${String(e)}`));
    ws.onmessage = (msg) => this.handleMessage(msg);
    ws.onclose = () => { for (const [, p] of this.pending) { p.reject(new Error('Hermes connection closed')); } this.pending.clear(); };
  });
}
```

- `onerror` 拒 generic message（含 URL 但零 actionable hint）。
- `onclose` 拒 pending requests。**零** `setTimeout(reconnect, ...)`，**零** call to `resolveHermesSessionToken()`，**零** retry。
- 4 行 "Missing token" message at `session-client.ts:103-108` 有用，但仅在 `this.token` 是 falsy 时触发。首次 auto-discovery 成功后，`this.token` 是 stale value，这 message 永不再触发——即使 cache 是错的。
- **零** 401/403 path。WebSocket 协议要么 upgrade 要么 handshake 失败。Handshake 失败时 operator 看到 raw browser-level error。

**从 `connect()` failure 到 fresh `resolveHermesSessionToken()` call 零路径。**

---

## 10. 长跑 process 的问题

**如果 agentFabric 计划长跑几天 (P0010.2 Continuous Runtime)，token cache 是 latent bug。** 最清晰的演示是 failure mode #3: agentFabric 启动**早于** `hermes serve` 时，模块加载时 eager auto-discovery 跑 `discoverFromRunningServe(9119)`，返 `undefined`（无 listener）。Cache 设为 `{ port: 9119, token: undefined }` at `token-resolver.ts:61`。`resolvedToken` snapshot 设为 `undefined` at `session-client.ts:72`。**当 `hermes serve` 后来启动，零东西会醒来**。Constructor 已跑（带 `undefined`）；`connect()` failure path 零 re-resolve；cache lookup 已满足。Operator 选项: (a) 重启 agentFabric, (b) export `HERMES_DASHBOARD_SESSION_TOKEN` 后重启 agentFabric, (c) 看到 error 后重启。

Failure mode #2（agentFabric 跑时 token rotation）形状一样：one-shot snapshot 永不针对 live serve re-validate。`HermesSessionClient` 第一次 constructor 调用把 process 锁到 startup 看到的 token。零 heartbeat，零 SIGHUP，零 env-var-poll，零 `/api/healthz` 风格 "are we still trusted?" probe。

存在的 defense-in-depth（`HERMES_DASHBOARD_SESSION_TOKEN` env var wins over cache）自己也在 constructor 时被冻结。如果 operator 在 agentFabric process 里更新 env var（例如 config reload, signal, dynamic loader），`process.env.HERMES_DASHBOARD_SESSION_TOKEN` 会被重读，但**只在 fresh `HermesSessionClient` constructor 调用内**；已有 clients 已经 snapshot `this.token`。

---

## 11. The right fix（NOT IMPLEMENTED — 描述 only）

A production-ready cache for 24/7 deployment 会做:

1. **Token as a getter, not a snapshot**。`HermesSessionClient` 应该在每次 `connect()` attempt 上 lazy await `resolveHermesSessionToken()`，而不是在 construction 时 snapshot。Constructor 仍能 cache 结果，但必须在每次 connect 时 re-resolve，rotation 在一个 connect cycle 内被 detect。
2. **Detect 401/403 and re-resolve exactly once**。当 WebSocket handshake 失败（或第一个 JSON-RPC request 返 auth error），call `resolveHermesSessionToken({ url, forceRefresh: true })` —— 一个 bypass per-port cache 的 variant——然后 retry connect 一次。第二次失败后，surface structured error 给 operator，命名精确原因: 「Hermes rejected the cached token. The operator should restart agentFabric, or confirm `HERMES_DASHBOARD_SESSION_TOKEN` matches the value exported when `hermes serve` was started.」
3. **加 soft TTL (e.g. 60s) to the cache**。即便无 failure，TTL 后 re-resolve，token rotation 在分钟内被 pick up，即便 hermes serve 稳定。
4. **加 reconnect with backoff on `ws.onclose`**。On non-clean close，schedule retry，re-resolve token，重开 socket。Cap retries 避免 log flood。
5. **让 `_resetTokenCache` 成为真实的 non-underscored API**，并 expose `refreshTokenCache()` method on `HermesSessionClient`（或 event-bus hook）让 tests AND 生产代码 force refresh。当前 leading-underscore prefix 宣告 "test-only"，是「无生产 caller 应依赖它」的 right signal。
6. **加 per-port invalidation hook for "started after agentFabric" case**。当 eager discovery 返 `undefined` 因为 no serve running，schedule backoff-and-retry（e.g. 每 10s up to 60s）让 agentFabric 在 `hermes serve` 晚到时 self-heal。
7. **Emit structured warning log on first successful connect with auto-discovered token**（「token source: auto-discovered from PID 79723; will be re-validated on every connect」）让 operator audit 哪条路径 in use。

**当前实现零上述项。** 它对「start agentFabric after `hermes serve`, 跑几小时, 一起 restart」workflow 是 correct 的（f7e64fc 当时的目标）。对 P0010.2「agentFabric 长跑, hermes serve 独立 restart」workflow 是 incorrect 的。

---

## 12. 关键文件索引

- `platform/runtime/hermes/token-resolver.ts` — Cache 实现: `cache: CacheEntry | null` (line 37), `resolveHermesSessionToken()` (line 45), `_resetTokenCache()` (line 66), `discoverFromRunningServe()` (line 70), `findListenPid()` (line 79), `readProcessEnv()` (line 95)
- `platform/runtime/hermes/session-client.ts` — Eager `resolvedToken` snapshot (line 66-73), `HermesSessionClient` constructor (line 85-96), `connect()` (line 99-128), `onclose` handler (line 120-126), zero reconnect/re-resolve
- `platform/runtime/hermes/index.ts:14` — Re-exports `_resetTokenCache`（唯一 re-export path; 零生产 caller）
- `platform/runtime/hermes/subprocess-client.ts` — `SubprocessHermesClient` (`hermes -z`)
- `platform/runtime/hermes/stub-client.ts` — `StubHermesClient`
- `platform/runtime/hermes/adapter.ts` — `HermesRuntimeAdapter` (oneshot)
- `platform/runtime/hermes/types.ts` — `HermesClient` interface, `HermesOneShotRequestSchema`
- `platform/server/index.ts` — server wiring + `autoInvestigateSituation` (line 253)
- `platform/server/routes/chat.ts` — legacy `/api/chat` (line 284)
- `platform/server/routes/ranking.ts` — `/api/ranking` AI summary (line 28)
- `platform/server/routes/situation-chat.ts` — Situation Chat Bridge (lines 340, 416, 499, plus `collectTurn`, `runInvestigationTurn`, `runRecommendationTurn`)
- `platform/server/routes/knowledge.ts` — Knowledge Ingest (line 103)
- `platform/server/routes/runtime.ts` — `/api/fabric/execute` and `/api/runtime/*`（不直接碰 Hermes，用 RuntimeKernel + CDP）
- `apps/ecommerce/orchestrator.ts` — `rankProductsComposition` + `summarizeTopResult` (lines 103, 158)
- `apps/ecommerce/skills/registry.ts` — `matchIntent` (line 142), `generateResponse` (line 196)
- `apps/ecommerce/experience/learning-context-producer.ts` — read-side only（被 `situation-chat.ts` 和 `autoInvestigateSituation` 用; 不直接调 Hermes）
- `apps/ecommerce/workspace/app.js` — UI calls `/api/situation/...` (lines 1258, 2102, 2244, 2409)
- `tests/unit/hermes/token-resolver.test.ts` — 14 tests, including `_resetTokenCache forces a re-resolution` at line 241. **Does NOT test "cache survives hermes serve restart."**
- `tests/unit/hermes/session-client.test.ts` — 11 tests; mocks resolver 返 static value; tests auto-discovered token path (line 189-206). **Does NOT test "connect fails because token rotated."**
- `tests/contract/hermes-client.contract.ts`, `tests/contract/runtime-adapter.contract.ts`, `tests/unit/runtime-router.test.ts`, `tests/integration/router-runtime.test.ts` — stub/test usage
- `proposals/audits/p0008.3-integration-gap-map.md:219` — `POST /api/chat → HermesSessionClient` 明确列 TODO 但未做

---

> 本审计与 [runtime-execution-chain-audit.md](./runtime-execution-chain-audit.md) 成对：那份回答「Runtime execution chain 上每跳的真实触发点」，这份回答「Hermes 客户端的 transport + token 身份验证通道在持续运行下能不能稳」。**本次未修改任何代码、未修复任何问题、未 commit、未生成 P0010.2 proposal（按用户要求：audit 后再出 proposal，由用户来定 Included / NOT Included）。**
