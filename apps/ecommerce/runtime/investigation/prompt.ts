// P0010 — Investigation prompt (Fabric-owned).
//
// This is the ONLY prompt that launches a Knowledge-Guided Investigation. It
// carries the situation + current evidence as DATA, and instructs the Runtime
// (Hermes) HOW to investigate. It does NOT contain business rules, hardcoded
// questions, or an investigation tree — the Agent decides what to ask based on
// the professional Knowledge it reads from knowledge/.

import type { LearningContext, Situation } from '#shared/schemas/learning-context.js';
import {
  ANALYSIS_TARGET_SECTION,
  ANALYSIS_OUTPUT_OBLIGATIONS,
  COGNITION_CONTINUITY_SECTION,
  EVIDENCE_RESOLUTION_SECTION,
  EVIDENCE_SUFFICIENCY_SECTION,
  KNOWLEDGE_ANALYSIS_SECTION,
  EPISTEMIC_DISCIPLINE_SECTION,
  PROVENANCE_SECTION,
  OUTPUT_CONTRACT_SECTION,
  formatPriorCognitionSection,
} from './analysis-contract.js';

/** Flatten the situation's current evidence into compact, data-only lines. */
export const formatSituationEvidence = (ctx: LearningContext | null): string => {
  if (!ctx) return '(no learning context yet)';
  const lines: string[] = [];
  for (const obs of ctx.observations ?? []) {
    const metrics = obs.metricsSnapshot ? JSON.stringify(obs.metricsSnapshot) : '';
    lines.push(
      `- ${obs.summary}${metrics ? ` (metrics: ${metrics})` : ''}` +
        `${obs.evidenceIds?.length ? ` [evidence: ${obs.evidenceIds.length} refs]` : ''}` +
        `${obs.signalIds?.length ? ` [signals: ${obs.signalIds.length} refs]` : ''}` +
        ` acquired via ${obs.provider.platform}/${obs.provider.acquisition}`,
    );
  }
  if (lines.length === 0) return '(no observation records)';
  return lines.join('\n');
};

/**
 * P0010.1 Prior Human Guidance — flatten the situation's persisted
 * humanInterventions into a section the Agent MUST consider as ONE input
 * (not the only input). correction / context_supplement are important
 * human input the Agent should weigh alongside Evidence; if they conflict
 * with hard Evidence, the Agent should call that out rather than silently
 * override either side. response / decision are feedback on the Agent's
 * prior output, not factual constraints on Evidence.
 *
 * P0010.2.4 (ADR-060 audit C) — the consumer must also expose:
 *   - the section ("judgment" | "suggestion") the operator was responding
 *     to, so the next turn can distinguish "I disagree with your reading"
 *     from "I'm not acting on your recommendation";
 *   - the executionDisabled invariant for any decision/suggestion
 *     intervention — a hard re-affirmation that the operator's `accept`
 *     records a disposition and does NOT trigger external execution;
 *   - the appliesTo target (recommendationId / agentActivityId) when
 *     present, so the Agent can map a decision back to the prior output
 *     it was responding to.
 *
 * P0010.2.4 review repair (ADR-061) — explicit "feedback ≠ wake" note:
 *   Writing a human intervention does NOT itself wake the Runtime loop.
 *   The Loop's investigation policy (apps/ecommerce/runtime/loop/
 *   investigation-policy.ts) re-evaluates a situation only when EITHER
 *   the producer's new contentHash differs from the prior sidecar
 *   (`meaningful_new_evidence`) OR the recovery scan picks the
 *   situation up as `failed_retryable` / `interrupted` / `no_investigation`.
 *   Human interventions are NOT a wake signal. They are only consumed by
 *   the next investigation turn that happens to fire for some other
 *   reason. This is the only path by which a human correction,
 *   supplement, or decision reaches the next Agent. If the operator
 *   wants their feedback to take effect *now*, they must wait for
 *   the next natural investigation turn (or the next producer tick
 *   that changes the contentHash). The Wake Engine / Event Bus that
 *   would let an intervention trigger an immediate re-investigation is
 *   explicitly out of scope for P0010.2.4. We do NOT claim the feedback
 *   loop is closed until such a wake mechanism exists.
 *
 * Type-specific payload shape (per InterventionContentSchema):
 *   response           — evaluation: agree | disagree | partial | uncertain
 *                         (feedback, NOT a factual constraint on Evidence)
 *   correction         — what is wrong + correctedValue
 *                         (important human input, weigh with Evidence)
 *   context_supplement — information the system cannot observe
 *                         (important human input, weigh with Evidence)
 *   decision           — accept | reject | defer | override | no_action
 *                         (feedback on a prior recommendation; executionDisabled
 *                          MUST be honored — no external action is implied)
 *   (P0010.1 ADR-047 removed `action_intent` from the union; outbound
 *    action is no longer a current guidance input.)
 *
 * Returns a single string starting with a "(no prior human guidance)" sentinel
 * when there are no interventions, so the section is always present and the
 * Agent never silently drops it.
 */
