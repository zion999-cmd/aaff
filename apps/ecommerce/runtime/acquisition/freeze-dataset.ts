// P0013.1 — Historical dataset freezer.
//
// The executing agent delivers an intake (4 canonical files + raw
// artifacts + result.json). Fabric validates the intake against the
// existing canonical Zod contracts, re-derives the actual window from
// the files (never relabelling to the request), runs a business
// reconciliation gate, machine-emits the provenance manifest with
// per-file hashes, and only then publishes a catalog-discoverable
// frozen dataset. A failed gate freezes NOTHING.
//
// This is the Dataset Productization component that the P0013 upstream
// audit found MISSING: the 2026-09-03 manifest was hand-authored.

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { z } from 'zod';
import {
  TradeOverviewSummarySchema,
  TrendPerDaySchema,
  OrderDetailPerDaySummarySchema,
  OrderDetailRowSchema,
} from '#shared/contracts/historical-dataset.js';
import type { HistoricalEvidenceNeed } from '#shared/contracts/historical-evidence-need.js';
import type { HistoricalEvidenceResult } from '#shared/contracts/historical-evidence-result.js';
import { loadHistoricalDataset } from '../replay/historical-dataset.js';
import { enumerateYmd } from './evidence-gap.js';

export class FreezeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreezeValidationError';
  }
}

export class ReconciliationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationMismatchError';
  }
}

const CANONICAL_FILES = {
  summary: 'target_a_summary_decoded.json',
  trend: 'target_a_trend_parsed.json',
  orderSummary: 'target_b_order_detail_summary.json',
  orderRows: 'target_b_order_detail_parsed.json',
} as const;

type CanonicalName = (typeof CANONICAL_FILES)[keyof typeof CANONICAL_FILES];

const RECONCILE_TOLERANCE = 1; // ¥1 rounding tolerance
const MANIFEST_NAME = 'PROVENANCE_MANIFEST.json';

export interface FreezeInput {
  readonly dataRoot: string;
  readonly intakeDir: string;
  readonly need: HistoricalEvidenceNeed;
  readonly result: HistoricalEvidenceResult;
  readonly jobId: string;
  readonly candidateId?: string;
  readonly clock?: () => Date;
  /** Truthful note about turn lifecycle anomalies (e.g. lost completion event). */
  readonly turnNote?: string;
}

export interface FreezeOutcome {
  readonly datasetDir: string;
  readonly datasetDirName: string;
  readonly manifestHash: string;
  readonly actualWindow: {
    readonly start: string;
    readonly end: string;
    readonly days: number;
    readonly missingDates: readonly string[];
  };
  readonly gateReport: {
    readonly ordersGmv: number;
    readonly tradeGmv: number | null;
    readonly headerOrders: number;
    readonly childRows: number;
    readonly orphanChildren: number;
    readonly checks: readonly string[];
  };
}

const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

