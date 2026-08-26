// P0010.2.4 (ADR-060 audit C) + P0010.2.4 review repair (ADR-061) —
// Human feedback consumption contract.
//
// Pin: for every intervention kind the UI can produce
// (response / correction / context_supplement / decision), the next
// `runInvestigationTurn` call for the same situation MUST include the
// operator's text in `formatPriorHumanGuidance(...)` output. This is
// the only path by which a human correction/supplement/decision is
// observed by the next investigation Agent — if this contract breaks,
// feedback is silently dropped.
//
// We also pin the P0010.2.4-specific surface area:
//   - `section` ("judgment" | "suggestion") is rendered as a section
//     tag in the output so the next turn can tell "I disagree with your
//     reading" from "I'm not acting on your recommendation";
//   - `summaryKind` is rendered as a kind tag (helps with at-a-glance
//     review of the prompt);
//   - decision interventions in the suggestion section emit a
//     `no-execution` guard inline AND a top-of-section hard-constraint
//     line so the next-turn Agent is told up-front that operator
//     `accept` is a disposition, NOT an execution cue;
//   - `appliesTo.{recommendationId|agentActivityId|signalId}` is
//     surfaced when present. The current production workspace
//     (`apps/ecommerce/workspace/interaction-grammar.js`) does NOT
//     populate `appliesTo` because the `Recommendation` schema
//     (shared/schemas/investigation.ts:55-65) has no stable id field.
//     The two tests below exercise the formatter in BOTH shapes:
//       (a) populated appliesTo — verifies the formatter renders
//           `recommendation=<id>; agentActivity=<id>` correctly when
//           a target is supplied;
//       (b) empty appliesTo — verifies the formatter renders the
//           honest `[no-target-bound]` text when no target is
//           supplied. This is the current production case.

import { describe, it, expect } from 'vitest';
import {
  formatPriorHumanGuidance,
  buildInvestigationPrompt,
} from '#app/runtime/investigation/prompt.js';
import type { LearningContext, HumanIntervention } from '#shared/schemas/learning-context.js';

const NOW = '2026-08-27T12:00:00.000Z';
const SIT_ID = 'sit_p0010_2_4_consume';

const makeContext = (interventions: HumanIntervention[]): LearningContext => ({
  contextId: `ctx_${SIT_ID}`,
  situation: {
    situationId: SIT_ID,
    domain: 'ecommerce',
    type: 'anomaly_investigation',
    entity: { id: 'jd_shop_001', type: 'shop', name: '祁门红茶旗舰店', platform: 'jd' },
    temporal: { observedAt: NOW },
    description: 'test',
    tags: [],
    lifecycle: 'open',
  },
  observations: [],
  humanInterventions: interventions,
  createdAt: NOW,
  updatedAt: NOW,
}) as unknown as LearningContext;

describe('P0010.2.4 — formatPriorHumanGuidance empty contract', () => {
  it('returns the sentinel "no prior human guidance" when interventions[] is empty', () => {
    const out = formatPriorHumanGuidance(makeContext([]));
    expect(out).toMatch(/no prior human guidance/);
  });

  it('returns the sentinel when ctx is null', () => {
    expect(formatPriorHumanGuidance(null)).toMatch(/no prior human guidance/);
  });
});

describe('P0010.2.4 — correction text round-trips into the next-turn prompt', () => {
  it('contains the operator correction text', () => {
    const intervention: HumanIntervention = {
      interventionId: 'int_c_1',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'correction',
      content: {
        type: 'correction',
        corrects: {},
        correction: '京准通账户余额最近异常，怀疑是平台结算延迟',
        _section: 'judgment',
        _summaryKind: 'correction',
      },
      timestamp: NOW,
      summary: '这里判断错了: 京准通账户余额最近异常，怀疑是平台结算延迟',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([intervention]));
    expect(out).toContain('京准通账户余额最近异常，怀疑是平台结算延迟');
    expect(out).toContain('[判断反馈]');
    expect(out).toContain('{correction}');
  });
});

describe('P0010.2.4 — context_supplement text round-trips into the next-turn prompt', () => {
  it('contains the operator supplement text and aspect', () => {
    const intervention: HumanIntervention = {
      interventionId: 'int_cs_1',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'context_supplement',
      content: {
        type: 'context_supplement',
        supplements: { situationAspect: 'spend' },
        information: '今天下午 3 点有个品牌大促直播，预计流量 +30%',
        _section: 'judgment',
        _summaryKind: 'supplement',
      },
      timestamp: NOW,
      summary: '补充情况: 今天下午 3 点有个品牌大促直播，预计流量 +30%',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([intervention]));
    expect(out).toContain('今天下午 3 点有个品牌大促直播，预计流量 +30%');
    expect(out).toContain('[判断反馈]');
    expect(out).toMatch(/spend/);
  });
});

