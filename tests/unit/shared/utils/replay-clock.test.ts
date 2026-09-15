// P0013 Phase 0 — ReplayBusinessClock + TemporalVisibilityFilter (RED tests).
//
// §2 / §3 / §23 invariants:
//   1. The Replay clock is INDEPENDENT of the production clock.
//   2. No-future-leak is enforced at the DATA BOUNDARY, not at the prompt.
//   3. The clock is deterministic: same input → same output, no Date.now() leak.
//
// These tests are the load-bearing proof that the historical cognitive replay
// cannot accidentally let the Agent see data it shouldn't.

import { describe, it, expect } from 'vitest';
import {
  createReplayClock,
  nextDate,
  isAtOrBefore,
  isReplayTerminal,
  type ReplayBusinessClock,
  type ReplayClockStatus,
} from '#shared/utils/replay-clock.js';
import {
  filterToVisible,
  assertNoLeakage,
  countLeakedDates,
  type VisibleItem,
} from '#shared/utils/temporal-visibility.js';

describe('createReplayClock', () => {
  it('initializes with start date, step 0, status READY', () => {
    const c = createReplayClock('2026-08-04', '2026-09-02');
    expect(c.currentBusinessDate).toBe('2026-08-04');
    expect(c.startBusinessDate).toBe('2026-08-04');
    expect(c.endBusinessDate).toBe('2026-09-02');
    expect(c.step).toBe(0);
    expect(c.status).toBe('READY');
  });

  it('rejects an end date before start date', () => {
    expect(() => createReplayClock('2026-09-02', '2026-08-04')).toThrow(/start.*end/i);
  });

  it('rejects a start date in the wrong format', () => {
    expect(() => createReplayClock('not-a-date', '2026-09-02')).toThrow(/YYYY-MM-DD/);
    expect(() => createReplayClock('2026-8-4', '2026-09-02')).toThrow(/YYYY-MM-DD/);
  });

  it('rejects an end date in the wrong format', () => {
    expect(() => createReplayClock('2026-08-04', '2026/09/02')).toThrow(/YYYY-MM-DD/);
  });

  it('is a frozen value object — callers cannot mutate the clock', () => {
    const c = createReplayClock('2026-08-04', '2026-09-02');
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe('nextDate', () => {
  it('increments by one day inside the window', () => {
    const c = createReplayClock('2026-08-04', '2026-09-02');
    const after = nextDate(c);
    expect(after.currentBusinessDate).toBe('2026-08-05');
    expect(after.step).toBe(1);
    expect(after.status).toBe('RUNNING');
  });

  it('crosses month boundaries correctly', () => {
    const c = createReplayClock('2026-08-31', '2026-09-02');
    const after = nextDate(c);
    expect(after.currentBusinessDate).toBe('2026-09-01');
  });

  it('handles leap year February correctly', () => {
    const c = createReplayClock('2024-02-28', '2024-03-01');
    expect(nextDate(c).currentBusinessDate).toBe('2024-02-29');
    expect(nextDate(nextDate(c)).currentBusinessDate).toBe('2024-03-01');
  });

  it('transitions to COMPLETED and freezes at the last valid date when stepping past end', () => {
    const c = createReplayClock('2026-08-04', '2026-08-04');
    const after = nextDate(c);
    expect(after.currentBusinessDate).toBe('2026-08-04');
    expect(after.status).toBe('COMPLETED');
    const again = nextDate(after);
    expect(again.currentBusinessDate).toBe('2026-08-04');
    expect(again.status).toBe('COMPLETED');
    expect(again.step).toBe(after.step);
  });

  it('returns a NEW clock object (does not mutate the input)', () => {
    const c = createReplayClock('2026-08-04', '2026-09-02');
    const after = nextDate(c);
    expect(after).not.toBe(c);
    expect(c.currentBusinessDate).toBe('2026-08-04');
    expect(c.step).toBe(0);
  });

  it('is deterministic — same input always yields same output (no Date.now leak)', () => {
    const a = nextDate(createReplayClock('2026-08-12', '2026-09-02'));
    const b = nextDate(createReplayClock('2026-08-12', '2026-09-02'));
    expect(a).toEqual(b);
  });
});

describe('isAtOrBefore', () => {
  it('compares two YYYY-MM-DD dates lexicographically', () => {
    expect(isAtOrBefore('2026-08-10', '2026-08-12')).toBe(true);
    expect(isAtOrBefore('2026-08-12', '2026-08-12')).toBe(true);
    expect(isAtOrBefore('2026-08-13', '2026-08-12')).toBe(false);
  });

  it('handles month and year boundaries', () => {
    expect(isAtOrBefore('2026-08-31', '2026-09-01')).toBe(true);
    expect(isAtOrBefore('2026-12-31', '2027-01-01')).toBe(true);
  });
});

describe('isReplayTerminal', () => {
  it('returns true only for COMPLETED and FAILED', () => {
    expect(isReplayTerminal('READY' as ReplayClockStatus)).toBe(false);
    expect(isReplayTerminal('RUNNING' as ReplayClockStatus)).toBe(false);
    expect(isReplayTerminal('PAUSED' as ReplayClockStatus)).toBe(false);
    expect(isReplayTerminal('COMPLETED' as ReplayClockStatus)).toBe(true);
    expect(isReplayTerminal('FAILED' as ReplayClockStatus)).toBe(true);
  });
});

// --------------------------------------------------------------------------
//   TemporalVisibilityFilter — the §3 "no-future-leak at the data boundary"
// --------------------------------------------------------------------------

describe('filterToVisible', () => {
  type Row = { date: string; id: number };
  const rows: Row[] = [
    { id: 1, date: '2026-08-10' },
    { id: 2, date: '2026-08-12' },
    { id: 3, date: '2026-08-15' },
    { id: 4, date: '2026-08-12' },
  ];

  it('returns only items with business_date <= clock.currentBusinessDate', () => {
    const c = createReplayClock('2026-08-12', '2026-09-02');
    const visible = filterToVisible<Row>(c, rows, (r) => r.date);
    expect(visible.map((r) => r.id).sort()).toEqual([1, 2, 4]);
  });

  it('drops future items silently (does not throw)', () => {
    const c = createReplayClock('2026-08-12', '2026-09-02');
    const futureOnly: Row[] = [{ id: 99, date: '2026-08-13' }];
    expect(filterToVisible<Row>(c, futureOnly, (r) => r.date)).toEqual([]);
  });

  it('includes items on the exact boundary date (<= is the contract)', () => {
    const c = createReplayClock('2026-08-12', '2026-09-02');
    const onBoundary: Row[] = [{ id: 7, date: '2026-08-12' }];
    expect(filterToVisible<Row>(c, onBoundary, (r) => r.date)).toEqual(onBoundary);
  });

  it('handles empty input', () => {
    const c = createReplayClock('2026-08-12', '2026-09-02');
    expect(filterToVisible<Row>(c, [], (r) => r.date)).toEqual([]);
  });

  it('works on the boundary case clock = end, status COMPLETED', () => {
    let c: ReplayBusinessClock = createReplayClock('2026-08-04', '2026-09-02');
    for (let i = 0; i < 30; i++) c = nextDate(c);
    expect(c.status).toBe('COMPLETED');
    const onLast: Row[] = [{ id: 1, date: '2026-09-02' }];
    expect(filterToVisible<Row>(c, onLast, (r) => r.date)).toEqual(onLast);
  });
});

describe('assertNoLeakage', () => {
  type Row = { date: string; id: number };
  const all30: Row[] = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 4 + i));
    return { id: i + 1, date: d.toISOString().slice(0, 10) };
  });

  it('passes when no future items present', () => {
    const c = createReplayClock('2026-08-20', '2026-09-02');
    const visible = filterToVisible<Row>(c, all30, (r) => r.date);
    expect(() => assertNoLeakage(c, visible, (r) => r.date)).not.toThrow();
  });

  it('THROWS the moment a future item is present — the §3 enforcement point', () => {
    const c = createReplayClock('2026-08-20', '2026-09-02');
    const leaked: Row[] = [...all30];
    expect(() => assertNoLeakage(c, leaked, (r) => r.date)).toThrow(/leakage|future|>|2026-08-2/);
  });

  it('the error message names the offending future date(s)', () => {
    const c = createReplayClock('2026-08-20', '2026-09-02');
    try {
      assertNoLeakage(c, all30, (r) => r.date);
      expect.fail('expected assertNoLeakage to throw');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/2026-08-21/);
      expect(message).toMatch(/2026-08-25/);
    }
  });
});

