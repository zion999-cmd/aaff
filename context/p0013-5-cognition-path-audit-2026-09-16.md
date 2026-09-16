# P0013.5 Cognition Path Audit — Production vs Historical Replay (2026-09-16)

**类型**: architecture-level cognition path audit + 修复
**审计起点**: HEAD `0855cde`（暂停修复在此之前完成并提交为 `cd8b263`）
**方法**: 代码 + persistence + `~/.hermes/state.db` 真实 session/tool trace；未做业务结论判断。

---

## 0. 结论速览

**「Production 与 Replay 是两套 cognition pipeline」——不成立。** 两者共用同一个 turn machinery（同一 WS client、同一 `collectTurn`、同一 `parseInvestigation`、同一份共享 Analysis Contract）；claude 未发现第二套 cognition 实现。

**真正的分叉在 Evidence Universe 层，而且它是设计使然**：Production 的 runtime loop 按**业务日**采集 `trade.overview`，所以每天都有 UV/CVR；Replay 的 frozen 数据集对 KPI 只采到**一个整窗口聚合**，**按日的 traffic/CVR 从未存在过**。

因此 Agent 在 Replay 说「Traffic/CVR 不可见」**是事实正确的**，不是幻觉，也**不是**「已有 persisted Evidence 被声称为缺失」。但审计确实发现两个**真实的表示层缺陷**（见 §4），已修复。

---

## 1. §1 未提交改动分类（audit 开始时的 working tree）

`git status --porcelain` = **78 项**。按来源分类：

| 类别 | 内容 | 处理 |
|---|---|---|
| **已完成且已验证（本会话）** | `views/replay-view.js`（暂停修复） | **已形成独立 checkpoint commit `cd8b263`** |
| **历史 stale 改动**（30 个 tracked 文件） | mtime **2026-09-07 06:53** 同一批次：`cdp-client.ts` / `situation/producer.ts` / `situation-chat.ts` / `app.js` / `session-client.ts` / `AGENTS.md` / `README.md` 等 | **保持 untouched**（无法确认归属，不删不改） |
| **来源不明** | `CLAUDE.md`（mtime 2026-09-16 06:41，非本会话改写）；仓库根 `delimiter`、`task.md` | **保持 untouched** |
| **运行/实验产物（untracked）** | `data/_blind_runs/`、`data/jd_acquisition_*/`、`data/quarantine/`、`data/*.json`、`scripts/phasej-*.ts` 等 | **保持 untouched** |

未删除、未覆盖、未顺手 cleanup 任何旧改动。

---

## 2. §2 两条真实执行链逐层对比

### 2.1 结构

```
                 Production                          Historical Replay
Evidence Universe  runtime loop 按日采集               frozen dataset（4 个文件）
                   trade.overview(today)              getTrend / getSummary /
                   → evidence_observations            perDaySummary / perOrder
Situation          producer.ts（规则触发）             ⚠ Replay 无 Situation 层，
                                                      run window 即日期游标
Knowledge/Skill    knowledge/ + capabilities/ 可读     knowledge/ 可读（P0013.5 起同一义务）
Business Question  prompt 内嵌 Situation + 证据        prompt 内嵌 visibleEvidence
Investigation      runInvestigationTurn               kernel 自建 prompt（同形）
Evidence retrieval fabric_execute_capability          fabric_replay_retrieve_orders
                   fabric_list_capabilities           （orders-only）
Finding/Hypothesis parseInvestigation                 parseInvestigation（同一个）
Judgment           ↓ 同一个 parser / 同一份共享 contract ↓
Recommendation     recommendation-to-output.ts        （无 WorkItem materialization）
```

**共享**：WS client、`collectTurn`、`parseInvestigation`、`validateAnalysisObligations`、
以及 `analysis-contract.ts` 的四段（Analysis Target / Cognition Continuity / Evidence
Resolution / Output Obligations，P0013.5 起再加 Knowledge）。

**不共享**：Evidence Universe、Retrieval surface、Situation 层、WorkItem materialization。

### 2.2 逐项 Evidence 归属（回答「在哪一层进入」）

| Evidence | Production | Replay |
|---|---|---|
| orders / products | `trade.overview` + `order.overview` capability | `perDaySummary` / `perOrder`（按日，**可见**） |
| **traffic（UV/PV）** | 按日 `getSummary` → prompt | **无按日数据**；仅存在于整窗口聚合 |
| **conversion（CVR/加购）** | 同上（按日） | 同上 |
| operational actions | operator 富化 / live capability | enrichment 表（本轮 run 无） |

### 2.3 §2 特别 trace：09-02/09-03 的 UV / PV / CVR / traffic source / promotion

