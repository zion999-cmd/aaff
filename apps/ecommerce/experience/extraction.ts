// Memory extraction — the reason→condition→adjustment mapping.
// This is the most valuable business asset: it encodes WHY operators reject rankings.

import type { ContextMemory, MemoryPattern } from '#shared/schemas/memory.js';
import type { RankingReviewReasonCategory, ReviewEvent } from '#shared/schemas/review.js';
import { nowIso } from '#shared/utils/time.js';
import { uuid } from '#shared/utils/crypto.js';
import {
  DEFAULT_HALF_LIFE_DAYS,
  MIN_SUPPORT,
  MIN_SUPPORT_RATE,
  computeFinalScore,
  memoryConfidence,
} from './weights.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The domain-specific rule table: each reason category maps to a condition,
 * a lesson, and a ranking adjustment. Migrated concept from agentCMS
 * buildMemoryPattern.
 */
export const MEMORY_PATTERN_RULES: Readonly<
  Partial<Record<RankingReviewReasonCategory, MemoryPattern>>
> = {
  inventory_concern: {
    condition: { signal_name: 'stockout_risk', threshold: 0.5, direction: 'above' },
    correlated_condition: { signal_name: 'gmv_growth', threshold: 0.3, direction: 'above' },
    lesson: '库存紧张时不应放大增长信号',
    adjustment: {
      target_signal: 'gmv_growth',
      action: 'decrease_confidence',
      magnitude: 0.3,
    },
    support_count: 0,
    total_related: 0,
  },
  promotion_ending: {
    condition: { signal_name: 'gmv_growth', threshold: 0.5, direction: 'above' },
    correlated_condition: { signal_name: 'ad_density', threshold: 0.6, direction: 'above' },
    lesson: '促销末期的高增长不可持续',
    adjustment: { target_signal: 'gmv_growth', action: 'decrease_confidence', magnitude: 0.2 },
    support_count: 0,
    total_related: 0,
  },
  creator_drop: {
    condition: { signal_name: 'creator_coverage', threshold: 0.3, direction: 'below' },
    lesson: '达人带动力下降时降低其信号置信度',
    adjustment: { target_signal: 'creator_coverage', action: 'decrease_confidence', magnitude: 0.2 },
    support_count: 0,
    total_related: 0,
  },
  seasonal_fluctuation: {
    condition: { signal_name: 'sales_growth', threshold: 0.4, direction: 'above' },
    lesson: '季节性波动需折扣处理增长信号',
    adjustment: { target_signal: 'sales_growth', action: 'cap_score', magnitude: 0.5 },
    support_count: 0,
    total_related: 0,
  },
  market_trend_shift: {
    condition: { signal_name: 'price_competition_index', threshold: 0.3, direction: 'below' },
    lesson: '市场趋势转变时降低价格竞争信号置信度',
    adjustment: {
      target_signal: 'price_competition_index',
      action: 'decrease_confidence',
      magnitude: 0.2,
    },
    support_count: 0,
    total_related: 0,
  },
  pricing_issue: {
    condition: { signal_name: 'price_competition_index', threshold: 0.4, direction: 'below' },
    lesson: '定价偏离中位数时限制价格竞争得分',
    adjustment: {
      target_signal: 'price_competition_index',
      action: 'cap_score',
      magnitude: 0.4,
    },
    support_count: 0,
    total_related: 0,
  },
  data_quality_doubt: {
    condition: { signal_name: 'sales_growth', threshold: 0.5, direction: 'above' },
    lesson: '数据质量存疑时降低增长信号置信度',
    adjustment: { target_signal: 'sales_growth', action: 'decrease_confidence', magnitude: 0.3 },
    support_count: 0,
    total_related: 0,
  },
  manual_override: {
    condition: { signal_name: 'sales_growth', threshold: 0.5, direction: 'above' },
    lesson: '人工覆盖：限制该信号对排名的影响',
    adjustment: { target_signal: 'sales_growth', action: 'cap_score', magnitude: 0.5 },
    support_count: 0,
    total_related: 0,
  },
};

