// P0010.2.x — time-format.js tests.
//
// The four formatters are the single source of truth for "how to
// display a timestamp" in the Workspace. These tests pin:
//
//   1. formatLocalTime(iso)  → "YYYY-MM-DD HH:mm:ss" (browser local)
//   2. formatUtcTime(iso)    → "YYYY-MM-DD HH:mm:ssZ" (explicit UTC)
//   3. formatBusinessDate(iso) → "YYYY-MM-DD" (NO time, NO "00:00:00" padding)
//   4. formatProxyTime(iso)  → "≈YYYY-MM-DD HH:mm" (proxy marker, no sec)
//
// The user's IMPORTANT rule:
//   "业务日期: YYYY-MM-DD 绝不伪造成 00:00:00"
//   is enforced by test 7 below — the formatter must NEVER pad the
//   business date with a fake "00:00:00" suffix.

import { describe, test, expect } from 'vitest';
import {
  formatLocalTime,
  formatUtcTime,
  formatBusinessDate,
  formatProxyTime,
  formatRelative,
} from '#app/workspace/time-format.js';

// A fixed UTC moment: 2026-08-27T06:30:42Z.
// The test must NOT depend on the host's local timezone (CI runs
// under different TZs). So:
const SAMPLE_UTC_ISO = '2026-08-27T06:30:42.000Z';
const SAMPLE_MS = Date.UTC(2026, 7, 27, 6, 30, 42); // month is 0-indexed: 7 = August

describe('formatLocalTime', () => {
  test('returns "YYYY-MM-DD HH:mm:ss" with zero-padded components', () => {
    const out = formatLocalTime(SAMPLE_UTC_ISO);
    // We don't pin the local hour (depends on TZ), but the format
    // must be 19 chars long, all numeric, with a single space between
    // date and time.
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('uses the browser local timezone (verifiable via Date.getTimezoneOffset)', () => {
    // We do not change the system timezone in a test, but we can
    // assert the local-time output equals new Date(iso).toLocaleString
    // formatted as YYYY-MM-DD HH:mm:ss. This is the round-trip
    // contract: formatLocalTime is a typed wrapper around the same
    // conversion `new Date(iso).toLocaleString(...)` would do.
    const d = new Date(SAMPLE_MS);
    const expected =
      d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
    expect(formatLocalTime(SAMPLE_UTC_ISO)).toBe(expected);
  });

  test('returns "—" on missing or invalid input (not empty string)', () => {
    expect(formatLocalTime('')).toBe('—');
    expect(formatLocalTime(null as any)).toBe('—');
    expect(formatLocalTime(undefined as any)).toBe('—');
    expect(formatLocalTime('not-a-date')).toBe('—');
  });
});

describe('formatUtcTime', () => {
  test('returns "YYYY-MM-DD HH:mm:ssZ" matching the input UTC', () => {
    expect(formatUtcTime(SAMPLE_UTC_ISO)).toBe('2026-08-27 06:30:42Z');
  });

  test('zero-pads single-digit month and day', () => {
    // 2026-01-05T03:04:05Z — month=01, day=05, hour=03
    expect(formatUtcTime('2026-01-05T03:04:05.000Z')).toBe('2026-01-05 03:04:05Z');
  });

  test('returns "—" on missing or invalid input', () => {
    expect(formatUtcTime('')).toBe('—');
    expect(formatUtcTime('garbage')).toBe('—');
  });
});

describe('formatBusinessDate — the user\'s IMPORTANT rule', () => {
  test('returns "YYYY-MM-DD" with NO time component', () => {
    expect(formatBusinessDate(SAMPLE_UTC_ISO)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('NEVER pads with "00:00:00" (audit IMPORTANT rule)', () => {
    // The whole point of the business date formatter: the operator
    // reads "2026-08-27" and knows the date is real, but the time is
    // not. Padding with 00:00:00 would lie about precision.
    const out = formatBusinessDate(SAMPLE_UTC_ISO);
    expect(out).not.toContain('00:00:00');
    expect(out).not.toContain(' ');
    expect(out).not.toContain('T');
  });

  test('zero-pads single-digit month and day', () => {
    expect(formatBusinessDate('2026-01-05T12:34:56.000Z')).toBe('2026-01-05');
  });

  test('returns "—" on missing or invalid input', () => {
    expect(formatBusinessDate('')).toBe('—');
    expect(formatBusinessDate('garbage')).toBe('—');
  });
});

describe('formatProxyTime — the proxy marker contract', () => {
  test('starts with "≈" (the proxy marker MUST be visible)', () => {
    expect(formatProxyTime(SAMPLE_UTC_ISO).startsWith('≈')).toBe(true);
  });

  test('truncates to minutes (no seconds)', () => {
    // Local timezone, so we don't pin the hour. Just confirm the
    // format is "≈YYYY-MM-DD HH:mm" with a 16-char string after the
    // marker.
    const out = formatProxyTime(SAMPLE_UTC_ISO);
    expect(out).toMatch(/^≈\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test('NEVER strips the "≈" marker (the contract is honesty)', () => {
    expect(formatProxyTime('')).toBe('—');
    // Even with valid input, the marker is always present.
    expect(formatProxyTime('2026-12-31T23:59:59.000Z')).toMatch(/^≈/);
  });
});

describe('formatRelative', () => {
  test('"刚刚" for < 60s ago', () => {
    const now = SAMPLE_MS + 30 * 1000;
    expect(formatRelative(SAMPLE_UTC_ISO, now)).toBe('刚刚');
  });

  test('"N 分钟前" for < 60min', () => {
    const now = SAMPLE_MS + 5 * 60 * 1000;
    expect(formatRelative(SAMPLE_UTC_ISO, now)).toBe('5 分钟前');
  });

  test('"N 小时前" for < 24h', () => {
    const now = SAMPLE_MS + 3 * 60 * 60 * 1000;
    expect(formatRelative(SAMPLE_UTC_ISO, now)).toBe('3 小时前');
  });

  test('"N 天前" for < 7d', () => {
    const now = SAMPLE_MS + 2 * 24 * 60 * 60 * 1000;
    expect(formatRelative(SAMPLE_UTC_ISO, now)).toBe('2 天前');
  });

  test('falls back to formatBusinessDate for >= 7d', () => {
    const now = SAMPLE_MS + 14 * 24 * 60 * 60 * 1000;
    // The exact value depends on local TZ, but it must NOT contain
    // a time component (the rule carries through to formatRelative).
    const out = formatRelative(SAMPLE_UTC_ISO, now);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('returns "—" on missing or invalid input', () => {
    expect(formatRelative('')).toBe('—');
    expect(formatRelative('garbage')).toBe('—');
  });
});
