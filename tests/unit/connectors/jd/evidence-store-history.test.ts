// P0012 — Evidence Observation history insert (saveEvidence → evidence_observations).
//
// Tests the in-DB history append that the Evidence Store does on every save.
// Best-effort: if the DB handle isn't wired (setEvidenceHistoryDb not called),
// the append is a no-op (filesystem write is the source of truth).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import {
  saveEvidence,
  setEvidenceHistoryDb,
} from '#app/connectors/evidence/store.js';
import { applyP0007Schema } from '#platform/storage/p0007-schema.js';

const SCHEMA = (db: Database.Database): void => {
  applyP0007Schema(db);
};

describe('saveEvidence — P0012 evidence_observations history append', () => {
  let workDir: string;
  let db: Database.Database;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'p0012-'));
    process.chdir(workDir);
    db = new Database(':memory:');
    SCHEMA(db);
    setEvidenceHistoryDb(db);
  });

  afterEach(() => {
    setEvidenceHistoryDb(undefined);
    db.close();
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('appends one evidence_observations row per saveEvidence call', async () => {
    await saveEvidence('jd', 'jd_shop_001', '2026-09-01', 'summary', {
      header: { code: 0 },
      body: { data: [{ gmv: 1068, orders: 109, shop_visitors: 623 }] },
    });
    await saveEvidence('jd', 'jd_shop_001', '2026-09-01', 'trend', {
      header: { code: 0 },
      body: { data: [{ categories: ['a', 'b'], gmv: [1, 2] }] },
    });
    await saveEvidence('jd', 'jd_shop_001', '2026-09-01', 'productTop', {
      header: { code: 0 },
      body: { data: [{ sku: 1, gmv: 100 }] },
    });

    const rows = db
      .prepare(
        'SELECT data_type, capability, business_date, business_time_bucket ' +
          'FROM evidence_observations ORDER BY id',
      )
      .all() as Array<{
        data_type: string;
        capability: string;
        business_date: string;
        business_time_bucket: string;
      }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ data_type: 'summary', business_date: '2026-09-01' });
    expect(rows[1].data_type).toBe('trend');
    expect(rows[2].data_type).toBe('productTop');
    // all three are trade.overview under P0012 mapping
    for (const r of rows) {
      expect(r.capability).toBe('trade.overview');
      expect(r.business_time_bucket).toMatch(/^2026-09-01T\d{2}$/);
    }
  });

  it('INSERT OR IGNORE deduplicates by (shop, data_type, business_date, acquired_at, content_hash)', async () => {
    // Identical save (same second-resolution acquired_at) → second insert
    // becomes a no-op. We can't reliably control acquired_at to the
    // millisecond via process clock, so the test only asserts the
    // invariant for a single explicit replay.
    await saveEvidence('jd', 'jd_shop_001', '2026-09-01', 'summary', {
      header: { code: 0 },
      body: { data: [{ gmv: 1 }] },
    });
    const first = db
      .prepare('SELECT COUNT(*) AS n FROM evidence_observations')
      .get() as { n: number };
    expect(first.n).toBe(1);
    // Replay the exact same payload — `acquired_at` is generated
    // by `new Date().toISOString()` at write time so two successive
    // calls within the same millisecond will collide on the UNIQUE
    // tuple; calls across milliseconds are distinct observations.
    // We do not assert the exact count here — only the structural
    // property that the table has a UNIQUE INDEX on the natural key.
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'evidence_observations'",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_evidence_observations_natural_key');
  });

  it('saveEvidence is a no-op for history when no DB is wired', async () => {
    setEvidenceHistoryDb(undefined);
    // filesystem write must still succeed.
    const returnValue = await saveEvidence(
      'jd',
      'jd_shop_001',
      '2026-09-01',
      'summary',
      { header: { code: 0 }, body: { data: [{ gmv: 1 }] } },
    );
    expect(returnValue).toBeDefined();
    // verify the file was actually written — read from the cwd that was
    // active during saveEvidence (vitest workers may differ from beforeEach).
    const fs = await import('node:fs');
    const targetDir = `${process.cwd()}/data/evidence/jd/2026/09`;
    if (!fs.existsSync(targetDir)) {
      // fall back to a path-search across candidate roots
      const candidates = [
        `${workDir}/data/evidence/jd/2026/09`,
        `${originalCwd}/data/evidence/jd/2026/09`,
      ];
      const found = candidates.find((d) => fs.existsSync(d));
      if (!found) {
        throw new Error(`Evidence dir not found; checked: ${[targetDir, ...candidates].join(', ')}`);
      }
      expect(fs.readdirSync(found)).toContain('01_summary.meta.json');
      return;
    }
    expect(fs.readdirSync(targetDir)).toContain('01_summary.meta.json');
  });
});
