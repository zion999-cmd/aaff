# Runtime Execution Chain Audit (post-f7e64fc)

- **日期**: 2026-08-25
- **类型**: 只读 Runtime Execution Chain Audit（现实校准，非开发，非 Proposal）
- **核心问题**: Post-f7e64fc / Post-p0010.1，agentFabric 的「从外部数据到业务结论」链路上，**哪些跳是 LIVE（自己活）、哪些跳是 STARTUP-ONLY / REQUEST-ONLY、哪些跳是 DEAD？** 链路断在哪？
- **事实优先级**: 实际代码 > 实际 DB > API > Tests > Proposal / context docs
- **分类框架**: `LIVE` / `STARTUP-ONLY` / `REQUEST-ONLY` / `DEAD` / `DEMO-ONLY`
- **范围**: 跟 [current-runtime-capability-consolidation-audit.md](./current-runtime-capability-consolidation-audit.md) (2026-08-19) 配对，那份回答「专业人员现在拿到了什么」，这份回答「链路上每跳的真实触发点」。

---

## 0. 结论（先答核心问题）

> **Post-f7e64fc，agentFabric 仍然是「幂等重放 + 按需 Runtime」，不是「持续自驱的系统」。**

对比 2026-08-19 audit 的「活到 Situation 然后停止」：

- **新升级的部分**: P0010.1 引入了 `autoInvestigatePending`（启动时上限 3 的 Hermes 调查恢复）和 `onAfterRun` 钩子（按 schedule 触发后的 situation→investigation 链）。这两条「在」的链是真实的，代码写完了。
- **没升级的部分**: scheduler 的 `setInterval` 默认 `enabled:false`；没有任何文件 watcher 监听新 evidence；`extractMemories` 仍然零调用方；Output 只能由 operator 手动 POST 创建；intervention 写完就是死路。
- **新增 dead-leg**: `runInvestigationTurn` 写完 `recommendation` 后**不再创建 WorkItem**——`outputs[]` 在稳态下永远是空。

一句话：**f7e64fc 让 Hermes 客户端能 sessionful 调用了，但 runtime 仍然是「按需 + 重放」，没有自驱 tick。**「Fabric 看起来像持续运行的 Agent 系统，但业务认知链没持续运行」这个判断在 2026-08-25 仍然 100% 成立。

---

## 1. Chain Table（10 跳，每跳给 producer / trigger / 分类 / gap）

