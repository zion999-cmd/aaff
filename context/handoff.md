# Handoff — P0013 Workspace UI Regression Repairs（2026-09-16）

> Operator Acceptance 被 Historical Replay 页面布局回归阻塞。两处修复均为**恢复既有正确行为**，非新设计、非重构；未改 cognition / prompt / contract / Evidence / schema / Hermes / 数据。

## 1. 布局回归 — `apps/ecommerce/workspace/styles.css`（+19/−2）

**根因**：`eab6ed4` 新增的 `#replayDailyView > .replay-daily-content { max-height: none }` 以 `#id > .class`(1,1,0) 压制了 G2.3-fix 的 `.replay-daily-content { max-height: 60vh; overflow-y: auto }`(0,1,0) → 每日 cognition 内容**无界增长**；而 `#view-replay` 是 `.view-container { overflow: hidden }`，且是**全仓唯一没有 `.view-scroll` 子容器**的视图 → 超出部分被裁剪且不可滚动，底部 Enrichment 框完全掉出视口（实测 `top 1761` / 视口 900）。

**修复**：删除 `max-height: none`（保留该规则的 flex 尺寸意图）；新增 `#view-replay { overflow-y: auto }`（等价其他视图的 `.view-scroll`）。

**真实浏览器验证**（700 / 900 / 1080 三档，隔离 headless，未触碰 operator `:9222`）：视图独立滚动（900px 档 `scrollH 984 > clientH 796`，`scrollTop 0→188`）；每日内容 60vh 内部滚动；**滚动到底 dock 完整可见且可操作**（选择器/文本框/按钮可见，实测可输入）；页面不增高（`scrollH = clientH`）；其他 5 个视图容器未受影响。

## 2. Control bar stale state — `apps/ecommerce/workspace/views/replay-view.js`（+14）

**根因**：`refreshRunState()` 在 `isAdvancing === true` 时调用 `applyControls()`，而 `onNextClick` / `onRetryClick` 的 `finally` 只清 flag **不重推控制栏** → 连续回放中「⏸ 暂停」长期渲染为禁用，run 不可中断。（`onSkipClick` 早已有 P1-4 正确模式，这两处漏了。）

**修复**：两处 `finally` 各补 `applyControls();`。未改其他控制状态逻辑、未重构。

**真实验证**：Next 飞行结束后控制栏恢复（`step 1/4 → 2/4`，next/exec/restart 均可用）；连续回放中一步飞行结束后「⏸ 暂停」**已启用**，点击后 run 状态 `RUNNING → PAUSED`（真中断）。**Retry 分支仅代码对称，未端到端实测** —— 该按钮仅在 `STEP_FAILED` / `BLOCKED` / 卡住 `RUNNING_ACTIVE` 下启用，三者当前都不可非破坏性构造（`POST /runs` 对含缺口日的窗口返 409，造不出 BLOCKED）。

## 边界

未触碰：审计 A–G 债务、Enrichment timeline icon、compression/deadline、Replay cognition/prompt/contract、Evidence/Coverage/Enrichment 语义、DB/schema、其他页面。探针 run 已按 ID 精确清理（生产 Evidence 870 行未变，`foreign_key_check` 无输出）。

---

# Handoff — P0013.5 Knowledge-Grounded Business Analysis（2026-09-16，ADR-092）

> 只把 Knowledge 义务**提升为 shared analysis contract**，未新建 Knowledge 系统，未改 schema / Evidence / runner / coverage / clock / acquisition / Hermes / 模型。

## 改动（4 处文件）

1. `apps/ecommerce/runtime/investigation/analysis-contract.ts` — 新增共享 `KNOWLEDGE_ANALYSIS_SECTION`（Index-first 导航 / 作为方法 / Knowledge+Evidence→hypothesis / 回答经营问题 / 不设引用数量与必读页面 / Knowledge≠Evidence 边界与因果禁止）；`EVIDENCE_RESOLUTION_SECTION` 的 "Do NOT read arbitrary files" 收紧为 "…to obtain **EVIDENCE**…"。
2. `apps/ecommerce/runtime/investigation/prompt.ts` — **改为消费共享节**：删除 Production 专属的三层导航段与自有 `## Knowledge ≠ Evidence` 段落，workflow 第 2 步缩为指针，Three Concepts 表 Knowledge 行改为指向共享节（净效果：production prompt 变短、规则单点）。
3. `apps/ecommerce/runtime/replay/replay-cognition-kernel.ts` — 删除 replay-only `## Knowledge ≠ Evidence (Phase D)`，嵌入同一共享节；workflow 新增第 2 步（Knowledge 导航），第 3 步改为 "Form at most 3 hypotheses **from Knowledge + Evidence**"；Trust Boundary 的 "The ONE permitted tool call" → "The only permitted **ACQUISITION** tool"（否则新义务被同一 prompt 禁止）。
4. `tests/...` — 新增 `knowledge-analysis-contract.contract.ts`（11 项）；`replay-cognition-kernel.test.ts` 旧标题断言更新为新共享节。