export const formatPriorHumanGuidance = (ctx: LearningContext | null): string => {
  const interventions = ctx?.humanInterventions ?? [];
  if (interventions.length === 0) {
    return '(no prior human guidance — this is the first investigation turn)';
  }

  // P0010.2.4 — once we have surfaced any decision-section intervention,
  // we emit a hard guard line so the next-turn Agent never reads
  // `decision === 'accept'` as a cue for external execution.
  let sawSuggestionDecision = false;

  const lines: string[] = [];
  for (const i of interventions) {
    const content = (i.content ?? {}) as Record<string, unknown>;
    const when = (i.timestamp || '').slice(0, 16);
    // P0010.2.4 — read the section the operator was responding to.
    // The UI writes `content._section`; the schema accepts arbitrary
    // keys on the `content` record (`z.record(z.string(), z.unknown())`),
    // so this round-trips end-to-end.
    const section = (content['_section'] as string | undefined) ?? null;
    const summaryKind = (content['_summaryKind'] as string | undefined) ?? null;
    const sectionLabel =
      section === 'judgment' ? '判断反馈'
      : section === 'suggestion' ? '建议处理'
      : null;
    if (section === 'suggestion' && i.type === 'decision') {
      sawSuggestionDecision = true;
    }
    const sectionTag = sectionLabel ? `[${sectionLabel}] ` : '';
    const kindTag = summaryKind ? `{${summaryKind}} ` : '';
    switch (i.type) {
      case 'response': {
        const eval_ = (content['evaluation'] as string) || 'unspecified';
        const rationale = content['rationale'] as string | undefined;
        lines.push(
          `- [${when}] ${sectionTag}${kindTag}用户对 Agent ${eval_}` +
            (rationale ? ` — 理由: ${rationale}` : ''),
        );
        break;
      }
      case 'correction': {
        const correction = (content['correction'] as string) || '(no correction text)';
        const correctedValue = content['correctedValue'];
        lines.push(
          `- [${when}] ${sectionTag}${kindTag}用户纠正: ${correction}` +
            (correctedValue !== undefined ? ` (正确值: ${JSON.stringify(correctedValue)})` : ''),
        );
        break;
      }
      case 'context_supplement': {
        const information = (content['information'] as string) || '(no information text)';
        const aspect = (content['supplements'] as Record<string, unknown> | undefined)?.['situationAspect'] as string | undefined;
        lines.push(
          `- [${when}] ${sectionTag}${kindTag}用户补充${aspect ? ` (${aspect})` : ''}: ${information}`,
        );
        break;
      }
      case 'decision': {
        const decision = (content['decision'] as string) || 'unspecified';
        const rationale = content['rationale'] as string | undefined;
        // P0010.2.4 review repair (ADR-061) — the `appliesTo` target
        // surface is preserved for future schema support, but the
        // CURRENT production workspace cannot populate it: the
        // `Recommendation` schema (shared/schemas/investigation.ts:55-65)
        // has no stable id field. We render `[no-target-bound]` when
        // the target is empty so the Agent explicitly sees that the
        // decision is not bound to a specific recommendation — it is a
        // general disposition for the situation's current state, not
        // a yes/no on a particular suggestion. Once Recommendation
        // gains an id, `buildInterventionContent` will be updated to
        // accept it and this surface will switch to
        // `recommendation=<id>` automatically.
        const appliesTo = content['appliesTo'] as
          | { agentActivityId?: string; recommendationId?: string; signalId?: string }
          | undefined;
        const targetParts: string[] = [];
        if (appliesTo?.recommendationId) targetParts.push(`recommendation=${appliesTo.recommendationId}`);
        if (appliesTo?.agentActivityId) targetParts.push(`agentActivity=${appliesTo.agentActivityId}`);
        if (appliesTo?.signalId) targetParts.push(`signal=${appliesTo.signalId}`);
        const targetStr = targetParts.length
          ? ` (目标: ${targetParts.join('; ')})`
          : ' (目标: [no-target-bound — 当前 schema 不支持绑定到具体 Recommendation])';
        // P0010.2.4 — for any decision intervention originating in the
        // suggestion section, re-affirm the executionDisabled invariant
        // inline. The Agent MUST NOT interpret `accept` as execution
        // intent. Action Engine / Approval / external sending are
        // explicitly out of scope for P0010.2.4.
        const execGuard =
          section === 'suggestion' ? ' (no-execution: 仅记录处置，不触发外部执行)' : '';
        lines.push(
          `- [${when}] ${sectionTag}${kindTag}用户已决定: ${decision}${targetStr}${execGuard}` +
            (rationale ? ` — 理由: ${rationale}` : ''),
        );
        break;
      }
      // P0010.1 Final Repair (ADR-047) — `action_intent` is removed from
      // the discriminated union of `type`, so this case is now
      // unreachable at the type level. Kept here as a comment so a
      // future contributor who re-introduces it knows the consumer
      // contract: outbound action is NOT a current guidance input.
      default:
        lines.push(`- [${when}] 用户输入 (${i.type}): ${i.summary || ''}`);
    }
  }
  // P0010.2.4 — when ANY suggestion-section decision has been recorded,
  // prepend a guard line so the next-turn Agent is told up-front that
  // the operator's `accept` is a disposition, not an execution cue.
  if (sawSuggestionDecision) {
    lines.unshift(
      '> [P0010.2.4 硬约束] 上述 [建议处理] 块中的所有 `accept` 均为操作员处置记录；' +
        'Agent 不得据此触发任何外部执行（Action Engine / Approval / 外发均不在 P0010.2.4 范围内）。',
    );
  }
  return lines.join('\n');
};

