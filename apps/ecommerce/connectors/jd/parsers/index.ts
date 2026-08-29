// JD data parsers — convert raw JD API responses into structured, typed data.
// Ported from agentCMS process_historical_data.ts, adapted for P0005 pipeline.

import { mapJdDataRow, isJdApiResponse } from './indicator-map.js';
import type { JdApiResponse } from './indicator-map.js';

// ---- Parsed Types ----

export interface JdSummary {
  /** GMV (成交金额) */
  gmv: number;
  /** Order count (成交订单数) */
  orders: number;
  /** Unique customers (成交客户数) */
  customers: number;
  /**
   * P0010.2.9 — Shop-level (店铺) — primary for trade.overview.
   * Visitors that entered THIS shop, computed by the live 经营概览 page.
   * Source: jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src
   */
  shop_visitors: number;
  /**
   * P0010.2.9 — Shop-level — primary for trade.overview.
   * Shop deal rate (店铺成交转化率), as the live page shows.
   * Source: fo_jdr_sch_shop_deal_rate
   */
  shop_conversion_rate: number;
  /**
   * P0010.2.9 — Product-level (商品). Previously mislabeled as `visitors`.
   * Preserved for traffic.overview / product.overview.
   * Source: jdr_sch_traffic_brow_sku__page_cnt_traffic_plat_item_di_sz_bsg
   */
  product_visitors: number;
  /**
   * P0010.2.9 — Industry-level (行业). Previously mislabeled as `conversion_rate`.
   * Preserved for industry.benchmark.
   * Source: fo_jdr_sch_industry_deal_rate
   */
  industry_conversion_rate: number;

  // ---- WoW comparison percentages (signed) ----
  /** WoW GMV comparison percentage */
  gmv_compare_pct: number | null;
  /** WoW orders comparison percentage */
  orders_compare_pct: number | null;
  /** WoW shop_visitors comparison percentage */
  shop_visitors_compare_pct: number | null;
  /** WoW product_visitors comparison percentage */
  product_visitors_compare_pct: number | null;
  /** WoW shop_conversion_rate comparison percentage */
  shop_conversion_rate_compare_pct: number | null;
  /** WoW industry_conversion_rate comparison percentage */
  industry_conversion_rate_compare_pct: number | null;

  // ---- ##compareValue — yesterday absolute baseline (P0010.2.11 C2) ----
  // The getSummary payload bakes YESTERDAY's full-day absolute values into
  // the SAME response as today's realtime values, so a today-vs-yesterday
  // comparison needs no historical backfill. Null when the endpoint did not
  // return the field.
  /** Yesterday GMV (absolute) */
  gmv_compare_value: number | null;
  /** Yesterday orders (absolute) */
  orders_compare_value: number | null;
  /** Yesterday shop visitors (absolute) */
  shop_visitors_compare_value: number | null;
  /** Yesterday shop conversion rate (absolute) */
  shop_conversion_rate_compare_value: number | null;
}

export interface JdHourlyPoint {
  /** Hour label (e.g. "2026-06-30 14:00:00") */
  hour: string;
  /** GMV for this hour */
  gmv: number;
}

export interface JdProductTopEntry {
  /** JD SKU ID */
  sku_id: string;
  /** Product name (Chinese) */
  name: string;
  /** GMV for this product */
  gmv: number;
  /** Product page URL on JD.com */
  item_url: string;
}

export interface ParsedJdData {
  date: string;
  summary: JdSummary;
  hourly_gmv: JdHourlyPoint[];
  top_products: JdProductTopEntry[];
}

// ---- Parsers ----

const emptySummary = (): JdSummary => ({
  gmv: 0,
  orders: 0,
  customers: 0,
  shop_visitors: 0,
  shop_conversion_rate: 0,
  product_visitors: 0,
  industry_conversion_rate: 0,
  gmv_compare_pct: null,
  orders_compare_pct: null,
  shop_visitors_compare_pct: null,
  product_visitors_compare_pct: null,
  shop_conversion_rate_compare_pct: null,
  industry_conversion_rate_compare_pct: null,
  gmv_compare_value: null,
  orders_compare_value: null,
  shop_visitors_compare_value: null,
  shop_conversion_rate_compare_value: null,
});

