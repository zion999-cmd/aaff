// P0010.2 closure Slice 2 — Agent Execution Trace (in-memory ring buffer).
//
// This is **Agent Execution Observability**, not a Hermes debugger. The schema
// is intentionally runtime-agnostic: `source` is the broad layer
// (runtime-loop / agent / system); `kind` is the specific event type. When
// Hermes is replaced with Claude (or a second Agent Runtime is added), the
// right pane and the API contract stay unchanged — only the producer in
// `session-client.ts` (or a future `claude-client.ts`) needs to swap.
//
// Strict scope (per Slice 2 spec):
//   - In-memory ring buffer, NOT persisted. Process restart = empty buffer.
//     This is exposed explicitly via the `lost: 'lost-on-restart'` API field so
//     the operator never confuses "no events" with "no activity".
//   - Does NOT record high-frequency `message.delta` (would flood the
//     200-event buffer in <1 second of streaming).
//   - No new table, no Event Bus, no recovery-policy change, no Wake
//     Engine, no Terminal Lifecycle.
//
// P0010.2 closure Repair — added a strictly-monotonic `seq` cursor on every
// `push()` so the right-pane UI's incremental polling no longer relies on
// the ambiguous `since >= ts` comparison. Two events in the same
// millisecond now get distinct `__seq` values, eliminating both the
// "duplicate on next poll" bug (`>=`) and the "skip on next poll" bug
// (`>`). The schema is unchanged; `__seq` is an internal cursor attached
// to the event at `query()` time. Producers never set it.
//
// Consumers:
//   - `loop-events.ts#stdoutSink` pushes runtime-layer events.
//   - `session-client.ts#defaultConnectLogger` pushes connect events.
//   - `situation-chat.ts` subscribes to `client.onEvent` and pushes
//     agent.turn.* + agent.tool.* with the situationId from the route's
//     closure (so the UI can scope to "this Situation" without scanning
//     every event on the wire).
//   - `GET /api/runtime/loop/events` (see platform/server/routes/
//     runtime-loop.ts) exposes the buffer to the Workspace UI.

// ---- Schema ------------------------------------------------------------

/**
 * Broad layer the event came from. Runtime-agnostic: when a non-Hermes
 * Agent Runtime ships, it still uses `source: 'agent'` — only the producer
 * in that runtime's client changes.
 *
 *   - `runtime-loop` — the RuntimeLoop orchestrator (Scheduling layer)
 *   - `agent`        — the currently-active Agent Runtime (Hermes today)
 *   - `system`       — process-level signals (e.g. "no events after
 *                       restart" disclosure)
 */
export type TraceSource = 'runtime-loop' | 'agent' | 'system';

/**
 * Specific event kind. Each source has its own sub-vocabulary; consumers
 * narrow on `kind` for fine-grained rendering. New kinds are additive —
 * the UI renders anything it doesn't recognize as a neutral event with
 * the raw `summary` string.
 */
export type TraceKind =
  // Runtime loop layer (RuntimeLoop → traceBuffer)
  | 'runtime.scheduled'          // Loop picked up the Situation
  | 'runtime.skipped'            // Loop decided not to investigate
  | 'runtime.retry'              // Loop scheduled a retry after a failure
  | 'runtime.recovery_attempt'   // Recovery scan found a pre-existing situation
  | 'runtime.blocked'            // Threshold crossed; manual clear-block required
  | 'runtime.completed'          // Tick done
  // Agent runtime layer (Hermes today → traceBuffer; tomorrow: any Agent)
  | 'agent.connect.started'
  | 'agent.connect.ok'
  | 'agent.connect.failed'
  | 'agent.session.created'
  | 'agent.turn.started'
  | 'agent.turn.completed'
  | 'agent.turn.failed'
  | 'agent.tool.called'
  | 'agent.tool.completed';

/**
 * One execution-observability event. The shape is runtime-agnostic:
 *   - `ts`         — ISO 8601 (caller supplies; we do not synthesize).
 *   - `source`     — broad layer (see `TraceSource`).
 *   - `kind`       — specific event type (see `TraceKind`).
 *   - `situationId` — correlates to the Situation this event belongs to.
 *                      Optional because connect events are situation-less.
 *   - `sessionId`   — Agent Runtime session id (opaque token; the schema
 *                      does NOT name it "hermesSessionId" so a swap stays clean).
 *   - `turnId`      — Agent Runtime turn id (opaque).
 *   - `summary`    — business-readable one-liner in Chinese (the operator's
 *                      language; the right pane renders this as the headline).
 *   - `detail`     — raw payload (collapsed `<details>` in the UI). The
 *                      schema is `unknown` because producers are diverse
 *                      and we want a single accept-anything shape.
 */
