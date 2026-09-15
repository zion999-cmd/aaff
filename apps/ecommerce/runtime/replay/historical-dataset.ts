// P0013 Phase 2 — Historical Dataset loader.
//
// P0013 §6 (Raw Historical Data Is Immutable) + §35 (do NOT reopen P0011.x
// acquisition). This module READS the on-disk P0011.x JSON files and returns
// a frozen, typed object. It never writes, never acquires, never falls back
// to mock. The ONLY way to get a HistoricalDataset is from disk; the ONLY
// way to be sure the source is real is the manifest hash recorded on the
// returned object (Phase 1 stores it on replay_runs.source_manifest_hash).
//
// Boundaries:
//   - rootPath MUST be an absolute path to a P0011.x acquisition root.
//   - All 4 canonical files are required. Missing → fail closed.
//   - Returned object is deeply frozen (Object.freeze) so consumers cannot
//     accidentally mutate the dataset through the loader.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ProvenanceManifestSchema,
  TradeOverviewSummarySchema,
  TrendPerDaySchema,
  OrderDetailPerDaySummarySchema,
  OrderDetailRowSchema,
  type ProvenanceManifest,
  type TradeOverviewSummary,
  type TrendPerDay,
  type OrderDetailPerDaySummary,
  type OrderDetailRow,
} from '#shared/contracts/historical-dataset.js';

/** Public error type — callers can `instanceof` to distinguish from generic Error. */
export class HistoricalDatasetContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoricalDatasetContractError';
  }
}

export interface HistoricalShop {
  readonly shopId: string;
  readonly shopName: string;
}

export interface HistoricalWindow {
  readonly start: string;
  readonly end: string;
  readonly days: number;
}

/**
 * Per-business-date Evidence Contract status.
 *
 * A Replay business date is COVERED only when the frozen acquisition can
 * actually answer for that day. Presence in the trend x-axis alone is NOT
 * coverage: the source can emit a date whose value is null (no finalized
 * snapshot) and a per-day order aggregate of zeros with no rows behind it.
 * Replay must not run cognition on such a day — it is an Evidence Gap.
 */
export interface BusinessDateCoverage {
  readonly businessDate: string;
  readonly covered: boolean;
  /** Machine-readable reasons the date is NOT covered (empty when covered). */
  readonly reasons: readonly string[];
}

export interface HistoricalCoverage {
  readonly start: string;
  readonly end: string;
  readonly days: number;
  readonly missingBusinessDates: readonly string[];
  /** Per-date Evidence Contract status for every day in the window. */
  readonly byBusinessDate: readonly BusinessDateCoverage[];
}

/** Own-shop GMV field carried by each trend row (source series). */
const TREND_OWN_GMV_FIELD = 'jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot';

export interface HistoricalOrderDetails {
  readonly perDay: Readonly<Record<string, { readonly orders: number; readonly qty: number; readonly amt: number }>>;
  readonly rows: readonly OrderDetailRow[];
}

export interface HistoricalTradeOverview {
  readonly decoded: TradeOverviewSummary;
}

export interface HistoricalDataset {
  readonly rootPath: string;
  readonly manifestHash: string;
  readonly shop: HistoricalShop;
  readonly window: HistoricalWindow;
  readonly tradeOverview: HistoricalTradeOverview;
  readonly trend: TrendPerDay;
  readonly orderDetails: HistoricalOrderDetails;
  readonly coverage: HistoricalCoverage;
}

const CANONICAL_FILES = [
  'PROVENANCE_MANIFEST.json',
  'target_a_summary_decoded.json',
  'target_a_trend_parsed.json',
  'target_b_order_detail_summary.json',
  'target_b_order_detail_parsed.json',
] as const;

