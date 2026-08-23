# 交接文档

## 本次会话 (2026-08-23) - P0010.1 REPAIR-6（Output Workspace 三处语义收紧：knownEvidence 不再伪 Evidence、状态机 forward-only、label 唯一事实源落地）

### 目标

用户审 `e270c7e` 之后找到 3 个语义问题：①`knownEvidence` 被混进 `evidenceRefs` 假冒 Evidence；②PATCH 任何状态都能改任何状态，没有真正执行状态机；③`app.js` 还有两套本地 label 常量，"label 单一事实源" 只在 Detail 表面成立。**REPAIR-6 严格按用户边界**（不改 Trust schema / 不改 delivery 设计 / 不接 transport / 不改 UI 产品结构）做 3 处最小收紧。

### 三处修复

1. **P0 Trust: `knownEvidence` 不再是 Evidence** — 之前 `outputs.ts` 把 `findings[].evidenceRefs` 和整个 `investigation.knownEvidence[]` 合并进 `evidenceLabels`，只要任一存在就 `hasEvidence=true`。但 `knownEvidence` 是 free-text 调查笔记，可能含 "Prior human guidance…" / 知识规则 / 运营笔记，**和外部 Evidence 完全不是一类**。改成：
   - `hasEvidence` 只由 `findings[].evidenceRefs.length > 0` 驱动
   - `evidenceLabels` 只含 `findings[].evidenceRefs`（**不**含 `knownEvidence`）
   - `knownEvidence` 保持原状仍在 canonical investigation 表面（`/api/situations/:id` response / Situation Detail Layer 2）— 但不进入 provenance
   - 用户原话: "无法分类的保持普通文本，禁止猜 Knowledge/Human 类型"
   - 新测试 `REPAIR-6: provenance is hasEvidence:false when ONLY knownEvidence is present` 专门覆盖该路径

2. **PATCH 状态机 forward-only** — 之前 PATCH 只做 enum 校验，`closed → ready` / `acknowledged → delivered` 都能成功。改成显式 forward-only：
   - `STATUS_ORDER = { ready: 0, delivered: 1, acknowledged: 2, closed: 3 }`
   - `body.status === prev.status` → 400（防止 re-stamp `acknowledgedAt` / `closedAt` — 重新确认不是新事件）
   - `STATUS_ORDER[body.status] < STATUS_ORDER[prev.status]` → 400 with "rollback rejected" 错误
   - skip-ahead 允许（`ready → acknowledged` / `ready → closed` 直接跳）
   - `closed` 是 terminal（任何 further PATCH 拒绝）
   - **WorkItem.closed 仍然不影响 Situation lifecycle**（不变）
   - 新测试 4 个: backward reject / closed terminal / same-status no-op / skip-ahead still works

3. **Label 单一事实源落地** — 之前虽然 schema → `output-labels.js` 通了，但 `app.js` 残留 2 套本地常量 (`OUTPUT_COLLECTION_STATUS_LABEL` / `OUTPUT_COLLECTION_TYPE_LABEL` + `OUTPUT_STATUS_LABEL` / `OUTPUT_TYPE_LABEL`)，Collection / Situation 内嵌摘要直接用本地副本，所以**实际是 3 套显示常量**。改成：
   - 删 4 个本地常量
   - 顶部定义 2 个 helper: `getOutputStatusLabel(s)` / `getOutputTypeLabel(t)`，都从 `window.WORK_ITEM_*` 读，**单一入口**
   - 7 个使用点（Collection placeholder / Collection row type+status / Detail type+status / Situation summary type+status）全部改 helper
   - Defensive `|| {}` 兜底（防止 `output-labels.js` 加载失败时 crash；CI 必跑 contract test 保证不漂移）

### 边界（严格遵守）

- ❌ 不改 Trust schema（provenance 仍是 inline JSON）
- ❌ 不改 delivery 设计（`delivered` 状态语义仍悬空 — 用户明示 "等我们讨论 Human Protocol 时再决定 delivered 的真正 authority"）
- ❌ 不接 transport
- ❌ 不改 UI 产品结构
- ❌ 不增加 schema 字段

### 验收

- `npx vitest run tests/integration/outputs-api.test.ts tests/contract/output-labels-sync.test.ts` — **35/35 ✅**（29 integration + 6 contract，含 5 个新 REPAIR-6 测试）
- 全量 717/717 pass（pre-existing 1 test failure 偶发：chat.contract.ts 5s timeout，flaky，与本刀无关）
- 浏览器 Playwright smoke (`/tmp/verify_repair6.py`)：labels 暴露 ✅ / Collection 3 items 状态+类型正确 ✅ / Detail 状态表 6 行 honest ✅ / source tag `人工` 真实显示（demo 的 evidenceRefs 数组空时不会假造 `证据`）✅ / PATCH skip-ahead ready → closed 200 ✅ / 0 console error ✅
- typecheck 0 新增错误

### 文件改动

- 修改：`platform/server/routes/outputs.ts`（provenenace 只读 evidenceRefs / PATCH 状态机 forward-only guard）
- 修改：`apps/ecommerce/workspace/app.js`（删 4 个本地 label 常量 + 顶部 2 个 helper + 7 个使用点统一）
- 修改：`tests/integration/outputs-api.test.ts`（5 个新 REPAIR-6 测试 + 1 个 canonical-path 测试断言 evidenceLabels 不再含 knownEvidence）
- 修改：`context/{current_state.md,decisions.md,handoff.md,status.json}`

### 未做（明确不属本刀）

- **`delivered` 状态语义** — 用户明示 "等讨论 Human Protocol 时再决定 delivered 的真正 authority"，不属本刀
- **Trust schema 化** — provenance 仍 inline JSON；first-class `provenance` 表是 P0011+ scope
- **Action/Approval / transport** — 都不在 REPAIR-6 范围

---

## 本次会话 (2026-08-22) - P0010.1 REPAIR-5（Output Workspace 诚实性：canonical path、no fake source、no deliveredAt、统一 label、global badge）

### 目标

ChatGPT 审了 `40afdc6`（REPAIR-1/2/3 + Output Workspace v0）后找到 4 个真实断点 + 2 个小问题。Claude 按用户给的边界（**不改 Situation lifecycle、不做 Trust schema、不接 transport、不做 Action/Approval**）只做 6 件事的最小诚实修复。

### 六处修复

1. **P0：canonical 路径** — `GET /api/outputs/:oid` 之前从 `ctx.currentUnderstanding` / `ctx.recommendation` 顶层读，但 `InvestigationSchema` 把它们放在 `ctx.investigation.*`。改成从 `ctx.investigation.currentUnderstanding` / `ctx.investigation.recommendation.recommendation` / `ctx.investigation.recommendation.rationale` 读。**测试通过**（seed 故意写了顶层假字段 `SHOULD-NOT-BE-READ`，断言它们**不被**读出 — 反向证据）。

2. **P0：mark-delivered 端点删除** — `POST /api/situations/:id/outputs/mark-delivered` 整体删除（之前在 Situation detail 打开时把所有 `ready` → `delivered`，违反"打开页面 ≠ 已交付"）。`WorkItemSchema` 顶部注释 + 4 处 app.js 旧注释都改成 REPAIR-5 真实语义。**测试通过**（`POST .../mark-delivered` 返回 404，且没有任何 `ready` 被偷偷转成 `delivered`）。

3. **P0/P1：Source tag 真实存在才显示** — 之前 Output Detail/右栏**固定渲染 4 个 tag（证据/人工/知识/记忆）**不管这个 Output 实际是否引用了任何 source（假来源类别）。改成：服务端 `GET /api/outputs/:oid` 返回 `provenance = { hasHuman, humanInterventions[], hasEvidence, evidenceLabels[], hasKnowledge, knowledgeLabels[] }`，**只包含真实存在的 fact**；`hasKnowledge` 始终 `false`（本刀无 first-class Knowledge 记录，**绝不伪造**）。前端 `renderOutputDetail` + `renderOutputDetailRightPane` 都改用 `out.provenance` 条件渲染 — 有 2 个真实 source 时显示 2 个 tag，0 个真实 source 时显示「本交付物尚无 first-class provenance」诚实提示。**浏览器验证**（`/tmp/verify_repair5.py`）：seed 的 demo Output 有 2 个真实 source → 显示 `证据` + `人工` 两个 tag，不是 4 个假的。

4. **P1：删除 交付时间 / deliveredAt** — `WorkItemSchema` 根本没有 `deliveredAt` 字段（无 Transport，无 delivery event），但 UI 之前显示「交付时间」永远 `—`。按用户偏好**从 UI 删除该行**，**不**为它新增 schema 字段。Output Detail 状态表现在 6 行：当前状态 / 生成时间 / 确认时间 / 关闭时间 / 交付渠道 / 外部发送。**测试通过**（断言 `body.data.deliveredAt === undefined`）。

5. **小：状态 label 统一** — `WORK_ITEM_STATUS_LABEL` 在 `shared/schemas/output.ts` 是 single source of truth（待交付/已交付/已确认/已关闭）。Workspace 是 vanilla JS 不能 import TS，**新加 `apps/ecommerce/workspace/output-labels.js`** 把 schema label 镜像到 `window.WORK_ITEM_STATUS_LABEL` / `window.WORK_ITEM_TYPE_LABEL`，`index.html` 在 app.js 之前加载。**新增 contract test `tests/contract/output-labels-sync.test.ts`**（6 个断言）保证两份自动同步不漂移。

6. **小：左栏 Output badge 全局含义** — `updateOutputsBadge(items)` 之前接收 filtered `items.length`（切到 closed tab badge 就缩成 0），违反"badge 是全局工作输出总数"的语义。改 `loadOutputs` 用 `Promise.all` 同时拿 filtered 列表 + unfiltered 列表，badge 永远用后者。**浏览器验证**：badge 始终显示 `3`（全局总数），切到 closed tab（0 items）badge 不变。

### 边界（严格遵守）

- ❌ 不改 Situation lifecycle（5 状态保持）
- ❌ 不做 Trust schema（provenance 还是 inline JSON，不持久化）
- ❌ 不接 transport（无飞书/邮件/企业微信/Telegram）
- ❌ 不做 Action/Approval（`已知悉/结束` 按钮保持原状）
- ❌ 不增加 schema 字段（不补 `deliveredAt`、不补 `knowledgeId`）
- ❌ 不创建第二套 Output Store

### 验收

- `npx vitest run tests/integration/outputs-api.test.ts tests/contract/output-labels-sync.test.ts` — **30/30 ✅**（24 integration + 6 contract）
- 浏览器 Playwright smoke (`/tmp/verify_repair5.py`)：labels 暴露 ✅ / badge 全局 ✅ / status table 无 deliveredAt 行 ✅ / source tags 只 2 个真实 ✅ / 0 console error ✅
- 全量 693 tests pass（pre-existing 2 failures 不变：`chat.contract.ts` 5s timeout + `coverage.test.ts` 58% > 50%）
- typecheck：仅 pre-existing 错误，本刀 0 新增

### 文件改动

- 修改：`platform/server/routes/outputs.ts`（canonical path + 真实 provenance + 删 mark-delivered + header comment REPAIR-5 说明）
- 修改：`shared/schemas/output.ts`（删旧 auto-deliver 注释，4 状态 label 改 canonical 中文）
- 修改：`apps/ecommerce/workspace/app.js`（`renderOutputDetail` / `renderOutputDetailRightPane` 用 `out.provenance` + 删 `deliveredAt` / `loadOutputs` `Promise.all` 全局 badge / 4 处旧 `/mark-delivered` 注释清理）
- 新增：`apps/ecommerce/workspace/output-labels.js`（mirror schema → `window.*`）
- 修改：`apps/ecommerce/workspace/index.html`（`output-labels.js` 在 app.js 前加载）
- 修改：`tests/integration/outputs-api.test.ts`（删 mark-delivered 测试 → 改 404 断言 + 加 3 个新 REPAIR-5 测试：no deliveredAt / provenance 真实 fact / canonical path 反向证明）
- 新增：`tests/contract/output-labels-sync.test.ts`（6 个 sync 断言）
- 修改：`context/{current_state.md,decisions.md,handoff.md,status.json}`

### 风险与建议下一步

- **风险**: `output-labels.js` 是 schema 的 1:1 mirror，**靠 vitest contract test 防漂移**（CI 红 = 必须同步）。如果 schema 改 label 但忘改 JS，UI 会显示 undefined 字符串兜底（不崩溃），但产生漂移告警。
- **下一步候选**（不属本刀）: P0011 Evidence Identity（解锁 `evidence` resultRef kind，**首次**让 `hasEvidence: true` 真正有 first-class 记录）/ P0011.1 Knowledge Provenance（解锁 `hasKnowledge`）/ P0012 Operations（解锁 wake + event bus）/ Transport（解锁 `deliveredAt` / 真实 delivery 状态机）— 这些都标为 future slice，不在 REPAIR-5 范围。
- **Trust schema 候选**: 现在的 `provenance` 是 inline JSON（每请求现算），未来如要做 trust popover / 多 source 引用统计，需要 first-class `provenance` 表（仍是 P0011+ scope）。

---

## 本次会话 (2026-08-22) - P0010.1 Workspace Productization Baseline 1.0（已 commit）

### 目标

按 18 节人类侧呈现契约打磨 Workspace，让人打开任一 Situation 在 10 秒内回答 10 个问题（What/Why/Who/Where/Sources 等）。**不创建第二套 Memory/Knowledge/Catalog，不重设计 Hermes session，不为了页面漂亮伪造 Evidence/Knowledge/Source**。

### 关键成果

1. **3 demo situations**（`sit_observe_demo` / `sit_human_demo` / `sit_failed_recover_demo`）作为不可绕过样本，覆盖完成态、有人工反馈、失败+有上次有效判断三种关键状态。Seed 幂等。
2. **Hero block**（"当前判断 + 建议 + 调查状态"）置顶 Layer 1 之下、Layer 2 6 块之上；failed+hasPrior 时顶部加红色 Stale banner；business mode 隐藏原始 error，developer mode 显式。
3. **Honest Source Tag** `[E]/[K]/[H]/[M]` 4 kind 正确渲染；未识别 kind 不渲染（不伪造）；[H{n}] 标签由 `humanInterventions[]` index 真实计数（如 sit_human_demo 3 条 → `[H1] … [H3]`）。
4. **失败业务化**（`humanizeError` 4 种常见 error 字符串 → 中文）+ **Track 投影**到现有 `#decisionPanel` 右侧 pane（HARD RULE：不放第二条 Track 列在 Situation 主区），通过 `decisionEntityLabel="调查过程 · {entity.name}"` 与 Ranking Explainability 区分。
5. **5 个 schema blocker 显式声明**（SB-1~SB-5，详见 `context/p0010_1_productization_baseline.md`）— 不修，记入 P0011 候选，不为了页面漂亮伪造引用。

### 验收

- 3 截图：`data/fabric-workspace/screenshots/{01_observe,02_human_guidance,03_failed_recover}.png` ✅
- 24 contract tests in `tests/contract/investigation.contract.ts` ✅
- 3 integration tests in `tests/integration/three-demo-situations.test.ts` ✅
- 浏览器真实打开 3 demo，Hero / Source Tag / Stale banner 全部按契约显示 ✅

### 文件改动

- 新增：`apps/ecommerce/workspace/presentation.js`（7 个 pure helpers）+ `presentation.d.ts`（types）+ `scripts/seed-demo-situations.ts`（idempotent seed）+ `scripts/capture-demo-screenshots.ts`（Playwright 1223 截图）+ `tests/integration/three-demo-situations.test.ts`（3 测试）+ `context/p0010_1_productization_baseline.md`（18 节验收对照）
- 修改：`apps/ecommerce/workspace/app.js`（6 helper 接入 + Hero 块 + decisionEntityLabel + detailHtml track 事件 + 移除重复 title block）+ `styles.css`（.hero-block / .source-tag / .inv-stale-banner）+ `apps/ecommerce/runtime/situation/rules.ts:175`（business language）+ `package.json`（seed:demo-situations script）+ `tests/contract/investigation.contract.ts`（+24 baseline tests）+ `context/{current_state.md,decisions.md,handoff.md,status.json}`

### 调试经验

发现一个**易踩的 schema 类型陷阱**：`recommendation.{risks, prerequisites, humanNeeded}` 在 production schema 归一化为 `string[]`，但 seed 当时用 string 写，UI 的 `list(rec.risks)` 走 `risks.map(...)` 时 throw `"items.map is not a function"`。修复 = seed 全部用 `string[]`。后续 seed demo 数据应强制走 Zod parse-in 校验路径。

### 风险与建议下一步

