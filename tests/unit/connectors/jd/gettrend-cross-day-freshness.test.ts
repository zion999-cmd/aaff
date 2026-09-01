// P0010.2.11 follow-up — getTrend cross-day freshness guard.
//
// The tradeSummary date picker's 'yesterday' quick item is a SPA-boot
// value in dimVals and freezes for the tab's lifetime. A long-running
// tab crossing Beijing midnight keeps the stale value, shifting
// getTrend's 7-day categories by 1 day. The fix: read pageYesterday
// before the direct-fetch, reload once if stale, fail closed if the
// reload does not refresh it. These tests cover the pure-function
// helpers and the IIFE shape; the integration paths (read,
// reload-after-stale, fail-closed-after-stale-reload) require a live
// Chrome + JD page and are marked it.skip with rationale.

import { describe, it, expect } from 'vitest';
import {
  beijingTodayISO,
  buildReadPageYesterdayExpr,
  expectedPageYesterday,
} from '#app/connectors/jd/acquisition/cdp-client.js';

describe('beijingTodayISO', () => {
  it('returns YYYY-MM-DD for an input within the Beijing day', () => {
    // 2026-08-31 23:30 Beijing = 2026-08-31 15:30 UTC
    expect(beijingTodayISO(new Date('2026-08-31T15:30:00.000Z'))).toBe('2026-08-31');
  });

  it('rolls over at Beijing midnight (16:00 UTC)', () => {
    // 2026-08-31 23:59:59 Beijing = 2026-08-31 15:59:59 UTC
    expect(beijingTodayISO(new Date('2026-08-31T15:59:59.000Z'))).toBe('2026-08-31');
    // 2026-09-01 00:00:00 Beijing = 2026-08-31 16:00:00 UTC
    expect(beijingTodayISO(new Date('2026-08-31T16:00:00.000Z'))).toBe('2026-09-01');
  });
});

describe('expectedPageYesterday', () => {
  it('is beijing today - 1 day (mid Beijing day)', () => {
    // 2026-08-31 23:30 Beijing = 2026-08-31 15:30 UTC
    // Beijing today=2026-08-31, yesterday=2026-08-30
    expect(expectedPageYesterday(new Date('2026-08-31T15:30:00.000Z'))).toBe('2026-08-30');
  });

  it('flips to the new day exactly at Beijing midnight', () => {
    // 2026-09-01 00:00:00 Beijing = 2026-08-31 16:00:00 UTC
    // Beijing today becomes 2026-09-01, yesterday becomes 2026-08-31
    expect(expectedPageYesterday(new Date('2026-08-31T16:00:00.000Z'))).toBe('2026-08-31');
  });

  it('handles month rollover', () => {
    // 2026-10-01 01:00 Beijing = 2026-09-30 17:00 UTC
    // Beijing today=2026-10-01, yesterday=2026-09-30
    expect(expectedPageYesterday(new Date('2026-09-30T17:00:00.000Z'))).toBe('2026-09-30');
  });

  it('handles year rollover', () => {
    // 2027-01-01 01:00 Beijing = 2026-12-31 17:00 UTC
    expect(expectedPageYesterday(new Date('2026-12-31T17:00:00.000Z'))).toBe('2026-12-31');
  });
});

describe('buildReadPageYesterdayExpr', () => {
  it('returns a string (Playwright evaluate injects it as a script)', () => {
    const expr = buildReadPageYesterdayExpr();
    expect(typeof expr).toBe('string');
    expect(expr.length).toBeGreaterThan(100);
  });

  it('returns an IIFE that produces an object with { ok, yesterday? | error? }', () => {
    // The IIFE must be a self-invoking function expression.
    const expr = buildReadPageYesterdayExpr();
    // Strip leading whitespace; IIFE pattern: "(function(){ ... })()"
    const trimmed = expr.trim();
    expect(trimmed.startsWith('(function(')).toBe(true);
    expect(trimmed.endsWith(')()')).toBe(true);
  });

  it('contains the date-picker echo span selector', () => {
    const expr = buildReadPageYesterdayExpr();
    expect(expr).toContain("querySelectorAll('span.jmt-combo-date-picker-echo-item')");
  });

  it('looks up the "yesterday" quick item', () => {
    const expr = buildReadPageYesterdayExpr();
    expect(expr).toContain("key === 'yesterday'");
  });
});

describe('integration: cross-day freshness guard in acquireJdTradeOverviewViaCDP', () => {
  // These paths require a live Chrome + the JD 交易概况 page (operator must
  // be logged in). They are documented here as skipped — real acceptance
  // is performed by triggering a real trade.overview direct-fetch and
  // inspecting the resulting evidence file (see plan / handoff).

  it.skip('pageYesterday === expectedYesterday → no reload triggered', () => {
    // TODO live-chrome:
    //   1. open tradeSummary page at any non-midnight hour (pageYesterday
    //      naturally equals beijingToday-1day).
    //   2. mock evaluate responses: first read → matches expected → no reload.
    //   3. assert saveEvidence was called with the same pageYesterday-derived
    //      7-day window.
  });

  it.skip('pageYesterday stale → reload → re-read matches → acquisition continues', () => {
    // TODO live-chrome:
    //   1. keep the same tab open across a simulated Beijing midnight
    //      (or use a previously-stale page that hasn't been refreshed).
    //   2. expect: first read returns stale, page.reload() is invoked,
    //      re-read returns fresh, getTrend direct-fetch proceeds with the
    //      fresh yesterday.
    //   3. inspect saved 09/01_getTrend.json: trend.categories ==
    //      ['2026-08-25', ..., '2026-08-31'].
  });

  it.skip('pageYesterday stale → reload → still stale → fail closed (no Evidence written)', () => {
    // TODO live-chrome (hardest to simulate): even after reload, dimVals
    // keeps returning a stale value (e.g. SPA bug or operator logged out
    // so page returns a placeholder). The function must return
    // { success: false, errors: ['getTrend cross-day staleness: ...',
    // 'reload did not refresh dimVals.yesterday — acquisition refused,
    // no Evidence written'] } and historical-acquire.ts:182 must throw,
    // preventing any saveEvidence call.
  });
});
