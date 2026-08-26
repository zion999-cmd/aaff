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
//     This is exposed explicitly via the `lost: 'on-restart'` API field so
//     the operator never confuses "no events" with "no activity".
//   - Does NOT record high-frequency `message.delta` (would flood the
//     200-event buffer in <1 second of streaming).
//   - No new table, no Event Bus, no recovery-policy change, no Wake
//     Engine, no Terminal Lifecycle.
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
 * Bounded FIFO ring buffer. The fixed capacity is the explicit disclosure:
 * once 200 events are stored, the oldest is dropped on each new push. The
 * capacity is intentionally small (200) so the buffer survives a single
 * minute of a busy tick (≈3 events/sec × 60s) but does NOT grow without
 * bound and does NOT keep history across restarts.
 *
 * `query()` returns events NEWEST FIRST so the UI's natural render order
 * (top of pane = most recent) is the cheapest to compose.
 */
export class TraceRingBuffer {
  private buf: TraceEvent[] = [];

  constructor(public readonly capacity: number = 200) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`TraceRingBuffer capacity must be a positive number; got ${capacity}`);
    }
  }

  /**
   * Append a new event. When the buffer is at capacity, the oldest event
   * is dropped (slice + push is faster than head/tail pointer math at this
   * scale, and the buffer is small).
   */
  push(event: TraceEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
  }

  /**
   * Query the buffer. All filters are AND-combined and optional.
   *
   *   - `situationId` — keep only events that match (or are situation-less
   *                      if `situationId` is the literal `'__no_situation__'`).
   *                      The `__no_situation__` sentinel is reserved for
   *                      connect events that don't belong to a specific
   *                      Situation; production code NEVER queries with it.
   *   - `since`       — keep only events with `ts >= since` (lexicographic
   *                      ISO 8601 compare is chronological).
   *   - `limit`       — return at most this many events, NEWEST FIRST.
   *                      Default: 100 (well below capacity).
   *
   * Returns a NEW array — callers may mutate freely.
   */
  query(opts: { situationId?: string; since?: string; limit?: number } = {}): TraceEvent[] {
    const limit = opts.limit ?? 100;
    const since = opts.since;
    const situationId = opts.situationId;
    const filtered = this.buf.filter((e) => {
      if (situationId !== undefined && e.situationId !== situationId) return false;
      if (since !== undefined && e.ts < since) return false;
      return true;
    });
    // Take the LAST `limit` of the filtered list (most recent), then
    // reverse so the caller gets newest-first.
    return filtered.slice(-limit).reverse();
  }

  /** Current size (after filtering would still apply at query time). */
  size(): number {
    return this.buf.length;
  }

  /** Drop everything. Used by tests; the production code does not call it. */
  clear(): void {
    this.buf = [];
  }

  /** Read-only snapshot. Used by tests; the production code queries via `query()`. */
  snapshot(): readonly TraceEvent[] {
    return this.buf;
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
 * surfaces this as `lost: 'on-restart'` so the UI's empty state copy
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
