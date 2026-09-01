// Unit tests for Evidence Store — save, load, list round-trips.

import { describe, expect, test, afterAll } from 'vitest';
import { saveEvidence, loadEvidence, listEvidence } from '#app/connectors/evidence/store.js';
import { EvidenceMetadataSchema, EvidenceRecordSchema } from '#app/connectors/evidence/types.js';
import { rmSync } from 'node:fs';

const TEST_PLATFORM = 'test-platform';
const TEST_DATE = '2026-06-30';
const TEST_SHOP = 'test-shop';

describe('Evidence Store', () => {
  afterAll(() => {
    // Clean up test evidence
    try { rmSync('data/evidence/test-platform', { recursive: true }); } catch { /* ok */ }
  });

  test('saveEvidence returns a valid EvidenceRecord', async () => {
    const payload = { gmv: 1234, orders: 42 };
    const record = await saveEvidence(TEST_PLATFORM, TEST_SHOP, TEST_DATE, 'summary', payload, {
      method: 'mock',
      operator: 'test',
    });

    const parsed = EvidenceRecordSchema.parse(record);
    expect(parsed.evidence_id).toBeDefined();
    expect(parsed.metadata.source).toBe(TEST_PLATFORM);
    expect(parsed.metadata.shop_id).toBe(TEST_SHOP);
    expect(parsed.metadata.data_type).toBe('summary');
    expect(parsed.metadata.method).toBe('mock');
    expect(parsed.metadata.operator).toBe('test');
    expect(parsed.metadata.content_hash).toBeDefined();
    expect(parsed.file_path).toContain('30_summary.json');
    expect(parsed.file_size).toBeGreaterThan(0);
  });

  test('saveEvidence creates both .json and .meta.json files', async () => {
    const payload = { visitors: 500 };
    const record = await saveEvidence(TEST_PLATFORM, TEST_SHOP, TEST_DATE, 'traffic', payload);

    const loaded = loadEvidence(TEST_PLATFORM, TEST_DATE, 'traffic');
    expect(loaded).not.toBeNull();
    expect(loaded!.data).toEqual(payload);
    expect(loaded!.record.metadata.content_hash).toBe(record.metadata.content_hash);
  });

  test('loadEvidence returns null for non-existent evidence', async () => {
    const result = loadEvidence('nonexistent', '2020-01-01', 'summary');
    expect(result).toBeNull();
  });

  test('listEvidence filters by source', async () => {
    await saveEvidence(TEST_PLATFORM, TEST_SHOP, '2026-06-28', 'summary', { x: 1 });
    await saveEvidence(TEST_PLATFORM, TEST_SHOP, '2026-06-29', 'summary', { x: 2 });

    const results = listEvidence({ source: TEST_PLATFORM, limit: 50 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // All results should be from the test platform
    for (const r of results) {
      expect(r.metadata.source).toBe(TEST_PLATFORM);
    }
  });

  test('listEvidence filters by dataType', async () => {
    await saveEvidence(TEST_PLATFORM, TEST_SHOP, '2026-06-27', 'trend', { hourly: [] });
    await saveEvidence(TEST_PLATFORM, TEST_SHOP, '2026-06-27', 'summary', { gmv: 100 });

    const summaries = listEvidence({ source: TEST_PLATFORM, dataType: 'summary', limit: 50 });
    for (const r of summaries) {
      expect(r.metadata.data_type).toBe('summary');
    }
  });

  test('EvidenceMetadata schema validates correctly', async () => {
    const meta = EvidenceMetadataSchema.parse({
      source: 'jd',
      shop_id: 'jd_001',
      data_type: 'summary',
      // P0010.2.10 — business_date is now a required schema field.
      business_date: '2026-06-30',
      acquired_at: new Date().toISOString(),
      method: 'cdp',
      version: '1.0.0',
      operator: 'system',
      runtime: 'playwright',
      connector: 'jd',
      content_hash: 'abc123',
      mime_type: 'application/json',
    });
    expect(meta.source).toBe('jd');
    expect(meta.business_date).toBe('2026-06-30');
  });

  // P0010.2.10 — legacy .meta.json files written before the business_date
  // field existed must still be readable. listEvidence / loadEvidence inject
  // business_date from the path so the schema's "required" constraint never
  // rejects an existing on-disk file. Pin this behavior.
  test('loadEvidence injects business_date from the path for legacy metadata', async () => {
    // Write a legacy .meta.json directly to disk WITHOUT business_date,
    // simulating the pre-P0010.2.10 era. Everything else matches the
    // real on-disk shape (see data/evidence/jd/2026/08/20_summary.meta.json).
    const legacyDate = '2026-06-25';
    const legacyType = 'summary-legacy';
    const platformDir = `data/evidence/${TEST_PLATFORM}/2026/06`;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(platformDir, { recursive: true });
    fs.writeFileSync(
      `${platformDir}/25_${legacyType}.json`,
      JSON.stringify({ legacy: true }),
      'utf-8',
    );
    fs.writeFileSync(
      `${platformDir}/25_${legacyType}.meta.json`,
      JSON.stringify({
        source: TEST_PLATFORM,
        shop_id: TEST_SHOP,
        data_type: legacyType,
        // ← NO business_date in this legacy payload
        acquired_at: '2026-06-25T12:00:00.000Z',
        acquisition_method: 'cdp',
        processing_method: 'runtime',
        method: 'cdp',
        version: '1.0.0',
        operator: 'system',
        runtime: 'node',
        connector: TEST_PLATFORM,
        content_hash: 'legacy-hash',
        mime_type: 'application/json',
        tags: [],
      }),
      'utf-8',
    );

    const loaded = loadEvidence(TEST_PLATFORM, legacyDate, legacyType);
    expect(loaded).not.toBeNull();
    expect(loaded!.record.metadata.business_date).toBe(legacyDate);
  });

  // P0010.2.10 — same path-based fallback applies to listEvidence. Without
  // it, every pre-P0010.2.10 evidence file would fail schema.parse and be
  // silently dropped from listings.
  test('listEvidence injects business_date from the path for legacy metadata', async () => {
    // The previous test already wrote 25_summary-legacy.* files.
    const results = listEvidence({
      source: TEST_PLATFORM,
      dataType: 'summary-legacy',
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.metadata.business_date).toBe('2026-06-25');
  });
});