describe('P0010.2.4 — decision/accept on a recommendation is consumed with appliesTo + no-execution guard', () => {
  // NOTE — P0010.2.4 review repair (ADR-061):
  // The `appliesTo` values used here are SYNTHETIC TEST DATA. The
  // current production workspace cannot populate `appliesTo` because
  // the `Recommendation` schema (shared/schemas/investigation.ts:55-65)
  // has no stable id field. These tests verify the formatter's behavior
  // WHEN a target is supplied — the future case once Recommendation
  // gains an id. The "empty appliesTo" path (current production) is
  // covered in the next describe block.
  it('emits a no-execution guard line AND the appliesTo target for an accept decision', () => {
    const intervention: HumanIntervention = {
      interventionId: 'int_d_acc_1',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'decision',
      content: {
        type: 'decision',
        decision: 'accept',
        appliesTo: { recommendationId: 'SYNTHETIC_rec_abc123', agentActivityId: 'SYNTHETIC_act_xyz789' },
        rationale: '先按这个思路推进',
        _section: 'suggestion',
        _summaryKind: 'decision',
      },
      timestamp: NOW,
      summary: '已纳入考量: 先按这个思路推进',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([intervention]));
    // Section tag
    expect(out).toContain('[建议处理]');
    // Top-of-section hard constraint (P0010.2.4 invariant)
    expect(out).toMatch(/P0010\.2\.4 硬约束/);
    expect(out).toMatch(/accept.*均为操作员处置记录/);
    // Inline no-execution guard on the decision line
    expect(out).toContain('no-execution');
    // appliesTo target surfaces
    expect(out).toContain('recommendation=SYNTHETIC_rec_abc123');
    expect(out).toContain('agentActivity=SYNTHETIC_act_xyz789');
    // rationale surfaces
    expect(out).toContain('先按这个思路推进');
    // The decision value itself surfaces
    expect(out).toContain('accept');
  });

  it('emits the no-execution guard for decision/reject too', () => {
    const intervention: HumanIntervention = {
      interventionId: 'int_d_rej_1',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'decision',
      content: {
        type: 'decision',
        decision: 'reject',
        appliesTo: { recommendationId: 'SYNTHETIC_rec_abc123' },
        rationale: '成本太高',
        _section: 'suggestion',
        _summaryKind: 'decision',
      },
      timestamp: NOW,
      summary: '暂不采用: 成本太高',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([intervention]));
    expect(out).toContain('reject');
    expect(out).toContain('no-execution');
    expect(out).toMatch(/P0010\.2\.4 硬约束/);
    expect(out).toContain('recommendation=SYNTHETIC_rec_abc123');
  });

  it('emits the no-execution guard for decision/defer too', () => {
    const intervention: HumanIntervention = {
      interventionId: 'int_d_def_1',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'decision',
      content: {
        type: 'decision',
        decision: 'defer',
        appliesTo: { recommendationId: 'SYNTHETIC_rec_abc123' },
        _section: 'suggestion',
        _summaryKind: 'decision',
      },
      timestamp: NOW,
      summary: '稍后再看',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([intervention]));
    expect(out).toContain('defer');
    expect(out).toContain('no-execution');
    expect(out).toMatch(/P0010\.2\.4 硬约束/);
  });

  it('does NOT emit the no-execution guard for a decision in the judgment section', () => {
    // `decision` in the judgment section is not possible under the
    // current UI grammar (judgment-section decision was the old
    // "采用建议" branch and was removed in C1). But the consumer MUST
    // NOT add the no-execution guard for non-suggestion decisions —
    // that guard is the suggestion-specific invariant.
    const intervention: HumanIntervention = {
      interventionId: 'int_d_other_1',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'decision',
      content: {
        type: 'decision',
        decision: 'accept',
        // no _section set — fallthrough case
      },
      timestamp: NOW,
      summary: '已纳入考量',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([intervention]));
    // no hard constraint line, no inline no-execution
    expect(out).not.toMatch(/P0010\.2\.4 硬约束/);
    expect(out).not.toMatch(/no-execution/);
  });
});

describe('P0010.2.4 review repair (ADR-061) — production decision with empty appliesTo renders [no-target-bound]', () => {
  // The current production workspace leaves `appliesTo = {}` because
  // the Recommendation schema has no id. The formatter must honestly
  // mark this as "no-target-bound" instead of fabricating a target.
  it('emits [no-target-bound] text when appliesTo is empty (the production case)', () => {
    const intervention: HumanIntervention = {
      interventionId: 'int_d_empty_1',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'decision',
      content: {
        type: 'decision',
        decision: 'accept',
        appliesTo: {},
        rationale: '先按这个思路推进',
        _section: 'suggestion',
        _summaryKind: 'decision',
      },
      timestamp: NOW,
      summary: '已纳入考量: 先按这个思路推进',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([intervention]));
    // The honest marker
    expect(out).toContain('no-target-bound');
    // Does NOT fabricate any recommendation= or agentActivity=
    expect(out).not.toMatch(/recommendation=/);
    expect(out).not.toMatch(/agentActivity=/);
    // Still surfaces the decision and section guard
    expect(out).toContain('[建议处理]');
    expect(out).toContain('accept');
    expect(out).toContain('no-execution');
    expect(out).toMatch(/P0010\.2\.4 硬约束/);
  });

  it('emits [no-target-bound] for decision/reject with empty appliesTo (production case)', () => {
    const intervention: HumanIntervention = {
      interventionId: 'int_d_empty_rej',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'decision',
      content: {
        type: 'decision',
        decision: 'reject',
        appliesTo: {},
        rationale: '成本太高',
        _section: 'suggestion',
        _summaryKind: 'decision',
      },
      timestamp: NOW,
      summary: '暂不采用: 成本太高',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([intervention]));
    expect(out).toContain('no-target-bound');
    expect(out).toContain('reject');
    expect(out).toContain('no-execution');
  });
});

