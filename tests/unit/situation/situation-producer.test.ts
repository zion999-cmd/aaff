// P0009.1 — Situation Producer tests.
// Covers both the pure detection rules (detectSituations) and the Evidence-backed
// producer (runSituationProducer): detection, determinism, dedup, and the
// P0010.2.10 evidence-based "today vs yesterday" comparison semantics.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import type { RankingResult } from '#shared/schemas/ranking.js';
import { detectSituations } from '#app/runtime/situation/rules.js';
import { runSituationProducer } from '#app/runtime/situation/producer.js';
import { saveEvidence } from '#app/connectors/evidence/store.js';

// ---- Fixtures ----

const SHOP = { id: 'test-shop-001', name: '测试店铺', platform: 'test-situation', domain: 'ecommerce' };
// P0010.2.10 — tests use a dedicated platform (and a dedicated shop id)
// so they write evidence into data/evidence/test-situation/ and never
// collide with the real jd/ directory that holds production evidence.
const TEST_PLATFORM = 'test-situation';
const TEST_SHOP = 'test-shop-001';
const TEST_EVIDENCE_ROOT = resolve(process.cwd(), 'data', 'evidence', 'test-situation');

/**
 * Build a JD `getSummary.ajax` response payload (the raw API shape) for a
 * single business_date with 4 trade.overview metrics. The P0010.2.10 producer
 * feeds this through `parseJdSummary` to extract {gmv, orders, uv, cvr}.
 */
const buildGetSummaryPayload = (
  gmv: number,
  orders: number,
  shopVisitors: number,
  shopConversionRate: number,
  compareValues?: { gmv: number; orders: number; shopVisitors: number; shopConversionRate: number },
): unknown[] => [
  {
    header: { code: 0, desc: 'success' },
    body: {
      data: [
        {
          jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot: gmv,
          jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot: orders,
          jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src: shopVisitors,
          fo_jdr_sch_shop_deal_rate: shopConversionRate,
          jdr_sch_user_deal_ord_user_cnt_sz_user_deal_snapshot: Math.max(1, orders - 1),
          ...(compareValues
            ? {
                'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compareValue': compareValues.gmv,
                'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compareValue': compareValues.orders,
                'jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src##compareValue': compareValues.shopVisitors,
                'fo_jdr_sch_shop_deal_rate##compareValue': compareValues.shopConversionRate,
              }
            : {}),
        },
      ],
      size: 1,
      cache: false,
    },
    errors: null,
  },
];

/**
 * Seed a getSummary evidence row. `acquisitionMethod` defaults to 'cdp'
 * (production-grade); tests that need to verify the mock-is-rejected
 * behavior pass 'mock' explicitly.
 */
const seedGetSummary = (
  businessDate: string,
  gmv: number,
  orders: number,
  shopVisitors: number,
  shopConversionRate: number,
  options: {
    acquisitionMethod?: 'cdp' | 'mock';
    acquiredAt?: string;
    compareValues?: { gmv: number; orders: number; shopVisitors: number; shopConversionRate: number };
  } = {},
) => {
  const acquisitionMethod = options.acquisitionMethod ?? 'cdp';
  const acquiredAt = options.acquiredAt ?? `${businessDate}T12:00:00.000Z`;
  const payload = buildGetSummaryPayload(gmv, orders, shopVisitors, shopConversionRate, options.compareValues);
  saveEvidence(TEST_PLATFORM, TEST_SHOP, businessDate, 'getSummary', payload, {
    acquisition_method: acquisitionMethod,
    processing_method: 'runtime',
    acquired_at: acquiredAt,
    method: acquisitionMethod,
    operator: 'test',
    runtime: 'node',
    content_hash: 'test-hash',
  });
};

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
    expect(uv.entity).toEqual({ id: 'test-shop-001', type: 'shop', name: '测试店铺', platform: 'test-situation' });
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
      productNames: { sku_0: '明星商品A', sku_1: '明星商品B' },
    });

    const leaders = situations.filter((s) => s.tags[0] === 'ranking_attention');
    expect(leaders).toHaveLength(2);
    expect(leaders[0]!.entity.id).toBe('sku_0');
    expect(leaders[0]!.entity.name).toBe('明星商品A');
  });

  test('does NOT emit ranking attention for products with no real catalog name', () => {
    const rankings = [0.9, 0.85, 0.5, 0.4, 0.4, 0.4].map((score, i) => makeRanking(`sku_${i}`, score));
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [],
      rankings,
      productNames: {},
    });

    const leaders = situations.filter((s) => s.tags[0] === 'ranking_attention');
    expect(leaders).toHaveLength(0);
  });

  test('emits no ranking attention when scores are tied', () => {
    const rankings = [0.4648, 0.4648, 0.4648, 0.4648, 0.4648].map((score, i) => makeRanking(`sku_${i}`, score));
    const situations = detectSituations({ shop: SHOP, storeDaily: [], rankings, productNames: {} });
    expect(situations).toHaveLength(0);
  });
});

