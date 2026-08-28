// P0010.2.x — Unit tests for `normalizeForFingerprint`.
//
// The normalize helper is the load-bearing piece of the write-time
// dedup fix for the 90+ duplicate WorkItem runaway pattern. It strips
// volatile content (round counters, embedded timestamps, durations)
// from Agent prose before the fingerprint is computed. These tests
// pin the canonical collapse behavior so future refactors don't
// silently re-introduce a dedup miss.

import { describe, test, expect } from 'vitest';
import { normalizeForFingerprint } from '#shared/utils/text.js';

describe('normalizeForFingerprint', () => {
  describe('round counters (the runaway pattern from the audit)', () => {
    test('本情境已第 7 轮 / 第 8 轮 collapse to the same canonical', () => {
      const a = normalizeForFingerprint('本情境已第 7 轮连续 missing_capability，Agent 建议维持持续观察名单');
      const b = normalizeForFingerprint('本情境已第 8 轮连续 missing_capability，Agent 建议维持持续观察名单');
      expect(a).toBe(b);
    });

    test('第 N 轮 standalone also collapses', () => {
      const a = normalizeForFingerprint('已 第 7 轮 调查');
      const b = normalizeForFingerprint('已 第 12 轮 调查');
      expect(a).toBe(b);
    });

    test('round counter preserves the surrounding substance', () => {
      const out = normalizeForFingerprint('已 第 7 轮 调查，请关注 GMV 走势');
      // The substance "请关注 GMV 走势" must survive; only the counter is normalized.
      expect(out).toContain('请关注 GMV 走势');
      expect(out).not.toContain('7 轮');
    });
  });

  describe('embedded timestamps', () => {
    test('18:56:48 / 18:56 collapse to TIME marker', () => {
      const a = normalizeForFingerprint('截至 18:56:48 仍无新数据');
      const b = normalizeForFingerprint('截至 19:30:12 仍无新数据');
      expect(a).toBe(b);
    });

    test('HH:MM (no seconds) also collapses', () => {
      const a = normalizeForFingerprint('截至 18:56 仍无新数据');
      const b = normalizeForFingerprint('截至 07:42 仍无新数据');
      expect(a).toBe(b);
    });
  });

  describe('date stamps', () => {
    test('2026-08-27 / 2026-08-28 collapse to DATE marker', () => {
      const a = normalizeForFingerprint('2026-08-27 数据缺失');
      const b = normalizeForFingerprint('2026-08-28 数据缺失');
      expect(a).toBe(b);
    });

    test('08-27 / 08-28 (short form) collapse', () => {
      const a = normalizeForFingerprint('08-27 数据缺失');
      const b = normalizeForFingerprint('08-28 数据缺失');
      expect(a).toBe(b);
    });
  });

  describe('durations', () => {
    test('3 天 / 5 天 collapse to N DURATION', () => {
      const a = normalizeForFingerprint('维持 3 天 观察窗口');
      const b = normalizeForFingerprint('维持 5 天 观察窗口');
      expect(a).toBe(b);
    });

    test('2-3 天 / 5-7 小时 collapse to N-M DURATION', () => {
      const a = normalizeForFingerprint('维持 2-3 天 观察窗口');
      const b = normalizeForFingerprint('维持 5-7 天 观察窗口');
      expect(a).toBe(b);
    });
  });

  describe('substance preservation', () => {
    test('actual advice is NOT stripped (the load-bearing content)', () => {
      const out = normalizeForFingerprint('维持持续观察名单，不升级、不干预，等待 Fabric 数据能力恢复后补足证据');
      // Every Chinese phrase that IS the recommendation must survive intact.
      expect(out).toContain('维持持续观察名单');
      expect(out).toContain('不升级、不干预');
      expect(out).toContain('等待');
      expect(out).toContain('Fabric 数据能力恢复后补足证据');
    });

    test('judgment-style content is preserved', () => {
      const out = normalizeForFingerprint('数据缺失，无法判断 GMV 趋势');
      expect(out).toContain('数据缺失');
      expect(out).toContain('无法判断 GMV 趋势');
    });

    test('action verbs are preserved', () => {
      const out = normalizeForFingerprint('调整主推位 + 同步提高广告出价');
      expect(out).toContain('调整主推位');
      expect(out).toContain('同步提高广告出价');
    });
  });

  describe('whitespace', () => {
    test('multiple whitespace → single space', () => {
      const out = normalizeForFingerprint('hello   world\n\nfoo\tbar');
      expect(out).toBe('hello world foo bar');
    });

    test('leading/trailing whitespace is trimmed', () => {
      const out = normalizeForFingerprint('   hello world   ');
      expect(out).toBe('hello world');
    });
  });

  describe('idempotence', () => {
    test('normalize(normalize(x)) === normalize(x)', () => {
      const input = '本情境已第 7 轮连续 missing_capability，2026-08-27 18:56:48 维持 3 天 观察窗口';
      const once = normalizeForFingerprint(input);
      const twice = normalizeForFingerprint(once);
      expect(twice).toBe(once);
    });
  });

  describe('empty / edge cases', () => {
    test('empty string returns empty string', () => {
      expect(normalizeForFingerprint('')).toBe('');
    });

    test('whitespace-only returns empty string', () => {
      expect(normalizeForFingerprint('   \n\t  ')).toBe('');
    });
  });
});
