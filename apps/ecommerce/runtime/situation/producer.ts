// P0009.1 — Situation Producer.
// Bridges existing runtime outputs (Evidence / Rankings) into Situations.
//
// Responsibilities (strictly one-way):
//   detect → construct → persist
//
// The producer consumes already-persisted Evidence (P0010.2.10) and Rankings.
// It NEVER triggers acquisition (no CDP), and NEVER calls a model (no LLM/Hermes).
// Lifecycle stays P0007: persisted as 'open'; human interaction / outcomes advance it.
//
// P0010.2.10 — daily observations are now derived from Evidence, not Signals.
// Signals were unable to distinguish the OLD `summary` data from P0010.2.9's
// NEW `getSummary` data, could not filter by acquisition_method, and lost
// the business_date → acquired_at relationship. Evidence is the only object
// in the system that records both the data_type (which endpoint was hit)
// and the acquisition_method (cdp / mock / import-agentcms / unknown), so
// the producer uses it as the source of truth.

import type { Database as Db } from 'better-sqlite3';
import type { Situation } from '#shared/schemas/learning-context.js';
import { SituationSchema } from '#shared/schemas/learning-context.js';
import type { RankingProfileName } from '#shared/schemas/ranking.js';
import { RankingFacade } from '#app/analysis/decision/facade.js';
import { listProducts } from '#platform/storage/product-repository.js';
import { nowIso } from '#shared/utils/time.js';
import { readFileSync } from 'node:fs';
import { listEvidence } from '#app/connectors/evidence/store.js';
import { parseJdSummary } from '#app/connectors/jd/parsers/index.js';
import { buildMeaningfulChangeDescription, detectSituations } from './rules.js';
import type { StoreDailyObservation } from './rules.js';

export interface SituationProducerOptions {
  /** Store entity id (matches the shop_id used by the runtime pipeline). */
  shopId: string;
  /** Store display name (business language). */
  shopName?: string;
  /** Platform (default 'jd'). */
  platform?: string;
  /** Business domain (default 'ecommerce'). */
  domain?: string;
  /** Ranking profile to consume for ranking attention. */
  rankingProfile?: RankingProfileName;
}

export interface SituationRunResult {
  created: number;
  refreshed: number;
  skipped: number;
  /** situationIds actually inserted this run (for P0010.1 automatic investigation). */
  createdIds: string[];
  situations: Situation[];
}

/**
 * Latest-projection facts for one Situation (P0010.2.11 fact refresh).
 *
 * Computed from the latest Evidence + the same-time ##compareValue baseline
 * (ADR-077) for the corresponding metric. Stored on `situations` and refreshed
 * on every producer run so the Workspace always shows the freshest numbers
 * for a stable deterministic situation_id (identity is preserved; only the
 * "current observation" changes).
 */
interface SituationLatestFacts {
  currentValue: number;
  baselineValue: number;
  changePct: number;
  evidenceId: string;
  acquiredAt: string;
  contentHash: string;
}

const DEFAULT_SHOP_NAME = '京东店铺';
const DEFAULT_PLATFORM = 'jd';
const DEFAULT_DOMAIN = 'ecommerce';
const DEFAULT_RANKING_PROFILE = 'operator_mode';

// ---- P0010.2.10: Evidence-based daily observation loading ----
//
// The "today vs yesterday" comparison is the heart of Situations. To make
// it correct, we MUST use Evidence — Signals cannot distinguish:
//
//   1. data_type ('getSummary' vs 'summary') — different endpoints, different
//      values. P0010.2.9 introduced getSummary; the old summary endpoint is
//      still on disk and must NOT be used for trade.overview comparisons.
//   2. acquisition_method ('cdp' vs 'mock') — production Situations must
//      use real acquired data, never synthetic mocks.
//   3. business_date vs acquired_at — an Evidence row whose `acquired_at`
//      is on 8/28 may actually represent business_date 8/27 (the page was
//      queried at 23:55 for "yesterday"). Only Evidence carries both fields.
//
// Grouping rule (per user 2026-08-28 spec):
//   • Group Evidence by business_date (NOT by acquired_at).
//   • For each business_date, pick the latest by acquired_at.
//   • Drop anything with acquisition_method != 'cdp' (no mocks in production).
//   • Only consider data_type === 'getSummary' (P0010.2.9's shop-level
//     realtime endpoint — the page's own view).

/** The 4 trade.overview metrics, in the canonical names rules.ts expects. */
const TRADE_OVERVIEW_METRICS = ['gmv', 'orders', 'uv', 'cvr'] as const;

