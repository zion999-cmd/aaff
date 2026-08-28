// Historical Acquire — reads previously collected evidence from the file store.
// P0006.2: Replay is NOT a special mode. It just swaps the data source
// from Live Connector → Historical Connector. Same return shape.
//
// Strategy: try evidence store first → fall back to mock data.
// This ensures replay always produces signals, even for dates without
// previously collected evidence.

import { loadEvidence } from '#app/connectors/evidence/store.js';
import { mockJdPayload, type MockJdPayload } from '#app/connectors/jd/acquisition/mock.js';
import { acquireJdData, type AcquireResult } from '#app/connectors/jd/acquisition/index.js';
import {
  acquireJdTradeOverviewViaCDP,
  type TradeOverviewAcquireResult,
} from '#app/connectors/jd/acquisition/cdp-client.js';
import type { AcquireFunction } from '#app/connectors/binding/executor.js';

/** Map endpoint names to evidence data types. */
const endpointToDataType = (endpoint: string): string => {
  const base = endpoint.replace(/\.(ajax|json|html?)$/, '');
  // P0010.2.11 C1 Bug 2 — keep the canonical lowcode names as their own
  // dataType. Without these guards, `getSummary` → `'summary'` and
  // `getTrend` → `'trend'`, so the local-first lookup silently reuses the
  // legacy `summary.ajax` evidence as if it satisfied trade.overview.
  // That makes the broken-path evidence appear valid to the runtime
  // loop. Exact-match first, then the legacy fallback heuristic for the
  // OLD `summary` / `trend` / `productTop` names.
  if (base === 'getSummary' || base === 'getTrend') return base;
  if (base.includes('summary')) return 'summary';
  if (base.includes('trend') || base.includes('hourly')) return 'trend';
  if (base.includes('product') || base.includes('top')) return 'productTop';
  return base;
};

/**
 * Create a historical acquire function that reads from evidence store
 * with mock fallback for dates without collected evidence.
 *
 * Priority:
 *   1. Evidence store (real collected data)
 *   2. Mock generator (synthetic data for any date)
 *
 * Returns the same shape as the live JD acquire → Record<endpoint, payload>.
 */
export const createHistoricalAcquire = (): AcquireFunction => {
  return async (_shopId, endpoints, options) => {
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    const data: Record<string, unknown> = {};

    for (const endpoint of endpoints) {
      const dataType = endpointToDataType(endpoint);
      // Try evidence store first
      const loaded = loadEvidence('jd', date, dataType);
      if (loaded) {
        data[endpoint] = loaded.data;
      }
    }

    // If no evidence was found for any endpoint, fall back to mock
    if (Object.keys(data).length === 0) {
      const mock = mockJdPayload(date);
      for (const endpoint of endpoints) {
        const dataType = endpointToDataType(endpoint);
        const key = dataType as keyof MockJdPayload;
        if (key in mock && mock[key] !== undefined) {
          data[endpoint] = mock[key] as unknown;
        }
      }
    }

    return data;
  };
};

/**
 * Create a local-first → live-on-miss acquire function.
 * P0009 correction: operational capability execution consumes already-collected
 * local Evidence first; it only triggers real JD CDP acquisition for endpoints
 * whose local evidence is missing for the target date.
 *
 * Priority per endpoint:
 *   1. Evidence store (real collected data)
 *   2. Live CDP acquisition (single-date, only for the missing endpoints)
 *
 * Same return shape as the live JD acquire → Record<endpoint, payload>.
 * `liveAcquire` is injectable for tests (defaults to the real acquireJdData).
 */
