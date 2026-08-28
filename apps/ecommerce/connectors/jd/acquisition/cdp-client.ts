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

// ---- Trade Overview (P0010.2.9) ----
//
// trade.overview is the live 经营概览 page. It calls the lowcode endpoints
// `tradeSummary/summary/getSummary.ajax` + `getTrend.ajax` — NOT the snapshot
// `indexSummary/summary.ajax` that the historical walker uses. Page-driven:
//   1. Navigate to /szweb/view/tradeAnalysis/tradeSummary.html
//   2. Let the SPA fire its own signed XHR (no body rewrite — the page knows
//      `todayRealtime` mode is correct)
//   3. Capture both responses in memory
//
// Keep CDP/browser signed-request path: do NOT try to forge __sgm__.

export interface TradeOverviewAcquireOptions {
  /** Chrome CDP port (default: 9222) */
  cdpPort?: number;
  /** Target date (ISO, default: today) */
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

const TRADE_OVERVIEW_URL = 'https://jdsz.jd.com/szweb/view/tradeAnalysis/tradeSummary.html';

/**
 * Acquire trade.overview via the live 经营概览 page.
 *
 * The page fires `tradeSummary/summary/getSummary.ajax` + `getTrend.ajax` on
 * its own (with the page's own CSRF headers + signed request context). We
 * navigate to the page, let it fire, and capture the responses — no body
 * rewrite, no `__sgm__` forgery. Returns a non-paged (single-day) payload
 * keyed by `summary` and `trend` (the same keys the parsers expect).
 *
 * This is a sibling to {@link acquireJdViaCDP} (the multi-day snapshot walker)
 * and {@link acquireJdMultiPage} (the multi-page discovery walker). It is the
 * right tool for `trade.overview`, which is realtime shop-level, not historical.
 */
export const acquireJdTradeOverviewViaCDP = async (
  options: TradeOverviewAcquireOptions = {},
): Promise<TradeOverviewAcquireResult> => {
  const { cdpPort = 9222, maxWaitMs = 15_000 } = options;
  const date = options.date ?? new Date().toISOString().slice(0, 10);
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

  // Hoisted so the `finally` block can detach the response listener on
  // every exit path (result / throw / early-return) — no cross-tick leak.
  let targetPage: CdpPage | undefined;
  let responseHandler: ((response: CdpResponse) => Promise<void>) | null = null;

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

    // 5. Set up response capture BEFORE any navigation (P0010.2.11 C1.6).
    // The goto below triggers a full page reload even when the tab is
    // already on tradeSummary.html. Registering the listener after the
    // navigation raced the page lifecycle: on the first tick of a fresh
    // dev server the reload's follow-up fetches fired before the
    // listener was attached, so `captured` stayed empty and the first
    // acquisition failed ("Did not capture …"). Registering first means
    // every response — including those fired during/before the reload —
    // is observable. The filter below keeps only the two target APIs,
    // so nothing unrelated is accumulated. The handler is removed in
    // the `finally` block on every exit path (result, throw, empty).
    const captured: { api: string; data: unknown }[] = [];
    const targetApis = new Set(['getSummary', 'getTrend']);

    const handler = async (response: CdpResponse): Promise<void> => {
      const url = response.url();
      if (!url.includes('szgateway.jd.com/api/lowcode/tradeSummary/')) return;
      const apiName = url.split('/').pop()?.split('?')[0]?.replace('.ajax', '') || '';
      if (!targetApis.has(apiName)) return;
      try {
        const body = await response.text();
        const parsed = JSON.parse(body) as { header?: { code: number } };
        if (parsed?.header?.code === 0) {
          captured.push({ api: apiName, data: parsed });
        }
      } catch {
        // Skip non-JSON
      }
    };
    responseHandler = handler;
    targetPage.on('response', handler);

    // 6. Navigate to trade summary page
    await targetPage.goto(TRADE_OVERVIEW_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });

    // 7. Wait for SPA to render the 核心指标 / 交易概览 shell
    try {
      await targetPage.waitForSelector('text=核心指标', { timeout: 10_000 });
    } catch {
      // Selector not present in this build — continue. The response
      // capture above is the source of truth.
    }

    // 8. Click "查询" to force a fresh fetch. The page is in 实时 mode by
    // default, but the click guarantees the SPA fires getSummary/getTrend
    // even if a stale value is on screen. Multiple 查询 buttons may exist
    // — pick the first one inside the page content area.
    try {
      await targetPage.click('button:has-text("查询")', { timeout: 5_000 });
    } catch {
      // Button not found / not clickable — rely on initial fetch.
    }

    // 9. Wait for both responses (or until maxWaitMs)
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const haveSummary = captured.some((c) => c.api === 'getSummary');
      const haveTrend = captured.some((c) => c.api === 'getTrend');
      if (haveSummary && haveTrend) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // 10. Build result
    const summary: unknown[] = [];
    const trend: unknown[] = [];
    for (const c of captured) {
      if (c.api === 'getSummary') summary.push(c.data);
      else if (c.api === 'getTrend') trend.push(c.data);
    }

    const result: TradeOverviewAcquireResult = {
      success: summary.length > 0,
      date,
      summary,
      trend,
      cdpAvailable: true,
    };
    const missing: string[] = [];
    if (summary.length === 0) missing.push('getSummary');
    if (trend.length === 0) missing.push('getTrend');
    if (missing.length > 0) {
      result.errors = [`Did not capture: ${missing.join(', ')} within ${maxWaitMs}ms`];
    }
    return result;
  } catch (err) {
    return empty(true, [err instanceof Error ? err.message : String(err)]);
  } finally {
    // C1.6 — detach the response listener on EVERY exit path (success,
    // failure result, thrown error) so no handler survives the tick. The
    // browser connection is closed right after, which would drop it
    // anyway, but the explicit detach makes the no-leak invariant
    // structural instead of incidental.
    if (targetPage && responseHandler) {
      try {
        targetPage.off('response', responseHandler);
      } catch {
        // Page may already be gone (navigation crash) — nothing to detach.
      }
    }
    responseHandler = null;
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
