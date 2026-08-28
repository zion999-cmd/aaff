// Tests for runtime-signal-engine — blueprint-driven signal generation.
// P0005.5: Validates that signals are generated from blueprint manifest.signal_types.
// P0006.1.1: signal_name is pure type (not hour-suffixed), observed_at distinguishes observations.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { generateSignals } from '#app/runtime/kernel/runtime-signal-engine.js';
import type { ParsedJdData } from '#app/connectors/jd/parsers/index.js';
import { buildSpecFromBlueprint } from '#app/runtime/kernel/runtime-normalizer-resolver.js';
import { loadBlueprint } from '#app/connectors/binding/loader.js';

const makeParsedData = (): ParsedJdData => ({
  date: '2026-07-04',
  summary: {
    gmv: 150000,
    orders: 320,
    customers: 1200,
    // P0010.2.9: shop-level (primary for trade.overview)
    shop_visitors: 8500,
    shop_conversion_rate: 0.038,
    // Product / industry level (preserved)
    product_visitors: 7200,
    industry_conversion_rate: 0.025,
    // WoW percentages
    gmv_compare_pct: 0.12,
    orders_compare_pct: 0.08,
    shop_visitors_compare_pct: -0.03,
    product_visitors_compare_pct: null,
    shop_conversion_rate_compare_pct: null,
    industry_conversion_rate_compare_pct: null,
  },
  hourly_gmv: [
    { hour: '2026-07-04 10:00:00', gmv: 8500 },
    { hour: '2026-07-04 11:00:00', gmv: 12000 },
    { hour: '2026-07-04 12:00:00', gmv: 0 },
  ],
  top_products: [
    { sku_id: 'SKU001', name: 'Product A', gmv: 45000, item_url: 'https://item.jd.com/SKU001' },
  ],
});

describe('generateSignals', () => {
  let db: ReturnType<typeof Database>;
  const normalizerSpec = buildSpecFromBlueprint(loadBlueprint('jd').normalizer_plan);

  beforeEach(() => {
    db = openDb();
    initDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  test('generates one daily_summary signal from parsed data', () => {
    const result = generateSignals(db, makeParsedData(), {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date: '2026-07-04',
      signalTypes: ['daily_summary'],
      normalizerSpec,
    });

    expect(result.signalCount).toBe(1);
    const signal = result.signals[0]!;
    expect(signal.signal_name).toBe('daily_summary');
    expect(signal.entity_type).toBe('product');
    expect(signal.signal_unit).toBe('currency');
    expect(signal.metrics).toBeDefined();
    // P0006.1.1: observed_at is the business observation time
    expect(signal.observed_at).toBeTruthy();
  });

  test('generates one hourly_sales signal per non-zero hourly entry, signal_name is pure type', () => {
    const result = generateSignals(db, makeParsedData(), {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date: '2026-07-04',
      signalTypes: ['hourly_sales'],
      normalizerSpec,
    });

    // 3 hourly entries, but one has gmv=0 → 2 signals
    expect(result.signalCount).toBe(2);
    for (const signal of result.signals) {
      // P0006.1.1: signal_name is the pure type, not type+hour
      expect(signal.signal_name).toBe('hourly_sales');
      expect(signal.signal_unit).toBe('currency');
      expect(signal.signal_value).toBeGreaterThan(0);
      // observed_at carries the observation time (the hour string)
      expect(signal.observed_at).toBeTruthy();
    }
    // Different hours are distinguished by observed_at, not signal_name
    const observedAts = result.signals.map((s) => s.observed_at).sort();
    expect(observedAts.length).toBe(2);
    expect(observedAts[0]).not.toBe(observedAts[1]);
  });


  test('skips hourly entries with zero gmv', () => {
    const data = makeParsedData();
    data.hourly_gmv = [{ hour: '2026-07-04 10:00:00', gmv: 0 }];

    const result = generateSignals(db, data, {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date: '2026-07-04',
      signalTypes: ['hourly_sales'],
      normalizerSpec,
    });

    expect(result.signalCount).toBe(0);
  });

  test('generates multiple signal types from manifest.signal_types', () => {
    const result = generateSignals(db, makeParsedData(), {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date: '2026-07-04',
      signalTypes: ['daily_summary', 'hourly_sales'],
      normalizerSpec,
    });

    // 1 daily + 2 non-zero hourly = 3
    expect(result.signalCount).toBe(3);

    const signalNames = result.signals.map((s) => s.signal_name);
    expect(signalNames).toContain('daily_summary');
    // P0006.1.1: hourly_sales signals all have signal_name = 'hourly_sales'
    const hourlySignals = signalNames.filter((n) => n === 'hourly_sales');
    expect(hourlySignals.length).toBe(2);
  });

  test('gracefully skips unknown signal types', () => {
    const result = generateSignals(db, makeParsedData(), {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date: '2026-07-04',
      signalTypes: ['unknown_type', 'daily_summary'],
      normalizerSpec,
    });

    // Only daily_summary generated; unknown_type skipped
    expect(result.signalCount).toBe(1);
    expect(result.signals[0]!.signal_name).toBe('daily_summary');
  });

  test('signalCount matches actual signals array length', () => {
    const result = generateSignals(db, makeParsedData(), {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date: '2026-07-04',
      signalTypes: ['daily_summary', 'hourly_sales'],
      normalizerSpec,
    });

    expect(result.signalCount).toBe(result.signals.length);
    expect(result.signalCount).toBeGreaterThan(0);
  });

  test('all 24 hourly signals have unique observed_at values, pure signal_name', () => {
    const data = makeParsedData();
    // 24 non-zero hourly entries, one per hour
    data.hourly_gmv = Array.from({ length: 24 }, (_, i) => ({
      hour: `2026-07-04 ${String(i).padStart(2, '0')}:00:00`,
      gmv: 1000 + i * 100,
    }));

    const result = generateSignals(db, data, {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date: '2026-07-04',
      signalTypes: ['hourly_sales'],
      normalizerSpec,
    });

    expect(result.signalCount).toBe(24);
    // P0006.1.1: all signals have the same pure signal_name
    for (const signal of result.signals) {
      expect(signal.signal_name).toBe('hourly_sales');
    }
    // Uniqueness comes from observed_at, not signal_name suffix
    const observedAts = result.signals.map((s) => s.observed_at);
    const uniqueObserved = new Set(observedAts);
    expect(uniqueObserved.size).toBe(24); // all 24 hours have unique observed_at
  });

  test('hourly_traffic signals have pure signal_name, observed_at distinguishes hours', () => {
    const result = generateSignals(db, makeParsedData(), {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date: '2026-07-04',
      signalTypes: ['hourly_traffic'],
      normalizerSpec,
    });

    // 2 non-zero from makeParsedData (10:00 and 11:00)
    expect(result.signalCount).toBe(2);
    for (const signal of result.signals) {
      // P0006.1.1: pure type name, not type+hour
      expect(signal.signal_name).toBe('hourly_traffic');
      expect(signal.signal_unit).toBe('count');
      expect(signal.observed_at).toBeTruthy();
    }
  });

  test('metrics from parsed data include spec-mapped canonical fields', () => {
    const result = generateSignals(db, makeParsedData(), {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date: '2026-07-04',
      signalTypes: ['daily_summary'],
      normalizerSpec,
    });

    const metrics = result.signals[0]!.metrics;
    // Basic fields should be present (via spec or fallback)
    expect(metrics.gmv).toBe(150000);
    expect(metrics.orders).toBe(320);
  });
});
