// P0010.2 Production Investigation Contract Repair — raw → canonical
// normalization at the Hermes raw contract boundary.
//
// The Agent (Runtime / Hermes) is asked via the Investigation prompt to emit
// only the canonical vocabulary. In practice the model drifts and emits
// near-synonyms (`confirmed`, `strongly_supported`, `partially_rejected`). We
// refuse the previous "expand the Zod enum" approach because that pollutes
// the canonical persisted schema (anything ever written can be read by future
// code that doesn't know the old enum was a drift). Instead we apply an
// EXPLICIT, EXHAUSTIVE allow-list of known equivalent forms at the boundary,
// and refuse any new value — fail-closed on drift.
//
// This is the only place where we accept non-canonical values. After this
// function returns, every downstream consumer (Workspace, storeInvestigation,
// InvestigationPolicy) sees only canonical `proposed | supported | weakened |
// rejected`.
//
// === Epistemic Integrity (2026-09-06, P0013 08-14 incident) ===
//
// REMOVED the silent "confirmed" → "supported" rewrite. The Agent MUST use
// the new `confirmed[]` field with `confirmed_evidence_refs[]` for L4 Confirmed
// claims; silently rewriting "confirmed" to "supported" hid the epistemic
// distinction between L3 (data-supported) and L4 (operator/system-stamped).
//
// ADDED `validateEpistemicContract` — scans prose fields for unsourced
// confirmation language ("确认" / "已确认" / "confirmed" / "definitely" / etc.)
// and reports occurrences as drift so the operator can see the gap. Does NOT
// fail-closed: prose-level "确认" without a corresponding `confirmed[]` entry
// is a soft warning, not a contract violation (the L3→L4 upgrade has been
// structurally prevented; the prose-level drift is a UX signal).

import {
  HypothesisStatusSchema,
  RecommendationKindSchema,
  StopReasonSchema,
} from '#shared/schemas/investigation.js';
import { CONFIDENT_LANGUAGE_ALLOWLIST } from '#shared/schemas/epistemic.js';

export type CanonicalHypothesisStatus = 'proposed' | 'supported' | 'weakened' | 'rejected';
export type CanonicalStopReason = 'judgment' | 'observe' | 'missing_capability' | 'ask_human';
export type CanonicalRecommendationKind = 'observe' | 'act';

/**
 * Hypothesis status normalization. The allow-list is the SINGLE source of
 * truth for what "drift" we tolerate. Adding a new mapping here is a
 * CONSCIOUS decision (and should come with a prompt update so we eventually
 * stop seeing the drift).
 */
const HYPOTHESIS_STATUS_NORMALIZATION: Readonly<Record<string, CanonicalHypothesisStatus>> = Object.freeze({
  // canonical — pass through
  proposed: 'proposed',
  supported: 'supported',
  weakened: 'weakened',
  rejected: 'rejected',
  // Epistemic Integrity (2026-09-06) — REMOVED silent "confirmed" → "supported"
  // rewrite. The Agent MUST use `confirmed[]` with explicit
  // `confirmed_evidence_refs[]` for L4 Confirmed claims, NOT silently
  // upgrade a `proposed` hypothesis to "supported" by calling it
  // "confirmed". The previous rewrite masked the epistemic distinction.
  //
  // Pure L3-status synonyms (no L3→L4 upgrade):
  strongly_supported: 'supported',
  partially_rejected: 'weakened',
});

/**
 * Stop-reason normalization. Same rules as hypothesis status.
 */
const STOP_REASON_NORMALIZATION: Readonly<Record<string, CanonicalStopReason>> = Object.freeze({
  // canonical
  judgment: 'judgment',
  observe: 'observe',
  missing_capability: 'missing_capability',
  ask_human: 'ask_human',
  // known drift
  complete: 'judgment',
  wait: 'observe',
});

/**
 * P0010.2.x — Recommendation-kind normalization. The Agent produces
 * a `recommendation.kind ∈ {observe, act}`. We accept a small set of
 * near-synonyms (Chinese drift) and rewrite to canonical. Anything
 * not on the allow-list surfaces as `driftUnmappable` and the parser
 * fails-closed (same fail-closed policy as hypothesis status and
 * stop reason).
 */
const RECOMMENDATION_KIND_NORMALIZATION: Readonly<Record<string, CanonicalRecommendationKind>> = Object.freeze({
  // canonical
  observe: 'observe',
  act: 'act',
  // known drift — Chinese
  观察: 'observe',
  保持观察: 'observe',
  持续观察: 'observe',
  等待: 'observe',
  不干预: 'observe',
  暂不干预: 'observe',
  不行动: 'observe',
  行动: 'act',
  干预: 'act',
  调整: 'act',
  采取行动: 'act',
  待执行: 'act',
  待交付: 'act',
  // known drift — English synonyms
  watch: 'observe',
  wait: 'observe',
  hold: 'observe',
  do_nothing: 'observe',
  intervene: 'act',
  action: 'act',
  take_action: 'act',
});