| 层 | 事实 | 结论 |
|---|---|---|
| source | JD `getSummary.ajax`（**请求体 `startDate=2026-09-02 & endDate=2026-09-13`**，8 次抓取**全部**是窗口范围） | 采到的就是窗口聚合 |
| acquisition | `target_a_summary_decoded.json` 的 `date_range = 2026-09-02..2026-09-13`，`all_kpis_readable` 含 12 项（UV=45124 / PV=8053 / CVR=0.0936 / 加购 …）但**只有一组值** | 无按日粒度 |
| persisted | `evidence_observations` **id=5837**，`capability=trade.overview`，`data_type=getSummary`，**`business_date=2026-09-13`** | 被标成数据集末日 |
| visibility gate | `visibleEvidenceFor` → `WHERE business_date <= T` | **T ∈ 09-02..09-12 时 09-13 > T ⇒ 永不可见** ← **第一次丢失点** |
| representation | `readEvidenceContentSummary` 的 getSummary 分支**只渲染 4/12 KPI**，且注释误称「the 6 KPIs」；UV/PV/加购**即使可见也不会被渲染** | ← **第二次丢失点（已修）** |
| retrieval | 唯一的 replay 检索工具是 orders-only 的 `fabric_replay_retrieve_orders`；`fabric_execute_capability` 被 trust boundary 禁止 | 无补救路径 |
| cognition | Agent 写 `traffic/conversion = gap` + `UNAVAILABLE` resolution + acquisition_need | **如实**，非误报 |

> **必须说明的反向事实**：把 id=5837 提前可见是**不可接受**的——它是覆盖 09-02..09-13 的聚合，
> 在 T=09-02 使用它等于泄露 11 天未来数据。所以 `business_date = window.end` 这个戳记本身
> **符合 No-Future-Leak**；问题不是「藏起来了」，而是「既不可见、也没有任何标注说明它是什么」。

**第一次丢失点 = `seed-evidence.ts` 把窗口聚合戳成 `dataset.window.end`；
按日 traffic/CVR 从未被采集，这是数据集采集粒度的事实，不是 cognition path 的 bug。**

---

## 3. §3 核心假设验证

> Production 与 Replay 不应拥有两套 cognition pipeline；应是「一个 Cognition Kernel，两种 Clock / Evidence Release Policy」。

**结论：假设基本成立，但有一个例外。**

- **成立**：kernel 实现层面确实共用同一套 turn machinery 与同一份 contract；Replay 的差异被收敛在「Evidence 从哪来 / 什么时刻可见 / 能检索什么」三点，正是 Clock + Evidence Release Policy。
- **例外（未共享）**：**Evidence Universe awareness**。Production 可以读 `capabilities/INDEX.md`（12 个 capability 规格）并调 `fabric_list_capabilities`；Replay **什么都没有** —— Agent 只能看到被渲染出来的行，于是「这个 run 从没采过」与「采了但没进我的 prompt」在它眼里**完全一样**，两者都会变成 Evidence Gap。这是真实的能力缺口，已修（§4）。

---

## 4. §4 Evidence Gap 语义 + 修复

### 违反情况

契约文本（Evidence Resolution）本身已经是正确的三步顺序，**没有**被违反：
Agent 在本轮真实 run 里确实先做 resolution，再写 gap（见 §5 证据）。但**执行这一步所需的信息 Replay 不提供**：Agent 无法区分「unavailable」的两个子类。这正是 §4 要求的「Agent 应知道 Evidence Universe / availability」缺失之处。

### 修复（两处，均为表示/认知面；未新增数据）

**F1 — KPI 渲染不再是截断的**
`replay-cognition-kernel.ts` 的 `readEvidenceContentSummary` getSummary 分支：
- 从硬编码 4 项改为**渲染文件里实际存在的全部 KPI**（含 UV/PV/加购/客单价/停留时长…），并带对比期百分比；
- **显式标注覆盖窗口**（`覆盖 2026-09-02..2026-09-13（整段窗口聚合，非单日值）`），使聚合行在任何时候都不会被读成单日事实；
- 修正误导性注释。

**F2 — Replay 获得 Evidence Universe（Production `capabilities/INDEX.md` 的对位物）**
- 新增 `heldEvidenceFor(db, runId, T)`（`temporal-evidence-view.ts`）：按 `capability/data_type` 汇总 run 实际持有的行数、`business_date` 覆盖区间、以及在 T 的可见行数。**只描述持有情况，不描述任何值**，也不放宽可见切片（`visibleEvidenceFor` 仍是唯一权威）。
- `buildReplayInvestigationPrompt` 新增 `## Evidence Universe of this run (complete inventory — the dataset is frozen)` 段（`heldEvidence` 为**可选**参数，既有调用方不受影响），并明确三种读法：
  - 列了且有可见行 → 在 Current evidence 里，直接用；
  - 列了但 0 行可见 → run 持有但今天不可用；
  - **完全没列 → 冻结数据集从未采集它**，记 Evidence Gap + acquisition_need，并明确要求**不得**把「从未采集」描述成「被隐藏」，也**不得**把已采集的报成缺失。
