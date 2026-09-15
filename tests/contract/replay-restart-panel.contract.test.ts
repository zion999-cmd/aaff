// P0013+ — Restart returns to the start panel (range selector reachable).
//
// Regression for the operator-reported defect (2026-09-12): "刚才我还看到
// 历史回放可以选择时间区间, 现在又不能选择了". Two root causes:
//
//   1. loadReplay rendered the start panel (the ONLY surface containing the
//      date inputs) and then, when any run already existed in DB, hid it
//      again when the runs list resolved — the selector flashed and vanished.
//   2. 重新回放 did NOT return to the panel: it POSTed a brand-new run
//      immediately, reading the HIDDEN date inputs (which always held the
//      full-window defaults). The operator could never change the range
//      after the first run; every restart silently created another full
//      30-day run.
//
// Fix contract:
//   - onRestartClick navigates back to the start panel (showStartPanel),
//     gated only by the RUNNING check. It MUST NOT POST /runs itself —
//     creation stays exclusively in onStartClick (开始回放 in the panel).
//   - showStartPanel unhides #replayStartPanel and hides the run surfaces
//     (controls / timeline / daily view / monthly review).
//   - loadReplay does NOT reveal the start panel before the runs-list fetch
//     resolves; it shows the panel only when the list is empty, and falls
//     back to the panel on fetch failure (never a blank view).
//
// Source-level for the same reason as workspace-loading-flicker.contract:
// vanilla-JS workspace, no jsdom runner configured.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(process.cwd(), 'apps/ecommerce/workspace/views/replay-view.js'),
  'utf8',
);

/** Brace-balanced body of `const name = ...` or `window.name = function`. */
function arrowBody(name: string): string {
  const decl = new RegExp(`(?:const ${name}\\s*=|window\\.${name}\\s*=\\s*function)`);
  const declIdx = source.search(decl);
  expect(declIdx, `${name} declaration exists`).toBeGreaterThan(-1);
  const openIdx = source.indexOf('{', declIdx);
  expect(openIdx, `${name} has a block body`).toBeGreaterThan(-1);
  let depth = 1;
  let i = openIdx + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    i += 1;
  }
  return source.slice(openIdx + 1, i - 1);
}

describe('replay restart → start panel contract', () => {
  it('onRestartClick navigates to showStartPanel without CREATING a run (P0013.3: pause of an idle scheduler is allowed, no dead-end)', () => {
    const body = arrowBody('onRestartClick');
    expect(body).toContain('showStartPanel()');
    // It MUST NOT create a run: the run-creation POST is exclusively onStartClick.
    expect(body).not.toMatch(/apiPost\s*\(\s*['"][^'"]*\/runs['"]/);
    expect(body).not.toMatch(/apiPost\s*\(\s*['"]\/api\/replay\/runs['"]/);
    // P0013.3 repair: RUNNING is handled (pause idle scheduler / wait on
    // in-flight step) rather than an unreachable "please pause" alert.
    expect(body).toMatch(/status\s*===\s*'RUNNING'/);
    expect(body).not.toContain('请先');
    // Idle scheduler pause uses the existing advance mode=pause capability.
    expect(body).toMatch(/mode:\s*'pause'/);
  });

  it('onStartClick remains the ONLY creator of runs (POST /runs in panel)', () => {
    const startBody = arrowBody('onStartClick');
    expect(startBody).toMatch(/apiPost\s*\(\s*'\/api\/replay\/runs'/);
  });

  it('showStartPanel reveals the start panel and hides all run surfaces', () => {
    const body = arrowBody('showStartPanel');
    expect(body).toContain("getElementById('replayStartPanel')");
    expect(body).toMatch(/start\.style\.display\s*=\s*''/);
    for (const id of ['replayControls', 'replayTimeline', 'replayDailyView', 'replayMonthlyReview']) {
      expect(body, `hides #${id}`).toContain(`getElementById('${id}')`);
    }
    // Date inputs are prefilled from the abandoned run so the operator can
    // edit the existing window rather than retype it.
    expect(body).toContain('state.run.startBusinessDate');
    expect(body).toContain('state.run.endBusinessDate');
  });

  it('loadReplay keeps the start panel hidden until the runs list resolves', () => {
    const body = arrowBody('loadReplay');
    // Panel starts hidden ...
    const hideIdx = body.indexOf("start.style.display = 'none'");
    expect(hideIdx).toBeGreaterThan(-1);
    // ... and is revealed only via showStartPanel() in the empty/error path.
    expect(body).toContain('showStartPanel()');
    // No upfront reveal before the fetch (the flash-and-vanish bug).
    const revealBeforeFetch = body.slice(0, body.indexOf('apiGet')).includes("start.style.display = ''");
    expect(revealBeforeFetch).toBe(false);
  });
});
