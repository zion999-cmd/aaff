// P0013.2 — Shared Analysis Contract obligations (fail-closed).
//
// Called from the shared parseInvestigation path for BOTH production and
// replay. The epistemic validator is a soft scan; these obligations are
// hard: a completed investigation that dodges business structure, or
// stops with `observe` while structural evidence is missing, is an invalid
// contract. The existing remediation paths handle rejection (production:
// one in-session re-prompt; replay: step FAILED for operator retry).

import type { Investigation } from '#shared/schemas/investigation.js';
import { BUSINESS_STRUCTURE_DIMENSIONS } from './analysis-contract.js';

const DIMENSION_KEYS = BUSINESS_STRUCTURE_DIMENSIONS.map((d) => d.key);

/**
 * Returns the list of contract violations. Empty array = the completed
 * investigation satisfies the shared Analysis Contract.
 */
export const validateAnalysisObligations = (inv: Investigation): string[] => {
  const errors: string[] = [];

  // ── 1. At least one L1 fact the judgment stands on ──────────────────
  const epistemicObserved = inv.epistemic_layers?.observed ?? [];
  const claimRefs = (inv.claim_evidence_refs ?? []).flatMap(
    (c) => c.evidence_refs ?? [],
  );
  const findingRefs = (inv.findings ?? []).flatMap((f) => f.evidenceRefs ?? []);
  const hasObserved =
    (inv.observed_facts ?? []).length > 0 ||
    (inv.knownEvidence ?? []).length > 0 ||
    epistemicObserved.length > 0;
  if (!hasObserved) {
    errors.push(
      'observed_facts obligation: emit at least one Evidence-supported fact (observed_facts[] or epistemic_layers.observed[])',
    );
  }

  const hasRefs =
    (inv.supporting_evidence_refs ?? []).length > 0 ||
    epistemicObserved.some((o) => (o.evidence_refs ?? []).length > 0) ||
    claimRefs.length > 0 ||
    findingRefs.length > 0;
  if (!hasRefs) {
    errors.push(
      'supporting_evidence_refs obligation: cite the evidence ids behind the strong claims',
    );
  }

  // ── 2. Five-dimension structure coverage ────────────────────────────
  const coverage = inv.business_structure_coverage ?? [];
  const coveredDims = coverage.map((c) => c.dimension);
  const missingDims = DIMENSION_KEYS.filter((d) => !coveredDims.includes(d));
  if (coverage.length === 0) {
    errors.push(
      'business_structure_coverage obligation: one entry per dimension (product, orders, traffic, conversion, operations) required',
    );
  } else if (missingDims.length > 0) {
    errors.push(
      `business_structure_coverage missing dimensions: ${missingDims.join(', ')}`,
    );
  }
  const duplicated = coveredDims.filter((d, i) => coveredDims.indexOf(d) !== i);
  if (duplicated.length > 0) {
    errors.push(`business_structure_coverage duplicates dimensions: ${duplicated.join(', ')}`);
  }
  const gapEntries = coverage.filter((c) => c.status === 'gap');

  // ── 3. stopReason-specific obligations ──────────────────────────────
  const stop = inv.stopReason;
  if (!stop) {
    // A completed turn MUST carry a canonical stop reason — otherwise the
    // observe-vs-gap decision is silently dodged via recommendation.kind.
    errors.push(
      'stopReason obligation: emit one canonical stop reason (judgment / observe / missing_capability / ask_human)',
    );
  } else if (stop === 'observe') {
    // observe is NOT a legal exit while a structural dimension is gapped.
    if (gapEntries.length > 0) {
      errors.push(
        `stopReason=observe is illegal while structural gaps remain (${gapEntries
          .map((g) => g.dimension)
          .join(', ')}): record evidence_gaps + acquisition need and stop with missing_capability or a partial judgment`,
      );
    }
    if (!inv.judgment || inv.judgment.trim().length === 0) {
      errors.push('stopReason=observe still requires a non-empty business judgment (why normal)');
    }
  } else if (stop === 'missing_capability') {
    const hasAcquisitionNeed =
      (inv.evidence_gaps ?? []).length > 0 &&
      (inv.requiredEvidence ?? []).length > 0 &&
      inv.investigationRequest.trim().length > 0;
    if (!hasAcquisitionNeed) {
      errors.push(
        'stopReason=missing_capability requires evidence_gaps[], requiredEvidence[] and a concrete investigationRequest acquisition need',
      );
    }
  } else if (stop === 'judgment') {
    if (!inv.judgment || inv.judgment.trim().length === 0) {
      errors.push('stopReason=judgment requires a non-empty business judgment');
    }
  } else if (stop === 'ask_human') {
    if (!inv.nextQuestion || inv.nextQuestion.trim().length === 0) {
      errors.push('stopReason=ask_human requires a concrete nextQuestion');
    }
  }

  // ── 4. Coverage gaps must be reflected as evidence gaps ─────────────
  if (gapEntries.length > 0 && (inv.evidence_gaps ?? []).length === 0) {
    errors.push(
      'business_structure_coverage gap entries require matching evidence_gaps[] entries',
    );
  }

  // ── 5. P0013.2 Evidence Resolution obligations ──────────────────────
  // Context Missing ≠ Evidence Missing: every declared gap must be
  // backed by an UNAVAILABLE resolution (retrieval was attempted against
  // held evidence and it could not answer); every RETRIEVED resolution
  // must name the evidence used.
  const resolutions = inv.evidence_resolutions ?? [];
  const unavailable = resolutions.filter((r) => r.result === 'UNAVAILABLE');
  const retrieved = resolutions.filter((r) => r.result === 'RETRIEVED');

  if (gapEntries.length > 0) {
    const byDim = new Set(unavailable.map((r) => r.dimension).filter(Boolean));
    const unresolvedDims = gapEntries
      .map((g) => g.dimension)
      .filter((d) => !byDim.has(d));
    if (unresolvedDims.length > 0) {
      errors.push(
        `coverage gap without UNAVAILABLE evidence resolution: ${unresolvedDims.join(', ')} ` +
          '(resolve held evidence — e.g. fabric_replay_retrieve_orders / a live capability — before declaring a gap)',
      );
    }
  }
  if ((inv.evidence_gaps ?? []).length > 0 && unavailable.length === 0) {
    errors.push(
      'evidence_gaps[] non-empty but no UNAVAILABLE evidence_resolutions entry: a question answerable from in-context or retrievable held evidence is RETRIEVED/IN_CONTEXT, not a gap',
    );
  }
  const retrievedWithoutRefs = retrieved.filter((r) => (r.retrieved_refs ?? []).length === 0);
  if (retrievedWithoutRefs.length > 0) {
    errors.push(
      `RETRIEVED evidence resolutions require non-empty retrieved_refs (${retrievedWithoutRefs.length} missing)`,
    );
  }
  const unavailableWithoutNote = unavailable.filter((r) => !r.note || r.note.trim().length === 0);
  if (unavailableWithoutNote.length > 0) {
    errors.push(
      `UNAVAILABLE evidence resolutions require a note explaining what was tried and why held evidence cannot answer`,
    );
  }

  return errors;
};
