# 路线图

## Phase 1: 基础框架 ✅
- [x] 项目脚手架 + 共享 schemas + utils
- [x] SQLite 基础设施 (connection, schema v2, init, seed)
- [x] Hermes 客户端 seam (subprocess + stub)

## Phase 2: Business Capabilities ✅
- [x] **Metrics** — calculators, pipeline, weights, repository, façade
- [x] **Decision** — 3 profiles, scoring, explainability, memory-adjustment
- [x] **Explainability** — trust score, contradictions, builder
- [x] **Experience** — weight/decay, extraction (8 pattern rules), repository
- [x] **Review** — 10-category taxonomy, queue, feedback, knowledge promotion

## Phase 3: Connectors + Workspace ✅
- [x] **Connectors** — JD/Tmall normalizer, registry, auth, adapters
- [x] **Workspace UI** — V2 nav, Discover/Memory/Reviews/Products/Settings, Evidence Hub
- [x] **Platform** — Express 5 routes, CLI, data migration

## Phase 4: 架构重构 ✅
- [x] `src/` 删除 → apps/platform/shared 三层
- [x] 命名改为业务语言 (signal→metrics, ranking→decision, trace→explainability, memory→experience)
- [x] Path aliases (`#shared/`, `#platform/`, `#app/`)
- [x] Project Memory 系统 (context files)

## Phase 5: HermesAgent + Workspace Integration ✅
- [x] **Skills** — 5 business skills (collect_data, analyze_ranking, query_signals, query_evidence, general_question)
- [x] **Chat Endpoint** — 自然语言 → 意图分类 → Kernel → 响应
- [x] **Runtime HTTP API** — Kernel 通过 HTTP 可访问
- [x] **Workspace Runtime View** — 执行历史 + 详情 + Chat 接入

## Phase 6: Context Engine 🔜
- [ ] **Business Context** — 一等公民 (campaign, business objectives, seasonality, constraints, competitor snapshot)
- [ ] 每次 Decision 前自动 Load Business Context

## P0008 系列: World Model + Instruction Architecture 🔜
- [x] P0008.1 World Model Gap Map (6 Objects + Assertion Graph)
- [x] P0008.2 World Model Contract (epistemic ≠ temporal, CapabilityBinding relationship)
- [x] P0008.3 Agent Workspace & Hermes Session Integration
- [x] P0008.4 Shared Knowledge Layer + AGENTS.md (Fabric Agent Workspace Contract)
- [x] P0008.5 Minimal World + Knowledge Bootstrap E2E (Knowledge PASS, World consumption FAIL → gap 收敛为 "缺 Instruction Architecture")
- [x] **P0008.6 Instruction Architecture Audit** (Claudian archaeology + 5-layer Instruction Layers + ownership + classification)
- [ ] P0008.6 Proposal (若 Review 通过): routing/epistemic 规则落盘 + topology 对齐 + known-fact probe 复验

## P0009 系列: Real Product Vertical Slice ✅
- [x] P0009 Real Product Vertical Slice — Product Surface / Hermes Session / Fabric Workspace / Capability Runtime / JD Acquisition / Evidence 六面接线 + startup backfill
- [x] **P0009.1 Situation Producer / 今日工作** — deterministic detection (meaningful_change/ranking_attention/cross_signal) + idempotent dedup + 复用 P0007 persistence；真实 grounded Situation 落「今日工作」
- [ ] P0009 Final Browser Acceptance — Workspace 浏览器端到端验收（待模型稳定性）

