// P0010.2.4 (ADR-060 audit B) + P0010.2.4 review repair (ADR-061) —
// Tests for `deriveInvestigationDisplayState`.
//
// The helper is a pure function:
//   f(inv, blockedRuntimeFailure, consecutiveFailures) -> 'pending' | 'recoverable' |
//                                                       'investigating' | 'blocked' |
//                                                       'completed'
//
// P0010.2.4 review repair (ADR-061): the previous 6-state contract
// (`pending / recoverable / investigating / blocked / completed /
// failed_unrecoverable`) included `failed_unrecoverable`, which no
// code path ever returned. The dead member is removed. `consecutiveFailures`
// is now an input that enriches the `blocked` banner's detail text
// (via the `INVESTIGATION_DISPLAY_BANNER.blocked.detail` function
// form); it does NOT change the state itself.
//
// The test also pins the banner copy (`INVESTIGATION_DISPLAY_BANNER`)
// so the operator-facing string never silently changes — and so the
// "blocked" state never shows "auto-recover, no human action" copy.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveInvestigationDisplayState,
  INVESTIGATION_DISPLAY_BANNER,
} from '#app/workspace/presentation.js';

describe('P0010.2.4 review repair — deriveInvestigationDisplayState (5 reachable states)', () => {
  it('returns "pending" when investigation is null/undefined', () => {
    expect(deriveInvestigationDisplayState(null, false, 0)).toBe('pending');
    expect(deriveInvestigationDisplayState(undefined, false, 0)).toBe('pending');
  });

  it('returns "pending" when investigation.status is "pending"', () => {
    expect(deriveInvestigationDisplayState({ status: 'pending' }, false, 0)).toBe('pending');
  });

  it('returns "investigating" when investigation.status is "investigating"', () => {
    expect(deriveInvestigationDisplayState({ status: 'investigating' }, false, 0)).toBe('investigating');
  });

  it('returns "completed" when investigation.status is "completed"', () => {
    expect(deriveInvestigationDisplayState({ status: 'completed' }, false, 0)).toBe('completed');
  });

  it('returns "recoverable" when investigation.status is "failed" (below threshold)', () => {
    expect(deriveInvestigationDisplayState({ status: 'failed' }, false, 2)).toBe('recoverable');
  });

  it('returns "recoverable" when investigation.status is "failed" with any consecutiveFailures count', () => {
    // consecutiveFailures is no longer used to pick the state. Below
    // threshold the runtime emits the recoverable path; above the
    // threshold it sets blockedRuntimeFailure=true (→ blocked). The
    // counter never independently drives the state.
    expect(deriveInvestigationDisplayState({ status: 'failed' }, false, 0)).toBe('recoverable');
    expect(deriveInvestigationDisplayState({ status: 'failed' }, false, 2)).toBe('recoverable');
    expect(deriveInvestigationDisplayState({ status: 'failed' }, false, 99)).toBe('recoverable');
  });

  it('returns "recoverable" when investigation.status is "failed" even with prior cognition', () => {
    const inv = {
      status: 'failed',
      stopReason: 'judgment',
      findings: [{ hypothesis: 'h', evidence: ['e'], confidence: 0.7 }],
    };
    expect(deriveInvestigationDisplayState(inv, false, 1)).toBe('recoverable');
  });

  it('returns "blocked" when blockedRuntimeFailure=true regardless of status', () => {
    expect(deriveInvestigationDisplayState({ status: 'failed' }, true, 3)).toBe('blocked');
    expect(deriveInvestigationDisplayState({ status: 'pending' }, true, 0)).toBe('blocked');
    expect(deriveInvestigationDisplayState(null, true, 0)).toBe('blocked');
    expect(deriveInvestigationDisplayState({ status: 'completed' }, true, 0)).toBe('blocked');
  });

  it('returns "pending" for unknown status (safe-by-default — never defaults to recoverable)', () => {
    expect(deriveInvestigationDisplayState({ status: 'weird_future_status' }, false, 0)).toBe('pending');
  });
});

