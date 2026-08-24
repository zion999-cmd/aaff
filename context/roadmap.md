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
