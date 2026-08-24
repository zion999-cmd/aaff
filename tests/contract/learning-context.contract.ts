// P0007.1 — Learning Context Contract tests.
// Validates schema, partial contexts, and real JD evidence integration.
//
// Fixture timestamps: all test fixtures use a fixed TEST_T0 to keep tests
// deterministic. Production code sources ALL times from real events
// (evidence metadata, execution events, intervention recording).

import { describe, it, expect } from 'vitest';

/** Central fixture anchor — all test times derive from this. Not for production use. */
const TEST_T0 = '2026-08-12T02:38:00Z';
import {
  LearningContextSchema,
  SituationSchema,
  ObservationRefSchema,
  AgentActivityRefSchema,
  HumanInterventionSchema,
  ActionRefSchema,
  OutcomeRefSchema,
  isLearnable,
  determineLifecycle,
} from '#shared/schemas/learning-context.js';
import type { LearningContext } from '#shared/schemas/learning-context.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---- Schema Validation Tests ----

describe('Situation', () => {
  it('accepts a valid JD ecommerce situation', () => {
    const situation = {
      situationId: 'sit_20260812_qimen_traffic',
      domain: 'ecommerce',
      type: 'performance_analysis',
      entity: { id: '11855009', type: 'shop', name: '祁门红茶旗舰店', platform: 'jd' },
      temporal: {
        observedAt: '2026-08-12T02:38:00Z',
        windowStart: '2026-08-05',
        windowEnd: '2026-08-12',
      },
      description: '祁门红茶旗舰店 2026-08-12 流量下降分析',
    };
    const result = SituationSchema.safeParse(situation);
    expect(result.success).toBe(true);
  });

  it('rejects missing description', () => {
    const result = SituationSchema.safeParse({ situationId: 'x', domain: 'ecommerce', type: 'performance_analysis', entity: { id: '1', type: 'shop' }, temporal: { observedAt: '2026-08-12' } });
    expect(result.success).toBe(false);
  });
});

describe('LearningContext — minimal (open lifecycle)', () => {
  it('accepts a context with only situation + observations + agent activity', () => {
    const ctx = {
      contextId: 'ctx_qimen_traffic_20260812',
      situation: {
        situationId: 'sit_20260812_qimen_traffic',
        domain: 'ecommerce',
        type: 'performance_analysis' as const,
        entity: { id: '11855009', type: 'shop', name: '祁门红茶旗舰店', platform: 'jd' },
        temporal: { observedAt: '2026-08-12T02:38:00Z', windowEnd: '2026-08-12' },
        description: '祁门红茶旗舰店 2026-08-12 流量下降分析',
      },
      createdAt: '2026-08-12T02:40:00Z',
      updatedAt: '2026-08-12T02:40:00Z',
      lifecycle: 'open' as const,
      observations: [{
        observationId: 'obs_20260812_cdp',
        capability: 'trade.overview',
        provider: { platform: 'jd', acquisition: 'cdp' as const },
        observedAt: '2026-08-12T02:38:00Z',
        summary: 'Live CDP capture: 14 API responses, GMV=¥337.90, orders=2, visitors=23',
        evidenceIds: ['ev_summary_20260812', 'ev_trend_20260812', 'ev_productTop_20260812'],
        metricsSnapshot: { gmv: 337.90, orders: 2, visitors: 23 },
      }],
      agentActivities: [{
        activityId: 'act_discover_20260812',
        type: 'capability_discovery' as const,
        agentRuntime: 'hermes',
        timestamp: '2026-08-12T02:37:00Z',
        summary: 'CapabilityBridge.searchByIntent → traffic.overview (score: 22.0)',
        capabilityId: 'traffic.overview',
        taskId: 'task_demo_20260812',
      }],
    };
    const result = LearningContextSchema.safeParse(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(isLearnable(result.data)).toBe(true);
      expect(determineLifecycle(result.data)).toBe('open');
    }
  });

  it('open context is learnable with just observations + agent activity', () => {
    const ctx = buildMinimalContext();
    expect(isLearnable(ctx)).toBe(true);
  });

  it('context without agent activity is not learnable', () => {
    const ctx = buildMinimalContext();
    ctx.agentActivities = [];
    expect(isLearnable(ctx)).toBe(false);
  });
});

describe('LearningContext — partial lifecycle', () => {
  it('has partial lifecycle when human interventions exist', () => {
    const ctx = buildMinimalContext();
    ctx.humanInterventions = [{
      interventionId: 'int_001',
      situationId: 'sit_test',
      actor: { id: 'operator_1', role: 'operator' },
      type: 'decision',
      timestamp: '2026-08-12T03:00:00Z',
      summary: 'Approved analysis — agrees traffic decline is from search channel',
      reviewId: 'rev_001',
    }];
    expect(determineLifecycle(ctx)).toBe('partial');
  });

  it('has partial lifecycle when actions exist', () => {
    const ctx = buildMinimalContext();
    ctx.actions = [{
      actionId: 'act_001',
      type: 'price_adjustment',
      actor: { type: 'human', id: 'operator_1' },
      timestamp: '2026-08-12T04:00:00Z',
      description: 'Lowered price on top 3 SKUs by 10%',
    }];
    expect(determineLifecycle(ctx)).toBe('partial');
  });
});

