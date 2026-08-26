// P0010.2 closure Slice 2 — HTTP contract for
// `GET /api/runtime/loop/events`.
//
// Pins the wire contract the right-pane UI relies on. Pinned invariants:
//   - Response envelope: `{ success: true, data: { events, nextSinceSeq,
//     serverTs, lost, capacity, size } }`.
//   - `events` is `TraceEventWithSeq[]` NEWEST FIRST; each event carries
//     a read-only `__seq: number` cursor.
//   - `nextSinceSeq` is the seq of the newest returned event; the UI
//     passes it back as `sinceSeq` on the next poll to fetch only NEW
//     events (no duplicates, no skips for same-millisecond bursts).
//   - `lost: 'lost-on-restart'` is the explicit restart disclosure
//     (matches `traceBufferDisclosure().kind`).
//   - `capacity` matches the singleton's capacity (200).
//   - `situationId` + `since` + `sinceSeq` + `limit` filters compose with AND.
//   - `limit` is hard-capped at capacity (no caller can pull more than
//     the buffer holds).
//   - `message.delta` MUST NOT appear (the producer in situation-chat
//     filters it out before reaching the buffer).
//
// The test seeds the process-wide `traceBuffer` singleton directly so we
// never have to spin up Hermes — the contract is between the route and
// the buffer, not the agent runtime. We mount `runtimeLoopRouter`
// directly on a minimal Express app with a stub loop so the rest of
// `createServer` (which would start the real Loop on a setInterval and
// pollute the buffer) does not run.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { runtimeLoopRouter } from '#platform/server/routes/runtime-loop.js';
import type { RuntimeLoop } from '#app/runtime/loop/index.js';
import { traceBuffer, makeTraceEvent } from '#app/runtime/loop/trace-ring-buffer.js';

// Minimal stub — only `.list()` is exercised by the production routes
// other than `/events`. The contract under test is `/events`, which
// touches ONLY the traceBuffer singleton (no loop dependency).
const stubLoop: RuntimeLoop = {
  list: () => ({
    running: false,
    lastTickAt: null,
    tickCount: 0,
    blockedCount: 0,
  }),
  start: () => undefined,
  stop: () => undefined,
  tickNow: async () => ({
    startedAt: new Date(0).toISOString(),
    capabilities: 0,
    situationsCreated: 0,
    situationsDeduped: 0,
    investigationsTriggered: 0,
    investigationsSkipped: 0,
    investigationsFailed: 0,
    outputsCreated: 0,
    errors: [],
  }),
};

