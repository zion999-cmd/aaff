// P0013.4 — Evidence Sufficiency predicate (shared Investigation layer).
//
// The proposal's Success Criterion 3 is the load-bearing case, and it is a
// REAL property of the frozen P0013 dataset: the acquisition requested
// `startDate=2026-09-02 & endDate=2026-09-13`, so the trade-summary row's UV
// (45124) and CVR (0.0936) are aggregates over that whole range, stamped at
// the range END. The fields genuinely exist and are genuinely true, and they
// still cannot answer "what was 09-03's UV?".
//
// Before P0013.4 nothing in Fabric could state that: a 12-day aggregate and a
// per-day reading look identical at the (capability, data_type,
// business_date) level. These tests pin the predicate that can.

import { describe, it, expect } from 'vitest';
import {
  evaluateRequirementSufficiency,
  parseBusinessTime,
  toAvailableEvidence,
  type AvailableEvidence,
} from '#app/runtime/investigation/evidence-sufficiency.js';
import {
  findEvidenceKindDeclaration,
  resolveEvidenceGrain,
} from '#app/runtime/investigation/evidence-grain.js';
import {
  EvidenceRequirementSchema,
  type EvidenceRequirement,
} from '#shared/schemas/investigation.js';

/** The requirement shape with schema defaults filled in. */
const req = (over: Partial<EvidenceRequirement>): EvidenceRequirement => ({
  question: '09-03 的礼盒大单是否可复制？',
  subject: 'UV',
  required_semantics: '',
  business_time: '',
  temporal_grain: 'any',
  scope: '',
  provenance_expectation: '',
  decision_relevance: '判断该增长是否可复制',
  status: 'unsatisfied',
  ...over,
});

const getSummary: AvailableEvidence = {
  capability: 'trade.overview',
  dataType: 'getSummary',
  grain: 'window_aggregate',
  subjectAliases: ['uv', '访客数', 'cvr', '转化率', 'aov', '客单价'],
  visibleRows: 1,
  visibleFrom: '2026-09-13',
  visibleTo: '2026-09-13',
};

const getTrend: AvailableEvidence = {
  capability: 'trade.overview',
  dataType: 'getTrend',
  grain: 'daily',
  subjectAliases: ['gmv', '成交金额', 'industry_gmv', '行业成交金额'],
  visibleRows: 11,
  visibleFrom: '2026-09-02',
  visibleTo: '2026-09-12',
};

describe('P0013.4 Evidence Sufficiency — grain is decisive', () => {
  it('SC3: a 12-day window aggregate cannot satisfy a single-day daily requirement, even though the field exists', () => {
    // Arrange — the real frozen-dataset situation: UV exists, at window grain.
    const requirement = req({ subject: 'UV', business_time: '2026-09-03', temporal_grain: 'daily' });

    // Act
    const verdict = evaluateRequirementSufficiency(requirement, [getSummary]);

    // Assert
    expect(verdict.sufficient).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/window aggregate covers a business-time RANGE/);
  });

  it('satisfies the same requirement when genuinely daily UV evidence is visible', () => {
    // Arrange
    const dailyUv: AvailableEvidence = {
      capability: 'traffic.overview',
      dataType: 'getSummary',
      grain: 'daily',
      subjectAliases: ['uv', '访客数'],
      visibleRows: 12,
      visibleFrom: '2026-09-02',
      visibleTo: '2026-09-13',
    };

    // Act
    const verdict = evaluateRequirementSufficiency(
      req({ subject: 'UV', business_time: '2026-09-03', temporal_grain: 'daily' }),
      [dailyUv],
    );

    // Assert
    expect(verdict).toMatchObject({ sufficient: true, reasons: [] });
  });

  it('a window aggregate still satisfies a requirement whose range ends at the same date', () => {
    // Arrange — the aggregate IS the right answer to a range question.
    const requirement = req({
      subject: 'UV',
      business_time: '2026-09-02..2026-09-13',
      temporal_grain: 'window_aggregate',
    });

    // Act
    const verdict = evaluateRequirementSufficiency(requirement, [getSummary]);

    // Assert
    expect(verdict.sufficient).toBe(true);
  });

  it('a window stamped at 09-13 cannot answer a DIFFERENT range ending 09-12', () => {
    // Arrange
    const requirement = req({
      subject: 'UV',
      business_time: '2026-09-02..2026-09-12',
      temporal_grain: 'window_aggregate',
    });

    // Act
    const verdict = evaluateRequirementSufficiency(requirement, [getSummary]);

    // Assert
    expect(verdict.sufficient).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/grain\/business-time mismatch/);
  });
});

