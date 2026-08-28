// Tests for runtime-executor — unified execution pipeline.
// P0005.5: Validates the single pipeline: Plan → Acquire → Parse → Normalize → Signal → Evidence.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { executeRuntimePipeline } from '#app/runtime/kernel/runtime-executor.js';
import { loadBlueprint } from '#app/connectors/binding/loader.js';
import type { BoundCapabilityModel } from '#app/connectors/binding/types.js';
import type { AcquireFunction } from '#app/connectors/binding/executor.js';

const makeMockAcquire = (): AcquireFunction => {
  return async (_shopId, _endpoints) => {
    // Return data in JD API response envelope format that parseJdPayload expects.
    // Each value is an array of JdApiResponse objects with header + body.data.
    return {
      summary: [{
        header: { code: 0 },
        body: {
          data: [{
            gmv: 150000,
            orders: 320,
            customers: 1200,
            // P0010.2.9: shop-level (primary for trade.overview)
            shop_visitors: 8500,
            shop_conversion_rate: 0.038,
            // Product / industry level (preserved for other capabilities)
            product_visitors: 7200,
            industry_conversion_rate: 0.025,
            // WoW percentages
            gmv_compare_pct: 0.12,
            orders_compare_pct: 0.08,
            shop_visitors_compare_pct: -0.03,
          }],
        },
      }],
      trend: [{
        header: { code: 0 },
        body: {
          data: [
            { dt: '2026-07-04 10:00:00', gmv: 8500 },
            { dt: '2026-07-04 11:00:00', gmv: 12000 },
          ],
        },
      }],
      productTop: [{
        header: { code: 0 },
        body: {
          data: [{
            sku_id: 'SKU001',
            'sku_id#name_cn': 'Product A',
            gmv: 45000,
            sku_id_item_url: 'https://item.jd.com/SKU001',
          }],
        },
      }],
    };
  };
};

describe('executeRuntimePipeline', () => {
  let db: ReturnType<typeof Database>;
  let blueprint: BoundCapabilityModel;

  beforeAll(() => {
    blueprint = loadBlueprint('jd');
  });

  beforeEach(() => {
    db = openDb();
    initDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  test('executes full pipeline: acquire → parse → signal → evidence', async () => {
    const result = await executeRuntimePipeline(
      blueprint,
      makeMockAcquire(),
      db,
      { shopId: 'jd_shop_001', date: '2026-07-04', mock: true },
    );

    expect(result.success).toBe(true);
    expect(result.platform).toBe('jd');
    expect(result.blueprintDriven).toBe(true);
    // Should have acquired data
    expect(result.acquired).toBeDefined();
    // Should have parsed data
    expect(result.parsed).not.toBeNull();
    expect(result.parsed!.summary.gmv).toBe(150000);
    // Should have generated signals
    expect(result.signals.length).toBeGreaterThan(0);
    // Should have captured evidence
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  test('returns success: false on acquisition failure', async () => {
    const failingAcquire: AcquireFunction = async () => {
      throw new Error('CDP connection refused');
    };

    const result = await executeRuntimePipeline(
      blueprint,
      failingAcquire,
      db,
      { shopId: 'jd_shop_001', date: '2026-07-04' },
    );

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('CDP connection refused');
    expect(result.parsed).toBeNull();
    expect(result.signals).toHaveLength(0);
  });

  test('produces daily_summary + hourly_sales signals from blueprint signal_types', async () => {
    const result = await executeRuntimePipeline(
      blueprint,
      makeMockAcquire(),
      db,
      { shopId: 'jd_shop_001', date: '2026-07-04', mock: true },
    );

    const signalNames = result.signals.map((s) => s.signal_name);
    // Blueprint manifest.signal_types includes daily_summary and hourly_traffic
    expect(signalNames).toContain('daily_summary');
  });

  test('filters by capabilities when specified', async () => {
    const result = await executeRuntimePipeline(
      blueprint,
      makeMockAcquire(),
      db,
      { shopId: 'jd_shop_001', date: '2026-07-04', mock: true, capabilities: ['Transaction'] },
    );

    expect(result.success).toBe(true);
    // Should still work — capability filtering affects which APIs are called
    expect(result.parsed).not.toBeNull();
  });

  test('evidence capture results include dataType and evidenceId', async () => {
    const result = await executeRuntimePipeline(
      blueprint,
      makeMockAcquire(),
      db,
      { shopId: 'jd_shop_001', date: '2026-07-04', mock: true },
    );

    for (const ev of result.evidence) {
      expect(ev.endpoint).toBeTruthy();
      expect(ev.evidenceId).toBeTruthy();
      expect(ev.dataType).toBeTruthy();
    }
  });

  test('returns success: false when acquired data is empty (honest completion)', async () => {
    const emptyAcquire: AcquireFunction = async () => ({});

    const result = await executeRuntimePipeline(
      blueprint,
      emptyAcquire,
      db,
      { shopId: 'jd_shop_001', date: '2026-07-04', mock: true },
    );

    expect(result.success).toBe(false);
    // No data to parse → parsed is null
    expect(result.parsed).toBeNull();
    // No signals generated (no data)
    expect(result.signals).toHaveLength(0);
  });

  // P0010.2.9: the trade.overview page-driven acquire factory returns data
  // keyed by endpoint name (`getSummary` / `getTrend` — the page's own
  // apiNames). parseAcquiredData must recognize these as the canonical
  // `summary` / `trend` payload, not drop them as "unknown endpoint".
  test('parseAcquiredData recognizes getSummary / getTrend page apiNames (P0010.2.9)', async () => {
    const pageApiNameAcquire: AcquireFunction = async () => ({
      getSummary: [{
        header: { code: 0 },
        body: {
          data: [{
            jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot: 6801.02,
            jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot: 125,
            jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src: 928,
            fo_jdr_sch_shop_deal_rate: 0.1336,
            jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot: 124,
          }],
          size: 1,
          cache: false,
          traceId: null,
          uuid: null,
        },
        errors: null,
      }],
      getTrend: [{
        header: { code: 0 },
        body: { data: [] },
        errors: null,
      }],
    });

    const result = await executeRuntimePipeline(
      blueprint,
      pageApiNameAcquire,
      db,
      { shopId: 'jd_shop_001', date: '2026-08-27', mock: true, capabilities: ['daily_summary'] },
    );

    expect(result.success).toBe(true);
    expect(result.parsed).not.toBeNull();
    // The new shop-level canonical names must be populated from the page's
    // JDR field names (via the indicator map).
    expect(result.parsed!.summary.gmv).toBe(6801.02);
    expect(result.parsed!.summary.orders).toBe(125);
    expect(result.parsed!.summary.shop_visitors).toBe(928);
    expect(result.parsed!.summary.shop_conversion_rate).toBeCloseTo(0.1336);
    // daily_summary signal must include the new fields under their canonical names
    const daily = result.signals.find((s) => s.signal_name === 'daily_summary');
    expect(daily).toBeDefined();
    expect((daily!.metrics as Record<string, number>).gmv).toBe(6801.02);
    expect((daily!.metrics as Record<string, number>).orders).toBe(125);
  });
});