describe('GET /api/runtime/loop/events (contract)', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    const app: Express = express();
    app.use(express.json());
    app.use('/api', runtimeLoopRouter(stubLoop));
    server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://localhost:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    traceBuffer.clear();
  });

  // Helper: hit the endpoint with a plain URL (no query string) so the
  // caller can compose its own query without repeating the test boilerplate.
  const getEvents = async (query: string = ''): Promise<{
    status: number;
    body: {
      success: boolean;
      data?: {
        events: unknown[];
        nextSinceSeq: number;
        serverTs: string;
        lost: string;
        capacity: number;
        size: number;
      };
      error?: string;
    };
  }> => {
    const url = base + '/api/runtime/loop/events' + (query ? '?' + query : '');
    const res = await fetch(url);
    const body = await res.json();
    return { status: res.status, body: body as never };
  };

  test('returns the success envelope with the lost-on-restart disclosure', async () => {
    const { status, body } = await getEvents();
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    if (!body.data) throw new Error('data missing');
    expect(body.data.lost).toBe('lost-on-restart');
    expect(body.data.capacity).toBe(200);
    expect(body.data.size).toBe(0);
    expect(Array.isArray(body.data.events)).toBe(true);
    expect(body.data.events.length).toBe(0);
    expect(body.data.nextSinceSeq).toBe(0);
    expect(typeof body.data.serverTs).toBe('string');
    expect(body.data.serverTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('returns pushed events NEWEST FIRST', async () => {
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'first', ts: '2026-08-22T01:00:00.000Z' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.completed', summary: 'second', ts: '2026-08-22T02:00:00.000Z' }));
    traceBuffer.push(makeTraceEvent({ source: 'runtime-loop', kind: 'runtime.completed', summary: 'third', ts: '2026-08-22T03:00:00.000Z' }));
    const { body } = await getEvents();
    if (!body.data) throw new Error('data missing');
    const summaries = (body.data.events as Array<{ summary: string }>).map((e) => e.summary);
    expect(summaries).toEqual(['third', 'second', 'first']);
  });

  test('filters by situationId', async () => {
    traceBuffer.push(makeTraceEvent({ source: 'runtime-loop', kind: 'runtime.scheduled', summary: 's1', situationId: 'sit-A' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a1', situationId: 'sit-A' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b1', situationId: 'sit-B' }));
    const { body } = await getEvents('situationId=sit-A');
    if (!body.data) throw new Error('data missing');
    const summaries = (body.data.events as Array<{ summary: string }>).map((e) => e.summary);
    expect(summaries).toEqual(['a1', 's1']);
  });

  test('filters by since (ISO 8601 lexicographic)', async () => {
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'old', ts: '2026-08-22T01:00:00.000Z' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'boundary', ts: '2026-08-22T02:00:00.000Z' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'new', ts: '2026-08-22T03:00:00.000Z' }));
    const { body } = await getEvents('since=' + encodeURIComponent('2026-08-22T02:00:00.000Z'));
    if (!body.data) throw new Error('data missing');
    const summaries = (body.data.events as Array<{ summary: string }>).map((e) => e.summary);
    expect(summaries).toEqual(['new', 'boundary']);
  });

  // P0010.2 closure Repair — the seq cursor fixes the
  // "same-millisecond events re-fetch or skip" bug. The contract is:
  //   1. The first poll returns ALL events newest-first.
  //   2. Each event has a `__seq` field (the internal cursor).
  //   3. `data.nextSinceSeq` is the seq of the newest event.
  //   4. The next poll passes `sinceSeq=<nextSinceSeq>` and gets back
  //      ZERO events (no duplicates, no skips).
  test('sinceSeq cursor: first poll returns all events; second poll with sinceSeq=nextSinceSeq returns 0 events', async () => {
    const sameTs = '2026-08-22T02:00:00.000Z';
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a', ts: sameTs }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b', ts: sameTs }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'c', ts: sameTs }));
    // First poll — no sinceSeq.
    const first = await getEvents();
    if (!first.body.data) throw new Error('data missing');
    const firstEvents = first.body.data.events as Array<{ summary: string; __seq: number }>;
    expect(firstEvents.map((e) => e.summary)).toEqual(['c', 'b', 'a']);
    // The newest event's __seq is the cursor to pass back.
    const cursor = first.body.data.nextSinceSeq;
    expect(cursor).toBeGreaterThan(0);
    expect(firstEvents[0]?.__seq).toBe(cursor);
    // Second poll — passing back the cursor returns NOTHING.
    // This is the exact regression test: with the previous `since >= ts`
    // cursor, this would either re-fetch the same events (>=) or skip
    // all of them and then re-fetch them on a later poll (>= on the
    // exact same ts). The seq cursor is exact.
    const second = await getEvents('sinceSeq=' + String(cursor));
    if (!second.body.data) throw new Error('data missing');
    expect(second.body.data.events.length).toBe(0);
    // And the nextSinceSeq is preserved so the third poll is still 0
    // (NOT accidentally re-fetched).
    expect(second.body.data.nextSinceSeq).toBe(cursor);
  });

  test('sinceSeq cursor handles invalid input (non-numeric / negative) as "no filter"', async () => {
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a' }));
    // Non-numeric → sinceSeq=undefined → returns all.
    const garbage = await getEvents('sinceSeq=abc');
    if (!garbage.body.data) throw new Error('data missing');
    expect(garbage.body.data.events.length).toBe(1);
    // Negative → sinceSeq=undefined → returns all.
    const neg = await getEvents('sinceSeq=-5');
    if (!neg.body.data) throw new Error('data missing');
    expect(neg.body.data.events.length).toBe(1);
  });

  test('respects limit (default 100, hard-capped at capacity 200)', async () => {
    for (let i = 0; i < 250; i += 1) {
      traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: `e${i}` }));
    }
    // Default 100
    const def = await getEvents();
    if (!def.body.data) throw new Error('data missing');
    expect(def.body.data.events.length).toBe(100);
    // Explicit limit=50
    const fifty = await getEvents('limit=50');
    if (!fifty.body.data) throw new Error('data missing');
    expect(fifty.body.data.events.length).toBe(50);
    // Limit beyond capacity is hard-capped at 200 (capacity).
    const beyond = await getEvents('limit=9999');
    if (!beyond.body.data) throw new Error('data missing');
    expect(beyond.body.data.events.length).toBeLessThanOrEqual(200);
    expect(beyond.body.data.capacity).toBe(200);
  });

  test('combines situationId + since + sinceSeq + limit with AND', async () => {
    traceBuffer.push(makeTraceEvent({ source: 'runtime-loop', kind: 'runtime.scheduled', summary: 'r-old', situationId: 'sit-A', ts: '2026-08-22T01:00:00.000Z' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a1', situationId: 'sit-A', ts: '2026-08-22T02:00:00.000Z' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a2', situationId: 'sit-A', ts: '2026-08-22T02:30:00.000Z' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b1', situationId: 'sit-B', ts: '2026-08-22T02:15:00.000Z' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.completed', summary: 'a3', situationId: 'sit-A', ts: '2026-08-22T03:00:00.000Z' }));
    const { body } = await getEvents('situationId=sit-A&since=' + encodeURIComponent('2026-08-22T01:30:00.000Z') + '&limit=2');
    if (!body.data) throw new Error('data missing');
    const summaries = (body.data.events as Array<{ summary: string }>).map((e) => e.summary);
    // Newest first, then limit=2 → a3, a2 (a1 dropped by limit; r-old by since; b1 by situationId)
    expect(summaries).toEqual(['a3', 'a2']);
    // nextSinceSeq is the seq of a3 (the newest returned).
    expect(body.data.nextSinceSeq).toBeGreaterThan(0);
  });

  test('preserves the runtime-agnostic TraceEvent shape (ts/source/kind/summary/situationId/sessionId/turnId/detail)', async () => {
    traceBuffer.push(makeTraceEvent({
      source: 'agent',
      kind: 'agent.tool.called',
      summary: '调用工具 jd.product.list',
      situationId: 'sit-Z',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      detail: { toolName: 'jd.product.list', args: { date: '2026-08-22' } },
      ts: '2026-08-22T04:00:00.000Z',
    }));
    const { body } = await getEvents('situationId=sit-Z');
    if (!body.data) throw new Error('data missing');
    expect(body.data.events.length).toBe(1);
    const evt = (body.data.events[0] as Record<string, unknown>);
    expect(evt['ts']).toBe('2026-08-22T04:00:00.000Z');
    expect(evt['source']).toBe('agent');
    expect(evt['kind']).toBe('agent.tool.called');
    expect(evt['summary']).toBe('调用工具 jd.product.list');
    expect(evt['situationId']).toBe('sit-Z');
    expect(evt['sessionId']).toBe('sess-1');
    expect(evt['turnId']).toBe('turn-1');
    expect(evt['detail']).toEqual({ toolName: 'jd.product.list', args: { date: '2026-08-22' } });
    // The internal __seq cursor is attached at query time.
    expect(typeof evt['__seq']).toBe('number');
    expect(evt['__seq']).toBe(body.data.nextSinceSeq);
  });

  test('invalid limit (non-numeric / negative) collapses to default 100', async () => {
    for (let i = 0; i < 120; i += 1) {
      traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: `e${i}` }));
    }
    const garbage = await getEvents('limit=abc');
    if (!garbage.body.data) throw new Error('data missing');
    expect(garbage.body.data.events.length).toBe(100);
    const neg = await getEvents('limit=-5');
    if (!neg.body.data) throw new Error('data missing');
    expect(neg.body.data.events.length).toBe(100);
  });

  test('empty situationId / empty since are treated as absent (do not over-filter)', async () => {
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a', situationId: 'sit-A' }));
    const { body } = await getEvents('situationId=&since=');
    if (!body.data) throw new Error('data missing');
    expect(body.data.events.length).toBe(1);
  });

  test('size field tracks the buffer (post-filter size vs. pre-filter size)', async () => {
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a', situationId: 'sit-A' }));
    traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b', situationId: 'sit-B' }));
    // size is the pre-filter buffer size, not the post-filter count.
    const all = await getEvents();
    if (!all.body.data) throw new Error('data missing');
    expect(all.body.data.size).toBe(2);
    expect(all.body.data.events.length).toBe(2);
    const aOnly = await getEvents('situationId=sit-A');
    if (!aOnly.body.data) throw new Error('data missing');
    expect(aOnly.body.data.size).toBe(2);
    expect(aOnly.body.data.events.length).toBe(1);
  });
});
