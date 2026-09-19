# P0013 Hermes Cognition Contamination — Isolation + Control Experiment (2026-09-20)

**目的**: 隔离已确认会被 fresh Replay session 继承的 Hermes Memory/Skill 污染，然后在**其余变量不变**的条件下重跑 09-02→09-12，观察当前 Cognition Contract 本身的真实表现。
**Claude 不对经营分析质量下结论**；本文件只报告可测量的事实。

---

## 1. 隔离内容（含原路径 / hash / mtime）

备份位置（**repo 之外**，未提交）：`~/.hermes/_p0013-contamination-backup-20260920/`

| 原路径 | sha256(前16) | mtime | 处理 |
|---|---|---|---|
| `~/.hermes/memories/MEMORY.md` | `2e7b83534ecbba42` | 2026-09-16 03:20 | 仅**删除 P0013 条目**（其余 8 条保留）2173→1976 字符 |
| `~/.hermes/skills/investigation-contract-output/SKILL.md` | `50972bc72fc8df1d` | 2026-09-16 08:22 | 删除 `## Historical Cognitive Replay Mode (P0013-style)` **整节 61 行** + 4 条 P0013 引用索引（223→159 行）；Contract Shape / Rules / Stop Reason 等通用内容保留 |
| `.../references/p0013-order-structure-states.md` | `f48fd6678aed8c63` | 2026-09-16 08:22 | **移出** skills 树 |
| `.../references/historical-cognitive-replay-mode.md` | `7ffcd3168f3fba92` | 2026-09-16 06:20 | 移出 |
| `.../references/case-log-p0013-replay-intermediate-state-0911-0912.md` | `12d8a12554afe408` | 2026-09-16 06:20 | 移出 |
| `.../references/case-log-p0013-replay-two-state-switching.md` | `305c8aaf7568ef37` | 2026-09-15 03:19 | 移出 |
| `.../references/case-log-p0013-replay-campaign-reversal-0815-0817.md` | `709895cbeeede0af` | 2026-09-07 07:48 | 移出 |
| `~/.hermes/skills/uv-cvr-noise-rule/`（整目录 9 文件） | `dcec59ed2693f507`(SKILL.md) | 2026-09-04 03:02 | 整目录移出（固定门禁矩阵） |

**未动**：`business-anomaly-investigation/references/aov-collapse-pattern.md` 与 `case-log-sit_7ea3efe6…-8th-pass.md` —— 复核后确认其中的「高客单」只是普通业务名词（"高客单 SKU"/"高客单组合优惠"），**不含 P0013 状态链或 numeric gates**，不属同类污染，保持原样。

**未修改**：agentFabric code / Prompt / Contract / Knowledge / Hermes 源码 / 模型 / provider。learning·memory 机制保持开启。

---

## 2. §3 fresh session 环境静态验证

- `~/.hermes/skills/` 全树模式扫描：仅剩上述 2 个生产期文件（非同类污染）
- `~/.hermes/memories/MEMORY.md`：P0013 命中 **0**
- 删除陈旧 `.skills_prompt_snapshot.json` 并以 `hermes serve` 冷启动重建 → **新快照（06:38, 87,772B）中 `uv-cvr-noise-rule` = 0 次、`p0013-order-structure-states` = 0 次**
- 机制保持：`memory_enabled: true`、skills manifest 仍正常注入（45 个 skill 目录）；**未关闭任何 learning/memory 功能**

> 说明：Hermes 的 in-process skills 缓存只由 skill-manager 工具/CLI 失效，不响应外部文件变更，因此必须重启 `hermes serve`（原进程已运行 5 天）。

---

## 3. 控制实验设置（三组）

| | BEFORE | REFERENCE | AFTER |
|---|---|---|---|
| run | `993070af` | `6bcfbaf5` | `0e86bec5` |
| session | `20260916_104130_14875b` | `20260916_125837_59dc53` | `20260920_063805_a9733d` |
| 窗口 | 09-02→09-12 (11d) | 09-02→09-03 (2d) | 09-02→09-12 (11d) |
| Enrichment | 09-04 + 09-10 | **无** | 09-04 + 09-10 |
| agentFabric code | `8248556`（Evidence Universe **前**） | `504b5f8`（= 当前） | `504b5f8`（= 当前） |
| 污染 | 存在 | 存在 | **已隔离** |
| 完成度 | 11/11 COMPLETED | 2/2 COMPLETED | **11/11 COMPLETED** |

REFERENCE 存在的意义：它是**与 AFTER 同代码**、仅污染状态不同的对照（代价是只 2 天且无 enrichment），用来排除"差异来自 504b5f8 代码改动"。

---

## 4. §5 对照结果

### 4.1 固定状态链词频（原始 Hermes 输出全文）

| 词 | BEFORE (14 outputs) | REFERENCE (2 outputs) | AFTER (14 outputs) |
|---|---|---|---|
| 托量 | **218**（14/14 天） | **87**（2/2 天） | **0** |
| 中间态 | **149**（14/14） | **6**（2/2） | **0** |
| 严格高客单 | **117**（12/14） | 0 | **0** |
| 软化 | **127**（11/14） | 0 | **1**（1 天） |
| 脉冲 | 369（14/14） | 50（2/2） | 55（13/14） |
| 高客单 | 315（14/14） | 12（2/2） | 30（10/14） |

