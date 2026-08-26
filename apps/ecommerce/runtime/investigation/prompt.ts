// P0010 — Investigation prompt (Fabric-owned).
//
// This is the ONLY prompt that launches a Knowledge-Guided Investigation. It
// carries the situation + current evidence as DATA, and instructs the Runtime
// (Hermes) HOW to investigate. It does NOT contain business rules, hardcoded
// questions, or an investigation tree — the Agent decides what to ask based on
// the professional Knowledge it reads from knowledge/.

import type { LearningContext, Situation } from '#shared/schemas/learning-context.js';

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
        // P0010.2.4 — surface the `appliesTo` target so the Agent can map
        // a decision back to the prior recommendation/agent-activity it
        // was responding to. This is the only path by which the next
        // turn can know "which suggestion was accepted".
        const appliesTo = content['appliesTo'] as
          | { agentActivityId?: string; recommendationId?: string; signalId?: string }
          | undefined;
        const targetParts: string[] = [];
        if (appliesTo?.recommendationId) targetParts.push(`recommendation=${appliesTo.recommendationId}`);
        if (appliesTo?.agentActivityId) targetParts.push(`agentActivity=${appliesTo.agentActivityId}`);
        if (appliesTo?.signalId) targetParts.push(`signal=${appliesTo.signalId}`);
        const targetStr = targetParts.length ? ` (目标: ${targetParts.join('; ')})` : '';
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
 * Rules (hard lines, enforced by prompt structure — not by Fabric code):
 *  - the Agent reads professional Knowledge from knowledge/INDEX.md + pages;
 *    no SOP is copied into this prompt;
 *  - Next Question is chosen by the Agent from Situation + Knowledge + Evidence;
 *  - if existing evidence cannot answer it, the Agent checks Fabric capabilities
 *    (fabric_list_capabilities) and acquires evidence via fabric_execute_capability;
 *  - if no capability exists for the needed evidence, it MUST stop with
 *    stop_reason = "missing_capability" (never guess, never invent capability);
 *  - the final answer is a JSON Investigation Contract.
 */
export const buildInvestigationPrompt = (
  situation: Situation,
  ctx: LearningContext | null,
): string => {
  const entity = situation.entity?.name ?? situation.entity?.id ?? 'unknown';
  return [
    `You are investigating ONE business situation in a Fabric Agent Workspace.`,
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
    `## What to do — a Knowledge-Guided Investigation`,
    ``,
    `1. Read professional Knowledge: open knowledge/INDEX.md, then read the knowledge pages relevant to this kind of situation. Base your judgment on that Knowledge, not on generic guessing.`,
    ``,
    `2. Form your Current Understanding. Weigh the Prior Human Guidance above as you form it: if a user correction notes a prior judgment was wrong, take that as a strong hint to re-examine that judgment, but verify against the Evidence before finalizing. If a user supplement provided information the system cannot observe, treat it as important context; if the Evidence contradicts it, surface the contradiction in the judgment rather than silently choosing one side.`,
    `   - known_evidence: what you already know (from the evidence above, the situation, AND the prior human guidance)`,
    `   - hypotheses: plausible explanations with status "proposed"`,
    `   - unknowns: what is genuinely still unknown`,
    ``,
    `3. Choose the NEXT QUESTION — the single question that, if answered, reduces this situation's uncertainty the most. State its required_evidence (the concrete data you would need). If the Prior Human Guidance already answered it, do NOT ask the same question again — incorporate the answer.`,
    ``,
    `4. Check whether existing evidence already answers it. If yes, answer directly from existing evidence.`,
    ``,
    `5. If existing evidence is insufficient, use the Fabric MCP tools to acquire it:`,
    `   - call fabric_list_capabilities to see what live JD data Fabric can provide,`,
    `   - pick the capability whose data matches required_evidence,`,
    `   - call fabric_execute_capability with that capability (and the situation's date if relevant),`,
    `   - the tool returns real evidence — read it.`,
    ``,
    `6. Answer your question from the newly acquired evidence. Update each hypothesis's status (supported / weakened / rejected) and record a finding with evidence_refs.`,
    ``,
    `7. Decide: continue (choose the next question) or stop. Stop only for one of:`,
    `   - stop_reason "judgment" — evidence suffices for a business judgment`,
    `   - stop_reason "observe" — the change is within normal variation; no intervention`,
    `   - stop_reason "missing_capability" — you know what evidence you need but Fabric has no capability for it (do NOT invent a capability, do NOT guess)`,
    `   - stop_reason "ask_human" — the needed fact is not machine-observable`,
    ``,
    `8. IMPORTANT: you MUST actually call fabric_execute_capability at least once when existing evidence cannot answer your next question and a matching capability exists. A plausible analysis without evidence acquisition is a failure.`,
    ``,
    `9. Finally, output ONLY a JSON object with this exact shape (no markdown fences, no prose around it):`,
    `{`,
    `  "situationId": "${situation.situationId}",`,
    `  "currentUnderstanding": "...",`,
    `  "knownEvidence": ["..."],`,
    `  "hypotheses": [{"statement": "...", "status": "proposed|supported|weakened|rejected"}],`,
    `  "unknowns": ["..."],`,
    `  "nextQuestion": "...",`,
    `  "requiredEvidence": ["..."],`,
    `  "investigationRequest": "...",`,
    `  "findings": [{"question": "...", "evidenceRefs": ["..."], "answer": "...", "impactOnHypothesis": "..."}],`,
    `  "judgment": "...",`,
    `  "stopReason": "judgment|observe|missing_capability|ask_human",`,
    `  "capabilityUsed": "<capability name> or null",`,
    `  "evidenceAcquired": ["..."],`,
    `  "recommendation": {"recommendation": "...", "rationale": "...", "expectedOutcome": "...", "risks": "...", "prerequisites": ["..."], "humanNeeded": ["..."]}`,
    `}`,
    ``,
    `The "recommendation" MUST follow ONLY from your judgment and findings above — never from a single Signal or metric threshold. If your judgment is "observe" (pseudo-anomaly / insufficient evidence), the recommendation should reflect NOT acting (e.g. continue observing, do not intervene). If human verification is required, list the needed facts under "humanNeeded". Do not write an Action — recommendation is what to consider, not an execution order.`,
    ``,
    `Do not write any Action. You are investigating (read / question / acquire evidence / understand), not executing a business operation.`,
  ].join('\n');
};
