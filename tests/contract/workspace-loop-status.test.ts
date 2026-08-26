// P0010.2.3 (ADR-059 audit D-3) — Workspace loop-status wiring contract.
//
// P0010.2 shipped `GET /api/runtime/loop` (running, lastTickAt, tickCount)
// and a P0010.2.2 follow-up added `blockedCount` (the operator-visibility
// surface for situations in `blocked_runtime_failure` state). The P0010.2
// audit found that the Workspace's "Runtime 执行" view (`view-runtime`)
// was wired only to the per-day kernel-execution history and not to the
// Loop state at all. This contract pins the new wiring at three levels:
//
//   1. Server (runtime-loop.ts) returns a payload that includes
//      `blockedCount` (string in source — avoids runtime eval).
//   2. HTML (`index.html`) has the DOM slots `loopStatus` + `loopBlockedBadge`
//      inside the `view-runtime` view container.
//   3. UI consumer (`app.js`) defines `loadLoopStatus()` and calls it
//      from the single `loadRuntime()` entry point. The consumer reads
//      `/api/runtime/loop` and renders all four fields without throwing
//      on missing data (honest "unknown" placeholders).
//
// Why source-level (not behaviour-level)? The Workspace is vanilla JS in
// the browser; no jsdom test runner is configured. The contract is the
// shape of the wiring, not the browser behaviour, so we pin the source.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

describe('Workspace loop-status contract (ADR-059 audit D-3)', () => {
  it('runtime-loop route returns blockedCount in the response shape', () => {
    const source = readFileSync(
      resolve(root, 'platform/server/routes/runtime-loop.ts'),
      'utf8',
    );
    // The route delegates to `loop.list()`. Pin the type so the consumer
    // contract holds.
    expect(source).toContain('loop.list()');
    // The LoopState type in runtime-loop.ts must include blockedCount.
    const loopSource = readFileSync(
      resolve(root, 'apps/ecommerce/runtime/loop/runtime-loop.ts'),
      'utf8',
    );
    expect(loopSource).toMatch(/blockedCount\s*:\s*number/);
    // The list() implementation must read the count live (not zero-fill).
    expect(loopSource).toContain('countBlockedSituations(db)');
  });

  it('view-runtime view has loopStatus + loopBlockedBadge DOM slots', () => {
    const html = readFileSync(
      resolve(root, 'apps/ecommerce/workspace/index.html'),
      'utf8',
    );
    // The slots must live inside the view-runtime view container, not
    // somewhere else (operator-visible only when the view is open).
    const viewStart = html.indexOf('id="view-runtime"');
    expect(viewStart).toBeGreaterThan(-1);
    // The next view-container after view-runtime is where it would end.
    const viewEnd = html.indexOf('id="view-', viewStart + 1);
    const slot = html.substring(viewStart, viewEnd > -1 ? viewEnd : html.length);
    expect(slot).toContain('id="loopStatus"');
    expect(slot).toContain('id="loopBlockedBadge"');
  });

  it('app.js defines loadLoopStatus() and calls it from loadRuntime()', () => {
    const js = readFileSync(
      resolve(root, 'apps/ecommerce/workspace/app.js'),
      'utf8',
    );
    // Function definition exists.
    expect(js).toMatch(/async\s+function\s+loadLoopStatus\s*\(/);
    // The function reads /api/runtime/loop.
    expect(js).toContain("apiGet('/api/runtime/loop')");
    // The function renders all four fields.
    expect(js).toContain('running');
    expect(js).toContain('lastTickAt');
    expect(js).toContain('tickCount');
    expect(js).toContain('blockedCount');
    // The function is invoked from the loadRuntime entry point.
    const loadRuntimeIdx = js.indexOf('async function loadRuntime(');
    const loadLoopCallIdx = js.indexOf('await loadLoopStatus()');
    expect(loadRuntimeIdx).toBeGreaterThan(-1);
    expect(loadLoopCallIdx).toBeGreaterThan(loadRuntimeIdx);
    // The call must be inside loadRuntime (not in a sibling function).
    // Find the next "async function" or top-level decl after loadRuntime.
    const afterLoadRuntime = js.indexOf('async function', loadRuntimeIdx + 10);
    expect(afterLoadRuntime).toBeGreaterThan(-1);
    expect(loadLoopCallIdx).toBeLessThan(afterLoadRuntime);
  });

  it('app.js loadLoopStatus is fail-soft: it never throws on missing data', () => {
    const js = readFileSync(
      resolve(root, 'apps/ecommerce/workspace/app.js'),
      'utf8',
    );
    // The function must have a try/catch that surfaces an honest "unavailable"
    // message instead of throwing.
    const fnStart = js.indexOf('async function loadLoopStatus(');
    expect(fnStart).toBeGreaterThan(-1);
    // Find the next top-level async function after loadLoopStatus.
    const fnEnd = js.indexOf('\n\tasync function ', fnStart + 30);
    const body = js.substring(fnStart, fnEnd > -1 ? fnEnd : fnStart + 4000);
    expect(body).toMatch(/try\s*\{/);
    expect(body).toMatch(/catch\s*\(/);
    // Honest placeholder text must exist.
    expect(body).toContain('state unavailable');
    // The "?" branch must exist for missing fields (no fabrication).
    expect(body).toContain('未知');
  });
});
