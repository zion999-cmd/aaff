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
 * P0010.2.5 closure — Behavior policy, NOT Runtime enforcement.
 * This prompt is a **prompt-level behavior policy**, not a Hermes security
 * sandbox. Hermes 0.20.5 (the underlying Runtime) does NOT enforce any of
 * the tool-namespace allow/deny lists, the per-turn call caps, or the
 * status-vocabulary constraint expressed here. Hermes exposes the full
 * `search_files` / `read_file` surface over the Workspace directory and
 * `tool_search` / `tool_describe` are unlimited.
 *
 * What this means concretely:
 *   - "ALLOWED" / "FORBIDDEN" sections below are **advisory contracts the
 *     Foundation Model is expected to honor** when generating its output.
 *     A sufficiently creative or confused model can still violate them
 *     (read a forbidden path, retry a failed call 5 times, return a
 *     non-canonical status string). The platform's job is to:
 *       (a) prompt the model to do the right thing, and
 *       (b) validate the model's *output* (canonical Investigation
 *           Contract, normalized status vocabulary, materialized
 *           WorkItem) — NOT to police the model's tool calls.
 *   - "HARD CONSTRAINT" status vocabulary, the "at most once" tool caps,
 *     and the "turn-failure" framing are all **prompt-level**, not
 *     Runtime-enforced. We document this here so the system is honest
 *     about its trust boundary. If/when Hermes grows a real tool-call
 *     sandbox, this section will become Runtime-enforced and the wording
 *     can be tightened.
 *
 * Per-turn rules (advisory):
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
    `> [P0010.2.5 closure] This document is a **prompt-level behavior policy**,`,
    `> NOT a Hermes Runtime security sandbox. The tool-allow / tool-forbid`,
    `> lists, "at most once" call caps, and the canonical status-vocabulary`,
    `> below are advisory contracts the Foundation Model is expected to honor.`,
    `> Hermes 0.20.5 does not enforce any of them at the Runtime layer. The`,
    `> platform validates the OUTPUT (canonical Investigation Contract +`,
    `> normalized status vocabulary + materialized WorkItem) and trusts the`,
    `> model to follow the prompt. If you find yourself unable to follow a`,
    `> section, the right move is to return a canonical stopReason explaining`,
    `> why (e.g. "missing_capability") — not to violate it.`,
    ``,
    // ===== P0010.2.5 — Three concepts MUST NOT be conflated =====
    `## Three Concepts — DO NOT CONFLATE`,
    ``,
    `| Concept | What it is | Where it lives | When to use it |`,
    `|---------|-----------|----------------|----------------|`,
    `| **Knowledge** | Long-term professional expertise (rules, methods, cases, SOPs, domain interpretation) | \`knowledge/\` directory (indexed by \`knowledge/INDEX.md\`) | ALWAYS read first to understand HOW to interpret this situation type |`,
    `| **Evidence** | Current fact about THIS situation (what actually happened, right now) | Provided in the prompt + acquired via Fabric | When you need to KNOW what is true for THIS situation |`,
    `| **Fabric capability** | The way to acquire new Evidence (live data from connected systems) | \`capabilities/\` directory + \`mcp__fabric__fabric_execute_capability\` | When existing Evidence is insufficient and a live query is needed |`,
    ``,
    `Knowledge ≠ Evidence. A case from 2024 (Knowledge) does NOT replace today's actual metric (Evidence). Fabric is the bridge from "I know the framework" to "I have today's number".`,
    `Performance optimization MUST NOT collapse these three. P0010.2.4 (the previous slice) over-corrected by forbidding Knowledge retrieval; this slice restores it.`,
    ``,
    // ===== Tool Surface — semantic (by purpose), not syntactic (by tool name) =====
    `## Tool Surface — Read by Purpose`,
    ``,
    `### ALLOWED — Business Knowledge retrieval`,
    `You may use \`search_files\`, \`read_file\`, \`list_files\` freely within these namespaces only:`,
    `- \`knowledge/\` — professional domain knowledge (cases, SOPs, reference, platform notes). Read \`knowledge/INDEX.md\` first, then the specific page relevant to this situation type.`,
    `- \`capabilities/\` — what live data Fabric can provide + how to call it. Read \`capabilities/INDEX.md\`, then the specific capability spec.`,
    `- \`references/\` — case-log files. Read ONLY case-log files that match this situation's type / entity. Cross-situation case-logs are NOT auto-readable.`,
    `- \`investigations/<this-situation-id>.*\` — this situation's own prior investigation history. Do not read other situations' investigation files.`,
    `Read 2-3 knowledge pages per turn — enough to ground the professional interpretation, not exhaustive.`,
    ``,
    `### ALLOWED — Evidence acquisition (multiple capabilities OK)`,
    `Use \`mcp__fabric__fabric_execute_capability\` to fetch live data.`,
    `- Multiple capability calls in one turn are ALLOWED as long as EACH solves a distinct evidence gap.`,
    `- Call ONCE per evidence gap. If it fails, retry ONCE. If it still fails, record the gap in \`unknowns\` and continue.`,
    `- Forbidden pattern: \`try A → fail → try A again → fail → try B → try C → random retry\`.`,
    `- Allowed pattern: \`trade.overview (gap: today's GMV) → traffic.overview (gap: today's traffic source) → product.overview (gap: which SKUs drove the change)\`.`,
    `- \`mcp__fabric__fabric_list_capabilities\` — use at most once per turn, to confirm what is available when the situation type is unfamiliar.`,
    ``,
    `### ADVISORY — Tool discovery (recommended once per session)`,
    `Call \`tool_search\` / \`tool_describe\` at most once at the start of the session to discover the \`mcp__fabric__fabric_*\` tools. After that, the tool universe is fixed.`,
    `**Note (P0010.2.5 closure)**: this is a recommendation, NOT a Runtime quota. Hermes does not enforce a per-session call cap on tool_search; if you call it again, the call will succeed. The recommendation exists to keep tool-budget noise out of the trace log.`,
    ``,
    `### ADVISORY — Source code exploration (behavior policy, not enforced)`,
    `Do NOT read or search any of: \`platform/\`, \`apps/\`, \`shared/\`, \`tests/\`, \`README\`, \`AGENTS.md\`, \`package.json\`, or any file under the agentFabric repository source tree.`,
    `The investigation is about a business situation, not about the agentFabric code base.`,
    `**Note (P0010.2.5 closure)**: this is a prompt-level policy, not a Hermes sandbox. Hermes exposes the entire Workspace via \`search_files\` / \`read_file\` without a path allowlist; the only enforcement is in the model. If you stray into these paths anyway, the output will still be validated, but the investigation will be off-topic and the WorkItem will be rejected as low-quality.`,
    ``,
    `### ADVISORY — Side-effect tools (behavior policy, not enforced)`,
    `Do NOT use: \`terminal\`, \`execute_code\`, \`run_command\`, \`sleep\`, \`wait\`, \`setTimeout\`. Investigation is read/think/acquire, not execute.`,
    `Do NOT write any file. Workspace presentation is computed by the platform, not by the Agent.`,
    `**Note (P0010.2.5 closure)**: Hermes does not deny these tools at the Runtime layer. The advisory exists because the Investigation layer has no Action Engine — using a side-effect tool cannot produce a valid WorkItem and is wasted tool budget.`,
    ``,
    // ===== Investigation Workflow — concept-driven =====
    `## Investigation Workflow`,
    ``,
    `1. **Frame the situation** — read the Situation, Current evidence, and Prior Human Guidance blocks below. You do NOT need to re-read the situation file from disk.`,
    `2. **Read relevant Knowledge** — open \`knowledge/INDEX.md\`, find the page for this situation type, read it. If the situation type is unclear, read \`capabilities/INDEX.md\` to learn what evidence Fabric can supply. Read 1-2 additional knowledge pages only if the first one points you there.`,
    `3. **Form initial hypotheses** from Knowledge + Evidence. Mark each \`proposed\`.`,
    `4. **Identify the smallest set of evidence gaps** — for each \`proposed\` hypothesis, what SINGLE piece of evidence would shift it to \`supported\` / \`weakened\` / \`rejected\`?`,
    `5. **Acquire evidence for each gap** — for each unresolved gap, call the matching \`mcp__fabric__fabric_execute_capability\` ONCE. Multiple capabilities per turn is fine. No sleep, no retry beyond 1.`,
    `6. **Update hypotheses** with each new finding. Status MUST be one of: \`proposed\`, \`supported\`, \`weakened\`, \`rejected\` (EXACT strings, no synonyms, no variants).`,
    `7. **Stop with a canonical stopReason** — one of: \`judgment\` (evidence suffices), \`observe\` (within normal variation), \`missing_capability\` (Fabric has no capability for the needed fact), \`ask_human\` (fact is not machine-observable).`,
    `8. **Emit the canonical Investigation Contract** (JSON shape below). All business prose in Simplified Chinese.`,
    ``,
    `   ### Status vocabulary — canonical contract (prompt policy + output-side normalization)`,
    `   `,
    `   hypotheses[].status MUST be EXACTLY one of these four strings, with no synonyms, no variants, no leading/trailing whitespace, and no extra punctuation:`,
    `     - "proposed"   — hypothesis stated, not yet tested`,
    `     - "supported"  — evidence backs the hypothesis`,
    `     - "weakened"   — evidence partially contradicts the hypothesis`,
    `     - "rejected"   — evidence rules out the hypothesis`,
    `   `,
    `   The same rule applies to stopReason — one of EXACTLY: "judgment", "observe", "missing_capability", "ask_human".`,
    `   `,
    `   **P0010.2.5 closure — what is and isn't enforced**: the canonical-vocabulary rule is a prompt-level contract AND is enforced on the OUTPUT side by a normalization layer in \`apps/ecommerce/runtime/investigation/normalize.ts\` (the safety-net allow-list of "confirmed" → "supported", "strongly_supported" → "supported", "partially_rejected" → "weakened"). Use the canonical four yourself; the normalization is a safety net, not a license to drift. The model is trusted to follow the contract; the platform validates the result.`,
    `   `,
    `   This is fundamentally different from the tool-allow / tool-forbid rules above: those are advisory-only (no Runtime sandbox), while the status vocabulary is prompt-policy PLUS output-side normalization. Both layers cooperate to keep the Investigation Contract canonical.`,
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
    // ===== P0010.2.5 — Output language contract (zh-CN for business prose) =====
    `## Output Language — Simplified Chinese (zh-CN)`,
    ``,
    `Business-facing natural-language fields MUST be written in Simplified Chinese (zh-CN). This is a language contract at the Investigation layer — it is model-independent and stays the same regardless of which foundation model powers the Runtime.`,
    ``,
    `**MUST be in Simplified Chinese:**`,
    `- \`currentUnderstanding\` — one paragraph, the human summary of the situation`,
    `- \`knownEvidence\` (the string entries, not the array structure)`,
    `- \`hypotheses[].statement\` — what the Agent suspects, in operator-friendly Chinese`,
    `- \`unknowns\` (the string entries)`,
    `- \`nextQuestion\` — the question the Agent would ask next, in Chinese`,
    `- \`investigationRequest\` — what the Agent is asking the next turn / a human to verify, in Chinese`,
    `- \`findings[].question\`, \`findings[].answer\`, \`findings[].impactOnHypothesis\` — all strings, in Chinese`,
    `- \`judgment\` — the final business judgment, in Chinese (this is the line the operator reads first)`,
    `- \`recommendation.recommendation\`, \`rationale\`, \`expectedOutcome\`, \`risks\` — in Chinese`,
    `- \`recommendation.prerequisites\` (string entries) — in Chinese`,
    `- \`recommendation.humanNeeded\` (string entries) — in Chinese`,
    ``,
    `**MUST remain canonical English (do NOT translate):**`,
    `- \`status\` — one of the four canonical strings (\`proposed\` / \`supported\` / \`weakened\` / \`rejected\`)`,
    `- \`stopReason\` — one of the four canonical strings (\`judgment\` / \`observe\` / \`missing_capability\` / \`ask_human\`)`,
    `- \`capabilityUsed\` — capability ID (e.g. \`trade.overview\`, \`traffic.overview\`)`,
    `- All situation / capability / evidence / signal / output IDs (the \`sit_*\`, \`cap_*\`, \`ev_*\`, \`sig_*\`, \`out_*\` keys and values)`,
    `- All JSON keys (field names)`,
    `- \`evidenceRefs\` (the IDs, not the descriptions)`,
    ``,
    `Example shape:`,
    `  "statement": "该商品流量下降主要来自自然搜索流量减少",`,
    `  "status": "supported"   ← canonical English enum`,
    `  "stopReason": "judgment"  ← canonical English enum`,
    `  "capabilityUsed": "traffic.overview"  ← canonical English ID`,
    ``,
    `## Knowledge guidance`,
    `Weigh the Prior Human Guidance above as you form your Current Understanding. If a user correction notes a prior judgment was wrong, take that as a strong hint to re-examine that judgment, but verify against the Evidence before finalizing. If a user supplement provided information the system cannot observe, treat it as important context; if the Evidence contradicts it, surface the contradiction in the judgment rather than silently choosing one side.`,
    ``,
    `If the current evidence is insufficient, your next move is to acquire evidence — not to guess. For each unresolved hypothesis, identify the smallest gap and resolve it (either from the Evidence already in this prompt, from a knowledge page you should read, or from a Fabric capability call). Do NOT invent facts. Do NOT speculate beyond what the data supports.`,
    ``,
    `Finally, output ONLY a JSON object with this exact shape (no markdown fences, no prose around it):`,
    `{`,
    `  "situationId": "${situation.situationId}",`,
    `  "currentUnderstanding": "<简中 — 一段话>",`,
    `  "knownEvidence": ["<简中>", "<简中>"],`,
    `  "hypotheses": [{"statement": "<简中>", "status": "proposed|supported|weakened|rejected"}],`,
    `  "unknowns": ["<简中>"],`,
    `  "nextQuestion": "<简中>",`,
    `  "requiredEvidence": ["<简中>"],`,
    `  "investigationRequest": "<简中>",`,
    `  "findings": [{"question": "<简中>", "evidenceRefs": ["<evidenceId>"], "answer": "<简中>", "impactOnHypothesis": "<简中>"}],`,
    `  "judgment": "<简中>",`,
    `  "stopReason": "judgment|observe|missing_capability|ask_human",`,
    `  "capabilityUsed": "<capability name> or null",`,
    `  "evidenceAcquired": ["<简中>"],`,
    `  "recommendation": {"recommendation": "<简中>", "rationale": "<简中>", "expectedOutcome": "<简中>", "risks": "<简中>", "prerequisites": ["<简中>"], "humanNeeded": ["<简中>"]}`,
    `}`,
    ``,
    `The "recommendation" MUST follow ONLY from your judgment and findings above — never from a single Signal or metric threshold. If your judgment is "observe" (pseudo-anomaly / insufficient evidence), the recommendation should reflect NOT acting (e.g. continue observing, do not intervene). If human verification is required, list the needed facts under "humanNeeded". Do not write an Action — recommendation is what to consider, not an execution order.`,
    ``,
    `Do not write any Action. You are investigating (read / question / acquire evidence / understand), not executing a business operation.`,
  ].join('\n');
};