| # | Step | Producer (file:line) | Trigger (file:line) | 分类 | Gap |
|---|---|---|---|---|---|
| 1 | **JD acquisition (CDP)** | `acquireJdData` `apps/ecommerce/connectors/jd/acquisition/index.ts:60`; `createLocalFirstLiveAcquire` 包装于 `apps/ecommerce/connectors/jd/historical-acquire.ts:76`; CDP client at `cdp-client.ts:190` | (a) Startup backfill `platform/server/index.ts:142` `kernel.execute({mock:false})` 跑最近 7 天；(b) Scheduled tick `apps/ecommerce/runtime/scheduling/scheduler.ts:98`；(c) `POST /api/runtime/collect` / `POST /fabric/execute` (`platform/server/routes/runtime.ts:139,189`)；(d) `POST /api/chat` with `discover_capability` (`platform/server/routes/chat.ts:301-323`) | **STARTUP-ONLY**（默认配置） | `main()` 在 `platform/server/index.ts:270-273` 把两个 schedule 条目都 `enabled:false`，所以 scheduler 永远不 `start()`。`historical-acquire.ts:116` 的 `throw new Error(live.error ?? ...)` 改成诚实抛错（之前是静默返回），这是好的诚实性修复但不影响触发面。 |
| 2 | **Evidence persistence** (`saveEvidence`) | `apps/ecommerce/connectors/evidence/store.ts:38`；called from `runtime/kernel/runtime-evidence-orchestrator.ts:70,88`, `runtime/kernel/runtime-executor.ts:507,513,519`, `platform/server/routes/runtime.ts:467` | kernel 内部随 `kernel.execute()` 触发，即同 step 1 的 4 条路径 | **STARTUP-ONLY + REQUEST-ONLY** | 启动后**没有任何路径**会自动写新 evidence 文件（除了手动 API）。`grep -rn "fs.watch\|chokidar"` 全仓 0 hit。 |
| 3 | **Signal derivation** (`SignalFacade.store`) | facade: `apps/ecommerce/analysis/metrics/facade.ts:14-25`；write: `apps/ecommerce/analysis/metrics/repository.ts:53`；调用 from `runtime/kernel/runtime-signal-engine.ts:145`, `runtime/kernel/runtime-executor.ts:550,568,573` | kernel.execute() 内 → 同 step 1/2 | **STARTUP-ONLY + REQUEST-ONLY** | 只在 evidence 上磁盘时更新，**没有 live signal projector**。 |
| 4 | **Ranking** (`RankingFacade.store`) | facade: `apps/ecommerce/analysis/decision/facade.ts:36`；write: `decision/repository.ts:41`；唯一生产调用方 `platform/server/index.ts:168`（backfillRecentData 内） | Startup backfill only | **STARTUP-ONLY** | 只在 `latestTopProducts.length > 0` (line 166) 时跑。chat 路径（`chat.ts:301-323`）不调用 `RankingFacade.store`。 |
| 5 | **Situation detection** (`runSituationProducer`) | `apps/ecommerce/runtime/situation/producer.ts:63`；rules: `runtime/situation/rules.ts:208` | (a) Startup backfill `platform/server/index.ts:194-198`；(b) `onAfterRun` of scheduler `platform/server/index.ts:80-82` → fires `runSituationProducer` + `autoInvestigateSituation`；(c) `POST /api/runtime/schedule/run` (`platform/server/routes/schedule.ts:26`) 触发 acquire 但不触发 producer | **STARTUP-ONLY**（live 路径 dead） | `onAfterRun` 钩子在 `server/index.ts:79-83` 注册时 gated by `schedule.length>0`，但每个 schedule 条目都是 `enabled:false`。**之前的「live-on-miss」已经被改写成「live-on-schedule」，但这个 schedule 同样默认 dead。** |
| 6 | **Investigation** (`runInvestigationTurn` via Hermes) | `platform/server/routes/situation-chat.ts:243`；`client.submitPrompt` at line 257；`collectTurn` line 256 | (a) Startup backfill via `autoInvestigatePending` `platform/server/index.ts:208-213`（上限 `MAX_AUTO_INVESTIGATE=3` line 223）；(b) Scheduler onAfterRun `platform/server/index.ts:82`（**DEAD**）；(c) `POST /api/situation/:id/investigate` `situation-chat.ts:472-542`；(d) `POST /api/situation/:id/chat` `situation-chat.ts:314-368` | **STARTUP-ONLY (bounded 3) + REQUEST-ONLY** | 有界恢复是唯一自动路径。`autoInvestigateSituation` (`server/index.ts:249-263`) 抓错 log "auto-investigate ${id}: ${msg}"。**无队列、无重试、无 backoff**——一次失败恢复就此消失，直到下次重启。 |
| 7 | **Output generation** (`outputsRouter`) | `platform/server/routes/outputs.ts:110`（POST `/situations/:id/outputs`）；所有状态转移由 operator PATCH 触发 (line 164) | `POST /api/situations/:id/outputs` —— 手动 | **REQUEST-ONLY** | **GAP**: investigation 写 `recommendation` 到 `learning_contexts.body.investigation.recommendation`（`situation-chat.ts:294-301`），但**没有任何代码**把 recommendation 合成成 `WorkItem` 写到 `learning_contexts.body.outputs[]`。 |
| 8 | **Human intervention processing** | `platform/server/routes/p0007.ts:276-328` POST `/api/situations/:id/interventions`；持久化 via `recordInterventionInLearningContext` `apps/ecommerce/experience/learning-context-producer.ts:118` | HTTP request only | **REQUEST-ONLY (terminal)** | **GAP**: 干预写一行 row + bump `situations.lifecycle` 到 `partial` (line 311-315) + append 到 `LearningContext.humanInterventions[]`，**不** (a) 重跑 `autoInvestigateSituation`、(b) 重跑 `runSituationProducer`、(c) 更新 signal/ranking、(d) 关闭 situation。干预是「写完就死」。 |
| 9 | **Experience / Learning** (`extractMemories`, `operator_memories`, `context_memories`) | `MemoryFacade.extract` → `extractMemories` `apps/ecommerce/experience/extraction.ts:108`；`storeMemories` `experience/repository.ts:48`；operator memory `apps/ecommerce/memory/store.ts:44` | **生产代码零调用**（`grep -rn "extract(\|MemoryFacade\.extract\|storeMemories\|MemoryFacade\.store" apps/ platform/` 确认）。唯一消费方是只读: `MemoryFacade.queryActive` `platform/server/routes/workspace.ts:37`, `platform/server/routes/chat.ts:198`, `platform/server/routes/reviews.ts:63` | **DEAD** | 2026-08-19 audit 的「`extractMemories` 从不被调」post-f7e64fc **仍然 100% 成立**。`context_memories` 和 `operator_memories` 表存在但零 producer。`learning-context-producer.ts:5-10` 注释明确「NO Intervention → context_memories producer」。 |
| 10 | **Scheduler / tick / loop** | 见 §2 | — | — | 浏览器端 `setInterval(loadData, 300000)` `workspace/app.js:3286` 是**纯 UI 刷新**（5 min 拉一次 ranking/memory/findings/products），不触发任何 server 端业务逻辑。 |

