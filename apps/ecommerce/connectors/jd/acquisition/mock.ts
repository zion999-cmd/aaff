// Mock JD data provider for development and testing.
// Returns sample JD 商智 data in the same shape as the CDP live capture.
// Ported from agentCMS data/daily_records.json pattern.

import type { ParsedJdData } from '../parsers/index.js';

/** Mock JD payload that mimics a CDP capture. */
export interface MockJdPayload {
  shopName: string;
  shopId: string;
  capturedAt: string;
  /** Business date this payload represents (YYYY-MM-DD). P0005 fix. */
  date: string;
  summary: unknown[];
  trend: unknown[];
  productTop: unknown[];
  /** Product analysis endpoint (captured by CDP steady-state). */
  getProductAnalysisData?: unknown[];
}

/**
 * Build a mock single-day JD payload.
 * Uses realistic data from 祁门红茶官方旗舰店.
 */
export const mockJdPayload = (date?: string): MockJdPayload => {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return {
    shopName: '祁门红茶官方旗舰店',
    shopId: 'jd_shop_001',
    capturedAt: new Date().toISOString(),
    date: d,
    summary: [buildMockSummaryResponse(d)],
    trend: [buildMockTrendResponse(d)],
    productTop: [buildMockProductTopResponse(d)],
  };
};

/**
 * Build mock payloads for a date range.
 */
export const mockJdPayloads = (
  fromDate: string,
  toDate: string,
): MockJdPayload[] => {
  const payloads: MockJdPayload[] = [];
  const start = new Date(fromDate);
  const end = new Date(toDate);
  for (let d = start; d <= end; d.setDate(d.getDate() + 1)) {
    payloads.push(mockJdPayload(d.toISOString().slice(0, 10)));
  }
  return payloads;
};

/**
 * Convert a mock payload into parsed JD data (same shape as parser output).
 */
export const mockJdData = (date?: string): ParsedJdData => {
  const d = date ?? new Date().toISOString().slice(0, 10);
  return {
    date: d,
    summary: {
      gmv: 4626.0 + Math.round(Math.random() * 3000),
      orders: 35 + Math.round(Math.random() * 25),
      customers: 42 + Math.round(Math.random() * 30),
      // P0010.2.9 — shop-level (primary for trade.overview)
      shop_visitors: 750 + Math.round(Math.random() * 400),
      shop_conversion_rate: 0.05 + Math.random() * 0.04,
      // Product / industry level (preserved for other capabilities)
      product_visitors: 820 + Math.round(Math.random() * 300),
      industry_conversion_rate: 0.05 + Math.random() * 0.04,
      // WoW percentages
      gmv_compare_pct: Math.round((Math.random() * 0.4 - 0.2) * 100) / 100,
      orders_compare_pct: Math.round((Math.random() * 0.4 - 0.2) * 100) / 100,
      shop_visitors_compare_pct: Math.round((Math.random() * 0.3 - 0.1) * 100) / 100,
      product_visitors_compare_pct: Math.round((Math.random() * 0.2 - 0.05) * 100) / 100,
      shop_conversion_rate_compare_pct: Math.round((Math.random() * 0.2 - 0.05) * 100) / 100,
      industry_conversion_rate_compare_pct: Math.round((Math.random() * 0.2 - 0.05) * 100) / 100,
    },
    hourly_gmv: Array.from({ length: 24 }, (_, i) => ({
      hour: `${d} ${String(i).padStart(2, '0')}:00:00`,
      gmv: i >= 8 && i <= 22 ? Math.round(Math.random() * 800 + 100) : Math.round(Math.random() * 100),
    })),
    top_products: [
      { sku_id: '10072457189341', name: '祁门红茶特级', gmv: 1850, item_url: 'https://item.jd.com/10072457189341.html' },
      { sku_id: '10072457189342', name: '祁门红茶一级', gmv: 1240, item_url: 'https://item.jd.com/10072457189342.html' },
      { sku_id: '10072457189343', name: '祁门红茶礼盒装', gmv: 890, item_url: 'https://item.jd.com/10072457189343.html' },
      { sku_id: '10072457189344', name: '祁门红茶散装', gmv: 520, item_url: 'https://item.jd.com/10072457189344.html' },
      { sku_id: '10072457189345', name: '祁门红茶小罐装', gmv: 340, item_url: 'https://item.jd.com/10072457189345.html' },
    ],
  };
};

// ---- Private helpers: build mock JD API response envelopes ----

const buildMockSummaryResponse = (_date: string): unknown => ({
  header: { code: 0, desc: 'success' },
  body: {
    data: [{
      jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot: 4626 + Math.round(Math.random() * 2000),
      jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot: 35 + Math.round(Math.random() * 20),
      jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot: 45 + Math.round(Math.random() * 25),
      // P0010.2.9 — shop-level (the live page values)
      jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src: 750 + Math.round(Math.random() * 400),
      fo_jdr_sch_shop_deal_rate: 0.05 + Math.random() * 0.04,
      // Product / industry level (preserved for other capabilities)
      jdr_sch_traffic_brow_sku__page_cnt_traffic_plat_item_di_sz_bsg: 820 + Math.round(Math.random() * 300),
      fo_jdr_sch_industry_deal_rate: 0.05 + Math.random() * 0.04,
      // WoW percentages
      'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compare': Math.round((Math.random() * 0.3 - 0.1) * 100) / 100,
      'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compare': Math.round((Math.random() * 0.3 - 0.1) * 100) / 100,
      'jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src##compare': Math.round((Math.random() * 0.2 - 0.05) * 100) / 100,
      'fo_jdr_sch_shop_deal_rate##compare': Math.round((Math.random() * 0.2 - 0.05) * 100) / 100,
      'jdr_sch_traffic_brow_sku__page_cnt_traffic_plat_item_di_sz_bsg##compare': Math.round((Math.random() * 0.2 - 0.05) * 100) / 100,
      'fo_jdr_sch_industry_deal_rate##compare': Math.round((Math.random() * 0.2 - 0.05) * 100) / 100,
    }],
  },
});

const buildMockTrendResponse = (date: string): unknown => ({
  header: { code: 0, desc: 'success' },
  body: {
    data: Array.from({ length: 24 }, (_, i) => ({
      dt: `${date} ${String(i).padStart(2, '0')}:00:00`,
      jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot:
        i >= 8 && i <= 22 ? Math.round(Math.random() * 800 + 100) : Math.round(Math.random() * 100),
    })),
  },
});

const buildMockProductTopResponse = (_date: string): unknown => ({
  header: { code: 0, desc: 'success' },
  body: {
    data: [
      { sku_id: '10072457189341', 'sku_id#name_cn': '祁门红茶特级', jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot: 1850, sku_id_item_url: 'https://item.jd.com/10072457189341.html' },
      { sku_id: '10072457189342', 'sku_id#name_cn': '祁门红茶一级', jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot: 1240, sku_id_item_url: 'https://item.jd.com/10072457189342.html' },
      { sku_id: '10072457189343', 'sku_id#name_cn': '祁门红茶礼盒装', jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot: 890, sku_id_item_url: 'https://item.jd.com/10072457189343.html' },
    ],
  },
});
