// P0009.1 — Situation detection rules.
// Pure, deterministic, side-effect-free. No DB, no IO, no LLM, no acquisition.
//
// Consumes existing runtime outputs (Signals / Rankings) and produces Situation
// candidates that conform to the P0007 SituationSchema contract.
//
// A Situation is a "business attention object" — what happened, on which entity,
// when. It is NOT a task, an action, or an attribution. Descriptions state the
// observed change and never invent causes or prescribe actions.

import type { Situation } from '#shared/schemas/learning-context.js';
import type { RankingResult } from '#shared/schemas/ranking.js';
import { fingerprint } from '#shared/utils/crypto.js';

export type DetectionKind = 'meaningful_change' | 'ranking_attention' | 'cross_signal';
export type ChangeDirection = 'up' | 'down';

/** A single day of store-level summary metrics (derived from a daily_summary signal). */
export interface StoreDailyObservation {
  /** Business observation date (YYYY-MM-DD). */
  date: string;
  /** Canonical metric bundle — e.g. { gmv, orders, uv, cvr }. */
  metrics: Record<string, number>;
}

/** The store entity a Situation is anchored to. */
export interface ShopRef {
  id: string;
  name: string;
  platform: string;
  domain: string;
}

export interface DetectSituationsInput {
  shop: ShopRef;
  /** Store daily summary observations, sorted ascending by date. */
  storeDaily: readonly StoreDailyObservation[];
  /** Product rankings (profile results) for ranking-attention detection. */
  rankings: readonly RankingResult[];
  /** product entity_id → display name (for ranking-attention descriptions). */
  productNames: Record<string, string>;
  /** Relative-change threshold (default 0.2 = 20%). */
  changeThreshold?: number;
}

const DEFAULT_CHANGE_THRESHOLD = 0.2;
const RANKING_TOP_K = 3;
const RANKING_LEAD_GAP = 0.1;

// ---- Business metric vocabulary (ecommerce domain language) ----

const METRIC_META: Record<string, { label: string; format: (v: number) => string }> = {
  gmv: { label: '成交金额', format: (v) => `¥${v.toFixed(2)}` },
  orders: { label: '订单量', format: (v) => String(Math.round(v)) },
  uv: { label: '访客数', format: (v) => String(Math.round(v)) },
  cvr: { label: '转化率', format: (v) => `${(v * 100).toFixed(1)}%` },
};

/** Metrics the first version detects store-level changes for. */
const DETECTED_METRICS: readonly string[] = ['gmv', 'orders', 'uv', 'cvr'];

const DIRECTION_WORD: Record<ChangeDirection, string> = { up: '上升', down: '下降' };

/**
 * Build a "meaningful change" description for a single metric pair — used by
 * the fact-refresh path to keep Situation descriptions in sync with the
 * latest evidence, independent of `detectSituations` (which only emits when
 * the metric change crosses the threshold). Keeps the Workspace current
 * even for metrics whose daily delta has cooled below threshold.
 */
export const buildMeaningfulChangeDescription = (
  shop: ShopRef,
  metric: string,
  prev: number,
  cur: number,
): string | null => {
  const meta = METRIC_META[metric];
  if (!meta) return null;
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev === 0) return null;
  const ratio = (cur - prev) / prev;
  const direction: ChangeDirection = ratio > 0 ? 'up' : 'down';
  const pct = (Math.abs(ratio) * 100).toFixed(1);
  return `${shop.name} ${meta.label} 较昨日${DIRECTION_WORD[direction]} ${pct}%，从 ${meta.format(prev)} 变为 ${meta.format(cur)}。`;
};

// ---- Adjacent-date check (P0010.2.10) ----
//
// P0010.2.10: the "today vs yesterday" comparison is only valid when
// latest.date and previous.date are ADJACENT calendar days. If we only
// have 8/26 + 8/28 (no 8/27 evidence), we MUST NOT hardcode a "较昨日"
// label — the operator sees "yesterday" as 8/27, not 8/26. The previous
// index-based logic ([length-2]) would silently mislabel a 2-day gap
// as "yesterday" — that's exactly the bug this slice fixes.
//
// `nextCalendarDay` returns true if `b` is the day immediately after `a`
// (handles month/year boundaries via Date arithmetic, not string parsing).