const readJson = (path: string, label: string): unknown => {
  if (!existsSync(path)) {
    throw new FreezeValidationError(`intake ${label} not found: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new FreezeValidationError(
      `intake ${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

const parseOrThrow = <T>(schema: z.ZodType<T>, raw: unknown, label: string): T => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new FreezeValidationError(`intake ${label} fails contract: ${parsed.error.message}`);
  }
  return parsed.data;
};

/** Beijing-local YYYYMMDD_HHMM for the dataset directory name. */
const beijingStamp = (d: Date): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}_${get('hour')}${get('minute')}`;
};

const findGmv = (kpis: Record<string, { value: number }>): number | null => {
  const found = Object.entries(kpis).find(([k]) => k.startsWith('GMV'));
  return found ? found[1].value : null;
};

export const freezeHistoricalDataset = (input: FreezeInput): FreezeOutcome => {
  const clock = input.clock ?? (() => new Date());
  const tmpDir = join(input.dataRoot, `.freeze-${input.jobId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
  let created = false;
  try {
    // ── 1. Load + validate the four canonical intake files ─────────────
    const art = input.result.artifacts;
    const expectedPaths: ReadonlyArray<[CanonicalName, string]> = [
      [CANONICAL_FILES.summary, art.summary],
      [CANONICAL_FILES.trend, art.trend],
      [CANONICAL_FILES.orderSummary, art.order_summary],
      [CANONICAL_FILES.orderRows, art.order_rows],
    ];
    const bodies: Record<CanonicalName, string> = {} as Record<CanonicalName, string>;
    for (const [canonical, rel] of expectedPaths) {
      const abs = resolve(input.intakeDir, rel);
      if (canonical !== basename(rel)) {
        throw new FreezeValidationError(
          `artifact ${canonical} must be delivered under that canonical name (got ${rel})`,
        );
      }
      bodies[canonical] = JSON.stringify(readJson(abs, canonical));
    }
    const summary = parseOrThrow(
      TradeOverviewSummarySchema,
      JSON.parse(bodies[CANONICAL_FILES.summary]),
      CANONICAL_FILES.summary,
    );
    const trend = parseOrThrow(
      TrendPerDaySchema,
      JSON.parse(bodies[CANONICAL_FILES.trend]),
      CANONICAL_FILES.trend,
    );
    const orderSummary = parseOrThrow(
      OrderDetailPerDaySummarySchema,
      JSON.parse(bodies[CANONICAL_FILES.orderSummary]),
      CANONICAL_FILES.orderSummary,
    );
    const orderRows = parseOrThrow(
      z.array(OrderDetailRowSchema),
      JSON.parse(bodies[CANONICAL_FILES.orderRows]),
      CANONICAL_FILES.orderRows,
    );

    // ── 2. Re-derive actual window FROM THE FILES ──────────────────────
    const trendDates = new Set(trend.xaxis);
    const perDayDates = new Set(orderSummary.per_day.map(([d]) => d));
    const allDates = new Set<string>([...trendDates, ...perDayDates]);
    if (allDates.size === 0) {
      throw new FreezeValidationError('intake contains no trade and no order dates');
    }
    const sorted = [...allDates].sort();
    const derivedStart = sorted[0] as string;
    const derivedEnd = sorted[sorted.length - 1] as string;
    const windowDates = enumerateYmd(derivedStart, derivedEnd);
    const missingDates = windowDates.filter((d) => !trendDates.has(d) || !perDayDates.has(d));

    const claimed = input.result.actual_window;
    if (
      (claimed.start !== null && claimed.start !== derivedStart) ||
      (claimed.end !== null && claimed.end !== derivedEnd) ||
      JSON.stringify([...claimed.missing_dates].sort()) !== JSON.stringify([...missingDates].sort())
    ) {
      throw new FreezeValidationError(
        `result.actual_window ${claimed.start}..${claimed.end} missing=${claimed.missing_dates.join(',')} ` +
          `contradicts files-derived ${derivedStart}..${derivedEnd} missing=${missingDates.join(',')}`,
      );
    }
    for (const row of orderRows) {
      if (row.biz_date < derivedStart || row.biz_date > derivedEnd) {
        throw new FreezeValidationError(
          `order row ${row.order_id} biz_date ${row.biz_date} outside actual window`,
        );
      }
    }

    // ── 3. Business reconciliation gate ────────────────────────────────
    const ordersGmv = round2(orderSummary.per_day.reduce((s, [, v]) => s + v.amt, 0));
    const headerRows = orderRows.filter((r) => r.row_kind === 'header');
    const childRows = orderRows.filter((r) => r.row_kind === 'child');
    const headerIds = new Set(headerRows.map((r) => r.order_id));
    const orphanChildren = childRows.filter((r) => !headerIds.has(r.order_id)).length;
    const headerOrderGmv = round2(headerRows.reduce((s, r) => s + r.ord_amt, 0));
    const perDayOrderCount = orderSummary.per_day.reduce((s, [, v]) => s + v.orders, 0);

    const checks: string[] = [];
    if (Math.abs(headerOrderGmv - ordersGmv) > RECONCILE_TOLERANCE) {
      throw new ReconciliationMismatchError(
        `header rows GMV ${headerOrderGmv} != per-day order GMV ${ordersGmv}`,
      );
    }
    checks.push('header_rows_gmv == per_day_order_gmv');
    if (headerIds.size !== perDayOrderCount) {
      throw new ReconciliationMismatchError(
        `unique header orders ${headerIds.size} != per_day orders sum ${perDayOrderCount}`,
      );
    }
    checks.push('unique_header_orders == per_day_orders_sum');
    if (orphanChildren !== 0) {
      throw new ReconciliationMismatchError(`${orphanChildren} child rows have no parent header`);
    }
    checks.push('zero_orphan_child_rows');

    const tradeGmv = findGmv(summary.all_kpis_readable);
    if (tradeGmv !== null && ordersGmv > 0 && Math.abs(tradeGmv - ordersGmv) > RECONCILE_TOLERANCE) {
      throw new ReconciliationMismatchError(
        `trade GMV ${tradeGmv} != orders GMV ${ordersGmv} (delta ${round2(tradeGmv - ordersGmv)})`,
      );
    }
    if (tradeGmv !== null) checks.push('trade_gmv == orders_gmv');

    // ── 4. Assemble frozen dataset in a temp dir, then publish ─────────
    mkdirSync(tmpDir, { recursive: true });
    created = true;
    for (const [canonical, rel] of expectedPaths) {
      copyFileSync(resolve(input.intakeDir, rel), join(tmpDir, canonical));
    }
    for (const rel of input.result.artifacts.raw) {
      const src = resolve(input.intakeDir, rel);
      if (!existsSync(src)) {
        throw new FreezeValidationError(`declared raw artifact missing: ${rel}`);
      }
      const dest = join(tmpDir, 'raw', basename(rel));
      mkdirSync(join(tmpDir, 'raw'), { recursive: true });
      copyFileSync(src, dest);
    }
    // Keep the Evidence Contract result alongside the frozen data.
    writeFileSync(join(tmpDir, 'acquisition_result.json'), JSON.stringify(input.result, null, 2));

    const now = clock();
    const fileHashes: Record<string, string> = {};
    for (const canonical of Object.values(CANONICAL_FILES) as CanonicalName[]) {
      fileHashes[canonical] = sha256(bodies[canonical]);
    }
    const manifest = {
      manifest_version: '2.0',
      acquired_at: now.toISOString(),
      acquisition_run_id: input.jobId,
      shop: {
        shop_id: input.need.subject.shopId,
        shop_name: input.need.subject.shopName,
      },
      time_window: {
        start: derivedStart,
        end: derivedEnd,
        days: windowDates.length,
        label: 'p0013.1_dynamic_historical_acquisition',
      },
      requested_window: {
        start: input.result.requested_window.start,
        end: input.result.requested_window.end,
      },
      source_system: input.result.provenance.source_system,
      source_surfaces: input.result.provenance.source_surfaces,
      acquisition_method: input.result.provenance.acquisition_method,
      source_acquired_at: input.result.provenance.acquired_at,
      domains: input.result.domains,
      gaps: input.result.gaps,
      reconciliation: {
        orders_gmv: ordersGmv,
        trade_gmv: tradeGmv,
        matches: tradeGmv === null ? null : Math.abs(tradeGmv - ordersGmv) <= RECONCILE_TOLERANCE,
      },
      file_hashes: fileHashes,
      candidate_id: input.candidateId ?? null,
      ...(input.turnNote ? { turn_note: input.turnNote } : {}),
      generated_by: 'agentfabric-historical-freezer/1.0',
    };
    writeFileSync(join(tmpDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));

    const stamp = beijingStamp(now);
    let finalName = `jd_acquisition_${stamp}`;
    if (existsSync(join(input.dataRoot, finalName))) {
      finalName = `${finalName}_${input.jobId.slice(-6)}`;
    }
    const finalDir = join(input.dataRoot, finalName);
    renameSync(tmpDir, finalDir);
    created = false;

    // ── 5. Roundtrip through the fail-closed loader ────────────────────
    const loaded = loadHistoricalDataset(finalDir);
    return {
      datasetDir: finalDir,
      datasetDirName: finalName,
      manifestHash: loaded.manifestHash,
      actualWindow: {
        start: derivedStart,
        end: derivedEnd,
        days: windowDates.length,
        missingDates,
      },
      gateReport: {
        ordersGmv,
        tradeGmv,
        headerOrders: headerIds.size,
        childRows: childRows.length,
        orphanChildren,
        checks,
      },
    };
  } finally {
    if (created) rmSync(tmpDir, { recursive: true, force: true });
  }
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