- **风险**: 3 demo situation_id `sit_observe_demo` / `sit_human_demo` / `sit_failed_recover_demo` 与生产 SHA256 命名空间隔离（dev 不会混淆），但若运营不识别"DEMO"标签可能误判。**建议**: 下一刀给 demo 卡片加视觉标识（如 prefix `[DEMO]`）。
- **P0011 候选**: P0011 Evidence Identity（解锁 SB-1）/ P0011.1 Knowledge Provenance（解锁 SB-2 + SB-6）/ P0011 Trust Schema（解锁 SB-4）/ P0012 Operations（解锁 SB-5）/ P0013 Memory Bridge（解锁 SB-3，Memory 写仍在 Runtime）。

---

## 本次会话 (2026-08-21) - P0010.1 Workspace Semantic Cleanup（已 commit）

### 目标

诊断证明 P0010.1 Initial Acceptance 不成立（18 个 Situation 仅 4 个有 investigation，其余停在旧 Pattern fallback，且 auto-investigation 只覆盖 createdIds + 失败静默丢失）。按现有 P0010.1 原地 REPAIR，把已实现的智能从旧 UI 壳子里释放。

### 三刀

1. **Slice 2 恢复机制**：InvestigationSchema + status/error/startedAt；runInvestigationTurn 持久化 investigating 标记 + 失败 failed 标记（不静默丢失）+ 完成自动 Recommendation；backfill findRecoveryCandidates（无 completed 的 situation，stopReason 视为 completed）+ autoInvestigatePending（有界 3、顺序后台）。
2. **UI 诚实化**：5 种状态可见；Pattern 降级「初始信号归因」；「交给 Agent 调查」→「🔄 立即调查（恢复）」。
3. **Workspace Semantic Cleanup（ADR-047，7 项）**：见 ADR-047。

### 真实验收

- 恢复机制：2 个无人工点击自动调查完成（转化率 +20.6%、访客/转化相反），均 observe + 自动 Recommendation + 真实取证（trade.overview/traffic.overview/trade.detail）。
- 4 状态浏览器验收：pending（尚未调查+预览）/ investigating（正在调查+预览）/ completed-observe（完整契约）/ needs-human（真异常需人工核验）。
- Sidebar 互斥计数 11+2+4+1+0=18；无「查看 Evidence」直连；无 action 按钮；capability 业务标签（交易概览/流量分析/商品表）；version v0.10.6（readiness 读 status.json）。

### 关键边界（本刀确立）

- **investigation timeout/failure = Runtime reliability**，Workspace 已诚实显示，不再通过 UI fallback 掩盖，不在本刀修。
- Human interaction 止于 Judgment + Recommendation feedback（6 个 canonical 按钮），action_intent 移除（Action 越界）。
- 不开始 Action/Approval；Evidence Viewer 保留 Advanced provenance。

### 测试

全量 605（595 passed + 2 pre-existing + 8 http 瞬态 skip），http 独立 8/8，investigation 18/18，typecheck 17 基线。

### 状态

P0010/P0010.1 最重要的东西第一次完整站起来：Situation → Agent 自己知道该问什么 → 自己取证 → 形成理解 → 给出建议 → 把为什么这么判断展示给人。**下一步（用户发起）：设计 Action Proposal 阶段（approval boundary / execution / result / experience evolution）——当前 6 个 feedback 按钮是 canonical human feedback，不提前改。**

---

## 本次会话 (2026-08-21) - P0010.1 Slice 4（Recommendation）→ P0010.1 全部完成

### 目标

P0010.1 的终点 Slice：Recommendation 从 Investigation/Judgment 产生（禁止 Signal→Rec），Workspace 展示 + 反馈 REUSE。至此 P0010.1 六个 Slice 全部完成。

### Slice 4 实现

- `RecommendationSchema`（investigation.ts）：recommendation/rationale/expectedOutcome/risks/prerequisites/humanNeeded；risks 等接受 string-or-list 归一化（模型自然产出数组）。
- prompt 第 9 步 JSON 加 recommendation 形状 + 严格约束（只从 judgment 产生；observe → 不干预；不写 Action）。
- `POST /api/situation/:id/recommend`：同一 session 短 follow-up turn，`extractJsonObject` 防御解析，持久化增量，600s 超时。
- Workspace：Understanding「建议」section（原文+依据+预期+风险+前提+需人工）+ 无建议时「生成建议」按钮；反馈 REUSE intervention grammar。

### 真实验收（orders 真异常需人工核验）

持久化 Recommendation：「暂停一切自动调价或加投广告的决策，先完成人工核验（优惠券/促销到期 → 主力子SKU库存状态 → 京准通账户预算与计划状态），核验结果确认后再在24-48h观测窗口内评估修复动作效果；若确认促销到期，优先短期补发券或切换平销策略，而非直接扩流量」+ rationale（链接 judgment 真异常/复合故障）+ risks×3 + prerequisites×4 + humanNeeded×4（财务/仓储/广告投放负责人核验项）。浏览器在 Understanding 表面显示 + intervention/chat 无回归 + console 零 error。

### 调试记录

- recommend 首次 JSON 解析失败：模型返回 ` ```json {...} ``` `（markdown fence）+ risks 为数组——修复 extractJsonObject 复用 + RecommendationSchema string-or-list 归一化。
- 模型延迟波动：240s 超时不够，提到 600s；多次重试后成功（模型产出质量高，但耗时 4-8 分钟波动）。

### 测试

604 total / 596 passed（2 pre-existing + http 套件瞬态 skip），typecheck 17 基线。investigation.contract +2（RecommendationSchema 归一化）。

### P0010.1 完成状态

- Slice 0（Wiring Audit）✅ 无 schema gap
- Slice 1（Workspace Investigation Surface）✅ 列表状态+Track+Current Understanding hero
- Slice 2（Automatic Investigation）✅ 完整模型验收（UV -47.5% 无人工点击自动调查→持久化→Workspace）
- Slice 3（Scheduled Acquisition）✅ run-now trade.overview→completed→新 Evidence
- Slice 4（Recommendation）✅ orders 从 judgment 生成建议+Workspace 显示
- Slice 5（Human Feedback）✅ REUSE intervention grammar（decision/accept→LC）

### 建议下一步

P0010.1 完成。按 P0010/P0010.1 boundaries，本阶段止于 Recommendation，无外部 Action。下一阶段（用户发起）考虑：Action Proposal（需 Approval/Policy），或补真实业务异常数据验证 B 纯路径/D/E。

---

## 本次会话 (2026-08-21) - P0010.1 Slice 2+3（Automatic Investigation + Scheduled Acquisition）

### 目标

P0010.1 把 P0010 从人工触发 Demo 提升为 steady-state。完成 Slice 2（新 Situation 自动调查）+ Slice 3（Scheduled Acquisition 最小化）。Slice 5（Recommendation feedback）REUSE 验证。

### Slice 2 — Automatic Investigation（wire 验证通过，模型验收受 P0009 延迟影响）

- 抽取 `runInvestigationTurn`（prompt + 两阶段契约提取 + 持久化）到 situation-chat.ts，route 与 backfill 共用（DRY，无重复实现）。
- `runSituationProducer` 返回 `createdIds`（新增 situation ids）。
- backfill 对每个新 Situation **无人工点击**自动调查：`autoInvestigateSituation`（导出）→ HermesSessionClient + createSession + runInvestigationTurn，fire-and-forget 不阻塞 startup，诚实 timeout/degradation。
- **wire 验证**：auto-investigate 在真实未调查 anomaly（UV -47.5%）上运行 → session 创建 ✓、prompt 提交 ✓、600s 诚实 timeout（模型未完成，无伪造）。重试运行中。

### Slice 3 — Scheduled Acquisition（API + run-now 验证通过）

- `apps/ecommerce/runtime/scheduling/scheduler.ts`：最小每日 setInterval runner（非 scheduler engine），REUSE `kernel.execute`（local-first live acquire）→ Evidence Store。`onAfterRun` 触发 runSituationProducer → 新 Situation → 自动调查（闭合 steady-state 循环）。
- `GET/POST /api/runtime/schedule`（list/run-now）。默认配置 trade.overview@02:00 / traffic.overview@02:05（enabled:false，避免意外 CDP）。
- **验证**：run-now `trade.overview` → `lastStatus: completed` → 新 Evidence（2026/08/21_trend.meta.json）落盘，完全复用现有路径（无第二套 acquisition）。

### Slice 5 — Recommendation Feedback（REUSE 验证通过）

现有 intervention grammar「采用建议/不采用/稍后处理」已是 Recommendation feedback → POST interventions → human_interventions + Learning Context。已验证 decision/accept（"采用建议: 同意优先排查优惠券到期"）落库。

### 测试

600/602 passed（2 pre-existing），typecheck 17 基线。零新测试文件（Slice 2/3 wire 以 API/浏览器实测验证）。

### 剩余

- **Slice 4 Recommendation**：从 Judgment 产生（扩展 InvestigationSchema 或 follow-up turn），禁止 Signal→Rec。需模型 turn（P0009 延迟风险）。
- Slice 2 完整模型验收：重试 auto-investigate 等待结果；若模型完成 → Workspace 显示该 Situation 状态（observing/judgment_ready）。

---

## 本次会话 (2026-08-21) - P0010.1 Slice 0+1（Workspace Investigation Surface）

### 目标

P0010.1 把 P0010 从人工触发 Demo 提升为 steady-state：Workspace 从 Signal/Ranking 告警中心调整为 Agent Operations Workspace。按提案 Implementation Sequence 从 Slice 0（Wiring Audit）开始，完成 Slice 1（产品表象追上 P0010）。

### Slice 0 — Wiring Audit（无 schema gap）

| 项 | 判定 |
|---|---|
| Situation 产生 | REUSE（runSituationProducer，index.ts:163） |
| Automatic Investigation 触发 | WIRE（investigate 逻辑内嵌 situation-chat 路由，需抽取 + 自动触发——Slice 2） |
| Investigation 入口 | REUSE（POST /api/situation/:id/investigate，session 复用/两阶段提取/持久化） |
| Investigation Track 重建 | WIRE（**从已持久化契约派生**，零 LLM/CoT/schema 变更） |
| Intervention UI | REUSE（「采用/不采用」已是 Recommendation feedback） |
| Recommendation | MISSING（Slice 4，旧「Agent 建议」=Signal→Rec 被禁止） |
| Scheduler | MISSING（Slice 3，无 primitive） |
| Situation 列表 | WIRE（+investigation summary） |
| Ranking Explainability | REUSE（secondary） |

### Slice 1 — Workspace Investigation Surface（浏览器验收通过）

- `/api/situations` join learning_contexts → per-situation `investigation` summary（`deriveInvestigationStatus`：observing/needs_human/judgment_ready，从 stopReason+人工核验 markers 派生，纯函数无 LLM）。
- Situation 列表卡片：Agent 状态 chip（观察中/未调查/需人工核验/已判断）+ judgment 摘要行。
- Situation Detail：**「调查过程」Investigation Track 一等 UI**——时间线（发现→调查问题→获取证据→假设更新→能力边界→判断→停止），全部派生自持久化 investigation（findings/hypotheses/capabilityUsed/stopReason），非 CoT。
- Current Understanding（ADR-043 hero）保持主表象；Track 回答 HOW；「为什么这么判断」保留证据下钻。

### 浏览器验收

- 列表 14 卡片：CVR→观察中+judgment 行；其余→未调查。
- Case A（GMV→observe）Track 10 步：发现→问题→周末节律→问题→发现→获取证据（trade.overview 4天）→假设更新（周末效应已支持/真异常已弱化）→下一问题→判断（伪异常）→停止（建议观察）。
- Case B（orders→真异常）Track 9 步：发现→问题→周同比-82.5%真异常→问题→双降→下一问题（广告账户）→**能力边界（京准通需人工核验）**→判断→停止。
- console 零 error；零 LLM 渲染；reload 持久。

### 剩余 Slice 评估（下一步）

- **Slice 2 Automatic Investigation**：抽取 investigate 核心为可复用函数 + backfill 后对新 situation 自动触发（涉及模型运行，需诚实 timeout）。验收需新 Situation 出现——当前数据难确定性触发。
- **Slice 3 Scheduled Acquisition**：最小 setInterval scheduler（无 cron primitive），复用 capability→Evidence 路径。
- **Slice 4 Recommendation**：从 Judgment 产生（扩展 InvestigationSchema 或 follow-up turn），禁止 Signal→Rec。
- **Slice 5 Human Feedback**：REUSE intervention grammar（采用/不采用已存在），反馈入 Learning Context。

### 建议

Slice 1 已使 Workspace 产品表象追上 P0010 Runtime。Slice 2-5 涉及模型触发/调度/契约扩展，按用户指示逐刀推进。

---

## 本次会话 (2026-08-21) - P0010 Current Understanding Workspace Surface

### 目标

P0010 Runtime/Behavioral Validation 已成立。补最后一个产品层缺口：把已持久化的 Investigation/Understanding 提升为 Workspace 一等业务表象。**不是新增推理能力**，是把已有认知状态正确投影到 Workspace。

### Canonical semantics（本刀确立）

Current Understanding（主表象）vs Chat/Intervention（可改变理解的交互）vs Trace/调查依据（次级下钻）。本刀停在 Situation → Current Understanding，不进 Recommendation/Action。

### 实现（仅 app.js，零后端改动，零 LLM）

- Situation Detail 重构：`🧠 Agent 当前理解` hero 层（6 段运营语言）+ `为什么这么判断？/查看调查依据` Trace 次级入口。
- `renderCurrentUnderstanding`：当前判断（judgment 原文 + verdict）、已确认（findings 可读行 + 依据）、当前假设（状态标签）、还不知道（unknowns + requiredEvidence）、下一步调查（真实 nextQuestion；observe-stop 显示"建议观察后续数据"+ muted 观察项，不伪装活跃）、能力边界。
- `deriveCapabilityBoundary`：**只从 Agent 自己的措辞派生**（stopReason missing_capability/ask_human，或 judgment 含 人工核验/无法获取），不硬编码运营判断、不重算。
- `renderInvestigationTrace`：次级下钻（capabilityUsed/evidenceAcquired/时间 + 信号归因）。
- 预调查状态：无 investigation 时保留 Pattern 归因 + 建议 + 「交给 Agent 调查」按钮。

### 真实浏览器验收（全过）

- **Case A**（GMV -67.9% 周末节律）：当前判断=【伪异常判定】禁止干预 + 调查结果·建议观察暂不干预；下一步调查=「当前无需继续调查，建议观察后续数据」；能力边界正确隐藏（伪异常无缺口）。肉眼可判断 伪异常→observe→不干预。
- **Case B**（orders -66.7% 真异常）：当前判断=【真异常需人工核验】；已确认=周同比-82.5%真实；5 假设；下一步调查=付费广告账户京准通状态；**能力边界=⚠ 京准通账户余额/预算/广告计划状态/渠道占比需人工核验**（来自 Agent 自己的 judgment"需人工核验"+requiredEvidence）。肉眼可判断 真异常→竞争假设→missing evidence→能力边界。
- reload 后 Case A 状态仍在；console 零 error；intervention/chat 无回归（三 case 均 hasIntervention/hasChat）；预调查 situation 显示 Pattern 归因+建议+按钮。
- **无新 LLM 调用**（渲染纯消费持久化 JSON）、**无新 evidence acquisition**。

### 关键决策（ADR-043）

- HARD RULE：禁止为 UI 调 Hermes/LLM 生成"理解摘要"——消费 P0010 已产生已持久化的认知结果。
- observe-stop 不把 nextQuestion 伪装成活跃调查（显示为 muted 观察项）。
- 能力边界只从 Agent 措辞派生（不重算、不硬编码、不包装成已知道答案）。
- Trace 是次级，不抢占 Current Understanding 主表象。

### 测试

600/602 passed（2 pre-existing），typecheck 17 基线。零新增测试文件（纯 Workspace 投影）。

### 建议下一步

P0010 产品层缺口已补。按指示停止，不继续 Action Proposal。下一阶段（如用户发起）才考虑：从 Investigation/Judgment 进入 Action Proposal，或补真实业务异常数据验证 B 纯路径/D/E。

---

## 本次会话 (2026-08-21) - P0010 Behavioral Validation（A-E 五类行为）

### 目标

P0010 Initial Acceptance 已通过（一个 happy path）。本轮不做横向扩功能，用现有真实 Situation/Knowledge/Capabilities 刻意验证 A-E 五类结果，判断 Agent 是否真的学会了像专业运营一样调查（而非刚好在一个 GMV case 上表现聪明）。

### 真实运行结果（3 个 Situation，全部持久化到 learning_contexts）

