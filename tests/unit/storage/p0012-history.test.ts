// P0012 — Storage layer: evidence_observations + situation_observations tables
// and their indexes exist after applyP0007Schema, and the UNIQUE constraints
// block duplicate inserts while allowing distinct observations.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { applyP0007Schema } from '#platform/storage/p0007-schema.js';

describe('P0012 schema — evidence_observations + situation_observations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyP0007Schema(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates both tables with all expected columns', () => {
    for (const table of ['evidence_observations', 'situation_observations']) {
      const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('id');
    }
    // evidence_observations columns
    const evoCols = db.prepare('PRAGMA table_info(evidence_observations)').all() as Array<{ name: string }>;
    const evoNames = evoCols.map((c) => c.name);
    expect(evoNames).toEqual(
      expect.arrayContaining([
        'id', 'shop_id', 'capability', 'data_type', 'business_date',
        'business_time_bucket', 'acquired_at', 'content_hash',
        'evidence_file_path', 'content_size', 'created_at',
      ]),
    );
    // situation_observations columns
    const soCols = db.prepare('PRAGMA table_info(situation_observations)').all() as Array<{ name: string }>;
    const soNames = soCols.map((c) => c.name);
    expect(soNames).toEqual(
      expect.arrayContaining([
        'id', 'situation_id', 'metric', 'business_time_bucket', 'observed_at',
        'current_value', 'baseline_value', 'change_pct',
        'evidence_observation_id', 'created_at',
      ]),
    );
  });

  it('creates the required indexes including the natural-key UNIQUE indexes', () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('evidence_observations','situation_observations')")
      .all() as Array<{ name: string }>;
    const names = idx.map((i) => i.name);
    expect(names).toContain('idx_evidence_observations_natural_key');
    expect(names).toContain('idx_evidence_observations_lookup');
    expect(names).toContain('idx_situation_observations_natural_key');
    expect(names).toContain('idx_situation_observations_lookup');
  });

  it('UNIQUE on (shop_id, data_type, business_date, acquired_at, content_hash) blocks evidence duplicates', () => {
    db.prepare(
      `INSERT INTO evidence_observations (
         shop_id, capability, data_type, business_date, business_time_bucket,
         acquired_at, content_hash, evidence_file_path, content_size, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'jd_shop_001', 'trade.overview', 'getSummary', '2026-09-01', '2026-09-01T08',
      '2026-09-01T00:08:30.000Z', 'hash-A', '/tmp/a.json', 100, '2026-09-01T00:08:30.000Z',
    );
    // exact same natural key → must throw a UNIQUE-constraint error.
    expect(() => {
      db.prepare(
        `INSERT INTO evidence_observations (
           shop_id, capability, data_type, business_date, business_time_bucket,
           acquired_at, content_hash, evidence_file_path, content_size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'jd_shop_001', 'trade.overview', 'getSummary', '2026-09-01', '2026-09-01T08',
        '2026-09-01T00:08:30.000Z', 'hash-A', '/tmp/b.json', 200, '2026-09-01T00:08:30.000Z',
      );
    }).toThrow(/UNIQUE constraint failed/);
    const cnt = (db.prepare('SELECT COUNT(*) AS n FROM evidence_observations').get() as { n: number }).n;
    expect(cnt).toBe(1);
  });

  it('UNIQUE on (situation_id, metric, business_time_bucket) blocks situation-observation duplicates', () => {
    // Need a parent evidence_observations row because the column is
    // declared with a FOREIGN KEY reference.
    const evo = db.prepare(
      `INSERT INTO evidence_observations (
         shop_id, capability, data_type, business_date, business_time_bucket,
         acquired_at, content_hash, evidence_file_path, content_size, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'jd_shop_001', 'trade.overview', 'getSummary', '2026-09-01', '2026-09-01T08',
      '2026-09-01T00:08:30.000Z', 'hash-A', '/tmp/a.json', 100, '2026-09-01T00:08:30.000Z',
    );
    const evidenceObservationId = Number(evo.lastInsertRowid);

    db.prepare(
      `INSERT INTO situation_observations (
         situation_id, metric, business_time_bucket, observed_at,
         current_value, baseline_value, change_pct, evidence_observation_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sit_1', 'gmv', '2026-09-01T08', '2026-09-01T00:08:30.000Z',
      1068, 534, 100, evidenceObservationId, '2026-09-01T00:08:30.000Z',
    );
    // exact same (situation_id, metric, business_time_bucket) → must throw.
    expect(() => {
      db.prepare(
        `INSERT INTO situation_observations (
           situation_id, metric, business_time_bucket, observed_at,
           current_value, baseline_value, change_pct, evidence_observation_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'sit_1', 'gmv', '2026-09-01T08', '2026-09-01T00:09:00.000Z',
        1100, 534, 106, evidenceObservationId, '2026-09-01T00:09:00.000Z',
      );
    }).toThrow(/UNIQUE constraint failed/);
    const cnt = (db.prepare('SELECT COUNT(*) AS n FROM situation_observations').get() as { n: number }).n;
    expect(cnt).toBe(1);
  });

  it('re-running applyP0007Schema is idempotent (CREATE TABLE IF NOT EXISTS)', () => {
    expect(() => applyP0007Schema(db)).not.toThrow();
    expect(() => applyP0007Schema(db)).not.toThrow();
  });
});
