// P0009.1 — Situation Producer tests.
// Covers both the pure detection rules (detectSituations) and the DB-backed
// producer (runSituationProducer): detection, determinism, dedup, and grounding.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { generateSignals } from '#app/runtime/kernel/runtime-signal-engine.js';
import type { ParsedJdData } from '#app/connectors/jd/parsers/index.js';
import type { RankingResult } from '#shared/schemas/ranking.js';
import { detectSituations } from '#app/runtime/situation/rules.js';
import { runSituationProducer } from '#app/runtime/situation/producer.js';

// ---- Fixtures ----

const SHOP = { id: 'jd_shop_001', name: '测试店铺', platform: 'jd', domain: 'ecommerce' };

const parsedFor = (date: string, summary: Partial<ParsedJdData['summary']>): ParsedJdData => ({
  date,
  summary: {
    gmv: summary.gmv ?? 0,
    orders: summary.orders ?? 0,
    visitors: summary.visitors ?? 0,
    customers: summary.customers ?? 0,
    conversion_rate: summary.conversion_rate ?? 0,
    gmv_compare_pct: null,
    orders_compare_pct: null,
    visitors_compare_pct: null,
  },
  hourly_gmv: [],
  top_products: [],
});

const makeRanking = (entityId: string, score: number, rankedAt = '2026-08-16T00:00:00Z'): RankingResult => ({
  ranking_id: `rk_${entityId}`,
  entity_id: entityId,
  overall_score: score,
  confidence: 0.9,
  coverage: 1,
  component_scores: { growth: 0.5, competition: 0.5, supply_stability: 0.5, lifecycle: 0.5, quality: 0.5 },
  signals_used: ['gmv_growth_7d'],
  explainability: { strengths: [], risks: [], summary: '' },
  decision_trace: {
    decision_id: `d_${entityId}`,
    final_score: score,
    top_signals: [],
    risk_signals: [],
    ranking_contribution: [],
    evidence: [],
    confidence: { model: 0.9, evidence_coverage: 1, final: 0.9 },
  },
  ranked_at: rankedAt,
});

// ---- detectSituations (pure rules) ----

describe('detectSituations — meaningful change', () => {
  test('detects declines across metrics when latest drops vs prior day', () => {
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [
        { date: '2026-08-14', metrics: { gmv: 1000, orders: 10, uv: 100, cvr: 0.05 } },
        { date: '2026-08-15', metrics: { gmv: 500, orders: 4, uv: 40, cvr: 0.03 } },
      ],
      rankings: [],
      productNames: {},
    });

    const changeKinds = situations.map((s) => s.tags[0]);
    expect(changeKinds.filter((k) => k === 'meaningful_change')).toHaveLength(4);
    const uv = situations.find((s) => s.tags.includes('uv'))!;
    expect(uv.description).toContain('访客数');
    expect(uv.description).toContain('下降');
    expect(uv.type).toBe('anomaly_investigation');
    expect(uv.entity).toEqual({ id: 'jd_shop_001', type: 'shop', name: '测试店铺', platform: 'jd' });
    expect(uv.temporal.observedAt).toBe('2026-08-15');
    expect(uv.temporal.windowStart).toBe('2026-08-14');
  });

  test('marks rises as performance_analysis', () => {
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [
        { date: '2026-08-14', metrics: { gmv: 1000, orders: 10, uv: 100, cvr: 0.05 } },
        { date: '2026-08-15', metrics: { gmv: 1500, orders: 15, uv: 130, cvr: 0.08 } },
      ],
      rankings: [],
      productNames: {},
    });
    const rises = situations.filter((s) => s.tags[0] === 'meaningful_change' && s.type === 'performance_analysis');
    expect(rises).toHaveLength(4);
  });

  test('ignores changes below the threshold', () => {
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [
        { date: '2026-08-14', metrics: { gmv: 1000, orders: 10, uv: 100, cvr: 0.05 } },
        { date: '2026-08-15', metrics: { gmv: 1050, orders: 10, uv: 102, cvr: 0.051 } }, // all < 20%
      ],
      rankings: [],
      productNames: {},
    });
    expect(situations).toHaveLength(0);
  });

  test('needs at least two observations to produce a situation', () => {
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [{ date: '2026-08-15', metrics: { gmv: 500, orders: 4, uv: 40, cvr: 0.03 } }],
      rankings: [],
      productNames: {},
    });
    expect(situations).toHaveLength(0);
  });
});

describe('detectSituations — cross-signal', () => {
  test('emits a cross-signal situation when traffic and conversion diverge', () => {
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [
        { date: '2026-08-14', metrics: { gmv: 1000, orders: 10, uv: 100, cvr: 0.05 } },
        { date: '2026-08-15', metrics: { gmv: 1000, orders: 10, uv: 60, cvr: 0.08 } }, // uv -40%, cvr +60%
      ],
      rankings: [],
      productNames: {},
    });

    const cross = situations.find((s) => s.tags[0] === 'cross_signal');
    expect(cross).toBeDefined();
    expect(cross!.description).toContain('访客数');
    expect(cross!.description).toContain('转化率');
  });

  test('does not emit cross-signal when both metrics move the same direction', () => {
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [
        { date: '2026-08-14', metrics: { gmv: 1000, orders: 10, uv: 100, cvr: 0.05 } },
        { date: '2026-08-15', metrics: { gmv: 500, orders: 4, uv: 40, cvr: 0.03 } }, // both down
      ],
      rankings: [],
      productNames: {},
    });
    expect(situations.find((s) => s.tags[0] === 'cross_signal')).toBeUndefined();
  });
});