| 场景 | Situation | 结果 | 判定 |
|---|---|---|---|
| **A 伪异常→observe** | GMV -67.9% (08-16) | 周末节律伪异常；capability=trade.overview 真实取证 4 天 | ✅ |
| **A 伪异常（另一机制）** | CVR -21.2% (08-20 周四) | **小样本统计噪声**（UV<500、GMV 反升 +19.7%、客单价 +48%）；未取证（现有证据够用） | ✅ |
| **B 真异常→judgment** | orders -66.7% (08-16) | 真异常确认（周同比 8/9 40单→8/16 7单 = -82.5%）；5 假设；优先排查清单（优惠券到期>断货>京准通） | ✅ |
| **C 多假设竞争** | orders run | **5 个竞争假设**（优惠券/差评/断货/广告/算法降权），选最高信息增益问题（广告账户状态），**未把所有 capability 全调** | ✅ |
| **D MISSING_CAPABILITY** | orders run | 模型识别所需证据（京准通账户余额/预算/广告计划/差评/断货）**非 Fabric 能力**，列为人工核验——但 stopReason=judgment 而非 missing_capability | ⚠️ partial |
| **E 证据矛盾** | 当前数据无矛盾证据 | 无法触发 | ⚠️ not provable |

### 关键行为发现

1. **伪异常门稳定成立**：模型持续用「周同比>类目大盘>日环比」「单天波动±15%优先观察」判断真假异常，两次不同机制（周末节律 vs 小样本噪声）都正确拒绝干预。这是「知道什么时候不该动」的高级运营能力。
2. **不必要取证抑制**：CVR 案例证据够用时不重复 Acquisition（proposal §5 语义）。
3. **多假设不盲查**：orders 案例 5 假设选 1 个最高信息增益问题，未全量调用 capability。
4. **能力边界识别**：模型知道 京准通/差评/断货 是 Fabric 答不了的，转人工核验——但 stopReason 落在 judgment 而非 missing_capability（边界行为，非代码缺陷）。

### 数据可用性诚实发现

当前快照（08-12~08-20）被「08-16 周末簇」+「小样本日」主导。**B 的纯路径（真异常→capability 取证→hypothesis supported by 该 evidence）和 E 需要真实业务异常**（真实事件，非周末/噪声）——现有数据不含，无法现场造。模型的「拒绝伪异常」行为本身就是有价值的反幻觉验证。

### 契约保真度观察（非代码缺陷，未来可精修 prompt）

- orders 案例模型实际调用了 fabric_execute（evidence 文件 08-15/16 被触碰）但契约里 capabilityUsed 留空——用了证据但没记录哪个 capability。
- stopReason 边界：judgment vs missing_capability 由模型选，未强制。

### 建议下一步

Behavioral Validation 确认 A/C 稳定、B 成立、D 部分、E 待数据。**从 Investigation/Judgment 进入 Action Proposal** 前，需要一个真实业务异常数据（非周末/噪声）来补足 B 纯路径 + D + E。模型稳定性（>600s timeout）仍是主要工程风险。

---

## 本次会话 (2026-08-21) - P0010 Knowledge-Guided Investigation（Initial Acceptance 通过）

### 目标与定位

proposals/P0010-knowledge-guided-investigation.md 为唯一设计基线。先做 Implementation Readiness / Wiring Audit，无架构冲突后直接实现。核心验证：Agent 不再"读已有数据解释 Situation"，而是基于专业 Knowledge 主动调查——**Knowledge → Better Question → Evidence Acquisition → Updated Understanding**。

### Wiring Audit（先报告后实现）

- Situation → Hermes Session：WIRE（session 只传 cwd/profile；Learning Context 写 situations/<id>.json 但 AGENTS.md 未指向 → 调查 prompt 把 Situation+Evidence 作为 data 注入）
- Hermes → knowledge/INDEX.md + 运营 Knowledge：REUSE（cwd=fabric-workspace，AGENTS.md routing，ingest 已证实可读）
- fabric_execute_capability → Evidence：REUSE（`~/.hermes/config.yaml` 注册 fabric MCP → `/api/fabric/execute` → signals+evidence → Evidence Store）
- capability result → 同一 turn：REUSE（原生 MCP tool-call 返回）
- Learning Context 承载业务产物：WIRE（增量加 Investigation schema，不建新表）
- 持久化：REUSE `learning_contexts` body upsert
- Workspace Situation Detail 接入：WIRE（加 Investigation 层）

### 实现

- `shared/schemas/investigation.ts`：Investigation Contract（Known/Hypotheses/Unknowns/NextQuestion/Findings/Judgment/StopReason）。LearningContextSchema 加 `investigation` optional。
- `apps/ecommerce/runtime/investigation/{prompt,parse}.ts`：`buildInvestigationPrompt`（situation 作 data、指示读 knowledge/、Agent 自主选问题+能力、诚实 stop、必须真实调用 fabric_execute_capability）；`parseInvestigation`（防御式 JSON 提取 + schema 校验）。
- `platform/server/routes/situation-chat.ts`：`POST /situation/:id/investigate`（复用 sessions Map = **同一 Hermes session**；两阶段契约提取：主 turn + 若 prose 则 follow-up 结构化；600s+240s 超时）；`GET /situation/:id/investigation`；`collectTurn` 加 timeoutMs 参数。
- `learning-context-producer.ts`：`storeInvestigationInLearningContext` / `loadInvestigationFromLearningContext`（INSERT/UPDATE，不建新表）。
- Workspace app.js：Situation Detail 加「🔍 调查」层（Agent 当前判断/已确认/当前假设/尚未确认/下一问题/新发现/判断/调查结果）+ 「交给 Agent 调查」按钮 + `window.startInvestigation`。

### 真实验收（GMV decline `sit_6f42b428e06c766d5681`，成交金额 -67.9%）

Hermes 完整执行：读 Knowledge（引用 "对比优先级：周同比>类目大盘>日环比"、"单天波动±15%优先观察不干预"——来自 knowledge/reference/京东电商运营隐性经验与故障诊断.md）→ Current Understanding（4 天真实数据 knownEvidence）→ 自主 Next Question（与上周同日对比验证周末节律）→ Required Evidence 明确 → 证据不足 → **fabric_execute_capability(trade.overview) 真实调用** → 获取 08-13/14/15/16 四天 Evidence 入 Evidence Store → Answer（67.9% = 周末节律伪异常）→ 假设更新（周末效应 supported / 真异常 weakened）→ **stopReason=observe**（Investigation Gate 正确：波动幅度+周度节律 → 观察不干预）。持久化 learning_contexts + GET API 可读 + Workspace Investigation 层渲染 + console 零 error。

过程中验证：fabric MCP 工具在 session 中可用（probe 确认 fabric_execute_capability/fabric_list_capabilities）；监控 probe 观察到 Hermes read_file×多、tool_search→tool_describe→tool_call、mcp__fabric__fabric_execute_capability×9；evidence 文件 acquired_at=09:38Z（17:38 CST）即调查期间写入。

### 关键决策（ADR-042）

- 无 if/else 调查树、无硬编码问题、不复制 SOP 进 prompt；Next Question 由 Agent 根据 Situation+Knowledge+Evidence 产生。
- Fabric 不合成 Investigation 契约——两阶段提取是让 Hermes 自己结构化输出。
- 能力不足 → missing_capability（不猜不扩）；数据不足 → ASK_HUMAN/OBSERVE。
- 不保存 CoT；只保存 Question/Hypothesis/Evidence/Finding/Judgment/StopReason。

### 测试

602 total（+15 investigation contract）／investigation 15 通过／typecheck 17 基线。

### 建议下一步

- 模型稳定性：本次调查 ~390-600s 完成（P0009 已知延迟），两阶段提取在 >600s 时可能仍 timeout（诚实返回）。
- 未来（不属本阶段）：把 Investigation 的 stopReason=missing_capability 作为 Fabric 扩能力的信号；Question correction learning 不实现。

---

## 本次会话 (2026-08-21) - Knowledge Sources Workspace Surface（专业人员可用）

### 目标与定位

ADR-040 已闭环 Knowledge Ingest backend control plane；本轮补齐专业人员可用的 Workspace 页面，让非开发人员不再手工操作 `data/fabric-workspace/knowledge-sources/raw/`。**不是 Knowledge Engine**：Fabric 仍只做控制面（枚举/标记/上传入口/启动 Hermes/展示结果），Hermes 负责读 raw、组织、写 `knowledge/*.md`、更新 INDEX、append log。

### 做了什么

- `shared-knowledge/status.ts`（增量，未重构）：`RawSourceStatus` +`type`/`mtimeMs`；`KnowledgeStatus` +`pages`（生成的知识列表，排除 INDEX/KNOWLEDGE/log 系统文件）+`indexMd`。新增 `collectKnowledgePages`/`readKnowledgeIndex`/`inferSourceType`/`parseFrontmatterTitle`。状态仍只来自 `/api/knowledge/status`。
- `platform/server/routes/knowledge.ts`：+`POST /api/knowledge/upload`（纯函数 `validateRawUpload` + `storeRawSource`：basename-only、.txt/.md 白名单、≤500KB、同名 409 拒绝覆盖、只写 raw 目录、path traversal 防护）；ingest 超时诚实化——返回 `{success:false, agentStatus:'timeout'|'error', error, status}`（实时磁盘真相），不再裸 500。**knowledge 路由改 `initSharedKnowledgeLayer` 替代 `ensureWorkspace`**（不触发 writeProjection 的 rmSync，修复并行测试 ENOENT 竞态）。
- `workspace/index.html` + `app.js`：Knowledge 页重做为「专业知识/经验资料」——上传按钮（.txt/.md）→ 知识来源列表（文件名/类型/大小/更新时间/已整理-未整理/生成页/每份「整理此份」）→ 全局「交给 Agent 整理」→ 诚实结果区（Agent 报告原样 + timeout 时显示实时文件系统状态）→「生成的知识」只读卡片 + 可折叠 INDEX。前端不推断第二套状态模型。

### 真实浏览器 + Hermes 端到端验收（全通）

1. 浏览器上传 `团队管理经验.txt`（DataTransfer 走真实 onchange → apiPost）→ 文件落 raw（154 B）
2. 页面立即「未整理」（含「整理此份」按钮）
3. 点击「交给 Agent 整理」（全局）→ 真实 Hermes session 被调用
4. Hermes 实际读取 → 创建 `knowledge/operations/团队管理经验.md`（frontmatter `sources: [knowledge-sources/raw/团队管理经验.txt]`，提炼 3 条核心原则）
5. `log.md` append `[2026-08-22] ingest batch 3`；`INDEX.md` Operations 新增条目
6. 刷新后 source 显示「已整理 · 生成: knowledge/operations/团队管理经验.md」
7. **raw 文件内容逐字节未变**
8. console 零 error
- 另验证：上传 409 重复拒绝（不覆盖）、path traversal / PDF 拒绝、per-source「整理此份」按钮正确触发 `/api/knowledge/ingest {source}`。

### 关键决策（ADR-041）

- 状态单一事实源 = status API；不做「有更新待整理」不可靠推断。
- 上传 JSON（复用 express.json/apiPost）非 multipart——零新依赖。
- timeout 不伪造成功：区分 agentStatus 与 filesystem status。

### 测试

587 total / 585 passed / 2 pre-existing failures（coverage indicator_pct 漂移、chat.contract Hermes 超时）。typecheck 17（基线）。新增 7（knowledge-status 1 多行数组 + raw-upload 6）。

### 状态

Knowledge → 专业人员 Workspace surface 完成。**下一阶段由 ChatGPT 重新设计：Knowledge → Investigation → Situation Understanding**（按用户指示，不在本会话做 Situation Knowledge Reasoning / Skill / Knowledge backend 扩展）。

---

## 本次会话 (2026-08-21) - Knowledge Ingest 操作入口恢复（Fabric 控制面，无 Knowledge Engine）

### 目标与定位

P0008.4 §10 早已定义 Ingest 流程（Agent 读 raw → 写 knowledge/ → 更新 INDEX → append log），但从未设计控制入口（"暂无自动化引擎"）。按「先查历史、有就恢复、没有补最小入口」——查证后无入口设计，补最小 Fabric 控制面。边界严格：Fabric 不总结 raw、不生成知识页、不做 RAG/向量/Knowledge Engine。

### 做了什么

- `apps/ecommerce/runtime/shared-knowledge/status.ts`（新，纯函数）：`buildKnowledgeStatus` 枚举 `knowledge-sources/raw/` + 解析每个 knowledge 页 frontmatter `sources:` 标记 provenance 引用。支持三种形式：单行数组 `[a, b]`、**多行数组 `[
 a,
 b
]`（Hermes 实测输出形式，初版 parser 漏了，已修）**、dash list。匹配 = workspace-relative 精确路径 + basename fallback。
- `platform/server/routes/knowledge.ts`（新）：`GET /api/knowledge/status`（纯枚举+标记）；`POST /api/knowledge/ingest`（复用 `situation-chat` 导出的 `ensureWorkspace`/`collectTurn` 启动 Hermes，cwd=`data/fabric-workspace`，prompt 指示执行 KNOWLEDGE.md Ingest 流程，优先未引用源；返回 Hermes 报告原样 + ingest 后状态）。
- `platform/server/routes/situation-chat.ts`：导出 `ensureWorkspace`/`collectTurn`；`collectTurn` 超时 120s→300s（已知 P0009 模型延迟）。
- `platform/server/index.ts`：挂载 `knowledgeRouter`。
- `workspace/{index.html,app.js}`：系统/Advanced 新增 Knowledge 入口 + `view-knowledge`（状态列表：✓ 已引用 / ○ 待 Ingest + 文件大小 + 引用页；Ingest 按钮；Hermes 报告 pre 原样展示；ingest 后 provenance 状态）。

### 真实 Hermes 实测（端到端全通）

- status：枚举 **9 个 raw 源**（2 seed demo md + 7 个真实 `京东电商运营*.txt`，08-21 由人工/Agent 放入）。
- `POST /api/knowledge/ingest` → Hermes 真实执行：创建 `knowledge/operations/京东电商运营日常SOP.md`（合并 2 个概述源）+ `knowledge/reference/京东电商运营隐性经验与故障诊断.md`（多源），更新 `INDEX.md`（新增 Operations/Reference 条目），append `log.md`（ingest batch 1）。platform-promotion.md 被 Agent 判定已处理未重复——provenance 语义生效。
- parser 修复后 status 精确反映：**7 referenced / 2 pending**。2 pending 诚实暴露：marketing-case.md（seed demo 未处理）+ `京东电商运营-诊断-决策.txt`（Agent 引用了 `电商运营知识库‑京东板块-诊断-决策.txt` 这个不存在的源名，basename 不匹配 → 诚实显示未引用）。

### 已知限制（非本轮 bug）

模型 `agnes-2.5-flash` 在 ingest prompt 上 300s 内未 emit `message.complete`（thinking.delta 持续报 "waiting... no output"），但 **Agent 的实际工作（写页/更新 INDEX/log）已完成**——这是 P0009 已记录的模型/配额层限制（status.json blocked），不是入口问题。入口机制（session 创建、prompt 提交、delta 流）全部验证通过。

### 测试

新增 9（knowledge-status 8 + http knowledge/status 1）；全量 570+9=579 passed / 2 pre-existing；typecheck 17 errors 前后一致。

### 建议下一步

- 模型稳定性恢复后重跑 ingest，验收 `message.complete` 正常返回（回复原样进 Workspace Knowledge 视图）。
- 2 个 pending 源：marketing-case.md 可人工触发二次 ingest；`诊断-决策.txt` 的引用名不一致可在后续 ingest 由 Hermes 修正。

---

## 本次会话 (2026-08-21) - Post-Consolidation REMOVE Sweep（债务清零收口）

### 目标

执行 audit/ADR 已明确的 REMOVE CANDIDATE 清理：只删有 prove 无 canonical consumer 的资产，DB 表/列不动，删除后浏览器验证 7 条 canonical 链无回归。完成后停止，不找下一刀。

### REMOVED（代码层删除，全部证明无 canonical consumer）

- `situation-viewmodel.ts` 孤儿文件（Pass 2 已被 `interaction-grammar.js` 取代）。
- agentSession SSE demo：`/api/runtime/events/:taskId` demo 路由（runtime.ts 68 行）+ `connectEventStream`/`agentSessionState`/`agentSessionEventSource`（P0009 起无调用者；真实聊天走 `/api/situation/:id/chat` + 3 个真实 activity slots）。
- agentConfig：`loadConfig`/`saveAgentConfig`/`view-agentConfig`/sidebar 入口/全部 `config.*` + `nav.agentConfig` i18n（localStorage 伪持久化，权重从不在 ranking 生效）。
- Legacy Inbox 全套：`loadInbox`/`renderFindingCards`/`view-inbox`/隐藏 sidebar 入口/inbox 内嵌 chat（`chatSendButton`/recommendedChips）及 `inbox.*`/`stat.*`/`findings.title`/`filter.*`/`nav.inbox|growth|risk|review`/`toast.refreshed` i18n——含 ADR-037 记录的 pre-existing broken `badgeAll` 残留。
- Evidence Viewer 17 个死 `evidence.*` i18n 键（从未渲染，指向不存在的功能）。
- operator_memories producer+API+consumer：`buildOperatorMemories`、`buildMemories`（pattern/memory.ts 删除）、`matchMemories`/`buildContext`（memory/matcher.ts 删除）、3 个零消费者端点（POST /api/memories/sync、GET /api/memories、GET /api/context）。