/**
 * Parse a JD summary API response into structured metrics.
 * Handles both raw indicator keys and already-mapped canonical keys.
 *
 * P0010.2.9: Shop-level (shop_visitors / shop_conversion_rate) is the
 * primary for trade.overview; product / industry level is preserved.
 */
export const parseJdSummary = (
  responses: unknown[],
): JdSummary => {
  for (const resp of responses) {
    if (!isJdApiResponse(resp)) continue;
    const data = (resp as JdApiResponse).body?.data;
    if (!Array.isArray(data) || data.length === 0) continue;

    const row = mapJdDataRow(data[0]!);
    return {
      gmv: asNum(row['gmv']),
      orders: asNum(row['orders']),
      customers: asNum(row['customers']),
      shop_visitors: asNum(row['shop_visitors']),
      shop_conversion_rate: asNum(row['shop_conversion_rate']),
      product_visitors: asNum(row['product_visitors']),
      industry_conversion_rate: asNum(row['industry_conversion_rate']),
      gmv_compare_pct: asNumOrNull(row['gmv_compare_pct']),
      orders_compare_pct: asNumOrNull(row['orders_compare_pct']),
      shop_visitors_compare_pct: asNumOrNull(row['shop_visitors_compare_pct']),
      product_visitors_compare_pct: asNumOrNull(row['product_visitors_compare_pct']),
      shop_conversion_rate_compare_pct: asNumOrNull(row['shop_conversion_rate_compare_pct']),
      industry_conversion_rate_compare_pct: asNumOrNull(row['industry_conversion_rate_compare_pct']),
      gmv_compare_value: asNumOrNull(row['gmv_compare_value']),
      orders_compare_value: asNumOrNull(row['orders_compare_value']),
      shop_visitors_compare_value: asNumOrNull(row['shop_visitors_compare_value']),
      shop_conversion_rate_compare_value: asNumOrNull(row['shop_conversion_rate_compare_value']),
    };
  }
  return emptySummary();
};

/**
 * Parse a JD trend API response into hourly data points.
 */
export const parseJdTrend = (
  responses: unknown[],
): JdHourlyPoint[] => {
  for (const resp of responses) {
    if (!isJdApiResponse(resp)) continue;
    const data = (resp as JdApiResponse).body?.data;
    if (!Array.isArray(data)) continue;

    return data.map((h) => {
      const row = mapJdDataRow(h);
      return {
        hour: String(row['dt'] ?? row['hour'] ?? ''),
        gmv: asNum(row['gmv']),
      };
    });
  }
  return [];
};

/**
 * Parse a JD productTop API response into product rankings.
 */
export const parseJdProductTop = (
  responses: unknown[],
): JdProductTopEntry[] => {
  for (const resp of responses) {
    if (!isJdApiResponse(resp)) continue;
    const data = (resp as JdApiResponse).body?.data;
    if (!Array.isArray(data)) continue;

    return data.map((p) => {
      const row = mapJdDataRow(p);
      return {
        sku_id: String(row['sku_id'] ?? ''),
        name: String(row['sku_id#name_cn'] ?? row['name'] ?? ''),
        gmv: asNum(row['gmv']),
        item_url: String(row['sku_id_item_url'] ?? row['item_url'] ?? ''),
      };
    });
  }
  return [];
};

/**
 * Parse a complete JD payload (summary + trend + productTop).
 * Accepts either the raw API response arrays or a pre-grouped payload object.
 */
export const parseJdPayload = (
  raw: Record<string, unknown>,
): ParsedJdData => {
  const date = String(raw['date'] ?? new Date().toISOString().slice(0, 10));

  const summaryResponses = asArray(raw['summary']);
  const trendResponses = asArray(raw['trend']);
  const productTopResponses = asArray(raw['productTop']);

  return {
    date,
    summary: parseJdSummary(summaryResponses.length > 0 ? summaryResponses : [raw]),
    hourly_gmv: parseJdTrend(trendResponses.length > 0 ? trendResponses : [raw]),
    top_products: parseJdProductTop(productTopResponses.length > 0 ? productTopResponses : [raw]),
  };
};

// ---- Helpers ----

const asNum = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

const asNumOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const asArray = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  return [];
};
