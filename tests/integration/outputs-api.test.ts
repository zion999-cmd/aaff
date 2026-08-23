// P0010.1 Post-Productization REPAIR — Output / WorkItem API Integration Test.
//
// Verifies the 4 minimal routes (GET list / POST create / PATCH transition /
// GET single + collection), all backed by the `learning_contexts.body.outputs[]`
// JSON column (no SQL migration). Asserts the contract:
//   - The status enum has exactly 4 values: ready / delivered / acknowledged / closed.
//   - PATCH enforces the status enum; invalid statuses are rejected.
//   - Missing situation returns 404.
//   - P0010.1 REPAIR-5: GET /api/outputs/:oid reads current understanding /
//     recommendation from the canonical `ctx.investigation.*` path
//     (NOT `ctx.*` top-level), and returns `provenance` with only real
//     facts (hasHuman / hasEvidence / hasKnowledge — hasKnowledge is
//     always false in this slice because there is no first-class
//     Knowledge record).
//   - P0010.1 REPAIR-5: the previously-existing
//     `POST /api/situations/:id/outputs/mark-delivered` side effect
//     has been REMOVED; opening a page does NOT change WorkItem status.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { createServer } from '#platform/server/index.js';

const TEMP_DB = './data/test-outputs-api.db';

describe('P0010.1 Output / WorkItem API (integration)', () => {
  let server: Server;
  let base: string;
  const SIT = 'sit_outputs_test';

  beforeAll(() => {
    rmSync(TEMP_DB, { force: true });
    const db = openDb(TEMP_DB);
    initDatabase(db);
    // Seed a minimal learning_context (the route reads from this row).
    const now = '2026-08-22T08:00:00.000Z';
    db.prepare(
      `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
         observed_at, description, tags, lifecycle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SIT, 'ecommerce', 'anomaly_investigation',
      'jd_shop_001', 'shop', '祁门红茶旗舰店', 'jd',
      '2026-08-22T08:00:00.000Z',
      'test situation for outputs API',
      JSON.stringify(['test']), 'open', now, now,
    );
    db.prepare(
      `INSERT INTO learning_contexts (context_id, situation_id, lifecycle, created_at, updated_at, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'ctx_' + SIT, SIT, 'open', now, now,
      JSON.stringify({
        contextId: 'ctx_' + SIT,
        situation: { situationId: SIT, domain: 'ecommerce', type: 'anomaly_investigation', entity: { id: 'e1', type: 'shop' }, temporal: { observedAt: now }, description: 'x', tags: [] },
        lifecycle: 'open', createdAt: now, updatedAt: now,
        observations: [], evidenceIds: [], signalIds: [],
        agentActivities: [], humanInterventions: [], actions: [], outcomes: [],
        summary: { capabilitiesUsed: [], agentRuntimes: [], humanActors: [], totalEvidence: 0, totalSignals: 0 },
        outputs: [],
      }),
    );
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

  test('GET /api/situations/:id/outputs returns [] on a fresh situation', async () => {
    const res = await fetch(`${base}/api/situations/${SIT}/outputs`);
    const body = (await res.json()) as { success: boolean; data: unknown[] };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test('POST /api/situations/:id/outputs creates a ready WorkItem', async () => {
    const res = await fetch(`${base}/api/situations/${SIT}/outputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'recommendation', content: '先排查库存。' }),
    });
    const body = (await res.json()) as { success: boolean; data: any; error?: string };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ready');
    expect(body.data.type).toBe('recommendation');
    expect(body.data.content).toBe('先排查库存。');
    expect(body.data.outputId).toMatch(/^out_/);
  });

  test('POST /api/situations/:id/outputs rejects invalid type', async () => {
    const res = await fetch(`${base}/api/situations/${SIT}/outputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'not_a_type', content: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  test('P0010.1 REPAIR-5: POST /api/situations/:id/outputs/mark-delivered is GONE (no auto-deliver on page load)', async () => {
    // The previous "open the page = delivered" side effect was REMOVED.
    // Confirm the endpoint no longer exists (404 / 405 — Express returns
    // 404 for unknown routes in this stack).
    const res = await fetch(`${base}/api/situations/${SIT}/outputs/mark-delivered`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    // And: calling it must NOT have changed any WorkItem status to delivered.
    const list = (await (await fetch(`${base}/api/situations/${SIT}/outputs`)).json()) as { data: Array<{ status: string }> };
    const readyStillExists = list.data.some((o) => o.status === 'ready');
    expect(readyStillExists).toBe(true);
  });

  test('PATCH /api/situations/:id/outputs/:oid transitions status', async () => {
    const list = ((await (await fetch(`${base}/api/situations/${SIT}/outputs`)).json()) as { data: Array<{ outputId: string; status: string }> }).data;
    const first = list[0]!;
    const res = await fetch(`${base}/api/situations/${SIT}/outputs/${first.outputId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged' }),
    });
    const body = (await res.json()) as { success: boolean; data: any; error?: string };
    expect(res.status).toBe(200);
    expect(body.data.status).toBe('acknowledged');
    expect(body.data.acknowledgedAt).toBeDefined();
  });

  test('PATCH rejects invalid status', async () => {
    const list = ((await (await fetch(`${base}/api/situations/${SIT}/outputs`)).json()) as { data: Array<{ outputId: string }> }).data;
    const first = list[0]!;
    const res = await fetch(`${base}/api/situations/${SIT}/outputs/${first.outputId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    expect(res.status).toBe(400);
  });

  // ═══ P0010.1 REPAIR-6: forward-only state machine ═══

  test('P0010.1 REPAIR-6: PATCH forward-only — rejected backward transition (acknowledged → delivered)', async () => {
    // Move the first output to 'acknowledged' first.
    const list = ((await (await fetch(`${base}/api/situations/${SIT}/outputs`)).json()) as { data: Array<{ outputId: string; status: string }> }).data;
    const first = list[0]!;
    await fetch(`${base}/api/situations/${SIT}/outputs/${first.outputId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged' }),
    });
    // Now try to roll back: acknowledged → delivered MUST be rejected.
    const res = await fetch(`${base}/api/situations/${SIT}/outputs/${first.outputId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'delivered' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error || '').toMatch(/forward-only|rollback/);
    // And: the WorkItem status did NOT change.
    const after = ((await (await fetch(`${base}/api/situations/${SIT}/outputs`)).json()) as { data: Array<{ outputId: string; status: string }> }).data;
    const stillFirst = after.find((o) => o.outputId === first.outputId)!;
    expect(stillFirst.status).toBe('acknowledged');
  });

  test('P0010.1 REPAIR-6: PATCH forward-only — rejected terminal rollback (closed → ready)', async () => {
    // Create a fresh output, drive it all the way to 'closed' via the
    // canonical skip-ahead path (ready → closed is forward).
    const create = await fetch(`${base}/api/situations/${SIT}/outputs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'analysis', content: 'REPAIR-6 rollback test' }),
    });
    const created = (await create.json()) as { data: { outputId: string } };
    const oid = created.data.outputId;
    await fetch(`${base}/api/situations/${SIT}/outputs/${oid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    });
    // closed is terminal — any further PATCH MUST be rejected.
    for (const target of ['ready', 'delivered', 'acknowledged']) {
      const res = await fetch(`${base}/api/situations/${SIT}/outputs/${oid}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: target }),
      });
      expect(res.status).toBe(400);
    }
    // Sanity: status is still 'closed' and closedAt is preserved.
    const after = ((await (await fetch(`${base}/api/situations/${SIT}/outputs`)).json()) as { data: Array<{ outputId: string; status: string; closedAt?: string }> }).data;
    const target = after.find((o) => o.outputId === oid)!;
    expect(target.status).toBe('closed');
    expect(target.closedAt).toBeDefined();
  });

  test('P0010.1 REPAIR-6: PATCH forward-only — same-status no-op is rejected (no re-stamping of acknowledgedAt/closedAt)', async () => {
    // After the previous test, the 'closed' item is terminal. For
    // non-terminal states, PATCHing the same status would re-stamp
    // acknowledgedAt / closedAt — which is dishonest (a re-ack is
    // not a new event). The handler must reject same-status PATCH.
    const list = ((await (await fetch(`${base}/api/situations/${SIT}/outputs`)).json()) as { data: Array<{ outputId: string; status: string; acknowledgedAt?: string }> }).data;
    const readyOrDelivered = list.find((o) => o.status === 'ready' || o.status === 'delivered' || o.status === 'acknowledged');
    if (!readyOrDelivered) {
      // No suitable target — skip silently (shouldn't happen in normal seed).
      return;
    }
    const oid = readyOrDelivered.outputId;
    const original = readyOrDelivered;
    const res = await fetch(`${base}/api/situations/${SIT}/outputs/${oid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: original.status }),
    });
    expect(res.status).toBe(400);
    // Sanity: timestamps are not changed.
    const after = ((await (await fetch(`${base}/api/situations/${SIT}/outputs`)).json()) as { data: Array<{ outputId: string; status: string; acknowledgedAt?: string; closedAt?: string }> }).data;
    const target = after.find((o) => o.outputId === oid)!;
    expect(target.acknowledgedAt).toBe(original.acknowledgedAt);
    expect(target.closedAt).toBeUndefined();
  });

  test('P0010.1 REPAIR-6: PATCH forward-only — skip-ahead is allowed (ready → acknowledged)', async () => {
    // The previous REPAIR-5 PATCH transitions test already does
    // ready → acknowledged, which is the skip-ahead path. Confirm
    // it still works after the state-machine guard is in place.
    const create = await fetch(`${base}/api/situations/${SIT}/outputs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'recommendation', content: 'REPAIR-6 skip-ahead test' }),
    });
    const created = (await create.json()) as { data: { outputId: string } };
    const oid = created.data.outputId;
    // ready → acknowledged (skip 'delivered' step): must succeed.
    const res = await fetch(`${base}/api/situations/${SIT}/outputs/${oid}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; acknowledgedAt?: string } };
    expect(body.data.status).toBe('acknowledged');
    expect(body.data.acknowledgedAt).toBeDefined();
  });

  test('GET outputs for a missing situation returns [] (not 404) so the UI does not break', async () => {
    const res = await fetch(`${base}/api/situations/sit_does_not_exist/outputs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: any; error?: string };
    expect(body.data).toEqual([]);
  });

  test('POST outputs for a missing situation returns 404', async () => {
    const res = await fetch(`${base}/api/situations/sit_does_not_exist/outputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'recommendation', content: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  test('P0010.1 REPAIR-2: GET /api/situations/:id returns outputs[] + learningContext in the FIRST response', async () => {
    // The detail endpoint must carry outputs (and the rest of the
    // LearningContext) so the Workspace can render the Output/WorkItem
    // section SYNCHRONOUSLY without a second-pass /outputs call.
    const res = await fetch(`${base}/api/situations/${SIT}`);
    const body = (await res.json()) as { success: boolean; data: any; error?: string };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.outputs)).toBe(true);
    expect(body.data.outputs.length).toBeGreaterThan(0);
    expect(body.data.learningContext).toBeDefined();
    expect(Array.isArray(body.data.learningContext.outputs)).toBe(true);
    // Sanity: the response's outputs[] matches learningContext.outputs[].
    expect(body.data.outputs.length).toBe(body.data.learningContext.outputs.length);
  });

  test('P0010.1 REPAIR-2: detail endpoint for a situation with no outputs returns [] (not undefined)', async () => {
    // Seed a fresh situation with no outputs and confirm the detail
    // endpoint still carries an empty outputs[] (so the UI can rely on
    // the field being present).
    const SIT_EMPTY = 'sit_outputs_empty_test';
    const now = '2026-08-22T08:00:00.000Z';
    server.listeners('request')?.[0]; // no-op: keep TS happy
    const { openDb: openDb2 } = await import('#platform/storage/connection.js');
    const db2 = openDb2(TEMP_DB);
    db2.prepare(
      `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
         observed_at, description, tags, lifecycle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SIT_EMPTY, 'ecommerce', 'anomaly_investigation',
      'jd_shop_empty', 'shop', '空测试店', 'jd',
      now, 'test', JSON.stringify([]), 'open', now, now,
    );
    db2.prepare(
      `INSERT INTO learning_contexts (context_id, situation_id, lifecycle, created_at, updated_at, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'ctx_' + SIT_EMPTY, SIT_EMPTY, 'open', now, now,
      JSON.stringify({
        contextId: 'ctx_' + SIT_EMPTY,
        situation: { situationId: SIT_EMPTY, domain: 'ecommerce', type: 'anomaly_investigation', entity: { id: 'e1', type: 'shop' }, temporal: { observedAt: now }, description: 'x', tags: [] },
        lifecycle: 'open', createdAt: now, updatedAt: now,
        observations: [], evidenceIds: [], signalIds: [],
        agentActivities: [], humanInterventions: [], actions: [], outcomes: [],
        summary: { capabilitiesUsed: [], agentRuntimes: [], humanActors: [], totalEvidence: 0, totalSignals: 0 },
        outputs: [],
      }),
    );
    db2.close();
    const res = await fetch(`${base}/api/situations/${SIT_EMPTY}`);
    const body = (await res.json()) as { success: boolean; data: any; error?: string };
    expect(res.status).toBe(200);
    expect(body.data.outputs).toEqual([]);
    expect(body.data.learningContext.outputs).toEqual([]);
  });

  // ═══ P0010.1 REPAIR-3: cross-situation read-only collection ═══

  test('GET /api/outputs returns ALL outputs across all situations (no second Store)', async () => {
    const res = await fetch(`${base}/api/outputs`);
    const body = (await res.json()) as { success: boolean; data: Array<any>; meta?: { total: number } };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // The seed in beforeAll only seeded `SIT` with 1+ outputs (from earlier
    // POSTs). Plus `SIT_EMPTY` (no outputs). So total is whatever was POSTed.
    expect(body.data.length).toBeGreaterThan(0);
    // Each item must carry the situation context (the audit surface).
    for (const o of body.data) {
      expect(o.situation).toBeDefined();
      expect(o.situation.situationId).toBeDefined();
      // Sanity: kind/ref match what we wrote.
      if (o.resultRef && typeof o.resultRef === 'object') {
        expect(['workspace_path', 'learning_context', 'evidence', 'none']).toContain(o.resultRef.kind);
      }
    }
  });

  test('GET /api/outputs?status=ready returns only ready outputs', async () => {
    const res = await fetch(`${base}/api/outputs?status=ready`);
    const body = (await res.json()) as { success: boolean; data: Array<any> };
    expect(res.status).toBe(200);
    for (const o of body.data) {
      expect(o.status).toBe('ready');
    }
  });

  test('GET /api/outputs?status=delivered returns only delivered outputs', async () => {
    const res = await fetch(`${base}/api/outputs?status=delivered`);
    const body = (await res.json()) as { success: boolean; data: Array<any> };
    expect(res.status).toBe(200);
    for (const o of body.data) {
      expect(o.status).toBe('delivered');
    }
  });

  test('GET /api/outputs?status=acknowledged returns only acknowledged outputs', async () => {
    const res = await fetch(`${base}/api/outputs?status=acknowledged`);
    const body = (await res.json()) as { success: boolean; data: Array<any> };
    expect(res.status).toBe(200);
    for (const o of body.data) {
      expect(o.status).toBe('acknowledged');
    }
  });

  test('GET /api/outputs?status=closed returns only closed outputs', async () => {
    const res = await fetch(`${base}/api/outputs?status=closed`);
    const body = (await res.json()) as { success: boolean; data: Array<any> };
    expect(res.status).toBe(200);
    for (const o of body.data) {
      expect(o.status).toBe('closed');
    }
  });

  test('GET /api/outputs?status=garbage returns 400 (no fabricated filter)', async () => {
    const res = await fetch(`${base}/api/outputs?status=garbage`);
    expect(res.status).toBe(400);
  });

  test('GET /api/outputs does NOT change any WorkItem status (read-only)', async () => {
    // The collection endpoint must be strictly read-only. Calling it
    // 3 times should not change a single Output's status.
    const before = (await (await fetch(`${base}/api/outputs`)).json()) as { data: Array<any> };
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/api/outputs`);
      await fetch(`${base}/api/outputs?status=ready`);
      await fetch(`${base}/api/outputs?status=closed`);
    }
    const after = (await (await fetch(`${base}/api/outputs`)).json()) as { data: Array<any> };
    expect(after.data.length).toBe(before.data.length);
    // Status distribution should be identical.
    const beforeStatus = before.data.map((o: any) => o.status).sort().join('|');
    const afterStatus = after.data.map((o: any) => o.status).sort().join('|');
    expect(afterStatus).toBe(beforeStatus);
  });

  // ═══ P0010.1 Output Workspace v0: single-Output fetch (Output Detail) ═══

  test('GET /api/outputs/:oid returns the single Output with situation context', async () => {
    const list = (await (await fetch(`${base}/api/outputs`)).json()) as { data: Array<any> };
    expect(list.data.length).toBeGreaterThan(0);
    const target = list.data[0]!;
    const res = await fetch(`${base}/api/outputs/${encodeURIComponent(target.outputId)}`);
    const body = (await res.json()) as { success: boolean; data: any; error?: string };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.outputId).toBe(target.outputId);
    expect(body.data.situation).toBeDefined();
    expect(body.data.situation.situationId).toBeDefined();
  });

  test('GET /api/outputs/:oid returns 404 for an unknown outputId', async () => {
    const res = await fetch(`${base}/api/outputs/out_does_not_exist`);
    expect(res.status).toBe(404);
  });

  test('GET /api/outputs/:oid includes currentSituation context but marks snapshotAvailable=false', async () => {
    // The schema does not snapshot judgment/recommendation at output
    // creation time. The endpoint must surface the *current* situation
    // judgment for the Output Detail page to render "判断依据" — but
    // must NEVER claim it is a generation-time snapshot. The
    // snapshotAvailable: false flag is the honest surface for that.
    const list = (await (await fetch(`${base}/api/outputs`)).json()) as { data: Array<any> };
    const target = list.data[0]!;
    const res = await fetch(`${base}/api/outputs/${encodeURIComponent(target.outputId)}`);
    const body = (await res.json()) as { data: any };
    expect(body.data.currentSituation).toBeDefined();
    expect(body.data.currentSituation.snapshotAvailable).toBe(false);
  });

  test('GET /api/outputs/:oid is read-only (does not change WorkItem status)', async () => {
    const list = (await (await fetch(`${base}/api/outputs`)).json()) as { data: Array<any> };
    const target = list.data[0]!;
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/api/outputs/${encodeURIComponent(target.outputId)}`);
      const b = (await r.json()) as { data: { status: string } };
      expect(b.data.status).toBe(target.status);
    }
    const after = (await (await fetch(`${base}/api/outputs`)).json()) as { data: Array<any> };
    const afterById = new Map<string, string>(after.data.map((o: any) => [o.outputId, o.status]));
    expect(afterById.get(target.outputId)).toBe(target.status);
  });

  // ═══ P0010.1 REPAIR-5: canonical path, provenance, no deliveredAt ═══

  test('P0010.1 REPAIR-5: /api/outputs/:oid response carries NO deliveredAt field (no fake delivery event)', async () => {
    // The WorkItemSchema does NOT have a deliveredAt field. There is
    // no Transport, no delivery event. The endpoint must NOT fabricate
    // a deliveredAt — and the UI must NOT read one.
    const list = (await (await fetch(`${base}/api/outputs`)).json()) as { data: Array<any> };
    const target = list.data[0]!;
    const res = await fetch(`${base}/api/outputs/${encodeURIComponent(target.outputId)}`);
    const body = (await res.json()) as { data: any };
    expect(body.data.deliveredAt).toBeUndefined();
  });

  test('P0010.1 REPAIR-5: /api/outputs/:oid response has `provenance` with only real facts', async () => {
    // Empty / minimal ctx → all four booleans must be false; knowledge
    // is always false (no first-class Knowledge record in this slice).
    const list = (await (await fetch(`${base}/api/outputs`)).json()) as { data: Array<any> };
    const target = list.data[0]!;
    const res = await fetch(`${base}/api/outputs/${encodeURIComponent(target.outputId)}`);
    const body = (await res.json()) as { data: any };
    expect(body.data.provenance).toBeDefined();
    expect(body.data.provenance.hasHuman).toBe(false);
    expect(body.data.provenance.hasEvidence).toBe(false);
    expect(body.data.provenance.hasKnowledge).toBe(false);
    expect(body.data.provenance.knowledgeLabels).toEqual([]);
    expect(body.data.provenance.humanInterventions).toEqual([]);
    expect(body.data.provenance.evidenceLabels).toEqual([]);
  });

  test('P0010.1 REPAIR-5: /api/outputs/:oid reads from canonical ctx.investigation.* (NOT ctx.* top level)', async () => {
    // Seed a dedicated situation with a full investigation object so we
    // can prove the path. The endpoint must surface investigation
    // fields — and must NOT pretend a top-level `ctx.currentUnderstanding`
    // or `ctx.recommendation` field is the canonical store.
    const SIT_R5 = 'sit_outputs_repair5';
    const now = '2026-08-22T08:00:00.000Z';
    const investigationBody = {
      contextId: 'ctx_' + SIT_R5,
      situation: { situationId: SIT_R5, domain: 'ecommerce', type: 'anomaly_investigation', entity: { id: 'e1', type: 'shop' }, temporal: { observedAt: now }, description: 'x', tags: [] },
      lifecycle: 'open', createdAt: now, updatedAt: now,
      observations: [], evidenceIds: [], signalIds: [],
      agentActivities: [], humanInterventions: [
        { interventionId: 'h1', type: 'correction', timestamp: now, summary: '人工修正' },
        { interventionId: 'h2', type: 'context_supplement', timestamp: now, summary: '补充上下文' },
      ],
      actions: [], outcomes: [],
      summary: { capabilitiesUsed: [], agentRuntimes: [], humanActors: [], totalEvidence: 0, totalSignals: 0 },
      // The investigation object — fields here are the canonical source.
      investigation: {
        currentUnderstanding: '来自 ctx.investigation.currentUnderstanding 的当前理解',
        judgment: '来自 ctx.investigation.judgment 的当前判断',
        stopReason: 'judgment',
        knownEvidence: ['known-evidence-1', 'known-evidence-2'],
        findings: [
          { question: 'q1', answer: 'a1', evidenceRefs: ['ev-aaa', 'ev-bbb'] },
          { question: 'q2', answer: 'a2', evidenceRefs: [] },
        ],
        recommendation: {
          recommendation: '来自 ctx.investigation.recommendation.recommendation 的建议',
          rationale: '来自 ctx.investigation.recommendation.rationale 的理由',
          expectedOutcome: '',
          risks: [],
          prerequisites: [],
          humanNeeded: false,
        },
      },
      // Anti-test: a top-level `currentUnderstanding` / `recommendation`
      // — if the endpoint reads from these, the test will catch it.
      // (Some legacy implementations read from ctx.* top-level.)
      currentUnderstanding: 'SHOULD-NOT-BE-READ (top-level, wrong path)',
      recommendation: { recommendation: 'SHOULD-NOT-BE-READ (top-level, wrong path)' },
      outputs: [],
    };
    const { openDb: openDbR5 } = await import('#platform/storage/connection.js');
    const dbR5 = openDbR5(TEMP_DB);
    dbR5.prepare(
      `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
         observed_at, description, tags, lifecycle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SIT_R5, 'ecommerce', 'anomaly_investigation',
      'jd_shop_repair5', 'shop', 'REPAIR5 测试店', 'jd',
      now, 'REPAIR-5 canonical-path test', JSON.stringify(['test']), 'open', now, now,
    );
    dbR5.prepare(
      `INSERT INTO learning_contexts (context_id, situation_id, lifecycle, created_at, updated_at, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'ctx_' + SIT_R5, SIT_R5, 'open', now, now, JSON.stringify(investigationBody),
    );
    dbR5.close();

    // Create an Output for this situation.
    const createRes = await fetch(`${base}/api/situations/${SIT_R5}/outputs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'recommendation', content: 'REPAIR-5 测试交付物' }),
    });
    const createBody = (await createRes.json()) as { data: { outputId: string } };
    expect(createRes.status).toBe(200);
    const oid = createBody.data.outputId;

    const res = await fetch(`${base}/api/outputs/${encodeURIComponent(oid)}`);
    const body = (await res.json()) as { data: any };
    expect(res.status).toBe(200);

    // currentSituation must surface the canonical investigation fields.
    const cs = body.data.currentSituation;
    expect(cs.understanding).toBe('来自 ctx.investigation.currentUnderstanding 的当前理解');
    expect(cs.judgment).toBe('来自 ctx.investigation.judgment 的当前判断');
    expect(cs.stopReason).toBe('judgment');
    expect(cs.recommendation).toBe('来自 ctx.investigation.recommendation.recommendation 的建议');
    expect(cs.recommendationRationale).toBe('来自 ctx.investigation.recommendation.rationale 的理由');

    // Anti-test: the wrong-path top-level fields MUST NOT be read.
    expect(cs.understanding).not.toContain('SHOULD-NOT-BE-READ');
    expect(cs.recommendation).not.toContain('SHOULD-NOT-BE-READ');

    // Provenance must reflect the real facts.
    const prov = body.data.provenance;
    expect(prov.hasHuman).toBe(true);
    expect(prov.humanInterventions.length).toBe(2);
    expect(prov.humanInterventions[0].interventionId).toBe('h1');
    expect(prov.humanInterventions[1].interventionId).toBe('h2');
    // P0010.1 REPAIR-6: only findings[].evidenceRefs drives
    // hasEvidence / evidenceLabels. `knownEvidence` is investigation
    // text and may contain human guidance / knowledge rules; it MUST
    // NOT be re-categorized as Evidence provenance. So the 2 entries
    // from `knownEvidence` are NOT in evidenceLabels anymore.
    expect(prov.hasEvidence).toBe(true);
    expect(prov.evidenceLabels).toContain('ev-aaa');
    expect(prov.evidenceLabels).toContain('ev-bbb');
    expect(prov.evidenceLabels).not.toContain('known-evidence-1');
    expect(prov.evidenceLabels).not.toContain('known-evidence-2');
    expect(prov.evidenceLabels.length).toBe(2);
    // Knowledge: never present in this slice.
    expect(prov.hasKnowledge).toBe(false);
    expect(prov.knowledgeLabels).toEqual([]);
  });

  test('P0010.1 REPAIR-6: /api/outputs/:oid provenance is hasEvidence:false when ONLY knownEvidence is present (no evidenceRefs)', async () => {
    // Seed a situation with `knownEvidence` text but no `findings[*].evidenceRefs`.
    // The endpoint must NOT mark the Output as having Evidence — only
    // human / knowledge / untyped text does not become `[证据]`.
    const SIT_R6 = 'sit_outputs_repair6_known';
    const now = '2026-08-23T08:00:00.000Z';
    const body = {
      contextId: 'ctx_' + SIT_R6,
      situation: { situationId: SIT_R6, domain: 'ecommerce', type: 'anomaly_investigation', entity: { id: 'e1', type: 'shop' }, temporal: { observedAt: now }, description: 'x', tags: [] },
      lifecycle: 'open', createdAt: now, updatedAt: now,
      observations: [], evidenceIds: [], signalIds: [],
      agentActivities: [], humanInterventions: [], actions: [], outcomes: [],
      summary: { capabilitiesUsed: [], agentRuntimes: [], humanActors: [], totalEvidence: 0, totalSignals: 0 },
      investigation: {
        // No findings.evidenceRefs anywhere.
        findings: [
          { question: 'q1', answer: 'a1' /* no evidenceRefs */ },
        ],
        // Only knownEvidence text — could be anything; we cannot
        // honestly classify it as Evidence, Knowledge, or Human.
        knownEvidence: [
          'Prior human guidance: 库存需先核验',
          'knowledge/operations/SOP.md: 大促后波动',
          'free text 运营笔记',
        ],
      },
      outputs: [],
    };
    const { openDb: openDbR6 } = await import('#platform/storage/connection.js');
    const dbR6 = openDbR6(TEMP_DB);
    dbR6.prepare(
      `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
         observed_at, description, tags, lifecycle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      SIT_R6, 'ecommerce', 'anomaly_investigation',
      'jd_shop_repair6_known', 'shop', 'REPAIR6 测试店', 'jd',
      now, 'REPAIR-6 knownEvidence test', JSON.stringify(['test']), 'open', now, now,
    );
    dbR6.prepare(
      `INSERT INTO learning_contexts (context_id, situation_id, lifecycle, created_at, updated_at, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'ctx_' + SIT_R6, SIT_R6, 'open', now, now, JSON.stringify(body),
    );
    dbR6.close();

    const createRes = await fetch(`${base}/api/situations/${SIT_R6}/outputs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'analysis', content: 'REPAIR-6 knownEvidence-only test' }),
    });
    const created = (await createRes.json()) as { data: { outputId: string } };
    const res = await fetch(`${base}/api/outputs/${encodeURIComponent(created.data.outputId)}`);
    const out = (await res.json()) as { data: any };
    expect(res.status).toBe(200);

    const prov = out.data.provenance;
    // No real Evidence — knownEvidence is not a source.
    expect(prov.hasEvidence).toBe(false);
    expect(prov.evidenceLabels).toEqual([]);
    // No Human — there are zero humanInterventions in this seed.
    expect(prov.hasHuman).toBe(false);
    // No Knowledge — always false in this slice.
    expect(prov.hasKnowledge).toBe(false);
  });
});
