// P0010 — Investigation Contract tests: schema, parser, prompt.
// Verifies the business artifacts are validatable and that the prompt carries
// situation DATA (not rules) and drives evidence acquisition.

import { describe, expect, test } from 'vitest';
import { InvestigationSchema, RecommendationSchema } from '#shared/schemas/investigation.js';
import type { Investigation } from '#shared/schemas/investigation.js';
import { LearningContextSchema } from '#shared/schemas/learning-context.js';
import type { Situation } from '#shared/schemas/learning-context.js';
import { buildInvestigationPrompt } from '#app/runtime/investigation/prompt.js';
import { parseInvestigation, extractJsonObject } from '#app/runtime/investigation/parse.js';

const validInvestigation = (): Investigation => ({
  situationId: 'sit_abc',
  currentUnderstanding: 'GMV decline confirmed.',
  knownEvidence: ['GMV -24%', 'UV -27%'],
  hypotheses: [{ statement: 'Traffic-side anomaly drives GMV decline', status: 'proposed' }],
  unknowns: ['Which channel caused the UV drop?'],
  nextQuestion: 'Which traffic channel caused the UV drop?',
  requiredEvidence: ['traffic source breakdown'],
  investigationRequest: 'Acquire traffic.overview',
  findings: [
    {
      question: 'Which channel?',
      evidenceRefs: ['ev_1'],
      answer: 'Natural search -38%',
      impactOnHypothesis: 'H1 supported',
    },
  ],
  judgment: 'Decline concentrated in natural search.',
  stopReason: 'judgment',
  capabilityUsed: 'traffic.overview',
  evidenceAcquired: ['ev_1'],
});

describe('InvestigationSchema', () => {
  test('accepts a complete investigation', () => {
    expect(InvestigationSchema.safeParse(validInvestigation()).success).toBe(true);
  });

  test('hypothesis status enum', () => {
    for (const s of ['proposed', 'supported', 'weakened', 'rejected'] as const) {
      expect(InvestigationSchema.safeParse({ ...validInvestigation(), hypotheses: [{ statement: 'x', status: s }] }).success).toBe(true);
    }
    expect(InvestigationSchema.safeParse({ ...validInvestigation(), hypotheses: [{ statement: 'x', status: 'bogus' }] }).success).toBe(false);
  });

  test('stop reason enum', () => {
    for (const s of ['judgment', 'observe', 'missing_capability', 'ask_human'] as const) {
      expect(InvestigationSchema.safeParse({ ...validInvestigation(), stopReason: s }).success).toBe(true);
    }
    expect(InvestigationSchema.safeParse({ ...validInvestigation(), stopReason: 'investigate' }).success).toBe(false);
  });

  test('requires situationId', () => {
    expect(InvestigationSchema.safeParse({ ...validInvestigation(), situationId: '' }).success).toBe(false);
  });

  test('defaults optional fields', () => {
    const minimal = InvestigationSchema.parse({ situationId: 'sit_x' });
    expect(minimal.knownEvidence).toEqual([]);
    expect(minimal.hypotheses).toEqual([]);
    expect(minimal.findings).toEqual([]);
  });

  test('RecommendationSchema normalizes string-or-list risk/human fields', () => {
    const rec = RecommendationSchema.parse({
      recommendation: '先人工核验，不干预',
      rationale: 'judgment 依据',
      risks: ['风险A', '风险B'], // model may emit a list
      humanNeeded: '财务确认优惠券到期', // or a single string
    });
    expect(rec.risks).toEqual(['风险A', '风险B']);
    expect(rec.humanNeeded).toEqual(['财务确认优惠券到期']);
    expect(rec.prerequisites).toEqual([]);
  });

  test('RecommendationSchema rejects missing recommendation', () => {
    expect(RecommendationSchema.safeParse({ rationale: 'x' }).success).toBe(false);
  });

  test('status markers (investigating/failed) validate as Investigations', () => {
    const investigating = InvestigationSchema.parse({ situationId: 'sit_x', status: 'investigating', startedAt: '2026-08-21T00:00:00.000Z' });
    expect(investigating.status).toBe('investigating');
    expect(investigating.knownEvidence).toEqual([]); // defaults filled

    const failed = InvestigationSchema.parse({ situationId: 'sit_x', status: 'failed', error: 'Turn timed out' });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Turn timed out');
  });

  // P0010.1 REPAIR: capabilityUsed must accept the HONEST "no capability
  // called this turn" state without forcing the Agent to invent a fake id.
  describe('capabilityUsed — honest null is accepted and normalized', () => {
    test('null capabilityUsed is accepted and normalized to empty string', () => {
      const parsed = InvestigationSchema.parse({ ...validInvestigation(), capabilityUsed: null });
      expect(parsed.capabilityUsed).toBe('');
    });

    test('omitted capabilityUsed is accepted and normalized to empty string', () => {
      const parsed = InvestigationSchema.parse({ situationId: 'sit_x' });
      expect(parsed.capabilityUsed).toBe('');
    });

    test('real capabilityUsed string is preserved verbatim', () => {
      const parsed = InvestigationSchema.parse({ ...validInvestigation(), capabilityUsed: 'trade.overview' });
      expect(parsed.capabilityUsed).toBe('trade.overview');
    });
  });

  test('LearningContextSchema carries an optional investigation additively', () => {
    const ctx = {
      contextId: 'c1',
      situation: {
        situationId: 'sit_abc',
        domain: 'ecommerce',
        type: 'anomaly_investigation',
        entity: { id: 'shop', type: 'product' },
        temporal: { observedAt: '2026-08-16T00:00:00.000Z' },
        description: 'GMV down',
        tags: [],
      },
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
      investigation: validInvestigation(),
    };
    const parsed = LearningContextSchema.parse(ctx);
    expect(parsed.investigation?.nextQuestion).toBe('Which traffic channel caused the UV drop?');
  });
});

