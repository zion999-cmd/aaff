# P0013 Hermes Cognition Provenance Audit — 2026-09-16

**类型**: READ-ONLY 审计（未修改 Prompt / Contract / Knowledge / Replay / Hermes）
**作者**: Claude Code（Implementation / Observer / Auditor 角色，见 CLAUDE.md Agent 权责边界）
**Audience**: Design / Planning Agent + Human Operator

---

## 0. 边界声明

本次审计只做四件事：调用/观察真实 Hermes Runtime、准备并记录 Fabric 输入、检查结构/Evidence 引用/时间边界/工具调用、比较 Hermes 原始输出与 Workspace 展示。

未做：读取业务数据后自行完成经营分析、替 Hermes 判断"发生了什么"、补写或改写任何 cognition、用 Claude 的子 Agent 判断作为验收结论。

唯一的写操作是审计要求的 **Real Control Run**（一次真实回放，产生 1 个 run + 1 个 step + 1 个 snapshot）。**没有修改任何 prompt / contract / schema / knowledge / dataset / Hermes 配置。**

---

## 1. 方法与证据源（关键：可独立复核）

过去审计只能证明"代码接线到 Hermes"。本轮发现了一个**独立的第三方证据源**，使逐条比对成为可能：

| 证据源 | 位置 | 提供什么 |
|---|---|---|
| Fabric 持久化 | `data/agentfabric.db` → `replay_run_cognitive_snapshots` | persisted cognition |
| Hermes 自有会话库 | `~/.hermes/state.db` → `messages` / `sessions` | **Hermes 自己存下的完整对话**：user prompt 原文、assistant 原始输出（含 JSON）、每一次 tool call 与结果、session model/provider |
| Hermes 运行日志 | `~/.hermes/logs/agent.log`（覆盖 2026-08-30 → 今） | 每个 turn 的 session/model/provider/platform/prompt 前缀 |
| Workspace | 真实渲染 DOM（headless，隔离端口，未触碰 operator :9222） | 最终展示 |

**方法**：把 snapshot 的每个字段与 Hermes `state.db` 中该 session 的 assistant 消息里 JSON 对象的同名字段做**精确等值**比较。

Step → Hermes session/turn 的关联方式：按时间戳（`step.started_at` vs turn 日志，|Δ| ≤ 150s，Hermes 日志为本地时间 UTC+8）+ replay prompt 标记。关联明细见 `data/audit-20260916-cognition-provenance/step-to-hermes-turn-correlation.json`。

> **方法局限（如实声明）**：关联是**时间邻近推断**，不是持久化的外键。Fabric 侧**没有**保存 `hermes_session_id`（见 §5 发现 D）。因此"snapshot 属于哪个 session"是推断出来的；但"snapshot 的内容确实是某个真实 Hermes turn 产出的"由内容精确等值直接证明，不依赖该推断。

---

## 2. 问题一：过去哪些 cognition acceptance 是 PROVEN_HERMES / UNVERIFIED？

逐 run 判定（完整机器可读账本：`data/audit-20260916-cognition-provenance/provenance-ledger.json`）：