/** Previous UTC calendar day of a YYYY-MM-DD string. */
const previousCalendarDay = (date: string): string => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Load store-level daily observations for the trade.overview 4-metric
 * "today vs yesterday" comparison.
 *
 * - One observation per business_date.
 * - Within a business_date, multiple Evidence rows are collapsed by
 *   `latest acquired_at` (so the freshest CDP read wins).
 * - Only `data_type === 'getSummary'` Evidence qualifies — the old
 *   `summary` endpoint is not comparable.
 * - Only `acquisition_method === 'cdp'` Evidence qualifies — production
 *   Situations must not be built on mock data.
 *
 * Returns observations sorted ASC by business_date. Caller is responsible
 * for the "adjacent dates only" check (rules.ts enforces it).
 */
const loadStoreDailyFromEvidence = (
  platform: string,
  shopId: string,
): { observations: StoreDailyObservation[]; rawEvidence: ReturnType<typeof listEvidence> } => {
  const all = listEvidence({
    source: platform,
    shopId,
    dataType: 'getSummary',
    limit: 1000,
  });

  // Group by business_date, keep only cdp-acquired Evidence.
  const byDate = new Map<string, typeof all>();
  for (const ev of all) {
    if (ev.metadata.acquisition_method !== 'cdp') continue;
    const date = ev.metadata.business_date;
    const list = byDate.get(date) ?? [];
    list.push(ev);
    byDate.set(date, list);
  }

  let observations: StoreDailyObservation[] = [];
  // Parsed summaries keyed by business_date — kept so the C2 baseline pass
  // below can read the LATEST payload's ##compareValue fields.
  const parsedByDate = new Map<string, ReturnType<typeof parseJdSummary>>();
  for (const [date, evs] of byDate.entries()) {
    // Latest by acquired_at wins. ISO-8601 sorts lexicographically; if
    // two have identical acquired_at (rare), tie-break by file_path so
    // the result is deterministic.
    evs.sort((a, b) => {
      const t = b.metadata.acquired_at.localeCompare(a.metadata.acquired_at);
      if (t !== 0) return t;
      return a.file_path.localeCompare(b.file_path);
    });
    const latest = evs[0]!;

    let data: unknown;
    try {
      data = JSON.parse(readFileSync(latest.file_path, 'utf-8'));
    } catch {
      // Unreadable evidence file — skip this business_date entirely
      // rather than emit a half-built observation.
      continue;
    }
    if (!Array.isArray(data)) continue;

    const summary = parseJdSummary(data as unknown[]);
    parsedByDate.set(date, summary);

    // Map JdSummary's canonical names to the rules.ts vocabulary
    // (uv ← shop_visitors, cvr ← shop_conversion_rate per P0010.2.9).
    const metrics: Record<string, number> = {};
    metrics['gmv'] = summary.gmv;
    metrics['orders'] = summary.orders;
    metrics['uv'] = summary.shop_visitors;
    metrics['cvr'] = summary.shop_conversion_rate;

    // Sanity: skip dates where any of the 4 trade.overview metrics is
    // missing or zero — a half-empty observation cannot produce a
    // meaningful "today vs yesterday" comparison.
    const allPresent = TRADE_OVERVIEW_METRICS.every((k) => Number.isFinite(metrics[k]));
    if (!allPresent) continue;

    observations.push({ date, metrics });
  }

  // P0010 — Realtime Situation same-time baseline enforcement.
  //
  // The canonical today-vs-yesterday baseline is the SAME getSummary
  // response's ##compareValue (yesterday same-moment), NOT a real
  // previous-day observation: that evidence's acquisition window may not
  // align with today's (e.g. today 08:20 vs yesterday 16:00) — calendar
  // adjacency ≠ window alignment. The previous-day observation is therefore
  // unconditionally dropped; when the latest payload has no ##compareValue,
  // no aligned comparison exists → honest silence (no today Situation).
  const latest = observations[observations.length - 1];
  if (latest) {
    const prevDate = previousCalendarDay(latest.date);
    const summary = parsedByDate.get(latest.date);
    let baseline: Record<string, number> | null = null;
    if (summary) {
      const candidate: Record<string, number> = {
        gmv: summary.gmv_compare_value ?? Number.NaN,
        orders: summary.orders_compare_value ?? Number.NaN,
        uv: summary.shop_visitors_compare_value ?? Number.NaN,
        cvr: summary.shop_conversion_rate_compare_value ?? Number.NaN,
      };
      if (TRADE_OVERVIEW_METRICS.every((k) => Number.isFinite(candidate[k]))) {
        baseline = candidate;
      }
    }
    observations = observations.filter((o) => o.date !== prevDate);
    if (baseline) observations.push({ date: prevDate, metrics: baseline });
  }

  observations.sort((a, b) => a.date.localeCompare(b.date));
  return { observations, rawEvidence: all };
};

/**
 * Run the Situation Producer against persisted data. Idempotent — re-running
 * within the same observation window dedupes via deterministic situation ids.
 */
