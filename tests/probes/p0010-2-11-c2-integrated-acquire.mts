// P0010.2.11 C2 — integrated acquire verification: run the REAL
// acquireJdTradeOverviewViaCDP (post direct-fetch rewrite) against the live
// Chrome and verify the two envelopes carry today's realtime values and the
// 7-day trend categories.
import { acquireJdTradeOverviewViaCDP } from '../../apps/ecommerce/connectors/jd/acquisition/cdp-client.js';

const result = await acquireJdTradeOverviewViaCDP({ cdpPort: 9222 });
console.log('success:', result.success);
console.log('date:', result.date);
console.log('errors:', JSON.stringify(result.errors ?? null));

const summarize = (resp: unknown) => {
  const r = resp as { header?: { code?: number }; body?: { data?: Array<Record<string, unknown>> } };
  const row = r?.body?.data?.[0] ?? {};
  const pick = (k: string) => {
    const v = row[k];
    return typeof v === 'object' && v !== null ? (v as { value?: unknown }).value : v;
  };
  return {
    code: r?.header?.code,
    gmv: pick('jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot'),
    gmv_compareValue: pick('jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compareValue'),
    orders: pick('jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot'),
    shop_visitors: pick('jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src'),
    shop_cvr: pick('fo_jdr_sch_shop_deal_rate'),
    cvr_compareValue: pick('fo_jdr_sch_shop_deal_rate##compareValue'),
  };
};
console.log('summary[0]:', JSON.stringify(result.summary.map(summarize), null, 1));

const trendOf = (resp: unknown) => {
  const r = resp as { header?: { code?: number }; body?: { data?: Array<{ trend?: { categories?: string[]; series?: Array<{ code: string; data: unknown[] }> } }> } };
  const t = r?.body?.data?.[0]?.trend;
  return {
    code: r?.header?.code,
    categories: t?.categories,
    series: t?.series?.map((s) => ({ code: s.code, n: s.data.length, last: s.data[s.data.length - 1] })),
  };
};
console.log('trend[0]:', JSON.stringify(result.trend.map(trendOf), null, 1));
process.exit(result.success ? 0 : 1);