describe('parseInvestigation', () => {
  test('extracts the JSON object from prose-wrapped text', () => {
    const reply = `I investigated. Here is the contract:\n${JSON.stringify(validInvestigation(), null, 2)}\nHope this helps.`;
    const result = parseInvestigation(reply, 'sit_abc');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.investigation.nextQuestion).toBe('Which traffic channel caused the UV drop?');
      expect(result.investigation.stopReason).toBe('judgment');
    }
  });

  test('forces the situationId from the caller (untrusted reply)', () => {
    const reply = JSON.stringify({ ...validInvestigation(), situationId: 'evil_id' });
    const result = parseInvestigation(reply, 'sit_abc');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.investigation.situationId).toBe('sit_abc');
  });

  test('fails when no JSON object present', () => {
    const result = parseInvestigation('no structured output', 'sit_abc');
    expect(result.ok).toBe(false);
  });

  test('fails on invalid shape', () => {
    const result = parseInvestigation(JSON.stringify({ situationId: 'sit_abc', hypotheses: [{ statement: 5 }] }), 'sit_abc');
    expect(result.ok).toBe(false);
  });

  test('extractJsonObject handles nested braces', () => {
    const text = 'prefix ' + JSON.stringify({ a: { b: [1, 2] } }) + ' suffix';
    const obj = extractJsonObject(text);
    expect(obj).not.toBeNull();
    expect(JSON.parse(obj!)).toEqual({ a: { b: [1, 2] } });
  });
});