describe('detectSituations — P0010.2.10 adjacent-date guard', () => {
  // The "today vs yesterday" comparison is only valid when latest and
  // previous are ADJACENT calendar days. If 8/27 is missing, the prior
  // index-based logic would silently mislabel 8/26 as "yesterday" —
  // this is exactly the bug P0010.2.10 fixes.

  test('does NOT emit meaningful_change when latest and previous are 2+ days apart', () => {
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [
        { date: '2026-08-26', metrics: { gmv: 1000, orders: 10, uv: 100, cvr: 0.05 } },
        { date: '2026-08-28', metrics: { gmv: 500, orders: 4, uv: 40, cvr: 0.03 } }, // 8/27 missing
      ],
      rankings: [],
      productNames: {},
    });
    const changes = situations.filter((s) => s.tags[0] === 'meaningful_change');
    expect(changes).toHaveLength(0);
  });

  test('emits meaningful_change when latest and previous ARE adjacent days', () => {
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [
        { date: '2026-08-27', metrics: { gmv: 1000, orders: 10, uv: 100, cvr: 0.05 } },
        { date: '2026-08-28', metrics: { gmv: 500, orders: 4, uv: 40, cvr: 0.03 } },
      ],
      rankings: [],
      productNames: {},
    });
    const changes = situations.filter((s) => s.tags[0] === 'meaningful_change');
    expect(changes).toHaveLength(4);
  });

  test('emits cross-signal only on adjacent days', () => {
    const situations = detectSituations({
      shop: SHOP,
      storeDaily: [
        { date: '2026-08-26', metrics: { gmv: 1000, orders: 10, uv: 100, cvr: 0.05 } },
        { date: '2026-08-28', metrics: { gmv: 1000, orders: 10, uv: 60, cvr: 0.08 } },
      ],
      rankings: [],
      productNames: {},
    });
    expect(situations.find((s) => s.tags[0] === 'cross_signal')).toBeUndefined();
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
    expect(new Set(a).size).toBe(a.length);
  });
});

// ---- runSituationProducer (Evidence-backed) ----

