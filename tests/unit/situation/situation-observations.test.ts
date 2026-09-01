// P0012 — Situation metric observations append behavior.
//
// Producer Phase A refreshes the latest_* projection AND inserts an
// immutable observation row to `situation_observations` per
// (situation_id, metric, business_time_bucket). The UNIQUE index on
// the natural key makes a re-run in the same hour a no-op.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';

import { runSituationProducer } from '#app/runtime/situation/producer.js';
import { applyP0007Schema } from '#platform/storage/p0007-schema.js';
import {
  saveEvidence,
  setEvidenceHistoryDb,
} from '#app/connectors/evidence/store.js';

const TEST_SHOP = 'test-shop-p0012';
const TEST_PLATFORM = 'test-p0012';
const TEST_EVIDENCE_ROOT = resolve(process.cwd(), 'data', 'evidence', 'test-p0012');

const seedGetSummary = (
  businessDate: string,
  gmv: number,
  orders: number,
  uv: number,
  cvr: number,
  options: { acquiredAt?: string; compareGm?: number; compareOrders?: number; compareUv?: number; compareCvr?: number } = {},
): Promise<string> => {
  // Default acquiredAt = 04:00 UTC = 12:00 Beijing (T12 bucket).
  // Test 3 uses a different UTC hour to land in a different bucket.
  const acquiredAt = options.acquiredAt ?? `${businessDate}T04:00:00.000Z`;
  const compareGm = options.compareGm ?? Math.max(1, Math.floor(gmv / 2));
  const compareOrders = options.compareOrders ?? Math.max(1, Math.floor(orders / 2));
  const compareUv = options.compareUv ?? Math.max(1, Math.floor(uv / 2));
  const compareCvr = options.compareCvr ?? Math.max(0.001, cvr / 2);
  const payload = [
    {
      header: { code: 0, desc: 'success' },
      body: {
        data: [
          {
            jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot: gmv,
            jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot: orders,
            jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src: uv,
            fo_jdr_sch_shop_deal_rate: cvr,
            'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot##compareValue': compareGm,
            'jdr_sch_trade_deal_ord_ord_qtty_sz_trade_deal_snapshot##compareValue': compareOrders,
            'jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src##compareValue': compareUv,
            'fo_jdr_sch_shop_deal_rate##compareValue': compareCvr,
          },
        ],
      },
    },
  ];
  return saveEvidence(TEST_PLATFORM, TEST_SHOP, businessDate, 'getSummary', payload, {
    acquisition_method: 'cdp',
    processing_method: 'runtime',
    processed_at: new Date().toISOString(),
    method: 'cdp',
  }).then(() => acquiredAt);
};