## 真实 A/B（同一 frozen 数据集 / 同窗口 09-02→09-12 / 同两条 enrichment，真 Hermes）

| | BEFORE `1bbc1239` | AFTER `993070af` |
|---|---|---|
| 天数 | 11/11 COMPLETED | 11/11 COMPLETED |
| 读到的 knowledge 文件 | **0** | **5**（INDEX → operations/product INDEX → true-vs-false-anomaly / atp-drop-diagnosis） |
| `provenance:"knowledge_rule"` | 0 | **3**（`basis_refs` 点名 `knowledge/operations/true-vs-false-anomaly.md`） |
| Knowledge 升格进 `observed[]` | 0 | **0** |
| 因果越权 | — | 0（优惠→结果记为 `missing_evidence:["核销"]` 的待证 claim） |

**如实记录**：After 的导航集中在 09-02/09-03，其后各日引用本 run 内已读页而非重复读取 —— index-first、按需、不 bulk，但**不是**每天读一次。

## Production provenance probe（只读抽样）

最近 15 个真实 Production investigation 会话 **15/15** 都执行 Knowledge 导航（`read_file` + `search_files`，根 INDEX → 域 INDEX → 相关页，3–5 文件非 bulk）；抽样原始输出把 Knowledge 用于分析并与 Evidence 区分（引用"真伪异常判定门（UV<500…）"与 "Case-008"，并写明"当前证据不支持"升级）。**PASS**。

## 测试

新增 contract 11/11；全套件 **1778 passed / 4 failed + 1 file error**，5 项失败全部既存（live-d1 缺 token、chat.contract CDP 超时、clear-block-dispatcher 按钮漂移、evidence-store-history 日期硬编码、gettrend-provider-watermark 文案漂移），0 新增；typecheck 83（= 基线）。

## Artifact

`context/p0013-5-knowledge-ab-2026-09-16.md`；两侧 run 在 Workspace「历史回放」可直接对比。AFTER run 09-09 步触发 ADR-085 已知 compression（仍 COMPLETED），按边界未处理。

## 未触碰

Knowledge 内容 / 新增知识文件 / embedding 或 RAG / Evidence schema / Replay coverage, clock, runner, acquisition / gap 自动调查 / A–G 债务 / Enrichment timeline icon / compression-deadline / Hermes / 模型与 provider。Claude 未对认知业务质量下结论（留给 Operator）。

---

# Handoff — P0013.4 Replay Cognition Continuity（2026-09-16，ADR-091）

> 只改**推理契约**（prompt 文本），不改 runner / Coverage Gate / Acquisition / stale-rerun-enrichment storage / Evidence / schema / Knowledge / Hermes；未新增规则引擎、状态机或经营阈值；未加文案润色层。

## 审计：症状与归因（真实轨迹 run 5babef67，09-04→09-13，10 天）

| 症状 | 度量 | 归因（契约沉默处） |
|---|---|---|
| 逐日 N/N 计分 | **8/10 天**（`严格高客单 2/2（未升稳态）`、`软化口径 3/3`、`①命中 ②未命中`） | 契约从未说明 prior_cognition 是"既有理解"还是"待逐条回应的清单" |
| 自造分类装置 | **6/10 天**（`门禁`/`软化口径`/`升稳态`/`候选`） | threshold provenance 示例 `若 GMV > 12000 则确认` 直接诱导模型自建闸门来给每天贴标签 |
| Understanding 指标堆开头 | **8/10 天** | 契约要求"强 claim 必须有 refs"，却没有说数字是支撑而非叙述 |
| Enrichment 每日必答 | **10/10 天** mention（多为例行"不归因"声明） | 旧文案要求"weigh against evidence, cite them explicitly"，等于每日点名 |
| Recommendation 规则机化 | 多日退化为 `观察 2/2 或转向` | 同上（计分框架的产物） |

## 修改（3 处，均为文本）

