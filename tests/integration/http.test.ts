import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { upsertOrders, upsertProducts } from '#platform/storage/product-repository.js';
import { createServer } from '#platform/server/index.js';
import { canonicalNow, canonicalOrders, canonicalProducts } from '../fixtures/canonical-product.js';

const TEMP_DB = './data/test-http.db';

describe('HTTP server (integration)', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    rmSync(TEMP_DB, { force: true });
    const db = openDb(TEMP_DB);
    initDatabase(db);
    upsertProducts(db, canonicalProducts);
    upsertOrders(db, canonicalOrders);
    const app = createServer({ db, workspaceDir: './apps/ecommerce/workspace' });
    server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3000;
    base = `http://localhost:${port}`;
  });

  afterAll(() => {
    server.close();
    rmSync(TEMP_DB, { force: true });
    rmSync(`${TEMP_DB}-wal`, { force: true });
    rmSync(`${TEMP_DB}-shm`, { force: true });
  });

  test('GET /api/health returns ok', async () => {
    const res = await fetch(`${base}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['success']).toBe(true);
    expect((body['data'] as Record<string, unknown>)['status']).toBe('ok');
  });

  test('POST /api/ranking returns ranked results + trace + ai_summary', async () => {
    const res = await fetch(`${base}/api/ranking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'operator_mode', now: canonicalNow().toISOString() }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['success']).toBe(true);
    expect(data['rankings']).toHaveLength(canonicalProducts.length);
    expect((data['top_trace'] as Record<string, unknown>)['alignment']).toBeDefined();
    expect(typeof data['ai_summary']).toBe('string');
  });

  test('GET /api/ranking/:profile loads persisted rankings', async () => {
    const res = await fetch(`${base}/api/ranking/operator_mode`);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Array<unknown>;
    expect(res.status).toBe(200);
    expect(data.length).toBe(canonicalProducts.length);
  });

  test('ranking carries current trace_id; /api/trace/:traceId returns the real trace', async () => {
    const res = await fetch(`${base}/api/ranking/operator_mode`);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Array<Record<string, unknown>>;
    const withTrace = data.filter(
      (r) => typeof r['trace_id'] === 'string' && (r['trace_id'] as string).length > 0,
    );
    // persistComposition stores a trace for the top ranking → at least one live link.
    expect(withTrace.length).toBeGreaterThanOrEqual(1);

    const traceId = withTrace[0]!['trace_id'] as string;
    const tRes = await fetch(`${base}/api/trace/${traceId}`);
    const tBody = (await tRes.json()) as Record<string, unknown>;
    const trace = tBody['data'] as Record<string, unknown>;
    expect(tRes.status).toBe(200);
    const alignment = trace['alignment'] as Record<string, unknown>;
    expect(typeof alignment['trust_score']).toBe('number');
    expect(alignment['trust_score']).toBeGreaterThanOrEqual(0);
    expect(trace['system_truth']).toBeDefined();
    expect((trace['system_truth'] as Record<string, unknown>)['ranking']).toBeDefined();
  });

  test('GET /api/workspace/findings returns a discoveries feed', async () => {
    const res = await fetch(`${base}/api/workspace/findings?profile=operator_mode`);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Array<Record<string, unknown>>;
    expect(res.status).toBe(200);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]!['discovery_type']).toMatch(/opportunity|risk|review|memory/);
  });

  test('GET /api/signals returns signals', async () => {
    const res = await fetch(`${base}/api/signals`);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Array<unknown>;
    expect(res.status).toBe(200);
    expect(data.length).toBeGreaterThan(0);
  });

  test('GET /api/evidence/:capabilityId returns recent records sorted newest-first', async () => {
    const res = await fetch(`${base}/api/evidence/product.overview`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;

    const evidence = data['evidence'] as { totalRecords: number; recentRecords: Array<{ metadata: { acquired_at: string } }> };
    expect(Array.isArray(evidence.recentRecords)).toBe(true);
    expect(evidence.recentRecords.length).toBeLessThanOrEqual(10);
    expect(evidence.totalRecords).toBeGreaterThanOrEqual(evidence.recentRecords.length);

    // recentRecords must be the NEWEST records (sorted by acquired_at descending),
    // not the first N of an ascending directory walk.
    const acquired = evidence.recentRecords.map((r) => r.metadata.acquired_at);
    const sorted = [...acquired].sort((a, b) => b.localeCompare(a));
    expect(acquired).toEqual(sorted);

    // provenance fields the Evidence Viewer renders
    const provider = data['provider'] as Record<string, unknown>;
    expect(typeof provider['platform']).toBe('string');
    expect(typeof provider['acquisition']).toBe('string');
  });

  test('GET /api/knowledge/status enumerates raw sources with provenance markers', async () => {
    const res = await fetch(`${base}/api/knowledge/status`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const status = body['data'] as {
      sources: Array<{ path: string; file: string; size: number; referenced: boolean; referencedBy: string[] }>;
      total: number;
      referencedCount: number;
      pendingCount: number;
    };
    expect(Array.isArray(status.sources)).toBe(true);
    expect(status.total).toBe(status.sources.length);
    expect(status.referencedCount + status.pendingCount).toBe(status.total);
    // Every raw source must be enumerated with provenance state.
    for (const s of status.sources) {
      expect(typeof s.path).toBe('string');
      expect(s.path.startsWith('knowledge-sources/raw/')).toBe(true);
      expect(typeof s.referenced).toBe('boolean');
      expect(Array.isArray(s.referencedBy)).toBe(true);
      // platform-promotion.md is seeded and referenced by the seed page.
      // P0011: knowledge pages live under SEMANTIC DOMAIN dirs — 内容化推广
      // (a platform promotion product) is seeded under operations/.
      if (s.file === 'platform-promotion.md') {
        expect(s.referenced).toBe(true);
        expect(s.referencedBy.some((p) => p.includes('knowledge/operations'))).toBe(true);
      }
    }
  });
});
