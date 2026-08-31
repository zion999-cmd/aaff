// P0008.4 — Agent Shared Knowledge Governance Contract.
// KNOWLEDGE.md is a deterministic governance text that tells any Runtime
// entering the Fabric Agent Workspace HOW to maintain shared knowledge.
//
// It is GOVERNANCE, not business knowledge. It does NOT contain domain expertise.

/** The KNOWLEDGE.md governance contract content (deterministic). */
export const KNOWLEDGE_GOVERNANCE: string = `# KNOWLEDGE.md — Agent Shared Knowledge Governance Contract

You are maintaining a shared knowledge layer for a business Agent.

This file tells you HOW to maintain knowledge. It is NOT business knowledge.

## Roles

- **knowledge-sources/raw/** — immutable provenance source. You may READ but
  NEVER modify. These are the original human/external supplied materials.
- **knowledge/** — the Agent-consumable Shared Knowledge Read Model. You
  CREATE and UPDATE the Markdown pages here.

## Maintenance Rules

1. **Raw is immutable.** Never edit anything under knowledge-sources/raw/.
   All derived knowledge goes under knowledge/.

2. **Create vs update.** Before creating a new page, search knowledge/INDEX.md
   and existing pages. If the source relates to existing knowledge, UPDATE the
   existing page. Only create a new page when the source is a genuinely new topic.

3. **One source may update multiple pages.** A single raw source can add to
   several knowledge pages (e.g. a campaign report may update a "marketing cases"
   page AND a "platform rules" page). Do not force everything into one page.

4. **Provenance.** Every knowledge page MUST reference its raw source(s) in the
   YAML frontmatter \`sources\` field. Never present your synthesis as a
   source-of-origin fact.

5. **Uncertainty.** If the source is ambiguous, express the uncertainty in prose.
   Do not invent certainty that the source does not support.

6. **Disagreement.** If a new source conflicts with existing knowledge, PRESERVE
   the disagreement. Record both positions under a "未决矛盾 / contradictions"
   section. Never silently overwrite the older conclusion.

7. **Cross-references.** In page BODIES, link related pages using [[Page Name]]
   where useful (human-readable). Runtimes do NOT auto-resolve [[wikilinks]] —
   body cross-references are for humans and Agent-to-page navigation, not for
   filesystem discovery.

8. **INDEX.** Keep knowledge/INDEX.md up to date so navigation stays accurate.
   Every INDEX entry MUST use an explicit runtime-readable relative path from
   the workspace root (e.g. \`knowledge/traffic/traffic-drop.md\`), NEVER a
   bare [[wikilink]] — Runtimes resolve files via the filesystem, not an
   Obsidian wikilink resolver.
   The ROOT INDEX is a semantic router (see Domain Structure): it maps a
   situation type / metric to one domain directory. Each domain directory has
   its own INDEX.md listing that domain's pages. Both must stay current.

9. **Log.** Append every ingest/update/lint action to knowledge/log.md in
   chronological order.

10. **Lint.** Periodically check for: contradictions, stale pages, orphan pages,
    missing cross-references, and knowledge gaps.

## Page Convention

Use lightweight Markdown + YAML frontmatter:

\`\`\`markdown
---
title: <page title>
type: <platform_rule | case | organization | reference>
domain: <ecommerce | ...>
sources: [knowledge-sources/raw/<file>]
created_at: <ISO date>
updated_at: <ISO date>
tags: [<...>]
---
\`\`\`

The body is natural-language Markdown for LLM consumption.

## Domain Structure (语义域分层导航)

Knowledge pages are organized by SEMANTIC DOMAIN, not by content type. The
root INDEX is a semantic router; each domain has its own INDEX.md.

\`\`\`
knowledge/INDEX.md            # 根路由器：situation 类型/指标 → 语义域 + 通用前置内联
knowledge/traffic/INDEX.md    # 流量问题：UV 下跌排查、流量侧边缘场景、爬虫 UV
knowledge/conversion/INDEX.md # 转化问题：转化率下跌排查、广告 ROI、转化侧边缘场景
knowledge/product/INDEX.md    # 商品问题：客单价、SKU 禁忌、券风险、库存、商品侧
knowledge/operations/INDEX.md # 经营异常：真伪异常判定、大促预案、运营决策、对照表
\`\`\`

Routing rules (write into the root INDEX, not code):
- \`uv\` → traffic; \`cvr\` → conversion; \`overall_score\` / product entity → product.
- \`gmv\` / \`orders\` / \`uv_cvr\` → operations (result metrics: judge true-vs-false
  anomaly first, then drill down the fault tree into traffic/conversion/product).
- Cross-domain general knowledge (Agent execution constraints, Few-Shot case
  library) lives in standalone pages at the knowledge/ root, referenced from
  domain INDEXes as needed. The true-vs-false anomaly gate (UV threshold,
  pseudo-anomaly checklist) is INLINED in the root INDEX so every query reads
  it without an extra page.

## Operations

- **Ingest** — read a new raw source → create/update knowledge pages in the
  matching SEMANTIC DOMAIN → update root INDEX (semantic router) + domain
  INDEX → append log.
- **Query** — read root INDEX (semantic router + inlined anomaly gate) →
  follow to the domain INDEX → read the ONE most relevant domain page. Prefer
  compiled knowledge over re-reading raw every time.
- **Lint** — surface contradictions, stale/orphan pages, missing cross-refs, gaps.
`;

/** The initial INDEX.md navigation entry (deterministic). */
export const KNOWLEDGE_INDEX: string = `# Knowledge Index — 语义路由

> 先读本节判定真假异常，再按 situation 类型/指标路由到语义域。

## 通用前置（每次必读，无需额外读页）
- **判定阈值**：单天波动 ±15% 以内优先观察；连续 2-3 天 >20% 才启动故障排查。
- **小样本噪声**：访客 <500 / 关键词点击 <30 时指标剧烈跳动属统计噪声，禁止下确定性结论。
- **对比优先级**：周同比 > 类目大盘 > 日环比。
- **伪异常清单**：节假日回落 / 平台算法迭代 / 单店小样本大单抖动 / 爬虫 UV 虚高 / 外部引流低匹配 / 大促预热只加购不下单。

## 语义域路由
- **uv 变化** → 流量问题 → \`knowledge/traffic/INDEX.md\`
- **cvr 变化** → 转化问题 → \`knowledge/conversion/INDEX.md\`
- **客单价 / 商品 / SKU / 库存** → 商品问题 → \`knowledge/product/INDEX.md\`
- **gmv / orders / uv_cvr（结果指标或背离）** → 经营异常 → \`knowledge/operations/INDEX.md\`（先真伪判定，再按排查树下钻流量/转化/客单价三支）

## 通用参考（按需）
- Agent 执行约束 → \`knowledge/agent-execution-constraints.md\`
- Few-Shot 失败案例库 → \`knowledge/few-shot-cases.md\`
`;
