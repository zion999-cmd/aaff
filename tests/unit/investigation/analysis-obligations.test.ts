// P0013.2 — shared Analysis Contract obligations (fail-closed).
//
// These tests pin the audit fix: curve-only narration cannot end as
// `observe` while business-structure dimensions are unexamined/gapped;
// missing structural evidence must become an Evidence Gap + acquisition
// need; sufficient evidence demands a business judgment.

import { describe, it, expect } from 'vitest';
import { validateAnalysisObligations } from '#app/runtime/investigation/analysis-obligations.js';
import { parseInvestigation } from '#app/runtime/investigation/index.js';
import type { Investigation } from '#shared/schemas/investigation.js';

const dims = (statuses: Record<string, 'covered' | 'gap' | 'not_applicable'>) =>
  (['product', 'orders', 'traffic', 'conversion', 'operations'] as const).map((dimension) => {
    const status = statuses[dimension] ?? 'covered';
    return {
      dimension,
      status,
      note: `note ${dimension}`,
      acquisition_need: status === 'gap' ? `need ${dimension}` : '',
      evidence_refs: status === 'covered' ? ['ev1'] : [],
    };
  });

const base = (over: Partial<Investigation> = {}): Investigation =>
  ({
    situationId: 'sit_x',
    currentUnderstanding: '今日经营结构正常',
    knownEvidence: ['GMV 稳定'],
    observed_facts: ['fact1'],
    supporting_evidence_refs: ['ev1'],
    evidence_gaps: [],
    requiredEvidence: [],
    investigationRequest: '',
    hypotheses: [{ statement: 'h', status: 'proposed' }],
    unknowns: [],
    nextQuestion: '',
    findings: [],
    judgment: '商品/订单/流量/转化/运营五维无结构异常',
    stopReason: 'judgment',
    business_structure_coverage: dims({}),
    ...over,
  } as unknown as Investigation);

