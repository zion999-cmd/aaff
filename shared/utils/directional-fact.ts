// Evidence Semantic Integrity — Directional Fact Contract (Phase B).
//
// The Agent (Hermes) reasons about business changes. When Fabric feeds it
// "GMV 回落 -44.6%" the LLM sees a double negative ("回落" already says
// decrease, and "-44.6%" is signed negative) and the truth is ambiguous:
// is the change -44.6% or +44.6%? The same data expressed differently
// produces different downstream judgments.
//
// This module pins the semantic contract: every "change vs baseline" fact
// is decomposed into a structured object with EXACTLY ONE of three
// directions (increase / decrease / flat) and a signed delta that is NEVER
// combined with a contradictory direction word in prose.
//
// Mathematical representation (for arithmetic / sort / threshold / persist):
//   delta_pct_signed = (current - previous) / previous * 100   // e.g. -44.6
//
// Semantic representation (for LLM-facing / human-facing prose):
//   direction = "decrease"      // enum, not a word
//   magnitude_pct = 44.6        // ALWAYS abs(delta_pct_signed)
//
// Prose generator (the ONLY allowed format):
//   "从 10609.95 下降至 5875，降幅 44.6%"
//   "从 5875 上升至 10609.95，涨幅 44.6%"
//   "较基准持平（约 X.Y%）"      // flat case
//
// Forbidden prose patterns (asserted by unit tests):
//   "下降 -44.6%"   // direction word + signed pct
//   "回落 -44.6%"   // direction word + signed pct
//   "下跌 -44.6%"   // direction word + signed pct
//   "减少 -44.6%"   // direction word + signed pct
//   "下降 44.6%"   // word OK if pct is magnitude (positive), but our
//                  // formatter's "降幅 44.6%" pattern is canonical
//                  // because it pairs the magnitude with a UNIQUE word
//                  // ("降幅" only ever means "decrease magnitude"),
//                  // whereas "下降" can also appear in non-pct context
//
// "Normalize representation, never normalize truth" — the signed delta is
// preserved in the structured payload; only the prose is normalized.

import { safeDivide } from './math.js';

/**
 * Categorical direction. Decoupled from the sign of delta_pct_signed so
 * downstream code can switch on a single enum without re-deriving the
 * sign from a float. `flat` is the only case where the magnitude is
 * near-zero (within `eps_pct` of 0); see computeDirectionalFact.
 */
export type Direction = 'increase' | 'decrease' | 'flat';

/**
 * Where did `previous_value` come from? Pinned here so the LLM can
 * distinguish "yesterday same time" (the canonical realtime baseline
 * per ADR-077) from "yesterday full day" (a different reading) from
 * "industry / market" (a different entity entirely).
 */
export type BaselineSource =
  | 'yesterday_same_moment' // ##compareValue from the same getSummary call
  | 'previous_day_full' // persisted day-vs-day from storeDaily
  | 'prior_window' // rolling N-day window
  | 'industry_indicator' // shop vs market comparison
  | 'product_vs_category'; // product within its category

/**
 * The structured Directional Fact — the single source of truth for any
 * "X changed vs Y" claim that crosses the Fabric → Agent boundary.
 */
export interface DirectionalFact {
  /** The value being reported. */
  readonly current_value: number;
  /** The comparison baseline. */
  readonly previous_value: number;
  /** Signed absolute delta (current - previous). E.g. -4734.95. */
  readonly delta_signed: number;
  /** Signed percentage delta. (current - previous) / previous * 100, rounded to 1dp. */
  readonly delta_pct_signed: number;
  /** Unsigned magnitude. abs(delta_pct_signed), used for prose ("降幅 44.6%"). */
  readonly magnitude_pct: number;
  /** Categorical direction (enum). Decoupled from sign of delta_pct_signed. */
  readonly direction: Direction;
  /** Human-readable label of what is being compared (e.g. "昨日同时段", "上周同日"). */
  readonly comparison_base: string;
  /** Period covered by `current_value` (e.g. "今日 10:00 时段", "2026-08-04 全天"). */
  readonly observation_window: string;
  /** Provenance tag for the baseline. */
  readonly baseline_source: BaselineSource;
}