describe('LearningContext — mature lifecycle', () => {
  it('has mature lifecycle when outcomes exist', () => {
    const ctx = buildMinimalContext();
    ctx.actions = [{
      actionId: 'act_001',
      type: 'price_adjustment',
      actor: { type: 'human', id: 'operator_1' },
      timestamp: '2026-08-12T04:00:00Z',
      description: 'Lowered price on top 3 SKUs by 10%',
    }];
    ctx.outcomes = [{
      outcomeId: 'out_001',
      relatedActionIds: ['act_001'],
      observedAt: '2026-08-19T00:00:00Z',
      summary: 'GMV +54%, orders +150% after price adjustment',
    }];
    expect(determineLifecycle(ctx)).toBe('mature');
  });
});

describe('LearningContext — runtime-neutral', () => {
  it('contains no Hermes-specific fields in schema', () => {
    const ctx = buildMinimalContext();
    const result = LearningContextSchema.safeParse(ctx);
    expect(result.success).toBe(true);
    // Verify the schema doesn't require hermes-specific keys
    const keys = Object.keys(result.success ? result.data : {});
    expect(keys).not.toContain('hermesMemory');
    expect(keys).not.toContain('hermesSkill');
    expect(keys).not.toContain('chainOfThought');
  });
});

describe('LearningContext — real JD evidence validation', () => {
  it('can build a context from real CDP evidence data', () => {
    const evidencePath = resolve(process.cwd(), 'data', 'evidence', 'jd', '2026', '08', '12_summary.meta.json');
    if (!existsSync(evidencePath)) {
      // Skip if no evidence exists yet
      return;
    }
    const meta = JSON.parse(readFileSync(evidencePath, 'utf-8'));

    const ctx: LearningContext = {
      contextId: 'ctx_real_jd_20260812',
      situation: {
        situationId: 'sit_real_jd_20260812',
        domain: 'ecommerce',
        type: 'performance_analysis',
        entity: { id: meta.shop_id, type: 'shop', platform: meta.source },
        temporal: { observedAt: meta.acquired_at, windowEnd: meta.acquired_at.slice(0, 10) },
        description: `Live CDP acquisition for ${meta.source} shop ${meta.shop_id}`,
      },
      // Context creation ≠ evidence acquisition.
      // Evidence time (observedAt) = from source metadata.
      // Context time (createdAt) = when context was assembled (later).
      createdAt: meta.acquired_at,   // reasonable in test: assembly immediately after capture
      updatedAt: meta.acquired_at,
      observations: [{
        observationId: `obs_${meta.content_hash.slice(0, 8)}`,
        capability: 'trade.overview',
        provider: { platform: meta.source, acquisition: meta.acquisition_method as 'cdp' },
        // Observation time = evidence acquisition time (source of truth)
        observedAt: meta.acquired_at,
        summary: `${meta.data_type} captured via ${meta.acquisition_method}`,
        evidenceIds: [meta.content_hash],
      }],
      agentActivities: [{
        activityId: 'act_cdp_collect',
        type: 'data_acquisition',
        agentRuntime: 'cli',
        timestamp: meta.acquired_at,
        summary: `CLI collect jd --mode live --date 2026-08-12`,
        taskId: 'cli_collect_20260812',
      }],
    };

    const result = LearningContextSchema.safeParse(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.observations[0]!.evidenceIds.length).toBeGreaterThanOrEqual(1);
      expect(isLearnable(result.data)).toBe(true);
    }
  });
});

describe('HumanIntervention — 4-type Grammar (P0007.2 + P0010.1 Final Repair Area C)', () => {
  it('accepts all 4 intervention types', () => {
    // P0010.1 Final Repair — Area C.1: `action_intent` was removed in ADR-047.
    // The canonical operator surface is the 4 high-level kinds, with
    // `decision` sub-typed by `content.decision` ∈ accept | reject | defer
    // | override | no_action. The DB trigger enforces the same set.
    const grammarTypes = ['response', 'correction', 'context_supplement', 'decision'] as const;
    grammarTypes.forEach(type => {
      const intervention = {
        interventionId: `int_${type}`,
        situationId: 'sit_test',
        actor: { id: 'u1', role: 'operator' },
        type,
        timestamp: '2026-08-12T00:00:00Z',
        summary: `Test ${type}`,
      };
      expect(() => HumanInterventionSchema.parse(intervention)).not.toThrow();
    });
  });

  it('REPAIR invariant: rejects `action_intent` (removed in ADR-047)', () => {
    // P0010.1 Final Repair — Area C.1 + C.2: `action_intent` is no longer a
    // valid intervention type. The Zod enum drops it; the DB trigger
    // enforces the same set.
    const intervention = {
      interventionId: 'int_legacy',
      situationId: 'sit_test',
      actor: { id: 'u1', role: 'operator' },
      type: 'action_intent',
      timestamp: '2026-08-12T00:00:00Z',
      summary: 'Test action_intent (legacy)',
    };
    expect(() => HumanInterventionSchema.parse(intervention)).toThrow(/action_intent/);
  });

  it('rejects invalid type — Grammar is enforced, unknown values fail validation', () => {
    const intervention = {
      interventionId: 'int_bad',
      situationId: 'sit_test',
      actor: { id: 'u1', role: 'operator' },
      type: 'custom_escalation_protocol',  // NOT in the 5-type Grammar
      timestamp: '2026-08-12T00:00:00Z',
      summary: 'Escalated to legal team for review',
    };
    const result = HumanInterventionSchema.safeParse(intervention);
    expect(result.success).toBe(false);
  });
});