describe('buildInvestigationPrompt', () => {
  const situation: Situation = {
    situationId: 'sit_abc',
    domain: 'ecommerce',
    type: 'anomaly_investigation',
    entity: { id: 'jd_shop_001', type: 'product', name: '祁门红茶旗舰店', platform: 'jd' },
    temporal: { observedAt: '2026-08-16T00:00:00.000Z' },
    description: '成交金额 较昨日下降 67.9%，从 ¥3384.26 变为 ¥1087.13。',
    tags: ['gmv', 'down'],
  };

  test('carries the situation as data', () => {
    const prompt = buildInvestigationPrompt(situation, null);
    expect(prompt).toContain('sit_abc');
    expect(prompt).toContain('成交金额 较昨日下降 67.9%');
    expect(prompt).toContain('祁门红茶旗舰店');
  });

  test('directs the Agent to read knowledge/INDEX.md + pages (no SOP copy)', () => {
    const prompt = buildInvestigationPrompt(situation, null);
    expect(prompt).toContain('knowledge/INDEX.md');
    // No business rules are embedded — the prompt must not contain the GMV->UV->traffic mapping.
    expect(prompt.toLowerCase()).not.toMatch(/gmv.*→.*uv/i);
  });

  test('instructs evidence acquisition via fabric_execute_capability and honest stop', () => {
    const prompt = buildInvestigationPrompt(situation, null);
    expect(prompt).toContain('fabric_execute_capability');
    expect(prompt).toContain('fabric_list_capabilities');
    expect(prompt).toContain('missing_capability');
    // P0010.2.5 — the old "MUST actually call fabric_execute_capability at
    // least once" was over-prescriptive. The new prompt frames evidence
    // acquisition as the standard move per gap (one call per gap, retry
    // once, then stop) — multiple capabilities per turn are allowed as
    // long as each solves a distinct evidence gap. The semantic invariant
    // is "acquire live evidence for unresolved gaps, do not just analyze";
    // we pin the new wording rather than the old one.
    expect(prompt.toLowerCase()).toMatch(/acquire evidence for each gap|evidence acquisition|one capability per gap|evidence gap/i);
  });

  test('no hardcoded investigation tree / if-else business logic', () => {
    const prompt = buildInvestigationPrompt(situation, null);
    expect(prompt).not.toContain('if (');
    expect(prompt).not.toContain('GMV down →');
  });

  // P0010.1 Post-Review REPAIR — epistemic semantics. The prompt must NOT
  // frame prior human guidance as "authoritative" / "overrides the Agent's
  // own guesses" / "MUST be consistent". Human input is ONE input the
  // Agent should weigh alongside Evidence; if the two conflict, the Agent
  // surfaces the conflict in the judgment, it does NOT silently override
  // either side.
  test('does not use override/authoritative/MUST-consult/MUST-be-consistent wording', () => {
    const prompt = buildInvestigationPrompt(situation, null);
    const lower = prompt.toLowerCase();
    expect(lower).not.toContain('overrides the agent');
    expect(lower).not.toContain('authoritative');
    expect(lower).not.toContain('must consult');
    expect(lower).not.toContain('must be consistent');
  });

  test('capabilityUsed schema hint accepts null (matches REPAIR 1 schema)', () => {
    const prompt = buildInvestigationPrompt(situation, null);
    expect(prompt).toContain('"capabilityUsed"');
    expect(prompt.toLowerCase()).toMatch(/capabilityused.*or null|null.*capabilityused/s);
  });

  test('prior human guidance section is weighted (correction/supplement vs response/decision)', () => {
    const prompt = buildInvestigationPrompt(situation, null);
    expect(prompt).toContain('权重');
    expect(prompt).toMatch(/correction/);
    expect(prompt).toMatch(/decision/);
    expect(prompt).toContain('反馈');
  });
});