| run | status | snapshots | model | 判定 |
|---|---|---|---|---|
| `105e6f5e` | COMPLETED | 30 | — | **PROVEN_STUB_NOT_HERMES** |
| `990c258b` | COMPLETED | 25 | ark-code-latest | PROVEN_HERMES |
| `98fb54e0` `9bc882e7` `16468bd3` | COMPLETED | 30 / 30 / 30 | ark-code-latest | PROVEN_HERMES |
| `bd669163` | COMPLETED | 12 | grok-4.5 | PROVEN_HERMES |
| `bd4edf24` | PAUSED | 2 | grok-4.5 | PROVEN_HERMES |
| `cb110066` | COMPLETED | 11 | grok-4.5 | PROVEN_HERMES |
| `37e3fbd3` | COMPLETED | 9 | grok-4.5 | PROVEN_HERMES |
| `4dd84996` | COMPLETED | 11 | grok-4.5 | PROVEN_HERMES |
| `0177cbe0` | RUNNING | 2 | grok-4.5 | PROVEN_HERMES |
| `bf740b90` | COMPLETED | 5 | grok-4.5 | PROVEN_HERMES |
| `5babef67` | COMPLETED | 10 | grok-4.5 | PROVEN_HERMES |
| `7d321cc2` | PAUSED | 5 | grok-4.5 | PROVEN_HERMES |
| `9cdb7077` | COMPLETED | 9 | grok-4.5 | PROVEN_HERMES |
| `c7c37f5b` | COMPLETED | 2 | grok-4.5 | PROVEN_HERMES |
| `9a10c8b3` | BLOCKED | 1 | grok-4.5 | PROVEN_HERMES |
| `920332b4` `16220625` | COMPLETED | 9 / 9 | grok-4.5 | PROVEN_HERMES |
| `6a27177c` | RUNNING | 1 | grok-4.5 | PROVEN_HERMES（本次 control run） |
| `5da354de` `9dfa09fe` `e4340d96` `794c1803` `af78534d` `845f85ed` | READY | 0 | — | NO_COGNITION（无认知，无需判定） |

**汇总：243 个 snapshot 中 213 个 PROVEN_HERMES，30 个 PROVEN_STUB_NOT_HERMES，0 个 UNVERIFIED。**

### 逐字段证明结果（18 个真实 run，212 个 snapshot）

| 字段 | 非空数 | 与 Hermes 原始 JSON 精确一致 |
|---|---|---|
| `judgment` | 212 | **212/212** |
| `current_understanding` | 212 | **212/212** |
| `unknowns` | 212 | **212/212** |
| `evidence_gaps` | 85 | **85/85** |
| `stopReason` | 83 | **83/83** |
| `evidenceAcquired` | 212 | **212/212** |
| `business_structure_coverage` / `evidence_resolutions` / `claim_evidence_refs` / `epistemic_layers` / `thresholds` / `confirmed_action` | — | 内容 100% 一致（仅键名 snake_case → camelCase 规范化） |
| `observed_facts` | 212 | 85/212 直接一致；其余 127 见下 |
| `supporting_evidence_refs` | 212 | 85/212 直接一致；其余 127 见下 |

`observed_facts` / `supporting_evidence_refs` 的 127 个"不一致"**不是伪造**：ADR-087（2026-09-14）之前 Hermes 未产出这两个字段，`replay-runner-p0013.ts:422-432` 有显式 fallback 到 `inv.evidenceAcquired`——而 `evidenceAcquired` 本身 **212/212 全部是 Hermes 原文**。即：文字来自 Hermes，但**"把它登记为 Observed Facts"这个语义角色是 Fabric 指定的**，不是模型自己声明的。（Workspace 标签亦如实写明 `snapshot.observed_facts，evidenceAcquired`。）

### 唯一的失败样本：run `105e6f5e`

- 2026-09-03 13:49–13:50，30/30 step COMPLETED，30 个 snapshot，**0 个 Hermes turn**，judgment 全部为 `[HTTP-driven stub] Awaiting LLM kernel wiring in Phase 5.5.`
- 这正是当时 operator 验收抓住、并驱动 BC.2 修复的那个 run。**它没有被任何文档当作"真实认知验收"**，本轮结论与历史记载一致。
- **但它在 DB 中仍是 `COMPLETED`，且会出现在 Workspace 的运行列表里**——operator 现在点进去仍会看到 30 天"COMPLETED"的 stub 认知。见 §5 发现 E。

### Provider / model 可追溯性

| 模型 | replay turn 数 | 时间范围 |
|---|---|---|
| `ark-code-latest` | 224 | 2026-09-03 → 09-12 |
| `grok-4.5` | 121 | 2026-09-13 → 今 |
| `gpt-5.6-sol` | 1 | 2026-09-13 05:03（session `20260913_050346_463d60`，**未产出任何 snapshot**，不影响任何判定） |

- provider 恒为 `custom`；当前 base_url = `https://devapi.dpdns.org/v1`。
- **Fabric 侧不记录 model/provider**。model 只能从 Hermes 日志/state.db 反查。见 §5 发现 D。