export interface TraceEvent {
  ts: string;
  source: TraceSource;
  kind: TraceKind;
  situationId?: string;
  sessionId?: string;
  turnId?: string;
  summary: string;
  detail?: unknown;
}

// ---- Ring buffer -------------------------------------------------------

/**
 * P0010.2 closure Repair — internal slot in the ring buffer. The
 * `TraceEvent` schema (public API) is unchanged; `seq` is the
 * implementation's stable cursor so callers can do incremental polling
 * without missing or duplicating events whose `ts` collides with the
 * most recent event. A new `seq` is assigned monotonically on every
 * `push()`. The previous `since >= ts` cursor was ambiguous: it would
 * re-include the most recent event on the next poll (>=), while
 * `since > ts` would skip same-millisecond events entirely. The seq
 * cursor removes the ambiguity because it is strictly monotonic.
 */
interface TraceSlot {
  seq: number;
  event: TraceEvent;
}

/**
 * P0010.2 closure Repair — extend `TraceEvent` with a read-only `__seq`
 * for UI incremental polling. This is NOT part of the producer's
 * public schema (the producer never sets it); the buffer attaches it
 * at `query()` time. The `__` prefix marks it as a buffer-internal
 * cursor field that producers/consumers should not synthesize.
 */
export type TraceEventWithSeq = TraceEvent & { __seq: number };

/**
 * P0010.2 closure Repair — query result. `events` is the NEWEST-FIRST
 * `TraceEvent[]` (same shape as before, augmented with `__seq`).
 * `nextSinceSeq` is the seq of the newest event in this result; the
 * caller passes it back as `sinceSeq` on the next poll to fetch only
 * NEW events. `size` and `capacity` are unchanged.
 */
export interface TraceQueryResult {
  events: TraceEventWithSeq[];
  /** The seq of the newest returned event; pass it back as `sinceSeq`. */
  nextSinceSeq: number;
}

/**
 * Bounded FIFO ring buffer. The fixed capacity is the explicit disclosure:
 * once 200 events are stored, the oldest is dropped on each new push. The
 * capacity is intentionally small (200) so the buffer survives a single
 * minute of a busy tick (≈3 events/sec × 60s) but does NOT grow without
 * bound and does NOT keep history across restarts.
 *
 * `query()` returns events NEWEST FIRST so the UI's natural render order
 * (top of pane = most recent) is the cheapest to compose. Each returned
 * event also carries `__seq` (the buffer's internal sequence id) so the
 * caller can pass it back as `sinceSeq` on the next poll — the seq is
 * strictly monotonic so two events with the same ISO 8601 `ts` are
 * guaranteed to get distinct `__seq` and an exact incremental fetch
 * (no duplicates, no misses).
 */
export class TraceRingBuffer {
  private buf: TraceSlot[] = [];
  private nextSeq = 1;

