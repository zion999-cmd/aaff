// P0010.2 — HTTP control surface for the RuntimeLoop.
// Three endpoints, no transport, no engine, no approval flow:
//
//   GET  /api/runtime/loop         — read loop state (running, lastTickAt, tickCount)
//   POST /api/runtime/loop/tick    — force a tick now (idempotent; reuses in-flight)
//   POST /api/runtime/loop/start   — start the loop (no-op if already running)
//   POST /api/runtime/loop/stop    — stop the loop (no-op if already stopped)
//   GET  /api/runtime/loop/events  — Slice 2: Agent Execution Trace
//                                    (in-memory ring buffer; query by
//                                    situationId + since + limit)
//
// Strict boundaries (NOT INCLUDED):
//   - No event bus, no wake engine, no durable job queue.
//   - The Loop is process-local; restart the server = reset its tick state.
//   - The events endpoint exposes an in-memory ring buffer; process
//     restart = empty buffer (explicit `lost: 'lost-on-restart'` field).

import { Router } from 'express';
import type { RuntimeLoop, LoopTickSummary } from '#app/runtime/loop/index.js';
import { traceBuffer, traceBufferDisclosure } from '#app/runtime/loop/trace-ring-buffer.js';
import { nowIso } from '#shared/utils/time.js';

const ok = (res: any, data: unknown) => res.json({ success: true, data });
const fail = (res: any, status: number, error: string) =>
  res.status(status).json({ success: false, error });

export const runtimeLoopRouter = (loop: RuntimeLoop): Router => {
  const router = Router();

  router.get('/runtime/loop', (_req, res) => {
    ok(res, loop.list());
  });

  router.post('/runtime/loop/tick', async (_req, res) => {
    try {
      const summary: LoopTickSummary = await loop.tickNow();
      ok(res, summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tick failed';
      fail(res, 500, message);
    }
  });

  router.post('/runtime/loop/start', (_req, res) => {
    loop.start();
    ok(res, loop.list());
  });

  router.post('/runtime/loop/stop', (_req, res) => {
    loop.stop();
    ok(res, loop.list());
  });

  // Slice 2 — Agent Execution Trace.
  //
  // Query parameters (all optional):
  //   - `situationId` — keep only events whose `situationId` matches.
  //                     Omit to see the full process-wide stream
  //                     (connect events + tick summaries + per-Situation
  //                     events). The Workspace right pane ALWAYS passes
  //                     the current situationId so the operator only
  //                     sees the trace of the Situation they're looking
  //                     at.
  //   - `since`       — keep only events with `ts >= since` (ISO 8601
  //                     string; lexicographic compare is chronological).
  //                     The UI uses this for incremental polling: it
  //                     sends the `ts` of the most recent event it has,
  //                     and the server returns only newer events.
  //   - `limit`       — return at most this many events, NEWEST FIRST.
  //                     Default 100. Hard-capped at 200 (= buffer
  //                     capacity) so a malicious caller cannot pull
  //                     more than the buffer holds.
  //
  // Response shape:
  //   {
  //     success: true,
  //     data: {
  //       events: TraceEvent[],   // NEWEST FIRST
  //       serverTs: string,       // ISO 8601; UI uses for the next `since`
  //       lost: 'lost-on-restart', // explicit disclosure: the buffer is
  //                                // process-local; restart wipes it
  //       capacity: number,       // ring buffer capacity
  //       size: number            // current events in the buffer
  //     }
  //   }
  router.get('/runtime/loop/events', (req, res) => {
    const situationIdRaw = req.query['situationId'];
    const sinceRaw = req.query['since'];
    const sinceSeqRaw = req.query['sinceSeq'];
    const limitRaw = req.query['limit'];
    const situationId = typeof situationIdRaw === 'string' && situationIdRaw.length > 0 ? situationIdRaw : undefined;
    const since = typeof sinceRaw === 'string' && sinceRaw.length > 0 ? sinceRaw : undefined;
    // P0010.2 closure Repair — `sinceSeq` is the canonical incremental
    // cursor (strictly monotonic). The previous `since` (ISO 8601
    // timestamp) is kept for the Slice 2 contract but the UI should
    // prefer `sinceSeq` because two events in the same millisecond
    // would otherwise re-fetch (`since >= ts`) or skip (`since > ts`).
    const parsedSinceSeq = typeof sinceSeqRaw === 'string' ? Number.parseInt(sinceSeqRaw, 10) : NaN;
    const sinceSeq =
      Number.isFinite(parsedSinceSeq) && parsedSinceSeq >= 0 ? parsedSinceSeq : undefined;
    // Hard cap the limit at the buffer capacity. Negative or non-numeric
    // inputs collapse to the default 100.
    const DEFAULT_LIMIT = 100;
    const parsedLimit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : NaN;
    const safeLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, traceBuffer.capacity)
        : DEFAULT_LIMIT;
    const result = traceBuffer.query({
      ...(situationId !== undefined ? { situationId } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
      limit: safeLimit,
    });
    const disclosure = traceBufferDisclosure();
    res.json({
      success: true,
      data: {
        events: result.events,
        // P0010.2 closure Repair — the seq of the newest returned
        // event. The UI passes this back as `sinceSeq` on the next
        // poll to fetch only NEW events (no duplicates, no misses for
        // same-millisecond bursts).
        nextSinceSeq: result.nextSinceSeq,
        serverTs: nowIso(),
        lost: disclosure.kind,
        capacity: disclosure.capacity,
        size: traceBuffer.size(),
      },
    });
  });

  return router;
};