---

## 3. 问题二：网页上"复读 / checklist 化"的内容，能否证明就是 Hermes 原始输出？

**能证明。** 证据链完全闭合，且是**内容级**的，不是接线级的。

### 3.1 机制验证（control run，2026-09-07，run `6a27177c`）

```
Fabric prompt (28,205 chars)
  → Hermes session 20260916_070554_0f57b2 (model=grok-4.5, provider=custom)
  → Hermes 最终 assistant 消息 14,059 chars，末尾为 canonical JSON（24 个键）
  → parseInvestigation
  → replay_run_cognitive_snapshots（persisted，6 个核心字段精确等值）
  → GET /api/replay/runs/:id/steps/2026-09-07（API 回读，8/8 字段精确等值）
  → Workspace 渲染 DOM（judgment / currentUnderstanding / unknowns×5 / observed_facts×6 / evidence_gaps×5 / recommendation 文本 全部逐字出现）
```

Workspace 渲染路径 `apps/ecommerce/workspace/views/replay-view.js:1465-1471` 只做 `escHtml(snapshot.<field>)`——**没有改写、没有摘要、没有截断、没有二次 LLM**。

### 3.2 checklist 内容的具体取证

以被 P0013.4 审计点名的 checklist 形态为例（run `5babef67`，Business Date 2026-09-05）：

persisted `judgment`：
> `09-05 业务态=严格高客单（1/1）：n=34、AOV≈282、零低价带、ex-top1 仍高、主售金奖礼盒。… 观察 2/2 并追核销。`

该字符串在 Hermes 自己的 `state.db`（session `20260915_130632_79b07c`）中，**逐字出现在模型 assistant 消息的第 2050 字符偏移处**，且位于该消息 JSON 的 `"judgment":"…"` 字段内部，其前文是模型自己写的 `"impactOnHypothesis":"H3 proposed；不升 L4 因果"`。

> 结论：**复读/checklist 形态是模型自己产出的，不是 Fabric 渲染的产物，更不是 Claude/测试/harness 写的。** P0013.4 的定性（"契约沉默导致模型自建记分卡"）与本次取证一致。

### 3.3 信息不是被"加工"，而是被"丢弃"

唯一的内容偏差是**单调的字段丢弃**，不是改写：

| Hermes 实际产出 | Fabric 持久化 | Workspace 展示 |
|---|---|---|
| `recommendation` 7 个键：`kind` `recommendation` `rationale` **`risks` `prerequisites` `humanNeeded` `expectedOutcome`** | 3 个键：`kind` `recommendation` `rationale` | 仅 `kind` + 文本 |
| `knownEvidence` `hypotheses` `nextQuestion` `requiredEvidence` `investigationRequest` `findings` `capabilityUsed` `prior_cognition` | **不持久化** | 不展示 |

control run 实例：Hermes 给出了 3 条 `humanNeeded`（"确认是否有中秋/教师节礼盒活动、优惠券或付费投放"等）与 3 条 `risks`（"误把千元礼盒脉冲当作全店转化/流量胜利而加投"等），**机器验证 Workspace DOM 中未出现任何一条**。

---

## 4. 问题三：Fabric 实际给 Hermes 的输入 / Hermes 实际返回了什么

### 4.1 Fabric → Hermes（control run，2026-09-07，共 28,205 字符 / 251 行）

章节结构（`## ` 级）：

```
## Runtime Trust Boundary
## Run context
## Current evidence (already observed, business_date <= 2026-09-07)
## Operator enrichments (human-provided, append-only, business_date <= 2026-09-07)
## Evidence Resolution — resolve held evidence BEFORE declaring a gap
### Replay V1 retrieval binding — order evidence
## Prior days' judgments (read-only; do not re-investigate)
## Prior Cognition (Historical, NOT Current — Phase F)
## Epistemic Layers — DO NOT COLLAPSE (Phase B)
## Knowledge ≠ Evidence (Phase D)
## Per-claim provenance (Phase C) + Threshold provenance (Phase E)
## Three concepts — DO NOT CONFLATE
## Output language — Simplified Chinese (zh-CN)
## Cognition continuity — standing understanding, not a scorecard   ← P0013.4 新增
## Analysis Target — explain business state and STRUCTURE, not the curve
### Mandatory business-structure coverage
### Stop-rule decision (binding)
## Investigation Workflow
## Formal output obligations (shared Analysis Contract)
## Output shape (canonical Investigation Contract + Epistemic Layers, no markdown fences, no prose around it)
```