/**
 * Build the investigation instruction for one situation.
 *
 * P0010.2.6 — consolidated the prompt-level-vs-Runtime trust boundary
 * into a single `## Runtime Trust Boundary` section. The 3 ADVISORY
 * sub-blocks (tool discovery / source code / side-effect tools) used
 * to each carry a "Hermes does not enforce" note. Now they just state
 * the rule; the trust boundary is explained once, up top.
 *
 * Knowledge / Evidence / Fabric separation and zh-CN business output
 * contract are unchanged from P0010.2.5.
 */
/**
 * P0013.2 — build prior-cognition entries from the situation's PREVIOUS
 * completed investigation (the Learning Context is loaded before the new
 * turn overwrites it). T-1 hypotheses/judgment/recommendations enter as
 * prior cognition, not current evidence — same semantics as Replay.
 */
const buildPriorCognitionEntries = (situation: Situation, ctx: LearningContext | null) => {
  const prior = ctx?.investigation;
  if (!prior || prior.status !== 'completed') return [];
  const businessDate =
    prior.business_date ?? (situation.temporal?.observedAt ?? '').slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(businessDate) ? businessDate : situation.temporal?.observedAt?.slice(0, 10) ?? '';
  const entries: Array<{ business_date?: string; kind: string; content: string; status_at_t_minus_1: string }> = [];
  for (const h of prior.hypotheses ?? []) {
    entries.push({
      ...(date ? { business_date: date } : {}),
      kind: 'prior_hypothesis',
      content: h.statement,
      status_at_t_minus_1: h.status,
    });
  }
  if (prior.judgment?.trim()) {
    entries.push({
      ...(date ? { business_date: date } : {}),
      kind: 'prior_judgment',
      content: prior.judgment,
      status_at_t_minus_1: 'unknown',
    });
  }
  if (prior.recommendation?.recommendation?.trim()) {
    entries.push({
      ...(date ? { business_date: date } : {}),
      kind: 'prior_recommendation',
      content: prior.recommendation.recommendation,
      status_at_t_minus_1: 'unknown',
    });
  }
  return entries;
};