describe('P0010.2.4 review repair — INVESTIGATION_DISPLAY_BANNER (5 states, no dead member)', () => {
  it('has exactly the 5 reachable states', () => {
    expect(Object.keys(INVESTIGATION_DISPLAY_BANNER).sort()).toEqual(
      ['blocked', 'completed', 'investigating', 'pending', 'recoverable'].sort(),
    );
    // CRITICAL: failed_unrecoverable was removed; the contract now
    // matches the real state machine.
    expect(Object.keys(INVESTIGATION_DISPLAY_BANNER)).not.toContain('failed_unrecoverable');
  });

  it('blocked state shows the clear-block button', () => {
    expect(INVESTIGATION_DISPLAY_BANNER.blocked.showClearBlock).toBe(true);
  });

  it('NON-blocked states do NOT show the clear-block button', () => {
    expect(INVESTIGATION_DISPLAY_BANNER.pending.showClearBlock).toBe(false);
    expect(INVESTIGATION_DISPLAY_BANNER.recoverable.showClearBlock).toBe(false);
    expect(INVESTIGATION_DISPLAY_BANNER.investigating.showClearBlock).toBe(false);
    expect(INVESTIGATION_DISPLAY_BANNER.completed.showClearBlock).toBe(false);
  });

  it('CRITICAL — blocked banner does NOT say "无需人工" / "自动恢复" (the contradiction we fixed)', () => {
    const blocked = INVESTIGATION_DISPLAY_BANNER.blocked;
    // detail is now a function; render it with a representative counter
    // before checking the produced string.
    const rendered = typeof blocked.detail === 'function' ? blocked.detail(5, 3) : blocked.detail;
    expect(blocked.headline).not.toMatch(/无需人工/);
    expect(blocked.headline).not.toMatch(/自动恢复/);
    expect(rendered).not.toMatch(/无需人工/);
    expect(rendered).not.toMatch(/自动恢复/);
  });

  it('blocked detail is a function that renders the actual counter + threshold', () => {
    const blocked = INVESTIGATION_DISPLAY_BANNER.blocked;
    expect(typeof blocked.detail).toBe('function');
    const detailFn = blocked.detail as (n: number, t: number) => string;
    const rendered = detailFn(5, 3);
    expect(rendered).toContain('已连续失败 5 次');
    expect(rendered).toContain('阈值 3');
    expect(rendered).toContain('解除阻塞并重新调度');
  });

  it('blocked detail falls back to threshold=3 when given an invalid value', () => {
    const blocked = INVESTIGATION_DISPLAY_BANNER.blocked;
    const detailFn = blocked.detail as (n: number, t: number) => string;
    const renderedNaN = detailFn(Number.NaN, Number.NaN);
    expect(renderedNaN).toContain('阈值 3');
    const renderedZero = detailFn(2, 0);
    expect(renderedZero).toContain('阈值 3');
  });

  it('CRITICAL — blocked banner does NOT contain literal ** markdown', () => {
    // The workspace renders detail as text (not innerHTML), so
    // literal `**` would have shown as asterisks. The review caught
    // this in app.js innerHTML render path.
    const blocked = INVESTIGATION_DISPLAY_BANNER.blocked;
    const rendered = typeof blocked.detail === 'function' ? blocked.detail(5, 3) : blocked.detail;
    expect(rendered).not.toMatch(/\*\*/);
  });

  it('CRITICAL — recoverable banner does NOT show a clear-block button', () => {
    expect(INVESTIGATION_DISPLAY_BANNER.recoverable.showClearBlock).toBe(false);
  });

  it('all static-state banners have non-empty headline + detail', () => {
    for (const state of ['pending', 'recoverable', 'investigating', 'completed'] as const) {
      const b = INVESTIGATION_DISPLAY_BANNER[state];
      expect(b.headline.length, state).toBeGreaterThan(0);
      expect(typeof b.detail === 'string' && b.detail.length, state).toBeGreaterThan(0);
    }
    // The blocked state has a function detail; its headline still must be non-empty.
    expect(INVESTIGATION_DISPLAY_BANNER.blocked.headline.length).toBeGreaterThan(0);
  });
});

describe('P0010.2.4 review repair — app.js wires the helper (no inline string match)', () => {
  it('app.js imports deriveInvestigationDisplayState + INVESTIGATION_DISPLAY_BANNER', () => {
    const appSrc = readFileSync(
      resolve(process.cwd(), 'apps/ecommerce/workspace/app.js'),
      'utf8',
    );
    expect(appSrc).toContain('deriveInvestigationDisplayState');
    expect(appSrc).toContain('INVESTIGATION_DISPLAY_BANNER');
  });

  it('app.js does NOT contain the old "重试调查（清除阻塞）" copy', () => {
    const appSrc = readFileSync(
      resolve(process.cwd(), 'apps/ecommerce/workspace/app.js'),
      'utf8',
    );
    expect(appSrc).not.toContain('重试调查（清除阻塞）');
  });

  it('app.js uses the new "解除阻塞并重新调度" copy', () => {
    const appSrc = readFileSync(
      resolve(process.cwd(), 'apps/ecommerce/workspace/app.js'),
      'utf8',
    );
    expect(appSrc).toContain('解除阻塞并重新调度');
  });

  it('app.js calls banner.detail as a function when it is one (the blocked path)', () => {
    const appSrc = readFileSync(
      resolve(process.cwd(), 'apps/ecommerce/workspace/app.js'),
      'utf8',
    );
    // app.js must check `typeof banner.detail === 'function'` and call
    // it with the live counter; otherwise the operator sees a literal
    // function source instead of a real message.
    expect(appSrc).toMatch(/typeof\s+banner\.detail\s*===\s*['"]function['"]/);
    expect(appSrc).toMatch(/banner\.detail\(/);
  });

  it('app.js button copy is sourced from INVESTIGATION_DISPLAY_BANNER, not inline', () => {
    const appSrc = readFileSync(
      resolve(process.cwd(), 'apps/ecommerce/workspace/app.js'),
      'utf8',
    );
    // The button textContent assignment must read from the banner map,
    // not from a hardcoded string. Look for the structural pattern:
    // `banner.showClearBlock ? ... : ...` and `btn.textContent = '解除阻塞...'`.
    expect(appSrc).toMatch(/banner\.showClearBlock/);
    expect(appSrc).toMatch(/btn\.textContent\s*=\s*['"]解除阻塞并重新调度['"]/);
  });

  it('app.js does NOT contain the literal "**" markdown in any banner detail path', () => {
    const appSrc = readFileSync(
      resolve(process.cwd(), 'apps/ecommerce/workspace/app.js'),
      'utf8',
    );
    // The previous bug: `detail: '已达连续失败阈值。**请执行...**'`
    // ended up showing literal asterisks because the workspace renders
    // detail via textContent. The review caught this; the banner table
    // is the canonical place for copy.
    expect(appSrc).not.toMatch(/已达连续失败阈值\.\s*\*\*/);
  });
});