describe('runSituationProducer', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    // Clean up any leftover test evidence from a previous failed run.
    try { rmSync(TEST_EVIDENCE_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    db.close();
    try { rmSync(TEST_EVIDENCE_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // P0010.2.10 — happy path: two adjacent days of real getSummary evidence
  // produce the 4 meaningful_change situations + the cross-signal one.
  test('emits 4 meaningful_change + 1 cross-signal for adjacent getSummary cdp evidence', () => {
    // 8/27 → 8/28: gmv drops, orders drop, uv drops, cvr RISES (diverges).
    // The uv/cvr divergence triggers the cross-signal Situation.
    seedGetSummary('2026-08-27', 1000, 10, 100, 0.05);
    seedGetSummary('2026-08-28', 500, 4, 40, 0.08, {
      compareValues: { gmv: 1000, orders: 10, shopVisitors: 100, shopConversionRate: 0.05 },
    });

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });

    expect(result.created).toBe(5); // 4 meaningful_change + 1 cross-signal
    const changes = result.situations.filter((s) => s.tags[0] === 'meaningful_change');
    expect(changes).toHaveLength(4);
    const cross = result.situations.find((s) => s.tags[0] === 'cross_signal');
    expect(cross).toBeDefined();
  });

  test('is idempotent — re-running refreshes instead of duplicating (P0010.2.11 fact refresh)', () => {
    seedGetSummary('2026-08-27', 1000, 10, 100, 0.05);
    seedGetSummary('2026-08-28', 500, 4, 40, 0.08, {
      compareValues: { gmv: 1000, orders: 10, shopVisitors: 100, shopConversionRate: 0.05 },
    });

    const first = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    const second = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });

    expect(first.created).toBe(5);
    // Re-run with no new evidence: same situationIds, all refreshed (not
    // re-inserted). P0010.2.11 fact refresh: Phase A refreshes 4
    // meaningful_change rows (cross_signal has no numeric metric to refresh);
    // Phase B re-runs detectSituations → all 5 candidates UPDATE the same
    // rows but `refreshed` only counts Phase A (Phase B only counts `created`
    // — otherwise the same row would be double-counted).
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(4);
  });

  test('produces no situations when there is no evidence', () => {
    const result = runSituationProducer(db, { shopId: TEST_SHOP, platform: TEST_PLATFORM });
    expect(result.created).toBe(0);
  });

  // P0010.2.10 — ACCEPTANCE 1: acquired_at=8/28, business_date=8/27
  // Evidence MUST be grouped under 8/27. acquired_at is only used to
  // pick the latest within the same business_date.
  test('groups Evidence by business_date, not acquired_at (acquired 8/28 + business 8/27 → 8/27)', () => {
    // Two days of evidence: 8/27 (cdp, real values) and 8/28 (cdp, real values).
    // The 8/27 evidence is acquired at 8/28 (e.g. 23:55 acquisition of "yesterday").
    // Both must appear, sorted by business_date ASC, and the comparison
    // must use 8/28 (acquired 8/28 morning) vs 8/27 (acquired 8/28 23:55).
    seedGetSummary('2026-08-27', 1000, 10, 100, 0.05, {
      acquisitionMethod: 'cdp',
      acquiredAt: '2026-08-28T15:55:00.000Z', // late acquisition of "yesterday"
    });
    seedGetSummary('2026-08-28', 500, 4, 40, 0.03, {
      acquisitionMethod: 'cdp',
      acquiredAt: '2026-08-28T09:00:00.000Z', // morning acquisition of "today"
      // Same-time baseline: 8/28's payload bakes yesterday's same-moment
      // values (the P0010 same-time comparison pair).
      compareValues: { gmv: 1000, orders: 10, shopVisitors: 100, shopConversionRate: 0.05 },
    });

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    expect(result.created).toBeGreaterThan(0);

    // The latest situation's window must be 2026-08-28 (today), with
    // window_start 2026-08-27 (yesterday). The acquired_at=8/28 of the
    // 8/27 row must NOT have caused it to be mis-bucketed as 8/28.
    const latestChange = result.situations.find((s) => s.tags[0] === 'meaningful_change')!;
    expect(latestChange.temporal.observedAt).toBe('2026-08-28');
    expect(latestChange.temporal.windowStart).toBe('2026-08-27');
  });

  // P0010.2.10 — ACCEPTANCE 2: today=getSummary (cdp), yesterday=summary (old endpoint)
  // → no comparison. The producer must ONLY use data_type='getSummary' as
  // the basis; falling back to old `summary` would silently mix in
  // pre-P0010.2.9 wrong values.
  test('does NOT compare today getSummary vs yesterday old-summary (data_type filter)', () => {
    // 8/27 has the OLD `summary` endpoint (pre-P0010.2.9 wrong values).
    // We write a synthetic summary evidence file with values that, if
    // mistakenly used, would show a >20% "drop". This is the bug we're
    // guarding against.
    saveEvidence(TEST_PLATFORM, TEST_SHOP, '2026-08-27', 'summary',
      buildGetSummaryPayload(100, 1, 5, 0.01), {
        acquisition_method: 'cdp',
        processing_method: 'runtime',
        method: 'cdp',
        operator: 'test',
        runtime: 'node',
        content_hash: 'old-summary-hash',
      },
    );
    // 8/28 has the NEW getSummary endpoint (correct, P0010.2.9 values).
    seedGetSummary('2026-08-28', 6801, 125, 928, 0.1336);

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    // Producer must have ignored 8/27 `summary` (wrong data_type) and
    // also have no other 8/27 evidence, so no "yesterday" exists.
    expect(result.situations.filter((s) => s.tags[0] === 'meaningful_change')).toHaveLength(0);
  });

  // P0010.2.10 — ACCEPTANCE 3: today=getSummary (cdp), yesterday=getSummary (mock)
  // → no comparison. Production Situations must NOT use mock as a
  // comparison fact. The 8/28 situation can only be generated if
  // 8/27 has a real cdp-acquired getSummary.
  test('does NOT compare today getSummary-cdp vs yesterday getSummary-mock (acquisition_method filter)', () => {
    seedGetSummary('2026-08-27', 999, 99, 999, 0.99, { acquisitionMethod: 'mock' });
    seedGetSummary('2026-08-28', 6801, 125, 928, 0.1336, { acquisitionMethod: 'cdp' });

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    expect(result.situations.filter((s) => s.tags[0] === 'meaningful_change')).toHaveLength(0);
  });

  // P0010.2.10 — ACCEPTANCE 4: 8/28 + 8/26 (no 8/27) → no "较昨日" Situation.
  // The hardcoded [length-2] logic would have labeled 8/26 as "yesterday"
  // even though there's a 1-day gap. The new adjacent-date guard rejects it.
  test('does NOT compare non-adjacent dates (8/28 + 8/26, no 8/27)', () => {
    seedGetSummary('2026-08-26', 1000, 10, 100, 0.05);
    seedGetSummary('2026-08-28', 500, 4, 40, 0.03);

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    expect(result.situations.filter((s) => s.tags[0] === 'meaningful_change')).toHaveLength(0);
    expect(result.situations.find((s) => s.tags[0] === 'cross_signal')).toBeUndefined();
  });

  // P0010.2.10 — ACCEPTANCE 5: 8/28 + 8/27, two real getSummary-cdp rows
  // → emit 4 meaningful_change + cross-signal. This is the happy path
  // that previously was masked by Signal-based comparisons.
  test('emits 4 meaningful_change for two real getSummary-cdp rows on adjacent days', () => {
    seedGetSummary('2026-08-27', 1000, 10, 100, 0.05);
    seedGetSummary('2026-08-28', 500, 4, 40, 0.03, {
      compareValues: { gmv: 1000, orders: 10, shopVisitors: 100, shopConversionRate: 0.05 },
    });

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    const changes = result.situations.filter((s) => s.tags[0] === 'meaningful_change');
    expect(changes).toHaveLength(4);
    // Each metric is described with a real "较昨日" delta.
    for (const c of changes) {
      expect(c.description).toContain('较昨日');
      expect(c.temporal.observedAt).toBe('2026-08-28');
      expect(c.temporal.windowStart).toBe('2026-08-27');
    }
  });

  // P0010.2.10 — when the same business_date has multiple getSummary
  // evidence, pick the one with the LATEST acquired_at. (acquired_at
  // is only meaningful WITHIN a business_date, never across.)
  test('within the same business_date, picks the latest by acquired_at', () => {
    seedGetSummary('2026-08-27', 100, 1, 10, 0.01, {
      acquiredAt: '2026-08-27T08:00:00.000Z', // older
    });
    seedGetSummary('2026-08-27', 200, 2, 20, 0.02, {
      acquiredAt: '2026-08-27T20:00:00.000Z', // newer — wins
    });
    seedGetSummary('2026-08-28', 100, 1, 10, 0.01, {
      // Same-time baseline matches the LATEST 8/27 read (200) — the
      // P0010 same-response pair, not the older 8/27 08:00 read.
      compareValues: { gmv: 200, orders: 2, shopVisitors: 20, shopConversionRate: 0.02 },
    });

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    // 8/28's gmv=100 vs synthesized baseline 200 → -50% drop. One change per metric.
    const gmv = result.situations.find((s) => s.tags.includes('gmv'))!;
    expect(gmv).toBeDefined();
    expect(gmv.description).toContain('¥200');
    expect(gmv.description).toContain('¥100');
  });
});