export const buildInvestigationPrompt = (
  situation: Situation,
  ctx: LearningContext | null,
): string => {
  const entity = situation.entity?.name ?? situation.entity?.id ?? 'unknown';
  const priorCognitionEntries = buildPriorCognitionEntries(situation, ctx);
  return [
    `You are investigating ONE business situation in a Fabric Agent Workspace.`,
    ``,
    // ===== P0010.2.6 — Runtime Trust Boundary (single source of truth) =====
    `## Runtime Trust Boundary`,
    ``,
    `Read this ONCE. It applies to every section below.`,
    ``,
    `- **Tool / path restrictions are behavior policies, not a sandbox.** Hermes 0.20.5 does not enforce a path allowlist, a per-session tool-call quota, or a tool-deny list. The \`search_files\` / \`read_file\` surface covers the full Workspace; \`tool_search\` / \`tool_describe\` are unlimited; \`terminal\` / \`execute_code\` are present and work.`,
    `- **The platform validates your OUTPUT, not your tool calls.** The Investigation Contract must be canonical (see Status vocabulary). Canonical status values are normalized by the platform; the WorkItem is materialized ONLY when Zod + normalization pass. If a rule below is impossible to follow, return \`stopReason=missing_capability\` and explain — do not silently violate it.`,
    `- **What this means for the rules below:** the \`ALLOWED\` / \`ADVISORY\` labels describe what the platform EXPECTS you to do. The model is trusted; the platform is the trust boundary.`,
    ``,
    // ===== Tool Surface — PERMISSIONS (not a call schedule) =====
    // P0013.5: this block used to carry retry budgets ("retry ONCE"), a call
    // quota ("at most once per turn"), and pre-approved call patterns
    // ("allowed pattern: A -> B -> C"). Those are Execution HOW — how to drive
    // the tool loop — and belong to the Runtime, not to Fabric. What remains is
    // the permission boundary, which Fabric owns.
    `## Tool Surface — permissions`,
    ``,
    `- **Read-only context you may read:** \`knowledge/\` (professional domain knowledge), \`capabilities/\` (what live data Fabric can provide, and how to call it), \`references/\` (case-log files — only those matching this situation's type / entity), and this situation's own \`investigations/<situationId>.*\`.`,
    `- **Evidence acquisition:** \`mcp__fabric__fabric_execute_capability\` for live data, and \`mcp__fabric__fabric_list_capabilities\` to see what exists. Several acquisitions in one turn are fine when each answers a distinct evidence gap.`,
    `- **Do NOT read or search the agentFabric source tree** (\`platform/\`, \`apps/\`, \`shared/\`, \`tests/\`, \`README\`, \`AGENTS.md\`, \`package.json\`): this investigation is about a business situation, not about this code base.`,
    `- **Do NOT use** \`terminal\`, \`execute_code\`, \`run_command\`, \`sleep\`, \`wait\`, \`setTimeout\`, and **do NOT write any file**. Investigation is read / think / acquire, not execute; Workspace presentation is computed by the platform.`,
    ``,
    // ===== P0013.4 Cognition continuity (shared) =====
    COGNITION_CONTINUITY_SECTION,
    ``,
    // ===== P0013.2 Shared Analysis Contract (Production + Replay) =====
    ANALYSIS_TARGET_SECTION,
    ``,
    // ===== P0013.2 Evidence Resolution (shared; production binding = the
    // live Fabric capability tool already permitted below) =====
    EVIDENCE_RESOLUTION_SECTION,
    ``,
    `Production resolution binding: RETRIEVED means a real \`mcp__fabric__fabric_execute_capability\` call returned the needed evidence (e.g. traffic.overview for traffic structure). A capability that does not exist or returns no answering data is UNAVAILABLE — then, and only then, write evidence_gaps + acquisition_need.`,
    ``,
    // ===== P0013.4 Question-driven investigation & Evidence Sufficiency
    // (shared; the same section text runs in Historical Replay) =====
    EVIDENCE_SUFFICIENCY_SECTION,
    ``,
    `## Situation`,
    `- id: ${situation.situationId}`,
    `- entity: ${entity} (${situation.entity?.platform ?? 'jd'})`,
    `- observed: ${situation.temporal?.observedAt ?? ''}`,
    `- type: ${situation.type}`,
    `- description: ${situation.description}`,
    ``,
    `## Prior Human Guidance (one input; weigh alongside Evidence, do not silently override either side)`,
    // P0010.1 Post-Review REPAIR: prior human guidance is an input, not
    // authoritative. The Agent must NOT silently drop or invert this
    // section, but it also must not use it to override hard Evidence; if
    // the two conflict, the Agent should surface the conflict in the
    // judgment and recommend a human reconciliation.
    `- 权重: correction / context_supplement 是重要人类输入；response / decision 是反馈，不构成 Evidence 级别约束。`,
    formatPriorHumanGuidance(ctx),
    ``,
    `## Current evidence (already observed, do NOT re-acquire unless stale)`,
    formatSituationEvidence(ctx),
    ``,
    `## Recommendation kind`,
    ``,
    `\`recommendation.kind\` describes what the OPERATOR should do, and is independent of why you stopped.`,
    `Use \`observe\` when the operator should not act (keep watching), \`act\` when there is a concrete step to consider.`,
    `A recommendation must follow from your judgment, never from a single metric; it is what to consider, not an execution order.`,
    ``,
    EPISTEMIC_DISCIPLINE_SECTION,
    ``,
    // ===== P0013.5 shared Knowledge obligation (Production + Replay) =====
    KNOWLEDGE_ANALYSIS_SECTION,
    ``,
    PROVENANCE_SECTION,
    ``,
    // ===== P0013.2 Prior cognition — dynamically pre-loaded from this
    // situation's previous completed investigation (Production) or prior
    // Replay day. Same semantics on both paths. =====
    `## Prior Cognition (Historical, NOT Current — P0013.2)`,
    formatPriorCognitionSection(priorCognitionEntries),
    ``,
    `If \`prior_cognition[]\` is non-empty, treat it as PRIOR COGNITION, not current Evidence:`,
    ``,
    `- A T-1 \`status: proposed\` hypothesis is STILL \`proposed\` at T until NEW Evidence at T shifts it.`,
    `- A T-1 \`status: supported\` hypothesis does NOT auto-upgrade to Confirmed at T. It may be \`weakened\` / \`rejected\` at T if new Evidence contradicts.`,
    `- A T-1 \`judgment\` is HISTORICAL cognition. Do not silently carry its decision forward to T. Re-evaluate against T's Evidence.`,
    ``,
    `You may write a fresh \`prior_cognition[]\` entry showing how T's new Evidence shifts the T-1 status. Empty array is acceptable on the first turn.`,
    ``,
    ANALYSIS_OUTPUT_OBLIGATIONS,
    ``,
    OUTPUT_CONTRACT_SECTION,
    ``,
    `## Guidance for this investigation`,
    ``,
    `Weigh the Prior Human Guidance above as you form your Current Understanding. If a user correction notes a prior judgment was wrong, take that as a strong hint to re-examine that judgment, but verify against the Evidence before finalizing. If a user supplement provided information the system cannot observe, treat it as important context; if the Evidence contradicts it, surface the contradiction in the judgment rather than silently choosing one side.`,
    ``,
    `If the current evidence is insufficient, your next move is to acquire evidence — not to guess. For each unresolved hypothesis, identify the smallest gap and resolve it (either from the Evidence already in this prompt, from a knowledge page you should read, or from a Fabric capability call). Do NOT invent facts. Do NOT speculate beyond what the data supports.`,
    ``,
    `The "recommendation" MUST follow ONLY from your judgment and findings above — never from a single Signal or metric threshold. If your judgment is "observe" (pseudo-anomaly / insufficient evidence), the recommendation should reflect NOT acting (e.g. continue observing, do not intervene). If human verification is required, list the needed facts under "humanNeeded". Do not write an Action — recommendation is what to consider, not an execution order.`,
    ``,
    `Do not write any Action. You are investigating (read / question / acquire evidence / understand), not executing a business operation.`,
  ].join('\n');
};
