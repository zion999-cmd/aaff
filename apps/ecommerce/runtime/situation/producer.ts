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
import { detectSituations } from './rules.js';
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
  skipped: number;
  /** situationIds actually inserted this run (for P0010.1 automatic investigation). */
  createdIds: string[];
  situations: Situation[];
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
): StoreDailyObservation[] => {
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

  const observations: StoreDailyObservation[] = [];
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

  observations.sort((a, b) => a.date.localeCompare(b.date));
  return observations;
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
  const storeDaily = loadStoreDailyFromEvidence(platform, shopId);

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

  // 4. Persist (dedup via deterministic situationId + INSERT OR IGNORE).
  const insert = db.prepare(
    `INSERT OR IGNORE INTO situations (
       situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
       observed_at, window_start, window_end, description, tags, lifecycle, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  );

  let created = 0;
  let skipped = 0;
  const createdIds: string[] = [];
  const now = nowIso();
  const persist = db.transaction((rows: readonly Situation[]) => {
    for (const s of rows) {
      const parsed = SituationSchema.safeParse(s);
      if (!parsed.success) continue; // defensive — builders always produce valid Situations
      const info = insert.run(
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
      );
      if (info.changes > 0) { created++; createdIds.push(s.situationId); } else skipped++;
    }
  });
  persist(situations);

  return { created, skipped, createdIds, situations };
};
