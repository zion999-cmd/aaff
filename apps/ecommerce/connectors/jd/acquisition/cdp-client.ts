// CDP-based JD data acquisition client — ported from agentCMS jd_historical_api.ts.
//
// Technique:
//   1. Connect to Chrome via CDP (port 9222) where user is already logged into sz.jd.com
//   2. Intercept the SPA's own API calls via page.route() + route.continue()
//   3. Modify POST body date fields while preserving original CSRF headers
//   4. Walk through dates one by one, waiting for SPA's natural polling cycle
//   5. Capture responses, save to Evidence Store
//
// This is NOT a standalone scraper. It requires a pre-authenticated Chrome session.
// The user logs into 京东商智 once in Chrome, then this script reuses that session.

import type { MockJdPayload } from './mock.js';
import { resolveTradeOverviewBusinessDate } from './trade-overview-date.js';

// ---- Minimal Playwright CDP types (avoids depending on @types/playwright-core) ----

interface CdpPage {
  url(): string;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
  reload(opts?: { waitUntil?: string }): Promise<void>;
  on(event: 'response', handler: (response: CdpResponse) => void): void;
  off(event: 'response', handler: (response: CdpResponse) => void): void;
  route(url: string, handler: (route: CdpRoute) => Promise<void>): Promise<void>;
  unroute(url: string): Promise<void>;
  /** P0005.3: Click an element by text content or selector */
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  /** P0005.3: Wait for a selector to appear in the DOM */
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<void>;
  /** P0005.3: Execute JavaScript in the page context */
  evaluate<T>(fn: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>;
}

interface CdpResponse {
  url(): string;
  status(): number;
  text(): Promise<string>;
}

interface CdpRoute {
  request(): { url(): string; postDataJSON(): unknown | null };
  continue(opts?: { postData?: string }): Promise<void>;
}

interface CdpBrowser {
  contexts(): Array<{ pages(): CdpPage[] }>;
  close(): Promise<void>;
}

interface PlaywrightCore {
  chromium: { connectOverCDP(wsUrl: string): Promise<CdpBrowser> };
}

// ---- Types ----

export interface CdpAcquireOptions {
  /** Chrome CDP port (default: 9222) */
  cdpPort?: number;
  /** Start date (ISO, default: 30 days ago) */
  fromDate?: string;
  /** End date (ISO, default: yesterday) */
  toDate?: string;
  /** Optional: API endpoint names to capture (from blueprint). When absent, defaults to all known endpoints. */
  endpointFilter?: string[];
}

export interface CdpAcquireResult {
  success: boolean;
  payloads?: MockJdPayload[];
  errors?: string[];
  cdpAvailable: boolean;
}

// ---- Multi-Page Discovery Types ----

export interface JdPageSpec {
  id: string;
  name: string;
  url: string;
}

export interface PageDiscoveryResult {
  page: JdPageSpec;
  success: boolean;
  payload?: MockJdPayload;
  apiCount: number;
  error?: string;
}

export interface MultiPageResult {
  success: boolean;
  pagesVisited: number;
  pagesWithData: number;
  results: PageDiscoveryResult[];
  errors: string[];
}

interface CapturedCall {
  api: string;
  date: string;
  data: unknown;
}

// ---- Implementation ----

/** Check if Chrome CDP is reachable. */
export const isCdpAvailable = async (port = 9222): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
};

/** Get the WebSocket URL from Chrome CDP. */
const getWsUrl = async (port: number): Promise<string | null> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
};

/**
 * Check whether a 京东商智 (sz.jd.com) page is open in Chrome — the real
 * data-source readiness signal. `isCdpAvailable` only confirms the Chrome
 * remote-debugging port is reachable; it does NOT mean a JD page is open (and
 * therefore that the operator is logged in).
 *
 * Read-only probe: connects to Chrome, lists pages, then closes. It never
 * launches Chrome, opens a tab, or acquires data.
 */
export const isJdPageAvailable = async (port = 9222): Promise<boolean> => {
  if (!(await isCdpAvailable(port))) return false;

  let playwright: PlaywrightCore;
  try {
    playwright = (await import(String('playwright-core'))) as unknown as PlaywrightCore;
  } catch {
    return false;
  }

  const wsUrl = await getWsUrl(port);
  if (!wsUrl) return false;

  let browser: CdpBrowser;
  try {
    browser = await playwright.chromium.connectOverCDP(wsUrl);
  } catch {
    return false;
  }

  try {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().includes('sz.jd.com')) return true;
      }
    }
    return false;
  } finally {
    await browser.close().catch(() => {});
  }
};

/** Build date list between fromDate and toDate (inclusive). */
const buildDateRange = (fromDate: string, toDate: string): string[] => {
  const dates: string[] = [];
  const start = new Date(fromDate);
  const end = new Date(toDate);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
};

/**
 * Acquire JD 商智 data via CDP — the real thing.
 *
 * Prerequisites:
 *   - Chrome running with: --remote-debugging-port=9222
 *   - A tab open at https://sz.jd.com/ with an active login session
 *
 * How it works:
 *   The JD 商智 SPA polls its backend API every ~9 seconds with dateType='todayRealtime'.
 *   We intercept those calls via page.route(), modify the POST body to request historical
 *   dates, and capture the responses. The SPA's original CSRF headers (user-mnp, user-mup,
 *   uuid) pass through unchanged via route.continue().
 */
