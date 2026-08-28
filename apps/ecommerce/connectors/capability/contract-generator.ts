// Capability Contract Generator — builds capability-contract.json from domain knowledge.
// P0006.5.3: This is a BUILD-TIME generator. It produces the Contract artifact from
// hand-curated domain configs. The output is a pure capability description —
// no URLs, no API names, no implementation details.
//
// The Contract tells agents WHAT capabilities exist.
// The Connector Blueprint tells the runtime HOW to execute them.
// They are separate artifacts with separate lifecycles.
//
// Run via: npm run cli -- generate-contract --platform jd

import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  CapabilityContract,
  CapabilityContractEntry,
  CapabilityMetric,
} from './contract-types.js';
import { CapabilityContractSchema } from './contract-types.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');

// ---- Domain Configuration ----
// Each domain config describes ONE business capability.
// This is hand-curated — it represents business understanding, not auto-generated data.

interface DomainConfig {
  capability: string;
  domain: string;
  name: string;
  description: string;
  intent: string[];
  inputs: {
    date_range: boolean;
    entity_id: boolean;
    dimensions: string[];
  };
  outputs: string[];             // canonical metric names
  dimensions: string[];
  provider: {
    platform: string;
    acquisition: 'cdp' | 'api_direct' | 'csv_export' | 'manual';
  };
  validation: {
    status: CapabilityContractEntry['validation']['status'];
    lastVerified?: string;
    verifiedMetrics: string[];
  };
  constraints: {
    requiresPremium: boolean;
    premiumTier?: string;
    requiresAdAccount: boolean;
    isPopup: boolean;
    notes?: string;
  };
}

