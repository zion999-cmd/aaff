// P0010 — Knowledge-Guided Investigation: prompt builder + contract parser.
export { buildInvestigationPrompt, formatSituationEvidence } from './prompt.js';
export { parseInvestigation, extractJsonObject } from './parse.js';
export type { ParseInvestigationResult } from './parse.js';
// P0010.2 — raw → canonical vocabulary normalization at the Hermes boundary.
export {
  normalizeHypothesisStatus,
  normalizeStopReason,
  normalizeInvestigationContract,
  CANONICAL_HYPOTHESIS_STATUSES,
  CANONICAL_STOP_REASONS,
} from './normalize.js';
export type {
  CanonicalHypothesisStatus,
  CanonicalStopReason,
  NormalizationResult,
  ContractNormalizationResult,
} from './normalize.js';