describe('P0010.2.4 — response/agree surfaces with section tag', () => {
  it('contains the evaluation string and section tag', () => {
    const intervention: HumanIntervention = {
      interventionId: 'int_r_1',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'response',
      content: {
        type: 'response',
        respondsTo: { agentActivityIds: [], signalIds: [], observationIds: [] },
        evaluation: 'agree',
        _section: 'judgment',
        _summaryKind: 'agree',
      },
      timestamp: NOW,
      summary: '认同',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([intervention]));
    expect(out).toContain('agree');
    expect(out).toContain('[判断反馈]');
    // response/agree is not a suggestion decision — no hard-constraint line
    expect(out).not.toMatch(/P0010\.2\.4 硬约束/);
  });
});

describe('P0010.2.4 — section distinction: judgment vs suggestion', () => {
  it('renders section tag for both kinds in a multi-intervention context', () => {
    const a: HumanIntervention = {
      interventionId: 'int_m_a',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'correction',
      content: {
        type: 'correction',
        corrects: {},
        correction: '判断是错的',
        _section: 'judgment',
        _summaryKind: 'correction',
      },
      timestamp: NOW,
      summary: '判断错了: 判断是错的',
    } as unknown as HumanIntervention;
    const b: HumanIntervention = {
      interventionId: 'int_m_b',
      situationId: SIT_ID,
      actor: { id: 'operator_1', role: 'operator' },
      type: 'decision',
      content: {
        type: 'decision',
        decision: 'accept',
        appliesTo: { recommendationId: 'SYNTHETIC_rec_xyz' },
        _section: 'suggestion',
        _summaryKind: 'decision',
      },
      timestamp: NOW,
      summary: '已纳入考量',
    } as unknown as HumanIntervention;
    const out = formatPriorHumanGuidance(makeContext([a, b]));
    // both section tags appear on the per-intervention lines.
    // The hard-constraint line also contains the literal `[建议处理]`
    // string (it names the section it's warning about), so the
    // suggestion count is 2 (decision line + guard line) and the
    // judgment count is 1.
    const judgmentMatches = out.match(/\[判断反馈\]/g) || [];
    const suggestionMatches = out.match(/\[建议处理\]/g) || [];
    expect(judgmentMatches.length).toBe(1);
    expect(suggestionMatches.length).toBe(2);
    // The suggestion decision is what triggers the hard-constraint line
    expect(out).toMatch(/P0010\.2\.4 硬约束/);
  });
});

describe('P0010.2.4 — buildInvestigationPrompt surfaces human feedback end-to-end', () => {
  it('the prompt includes the operator correction and the P0010.2.4 hard-constraint when a decision is in the suggestion section', () => {
    const ctx = makeContext([
      {
        interventionId: 'int_e2e_a',
        situationId: SIT_ID,
        actor: { id: 'operator_1', role: 'operator' },
        type: 'correction',
        content: {
          type: 'correction',
          corrects: {},
          correction: '京准通账户余额异常',
          _section: 'judgment',
          _summaryKind: 'correction',
        },
        timestamp: NOW,
        summary: '判断错了: 京准通账户余额异常',
      } as unknown as HumanIntervention,
      {
        interventionId: 'int_e2e_b',
        situationId: SIT_ID,
        actor: { id: 'operator_1', role: 'operator' },
        type: 'decision',
        content: {
          type: 'decision',
          decision: 'accept',
          appliesTo: { recommendationId: 'SYNTHETIC_rec_xyz' },
          _section: 'suggestion',
          _summaryKind: 'decision',
        },
        timestamp: NOW,
        summary: '已纳入考量',
      } as unknown as HumanIntervention,
    ]);
    const situation = ctx.situation as unknown as import('#shared/schemas/learning-context.js').Situation;
    const prompt = buildInvestigationPrompt(situation, ctx);
    expect(prompt).toContain('京准通账户余额异常');
    expect(prompt).toMatch(/P0010\.2\.4 硬约束/);
    expect(prompt).toContain('Prior Human Guidance');
  });
});