### DEPRECATED / inert（保留，不删不扩）

- `operator_memories` 表 + `memory/store.ts`（`initMemoryStore`）+ `memory/types.ts`：表由 init 建（DB 约束），无运行时 reader/writer，12 行历史保留。
- `signal_weights` 表 + seed：仅 schema + init seed（真实权重源 = `DEFAULT_SIGNAL_WEIGHTS` 常量），删 = schema cleanup 禁止。
- legacy `Review → Feedback → context_memories → memory-adjustment`：**读侧有真实 consumer 不删**——`MemoryFacade.queryActive` 被 GET /api/memory（Workspace memory 视图）+ chat.ts + workspace.ts findings + orchestrator `adjustmentsFor` 消费；生产侧 `extractMemories` 零调用 = inert。

### 关键决策（ADR-039）

删除只允许「audit/ADR 明确 REMOVE CANDIDATE + 证明无 canonical consumer」；「仍有真实调用 → 停止并报告」的规则在 legacy memory 链上触发（读侧 live），未强删。

### 验证

- typecheck 17 errors 前后一致（全 pre-existing）。
- 570/572 tests passed（2 pre-existing：coverage indicator_pct 漂移、chat.contract Hermes 超时）。
- **浏览器 7 链全通**（CDP 实测）：① Acquisition readiness（Hermes ready / JD-CDP ready / Capabilities 11 / Evidence 100）→ ② Ranking→Explainability（商品详情卡 → 决策面板真实 `信任分 12% — 证据稀薄（low_coverage）`）→ ③ Situation 今日工作（真实 situation 卡，70 条含 ranking_attention）→ ④ Professional Action（Situation detail 真实归因/建议 + 「认同」按钮）→ ⑤ Learning Context（`humanInterventions` 含 `evaluation:agree` 结构化落库，lifecycle:partial）→ ⑥ Explainability trace（同上）→ ⑦ Evidence Viewer（3 provenance 节点 + `Total: 641 records` + 真实 CDP timeline）。全视图 reload 后控制台零 error。
- 净删 -1036 行。

### 状态

**Consolidation 债务清零，正式结束。** 后续 = 新功能（knowledge/policy/reports、Action/Result、provenance consolidation per ADR-038），等业务需求驱动。

---

## 本次会话 (2026-08-21) - Consolidation: Evidence Viewer Contract Repair

### 目标

修复 Evidence Viewer 的 API/UI contract mismatch（post-consolidation inventory 判定为最后一条「有真实数据撑着的断腿」）：`Evidence Store -> /api/evidence/:capabilityId -> Evidence Viewer -> 专业人员可查看真实 provenance`。只允许契约对齐 + REUSE 现有 recentRecords/discovery.artifacts，不新增 schema/producer、不重设计 provenance。

### 做了什么

- `apps/ecommerce/workspace/app.js`：`renderProvenanceChain` 字段路径修正（`evidence.artifacts`->`discovery.artifacts`、`evidence.evidence_records`->`evidence.recentRecords`、`evidence.summary`->`evidence.totalRecords`）；Provider 节点显示真实 `platformName`/`acquisitionLabel`/`lastVerified`；Timeline 增加 `shop_id`；`loadBtn` 改 `onclick`（view loader 每次导航重跑，addEventListener 叠加重复 listener -> 重复 fetch）。
- `platform/server/routes/runtime.ts`：`recentRecords` 按 `acquired_at` 降序（原目录序前 10 = **最旧** 10 条，字段名叫 recent 实则 oldest）；`listEvidence` 显式 `EVIDENCE_LIST_LIMIT=10_000`（默认 limit=100 会截断 `totalRecords` 且 2026-08-20 最新 CDP evidence 永远进不了列表--修复前 recentRecords 首位是 2026-08-16，修复后是 2026-08-20）。
- `tests/integration/http.test.ts`：新增回归测试（recentRecords 降序 + <=10 条 + totalRecords 不截断 + provider 字段）。

### 浏览器实证（CDP 实测 Chrome，product.overview）

三个 provenance 节点（商品表现 -> Discovery Artifacts -> Evidence Records）不再空白；Provider `京东商智 · Live CDP Capture`；Timeline 10 条真实 CDP evidence（`2026-08-20 productTop · jd_shop_001 · cdp` 等，与 API recentRecords 逐项一致）；`Total: 641 records` 与磁盘 641 个 .meta.json 一致。

### 新发现（记录，不修 -- ADR-038）

1. **capability ↔ evidence 无稳定关联**（schema gap，MISSING）：route 按 `source=platform` 列全部 evidence，product.overview 也显示 summary/trend 记录。
2. **persistent evidence identity**（重要非 blocker）：`evidence_id` 每次 list 重新生成 UUID，未来「点一条 Evidence -> 稳定回链原始证据」必须先解决，归后续 provenance consolidation。
3. **`lastVerified=null`**：capability-contract.json 无 last_verified 数据（低优先）。
4. **废弃 i18n keys**（`evidence.viewRawJson`/`viewMappings`/`provenanceRaw` 等指向不存在的功能）：留给 REMOVE sweep。

### 事故

onclick 改动漏改闭合括号（`});`->`};`）造成 app.js `SyntaxError` 整个 SPA 不加载，CDP console 捕获后修复，`node --check` 加入验收流程。

### 测试

572 total / 570 passed / 2 pre-existing failures（coverage indicator_pct 漂移、chat.contract Hermes 超时），http.test 7/7。typecheck 17 错误前后一致（全部 pre-existing）。

### 状态

- **Evidence Viewer: END-TO-END 可用**（Evidence Store -> API -> Viewer 全链真实数据）。
- Consolidation 功能恢复阶段结束；剩余工作 = REMOVE sweep + inventory 收口（见 current_state.md 下一步）。

---

## 本次会话 (2026-08-20) — Explainability/Trust Workspace WIRE（END-TO-END COMPLETE）

### 做了什么

把真实 Ranking 对应的 trace 接进 Workspace 商品/Ranking 视图，闭环 `JD productTop → signals → Ranking → buildTrace → business_traces → /api/trace → Workspace → 专业人员看到真实 Trust/Evidence/Contradictions`。

- `platform/server/routes/ranking.ts`：`GET /api/ranking/:profile` 为每个 ranking 附带**当前** trace_id（JOIN business_traces.ranking_id = live ranking_results，悬空历史 trace 永不命中）。
- `apps/ecommerce/workspace/app.js`：`updatePanel` 异步拉 `/api/trace/:traceId`（stale-guard 防竞态）；`renderTracePanel` 整体重写为真实 trace consumer（trust/contradictions/evidence/ranking，明确「Ranking Explainability 非 Situation 解释」）；旧合成 section（Skills/MCP/Memory/ExecutionSteps）与 expand 逻辑删除；`renderBusinessPanel` 显示 trace 真实信任分；商品视图详情卡可点开决策面板。
- `apps/ecommerce/workspace/index.html`：8 个合成 trace section → 单一真实 consumer 容器。
- `tests/integration/http.test.ts`：新增 ranking 携带 current trace_id + /api/trace 返回真实 alignment 测试。

### 浏览器实证

商品视图点开一个商品 → 决策面板：运营模式 `信任分: 12% — 证据稀薄，需人工复核（low_coverage）`；开发模式完整 `信任分 12% / 支持度 no / Conf 90% / 矛盾点 low_coverage / 证据 gmv_growth_1d impact=0.880 / 排名第 1 · 0.3667`。真实，非硬编码。

### 决策（ADR-037）

- Workspace 只消费 `/api/trace/:traceId`，不重算 trust、不调 Hermes/LLM。
- 旧 fabricated trace panel 替换，不维护两套。
- **Legacy Inbox（`loadInbox`）pre-existing broken `badgeAll` 引用 → REMOVE CANDIDATE，不修复**（已标记「(旧)」，canonical Workspace 不依赖）。

### 测试

569 passed / 2 pre-existing failures，改动文件 typecheck 干净。

### 下一步（用户指示：不继续顺着 UI 找小 bug）

回到 capability audit，做 **post-consolidation inventory**：逐项分类「真正值得恢复的断腿」vs「REMOVE CANDIDATE」，判断这轮补旧账何时结束。

---

## 本次会话 (2026-08-20) — Consolidation: Explainability/Trust Producer Wiring

### 目标

纵向收口 `productTop → product signals → Ranking → buildTrace → business_traces → /api/trace/:traceId`，只把真实 productTop ranking 接进已有 Explainability/Trust producer（上一步 audit 判定 `business_traces` 只有 1 行 stale agentCMS trace、5 个真实 SKU ranking 零 trace）。

### 做了什么

- `apps/ecommerce/analysis/explainability/builder.ts` 新增 `buildRankingTrace`（纯函数：单个 ranking → trace，复用 `buildTrace`）。
- `apps/ecommerce/analysis/explainability/facade.ts` 新增 `explainRanking`（facade 薄委托，保唯一跨域入口）。
- `platform/server/index.ts` backfill：`rankByProfile` + `RankingFacade.store` 后，为每个 ranking `TraceFacade.explainRanking` + `store`。
- 新增 `tests/integration/product-top-trace.test.ts`（2 tests：差异化→trace→trust>0→一一对应；store/load round-trip）。

### 验收（真实 DB 实证）

- 5 差异化 ranking（0.3667 / 0.1326 / 0.1004 / 0.0916 / 0.0815，conf=0.9 cov=0.2）→ 每次 run 5 条 current trace。
- `ranking_id ↔ trace_id ↔ SKU` 最新 run 一一对应；`/api/trace/:traceId` round-trip 可读。
- `trust_score=0.12`（>0），`contradictions=["low_coverage"]`（单信号 `gmv_growth_1d` → coverage 0.2 → Rule 5）。
- stale 旧 trace `2448038d`（agentCMS，trust=0）保留，ranking_id 悬空，无 latest/list 视图误用。

### 状态

- **Explainability/Trust producer wiring: COMPLETE**
- **Workspace consumer: 仍未 WIRE**
- **Trace history: append-only**（本轮接受）
- **Known issue**: 旧 trace 的 `ranking_id` 在 ranking current-state 被覆盖后成为 dangling reference；未来 Replay/Audit 需 ranking snapshot / retention policy（本轮不改 store / ranking_id / unique constraint）。

### 测试

570 total / 568 passed / 2 pre-existing failures（coverage.test 阈值过期、chat.contract Hermes 超时），改动文件 typecheck 干净。

### 建议下一步

- Workspace consumer（trace 面板，只消费 `/api/trace/:traceId`）——下一刀。
- （可选）trace 幂等：`business_traces` 加 `(profile, entity_id)` 唯一键 + `storeTrace` upsert，或 `ranking_id` 确定性化——需放宽「REUSE store / 不改 ranking 算法」红线。

---

## 本次会话 (2026-08-20) — Consolidation Pass 2.1: Learning Context observations WIRE

### 目标

补全 ADR-035 canonical path 的「观察」层，让 Learning Context 从「一段描述」变成 grounded context（situation + observations + interventions + provenance）。

### 做了什么

- `learning-context-producer.ts` 新增 `buildObservations`：从 `SignalFacade.list`（当日 signals）+ `listEvidence`（当日 evidence）构建 `ObservationRef`（capability/provider/observedAt/signalIds/evidenceIds/metricsSnapshot）。不重新计算分析，不新增 schema。
- `buildLearningContext` 接收 observations，汇总顶层 `evidenceIds/signalIds/summary`。
- reclassification 追加进 `professional-capability-surface-audit.md` 附 2（4 项判定：Explainability/Trust=WIRE、operator_memories=REMOVE CANDIDATE、observations=WIRE、agentActivities=REMOVE CANDIDATE、Evaluation=MISSING）。

### 验收

真实 Situation（访客数下降 47.5% @ 08-16）→ intervention → learning_contexts：

```
observations: 1
  capability=daily_summary  provider={jd,cdp}  observedAt=2026-08-16
  signalIds=6  evidenceIds=3  metricsSnapshot={gmv,orders,uv,cvr}
```

### 下一步（待审计，不修）

**Ranking Data Lineage Audit**：67 商品全 0.4648，怀疑是旧 mock/import 遗留，非最新 CDP 真实商品数据。纵向追 product evidence → signals → SignalFacade → ranking 输入 → normalization/weights → score/confidence。

---

## 本次会话 (2026-08-20) — Consolidation Pass 2: Situation → Professional Action

### 目标与定位

两份 Audit 已钉死「专业人员打开 Situation 只看到占位符按钮」。Pass 2 收债「专业人员参与 Agent 认知」的闭环，架构决策定死：**canonical = `Situation → Intervention → Learning Context → Hermes`；Memory/Growth 归 Hermes**（ADR-035）。

### 三刀

1. **Slice 1 — 真实分析/建议/追问**（`workspace/app.js`）：Situation Detail 三个占位符换真实内容——「Agent 怎么理解」= Pattern Engine 归因（`/api/explain`，primary_driver + evidence + 历史恢复率）；「Agent 建议」= 从 tags(metric,direction) 确定性推导；「追问 Agent」= situation-chat 桥（去掉「未实现」）。

2. **Slice 2 — Intervention → Learning Context producer**（`apps/ecommerce/experience/learning-context-producer.ts` 新 + `p0007.ts` + `situation-chat.ts` + `index.ts`）：补上缺失的 INSERT（`recordInterventionInLearningContext`），新增 `GET /api/situations/:id/learning-context`，situation-chat 建 session 前把 Learning Context 写入 `fabric-workspace/situations/<id>.json`。**没做 `Intervention → context_memories`，没恢复 legacy Review 链。**

3. **Slice 3 — UI 结构化 grammar**（`workspace/interaction-grammar.js` 新 + `index.html` + `app.js` + `situation-viewmodel.ts`）：`INTERACTION_OPTIONS` 从 orphaned `.ts` 移成浏览器单一事实源；`submitIntervention` 发结构化 content（response/correction/decision 已表达）；**修复 module-scoped inline onclick**（暴露到 window）。验收从 Workspace 点按钮/填内容完成，非手工 POST。

### 关键决策（ADR-035）

- canonical professional-learning path = `Situation → Intervention → Learning Context → Hermes`。
- Memory/Growth 归 Hermes，Fabric 不生产自身 Memory。
- legacy `Review → Feedback → context_memories → memory-adjustment` 标记 **REMOVE CANDIDATE**，暂不删除，禁止新功能依赖。
- **Action/Result（业务执行）≠ 认知反馈**，不在 Pass 2 处理。

### 验收链（全通）

Workspace 点「认同/这里判断错了/不采用」→ structured Intervention（content 按 grammar）→ human_interventions → Learning Context（3 条结构化）→ Hermes workspace（`situations/<id>.json` 3 条人工判断）。

### 测试

566 passed / 2 pre-existing failures（chat.contract 真 CDP、coverage 断言漂移），typecheck 干净。

### 建议下一步

重新打开 `professional-capability-surface-audit.md`，看剩下「断腿」里哪些继续 Consolidation（Explainer/Trust、operator_memories UI、Evaluation 等），不马上开 Pass 3。

---

## 本次会话 (2026-08-19) — Consolidation Pass 1: Self-Sustaining Data Runtime

### 目标与定位

两份 Audit 钉死事实后，停止 fork feature，开始「还债」。Pass 1 只修数据生命线：让 Fabric 离开开发者后自己能持续获得世界状态；身份认证留给人。三小刀：

### Pass 1 — 诚实完成（no fake success）

根因：CDP miss 被 5 级静默吞掉，`executePlan` 把空采集报 success → backfill 报「7/7 completed」但实际零产出。修复：
- `historical-acquire.ts` `createLocalFirstLiveAcquire`：CDP 失败 throw（带原因），不再静默空返回。
- `binding/executor.ts` `executePlan`：`success = errors空 && acquired非空`；「No APIs」= false。
- `index.ts` `backfillRecentData`：收集失败日 + 原因，如实输出 `N/M · missed(...)`。

### Pass 1.1 — 诚实 readiness + session lifecycle ownership