describe('countLeakedDates', () => {
  type Row = { date: string; id: number };

  it('returns 0 when no future items are present', () => {
    // All three rows are <= 2026-09-02 (the clock's end), so a clock at
    // 2026-09-02 sees zero leakage.
    const c = createReplayClock('2026-09-02', '2026-09-02');
    const rows: Row[] = [
      { id: 1, date: '2026-08-10' },
      { id: 2, date: '2026-08-15' },
      { id: 3, date: '2026-08-25' },
    ];
    expect(countLeakedDates(c, rows, (r) => r.date)).toBe(0);
  });

  it('returns the count of future items', () => {
    // rows at 08-15 and 08-25 are both > clock 08-12 → count = 2.
    const c = createReplayClock('2026-08-12', '2026-09-02');
    const rows: Row[] = [
      { id: 1, date: '2026-08-10' },
      { id: 2, date: '2026-08-15' },
      { id: 3, date: '2026-08-25' },
    ];
    expect(countLeakedDates(c, rows, (r) => r.date)).toBe(2);
  });

  it('boundary: items on the exact clock date are NOT counted as leaked', () => {
    const c = createReplayClock('2026-08-15', '2026-09-02');
    const rows: Row[] = [{ id: 1, date: '2026-08-15' }];
    expect(countLeakedDates(c, rows, (r) => r.date)).toBe(0);
  });
});

describe('VisibleItem (type contract)', () => {
  it('wraps an item with its business_date string', () => {
    const wrapped: VisibleItem<{ x: number }> = { item: { x: 1 }, businessDate: '2026-08-12' };
    expect(wrapped.item.x).toBe(1);
    expect(wrapped.businessDate).toBe('2026-08-12');
  });
});