---

## 2. Scheduler audit（`setInterval` / `cron` / `fs.watch` 全仓扫描）

| File:line | Construct | 分类 | 备注 |
|---|---|---|---|
| `apps/ecommerce/runtime/scheduling/scheduler.ts:105` | `setInterval(() => void tick(), 60_000)` | **DEAD by default** | 仅当 `createServer({schedule: [...length>0]})` 且条目 `enabled:true` 时才启动。`main()` 在 `platform/server/index.ts:270-273` 始终传 `enabled:false`。`tick()` 在 `scheduler.ts:93` 用 `if (!cfg.enabled) continue;` 跳过。 |
| `apps/ecommerce/runtime/scheduling/scheduler.ts:106` | `void tick()` (initial fire on `start()`) | **DEAD by default** | 同上。 |
| `apps/ecommerce/workspace/app.js:3286` | `setInterval(loadData, 300000)` | **INFRA-ONLY (UI refresh)** | 浏览器端。拉 ranking/memory/findings/products。对 server 零业务影响。 |
| `apps/ecommerce/runtime/scheduling/scheduler.ts:80` | `onAfterRun?.(date)` callback | **DEAD by default** | 只在 schedule run 成功后触发。`onAfterRun` 在 `platform/server/index.ts:79-83` 接 `runSituationProducer` + `autoInvestigateSituation`——即「Situation→Investigation」live 链**完全 wired 但 unpowered**。 |
| `platform/server/index.ts:293` | `void backfillRecentData(db)` (one-shot on boot) | **STARTUP-ONLY** | 唯一保证-on-boot 的通道。最近 7 天 → `kernel.execute({mock:false})` (line 142) → regenerates rankings (line 167-168) → situation producer (line 195) → `autoInvestigatePending` (line 212, max 3)。 |
| `platform/server/index.ts:284` | `bootstrapProductCatalog(db)` (one-shot on boot) | **STARTUP-ONLY** | 幂等。P0010.1 引入。walk `data/evidence/jd/**/getProductList*.json`。 |
| `apps/ecommerce/connectors/evidence/types.ts:43` | `// cron` (provenance enum) | **COMMENT ONLY** | schema 里 `'cron'` 是合法 `acquisition_method` 值，但零代码 emit。 |

- `node-cron` / `node-schedule` / `cron` (npm) / `process.on('SIGALRM')` 全仓未使用。
- `setTimeout` 递归模式不存在（除 tests 外）。
- `MessageChannel` / `EventEmitter` 跨桥不存在。
- **`scheduler.ts:105` 是唯一候选「wake engine」，且它 dead。**

---

## 3. Re-investigation signal（新 evidence 进来会不会触发调查？）

**结论: No —— partial / effectively no。**

