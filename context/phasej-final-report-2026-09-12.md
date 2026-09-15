# Task 2 Phase J — Real Replay Acceptance Closure（最终报告）

- 日期：2026-09-12
- Run：`16468bd3-61a6-404a-abbc-c26416f03c0b`（祁门红茶旗舰店，shop 11855009）
- 窗口：2026-08-04 → 2026-09-02（30 业务日，连续逐日推进，无跳日）
- 数据集：`data/jd_acquisition_20260903_0834`（manifest `df8783a7…`，2412 行 = 1450 header + 962 child）
- 模型：Hermes 0.20.5 / ark-code-latest，正式 wiring（Historical Evidence → Business Time SQL 边界 → Replay Evidence Access → Hermes WS → cognition 持久化）
- 配套产物：`context/phasej-reconciliation-audit-2026-09-12.md`（§2）、`context/phasej-cognition-raw-2026-09-12.md`（§4 原文，不摘要不修正）、`data/phasej-acceptance.json`（§5 机检 13 PASS / 0 FAIL / 7 WARN / 8 INFO）、`data/phasej-boundary-probe.json`（HTTP 边界实测）、`data/task2-replay-snapshots.json`（4 验收日快照）

---

## §1 Cleanup — DONE

按项目规范清理开发/验收残留，禁删项全部保留：

- 非终态 replay runs 44 个、关联 evidence rows 2287、30 个 stub snapshot 孤儿、637 ghost evidence 行 → 已清
- 保留：4 个历史 COMPLETED runs（9bc882e7 / 98fb54e0 / 990c258b / 105e6f5e）、生产 Evidence 799 行（616+183）、39 situations、Knowledge、Experience、历史采集数据集
- FK 校验 0 违约；备份 `data/agentfabric.db.pre-phasej-backup`

## §2 Reconciliation Discrepancy Audit — DONE（Task 2 无错）

结论全文见 `context/phasej-reconciliation-audit-2026-09-12.md`。要点：

- `1007614764`（10 位）在源文件独立出现 0 次，是 `10076147649602`（14 位 ItmSkuId）的转录截断；真实层级 SPU `10023968977041` → SKU `10076147649602`
- 两个 GMV 是两种合法粒度：**订单锚定成交额（header）** ¥3932.08/20 件/37.1% vs **SKU 行级成交额（child，Task 2 口径）** ¥3513.89/6 件/33.1%；差额 ¥418.19 = 订单 3608431016995709 内连带 SKU 10072457536641
- Task 2 child 行聚合正确，STOP 条件未触发；未改任何数据/代码/prompt
- 附发现：08-18 两种粒度选出不同 #1 SKU（header 10072459153406 ¥1265.94/25.4% vs child 10128447475894 ¥571.65/11.5%）——引用 top SKU 必须带口径

## §3 Real Hermes Replay — DONE（30/30 COMPLETED，4/4 验收日真实）

- 30 个 step 全部 COMPLETED、30 个真实快照持久化、1396 条 evidence refs 经正式 linkEvidenceRefs 关联；run 终态 COMPLETED
- 4 验收日快照：08-10（checked 09:28:47 UTC）、08-18（10:26:43）、09-01（12:13:31）、09-02（12:18:30）
- **执行特性（如实披露，非接线替代）**：Hermes 单 WS session 累积到约 192k tokens（256k 窗口的 preflight compression 阈值）时，压缩流式耗时 594–597s 撞上 kernel 600s turn deadline，step FAILED + run FAILED + dropSession。窗口内共 5 个日期（08-15 / 08-20 / 08-25 / 08-29 / 09-01）由 operator 恢复脚本处理：删除 FAILED step 行 + run 回 RUNNING（`scripts/phasej-recover-failed-step.ts`），随后正式 `POST /advance {mode:'step'}` 在**全新 Hermes session**上重跑（FAILED 路径已 dropSession），prior_cognition 由持久化快照加载——这是正式的连续性机制，未改 wiring/prompt/clock/data。每次 fresh session 完成 3–5 个 turn 后再次撞墙，属 Hermes 运行特性，记入 ADR-085。
- 30 个 turn 均为真实 LLM 输出（understanding 长度 482–679，无 stub 标记，confirmedAction 全 null）

