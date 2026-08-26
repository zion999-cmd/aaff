// Interaction Grammar — browser-loadable definition of the P0007.2 Human
// Intervention grammar. Moved out of situation-viewmodel.ts (a .ts file the
// vanilla-JS workspace cannot load) so it is the single source of truth for the
// interaction surface. Loaded as a plain script (globals), before app.js.
//
// app.js renders the buttons from INTERACTION_OPTIONS and builds the type-specific
// structured `content` via buildInterventionContent — no divergent hardcoded copy.
//
// P0010.2.4 (ADR-060 audit C) — Split into two distinct sections:
//   - `judgment`  : 对 Agent 当前判断的反馈 (3 buttons, all non-blocking)
//   - `suggestion`: 对 Agent 建议的处理 (3 buttons, all non-blocking,
//                   explicitly NOT a trigger for external execution)
// All 6 buttons are recorded as humanInterventions in learning_contexts.body
// and are consumed by the next investigation turn via
// `formatPriorHumanGuidance` (apps/ecommerce/runtime/investigation/prompt.ts).
// The "accept" branch on suggestion is a DISPOSITION recorded for the
// operator's tracking; it MUST NOT trigger any external execution
// (no Action Engine, no approval route, no external sending) — see
// `executionDisabled: true` on the option.

var INTERACTION_OPTIONS = [
  // ─── Section 1: 对 Agent 当前判断的反馈 (judgment) ─────────────
  { label: '认同', grammarType: 'response', section: 'judgment',
    requiresInput: false, inputPlaceholder: '', decision: null,
    executionDisabled: true, summaryKind: 'agree' },
  { label: '这里判断错了', grammarType: 'correction', section: 'judgment',
    requiresInput: true, inputPlaceholder: '正确的判断是什么？', decision: null,
    executionDisabled: true, summaryKind: 'correction' },
  { label: '补充情况', grammarType: 'context_supplement', section: 'judgment',
    requiresInput: true, inputPlaceholder: '什么情况？', decision: null,
    executionDisabled: true, summaryKind: 'supplement' },
  // ─── Section 2: 对 Agent 建议的处理 (suggestion) ──────────────
  // CRITICAL: `executionDisabled: true` on every suggestion-section entry.
  // The "accept" verb records the operator's disposition; it does NOT
  // trigger external execution. Action Engine / Approval / external
  // sending are explicitly OUT OF SCOPE for P0010.2.4.
  { label: '已纳入考量', grammarType: 'decision', section: 'suggestion',
    requiresInput: false, inputPlaceholder: '', decision: 'accept',
    executionDisabled: true, summaryKind: 'decision' },
  { label: '暂不采用', grammarType: 'decision', section: 'suggestion',
    requiresInput: true, inputPlaceholder: '为什么不采用？', decision: 'reject',
    executionDisabled: true, summaryKind: 'decision' },
  { label: '稍后再看', grammarType: 'decision', section: 'suggestion',
    requiresInput: false, inputPlaceholder: '', decision: 'defer',
    executionDisabled: true, summaryKind: 'decision' },
];

/** Section metadata for the two button rows. UI reads `label` only. */
var INTERACTION_SECTIONS = {
  judgment:  { label: '判断反馈',    detail: '针对 Agent 当前判断' },
  suggestion: { label: '建议处理',   detail: '针对 Agent 给出的建议（仅记录，不触发外部执行）' },
};

/**
 * Build the type-specific structured content per InterventionContentSchema.
 *
 * P0010.2.4 review repair (ADR-061) — the `decision` branch no longer
 * pre-fills `content.appliesTo = {}`. The current `Recommendation` schema
 * (shared/schemas/investigation.ts:55-65) has NO stable id field, so
 * the workspace cannot bind a decision intervention to a specific
 * recommendation without fabricating an identifier. Until the
 * Recommendation schema gains an id, decision interventions carry an
 * empty `appliesTo` and the next-turn prompt renders
 * `[no-target-bound]`. Recording this gap here so the next reviewer
 * does not re-add the fake binding.
 */
function buildInterventionContent(option, text) {
  var content = { type: option.grammarType };
  // P0010.2.4 — every produced intervention is non-blocking by default.
  // The runtime reads this and never pauses on account of an operator
  // clicking a judgment/suggestion button; the next Loop tick proceeds.
  content.executionDisabled = option.executionDisabled === true;
  switch (option.grammarType) {
    case 'response':
      content.respondsTo = { agentActivityIds: [], signalIds: [], observationIds: [] };
      content.evaluation = 'agree';
      break;
    case 'correction':
      content.corrects = {};
      content.correction = text || '';
      break;
    case 'context_supplement':
      content.supplements = {};
      content.information = text || '';
      break;
    case 'decision':
      content.decision = option.decision || 'accept';
      // `appliesTo` is intentionally NOT pre-populated. The workspace
      // has no source of `recommendationId` (the Recommendation schema
      // has no id field). When the call site has a real target it
      // should pass it in as a second arg via the future
      // `buildDecisionInterventionContent(option, text, appliesTo)`
      // entrypoint. For now, this empty object signals
      // "no-target-bound" to the next-turn prompt.
      content.appliesTo = {};
      if (text) content.rationale = text;
      // P0010.2.4 — explicit re-affirmation that decision interventions
      // do not trigger external execution. The runtime never reads
      // content.decision === 'accept' as a cue to do anything; it only
      // surfaces the operator's disposition to the next investigation
      // turn via `formatPriorHumanGuidance`.
      content.executionDisabled = true;
      break;
    case 'action_intent':
      content.description = text || '';
      content._hypothesis = true;
      break;
  }
  return content;
}

/** Human-readable summary for the intervention record. */
function buildInterventionSummary(option, text) {
  if (text) return option.label + ': ' + text;
  return option.label;
}

/** Group options by section — used by the UI to render two button rows. */
function groupOptionsBySection() {
  var out = { judgment: [], suggestion: [] };
  for (var i = 0; i < INTERACTION_OPTIONS.length; i++) {
    var opt = INTERACTION_OPTIONS[i];
    if (!out[opt.section]) out[opt.section] = [];
    out[opt.section].push(opt);
  }
  return out;
}
