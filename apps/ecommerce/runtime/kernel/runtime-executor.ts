// Runtime Executor — unified execution pipeline with signal + evidence hooks.
// P0005.5: Fixes G4+G5 — converges the binding executor + processDay into ONE pipeline.
// P0005.6.1: Adds executeLiveCDPPipeline + executeImportPipeline — all business logic
//            lives inside the kernel, never in CLI.
//
// The existing executePlan() handles acquisition. This runtime executor wraps it and adds:
//   - Normalizer resolution (via normalizer-resolver)
//   - Signal generation (via signal-engine)
//   - Evidence capture (via evidence-orchestrator)
//
// Single unified pipeline: Plan → Acquire → Parse → Normalize → Signal → Evidence

import { readFileSync } from 'node:fs';
import type { Database as Db } from 'better-sqlite3';
import type { EnterpriseSignal } from '#shared/schemas/signal.js';
import type { BoundCapabilityModel } from '#app/connectors/binding/types.js';
import type { AcquireFunction } from '#app/connectors/binding/executor.js';
import { executePlan } from '#app/connectors/binding/executor.js';
import { buildExecutionPlan } from '#app/connectors/binding/planner.js';
import { parseJdPayload } from '#app/connectors/jd/parsers/index.js';
import type { ParsedJdData } from '#app/connectors/jd/parsers/index.js';
import { beijingDate } from '#shared/utils/time.js';
import { INDICATOR_OVERRIDES } from '#app/connectors/jd/parsers/indicator-map.js';
import { acquireJdData } from '#app/connectors/jd/acquisition/index.js';
import { saveEvidence } from '#app/connectors/evidence/store.js';
import { normalizeSignal } from '#app/connectors/normalizer.js';
import { SignalFacade } from '#app/analysis/metrics/facade.js';
import { buildSpecFromBlueprint } from './runtime-normalizer-resolver.js';
import { generateSignals } from './runtime-signal-engine.js';
import type { SignalGenerationResult } from './runtime-signal-engine.js';
import { captureEvidence } from './runtime-evidence-orchestrator.js';
import type { EvidenceCaptureResult } from './runtime-evidence-orchestrator.js';

// ---- Types ----

export interface RuntimeExecuteOptions {
  shopId: string;
  date?: string;
  mock?: boolean;
  /** Optional capability filter (e.g. ['daily_summary']) */
  capabilities?: string[];
  /** Shop display name */
  shopName?: string;
  /** Original data acquisition method (P0006.3.2.1). Overrides mock flag inference. */
  acquisitionMethod?: string;
  /** Processing context: 'runtime' | 'replay' (P0006.3.2.1). */
  processingMethod?: string;
}

export interface RuntimeExecuteResult {
  success: boolean;
  platform: string;
  shopId: string;
  date: string;
  /** Raw acquired data keyed by endpoint */
  acquired: Record<string, unknown>;
  /** Parsed JD business data */
  parsed: ParsedJdData | null;
  /** Generated enterprise signals */
  signals: EnterpriseSignal[];
  /** Evidence capture results */
  evidence: EvidenceCaptureResult[];
  /** Errors encountered during execution */
  errors: string[];
  /** True if execution was blueprint-driven */
  blueprintDriven: boolean;
}

// ---- Execute ----

/**
 * Execute the full runtime pipeline for one day:
 *   Plan → Acquire → Parse → Normalize → Signal → Evidence
 *
 * This is the single unified runtime path that replaces both executePlan() (binding)
 * and processDay() (CLI legacy). All business decisions flow from the blueprint.
 */