**结论**：`托量 / 中间态 / 严格高客单 / 软化` 这一**固化状态链在 AFTER 中消失**（0 / 0 / 0 / 1），而 REFERENCE 在同样 2 天里就出现 托量 87、中间态 6 —— 同代码下差异明确。
`脉冲`、`高客单` 仍出现，但逐条抽检 AFTER 上下文是**普通业务名词**（"礼盒大单脉冲消失"、"礼盒 1000+ 是否为脉冲"、"高客单 SKU"），**不是带 gate 的状态标签**。

### 4.2 numeric gates / 四分支 / 命中计分

| 指标 | BEFORE | REFERENCE | AFTER |
|---|---|---|---|
| 门禁 | 29（11/14 天） | 0 | 5（2/14） |
| 四分支 | **6**（4/14） | 0 | **0** |
| 分支 | 9（5/14） | 0 | 2（1/14） |
| 升稳态 | 10（6/14） | — | 1（1/14） |
| 命中 / 未命中 | 0 / 0 | — | 4 / 1 |

**必须更正一个我自己的测量错误**：我原打算用正则 `\b\d+/\d+\b` 统计"N/N 计分"，实测发现命中的全是**日期对（05/06、08/09）、证据 id 对（5843/5855、6128/6140）与数值比（50/1000、95/129）**，**不是计分**。该项**不可作为指标**，已剔除，不据它下任何结论。

AFTER 中 `命中` 的 4 次抽检：1 次是模型**引用契约的禁止条款原文**（"per-day hit/miss tallies (\"①命中 ②未命中\"…)"），3 次是普通业务表述（"是否命中 3200/礼盒单"）。**不构成四分支/命中计分模式**。

### 4.3 Unknown / Evidence Gap 是否机械重复

相邻业务日集合的 Jaccard 相似度均值：

| | BEFORE | AFTER |
|---|---|---|
| unknowns | 0.21 | **0.06** |
| evidence_gaps | 0.43 | 0.37 |
| distinct unknowns tuples | 11 / 11 天 | 11 / 11 天 |
| distinct evidence_gaps tuples | 10 / 11 天 | 11 / 11 天 |

**AFTER 的重复度低于 BEFORE**，未见机械复读加剧。

### 4.4 Recommendation kind 分布

| | BEFORE | AFTER |
|---|---|---|
| observe | **11 / 11** | **11 / 11** |

两组都是全 observe。**这项没有变化** —— 如实报告，不作解释性推断。

### 4.5 实际加载的 Skills

| | BEFORE | AFTER |
|---|---|---|
| skill_view 次数 | 3 skills / 7 次 | 2 skills / 4 次 |
| 具体 | `investigation-contract-output`、`fabric-anomaly-investigation`、`business-anomaly-investigation` | `investigation-contract-output`、`fabric-anomaly-investigation` |
| **references 加载** | **`references/p0013-order-structure-states.md` ×1** | **NONE** |
| `uv-cvr-noise-rule` | 未在本 run 加载（历史 34 次） | 已隔离，无法加载 |

### 4.6 Knowledge retrieval

| | BEFORE | AFTER |
|---|---|---|
| 读到的知识页 | 5：`INDEX` / `operations/INDEX` / `product/INDEX` / `true-vs-false-anomaly` / `atp-drop-diagnosis` | 3：`INDEX` / `operations/INDEX` / `true-vs-false-anomaly` |

两侧都做了 INDEX-first 导航；AFTER 读得更少（未读 product 分支），符合"按需、不 bulk"。

### 4.7 No-Future

| | BEFORE | AFTER |
|---|---|---|
| violations | **0** | **0** |

### 4.8 Provenance

两侧均为真实 Hermes（`grok-4.5` / provider `custom` @ `ws://localhost:9120/api/ws`），raw assistant 输出直接取自 `~/.hermes/state.db`；未使用 mock/stub。artifact 数据可由上述 session id 独立复核。

---

## 5. 运行期事件（如实记录，非本任务设计的一部分）

隔离要求重启 `hermes serve`（进程内 skills 缓存不响应外部文件变更）。原 serve 是 operator 手工带 `HERMES_DASHBOARD_SESSION_TOKEN` 启动；我的首次重启未带该变量 → Fabric 连不上（`Hermes Session Runtime unavailable … loopback mode still requires ?token=`）。按 Fabric 错误信息给出的官方路径恢复：**两端显式导出同一 token**。

- 新 token 存于 `~/.hermes/.p0013-experiment-session-token`（0600，未打印、未提交）
- `hermes serve` 与 fabric dev server 均以该文件为 env source 重启
- **影响**：原 token 已随旧进程消失；若 operator 有其他客户端持有旧 token，需改用该文件或换回自己的启动方式。如需回退，删除该文件并按原方式重启即可。

---

## 6. 未做（NOT Included）

未设计 Skill Governance、未实现 Skill Candidate/Promotion、未做 Evidence Requirement/Sufficiency、未补采 UV/CVR、未改 Knowledge、未为改善结果调整 Prompt、未修其他 P0013 debt/UI、Claude 未代替 Hermes 做业务分析。