const DOMAIN_CONFIGS: readonly DomainConfig[] = [
  {
    capability: 'trade.overview',
    domain: 'trade',
    name: '交易概览',
    description: '店铺级核心经营指标：GMV、订单、店铺访客、店铺成交转化率。每日汇总 + 24小时趋势 + Top5 商品排行。',
    intent: [
      '今天卖了多少',
      'GMV涨跌分析',
      '哪个商品卖得最好',
      '每小时销售趋势',
      '店铺转化率监控',
      '经营概览',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['time_hourly', 'time_daily', 'product_top5'] },
    // P0010.2.9: shop-level is primary; product/industry level preserved.
    outputs: ['gmv', 'orders', 'customers', 'shop_visitors', 'shop_conversion_rate', 'product_visitors', 'industry_conversion_rate', 'gmv_compare_pct', 'orders_compare_pct', 'shop_visitors_compare_pct', 'gmv_hourly'],
    dimensions: ['time_hourly', 'time_daily', 'product_top5', 'sku'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'verified',
      lastVerified: '2026-08-28',
      verifiedMetrics: ['gmv', 'orders', 'shop_visitors', 'shop_conversion_rate', 'product_visitors', 'industry_conversion_rate'],
    },
    constraints: { requiresPremium: false, requiresAdAccount: false, isPopup: false },
  },
  {
    capability: 'trade.detail',
    domain: 'trade',
    name: '交易构成',
    description: '交易构成分析：品牌构成、类目构成、渠道构成。含退款金额、客单价等细分指标。',
    intent: [
      '品牌GMV贡献',
      '退款率分析',
      '渠道成交占比',
      '客单价趋势',
      '交易构成分析',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['brand', 'category', 'channel'] },
    outputs: ['gmv', 'orders', 'refunds', 'revenue_per_customer', 'brand_gmv', 'category_gmv'],
    dimensions: ['brand', 'category', 'channel', 'time_daily'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'captured',
      verifiedMetrics: [],
    },
    constraints: { requiresPremium: false, requiresAdAccount: false, isPopup: false },
  },
  {
    capability: 'traffic.overview',
    domain: 'traffic',
    name: '流量分析',
    description: '流量来源分析：各渠道访客数、UV、PV、跳失率。来源渠道归因 + 搜索关键词分析。',
    intent: [
      '分析流量变化',
      '分析访客下降',
      '流量从哪里来',
      '哪个渠道访客最多',
      '搜索什么关键词进来',
      '商品流量排行',
      '渠道归因分析',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['channel', 'keyword', 'product'] },
    // P0010.2.9: rename `visitors` → `product_visitors` to avoid polluting trade.overview
    outputs: ['product_visitors', 'uv', 'pv', 'bounce_rate', 'avg_duration', 'traffic_by_channel', 'order_amount_by_channel', 'search_keyword_visitors'],
    dimensions: ['channel', 'keyword', 'product', 'time_daily'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'captured',
      verifiedMetrics: [],
    },
    constraints: { requiresPremium: false, requiresAdAccount: false, isPopup: false },
  },
  {
    capability: 'product.overview',
    domain: 'product',
    name: '商品表现',
    description: '商品表现分析：SKU 排行、动销 SPU 趋势、商品转化漏斗。按 GMV/访客数/曝光量排名。',
    intent: [
      '商品销售排行',
      'SKU转化率分析',
      '动销商品趋势',
      '商品曝光点击漏斗',
      '哪个商品卖得好',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['sku', 'spu', 'brand'] },
    // P0010.2.9: rename `visitors` → `product_visitors` to avoid polluting trade.overview
    outputs: ['gmv', 'product_visitors', 'exposure', 'conversion', 'sku_count', 'inventory_turnover'],
    dimensions: ['sku', 'spu', 'brand', 'time_daily'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'captured',
      verifiedMetrics: [],
    },
    constraints: { requiresPremium: false, requiresAdAccount: false, isPopup: false },
  },
  {
    capability: 'service.overview',
    domain: 'service',
    name: '服务指标',
    description: '店铺服务指标：店铺星级、服务运营数据、客服响应、售后满意度。',
    intent: [
      '店铺星级查询',
      '客服响应速度',
      '售后满意度分析',
      '服务质量评估',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: [] },
    outputs: ['response_rate', 'resolution_time', 'satisfaction_score', 'shop_stars'],
    dimensions: ['time_daily', 'service_type'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'captured',
      verifiedMetrics: [],
    },
    constraints: { requiresPremium: false, requiresAdAccount: false, isPopup: false },
  },
  {
    capability: 'industry.benchmark',
    domain: 'industry',
    name: '行业对标',
    description: '行业对标分析：行业排行、品牌排行、市场趋势。注意：JD 行业数据为 indexed 值（非绝对值）。',
    intent: [
      '行业排名查询',
      '市场份额分析',
      '同行品牌对比',
      '行业大盘趋势',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['brand', 'industry'] },
    outputs: ['market_rank', 'market_share', 'industry_gmv_index', 'industry_uv_index'],
    dimensions: ['brand', 'industry', 'time_daily'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'captured',
      verifiedMetrics: [],
    },
    constraints: {
      requiresPremium: false,
      requiresAdAccount: false,
      isPopup: false,
      notes: '行业数据为 indexed 值（非绝对值），不可直接与其他平台对标',
    },
  },
  {
    capability: 'customer.overview',
    domain: 'customer',
    name: '客户资产',
    description: '客户资产分析：新老客、会员、粉丝、用户画像。含用户增长运营数据。',
    intent: [
      '新增客户统计',
      '复购率分析',
      '会员增长趋势',
      '用户画像分布',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['customer_type'] },
    outputs: ['new_customers', 'repeat_customers', 'members', 'fans'],
    dimensions: ['customer_type', 'time_daily'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'popup_blocked',
      verifiedMetrics: [],
    },
    constraints: {
      requiresPremium: false,
      requiresAdAccount: false,
      isPopup: true,
      notes: '页面以弹窗形式打开，需要特殊导航处理',
    },
  },
  {
    capability: 'marketing.overview',
    domain: 'marketing',
    name: '营销效果',
    description: '营销效果分析：广告花费、ROI、活动效果、CPA/CPC。促销工具分析 + 活动对比。',
    intent: [
      '广告ROI分析',
      '活动效果评估',
      '获客成本分析',
      '优惠券核销率',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['campaign', 'channel'] },
    outputs: ['ad_spend', 'roi', 'campaign_orders', 'cpa'],
    dimensions: ['campaign', 'channel', 'time_daily'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'popup_blocked',
      verifiedMetrics: [],
    },
    constraints: {
      requiresPremium: false,
      requiresAdAccount: false,
      isPopup: true,
      notes: '页面以弹窗形式打开，需要特殊导航处理',
    },
  },
  {
    capability: 'supply_chain.inventory',
    domain: 'supply_chain',
    name: '库存健康',
    description: '供应链健康：库存天数、缺货风险、周转率、滞销率。库存诊断 + 入仓模拟。',
    intent: [
      '缺货预警',
      '库存周转分析',
      '滞销商品识别',
      '入仓建议',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['sku', 'warehouse'] },
    outputs: ['stock_days', 'stockout_risk', 'turnover_rate', 'unsale_rate'],
    dimensions: ['sku', 'warehouse', 'time_daily'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'popup_blocked',
      verifiedMetrics: [],
    },
    constraints: {
      requiresPremium: false,
      requiresAdAccount: false,
      isPopup: true,
      notes: '页面以弹窗形式打开，需要特殊导航处理',
    },
  },
  {
    capability: 'trade.competition',
    domain: 'trade',
    name: '竞争分析',
    description: '竞店对标：竞店 GMV、市场排名、份额变化。需要 ¥8,856/年 数据尊享包。',
    intent: [
      '竞店分析',
      '市场排名查询',
      '份额变化监控',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['competitor'] },
    outputs: ['competitor_gmv', 'market_position', 'share_change'],
    dimensions: ['competitor', 'time_daily'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: {
      status: 'premium_required',
      verifiedMetrics: [],
    },
    constraints: {
      requiresPremium: true,
      premiumTier: '¥8,856/年 数据尊享包',
      requiresAdAccount: false,
      isPopup: false,
    },
  },
  {
    capability: 'trade.reports',
    domain: 'trade',
    name: '数据导出',
    description: '批量数据导出：自定义报表、下载中心。可导出 CSV 格式的原始数据。',
    intent: [
      '导出原始数据',
      '月度报表下载',
    ],
    inputs: { date_range: true, entity_id: false, dimensions: ['report_type'] },
    outputs: ['custom_report_data'],
    dimensions: ['report_type', 'time_daily'],
    provider: { platform: 'jd', acquisition: 'csv_export' },
    validation: {
      status: 'content_only',
      verifiedMetrics: [],
    },
    constraints: { requiresPremium: false, requiresAdAccount: false, isPopup: false },
  },
];

/**
 * Canonical capability ID → connector api_module.
 * THE single source of truth for capability → module resolution. The planner
 * uses this (not the stale discovery vocabulary) to bind a canonical
 * capability to its endpoint subset. Unknown capabilities fail closed.
 */
export const CAPABILITY_TO_MODULE: Readonly<Record<string, string>> = {
  'trade.overview': 'indexSummary',
  'trade.detail': 'indexSummary',
  'trade.competition': 'industryMarket',
  'trade.reports': 'common',
  'traffic.overview': 'indexSummary',
  'product.overview': 'indexSummary',
  'service.overview': 'common',
  'industry.benchmark': 'industryMarket',
  'customer.overview': 'custGrowth',
  'marketing.overview': 'marketing',
  'supply_chain.inventory': 'stock',
};

// ---- Metric Metadata ----
// Detailed metadata for each canonical metric that appears in outputs.

interface MetricDef {
  canonical: string;
  label: string;
  unit: CapabilityMetric['unit'];
  confidence: number;
}

const METRIC_METADATA: Readonly<Record<string, MetricDef[]>> = {
  'trade.overview': [
    { canonical: 'gmv', label: '成交金额', unit: 'currency', confidence: 1.0 },
    { canonical: 'orders', label: '成交订单数', unit: 'count', confidence: 1.0 },
    { canonical: 'customers', label: '成交客户数', unit: 'count', confidence: 1.0 },
    // P0010.2.9: shop-level is primary
    { canonical: 'shop_visitors', label: '店铺访客数', unit: 'count', confidence: 1.0 },
    { canonical: 'shop_conversion_rate', label: '店铺成交转化率', unit: 'percentage', confidence: 1.0 },
    // Product / industry level (preserved for other capabilities)
    { canonical: 'product_visitors', label: '商品访客数', unit: 'count', confidence: 1.0 },
    { canonical: 'industry_conversion_rate', label: '行业成交转化率', unit: 'percentage', confidence: 1.0 },
    { canonical: 'gmv_compare_pct', label: 'GMV 环比', unit: 'percentage', confidence: 1.0 },
    { canonical: 'orders_compare_pct', label: '订单环比', unit: 'percentage', confidence: 1.0 },
    { canonical: 'shop_visitors_compare_pct', label: '店铺访客环比', unit: 'percentage', confidence: 1.0 },
    { canonical: 'gmv_hourly', label: '小时 GMV', unit: 'currency', confidence: 1.0 },
  ],
  'trade.detail': [
    { canonical: 'gmv', label: '成交金额', unit: 'currency', confidence: 0.8 },
    { canonical: 'orders', label: '成交订单数', unit: 'count', confidence: 0.8 },
    { canonical: 'refunds', label: '退款金额', unit: 'currency', confidence: 0.6 },
    { canonical: 'revenue_per_customer', label: '客单价', unit: 'currency', confidence: 0.6 },
    { canonical: 'brand_gmv', label: '品牌成交', unit: 'currency', confidence: 0.5 },
    { canonical: 'category_gmv', label: '类目成交', unit: 'currency', confidence: 0.5 },
  ],
  'traffic.overview': [
    // P0010.2.9: `visitors` renamed to `product_visitors` to avoid polluting trade.overview
    { canonical: 'product_visitors', label: '商品访客数', unit: 'count', confidence: 0.7 },
    { canonical: 'uv', label: 'UV', unit: 'count', confidence: 0.7 },
    { canonical: 'pv', label: 'PV', unit: 'count', confidence: 0.7 },
    { canonical: 'bounce_rate', label: '跳失率', unit: 'percentage', confidence: 0.6 },
    { canonical: 'avg_duration', label: '平均停留时长', unit: 'count', confidence: 0.5 },
    { canonical: 'traffic_by_channel', label: '渠道访客', unit: 'count', confidence: 0.6 },
    { canonical: 'order_amount_by_channel', label: '渠道成交', unit: 'currency', confidence: 0.6 },
    { canonical: 'search_keyword_visitors', label: '搜索词访客', unit: 'count', confidence: 0.5 },
  ],
  'product.overview': [
    { canonical: 'gmv', label: '商品 GMV', unit: 'currency', confidence: 0.7 },
    { canonical: 'product_visitors', label: '商品访客', unit: 'count', confidence: 0.6 },
    { canonical: 'exposure', label: '商品曝光', unit: 'count', confidence: 0.6 },
    { canonical: 'conversion', label: '商品转化率', unit: 'ratio', confidence: 0.6 },
    { canonical: 'sku_count', label: '动销 SKU 数', unit: 'count', confidence: 0.5 },
    { canonical: 'inventory_turnover', label: '库存周转', unit: 'ratio', confidence: 0.4 },
  ],
  'service.overview': [
    { canonical: 'response_rate', label: '客服响应率', unit: 'percentage', confidence: 0.5 },
    { canonical: 'resolution_time', label: '平均解决时间', unit: 'count', confidence: 0.5 },
    { canonical: 'satisfaction_score', label: '满意度评分', unit: 'score', confidence: 0.5 },
    { canonical: 'shop_stars', label: '店铺星级', unit: 'score', confidence: 0.5 },
  ],
  'industry.benchmark': [
    { canonical: 'market_rank', label: '市场排名', unit: 'index', confidence: 0.5 },
    { canonical: 'market_share', label: '市场份额', unit: 'percentage', confidence: 0.4 },
    { canonical: 'industry_gmv_index', label: '行业 GMV 指数', unit: 'index', confidence: 0.5 },
    { canonical: 'industry_uv_index', label: '行业 UV 指数', unit: 'index', confidence: 0.5 },
  ],
  'customer.overview': [
    { canonical: 'new_customers', label: '新增客户', unit: 'count', confidence: 0.5 },
    { canonical: 'repeat_customers', label: '复购客户', unit: 'count', confidence: 0.5 },
    { canonical: 'members', label: '会员数', unit: 'count', confidence: 0.5 },
    { canonical: 'fans', label: '粉丝数', unit: 'count', confidence: 0.5 },
  ],
  'marketing.overview': [
    { canonical: 'ad_spend', label: '广告花费', unit: 'currency', confidence: 0.6 },
    { canonical: 'roi', label: '广告 ROI', unit: 'ratio', confidence: 0.6 },
    { canonical: 'campaign_orders', label: '活动订单', unit: 'count', confidence: 0.5 },
    { canonical: 'cpa', label: '获客成本 CPA', unit: 'currency', confidence: 0.5 },
  ],
  'supply_chain.inventory': [
    { canonical: 'stock_days', label: '可售天数', unit: 'count', confidence: 0.5 },
    { canonical: 'stockout_risk', label: '缺货风险', unit: 'count', confidence: 0.5 },
    { canonical: 'turnover_rate', label: '周转率', unit: 'ratio', confidence: 0.5 },
    { canonical: 'unsale_rate', label: '滞销率', unit: 'percentage', confidence: 0.5 },
  ],
  'trade.competition': [
    { canonical: 'competitor_gmv', label: '竞店 GMV', unit: 'currency', confidence: 0.5 },
    { canonical: 'market_position', label: '市场排名', unit: 'index', confidence: 0.5 },
    { canonical: 'share_change', label: '份额变化', unit: 'percentage', confidence: 0.5 },
  ],
  'trade.reports': [
    { canonical: 'custom_report_data', label: '自定义报表', unit: 'text', confidence: 0.4 },
  ],
};

// ---- Builder ----

const buildEntry = (config: DomainConfig): CapabilityContractEntry => {
  const metricDefs = METRIC_METADATA[config.capability] ?? [];
  const verifiedSet = new Set(config.validation.verifiedMetrics);

  const metrics: CapabilityMetric[] = metricDefs.map((m) => ({
    canonical: m.canonical,
    label: m.label,
    unit: m.unit,
    confidence: m.confidence,
    verified: verifiedSet.has(m.canonical),
  }));

  return {
    capability: config.capability,
    domain: config.domain,
    name: config.name,
    description: config.description,
    intent: config.intent,
    inputs: {
      date_range: config.inputs.date_range,
      entity_id: config.inputs.entity_id,
      dimensions: config.inputs.dimensions,
    },
    outputs: config.outputs,
    metrics,
    dimensions: config.dimensions,
    provider: {
      platform: config.provider.platform,
      acquisition: config.provider.acquisition,
    },
    validation: {
      status: config.validation.status,
      last_verified: config.validation.lastVerified,
      verified_metrics: config.validation.verifiedMetrics,
    },
    constraints: {
      requires_premium: config.constraints.requiresPremium,
      premium_tier: config.constraints.premiumTier,
      requires_ad_account: config.constraints.requiresAdAccount,
      is_popup: config.constraints.isPopup,
      notes: config.constraints.notes,
    },
  };
};

/**
 * Generate the full CapabilityContract from domain configs.
 * Pure function — produces a validated contract ready for consumption.
 */
export const generateCapabilityContract = (): CapabilityContract => {
  const entries: CapabilityContractEntry[] = DOMAIN_CONFIGS.map(buildEntry);

  const verified = entries.filter((e) => e.validation.status === 'verified');
  const captured = entries.filter(
    (e) => e.validation.status === 'captured' || e.validation.status === 'content_only',
  );
  const pending = entries.filter((e) => e.validation.status === 'pending');
  const blocked = entries.filter(
    (e) =>
      e.validation.status === 'premium_required' ||
      e.validation.status === 'popup_blocked',
  );

  // Deduplicate metrics across all entries (keep highest confidence)
  const allMetrics = new Map<string, CapabilityMetric>();
  for (const entry of entries) {
    for (const m of entry.metrics) {
      if (!allMetrics.has(m.canonical) || m.confidence > allMetrics.get(m.canonical)!.confidence) {
        allMetrics.set(m.canonical, m);
      }
    }
  }

  const domains = [...new Set(entries.map((e) => e.domain))].sort();

  const contract: CapabilityContract = {
    version: '1.0.0',
    platform: 'jd',
    platform_name: '京东商智',
    generated_at: new Date().toISOString(),
    sources: [
      'sources/jd_smart/blueprint.yaml',
      'catalog/jd/endpoints.json',
      'catalog/jd/capability.md',
      'discovery/jd-capability/capability_matrix.json',
      'jd_source/P0006-Data-Acquisition-Report.md',
    ],
    capabilities: entries,
    summary: {
      total_capabilities: entries.length,
      total_metrics: allMetrics.size,
      verified_capabilities: verified.length,
      captured_capabilities: captured.length,
      pending_capabilities: pending.length,
      blocked_capabilities: blocked.length,
      domains,
    },
  };

  return CapabilityContractSchema.parse(contract);
};

/**
 * Write the generated contract to generated/capability-contract.json.
 */
export const writeCapabilityContract = (outputPath?: string): CapabilityContract => {
  const contract = generateCapabilityContract();
  const outPath = outputPath ?? resolve(PROJECT_ROOT, 'generated', 'capability-contract.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(contract, null, 2), 'utf-8');
  return contract;
};