- `cdp-client.ts` 新增 `isJdPageAvailable`（区分 Chrome reachable vs sz.jd.com page open）。
- `routes/runtime.ts` `/api/readiness`：`jd_cdp` 三态 ready/auth_required/unavailable + `jd_page`。
- `workspace/app.js` readiness chip：`auth_required` → 「需要登录」。
- `session-lifecycle.ts`（新）：`ensureChromeReady`（Chrome 不在就 launch + 持久 profile `~/.agentfabric/chrome-jd-profile`）、`ensureJdPageOpen`（无 sz.jd.com tab 就开 商智 首页 via CDP `/json/new`）、`ensureJdSession`。startup backfill 前自动 ensure。

### Pass 1.2 — direct HTTP hypothesis REJECTED（JCap）

实验：真实登录 session 直接 `fetch summary.ajax` → `-402 不安全的请求`（无 CSRF 头）→ `-407`（伪造头）。拦截 SPA 真实请求：`user-mnp`(32hex)/`user-mup`(ts)/`uuid` **每请求动态生成**，secret 在 JD 压缩 JS，从不在网络流量。结论：**direct WebAPI 对 JD 不可行，JD canonical execution = browser-mediated CDP**，不复现/不研究 JCap。曾尝试的 `direct-executor.ts` 已删除。

### Cold-start acceptance（真实验收）

```
[backfill] jd session: chrome=ready page=available
[CDP] ... Will fetch 1 dates (08-17~08-17) → Captured 8 API responses
[CDP] ... (08-18) → Captured 8 API responses
[backfill] 7/7 days completed (08-12~08-18)          ← 真 7/7
[backfill] rankings regenerated (67)
[backfill] situations: 2 created / 0 deduped          ← 真新 Situation
```

DB 实证：6 个新 Evidence（17/18_*）、signals 5537→5568（daily_summary 08-18 gmv ¥4978.54/orders 30/uv 480）、2 条新 Situation（订单 +25%、成交 +30.2%）。

### 关键边界（本次确立）

- **JD canonical execution = browser-mediated CDP**（非 direct HTTP，JCap 封死）。
- **human boundary = 正常 JD 登录**（session lifecycle 只 ensure Chrome/page，不登录、不绕过）。
- 不做 Browser Manager / 新 acquisition service / scheduler / 自动登录。

### 测试

566 passed / 2 pre-existing failures（`chat.contract` 真 CDP 需商智页、`coverage` 断言漂移），typecheck 干净。新增 `session-lifecycle.test.ts`(4)。

### 建议下一步

Pass 2: Situation → Professional Action（收编 Explainability/Hermes/Intervention/Pattern 等已有资产）。当前未 commit（待指示）。

---

## 本次会话 (2026-08-16) — P0009.1 Situation Producer / 今日工作

### 任务与定位

补齐 P0007 缺失的 **canonical Situation Producer**。前序审计已确认：P0007 只有契约（SituationSchema）+ thin INSERT route + legacy-adapter（review→intervention）+ viewmodel（presentation），**不存在**"观察 Signals/Rankings → 生成 Situation"的 producer。P0009.1 把已跑通的 `Evidence → Signals → Rankings` 提升为真实可持久化的 Situation，使 Workspace「今日工作」第一次有真实业务内容。严格边界：deterministic、无 LLM、无 acquisition、复用 P0007、不重构。

### 新增

- `apps/ecommerce/runtime/situation/rules.ts` — 纯检测规则（无 DB/IO）：三类检测（meaningful_change / ranking_attention / cross_signal）、中文业务指标词表（gmv→成交金额 等）、模板描述、确定性 situationId（sha256 fingerprint）。export `detectSituations`（纯函数，输入 signals+rankings → `Situation[]`）。
- `apps/ecommerce/runtime/situation/producer.ts` — `runSituationProducer(db, {shopId, shopName})`：`SignalFacade.list` 读 daily_summary → `RankingFacade.load` 读 rankings → `detectSituations` → `SituationSchema.safeParse` 校验 → `INSERT OR IGNORE`（幂等）。
- `apps/ecommerce/runtime/situation/index.ts` — barrel。
- `tests/unit/situation/situation-producer.test.ts` — 12 测试（decline/rise/阈值/少于2观测/cross_signal/ranking/确定性/持久化/幂等/无数据）。

### 重构 / 接线

- `platform/server/index.ts` — backfill 之后新增 `runSituationProducer`（`created`/`skipped` 日志）。startup 闭环确认：`backfill → signals → rankings → situations`。

### 测试

- 新增 12 测试全绿。全量 `npm test`: 561 passed / 2 failed（**均为 pre-existing**：`chat.contract.ts` CDP 5s 超时、`capability/coverage.test.ts` "58 ≤ 50" 断言漂移——与 P0009.1 无关）。
- `npm run typecheck`: 我的新文件零错误；剩余错误均为 pre-existing（`cdp-client.ts` apiName 未用、`routes/runtime.ts` meta 形状、`tests/contract/learning-context.contract.ts` schema 形状）。

### 验收（真实数据）

- 真实 DB 生成 4 条 grounded Situation（entity=祁门红茶旗舰店，observed_at=2026-08-16）：成交金额 -67.9%（¥3384→¥1087）、订单量 -66.7%（21→7）、访客数 -47.5%（434→228）、转化率 -33.4%（4.6%→3.1%），type=anomaly_investigation，lifecycle=open。
- 幂等：重跑 `created=0 / skipped=4`；服务重启 backfill `situations: 0 created / 4 deduped`。
- `GET /api/situations` 返回 5 条（4 producer + 1 既有 manual `sit_e2e_jd_20260812`），Workspace「今日工作」经既有 `loadSituationFeed` 渲染。
- 诚实发现：ranking_attention 规则已实现但不触发（67 商品 ranking 全同分 0.4648，数据未差异化），不制造 demo。

### 数据污染与恢复（重要）

单测初版误用 `openDb()`（真实 file DB）而非 `:memory:`，导致 `generateSignals` upsert 覆盖了真实 `jd_shop_001` 的 08-14/08-15 daily_summary，并写入 3 条 "测试店铺" Situation。已恢复：删除污染 Situation + 从 intact 的 `11855009` 行/evidence store 还原正确 metrics。测试已改为 `openDb(':memory:')` 隔离。**教训：所有 DB 单测必须 `:memory:`，勿碰真实 file DB。**

### 建议下一步

- P0009.1 已按边界完成，未 commit。下一步由用户定：a) 从 Workspace 浏览器做最终 Browser Acceptance；b) commit（需用户指示）；c) 若需 ranking_attention 触发真实内容，需先解决商品数据非差异化问题（属数据/采集，非 Producer）。

---

## 本次会话 (2026-08-14) — P0008.6 Claudian Instruction Architecture Audit

### 任务与定位

P0008.5 已收敛到"缺 Workspace-level Instruction Architecture"（不再用局部 prompt / AGENTS.md patch 调试）。本次 P0008.6 是**架构考古 + Audit**，不是 implementation。目标：研究 Claudian 已验证的 Workspace Instruction Pattern，抽象出 Fabric Workspace Instruction Architecture，回答"Blank Runtime 进入 workspace 后如何理解我在哪/有哪些 context/何时用哪种/怎么导航/什么能改/边界在哪"。

### 做了什么

1. **Claudian archaeology**（`git clone --depth 1`，只读 instruction/context 相关文件，忽略 UI/plugin）：
   - 发现 Claudian 有 **3 条独立指令轨道**：① repo developer instruction（root AGENTS.md + 9 个 scoped AGENTS.md，`src/app|core|features/chat|providers/{claude,codex,grok,opencode,pi}|style`）；② runtime system prompt（`src/core/prompt/mainAgent.ts:buildSystemPrompt()` → `Options.systemPrompt`）；③ user vault instruction（用户自己的 AGENTS.md，provider 原生发现，Claudian 绝不碰）。
   - `CLAUDE.md = @AGENTS.md`（指针，不复制内容）。
   - **orientation 在 system prompt 里，不在 AGENTS.md 里**——这是对 agentFabric 最反直觉的一点：Claudian 的 AGENTS.md 是给开发者（如何编辑代码），给终端用户 agent 的 orientation（我在哪/内容模型/怎么导航/什么能改）全在 buildSystemPrompt。
   - Claudian **没有 router、没有 INDEX**——导航是涌现式（cwd=vault + 原生 file tools + 内容模型）。INDEX 是 agentFabric 自己发明的，不是从 Claudian 学的。
   - 边界声明最强先例：grok AGENTS.md "Repository Instructions vs Runtime Instructions"——Claudian 绝不 create/import/append/suppress/rewrite/inject vault/runtime 指令。
   - 明确不重实现的清单：instruction loading、file tools、approval、session、MCP、skills（AgentSkillRepository 只是 codec 包装）。

2. **Claudian → Fabric mapping**（REUSE/ADAPT/REJECT，逐项）：orientation 反转落 workspace-root AGENTS.md（ADAPT）；scoped instruction（ADAPT）；CLAUDE.md 指针（ADAPT）；INDEX 是补强（ADAPT-扩展）；ownership 边界（REUSE 原则）；provider-native 能力（REUSE 不复制）；skill/permission（REJECT）。

3. **P0008.5 failure 五维解读**：`knowledge/` 成功因碰巧有完整消费链（task routing → KNOWLEDGE.md query 操作 → INDEX → content → provenance）；`world/` 只有生产链（construct routing → WORLD_MODEL.md → content），消费链缺 orientation(subject anchoring)/routing(READ-side)/scope(operational)/navigation(pointer)/semantics(epistemic authority) 四环半。**不是"少一行"**。

4. **提议 5-layer Instruction Layers**：Instruction / Navigation / Content / Capability / Runtime Self。评价了 Part C 结构：`knowledge/AGENTS.md` + `KNOWLEDGE.md` 双指令冗余；`systems/` vs `world/` 是 Case C 非决定性；致命缺失是 Routing 规则 + Epistemic Semantics（而非再加 INDEX 文件）。

5. **Ownership boundary**：Fabric-owned（topology/instructions/systems/knowledge/capability/navigation/governance）vs Runtime-owned（SOUL/Memory/Skill/Session/tools/approval/instruction loading）。

6. **Operational capability classification**：4 个已验证行为——System Context Construction + Shared Knowledge Ingestion = **Fabric Procedure**；Context Navigation + Grounded Consumption = **Workspace Instruction + Navigation**。**无一不是 Runtime Skill 或 Fabric Capability**。防退化 = 落成 workspace 内纯 Markdown 文件（instruction/procedure/map），而非停留在测试报告。

### 交付物

- `proposals/audits/p0008.6-claudian-instruction-architecture.md`（约 200 行，7 节：archaeology / mapping / failure 解读 / proposed layers / ownership / classification / open questions）

### 未做（NOT Included 遵守）

- 未改 P0008.5 测试结果、未改 AGENTS.md / systems/ / knowledge/ / capability/、未重跑 Blank Agent、未实现 RAG/VectorDB/Search/router/loader/Capability Engine/权限系统、未改 Hermes/Claude Code、未建 Hermes Skill、未复制 Claudian UI。

### 发现的具体 drift（供 Review）

- `data/fabric-workspace/AGENTS.md:73` 引用 `contracts/WORLD_MODEL.md`，但 repo 内**不存在** `contracts/` 或 `WORLD_MODEL.md`（dangling reference）。
- AGENTS.md 写 `capabilities/`（复数），实际目录是 `capability/`（单数）。
- AGENTS.md 写 `world/`，P0008.5 实验结论是 `systems/` 更好（1/3）。
- 生产 `data/fabric-workspace` 与 P0008.5 测试 workspace 结构已分叉。

### 风险

- Routing "systems 优先、web 兜底" 可能反伤真实业务（world 内容不全时硬答）——需"systems 无答案 → 明确 fallback"退出条件。
- Epistemic Authority 信任边界：`verified` 标注本身可能错，无条件信任会把 preparation 错误放大——需 provenance 链而非单档 `verified`。
- 未回答：P0008.6 是否要走"先修 root AGENTS.md routing/epistemic + WORLD_MODEL 落盘 + topology 对齐，再重跑 3 known-fact probes"作为验收——待 Review 拍板。

### 建议下一步

1. Architecture Review P0008.6 Audit。
2. 若通过，创建正式 P0008.6 Proposal：定案 Instruction Layers canonical 定义 + routing/epistemic 规则形态 + 验收方案（重跑 P0008.5 3 known-fact probes）。

---

## 本次会话 (2026-08-13/14) — P0008.5 Minimal World + Knowledge Bootstrap E2E

### 目标

验证 P0008 核心命题：一个 Blank Runtime（未参与构建的 Hermes Profile）能否继承另一个 Agent 整理出来的 Context。

### 三条链结果

1. **Phase B — System Context Construction ✅**：WorldExplorationTask（Hermes 真实探索产物）→ Fabric Contract → world/。首次旧 Contract 出 topology 歧义 + world 空 + source 被 move。修正 3 处 Contract（topology 唯一 / source taxonomy / source immutability）后，**同模型 agnes-2.5-flash** 正确生成 6-primitive structured World + epistemic status + evidence + provenance。结论：清晰 Contract 足以指导普通 Agent 抽象 structured context，非模型聪明。

2. **Phase C/D — Shared Knowledge Ingestion ✅**：非 Markdown .txt 文档，prompt 只"请处理"，Agent 自主 search_files → 读 KNOWLEDGE.md → semantic compilation（7 模块框架）→ page + provenance + INDEX + log。raw 不变、world 隔离、不进 Memory/Skill。

3. **Phase F — Blank Runtime Consumption ⚠️ 不对称**：Knowledge 继承成立（Probe B/C PASS）；World 消费失败（Probe A 走 web_search）。Known-Fact Diagnostic 用 3 个确定存在的事实 → 0/3 读 world/。

### 后续控制变量实验（逐层排除，都是负面/部分结果）

- **World Map A/B**：加 world/INDEX.md（无答案泄露）→ 0/3，`indexRead:false`（Agent 根本不读 INDEX）。结论：Navigation Map 必要不充分。
- **`world/` → `systems/`**：1/3（system-identity 类"店铺星级 4.6"0→1 提升，search_files→read_file→grounded；enumeration 类仍 web_search）。结论：`systems/` 是强候选 vocabulary，但 naming 非完整解。

### 收敛

Gap 从"缺 World Model"→"缺 INDEX"→"仅改 vocabulary 不够"，最终收敛为 **缺 Workspace-level Instruction Architecture**。停止，进入 P0008.6。

---

## 本次会话 (2026-08-13) — P0008.4 Agent Shared Knowledge Layer

### 核心决策

- Shared Knowledge 非 Wiki，是 "Raw Source → Agent semantic compilation → persistent Shared Knowledge"（借鉴 Karpathy LLM Wiki 维护 pattern，非产品边界）。
- 四层 Context Environment 绝不合并：world/ + knowledge/ + Situation/Learning Context + Hermes Profile（Runtime Self）。
- ownership：`knowledge-sources/raw/` immutable provenance；`knowledge/` = Agent-consumable Read Model（非 canonical truth）。
- AGENTS.md = Fabric Agent Workspace Contract，Hermes 原生加载，指向 KNOWLEDGE.md 不复制内容。

### 实现 + 验证

- workspace root AGENTS.md + knowledge/KNOWLEDGE.md + INDEX.md + log.md。15 tests 全过（5 个 AGENTS.md 测试）。
- Blank Hermes acceptance（诚实）：AGENTS.md 被加载（discovery 生效），但对 research 任务默认 web_search（9 次）而非先读 raw sources，write_file 未发生。缺口 = "workspace 内知识优先于 web_search"规则缺失 → 成为 P0008.5/P0008.6 主线。

---

## 本次会话 (2026-08-13) — P0008.3 Agent Workspace & Runtime Integration

### 三个工程对象

1. **FabricAgentWorkspace**（projector.ts）：authoritative state → runtime-facing 投影，deterministic/rebuildable（SHA-256 contentHash + 清空重建），只写不读回。
2. **HermesSessionClient**（session-client.ts）：speak Hermes /api/ws JSON-RPC，只接线不复现 session。
3. **Situation Chat Bridge**（situation-chat.ts）：只接"人↔Hermes Session"，不产生 Memory/Skill。

### 结果

- 11 tests 全过（projector 6 + session client 5）。
- 真实 Hermes E2E PASS：session.create cwd=FabricWorkspace，模型自主触发 filesystem 读取（2 次 tool call）。
- 协议修正：文本在 `event.payload.text`、完成信号 `message.complete`、需 `?token=` WS 认证。
- 边界：Memory/Skill/SOUL 归 Hermes Profile（`~/.hermes/profiles/jd/`），不进 agentFabric。

---

## 本次会话 (2026-08-13) — P0008 World Abstraction Infrastructure

### P0008.1 Contract Archaeology & Gap Map

