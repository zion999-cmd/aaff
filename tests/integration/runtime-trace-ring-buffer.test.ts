// P0010.2 closure Slice 2 — TraceRingBuffer integration tests.
//
// Pins the buffer's runtime-agnostic contract. These tests exercise the
// SAME singleton the production code uses (`traceBuffer`), so a regression
// in the buffer's behavior that the API contract test misses (e.g. wrong
// ordering, off-by-one on `since`, capacity overflow) gets caught here.
//
// P0010.2 closure Repair — `query()` now returns `{ events, nextSinceSeq }`
// instead of a raw array. `events[].__seq` is the strictly-monotonic
// cursor the right-pane UI uses for incremental polling. The previous
// `since >= ts` cursor was ambiguous: two events in the same millisecond
// would either re-fetch (`>=`) or be skipped (`>`). The seq cursor
// removes that ambiguity.
//
// Boundary reminders (re-asserted in the contract test):
//   - In-memory only; NOT persisted; process restart = empty.
//   - No `message.delta` is recorded (the agent-side producer filters
//     it out before calling `traceBuffer.push`).
//   - `query().events` is returned NEWEST FIRST so the right-pane UI's
//     natural render order (top of pane = most recent) is the cheapest.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TraceRingBuffer,
  traceBuffer,
  traceBufferDisclosure,
  makeTraceEvent,
} from '#app/runtime/loop/trace-ring-buffer.js';