## P0010 系列: Knowledge-Guided Investigation + Continuous Business Runtime
- [x] P0010 Knowledge-Guided Investigation (Slice 0+1, 2+3, 4, 5 Recommendation-feedback) — Investigation Contract schema + runInvestigationTurn + Workspace Investigation surface
- [x] P0010.1 Final Repair (ADR-047..055) — 8 区诚实收尾: 实体解析 / 时间轴 / 4 canonical human kind / needs_human 语义 / Archive legacy badge / Output 候选下架 / Final outcome audit / Trust reference audit
- [x] P0010.2 Continuous Business Runtime (ADR-056) — RuntimeLoop 60s tick + per-tick mutex + InvestigationPolicy contentHash compare + materializeWorkItem 幂等
- [x] P0010.2.1 contentHash sidecar fix (ADR-057) — InvestigationSchema evidenceContentHash field + markInvestigation 接受 hash + fail-CLOSED on legacy
- [x] P0010.2.2 Investigation Recovery / Self-Healing Runtime (ADR-058) — listRecoverableCandidates 每 tick 扫 open/partial (3 kind: no_investigation / failed_retryable / interrupted) + InvestigationPolicy +4 reasons (3 recovery_* + blocked_runtime_failure) + consecutiveFailures counter sidecar (P0010.2.1 模式) + POST /clear-block + LoopEvent investigation_blocked + Workspace UI 4 状态矩阵 (立即调查按钮默认隐藏). 单 invariant: 进程重启不能把 situation 永久留在 pending 状态. live 2-cycle log 验收: 2 天 stuck investigating 自动 resume / 3 连失败后 blocked 不再第 4 次 / clear-block 单独 resume. 边界: 不做 Action Engine/Approval/Event Bus/新 lifecycle/第二 recovery 逻辑. 46 net new tests, 884 passed / 2 pre-existing flaky, typecheck 0 new errors.
- [x] P0010.2.3 Post-P0010.2 Regression Audit + Repair (ADR-059) — 10 capability (A-J) audit. 6 REPAIR'd to PASS: A bootstrap BEFORE startServer + initDatabase (kills fresh-DB + first-request race); D countBlockedSituations + LoopState.blockedCount + /api/runtime/loop returns it + loadLoopStatus() in Workspace Runtime view + loopBlockedBadge; F deriveCapabilityBoundary drops dead fuzzy text match → uses inv.needsHuman; G stop-reason event carries ≈ annotation + 时间未记录 fallback; J REMOVE CANDIDATE JSDoc on 5 dead exports. 1 DEFERRED (B evidence_id/knowledge_id P0010.3 SB-1/SB-2). 1 LEGACY (E SubprocessHermesClient rankProductsComposition). 16 net new tests, 898/902 (4 pre-existing flaky), typecheck 0 new errors. 6 live verification cases: 1 Continuous PASS / 2 Restart PASS (P0010.2.2 log) / 3 Human Feedback PROVEN-BY-TEST (hermes auth broken) / 4 Output PASS (live out_3a43d1053b9bfa2d) / 5 Entity PROVEN-BY-TEST + PARTIAL LIVE / 6 Archive PASS. STOP.
- [x] P0010.2.11 trade.overview Direct-Fetch 采集 (ADR-072, commit a989b50) — lazyLoad 可见性守卫根因确诊 (module 6611 `zN` 读未注册 `window[Symbol('lazyLoad')]`, 后台 tab 连页面 boot fetch 都不触发 = "数据时有时无"历史怪症根源); acquireJdTradeOverviewViaCDP 弃用 UI 交互/listener 路径, 改页面内 webpack hijack + 页面自己的签名 ajax (module 99859 Fe) + 页面自己的参数机 (4461 SzDPParams + 22886 M), 零伪造头; realtime getSummary (当天 + ##compareValue 昨日基线) + offline getTrend (昨天 item 构造, 近7天 daily categories); offline getSummary 有意不采 (毒化 business_date 语义). 真实页面对账 4 项 0.00% (8/28: ¥12,805.54/1,099/12.01%/132), 8/27 点与 P0010.2.9 对账值复现. 全 suite 1230 passed / 2 pre-existing failed. P0010.2.7~2.10 (C1.1~C1.7, ADR-066~071) 已在此前 commit 落地.
- [x] P0010.2.11 C2.0 trade.overview business-date fail-closed guard (ADR-073) — resolveTradeOverviewBusinessDate 在 acquire 任何 CDP 动作前拒绝非今天日期; 堵死 realtime payload 盖历史 business_date 的污染路径 (8/22/27/28_getSummary 真实事故); CLI snapshot walker 不受影响
- [x] **P0013.5 Domain Exploration Methodology & Contract Boundary** — 实现 + 真实 Hermes 验收（ADR-095）。9 个 shared section 单一来源；删除 Execution HOW 与 prompt debt；Production −32.2%、Replay −20.9%；SC1 扫描器 0 未豁免实例；SC6 单 session 连续 3 天认知（含 `supported→weakened` 反证推翻）；SC7 真实 Production investigation 完整通过
- [ ] **P0013.5 收尾（待 operator 决策）** — 是否提交实现（建议与 light-prompt / audit 改动分开 commit）；`## Output contract` 仍是最大单块（~3.7 KB），若要再降需把 schema 经 Hermes skill 侧提供
- [ ] **`finalizePrompt` Runtime-boundary debt** — `situation-chat.ts:817-831` 是 Fabric 侧唯一「依据中间结果分支」处；本阶段只保证不扩张，需独立 Proposal 决定去留
- [x] **P0013.4 Question-Driven Investigation & Evidence Sufficiency** — 实现完成（ADR-094，`evidence-grain.ts` + `evidence-sufficiency.ts` + 共享 `EVIDENCE_SUFFICIENCY_SECTION` + `business_questions[]`/`evidence_requirements[]`）。**验收 BLOCKED**：① provider 403 额度耗尽；② Hermes learning loop 在本次运行中重新生成 P0013 case-log 污染（`investigation-contract-output` skill，2026-09-20 17:04）。真 Hermes 证据：run `da2fc53a` 09-03 产出完整问题驱动链条；未完成 11 天窗口 clean Replay。详见 `context/p0013-4-acceptance-2026-09-20.md`
- [ ] **P0013.4 收尾（待 operator 决策）** — 恢复 provider 额度 → 处理重新生成的 Hermes skill 产物（不处理则新 run 继承 `da2fc53a` case log，非干净证据）→ 跑完整 11 天窗口 → 与「observe 11/11」基线对比 → SC10 业务问题质量由 operator 判定
- [ ] **Hermes learning-loop 污染持久性问题** — 本次实验证明污染隔离**不具持久性**（同一会话内 learning loop 重建等价 case-log 与 SKILL.md 段）。需要一个可持续机制（curator 范围 / skill 命名空间 / 只读挂载），属 Design/Planning 议题，非本阶段实现
- [ ] P0010.2.12 — closure roadmap 下一项 (见 proposals P0010 closure 清单)
- [ ] traffic.overview 采集 — acquireJdTrafficOverviewViaCDP 不存在前 scheduler 不得重启用 traffic 分支 (按 ADR-072 同模式 direct fetch)
- [ ] E2E 验收 + workspace acceptance + P0010 freeze — closure roadmap 收尾 3 项
- [ ] P0010.3 终态 Lifecycle（unblocks E 真 Archive + G 终态） — situations.closed_at + lifecycle='closed' + Resolution Engine + Outcome producer
- [ ] P0010.3 Evidence Identity (H.1 / SB-1) — content_hash 是唯一持久 handle 不可跨加载；需 evidence_id 列 or hash-keyed
- [ ] P0010.3 Knowledge Identity (H.2 / SB-2) — operator_memories vs context_memories shared identity or 2 surface decision
- [ ] P0010.3 Agent Activity Producer (H.3) — write real agentActivities[] + correct findings[].evidenceIds[] (needs H.1 first)
- [ ] P0010.3 Token-rotation test (per ADR-057 "What to verify next session" — restart hermes with new token, see loop auto-discover without restart)

## Phase 7: Skills + Workflows 🔮
- [ ] **Business Workflows** — 618, 双11, 新品上市, 日报/周报/月报 (不是 Runtime Workflow)

## Phase 7: 后续增强 🔮
- [x] Connectors CDP onboarding (Chrome debug-mode, JD session reuse, Playwright connectOverCDP) ✅ D0002
- [ ] Replay Simulator (counterfactual comparison, management report)
- [ ] MCP tool exposure (向 Hermes 暴露 business skills)
- [ ] 反馈驱动的信号重加权 (signal usefulness → 权重推荐)
- [ ] PDD connector
