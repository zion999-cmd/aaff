// P0013.1 — Capability Resolution (pure).
//
// Before entering unknown-world exploration, Fabric must ask whether an
// existing VERIFIED binding satisfies the need. In V1 no verified
// historical binding exists — the 2026-09-03 acquisition scripts are
// experimental assets, and Capability Candidates are pending human
// architecture review (proposal §4, §7; SC9). Candidates are accepted as
// an explicit parameter precisely so this decision is visible and pinned
// by tests: they MUST NOT be auto-executed.

import type { CapabilityCandidate } from '#shared/contracts/capability-candidate.js';
import type { HistoricalEvidenceNeed } from '#shared/contracts/historical-evidence-need.js';

export type CapabilityResolution =
  | Readonly<{ kind: 'execute'; bindingId: string }>
  | Readonly<{ kind: 'explore'; reason: 'no_verified_historical_binding' }>;

export const resolveHistoricalBinding = (
  _need: HistoricalEvidenceNeed,
  _candidates: readonly CapabilityCandidate[],
): CapabilityResolution => {
  // V1 always explores. Candidates never count as verified bindings here;
  // a future promotion step would register a verified binding and add an
  // 'execute' branch — that is a separate architecture decision.
  return { kind: 'explore', reason: 'no_verified_historical_binding' };
};