describe('HumanIntervention — respondsToActivityIds (Case C)', () => {
  it('can reference which agent activity the human is responding to', () => {
    const intervention = {
      interventionId: 'int_c_rejection',
      situationId: 'sit_test',
      actor: { id: 'u1', role: 'operator' },
      type: 'decision' as const,
      timestamp: '2026-08-12T00:00:00Z',
      summary: 'Rejected agent recommendation — traffic drop is seasonal, not channel issue',
      respondsToActivityIds: ['act_agent_recommendation_001'],
    };
    const result = HumanInterventionSchema.safeParse(intervention);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.respondsToActivityIds).toEqual(['act_agent_recommendation_001']);
    }
  });

  it('respondsToActivityIds defaults to empty when not specified', () => {
    const intervention = {
      interventionId: 'int_no_ref',
      situationId: 'sit_test',
      actor: { id: 'u1', role: 'operator' },
      type: 'correction' as const,
      timestamp: '2026-08-12T00:00:00Z',
      summary: 'General note',
    };
    const result = HumanInterventionSchema.parse(intervention);
    expect(result.respondsToActivityIds).toEqual([]);
  });
});

describe('Outcome — relatedActionIds (Case D)', () => {
  it('records multiple actions without implying causality', () => {
    // Reality: 换主图 + 降价 + 增加投放 all happened, then CTR+8%.
    // Contract records all three as related — does NOT pick a single cause.
    const outcome = {
      outcomeId: 'out_multi_action',
      relatedActionIds: ['act_banner_change', 'act_price_drop', 'act_ad_increase'],
      observedAt: '2026-08-19T00:00:00Z',
      summary: 'CTR +8% after combined changes',
    };
    const result = OutcomeRefSchema.safeParse(outcome);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.relatedActionIds).toHaveLength(3);
    }
  });

  it('can have zero related actions (outcome from external factors)', () => {
    const outcome = {
      outcomeId: 'out_external',
      relatedActionIds: [],
      observedAt: '2026-08-19T00:00:00Z',
      summary: 'Market-wide traffic increase — no actions taken by shop',
    };
    const result = OutcomeRefSchema.safeParse(outcome);
    expect(result.success).toBe(true);
  });
});

describe('LearningContext — incremental enrichment', () => {
  it('can start open then add intervention (partial) then outcome (mature)', () => {
    const ctx = buildMinimalContext();
    expect(determineLifecycle(ctx)).toBe('open');

    const withIntervention = { ...ctx, humanInterventions: [{
      interventionId: 'int_001', situationId: 'sit_test', actor: { id: 'u1', role: 'operator' },
      type: 'decision' as const, timestamp: '2026-08-12T00:00:00Z', summary: 'test',
    }]};
    expect(determineLifecycle(withIntervention)).toBe('partial');

    const withOutcome = { ...withIntervention, actions: [{
      actionId: 'a1', type: 'price_change', actor: { type: 'human' as const },
      timestamp: '2026-08-12T00:00:00Z', description: 'test',
    }], outcomes: [{
      outcomeId: 'o1', relatedActionIds: ['a1'],
      observedAt: '2026-08-19T00:00:00Z',
    }]};
    expect(determineLifecycle(withOutcome)).toBe('mature');
  });
});

// ---- Test Helpers ----

function buildMinimalContext(): LearningContext {
  return {
    contextId: 'ctx_test',
    situation: {
      situationId: 'sit_test',
      domain: 'ecommerce',
      type: 'performance_analysis',
      entity: { id: 'test_shop', type: 'shop', name: 'Test Shop', platform: 'jd' },
      temporal: { observedAt: '2026-08-12T00:00:00Z' },
      description: 'Test situation for Learning Context validation',
    },
    lifecycle: 'open',
    createdAt: '2026-08-12T00:00:00Z',
    updatedAt: '2026-08-12T00:00:00Z',
    observations: [{
      observationId: 'obs_test',
      capability: 'trade.overview',
      provider: { platform: 'jd', acquisition: 'cdp' },
      observedAt: '2026-08-12T00:00:00Z',
      summary: 'Test observation',
      metricsSnapshot: { gmv: 100 },
    }],
    agentActivities: [{
      activityId: 'act_test',
      type: 'capability_discovery',
      agentRuntime: 'hermes',
      timestamp: '2026-08-12T00:00:00Z',
      summary: 'Test activity',
    }],
  };
}
