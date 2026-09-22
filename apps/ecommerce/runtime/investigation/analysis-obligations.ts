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
import {
  evaluateRequirementSufficiency,
  type AvailableEvidence,
} from './evidence-sufficiency.js';

const DIMENSION_KEYS = BUSINESS_STRUCTURE_DIMENSIONS.map((d) => d.key);

/**
 * P0013.4 — what the caller knows about the evidence the system holds.
 *
 * `availableEvidence` is supplied by Historical Replay (it already builds the
 * run's inventory via `heldEvidenceFor`). Production has no equivalent
 * inventory today and passes nothing, which disables ONLY the
 * fabric-verified sufficiency check below. The traceability and
 * decision-relevance obligations always apply on both paths — they need no
 * inventory, they only need the Agent to have said why it is asking.
 */
export interface AnalysisObligationContext {
  readonly availableEvidence?: readonly AvailableEvidence[];
}

/**
 * Returns the list of contract violations. Empty array = the completed
 * investigation satisfies the shared Analysis Contract.
 */
export const validateAnalysisObligations = (
  inv: Investigation,
  context: AnalysisObligationContext = {},
): string[] => {
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

  // ── 6. P0013.4 Question-driven investigation & Evidence Sufficiency ──
  //
  // NOTE ON ABSENCE: an empty `business_questions[]` / `evidence_requirements[]`
  // is a VALID turn — "no material business question today" is a legal answer
  // and the contract never asks for a question per day. Every check below is
  // conditional on requirements having been emitted at all. Nothing here may
  // be turned into an "at least one requirement" rule.
  const requirements = inv.evidence_requirements ?? [];
  const questions = inv.business_questions ?? [];

  if (requirements.length > 0) {
    // 6a. Traceability — a requirement must say which question it serves.
    const untraceable = requirements.filter((r) => !r.question || r.question.trim().length === 0);
    if (untraceable.length > 0) {
      errors.push(
        `evidence_requirements[] entries must name the Business Question / Hypothesis they trace to ` +
          `(${untraceable.length} missing) — a free-floating requirement is the missing-field list this contract forbids`,
      );
    }

    // 6b. Decision relevance — what would change if the evidence arrived.
    const unrelevant = requirements.filter(
      (r) => !r.decision_relevance || r.decision_relevance.trim().length === 0,
    );
    if (unrelevant.length > 0) {
      errors.push(
        `evidence_requirements[] entries require decision_relevance: what judgment/hypothesis/recommendation ` +
          `would change if the evidence were obtained (${unrelevant.length} missing)`,
      );
    }

    // 6c. Requirements must have somewhere to trace FROM. This is a
    //     STRUCTURAL floor, not a semantic match.
    //
    //     An earlier version compared the requirement's `question` against the
    //     stated questions by normalized string containment, and the
    //     2026-09-20 acceptance run showed why that cannot work: the Agent
    //     traced its requirements to a real Business Question but restated it
    //     in the requirement field (dropping the parenthesised amounts and the
    //     word "少量"), so an honest, correctly-linked turn was rejected for
    //     not matching character-for-character. Deciding whether two prose
    //     statements are the same question is a semantic judgement, not a
    //     string operation — and it is the Human operator's call (SC10), not
    //     Fabric's.
    //
    //     What Fabric CAN soundly reject is the pathological case the proposal
    //     names: requirements appearing when there is nothing at all they
    //     could have come from — no Business Question, no Hypothesis, and no
    //     prior cognition.
    if (questions.length === 0 && (inv.hypotheses ?? []).length === 0
        && (inv.prior_cognition ?? []).length === 0) {
      errors.push(
        'evidence_requirements[] emitted with no business_questions[], no hypotheses[] and no prior_cognition[]: ' +
          'a requirement must come from something you are actually trying to decide, not from a missing-field list',
      );
    }

    // 6d. Both DIRECTIONS of the sufficiency claim are checked against
    //     Fabric's own grain/coverage facts, wherever an inventory exists:
    //
    //       claimed `satisfied` but the held evidence cannot carry it
    //         → over-claim ("field exists ≠ requirement satisfied");
    //       left `unsatisfied` while the held evidence already DOES carry it
    //         → under-claim, i.e. a gap declared for something the system
    //           holds (P0013.2's "Context Missing ≠ Evidence Missing").
    //
    //     This is deliberately an EVIDENCE check, not a bookkeeping one. An
    //     earlier version demanded that every unsatisfied requirement carry a
    //     matching `evidence_resolutions[]` row; the 2026-09-20 acceptance run
    //     showed why that is wrong — Hermes raised a legitimately open,
    //     forward-looking requirement ("后续日订单结构中的礼盒大单…", evidence
    //     that does not exist yet at T) and the run FAILED for not filing
    //     paperwork, not for any epistemically wrong claim. A requirement that
    //     neither claim can be refuted on is simply an honest open item.
    const available = context.availableEvidence;
    if (available !== undefined) {
      const overclaims: string[] = [];
      const underclaims: string[] = [];
      for (const r of requirements) {
        if (r.status === 'satisfied') {
          const verdict = evaluateRequirementSufficiency(r, available);
          if (!verdict.sufficient) {
            overclaims.push(`"${r.subject}" — ${verdict.reasons.join('; ')}`);
          }
        } else if (r.status === 'unsatisfied') {
          const verdict = evaluateRequirementSufficiency(r, available);
          if (verdict.sufficient) {
            underclaims.push(
              `"${r.subject}" — held evidence already carries it; resolve it through the existing ` +
                `Evidence Resolution (IN_CONTEXT/RETRIEVED) instead of leaving it open`,
            );
          }
        }
      }
      if (overclaims.length > 0) {
        errors.push(
          `evidence_requirements[] claimed satisfied but the held evidence cannot carry the requirement ` +
            `(field exists ≠ requirement satisfied): ${overclaims.join(' | ')}`,
        );
      }
      if (underclaims.length > 0) {
        errors.push(
          `evidence_requirements[] left unsatisfied but the held evidence already carries them ` +
            `(resolve before declaring a gap): ${underclaims.join(' | ')}`,
        );
      }
    }
  }

  return errors;
};