- 三组资产考古: `discovery/`(Claude guided) / `data/jd_shangzhi_features/`(Claude 早期) / `WorldExplorationTask/`(Hermes zero-shot)
- 最大发现: Hermes 在零 schema 下独立产出全套 World primitive + `_suspected` epistemic 标记（猜错 API 路径但知道自己只是猜）
- 收敛模型: 6 个 World Objects + Assertion Graph（去掉 Entity/Concept 独立节点）
- 4 个 Contract Review 语义修正: Capability→Feature/Affordance 命名、epistemic 属 Assertion 不属对象、Entity binding 延后、真实值非 World Fact

### P0008.2 World Model Contract

- `shared/schemas/world-model.ts` + 28 stress tests
- 三层分离: World Object(6 types) / World Assertion / Capability Binding
- 两个正交生命周期: epistemic(suspected→observed→verified 单调) vs temporal(active→superseded/retired)
- evidenceRefs 是 reference interface（World Evidence semantics 未实现）
- binding 有 relationship 语义（observable_by/exportable_by/comparable_by）
- 无 Builder/Query/Registry（P0008.3 的事）

### 下一步

P0008.3 World Query & Capability Binding（待指示，不自动开始）

---

## 本次会话 (2026-08-12) — P0007.1 Learning Context Contract

### P0007.1 Implementation

- `shared/schemas/learning-context.ts`: Situation/Case anchor + Observation + Agent Activity + Human Intervention + Action + Outcome schemas. Open/partial/mature lifecycle. Runtime-neutral.
- `tests/contract/learning-context.contract.ts`: 12 tests (situation, lifecycle, real JD evidence, intervention types, incremental enrichment)
- Real JD validation: context built from live CDP evidence (2026-08-12, GMV=¥337.90). No fake intervention/action/outcome.
- Tests: 456/458 pass (2 pre-existing failures)

### P0007 Restructure
Sub-proposals reordered: 7.1 Contract → 7.2 Grammar → 7.3 Domain Workspace → 7.4 Outcome → 7.5 Trust → 7.6 Hermes Loop. Architecture diagram updated with Situation/Case + Domain Workspace.

---

## 本次会话 (2026-08-12) — Phase 3 Complete + P0007 Proposal

### P0007 Architecture

新 P0007-Experience-Memory-Skill.md 创建。旧 P0007.3-memory-retrieval.md → proposals/archive/。

核心架构决策：
- agentFabric: World → Learning Context（不实现 Memory/Skill Engine）
- Runtime: Learning Context → Memory → Skill（HermesAgent 自有学习机制）
- Learning Context 是 Runtime-neutral 的成长接口
- 6 个子 Proposal (P0007.1–7.6)，逐层验证
- Trust 是横向能力，不是单一分数

---

## 本次会话 (2026-08-12) — Phase 3 Complete + Live CDP Verification + mock→real switch

### Phase 3 Closeout

Phase 3.1–3.4 全部完成。E2E 链路已验证：

```
CapabilityBridge.searchByIntent("分析最近30天流量")
  → traffic.overview (score: 22.0)
  → discover_capability skill → bridge.discover handler
  → kernel.execute({ mock: false }) → real evidence data
  → SSE event stream → Agent Activity panel
  → POST /api/chat → capability + execution → response
```

Live CDP 验证: CLI `collect jd --mode live --date 2026-08-12` → 14 API responses, GMV=¥337.90, orders=2, visitors=23.

chat.ts 已切换 mock:false — 全部使用真实 evidence 数据。

### Known Debt
- SSE demo sequence (Phase 4: connect to real HermesAgent task events)
- resetCapabilityBridge() test export in production module (low priority)

### Tag
v0.2-phase3-complete

---

## 本次会话 (2026-08-11) — Phase 2 Workspace + Proposal Taxonomy + Phase 3 Design + Phase 3.1

### Phase 3.1 Runtime Kernel Contract

- **文件**: `shared/schemas/execution.ts` + `tests/contract/execution.contract.ts` + `docs/runtime-kernel-contract.md`
- **范围**: 纯 Contract — 无 Hermes/CDP/UI 修改
- **内容**:
  - `ExecutionRequest`: { taskId, capability, inputs, context } — Agent 请求 Kernel 执行
  - `ExecutionEvent`: 7 种事件类型 (execution.started → execution.failed)
  - 20 contract validation tests — 全部通过
  - 事件描述执行状态，不描述模型思维 (无 thinking/reasoning)
  - Contract 是 Agent-agnostic — 任何 Agent Runtime 都可用
- **与 Capability Contract 关系**: Contract 定义 WHAT; Execution Contract 定义 HOW TO REQUEST
- **下一步**: Phase 3.2 Hermes Capability Discovery (searchByIntent bridge)

---

## 本次会话 (2026-08-11) — Phase 2 Workspace + Proposal Taxonomy + Phase 3 Design

### 做了什么

完成 P0006.5.3 Capability Contract 后，实现 Phase 2 Agent Cognitive Workspace（Human ↔ Agent ↔ Capability ↔ Evidence），规范化 proposals/ 目录命名体系，并创建 Phase 3 HermesAgent Integration 设计提案。

### Phase 3 Hermes Integration Proposal

- **文件**: `proposals/workspace-v0.2-phase3-hermes-integration.md`
- **格式**: Feature Proposal（非 P-number；日后可升级为 P0006.3）
- **核心设计**:
  1. HermesAgent → CapabilityRegistry.searchByIntent() → 选择能力（不执行采集）
  2. Runtime Kernel 作为 Capability Execution Layer（共享于所有 Agent Runtime）
  3. Observable Event Model: intent.resolved → capability.selected → execution.started → acquisition.* → evidence.created → execution.completed → response.ready
  4. POST /api/runtime/chat：异步 task 模型（SSE 事件流），不是同步 Chat API
- **Phase 2 vs Phase 3 关系**:
  - Phase 2: UI shell（static event slots + disabled input）
  - Phase 3: 接通 HermesAgent，UI 消费真实事件流
  - P0006.5.3: Capability Contract（Phase 3 HermesAgent 的查询入口）

### Phase 2 Workspace UI 实施

- **Agent Session**（主视图）: UI state contract 定义，5 个 observable event slots，"Runtime integration unavailable" 状态（Phase 3 接 HermesAgent）
- **Capability Explorer**: GET /api/capabilities → domain filter + intent search + capability cards（11 capabilities, 48 metrics, 8 domains）+ detail view
- **Evidence Viewer**: GET /api/evidence/:capabilityId → provenance chain（capability → discovery artifacts → evidence records → timeline）
- **Sidebar**: AGENT section（顶部）+ CAPABILITY section（新增），现有视图完整保留
- **Boot**: Agent Session 为默认首页
- **JS**: loadAgentSession / loadCapabilityExplorer / loadEvidenceViewer 三个 loader 实现
- **审计**: Phase-2-Implementation-Audit.md — 初始发现 3 个 undefined loader + 2 个 bug，全部修复
- **Tag**: v0.2-phase2-workspace
- **测试**: 412/413 pass（1 pre-existing coverage threshold）
- **事故防控**: 零 CBP/bridge 污染，零 Hermes 认知伪造，零 Phase 3 越界

### Proposal 命名规范化

- 17 个文件重命名：PascalCase→kebab-case，修复 typo（"Capalibity"→"capability"），修复截断（"Integrat"→"integration"），下划线→连字符，移除特殊字符（&）
- 1 个死链修复：`P0002-workspace-information-architecture.md` → `P0002-workspace-information-architecture.md`
- 创建 `proposals/README.md` — taxonomy, naming convention, examples, next available P numbers
- 更新 `context/decisions.md`（ADR-019: Proposal 命名规范）+ cross-reference 更新
- 更新 `context/current_state.md`（版本 v0.2-phase2-workspace, 新增完成项）

### 命名规则

- Architecture Proposal: `P{NNNN}[-{N}]-{kebab-case-description}.md`
- Feature/Phase Proposal: `{module}-v{version}-phase{N}-{description}.md`
- 全小写 kebab-case，只用连字符，不用下划线/特殊字符/PascalCase

### 下一步

Phase 3: HermesAgent Integration — 接通 POST /api/runtime/chat + 将 Agent Session 从 static shell 升级为实时 Agent 交互。

---

## 本次会话 (2026-08-09) — P0006.2 Real Data Replay Verification

### 做了什么（一句话）

用户要求验证"JD 是否可以用真实数据一天一天 runtime"。经全链路审计 (JD Connector → Blueprint → Runtime → Evidence Store → CDP) + 实际运行 190 天 full replay，确认闭环已存在且可用。修复 2 个 blocking bug 后，190/190 天全部成功，3,489 signals 含真实 GMV 数据。

### JD Historical Capability Report (审计结果)

**A. Direct Runtime Backfill: YES** ✅
- `kernel.execute({ date })` 支持逐日参数
- `runReplay({ from, to })` 日期循环调用 kernel.execute()
- Evidence store 有 573 个真实 CDP 文件 (2026-01-01 ~ 2026-07-09)

**B. Need Historical Connector: NO** (已有)
- `createHistoricalAcquire()` — evidence store → mock fallback
- 不需要新增架构层，现有历史采集+回放已完整

**C. Need CDP Historical Navigation: ALREADY EXISTS** ✅
- CDP client passive intercept — 修改 POST body date fields
- 支持 arbitrary date range via `fromDate`/`toDate`
- 不需要页面导航/日期选择器交互

### 修复的 Bug

1. **`jd-schema.ts` SQL 分号缺失** — `db.exec(STATEMENTS.join('\n'))` → `join(';\n')` (对齐 schema.ts 模式). 导致 `npm run db:init` 失败

2. **Evidence store 数据解析失败** — `parseAcquiredData()` 中 `asArray()` 将单对象 evidence 数据当作空数组处理, parser 永远返回 empty values. 修复: `const wrapped = Array.isArray(data) ? data : [data]`

### 验证数据

| 指标 | Before (Bug) | After (Fix) |
|------|-------------|-------------|
| 3天 replay signals | 3 (all value=0) | 64 (real GMV) |
| 190天 full replay | N/A | 190/190 completed, 3,489 signals |
| Evidence | 0 | 570 records |
| Errors | 3 | 0 |
| GMV 范围 | ¥0 | ¥4,628 ~ ¥14,230/天 |

### 已知限制

- `EnterpriseSignal.metrics` (gmv, orders, uv, cvr 等子字段) 未被 repository.toRow 持久化到 SQLite. Workspace 通过 `signal_value` 展示 GMV 功能正常
- Rankings 全部 uniform score (0.4648) — 与 replay 无关, 是 seed product/order 数据问题
- CDP live 采集需要 Chrome + 登录态 (手动步骤)
- Evidence store 方法标记为 "cdp" 但数据字段已 canonicalized (header.code→0, body.data.gmv, etc.) — 怀疑是 import 而非原生 CDP 采集

### 关键架构确认

```
JD 商智 → CDP (Chrome 登录态) → Evidence Store → Historical Acquire → Runtime Kernel → Signal → Workspace
```
这个闭环已完整验证通过。

### 风险

- **CDP Live 未重新验证** — 当前 evidence store 数据来自历史采集, 未确认 JD 商智 SPA 结构是否有变化
- **Hourly 信号来自 trend evidence** — evidence store 的 trend 数据包含 24 小时时间序列, 解析正确 → 61 hourly_traffic signals/天
- **Ranking 数据质量问题** — product-level computed signals 值为 0, 因 order 数据与 evidence 不对齐

### 建议下一步

1. **P0006.2 Workspace Timeline** — Runtime 页面显示 190 天执行历史 (当前 limit=20)
2. **补全 metrics persistence** — toRow/fromRow 添加 metrics 序列化
3. **重新 CDP 采集** — 用当前 JD 商智验证 CDP live 路径仍可用
4. **P0007 Memory / Replay Analysis** — 用 180 天真实 replay 数据分析 Ranking 稳定性 + Memory 价值

---

## 本次会话 (2026-07-09) — P0006 + P0006.1 + P0006.1.1

### 做了什么（一句话）

完成 HermesAgent & Workspace Integration（P0006）→ 通过 P0006.1 Product Readiness Checklist 发现 Signal 跨日期持久化缺陷（C1）→ 执行 P0006.1.1 Signal Observation Model Refactor 修复数据模型。

### 新增

**P0006 — HermesAgent & Workspace Integration** (4 files, ~755 lines)
1. `apps/ecommerce/skills/definitions.ts` — 5 business skills (collect_data, analyze_ranking, query_signals, query_evidence, general_question)
2. `apps/ecommerce/skills/registry.ts` — Intent matching (pattern + HermesAgent fallback) + response generation
3. `platform/server/routes/chat.ts` — Agent Loop: `POST /api/chat` (intent→dispatch→response), `GET /api/chat/skills`
4. `platform/server/routes/runtime.ts` — Kernel HTTP: `POST /api/runtime/collect`, `GET /api/runtime/executions`, `GET /api/runtime/executions/:date`, `GET /api/runtime/status`

**P0006.1.1 — Signal Observation Model Refactor** (8 files modified)
1. `shared/schemas/signal.ts` — SignalSchema +`observed_at: IsoDateString`
2. `platform/storage/schema.ts` — v3 migration: +observed_at column, 新 UNIQUE `(entity_type, entity_id, signal_name, window, observed_at)`; 从 signal_id 回填旧数据
3. `apps/ecommerce/connectors/normalizer.ts` — normalizeSignal: `timestamp→observed_at`
4. `apps/ecommerce/analysis/metrics/repository.ts` — toRow/fromRow +observed_at; storeSignals 新 UNIQUE; ORDER BY observed_at
5. `apps/ecommerce/analysis/metrics/pipeline.ts` — 计算信号使用 pipeline 时间作为 observed_at
6. `apps/ecommerce/runtime/kernel/runtime-signal-engine.ts` — **回退**小时后缀补丁 (`hourly_traffic_14`→`hourly_traffic`); 删除 extractHour()
7. `platform/server/routes/runtime.ts` — 使用 observed_at 分组执行历史
8. `platform/server/routes/chat.ts` — 使用 observed_at 分组日期

### 重构

- `platform/server/index.ts` — +2 imports (chatRouter, runtimeRouter), +2 route mounts
- `apps/ecommerce/workspace/index.html` — +Runtime sidebar + view container
- `apps/ecommerce/workspace/app.js` — +apiPost(), +loadRuntime(), +Chat 接入
- `tests/unit/runtime/kernel/signal-engine.test.ts` — signal_name 纯净类型断言; observed_at 唯一性断言

### 删除

- `runtime-signal-engine.ts`: extractHour() helper
- `runtime-signal-engine.ts`: signal_name mutation 逻辑 (`_14` 后缀)
- `runtime.ts`, `chat.ts`: extractDateFromSignalId() — 不再从 signal_id 提取日期

### 设计决策

- **ADR-024**: Agent Loop 由 agentFabric 拥有。HermesAgent (语言) + agentFabric (dispatch)。Skills as Data。
- **ADR-025**: Signal Observation Model — 三层时间轴 (Business: observed_at / System: ingested_at / Execution: pipeline_run_id)。Signal Type 与 Observation 两层分离。

### 测试 — 413 passed (389 existing + 24 P0006 new; 零净增)

### 风险

- Hermes 二进制不可用: Chat 使用 StubHermesClient，回复为 responseTemplate fallback 文本
- Workspace 7 处 placeholder 文案（加载态初始值，属正常 UI pattern）

### P0006.1 Readiness Report 结论

C1 (Signal 跨日期不持久化) 已通过 P0006.1.1 修复。验证: production DB 含 4 个日期的信号 (2026-06-27, 2026-07-04, 2026-07-05, 2026-07-09)。
Chat Agent Loop 完整闭环: intent=collect_data → kernel.execute() → 25 signals。
Hermes 不可用导致 reply 为 fallback 文本，不阻塞 Runtime 执行。

### 建议下一步

1. MCP Tool Exposure — 向 HermesAgent 暴露 skills 为 MCP tools
2. Chat 多轮对话 — Session 管理 + 消息历史
3. PDD Connector

## 本次会话 (2026-07-12) — JD Persistence Layer + Type Fix

### 做了什么（一句话）

建立 JD 数据持久化层（SQLite schema + persistence bridge），修复 `historical-acquire.ts` 类型错误，严格遵循 CLAUDE.md 规范（No `any`）。

### 新增

1. **`platform/storage/jd-schema.ts`** — 4 张 SQLite 表
   - `jd_raw_data` — 原始行数据（UPSERT by dataset_id + source_page + row_index + data_date）
   - `jd_collection_runs` — 采集任务追踪（日期范围、数据集、行数、状态）
   - `jd_dataset_metadata` — 数据集元数据预注册（productTop, summary, trend 等）
   - `jd_metric_timeseries` — 指标时序（UPSERT by dataset_id + entity_id + metric_name + data_date）