1. `apps/ecommerce/runtime/investigation/analysis-contract.ts` — 新增共享 `COGNITION_CONTINUITY_SECTION`（Production + Replay 同一文本，无分叉）：prior cognition = standing understanding；显式禁止 N/N 计分、自造分类闸门/阈值阶梯、指标堆开头、为确认而重述昨日、计分式 recommendation；规定 Understanding 必须回答"什么延续 / 什么改变 / 什么仍未知"。同时把 `business_structure_coverage` 明确为**完整性检查**（五维仍强制，validator 未动）。
2. `apps/ecommerce/runtime/replay/replay-cognition-kernel.ts` — Enrichment 改为**背景上下文**：不要求回应/解释/验证，**不相关时沉默即正确**（明确禁止每天写"这不构成原因/不归因"），仅在确实影响当日阅读时使用；因果纪律保留并改为"When relevant"前提。prior cognition INVARIANT 补一句"不要逐项打分"；workflow 第 2/4 步删除逐项判定与阈值分类措辞；thresholds 示例改为"仅在真实决策依赖时"。
3. `apps/ecommerce/runtime/investigation/prompt.ts` — 同一 continuity 节接入 Production prompt（共享契约，不分叉）。

## 真实验收：A/B（同一数据集 `…20260914_0231`，同窗口 09-04→09-12，真实 Hermes）

| 运行 | 天数 | N/N 计分 | 自造装置 | 指标堆开头 | 提及 enrichment | 因果违规 |
|---|---|---|---|---|---|---|
| **BEFORE** 5babef67（修复前，有 enrichment） | 10 | **8** | **6** | **8** | **10** | 0 |
| **A** 无 enrichment（run 920332b4） | 9 | **0** | 1 | 1 | 0 | 0 |
| **B** 有 enrichment（run 16220625，09-04 action + 09-10 feedback） | 9 | **0** | **0** | **0** | **1** | 0 |

逐条对应 Success Criteria：
1. ✅ 零 N/N 计分（对照 8/10）；自造装置 A 残留 1 例（09-12 建议"续窗用同一套结构门禁继续读"）——已记录，未追加补丁。
2. ✅ 无 enrichment 时认知自然延续与修正：A 逐日读作"中间态 → 高客单 → 延续 → 脉冲 → 软化 → 中间态"，09-12 自行归纳"订单结构高频切换生意，极端脉冲不可当增长锚"；无昨日结论复述式确认。
3. ✅ 有 enrichment 时只相关才用：B 中 09-04（记录优惠当天）对优惠**零提及**，未解释也未声明无关；唯一提及在 09-10。
4. ✅ 因果未知保持：两天运行 0 处"优惠导致/因券/券带来"；B 09-10 写明"店长判断可作工作假设，不能替代订单证据"。
5. ✅ Understanding 体现跨日理解：B "截至09-05，店铺从昨日中间态切到…"；指标堆开头 0/9。
6. ✅ A/B 真实轨迹已存档供人工审核：`context/p0013-4-cognition-ab-trajectories-2026-09-16.md`（逐日 Understanding/Judgment/Recommendation/Unknowns + BEFORE 对照）。

不可变性：frozen manifest hash `87613e01…` 不变；两 run no-future-leak 违规 0；生产 Evidence 858 行（+6 为生产 loop 当日 trade.overview 采集，与 Replay 无关）。

## 测试

新增 `tests/contract/replay-cognition-continuity.contract.ts` **12/12**（禁止模式锚定 + enrichment 非议题 + coverage 非记分卡 + workflow 源码断言）。相关套件 contract/unit replay/investigation 717 passed（1 个既存 live 失败）。全量 **1766 passed / 5 failed**，5 个失败全部为本任务前既存（日期硬编码 fixture、watermark 文案、app.js 按钮、live chat/loop/live-d1）。typecheck 83（基线 84，无新增）。

## 残留 / 建议

- A 的 09-12 出现一次 `门禁` 措辞（模型仍倾向为未来窗口提议分类装置）。未再堆 prompt 规则；若复现增多，考虑在 continuity 节补一条"不要为后续窗口提议框架"。
- Enrichment 唯一提及日为 09-10（operator_feedback），属预期；若人工审核认为"相关日也必须完全沉默"，需再议（与 criterion 3 的"相关时可用"冲突）。
- 未做：Knowledge/Skill/Memory 新能力、Production feedback、cognition 输出 schema 变更。

---

# Handoff — P0013 Historical Replay Correctness Patch（2026-09-16，ADR-090，基线 eab6ed4）

> 只修确定性正确性问题：Coverage Gate（核心）、控制状态死路、Enrichment 交互、UI 紧凑度。未改 cognition prompt / analysis obligations / ADR-083 / frozen dataset / 原始 Evidence / Business Time。未处理 checkpoint 后遗留的 77 项历史工作区文件。

## 根因（覆盖缺口为什么没被拦住）

