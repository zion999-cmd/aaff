// P0013.4 — Evidence Sufficiency (shared Investigation layer).
//
// WHAT THIS IS, AND WHAT IT IS NOT
//
// It is NOT a completeness score. There is deliberately no percentage, no
// ratio, no threshold ladder and no "N of M requirements met" anywhere in
// this file — the proposal forbids all of them by name. A sufficiency
// verdict here is a MECHANICAL statement about whether the evidence the
// system holds can carry the semantics the question asked for.
//
// It is the Fabric side of a split stated in the proposal:
//
//   Fabric owns  — existence, business time, temporal grain, scope,
//                  provenance, Resolution state, and the Sufficiency contract.
//   Hermes owns  — which Business Question is worth asking, what evidence
//                  would change the judgment, and whether the remaining
//                  Unknown still materially matters.
//
// So this module answers exactly one question:
//
//   "Does any evidence the run actually holds, at grain and business time
//    compatible with this requirement, carry this subject?"
//
// and it FAILS CLOSED. Every axis it cannot verify — undeclared kind,
// unrecorded window start, unknown grain — resolves to `false`, never to
// "probably fine". A false `sufficient` would let the Agent stop on
// evidence that cannot answer its own question, which is the failure mode
// this proposal exists to remove.
//
// RELATION TO P0013.2 EVIDENCE RESOLUTION — these are different questions
// and the code keeps them different:
//   Resolution  (P0013.2)  — "was the evidence FOUND?"      IN_CONTEXT | RETRIEVED | UNAVAILABLE
//   Sufficiency (P0013.4)  — "is what we have ENOUGH?"       satisfied | unsatisfied | unresolvable
// This module never retrieves anything and never emits a resolution state.

import type {
  EvidenceRequirement,
  EvidenceTemporalGrain,
} from '#shared/schemas/investigation.js';
import {
  findEvidenceKindDeclaration,
  isSubjectDeclaredAnywhere,
  subjectMatchesKind,
  resolveEvidenceGrain,
} from './evidence-grain.js';

/** One evidence kind the run holds, described so sufficiency can be judged. */
export interface AvailableEvidence {
  readonly capability: string;
  readonly dataType: string;
  readonly grain: EvidenceTemporalGrain;
  /** Matching aliases (tokens) for the subjects this kind carries. */
  readonly subjectAliases: readonly string[];
  /** Rows of this kind VISIBLE at the clock date T (business_date <= T). */
  readonly visibleRows: number;
  /** business_date of the earliest VISIBLE row; null when visibleRows === 0. */
  readonly visibleFrom: string | null;
  /** business_date of the latest VISIBLE row; null when visibleRows === 0. */
  readonly visibleTo: string | null;
}

/** Structural input: what `heldEvidenceFor` (or any inventory) returns. */
export interface HeldEvidenceLike {
  readonly capability: string;
  readonly data_type: string;
  readonly rows: number;
  readonly firstDate: string;
  readonly lastDate: string;
  readonly visibleAtT: number;
}

const minDate = (a: string, b: string): string => (a <= b ? a : b);

/**
 * Build the sufficiency-facing descriptor list from a run's evidence
 * inventory.
 *
 * The visible slice is derived from (first row date, last row date, clock
 * date T). For every `daily` kind Fabric declares today the rows are
 * one-per-business_date, so the earliest visible date is `firstDate` and the
 * latest is `min(lastDate, T)`. A kind whose grain is undeclared stays
 * `unknown` and is therefore never trusted to satisfy a dated requirement —
 * so a wrong derivation here cannot silently become a false `sufficient`.
 */
export const toAvailableEvidence = (
  held: readonly HeldEvidenceLike[],
  clockDate: string,
): AvailableEvidence[] =>
  held.map((k) => {
    const grain = resolveEvidenceGrain(k.capability, k.data_type);
    const visible = k.visibleAtT > 0;
    return {
      capability: k.capability,
      dataType: k.data_type,
      grain,
      subjectAliases: findEvidenceKindDeclaration(k.capability, k.data_type)?.subjectAliases ?? [],
      visibleRows: k.visibleAtT,
      visibleFrom: visible ? k.firstDate : null,
      visibleTo: visible ? minDate(k.lastDate, clockDate) : null,
    };
  });

/** A sufficiency verdict for one requirement, with the reasons it failed. */
export interface RequirementSufficiency {
  readonly subject: string;
  readonly sufficient: boolean;
  /** Empty when sufficient; otherwise one line per axis that did not hold. */
  readonly reasons: readonly string[];
}