describe('TraceRingBuffer (integration)', () => {
  describe('capacity overflow', () => {
    it('drops the oldest event when capacity is exceeded', () => {
      const buf = new TraceRingBuffer(3);
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 't1' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 't2' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 't3' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.completed', summary: 't4' }));
      // Newest first, so t4 → t3 → t2 (t1 dropped).
      expect(buf.query().events.map((e) => e.summary)).toEqual(['t4', 't3', 't2']);
      expect(buf.size()).toBe(3);
    });

    it('refuses a non-positive capacity', () => {
      expect(() => new TraceRingBuffer(0)).toThrow(/positive/);
      expect(() => new TraceRingBuffer(-5)).toThrow(/positive/);
      expect(() => new TraceRingBuffer(Number.NaN)).toThrow(/positive/);
    });
  });

  describe('situationId filter', () => {
    it('returns only events that match the requested situationId', () => {
      const buf = new TraceRingBuffer(50);
      buf.push(makeTraceEvent({ source: 'runtime-loop', kind: 'runtime.scheduled', summary: 's1', situationId: 'sit-1' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 's2-start', situationId: 'sit-1' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.completed', summary: 's2-end', situationId: 'sit-2' }));
      buf.push(makeTraceEvent({ source: 'runtime-loop', kind: 'runtime.scheduled', summary: 's3', situationId: 'sit-1' }));
      // No situationId at all → connect-style events. Must NOT match a
      // situationId-scoped query (the Workspace right pane only shows
      // this Situation's events).
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.connect.ok', summary: 'connect-ok' }));
      const onlySit1 = buf.query({ situationId: 'sit-1' });
      expect(onlySit1.events.map((e) => e.summary)).toEqual(['s3', 's2-start', 's1']);
      const onlySit2 = buf.query({ situationId: 'sit-2' });
      expect(onlySit2.events.map((e) => e.summary)).toEqual(['s2-end']);
      const allUnscoped = buf.query();
      expect(allUnscoped.events.length).toBe(5);
    });

    it('treats situationId as a strict string match (no partial / prefix)', () => {
      const buf = new TraceRingBuffer(10);
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a', situationId: 'sit-1' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b', situationId: 'sit-10' }));
      const onlySit1 = buf.query({ situationId: 'sit-1' });
      expect(onlySit1.events.length).toBe(1);
      expect(onlySit1.events[0]?.summary).toBe('a');
    });
  });

  describe('since filter (ISO 8601 lexicographic = chronological)', () => {
    it('returns only events with ts >= since', () => {
      const buf = new TraceRingBuffer(10);
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'old', ts: '2026-08-22T01:00:00.000Z' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'boundary', ts: '2026-08-22T02:00:00.000Z' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'new', ts: '2026-08-22T03:00:00.000Z' }));
      const result = buf.query({ since: '2026-08-22T02:00:00.000Z' });
      expect(result.events.map((e) => e.summary)).toEqual(['new', 'boundary']);
    });

    it('combines situationId + since (AND)', () => {
      const buf = new TraceRingBuffer(20);
      buf.push(makeTraceEvent({ source: 'runtime-loop', kind: 'runtime.scheduled', summary: 'r1', situationId: 'sit-1', ts: '2026-08-22T01:00:00.000Z' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a1', situationId: 'sit-1', ts: '2026-08-22T02:00:00.000Z' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a2', situationId: 'sit-2', ts: '2026-08-22T02:30:00.000Z' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.completed', summary: 'a1-end', situationId: 'sit-1', ts: '2026-08-22T03:00:00.000Z' }));
      const result = buf.query({ situationId: 'sit-1', since: '2026-08-22T01:30:00.000Z' });
      expect(result.events.map((e) => e.summary)).toEqual(['a1-end', 'a1']);
    });
  });

  describe('sinceSeq filter (strictly-monotonic cursor — P0010.2 closure Repair)', () => {
    it('returns only events with seq > sinceSeq (no duplicates, no skips)', () => {
      const buf = new TraceRingBuffer(10);
      const sameTs = '2026-08-22T02:00:00.000Z';
      const seqA = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a', ts: sameTs }));
      const seqB = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b', ts: sameTs }));
      const seqC = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'c', ts: sameTs }));
      // All three share the SAME `ts` (the bug the seq cursor fixes).
      // First call (no sinceSeq) returns all 3.
      const first = buf.query();
      expect(first.events.map((e) => e.summary)).toEqual(['c', 'b', 'a']);
      expect(first.nextSinceSeq).toBe(seqC);
      // The UI would now pass `seqC` as `sinceSeq` and get back 0 events.
      // No duplicate of `c`, no skip of `b` or `a`.
      const second = buf.query({ sinceSeq: seqC });
      expect(second.events.length).toBe(0);
      expect(second.nextSinceSeq).toBe(seqC);
      // Forcing sinceSeq back to seqA re-reveals `b` and `c` (sanity).
      const back = buf.query({ sinceSeq: seqA });
      expect(back.events.map((e) => e.summary)).toEqual(['c', 'b']);
      expect(back.nextSinceSeq).toBe(seqC);
      // Sanity: seqs were assigned monotonically starting at 1.
      expect(seqA).toBe(1);
      expect(seqB).toBe(2);
      expect(seqC).toBe(3);
    });

    it('preserves the sinceSeq cursor when the response is empty (next poll uses the same cursor)', () => {
      const buf = new TraceRingBuffer(10);
      const seq1 = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a' }));
      // A poll with sinceSeq=seq1 returns no events but must still
      // return `nextSinceSeq=seq1` so the next poll doesn't accidentally
      // re-fetch the same events.
      const result = buf.query({ sinceSeq: seq1 });
      expect(result.events).toEqual([]);
      expect(result.nextSinceSeq).toBe(seq1);
    });

    it('combines situationId + sinceSeq (AND)', () => {
      const buf = new TraceRingBuffer(20);
      const seqA = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a', situationId: 'sit-1' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b', situationId: 'sit-2' }));
      const seqC = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'c', situationId: 'sit-1' }));
      // Since seqA: only `b` (sit-2) and `c` (sit-1) match. With sit-1
      // filter: only `c`.
      const result = buf.query({ situationId: 'sit-1', sinceSeq: seqA });
      expect(result.events.map((e) => e.summary)).toEqual(['c']);
      expect(result.nextSinceSeq).toBe(seqC);
    });

    it('exposes the cursor on every returned event via __seq', () => {
      const buf = new TraceRingBuffer(10);
      const seq1 = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a' }));
      const seq2 = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b' }));
      const result = buf.query();
      // Newest first: b then a; __seq attached.
      expect(result.events[0]?.__seq).toBe(seq2);
      expect(result.events[1]?.__seq).toBe(seq1);
    });

    it('peekNextSeq returns the seq that the next push will assign', () => {
      const buf = new TraceRingBuffer(5);
      expect(buf.peekNextSeq()).toBe(1);
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a' }));
      expect(buf.peekNextSeq()).toBe(2);
    });

    it('clear resets the seq counter so the next push starts at 1', () => {
      const buf = new TraceRingBuffer(5);
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b' }));
      buf.clear();
      const seq = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'c' }));
      expect(seq).toBe(1);
    });
  });

  describe('limit + ordering', () => {
    it('returns at most `limit` events, newest first', () => {
      const buf = new TraceRingBuffer(50);
      for (let i = 0; i < 10; i += 1) {
        buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: `e${i}`, ts: `2026-08-22T00:00:0${i}.000Z` }));
      }
      const result = buf.query({ limit: 3 });
      expect(result.events.length).toBe(3);
      expect(result.events.map((e) => e.summary)).toEqual(['e9', 'e8', 'e7']);
    });

    it('default limit is 100', () => {
      const buf = new TraceRingBuffer(200);
      for (let i = 0; i < 150; i += 1) {
        buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: `e${i}` }));
      }
      const result = buf.query();
      expect(result.events.length).toBe(100);
      // Newest first
      expect(result.events[0]?.summary).toBe('e149');
      expect(result.events[99]?.summary).toBe('e50');
    });

    it('limit larger than buffer size returns all', () => {
      const buf = new TraceRingBuffer(20);
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'only' }));
      const result = buf.query({ limit: 100 });
      expect(result.events.length).toBe(1);
    });
  });

  // P0010.2 closure Repair — situation-scoped Trace must include the
  // connect events that the route stamps with the same `situationId`.
  // Before the fix, the process-level `agent.connect.*` events had no
  // situationId, so the situation-scoped query filtered them out and the
  // operator never saw "Agent connect started → ok" for THIS Situation.
  describe('situation-scoped Trace includes correlated connect events', () => {
    it('when the route stamps the situationId on connect events, they appear in the situation-scoped query', () => {
      const buf = new TraceRingBuffer(50);
      const sit = 'sit-kill-during-investigation';
      // Simulate the route's `connectWithSituationTrace` helper: it
      // pushes 3 events (started / ok / failed) with the situationId
      // baked in. The buffer must surface them under the same query.
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.connect.started', summary: 'connect started for this sit', situationId: sit }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.connect.ok', summary: 'connect ok for this sit', situationId: sit }));
      // Per-Situation investigation events.
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'turn started', situationId: sit }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.failed', summary: 'turn failed', situationId: sit }));
      // Other Situation's connect events — must NOT leak in.
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.connect.ok', summary: 'connect ok for OTHER sit', situationId: 'sit-other' }));
      // Process-level connect events (no situationId) — these are
      // intentional and represent connect events that were NOT stamped
      // by the route (e.g. pre-fix logs). They are NOT in the
      // situation-scoped query.
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.connect.failed', summary: 'process-level connect fail' }));
      const result = buf.query({ situationId: sit });
      // The 4 sit-stamped events appear; the 2 unrelated ones don't.
      expect(result.events.map((e) => e.summary)).toEqual([
        'turn failed',
        'turn started',
        'connect ok for this sit',
        'connect started for this sit',
      ]);
    });

    it('route-stamped connect events get a strictly-monotonic seq (no merge with process-level events)', () => {
      const buf = new TraceRingBuffer(20);
      const sit = 'sit-x';
      // Process-level connect (no sit) — happens first.
      const seqA = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.connect.started', summary: 'process-level' }));
      // Route-stamped connect (with sit) — happens second.
      const seqB = buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.connect.started', summary: 'route-stamped', situationId: sit }));
      // Strictly monotonic: B > A.
      expect(seqB).toBeGreaterThan(seqA);
      // Sit-scoped query returns only the route-stamped one.
      const result = buf.query({ situationId: sit });
      expect(result.events.map((e) => e.summary)).toEqual(['route-stamped']);
      expect(result.events[0]?.__seq).toBe(seqB);
    });
  });

  describe('snapshot / size / clear', () => {
    it('snapshot returns the same array reference as the internal buffer (read-only intent only)', () => {
      const buf = new TraceRingBuffer(5);
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a' }));
      const snap = buf.snapshot();
      expect(snap.length).toBe(1);
      expect(snap[0]?.summary).toBe('a');
    });

    it('clear drops everything', () => {
      const buf = new TraceRingBuffer(5);
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'a' }));
      buf.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'b' }));
      expect(buf.size()).toBe(2);
      buf.clear();
      expect(buf.size()).toBe(0);
      expect(buf.query().events).toEqual([]);
    });
  });

  describe('makeTraceEvent', () => {
    it('fills ts with nowIso() when not provided', () => {
      const evt = makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'x' });
      expect(typeof evt.ts).toBe('string');
      expect(evt.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(evt.source).toBe('agent');
      expect(evt.kind).toBe('agent.turn.started');
      expect(evt.summary).toBe('x');
    });

    it('omits optional fields when not provided', () => {
      const evt = makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'x' });
      expect(evt).not.toHaveProperty('situationId');
      expect(evt).not.toHaveProperty('sessionId');
      expect(evt).not.toHaveProperty('turnId');
      expect(evt).not.toHaveProperty('detail');
    });

    it('preserves explicit ts for deterministic tests', () => {
      const evt = makeTraceEvent({
        source: 'agent',
        kind: 'agent.turn.started',
        summary: 'x',
        ts: '2026-08-22T04:00:00.000Z',
      });
      expect(evt.ts).toBe('2026-08-22T04:00:00.000Z');
    });

    it('passes through detail and correlation ids', () => {
      const evt = makeTraceEvent({
        source: 'runtime-loop',
        kind: 'runtime.scheduled',
        summary: 'y',
        situationId: 'sit-7',
        sessionId: 'sess-abc',
        turnId: 'turn-xyz',
        detail: { reason: 'new_situation' },
      });
      expect(evt.situationId).toBe('sit-7');
      expect(evt.sessionId).toBe('sess-abc');
      expect(evt.turnId).toBe('turn-xyz');
      expect(evt.detail).toEqual({ reason: 'new_situation' });
    });
  });

  describe('singleton (process-wide buffer)', () => {
    beforeEach(() => {
      // Tests share the same singleton — reset between cases so the
      // assertions stay deterministic.
      traceBuffer.clear();
    });

    it('process-wide push is visible to query()', () => {
      traceBuffer.push(makeTraceEvent({ source: 'agent', kind: 'agent.turn.started', summary: 'live', situationId: 'sit-live' }));
      const out = traceBuffer.query({ situationId: 'sit-live' });
      expect(out.events.length).toBe(1);
      expect(out.events[0]?.summary).toBe('live');
    });

    it('disclosure copy names the lost-on-restart policy', () => {
      const d = traceBufferDisclosure();
      expect(d.kind).toBe('lost-on-restart');
      expect(d.capacity).toBe(200);
      expect(d.copy).toMatch(/重启/);
    });
  });
});