1. **Coverage 谓词过弱**：`historical-dataset.ts` 的 `missingBusinessDates` 只由 `trend.xaxis` 是否包含该日期推导。真实数据集 `jd_acquisition_20260914_0231` 的 xaxis 含 09-13，但该日 `getTrend` own-GMV 为 **null**、`getDealOrders` 返回 **0 行**、per_day 为 0 —— 于是被判"已覆盖"。
2. **Replay 路径从不查询 coverage**：POST /runs 只校验窗口边界；`runReplayRunStep` 对游标日期无条件调 kernel；`nextDate` 无条件推进。
3. 结果（本 patch 之前的真实记录）：run `5babef67`（09-04→09-13）对 09-13 产出了 COMPLETED cognition + 快照，Agent 甚至在判断里写"空日更宜记为数据未齐" —— 一次真实 Hermes turn 被浪费，且把空日混入认知轨迹。

## 修复

- **按日 Evidence Contract 谓词**（纯函数 `computeDateCoverage`）：covered ⇔ ①trend 有该日行且（数据集确实携带 own-GMV 序列时）值为有限数 ②订单 per_day 存在 ③manifest `gaps[]` 未声明该日缺口。零订单/零金额**不**算缺口（真实零经营日是事实）。数据集未携带该序列时退化为行存在性（不误伤最小 fixture）。行级 `reasons` 机器可读。
- **BLOCKED run 状态**：`REPLAY_RUN_STATUSES` / `ReplayClockStatus` / TERMINAL 集合同步 + `blocked_business_date` / `blocked_reason` 列 + SQLite CHECK 就地重建迁移（幂等；已在生产库副本上验证 20 runs / 226 steps / 5337 refs / 220 snapshots 行数不变、FK 干净、索引保留）。
- **Runner 日级 gate**：`runReplayRunStep` 与 `rerunHistoricalStep` 在 kernel **之前**判定；不通过则不写 step 行、不调 kernel、不产认知，run 置 BLOCKED。连续回放遇 BLOCKED 停止，不越缺口。
- **创建即拦截**：POST /runs 窗口含未覆盖日 → 409 named Coverage Gap（含日期与原因）并指向既有 P0013.1 acquisition 端点；缺口日必须采集出新数据集后用新 run 回放。
- **retry 可达性**：mode=retry 现删除当前业务日的 FAILED 认知行并 FAILED/BLOCKED → RUNNING（此前只删带 `[manually retried]` 标记的行，自身 FAILED 的 step 永远无法重试）。新增 `clearFailedCognitionForCurrentDate` / `rearmRunForRetry`。
- **UI**：BLOCKED 为独立 uiState（next/exec 禁用并给出原因；retry/restart 始终可达）；新增覆盖缺口横幅（缺口日 + 原因 + 「前往发起真实历史采集」直达 P0013.1 入口）；`GET /runs` 列表投影补上 blocked 列。

## 真实验收（逐项，非单测）

| # | 项目 | 结果 |
|---|---|---|
| 1 | 覆盖 + 未覆盖窗口的 Replay 请求 | 09-04→09-13 = **409** `Evidence Coverage Gap: 2026-09-13 (trend_value_missing, declared_evidence_gap)`；09-11→09-12 = 200 |
| 2 | 未覆盖日在 cognition 前触发 Gap | run `9a10c8b3`：09-12（覆盖）真实 Hermes 认知 COMPLETED → 推进到 09-13 时 **BLOCKED，0 step 行、0 快照、kernel 未被调用** |
| 3 | 采集路径 + 不产伪认知 | 缺口经 POST /api/replay/acquisitions（既有 P0013.1 路径；UI 横幅一键直达）；`/datasets` 如实报 missingList=['2026-09-13']；源系统对该日确实无数据（0 行/null）→ 明确 BLOCKED，不执行 cognition |
| 4 | 连续回放同样 gate | runReplayRunToCompletion 遇 BLOCKED 立即停（单测 + 真实 run 双证）；覆盖窗口连续回放正常 COMPLETED |
| 5 | RUNNING 下 pause/rerun/retry 无死路 | run `9cdb7077` 的 FAILED step（Turn timed out）经 **retry 真实重跑 → COMPLETED**；restart 在 BLOCKED/RUNNING idle 下可达（自动 pause，不再提示"必须暂停"） |
| 6 | 未回放日加 enrichment → 回放自动读取 | run `c7c37f5b`（0 step）预置 09-11 fact + 09-12 action（stale=[] ）→ 连续回放到达即消费（09-12 判断同时引用 09-11 fact，T+n 可见） |
| 7 | 已回放日加 enrichment → stale + rerun | 09-11 加 operator_feedback → stale=[09-11,09-12] → 单日 rerun 后 09-11 fresh / 09-12 仍 stale → 连续 stale rerun 全 fresh；feedback **未**进入 observed[] |
| 8 | UI business_date ≠ created_at | headless 实测：记录显示 `Business Date 2026-09-11 … 录入时间 2026-09-16 04:22`；缺口头条显示缺口日期与原因 |
| 9 | frozen dataset / Evidence / no-future-leak 不变 | manifest hash `87613e01…` / `df8783a7…` 与文件 mtime 不变；生产 Evidence 852 行不变；no-future-leak 违规 0（09-11 未看到 09-12 证据） |

