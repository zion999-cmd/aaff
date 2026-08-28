// Chat endpoint contract tests — validates the natural language agent loop.
// P0006: User → HermesAgent (intent) → Kernel (execute) → HermesAgent (response) → Workspace

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { upsertOrders, upsertProducts } from '#platform/storage/product-repository.js';
import { createServer } from '#platform/server/index.js';
import { resetKernel } from '#platform/server/routes/runtime.js';
import { canonicalOrders, canonicalProducts } from '../fixtures/canonical-product.js';

const TEMP_DB = './data/test-chat.db';

describe('Chat endpoint (contract)', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    rmSync(TEMP_DB, { force: true });
    const db = openDb(TEMP_DB);
    initDatabase(db);
    upsertProducts(db, canonicalProducts);
    upsertOrders(db, canonicalOrders);
    resetKernel();
    const app = createServer({ db, workspaceDir: './apps/ecommerce/workspace' });
    server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3000;
    base = `http://localhost:${port}`;
  });

  afterAll(() => {
    resetKernel();
    server.close();
    rmSync(TEMP_DB, { force: true });
    rmSync(`${TEMP_DB}-wal`, { force: true });
    rmSync(`${TEMP_DB}-shm`, { force: true });
  });

  test('POST /api/chat returns reply + intent + execution', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '帮我查看京东店铺的销售数据' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['success']).toBe(true);

    // Response structure
    expect(typeof data['reply']).toBe('string');
    expect((data['reply'] as string).length).toBeGreaterThan(0);
    expect(typeof data['intent']).toBe('string');
    expect(['pattern', 'hermes']).toContain(data['method']);

    // Execution data
    const execution = data['execution'] as Record<string, unknown>;
    expect(execution).toBeDefined();
    expect(typeof execution['success']).toBe('boolean');
    expect(typeof execution['skillName']).toBe('string');
    expect(execution['data']).toBeDefined();
  });

  test('POST /api/chat with ranking intent processes correctly', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '帮我分析一下商品排名' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['success']).toBe(true);

    // With StubHermesClient, the intent should be matched by pattern
    const execution = data['execution'] as Record<string, unknown>;
    expect(execution['success']).toBe(true);
  });

  test('POST /api/chat with general question gets general_question intent', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你能做什么？' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Record<string, unknown>;
    expect(res.status).toBe(200);

    // Should match "帮助" pattern in general_question's intentPatterns
    expect(data['intent']).toBe('general_question');
  });

  test('POST /api/chat validates message is required', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body['success']).toBe(false);
  });

  test('GET /api/chat/skills lists available skills', async () => {
    const res = await fetch(`${base}/api/chat/skills`);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Array<Record<string, unknown>>;
    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(4);
    // Each skill should have required fields
    for (const skill of data) {
      expect(skill['name']).toBeTruthy();
      expect(skill['displayName']).toBeTruthy();
      expect(skill['description']).toBeTruthy();
      expect(skill['handler']).toBeTruthy();
    }
  });

  // P0010.2.9: collect_data invokes the live CDP path
  // (acquireJdTradeOverviewViaCDP navigates to the page and captures
  // getSummary.ajax + getTrend.ajax responses). 30s covers page load +
  // SPA bootstrap + signed-request round-trip.
  test('POST /api/chat with collect intent executes collect_data skill', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '帮我采集今天的店铺数据' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Record<string, unknown>;
    expect(res.status).toBe(200);

    // Pattern match should detect "采集" → collect_data
    const execution = data['execution'] as Record<string, unknown>;
    expect(execution['skillName']).toBe('collect_data');
    expect(execution['success']).toBe(true);
  }, 30_000);
});
