// Phase 3: Execution Planner — converts a BoundCapabilityModel into a CapabilityExecutionPlan.
// P0005.4: The planner is the "what to execute" layer. It selects APIs, resolves indicators,
// and determines evidence capture rules — all from the blueprint.

import type {
  BoundCapabilityModel,
  CapabilityExecutionPlan,
  ApiCall,
  IndicatorResolution,
  EvidenceCapture,
  PlanOptions,
} from './types.js';
import { CapabilityExecutionPlanSchema } from './types.js';
import { CAPABILITY_TO_MODULE } from '#app/connectors/capability/contract-generator.js';

/** Map signal types back to the canonical capabilities they encompass. */
const SIGNAL_TO_CAPABILITIES: Readonly<Record<string, string[]>> = {
  daily_summary: ['trade.overview', 'customer.overview', 'product.overview', 'industry.benchmark', 'supply_chain.inventory'],
  hourly_traffic: ['traffic.overview'],
  campaign_performance: ['marketing.overview'],
};

/** Default JD gateway — can be overridden per platform. */
const PLATFORM_GATEWAYS: Readonly<Record<string, string>> = {
  jd: 'szgateway.jd.com/api/lowcode/indexSummary/',
};

/**
 * Build a CapabilityExecutionPlan from a BoundCapabilityModel.
 * Selects APIs by requested capabilities, resolves indicator mappings, and builds evidence rules.
 */
export const buildExecutionPlan = (
  model: BoundCapabilityModel,
  options?: PlanOptions,
): CapabilityExecutionPlan => {
  const gatewayBase = options?.gateway_base ?? PLATFORM_GATEWAYS[model.platform] ?? '';
  const requestedCaps = options?.capabilities;

  // Resolve which capabilities to use
  const capabilities = requestedCaps && requestedCaps.length > 0
    ? resolveCapabilityNames(requestedCaps)
    : model.capabilities.map((c) => c.capability);

  // Select APIs that serve the requested capabilities
  const selectedApis = resolveApisForCapability(model, capabilities, gatewayBase);

  // Resolve indicator mappings for the selected APIs
  const indicatorRules = resolveIndicatorRules(model, new Set(selectedApis.map((a) => a.endpoint)));

  // Resolve evidence capture rules
  const evidenceRules = resolveEvidenceRules(model, new Set(selectedApis.map((a) => a.endpoint)));

  const plan: CapabilityExecutionPlan = {
    platform: model.platform,
    apis_to_call: selectedApis,
    indicator_resolution: indicatorRules,
    evidence_capture: evidenceRules,
    target_capabilities: capabilities,
  };

  return CapabilityExecutionPlanSchema.parse(plan);
};

/**
 * Resolve capability names from requested signal types or capability names.
 * Accepts both forms: "daily_summary" (signal type) or "Transaction" (capability name).
 */
const resolveCapabilityNames = (requested: string[]): string[] => {
  const capabilities = new Set<string>();
  for (const item of requested) {
    // Check if it's a signal type
    const caps = SIGNAL_TO_CAPABILITIES[item];
    if (caps) {
      for (const c of caps) capabilities.add(c);
    } else {
      // Assume it's already a capability name
      capabilities.add(item);
    }
  }
  return [...capabilities];
};

/**
 * Select API calls that serve the given capabilities.
 * Matches capability name → api_module name → parser rules.
 */
const resolveApisForCapability = (
  model: BoundCapabilityModel,
  capabilities: string[],
  gatewayBase: string,
): ApiCall[] => {
  // Legacy module map (blueprint's stale discovery vocabulary) — kept only so
  // the no-capability "collect all" path keeps working.
  const legacyCapToModule = new Map<string, string>();
  for (const cap of model.capabilities) {
    legacyCapToModule.set(cap.capability, cap.api_module);
  }

  // Resolve requested capabilities → modules. The canonical mapping is the
  // single source of truth; legacy discovery names are a backward-compat fallback.
  const selectedModules = new Set<string>();
  const unresolved: string[] = [];
  for (const cap of capabilities) {
    const mod = CAPABILITY_TO_MODULE[cap] ?? legacyCapToModule.get(cap);
    if (mod) selectedModules.add(mod);
    else unresolved.push(cap);
  }

  // Fail closed: an unknown capability must never silently fall back to
  // "all endpoints" (that masks a binding gap and re-triggers live CDP).
  if (unresolved.length > 0) {
    throw new Error(`Unresolved capability: ${unresolved.join(', ')}`);
  }

  // Filter parser rules: include rules whose endpoint's module matches.
  const moduleEndpoints = getModuleEndpoints(model, selectedModules);

  const apis: ApiCall[] = [];
  for (const rule of model.parser_plan.rules) {
    if (moduleEndpoints.has(rule.endpoint) && rule.fields_to_parse.length > 0) {
      apis.push({
        endpoint: rule.endpoint,
        gateway_url: gatewayBase,
        strategy: rule.strategy,
        fields_to_parse: rule.fields_to_parse,
        field_mapping: rule.field_mapping,
      });
    }
  }

  return apis;
};

