// P0010 — Investigation Contract parser.
//
// Extracts the structured Investigation Contract from a Runtime reply. The
// Agent is asked to output ONLY the JSON object; this parser is defensive
// (finds the last balanced {...} block) and validates against the schema.
//
// P0010.2 Production Investigation Contract Repair — the parser now does
// explicit vocabulary normalization at the raw → canonical boundary (see
// ./normalize.ts). The allow-list of known equivalent values is the SINGLE
// place where we tolerate Agent drift. Any value not on the allow-list is
// fail-closed: the parser returns `contract_invalid` and the runtime marks
// the investigation failed with a structured reason the operator can act on.
//
// The parser does NOT hand-pick fields out of a failed reply. The previous
// fallback path (`reply2` re-prompt) is preserved: if the FIRST reply did
// not produce a valid contract, we ask the Agent to emit ONLY the JSON
// object in the SAME session. We do not synthesize the contract from prose.

import { InvestigationSchema } from '#shared/schemas/investigation.js';
import type { Investigation } from '#shared/schemas/investigation.js';
import {
  normalizeInvestigationContract,
  type ContractNormalizationResult,
} from './normalize.js';

export type ParseInvestigationResult =
  | { ok: true; investigation: Investigation; drift: ContractNormalizationResult['drift'] }
  | { ok: false; error: string; unmappable?: ContractNormalizationResult['driftUnmappable'] };

/** Find the last complete {...} object in arbitrary text (outermost, balanced). */
export const extractJsonObject = (text: string): string | null => {
  const end = text.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (text[i] === '}') depth++;
    else if (text[i] === '{') {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null; // unbalanced — no complete outer object
};

/**
 * Parse + validate an Investigation Contract from a Runtime reply.
 *
 * Two-step: (1) try safeParse on the raw object; (2) on failure, try with
 * vocabulary normalization applied at the raw boundary. If both fail, we
 * fail-closed with the unmappable values so the operator can see exactly
 * which field tripped the contract.
 */
export const parseInvestigation = (reply: string, situationId: string): ParseInvestigationResult => {
  const candidate = extractJsonObject(reply);
  if (!candidate) {
    return { ok: false, error: 'No JSON Investigation Contract found in the reply.' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      error: `Investigation JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Stamp the situationId so a slightly-off id still validates; the reply is
  // Agent-produced, so we treat it as untrusted input.
  const withId = typeof raw === 'object' && raw !== null
    ? { ...(raw as Record<string, unknown>), situationId }
    : raw;

  // (1) Direct parse — no normalization. This is the fast path for the
  // common case where the Agent honored the prompt.
  const direct = InvestigationSchema.safeParse(withId);
  if (direct.success) {
    return { ok: true, investigation: direct.data, drift: [] };
  }

  // (2) Normalized parse — apply the allow-list at the raw boundary. This
  // is for the documented drift cases (`confirmed`, `strongly_supported`,
  // `partially_rejected`, `complete`, `wait`).
  const norm = normalizeInvestigationContract(withId);
  if (norm.normalized !== null) {
    const normalized = InvestigationSchema.safeParse(norm.normalized);
    if (normalized.success) {
      return { ok: true, investigation: normalized.data, drift: norm.drift };
    }
    // The vocabulary was mappable but the contract is still invalid for
    // some other reason (e.g. missing required field, wrong type). Fall
    // through to the failure path so the operator sees the real Zod error.
    return {
      ok: false,
      error: `Invalid Investigation Contract after vocabulary normalization: ${normalized.error.message}`,
      unmappable: norm.driftUnmappable,
    };
  }

  // (3) Normalization refused — there is drift we do not have a mapping
  // for. Surface the EXACT values so the operator / Agent can see what
  // we rejected. This is the fail-closed path: we do NOT silently invent
  // a status, we do NOT pick fields out of the failed reply.
  return {
    ok: false,
    error: `Invalid Investigation Contract: ${direct.error.message}`,
    unmappable: norm.driftUnmappable,
  };
};
