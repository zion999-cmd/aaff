// JD 商智 indicator key mappings — ported from agentCMS process_historical_data.ts.
// Maps raw JD API response field names to canonical business metric names.
// The JD SPA uses these opaque indicator keys in its API responses.
//
// P0005.4: Hand-written overrides ON TOP of generated indicator dictionary.
// The generated dict (loadIndicatorDict) handles 887 keys algorithmically.
// These overrides ensure business-critical keys have semantically correct canonical names.

import { loadIndicatorDict } from '#app/connectors/binding/index.js';

/**
 * Hand-written overrides for business-critical indicator keys.
 * The generated dictionary uses algorithmic JDR key parsing which doesn't
 * understand business semantics (e.g., "ord_user_cnt" → "customers").
 * These overrides provide authoritative canonical names for core metrics.
 */
export const INDICATOR_OVERRIDES: Readonly<Record<string, string>> = {
  // P0010.2.9 — Shop-level (店铺) — primary for trade.overview.
  // These are the fields the live 经营概览 page actually displays.
  // Source: tradeSummary/summary/getSummary.ajax (szgateway.jd.com)
  jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src: 'shop_visitors',
  fo_jdr_sch_shop_deal_rate: 'shop_conversion_rate',
  'jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src##compare': 'shop_visitors_compare_pct',
  'jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src##compareValue': 'shop_visitors_compare_value',
  'fo_jdr_sch_shop_deal_rate##compare': 'shop_conversion_rate_compare_pct',
  'fo_jdr_sch_shop_deal_rate##compareValue': 'shop_conversion_rate_compare_value',

  // P0010.2.9 — Product / industry level — preserved for traffic.overview /
  // product.overview. These were previously mislabeled as `visitors` and
  // `conversion_rate` (商品 UV 与 行业 CVR) and polluted trade.overview.
  jdr_sch_traffic_brow_sku__page_cnt_traffic_plat_item_di_sz_bsg: 'product_visitors',
  fo_jdr_sch_industry_deal_rate: 'industry_conversion_rate',
  'jdr_sch_traffic_brow_sku__page_cnt_traffic_plat_item_di_sz_bsg##compare': 'product_visitors_compare_pct',
  'jdr_sch_traffic_brow_sku__page_cnt_traffic_plat_item_di_sz_bsg##compareValue': 'product_visitors_compare_value',
  'fo_jdr_sch_industry_deal_rate##compare': 'industry_conversion_rate_compare_pct',
  'fo_jdr_sch_industry_deal_rate##compareValue': 'industry_conversion_rate_compare_value',

  // Summary indicators
  jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot: 'gmv',
  jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot: 'orders',
  jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot: 'customers',

  // WoW comparison indicators (##compare = percentage change, ##compareValue = absolute value)
  'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compare': 'gmv_compare_pct',
  'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compareValue': 'gmv_compare_value',
  'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compare': 'orders_compare_pct',
  'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compareValue': 'orders_compare_value',
  'jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot##compare': 'customers_compare_pct',
  'jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot##compareValue': 'customers_compare_value',
};

/**
 * Backward-compatible alias for the overrides.
 * @deprecated Use INDICATOR_OVERRIDES directly. Kept for backward compat.
 */
export const JD_INDICATOR_MAP: Readonly<Record<string, string>> = INDICATOR_OVERRIDES;

/** Lazy-loaded indicator dictionary from generated artifacts. */
let _indicatorDict: Record<string, { canonical: string; unit: string; confidence: number }> | null = null;

const getIndicatorDict = (): Record<string, { canonical: string; unit: string; confidence: number }> => {
  if (!_indicatorDict) {
    try {
      _indicatorDict = loadIndicatorDict('jd');
    } catch {
      // Fallback: empty dict if generated files don't exist (backward compat).
      _indicatorDict = {};
    }
  }
  return _indicatorDict;
};

/**
 * Map a JD indicator key to its canonical metric name.
 * Resolution order: hand-written overrides → generated dictionary → raw key.
 */
export const mapJdIndicator = (jdKey: string): string => {
  // 1. Check hand-written overrides (highest priority)
  if (jdKey in INDICATOR_OVERRIDES) {
    return INDICATOR_OVERRIDES[jdKey]!;
  }
  // 2. Check generated indicator dictionary
  const dict = getIndicatorDict();
  const entry = dict[jdKey];
  if (entry) return entry.canonical;
  // 3. Fallback: return the raw key
  return jdKey;
};

/**
 * Enhanced indicator mapping with confidence info.
 * Returns null if the key is unknown (not in overrides or generated dict).
 */
export const mapJdIndicatorWithConfidence = (jdKey: string): { canonical: string; confidence: number } | null => {
  if (jdKey in INDICATOR_OVERRIDES) {
    return { canonical: INDICATOR_OVERRIDES[jdKey]!, confidence: 1 };
  }
  const dict = getIndicatorDict();
  const entry = dict[jdKey];
  if (entry) return { canonical: entry.canonical, confidence: entry.confidence };
  return null;
};

/** Map a raw JD data object's keys to canonical names. */
export const mapJdDataRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const canonical = mapJdIndicator(key);
    mapped[canonical] = value;
  }
  return mapped;
};

/** Known JD API response shape (szgateway.jd.com). */
export interface JdApiResponse {
  header?: { code: number; desc?: string };
  body?: { data?: Record<string, unknown>[] | null };
}

/** Check if a value looks like a JD API response envelope. */
export const isJdApiResponse = (v: unknown): v is JdApiResponse => {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return 'header' in obj || 'body' in obj;
};