describe('runSituationProducer — P0012 situation_observations append', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyP0007Schema(db);
    // RankingFacade.load (called by the producer) expects `ranking_results`
    // and `products` tables; provide minimal schemas so the producer can run
    // without DB-prep.
    db.exec(
      `CREATE TABLE IF NOT EXISTS products (
         product_id TEXT PRIMARY KEY,
         name TEXT
       )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS ranking_results (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         entity_id TEXT NOT NULL,
         entity_type TEXT NOT NULL,
         profile TEXT NOT NULL,
         overall_score REAL NOT NULL,
         rank INTEGER NOT NULL,
         created_at TEXT NOT NULL
       )`,
    );
    setEvidenceHistoryDb(db);
  });

  afterEach(() => {
    setEvidenceHistoryDb(undefined);
    db.close();
    try {
      rmSync(TEST_EVIDENCE_ROOT, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('appends one observation per (situation, metric, hour bucket) on Phase A refresh', async () => {
    await seedGetSummary('2026-09-01', 1068, 109, 623, 0.13, {
      compareGm: 534,
      compareOrders: 54,
      compareUv: 311,
      compareCvr: 0.07,
    });
    const first = runSituationProducer(db, {
      shopId: TEST_SHOP,
      shopName: '测试',
      platform: TEST_PLATFORM,
    });
    expect(first.created).toBeGreaterThan(0);

    // 4 meaningful_change Situations × 1 metric tag each = 4 observation rows
    const obs1 = db
      .prepare(
        "SELECT metric, business_time_bucket, current_value, baseline_value " +
          'FROM situation_observations ORDER BY id',
      )
      .all() as Array<{
        metric: string;
        business_time_bucket: string;
        current_value: number;
        baseline_value: number;
      }>;
    expect(obs1).toHaveLength(4);
    const metrics = obs1.map((o) => o.metric).sort();
    expect(metrics).toEqual(['cvr', 'gmv', 'orders', 'uv']);
    // All four rows share the same bucket (driven by the single evidence
    // file we just saved — Beijing hour-of-acquisition). Don't pin to a
    // specific value (test runs at wall-clock T17+).
    const buckets = new Set(obs1.map((o) => o.business_time_bucket));
    expect(buckets.size).toBe(1);
    // Each row's current_value must match the metric in the just-saved evidence.
    for (const o of obs1) {
      const expected =
        o.metric === 'gmv' ? 1068
        : o.metric === 'orders' ? 109
        : o.metric === 'uv' ? 623
        : o.metric === 'cvr' ? 0.13
        : null;
      expect(o.current_value).toBe(expected);
    }
  });

  it('re-run within the same hour bucket dedupes via UNIQUE (situation_id, metric, business_time_bucket)', async () => {
    // Direct INSERT simulation: same (situation_id, metric, bucket) twice
    // must be a no-op. The producer's natural call path uses
    // new Date().toISOString() for acquired_at, so two rapid producer
    // runs would generate different ms — testing the schema invariant
    // directly is more reliable than racing the clock.
    db.prepare(
      `INSERT INTO evidence_observations (
         shop_id, capability, data_type, business_date, business_time_bucket,
         acquired_at, content_hash, evidence_file_path, content_size, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'jd_shop_001', 'trade.overview', 'getSummary', '2026-09-01', '2026-09-01T08',
      '2026-09-01T00:00:00.000Z', 'hash-X', '/tmp/a.json', 100, '2026-09-01T00:00:00.000Z',
    );
    const evoId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

    db.prepare(
      `INSERT INTO situation_observations (
         situation_id, metric, business_time_bucket, observed_at,
         current_value, baseline_value, change_pct, evidence_observation_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sit_1', 'gmv', '2026-09-01T08', '2026-09-01T00:08:30.000Z',
      1068, 534, 100, evoId, '2026-09-01T00:08:30.000Z',
    );
    // Identical natural key (sit_1, gmv, 2026-09-01T08) → second insert
    // must be a no-op.
    db.prepare(
      `INSERT OR IGNORE INTO situation_observations (
         situation_id, metric, business_time_bucket, observed_at,
         current_value, baseline_value, change_pct, evidence_observation_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sit_1', 'gmv', '2026-09-01T08', '2026-09-01T00:09:00.000Z',
      1100, 534, 106, evoId, '2026-09-01T00:09:00.000Z',
    );
    const n = (db.prepare('SELECT COUNT(*) AS n FROM situation_observations').get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it('two distinct hour buckets for the same situation append two rows (History grows)', async () => {
    // Direct INSERT keeps the test deterministic (producer paths depend
    // on wall-clock acquired_at).
    db.prepare(
      `INSERT INTO evidence_observations (
         shop_id, capability, data_type, business_date, business_time_bucket,
         acquired_at, content_hash, evidence_file_path, content_size, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'jd_shop_001', 'trade.overview', 'getSummary', '2026-09-01', '2026-09-01T08',
      '2026-09-01T00:00:00.000Z', 'hash-Y', '/tmp/y.json', 100, '2026-09-01T00:00:00.000Z',
    );
    const evoId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;

    db.prepare(
      `INSERT INTO situation_observations (
         situation_id, metric, business_time_bucket, observed_at,
         current_value, baseline_value, change_pct, evidence_observation_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('sit_1', 'gmv', '2026-09-01T08', '2026-09-01T00:08:30.000Z', 1068, 534, 100, evoId, '2026-09-01T00:08:30.000Z');
    db.prepare(
      `INSERT INTO situation_observations (
         situation_id, metric, business_time_bucket, observed_at,
         current_value, baseline_value, change_pct, evidence_observation_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('sit_1', 'gmv', '2026-09-01T09', '2026-09-01T01:08:30.000Z', 2100, 1068, 96.6, evoId, '2026-09-01T01:08:30.000Z');

    const rows = db
      .prepare(
        "SELECT business_time_bucket, current_value " +
          "FROM situation_observations WHERE metric = 'gmv' ORDER BY business_time_bucket",
      )
      .all() as Array<{ business_time_bucket: string; current_value: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].business_time_bucket).toBe('2026-09-01T08');
    expect(rows[1].business_time_bucket).toBe('2026-09-01T09');
    expect(rows[1].current_value).toBe(2100);
  });

  it('Fact Refresh and Detection Threshold are decoupled — observation appends even when changePct < 20%', async () => {
    // Insert an existing Situation row that Phase A will refresh.
    db.prepare(
      `INSERT INTO situations (
         situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
         observed_at, window_start, window_end, description, tags, lifecycle, created_at, updated_at,
         latest_current_value, latest_baseline_value, latest_change_pct,
         latest_evidence_id, latest_evidence_acquired_at, latest_evidence_content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sit_existing', 'ecommerce', 'performance_analysis', 'jd_shop_001', 'shop', 'test', 'jd',
      '2026-09-01T00:00:00.000Z', '2026-08-31', '2026-09-01',
      'test 访客数 较昨日上升 10.0%，从 500 变为 550。',
      JSON.stringify(['meaningful_change', 'uv', 'up']),
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
      550, 500, 10, null, null, null,
    );
    // Save evidence with all compareValues very close to current → all
    // changePcts < 20% → Phase B emits no new situations; Phase A still
    // refreshes the existing uv situation and appends its observation.
    await seedGetSummary('2026-09-01', 1060, 110, 615, 0.131, {
      compareGm: 1040,
      compareOrders: 108,
      compareUv: 550,
      compareCvr: 0.13,
    });
    const refresh = runSituationProducer(db, {
      shopId: TEST_SHOP,
      shopName: '测试',
      platform: TEST_PLATFORM,
    });
    expect(refresh.created).toBe(0); // no new situation from detection (all < 20%)
    expect(refresh.refreshed).toBeGreaterThan(0);
    const obs = (db.prepare('SELECT COUNT(*) AS n FROM situation_observations').get() as { n: number }).n;
    expect(obs).toBeGreaterThan(0);
  });
});
