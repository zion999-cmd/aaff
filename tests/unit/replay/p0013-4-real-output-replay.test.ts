// P0013.4 — does the FIXED validator accept the real Hermes output?
//
// The 2026-09-20 acceptance runs produced genuine Hermes cognition that the
// first version of two obligations rejected for the wrong reasons:
//   run 5a9e1157 day 09-03 → obligation 6e demanded a resolution row for a
//     legitimately open forward-looking requirement;
//   run da2fc53a day 09-03 → obligation 6c demanded character-for-character
//     containment between the requirement's question and the stated question.
//
// This file replays that ACTUAL output (extracted verbatim from
// ~/.hermes/state.db, session 20260920_165118_e4e013) through the fixed
// parser with the run's real T=09-03 inventory, so the fix is pinned against
// real cognition rather than a hand-written fixture.
//
// What this does NOT do: it does not re-run Hermes, and it is not business
// acceptance. It only answers "would the corrected contract still have
// rejected this real turn?".

import { describe, it, expect } from 'vitest';
import { parseInvestigation } from '#app/runtime/investigation/index.js';
import {
  EVIDENCE_KIND_DECLARATIONS,
} from '#app/runtime/investigation/evidence-grain.js';
import { toAvailableEvidence } from '#app/runtime/investigation/evidence-sufficiency.js';

/** The frozen dataset's holdings as of T = 2026-09-03. */
const HELD_AT_0903 = [
  { capability: 'trade.overview', data_type: 'getSummary', rows: 1, firstDate: '2026-09-13', lastDate: '2026-09-13', visibleAtT: 0 },
  { capability: 'trade.overview', data_type: 'getTrend', rows: 12, firstDate: '2026-09-02', lastDate: '2026-09-13', visibleAtT: 2 },
  { capability: 'order.overview', data_type: 'perDaySummary', rows: 12, firstDate: '2026-09-02', lastDate: '2026-09-13', visibleAtT: 2 },
  { capability: 'order.overview', data_type: 'perOrder', rows: 12, firstDate: '2026-09-02', lastDate: '2026-09-13', visibleAtT: 2 },
];

