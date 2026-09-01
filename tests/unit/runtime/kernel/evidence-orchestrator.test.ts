// Tests for runtime-evidence-orchestrator — blueprint-driven evidence capture.
// P0005.5: Validates evidence capture from blueprint evidence_strategy.capture_rules.
// P0006.3.2.1: Updated for acquisition_method + processing_method signature.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureEvidence } from '#app/runtime/kernel/runtime-evidence-orchestrator.js';
import type { EvidenceCapture } from '#app/connectors/binding/types.js';

const TEST_DATE = '2026-07-04';
const EVIDENCE_ROOT = resolve(process.cwd(), 'data', 'evidence');

const makeCaptureRules = (): EvidenceCapture[] => [
  { endpoint: 'summary.ajax', capture_screenshot: true, capture_dom: true, capture_raw_response: true, capture_metadata: true },
  { endpoint: 'trend.ajax', capture_screenshot: false, capture_dom: false, capture_raw_response: true, capture_metadata: true },
  { endpoint: 'getProductList', capture_screenshot: true, capture_dom: true, capture_raw_response: false, capture_metadata: true },
];

const cleanup = () => {
  const testDir = resolve(EVIDENCE_ROOT, 'jd', '2026', '07');
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
};

describe('captureEvidence', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test('captures evidence for endpoints with capture_raw_response:true and available data', async () => {
    const rawPayloads: Record<string, unknown> = {
      'summary.ajax': { gmv: 10000, orders: 50 },
      'trend.ajax': [{ hour: '10:00', gmv: 500 }],
      'getProductList': { products: [] },
    };

    const results = await captureEvidence(
      'jd', 'jd_shop_001', TEST_DATE, rawPayloads,
      makeCaptureRules(), 'mock', 'runtime',
    );

    // summary.ajax: capture_raw_response=true, data available → captured
    // trend.ajax: capture_raw_response=true, data available → captured
    // getProductList: capture_raw_response=false → skipped
    expect(results).toHaveLength(2);

    const endpoints = results.map((r) => r.endpoint);
    expect(endpoints).toContain('summary.ajax');
    expect(endpoints).toContain('trend.ajax');
    expect(endpoints).not.toContain('getProductList');
  });

  test('skips endpoints without data in rawPayloads', async () => {
    const rawPayloads: Record<string, unknown> = {
      'summary.ajax': { gmv: 10000 },
    };

    const results = await captureEvidence(
      'jd', 'jd_shop_001', TEST_DATE, rawPayloads,
      makeCaptureRules(), 'mock', 'runtime',
    );

    // Only summary.ajax has data and capture_raw_response=true
    expect(results).toHaveLength(1);
    expect(results[0]!.endpoint).toBe('summary.ajax');
  });

  test('converts endpoint names to human-readable data types', async () => {
    const rawPayloads: Record<string, unknown> = {
      'summary.ajax': { gmv: 10000 },
    };

    const results = await captureEvidence(
      'jd', 'jd_shop_001', TEST_DATE, rawPayloads,
      makeCaptureRules(), 'mock', 'runtime',
    );

    expect(results[0]!.dataType).toBe('summary'); // .ajax stripped
  });

  test('falls back to legacy types when no blueprint rules match', async () => {
    const rawPayloads: Record<string, unknown> = {
      'summary': { gmv: 10000 },
      'trend': [{ hour: '10:00', gmv: 500 }],
      'productTop': [{ sku_id: '123', name: 'test' }],
    };

    // Empty capture rules — no blueprint match
    const results = await captureEvidence(
      'jd', 'jd_shop_001', TEST_DATE, rawPayloads,
      [], 'cdp', 'replay',
    );

    // Falls back to legacy summary/trend/productTop
    expect(results).toHaveLength(3);
    const dataTypes = results.map((r) => r.dataType);
    expect(dataTypes).toContain('summary');
    expect(dataTypes).toContain('trend');
    expect(dataTypes).toContain('productTop');
  });

  test('persists evidence files to disk with provenance metadata', async () => {
    const rawPayloads: Record<string, unknown> = {
      'summary.ajax': { gmv: 10000, orders: 50 },
    };

    await captureEvidence(
      'jd', 'jd_shop_001', TEST_DATE, rawPayloads,
      makeCaptureRules(), 'cdp', 'runtime',
    );

    // Verify evidence file was created
    const evidenceFile = resolve(EVIDENCE_ROOT, 'jd', '2026', '07', '04_summary.json');
    expect(existsSync(evidenceFile)).toBe(true);

    const content = JSON.parse(readFileSync(evidenceFile, 'utf-8'));
    expect(content.gmv).toBe(10000);
    expect(content.orders).toBe(50);

    // Verify provenance in metadata (P0006.3.2.1)
    const metaFile = resolve(EVIDENCE_ROOT, 'jd', '2026', '07', '04_summary.meta.json');
    expect(existsSync(metaFile)).toBe(true);
    const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
    expect(meta.acquisition_method).toBe('cdp');
    expect(meta.processing_method).toBe('runtime');
    expect(meta.processed_at).toBeDefined();
  });
});
