// Unit tests for the shared Relative Performance contract.

import { describe, it, expect } from 'vitest';
import {
  computeRelativePerformance,
  formatRelativePerformance,
  formatRelativePerformanceShort,
  RELATIVE_PERFORMANCE_WORD,
  DEFAULT_RELATIVE_FLAT_EPS_PP,
} from '#shared/utils/relative-performance.js';
import { computeDirectionalFact } from '#shared/utils/directional-fact.js';

const baseArgs = {
  comparison_base: '昨日同时段',
  observation_window: '今日 10:00 时段',
  baseline_source: 'yesterday_same_moment' as const,
};

const buildFact = (
  current: number,
  previous: number,
): ReturnType<typeof computeDirectionalFact> =>
  computeDirectionalFact({
    ...baseArgs,
    current,
    previous,
  });

describe('relative-performance / computeRelativePerformance', () => {
  it('Case 3 canonical: shop -44.6% / market +8.9% → underperform by 53.5pp', () => {
    const shop = buildFact(5875, 10609.95)!; // -44.6%
    const market = buildFact(20330, 18665)!; // +8.9%
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    });
    expect(rel).not.toBeNull();
    expect(rel!.relative_performance).toBe('underperform');
    expect(rel!.relative_gap_pp).toBeCloseTo(-53.5, 1);
    expect(rel!.magnitude_pp).toBeCloseTo(53.5, 1);
  });

  it('shop up +80.6% / market down -5.0% → outperform by 85.6pp', () => {
    const shop = buildFact(10609.95, 5875)!; // +80.6%
    const market = buildFact(0.95, 1.0)!; // -5.0%
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    });
    expect(rel).not.toBeNull();
    expect(rel!.relative_performance).toBe('outperform');
    // 80.6 - (-5.0) = 85.6
    expect(rel!.relative_gap_pp).toBeCloseTo(85.6, 1);
  });

  it('shop and market move same direction with same pct → equal', () => {
    const shop = buildFact(80, 100)!; // -20%
    const market = buildFact(80, 100)!; // -20%
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    });
    expect(rel).not.toBeNull();
    expect(rel!.relative_performance).toBe('equal');
    expect(rel!.magnitude_pp).toBeLessThanOrEqual(DEFAULT_RELATIVE_FLAT_EPS_PP);
  });

  it('shop and market both up +20% within eps → equal', () => {
    const shop = buildFact(120, 100)!;
    const market = buildFact(120.05, 100)!; // +20.05%, gap 0.05pp
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    });
    expect(rel!.relative_performance).toBe('equal');
  });

  it('returns null when subject_fact is null', () => {
    const market = buildFact(20330, 18665)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: null as never,
      comparison_label: '大盘',
      comparison_fact: market,
    });
    expect(rel).toBeNull();
  });

  it('returns null when comparison_fact is null', () => {
    const shop = buildFact(5875, 10609.95)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: null as never,
    });
    expect(rel).toBeNull();
  });
});

describe('relative-performance / formatRelativePerformance', () => {
  it('underperform canonical: 店铺下降 44.6%，大盘上升 8.9%，店铺相对大盘跑输 53.5 个百分点', () => {
    const shop = buildFact(5875, 10609.95)!;
    const market = buildFact(20330, 18665)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    })!;
    const prose = formatRelativePerformance(rel);
    expect(prose).toMatch(/店铺下降 44\.6%/);
    expect(prose).toMatch(/大盘上升 8\.9%/);
    expect(prose).toMatch(/店铺相对大盘跑输 53\.5 个百分点/);
    // Hard forbidden: no "%" on the relative gap
    expect(prose).not.toMatch(/跑输 \d+\.\d+%/);
    // No judgment word attached
    expect(prose).not.toMatch(/异常/);
    expect(prose).not.toMatch(/故障/);
    expect(prose).not.toMatch(/恶化/);
  });

  it('outperform canonical: 店铺上升 80.6%，大盘下降 5.0%，店铺相对大盘跑赢 85.6 个百分点', () => {
    const shop = buildFact(10609.95, 5875)!;
    const market = buildFact(0.95, 1.0)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    })!;
    const prose = formatRelativePerformance(rel);
    expect(prose).toMatch(/店铺上升 80\.6%/);
    expect(prose).toMatch(/大盘下降 5\.0%/);
    expect(prose).toMatch(/店铺相对大盘跑赢 85\.6 个百分点/);
  });

  it('equal: 店铺下降 20.0%，大盘下降 20.0%，店铺相对大盘持平（差 0.0 个百分点）', () => {
    const shop = buildFact(80, 100)!;
    const market = buildFact(80, 100)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    })!;
    const prose = formatRelativePerformance(rel);
    expect(prose).toMatch(/持平/);
    expect(prose).toMatch(/差 \d+\.\d+ 个百分点/);
  });
});

describe('relative-performance / formatRelativePerformanceShort', () => {
  it('underperform: "店铺跑输大盘 53.5pp"', () => {
    const shop = buildFact(5875, 10609.95)!;
    const market = buildFact(20330, 18665)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    })!;
    expect(formatRelativePerformanceShort(rel)).toBe('店铺跑输大盘 53.5pp');
  });

  it('outperform: "店铺跑赢大盘 85.6pp"', () => {
    const shop = buildFact(10609.95, 5875)!;
    const market = buildFact(0.95, 1.0)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    })!;
    expect(formatRelativePerformanceShort(rel)).toBe('店铺跑赢大盘 85.6pp');
  });

  it('equal: "店铺与大盘持平"', () => {
    const shop = buildFact(80, 100)!;
    const market = buildFact(80, 100)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    })!;
    expect(formatRelativePerformanceShort(rel)).toBe('店铺与大盘持平');
  });
});

describe('relative-performance / dictionary invariants', () => {
  it('RELATIVE_PERFORMANCE_WORD has 3 distinct values', () => {
    expect(RELATIVE_PERFORMANCE_WORD.outperform).toBe('跑赢');
    expect(RELATIVE_PERFORMANCE_WORD.underperform).toBe('跑输');
    expect(RELATIVE_PERFORMANCE_WORD.equal).toBe('持平');
    expect(new Set(Object.values(RELATIVE_PERFORMANCE_WORD)).size).toBe(3);
  });
});

describe('relative-performance / Forbidden patterns — no Judgment, no mixed units', () => {
  it('never "跑输 X%" (must use "个百分点")', () => {
    const shop = buildFact(5875, 10609.95)!;
    const market = buildFact(20330, 18665)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    })!;
    const prose = formatRelativePerformance(rel);
    expect(prose).not.toMatch(/跑输\s+\d+\.\d+%/);
    expect(prose).toMatch(/跑输\s+\d+\.\d+\s*个百分点/);
  });

  it('never attaches Judgment words (异常/恶化/健康/客户画像改变/活动导致/故障)', () => {
    const shop = buildFact(5875, 10609.95)!;
    const market = buildFact(20330, 18665)!;
    const rel = computeRelativePerformance({
      subject_label: '店铺',
      subject_fact: shop,
      comparison_label: '大盘',
      comparison_fact: market,
    })!;
    const prose = formatRelativePerformance(rel);
    for (const j of ['异常', '恶化', '健康', '客户画像改变', '活动导致', '故障']) {
      expect(prose).not.toContain(j);
    }
  });
});
