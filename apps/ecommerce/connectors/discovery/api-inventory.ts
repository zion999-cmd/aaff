// P0005.2 Phase 1 — API Inventory.
//
// Auto-maintained catalog of all discovered API endpoints.
// Loads from D0002 api_inventory.json + page_inventory.json.
// Classifies APIs into modules by URL prefix pattern (derived from the
// api_modules section of D0002_JD_Capability_Report).

import { loadApiInventory, loadPageInventory } from './loader.js';
import type { ApiEndpoint, ApiModule, PageCapture } from './types.js';

// ---------------------------------------------------------------------------
// Module classification (from D0002 JD capability report api_modules)
// ---------------------------------------------------------------------------

interface ModuleRule {
  name: string;
  prefix: string;
  test: (endpointName: string) => boolean;
  description: string;
}

const MODULE_RULES: readonly ModuleRule[] = [
  {
    name: 'indexSummary',
    prefix: 'szgateway.jd.com/api/lowcode/indexSummary/',
    description: '首页核心指标 — GMV, orders, visitors, conversion, product rankings',
    test: (ep) =>
      ep.includes('indexSummary') ||
      ep.includes('tradeSummary') ||
      ['trend', 'productTop', 'shopLevel',
       'targetState', 'showAiEntry', 'getShopStars',
       'getShopValueProposition', 'getProductToBeActiveDiagnosisDetail',
       'getChannelList', 'getProductAnalysisData', 'getFlowAnalysisData',
       'getFlowHead', 'getProductHead', 'getProductList', 'getProductListByChannel',
       'getIndustryHead', 'getIndustryTopTable', 'getHotCate',
       // P0010.2.9: trade.overview pulls shop-level + realtime from
       // tradeSummary/summary/{getSummary,getTrend}.ajax. The per-cap
       // factory in routes/runtime.ts dispatches these to the page-driven
       // acquire; for planner purposes they live in indexSummary.
       'getSummary', 'getTrend',
      ].includes(ep),
  },
  {
    name: 'industryMarket',
    prefix: 'szgateway.jd.com/szajax/sz/industry/industryMarket/',
    description: '行业大盘 — indexed GMV/UV/PV/orders/rankings (JD hides absolute values)',
    test: (ep) =>
      ep.includes('industryMarket') ||
      ['getRealSeriesData', 'getRealSummaryData',
       'getProductRankListDetail', 'getShopRankListDetail',
      ].includes(ep),
  },
  {
    name: 'custGrowth',
    prefix: 'szgateway.jd.com/szajax/sz/cust/growthSummary/',
    description: '客户增长 — new/old/member/fan breakdown, product-level conversion',
    test: (ep) =>
      ep.includes('growthSummary') || ep.includes('cust/') ||
      ['audienceInfo', 'conversionEffect', 'dateRange',
       'diagnosis', 'shopAsset', 'shopGoodsList',
       'whiteList', 'getReachTypeConfig', 'summary',
      ].includes(ep),
  },
  {
    name: 'marketing',
    prefix: 'szgateway.jd.com/marketajax/biz/marketing/',
    description: '营销活动 — campaign list, trend, overview',
    test: (ep) =>
      ep.includes('marketing') ||
      ['overview', 'getMarketingTrend', 'getMarketingActivityList'].includes(ep),
  },
  {
    name: 'stock',
    prefix: 'szgateway.jd.com/stockweb/',
    description: '供应链 — inventory health, alarms, turnover, spot rates',
    test: (ep) =>
      ep.startsWith('getAlarm') || ep.startsWith('getHealth') ||
      ep.startsWith('getIndicator') || ep.startsWith('getVender') ||
      ep.startsWith('getDefault'),
  },
  {
    name: 'common',
    prefix: 'szgateway.jd.com/api/lowcode/common/',
    description: '平台基础设施 — menus, announcements, auth, page info',
    test: (ep) =>
      ep.includes('common') ||
      ep.startsWith('getMenu') || ep.startsWith('getPage') ||
      ep.startsWith('getAnnouncement') || ep.startsWith('getLocalAnnouncement') ||
      ep.startsWith('getHome') || ep.startsWith('getSystem') ||
      ep.startsWith('getWindow') || ep.startsWith('getUser') ||
      ep.startsWith('getModel') || ep.startsWith('getPop') ||
      ep.startsWith('getDims') || ep.startsWith('commonParam') ||
      ep.startsWith('emergency') || ep.startsWith('lkActivity') ||
      ep.startsWith('noOrder') || ep === 'getNewMenuTreeData.ajax' ||
      ep === 'getUserCategoryList.ajax',
  },
];

