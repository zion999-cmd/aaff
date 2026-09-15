// Unit tests for the shared Directional Fact contract.

import { describe, it, expect } from 'vitest';
import {
  computeDirectionalFact,
  formatDirectionalFact,
  formatDirectionalFactShort,
  formatSignedDeltaPct,
  formatMagnitudePct,
  defaultValueFormatter,
  DEFAULT_FLAT_EPS_PCT,
  DIRECTION_ACTION_WORD,
  DIRECTION_PCT_WORD,
} from '#shared/utils/directional-fact.js';

const baseArgs = {
  comparison_base: '昨日同时段',
  observation_window: '今日 10:00 时段',
  baseline_source: 'yesterday_same_moment' as const,
};

describe('directional-fact / computeDirectionalFact', () => {
  it('Case 1: decrease 10609.95 -> 5875 (canonical task example)', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 5875, previous: 10609.95 });
    expect(f).not.toBeNull();
    expect(f!.direction).toBe('decrease');
    expect(f!.current_value).toBe(5875);
    expect(f!.previous_value).toBe(10609.95);
    expect(f!.delta_pct_signed).toBe(-44.6);
    expect(f!.magnitude_pct).toBe(44.6);
    expect(f!.delta_signed).toBe(-4734.95);
    expect(f!.comparison_base).toBe('昨日同时段');
  });

  it('Case 2: increase 5875 -> 10609.95 (mirror of Case 1)', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 10609.95, previous: 5875 });
    expect(f).not.toBeNull();
    expect(f!.direction).toBe('increase');
    expect(f!.delta_pct_signed).toBe(80.6);
    expect(f!.magnitude_pct).toBe(80.6);
  });

  it('flat: |delta_pct_signed| <= DEFAULT_FLAT_EPS_PCT (0.05)', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 100, previous: 100.03 });
    expect(f).not.toBeNull();
    expect(f!.direction).toBe('flat');
    expect(f!.magnitude_pct).toBeLessThanOrEqual(DEFAULT_FLAT_EPS_PCT);
  });

  it('flat: exact equality', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 100, previous: 100 });
    expect(f).not.toBeNull();
    expect(f!.direction).toBe('flat');
    expect(f!.delta_pct_signed).toBe(0);
  });

  it('returns null when previous is 0 (undefined comparison)', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 100, previous: 0 });
    expect(f).toBeNull();
  });

  it('returns null when current is NaN', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: Number.NaN, previous: 100 });
    expect(f).toBeNull();
  });

  it('returns null when current is Infinity', () => {
    const f = computeDirectionalFact({
      ...baseArgs,
      current: Number.POSITIVE_INFINITY,
      previous: 100,
    });
    expect(f).toBeNull();
  });

  it('returns null when previous is NaN', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 100, previous: Number.NaN });
    expect(f).toBeNull();
  });

  it('custom eps_pct: 1.0 turns a 0.8% move into flat', () => {
    const f = computeDirectionalFact({
      ...baseArgs,
      current: 100.8,
      previous: 100,
      eps_pct: 1.0,
    });
    expect(f).not.toBeNull();
    expect(f!.direction).toBe('flat');
  });

  it('CVR stored as ratio, formatted as %', () => {
    const f = computeDirectionalFact({
      ...baseArgs,
      current: 0.12,
      previous: 0.10,
      comparison_base: '昨日',
      observation_window: '今日',
      baseline_source: 'previous_day_full',
    });
    expect(f).not.toBeNull();
    expect(f!.direction).toBe('increase');
    expect(f!.delta_pct_signed).toBe(20);
    expect(f!.magnitude_pct).toBe(20);
  });
});

describe('directional-fact / formatDirectionalFact — canonical prose', () => {
  it('decrease: never "下降 -44.6%", always "从 A 下降至 B，降幅 44.6%"', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 5875, previous: 10609.95 })!;
    const prose = formatDirectionalFact(f, { metric: 'gmv' });
    expect(prose).not.toMatch(/下降\s*-\d/);
    expect(prose).not.toMatch(/回落\s*-?\d/);
    expect(prose).not.toMatch(/下跌\s*-?\d/);
    expect(prose).not.toMatch(/减少\s*-?\d/);
    expect(prose).not.toMatch(/下降\s*\d+%/);
    expect(prose).toContain('从 ¥10609.95 下降至 ¥5875.00');
    expect(prose).toContain('降幅 44.6%');
  });

  it('increase: never "上涨 +80.6%", always "从 A 上升至 B，涨幅 80.6%"', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 10609.95, previous: 5875 })!;
    const prose = formatDirectionalFact(f, { metric: 'gmv' });
    expect(prose).not.toMatch(/上涨\s*[+-]\d/);
    expect(prose).not.toMatch(/上升\s*[+-]\d/);
    expect(prose).not.toMatch(/增长\s*[+-]\d/);
    expect(prose).toContain('从 ¥5875.00 上升至 ¥10609.95');
    expect(prose).toContain('涨幅 80.6%');
  });

  it('flat: "较 X 持平（幅度 0.04%）" — never "持平 -0.04%"', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 100, previous: 100.04 })!;
    const prose = formatDirectionalFact(f, { metric: 'orders' });
    expect(prose).toMatch(/持平/);
    expect(prose).toContain('幅度');
    expect(prose).not.toMatch(/[+-]\d+\.\d+%/);
  });

  it('metric label is prepended when supplied', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 5875, previous: 10609.95 })!;
    const prose = formatDirectionalFact(f, { metric: 'gmv', metric_label: 'GMV' });
    expect(prose).toMatch(/^GMV /);
  });

  it('custom value_formatter overrides default', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 5875, previous: 10609.95 })!;
    const prose = formatDirectionalFact(f, { value_formatter: (v) => `${v.toFixed(0)}元` });
    expect(prose).toContain('从 10610元 下降至 5875元');
  });
});