describe('P0013.4 Evidence Sufficiency — subject, visibility, fail-closed', () => {
  it('daily GMV evidence does not satisfy a UV requirement (field exists ≠ requirement satisfied)', () => {
    // Arrange — getTrend is daily but carries no traffic series.
    const requirement = req({ subject: 'UV', business_time: '2026-09-03', temporal_grain: 'daily' });

    // Act
    const verdict = evaluateRequirementSufficiency(requirement, [getTrend]);

    // Assert — UV is a subject Fabric declares elsewhere, so the honest
    // reason is "not held by THIS run", not "not a real subject".
    expect(verdict.sufficient).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/this run holds no rows of it/);
  });

  it('a subject no Fabric kind declares is reported as such, not as a retrieval miss', () => {
    // Act
    const verdict = evaluateRequirementSufficiency(
      req({ subject: '买家是否为企业采购', business_time: '2026-09-03', temporal_grain: 'daily' }),
      [getSummary, getTrend],
    );

    // Assert
    expect(verdict.sufficient).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/not carried by any declared Fabric evidence kind/);
  });

  it('a subject held but with 0 rows visible at T is not sufficient', () => {
    // Arrange — the run holds it, the clock has not reached it.
    const heldNotVisible: AvailableEvidence = { ...getSummary, visibleRows: 0, visibleFrom: null, visibleTo: null };

    // Act
    const verdict = evaluateRequirementSufficiency(req({ subject: 'UV' }), [heldNotVisible]);

    // Assert
    expect(verdict.sufficient).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/0 rows visible at the clock date/);
  });

  it('an undeclared grain fails closed against a dated requirement', () => {
    // Arrange — a kind nobody declared is never assumed daily.
    const undeclared: AvailableEvidence = { ...getTrend, grain: 'unknown' };
    const requirement = req({ subject: 'GMV', business_time: '2026-09-05', temporal_grain: 'daily' });

    // Act
    const verdict = evaluateRequirementSufficiency(requirement, [undeclared]);

    // Assert
    expect(verdict.sufficient).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/undeclared, so it fails closed/);
  });

  it('a requirement with no business_time is satisfied by visible same-subject evidence', () => {
    // Act
    const verdict = evaluateRequirementSufficiency(req({ subject: 'GMV' }), [getTrend]);

    // Assert
    expect(verdict.sufficient).toBe(true);
  });
});

describe('P0013.4 regression — composite subjects emitted by real Hermes', () => {
  it('matches the composite subject a real Replay turn actually emitted', () => {
    // The 2026-09-20 acceptance run 315aef52 failed here for real: Hermes
    // asked for the per-order evidence it genuinely holds, under the
    // composite subject "订单金额分布/Top 单/SKU 贡献", and a GROUPED alias
    // list ("订单金额 order_amount") failed containment — rejecting a
    // correct claim. Aliases are individual tokens for exactly this reason.
    const perOrder: AvailableEvidence = {
      capability: 'order.overview',
      dataType: 'perOrder',
      grain: 'daily',
      subjectAliases: findEvidenceKindDeclaration('order.overview', 'perOrder')!.subjectAliases,
      visibleRows: 2,
      visibleFrom: '2026-09-02',
      visibleTo: '2026-09-03',
    };

    // Act
    const verdict = evaluateRequirementSufficiency(
      req({
        subject: '订单金额分布/Top 单/SKU 贡献',
        business_time: '2026-09-03',
        temporal_grain: 'daily',
      }),
      [perOrder],
    );

    // Assert
    expect(verdict).toMatchObject({ sufficient: true, reasons: [] });
  });

  it('still refuses the same subject at a day the run cannot see', () => {
    // Arrange — the same held evidence, a future business day.
    const perOrder: AvailableEvidence = {
      capability: 'order.overview',
      dataType: 'perOrder',
      grain: 'daily',
      subjectAliases: ['订单金额', 'sku', 'top单'],
      visibleRows: 2,
      visibleFrom: '2026-09-02',
      visibleTo: '2026-09-03',
    };

    // Act
    const verdict = evaluateRequirementSufficiency(
      req({ subject: '订单金额分布/Top 单', business_time: '2026-09-08', temporal_grain: 'daily' }),
      [perOrder],
    );

    // Assert
    expect(verdict.sufficient).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/grain\/business-time mismatch/);
  });
});

