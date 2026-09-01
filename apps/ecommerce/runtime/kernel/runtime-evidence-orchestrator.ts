// Runtime Evidence Orchestrator — blueprint-driven evidence capture.
// P0005.5: Fixes G1 (partial) — replaces hardcoded saveEvidence() calls in processDay
// with blueprint-driven evidence capture based on evidence_strategy.capture_rules.
//
// Currently processDay hardcodes:
//   saveEvidence('jd', shopId, date, 'summary', ...)
//   saveEvidence('jd', shopId, date, 'trend', ...)
//   saveEvidence('jd', shopId, date, 'productTop', ...)
//
// After P0005.5: the orchestrator reads blueprint.evidence_strategy.capture_rules
// to determine WHAT to capture and HOW.

import type { EvidenceCapture } from '#app/connectors/binding/types.js';
import { saveEvidence } from '#app/connectors/evidence/store.js';

/** Result of capturing evidence for one endpoint. */
export interface EvidenceCaptureResult {
  /** The endpoint that produced this evidence */
  endpoint: string;
  /** Evidence ID from the store */
  evidenceId: string;
  /** Data type used for file naming (derived from endpoint name) */
  dataType: string;
}

/**
 * Convert an endpoint name (e.g. "summary.ajax" or "getProductList") to a
 * human-readable data type for evidence file naming.
 */
const endpointToDataType = (endpoint: string): string => {
  // Strip file extension and path separators
  const base = endpoint.replace(/\.(ajax|json|html?)$/, '').replace(/[./]/g, '_');
  return base || endpoint;
};

/**
 * Capture evidence for a single day's acquired data, driven by the blueprint's
 * evidence_strategy.capture_rules.
 *
 * For each capture rule that has capture_raw_response: true AND has matching data
 * in rawPayloads, saves the evidence via the existing saveEvidence() store.
 *
 * Falls back to legacy behavior (summary/trend/productTop) if no capture rules
 * match the available payload data — backward compatibility with existing evidence files.
 */
export const captureEvidence = async (
  platform: string,
  shopId: string,
  date: string,
  rawPayloads: Record<string, unknown>,
  captureRules: readonly EvidenceCapture[],
  acquisitionMethod: 'cdp' | 'mock' | 'import-agentcms' | 'unknown',
  processingMethod: 'runtime' | 'replay' | 'import' | 'none',
): Promise<EvidenceCaptureResult[]> => {
  const results: EvidenceCaptureResult[] = [];
  const processedAt = new Date().toISOString();

  // Collect rules that should capture raw responses and have data available
  const activeRules = captureRules.filter(
    (rule) => rule.capture_raw_response && rawPayloads[rule.endpoint] !== undefined,
  );

  if (activeRules.length > 0) {
    // Blueprint-driven capture
    for (const rule of activeRules) {
      const payload = rawPayloads[rule.endpoint];
      if (payload === undefined) continue;

      const dataType = endpointToDataType(rule.endpoint);
      const record = await saveEvidence(platform, shopId, date, dataType, payload, {
        acquisition_method: acquisitionMethod as 'cdp' | 'mock' | 'import-agentcms' | 'unknown',
        processing_method: processingMethod as 'runtime' | 'replay' | 'import' | 'none',
        processed_at: processedAt,
      });

      results.push({
        endpoint: rule.endpoint,
        evidenceId: record.evidence_id,
        dataType,
      });
    }
  } else {
    // Legacy fallback: capture known data types from rawPayloads
    const legacyTypes = ['summary', 'trend', 'productTop'];
    for (const dataType of legacyTypes) {
      const payload = rawPayloads[dataType];
      if (payload !== undefined) {
        const record = await saveEvidence(platform, shopId, date, dataType, payload, {
          acquisition_method: acquisitionMethod,
          processing_method: processingMethod,
          processed_at: processedAt,
        });
        results.push({
          endpoint: dataType,
          evidenceId: record.evidence_id,
          dataType,
        });
      }
    }
  }

  return results;
};