export const executeRuntimePipeline = async (
  blueprint: BoundCapabilityModel,
  acquireFn: AcquireFunction,
  db: Db,
  options: RuntimeExecuteOptions,
): Promise<RuntimeExecuteResult> => {
  const {
    shopId,
    date,
    mock,
    capabilities,
    shopName = '京东店铺',
    acquisitionMethod,
    processingMethod = 'runtime',
  } = options;

  // P0010.2.11 C2 — default the execution/business date to the BEIJING
  // calendar day (Asia/Shanghai), not UTC. JD 商智 realtime payloads describe
  // the Beijing business day; a UTC stamp mislabels everything acquired
  // before 08:00 Beijing (e.g. 8/28T23:58Z → Beijing 8/29 was stamped 8/28).
  // Explicit `date` (historical walk / replay) still wins.
  const executionDate = date ?? beijingDate();
  const errors: string[] = [];
  const blueprintDriven = true;

  try {
    // Step 1: Build execution plan from blueprint
    const planOpts: { capabilities?: string[]; gateway_base?: string } = {};
    if (capabilities && capabilities.length > 0) planOpts.capabilities = capabilities;
    const plan = buildExecutionPlan(blueprint, planOpts);

    // Step 2: Execute acquisition via binding executor
    const execOpts: { shopId: string; date: string; mock?: boolean } = {
      shopId,
      date: executionDate,
    };
    if (mock !== undefined) execOpts.mock = mock;
    const execResult = await executePlan(plan, acquireFn, execOpts);

    if (!execResult.success) {
      return {
        success: false,
        platform: blueprint.platform,
        shopId,
        date: executionDate,
        acquired: execResult.acquired,
        parsed: null,
        signals: [],
        evidence: [],
        errors: execResult.errors,
        blueprintDriven,
      };
    }

    // Step 3: Parse JD data — build a ParsedJdData from the acquired raw payloads.
    // The acquireFn returns data keyed by endpoint name. We pass the combined
    // payload to parseJdPayload which expects { summary, trend, productTop } shape.
    const parsed = parseAcquiredData(execResult.acquired, executionDate);

    // Step 4: Build normalizer spec from blueprint's normalizer_plan + INDICATOR_OVERRIDES
    const normalizerSpec = buildSpecFromBlueprint(
      blueprint.normalizer_plan,
      INDICATOR_OVERRIDES,
    );

    // Step 5: Generate signals from parsed data, driven by blueprint signal_types
    const signalResult: SignalGenerationResult = parsed
      ? generateSignals(db, parsed, {
          platform: blueprint.platform,
          shopId,
          shopName,
          date: executionDate,
          signalTypes: blueprint.manifest.signal_types,
          normalizerSpec,
          rawPayload: execResult.acquired,
        })
      : { signals: [], signalCount: 0 };

    // Step 6: Capture evidence, driven by blueprint evidence_strategy
    const acqMethod = (acquisitionMethod ?? (mock ? 'mock' : 'cdp')) as 'cdp' | 'mock' | 'import-agentcms' | 'unknown';
    const evidenceResults = captureEvidence(
      blueprint.platform,
      shopId,
      executionDate,
      execResult.acquired,
      blueprint.evidence_strategy.capture_rules,
      acqMethod,
      processingMethod as 'runtime' | 'replay' | 'import' | 'none',
    );

    return {
      success: true,
      platform: blueprint.platform,
      shopId,
      date: executionDate,
      acquired: execResult.acquired,
      parsed,
      signals: signalResult.signals,
      evidence: evidenceResults,
      errors,
      blueprintDriven,
    };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Unknown runtime execution error');
    return {
      success: false,
      platform: blueprint.platform,
      shopId,
      date: executionDate,
      acquired: {},
      parsed: null,
      signals: [],
      evidence: [],
      errors,
      blueprintDriven,
    };
  }
};

/**
 * Parse acquired raw payloads into ParsedJdData.
 *
 * The acquireFn returns data keyed by endpoint name (e.g. "summary.ajax").
 * JD's parseJdPayload expects { date, summary, trend, productTop } shape.
 * We flatten endpoint-keyed data into the flat shape the parser expects.
 */