  constructor(public readonly capacity: number = 200) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`TraceRingBuffer capacity must be a positive number; got ${capacity}`);
    }
  }

  /**
   * Append a new event. Assigns a monotonically increasing `seq` for
   * cursor-based polling. When the buffer is at capacity, the oldest
   * event is dropped (slice + push is faster than head/tail pointer
   * math at this scale, and the buffer is small).
   *
   * Returns the assigned `seq` so tests can pin the exact cursor.
   * Production code reads `seq` off the `query()` result instead.
   */
  push(event: TraceEvent): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.buf.push({ seq, event });
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
    return seq;
  }

  /**
   * Query the buffer. All filters are AND-combined and optional.
   *
   *   - `situationId` — keep only events whose `situationId` matches
   *                      (or are situation-less for process-level
   *                      connect events). Omit to see the full stream.
   *   - `sinceSeq`    — keep only events with `__seq > sinceSeq`. This
   *                      is the CANONICAL incremental cursor and is
   *                      unaffected by ISO 8601 timestamp collisions
   *                      (multiple events in the same millisecond).
   *   - `since`       — keep only events with `ts >= since` (lexicographic
   *                      ISO 8601 compare is chronological). KEPT for
   *                      backward compatibility with the Slice 2
   *                      contract; new code should prefer `sinceSeq`.
   *                      `since` and `sinceSeq` are AND-combined when
   *                      both are provided.
   *   - `limit`       — return at most this many events, NEWEST FIRST.
   *                      Default: 100 (well below capacity).
   *
   * Returns `{ events, nextSinceSeq }`. Each event in `events` is
   * augmented with a read-only `__seq: number` so the caller can pass
   * `events[0].__seq` back as `sinceSeq` on the next poll.
   */
  query(opts: {
    situationId?: string;
    since?: string;
    sinceSeq?: number;
    limit?: number;
  } = {}): TraceQueryResult {
    const limit = opts.limit ?? 100;
    const since = opts.since;
    const sinceSeq = opts.sinceSeq;
    const situationId = opts.situationId;
    const filtered = this.buf.filter((slot) => {
      const e = slot.event;
      if (situationId !== undefined && e.situationId !== situationId) return false;
      if (since !== undefined && e.ts < since) return false;
      if (sinceSeq !== undefined && slot.seq <= sinceSeq) return false;
      return true;
    });
    // Take the LAST `limit` of the filtered list (most recent), then
    // reverse so the caller gets newest-first.
    const sliced = filtered.slice(-limit).reverse();
    const events: TraceEventWithSeq[] = sliced.map((slot) => ({ ...slot.event, __seq: slot.seq }));
    const nextSinceSeq = events.length > 0 ? events[0]!.__seq : (sinceSeq ?? 0);
    return { events, nextSinceSeq };
  }

  /** Current size (after filtering would still apply at query time). */
  size(): number {
    return this.buf.length;
  }

  /**
   * Current value of the next seq that `push()` will assign. Useful
   * for tests that want to seed a cursor without pushing a real event.
   * Production code uses `query().nextSinceSeq` instead.
   */
  peekNextSeq(): number {
    return this.nextSeq;
  }

  /** Drop everything. Used by tests; the production code does not call it. */
  clear(): void {
    this.buf = [];
    this.nextSeq = 1;
  }

  /** Read-only snapshot of events (without seq). Used by tests. */
  snapshot(): readonly TraceEvent[] {
    return this.buf.map((slot) => slot.event);
  }
}

// ---- Singleton ---------------------------------------------------------

/**
 * Process-wide buffer. Producers (`loop-events.ts#stdoutSink`,
 * `session-client.ts#defaultConnectLogger`, the route's
 * `client.onEvent` subscription) push here. The Workspace UI reads via
 * `GET /api/runtime/loop/events`.
 *
 * A fresh process starts with an empty buffer; the API response
 * surfaces this as `lost: 'lost-on-restart'` so the UI's empty state copy
 * is honest ("尚无记录（重启后清空）") instead of implying "no activity".
 */
export const traceBuffer: TraceRingBuffer = new TraceRingBuffer(200);

/**
 * Disclosure string for the UI. Exposed as a function so tests can pin the
 * exact copy without it drifting across consumers.
 */
export const traceBufferDisclosure = (): {
  kind: 'lost-on-restart';
  capacity: number;
  copy: string;
} => ({
  kind: 'lost-on-restart',
  capacity: traceBuffer.capacity,
  copy: `执行轨迹仅在内存中保留最近 ${traceBuffer.capacity} 条记录，进程重启后清空。`,
});

// ---- Producer-side helper ---------------------------------------------

/**
 * Build a TraceEvent from a producer's inputs. The helper centralizes the
 * `ts = nowIso()` (so tests can mock it via the shared `nowIso` seam) and
 * the `ts: new Date().toISOString()` default. Producers in
 * `loop-events.ts` and `session-client.ts` import this so they don't
 * drift in the event-shape definition.
 */
import { nowIso } from '#shared/utils/time.js';

export interface MakeTraceEventInput {
  source: TraceSource;
  kind: TraceKind;
  summary: string;
  situationId?: string;
  sessionId?: string;
  turnId?: string;
  detail?: unknown;
  /** Override the default `ts` (ISO 8601). Default: now. */
  ts?: string;
}

export const makeTraceEvent = (input: MakeTraceEventInput): TraceEvent => {
  const evt: TraceEvent = {
    ts: input.ts ?? nowIso(),
    source: input.source,
    kind: input.kind,
    summary: input.summary,
  };
  if (input.situationId !== undefined) evt.situationId = input.situationId;
  if (input.sessionId !== undefined) evt.sessionId = input.sessionId;
  if (input.turnId !== undefined) evt.turnId = input.turnId;
  if (input.detail !== undefined) evt.detail = input.detail;
  return evt;
};