// P0010.1 — Prior Human Guidance wire. The investigation prompt MUST surface
// persisted humanInterventions (correction / supplement / decision / response)
// so the next investigation turn consults the operator's prior input. This
// proves the consumer side of the human feedback chain is wired.
describe('buildInvestigationPrompt — Prior Human Guidance (P0010.1)', () => {
  const baseSituation: Situation = {
    situationId: 'sit_human_test',
    domain: 'ecommerce',
    type: 'anomaly_investigation',
    entity: { id: 'jd_shop_001', type: 'product', name: '祁门红茶旗舰店', platform: 'jd' },
    temporal: { observedAt: '2026-08-16T00:00:00.000Z' },
    description: '成交金额 较昨日下降 67.9%，从 ¥3384.26 变为 ¥1087.13。',
    tags: ['gmv', 'down'],
  };

  const buildCtx = (interventions: Array<Record<string, unknown>>) => ({
    contextId: 'ctx_test',
    situation: baseSituation,
    lifecycle: 'partial' as const,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    observations: [],
    evidenceIds: [],
    signalIds: [],
    agentActivities: [],
    humanInterventions: interventions as never,
    actions: [],
    outcomes: [],
    summary: {
      capabilitiesUsed: [],
      agentRuntimes: [],
      humanActors: [],
      totalEvidence: 0,
      totalSignals: 0,
    },
  });

  test('emits a "no prior human guidance" sentinel when no interventions exist', () => {
    const prompt = buildInvestigationPrompt(baseSituation, buildCtx([]) as never);
    expect(prompt).toContain('## Prior Human Guidance');
    expect(prompt).toContain('no prior human guidance');
  });

  test('surfaces a user correction verbatim in the prompt', () => {
    const prompt = buildInvestigationPrompt(
      baseSituation,
      buildCtx([
        {
          interventionId: 'int_c1',
          situationId: 'sit_human_test',
          actor: { id: 'operator_1', role: 'operator' },
          type: 'correction',
          content: { type: 'correction', corrects: {}, correction: '实际是 8月15日大促结束导致订单回落，不是下降' },
          timestamp: '2026-08-16T01:00:00.000Z',
          summary: '纠正: 实际是 8月15日大促结束导致订单回落',
        },
      ]) as never,
    );
    expect(prompt).toContain('## Prior Human Guidance');
    expect(prompt).toContain('用户纠正');
    expect(prompt).toContain('8月15日大促结束导致订单回落');
  });

  test('surfaces a user context supplement in the prompt', () => {
    const prompt = buildInvestigationPrompt(
      baseSituation,
      buildCtx([
        {
          interventionId: 'int_s1',
          situationId: 'sit_human_test',
          actor: { id: 'operator_1', role: 'operator' },
          type: 'context_supplement',
          content: { type: 'context_supplement', supplements: { situationAspect: '库存' }, information: '主推 SKU 缺货已 3 天' },
          timestamp: '2026-08-16T02:00:00.000Z',
          summary: '补充: 主推 SKU 缺货已 3 天',
        },
      ]) as never,
    );
    expect(prompt).toContain('## Prior Human Guidance');
    expect(prompt).toContain('用户补充');
    expect(prompt).toContain('主推 SKU 缺货已 3 天');
  });

  test('surfaces a user decision (accept/reject/defer) in the prompt', () => {
    const prompt = buildInvestigationPrompt(
      baseSituation,
      buildCtx([
        {
          interventionId: 'int_d1',
          situationId: 'sit_human_test',
          actor: { id: 'operator_1', role: 'operator' },
          type: 'decision',
          content: { type: 'decision', decision: 'reject', appliesTo: {}, rationale: '不符合本期主推' },
          timestamp: '2026-08-16T03:00:00.000Z',
          summary: '不采用: 不符合本期主推',
        },
      ]) as never,
    );
    expect(prompt).toContain('## Prior Human Guidance');
    expect(prompt).toContain('用户已决定');
    expect(prompt).toContain('reject');
    expect(prompt).toContain('不符合本期主推');
  });
});

// P0010.1 Productization Baseline — pure presentation helpers in
// apps/ecommerce/workspace/presentation.js. These functions are the
// single source of truth for the human-side contract: business
// situation language, source attribution, error humanization, and
// system-term scrubbing. App.js re-uses them; the unit tests pin the
// behavior so a UI tweak does not silently regress the baseline.