注入的数据量：`Current evidence` 段 **6,577 字符 / 18 个 evidence id**（同窗口修复前的 5babef67 是 3,326 字符 / 9 个 id）。时间上界写在标题里（`business_date <= 2026-09-07`），但真正的边界在 SQL（`visibleEvidenceFor`）。

**与修复前（5babef67）的差异**：新增 `## Cognition continuity` 一节（含 `not a scorecard`、`Silence is the correct form`），prompt 由 21,696 → 28,205 字符。其余章节一一对应，无删减。

### 4.2 Hermes → Fabric（同一次 turn）

- session `20260916_070554_0f57b2`，model `grok-4.5`，provider `custom`，base_url `https://devapi.dpdns.org/v1`
- 17 条消息，**11 次 tool call**；tokens in 71,752 / out 10,484
- 工具调用序列：`skill_view` ×4 → `tool_describe` → `skill_view` → **`mcp__fabric__fabric_replay_retrieve_orders` ×4** → `terminal` → `execute_code`
- 最终 assistant 消息 14,059 字符，末尾为 canonical JSON，24 个键：
  `situationId, currentUnderstanding, knownEvidence, hypotheses, unknowns, nextQuestion, requiredEvidence, investigationRequest, findings, judgment, stopReason, capabilityUsed, evidenceAcquired, recommendation, epistemic_layers, claim_evidence_refs, thresholds, prior_cognition, observed_facts, supporting_evidence_refs, evidence_gaps, business_structure_coverage, evidence_resolutions, confirmed_action`

原始产物已存档（见 §6）。

---

## 5. 附带发现（审计过程中真实观察到，未修复）

| # | 发现 | 证据 | 影响 |
|---|---|---|---|
| **A** | **Fabric 崩溃后 replay run 无恢复路径** | 本次 control run 首次尝试（run `845f85ed`）在 Hermes turn 进行中 dev server 被回收；Hermes 记录 `end_reason=ws_orphan_reap`。此后该 run 恒为 `READY` + `current_business_date=2026-09-07`，但存在一条 `RUNNING` step 行且无 `completed_at`。再点「▶ 下一天」永远返回 `PAUSED / "concurrent advance in flight"`（0.087s 返回，不调 Hermes） | 该 run **永久死锁**，只能靠「↻ 重新回放」另建 run 绕过。P0013.1 的 `acquisition_jobs` 有启动时 orphan → INTERRUPTED 策略，**replay run 没有同等待遇**。属 G1.5 幂等保护的盲区（防并发正确，缺 stale takeover） |
| **B** | **status.json 的 activeModel 已过期** | `context/status.json` 记 `"activeModel": "ark-code-latest"`；`~/.hermes/config.yaml` 现为 `default: grok-4.5`；自 2026-09-13 起 121 个 replay turn 全部跑在 `grok-4.5` 上 | 文档与事实不符（违反 memory `hermes-active-model` 的教训："不复述旧 handoff 的 stale claim"） |
| **C** | **P0013.4 的"门禁"残留在新 run 中复现** | control run `6a27177c` 09-07 recommendation 原文含 `按订单结构门禁阅读下一业务日`（POST-P0013.4 代码） | P0013.4 handoff 把该残留记为"A 的 09-12 一次"，实测**在全新 run 中仍出现**，说明不是个例 |
| **D** | **Fabric 不持久化 Hermes session/turn 身份** | `replay_runs` / `replay_run_cognitive_snapshots` 无 `hermes_session_id` / `model` / `provider` 列（对比 `acquisition_jobs` **有** `hermes_session_id`） | 每次审计都必须反查 Hermes 日志做时间邻近推断；无法用外键证明 run↔session。建议后续票加固 |
| **E** | **stub run `105e6f5e` 仍以 COMPLETED 出现在 Workspace 运行列表** | DB 中 30/30 stub snapshot、status=COMPLETED | operator 点进去会看到 30 天"已完成"的 stub 认知，与真实 run 无法区分 |
| **F** | **Hermes 的 `risks` / `humanNeeded` / `prerequisites` / `expectedOutcome` 被丢弃** | §3.3 | 模型明确提出的风险与人工核验项到不了 operator |
| **G** | **Hermes turn 日志的 business date 被截断** | `agent.log` 的 `msg='…'` 截断到 80 字符，`2026-08-04` 只留 `2026-08-0` | 无法直接从日志按业务日关联，只能靠时间邻近 |