UI 检查 9/9 PASS（隔离 headless Chrome :9340，未触碰 operator 的 :9222）。

## 测试

新增：`tests/unit/replay/coverage-gate.test.ts` 7 项（谓词 + runner gate + 连续 + 无误伤）；`replay-routes.test.ts` +3（409/200/retry 可达）。全套件 **1755 passed / 4 failed**，4 个失败均为本 patch 之前既存（日期硬编码 fixture `evidence-store-history`、`gettrend-provider-watermark` 文案漂移、`clear-block-dispatcher` app.js 按钮漂移、live 路径 chat/runtime-loop/p0010.2.4-live-d1）。typecheck 83（基线 84，无新增）。

## 未解决 / 待办

- run `5babef67` 等本 patch 之前产生的"空日认知"按原样保留（历史记录不回改）。
- 09-13 在源系统确实无数据（getDealOrders 0 行 / getTrend null）——补齐需 provider 侧有数据，属独立采集任务。
- 控制状态模型已是 READY/RUNNING/PAUSED/COMPLETED/FAILED/**BLOCKED**，未另造平行状态机；若后续需要 run 内跨数据集补齐，属新设计（当前明确：run 绑定单一数据集）。
- 任务范围外仍开放：cognition 的 checklist 化/复读倾向（#5）、Enrichment 不应被 Agent 当作每日必答议题（#6）——**本轮未动 prompt**。

---

# Handoff — P0013.3 Product Acceptance Repair（2026-09-15）

> 人工验收 6 缺陷已修并重新 Workspace E2E。Enrichment 语义统一为 Run+Business Date（非 step/completed/created_at）。

## 修复
1. 所有时间轴格（含 pending ○/未来日）可点 → viewedDate 与 cursor 完全解耦；run 创建后任意合法日即可补充（无 cognition 也显示补充面板）。
2. Business Date 粗体主显示（#replayEnrichmentDate），录入时间次要；DB/API（窗口校验）/kernel（business_date<=T）三层绑定一致。
3. 表单 CSS：类名失配修正（replay-enrich-form）+ 确定宽度 600px/max-width:100%，桌面 1440 实测 600px 不遮挡。
4. 死路消除：「重新回放」RUNNING idle 时自动 pause（复用已有 runner 能力，无新 pause UI）后回面板；in-flight 临时禁用+说明；「保存并重放」等待 in-flight/自动 pause 后 rerun；未来日 rerun 按钮禁用并说明"预置，到达时自动读取"。
5. 未来日预置不产生 stale（仅 COMPLETED step 被打标），到 T 自然消费。
6. Action T+n 可见性审计：visibleEnrichmentsAt business_date<=T 已满足，未重写；prompt 共现非因果规则已在 ADR-089。

## 真实验收（真 Hermes，run bf740b90，09-04→09-08）
- 创建 run 不 replay → 09-07 预置 action（零 step/零 stale）→ resume+连续 replay：09-07 judgment "券与 GMV 只记序列"；09-08 运行中预置 fact → "停券与软化只记序列"；09-06 UI 追加的 operator_feedback 被执行为 L3 hypothesis（"店长礼赠判断非 L1"），未升 Fact。
- 运行中给未来 09-08 补 fact：无死锁、零 stale；已完成 09-04 补 fact：stale=[04,05]；mode=stale 从 09-04 重放到窗口末 5 步 COMPLETED、0 stale；frozen hash 87613e01 不变。
- Headless Chrome（独立 9334，不碰 9222）Workspace E2E 15/15。
- 回归：135 replay/契约测试通过；typecheck 84（=基线）。

## 注意
- 踩坑：排查布局时发现 GET / 与 /index.html 一度比对异常，实为 CSS 类名 replay-enrichment-form(误) vs replay-enrich-form(实) 失配；已修。
- headless 测试产生的 READY run 已清理。
- Workspace 手工点击请硬刷新（Cmd+Shift+R）。

---

