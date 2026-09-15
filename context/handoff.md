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

