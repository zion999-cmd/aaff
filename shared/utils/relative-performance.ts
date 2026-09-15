// Evidence Semantic Integrity — Relative Performance Contract (Phase C).
//
// "店铺下降 44.6%, 同期大盘上涨 8.9% — 店铺相对大盘跑输 53.5 pp."
//
// The LLM should never have to combine three signed numbers in its head
// to decide "did the shop do better or worse than the market?". This
// module computes the second-order comparison as a structured fact and
// renders the canonical prose, with a hard guard against converting
// "跑输 / 跑赢" into a Judgment ("经营异常 / 客户画像改变") — that is
// the Agent's job, not Fabric's.

import type { DirectionalFact, Direction } from './directional-fact.js';
import { DIRECTION_ACTION_WORD } from './directional-fact.js';

/** Categorical second-order result. */
export type RelativePerformance = 'outperform' | 'underperform' | 'equal';

export const RELATIVE_PERFORMANCE_WORD: Readonly<Record<RelativePerformance, string>> =
  Object.freeze({
    outperform: '跑赢',
    underperform: '跑输',
    equal: '持平',
  });

/**
 * The structured second-order fact. The key fields:
 *
 *   relative_gap_pp  — SIGNED percentage-POINT gap. positive = subject
 *                      outperformed (its delta_pct_signed is more
 *                      positive than the comparison's by N pp).
 *                      EXACTLY (subject.delta_pct_signed - comparison.delta_pct_signed).
 *
 *   magnitude_pp     — abs(relative_gap_pp), used for prose.
 *
 *   relative_performance — categorical enum. Driven by the SIGN of
 *                      relative_gap_pp (positive → outperform; negative
 *                      → underperform; near-zero → equal). Uses the
 *                      same eps_pct knob the first-order DirectionalFact
 *                      uses, but applied to percentage POINTS not pct
 *                      movements.
 *
 * "outperform" / "underperform" are facts. The Judgment (is this
 * 经营异常? is it a 客户画像改变? is it a 故障?) is the Agent's job.
 *  Fabric NEVER attaches a Judgment to a fact.
 */
export interface RelativePerformanceFact {
  /** Label of the subject being compared (e.g. "店铺 GMV" / "本店转化率"). */
  readonly subject_label: string;
  /** First-order DirectionalFact for the subject. */
  readonly subject_fact: DirectionalFact;
  /** Label of the comparison base (e.g. "大盘" / "同行业" / "类目"). */
  readonly comparison_label: string;
  /** First-order DirectionalFact for the comparison base. */
  readonly comparison_fact: DirectionalFact;
  /**
   * Signed pp gap. EXACTLY (subject_fact.delta_pct_signed - comparison_fact.delta_pct_signed).
   * E.g. -44.6 - 8.9 = -53.5 (shop down 44.6, market up 8.9 → shop
   * underperformed by 53.5pp).
   */
  readonly relative_gap_pp: number;
  /** abs(relative_gap_pp). Used for prose. */
  readonly magnitude_pp: number;
  /** Categorical. */
  readonly relative_performance: RelativePerformance;
}

/** Default epsilon for `equal` (in percentage POINTS). 0.1pp. */
export const DEFAULT_RELATIVE_FLAT_EPS_PP = 0.1;

/**
 * Compute the second-order fact. Returns `null` if either of the inputs
 * is missing (caller decides how to surface "no comparison").
 */
export const computeRelativePerformance = (args: {
  readonly subject_label: string;
  readonly subject_fact: DirectionalFact;
  readonly comparison_label: string;
  readonly comparison_fact: DirectionalFact;
  /** Epsilon for "equal" in pp. Default 0.1. */
  readonly eps_pp?: number;
}): RelativePerformanceFact | null => {
  const { subject_label, subject_fact, comparison_label, comparison_fact } = args;
  // First-order null propagation: if either first-order fact is missing,
  // we cannot compute the second-order fact.
  if (!subject_fact || !comparison_fact) return null;
  const eps = args.eps_pp ?? DEFAULT_RELATIVE_FLAT_EPS_PP;
  const relative_gap_pp =
    Math.round((subject_fact.delta_pct_signed - comparison_fact.delta_pct_signed) * 10) / 10;
  const magnitude_pp = Math.abs(relative_gap_pp);
  const relative_performance: RelativePerformance =
    magnitude_pp <= eps ? 'equal' : relative_gap_pp > 0 ? 'outperform' : 'underperform';
  return {
    subject_label,
    subject_fact,
    comparison_label,
    comparison_fact,
    relative_gap_pp,
    magnitude_pp,
    relative_performance,
  };
};

/**
 * Format the canonical prose. Output:
 *
 *   "店铺下降 44.6%，大盘上涨 8.9%，店铺相对大盘跑输 53.5 个百分点"
 *   "店铺上涨 71.8%，大盘下降 5.0%，店铺相对大盘跑赢 76.8 个百分点"
 *   "店铺下降 12.3%，大盘下降 12.4%，店铺相对大盘持平（差 0.1pp）"
 *
 * Forbidden:
 *   "店铺跑输 53.5%"   ← would mix pp with %
 *   "店铺跑输 53.5pp 大盘异常"   ← would attach a Judgment
 */
export const formatRelativePerformance = (fact: RelativePerformanceFact): string => {
  const sub = fact.subject_fact;
  const cmp = fact.comparison_fact;
  // Sub: "{label}{action_word} {magnitude}%"
  const subPart = `${fact.subject_label}${DIRECTION_ACTION_WORD[sub.direction]} ${sub.magnitude_pct.toFixed(1)}%`;
  const cmpPart = `${fact.comparison_label}${DIRECTION_ACTION_WORD[cmp.direction]} ${cmp.magnitude_pct.toFixed(1)}%`;
  if (fact.relative_performance === 'equal') {
    return `${subPart}，${cmpPart}，${fact.subject_label}相对${fact.comparison_label}${RELATIVE_PERFORMANCE_WORD.equal}（差 ${fact.magnitude_pp.toFixed(1)} 个百分点）`;
  }
  return `${subPart}，${cmpPart}，${fact.subject_label}相对${fact.comparison_label}${RELATIVE_PERFORMANCE_WORD[fact.relative_performance]} ${fact.magnitude_pp.toFixed(1)} 个百分点`;
};

/**
 * Format as a short summary. Output:
 *
 *   "店铺跑输大盘 53.5pp"   (underperform)
 *   "店铺跑赢大盘 76.8pp"   (outperform)
 *   "店铺与大盘持平"         (equal)
 */
export const formatRelativePerformanceShort = (fact: RelativePerformanceFact): string => {
  if (fact.relative_performance === 'equal') {
    return `${fact.subject_label}与${fact.comparison_label}${RELATIVE_PERFORMANCE_WORD.equal}`;
  }
  return `${fact.subject_label}${RELATIVE_PERFORMANCE_WORD[fact.relative_performance]}${fact.comparison_label} ${fact.magnitude_pp.toFixed(1)}pp`;
};

/** Direction re-export (so callers can use this module alone). */
export type { Direction, DirectionalFact };