import {
  businessDescribeSituation,
  businessDescribeSituationShort,
  sourceTagLabel,
  sourceTagTooltip,
  humanizeError,
  descClean,
  hasPriorValidCognition,
} from '#app/workspace/presentation.js';

describe('P0010.1 Baseline — businessDescribeSituation (situation.type × investigation.stopReason)', () => {
  const desc = '祁门红茶旗舰店 成交金额 较昨日下降 67.9%，从 ¥3384.26 变为 ¥1087.13。';

  test('ranking_attention + observe → "相对突出 … 持续观察" with headline pct', () => {
    const out = businessDescribeSituation(
      { type: 'ranking_attention', description: desc },
      { stopReason: 'observe' },
    );
    expect(out).toContain('持续观察');
    expect(out).toContain('67.9%');
    expect(out).not.toContain('综合得分');
  });

  test('ranking_attention + judgment → "Agent 已对此商品形成判断"', () => {
    const out = businessDescribeSituation(
      { type: 'ranking_attention', description: desc },
      { stopReason: 'judgment' },
    );
    expect(out).toContain('形成判断');
    expect(out).not.toContain('综合得分');
  });

  test('meaningful_change + observe → "波动 … 正常范围"', () => {
    const out = businessDescribeSituation(
      { type: 'meaningful_change', description: desc },
      { stopReason: 'observe' },
    );
    expect(out).toContain('正常范围');
    expect(out).toContain('67.9%');
  });

  test('meaningful_change + judgment → "下降需要重点关注" (direction-aware)', () => {
    const out = businessDescribeSituation(
      { type: 'meaningful_change', description: desc },
      { stopReason: 'judgment' },
    );
    expect(out).toContain('下降');
    expect(out).toContain('重点关注');
    expect(out).toContain('67.9%');
  });

  test('anomaly_investigation + observe → "持续观察中 … 暂未发现异常"', () => {
    const out = businessDescribeSituation(
      { type: 'anomaly_investigation', description: desc },
      { stopReason: 'observe' },
    );
    expect(out).toContain('持续观察');
    expect(out).toContain('暂未发现');
  });

  test('anomaly_investigation + judgment → "已形成判断" with pct', () => {
    const out = businessDescribeSituation(
      { type: 'anomaly_investigation', description: desc },
      { stopReason: 'judgment' },
    );
    expect(out).toContain('形成判断');
    expect(out).toContain('67.9%');
  });
});

describe('P0010.1 Baseline — businessDescribeSituationShort (feed card one-liner)', () => {
  test('observe / judgment / unknown all produce a non-empty ≤ 12-char chip', () => {
    for (const stopReason of ['observe', 'judgment']) {
      for (const type of ['ranking_attention', 'meaningful_change', 'anomaly_investigation']) {
        const out = businessDescribeSituationShort(
          { type, description: '占位' },
          { stopReason },
        );
        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThanOrEqual(12);
      }
    }
  });

  test('unknown tuple falls back to "待整理" (no fabricated status)', () => {
    expect(businessDescribeSituationShort({ type: 'mystery_type' }, { stopReason: 'observe' })).toBe('待整理');
    expect(businessDescribeSituationShort({ type: 'meaningful_change' }, {})).toBe('待整理');
  });
});

