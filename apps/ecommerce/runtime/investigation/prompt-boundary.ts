// P0013.5 — the Fabric/Hermes boundary, as a machine check.
//
// Success Criterion 1 requires that the cognition prompts contain no
// Fabric-owned tool ordering, retry budget, fixed execution sequence or
// tool-call control flow, **and that an audit script can report those
// categories as 0 unexempted instances**. This module is that check: it scans
// RENDERED prompt text for Execution-HOW shapes and returns every match, so a
// prompt regression fails a test instead of relying on review.
//
// Two deliberate design choices:
//
//   1. It scans the RENDERED prompt, not the source. A pattern that only exists
//      in a comment or a string that is never emitted is not in the prompt.
//
//   2. Exemptions are explicit and carry a reason. Some Execution-HOW-looking
//      text is legitimately Fabric's — the permission boundary names the tools
//      it forbids, and the resolution vocabulary is a state set that happens to
//      use arrows. An unexplained exemption is not allowed: the exemption list
//      is asserted to be exactly the declared set, so adding one is a visible
//      change rather than a silent loosening.

/** One Execution-HOW shape Fabric must not own. */
export interface ExecutionHowPattern {
  readonly id: string;
  readonly re: RegExp;
  readonly why: string;
}

/**
 * The shapes that constitute Execution HOW — i.e. how THIS RUN is carried out,
 * as opposed to how this DOMAIN should be explored.
 */
export const EXECUTION_HOW_PATTERNS: readonly ExecutionHowPattern[] = Object.freeze([
  {
    id: 'numbered-procedure',
    re: /^\s*\d+\.\s+(\*\*)?(Frame|Read the|Read relevant|Form|Ask|Call|Use the|Stop per|Emit the|Check the)/m,
    why: 'a fixed numbered procedure prescribes the reasoning order',
  },
  {
    id: 'retry-budget',
    re: /\bretry (once|twice|ONCE|TWICE|\d+ times?)\b/i,
    why: 'a retry budget is Runtime policy',
  },
  {
    id: 'attempt-limit',
    re: /\b(no more than|at most) \d+ (times|attempts|retries)\b/i,
    why: 'an attempt limit is Runtime policy',
  },
  {
    id: 'call-budget',
    re: /\b(?:use|call|invoke) (?:it |them )?at most (?:once|twice|\d+)\b/i,
    why: 'a call budget is Runtime policy',
  },
  {
    id: 'once-per-gap',
    re: /\bcall ONCE per\b/i,
    why: 'a per-gap call budget is Runtime policy',
  },
  {
    id: 'preapproved-call-pattern',
    re: /\b(allowed|forbidden) pattern\s*:/i,
    why: 'pre-approved call sequences are tool orchestration',
  },
  {
    id: 'tool-chain-arrow',
    re: /→[^\n]{0,80}\b(call|retrieve|read_file|list_files|tool_search|capability|query)\b[^\n]{0,80}→/i,
    why: 'an arrow chain over tool names is a prescribed call order',
  },
  {
    id: 'then-call-tool',
    re: /\bthen (?:call|invoke|read|use) (?:the )?`?(?:fabric_|mcp__|read_file|search_files|list_files)/i,
    why: '“then call X” prescribes the next tool',
  },
  {
    id: 'index-first-procedure',
    re: /INDEX\.md[^\n]{0,60}→[^\n]{0,80}INDEX\.md/i,
    why: 'index-first navigation is a search strategy',
  },
  {
    id: 'retrieve-then-continue',
    re: /\bretrieve (?:it|the evidence|them)[^\n]{0,40}\bthen continue\b/i,
    why: 'retrieve-then-continue is control flow',
  },
]);

/** A match that is legitimately Fabric's, with the reason it is exempt. */
export interface DeclaredExemption {
  readonly patternId: string;
  readonly anchor: string;
  readonly reason: string;
}

/**
 * Declared exemptions. Each is a place where the SHAPE matches but the CONTENT
 * is a boundary Fabric owns. Keep this list short and justified — the contract
 * test asserts it is exactly this set.
 */
export const DECLARED_EXEMPTIONS: readonly DeclaredExemption[] = Object.freeze([
  {
    patternId: 'attempt-limit',
    anchor: 'Do NOT retry, do NOT rephrase',
    reason:
      'the tool layer’s own blocked-call notice (Hermes-side), quoted nowhere in Fabric’s prompts — reserved for text that reaches the model from the Runtime, not from Fabric',
  },
]);

export interface ExecutionHowMatch {
  readonly patternId: string;
  readonly why: string;
  /** The matching line, trimmed and truncated for reporting. */
  readonly line: string;
  readonly exempt: boolean;
  readonly exemptionReason?: string;
}

/**
 * Scan one rendered prompt. Returns every match, exempt ones included, so a
 * caller can report both totals.
 */
export const scanForExecutionHow = (prompt: string): ExecutionHowMatch[] => {
  const out: ExecutionHowMatch[] = [];
  for (const line of prompt.split('\n')) {
    for (const p of EXECUTION_HOW_PATTERNS) {
      if (!p.re.test(line)) continue;
      const exemption = DECLARED_EXEMPTIONS.find(
        (e) => e.patternId === p.id && line.includes(e.anchor),
      );
      out.push({
        patternId: p.id,
        why: p.why,
        line: line.trim().slice(0, 120),
        exempt: exemption !== undefined,
        ...(exemption ? { exemptionReason: exemption.reason } : {}),
      });
    }
  }
  return out;
};

/** Just the matches Fabric does not own. This is what SC1 requires to be 0. */
export const unexemptedExecutionHow = (prompt: string): ExecutionHowMatch[] =>
  scanForExecutionHow(prompt).filter((m) => !m.exempt);