/** Direction label mapping. Used by `formatDirectionalFact` and the
 *  downstream formatter layer. The two PCT words ("降幅" / "涨幅") are
 *  reserved for pct magnitude prose; the two ACTION words ("下降" / "上升")
 *  are reserved for the "从 A 下降至 B" prose. They never appear together
 *  with a signed number. */
export const DIRECTION_PCT_WORD: Readonly<Record<Direction, string>> = Object.freeze({
  increase: '涨幅',
  decrease: '降幅',
  flat: '幅度',
});

export const DIRECTION_ACTION_WORD: Readonly<Record<Direction, string>> = Object.freeze({
  increase: '上升',
  decrease: '下降',
  flat: '持平',
});

/**
 * Default epsilon for `flat` classification. |delta_pct_signed| <= eps_pct
 * is treated as flat. 0.05 means movements smaller than 0.05% are
 * statistically noise and reported as "持平"; the operator can still see
 * the signed delta if they drill in.
 *
 * 0.05 matches `directionByDelta` in `apps/ecommerce/analysis/metrics/
 * calculators/direction.ts:9-13` so the workspace chip color and the
 * prose direction are aligned.
 */
export const DEFAULT_FLAT_EPS_PCT = 0.05;

/**
 * Compute a DirectionalFact. Returns `null` when the comparison is
 * undefined (previous is 0 or non-finite). The caller decides whether
 * to surface a "no comparison" sentinel or omit the fact entirely.
 */
export const computeDirectionalFact = (args: {
  readonly current: number;
  readonly previous: number;
  readonly comparison_base: string;
  readonly observation_window: string;
  readonly baseline_source: BaselineSource;
  /** Epsilon for flat. Default 0.05 (matches directionByDelta). */
  readonly eps_pct?: number;
}): DirectionalFact | null => {
  const { current, previous, comparison_base, observation_window, baseline_source } = args;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  const eps = args.eps_pct ?? DEFAULT_FLAT_EPS_PCT;
  const ratio = (current - previous) / previous;
  const delta_pct_signed = Math.round(ratio * 1000) / 10; // round to 1 dp
  const magnitude_pct = Math.abs(delta_pct_signed);
  const direction: Direction =
    magnitude_pct <= eps ? 'flat' : delta_pct_signed > 0 ? 'increase' : 'decrease';
  const delta_signed = Math.round((current - previous) * 100) / 100; // round to 2dp
  return {
    current_value: current,
    previous_value: previous,
    delta_signed,
    delta_pct_signed,
    magnitude_pct,
    direction,
    comparison_base,
    observation_window,
    baseline_source,
  };
};

/**
 * Round a number for prose display. The directional contract uses 1dp
 * for pct values and 2dp for absolute currency. Callers can override via
 * the `value_formatter` option.
 */
export const defaultValueFormatter = (v: number, metric?: string): string => {
  if (metric === 'gmv' || metric === 'price') return `¥${v.toFixed(2)}`;
  if (metric === 'cvr' || metric === 'rate') return `${(v * 100).toFixed(1)}%`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
};

/** Format options for prose rendering. */
export interface FormatDirectionalFactOptions {
  /** Optional metric label, e.g. "GMV" / "成交金额". */
  readonly metric_label?: string;
  /** Optional value formatter. Defaults to defaultValueFormatter. */
  readonly value_formatter?: (v: number) => string;
  /** Optional metric key passed to defaultValueFormatter when value_formatter is absent. */
  readonly metric?: string;
}