export const runSituationProducer = (db: Db, options: SituationProducerOptions): SituationRunResult => {
  const shopId = options.shopId;
  const shopName = options.shopName ?? DEFAULT_SHOP_NAME;
  const platform = options.platform ?? DEFAULT_PLATFORM;
  const domain = options.domain ?? DEFAULT_DOMAIN;
  const rankingProfile = options.rankingProfile ?? DEFAULT_RANKING_PROFILE;

  // 1. Load store daily observations from Evidence (P0010.2.10).
  //    getSummary + cdp only; latest by acquired_at within business_date.
  //    Also keep the raw evidence list so the fact-refresh persist can
  //    record the latest evidence id / acquired_at / content_hash for each
  //    Situation.
  const { observations: storeDaily, rawEvidence: all } = loadStoreDailyFromEvidence(platform, shopId);

  // 2. Load rankings + product names (for ranking-attention detection).
  const rankings = RankingFacade.load(db, rankingProfile);
  const productNames: Record<string, string> = {};
  for (const p of listProducts(db)) productNames[p.product_id] = p.name || p.product_id;

  // 3. Detect (pure, deterministic). Rules.ts enforces the "adjacent
  //    calendar day" check on the latest/previous pair.
  const situations = detectSituations({
    shop: { id: shopId, name: shopName, platform, domain },
    storeDaily,
    rankings,
    productNames,
  });

  // 4. Persist (P0010.2.11 fact refresh).
  //
  // Phase A — refresh EVERY existing `meaningful_change` situation's
  // `latest_*` projection + description from the freshest evidence,
  // independent of `detectSituations`'s threshold-based emit. Without this,
  // a Situation whose daily delta has cooled below threshold (e.g. uv
  // changed from +28.7% to +10.97%) would never refresh its facts and
  // the Workspace would keep showing a stale observation. Identity columns
  // (type, window_start, tags, lifecycle) are not touched.
  //
  // Phase B — `detectSituations` may emit NEW candidate situations this
  // tick; for those, INSERT (or UPDATE if the deterministic id already
  // exists). The candidate persist also writes the latest_* projection,
  // so the Phase A refresh and Phase B insert are idempotent on overlapping
  // situation_ids (Phase A ran first, Phase B sees an existing row →
  // UPDATE; the UPDATE overwrites the same latest_* columns with the
  // same latest evidence so the final state is consistent).
  const insert = db.prepare(
    `INSERT INTO situations (
       situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
       observed_at, window_start, window_end, description, tags, lifecycle,
       created_at, updated_at,
       latest_current_value, latest_baseline_value, latest_change_pct,
       latest_evidence_id, latest_evidence_acquired_at, latest_evidence_content_hash
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?,
       ?, ?, ?, ?, ?, ?
     )`,
  );
  const refresh = db.prepare(
    `UPDATE situations SET
       description = ?,
       updated_at = ?,
       latest_current_value = ?,
       latest_baseline_value = ?,
       latest_change_pct = ?,
       latest_evidence_id = ?,
       latest_evidence_acquired_at = ?,
       latest_evidence_content_hash = ?
     WHERE situation_id = ?`,
  );
  const exists = db.prepare('SELECT 1 FROM situations WHERE situation_id = ?');

  let created = 0;
  let refreshed = 0;
  const createdIds: string[] = [];
  const now = nowIso();
  // Map each freshly-detected Situation to the latest evidence that produced
  // its current value, so we can store the evidence id / acquired_at /
  // content_hash alongside the latest facts. The evidence list is the same
  // collection `loadStoreDailyFromEvidence` used (deduped to one per
  // business_date, latest acquired_at wins). We use the latest evidence for
  // the *current* business_date — the same data the description's
  // "today realtime" half is drawn from.
  const latestEvidenceForCurrentDate = (date: string) => {
    const evs = all.filter(
      (e) => e.metadata.acquisition_method === 'cdp' && e.metadata.business_date === date,
    );
    evs.sort((a, b) => b.metadata.acquired_at.localeCompare(a.metadata.acquired_at));
    return evs[0] ?? null;
  };
  // Pure: compute latest-projection facts from a metric + the freshest
  // storeDaily pair (latest realtime vs ##compareValue-synthesized
  // baseline — ADR-077). No coupling to Situation input — usable by both
  // Phase A (refresh existing) and Phase B (persist candidates).
  const computeLatestFacts = (metric: string): SituationLatestFacts | null => {
    if (!['gmv', 'orders', 'uv', 'cvr'].includes(metric)) return null;
    const latest = storeDaily[storeDaily.length - 1];
    const previous = storeDaily[storeDaily.length - 2];
    if (!latest || !previous) return null; // no comparison partner yet
    const cur = latest.metrics[metric];
    const prev = previous.metrics[metric];
    if (cur === undefined || prev === undefined) return null;
    if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
    const ev = latestEvidenceForCurrentDate(latest.date);
    if (!ev) return null;
    return {
      currentValue: cur,
      baselineValue: prev,
      changePct: ((cur - prev) / prev) * 100,
      evidenceId: ev.evidence_id,
      acquiredAt: ev.metadata.acquired_at,
      contentHash: ev.metadata.content_hash,
    };
  };
  // Build a refreshed description for an existing meaningful_change
  // situation: depends only on the metric, the latest storeDaily pair,
  // and the situation's shop. Used in Phase A where we don't have a
  // freshly-detected Situation object (current change may be below
  // threshold but the Workspace must still show the latest numbers).
  const buildRefreshedDescription = (
    metric: string,
    shopName: string,
  ): string | null => {
    const latest = storeDaily[storeDaily.length - 1];
    const previous = storeDaily[storeDaily.length - 2];
    if (!latest || !previous) return null;
    return buildMeaningfulChangeDescription(
      { id: shopId, name: shopName, platform: 'jd', domain: 'ecommerce' },
      metric,
      previous.metrics[metric]!,
      latest.metrics[metric]!,
    );
  };

  // Phase A — refresh facts for every open `meaningful_change` situation,
  // independent of `detectSituations` emit (handles metrics whose daily
  // change has cooled below threshold — uv at +10.97%, etc.).
  const existingRefresh = db.prepare(
    `SELECT situation_id, tags FROM situations
       WHERE lifecycle = 'open' AND description LIKE '%较昨日%'`,
  );
  let refreshedByPhaseA = 0;
  const phaseA = db.transaction(() => {
    for (const row of existingRefresh.all() as Array<{ situation_id: string; tags: string }>) {
      let tagList: string[] = [];
      try {
        tagList = JSON.parse(row.tags) as string[];
      } catch {
        continue;
      }
      const metric = tagList.find((t) => ['gmv', 'orders', 'uv', 'cvr'].includes(t));
      if (!metric) continue; // cross_signal / ranking_attention: no numeric metric to refresh
      const facts = computeLatestFacts(metric);
      if (!facts) continue;
      const description = buildRefreshedDescription(metric, shopName);
      if (!description) continue;
      refresh.run(
        description,
        now,
        facts.currentValue,
        facts.baselineValue,
        facts.changePct,
        facts.evidenceId,
        facts.acquiredAt,
        facts.contentHash,
        row.situation_id,
      );
      refreshedByPhaseA++;
    }
  });
  phaseA();

  // Phase B — detectSituations emits NEW candidate situations; persist
  // (INSERT for new, UPDATE for existing). The fact columns written here
  // match the same latest evidence Phase A already used, so the
  // candidate-row UPDATE just overwrites with the same values.
  const persist = db.transaction((rows: readonly Situation[]) => {
    for (const s of rows) {
      const parsed = SituationSchema.safeParse(s);
      if (!parsed.success) continue; // defensive — builders always produce valid Situations
      // `s.tags` is a `string[]` produced by detectSituations — search it
      // directly. JSON.parse would throw on an array and the fact-builder
      // would silently fall through to null-facts (debug trap).
      const tagList: string[] = Array.isArray(s.tags) ? (s.tags as string[]) : [];
      const metric = tagList.find((t) => ['gmv', 'orders', 'uv', 'cvr'].includes(t));
      const facts = metric ? computeLatestFacts(metric) : null;
      if (exists.get(s.situationId)) {
        refresh.run(
          s.description,
          now,
          facts?.currentValue ?? null,
          facts?.baselineValue ?? null,
          facts?.changePct ?? null,
          facts?.evidenceId ?? null,
          facts?.acquiredAt ?? null,
          facts?.contentHash ?? null,
          s.situationId,
        );
        refreshed++;
      } else {
        insert.run(
          s.situationId,
          s.domain,
          s.type,
          s.entity.id,
          s.entity.type,
          s.entity.name ?? null,
          s.entity.platform ?? null,
          s.temporal.observedAt,
          s.temporal.windowStart ?? null,
          s.temporal.windowEnd ?? null,
          s.description,
          JSON.stringify(s.tags ?? []),
          now,
          now,
          facts?.currentValue ?? null,
          facts?.baselineValue ?? null,
          facts?.changePct ?? null,
          facts?.evidenceId ?? null,
          facts?.acquiredAt ?? null,
          facts?.contentHash ?? null,
        );
        created++;
        createdIds.push(s.situationId);
      }
    }
  });
  persist(situations);

  // `refreshed` counts Phase A only — the Phase B UPDATE branch writes the
  // same `latest_*` projection for candidates that were already refreshed
  // by Phase A, so adding them would double-count the same row.
  return { created, refreshed: refreshedByPhaseA, skipped: 0, createdIds, situations };
};