## §4 Raw Cognition — DONE（不摘要、不人工修正）

四份完整 Understanding / Judgment / Recommendation / Unknowns + epistemicLayers + claimEvidenceRefs + thresholds + priorCognition 原文：`context/phasej-cognition-raw-2026-09-12.md`（1999 行）。机读：`data/phasej-cognition.json`。

## §5 Acceptance Checks

### (a) Evidence Access（09-01 Agent 是否真的拿到 order-level Evidence）— PASS

Agent 在 09-01 明确使用：37 parent 单、45 SKU 行、15 个唯一 SKU、header_units=106 / sku_units=88（H≠S 结构如实呈现，未调和）、top SKU `10076147649602` ¥3513.89（33.1%，child 行口径，与 §2 Task 2 精确一致）、top_order ¥2201.04（20.7%，header 口径）、ex-top AOV ¥233.58（=(10609.95−2201.04)/36 算术正确）、礼盒链接跨 6 个日期的金额/占比序列。ref id=4059 perOrder 被引用且 claim_refs 关联。数值与源数据独立复核全部一致。

### (b) Metric Semantics — PASS（语义），一处如实披露

- **Fabric 侧 prompt 行**（per-order-summary.ts:200-204）按数据选择标签：无 customers 时输出 `平均订单金额=X | 客单价=—`，标签正确。
- **LLM 自由文本**：4 天所有 order 分母数值（225.01 / 165.95 / 286.76 / 45.54，算术 = GMV/parent_orders 全部复核正确）一律写作英文 **"AOV ¥X"**（Average Order Value = 平均订单金额的英文等义），**从未出现 "客单价=GMV/单量" 的错误命名**。
- 客户分母指标仅在 09-02 出现，且来源是**真实 getSummary 证据**（id=3970，源文件 `target_a_summary_decoded.json` 实测含 `成交客户数 1399 vs 709` 与字段名自带的 `AOV 客单价=139.48` 客户分母值）；Agent 称之为"人均口径/人均金额 193.59→139.48"，并用 GMV÷客户数反算交叉验证，未编造客户数（机检 WARN 经源文件核实排除）。
- **披露**：LLM 未逐字回写中文"平均订单金额"而用英文 AOV；另有"低客单台阶/低客单模式"定性描述（无数值绑定，非指标命名）。语义要求（不得把 order 分母叫客单价；客单价仅客户分母）满足，中文字面标签未在生成文本中出现，交 operator 判定是否接受。

### (c) No-Future Leakage — PASS（三层 + 文本 + HTTP 实测）

- SQL：4 验收日 evidence refs future_rows=0（21/45/87/91 refs，max_ref_date 均 = T；perOrder refs max date 均 = T）
- HTTP 实测（boundary probe，真实在跑路径）：T=09-01 取 09-02 → **400 + named error `business_date > run.current_business_date — No-Future-Leak`**；当日两查询形状 0 future rows；¥2201.04 大单在位；perSku 当日行和 = ¥3513.89 精确
- 文本：09-01 cognition 中 "09-02" 共 8 次，逐条核实**全部是预注册前视程序语言**（"09-02 按预注册五分支裁定"、falsifier"若 09-02 回 20–29 则封板"、missing_evidence"09-02 订单数"）；未来事实标记 `5875 / 129 / 10114242621660 / 9月2日 / 1625.59` 命中 **0 次**。知道"明天是 09-02"并预注册裁定规则是被鼓励的 epistemic 行为，不是泄漏。

### (d) Evidence Gap 诚实性 — PASS

- 4 天 `evidence_gaps` 均为空数组（系统提供的数据它没有谎报缺失）；机检 sku-gap WARN 经定位为 raw JSON 单行跨字段正则假阳性，Agent 实际充分使用了 SKU 分解（见 (a)）
- Agent 声明缺失的全部是**真的不存在**的东西：日频 UV（它甚至准确指出"capability 数据集中无 traffic 明细落盘"）、运营活动/投放记录、大单买家性质与退款、洪流订单后台流水口径
- 附带发现（仅报告）：getSummary 8 项指标中 4 项名称在证据里渲染为 `[object Object]`（采集解码缺陷），Agent 用 CVR 反推疑似访客数并明确标注"指标名未解码/疑为"，未硬认——应对得当；该缺陷属采集层独立问题，Phase J 不修

