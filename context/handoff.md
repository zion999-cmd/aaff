# Handoff — P0013.5 Domain Exploration Methodology & Contract Boundary（2026-09-22）

> 状态：**IMPLEMENTED + REAL-HERMES VERIFIED**。ADR-095。审计文档在 `artifacts/fabric-prompt-contract-audit/`（含 pass1/pass2）。
> 命名空间说明：Proposal 与 ADR 是两套编号空间；P0013.5 由 ADR-092 / ADR-093 / ADR-095 共同服务。

## 本 session 做了什么

1. **边界收敛**：新增 3 个规范 shared section（`EPISTEMIC_DISCIPLINE_SECTION` / `PROVENANCE_SECTION` / `OUTPUT_CONTRACT_SECTION`），`analysis-contract.ts` 现共 9 个 shared section，两条 prompt 逐字共用 → **共享契约单一来源**（SC3）。
2. **删 Execution HOW**（SC1）：两条 prompt 的固定 9 步 Workflow、Production 的调用预算/重试/预批调用模式、index-first 搜索策略、retrieve→continue 控制流、手工计算/过滤步骤；`exploration-goal.ts` 去强制 Step 顺序与重试预算。
3. **删 prompt debt**（SC4）：Output shape 完整 Schema 复述、重复 obligations、Three Concepts、Production Output Language 逐字段枚举、零 enrichment 时的规则块（改为条件输出）。
4. **机器化边界**（SC1）：新增 `apps/ecommerce/runtime/investigation/prompt-boundary.ts`（10 类 Execution-HOW 形态 + 显式豁免表），由 `tests/contract/prompt-boundary.contract.ts` 双向钉住（无 Execution HOW **且** 方法论未丢）。
5. **真实验收**（SC6/SC7）：见下。

## 体积（零证据基准）

| | before | after | Δ |
|---|---:|---:|---|
| Production investigation | 38,995 B | **26,456 B** | **−32.2%** |
| Replay heavy | 33,299 B | **26,341 B** | **−20.9%** |
| Replay light（未接线） | 4,513 B | 4,513 B | — |

SC1 扫描：Production / Replay / acquisition goal **均 0 个未豁免 Execution HOW 实例**。

## 真实验收证据

- **SC6**：run `85c0bded-fbc2-4b06-83ab-d0dc677c8f07`，session `20260922_062634_85d64e`（**单 session，3 条 user prompt**），09-02/09-03/09-04 连续 COMPLETED；`prior_cognition` 累积；**`proposed→supported`** 与 **`supported→weakened`**（反证推翻前日"礼盒大单可重复"判断）；**No-Future 0 违规**。
- **SC7**：situation `sit_7fa8662b02f1421ebe0f`，真实 Production turn 完成：`capabilityUsed` 真实、`business_questions[1]`、`evidence_requirements[1]`（含 `temporal_grain`）、五维 coverage（1 covered/4 gap）、`evidence_resolutions[6]`、`recommendation.kind=act`、`recommendation_executed=false`。
- **SC7 抓到的自我回归**：第一版 output contract 用代码围栏包 JSON 骨架而同段禁止 markdown 围栏 → 第一次 Production turn 输出 Python 单引号 dict 解析失败。去围栏后通过。**该缺陷只有真实 Production cognition 能暴露。**

## 测试

- 新增 `tests/contract/prompt-boundary.contract.ts`（7）。
- 改动既有断言 **26 处**：全部**重新指向新 canonical 位置**，未削弱语义（S0002 §15）。其中 3 处按真实行为更正 —— `confirmed→supported` 早已在 2026-09-06 从 normalizer 删除，旧 prompt 里那条属**陈旧指引**，删除即修正。
- **表述必须精确**：**P0013.5 scoped tests pass**；**full suite 有 7 个已证明的 pre-existing failures** —— 不得写成「全量 suite 通过」。数字为 1850 passed / 7 failed / 6 skipped。7 个失败与 P0013.5 无关，已逐一证实既存：clear-block-dispatcher（Sep-7 app.js 债务）、gettrend-provider-watermark（Sep-7 cdp-client 债务）、evidence-store-history（HEAD 即失败）、chat.contract（需 live MCP）、fabric-mcp-browser-tools（并行 flake，隔离下通过）、runtime-loop（既存，2 项）。

## 三条残留风险（operator 复核后保留）

1. **`prompt-boundary.ts` 是静态模式扫描器，不是职责边界本身。** 它挡已知形态，挡不住换措辞重写 execution control；authority 仍是 ADR/Proposal + review。
2. **`finalizePrompt`（`situation-chat.ts:817-831`）是最值得挂账的 Runtime 边界债务** —— `model output → Fabric 判断 → Fabric 改变下一次 prompt → 再执行`。只有一次分支，故意未处理；**继续增加就会长成 Fabric planner，必须保持醒目标记**。
3. **测试表述**：写「P0013.5 scoped tests pass；full suite 有 7 个已证明的 pre-existing failures」，不要写「全量通过」。

## 风险与未做

- **未接线 Light**；未新增/补齐任何业务数据；未改 Hermes / Skill / Memory；未新增 fabric 侧 loop/branching/retry/orchestrator；未修 `parentOrdersByDay` MCP 接线；未处理 Evidence acquisition 五类欠账。
- **`finalizePrompt`（`situation-chat.ts:817-831`）保持原样**：它是 Fabric 侧唯一「依据中间结果分支」之处，已记录为 Runtime-boundary debt；本阶段只保证不扩张。
- **`## Output contract` 仍是最大单块（~3.7 KB）**：字段骨架 + canonical 枚举，保留理由是模型无法自行推断字段名与词表；若后续要再降，需要把 schema 通过 Hermes skill 侧提供（本轮 NOT Included）。
- 工作树仍有大量**未提交**改动（本 session 的 P0013.5 改动 + 之前的 light/audit 改动 + Sep-7 存量）。**未提交任何实现**。

## 建议下一步

1. 决定是否提交：建议把 P0013.5 实现单独 commit，与 light-prompt / audit-only 改动分开。
2. `finalizePrompt` 的 Runtime-boundary debt 值得独立 Proposal。
3. Evidence acquisition 五类欠账（DATA ABSENT / WRONG GRAIN / NOT EXPOSED / BROKEN / PROMPT framing）继续留待独立阶段。