export const acquireJdViaCDP = async (
  options: CdpAcquireOptions = {},
): Promise<CdpAcquireResult> => {
  const { cdpPort = 9222 } = options;

  // 1. Check CDP availability
  const available = await isCdpAvailable(cdpPort);
  if (!available) {
    return {
      success: false,
      errors: [`Chrome CDP not available on port ${cdpPort}. Start Chrome with --remote-debugging-port=${cdpPort}`],
      cdpAvailable: false,
    };
  }

  // 2. Load playwright-core dynamically (optional dependency)
  let playwright: PlaywrightCore;
  try {
    playwright = await import(String('playwright-core')) as unknown as PlaywrightCore;
  } catch {
    return {
      success: false,
      errors: ['playwright-core is not installed. Run: npm install playwright-core'],
      cdpAvailable: true,
    };
  }

  // 3. Connect to Chrome
  const wsUrl = await getWsUrl(cdpPort);
  if (!wsUrl) {
    return { success: false, errors: ['Could not get CDP WebSocket URL'], cdpAvailable: true };
  }

  let browser: CdpBrowser;
  try {
    browser = await playwright.chromium.connectOverCDP(wsUrl);
  } catch (err) {
    return {
      success: false,
      errors: [`CDP connect failed: ${err instanceof Error ? err.message : String(err)}`],
      cdpAvailable: true,
    };
  }

  // 4. Find the 商智 page
  let targetPage: CdpPage | undefined;
  const allPages: CdpPage[] = [];
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      allPages.push(p);
      const url = p.url();
      // Prefer the 商智 home page (has indexSummary or index/home)
      if (url.includes('sz.jd.com') && (url.includes('indexSummary') || url.includes('index/home'))) {
        targetPage = p;
        break;
      }
    }
  }
  // Fallback: any sz.jd.com page
  if (!targetPage) {
    targetPage = allPages.find((p) => p.url().includes('sz.jd.com'));
  }

  if (!targetPage) {
    await browser.close().catch(() => {});
    return {
      success: false,
      errors: ['No 京东商智 page found in Chrome. Open https://sz.jd.com/ and log in first.'],
      cdpAvailable: true,
    };
  }

  console.log(`[CDP] Using page: ${targetPage.url().slice(0, 80)}`);

  // P0005: Reload page to ensure SPA is actively polling. JD 商智 SPA stops
  // polling after idle. A reload triggers fresh initialization + polling cycle.
  try {
    await targetPage.reload({ waitUntil: 'domcontentloaded' });
    console.log(`[CDP] Page reloaded`);
  } catch {
    // Non-fatal: continue even if reload fails (older playwright versions)
  }

  // 5. Build date range (default: last 30 days)
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const fromDate = options.fromDate ?? thirtyDaysAgo.toISOString().slice(0, 10);
  const toDate = options.toDate ?? yesterday.toISOString().slice(0, 10);
  const dates = buildDateRange(fromDate, toDate);

  // Default JD API endpoints — overridden by blueprint endpointFilter when provided.
  const DEFAULT_JD_APIS = ['summary', 'trend', 'productTop', 'getProductAnalysisData', 'getFlowAnalysisData'];
  const effectiveApis = options.endpointFilter ?? DEFAULT_JD_APIS;
  const apiSet = new Set(effectiveApis);

  console.log(`[CDP] Will fetch ${dates.length} dates (${fromDate} ~ ${toDate})`);
  if (dates.length === 0) {
    await browser.close().catch(() => {});
    return { success: false, errors: ['Empty date range'], cdpAvailable: true };
  }

  // 6. Set up capture
  const capturedCalls: CapturedCall[] = [];
  // P0005 fix: capture date at handler entry to avoid race with loop increment.
  let processingDate = '';

  // Capture responses
  targetPage.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('szgateway.jd.com/api/lowcode/')) return;

    const apiName = url.split('/').pop()?.split('?')[0]?.replace('.ajax', '') || '';
    if (!apiSet.has(apiName)) return;

    try {
      const body = await response.text();
      const parsed = JSON.parse(body) as { header?: { code: number; desc?: string }; body?: unknown };
      if (parsed?.header?.code === 0) {
        capturedCalls.push({
          api: apiName,
          date: processingDate || dates[0] || '',
          data: parsed,
        });
      }
    } catch {
      // Ignore parse errors on non-JSON responses
    }
  });

  // Intercept and modify API requests — replace date fields in POST body
  await targetPage.route('**/szgateway.jd.com/api/lowcode/**', async (route) => {
    const request = route.request();
    const url = request.url();
    const apiName = url.split('/').pop()?.split('?')[0]?.replace('.ajax', '') || '';
    if (!apiSet.has(apiName)) {
      await route.continue();
      return;
    }

    try {
      const postData = request.postDataJSON() as Record<string, unknown> | null;
      if (!postData || postData.dateType !== 'todayRealtime') {
        await route.continue();
        return;
      }

      const dateStr = processingDate;
      if (!dateStr) {
        await route.continue();
        return;
      }

      // Calculate compare date (same day last week)
      const d = new Date(dateStr);
      d.setDate(d.getDate() - 7);
      const compareDate = d.toISOString().slice(0, 10);

      const modified = {
        ...postData,
        startDate: `${dateStr} 00:00:00`,
        endDate: `${dateStr} 23:59:59`,
        compareStartDate: `${compareDate} 00:00:00`,
        compareEndDate: `${compareDate} 23:59:59`,
      };

      await route.continue({ postData: JSON.stringify(modified) });
    } catch {
      await route.continue();
    }
  });

  // 7. Walk through dates — wait for SPA's natural polling cycle (~10s per date)
  const errors: string[] = [];
  for (let i = 0; i < dates.length; i++) {
    processingDate = dates[i]!;  // P0005 fix: set before wait, captured by response handler
    if (i % 10 === 0) {
      console.log(`[CDP] ${i + 1}/${dates.length}: ${dates[i]}...`);
    }

    try {
      // Wait for the SPA to make its polling request (with our modified date)
      await new Promise((resolve) => setTimeout(resolve, 10000));
    } catch (err) {
      errors.push(`${dates[i]}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 8. Clean up
  await targetPage.unroute('**/szgateway.jd.com/api/lowcode/**');
  await browser.close().catch(() => {});

  console.log(`[CDP] Captured ${capturedCalls.length} API responses`);

  // 9. Group captured calls into daily payloads
  const byDate = new Map<string, Map<string, unknown[]>>();
  for (const call of capturedCalls) {
    if (!byDate.has(call.date)) byDate.set(call.date, new Map());
    const dateMap = byDate.get(call.date)!;
    if (!dateMap.has(call.api)) dateMap.set(call.api, []);
    dateMap.get(call.api)!.push(call.data);
  }

  const payloads: MockJdPayload[] = [];
  for (const [date, apiMap] of byDate.entries()) {
    const productAnalysis = apiMap.get('getProductAnalysisData');
    payloads.push({
      shopName: '京东店铺',
      shopId: 'jd_shop_001',
      capturedAt: new Date().toISOString(),
      date,  // P0005 fix: preserve the date that was captured
      summary: apiMap.get('summary') ?? [],
      trend: apiMap.get('trend') ?? [],
      productTop: apiMap.get('productTop') ?? [],
      ...(productAnalysis ? { getProductAnalysisData: productAnalysis } : {}),
    });
  }

  const result: CdpAcquireResult = {
    success: payloads.length > 0,
    payloads,
    cdpAvailable: true,
  };
  if (errors.length > 0) result.errors = errors;
  return result;
};

// ---- Trade Overview (P0010.2.9 / P0010.2.11) ----
//
// trade.overview is the live 经营概览 page. It calls the lowcode endpoints
// `tradeSummary/summary/getSummary.ajax` + `getTrend.ajax` — NOT the snapshot
// `indexSummary/summary.ajax` that the historical walker uses.
//
// P0010.2.11 — DIRECT FETCH (replaces the dead UI-interaction path):
// the page gates its own boot fetches behind a lazyLoad visibility guard
// (module 6611 `zN` / `window[Symbol('lazyLoad')]`), so in a background tab
// NOTHING fires — not even the SPA's own boot requests. UI clicks (echo →
// 实时 chip → 查询) were equally unreliable. The verified approach bypasses
// both: hijack the page's webpack require, call the page's OWN signed ajax
// helper (module 99859 `Fe`) with params built by the page's own date-param
// builder (module 4461 `jD.SzDPParams` + module 22886 `M` trendParams), and
// read the envelopes straight out of the evaluate return value. Signing,
// cookies and `__sgm__` are all handled by the page's own transport — we
// never forge headers.
//
// Two requests, each with a single purpose (no mode ambiguity):
//   1. realtime getSummary  → summary[0]  (today intraday + ##compareValue
//      yesterday-same-time baseline — the daily observation, business_date=today)
//   2. offline (yesterday) getTrend → trend[0] (7 daily categories — the
//      近7天 data the /fabric/trade-trend route reads from payload[0])

export interface TradeOverviewAcquireOptions {
  /** Chrome CDP port (default: 9222) */
  cdpPort?: number;
  /**
   * Target date (ISO). MUST be the current Beijing business day — the
   * direct-fetch transport always returns realtime data for today, so any
   * other date is rejected (fail-closed) instead of being stamped onto a
   * realtime payload (C2.0 invariant). Default: today (Beijing).
   */
  date?: string;
  /** Max wait time for both responses (default: 15_000 ms) */
  maxWaitMs?: number;
}

export interface TradeOverviewAcquireResult {
  success: boolean;
  date: string;
  summary: unknown[];
  trend: unknown[];
  errors?: string[];
  cdpAvailable: boolean;
}

/** Shape resolved by the in-page direct-fetch script ({@link buildTradeOverviewDirectFetchExpr}). */
// ---- Cross-day freshness guard helpers (P0010.2.11 follow-up) ----

/** Beijing (UTC+8) today as 'YYYY-MM-DD'. Independent of `beijingDate` in
 *  shared/utils/time to avoid a circular dependency from cdp-client → time. */
export const beijingTodayISO = (now: Date = new Date()): string =>
  new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** The 'yesterday' value the tradeSummary date picker SHOULD currently
 *  resolve to (Beijing today - 1 day, as YYYY-MM-DD). Page freezes this at
 *  SPA boot, so a long-running tab crossing Beijing midnight keeps the
 *  stale value and the getTrend 7-day categories shift by 1 day. */
export const expectedPageYesterday = (now: Date = new Date()): string => {
  const today = beijingTodayISO(now);
  const y = new Date(`${today}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  return y.toISOString().slice(0, 10);
};

/** In-page probe: walk the React fiber from the date picker's echo span
 *  to the picker component, read the 'yesterday' quick item's resolved
 *  value, and return it as YYYY-MM-DD. Returns `{ ok: false, error }` on any
 *  failure (component not found, item not found, value not a date). */
export const buildReadPageYesterdayExpr = (): string => `
  (function(){
    var spans = document.querySelectorAll('span.jmt-combo-date-picker-echo-item');
    if (!spans.length) return { ok: false, error: 'date picker echo not found' };
    var echo = spans[0];
    var fk = Object.keys(echo).find(function(k){return k.indexOf('__reactFiber')===0;});
    if (!fk) return { ok: false, error: 'react fiber key not found' };
    var f = echo[fk];
    var picker = null;
    for (var i=0;i<20 && f;i++,f = f.return) {
      if (f.memoizedProps && f.memoizedProps.data) { picker = f.memoizedProps; break; }
    }
    if (!picker) return { ok: false, error: 'picker component not found' };
    var items = picker.data.dimVals || picker.data;
    var y = null;
    for (var j=0;j<items.length;j++) if (items[j] && items[j].key === 'yesterday') { y = items[j]; break; }
    if (!y) return { ok: false, error: 'yesterday quick item not found' };
    var v = typeof y.value === 'function' ? y.value(y) : y.value;
    if (typeof v !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(v)) return { ok: false, error: 'yesterday value not YYYY-MM-DD' };
    return { ok: true, yesterday: v };
  })()
`;

interface TradeOverviewDirectFetchResult {
  ok: boolean;
  errors?: string[];
  realtimeParams?: unknown;
  offlineTrendParams?: unknown;
  summary?: unknown;
  trend?: unknown;
}

/**
 * A JD lowcode response envelope that the endpoint actually accepted:
 * `{ header: { code: 0 }, body: ... }` — the same filter the old
 * Network-listener capture applied before pushing into `captured`.
 */
const isTradeOverviewEnvelope = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const header = (value as { header?: { code?: unknown } }).header;
  return typeof header === 'object' && header !== null && header.code === 0
    && typeof (value as { body?: unknown }).body !== 'undefined';
};

const TRADE_OVERVIEW_URL = 'https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html';

// Boot (昨天-mode) indicator list captured 2026-08-29 from the page's own
// boot getSummary request — every shop-level indicator plus its
// ##compareValue / ##compare / ##industry / ##preIndustry variants.
const TRADE_SUMMARY_BOOT_INDICATORS: readonly string[] = Object.freeze([
  'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot',
  'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compareValue',
  'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compare',
  'jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##industry',
  'jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##preIndustry',
  'jdr_sch_trade_deal_ord_sku_qtty_sz_trade_deal_snapshot',
  'jdr_sch_trade_deal_ord_sku_qtty_sz_trade_deal_snapshot##compareValue',
  'jdr_sch_trade_deal_ord_sku_qtty_sz_trade_deal_snapshot##compare',
  'jdr_sch_trade_deal_ord_sku_qtty_sz_trade_shop_cate_and_level_snapshot##industry',
  'jdr_sch_trade_deal_ord_sku_qtty_sz_trade_shop_cate_and_level_snapshot##preIndustry',
  'jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot',
  'jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot##compareValue',
  'jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot##compare',
  'jdr_sch_user_deal_ord_user_cnt_sz_shop_cate_and_level_user_deal_snapshot##industry',
  'jdr_sch_user_deal_ord_user_cnt_sz_shop_cate_and_level_user_deal_snapshot##preIndustry',
  'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot',
  'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compareValue',
  'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compare',
  'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_shop_cate_and_level_snapshot##industry',
  'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_shop_cate_and_level_snapshot##preIndustry',
  'fo_jdr_sch_shop_deal_rate',
  'fo_jdr_sch_shop_deal_rate##compareValue',
  'fo_jdr_sch_shop_deal_rate##compare',
  'fo_jdr_sch_trade_deal_ord_amt_user_sz_trade_deal_snapshot',
  'fo_jdr_sch_trade_deal_ord_amt_user_sz_trade_deal_snapshot##compareValue',
  'fo_jdr_sch_trade_deal_ord_amt_user_sz_trade_deal_snapshot##compare',
  'fo_jdr_sch_sz_trade_shop_cate_and_level_deal_snapshot##industry',
  'fo_jdr_sch_sz_trade_shop_cate_and_level_deal_snapshot##preIndustry',
  'jdr_sch_traffic_enter_shop__browse_page_qtty_shop_last_src',
  'jdr_sch_traffic_enter_shop__browse_page_qtty_shop_last_src##compareValue',
  'jdr_sch_traffic_enter_shop__browse_page_qtty_shop_last_src##compare',
  'jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src',
  'jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src##compareValue',
  'jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src##compare',
  'fo_jdr_sch_traffic_enter_shop__browse_page_avg_duration_shop_last_src',
  'fo_jdr_sch_traffic_enter_shop__browse_page_avg_duration_shop_last_src##compareValue',
  'fo_jdr_sch_traffic_enter_shop__browse_page_avg_duration_shop_last_src##compare',
  'jdr_sch_sku_add_cart_sku_user_qtty_product_user_cart_add_minus_sz_bsg_shoppingcart@increase',
  'jdr_sch_sku_add_cart_sku_user_qtty_product_user_cart_add_minus_sz_bsg_shoppingcart@increase##compareValue',
  'jdr_sch_sku_add_cart_sku_user_qtty_product_user_cart_add_minus_sz_bsg_shoppingcart@increase##compare',
  'jdr_sch_sku_add_cart_sku_sku_piece_shopping_cart',
  'jdr_sch_sku_add_cart_sku_sku_piece_shopping_cart##compareValue',
  'jdr_sch_sku_add_cart_sku_sku_piece_shopping_cart##compare',
  'fo_jdr_sch_add_cart_user_uv_rate@increase',
  'fo_jdr_sch_add_cart_user_uv_rate@increase##compareValue',
  'fo_jdr_sch_add_cart_user_uv_rate@increase##compare',
]);

// The 4 canonical trend indicators (GMV / orders / shop visitors / shop CVR)
// — the series the 近7天 table renders.
const TRADE_SUMMARY_TREND_INDICATORS: readonly string[] = Object.freeze([
  'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot',
  'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot',
  'jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src',
  'fo_jdr_sch_shop_deal_rate',
]);

const ONE_DAY_MS = 86_400_000;

/**
 * Build the in-page direct-fetch script (P0010.2.11).
 *
 * Runs inside the tradeSummary SPA context. Returns a string expression
 * (an async IIFE) so it can go through `page.evaluate` without any closure
 * serialization: the indicator lists are embedded via JSON.
 *
 * The expressione resolves to
 * `{ ok: true, realtimeParams, offlineTrendParams, summary, trend }` or
 * `{ ok: false, errors: [...] }`. `summary` is the realtime getSummary
 * envelope; `trend` is the offline (昨天-mode) getTrend envelope with 7
 * daily categories.
 */
export const buildTradeOverviewDirectFetchExpr = (
  bootIndicators: readonly string[],
  trendIndicators: readonly string[],
): string => `(
async (cfg) => {
  const fail = (msg) => ({ ok: false, errors: [msg] });
  try {
    // 1. Hijack the page's webpack require (unique chunk id per call).
    if (typeof window.__wr !== 'function') {
      window.webpackChunksz_2024.push(
        [[Math.floor(Math.random() * 1e9)], {}, (r) => { window.__wr = r; }],
      );
    }
    if (typeof window.__wr !== 'function') return fail('webpack require hijack failed');
    const ajax = window.__wr(99859);
    const jD = window.__wr(4461).jD;
    const trendM = window.__wr(22886).M;
    if (!ajax || !jD || !trendM) return fail('page modules 99859/4461/22886 not resolvable');

    // 2. Walk the React fiber from the picker echo span up to the page
    //    component (the one holding picker data + a 7s refresh interval).
    const echo = document.querySelector('span.jmt-combo-date-picker-echo-item');
    if (!echo) return fail('date picker echo span not found (SPA not loaded?)');
    const fiberKey = Object.keys(echo).find((k) => k.startsWith('__reactFiber$'));
    if (!fiberKey) return fail('React fiber key not found on echo span');
    let fiber = echo[fiberKey];
    let comp = null;
    for (let i = 0; i < 10 && fiber; i++) {
      const pp = fiber.memoizedProps;
      if (pp && pp.onChange && pp.data && pp.refreshInterval === 7000) { comp = fiber; break; }
      fiber = fiber.return;
    }
    if (!comp) return fail('page component (refreshInterval=7000) not found in fiber tree');
    const picker = comp.memoizedProps;
    const items = picker.data.dimVals || picker.data;
    const M = items.reduce((acc, it) => {
      if (it && it.key) acc[it.key] = { min: it.min, max: it.max };
      return acc;
    }, {});

    // 3. Realtime (today) getSummary params — the verified construction:
    //    resolve the todayRealtime option's value/compareValue functions,
    //    then let the page's own SzDPParams produce the signed body.
    const rt = items.find((it) => it && it.key === 'realtime');
    if (!rt) return fail("picker item 'realtime' not found");
    const rtOpt = rt.config.panels[0].options[0];
    const rtResolved = rtOpt.value(rtOpt);
    const rtHb = (rtOpt.comparesMap || {}).hb;
    if (!rtHb) return fail("realtime option has no 'hb' compare");
    const rtHbResolved = typeof rtHb.value === 'function' ? rtHb.value(rtResolved) : rtHb.value;
    const rtValue = {
      key: 'realtime',
      value: Object.assign({}, rtOpt, { value: rtResolved }),
      compareValue: Object.assign({}, rtHb, { value: rtHbResolved }),
    };
    const realtimeParams = jD.SzDPParams(rtValue, M);

    // 4. Offline (昨天) getTrend params — deterministic construction from the
    //    'yesterday' quick item (independent of the picker's current mode).
    const y = items.find((it) => it && it.key === 'yesterday');
    if (!y) return fail("picker item 'yesterday' not found");
    const yResolved = typeof y.value === 'function' ? y.value(y) : y.value;
    if (typeof yResolved !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(yResolved)) {
      return fail('yesterday item did not resolve to a YYYY-MM-DD date');
    }
    const yDayBefore = new Date(
      new Date(yResolved + 'T00:00:00Z').getTime() - ${ONE_DAY_MS},
    ).toISOString().slice(0, 10);
    const yValue = {
      key: 'yesterday',
      value: Object.assign({}, y, { value: yResolved }),
      compareValue: Object.assign({}, y.comparesMap.hb, { value: yDayBefore }),
    };
    const offlineTrendParams = trendM(jD.SzDPParams(yValue, M), 6);

    // 5. Fire both requests through the page's own signed transport.
    const summaryResp = await ajax.Fe({
      url: '/api/lowcode/tradeSummary/summary/getSummary.ajax',
      method: 'post',
      data: Object.assign({}, realtimeParams, { channel: 'all', indicators: cfg.bootIndicators }),
    });
    const trendResp = await ajax.Fe({
      url: '/api/lowcode/tradeSummary/summary/getTrend.ajax',
      method: 'post',
      data: Object.assign({}, offlineTrendParams, { channel: 'all', indicators: cfg.trendIndicators }),
    });
    return { ok: true, realtimeParams, offlineTrendParams, summary: summaryResp, trend: trendResp };
  } catch (e) {
    return fail(String((e && e.message) || e));
  }
})(${JSON.stringify({ bootIndicators: [...bootIndicators], trendIndicators: [...trendIndicators] })})`;

/**
 * Acquire trade.overview via the live 经营概览 page (P0010.2.11 direct fetch).
 *
 * The page gates its own boot fetches behind a lazyLoad visibility guard, so
 * in a background tab nothing fires on its own. Instead of UI interaction we
 * call the page's OWN signed ajax helper directly (webpack hijack → module
 * 99859 `Fe`), with request bodies built by the page's own date-param
 * machinery — no body rewrite, no `__sgm__` forgery. Two requests:
 *
 *   - realtime `getSummary.ajax` → `summary[0]` (today intraday + yesterday-
 *     same-time ##compareValue baseline; business_date = today)
 *   - offline (昨天) `getTrend.ajax` → `trend[0]` (7 daily categories — the
 *     近7天 data the /fabric/trade-trend route reads from payload[0])
 *
 * This is a sibling to {@link acquireJdViaCDP} (the multi-day snapshot walker)
 * and {@link acquireJdMultiPage} (the multi-page discovery walker). It is the
 * right tool for `trade.overview`, which is realtime shop-level, not historical.
 */
export const acquireJdTradeOverviewViaCDP = async (
  options: TradeOverviewAcquireOptions = {},
): Promise<TradeOverviewAcquireResult> => {
  const { cdpPort = 9222, maxWaitMs = 15_000 } = options;
  // C2.0 invariant guard — BEFORE any CDP work. The direct-fetch transport
  // always returns the current Beijing business day's realtime data, so a
  // non-today requested date could only produce a poisoned stamp (the
  // 2026-08-22/27/28 evidence corruption). Fail closed with an explicit
  // error instead of ever writing payload-date ≠ metadata.business_date.
  const resolution = resolveTradeOverviewBusinessDate(options.date);
  if (!resolution.ok) {
    return {
      success: false,
      date: resolution.date,
      summary: [],
      trend: [],
      cdpAvailable: true,
      errors: [resolution.error],
    };
  }
  const date = resolution.date;
  const empty = (cdpAvailable: boolean, errors?: string[]): TradeOverviewAcquireResult => ({
    success: false,
    date,
    summary: [],
    trend: [],
    cdpAvailable,
    ...(errors ? { errors } : {}),
  });

  // 1. CDP availability
  const available = await isCdpAvailable(cdpPort);
  if (!available) {
    return empty(false, [
      `Chrome CDP not available on port ${cdpPort}. Start Chrome with --remote-debugging-port=${cdpPort}`,
    ]);
  }

  // 2. Load playwright-core
  let playwright: PlaywrightCore;
  try {
    playwright = (await import(String('playwright-core'))) as unknown as PlaywrightCore;
  } catch {
    return empty(true, ['playwright-core is not installed. Run: npm install playwright-core']);
  }

  // 3. Connect to Chrome
  const wsUrl = await getWsUrl(cdpPort);
  if (!wsUrl) {
    return empty(true, ['Could not get CDP WebSocket URL']);
  }

  let browser: CdpBrowser;
  try {
    browser = await playwright.chromium.connectOverCDP(wsUrl);
  } catch (err) {
    return empty(true, [`CDP connect failed: ${err instanceof Error ? err.message : String(err)}`]);
  }

  let targetPage: CdpPage | undefined;

  try {
    // 4. Find any open JD page (operator must be logged in)
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const url = p.url();
        if (url.includes('jdsz.jd.com') || url.includes('sz.jd.com')) {
          targetPage = p;
          break;
        }
      }
      if (targetPage) break;
    }

    if (!targetPage) {
      return empty(true, [
        'No 京东商智 page found in Chrome. Open https://jdsz.jd.com/ and log in first.',
      ]);
    }

    // 5. Make sure the tradeSummary SPA is loaded. Skip the navigation when
    // the tab is already there (a reload is wasted work and can disturb the
    // operator's tab); otherwise navigate, then wait for the date picker's
    // echo span — the reliable "SPA mounted" marker (the picker fiber is the
    // direct-fetch script's entry point).
    if (!targetPage.url().includes('tradeSummary.html')) {
      await targetPage.goto(TRADE_OVERVIEW_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
    }
    try {
      await targetPage.waitForSelector('span.jmt-combo-date-picker-echo-item', {
        timeout: maxWaitMs,
      });
    } catch {
      return empty(true, [
        `Trade summary SPA did not render its date picker within ${maxWaitMs}ms (not logged in or page changed?)`,
      ]);
    }

    // 5.5. Cross-day freshness guard for getTrend. The tradeSummary date
    // picker's 'yesterday' quick item is a SPA-boot value in dimVals and
    // freezes for the tab's lifetime — a long-running tab crossing Beijing
    // midnight keeps the stale value, shifting getTrend's 7-day categories
    // by 1 day. The realtime 'today' for getSummary is unaffected (realtime
    // injects 'now' on every call). The guard reads the page's current
    // 'yesterday' and reloads the tab once if stale; if still stale after
    // reload, the whole acquisition fails closed and no Evidence is written
    // (caller throws on `!result.success`, see historical-acquire.ts:182).
    const expectedYesterday = expectedPageYesterday();
    let pageYesterday: string | null = null;
    let pageYesterdayError: string | null = null;
    try {
      const read = await targetPage.evaluate<{ ok: boolean; yesterday?: string; error?: string }>(
        buildReadPageYesterdayExpr(),
      );
      if (read.ok && read.yesterday) pageYesterday = read.yesterday;
      else pageYesterdayError = read.error ?? 'unknown';
    } catch (err) {
      pageYesterdayError = err instanceof Error ? err.message : String(err);
    }

    if (pageYesterday !== expectedYesterday) {
      // One reload attempt. The page's webpack modules (99859/4461/22886)
      // and dimVals are reconstructed on document reload.
      try {
        await targetPage.reload({ waitUntil: 'domcontentloaded' });
        await targetPage.waitForSelector('span.jmt-combo-date-picker-echo-item', {
          timeout: maxWaitMs,
        });
      } catch (err) {
        return empty(true, [
          `getTrend cross-day staleness: pageYesterday=${pageYesterday ?? 'null'} (read error: ${pageYesterdayError}), expected=${expectedYesterday}; reload failed: ${err instanceof Error ? err.message : String(err)}`,
        ]);
      }
      // Re-hijack webpack — the reload tears down window.__wr.
      try {
        await targetPage.evaluate<void>(
          `(function(){
            if (typeof window.__wr !== 'function') {
              window.webpackChunksz_2024.push(
                [[Math.floor(Math.random() * 1e9)], {}, (r) => { window.__wr = r; }],
              );
            }
            return undefined;
          })()`,
        );
      } catch {
        // webpack hijack failure surfaces from the direct-fetch evaluate
        // below; we don't double-report.
      }
      // Re-read yesterday.
      try {
        const read = await targetPage.evaluate<{ ok: boolean; yesterday?: string; error?: string }>(
          buildReadPageYesterdayExpr(),
        );
        if (read.ok && read.yesterday) pageYesterday = read.yesterday;
        else pageYesterdayError = read.error ?? 'unknown';
      } catch (err) {
        pageYesterdayError = err instanceof Error ? err.message : String(err);
      }
      if (pageYesterday !== expectedYesterday) {
        return empty(true, [
          `getTrend cross-day staleness: pageYesterday=${pageYesterday ?? 'null'} (read error: ${pageYesterdayError}), expected=${expectedYesterday}; reload did not refresh dimVals.yesterday — acquisition refused, no Evidence written`,
        ]);
      }
    }

    // 6. Direct fetch through the page's own signed ajax transport — no UI
    // interaction, no visibility-guard dependence. The envelopes come back
    // as the evaluate return value, so there is no capture race at all.
    let direct: TradeOverviewDirectFetchResult;
    try {
      direct = await targetPage.evaluate<TradeOverviewDirectFetchResult>(
        buildTradeOverviewDirectFetchExpr(
          TRADE_SUMMARY_BOOT_INDICATORS,
          TRADE_SUMMARY_TREND_INDICATORS,
        ),
      );
    } catch (err) {
      return empty(true, [
        `Direct fetch evaluate failed: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    }
    if (!direct || !direct.ok) {
      return empty(true, direct?.errors ?? ['Direct fetch returned no result']);
    }

    // 7. Build result — an envelope counts only when the endpoint accepted
    // it (header.code === 0), mirroring the old Network-listener filter.
    const errors: string[] = [];
    const summary: unknown[] = [];
    const trend: unknown[] = [];
    if (isTradeOverviewEnvelope(direct.summary)) summary.push(direct.summary);
    else errors.push('getSummary returned a non-zero or malformed envelope');
    if (isTradeOverviewEnvelope(direct.trend)) trend.push(direct.trend);
    else errors.push('getTrend returned a non-zero or malformed envelope');

    const result: TradeOverviewAcquireResult = {
      success: summary.length > 0,
      date,
      summary,
      trend,
      cdpAvailable: true,
    };
    if (errors.length > 0) result.errors = errors;
    return result;
  } catch (err) {
    return empty(true, [err instanceof Error ? err.message : String(err)]);
  } finally {
    await browser.close().catch(() => {});
  }
};

// ---- Multi-Page Discovery (P0005.3) ----

export interface MultiPageOptions {
  cdpPort?: number;
  /** Pages to visit (from blueprint) */
  pages: JdPageSpec[];
  /** Target date for API interception */
  date?: string;
  /** Wait time per page for SPA polling (ms) */
  waitPerPage?: number;
}

/**
 * Navigate to each JD 商智 page, capture its API responses, and return
 * structured per-page results. Single CDP session — connects once, visits
 * all pages, closes.
 *
 * Ported from Python prototype collect_jd_data.py.
 */
export const acquireJdMultiPage = async (
  options: MultiPageOptions,
): Promise<MultiPageResult> => {
  const { cdpPort = 9222, pages, date, waitPerPage = 12000 } = options;
  const targetDate = date ?? new Date().toISOString().slice(0, 10);
  const errors: string[] = [];
  const results: PageDiscoveryResult[] = [];

  // 1. Check CDP
  const available = await isCdpAvailable(cdpPort);
  if (!available) {
    return { success: false, pagesVisited: 0, pagesWithData: 0, results: [], errors: ['CDP not available'] };
  }

  // 2. Load playwright-core
  let playwright: PlaywrightCore;
  try {
    playwright = await import(String('playwright-core')) as unknown as PlaywrightCore;
  } catch {
    return { success: false, pagesVisited: 0, pagesWithData: 0, results: [], errors: ['playwright-core not installed'] };
  }

  // 3. Connect to Chrome
  const wsUrl = await getWsUrl(cdpPort);
  if (!wsUrl) {
    return { success: false, pagesVisited: 0, pagesWithData: 0, results: [], errors: ['No CDP WebSocket URL'] };
  }

  let browser: CdpBrowser;
  try {
    browser = await playwright.chromium.connectOverCDP(wsUrl);
  } catch (err) {
    return { success: false, pagesVisited: 0, pagesWithData: 0, results: [], errors: [`CDP connect: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // 4. Find or open a JD page
  let targetPage: CdpPage | undefined;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes('jd.com') && !p.url().startsWith('blob:')) {
        targetPage = p;
        break;
      }
    }
  }
  if (!targetPage) {
    await browser.close().catch(() => {});
    return { success: false, pagesVisited: 0, pagesWithData: 0, results: [], errors: ['No JD page found in Chrome'] };
  }

  console.log(`[CDP:MultiPage] Visiting ${pages.length} pages...`);

  // 5. Visit each page, capture APIs
  for (const pageSpec of pages) {
    console.log(`[CDP:MultiPage] → ${pageSpec.name} (${pageSpec.url})`);

    try {
      // JD 商智 is AngularJS SPA — hash routing preserves login session.
      const urlPath = pageSpec.url.replace('https://jdsz.jd.com/szweb/view/', '').replace('.html', '');
      if (pageSpec.id === 'home') {
        await targetPage.goto('https://jdsz.jd.com/szweb/view/index/home.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
      } else {
        await targetPage.goto(`https://jdsz.jd.com/szweb/view/index/home.html#/${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
      // Wait for SPA to route
      await new Promise((resolve) => setTimeout(resolve, 4000));

      // P0005.3: Click sub-menu items in the SPA sidebar to trigger page-specific APIs.
      // Each JD 商智 page has sub-menus (e.g. 交易→交易概况, 品牌构成).
      // Clicking them triggers module-specific gateway API calls.
      // Known sub-menus from blueprint.yaml
      const subMenus: Record<string, string[]> = {
        home: [],
        trade: ['交易概况', '品牌构成', '类目构成', '渠道构成'],
        product: ['商品概况', '动销SPU数趋势', '热销商品榜'],
        traffic: ['流量概况', '来源渠道', '搜索-渠道分析', '商品表现'],
        service: ['服务概览'],
        industry: ['行业大盘'],
        reports: ['下载中心'],
        customer: ['用户概览', '用户概况', '用户洞察', '人群列表'],
        marketing: ['营销概览'],
        supply_chain: ['库存健康'],
      };
      const menus = subMenus[pageSpec.id] || [];

      if (menus.length > 0) {
        for (const menuText of menus) {
          try {
            // Click the sub-menu item by visible text
            await targetPage.click(`text="${menuText}"`, { timeout: 5000 });
            // Wait for the SPA module to load and fire its API
            await new Promise((resolve) => setTimeout(resolve, 3000));
          } catch {
            // Menu item not found or not clickable — skip
          }
        }
      } else {
        // No sub-menus, just wait for the main page APIs
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      // Capture ALL szgateway.jd.com API responses (matching Python prototype)
      const captured: { api: string; data: unknown }[] = [];

      // Route ALL lowcode/ API calls
      await targetPage.route('**/szgateway.jd.com/api/lowcode/**', async (route) => {
        const reqUrl = route.request().url();
        const apiName = reqUrl.split('/').pop()?.split('?')[0]?.replace('.ajax', '') || '';
        try {
          const postData = route.request().postDataJSON() as Record<string, unknown> | null;
          if (postData?.dateType === 'todayRealtime') {
            const d = new Date(targetDate);
            const compareD = new Date(d); compareD.setDate(compareD.getDate() - 7);
            const modified = {
              ...postData,
              startDate: `${targetDate} 00:00:00`,
              endDate: `${targetDate} 23:59:59`,
              compareStartDate: `${compareD.toISOString().slice(0, 10)} 00:00:00`,
              compareEndDate: `${compareD.toISOString().slice(0, 10)} 23:59:59`,
            };
            await route.continue({ postData: JSON.stringify(modified) });
          } else {
            await route.continue();
          }
        } catch { await route.continue(); }
      });

      // Capture ALL API responses (matching Python prototype)
      const responseHandler = async (response: CdpResponse) => {
        const url = response.url();
        if (!url.includes('szgateway.jd.com/api/lowcode/')) return;
        const apiName = url.split('/').pop()?.split('?')[0]?.replace('.ajax', '') || '';
        try {
          const body = await response.text();
          const parsed = JSON.parse(body);
          if (parsed?.header?.code === 0) {
            captured.push({ api: apiName, data: parsed });
          }
        } catch { /* skip non-JSON */ }
      };
      targetPage.on('response', responseHandler);

      // Wait for SPA polling
      await new Promise((resolve) => setTimeout(resolve, waitPerPage));

      // Unroute
      await targetPage.unroute('**/szgateway.jd.com/api/lowcode/**').catch(() => {});

      // Build payload from captured APIs
      const summaryData: unknown[] = [];
      const trendData: unknown[] = [];
      const topData: unknown[] = [];
      for (const c of captured) {
        const name = c.api;
        if (name.includes('summary') || name.includes('Summary') || name.includes('getSummary')) summaryData.push(c.data);
        else if (name.includes('trend') || name.includes('Trend')) trendData.push(c.data);
        else if (name.includes('product') || name.includes('Product') || name.includes('Top') || name.includes('top') || name.includes('Express') || name.includes('Brand') || name.includes('brand')) topData.push(c.data);
        else if (name.includes('Flow') || name.includes('flow')) trendData.push(c.data);
        else if (name.includes('Service') || name.includes('Group')) summaryData.push(c.data);
      }

      const payload: MockJdPayload = {
        shopName: '京东店铺',
        shopId: 'jd_shop_001',
        capturedAt: new Date().toISOString(),
        date: targetDate,
        summary: summaryData,
        trend: trendData,
        productTop: topData,
      };

      results.push({
        page: pageSpec,
        success: captured.length > 0,
        payload,
        apiCount: captured.length,
      });

      console.log(`[CDP:MultiPage]   ${pageSpec.name}: ${captured.length} APIs captured`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${pageSpec.name}: ${msg}`);
      results.push({ page: pageSpec, success: false, apiCount: 0, error: msg });
    }
  }

  await browser.close().catch(() => {});

  const pagesWithData = results.filter((r) => r.success).length;
  console.log(`[CDP:MultiPage] Done: ${pagesWithData}/${pages.length} pages with data`);

  return {
    success: pagesWithData > 0,
    pagesVisited: pages.length,
    pagesWithData,
    results,
    errors,
  };
};
