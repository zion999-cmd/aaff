// P0010.2 — HTTP control surface for the RuntimeLoop.
// Three endpoints, no transport, no engine, no approval flow:
//
//   GET  /api/runtime/loop         — read loop state (running, lastTickAt, tickCount)
//   POST /api/runtime/loop/tick    — force a tick now (idempotent; reuses in-flight)
//   POST /api/runtime/loop/start   — start the loop (no-op if already running)
//   POST /api/runtime/loop/stop    — stop the loop (no-op if already stopped)
//
// Strict boundaries (NOT INCLUDED):
//   - No event bus, no wake engine, no durable job queue.
//   - The Loop is process-local; restart the server = reset its tick state.

import { Router } from 'express';
import type { RuntimeLoop, LoopTickSummary } from '#app/runtime/loop/index.js';

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

  return router;
};