- `grep -rn "fs.watch\|chokidar"` 全仓 **0 hit**。
- 新 evidence → 重调查的唯一桥是 `onAfterRun` (`scheduler.ts:80`)，它由 disabled-by-default 的 scheduler 喂数据。
- `extractMemories` 和 LearningContext 没有任何监听新 observation 的 consumer。
- P0010.1 situation-chat session registry（`situation-chat.ts:310` `sessions: Map<string, ActiveSituationSession>`）是 in-memory only，只在第一次 `/chat` 或 `/investigate` POST 时创建——它不会在 evidence 落地时自动建 session。
- `apps/ecommerce/workspace/presentation.js:290-292` 注释明确写：「It is NOT an auto-wake condition: there is no scheduler, no wake engine, no event bus. The note field makes this explicit so the UI cannot be misread as 'the system will wake me up'.」
- `platform/server/routes/outputs.ts:32` 注释：「No Event Bus, no wake engine, no scheduler (out of scope).」

**Partial**: `autoInvestigatePending` 在 `platform/server/index.ts:224-239` 会在下次启动时 pick up 没有 `completed` 调查的 situations——但这只在重启时跑，不在 evidence 到达时跑。

---

## 4. Top 3 dead-legs（最影响「自驱」的链路断点）

### #1 — Scheduled Acquisition 默认 dead

`apps/ecommerce/runtime/scheduling/scheduler.ts:105` 的 `setInterval(60_000)` 永不跑，因为 `main()` 在 `platform/server/index.ts:270-273` 始终给两个 seed schedule 条目 `enabled:false`。结果：即便 Chrome-9222 在跑，agentFabric server 也不会自己起 CDP session；只有 operator 调 `POST /api/runtime/schedule/run` 或重启 server（重启会跑 `backfillRecentData`，但 backfill 是个固定 7-day window，**结束于昨天**）。

> **让它活**: 把 `main()` 至少一个 capability flip `enabled:true`（一行改动），或让 operator 通过 `--enable-schedule` CLI flag 开启。注：当前 `backfillRecentData` 是唯一会为「昨天 + 前 6 天」调 `acquireJdData` 的路径；想覆盖「今天」必须开 scheduler 或加新的「today's tail」路径。

### #2 — `extractMemories` dead（Memory/Experience loop 零 producer）

`apps/ecommerce/experience/extraction.ts:108` 和 `apps/ecommerce/experience/facade.ts:25` export 着，但 `grep` 确认生产代码零调用方。`storeMemories` (`experience/repository.ts:48`) 和 `upsertMemories` (`apps/ecommerce/memory/store.ts:44`) 同。`context_memories` 和 `operator_memories` 表存在但零 writer。结果：每条 `human_interventions` 都是死 row——写进去后**永不**变成 memory，ranking adjustments 永远 `[]`（`MemoryFacade.adjustmentsFor` at `facade.ts:28` 永远返空）。

> **让它活**: 在 `platform/server/routes/p0007.ts:276-328` 的 `recordInterventionInLearningContext` (line 321) 之后调 `MemoryFacade.extract`，但需要 type alignment（`extractMemories` 读 `ReviewEvent[]` 而非 `HumanIntervention[]`，`learning-context-producer.ts:5-10` 注释明确「NO Intervention → context_memories producer」）。需要先决定两套 memory 是否合并。

### #3 — Output 不从 Recommendation 自动创建

`platform/server/routes/outputs.ts:110` POST `/situations/:id/outputs` 是 `WorkItem` 落地到 `learning_contexts.body.outputs[]` 的唯一路径。investigation flow 在 `platform/server/routes/situation-chat.ts:294-301` 写 `recommendation` 到 investigation body，但**不**合成 `WorkItem`。结果：稳态下 `/api/outputs` collection 对任何不手动把 Agent 文案 copy 进 POST body 的 operator 永远是空。`outputs` 页 (`workspace/app.js:388`) 等于在说「没 agent 交付物曾被交付过」。

> **让它活**: 在 `runInvestigationTurn` 写完 `storeInvestigationInLearningContext(... completed)` (line 290) 之后，如果 `completed.recommendation` 存在，append 一个 `WorkItem` 到 `ctx.outputs`（复用 `outputs.ts:64-74` 的 `readLearningContextBody` / `writeLearningContextBody` helpers）。

### Honourable mention #4 — Intervention 不重调查

`p0007.ts:311-322` 写完就停。让它活：在 line 321 之后，当 intervention type 是 `correction` 或 `challenge` 时调 `void autoInvestigateSituation(db, fabricDir, situationId)`。

---