/** Parsed `business_time`: absent, one day, or an inclusive range. */
type BusinessTime =
  | { readonly kind: 'unspecified' }
  | { readonly kind: 'day'; readonly date: string }
  | { readonly kind: 'range'; readonly from: string; readonly to: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const parseBusinessTime = (value: string): BusinessTime => {
  const raw = value.trim();
  if (raw.length === 0) return { kind: 'unspecified' };
  const [head, tail, ...rest] = raw.split('..').map((p) => p.trim());
  if (head !== undefined && tail !== undefined && rest.length === 0) {
    if (DATE.test(head) && DATE.test(tail)) {
      const [from, to] = head <= tail ? [head, tail] : [tail, head];
      return { kind: 'range', from, to };
    }
  }
  if (DATE.test(raw)) return { kind: 'day', date: raw };
  // An unparseable business_time is not a licence to pass: treat it as a
  // dated requirement we cannot verify, so the temporal axis fails closed.
  return { kind: 'day', date: raw };
};

/**
 * Can a kind's visible evidence speak about a single business day?
 *
 * A `window_aggregate` may only speak about the range END it is stamped at.
 * We never recorded the range start, so we cannot claim it covers any other
 * day — this is the branch that makes the proposal's central case true:
 * 09-02..09-13 UV cannot answer a 09-03 question.
 */
const speaksAboutDay = (k: AvailableEvidence, date: string): boolean => {
  if (k.visibleRows === 0 || k.visibleFrom === null || k.visibleTo === null) return false;
  switch (k.grain) {
    case 'window_aggregate':
      return k.visibleTo === date;
    case 'daily':
    case 'point_in_time':
      return k.visibleFrom <= date && date <= k.visibleTo;
    case 'unknown':
      return false; // fails closed
  }
};

/** Can a kind's visible evidence speak about every day of an inclusive range? */
const speaksAboutRange = (k: AvailableEvidence, from: string, to: string): boolean => {
  if (k.visibleRows === 0 || k.visibleFrom === null || k.visibleTo === null) return false;
  switch (k.grain) {
    case 'window_aggregate':
      // A range total may answer a range question only when it is stamped at
      // the same range end. Its start is unrecorded, so this is the strongest
      // claim we can honestly make.
      return k.visibleTo === to;
    case 'daily':
    case 'point_in_time':
      return k.visibleFrom <= from && to <= k.visibleTo;
    case 'unknown':
      return false;
  }
};

const coversBusinessTime = (
  k: AvailableEvidence,
  time: BusinessTime,
): boolean => {
  if (time.kind === 'unspecified') return true;
  // `required` does not constrain whether the coverage holds — it is the
  // grain of the EVIDENCE that decides that, inside speaksAboutDay/Range.
  // A single-day question is answerable by a one-day aggregate stamped at
  // that day, or by daily evidence for that day; nothing else.
  if (time.kind === 'day') return speaksAboutDay(k, time.date);
  return speaksAboutRange(k, time.from, time.to);
};

/**
 * P0013.4 core predicate. Pure; no DB, no clock, no I/O.
 *
 * Returns `sufficient: true` ONLY when some held-and-visible kind carries the
 * requirement's subject AND can speak about the requirement's business time
 * at the required grain.
 */
export const evaluateRequirementSufficiency = (
  requirement: EvidenceRequirement,
  available: readonly AvailableEvidence[],
): RequirementSufficiency => {
  const reasons: string[] = [];
  const subject = requirement.subject;

  // ── Axis 1: subject — does the run hold evidence about it at all? ────
  const sameSubject = available.filter((k) => subjectMatchesKind(subject, k));
  if (sameSubject.length === 0) {
    reasons.push(
      isSubjectDeclaredAnywhere(subject)
        ? `subject "${subject}" is declared by a Fabric evidence kind but this run holds no rows of it (never acquired for this run)`
        : `subject "${subject}" is not carried by any declared Fabric evidence kind`,
    );
    return { subject, sufficient: false, reasons };
  }

  // ── Axis 2: visibility — held is not the same as visible at T ───────
  const visible = sameSubject.filter((k) => k.visibleRows > 0);
  if (visible.length === 0) {
    reasons.push(
      `subject "${subject}" is held by this run but has 0 rows visible at the clock date (not yet available)`,
    );
    return { subject, sufficient: false, reasons };
  }

  // ── Axis 3: business time × temporal grain ──────────────────────────
  const time = parseBusinessTime(requirement.business_time);
  const required = requirement.temporal_grain;
  if (visible.some((k) => coversBusinessTime(k, time))) {
    return { subject, sufficient: true, reasons: [] };
  }

  const covered = visible
    .map((k) => `${k.capability}/${k.dataType} (${k.grain}, business_date ${k.visibleFrom}..${k.visibleTo})`)
    .join(', ');
  if (time.kind === 'unspecified') {
    reasons.push(`subject "${subject}" is visible but no kind declares a usable grain for it`);
  } else {
    const wanted = time.kind === 'day' ? time.date : `${time.from}..${time.to}`;
    reasons.push(
      `grain/business-time mismatch: requirement needs ${required} at ${wanted}, ` +
        `the visible evidence for "${subject}" is ${covered}`,
    );
    if (required === 'daily' && visible.every((k) => k.grain === 'window_aggregate')) {
      reasons.push(
        'a window aggregate covers a business-time RANGE (its window start is not recorded); ' +
          'it cannot answer a single-day question even though the field really exists',
      );
    }
    if (visible.every((k) => k.grain === 'unknown')) {
      reasons.push(
        `the grain of ${covered} is undeclared, so it fails closed against a dated requirement`,
      );
    }
  }
  return { subject, sufficient: false, reasons };
};
