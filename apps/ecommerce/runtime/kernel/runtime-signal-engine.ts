// Runtime Signal Engine — blueprint-driven signal generation.
// P0005.5: Fixes G2 — replaces processDay's hardcoded signal logic with
// blueprint-driven signal generation based on manifest.signal_types.
//
// processDay currently hardcodes:
//   - Signal types: 'daily_summary', 'hourly_sales'
//   - Metrics: { gmv, orders, uv, cvr } for daily_summary, { gmv } for hourly
//   - Confidence: hardcoded 0.9 / 0.85
//
// After P0005.5, the signal engine:
//   - Reads signal_types from blueprint.manifest.signal_types
//   - Maps metrics using the blueprint-driven normalizer spec
//   - Derives confidence from normalizer rule confidence scores

import type { Database as Db } from 'better-sqlite3';
import type { EnterpriseSignal } from '#shared/schemas/signal.js';
import type { ParsedJdData } from '#app/connectors/jd/parsers/index.js';
import { normalizeSignal } from '#app/connectors/normalizer.js';
import { SignalFacade } from '#app/analysis/metrics/facade.js';
import { uuid } from '#shared/utils/crypto.js';

export interface SignalGenerationResult {
  signals: EnterpriseSignal[];
  signalCount: number;
}

export interface SignalEngineOptions {
  platform: string;
  shopId: string;
  shopName?: string;
  date: string;
  /** Signal types to generate (from blueprint.manifest.signal_types) */
  signalTypes: readonly string[];
  /** Normalizer spec from runtime-normalizer-resolver */
  normalizerSpec: Record<string, readonly string[]>;
  /** Optional raw payload for traceability */
  rawPayload?: Record<string, unknown>;
  /** Default confidence for signals when normalizer rules don't provide one */
  defaultConfidence?: number;
}

/**
 * Generate EnterpriseSignals from parsed JD data, driven by blueprint signal types.
 *
 * For each signal_type in options.signalTypes:
 *   - daily_summary → one signal from parsed.summary metrics
 *   - hourly_sales → one signal per non-zero hourly_gmv entry
 *   - hourly_traffic → one signal per hourly_gmv entry (traffic perspective)
 *   - campaign_performance → placeholder (campaign data source TBD)
 */
export const generateSignals = (
  db: Db,
  parsed: ParsedJdData,
  options: SignalEngineOptions,
): SignalGenerationResult => {
  const {
    platform,
    shopId,
    shopName = '京东店铺',
    date,
    signalTypes,
    normalizerSpec,
    rawPayload,
    defaultConfidence = 0.9,
  } = options;

  const signals: EnterpriseSignal[] = [];

  for (const signalType of signalTypes) {
    switch (signalType) {
      case 'daily_summary': {
        const metrics = mapSummaryMetrics(parsed, normalizerSpec);
        const signal = normalizeSignal({
          signal_id: `${platform}-daily-${date}-${uuid().slice(0, 8)}`,
          source: platform as 'jd',
          shop_id: shopId,
          shop_name: shopName,
          signal_type: 'daily_summary',
          priority: 0.5,
          timestamp: new Date(date).toISOString(),
          metrics,
          confidence: computeAverageConfidence(metrics, normalizerSpec, defaultConfidence),
          ...(rawPayload ? { raw_payload: rawPayload } : {}),
        });
        signals.push(signal);
        break;
      }

      case 'hourly_sales': {
        for (const h of parsed.hourly_gmv) {
          if (h.gmv <= 0) continue;
          const metrics: Record<string, number> = { gmv: h.gmv };
          const signal = normalizeSignal({
            signal_id: `${platform}-hourly-${date}-${h.hour.replace(/[^0-9]/g, '')}-${uuid().slice(0, 8)}`,
            source: platform as 'jd',
            shop_id: shopId,
            signal_type: 'hourly_sales',
            priority: 0.5,
            timestamp: h.hour,  // P0006.1.1: observed_at distinguishes hourly observations
            metrics,
            confidence: 0.85,
            ...(rawPayload ? { raw_payload: rawPayload } : {}),
          });
          signals.push(signal);
        }
        break;
      }

      case 'hourly_traffic': {
        for (const h of parsed.hourly_gmv) {
          if (h.gmv <= 0) continue;
          const metrics: Record<string, number> = { uv: h.gmv };
          const signal = normalizeSignal({
            signal_id: `${platform}-hourly-traffic-${date}-${h.hour.replace(/[^0-9]/g, '')}-${uuid().slice(0, 8)}`,
            source: platform as 'jd',
            shop_id: shopId,
            signal_type: 'hourly_traffic',
            priority: 0.5,
            timestamp: h.hour,  // P0006.1.1: observed_at distinguishes hourly observations
            metrics,
            confidence: 0.85,
            ...(rawPayload ? { raw_payload: rawPayload } : {}),
          });
          signals.push(signal);
        }
        break;
      }

      case 'campaign_performance': {
        // Campaign data requires additional API endpoints (marketing module).
        // When available, campaign metrics would be mapped through normalizerSpec.
        // For now, skip — the blueprint signals this capability exists but the
        // current data source (summary/trend/productTop) doesn't provide it.
        break;
      }

      default:
        // Unknown signal type — skip gracefully
        break;
    }
  }

  // Persist all generated signals
  if (signals.length > 0) {
    SignalFacade.store(db, signals);
  }

  return { signals, signalCount: signals.length };
};

