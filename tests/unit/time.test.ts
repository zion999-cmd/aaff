import { describe, expect, test } from 'vitest';
import { beijingDate, beijingHourBucket, diffDays, hourBucket, isWithin, parseIso, windowBounds } from '#shared/utils/time.js';

describe('parseIso', () => {
  test('valid iso -> Date', () => {
    expect(parseIso('2026-06-01T00:00:00.000Z')).toBeInstanceOf(Date);
  });

  test('invalid -> null', () => {
    expect(parseIso('not-a-date')).toBeNull();
  });
});

describe('diffDays', () => {
  test('whole day difference', () => {
    expect(diffDays('2026-06-01T00:00:00.000Z', '2026-06-04T00:00:00.000Z')).toBe(3);
  });

  test('invalid -> 0', () => {
    expect(diffDays('bad', '2026-06-04T00:00:00.000Z')).toBe(0);
  });
});

describe('hourBucket', () => {
  test('zeroes minutes/seconds', () => {
    expect(hourBucket('2026-06-01T13:45:09.000Z')).toBe('2026-06-01T13:00:00.000Z');
  });

  test('invalid passthrough', () => {
    expect(hourBucket('bad')).toBe('bad');
  });
});

describe('beijingHourBucket', () => {
  test('mid-morning Beijing -> YYYY-MM-DDTHH', () => {
    // 2026-08-31 08:20 Beijing = 2026-08-31 00:20 UTC.
    expect(beijingHourBucket(new Date('2026-08-31T00:20:00.000Z'))).toBe('2026-08-31T08');
  });

  test('Beijing 00:00 (UTC previous-day 16:00) stays on the Beijing day', () => {
    // 2026-08-31 00:30 Beijing = 2026-08-30 16:30 UTC — bucket must be 08-31T00.
    expect(beijingHourBucket(new Date('2026-08-30T16:30:00.000Z'))).toBe('2026-08-31T00');
  });

  test('Beijing 23:00 (UTC 15:00) is T23', () => {
    expect(beijingHourBucket(new Date('2026-08-31T15:00:00.000Z'))).toBe('2026-08-31T23');
  });

  test('same Beijing hour keeps the same bucket; next hour differs', () => {
    const a = beijingHourBucket(new Date('2026-08-31T00:05:00.000Z')); // 08:05 北京
    const b = beijingHourBucket(new Date('2026-08-31T00:55:00.000Z')); // 08:55 北京
    const c = beijingHourBucket(new Date('2026-08-31T01:05:00.000Z')); // 09:05 北京
    expect(a).toBe('2026-08-31T08');
    expect(b).toBe('2026-08-31T08');
    expect(c).toBe('2026-08-31T09');
  });
});

describe('windowBounds', () => {
  test('recent and previous equal-length windows', () => {
    const now = new Date('2026-06-14T00:00:00.000Z');
    const { recentStart, previousStart } = windowBounds(now, 7, 7);
    expect(recentStart.toISOString()).toBe('2026-06-07T00:00:00.000Z');
    expect(previousStart.toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });
});

describe('isWithin', () => {
  test('inside window', () => {
    const start = new Date('2026-06-07T00:00:00.000Z');
    const now = new Date('2026-06-14T00:00:00.000Z');
    expect(isWithin('2026-06-10T00:00:00.000Z', start, now)).toBe(true);
  });

  test('outside window', () => {
    const start = new Date('2026-06-07T00:00:00.000Z');
    const now = new Date('2026-06-14T00:00:00.000Z');
    expect(isWithin('2026-06-01T00:00:00.000Z', start, now)).toBe(false);
  });
});

describe('beijingDate (P0010.2.11 C2 — Asia/Shanghai calendar day)', () => {
  test('UTC 2026-08-28T23:58Z is Beijing 2026-08-29 (the mislabel that broke evidence)', () => {
    expect(beijingDate(new Date('2026-08-28T23:58:31.240Z'))).toBe('2026-08-29');
  });

  test('UTC midday maps to same Beijing day', () => {
    expect(beijingDate(new Date('2026-08-29T06:26:37.886Z'))).toBe('2026-08-29');
  });

  test('UTC 2026-08-29T15:59Z is still Beijing 8/29 (23:59 CST)', () => {
    expect(beijingDate(new Date('2026-08-29T15:59:00.000Z'))).toBe('2026-08-29');
  });

  test('UTC 2026-08-29T16:00Z is Beijing 8/30 (00:00 CST rollover)', () => {
    expect(beijingDate(new Date('2026-08-29T16:00:00.000Z'))).toBe('2026-08-30');
  });
});