/** The cognition fields from the real turn, verbatim. */
const REAL_TURN_0903 = {
  situationId: 'ignored-by-parser',
  currentUnderstanding:
    '09-03 全店 GMV 与客单价抬升主要由少量千元级中秋礼盒大单驱动，低价带订单数结构未变；该抬升能否写入经营基线仍不确定。',
  knownEvidence: ['09-03 三笔千元级礼盒大单'],
  observed_facts: ['09-03 GMV 9792.04，较 09-02 抬升'],
  supporting_evidence_refs: ['ev_perorder_0903'],
  hypotheses: [
    { statement: '低价/品鉴带继续抬高订单数、正价与礼盒带贡献主要GMV的双轨结构仍在', status: 'supported' },
    { statement: '09-03相对09-02的GMV/AOV抬升，主要来自少数中秋礼盒大宗订单，而非全店客单全面升级', status: 'supported' },
    { statement: '千元级礼盒大单更可能是节令礼赠集中释放，可重复性仍不确定', status: 'proposed' },
  ],
  unknowns: ['礼盒大单是否与活动/客户类型绑定'],
  nextQuestion: '',
  requiredEvidence: [],
  investigationRequest: '',
  findings: [],
  judgment: '09-03 的体量抬升集中在少数礼盒大单，尚不足以判定可重复性。',
  stopReason: 'judgment',
  business_structure_coverage: [
    { dimension: 'product', status: 'covered', note: '礼盒与品鉴带共存', evidence_refs: ['ev1'] },
    { dimension: 'orders', status: 'covered', note: '增量集中在少数大单', evidence_refs: ['ev1'] },
    { dimension: 'traffic', status: 'gap', note: '来源拆分未知', acquisition_need: '流量来源拆分', evidence_refs: [] },
    { dimension: 'conversion', status: 'not_applicable', note: '当日转化结构未变', evidence_refs: [] },
    { dimension: 'operations', status: 'gap', note: '活动记录未知', acquisition_need: '后台活动记录', evidence_refs: [] },
  ],
  evidence_gaps: ['礼盒大单归因证据缺失', '流量来源拆分缺失'],
  evidence_resolutions: [
    { need: '礼盒大单归因（活动/券/直播/企业购）', dimension: 'operations', result: 'UNAVAILABLE', source: '', query: '', retrieved_refs: [], note: '冻结订单行无活动与客户类型字段；已尝试 order_replay_retrieval 仍无法回答。' },
    { need: '流量来源拆分', dimension: 'traffic', result: 'UNAVAILABLE', source: '', query: '', retrieved_refs: [], note: '冻结数据集未采集流量来源维度。' },
  ],
  business_questions: [
    {
      question: '09-03三笔千元级中秋礼盒大单（1596/1311/1016）是节令礼赠/活动放量，还是不可重复的少量脉冲？',
      bears_on: '是否把09-03体量写入经营基线，以及要不要对礼盒做跟进运营',
      decision_relevance: '若为可重复节令结构，应准备礼盒供给与页面；若为脉冲，则维持观察',
    },
  ],
  evidence_requirements: [
    {
      question: '09-03三笔千元级中秋礼盒大单是节令礼赠/活动放量，还是不可重复脉冲？',
      subject: '礼盒大单归因（活动/券/直播/企业购）',
      required_semantics: '需说明大单是否与明确活动或客户类型绑定，而非仅有金额',
      business_time: '2026-09-03',
      temporal_grain: 'daily',
      scope: '头部礼盒订单/礼盒SKU',
      provenance_expectation: '后台活动与订单备注/客户类型，或操作员确认',
      decision_relevance: '改变对09-03是否可作新基线、是否跟进礼盒运营的判断',
      status: 'unresolvable',
    },
    {
      question: '09-03三笔千元级中秋礼盒大单是节令礼赠/活动放量，还是不可重复脉冲？',
      subject: '订单金额结构（已持有）',
      required_semantics: '头部大单金额、SKU、件数及占GMV比重',
      business_time: '2026-09-03',
      temporal_grain: 'daily',
      scope: '全店订单',
      provenance_expectation: '冻结订单明细',
      decision_relevance: '已足以支持“增量集中在礼盒大单”的结构判断，但不足以判定可重复性',
      status: 'satisfied',
    },
  ],
};

describe('P0013.4 — the fixed validator accepts the real Hermes turn', () => {
  it('parses the real 09-03 cognition without a contract violation', () => {
    // Act
    const r = parseInvestigation(JSON.stringify(REAL_TURN_0903), 'run-2026-09-03', {
      availableEvidence: toAvailableEvidence(HELD_AT_0903, '2026-09-03'),
    });

    // Assert
    if (!r.ok) throw new Error(`rejected: ${r.error}`);
    expect(r.ok).toBe(true);
  });

  it('keeps the satisfied claim only because the held per-order evidence really carries it', () => {
    // The turn claims "订单金额结构（已持有）" is satisfied. That must be TRUE
    // against the declaration — perOrder is daily and visible at 09-03 — not
    // merely unrefuted.
    const perOrder = EVIDENCE_KIND_DECLARATIONS.find(
      (d) => d.capability === 'order.overview' && d.data_type === 'perOrder',
    );
    expect(perOrder).toBeDefined();
    expect(perOrder?.grain).toBe('daily');
    expect(perOrder?.subjectAliases).toContain('订单金额');
  });

  it('still fails closed when a satisfied claim names something the run does not hold', () => {
    // Arrange — the same turn, but with the satisfied claim re-pointed at
    // evidence the frozen order payload has no field for. (Dropping perOrder
    // would NOT make the real claim false: perDaySummary legitimately carries
    // per-day 订单金额 too, which is why the real turn is accepted.)
    const overclaiming = {
      ...REAL_TURN_0903,
      evidence_requirements: [
        {
          ...REAL_TURN_0903.evidence_requirements[1],
          subject: '买家是否为企业采购',
          status: 'satisfied',
        },
      ],
    };

    // Act
    const r = parseInvestigation(JSON.stringify(overclaiming), 'run-2026-09-03', {
      availableEvidence: toAvailableEvidence(HELD_AT_0903, '2026-09-03'),
    });

    // Assert
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/field exists ≠ requirement satisfied/);
  });
});