describe('directional-fact / formatDirectionalFactShort', () => {
  it('decrease: "GMV 下降 44.6%" (no sign on magnitude)', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 5875, previous: 10609.95 })!;
    expect(formatDirectionalFactShort(f, { metric_label: 'GMV' })).toBe('GMV 下降 44.6%');
  });

  it('increase: "GMV 上升 80.6%"', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 10609.95, previous: 5875 })!;
    expect(formatDirectionalFactShort(f, { metric_label: 'GMV' })).toBe('GMV 上升 80.6%');
  });

  it('flat: "GMV 较昨日持平（约 0.04%）"', () => {
    const f = computeDirectionalFact({ ...baseArgs, current: 100, previous: 100.04 })!;
    expect(formatDirectionalFactShort(f, { metric_label: 'GMV' })).toMatch(/GMV 较.*持平/);
  });
});

describe('directional-fact / formatSignedDeltaPct (math repr, NOT prose)', () => {
  it('negative: "-44.6%"', () => {
    expect(formatSignedDeltaPct(-44.6)).toBe('-44.6%');
  });
  it('positive: "+12.3%"', () => {
    expect(formatSignedDeltaPct(12.3)).toBe('+12.3%');
  });
  it('zero: "+0.00%" (2dp because |0| < 1)', () => {
    expect(formatSignedDeltaPct(0)).toBe('+0.00%');
  });
  it('tiny < 1% uses 2dp: "-0.03%"', () => {
    expect(formatSignedDeltaPct(-0.03)).toBe('-0.03%');
  });
});

describe('directional-fact / formatMagnitudePct (always positive, for prose)', () => {
  it('abs of negative: "44.6%"', () => {
    expect(formatMagnitudePct(-44.6)).toBe('44.6%');
  });
  it('abs of positive: "12.3%"', () => {
    expect(formatMagnitudePct(12.3)).toBe('12.3%');
  });
});

describe('directional-fact / defaultValueFormatter', () => {
  it('gmv: ¥1234.56', () => {
    expect(defaultValueFormatter(1234.56, 'gmv')).toBe('¥1234.56');
  });
  it('cvr: 12.3% (when input is a ratio)', () => {
    expect(defaultValueFormatter(0.123, 'cvr')).toBe('12.3%');
  });
  it('integer: 100', () => {
    expect(defaultValueFormatter(100, 'orders')).toBe('100');
  });
  it('non-integer without metric: "12.34"', () => {
    expect(defaultValueFormatter(12.34)).toBe('12.34');
  });
});

describe('directional-fact / dictionary invariants', () => {
  it('DIRECTION_PCT_WORD has unique magnitude words per direction', () => {
    expect(DIRECTION_PCT_WORD.increase).toBe('涨幅');
    expect(DIRECTION_PCT_WORD.decrease).toBe('降幅');
    expect(DIRECTION_PCT_WORD.flat).toBe('幅度');
    expect(new Set(Object.values(DIRECTION_PCT_WORD)).size).toBe(3);
  });
  it('DIRECTION_ACTION_WORD has unique action words per direction', () => {
    expect(DIRECTION_ACTION_WORD.increase).toBe('上升');
    expect(DIRECTION_ACTION_WORD.decrease).toBe('下降');
    expect(DIRECTION_ACTION_WORD.flat).toBe('持平');
    expect(new Set(Object.values(DIRECTION_ACTION_WORD)).size).toBe(3);
  });
  it('magnitude word (涨幅/降幅/幅度) is NEVER the same as action word (上升/下降/持平)', () => {
    for (const d of ['increase', 'decrease', 'flat'] as const) {
      expect(DIRECTION_PCT_WORD[d]).not.toBe(DIRECTION_ACTION_WORD[d]);
    }
  });
});

describe('directional-fact / Forbidden patterns property check', () => {
  const cases: ReadonlyArray<{ current: number; previous: number; metric: string }> = [
    { current: 5875, previous: 10609.95, metric: 'gmv' },
    { current: 1, previous: 100, metric: 'orders' },
    { current: 0.5, previous: 1, metric: 'cvr' },
    { current: 99, previous: 100, metric: 'orders' },
    { current: 1, previous: 1000, metric: 'gmv' },
  ];
  for (const c of cases) {
    it(`decrease case (${c.metric}: ${c.previous} -> ${c.current})`, () => {
      const f = computeDirectionalFact({ ...baseArgs, current: c.current, previous: c.previous })!;
      expect(f.direction).toBe('decrease');
      const prose = formatDirectionalFact(f, { metric: c.metric });
      expect(prose).not.toMatch(/(下降|上升|上涨|下跌|增长|回落|减少|涨幅|降幅)\s*[+-]\d/);
      expect(prose).toMatch(/降幅\s+\d+\.\d+%/);
    });
  }
});