2. **`platform/storage/jd-persistence.ts`** — CDP 采集 → SQLite 桥接层
   - `extractRowsFromPayload()` — 从 API 响应体提取行数据
   - `extractMetricsFromRows()` — 从行数据提取数值指标
   - `persistJdData()` — 主持久化函数，接收 `AcquireResult` → 写入 SQLite

### 修改

| 文件 | 改动 |
|------|------|
| `platform/storage/init.ts` | +`applyJdSchema()` 调用，+`seedJdDatasets()` 调用 |
| `apps/ecommerce/connectors/jd/historical-acquire.ts` | 修复 `MockJdPayload` 类型转换（`as any` → `key in mock` 类型守卫） |

### 重构

- `jd-persistence.ts` 最初放在 `apps/ecommerce/connectors/jd/`，后移至 `platform/storage/`（基础设施层，非业务层）

### 设计决策

- **ADR-026**: JD Persistence Layer — 持久化层属于 platform/storage（基础设施），不属于 connectors（业务执行）
- **No `any` 规范**: `historical-acquire.ts` 类型修复使用 `key in mock` 类型守卫 + `keyof MockJdPayload`，严格遵守 CLAUDE.md "No `any` — use `unknown` and narrow"

### 测试

- `npm run typecheck` — 零错误通过
- 无新增测试文件（schema 和 persistence 逻辑由后续测试覆盖）

### 风险

- `jd-persistence.ts` 尚未被实际采集流程调用 — 需要 connector 层集成
- `jd_metric_timeseries` 的指标提取逻辑依赖 API 响应体结构，京东 API 变更时需同步更新

### 建议下一步

1. 集成 `persistJdData()` 到 `kernel.execute()` 或 `kernel.executeLiveCDP()` 管线
2. 编写 `jd-persistence.ts` 单元测试（行提取、指标提取、UPSERT 逻辑）
3. 编写 `jd-schema.ts` 集成测试（表结构验证、数据读写）

## 历次会话

### 上次会话 (2026-07-04) — P0005.6.1 CLI Final Patch

**CLI 变为纯入口壳层，所有业务逻辑移入 Kernel。** 这是 P0005.x 收敛的最后一块拼图。

### 背景

P0005.5 创建了 Runtime Kernel，P0005.6 删除了 `processDay()`。但验证审计发现仍有 2 个 bypass：
1. **Live CDP**: `acquireJdData()` 在 CLI 中直接调用，planner/executor 未参与
2. **Import-jd**: `saveEvidence()` 和 `SignalFacade.store()` 在 CLI 中直接调用，有 legacy fallback

P0005.6.1 的目标：CLI 不执行任何业务逻辑，只做 Kernel 调用入口。

### 新增

1. **`executeLiveCDPPipeline`** (runtime-executor.ts, ~90 行)
   - 多日 CDP 采集 + 逐日 signal/evidence 处理，全部在 kernel 内完成
   - Kernel 方法: `kernel.executeLiveCDP({ shopId, fromDate, toDate })`
   - 返回 `RuntimeLiveCDPResult`: success, totalSignals, totalEvidence, per-day results

2. **`executeImportPipeline`** (runtime-executor.ts, ~120 行)
   - 读取历史 JSON → 逐 record 保存 evidence (3 types) → 生成 signal
   - Blueprint 可用时走 signal-engine；否则走 legacy normalizeSignal + SignalFacade.store
   - Kernel 方法: `kernel.executeImport({ sourcePath })`
   - 返回 `RuntimeImportResult`: success, totalEvidence, totalSignals, recordCount

3. **`createEmptyBlueprint`** (runtime-executor.ts, ~30 行)
   - 创建合法的"空状态" BoundCapabilityModel
   - 所有 rules/signal_types/capture_rules 为空 → 各 pipeline 自动 fallback 到 legacy
   - 用于 import-jd 无 Discovery 数据的环境

### 重构

**`scripts/cli.ts`** — 从 20 imports 缩减到 6 imports:
- ❌ 删除: `acquireJdData`, `saveEvidence`, `normalizeSignal`, `generateSignals`, `captureEvidence`, `buildSpecFromBlueprint`, `INDICATOR_OVERRIDES`
- ✅ 保留: `createRuntimeKernel`, `createEmptyBlueprint`, `loadBlueprint`, `SignalFacade` (read-only in cmdSignals)
- Live CDP: 68 行 → 32 行 (kernel.executeLiveCDP)
- Import-jd: 60 行 → 22 行 (kernel.executeImport with empty blueprint fallback)

### 架构状态

```
Before (P0005.6):
CLI
 ├── kernel.execute()          ✅ mock only
 ├── acquireJdData()           ❌ live CDP bypass
 ├── generateSignals()         ⚠️ partial
 ├── captureEvidence()         ⚠️ partial
 ├── saveEvidence()            ❌ import-jd bypass
 └── SignalFacade.store()      ❌ import-jd bypass

After (P0005.6.1):
CLI
 ├── kernel.execute()          ✅ mock + single-day
 ├── kernel.executeLiveCDP()   ✅ multi-day CDP
 └── kernel.executeImport()    ✅ historical import
```

### 测试

- 387 tests 全部通过
- Typecheck 通过 (exactOptionalPropertyTypes strict)
- 无新增测试文件（逻辑从 CLI 移到 kernel，现有 kernel 测试已覆盖）

### 风险

- **Live CDP 端到端未验证**: `kernel.executeLiveCDP()` 包装了 `acquireJdData` 的调用，但实际 CDP 采集需要 Chrome + 登录态，未在本次会话中端到端测试
- **Import-jd 向后兼容**: `createEmptyBlueprint` 作为 fallback 合法但未被 Zod 验证，其 shape 由 TypeScript 类型系统保证

### 建议下一步

- 实际运行 `cli collect jd jd_shop_001 --mode live --days 3` 验证 CDP 路径
- 实际运行 `cli import-jd --source ...` 验证导入路径
- 考虑 P0006 扩展（多平台、可观测性、Blueprint 进化）

## 更早: 本次会话 (2026-07-04) — P0005.6 Execution Convergence + P0005.5 Runtime Convergence + Deep Audit

### P0005.6 — 做了什么（一句话）

彻底消除所有非 Kernel 执行路径。`processDay()` 完全删除。Live CDP + import-jd 全部改用 runtime 模块 (generateSignals + captureEvidence)。系统现在只有一条执行河流: CLI → Kernel → Binding → Connector → Evidence/Signal。

### P0005.6 变更

| 文件 | 变更 |
|------|------|
| `scripts/cli.ts` | **删除** `processDay()` 函数 (47行). Live CDP 路径 → `generateSignals()` + `captureEvidence()`. cmdImportJd → signal-engine (有 blueprint 时) + legacy fallback (无 blueprint 时) |
| `context/decisions.md` | ADR-022 |
| `context/status.json` | P0005.6 added to completed |
| `context/current_state.md` | P0005.6 added |

### 执行路径收敛状态

| 路径 | Before | After |
|------|--------|-------|
| Mock collect | kernel.execute() ✅ | kernel.execute() ✅ |
| Live CDP collect | processDay() ❌ | generateSignals() + captureEvidence() ✅ |
| import-jd | normalizeSignal() 直调 ❌ | signal-engine (blueprint) + fallback ✅ |
| processDay | 存在 ❌ | **已删除** ✅ |

### P0005.5 — 做了什么（一句话）

### 做了什么（一句话）

深度审计发现 5 个 CRITICAL GAP → P0005.5 建立 Runtime Kernel, 收敛 3 套并行运行体系为 1 个统一入口。CLI 从 hardcoded processDay 切换为 kernel.execute()。normalizer-plan.json (887 rules) 首次被 runtime 加载, 输出 895 canonical metrics (vs 旧 16)。

### 新增

| 文件 | 做什么 | LOC |
|------|--------|-----|
| `apps/ecommerce/runtime/kernel/runtime-kernel.ts` | Main entry point — createRuntimeKernel, CLI 唯一入口 | ~90 |
| `apps/ecommerce/runtime/kernel/runtime-normalizer-resolver.ts` | 3-layer resolution: overrides→generated plan→JD_SPEC fallback; 895 canonical keys | ~100 |
| `apps/ecommerce/runtime/kernel/runtime-signal-engine.ts` | blueprint-driven signal 生成, 替代 processDay hardcoding | ~150 |
| `apps/ecommerce/runtime/kernel/runtime-evidence-orchestrator.ts` | blueprint-driven evidence capture, 用 evidence_strategy | ~100 |
| `apps/ecommerce/runtime/kernel/runtime-executor.ts` | unified pipeline: Plan→Acquire→Parse→Normalize→Signal→Evidence | ~170 |
| `apps/ecommerce/runtime/kernel/index.ts` | Barrel | ~15 |
| `tests/unit/runtime/kernel/normalizer-resolver.test.ts` | 8 tests — 3-layer resolution, confidence filtering, overrides, fallback |
| `tests/unit/runtime/kernel/evidence-orchestrator.test.ts` | 5 tests — blueprint capture, endpoint→dataType, fallback, persistence |
| `tests/unit/runtime/kernel/signal-engine.test.ts` | 7 tests — daily_summary, hourly_sales, zero-skip, multi-type, unknown skip |
| `tests/unit/runtime/kernel/executor.test.ts` | 6 tests — full pipeline, acquisition failure, capabilities, evidence structure |
| `tests/unit/runtime/kernel/kernel.test.ts` | 5 tests — createRuntimeKernel, execute, signal_types, capabilities, errors |
| `tests/contract/runtime-pipeline.contract.ts` | 4 tests — full pipeline contract, normalizer spec size, overrides, multi-exec |

### 重构

| 文件 | 变更 |
|------|------|
| `scripts/cli.ts` | CLI `collect` 走 RuntimeKernel (blueprint-driven); `processDay` 标记 @deprecated; `generate-blueprint` 修复 `--platform` flag 解析 |
| `apps/ecommerce/connectors/binding/executor.ts` | 新增 `ParseFunction` 类型 + `parseFn` 参数 (backward compat) |

### 修复的 5 个 CRITICAL GAP

| Gap | 修复 |
|-----|------|
| G1: CLI bypass blueprint | CLI 现在加载 blueprint → createRuntimeKernel → kernel.execute() |
| G2: processDay hardcoded | Signal Engine 从 blueprint.manifest.signal_types 生成 signals |
| G3: normalizer-plan.json unused | Normalizer Resolver 加载 887 rules → 895 canonical keys |
| G4: binding/未进入 production | Runtime Executor 调用 binding/planner + binding/executor |
| G5: 双 runtime | 统一 pipeline: Plan→Acquire→Parse→Normalize→Signal→Evidence |

### 测试

- **之前**: 352 tests
- **之后**: 387 tests (+35)
- Typecheck: clean
- CLI smoke: `collect jd jd_shop_001 --mode mock` → blueprint-driven ✓

### 关键数字

- Normalizer spec: **895 canonical metrics** (旧 JD_SPEC: 16) — 55x 提升
- Blueprint 加载: normalizer-plan.json 887 rules → runtime lookup table
- INDICATOR_OVERRIDES: 8 hand-written keys, 100% 在 spec 中

### 风险

- Tmall connector 仍是 stub (无实际实现)
- Router prompt 仍是 hardcoded (非 P0005.5 scope)
- Live CDP 模式仍走 processDay (transitional — 下阶段迁移到 kernel)
- Coverage report 因 manifest 从 blueprint 派生 → 总是 100% (circular)

### 建议下一步

1. P0005.6 — Live CDP 路径迁移到 kernel
2. Tmall connector 实现 (或等需求驱动)
3. Router prompt 从 skill definitions 加载
4. Coverage 计算改为 runtime-driven (对比 blueprint vs actual execution)

## 之前会话 (2026-07-03) — P0005.4 Connector Binding Layer

### 做了什么（一句话）

P0005.4 建立了 Capability → Connector 的 Binding Layer。之前 P0005.3 生成的 `generated/` artifacts (5个JSON, 683KB) 是 orphaned (write-only); 现在 Connector 消费它们作为 Single Source of Truth。

### 新增