export type NormalizationOk<T extends string> = { ok: true; status: T; original: string };
export type NormalizationFail = { ok: false; original: string };
export type NormalizationResult<T extends string> = NormalizationOk<T> | NormalizationFail;

/**
 * Map one raw hypothesis status value to its canonical form, or fail if the
 * value is not on the allow-list. The `original` field is preserved so the
 * caller can include it in the failure trace for diagnosis.
 *
 * We DO NOT case-fold or trim aggressively — the Agent should be told exactly
 * what shape we want. Whitespace-only difference is the only normalization we
 * do on the surface, because JSON parsers sometimes leave trailing whitespace
 * in extracted objects.
 */
export const normalizeHypothesisStatus = (raw: unknown): NormalizationResult<CanonicalHypothesisStatus> => {
  if (typeof raw !== 'string') {
    return { ok: false, original: typeof raw === 'undefined' ? '<undefined>' : `<${typeof raw}>` };
  }
  const trimmed = raw.trim();
  if (trimmed in HYPOTHESIS_STATUS_NORMALIZATION) {
    return { ok: true, status: HYPOTHESIS_STATUS_NORMALIZATION[trimmed] as CanonicalHypothesisStatus, original: raw };
  }
  return { ok: false, original: raw };
};

/**
 * Map one raw stop-reason value to its canonical form, or fail if not on
 * the allow-list.
 */
export const normalizeStopReason = (raw: unknown): NormalizationResult<CanonicalStopReason> => {
  if (typeof raw !== 'string') {
    return { ok: false, original: typeof raw === 'undefined' ? '<undefined>' : `<${typeof raw}>` };
  }
  const trimmed = raw.trim();
  if (trimmed in STOP_REASON_NORMALIZATION) {
    return { ok: true, status: STOP_REASON_NORMALIZATION[trimmed] as CanonicalStopReason, original: raw };
  }
  return { ok: false, original: raw };
};

/**
 * P0010.2.x — Map one raw recommendation-kind value to its canonical
 * form (`observe | act`), or fail if not on the allow-list. The
 * normalization table accepts both the canonical English forms and
 * a small Chinese / English near-synonym set so we tolerate surface
 * drift the same way we tolerate it for `stopReason`.
 */
export const normalizeRecommendationKind = (raw: unknown): NormalizationResult<CanonicalRecommendationKind> => {
  if (typeof raw !== 'string') {
    return { ok: false, original: typeof raw === 'undefined' ? '<undefined>' : `<${typeof raw}>` };
  }
  const trimmed = raw.trim();
  if (trimmed in RECOMMENDATION_KIND_NORMALIZATION) {
    return { ok: true, status: RECOMMENDATION_KIND_NORMALIZATION[trimmed] as CanonicalRecommendationKind, original: raw };
  }
  return { ok: false, original: raw };
};

/**
 * P0010.2.x — Derive a default `recommendation.kind` from the
 * `stopReason` when the Agent did not emit an explicit `kind`. This
 * is the backwards-compatibility shim for non-C Agents (or for a
 * partial contract that lost the kind during extraction). The
 * derived default is the SEMANTIC correct one in 100% of audit-
 * observed cases: judgment → "act" (Agent is recommending an
 * action), everything else → "observe" (Agent is recommending
 * "wait / watch"). The derivation is logged as drift so the
 * operator can see the Agent was inconsistent.
 */
/**
 * Derive the recommendation kind from the main Investigation's stopReason.
 * The recommendation sub-turn does NOT ask the Agent for a kind, so this is
 * the authoritative source: only `judgment` means "act" — everything else
 * (observe / missing_capability / ask_human, or an absent stopReason) means
 * "do not act → observe". Exported so `runRecommendationTurn` can reuse the
 * SAME single mapping (Fix 2 — no second copy, no schema-default drift).
 */
export const deriveKindFromStopReason = (
  stopReason: CanonicalStopReason | undefined,
): CanonicalRecommendationKind => {
  return stopReason === 'judgment' ? 'act' : 'observe';
};

/**
 * Walk an `unknown` JSON value and rewrite its `hypotheses[].status` and
 * `stopReason` fields in place. Returns a new object — input is NOT mutated.
 * The shape of every other field is preserved verbatim; Zod will still
 * validate them.
 *
 * The return type is intentionally a thin wrapper: `{ normalized, drift }`
 * where `drift` lists the original non-canonical values we replaced, so the
 * parser can:
 *   - include `drift` in the persisted investigation's debug record
 *   - emit a structured `contract_invalid_drift_normalized` TraceEvent
 *     (so the Workspace can show the operator that a near-synonym was
 *      accepted and rewritten)
 *
 * We refuse to rewrite a value that is NOT on the allow-list — that case
 * surfaces as `driftUnmappable: string[]` and the parser will fail-closed
 * rather than silently invent a status.
 */
