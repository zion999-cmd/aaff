# Current Runtime Capability Consolidation Audit

- **日期**: 2026-08-19
- **类型**: 只读 Cold-Start Runtime Audit（现实校准，非开发，非 Proposal）
- **核心问题**: 如果今天开发者全部离开，只留下 agentFabric + Hermes + Workspace，系统究竟能独立运行到哪一跳？
- **事实优先级**: 实际代码 > 实际 DB > API > Tests > Proposal / context docs
- **分类框架**: REUSE / WIRE / PROMOTE / REPAIR / REMOVE / MISSING

---

## 0. 结论（先答核心问题）

> **开发者离开 → agentFabric 能自己活到「Situation」这一跳，然后停止。**

它靠**幂等重放**活到 Situation：把冻结的证据（618 文件，最新 08-16）重新推导成 signals → rankings → situations，每次启动都产出**同样**的结果。但它**不采集任何新数据**（"live-on-miss" 采集接了却不触发），Situation 之后的所有跳（Agent 理解 / 建议 / 行动闭环 / 结果回写 / 学习）**全部缺失或占位**。

一句话：**当前 agentFabric 是一个「冻结快照重放器」，不是一个「自我维持的系统」。**

---

## 1. Cold-Start 实测（第三阶段，只观察 Runtime 自己）

### 1.1 启动前置条件（都不由 Runtime 管理 = 开发者依赖）

| 依赖 | 现状 | 谁负责 |
|---|---|---|
| Node 版本 | better-sqlite3 编译于 NODE_MODULE_VERSION 127（Node 22）；系统默认 Node 25.6.1（141）→ `ERR_DLOPEN_FAILED` 直接崩 | 开发者手动 `nvm use 22` |
| Hermes serve | 需另开进程 `hermes serve`（端口 9119），token 需 `HERMES_DASHBOARD_SESSION_TOKEN` 两边一致；或由 agentFabric 自动从 serve 进程 env 发现（`platform/runtime/hermes/token-resolver.ts`） | 开发者手动启动 |
| Chrome CDP | 需 Chrome `--remote-debugging-port=9222` 常驻；Runtime 不启动它 | 开发者手动启动 |

> 冷启动本身不是「一条命令」：需要 Node 22 + Hermes + Chrome-9222 三个外部前置全部就位。

### 1.2 启动后 Runtime 自己做了什么（日志实证）

```
[agentFabric] workspace running at http://localhost:3000
[backfill] 7/7 days completed (2026-08-12 ~ 2026-08-18)
[backfill] rankings regenerated (67 ranked / 67 products)
[backfill] situations: 0 created / 4 deduped
```

### 1.3 启动前后 DB 差分（关键实证）

| 项 | 启动前 | 启动后 | 变化 |
|---|---|---|---|
| Evidence 文件 | 618 | 618 | **0 新增**（最新仍 08-16） |
| Signals 行数 / 最新 observed_at | 5537 / 08-16 | 5537 / 08-16 | **0 新增** |
| Rankings 行数 / 最新 ranked_at | 67 / 08-17 | 67 / **08-19** | 行数不变，ranked_at 被重算 |
| Situations 行数 / 最新 observed_at | 5 / 08-16 | 5 / 08-16 | **0 新增**（4 deduped） |
| 08-17 / 08-18 的 signals | — | **0 行** | 无 |

### 1.4 「7/7 days completed」是误导

backfill 覆盖 08-12~08-18 共 7 天。但证据只到 08-16。**08-17、08-18 两天没有任何证据，也没有任何信号**（0 行），`[backfill]` 却报 "7/7 completed"。