- 明写「Do not treat this inventory as an agenda」，避免变成 checklist。

**未做**（遵守 §5 / NOT Included）：没有为 Replay 硬编码 UV/CVR；没有新建第二套 Replay investigation framework；没有把更多固定字段塞进 prompt；没有改 Knowledge 内容；没有实现自动 gap acquisition；没有改 runner / clock / coverage / dataset。

---

## 5. §6 Real Acceptance（真 Hermes，非单测）

### A. Replay 09-02 → 09-03（run `6bcfbaf5-3994-42f7-912a-28aed9aa87c6`，2/2 COMPLETED）

**Hermes 确实知道 Evidence Universe** —— 真实 prompt 原文：

```
## Evidence Universe of this run (complete inventory — the dataset is frozen)
- order.overview/perDaySummary — 12 rows, business_date 2026-09-02..2026-09-13 — 1/12 visible at T=2026-09-02
- order.overview/perOrder     — 12 rows, business_date 2026-09-02..2026-09-13 — 1/12 visible at T=2026-09-02
- trade.overview/getSummary   — 1 rows,  business_date 2026-09-13 — 0 visible at T=2026-09-02 (not available today)
- trade.overview/getTrend     — 12 rows, business_date 2026-09-02..2026-09-13 — 1/12 visible at T=2026-09-02
```

**Agent 的 raw cognition 不再把「未采集」说成「不可见」**（09-02）：

```json
{"dimension":"traffic","status":"gap","note":"无 UV/PV/来源，无法判断份额与订单来自自然还是付费/活动",
 "acquisition_need":"traffic.overview 或等价 UV/来源拆分（自然/付费/活动）"}
{"need":"UV/流量来源","dimension":"traffic","result":"UNAVAILABLE","source":"in_context",
 "note":"当前证据与冻结库存无 traffic；replay 禁止 live 采集"}
```

**进入真实 Evidence retrieval**：3 个 `RETRIEVED` resolution，带真实订单/SKU id
（`parentOrdersByDay:2026-09-02`、`3609490014061700`、`10114242621660` …）。

**No-Future = 0 违规**：

| step | refs | 该步引用 evidence 的最大 business_date |
|---|---|---|
| 2026-09-02 | 3 | 2026-09-02 |
| 2026-09-03 | 6 | 2026-09-03 |

> **「如果 Traffic/CVR 已持久化 → 能发现并 retrieve」不成立的前提**：09-02/09-03 的按日
> traffic/CVR **没有被持久化**（§2.3）。因此该项按契约退化为「如实记为 gap + acquisition_need」，
> 这正是要求的语义，不是失败。

### B. Production cognition probe（真 Hermes）

对真实 open situation `sit_7a844c4ba80c3305a399` 跑真实 investigation：

| 字段 | 值 |
|---|---|
| stopReason | `judgment` |
| coverage | `orders:covered`、**`traffic:covered`**、**`conversion:covered`**、product/operations: gap |
| resolutions | `orders:RETRIEVED`、`traffic:IN_CONTEXT`、其余 UNAVAILABLE |
| hypotheses / obs facts / gaps | 7 / 4 / 6 |
| judgment | 引用真实数字：`trade.overview@2026-09-16：gmv=4994.05、orders=27、uv=390、cvr≈6.9%` |

**Production lifecycle 无回归**：Knowledge retrieval 正常（本会话早前抽样 15/15 导航）、
Evidence 正常、Judgment 正常。且它 `traffic:covered` **正是因为 Production 有按日 UV/CVR** —
与 Replay 的对照点在此，与 cognition 实现无关。

---

## 6. §7 交付

**touched files**
- `apps/ecommerce/runtime/replay/replay-cognition-kernel.ts`
- `apps/ecommerce/runtime/replay/temporal-evidence-view.ts`
- `tests/contract/replay-evidence-universe.contract.ts`（新增 9 项）

**changed behavior**：Replay prompt 多一段「本 run 持有清单」；getSummary 渲染全部 KPI 并标注覆盖窗口。
**intentionally unchanged**：runner / clock / coverage gate / acquisition / dataset / schema /
Knowledge 内容 / Hermes / 模型；暂停与 UI（属前一 commit `cd8b263`）；A–G 债务。
**NOT Included**：见 §4 末段 —— 全部遵守。
**remaining known defects**：按日 traffic/CVR 在该数据集中不存在（需重新采集，属采集粒度问题）；
聚合行 id=5837 在 run 窗口内不可见（正确行为）；Replay 无 Situation 层 / 无 WorkItem materialization；
P013.4 的「门禁」措辞残留；compression/deadline；A–G 债务。