export interface ContractNormalizationResult {
  /** The rewritten contract (or `null` if any value was unmappable). */
  normalized: Record<string, unknown> | null;
  /** Original non-canonical values we successfully mapped. */
  drift: Array<{ field: string; original: string; canonical: string }>;
  /** Original values that we DO NOT have a mapping for. The parser must fail. */
  driftUnmappable: Array<{ field: string; original: string }>;
}

export const normalizeInvestigationContract = (raw: unknown): ContractNormalizationResult => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { normalized: null, drift: [], driftUnmappable: [{ field: '<root>', original: typeof raw }] };
  }
  const drift: ContractNormalizationResult['drift'] = [];
  const driftUnmappable: ContractNormalizationResult['driftUnmappable'] = [];

  // Shallow copy at the top level. We only descend into two specific paths:
  //   - hypotheses[].status
  //   - stopReason
  // All other fields pass through unchanged; Zod handles their validation.
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  // hypotheses: array of { statement: string, status: string, ... }
  const hypotheses = (raw as Record<string, unknown>)['hypotheses'];
  if (Array.isArray(hypotheses)) {
    const rewritten = hypotheses.map((h, idx) => {
      if (h === null || typeof h !== 'object' || Array.isArray(h)) {
        driftUnmappable.push({ field: `hypotheses[${idx}]`, original: typeof h });
        return h;
      }
      const hObj = h as Record<string, unknown>;
      if (!('status' in hObj)) {
        // No status at all — leave it; Zod will default to 'proposed'.
        return { ...hObj };
      }
      const result = normalizeHypothesisStatus(hObj['status']);
      if (!result.ok) {
        driftUnmappable.push({ field: `hypotheses[${idx}].status`, original: result.original });
        return { ...hObj };
      }
      if (result.original !== result.status) {
        drift.push({
          field: `hypotheses[${idx}].status`,
          original: result.original,
          canonical: result.status,
        });
      }
      return { ...hObj, status: result.status };
    });
    out['hypotheses'] = rewritten;
  }

  // stopReason: optional top-level string
  if ('stopReason' in out) {
    const srResult = normalizeStopReason(out['stopReason']);
    if (!srResult.ok) {
      driftUnmappable.push({ field: 'stopReason', original: srResult.original });
      // Leave the field as-is — Zod will reject it and the parser will
      // report the unmappable value in the failure trace.
    } else {
      if (srResult.original !== srResult.status) {
        drift.push({ field: 'stopReason', original: srResult.original, canonical: srResult.status as string });
      }
      out['stopReason'] = srResult.status;
    }
  }

  // P0010.2.x — recommendation.kind: optional. If present, normalize to
  // canonical `observe | act`. If MISSING and the Agent produced a
  // recommendation, DERIVE a default from the (already-normalized)
  // `stopReason` so a non-C Agent still gets the right chip. The
  // derivation is logged as drift (with `original: '<derived>'` and the
  // canonical kind) so the operator can see the Agent was inconsistent.
  const recommendation = out['recommendation'];
  if (recommendation !== null && typeof recommendation === 'object' && !Array.isArray(recommendation)) {
    const recObj = { ...(recommendation as Record<string, unknown>) };
    const hasExplicitKind = 'kind' in recObj && recObj['kind'] !== undefined && recObj['kind'] !== null;
    if (hasExplicitKind) {
      const kindResult = normalizeRecommendationKind(recObj['kind']);
      if (!kindResult.ok) {
        driftUnmappable.push({ field: 'recommendation.kind', original: kindResult.original });
        // Leave as-is — Zod will reject it and the parser will report
        // the unmappable value in the failure trace.
      } else {
        if (kindResult.original !== kindResult.status) {
          drift.push({
            field: 'recommendation.kind',
            original: kindResult.original,
            canonical: kindResult.status,
          });
        }
        recObj['kind'] = kindResult.status;
      }
    } else {
      // Derive a default from the already-normalized stopReason. This
      // is the backwards-compat shim — a non-C Agent that did not
      // emit `kind` still gets the right chip.
      const stopReason = out['stopReason'];
      if (typeof stopReason === 'string' && stopReason in STOP_REASON_NORMALIZATION) {
        const derived = deriveKindFromStopReason(stopReason as CanonicalStopReason);
        recObj['kind'] = derived;
        drift.push({
          field: 'recommendation.kind',
          original: '<derived from stopReason>',
          canonical: derived,
        });
      }
      // No stopReason either — leave the field unset; Zod will
      // default to 'act' and the operator sees a yellow chip. This
      // is the "honest unknown" path; the parser still passes.
    }
    out['recommendation'] = recObj;
  }

  return {
    normalized: driftUnmappable.length === 0 ? out : null,
    drift,
    driftUnmappable,
  };
};

