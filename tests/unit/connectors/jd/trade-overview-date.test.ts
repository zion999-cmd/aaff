// C2.0 — trade.overview business-date corruption guard.
//
// Confirmed pollution (2026-08-29): 2026-08-22/27/28_getSummary.json were
// written with the CURRENT day's realtime payload but stamped with the
// caller's historical business_date, because acquireJdTradeOverviewViaCDP
// used options.date ONLY for stamping while the direct-fetch transport
// always returns the current Beijing business day's todayRealtime data.
//
// Invariant under test: payload semantic business date (current Beijing day)
// MUST equal evidence metadata.business_date — enforced by failing CLOSED on
// any requested date that is not today (Beijing).

import { describe, it, expect } from 'vitest';
import {
  resolveTradeOverviewBusinessDate,
} from '#app/connectors/jd/acquisition/trade-overview-date.js';
import {
  acquireJdTradeOverviewViaCDP,
} from '#app/connectors/jd/acquisition/cdp-client.js';

// 2026-08-29T14:18Z = Beijing 2026-08-29 22:18
const NOW = new Date('2026-08-29T14:18:00.000Z');

describe('C2.0 — resolveTradeOverviewBusinessDate', () => {
  it('defaults to the current Beijing business day when no date is requested', () => {
    const result = resolveTradeOverviewBusinessDate(undefined, NOW);
    expect(result).toEqual({ ok: true, date: '2026-08-29' });
  });

  it('accepts a requested date equal to the current Beijing business day', () => {
    const result = resolveTradeOverviewBusinessDate('2026-08-29', NOW);
    expect(result).toEqual({ ok: true, date: '2026-08-29' });
  });

  it('rejects a historical date (the 2026-08-22/27/28 poisoning pattern)', () => {
    const result = resolveTradeOverviewBusinessDate('2026-08-22', NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.date).toBe('2026-08-22');
      expect(result.error).toContain('2026-08-22');
      expect(result.error).toContain('2026-08-29');
      expect(result.error).toContain('realtime');
    }
  });

  it('rejects a UTC-derived date acquired before 08:00 Beijing (old UTC-stamping class)', () => {
    // Acquired at 2026-08-28T23:58:31Z = Beijing 2026-08-29 07:58 — the
    // payload describes Beijing 8/29, so a UTC-derived 8/28 stamp is wrong.
    const utcNow = new Date('2026-08-28T23:58:31.000Z');
    const result = resolveTradeOverviewBusinessDate('2026-08-28', utcNow);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('2026-08-29');
  });

  it('rejects a future date', () => {
    expect(resolveTradeOverviewBusinessDate('2026-08-30', NOW).ok).toBe(false);
  });
});

describe('C2.0 — acquireJdTradeOverviewViaCDP date guard', () => {
  it('fails closed BEFORE any CDP work when a historical date is requested', async () => {
    const result = await acquireJdTradeOverviewViaCDP({ date: '2026-08-22' });

    expect(result.success).toBe(false);
    expect(result.date).toBe('2026-08-22');
    expect(result.summary).toEqual([]);
    expect(result.trend).toEqual([]);
    expect(result.errors?.[0]).toContain('2026-08-22');
    expect(result.errors?.[0]).toContain('realtime');
  });

  it('guard outcome is deterministic regardless of CDP availability', async () => {
    // The guard must fire before the CDP availability check, so an
    // unreachable port must produce the SAME guard error, not a CDP error.
    const reachablePort = await acquireJdTradeOverviewViaCDP({ date: '2020-01-01' });
    const deadPort = await acquireJdTradeOverviewViaCDP({ date: '2020-01-01', cdpPort: 59999 });
    expect(reachablePort.errors).toEqual(deadPort.errors);
    expect(reachablePort.errors?.[0]).toContain('2020-01-01');
  });
});