describe('P0010.1 Baseline — sourceTagLabel / sourceTagTooltip (citation chain)', () => {
  test('4 known kinds produce the documented labels', () => {
    expect(sourceTagLabel('evidence')).toBe('[证据]');
    expect(sourceTagLabel('knowledge')).toBe('[规则]');
    expect(sourceTagLabel('human', 1)).toBe('[H1]');
    expect(sourceTagLabel('human', 7)).toBe('[H7]');
    expect(sourceTagLabel('memory')).toBe('[记忆]');
  });

  test('unknown kind returns "" (do not fabricate attribution)', () => {
    expect(sourceTagLabel('metric')).toBe('');
    expect(sourceTagLabel('')).toBe('');
    expect(sourceTagLabel(undefined as never)).toBe('');
  });

  test('human refId is 1-based and falls back to "?" when missing', () => {
    expect(sourceTagLabel('human')).toBe('[H?]');
    expect(sourceTagLabel('human', null)).toBe('[H?]');
  });

  test('tooltips admit the schema blocker honestly (no fabrication of stable ids)', () => {
    expect(sourceTagTooltip('evidence')).toContain('运行时生成');
    expect(sourceTagTooltip('evidence')).toContain('content_hash');
    expect(sourceTagTooltip('knowledge')).toContain('无 first-class');
    expect(sourceTagTooltip('memory')).toContain('Runtime');
    expect(sourceTagTooltip('human')).toContain('人工干预');
  });
});

describe('P0010.1 Baseline — humanizeError (no LLM, table lookup)', () => {
  test('4 known raw errors map to Chinese descriptions', () => {
    expect(humanizeError('Turn timed out', 'business')).toBe('调查超时（已超过 10 分钟）');
    expect(humanizeError('Invalid Investigation Contract', 'business')).toBe('调查结果未能形成有效判断');
    expect(humanizeError('Invalid recommendation JSON', 'business')).toBe('建议生成未形成有效输出');
    expect(humanizeError('Situation not found: sit_x', 'business')).toBe('Situation 不存在');
  });

  test('business mode never leaks the raw error string', () => {
    const raw = 'Unknown infra error XYZ-9981';
    const out = humanizeError(raw, 'business');
    expect(out).not.toContain('XYZ-9981');
    expect(out).not.toContain('Unknown infra');
    expect(out).toContain('系统已记录原因');
  });

  test('developer mode preserves the raw error in parens for diagnosis', () => {
    const raw = 'Unknown infra error XYZ-9981';
    const out = humanizeError(raw, 'developer');
    expect(out).toContain('XYZ-9981');
    expect(out).toContain('开发模式可见');
  });

  test('empty / null raw error still produces a Chinese sentence (not a blank UI)', () => {
    expect(humanizeError('', 'business')).toContain('系统已记录原因');
    expect(humanizeError(undefined as never, 'business')).toContain('系统已记录原因');
  });
});

describe('P0010.1 Baseline — descClean (system-term scrub as safety net)', () => {
  test('strips "综合得分" / "overall_score" / "右侧 Track" / "Evidence Viewer"', () => {
    const before = '综合得分领先，右侧 Track 已记录，Evidence Viewer 已捕获。';
    const after = descClean(before);
    expect(after).not.toContain('综合得分');
    expect(after).not.toContain('右侧 Track');
    expect(after).not.toContain('Evidence Viewer');
    expect(after).not.toContain('overall_score');
    expect(after).toContain('近期表现');
  });

  test('returns the original text when no system terms are present', () => {
    const safe = '祁门红茶旗舰店 成交金额 较昨日下降 67.9%。';
    expect(descClean(safe)).toBe(safe);
  });

  test('empty / null input returns empty (no crash)', () => {
    expect(descClean('')).toBe('');
    expect(descClean(null as never)).toBe('');
  });
});

describe('P0010.1 Baseline — hasPriorValidCognition (failed banner gate)', () => {
  test('null investigation → false', () => {
    expect(hasPriorValidCognition(null)).toBe(false);
    expect(hasPriorValidCognition(undefined)).toBe(false);
  });

  test('failed investigation with judgment → true (banner shows)', () => {
    expect(hasPriorValidCognition({ status: 'failed', error: 'Turn timed out', judgment: 'x' })).toBe(true);
    expect(hasPriorValidCognition({ status: 'failed', currentUnderstanding: 'y' })).toBe(true);
  });

  test('failed investigation without judgment or currentUnderstanding → false (no banner)', () => {
    expect(hasPriorValidCognition({ status: 'failed', error: 'x' })).toBe(false);
  });
});