export const createLocalFirstLiveAcquire = (
  liveAcquire: (opts: Parameters<typeof acquireJdData>[0]) => Promise<AcquireResult> = acquireJdData,
): AcquireFunction => {
  return async (shopId, endpoints, options) => {
    const date = options?.date ?? new Date().toISOString().slice(0, 10);
    const data: Record<string, unknown> = {};
    const missing: string[] = [];

    // Pass 1 — local evidence store (real collected data).
    for (const endpoint of endpoints) {
      const dataType = endpointToDataType(endpoint);
      // The JD connector persists only its core data types (summary/trend/productTop).
      // Endpoints that map to any other data type are never resolvable from the
      // store — skip them so they don't re-trigger live CDP on every call.
      // P0010.2.11 C1 — `getSummary` / `getTrend` are now their own canonical
      // dataTypes (Bug 2 fix). Add them so the local-first lookup can find
      // the canonical lowcode evidence; without this, only legacy `summary` /
      // `trend` were reachable from this path.
      if (dataType !== 'summary' && dataType !== 'trend' && dataType !== 'productTop' &&
          dataType !== 'getProductAnalysisData' &&
          dataType !== 'getSummary' && dataType !== 'getTrend') {
        continue;
      }
      const loaded = loadEvidence('jd', date, dataType);
      if (loaded) {
        data[endpoint] = loaded.data;
      } else {
        missing.push(endpoint);
      }
    }

    // Pass 2 — live CDP only for missing endpoints (single-date acquisition).
    // Fail loudly on CDP failure: an evidence miss must not be silently counted
    // as a completed acquisition (Consolidation Pass 1 — honest completion).
    if (missing.length > 0) {
      const live = await liveAcquire({ shopId, mock: false, fromDate: date, toDate: date });
      if (live.success && live.rawPayload) {
        const raw = live.rawPayload as Record<string, unknown>;
        for (const endpoint of missing) {
          const dataType = endpointToDataType(endpoint);
          if (dataType in raw) {
            data[endpoint] = raw[dataType];
          }
        }
      } else {
        throw new Error(live.error ?? `JD CDP acquisition failed for ${date}`);
      }
    }

    return data;
  };
};

/**
 * P0010.2.11 C1 — shared per-capability acquire factory.
 *
 * Routes per-capability acquisition so the same `AcquireFunction` is used by
 *   - the scheduler (`apps/ecommerce/runtime/scheduling/scheduler.ts`)
 *   - the `/api/fabric/execute` HTTP route (`platform/server/routes/runtime.ts`)
 *
 * Without this factory, the scheduler falls through to
 * {@link createLocalFirstLiveAcquire}, which routes trade.overview through the
 * OLD snapshot walker (`acquireJdData` → `acquireJdViaCDP`) and writes
 * `summary` / `trend` evidence (the wrong dataType) every tick. The HTTP
 * route's own per-cap branch was inline at `routes/runtime.ts:113-149` and
 * was not reachable by the scheduler. This factory is the single place that
 * defines the dispatch.
 *
 * Both `liveAcquire` and `tradeOverviewAcquire` are injectable for tests.
 * Default `tradeOverviewAcquire` is the page-driven realtime acquirer
 * introduced in P0010.2.9.
 */
export const TRADE_OVERVIEW_ENDPOINTS: ReadonlySet<string> = new Set([
  'getSummary',
  'getTrend',
]);

const stripEndpoint = (endpoint: string): string =>
  endpoint.split('/').pop()?.split('?')[0]?.replace('.ajax', '') ?? endpoint;

export const createCapabilityAcquire = (
  liveAcquire: (opts: Parameters<typeof acquireJdData>[0]) => Promise<AcquireResult> = acquireJdData,
  tradeOverviewAcquire: (opts: { cdpPort?: number; date?: string; maxWaitMs?: number }) => Promise<TradeOverviewAcquireResult> = acquireJdTradeOverviewViaCDP,
): AcquireFunction => {
  const localFirstAcquire = createLocalFirstLiveAcquire(liveAcquire);
  return async (shopId, endpoints, options) => {
    const isTradeOverview = endpoints.some(
      (e) => TRADE_OVERVIEW_ENDPOINTS.has(e) || TRADE_OVERVIEW_ENDPOINTS.has(stripEndpoint(e)),
    );
    if (isTradeOverview) {
      const acqOpts: { cdpPort?: number; date?: string; maxWaitMs?: number } = {};
      if (options?.cdpPort !== undefined) acqOpts.cdpPort = options.cdpPort;
      if (options?.date) acqOpts.date = options.date;
      const result = await tradeOverviewAcquire(acqOpts);
      if (!result.success) {
        throw new Error(
          result.errors?.[0] ?? `trade.overview acquire failed for ${result.date}`,
        );
      }
      const data: Record<string, unknown> = {};
      for (const endpoint of endpoints) {
        const base = stripEndpoint(endpoint);
        if (base === 'getSummary') {
          data[endpoint] = result.summary;
        } else if (base === 'getTrend') {
          data[endpoint] = result.trend;
        }
      }
      return data;
    }
    return localFirstAcquire(shopId, endpoints, options);
  };
};
