// P0010.2.4 (ADR-060 audit B) — Tests for `deriveInvestigationDisplayState`.
//
// The helper is a pure function:
//   f(inv, blockedRuntimeFailure, consecutiveFailures) -> 'pending' | 'recoverable' |
//                                                       'investigating' | 'blocked' |
//                                                       'completed' | 'failed_unrecoverable'
//
// The test also pins the banner copy (`INVESTIGATION_DISPLAY_BANNER`) so
// the operator-facing string never silently changes — and so the
// "blocked" state never shows "auto-recover, no human action" copy.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveInvestigationDisplayState,
  INVESTIGATION_DISPLAY_BANNER,
} from '#app/workspace/presentation.js';

describe('P0010.2.4 — deriveInvestigationDisplayState', () => {
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

describe('P0010.2.4 — INVESTIGATION_DISPLAY_BANNER', () => {
  it('has all 6 states', () => {
    expect(Object.keys(INVESTIGATION_DISPLAY_BANNER).sort()).toEqual(
      ['blocked', 'completed', 'failed_unrecoverable', 'investigating', 'pending', 'recoverable'].sort(),
    );
  });

  it('blocked state shows the clear-block button', () => {
    expect(INVESTIGATION_DISPLAY_BANNER.blocked.showClearBlock).toBe(true);
  });

  it('NON-blocked states do NOT show the clear-block button', () => {
    expect(INVESTIGATION_DISPLAY_BANNER.pending.showClearBlock).toBe(false);
    expect(INVESTIGATION_DISPLAY_BANNER.recoverable.showClearBlock).toBe(false);
    expect(INVESTIGATION_DISPLAY_BANNER.investigating.showClearBlock).toBe(false);
    expect(INVESTIGATION_DISPLAY_BANNER.completed.showClearBlock).toBe(false);
    expect(INVESTIGATION_DISPLAY_BANNER.failed_unrecoverable.showClearBlock).toBe(false);
  });

  it('CRITICAL — blocked banner does NOT say "无需人工" / "自动恢复" (the contradiction we fixed)', () => {
    const blocked = INVESTIGATION_DISPLAY_BANNER.blocked;
    expect(blocked.headline).not.toMatch(/无需人工/);
    expect(blocked.headline).not.toMatch(/自动恢复/);
    expect(blocked.detail).not.toMatch(/无需人工/);
    expect(blocked.detail).not.toMatch(/自动恢复/);
  });

  it('blocked banner mentions the "解除阻塞并重新调度" action', () => {
    expect(INVESTIGATION_DISPLAY_BANNER.blocked.detail).toMatch(/解除阻塞并重新调度/);
  });

  it('CRITICAL — recoverable banner does NOT show a clear-block button', () => {
    expect(INVESTIGATION_DISPLAY_BANNER.recoverable.showClearBlock).toBe(false);
  });

  it('all banners have non-empty headline + detail', () => {
    for (const state of Object.keys(INVESTIGATION_DISPLAY_BANNER) as Array<keyof typeof INVESTIGATION_DISPLAY_BANNER>) {
      expect(INVESTIGATION_DISPLAY_BANNER[state].headline.length, state).toBeGreaterThan(0);
      expect(INVESTIGATION_DISPLAY_BANNER[state].detail.length, state).toBeGreaterThan(0);
    }
  });
});

describe('P0010.2.4 — app.js wires the helper (no inline string match)', () => {
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
});