// ---- P0010.2.11 C2 — yesterday baseline from ##compareValue ----
//
// The JD getSummary payload bakes YESTERDAY's full-day absolute values into
// the SAME response as today's realtime values (`<field>##compareValue`).
// When no real previous-day cdp evidence exists (the normal state for a
// freshly-bootstrapped store — see the 2026-08-29 stopgap), the producer
// synthesizes the missing "yesterday" observation from those fields instead
// of emitting nothing.

describe('runSituationProducer — C2 compareValue yesterday baseline', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    try { rmSync(TEST_EVIDENCE_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    db.close();
    try { rmSync(TEST_EVIDENCE_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
  });

  test('single cdp day + ##compareValue baseline → today vs synthesized yesterday (4 changes)', () => {
    // Only ONE real observation exists (2026-08-29). The 8/28 baseline comes
    // from the payload's ##compareValue fields (yesterday full-day absolute).
    seedGetSummary('2026-08-29', 6801.02, 125, 928, 0.1336, {
      compareValues: { gmv: 1000, orders: 10, shopVisitors: 100, shopConversionRate: 0.05 },
    });

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    const changes = result.situations.filter((s) => s.tags[0] === 'meaningful_change');
    expect(changes).toHaveLength(4);
    const gmv = changes.find((s) => s.tags.includes('gmv'))!;
    expect(gmv.temporal.observedAt).toBe('2026-08-29');
    expect(gmv.temporal.windowStart).toBe('2026-08-28'); // synthesized baseline date = day-1
    expect(gmv.description).toContain('¥1000'); // baseline value from compareValue
  });

  // P0010 — real previous-day evidence EXISTS, but its acquisition window may
  // not align with today's (e.g. 8/28 acquired 16:00 vs 8/29 acquired 08:20).
  // The canonical same-time baseline is the SAME response's ##compareValue
  // (yesterday same-moment), NOT the previous-day evidence's realtime value.
  // This is the window-mismatch fix: calendar adjacency ≠ window alignment.
  test('uses ##compareValue baseline even when real previous-day evidence exists (same-time aligned)', () => {
    // 8/28 real evidence — acquired 16:00, realtime window [00:00→16:00].
    seedGetSummary('2026-08-28', 1000, 10, 100, 0.05, {
      acquiredAt: '2026-08-28T16:00:00.000Z',
    });
    // 8/29 acquired 08:20, realtime window [00:00→08:20]; its payload bakes
    // yesterday's same-moment (08:20) values.
    seedGetSummary('2026-08-29', 6801.02, 125, 928, 0.1336, {
      compareValues: { gmv: 900, orders: 9, shopVisitors: 90, shopConversionRate: 0.04 },
    });

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    const changes = result.situations.filter((s) => s.tags[0] === 'meaningful_change');
    expect(changes).toHaveLength(4);
    const gmv = changes.find((s) => s.tags.includes('gmv'))!;
    // Baseline MUST be the same-time ##compareValue (900), NOT the
    // previous-day realtime evidence value (1000) — different windows.
    expect(gmv.description).toContain('¥900');
    expect(gmv.description).not.toContain('¥1000');
  });

  // P0010 — previous-day real evidence exists, but the latest payload has NO
  // ##compareValue (no aligned baseline available). The previous-day realtime
  // must NOT be used (its window is unverifiable) → honest silence.
  test('drops previous-day observation when latest payload lacks ##compareValue (honest silence)', () => {
    seedGetSummary('2026-08-28', 1000, 10, 100, 0.05, {
      acquiredAt: '2026-08-28T16:00:00.000Z',
    });
    // 8/29 real evidence but payload has NO ##compareValue fields.
    seedGetSummary('2026-08-29', 6801.02, 125, 928, 0.1336);

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    // No window-aligned comparison exists → no today Situation.
    expect(result.situations).toHaveLength(0);
  });

  test('no synthesis when ##compareValue fields are incomplete', () => {
    // compareValues omitted → payload has no baseline → 0 situations (honest).
    seedGetSummary('2026-08-29', 6801.02, 125, 928, 0.1336);

    const result = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    expect(result.situations).toHaveLength(0);
  });
});

// ---- P0010.2.11 fact refresh: latest_* fields track the most recent evidence ----
//
// Hourly cadence: every new `trade.overview` evidence reuses the deterministic
// situation_id (same metric + window). The producer must REFRESH the latest_*
// fields (current/baseline/pct/evidence_id/acquired_at/content_hash + description)
// on every run — not only on first insert.
describe('runSituationProducer — fact refresh on re-run (hourly cadence)', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    try { rmSync(TEST_EVIDENCE_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    db.close();
    try { rmSync(TEST_EVIDENCE_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
  });

  test('refreshes latest_* fields on re-run (description + value tracking)', () => {
    // Hour 1: 8/30 realtime 1000/4/50/0.05 vs compareValue 800/3/40/0.04
    seedGetSummary('2026-08-30', 1000, 4, 50, 0.05, {
      compareValues: { gmv: 800, orders: 3, shopVisitors: 40, shopConversionRate: 0.04 },
    });
    const first = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    expect(first.created).toBeGreaterThan(0);
    // First run: 0 existing rows → Phase A refreshes nothing.
    expect(first.refreshed).toBe(0);

    const gmvSitId = db
      .prepare("SELECT situation_id FROM situations WHERE description LIKE '%成交金额%'")
      .get() as { situation_id: string } | undefined;
    expect(gmvSitId).toBeDefined();
    const id = gmvSitId!.situation_id;
    const before = db
      .prepare(
        'SELECT description, latest_current_value, latest_baseline_value, latest_change_pct ' +
          'FROM situations WHERE situation_id = ?',
      )
      .get(id) as { description: string; latest_current_value: number; latest_baseline_value: number; latest_change_pct: number };
    expect(before.description).toContain('¥1000.00');
    expect(before.description).toContain('¥800.00');
    expect(before.latest_current_value).toBe(1000);
    expect(before.latest_baseline_value).toBe(800);

    // Hour 2: re-seed 8/30 evidence with a HIGHER realtime value (simulating the
    // next hourly bucket). The deterministic situation_id must not change.
    // To force "latest wins" we give the second seed a later acquired_at.
    seedGetSummary('2026-08-30', 2500, 8, 75, 0.07, {
      compareValues: { gmv: 800, orders: 3, shopVisitors: 40, shopConversionRate: 0.04 },
      acquiredAt: '2026-08-30T15:30:00.000Z',
    });

    const second = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    expect(second.created).toBe(0); // no new — same deterministic id
    expect(second.refreshed).toBe(second.situations.length);

    const after = db
      .prepare(
        'SELECT description, latest_current_value, latest_baseline_value, latest_change_pct ' +
          'FROM situations WHERE situation_id = ?',
      )
      .get(id) as { description: string; latest_current_value: number; latest_baseline_value: number; latest_change_pct: number };
    expect(after.latest_current_value).toBe(2500);
    expect(after.latest_baseline_value).toBe(800);
    // pct = (2500-800)/800 = 2.125 = 212.5
    expect(after.latest_change_pct).toBeCloseTo(212.5, 1);
    expect(after.description).toContain('¥2500.00');
    expect(after.description).toContain('¥800.00');
  });

  test('UV Situation latest facts populated on first run (regression: uv was NULL)', () => {
    // UV: current=800, baseline=500 → +60% (>20% threshold so detectSituations emits)
    seedGetSummary('2026-08-31', 1000, 4, 800, 0.05, {
      compareValues: { gmv: 800, orders: 3, shopVisitors: 500, shopConversionRate: 0.04 },
    });
    runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    const uv = db
      .prepare("SELECT * FROM situations WHERE description LIKE '%访客%'")
      .get() as {
        situation_id: string; description: string;
        latest_current_value: number | null; latest_baseline_value: number | null;
        latest_change_pct: number | null; latest_evidence_acquired_at: string | null;
      } | undefined;
    expect(uv).toBeDefined();
    expect(uv!.latest_current_value).toBe(800);
    expect(uv!.latest_baseline_value).toBe(500);
    expect(uv!.latest_change_pct).toBeCloseTo(((800 - 500) / 500) * 100, 1);
    expect(uv!.description).toContain('800');
    expect(uv!.description).toContain('500');
  });

  // Phase A regression: a Situation whose daily delta has cooled below
  // threshold (uv dropped from +60% to +10.97%) is no longer emitted by
  // detectSituations, so the candidate loop would never re-visit it.
  // Phase A must still rewrite its latest_* projection from the freshest
  // evidence + latest ##compareValue baseline so the Workspace never
  // shows a stale observation.
  test('Phase A refreshes an existing UV Situation even when changePct < threshold', () => {
    // Hour 1: UV +60% (>20%) → detectSituations emits UV Situation.
    seedGetSummary('2026-08-31', 1000, 4, 800, 0.05, {
      compareValues: { gmv: 800, orders: 3, shopVisitors: 500, shopConversionRate: 0.04 },
    });
    runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    const id = (db
      .prepare("SELECT situation_id FROM situations WHERE description LIKE '%访客%'")
      .get() as { situation_id: string }).situation_id;
    const uv1 = db
      .prepare('SELECT description, latest_current_value, latest_baseline_value, latest_change_pct FROM situations WHERE situation_id = ?')
      .get(id) as { description: string; latest_current_value: number; latest_baseline_value: number; latest_change_pct: number };
    expect(uv1.latest_current_value).toBe(800);
    expect(uv1.latest_baseline_value).toBe(500);
    expect(uv1.latest_change_pct).toBeCloseTo(60, 1);

    // Hour 2: UV cooled to +10.97% (<20%) — detectSituations will NOT emit
    // a UV candidate this run. Without Phase A, the UV row's facts would
    // remain at +60% forever. Phase A must refresh them to +10.97% from
    // the freshest evidence + ##compareValue baseline.
    seedGetSummary('2026-08-31', 1000, 4, 688, 0.05, {
      compareValues: { gmv: 800, orders: 3, shopVisitors: 620, shopConversionRate: 0.04 },
      acquiredAt: '2026-08-31T18:30:00.000Z',
    });
    const second = runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    // GMV/orders/cvr are still above threshold → detectSituations emits 3
    // candidates which UPDATE the existing rows; UV alone fell below
    // threshold and is NOT a candidate this run.
    expect(second.created).toBe(0);
    expect(second.refreshed).toBe(4); // Phase A refreshes all 4 meaningful_change rows
    // The point of this test: the UV row's facts are still updated even
    // though it was not a candidate this tick.
    const uv2 = db
      .prepare('SELECT description, latest_current_value, latest_baseline_value, latest_change_pct FROM situations WHERE situation_id = ?')
      .get(id) as { description: string; latest_current_value: number; latest_baseline_value: number; latest_change_pct: number };
    expect(uv2.latest_current_value).toBe(688);
    expect(uv2.latest_baseline_value).toBe(620);
    expect(uv2.latest_change_pct).toBeCloseTo(((688 - 620) / 620) * 100, 1);
    expect(uv2.description).toContain('688');
    expect(uv2.description).toContain('620');
  });

  test('refresh preserves identity columns (lifecycle, type, window_start, tags)', () => {
    seedGetSummary('2026-08-30', 1000, 4, 50, 0.05, {
      compareValues: { gmv: 800, orders: 3, shopVisitors: 40, shopConversionRate: 0.04 },
    });
    runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    const id = (db
      .prepare("SELECT situation_id FROM situations WHERE description LIKE '%成交金额%'")
      .get() as { situation_id: string }).situation_id;
    const first = db.prepare('SELECT lifecycle, type, window_start, tags FROM situations WHERE situation_id = ?').get(id) as {
      lifecycle: string; type: string; window_start: string; tags: string;
    };

    // Re-seed with different numbers — refresh should not touch identity.
    seedGetSummary('2026-08-30', 9999, 99, 999, 0.99, {
      compareValues: { gmv: 1, orders: 1, shopVisitors: 1, shopConversionRate: 0.01 },
      acquiredAt: '2026-08-30T18:00:00.000Z',
    });
    runSituationProducer(db, { shopId: TEST_SHOP, shopName: '测试店铺', platform: TEST_PLATFORM });
    const second = db.prepare('SELECT lifecycle, type, window_start, tags FROM situations WHERE situation_id = ?').get(id) as {
      lifecycle: string; type: string; window_start: string; tags: string;
    };
    expect(second.lifecycle).toBe(first.lifecycle);
    expect(second.type).toBe(first.type);
    expect(second.window_start).toBe(first.window_start);
    expect(second.tags).toBe(first.tags);
  });
});