const parseAcquiredData = (
  acquired: Record<string, unknown>,
  executionDate: string,
): ParsedJdData | null => {
  // Build the raw payload in the shape parseJdPayload expects
  const raw: Record<string, unknown> = { date: executionDate };

  // Try to map endpoint-keyed data to the expected keys.
  // Endpoints like "summary.ajax" → "summary", "trend.ajax" → "trend", etc.
  // P0010.2.9: the trade.overview page-driven path uses the page's own
  // apiNames — `getSummary` and `getTrend` — so we treat them as the new
  // canonical names for `summary` / `trend` payload. The legacy
  // `summary`/`trend` names from the snapshot endpoint are still accepted.
  // Evidence store data comes as single objects; the parser expects arrays.
  for (const [endpoint, data] of Object.entries(acquired)) {
    const base = endpoint.replace(/\.(ajax|json|html?)$/, '');
    // Wrap single objects in arrays — the parser iterates arrays of JdApiResponse.
    const wrapped = Array.isArray(data) ? data : [data];
    if (base === 'summary' || base === 'trend' || base === 'productTop') {
      raw[base] = wrapped;
    } else if (base === 'getSummary' || base === 'getTrend') {
      // P0010.2.9: page-driven trade overview. Map to the same shape the
      // parser expects (summary / trend).
      const key = base === 'getSummary' ? 'summary' : 'trend';
      raw[key] = wrapped;
    } else if (base.includes('product') || base.includes('top')) {
      raw['productTop'] = wrapped;
    } else if (base.includes('trend') || base.includes('hourly')) {
      raw['trend'] = wrapped;
    } else {
      // Unknown endpoint — store under its own name
      raw[endpoint] = data;
    }
  }

  // If we don't have at least summary data, return null
  if (!raw['summary'] && !raw['trend']) return null;

  try {
    return parseJdPayload(raw);
  } catch {
    return null;
  }
};

// ---- Live CDP Pipeline (P0005.6.1) ----

export interface RuntimeLiveCDPOptions {
  shopId: string;
  fromDate: string;
  toDate: string;
  cdpPort?: number;
}

export interface RuntimeLiveCDPDayResult {
  date: string;
  signals: number;
  evidence: number;
  parsed: ParsedJdData | null;
  error?: string;
}

export interface RuntimeLiveCDPResult {
  success: boolean;
  totalSignals: number;
  totalEvidence: number;
  days: number;
  results: RuntimeLiveCDPDayResult[];
  errors: string[];
}

/**
 * Execute multi-day live CDP acquisition through the kernel.
 *
 * Captures all days in ONE Chrome CDP session (optimization), then processes
 * each day through the signal engine + evidence orchestrator.
 *
 * This replaces the CLI's direct acquireJdData() + manual signal/evidence loop.
 */