const OTHER_MODULE: ModuleRule = {
  name: 'other',
  prefix: 'unknown',
  description: 'Unclassified endpoints',
  test: () => true,
};

// ---------------------------------------------------------------------------
// Internal state (lazily loaded)
// ---------------------------------------------------------------------------

let _endpoints: Record<string, ApiEndpoint> | null = null;
let _pages: PageCapture[] | null = null;
let _modules: ApiModule[] | null = null;

const endpoints = (): Record<string, ApiEndpoint> => {
  if (!_endpoints) _endpoints = loadApiInventory();
  return _endpoints;
};

const pages = (): PageCapture[] => {
  if (!_pages) _pages = loadPageInventory();
  return _pages;
};

const classifyEndpoint = (epName: string): string => {
  for (const rule of MODULE_RULES) {
    if (rule.test(epName)) return rule.name;
  }
  return OTHER_MODULE.name;
};

const buildModules = (): ApiModule[] => {
  const eps = endpoints();
  const grouped: Record<string, string[]> = {};
  for (const epName of Object.keys(eps)) {
    const mod = classifyEndpoint(epName);
    (grouped[mod] ??= []).push(epName);
  }

  const allRules = [...MODULE_RULES, OTHER_MODULE];
  const result: ApiModule[] = [];
  for (const r of allRules) {
    const epList = grouped[r.name];
    if (epList && epList.length > 0) {
      result.push({
        name: r.name,
        prefix: r.prefix,
        endpoints: epList.sort(),
        description: r.description,
      });
    }
  }
  return result;
};

const modules = (): ApiModule[] => {
  if (!_modules) _modules = buildModules();
  return _modules;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List all API endpoints, optionally filtered by module name. */
export const listApis = (filter?: { module?: string }): ApiEndpoint[] => {
  const eps = endpoints();
  if (!filter?.module) return Object.values(eps);
  const mod = modules().find((m) => m.name === filter.module);
  if (!mod) return [];
  return mod.endpoints.map((n) => eps[n]!).filter(Boolean);
};

/** Get the full field schema for a specific endpoint (null if unknown). */
export const getApiSchema = (endpointName: string): ApiEndpoint | null =>
  endpoints()[endpointName] ?? null;

/** Return all API modules (auto-classified by URL prefix). */
export const getApiModules = (): ApiModule[] => modules();

/** Return all endpoints belonging to a specific module. */
export const getApisByModule = (moduleName: string): ApiEndpoint[] => {
  const mod = modules().find((m) => m.name === moduleName);
  if (!mod) return [];
  const eps = endpoints();
  return mod.endpoints.map((n) => eps[n]!).filter(Boolean);
};

/** Return all API endpoint names observed on a specific page (by Chinese name). */
export const getApisByPage = (pageName: string): string[] => {
  const p = pages().find((pg) => pg.page === pageName);
  if (!p) return [];
  const seen = new Set<string>();
  for (const call of p.apis) {
    // Extract endpoint name from URL: last path segment before .ajax, no .ajax suffix
    const urlParts = call.url.split('/');
    const last = urlParts[urlParts.length - 1]!;
    const ep = last.replace('.ajax', '');
    if (ep) seen.add(ep);
  }
  return [...seen].sort();
};

/** Return all pages mapped to their API endpoint names. */
export const getPageApiMap = (): Record<string, string[]> => {
  const map: Record<string, string[]> = {};
  for (const p of pages()) {
    map[p.page] = getApisByPage(p.page);
  }
  return map;
};

/** Return the known base path for a module prefix. */
export const getModuleBasePath = (moduleName: string): string | null => {
  for (const rule of MODULE_RULES) {
    if (rule.name === moduleName) return rule.prefix;
  }
  return null;
};

/** Compute aggregate statistics about the API inventory. */
export const getApiStats = (): {
  total_apis: number;
  total_fields: number;
  modules: number;
  module_counts: Record<string, number>;
} => {
  const eps = endpoints();
  const mods = modules();
  const module_counts: Record<string, number> = {};
  let total_fields = 0;
  for (const ep of Object.values(eps)) {
    total_fields += ep.field_count;
  }
  for (const mod of mods) {
    module_counts[mod.name] = mod.endpoints.length;
  }
  return {
    total_apis: Object.keys(eps).length,
    total_fields,
    modules: mods.length,
    module_counts,
  };
};