`createLocalFirstLiveAcquire`（[historical-acquire.ts](apps/ecommerce/connectors/jd/historical-acquire.ts#L76)）的逻辑是「local evidence → live CDP on miss」，但实测：Chrome 9222 明明在跑，**CDP 一次都没触发**（日志零 CDP 行），两天缺失日期零产出。所以：

> **"数据库里已经有数据" ≠ "Runtime 会持续产生这些数据"。** 现有 evidence 是历史上 Claude/CLI/E2E 采集的，backfill 只是重放它们。Runtime 的"自主采集"这一腿，实际上接了但**不触发**。

---

## 2. Current Product Runtime Map

```
External World
      ↓
Acquisition          PROMOTE   —— CDP 采集真实（acquireJdData），但属 developer-driven（CLI collect / POST /api/runtime/collect / 手工 CDP）。
      ↓                            backfill 的 "live-on-miss" 接了却不触发（08-17/08-18 零产出，Chrome 9222 在跑但 CDP 未发生）。
Evidence             REUSE     —— store + loadEvidence 真实，618 文件；但全部是 dev 历史采集，非 Runtime 自主产生。
      ↓
Signals              REUSE     —— SignalFacade 幂等重推导（5537 行，upsert 无新增）。
      ↓
Ranking              REUSE     —— RankingFacade 幂等重算（67 行，ranked_at 更新）；数据非差异化（全 0.4648）。
      ↓
Situation            REUSE     —— SituationProducer 启动时跑，幂等 dedup（0 created / 4 deduped）。
      ↓
Agent Understanding  MISSING   —— AgentActivityRefSchema 仅 schema，无 producer/持久化；UI 用 "Agent 分析: {desc}" 回显占位。
      ↓
Recommendation       MISSING   —— UI 硬编码 "Agent 建议: 查看详细数据判断原因"，无任何 recommendation 能力。
      ↓
Human/Agent Action   WIRE      —— intervention POST 真写通（UI→API→DB），但 grammar 压成 flat (type,summary)，写后死路。
      ↓
Execution            REUSE     —— Hermes chat（situation-chat 桥）真实，按需委派；但 Agent Session 事件槽是 demo（task_demo_* 硬编码）。
      ↓
Result               MISSING   —— intervention 只插一行 + 翻 lifecycle，不回写 evidence/memory/ranking，无 result 持久化闭环。
      ↓
Memory / Learning    MISSING   —— context_memories=0，extractMemories 从不被调；operator_memories(12) 有数据但无 UI 且不被 ranking 消费。
      └→ future behavior  MISSING —— 无任何 feedback→adjustment→re-rank 闭环（adjustmentsFor 永远读空表）。
```

---

## 3. 统一分类（第五阶段）

| 分类 | 节点 / 能力 |
|---|---|
| **REUSE**（真实在用） | Evidence store、Signals、Ranking、Situation、Execution(Hermes chat)、Runtime/Replay、Fabric Capabilities |
| **WIRE**（能力在，缺正式链路） | Human Intervention（写通但 grammar 降级 + 死路） |
| **PROMOTE**（只在 dev/CLI/test 路径） | Acquisition(CDP) — 真实但 developer-triggered，需提升为真正自主触发的 Runtime 采集 |
| **REPAIR**（链在，有 correctness bug） | backfill "live-on-miss" 采集（接了不触发）；Evidence Viewer 契约不匹配（读不存在的字段）；ranking explainability.summary 不持久化 |
| **REMOVE**（demo/占位/重复） | renderTracePanel（合成重建 + fabricated "Skills Triggered/MCP Calls"）；agentSession SSE 事件流（task_demo_*）；agentConfig（只 localStorage）；situation-viewmodel.ts（orphaned 死文件） |
| **MISSING**（确认无此能力） | Agent Understanding、Recommendation、Result 回写、Memory/Learning 闭环、Evaluation |

---

## 4. 「开发者离开后能活到哪一跳」的精确线

```
开发者离开
   ↓
✅ 启动（前提：Node 22 + Hermes 9119 + Chrome 9222 已就位）—— 否则崩在 ERR_DLOPEN_FAILED
   ↓
✅ backfill 幂等重放：冻结证据 → signals → rankings → situations（每次都一样，不产生新东西）
   ↓
✅ Workspace 自动渲染：今日工作 5 条 Situation、经营观察 rankings、Capability Explorer 11 个、Evidence Viewer(空)
   ↓
✅ 用户点「追问 Agent」→ Hermes 真实委派（按需，能回答）
   ↓
❌ 采集新数据 —— 停在这里（live-on-miss 不触发，证据永远停在 08-16）
   ↓
❌ Agent 理解 / 建议 —— 占位符，从未真正跑过
   ↓
❌ 人处理 → 结果 → 学习 → 影响未来行为 —— 无闭环，干预写完就死
```

**结论：系统能「活到」Situation 并持续重放同一份旧快照，但「长不大」——它永远重复过去，不吸收任何新世界数据，也不从人的处理中学习。**

---

## 5. 附：两处额外实证

1. **`/api/readiness` 自报**：`{workspace: ready, capabilities: 11, jd_cdp: ready, evidence: 100}` — capabilities(11) 真实（读 generated/capability-contract.json），jd_cdp(ready) 真实（探测 Chrome 9222），但 `evidence: 100` 是 `listEvidence({})` 的默认 limit 截断，**非真实总数 618**（轻微误导）。
2. **`operator_memories`(12 行) 与 `context_memories`(0 行) 双轨并存**：前者有数据无 UI、不被 ranking 读；后者有 UI（但被标 Legacy 隐藏）无数据、提取管线从不跑。两套都不可见、不闭环。

---

## 6. 关键文件索引

- `platform/server/index.ts` — main() + `backfillRecentData`（唯一自主 producer，P0009 引入）
- `apps/ecommerce/connectors/jd/historical-acquire.ts` — `createLocalFirstLiveAcquire`（local→CDP on miss，实测不触发）
- `apps/ecommerce/runtime/situation/producer.ts` — SituationProducer（启动时幂等 dedup）
- `platform/server/routes/runtime.ts` — /readiness /runtime/* /fabric/execute /evidence/:id /events/:taskId
- `apps/ecommerce/workspace/app.js` — boot()(1876) → switchView('situations')；loadSituationDetail(887) 的占位层；renderTracePanel(1624)；connectEventStream(1120)
- `apps/ecommerce/analysis/pattern/engine.ts` — operator_memories producer（6 端点无 UI）
- `apps/ecommerce/experience/` — extractMemories 从不被调（context_memories 恒空）
- `shared/schemas/learning-context.ts` — AgentActivityRef / LearningContext / HumanIntervention schemas

---

> 本审计与 `professional-capability-surface-audit.md` 成对：一份回答「专业人员现在拿到了什么」，一份回答「系统离开开发者以后自己还能做什么」。两者共同钉死当前真实状态。**本次未修改任何代码、未修复任何问题、未 commit。**