export const executeLiveCDPPipeline = async (
  blueprint: BoundCapabilityModel,
  db: Db,
  options: RuntimeLiveCDPOptions,
): Promise<RuntimeLiveCDPResult> => {
  const { shopId, fromDate, toDate, cdpPort = 9222 } = options;
  const errors: string[] = [];

  // Multi-day CDP acquisition in one session
  const result = await acquireJdData({
    shopId,
    mock: false,
    fromDate,
    toDate,
    cdpPort,
    blueprint,
  });

  if (!result.success) {
    return {
      success: false,
      totalSignals: 0,
      totalEvidence: 0,
      days: 0,
      results: [],
      errors: [result.error ?? 'CDP acquisition failed'],
    };
  }

  const allData = result.allData ?? (result.data ? [result.data] : []);
  const allRaw = result.allRawPayloads ?? (result.rawPayload ? [result.rawPayload] : []);

  // Build normalizer spec once — reused for all days
  const normalizerSpec = buildSpecFromBlueprint(
    blueprint.normalizer_plan,
    INDICATOR_OVERRIDES,
  );

  let totalSignals = 0;
  let totalEvidence = 0;
  const dayResults: RuntimeLiveCDPDayResult[] = [];

  for (let i = 0; i < allData.length; i++) {
    const parsed = allData[i];
    if (!parsed) continue;

    const raw = allRaw[i] ?? {};
    const date = parsed.date;

    try {
      // Blueprint-driven signal generation
      const signalResult = generateSignals(db, parsed, {
        platform: 'jd',
        shopId,
        date,
        signalTypes: blueprint.manifest.signal_types,
        normalizerSpec,
        rawPayload: raw,
      });

      // Blueprint-driven evidence capture
      const evidenceResults = captureEvidence(
        'jd',
        shopId,
        date,
        raw,
        blueprint.evidence_strategy.capture_rules,
        result.method,  // acquisition_method: 'mock' | 'cdp'
        'runtime',      // processing_method: live CDP is always runtime
      );

      totalSignals += signalResult.signalCount;
      totalEvidence += evidenceResults.length;

      dayResults.push({
        date,
        signals: signalResult.signalCount,
        evidence: evidenceResults.length,
        parsed,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${date}: ${msg}`);
      dayResults.push({
        date,
        signals: 0,
        evidence: 0,
        parsed,
        error: msg,
      });
    }
  }

  return {
    success: true,
    totalSignals,
    totalEvidence,
    days: dayResults.length,
    results: dayResults,
    errors,
  };
};

// ---- Import Pipeline (P0005.6.1) ----

export interface RuntimeImportOptions {
  /** Path to the JSON file containing historical daily records */
  sourcePath: string;
  /** Shop ID for the imported data */
  shopId?: string;
}

export interface RuntimeImportResult {
  success: boolean;
  totalEvidence: number;
  totalSignals: number;
  recordCount: number;
  firstDate?: string;
  lastDate?: string;
  errors: string[];
}

/**
 * Create a minimal empty blueprint for environments without discovery data.
 * All rules/signal_types/capture_rules are empty, so executeImportPipeline
 * and other pipeline functions fall through to their legacy paths automatically.
 *
 * This is NOT a stub — it's the legitimate "no discovery data" state.
 */
export const createEmptyBlueprint = (platform: string): BoundCapabilityModel => ({
  platform,
  generated_at: new Date().toISOString(),
  discovery_api_count: 0,
  capabilities: [],
  parser_plan: {
    generated_at: new Date().toISOString(),
    source: 'empty',
    rules: [],
  },
  normalizer_plan: {
    generated_at: new Date().toISOString(),
    source: 'empty',
    rules: [],
  },
  manifest: {
    platform,
    generated_at: new Date().toISOString(),
    signal_types: [],
    business_context: [],
    evidence_chain: [],
    supported_actions: [],
    total_apis_discovered: 0,
    apis_in_blueprint: 0,
  },
  evidence_strategy: {
    capture_rules: [],
  },
});

/** Shape of a single daily record in the agentCMS export file. */
interface ImportDailyRecord {
  date: string;
  summary: {
    gmv: number;
    orders: number;
    visitors: number;
    customers: number;
    conversion_rate: number;
    gmv_compare_pct: number | null;
    orders_compare_pct: number | null;
    visitors_compare_pct: number | null;
  };
  hourly_gmv: Array<{ hour: string; gmv: number }>;
  top_products: Array<{
    sku_id: string;
    name: string;
    gmv: number;
    item_url: string;
  }>;
}

/**
 * Import historical JD data from an agentCMS daily_records.json file.
 *
 * For each record:
 *   1. Save evidence (summary, trend, productTop) via the evidence store
 *   2. Generate signals — blueprint-driven when available, legacy fallback otherwise
 *
 * The blueprint / legacy decision is made per-record based on whether the
 * blueprint has usable signal_types and normalizer_plan rules.
 */
export const executeImportPipeline = async (
  blueprint: BoundCapabilityModel,
  db: Db,
  options: RuntimeImportOptions,
): Promise<RuntimeImportResult> => {
  const { sourcePath, shopId = 'jd_shop_001' } = options;
  const errors: string[] = [];

  // Read and parse the source file
  let records: ImportDailyRecord[];
  try {
    const raw = readFileSync(sourcePath, 'utf-8');
    records = JSON.parse(raw) as ImportDailyRecord[];
  } catch (err) {
    return {
      success: false,
      totalEvidence: 0,
      totalSignals: 0,
      recordCount: 0,
      errors: [`Failed to read source file: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (records.length === 0) {
    return {
      success: true,
      totalEvidence: 0,
      totalSignals: 0,
      recordCount: 0,
      errors: [],
    };
  }

  // Determine whether blueprint-driven signal generation is available
  const normalizerSpec = blueprint.normalizer_plan.rules.length > 0
    ? buildSpecFromBlueprint(blueprint.normalizer_plan, INDICATOR_OVERRIDES)
    : null;
  const signalTypes = blueprint.manifest.signal_types.length > 0
    ? blueprint.manifest.signal_types
    : null;
  const useBlueprint = normalizerSpec !== null && signalTypes !== null;

  let totalSignals = 0;
  let totalEvidence = 0;

  for (const r of records) {
    // Save evidence — wrap data in JD API envelope format for compatibility
    // with existing evidence consumers (parseJdPayload expects this shape).
    saveEvidence('jd', shopId, r.date, 'summary', {
      header: { code: 0 },
      body: { data: [r.summary] },
    }, { method: 'import-agentcms' });
    totalEvidence++;

    saveEvidence('jd', shopId, r.date, 'trend', {
      header: { code: 0 },
      body: { data: r.hourly_gmv.map((h) => ({ dt: h.hour, gmv: h.gmv })) },
    }, { method: 'import-agentcms' });
    totalEvidence++;

    saveEvidence('jd', shopId, r.date, 'productTop', {
      header: { code: 0 },
      body: {
        data: r.top_products.map((p) => ({
          sku_id: p.sku_id,
          'sku_id#name_cn': p.name,
          gmv: p.gmv,
          sku_id_item_url: p.item_url,
        })),
      },
    }, { method: 'import-agentcms' });
    totalEvidence++;

    // Signal generation
    if (useBlueprint && normalizerSpec && signalTypes) {
      // Blueprint-driven signal generation.
      // P0010.2.9: import records use the legacy JdSummary shape (visitors /
      // conversion_rate / visitors_compare_pct). Map them into the new
      // shop-level / product / industry shape so the blueprint-driven
      // normalizer can resolve the new canonical names.
      const legacy = r.summary;
      const parsed: ParsedJdData = {
        date: r.date,
        summary: {
          gmv: legacy.gmv,
          orders: legacy.orders,
          customers: legacy.customers,
          shop_visitors: legacy.visitors ?? 0,
          shop_conversion_rate: legacy.conversion_rate ?? 0,
          product_visitors: 0,
          industry_conversion_rate: 0,
          gmv_compare_pct: legacy.gmv_compare_pct,
          orders_compare_pct: legacy.orders_compare_pct,
          shop_visitors_compare_pct: legacy.visitors_compare_pct,
          product_visitors_compare_pct: null,
          shop_conversion_rate_compare_pct: null,
          industry_conversion_rate_compare_pct: null,
          gmv_compare_value: null,
          orders_compare_value: null,
          shop_visitors_compare_value: null,
          shop_conversion_rate_compare_value: null,
        },
        hourly_gmv: r.hourly_gmv,
        top_products: r.top_products,
      };
      const signalResult = generateSignals(db, parsed, {
        platform: 'jd',
        shopId,
        date: r.date,
        signalTypes,
        normalizerSpec,
      });
      totalSignals += signalResult.signalCount;
    } else {
      // Legacy fallback: direct normalizeSignal + SignalFacade.store
      // Preserved for environments where blueprint hasn't been generated yet.
      const di = {
        signal_id: `jd-real-${r.date}`,
        source: 'jd' as const,
        shop_id: shopId,
        shop_name: '京东店铺',
        signal_type: 'daily_summary' as const,
        priority: 0.6,
        timestamp: new Date(r.date).toISOString(),
        metrics: {
          gmv: r.summary.gmv,
          orders: r.summary.orders,
          // P0010.2.9: uv/cvr map to shop-level fields (the live page values).
          // Import is for historical agentCMS data which uses the old shape;
          // the live fabric-execute path now uses the new shape.
          uv: r.summary.visitors ?? 0,
          cvr: r.summary.conversion_rate ?? 0,
        },
        confidence: 0.95,
      };
      SignalFacade.store(db, [normalizeSignal(di)]);
      totalSignals++;

      for (const h of r.hourly_gmv) {
        if (h.gmv <= 0) continue;
        SignalFacade.store(db, [
          normalizeSignal({
            signal_id: `jd-real-${r.date}-${h.hour.replace(/[^0-9]/g, '')}`,
            source: 'jd' as const,
            shop_id: shopId,
            signal_type: 'hourly_sales' as const,
            priority: 0.5,
            timestamp: h.hour,
            metrics: { gmv: h.gmv },
            confidence: 0.9,
          }),
        ]);
        totalSignals++;
      }
    }
  }

  const firstDate = records[0]?.date;
  const lastDate = records[records.length - 1]?.date;

  return {
    success: true,
    totalEvidence,
    totalSignals,
    recordCount: records.length,
    errors,
    ...(firstDate !== undefined ? { firstDate } : {}),
    ...(lastDate !== undefined ? { lastDate } : {}),
  };
};
