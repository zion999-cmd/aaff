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

// ─── P0013.4 Question-Driven Investigation & Evidence Sufficiency ────────
//
// Two directions matter equally here, and they are easy to get wrong in
// opposite ways:
//   - a turn that emits NO requirements must stay VALID ("no material
//     business question today" is a legal answer — the contract must never
//     become an "at least one per day" rule);
//   - a turn that DOES emit requirements must not be allowed to
//     free-float them (no traceability, no decision relevance) or to claim
//     satisfaction the held evidence cannot carry.
describe('P0013.4 question-driven obligations', () => {
  it('accepts a turn with no business questions and no requirements (允许"不调查")', () => {
    // Arrange — the honest "nothing here warrants an investigation" day.
    const inv = base({
      stopReason: 'observe',
      judgment: '今日五维结构均无变化，属正常波动，无需调查',
      business_questions: [],
      evidence_requirements: [],
    });

    // Act / Assert
    expect(validateAnalysisObligations(inv)).toEqual([]);
  });

  it('accepts a requirement that traces to a stated question and declares its decision relevance', () => {
    // Arrange
    const inv = base({
      business_questions: [
        {
          question: '09-03 礼盒大单是否可复制？',
          bears_on: '增长可复制性',
          decision_relevance: '决定是否加大礼盒投放',
        },
      ],
      evidence_requirements: [
        {
          question: '09-03 礼盒大单是否可复制？',
          subject: 'UV',
          required_semantics: '09-03 单日店铺访客数',
          business_time: '2026-09-03',
          temporal_grain: 'daily',
          scope: '全店',
          provenance_expectation: '系统采集',
          decision_relevance: '决定是否加大投放',
          status: 'unresolvable',
        },
      ],
    });

    // Act / Assert
    expect(validateAnalysisObligations(inv)).toEqual([]);
  });

  it('rejects a requirement with no decision relevance (the "may help" gate)', () => {
    // Arrange
    const inv = base({
      business_questions: [{ question: 'q', bears_on: '', decision_relevance: '' }],
      evidence_requirements: [
        {
          question: 'q',
          subject: 'UV',
          required_semantics: '',
          business_time: '',
          temporal_grain: 'any',
          scope: '',
          provenance_expectation: '',
          decision_relevance: '   ',
          status: 'unsatisfied',
        },
      ],
    });

    // Act
    const errors = validateAnalysisObligations(inv);

    // Assert
    expect(errors.join('\n')).toMatch(/decision_relevance/);
  });

  it('accepts a requirement whose question PARAPHRASES the stated question (real Hermes behaviour)', () => {
    // Arrange — the 2026-09-20 acceptance run: the Agent traced correctly but
    // restated the question in the requirement field, dropping the
    // parenthesised amounts. A string-containment check rejected this; a
    // semantic judgement is the operator's call (SC10), not Fabric's.
    const inv = base({
      business_questions: [
        {
          question: '09-03三笔千元级中秋礼盒大单（1596/1311/1016）是节令礼赠/活动放量，还是不可重复的少量脉冲？',
          bears_on: '是否把09-03体量写入经营基线',
          decision_relevance: '若为脉冲则维持观察',
        },
      ],
      evidence_requirements: [
        {
          question: '09-03三笔千元级中秋礼盒大单是节令礼赠/活动放量，还是不可重复脉冲？',
          subject: '订单金额结构（已持有）',
          required_semantics: '头部大单金额、SKU、件数及占GMV比重',
          business_time: '2026-09-03',
          temporal_grain: 'daily',
          scope: '全店订单',
          provenance_expectation: '冻结订单明细',
          decision_relevance: '已足以支持结构判断，但不足以判定可重复性',
          status: 'unresolvable',
        },
      ],
    });

    // Act / Assert
    expect(validateAnalysisObligations(inv)).toEqual([]);
  });

  it('rejects requirements that come from nothing at all (the missing-field list)', () => {
    // Arrange — no Business Question, no Hypothesis, no prior cognition: the
    // requirement has no possible source.
    const inv = base({
      business_questions: [],
      hypotheses: [],
      prior_cognition: [],
      evidence_requirements: [
        {
          question: '补充 UV/CVR 数据',
          subject: 'UV',
          required_semantics: '',
          business_time: '',
          temporal_grain: 'any',
          scope: '',
          provenance_expectation: '',
          decision_relevance: '使分析更完整',
          status: 'unresolvable',
        },
      ],
    });

    // Act
    const errors = validateAnalysisObligations(inv);

    // Assert
    expect(errors.join('\n')).toMatch(/no business_questions\[\], no hypotheses\[\] and no prior_cognition/);
  });

  it('accepts a genuinely open requirement with no resolution record (no bookkeeping demand)', () => {
    // Arrange — the 2026-09-20 acceptance run failed here for real: Hermes
    // raised a forward-looking requirement ("后续日订单结构中的礼盒大单…"),
    // evidence that does not exist yet at T, and an earlier rule failed the
    // whole turn for not filing a resolution row. An open item is not an
    // epistemic error.
    const inv = base({
      business_questions: [{ question: 'q', bears_on: '', decision_relevance: 'x' }],
      evidence_requirements: [
        {
          question: 'q',
          subject: '后续日礼盒大单复现',
          required_semantics: '',
          business_time: '',
          temporal_grain: 'any',
          scope: '',
          provenance_expectation: '',
          decision_relevance: 'x',
          status: 'unsatisfied',
        },
      ],
      evidence_resolutions: [],
    });

    // Act / Assert — no inventory supplied, so nothing to refute either claim.
    expect(validateAnalysisObligations(inv)).toEqual([]);
  });

  it('rejects an unsatisfied requirement the held evidence ALREADY carries (under-claim)', () => {
    // Arrange — P0013.2's discipline in the other direction: a gap declared
    // for something the run holds is the "Context Missing ≠ Evidence Missing"
    // error, and the correct route is the existing Evidence Resolution.
    const inv = base({
      business_questions: [{ question: 'q', bears_on: '', decision_relevance: 'x' }],
      evidence_requirements: [
        {
          question: 'q',
          subject: 'UV',
          required_semantics: '',
          business_time: '2026-09-03',
          temporal_grain: 'daily',
          scope: '',
          provenance_expectation: '',
          decision_relevance: 'x',
          status: 'unsatisfied',
        },
      ],
      evidence_resolutions: [],
    });
    const availableEvidence = [
      {
        capability: 'traffic.overview',
        dataType: 'getSummary',
        grain: 'daily' as const,
        subjectAliases: ['uv', '访客数'],
        visibleRows: 3,
        visibleFrom: '2026-09-02',
        visibleTo: '2026-09-04',
      },
    ];

    // Act
    const errors = validateAnalysisObligations(inv, { availableEvidence });

    // Assert
    expect(errors.join('\n')).toMatch(/left unsatisfied but the held evidence already carries them/);
  });

  it('SC3: rejects a claimed "satisfied" that the held evidence cannot carry', () => {
    // Arrange — the real frozen-dataset situation. The Agent sees UV exists,
    // claims the 09-03 daily requirement is satisfied; the evidence is a
    // 12-day aggregate stamped 09-13.
    const inv = base({
      business_questions: [{ question: 'q', bears_on: '', decision_relevance: 'x' }],
      evidence_requirements: [
        {
          question: 'q',
          subject: 'UV',
          required_semantics: '09-03 单日访客数',
          business_time: '2026-09-03',
          temporal_grain: 'daily',
          scope: '全店',
          provenance_expectation: '',
          decision_relevance: 'x',
          status: 'satisfied',
        },
      ],
    });
    const availableEvidence = [
      {
        capability: 'trade.overview',
        dataType: 'getSummary',
        grain: 'window_aggregate' as const,
        subjectAliases: ['uv', '访客数'],
        visibleRows: 1,
        visibleFrom: '2026-09-13',
        visibleTo: '2026-09-13',
      },
    ];

    // Act
    const errors = validateAnalysisObligations(inv, { availableEvidence });

    // Assert
    expect(errors.join('\n')).toMatch(/field exists ≠ requirement satisfied/);
  });

  it('leaves the sufficiency check off when no inventory is supplied (Production)', () => {
    // Arrange — same over-claim, no inventory to adjudicate it against.
    const inv = base({
      business_questions: [{ question: 'q', bears_on: '', decision_relevance: 'x' }],
      evidence_requirements: [
        {
          question: 'q',
          subject: 'UV',
          required_semantics: '',
          business_time: '2026-09-03',
          temporal_grain: 'daily',
          scope: '',
          provenance_expectation: '',
          decision_relevance: 'x',
          status: 'satisfied',
        },
      ],
    });

    // Act / Assert — fail-closed where Fabric can prove the semantics,
    // silent where it holds no inventory. Not the other way round.
    expect(validateAnalysisObligations(inv)).toEqual([]);
  });
});

describe('parseInvestigation carries the P0013.4 sufficiency context', () => {
  it('rejects a fabricated satisfied claim at the parser boundary when given an inventory', () => {
    // Arrange
    const reply = JSON.stringify(
      base({
        business_questions: [{ question: 'q', bears_on: '', decision_relevance: 'x' }],
        evidence_requirements: [
          {
            question: 'q',
            subject: 'CVR',
            required_semantics: '',
            business_time: '2026-09-03',
            temporal_grain: 'daily',
            scope: '',
            provenance_expectation: '',
            decision_relevance: 'x',
            status: 'satisfied',
          },
        ],
      }),
    );

    // Act
    const r = parseInvestigation(reply, 'sit_x', {
      availableEvidence: [
        {
          capability: 'trade.overview',
          dataType: 'getSummary',
          grain: 'window_aggregate',
          subjectAliases: ['cvr', '转化率'],
          visibleRows: 1,
          visibleFrom: '2026-09-13',
          visibleTo: '2026-09-13',
        },
      ],
    });

    // Assert
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/field exists ≠ requirement satisfied/);
  });
});