const readJson = <T>(
  rootPath: string,
  file: string,
  parse: (raw: unknown) => T,
): T => {
  const full = join(rootPath, file);
  let raw: string;
  try {
    raw = readFileSync(full, 'utf8');
  } catch (err: unknown) {
    throw new HistoricalDatasetContractError(
      `Historical dataset missing canonical file: ${full} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new HistoricalDatasetContractError(
      `Historical dataset file is not valid JSON: ${full} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return parse(parsed);
};

const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

/** Generate every YYYY-MM-DD between two YYYY-MM-DD strings (inclusive). */
const enumerateDays = (start: string, end: string): string[] => {
  const [sy, sm, sd] = start.split('-').map((n) => Number.parseInt(n, 10));
  const [ey, em, ed] = end.split('-').map((n) => Number.parseInt(n, 10));
  const a = Date.UTC(sy, sm - 1, sd);
  const b = Date.UTC(ey, em - 1, ed);
  if (a > b) return [];
  const out: string[] = [];
  for (let t = a; t <= b; t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

/** Deep-freeze (one level + nested plain objects/arrays). */
const deepFreeze = <T>(obj: T): T => {
  Object.freeze(obj);
  for (const v of Object.values(obj as unknown as Record<string, unknown>)) {
    if (v && (typeof v === 'object') && !Object.isFrozen(v)) {
      deepFreeze(v);
    }
  }
  return obj;
};

/**
 * Dates the acquisition itself declared as evidence gaps (manifest `gaps[]`).
 * The frozen manifest is the acquisition's own per-date evidence statement,
 * so it is authoritative where present. Datasets written before this field
 * existed simply contribute nothing here.
 */
const readDeclaredGapDates = (manifest: ProvenanceManifest): ReadonlySet<string> => {
  const raw = (manifest as unknown as Record<string, unknown>)['gaps'];
  if (!Array.isArray(raw)) return new Set<string>();
  const dates = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const date = (entry as Record<string, unknown>)['date'];
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
  }
  return dates;
};

/**
 * Evidence Contract predicate per business date (pure).
 *
 * A date is COVERED iff the frozen dataset can answer for it:
 *   1. the trend has a row for the date AND — when the dataset carries the
 *      own-shop GMV series at all — the value is a finite number. A null
 *      among numeric values means the source had no finalized data for that
 *      day: the date sits in the x-axis but carries no evidence. Datasets
 *      whose trend rows do not carry that series at all (minimal fixtures)
 *      fall back to row presence, so a narrower shape is not mass-flagged;
 *   2. the order per-day aggregate exists for the date;
 *   3. the acquisition did not declare an evidence gap for the date.
 *
 * Deliberately NOT a criterion: zero orders / zero amount. A genuinely
 * zero-business day is a real fact; only a missing source value or an
 * acquisition-declared gap makes a date uncoverable.
 */
const computeDateCoverage = (args: {
  readonly allDays: readonly string[];
  readonly trend: TrendPerDay;
  readonly perDay: Readonly<Record<string, { readonly orders: number; readonly qty: number; readonly amt: number }>>;
  readonly declaredGapDates: ReadonlySet<string>;
}): BusinessDateCoverage[] => {
  const { allDays, trend, perDay, declaredGapDates } = args;
  const trendRowByDate = new Map<string, Record<string, unknown>>();
  for (const row of trend.rows) {
    trendRowByDate.set(row.date, row as unknown as Record<string, unknown>);
  }
  const xaxisDates = new Set<string>(trend.xaxis);
  // Strictness only applies when the dataset actually carries the series.
  const carriesOwnGmvSeries = trend.rows.some((row) =>
    Object.prototype.hasOwnProperty.call(row, TREND_OWN_GMV_FIELD),
  );

  return allDays.map((date) => {
    const reasons: string[] = [];
    const row = trendRowByDate.get(date);
    if (!xaxisDates.has(date) || row === undefined) {
      reasons.push('trend_row_absent');
    } else if (carriesOwnGmvSeries) {
      const ownGmv = row[TREND_OWN_GMV_FIELD];
      if (typeof ownGmv !== 'number' || !Number.isFinite(ownGmv)) {
        reasons.push('trend_value_missing');
      }
    }
    if (!(date in perDay)) {
      reasons.push('per_day_summary_absent');
    }
    if (declaredGapDates.has(date)) {
      reasons.push('declared_evidence_gap');
    }
    return {
      businessDate: date,
      covered: reasons.length === 0,
      reasons: Object.freeze(reasons),
    };
  });
};

/**
 * Look up the Evidence Contract status of ONE business date.
 * Returns `null` when the date is outside the dataset window (the caller
 * decides whether that is a No-Future-Leak or a No-Past-Coverage error).
 */
export const businessDateCoverageOf = (
  dataset: HistoricalDataset,
  businessDate: string,
): BusinessDateCoverage | null =>
  dataset.coverage.byBusinessDate.find((c) => c.businessDate === businessDate) ?? null;

/**
 * Load a Historical Dataset from an on-disk P0011.x root path.
 *
 * @param rootPath  Absolute path to the P0011.x acquisition root (the directory
 *                 that contains `PROVENANCE_MANIFEST.json`).
 * @returns        A frozen `HistoricalDataset`.
 * @throws         `HistoricalDatasetContractError` on any parse / contract failure.
 */
export const loadHistoricalDataset = (rootPath: string): HistoricalDataset => {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new HistoricalDatasetContractError('rootPath must be a non-empty string');
  }

  // Manifest must be read raw (so we can hash it byte-for-byte) AND parsed
  // through the Zod schema. The two reads share a single file read.
  const manifestFullPath = join(rootPath, CANONICAL_FILES[0]);
  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(manifestFullPath, 'utf8');
  } catch (err: unknown) {
    throw new HistoricalDatasetContractError(
      `Historical dataset missing canonical file: ${manifestFullPath} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const manifestHash = sha256(manifestRaw);

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (err: unknown) {
    throw new HistoricalDatasetContractError(
      `PROVENANCE_MANIFEST.json is not valid JSON: ${manifestFullPath} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const manifestParse = ProvenanceManifestSchema.safeParse(manifestJson);
  if (!manifestParse.success) {
    throw new HistoricalDatasetContractError(
      `PROVENANCE_MANIFEST.json fails contract: ${manifestParse.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const manifest: ProvenanceManifest = manifestParse.data;

  // 4 canonical data files. Each one fails closed on contract violation.
  const tradeOverview: TradeOverviewSummary = readJson(
    rootPath,
    CANONICAL_FILES[1],
    (raw) => {
      const r = TradeOverviewSummarySchema.safeParse(raw);
      if (!r.success) {
        throw new HistoricalDatasetContractError(
          `target_a_summary_decoded.json fails contract: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      return r.data;
    },
  );
  const trend: TrendPerDay = readJson(
    rootPath,
    CANONICAL_FILES[2],
    (raw) => {
      const r = TrendPerDaySchema.safeParse(raw);
      if (!r.success) {
        throw new HistoricalDatasetContractError(
          `target_a_trend_parsed.json fails contract: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      return r.data;
    },
  );
  const orderDetailSummary: OrderDetailPerDaySummary = readJson(
    rootPath,
    CANONICAL_FILES[3],
    (raw) => {
      const r = OrderDetailPerDaySummarySchema.safeParse(raw);
      if (!r.success) {
        throw new HistoricalDatasetContractError(
          `target_b_order_detail_summary.json fails contract: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      return r.data;
    },
  );
  const orderDetailRows: readonly OrderDetailRow[] = readJson(
    rootPath,
    CANONICAL_FILES[4],
    (raw) => {
      if (!Array.isArray(raw)) {
        throw new HistoricalDatasetContractError(
          `target_b_order_detail_parsed.json must be an array (got ${typeof raw})`,
        );
      }
      const out: OrderDetailRow[] = [];
      for (let i = 0; i < raw.length; i += 1) {
        const r = OrderDetailRowSchema.safeParse(raw[i]);
        if (!r.success) {
          throw new HistoricalDatasetContractError(
            `target_b_order_detail_parsed.json row ${i} fails contract: ${r.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join('; ')}`,
          );
        }
        out.push(r.data);
      }
      return out;
    },
  );

  const perDay: Record<string, { orders: number; qty: number; amt: number }> = {};
  for (const entry of orderDetailSummary.per_day) {
    const [date, agg] = entry;
    perDay[date] = { orders: agg.orders, qty: agg.qty, amt: agg.amt };
  }

  const allDays = enumerateDays(manifest.time_window.start, manifest.time_window.end);
  const byBusinessDate = computeDateCoverage({
    allDays,
    trend,
    perDay,
    declaredGapDates: readDeclaredGapDates(manifest),
  });
  const missingBusinessDates = byBusinessDate
    .filter((c) => !c.covered)
    .map((c) => c.businessDate);

  const shop: HistoricalShop = { shopId: manifest.shop.shop_id, shopName: manifest.shop.shop_name };
  const window: HistoricalWindow = {
    start: manifest.time_window.start,
    end: manifest.time_window.end,
    days: manifest.time_window.days,
  };
  const coverage: HistoricalCoverage = {
    start: window.start,
    end: window.end,
    days: window.days,
    missingBusinessDates,
    byBusinessDate,
  };

  const dataset: HistoricalDataset = {
    rootPath,
    manifestHash,
    shop,
    window,
    tradeOverview: { decoded: tradeOverview },
    trend,
    orderDetails: { perDay, rows: orderDetailRows },
    coverage,
  };
  return deepFreeze(dataset);
};