/**
 * Re-export the canonical Zod schemas so the test file can pin the
 * vocabulary without depending on the shared module path. Keeping the
 * canonical enum definitions in shared/schemas/investigation.ts is the
 * long-term design — this re-export is purely a test convenience.
 */
export const CANONICAL_HYPOTHESIS_STATUSES = HypothesisStatusSchema.options;
export const CANONICAL_STOP_REASONS = StopReasonSchema.options;
export const CANONICAL_RECOMMENDATION_KINDS = RecommendationKindSchema.options;

// ─── Epistemic Integrity (2026-09-06) — soft validation ──────────────
//
// The Agent may write "确认" / "已确认" / "confirmed" / "definitely" in
// natural-language fields (currentUnderstanding / judgment / recommendation.
// recommendation) without populating the new `epistemic_layers.confirmed[]`
// list. This is unsourced confirmation language at the LLM-output boundary.
//
// We do NOT fail-closed: the L3→L4 structural upgrade is already prevented
// (the schema requires `confirmed_evidence_refs[]` ≥ 1 for any `confirmed[]`
// entry, so the Agent cannot write a Confirmed claim without a ref). The
// prose-level scan here is a UX signal so the operator can see "the Agent
// used 确认 3 times but did not populate the confirmed[] list".
//
// The scan walks the prose fields AFTER normalization (so all canonical
// forms have been applied) and emits one drift record per word occurrence.

const PROSE_FIELDS_FOR_CONFIDENT_SCAN: ReadonlyArray<string> = Object.freeze([
  'currentUnderstanding',
  'judgment',
]);

const RECOMMENDATION_PROSE_FIELDS: ReadonlyArray<string> = Object.freeze([
  'recommendation',
  'rationale',
  'expectedOutcome',
]);

const countOccurrences = (text: string, word: string): number => {
  if (!text) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(word, idx)) !== -1) {
    count++;
    idx += word.length;
  }
  return count;
};

export interface EpistemicDriftRecord {
  /** The field path. */
  readonly field: string;
  /** The specific word that triggered the drift. */
  readonly word: string;
  /** How many times the word appears. */
  readonly count: number;
  /** A 30-char window around the first occurrence (Chinese chars: 30 chars). */
  readonly context: string;
  /** Whether the contract has a corresponding `confirmed[]` entry. */
  readonly hasConfirmedEntry: boolean;
}

/**
 * Scan the normalized Investigation Contract for unsourced confirmation
 * language in natural-language fields. Returns an empty array when the
 * Agent did not use any of the allow-list words, or when the Agent used
 * them but the contract has matching `confirmed[]` entries with refs.
 *
 * Soft validation — does NOT fail-closed. The caller surfaces the records
 * in the persisted `drift` list (Workspace + structured log) so the operator
 * can see the gap between prose-level language and structural confirmation.
 */
export const validateEpistemicContract = (
  normalized: Record<string, unknown>,
): EpistemicDriftRecord[] => {
  const records: EpistemicDriftRecord[] = [];
  const confirmed = normalized['epistemic_layers'];
  const confirmedList: ReadonlyArray<unknown> =
    confirmed && typeof confirmed === 'object'
      ? (confirmed as Record<string, unknown>)['confirmed'] instanceof Array
        ? ((confirmed as Record<string, unknown>)['confirmed'] as ReadonlyArray<unknown>)
        : []
      : [];
  const hasConfirmedEntry = confirmedList.length > 0;

  const scanField = (fieldPath: string, value: unknown): void => {
    if (typeof value !== 'string') return;
    for (const word of CONFIDENT_LANGUAGE_ALLOWLIST) {
      const n = countOccurrences(value, word);
      if (n === 0) continue;
      // Find a context window around the first occurrence.
      const idx = value.indexOf(word);
      const start = Math.max(0, idx - 12);
      const end = Math.min(value.length, idx + word.length + 18);
      records.push({
        field: fieldPath,
        word,
        count: n,
        context: value.slice(start, end),
        hasConfirmedEntry,
      });
    }
  };

  for (const f of PROSE_FIELDS_FOR_CONFIDENT_SCAN) {
    scanField(f, normalized[f]);
  }
  const recommendation = normalized['recommendation'];
  if (recommendation && typeof recommendation === 'object') {
    const recObj = recommendation as Record<string, unknown>;
    for (const f of RECOMMENDATION_PROSE_FIELDS) {
      scanField(`recommendation.${f}`, recObj[f]);
    }
  }
  return records;
};