export interface ExtractMemoriesInput {
  reviews: readonly ReviewEvent[];
  agentId: string;
  now?: Date;
}

/**
 * Extract validated ContextMemory records from reject reviews.
 * Gate: >= MIN_SUPPORT reject events of the same reason_category AND support_rate >= MIN_SUPPORT_RATE.
 *
 * P0010.2.3 (ADR-059 audit J-1) — REMOVE CANDIDATE.
 * Production zero-call: only the contract test at
 * `tests/contract/memory-facade.contract.ts` and the in-memory wrapper
 * `MemoryFacade.extract` (itself unused) call this. Out of scope for this
 * slice to delete (per user spec — no Knowledge Identity redesign, no
 * Memory Architecture refactor). Do not use in new code; the canonical
 * write side is `recordInterventionInLearningContext`.
 */
export const extractMemories = (input: ExtractMemoriesInput): ContextMemory[] => {
  const { reviews, agentId, now = new Date() } = input;
  const rejects = reviews.filter((r) => r.action === 'reject' && r.reason_category);
  const totalRelated = reviews.length;
  if (totalRelated === 0) return [];

  // Group reject reviews by reason_category.
  const byCategory = new Map<RankingReviewReasonCategory, ReviewEvent[]>();
  for (const r of rejects) {
    const cat = r.reason_category!;
    const list = byCategory.get(cat) ?? [];
    list.push(r);
    byCategory.set(cat, list);
  }

  const memories: ContextMemory[] = [];
  const extractionRunId = uuid();
  const nowStr = nowIso();

  for (const [category, categoryReviews] of byCategory) {
    if (categoryReviews.length < MIN_SUPPORT) continue;
    const rule = MEMORY_PATTERN_RULES[category];
    if (!rule) continue;

    const supportCount = categoryReviews.length;
    const supportRate = supportCount / totalRelated;
    if (supportRate < MIN_SUPPORT_RATE) continue;

    const confidence = memoryConfidence(supportRate);
    const importance = rule.adjustment.action === 'decrease_confidence' ? 0.8 : 0.6;
    const freshness = 1.0;
    const finalScore = computeFinalScore({ confidence, supportRate, importance, freshness });
    if (finalScore < 0.5) continue; // reject tier

    const sourceReviewIds = categoryReviews.map((r) => r.review_id);
    const firstSeenAt = categoryReviews
      .map((r) => r.created_at)
      .sort()[0]!;
    const lastSeenAt = categoryReviews
      .map((r) => r.created_at)
      .sort()
      .reverse()[0]!;

    const memoryId = uuid();
    memories.push({
      memory_id: memoryId,
      memory_type: category === 'manual_override' ? 'ranking_override_pattern' : 'signal_reliability',
      scope: {
        entity_type: 'signal',
        entity_ids: [rule.adjustment.target_signal],
        ...(agentId ? { agent_id: agentId } : {}),
      },
      statement: rule.lesson,
      evidence: {
        sample_size: supportCount,
        support_rate: supportRate,
        counter_rate: 1 - supportRate,
        sources: sourceReviewIds,
      },
      weight: { importance, confidence, freshness, final_score: finalScore },
      temporal: {
        first_seen_at: firstSeenAt,
        last_seen_at: lastSeenAt,
        half_life_days: DEFAULT_HALF_LIFE_DAYS,
        expires_at: new Date(now.getTime() + DEFAULT_HALF_LIFE_DAYS * MS_PER_DAY).toISOString(),
      },
      status: 'active',
      validation: { state: 'validated', validator: 'rule', validated_at: nowStr },
      override: { is_overridden: false },
      trace: { source_review_ids: sourceReviewIds, extraction_run_id: extractionRunId },
      adjustment: {
        signal_name: rule.adjustment.target_signal,
        action: rule.adjustment.action,
        magnitude: rule.adjustment.magnitude,
        reason: rule.lesson,
        memory_id: memoryId,
      },
      created_at: nowStr,
    });
  }

  return memories;
};
