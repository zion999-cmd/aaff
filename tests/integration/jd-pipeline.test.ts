// Integration test: full JD pipeline — acquire → parse → evidence → normalize.
// Uses mock mode (no CDP needed).

import { describe, expect, test } from 'vitest';
import { acquireJdData, mockJdPayload, mockJdData } from '#app/connectors/jd/acquisition/index.js';
import { parseJdPayload } from '#app/connectors/jd/parsers/index.js';
import { saveEvidence } from '#app/connectors/evidence/store.js';
import { normalizeSignal } from '#app/connectors/normalizer.js';
import { JD_MANIFEST } from '#app/connectors/jd/manifest.js';

describe('JD Pipeline (integration)', () => {
  test('mock acquisition → parse → evidence → normalize full flow', async () => {
    const date = '2026-06-30';
    const shopId = 'jd_shop_001';

    // 1. Acquire
    const result = await acquireJdData({ shopId, date, mock: true });
    expect(result.success).toBe(true);
    expect(result.method).toBe('mock');
    expect(result.data).toBeDefined();
    expect(result.rawPayload).toBeDefined();

    // 2. Parse (already done by acquireJdData, but verify directly)
    const parsed = parseJdPayload(result.rawPayload!);
    expect(parsed.summary.gmv).toBeGreaterThan(0);
    expect(parsed.hourly_gmv.length).toBeGreaterThan(0);
    expect(parsed.top_products.length).toBeGreaterThan(0);

    // 3. Evidence
    const evidenceRecord = await saveEvidence('jd', shopId, date, 'summary', result.rawPayload!['summary'] ?? {}, {
      method: result.method,
    });
    expect(evidenceRecord.evidence_id).toBeDefined();
    expect(evidenceRecord.metadata.source).toBe('jd');
    expect(evidenceRecord.metadata.method).toBe('mock');

    // 4. Normalize → EnterpriseSignal
    const signalInput = {
      signal_id: 'test-jd-pipeline',
      source: 'jd' as const,
      shop_id: shopId,
      signal_type: 'daily_summary' as const,
      priority: 0.5,
      timestamp: new Date().toISOString(),
      metrics: {
        gmv: parsed.summary.gmv,
        orders: parsed.summary.orders,
        // P0010.2.9: uv maps to shop-level (the live page's value)
        uv: parsed.summary.shop_visitors,
        // cvr maps to shop-level deal rate
        cvr: parsed.summary.shop_conversion_rate,
      },
      confidence: 0.9,
    };
    const signal = normalizeSignal(signalInput);
    expect(signal.signal_id).toBe('test-jd-pipeline');
    expect(signal.entity_type).toBe('product');
    expect(signal.signal_unit).toBe('currency');
    expect(signal.window).toBe('24h');
  });

  test('mockJdPayload produces valid structure', () => {
    const payload = mockJdPayload('2026-06-01');
    expect(payload.shopName).toBe('祁门红茶官方旗舰店');
    expect(payload.shopId).toBe('jd_shop_001');
    expect(payload.summary).toHaveLength(1);
    expect(payload.trend).toHaveLength(1);
    expect(payload.productTop).toHaveLength(1);
  });

  test('mockJdData produces valid parsed data', () => {
    const data = mockJdData('2026-06-15');
    expect(data.date).toBe('2026-06-15');
    expect(data.summary.gmv).toBeGreaterThan(0);
    expect(data.hourly_gmv).toHaveLength(24);
    expect(data.top_products).toHaveLength(5);
  });

  test('manifest declares correct capabilities', () => {
    expect(JD_MANIFEST.source).toBe('jd');
    // P0005.4: signal_types are derived from the generated blueprint
    expect(JD_MANIFEST.signal_types).toContain('daily_summary');
    expect(JD_MANIFEST.signal_types.length).toBeGreaterThanOrEqual(2);
    // P0005.4: business_context is derived from the generated blueprint (10 contexts from Discovery)
    expect(JD_MANIFEST.business_context).toContain('store');
    expect(JD_MANIFEST.business_context).toContain('transaction');
    expect(JD_MANIFEST.business_context.length).toBeGreaterThanOrEqual(5);
    expect(JD_MANIFEST.acquisition_methods).toContain('Mock (Development/Test)');
    expect(JD_MANIFEST.evidence_chain.length).toBeGreaterThan(0);
  });
});