describe('detectSituations — ranking attention', () => {
  test('emits ranking attention for products clearly ahead of the pack', () => {
    const rankings = [0.9, 0.85, 0.5, 0.4, 0.4, 0.4].map((score, i) => makeRanking(`sku_${i}`, score));
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [],
      rankings,
      // P0010.2.5 PREVENTION: ranking_attention now requires a real catalog
      // name. Both leaders here have real names so the test still pins the
      // ranking-detection logic; the unknown-SKU skip is covered separately
      // in the test below.
      productNames: { sku_0: '明星商品A', sku_1: '明星商品B' },
    });

    const leaders = situations.filter((s) => s.tags[0] === 'ranking_attention');
    expect(leaders).toHaveLength(2); // sku_0 (0.9) and sku_1 (0.85) lead by >= 0.1 over 0.4
    expect(leaders[0]!.entity.id).toBe('sku_0');
    expect(leaders[0]!.entity.name).toBe('明星商品A');
  });

  // P0010.2.5 — unknown-SKU products that lead the ranking but have no
  // real catalog entry MUST NOT generate ranking_attention situations.
  // These are noise (test-fixture data with no business meaning), and
  // because the situationId fingerprint includes the date, each daily
  // re-run would otherwise create a new one — accumulating stale
  // situations forever.
  test('does NOT emit ranking attention for products with no real catalog name', () => {
    const rankings = [0.9, 0.85, 0.5, 0.4, 0.4, 0.4].map((score, i) => makeRanking(`sku_${i}`, score));
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [],
      rankings,
      // No entries → all SKUs are "unknown". The 2 leading SKUs would
      // have qualified under the pure ranking rule, but the prevention
      // filter must drop them.
      productNames: {},
    });

    const leaders = situations.filter((s) => s.tags[0] === 'ranking_attention');
    expect(leaders).toHaveLength(0);
  });

  // Mixed: only the named leader should be emitted; the unknown-SKU
  // leader must be skipped even when it has a higher score.
  test('emits ranking attention only for named products; unknown-SKU leaders are skipped', () => {
    const rankings = [0.95, 0.85, 0.5, 0.4, 0.4, 0.4].map((score, i) => makeRanking(`sku_${i}`, score));
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [],
      rankings,
      // sku_0 has the highest score but no catalog name → skip.
      // sku_1 has a real name → emit.
      productNames: { sku_1: '明星商品B' },
    });

    const leaders = situations.filter((s) => s.tags[0] === 'ranking_attention');
    expect(leaders).toHaveLength(1);
    expect(leaders[0]!.entity.id).toBe('sku_1');
  });

  test('emits no ranking attention when scores are tied', () => {
    const rankings = [0.4648, 0.4648, 0.4648, 0.4648, 0.4648].map((score, i) => makeRanking(`sku_${i}`, score));
    const situations = detectSituations({ shop: SHOP, storeDaily: [], rankings, productNames: {} });
    expect(situations).toHaveLength(0);
  });
});

describe('detectSituations — determinism', () => {
  test('produces identical situation ids for identical input', () => {
    const input = {
      shop: SHOP,
      storeDaily: [
        { date: '2026-08-14', metrics: { gmv: 1000, orders: 10, uv: 100, cvr: 0.05 } },
        { date: '2026-08-15', metrics: { gmv: 500, orders: 4, uv: 40, cvr: 0.03 } },
      ],
      rankings: [] as RankingResult[],
      productNames: {},
    };
    const a = detectSituations(input).map((s) => s.situationId);
    const b = detectSituations(input).map((s) => s.situationId);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(new Set(a).size).toBe(a.length); // each situation id is unique
  });
});

// ---- runSituationProducer (DB) ----

describe('runSituationProducer', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  const seedDaily = (date: string, gmv: number, orders: number, visitors: number, conversionRate: number) => {
    generateSignals(db, parsedFor(date, { gmv, orders, visitors, conversion_rate: conversionRate }), {
      platform: 'jd',
      shopId: 'jd_shop_001',
      date,
      signalTypes: ['daily_summary'],
      normalizerSpec: {},
    });
  };

  test('persists real situations from seeded daily_summary signals', () => {
    seedDaily('2026-08-14', 1000, 10, 100, 0.05);
    seedDaily('2026-08-15', 500, 4, 40, 0.03);

    const result = runSituationProducer(db, { shopId: 'jd_shop_001', shopName: '测试店铺' });

    expect(result.created).toBe(4);
    expect(result.skipped).toBe(0);

    const rows = db.prepare('SELECT * FROM situations').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
    const uv = rows.find((r) => String(r.tags).includes('uv'))!;
    expect(String(uv.description)).toContain('测试店铺 访客数 较昨日下降');
  });

  test('is idempotent — re-running does not duplicate situations', () => {
    seedDaily('2026-08-14', 1000, 10, 100, 0.05);
    seedDaily('2026-08-15', 500, 4, 40, 0.03);

    const first = runSituationProducer(db, { shopId: 'jd_shop_001', shopName: '测试店铺' });
    const second = runSituationProducer(db, { shopId: 'jd_shop_001', shopName: '测试店铺' });

    expect(first.created).toBe(4);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(4);

    const count = (db.prepare('SELECT COUNT(*) AS c FROM situations').get() as { c: number }).c;
    expect(count).toBe(4);
  });

  test('produces no situations when there is no daily data', () => {
    const result = runSituationProducer(db, { shopId: 'jd_shop_001' });
    expect(result.created).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM situations').get() as { c: number }).c).toBe(0);
  });
});