## 5. 跟 2026-08-19 audit 的对比

| 2026-08-19 claim | 2026-08-25 验证 |
|---|---|
| 「live-on-miss acquisition 接了却不触发」 | **Partially true**。`createLocalFirstLiveAcquire` (`historical-acquire.ts:76`) wired into backfill (`server/index.ts:119`) 和 scheduler (`scheduler.ts:43`)，但 backfill 只 replay 最近 7 天，scheduler 默认 disabled。Net: CDP 只在「local evidence missing AND kernel.execute 正在跑」时触发，默认配置下基本等于 7-day backfill window on every restart。 |
| 「extractMemories 从不被调」 | **100% true**，post-f7e64fc。`grep` 确认 `MemoryFacade.extract` / `storeMemories` / `upsertMemories` 在 `apps/` 和 `platform/` 零调用方。 |
| 「Agent Session 事件槽是 demo（task_demo_* 硬编码）」 | **升级**。P0009 / f7e64fc 之后，`/api/situation/:id/{chat,recommend,investigate}` 都用 `HermesSessionClient` + `collectTurn` 真实 stream 事件；`autoInvestigatePending` 也是真 Hermes 调用。demo 路径只在 legacy `/api/chat` 里。 |
| 「Operator memories(12) + context memories(0) 双轨并存」 | **未变**。两表都在，无 producer。 |

---

## 6. 关键文件索引

- `platform/server/index.ts` — main + `backfillRecentData` (112-218) + `autoInvestigateSituation` (249-263) + `main()` (266-294)
- `apps/ecommerce/connectors/jd/historical-acquire.ts` — `createHistoricalAcquire` (33-61) + `createLocalFirstLiveAcquire` (76-122)
- `apps/ecommerce/connectors/jd/acquisition/index.ts` — `acquireJdData` (60-131)
- `apps/ecommerce/connectors/evidence/store.ts` — `saveEvidence` (38-106) + `loadEvidence` (112-138) + `listEvidence` (144-208)
- `apps/ecommerce/runtime/situation/producer.ts` — `runSituationProducer` (63-127)
- `apps/ecommerce/runtime/situation/rules.ts` — `detectSituations` (208-243)
- `apps/ecommerce/runtime/scheduling/scheduler.ts` — 唯一 `setInterval` (line 105)，默认 disabled
- `apps/ecommerce/experience/learning-context-producer.ts` — `loadSituation` (41-45) + `recordInterventionInLearningContext` (118-148) + `storeInvestigationInLearningContext` (171-199)
- `apps/ecommerce/experience/extraction.ts` — `extractMemories` (108-) **no callers**
- `apps/ecommerce/experience/facade.ts` — `MemoryFacade` re-exports
- `apps/ecommerce/memory/store.ts` — `operator_memories` DDL + `upsertMemories` (44-91) **no callers**
- `apps/ecommerce/analysis/metrics/facade.ts` — `SignalFacade`
- `apps/ecommerce/analysis/decision/facade.ts` — `RankingFacade`
- `platform/server/routes/situation-chat.ts` — `runInvestigationTurn` (243-304) + `situationChatRouter` (308-545)
- `platform/server/routes/p0007.ts` — Intervention POST (276-328)
- `platform/server/routes/schedule.ts` — `scheduleRouter` (10-37)
- `platform/server/routes/outputs.ts` — `outputsRouter` (90-)
- `platform/server/routes/chat.ts` — `chatRouter.post('/chat', 276)`
- `platform/server/routes/runtime.ts` — `/runtime/collect` (139), `/fabric/execute` (189)
- `apps/ecommerce/workspace/app.js` — `setInterval(loadData, 300000)` line 3286
- `apps/ecommerce/workspace/presentation.js` — "no scheduler, no wake engine, no event bus" 注释 (278-292)

---

> 本审计与 [hermes-transport-and-token-lifecycle-audit.md](./hermes-transport-and-token-lifecycle-audit.md) 成对：那份回答「Hermes 客户端和 token 缓存在 24/7 部署下能不能活」，这份回答「Runtime execution chain 上每跳的真实触发点」。两者共同钉死当前真实状态——为 P0010.2 (Continuous Runtime Loop) 方向提供事实基础。**本次未修改任何代码、未修复任何问题、未 commit。**