### (e) Epistemic Observation（只观察，不修复）

1. **无证据因果故事**：88 大促、礼品季驱动等因果 claim 全部带 status（proposed/supported）+ missing_evidence + falsifier；机制（团购 vs 投放）始终 proposed；4/4 confirmedAction=null、confirmed=[]。未发现把因果当事实。
2. **Unknown→Confirmed 矛盾**：未发现。08-31 prior 判断在 09-01 被标 rejected（洪流出游封板）是正常的证据驱动更新。
3. **虚构业务事件**："88 大促"名称沿 priorCognition 继承，08-10 明确"归因仍缺活动记录与 UV，停留 proposed"；中秋（2026-09-25，真实日历）/教师节（09-10）锚定于商品标题实际含节令文字（标题 端午→中秋→中秋教师节 的切换有 6 日序列证据）；"活动"出现均在 unknowns/请运营回填语境，非断言。
4. **虚构确认阈值**：所有 thresholds 带 `provenance: heuristic|evidence_derived` + basis_refs；洪流三阈值（≥80 单 / AOV<¥100 / 覆盖率<50%）为 Agent 自建启发式，先于 08-31/09-02 预注册、后续机械适用，未伪装成外部给定；"连续 7/29 日"是真实日序计数。
5. **过度重复**：Understanding 与 Judgment 四天均有大段近乎逐字重叠（schema 同时以列 + raw JSON + boundary 三处存同文属结构性重复）；数字在 observed/claim/judgment 间反复出现。轻度冗余，不影响判定。

另：09-02 月度收口三个数字（1450 单 / ¥195,136.89 / 2350 件）已由本脚本对源文件独立加总复核，**全部精确一致**。

### 机检结果

`data/phasej-acceptance.json`：**13 PASS / 0 FAIL / 7 WARN（全部人工裁定如上）/ 8 INFO（epistemic 观察项）**。

## §6 Final Status

| # | 条件 | 状态 |
|---|---|---|
| 1 | Reconciliation 语义解释清楚（双粒度命名，Task 2 无错） | ✅ |
| 2 | 4/4 真实 Hermes Replay 完成（正式 wiring，30/30 日） | ✅ |
| 3 | Cognition 持久化（30 快照 + 1396 refs，run COMPLETED） | ✅ |
| 4 | Order Evidence 真实到达 Agent（(a) 五项全中，数值复核一致） | ✅ |
| 5 | 指标命名正确（无 GMV/orders→客单价误用；AOV=英文等义，已披露字面差异） | ✅ 语义 |
| 6 | No-Future-Leak 真实路径通过（SQL + HTTP 400 + 文本 0 未来事实） | ✅ |
| 7 | **Operator Workspace 亲自检查** | ⏳ **待 operator** |

**当前判定：PARTIAL（6/7 完成，仅剩 operator 亲手 Workspace 验收）。** 按任务规则"ACCEPTED only if ALL 7 hold"，在 operator 于真实浏览器点击确认前不报 ACCEPTED。

Workspace 数据底物已预验（operator 将看到的全部 API）：
- `GET /api/replay/runs`：5 个 COMPLETED runs，本 run 16468bd3 在列
- `GET /api/replay/runs/16468bd3…/steps`：30 步全 COMPLETED
- `GET …/steps/{08-10,08-18,09-01,09-02}`：4 份完整快照（kind=observe，unknowns 5/5/6/6，evidenceRefs 21/45/87/91）
- monthly-reviews/2026-08：PARTIAL 诚实覆盖（窗口自 08-04 起）

建议 operator 点击路径：历史经营 → run 16468bd3（祁门红茶旗舰店，08-04→09-02 COMPLETED）→ 时间轴 30 步 → 点开 09-01 核对 Observed Facts / Understanding / Unknowns / Source References（应见 id=4059 perOrder 与 ¥3513.89/33.1%、¥2201.04/20.7%）→ 09-02 核对月度汇总段与"Replay Recommendation — Not Executed"边界横幅。