---

## 6. Real Control Run 存档

`data/audit-20260916-cognition-provenance/`：

| 文件 | 内容 |
|---|---|
| `prompt-sent-to-hermes.txt` | Fabric 实际发给 Hermes 的完整业务输入（28,205 字符，逐字） |
| `hermes-raw-messages.json` | 该 session 的全部 17 条消息（user prompt / assistant 原始输出含 JSON / tool 结果原文） |
| `workspace-dom.txt` | Workspace 真实渲染出的 operator 可见文本 |
| `step-to-hermes-turn-correlation.json` | 249 条 step → Hermes turn 的关联明细及时间差 |
| `provenance-ledger.json` | 26 个 run 的逐 run / 逐 snapshot 判定账本 |

Control run 本体：`6a27177c-f16b-4dcf-a45e-2819a9a517c9`（窗口 09-07→09-08，数据集 `jd_acquisition_20260914_0231`，manifest `87613e01…`）。09-07 已完成，09-08 未回放。**保留在 DB 中供复核。**

附带产生的 `845f85ed`（§5-A 的死锁样本）亦保留，作为该缺陷的现场证据。

---

## 7. 本轮未做的事

- 未修改任何 Prompt / Contract / Schema / Knowledge / Replay 代码 / Hermes 配置
- 未修改任何历史 run / snapshot / Evidence / 冻结数据集（`87613e01…` 与 `df8783a7…` 未变）
- 未修复 §5 的任何一项发现——**它们需要独立的任务边界与 operator 决策**
- 未替 Hermes 做任何业务判断，未对认知内容的业务正确性下结论

---

## 8. 三个问题的直接回答

1. **过去哪些 cognition acceptance 是 PROVEN_HERMES / UNVERIFIED？**
   19 个真实 run、213 个 snapshot 全部 **PROVEN_HERMES**（逐字段精确等值，非接线推断）；**0 个 UNVERIFIED**。唯一不来自 Hermes 的是 run `105e6f5e` 的 30 个 snapshot，判定为 **PROVEN_STUB_NOT_HERMES**——它本就是当时验收失败、驱动 BC.2 修复的现场。

2. **网页上"复读 / checklist 化"的内容能否证明就是 Hermes 原始输出？**
   **能。** persisted 字段与 Hermes 自存输出精确等值，Workspace 只做 HTML 转义后原样渲染，链路中无 stub / fixture / harness / Claude 介入。checklist 字样（`严格高客单（1/1）`、`观察 2/2`）逐字出现在模型自己 assistant 消息的 JSON `judgment` 字段内。

3. **Fabric 实际给 Hermes 的输入是什么，Hermes 实际返回了什么？**
   输入：28,205 字符的结构化 prompt（20 个章节，含 P0013.4 新增的 `## Cognition continuity`），其中 `Current evidence` 6,577 字符 / 18 个 evidence id，时间上界由 SQL 强制。返回：单次 turn 14,059 字符，11 次 tool call（含 4 次真实 `fabric_replay_retrieve_orders`），末尾 24 键 canonical JSON。**Fabric 丢弃了其中 8 个键**（含 `risks` / `humanNeeded`），并把 `recommendation` 从 7 键裁剪为 3 键。