/**
 * Format a DirectionalFact as the canonical prose line. The output is
 * guaranteed to be free of the forbidden patterns
 * ("<direction_word> <signed_number>%"):
 *
 *   increase: "GMV 从 ¥5875.00 上升至 ¥10609.95，涨幅 71.8%"
 *              (the "从 A 上升至 B" + "涨幅 X%" pattern — the only
 *               sign of increase is the verb "上升至" + the magnitude
 *               word "涨幅"; the magnitude is always positive)
 *
 *   decrease: "GMV 从 ¥10609.95 下降至 ¥5875.00，降幅 44.6%"
 *
 *   flat:     "GMV 较昨日持平（幅度 0.02%）"
 *
 * The signed number is NEVER combined with a direction word in this
 * formatter's output. The signed delta is preserved in the structured
 * `DirectionalFact` payload for arithmetic consumers; the prose is
 * normalized.
 */
export const formatDirectionalFact = (
  fact: DirectionalFact,
  options: FormatDirectionalFactOptions = {},
): string => {
  const fmt = options.value_formatter ?? ((v: number) => defaultValueFormatter(v, options.metric));
  const label = options.metric_label ? `${options.metric_label} ` : '';
  const prevStr = fmt(fact.previous_value);
  const curStr = fmt(fact.current_value);
  if (fact.direction === 'flat') {
    return `${label}较${fact.comparison_base}持平（${DIRECTION_PCT_WORD.flat} ${fact.magnitude_pct.toFixed(1)}%）`;
  }
  if (fact.direction === 'increase') {
    return `${label}从 ${prevStr} ${DIRECTION_ACTION_WORD.increase}至 ${curStr}，${DIRECTION_PCT_WORD.increase} ${fact.magnitude_pct.toFixed(1)}%`;
  }
  // decrease
  return `${label}从 ${prevStr} ${DIRECTION_ACTION_WORD.decrease}至 ${curStr}，${DIRECTION_PCT_WORD.decrease} ${fact.magnitude_pct.toFixed(1)}%`;
};

/**
 * Format a DirectionalFact as a SHORTER one-liner suitable for a card
 * title or a feed entry. Drops the "从 A 至 B" half; just the
 * direction + magnitude.
 *
 *   "GMV 下降 44.6%"            (decrease)
 *   "GMV 上升 71.8%"            (increase)
 *   "GMV 较昨日持平（约 0.02%）"  (flat)
 */
export const formatDirectionalFactShort = (
  fact: DirectionalFact,
  options: FormatDirectionalFactOptions = {},
): string => {
  const label = options.metric_label ? `${options.metric_label} ` : '';
  if (fact.direction === 'flat') {
    return `${label}较${fact.comparison_base}${DIRECTION_ACTION_WORD.flat}（约 ${fact.magnitude_pct.toFixed(1)}%）`;
  }
  return `${label}${DIRECTION_ACTION_WORD[fact.direction]} ${fact.magnitude_pct.toFixed(1)}%`;
};

/**
 * Internal: number formatting for the signed delta. Kept here so the
 * math layer (math.ts) stays free of business formatting concerns.
 * Exported only for use by `relative-performance.ts` — most callers
 * should use `formatDirectionalFact` instead.
 */
export const formatSignedDeltaPct = (v: number): string => {
  // Two decimals when the magnitude is < 1 (so a 0.03% move is visible),
  // one decimal otherwise. Sign is always present in the string form.
  const abs = Math.abs(v);
  const dp = abs < 1 ? 2 : 1;
  const body = abs.toFixed(dp);
  return v >= 0 ? `+${body}%` : `-${body}%`;
};

/**
 * Convert a signed pct to a clean unsigned magnitude string. The
 * "magnitude" word is reserved for prose paired with DIRECTION_PCT_WORD
 * (涨幅/降幅/幅度) — it should NEVER appear with a sign character.
 */
export const formatMagnitudePct = (v: number, dp: 1 | 2 = 1): string =>
  `${Math.abs(v).toFixed(dp)}%`;

// Re-export safeDivide for the RelativePerformance module's convenience
// (avoids a redundant import in that file).
export { safeDivide };