/**
 * Get the set of endpoint names that belong to the requested modules.
 * Uses the capabilities array's api_module→endpoints relationship from Discovery.
 */
const getModuleEndpoints = (
  model: BoundCapabilityModel,
  selectedModules: Set<string>,
): Set<string> => {
  const endpoints = new Set<string>();

  // The blueprint's parser_plan.rules list all endpoints.
  // We cross-reference with the capability→api_module mapping.
  // Each PlatformCapability has api_module and api_count but not the endpoint list.
  // We infer endpoints by matching parser rules to modules via naming conventions:
  // e.g., summary.* → indexSummary, getProductList → indexSummary, etc.

  for (const rule of model.parser_plan.rules) {
    const inferredModule = inferModuleFromEndpoint(rule.endpoint, model);
    if (selectedModules.has(inferredModule)) {
      endpoints.add(rule.endpoint);
    }
  }

  return endpoints;
};

/**
 * Infer which API module an endpoint belongs to.
 * Uses the blueprint's capability metadata: each capability has an api_module with supported_features.
 * Heuristic: endpoint name prefix or keyword matches against module identity.
 */
const inferModuleFromEndpoint = (
  endpoint: string,
  model: BoundCapabilityModel,
): string => {
  // Match endpoint by naming convention against known module prefixes
  for (const cap of model.capabilities) {
    const endpointLower = endpoint.toLowerCase();

    // Direct module prefix match
    // P0010.2.11 C1 Bug 1 — the previous regex `^(summary|index|getProduct|getFlow|getAlarm)`
    // excluded the new lowcode endpoints `getSummary` / `getTrend` (the "get" prefix
    // is anchored as a literal, not as "get*" — the "get" in "getSummary" is not a
    // leading character because the regex already starts matching at `s`/`i`/`g`).
    // Trade.overview was resolving to 0 endpoints through indexSummary, so
    // selectedApis was empty and the runtime loop had no plan. Add the new
    // canonical names alongside the existing alternation.
    if (cap.api_module === 'indexSummary' && /^(summary|index|getProduct|getFlow|getAlarm|getSummary|getTrend)/.test(endpoint)) {
      return 'indexSummary';
    }
    if (cap.api_module === 'industryMarket' && /^(industry|market|trade)/.test(endpointLower)) {
      return 'industryMarket';
    }
    if (cap.api_module === 'custGrowth' && /^(cust|customer|member|fan|growth)/.test(endpointLower)) {
      return 'custGrowth';
    }
    if (cap.api_module === 'marketing' && /^(market|ad|promot|campaign|coupon)/.test(endpointLower)) {
      return 'marketing';
    }
    if (cap.api_module === 'stock' && /^(stock|invent|supply|warehouse)/.test(endpointLower)) {
      return 'stock';
    }
    if (cap.api_module === 'common' && /^(common|plat|config|auth)/.test(endpointLower)) {
      return 'common';
    }
  }

  return 'indexSummary'; // default fallback
};

/**
 * Resolve indicator mappings for the selected API endpoints.
 * Filters normalizer rules to only those relevant to the selected endpoints.
 */
const resolveIndicatorRules = (
  model: BoundCapabilityModel,
  _selectedEndpoints: Set<string>,
): IndicatorResolution[] => {
  const rules: IndicatorResolution[] = [];

  for (const rule of model.normalizer_plan.rules) {
    // Include all rules with confidence > 0, prioritizing higher confidence
    if (rule.confidence > 0) {
      rules.push({
        raw_key: rule.source_field,
        canonical: rule.canonical,
        unit: rule.unit,
        confidence: rule.confidence,
      });
    }
  }

  // Deduplicate by raw_key, keeping highest confidence
  const seen = new Map<string, IndicatorResolution>();
  for (const r of rules) {
    const existing = seen.get(r.raw_key);
    if (!existing || r.confidence > existing.confidence) {
      seen.set(r.raw_key, r);
    }
  }

  return [...seen.values()];
};

/**
 * Resolve evidence capture rules for the selected API endpoints.
 */
const resolveEvidenceRules = (
  model: BoundCapabilityModel,
  selectedEndpoints: Set<string>,
): EvidenceCapture[] => {
  return model.evidence_strategy.capture_rules.filter((r) =>
    selectedEndpoints.has(r.endpoint),
  );
};