describe('validateAnalysisObligations', () => {
  it('accepts a judgment with five covered dimensions and refs', () => {
    expect(validateAnalysisObligations(base())).toEqual([]);
  });

  it('rejects observe while a dimension is gapped', () => {
    const inv = base({
      stopReason: 'observe',
      evidence_gaps: ['traffic source split missing'],
      business_structure_coverage: dims({ traffic: 'gap' }),
    });
    const errors = validateAnalysisObligations(inv);
    expect(errors.join('\n')).toMatch(/observe is illegal while structural gaps remain/);
  });

  it('accepts missing_capability only with gaps + required evidence + acquisition request + UNAVAILABLE resolution', () => {
    const inv = base({
      stopReason: 'missing_capability',
      judgment: '',
      evidence_gaps: ['traffic source split missing'],
      requiredEvidence: ['分来源 UV'],
      investigationRequest: '需要 traffic.overview capability 提供分来源流量',
      business_structure_coverage: dims({ traffic: 'gap' }),
      evidence_resolutions: [
        {
          need: 'traffic source split',
          dimension: 'traffic',
          result: 'UNAVAILABLE',
          source: '',
          query: '',
          retrieved_refs: [],
          note: 'no traffic capability / evidence exists in this frozen dataset',
        },
      ],
    } as Partial<Investigation>);
    expect(validateAnalysisObligations(inv)).toEqual([]);
  });

  it('rejects missing_capability without a concrete acquisition need', () => {
    const inv = base({
      stopReason: 'missing_capability',
      judgment: '',
      business_structure_coverage: dims({ traffic: 'gap' }),
    });
    expect(validateAnalysisObligations(inv).join('\n')).toMatch(/acquisition need/);
  });

  it('requires all five dimensions', () => {
    const inv = base({ business_structure_coverage: dims({}).slice(0, 3) });
    expect(validateAnalysisObligations(inv).join('\n')).toMatch(/missing dimensions: conversion, operations/);
  });

  it('requires observed facts and supporting refs', () => {
    const inv = base({
      observed_facts: [],
      knownEvidence: [],
      supporting_evidence_refs: [],
      findings: [],
      claim_evidence_refs: [],
      epistemic_layers: undefined,
    });
    const errors = validateAnalysisObligations(inv);
    expect(errors.join('\n')).toMatch(/observed_facts obligation/);
    expect(errors.join('\n')).toMatch(/supporting_evidence_refs obligation/);
  });

  it('accepts observe only when all dimensions examined and judgment explains normality', () => {
    const inv = base({
      stopReason: 'observe',
      judgment: 'UV=31 小样本，五维结构检查后为统计噪声，无结构变化，不干预',
    });
    expect(validateAnalysisObligations(inv)).toEqual([]);
  });

  it('coverage gaps require matching evidence_gaps entries', () => {
    const inv = base({
      stopReason: 'missing_capability',
      judgment: '',
      requiredEvidence: ['x'],
      investigationRequest: 'acquire x',
      evidence_gaps: [],
      business_structure_coverage: dims({ product: 'gap' }),
    });
    expect(validateAnalysisObligations(inv).join('\n')).toMatch(/matching evidence_gaps/);
  });

  // ── P0013.2 Evidence Resolution ──
  const unavailableResolution = (dimension: string) => ({
    need: `${dimension} need`,
    dimension,
    result: 'UNAVAILABLE' as const,
    source: '',
    query: '',
    retrieved_refs: [],
    note: `retrieval attempted; held evidence lacks ${dimension}`,
  });

  it('rejects a coverage gap without an UNAVAILABLE resolution (Context Missing ≠ Evidence Missing)', () => {
    const inv = base({
      stopReason: 'missing_capability',
      judgment: '',
      evidence_gaps: ['x'],
      requiredEvidence: ['x'],
      investigationRequest: 'acquire x',
      business_structure_coverage: dims({ traffic: 'gap' }),
      // no evidence_resolutions
    });
    expect(validateAnalysisObligations(inv).join('\n')).toMatch(/UNAVAILABLE evidence resolution/);
  });

  it('accepts an orders gap that was honestly resolved UNAVAILABLE after retrieval attempt', () => {
    const inv = base({
      stopReason: 'missing_capability',
      judgment: '',
      evidence_gaps: ['buyer identity for top order', 'refund status'],
      requiredEvidence: ['buyer identity', 'refund/cancel records'],
      investigationRequest: '源数据无买家身份/退款字段，需新数据采集',
      business_structure_coverage: dims({ orders: 'gap' }),
      evidence_resolutions: [unavailableResolution('orders')],
    } as Partial<Investigation>);
    expect(validateAnalysisObligations(inv)).toEqual([]);
  });

  it('RETRIEVED resolution requires non-empty retrieved_refs', () => {
    const inv = base({
      evidence_resolutions: [
        { need: 'price bands', dimension: 'orders', result: 'RETRIEVED', source: 'order_replay_retrieval', query: 'parentOrdersByDay', retrieved_refs: [], note: '' },
      ],
    } as Partial<Investigation>);
    expect(validateAnalysisObligations(inv).join('\n')).toMatch(/RETRIEVED.*retrieved_refs/);
  });

  it('accepts RETRIEVED orders evidence with refs and no gap', () => {
    const inv = base({
      business_structure_coverage: dims({}),
      evidence_resolutions: [
        {
          need: 'ex-top1 AOV',
          dimension: 'orders',
          result: 'RETRIEVED',
          source: 'order_replay_retrieval',
          query: 'topContributingOrders',
          retrieved_refs: ['order:3610454011181448'],
          note: '',
        },
      ],
    } as Partial<Investigation>);
    expect(validateAnalysisObligations(inv)).toEqual([]);
  });

  it('UNAVAILABLE resolution requires an explanatory note', () => {
    const inv = base({
      stopReason: 'missing_capability',
      judgment: '',
      evidence_gaps: ['x'],
      requiredEvidence: ['x'],
      investigationRequest: 'acquire x',
      business_structure_coverage: dims({ traffic: 'gap' }),
      evidence_resolutions: [{ ...unavailableResolution('traffic'), note: '' }],
    } as Partial<Investigation>);
    expect(validateAnalysisObligations(inv).join('\n')).toMatch(/UNAVAILABLE.*note/);
  });
});

describe('parseInvestigation enforces obligations on both parse paths', () => {
  const validJson = JSON.stringify(base());

  it('parses a compliant contract', () => {
    const r = parseInvestigation(validJson, 'sit_x');
    expect(r.ok).toBe(true);
  });

  it('rejects a curve-only observe reply at the parser boundary', () => {
    const curve = JSON.stringify({
      situationId: 'sit_x',
      currentUnderstanding: '行业回升，延续上行，等待确认',
      knownEvidence: ['GMV 回升'],
      observed_facts: ['f'],
      supporting_evidence_refs: ['ev'],
      hypotheses: [],
      unknowns: [],
      nextQuestion: '',
      requiredEvidence: [],
      investigationRequest: '',
      findings: [],
      judgment: '延续上行趋势，继续观察',
      stopReason: 'observe',
      business_structure_coverage: [],
      evidence_gaps: [],
    });
    const r = parseInvestigation(curve, 'sit_x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Analysis Target obligations/);
  });
});