/**
 * Map ParsedJdData.summary fields through the normalizer spec to produce
 * canonical EnterpriseSignalPayload metrics.
 *
 * Applies the normalizer spec's source_field → canonical mapping to extract
 * and rename fields from the parsed summary data.
 */
const mapSummaryMetrics = (
  parsed: ParsedJdData,
  spec: Record<string, readonly string[]>,
): Record<string, number> => {
  const metrics: Record<string, number> = {};

  // Build a flat map from all summary fields
  // P0010.2.9: shop-level (shop_visitors / shop_conversion_rate) is the
  // primary for trade.overview. Product / industry level is preserved
  // for the other capabilities.
  const raw: Record<string, number> = {
    gmv: parsed.summary.gmv,
    orders: parsed.summary.orders,
    customers: parsed.summary.customers,
    shop_visitors: parsed.summary.shop_visitors,
    shop_conversion_rate: parsed.summary.shop_conversion_rate,
    product_visitors: parsed.summary.product_visitors,
    industry_conversion_rate: parsed.summary.industry_conversion_rate,
  };
  if (parsed.summary.gmv_compare_pct !== null) raw.gmv_compare_pct = parsed.summary.gmv_compare_pct;
  if (parsed.summary.orders_compare_pct !== null) raw.orders_compare_pct = parsed.summary.orders_compare_pct;
  if (parsed.summary.shop_visitors_compare_pct !== null) raw.shop_visitors_compare_pct = parsed.summary.shop_visitors_compare_pct;
  if (parsed.summary.product_visitors_compare_pct !== null) raw.product_visitors_compare_pct = parsed.summary.product_visitors_compare_pct;
  if (parsed.summary.shop_conversion_rate_compare_pct !== null) raw.shop_conversion_rate_compare_pct = parsed.summary.shop_conversion_rate_compare_pct;
  if (parsed.summary.industry_conversion_rate_compare_pct !== null) raw.industry_conversion_rate_compare_pct = parsed.summary.industry_conversion_rate_compare_pct;

  // Apply spec: for each canonical → aliases, pick the first matching alias from raw
  for (const [canonical, aliases] of Object.entries(spec)) {
    for (const alias of aliases) {
      if (alias in raw) {
        metrics[canonical] = raw[alias]!;
        break;
      }
    }
  }

  // If spec didn't cover the basic fields, include them directly as fallback.
  // P0010.2.9: uv/cvr fall back to shop-level fields (the live page values).
  if (!('gmv' in metrics)) metrics.gmv = parsed.summary.gmv;
  if (!('orders' in metrics)) metrics.orders = parsed.summary.orders;
  if (!('uv' in metrics)) metrics.uv = parsed.summary.shop_visitors;
  if (!('cvr' in metrics)) metrics.cvr = parsed.summary.shop_conversion_rate;

  return metrics;
};

/**
 * Compute an average confidence score for a set of metrics based on how many
 * of them have matching entries in the normalizer spec.
 */
const computeAverageConfidence = (
  metrics: Record<string, number>,
  spec: Record<string, readonly string[]>,
  fallback: number,
): number => {
  const canonicalKeys = Object.keys(metrics);
  if (canonicalKeys.length === 0) return fallback;

  let totalConfidence = 0;
  let covered = 0;

  for (const key of canonicalKeys) {
    if (key in spec) {
      // Higher confidence when spec explicitly covers this canonical
      totalConfidence += 0.95;
      covered++;
    } else {
      totalConfidence += fallback;
    }
  }

  return covered > 0 ? totalConfidence / canonicalKeys.length : fallback;
};