describe('P0013.4 parseBusinessTime', () => {
  it('parses the three legal forms and normalizes reversed ranges', () => {
    expect(parseBusinessTime('')).toEqual({ kind: 'unspecified' });
    expect(parseBusinessTime('2026-09-03')).toEqual({ kind: 'day', date: '2026-09-03' });
    expect(parseBusinessTime('2026-09-02..2026-09-13')).toEqual({
      kind: 'range',
      from: '2026-09-02',
      to: '2026-09-13',
    });
    expect(parseBusinessTime('2026-09-13..2026-09-02')).toEqual({
      kind: 'range',
      from: '2026-09-02',
      to: '2026-09-13',
    });
  });

  it('treats an unparseable business_time as an unverifiable dated requirement, not as no constraint', () => {
    // Act — a free-text "上个月" must not silently become "any time".
    const parsed = parseBusinessTime('上个月');

    // Assert
    expect(parsed.kind).toBe('day');
  });
});

describe('P0013.4 toAvailableEvidence', () => {
  it('maps the run inventory through the declared grain and derives the visible slice', () => {
    // Arrange — the real frozen dataset's kinds.
    const held = [
      { capability: 'trade.overview', data_type: 'getSummary', rows: 1, firstDate: '2026-09-13', lastDate: '2026-09-13', visibleAtT: 1 },
      { capability: 'trade.overview', data_type: 'getTrend', rows: 12, firstDate: '2026-09-02', lastDate: '2026-09-13', visibleAtT: 11 },
      { capability: 'unknown.cap', data_type: 'mystery', rows: 3, firstDate: '2026-09-02', lastDate: '2026-09-04', visibleAtT: 3 },
    ];

    // Act
    const available = toAvailableEvidence(held, '2026-09-12');

    // Assert
    expect(available.find((a) => a.dataType === 'getSummary')?.grain).toBe('window_aggregate');
    expect(available.find((a) => a.dataType === 'getTrend')).toMatchObject({
      grain: 'daily',
      visibleTo: '2026-09-12', // clamped to the clock, never beyond
      visibleRows: 11,
    });
    expect(available.find((a) => a.dataType === 'mystery')?.grain).toBe('unknown');
  });

  it('declares the real frozen kinds, and leaves an unidentified kind unknown', () => {
    // Assert — the declarations came from the acquisition payload, not a guess.
    expect(resolveEvidenceGrain('trade.overview', 'getSummary')).toBe('window_aggregate');
    expect(resolveEvidenceGrain('trade.overview', 'getTrend')).toBe('daily');
    expect(resolveEvidenceGrain('order.overview', 'perDaySummary')).toBe('daily');
    expect(resolveEvidenceGrain('order.overview', 'perOrder')).toBe('daily');
    expect(resolveEvidenceGrain('trade.overview', 'somethingNew')).toBe('unknown');
  });
});

describe('P0013.4 EvidenceRequirement schema boundary', () => {
  it('coerces an explicit null on optional fields to the empty default', () => {
    // Arrange — models in this codebase are documented to emit explicit null
    // for fields they do not need; that is a representation detail, not a
    // reason to fail the whole cognition turn.
    const raw = {
      question: 'q',
      subject: 'UV',
      required_semantics: null,
      business_time: null,
      temporal_grain: null,
      scope: null,
      provenance_expectation: null,
      decision_relevance: 'x',
      status: null,
    };

    // Act
    const parsed = EvidenceRequirementSchema.parse(raw);

    // Assert
    expect(parsed).toMatchObject({
      required_semantics: '',
      business_time: '',
      temporal_grain: 'any',
      scope: '',
      provenance_expectation: '',
      status: 'unsatisfied',
    });
  });

  it('still rejects a requirement with no question or no decision relevance', () => {
    // Assert — the two obligations are NOT null-tolerant.
    expect(EvidenceRequirementSchema.safeParse({ subject: 'UV', decision_relevance: 'x' }).success).toBe(false);
    expect(EvidenceRequirementSchema.safeParse({ question: 'q', subject: 'UV' }).success).toBe(false);
  });
});