| 文件 | 做什么 | LOC |
|------|--------|-----|
| `apps/ecommerce/connectors/binding/types.ts` | BoundCapabilityModel + CapabilityExecutionPlan Zod schemas | ~75 |
| `apps/ecommerce/connectors/binding/loader.ts` | Read generated/*.json → Zod validate → typed output | ~90 |
| `apps/ecommerce/connectors/binding/planner.ts` | Blueprint → CapabilityExecutionPlan (API选择、Indicator解析、证据规则) | ~220 |
| `apps/ecommerce/connectors/binding/executor.ts` | Generic executePlan + createPlatformExecutor | ~100 |
| `apps/ecommerce/connectors/binding/index.ts` | Barrel | ~8 |
| `tests/unit/connectors/binding/types.test.ts` | 6 tests — schema validation + round-trip | |
| `tests/unit/connectors/binding/loader.test.ts` | 9 tests — loadBlueprint, loadNormalizerPlan, loadIndicatorDict | |
| `tests/unit/connectors/binding/planner.test.ts` | 7 tests — plan building, capability filtering, indicator resolution | |
| `tests/unit/connectors/binding/executor.test.ts` | 6 tests — pipeline execution, factory, error handling | |
| `tests/contract/binding.contract.ts` | 5 tests — full pipeline + indicator/manifest consistency | |

### 修改

| 文件 | 改动 |
|------|------|
| `jd/manifest.ts` | JD_MANIFEST 从 loadBlueprint('jd').manifest 派生（signal_types, business_context, evidence_chain）。UI字段 (display_name, auth_method, default_shop) 保持硬编码 |
| `jd/parsers/indicator-map.ts` | JD_INDICATOR_MAP → INDICATOR_OVERRIDES（8个业务关键key）。mapJdIndicator() = overrides → generated dict → raw key（三层查找）。新增 mapJdIndicatorWithConfidence |
| `jd/acquisition/index.ts` | AcquireOptions 新增 blueprint + capabilities 参数。有 blueprint 时 endpoint 选择来自 parser_plan |
| `jd/acquisition/cdp-client.ts` | CdpAcquireOptions 新增 endpointFilter。DEFAULT_JD_APIS 提取为常量, blueprint 可覆盖 |
| `normalizer.ts` | JD_SPEC / TMALL_SPEC 保持为 authoritative fallbacks（避免循环依赖）|
| `connectors/index.ts` | +1 行: `export * from './binding/index.js'` |
| `tests/integration/jd-pipeline.test.ts` | manifest assertion 适配 blueprint 生成的 context names |

### 关键设计决策

1. **Hand-written overrides 保留 ON TOP of generated dict** — 审计发现 5/7 手写 indicator key 比 algorithmic parser 更准确（如 `ord_user_cnt` → `customers` vs algorithmic `ord_user_cnt`）。INDICATOR_OVERRIDES 确保核心指标语义准确，generated dict 覆盖长尾 887 个 key。

2. **normalizer.ts 不 import binding layer** — 避免循环依赖。normalizer 保持 hand-written specs 作为 authoritative fallbacks，binding layer 的 normalizerPlan 提供额外覆盖。

3. **loadOrGenerate → 简化为 throw** — ESM 不支持同步 require()，原设计在 generated/ 不存在时调用 generateConnectorBlueprint 的 fallback 不可行。改为 throw 明确错误信息。

### 架构变化

```
P0005.2 Discovery (analyzes API data)
        ↓
P0005.3 Capability Generator (produces generated/ JSON)
        ↓
P0005.4 Binding Layer  ← 本次  (reads generated/ JSON → feeds connector)
        ↓
JD Connector (manifest, indicator-map, acquisition — now blueprint-driven)
        ↓
Signals / Evidence / SQLite
```

### 未修改

- `apps/ecommerce/connectors/discovery/*` — 零改动
- `apps/ecommerce/connectors/capability/*` — 零改动
- `apps/ecommerce/connectors/evidence/*` — 零改动
- `platform/runtime/*` — 零改动
- `scripts/cli.ts` — 零改动（backward compat）

### 测试

- **352 passed** (319 previous + 33 new), Typecheck clean
- types (6), loader (9), planner (7), executor (6), contract (5)

### 风险

- **Blueprint generation 仍然依赖 discovery D0002 数据** — discovery/jd-capability/ 是一次性采集的 snapshot。京东 API 变更后需要重新 run Discovery
- **Normalizer 未完全 blueprint-driven** — JD_SPEC/TMALL_SPEC 保持 hand-written fallbacks。当 normalizer plan 成熟后可替换
- **CDP client endpointFilter 是名字匹配** — 从 blueprint endpoint name 到 CDP 捕获的 API name 之间没有严格的 schema 映射

### 关键数据

```
变更前 → 后:
  API 来源:     5 hardcoded → 70 blueprint-driven (parser_plan.rules)
  Indicator:    8 manual     → 8 overrides + 887 generated dict
  Context:      5 static     → 10 generated (from Discovery)
  Manifest:     hand-written → blueprint-derived
  generated/:   orphaned     → consumed by Connector ← 核心变化
```

---

## 本次会话 (2026-07-01) — P0005.3 Discovery Capability Generator

### 做了什么（一句话）

在 P0005.2 的 Discovery Engine（分析层）之上，建立了 Capability Generator（生成层）。现在 `discovery/jd-capability/` 里的 70 个 API 不只是研究报告——它们可以自动生成 Connector Blueprint。

### 新增

| 文件 | 做什么 | LOC |
|------|--------|-----|
| `apps/ecommerce/connectors/capability/types.ts` | 11 个 Zod schema（Blueprint, ParserPlan, NormalizerPlan, Manifest, CoverageReport） | ~110 |
| `apps/ecommerce/connectors/capability/capability-discovery.ts` | Phase 1: API modules → 6 PlatformCapabilities (Transaction, Industry, Customer, Marketing, SupplyChain, Platform) | ~100 |
| `apps/ecommerce/connectors/capability/evidence-analysis.ts` | Phase 2: Endpoint schema → ParserPlan (70 rules, 4 strategies) | ~130 |
| `apps/ecommerce/connectors/capability/semantic-mapping.ts` | Phase 3: Indicator → canonical + unit + transform (887 rules) | ~160 |
| `apps/ecommerce/connectors/capability/blueprint-generator.ts` | Phase 4: 编排全流程 → ConnectorBlueprint + writeBlueprint() → `generated/` | ~140 |
| `apps/ecommerce/connectors/capability/coverage.ts` | Phase 5: Discovery(70 APIs) vs Connector(3 APIs) 覆盖率分析 | ~130 |
| `apps/ecommerce/connectors/capability/index.ts` | Barrel | ~10 |
| `generated/` | connector-blueprint.json, parser-plan.json, normalizer-plan.json, manifest.generated.json, indicator.generated.json | ~683 KB |
| `tests/unit/capability/` | 5 测试文件 (33 tests) | |

### 修改

| 文件 | 改动 |
|------|------|
| `apps/ecommerce/connectors/index.ts` | +1 行: `export * from './capability/index.js'` |
| `apps/ecommerce/connectors/discovery/loader.ts` | 修复 `loadPageInventory` 中 `body_hash`/`body_preview` 的 `exactOptionalPropertyTypes` 类型问题 |
| `scripts/cli.ts` | +19 行: `cli generate-blueprint [--platform jd]` 命令 |

### 关键数据

```
CLI output:
  Platform: jd
  APIs discovered: 70
  Capabilities: Transaction, Industry, Customer, Marketing, SupplyChain, Platform
  Parser rules: 70
  Normalizer rules: 887
  Business contexts: advertising, customer, industry, marketing, product, search, store, supply_chain, traffic, transaction
  Coverage: API 4% / Indicator 31% / Context 50%
```

### 未修改

- `apps/ecommerce/connectors/discovery/*` — 零改动（消费，不修改）
- `apps/ecommerce/connectors/jd/*` — 零改动（现有 connector 不变）
- `shared/schemas/*` — 零改动
- `platform/*` — 零改动

### 测试

- **319 passed** (282 previous + 37 new), Typecheck clean
- capability-discovery (6), evidence-analysis (8), semantic-mapping (8), blueprint-generator (5), coverage (6), contract (4)

### 风险

- **Generated Blueprint 尚未被 Connector 消费** — P0005.4 (Blueprint-driven Connector) 还没做。当前 Connector 仍然用硬编码的 3 个 API。
- **Indicator Dictionary 只有 26 个 key** — 887 个 normalizer rules 大部分来自 endpoint schema 推断（confidence 0.7），不如 indicator dictionary 的映射可靠。

### 建议下一步

1. **P0005.4 Blueprint-driven Connector** — 让 Connector 消费 generated/ 的 blueprint，替换 hand-written manifest 和 indicator-map
2. **扩展 Indicator Dictionary** — 多天多店铺采集以扩充 JDR key 覆盖

---

## 本次会话 (2026-07-01) — P0005.2 Discovery-Driven Connector Architecture

### 做了什么（一句话）

把 D0002 发现的 70 个 API、26 个 JDR 指标、7 个业务上下文，从 "研究报告" 变成了 "可运行的代码模块"。

### 问题

P0005.1 的 Connector 存在一个问题：它知道京东有 5 个 API，因为程序员在代码里写了 5 个。D0002 发现了 70 个 API，但这些发现躺在 `discovery/jd-capability/*.json` 里，Connector 完全不认识它们。

更大的问题是：manifest.ts 里的 `business_context: ['store_profile', 'product_catalog', ...]` 是程序员拍脑袋写的，不是从真实数据验证出来的。

### 解决

新增了 `apps/ecommerce/connectors/discovery/` 模块，分 4 个阶段：

**Phase 1 — API Inventory（替代手写 API 列表）**
`getApiModules()` 自动把 70 个 API 分类到 6 个模块（indexSummary, industryMarket, custGrowth, marketing, stock, common）。不需要任何人事先告诉它。现在 `getApiStats()` 返回 `{ total_apis: 70, modules: 6 }`。

**Phase 2 — Schema Evolution（京东升级时自动感知）**
每个 API 的字段 schema 被 hash 成 SHA-256。下次再跑 Discovery，如果京东改了 API（加了字段、删了字段、改了字段类型），`detectAllChanges()` 直接告诉你哪里变了。以前只能靠人工发现。

**Phase 3 — Indicator Dictionary（替代 indicator-map.ts）**
P0005.1 的 `indicator-map.ts` 只有 8 个手写映射。Phase 3 把 JDR key 拆开：`jdr_sch_trade_deal_ord_ord_amt` → domain=`trade_deal` → Transaction, metric=`ord_ord_amt` → gmv。`resolveIndicator(jdKey)` 返回 canonical name + confidence。新增指标不需要改代码。

**Phase 4 — Business Context Generator（Context 从数据字段自动生成）**
这是最重要的变化。`CONTEXT_DETECTION_RULES` 是一张规则表：如果 API 返回的字段包含 `gmv, deal, order` → 这是 TransactionContext。如果包含 `member, fan, new_customer` → 这是 CustomerContext。所有规则都基于 D0002 验证过的真实字段。`generateManifestContexts()` 输出的格式和 manifest.ts 的 `business_context` 完全兼容。

### 新增

| 文件 | 做什么 | LOC |
|------|--------|-----|
| `apps/ecommerce/connectors/discovery/types.ts` | 14 个 Zod schema，所有类型定义 | ~100 |
| `apps/ecommerce/connectors/discovery/loader.ts` | 读 D0002 JSON 文件 → Zod 验证 → 返回类型化数据 | ~90 |
| `apps/ecommerce/connectors/discovery/api-inventory.ts` | Phase 1: 70 API → 6 模块自动分类 | ~220 |
| `apps/ecommerce/connectors/discovery/schema-evolution.ts` | Phase 2: schema hash + 变更检测 | ~170 |
| `apps/ecommerce/connectors/discovery/indicator-dictionary.ts` | Phase 3: JDR key 解析 + canonical 映射 | ~210 |
| `apps/ecommerce/connectors/discovery/business-context.ts` | Phase 4: CONTEXT_DETECTION_RULES + 上下文生成 | ~180 |
| `apps/ecommerce/connectors/discovery/index.ts` | barrel 导出 | ~70 |
| `apps/ecommerce/connectors/index.ts` | +1 行: `export * from './discovery/index.js'` | +1 |

### 重构

_无。P0005.1 代码零修改。_

### 删除

_无。_

### 测试

- **282 passed**（192 existing + 90 new）, Typecheck clean
- `tests/unit/discovery/api-inventory.test.ts` — 16 tests（模块分类、查询、统计）
- `tests/unit/discovery/schema-evolution.test.ts` — 14 tests（hash 确定性、3 种变更类型、版本历史）
- `tests/unit/discovery/indicator-dictionary.test.ts` — 32 tests（key 解析、domain/metric 分类、compare 后缀、unit 推断）
- `tests/unit/discovery/business-context.test.ts` — 17 tests（字段分析、阈值过滤、manifest 格式、规则完整性）
- `tests/contract/discovery.contract.ts` — 11 tests（跨阶段 pipeline、hash 稳定性、context 不来自程序员声明）

### 风险

- **Discovery Engine 尚未被 Connector 消费** — 这是架构升级的第一步（能力层），第二步（消费层）还没做。当前 Connector 仍然用硬编码的 5 个 API。
- **D0002 数据是单次采集** — API 分类和字段分析基于 2026-06-30 的 snapshot。京东可能已经改了一些 API。
- **indicator_dictionary_full.json 只有 26 个键** — 这远少于京东商智实际的指标数量。需要多天多店铺数据来扩充。

## 本次会话 (2026-06-30) — D0002 JD Capability Discovery + 帮助文档抓取

### 新增
- **JD 商智完整功能介绍** (`data/jd_shangzhi_features/`, 3.1 MB)
  - 34 个功能模块的用户手册（含使用场景、功能简介、详细说明）
  - 23 个模块的指标定义（首页成交金额 → 京速推）
  - 完整资费矩阵（基础包 vs 数据尊享包的功能对比）
  - 抓取方式：CDP → Playwright 连接已登录 Chrome → AngularJS SPA 类别点击遍历
- **D0002 JD Capability Discovery** (`discovery/jd-capability/`, ~20 MB)
  - CDP 自动遍历 15 个 JD 商智页面
  - 捕获 **70 个唯一 API 端点**（1,060 次调用）
  - **7 个已验证的业务上下文**（全部从真实 API 响应数据推断，非页面名称推测）
  - 26 个 JDR 指标键 → 分类（Transaction/Traffic/Customer/Product/Industry/Search）
  - 页面截图 (12 MB) + DOM 快照 (5.4 MB) + API 响应体 (1.8 MB)
- **D0002 抓取脚本** (`scripts/discover-jd-capability-v2.py`)
  - Playwright `page.on('response')` 全量网络捕获
  - 跨子域 SPA 页面容忍（domcontentloaded timeout → load fallback）
  - 自动模态框关闭 + 12s SPA 轮询等待
- **ADR-018**: JD Capability Discovery — 原则：所有 Business Context 必须从真实 API 数据反向生长

### 关键发现
- **summary.ajax** 是最丰富的单端点 — 一次返回 GMV/订单/访客/转化率/客单价/商品件数/行业基准
- **行业数据全部指数化** — JD 不暴露绝对 GMV 值，仅提供 OrdAmtIndex/UVIndex 等指数（趋势分析仍可用）
- **客户 API 暴露人口分层** — 新客 75.48% / 老客 24.52% / 会员 12.52% / 粉丝 68,391
- **竞争分析需要付费订阅** — 竞店概况/竞品对比/竞争流失等 6 子模块当前不可用
- **API 模块已定型** — indexSummary (首页), industryMarket (行业), growthSummary (客户), marketing (营销), stock (供应链), common (平台)
- **JDR 键命名规律**: `jdr_sch_{domain}_{metric}_{source}` — 可机器解析；所有核心指标均带 `##compare`（环比）和 `##compareValue` 变体

### 未修改
- 现有代码零改动（D0002 是纯发现工作，不涉及代码变更）
- 192 测试全部通过
- Typecheck clean

### 风险
- 实时/流量/服务页面使用跨子域 SPA 路由（szweb/sz/marketweb/stockweb）— 当前 URL 直接导航未捕获其 API
- 揽客页面返回极少量数据 (196B 可见文本) — 可能需要特定店铺类型权限
- 竞争/部分行业分析需 ¥8,856/年数据尊享包 — 当前采集存在盲区

### 新增
- **P0005.1 Proposal** (`proposals/P0005.1-jd-connector.md`) — JD 商智 connector 完整 spec
- **Evidence Store** (`apps/ecommerce/connectors/evidence/`) — file-based immutable storage with metadata+hash
  - `types.ts`: EvidenceMetadata, EvidenceRecord Zod schemas
  - `store.ts`: saveEvidence(), loadEvidence(), listEvidence() — 文件结构 `data/evidence/{platform}/{year}/{month}/`
- **JD Parser** (`apps/ecommerce/connectors/jd/parsers/`) — 从 agentCMS 移植
  - `indicator-map.ts`: 8 JD indicator keys → canonical (jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot → gmv, etc.) + 3 WoW comparison
  - `index.ts`: parseJdSummary(), parseJdTrend(), parseJdProductTop(), parseJdPayload()
- **JD Acquisition** (`apps/ecommerce/connectors/jd/acquisition/`)
  - `mock.ts`: Mock data provider (祁门红茶官方旗舰店 sample data)
  - `cdp-client.ts`: Playwright CDP connect + page.route() interception (port from agentCMS)
  - `index.ts`: acquireJdData() facade — mock mode (default) or CDP live mode
- **Manifest** (`apps/ecommerce/connectors/jd/manifest.ts`) — JD connector capability declaration
- **CLI** (`scripts/cli.ts`) — `cli collect jd <shopId> [--mock true|false] [--date YYYY-MM-DD] [--days N]` 完整可运行
- **ADR-017**: JD Business Data Connector (P0005.1)
- **24 新测试**: evidence-store (6), jd-parser (14), jd-pipeline (4)

### 验证
- **192 passed** (168 previous + 24 new), Typecheck clean
- `cli collect jd jd_shop_001 --mock true` → 完整链路: acquire → parse → save evidence (6 files) → normalize → store 25 signals
- Evidence 文件正确生成: `data/evidence/jd/2026/06/30_{summary,trend,productTop}.{json,meta.json}`

### 架构

```
CLI collect jd
  → acquireJdData() [mock|cdp]
    → parseJdPayload() [indicator-map]
      → saveEvidence() [data/evidence/jd/...]
        → normalizeSignal() [existing normalizer]
          → SignalFacade.store() [SQLite signals table]
```

### 未修改
- normalizer.ts, auth.ts, registry.ts (全部复用)
- shared/schemas/ — 零改动
- platform/storage/ — 零改动
- 现有 168 测试全部通过

### 新增
- **RuntimeAdapter 接口** (`platform/runtime/types.ts`) — 所有 Runtime 的通用契约: execute(plan), isAvailable(), capability
- **ExecutionPlan / ExecutionResult 类型** — 结构化可序列化计划 + 结果 (含 Zod schemas)
- **RuntimeCapability / ToolCall / PlanStep / StepResult 类型** — 完整的 Runtime 契约类型系统
- **RuntimeRegistry** (`platform/runtime/registry.ts`) — InMemoryRuntimeRegistry: register, unregister, get, list, resolve(action)
- **DefaultRouter** (`platform/runtime/router.ts`) — 控制平面入口: action → runtime → plan → dispatch → result
- **HermesRuntimeAdapter** (`platform/runtime/hermes/adapter.ts`) — 包装 HermesClient 实现 RuntimeAdapter (适配器模式)
- **ADR-016**: Runtime Control Plane (P0004)
- **24 新测试** — contract (5), unit registry (10), unit router (7), integration (2)

### 重构
- Orchestrator (`apps/ecommerce/orchestrator.ts`) — 新增 `router?: Router` 参数 + `summarizeViaRouter()` 函数；Router 路径优先，HermesClient 路径作为 fallback
- Ranking 路由 (`platform/server/routes/ranking.ts`) — 构造 Registry → Adapter → Router 链路，传递给 orchestrator
- Hermes barrel (`platform/runtime/hermes/index.ts`) — 新增 adapter 导出（+1 行）

### 未修改
- HermesClient (types, subprocess-client, stub-client) — 零改动
- 所有 domain façades, scoring, pipeline — 零改动
- shared/schemas/ — 零改动
- 现有 144 测试全部通过（向后兼容）

### 测试
- **168 passed** (144 existing + 24 new), Typecheck clean
- Dev server: 正常启动，POST /api/ranking 通过 Router 路径返回完整结果
- Hermes v0.17.0: 子进程 AI 摘要可用 (通过 HermesRuntimeAdapter)

### 架构现状

```
HTTP Request
  → Express Route (ranking.ts)
    → Router (DefaultRouter)
      → RuntimeRegistry (InMemoryRuntimeRegistry)
        → RuntimeAdapter (HermesRuntimeAdapter)
          → HermesClient (SubprocessHermesClient)
            → hermes -z "..." (subprocess)
    → Orchestrator (rankProductsComposition)
      → SignalFacade → RankingFacade → TraceFacade
```

### 风险
- Router 目前只支持 `summarize_top_ranking` action — 需要扩展更多 business actions
- 新 RuntimeAdapter 实现 (Claude Code, Codex, OpenHands) 尚未开始
- Adapter 存储在 Registry metadata 中 — 未来可考虑更正式的类型安全机制

