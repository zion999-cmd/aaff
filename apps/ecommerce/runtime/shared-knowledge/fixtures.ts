// P0008.4 — minimal JD-domain fixtures.
// A few sample raw sources + seed knowledge pages to verify the mechanism.
// NOT a full corpus. Real material would be supplied by humans/external sources.

/** A sample raw source (platform reference) — immutable provenance material. */
export const RAW_PLATFORM_PROMOTION = `# 京东商智 2026 新推广产品说明

京东 2026 年推出"内容化推广"产品，支持商家在商品详情页投放短视频种草内容。

适用场景：新品冷启动、大促蓄水期。

计费方式：按曝光付费（CPM），不与成交强绑定。
`;

/** A sample raw source (marketing case) — immutable provenance material. */
export const RAW_MARKETING_CASE = `# 品牌A 618 大促复盘

品牌A 在 618 期间通过"直播 + 优惠券组合"将活动转化率提升 23%。

关键动作：
1. 预热期直播种草，积累加购
2. 爆发期发放限时优惠券
3. 返场期用"已加购未购买"人群定向召回
`;

/** A seed knowledge page (already compiled from RAW_PLATFORM_PROMOTION). */
export const SEED_PLATFORM_PAGE = `---
title: 京东内容化推广
type: platform_rule
domain: ecommerce
sources: [knowledge-sources/raw/platform-promotion.md]
created_at: 2026-08-13
updated_at: 2026-08-13
tags: [jd, promotion, content]
---

# 京东内容化推广

## 核心规则
京东 2026 推出"内容化推广"产品，支持商品详情页投放短视频种草内容。

## 适用场景
- 新品冷启动
- 大促蓄水期

## 计费方式
按曝光付费（CPM），不与成交强绑定。

## 交叉引用
- 相关：[[品牌A 618大促案例]]
`;

/** Seed knowledge index (the initial INDEX.md). */
export const SEED_INDEX = `# Knowledge Index — 语义路由

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

## 已编译领域
（待 ingest）
`;

/** Seed maintenance log. */
export const SEED_LOG = `# Maintenance Log

## [2026-08-13] seed
- created knowledge layer structure
- seeded raw source: platform-promotion.md
- seeded compiled page: 京东内容化推广
`;
