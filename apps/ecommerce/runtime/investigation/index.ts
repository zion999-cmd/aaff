// P0010 — Knowledge-Guided Investigation: prompt builder + contract parser.
export { buildInvestigationPrompt, formatSituationEvidence } from './prompt.js';
export { parseInvestigation, extractJsonObject } from './parse.js';
export type { ParseInvestigationResult } from './parse.js';
// P0010.2 — raw → canonical vocabulary normalization at the Hermes boundary.
export {
  normalizeHypothesisStatus,
  normalizeStopReason,
  normalizeRecommendationKind,
  normalizeInvestigationContract,
  validateEpistemicContract,
  deriveKindFromStopReason,
  CANONICAL_HYPOTHESIS_STATUSES,
  CANONICAL_STOP_REASONS,
  CANONICAL_RECOMMENDATION_KINDS,
} from './normalize.js';
export type {
  CanonicalHypothesisStatus,
  CanonicalStopReason,
  CanonicalRecommendationKind,
  NormalizationResult,
  ContractNormalizationResult,
  EpistemicDriftRecord,
} from './normalize.js';
// P0013.4 — Question-driven investigation & Evidence Sufficiency.
export { validateAnalysisObligations } from './analysis-obligations.js';
export type { AnalysisObligationContext } from './analysis-obligations.js';
export {
  EVIDENCE_KIND_DECLARATIONS,
  findEvidenceKindDeclaration,
  resolveEvidenceGrain,
  subjectMatchesKind,
  isSubjectDeclaredAnywhere,
  normalizeSubject,
} from './evidence-grain.js';
export type { EvidenceKindDeclaration } from './evidence-grain.js';
export {
  evaluateRequirementSufficiency,
  parseBusinessTime,
  toAvailableEvidence,
} from './evidence-sufficiency.js';
export type {
  AvailableEvidence,
  HeldEvidenceLike,
  RequirementSufficiency,
} from './evidence-sufficiency.js';