const nextCalendarDay = (a: string, b: string): boolean => {
  const da = new Date(`${a}T00:00:00Z`);
  const db = new Date(`${b}T00:00:00Z`);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  const dayMs = 86_400_000;
  // Compare UTC day numbers to avoid DST/TZ drift in `Date.getTime()`.
  const diffDays = Math.round((db.getTime() - da.getTime()) / dayMs);
  return diffDays === 1;
};

// ---- Change computation ----

interface MetricChange {
  metric: string;
  direction: ChangeDirection;
  /** (current - previous) / previous. */
  ratio: number;
  current: number;
  previous: number;
}

/** Compute a relative change between two metric values. Null when undefined. */
const computeChange = (current: number | undefined, previous: number | undefined): { direction: ChangeDirection; ratio: number } | null => {
  if (current === undefined || previous === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  const ratio = (current - previous) / previous;
  if (ratio === 0) return null;
  return { direction: ratio > 0 ? 'up' : 'down', ratio };
};

// ---- Identity / dedup ----

/** Deterministic situation id from the dedup key (kind + entity + subject + window). */
const buildSituationId = (parts: {
  kind: string;
  entityType: string;
  entityId: string;
  subject: string;
  window: string;
}): string => `sit_${fingerprint({ v: 1, ...parts }).slice(0, 20)}`;

// ---- Situation builders ----

const buildMeaningfulChange = (shop: ShopRef, c: MetricChange, window: string, previousDate: string): Situation => {
  const meta = METRIC_META[c.metric];
  const label = meta?.label ?? c.metric;
  const pct = (Math.abs(c.ratio) * 100).toFixed(1);
  const prevStr = meta ? meta.format(c.previous) : String(c.previous);
  const curStr = meta ? meta.format(c.current) : String(c.current);

  return {
    situationId: buildSituationId({
      kind: 'meaningful_change',
      entityType: 'shop',
      entityId: shop.id,
      subject: c.metric,
      window,
    }),
    domain: shop.domain,
    type: c.direction === 'down' ? 'anomaly_investigation' : 'performance_analysis',
    entity: { id: shop.id, type: 'shop', name: shop.name, platform: shop.platform },
    temporal: { observedAt: window, windowStart: previousDate, windowEnd: window },
    description: `${shop.name} ${label} 较昨日${DIRECTION_WORD[c.direction]} ${pct}%，从 ${prevStr} 变为 ${curStr}。`,
    tags: ['meaningful_change', c.metric, c.direction],
  };
};

const buildCrossSignal = (
  shop: ShopRef,
  uvChange: MetricChange,
  cvrChange: MetricChange,
  window: string,
  previousDate: string,
): Situation => {
  const uvLabel = METRIC_META.uv?.label ?? 'uv';
  const cvrLabel = METRIC_META.cvr?.label ?? 'cvr';
  const uvPct = (Math.abs(uvChange.ratio) * 100).toFixed(1);
  const cvrPct = (Math.abs(cvrChange.ratio) * 100).toFixed(1);

  return {
    situationId: buildSituationId({
      kind: 'cross_signal',
      entityType: 'shop',
      entityId: shop.id,
      subject: 'uv_cvr',
      window,
    }),
    domain: shop.domain,
    type: 'anomaly_investigation',
    entity: { id: shop.id, type: 'shop', name: shop.name, platform: shop.platform },
    temporal: { observedAt: window, windowStart: previousDate, windowEnd: window },
    description: `${shop.name} 访客数与转化率走势相反：${uvLabel}${DIRECTION_WORD[uvChange.direction]} ${uvPct}%，${cvrLabel}${DIRECTION_WORD[cvrChange.direction]} ${cvrPct}%。`,
    tags: ['cross_signal', 'uv', 'cvr'],
  };
};

const buildRankingAttention = (
  shop: ShopRef,
  r: RankingResult,
  window: string,
  productNames: Record<string, string>,
): Situation => {
  // P0010.1: do NOT use the product id as the display name. If the catalog
  // either has no entry, or its stored name is the id itself (no real human-
  // friendly name was ever captured), fall back to an empty string. The
  // Situation row then has entity_name=null; the Workspace renders this
  // honestly as "未知商品 · SKU <id>" instead of pretending the id is a name.
  const candidate = productNames[r.entity_id];
  const name = candidate && candidate !== r.entity_id ? candidate : '';
  return {
    situationId: buildSituationId({
      kind: 'ranking_attention',
      entityType: 'product',
      entityId: r.entity_id,
      subject: 'overall_score',
      window,
    }),
    domain: shop.domain,
    type: 'performance_analysis',
    entity: { id: r.entity_id, type: 'product', name, platform: shop.platform },
    temporal: { observedAt: window },
    description: `${name || `未知商品(SKU ${r.entity_id})`} 近期经营表现相对突出，进入持续观察名单 — 待 Agent 调查后给出判断。`,
    tags: ['ranking_attention', 'product', 'leader'],
  };
};

// ---- Ranking attention detection ----

/** Products distinctly ahead of the pack (top-K with a lead gap). Empty when tied. */
const detectRankingAttention = (
  shop: ShopRef,
  rankings: readonly RankingResult[],
  productNames: Record<string, string>,
): Situation[] => {
  if (rankings.length <= RANKING_TOP_K) return [];

  const sorted = [...rankings].sort((a, b) => b.overall_score - a.overall_score);
  const nextScore = sorted[RANKING_TOP_K]!.overall_score;
  const leaders = sorted
    .slice(0, RANKING_TOP_K)
    .filter((r) => r.overall_score - nextScore >= RANKING_LEAD_GAP);

  const window = sorted.map((r) => r.ranked_at.slice(0, 10)).sort().pop() ?? '';
  if (!window) return [];

  // P0010.2.5 PREVENTION: skip products with no real catalog name.
  //
  // The previous loop generated one ranking_attention Situation per
  // unknown-SKU leader per day. After 5 days, the same two products
  // (10072459317818, 10072459153406 — never had a real name in the
  // catalog) had accumulated 10 stale situations that carried no
  // business meaning. The fingerprint includes the date, so each day
  // produced a new ID — INSERT OR IGNORE could not dedup them.
  //
  // The fix: only emit ranking_attention when the product has a real
  // catalog name. Unknown-SKU "leaders" are not a real business signal;
  // they are ranking noise from the test fixture. If a real catalog
  // entry appears later, the situation will be generated from that day
  // onward.
  return leaders
    .filter((r) => {
      const candidate = productNames[r.entity_id];
      return candidate !== undefined && candidate !== '' && candidate !== r.entity_id;
    })
    .map((r) => buildRankingAttention(shop, r, window, productNames));
};

// ---- Top-level detection ----

/**
 * Detect Situations from existing store daily signals + product rankings.
 * Deterministic: identical input produces identical output (including situationIds).
 */
export const detectSituations = (input: DetectSituationsInput): Situation[] => {
  const threshold = input.changeThreshold ?? DEFAULT_CHANGE_THRESHOLD;
  const situations: Situation[] = [];

  // A + C need at least two daily observations (latest vs prior day).
  // P0010.2.10: AND the two observations must be ADJACENT calendar days.
  // If 8/27 is missing, the [length-2] entry is 8/26 — but the operator
  // calls 8/27 "yesterday", so labeling a 2-day gap as "较昨日" is wrong.
  if (input.storeDaily.length >= 2) {
    const latest = input.storeDaily[input.storeDaily.length - 1]!;
    const previous = input.storeDaily[input.storeDaily.length - 2]!;
    const adjacent = nextCalendarDay(previous.date, latest.date);
    if (adjacent) {
      const window = latest.date;

      const changes: MetricChange[] = [];
      for (const metric of DETECTED_METRICS) {
        const change = computeChange(latest.metrics[metric], previous.metrics[metric]);
        if (change && Math.abs(change.ratio) >= threshold) {
          changes.push({ metric, ...change, current: latest.metrics[metric]!, previous: previous.metrics[metric]! });
        }
      }

      // A. Meaningful change — one Situation per changed metric.
      for (const c of changes) {
        situations.push(buildMeaningfulChange(input.shop, c, window, previous.date));
      }

      // C. Cross-signal attention — traffic & conversion move in opposite directions.
      const uvChange = changes.find((c) => c.metric === 'uv');
      const cvrChange = changes.find((c) => c.metric === 'cvr');
      if (uvChange && cvrChange && uvChange.direction !== cvrChange.direction) {
        situations.push(buildCrossSignal(input.shop, uvChange, cvrChange, window, previous.date));
      }
    }
  }

  // B. Ranking attention — products distinctly ahead of the pack.
  situations.push(...detectRankingAttention(input.shop, input.rankings, input.productNames));

  return situations;
};
