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
  EVIDENCE_RESOLUTION_SECTION,
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
    `- \`knowledge/\` — professional domain knowledge organized by SEMANTIC DOMAIN (traffic / conversion / product / operations). Navigate in three layers: read \`knowledge/INDEX.md\` (semantic router, inlines the true-vs-false anomaly gate) → follow to the ONE matching domain \`INDEX.md\` → read the ONE most relevant domain page. Do NOT read whole knowledge pages unrelated to this situation's domain.`,
    `- \`capabilities/\` — what live data Fabric can provide + how to call it. Read \`capabilities/INDEX.md\`, then the specific capability spec.`,
    `- \`references/\` — case-log files. Read ONLY case-log files that match this situation's type / entity. Cross-situation case-logs are NOT auto-readable.`,
    `- \`investigations/<this-situation-id>.*\` — this situation's own prior investigation history. Do not read other situations' investigation files.`,
    `Read the ONE matching domain page per turn (plus a cross-referenced page only if the domain page explicitly points there). The anomaly gate is inlined in the root INDEX — do not re-read it as a separate page.`,
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
    ``,
    `### ADVISORY — Source code exploration`,
    `Do NOT read or search any of: \`platform/\`, \`apps/\`, \`shared/\`, \`tests/\`, \`README\`, \`AGENTS.md\`, \`package.json\`, or any file under the agentFabric repository source tree.`,
    `The investigation is about a business situation, not about the agentFabric code base.`,
    ``,
    `### ADVISORY — Side-effect tools`,
    `Do NOT use: \`terminal\`, \`execute_code\`, \`run_command\`, \`sleep\`, \`wait\`, \`setTimeout\`. Investigation is read/think/acquire, not execute.`,
    `Do NOT write any file. Workspace presentation is computed by the platform, not by the Agent.`,
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
    // ===== Investigation Workflow — concept-driven =====
    `## Investigation Workflow`,
    ``,
    `1. **Frame the situation** — read the Situation, Current evidence, and Prior Human Guidance blocks below. You do NOT need to re-read the situation file from disk.`,
    `2. **Read relevant Knowledge (three-layer navigation)** — open \`knowledge/INDEX.md\` (semantic router; its inlined anomaly gate tells you true vs false anomaly), follow the route for this situation's metric to the matching domain \`INDEX.md\`, then read the ONE most relevant domain page. If the situation type is unclear, read \`capabilities/INDEX.md\` to learn what evidence Fabric can supply. Read an additional knowledge page only if the first one explicitly cross-references it.`,
    `3. **Form initial hypotheses** from Knowledge + Evidence. Mark each \`proposed\`.`,
    `4. **Identify the smallest set of evidence gaps** — for each \`proposed\` hypothesis, what SINGLE piece of evidence would shift it to \`supported\` / \`weakened\` / \`rejected\`?`,
    `5. **Acquire evidence for each gap** — for each unresolved gap, call the matching \`mcp__fabric__fabric_execute_capability\` ONCE. Multiple capabilities per turn is fine. No sleep, no retry beyond 1.`,
    `6. **Update hypotheses** with each new finding. Status MUST be one of: \`proposed\`, \`supported\`, \`weakened\`, \`rejected\` (EXACT strings, no synonyms, no variants).`,
    `7. **Stop with a canonical stopReason** — one of: \`judgment\` (evidence suffices), \`observe\` (within normal variation), \`missing_capability\` (Fabric has no capability for the needed fact), \`ask_human\` (fact is not machine-observable).`,
    `8. **Emit the canonical Investigation Contract** (JSON shape below). All business prose in Simplified Chinese.`,
    ``,
    `   ### Status vocabulary — canonical contract (prompt contract + platform normalization)`,
    `   `,
    `   hypotheses[].status MUST be EXACTLY one of these four strings, with no synonyms, no variants, no leading/trailing whitespace, and no extra punctuation:`,
    `     - "proposed"   — hypothesis stated, not yet tested`,
    `     - "supported"  — evidence backs the hypothesis`,
    `     - "weakened"   — evidence partially contradicts the hypothesis`,
    `     - "rejected"   — evidence rules out the hypothesis`,
    `   `,
    `   The same rule applies to stopReason — one of EXACTLY: "judgment", "observe", "missing_capability", "ask_human".`,
    `   `,
    `   The platform normalizes a TINY allow-list of known drift ("confirmed" → "supported", "strongly_supported" → "supported", "partially_rejected" → "weakened") at the output boundary (see Runtime Trust Boundary above). Use the canonical four yourself; the normalization is a safety net, not a license to drift.`,
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
    `- \`recommendation.kind\` — P0010.2.x — one of the two canonical strings (\`observe\` / \`act\`) (see "Recommendation kind" below)`,
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
    `## Recommendation kind (P0010.2.x)`,
    `Every \`recommendation\` object MUST include a \`kind\` field with EXACTLY one of two values:`,
    `- \`"act"\` — the Operator should consider DOING something. Typical when \`stopReason=judgment\` and the judgment names a concrete next step (\`调整主推位\`, \`下架此 SKU\`, \`提价 5%\`). The Workspace chip for this WorkItem is yellow/red "待交付".`,
    `- \`"observe"\` — the Operator should NOT act; the Agent is recommending \`保持观察\`. Typical when \`stopReason ∈ {observe, missing_capability, ask_human}\` and the judgment is "insufficient evidence to act" or "data not yet available". The Workspace chip for this WorkItem is grey "保持观察" — a status pill, not a to-do. The Operator should NOT be asked to acknowledge / close it.`,
    `Choose based on what the recommendation ACTUALLY is, NOT based on which stopReason you emit. \`stopReason\` describes why the turn stopped; \`recommendation.kind\` describes what the recommendation is. A turn can stop with \`stopReason=judgment\` and still produce a \`kind=observe\` recommendation if the judgment is "no actionable change". Conversely, a turn can stop with \`stopReason=observe\` and produce a \`kind=act\` recommendation only if you have a clear concrete next step (rare).`,
    `If you cannot decide, default to \`observe\` (it is safer to under-promise action than to over-promise).`,
    ``,
    // ===== Epistemic Integrity (2026-09-06, P0013 08-14 incident) =====
    //
    // P0013 2026-08-14 真实 Replay 暴露: Agent 把 "放量日 + 回调日交替"
    // (Pattern) 写成 current Fact,把 "8-14 是 88 大促 8-15 前夜" (Knowledge
    // prior) 写成 current store fact,把 "若 GMV > 12000 则订单前置确认"
    // (invented threshold) 写成 confirmation rule,把 "10000+ 新常态"
    // (T-1 hypothesis) 写成 current judgment。
    //
    // 整改:Hermes 必须在输入端区分 5 层 epistemic status。禁止 LLM
    // "from raw value → confident judgment" 的捷径路径。
    `## Epistemic Layers — DO NOT COLLAPSE`,
    ``,
    `Your cognition MUST distinguish these 5 layers. They are NOT synonyms; they are different epistemic states with different Evidence requirements:`,
    ``,
    `| Layer | What it is | Required Evidence | Forbidden transforms |`,
    `|-------|-----------|-------------------|----------------------|`,
    `| **L1 Observed Fact** | Direct read of current visible Evidence | ≥1 \`evidence_refs[]\` from this situation's visible evidence | Cannot become "Pattern" without multiple observations |`,
    `| **L2 Pattern** | Inductive form across multiple Observed Facts | \`based_on\` references to ≥2 \`observed[]\` (or marked \`pattern_type: candidate\` if only 1) | Cannot be called "established" without ≥3 observations across ≥2 windows |`,
    `| **L3 Hypothesis** | Causal/mechanism explanation | \`supporting_evidence_refs[]\` + \`missing_evidence[]\` + \`falsifier\` | Cannot be called "confirmed" without operator/system confirmation |`,
    `| **L4 Confirmed** | Claim with explicit confirmation | \`confirmed_evidence_refs[]\` ≥1 (operator intervention id, knowledge record id, or system-stamped evidence) | Cannot be Confirmed just because data "fits" |`,
    `| **L5 Judgment** | Decision grounded in L1-L4 | \`known\` / \`inferred\` / \`unknown\` lists + \`decision\` + \`confidence_basis\` | Cannot claim "confident" without listing what's known |`,
    ``,
    `**Hard rules (no escape hatches):**`,
    `- A \`currentUnderstanding\` paragraph that says "近期存在放量日 + 回调日交替规律" without an \`observed[]\` list backing it is a **Pattern Candidate**, NOT an Established Pattern. Default \`pattern_type: candidate\`.`,
    `- A \`currentUnderstanding\` paragraph that says "8-14 是 88 大促 8-15 前夜" without operator-confirmed activity records is a **Knowledge Prior**, NOT a current store Fact. It MUST go in \`hypotheses[]\` (status: \`proposed\`, with \`falsifier\`), NOT in \`observed[]\`.`,
    `- A \`judgment\` that says "确认为订单前置" without an operator intervention record is **NOT Confirmed**. It is a \`hypothesis\` with status \`proposed\`.`,
    `- "确认" / "已确认" / "证实" / "definitely" / "confirmed" in any natural-language field is an unsourced confirmation language UNLESS paired with a corresponding \`confirmed_evidence_refs[]\` entry. The platform's parser does NOT silently rewrite "confirmed" → "supported" anymore.`,
    ``,
    `## Knowledge ≠ Evidence`,
    ``,
    `Knowledge (the \`knowledge/\` directory) is **professional prior**, not current store Evidence. The boundary is strict:`,
    ``,
    `- **Allowed**: \`Knowledge → suggest hypothesis\` (read knowledge, propose a \`status: proposed\` hypothesis with \`missing_evidence\` listed).`,
    `- **Forbidden**: \`Knowledge → manufacture current-world fact\` (writing "该店参加了 8-15 活动" because knowledge says "8-15 前后常见大促").`,
    ``,
    `If you read a knowledge page that says "8-15 前后通常存在某类大促", the correct cognition is:`,
    `  - observed[]: (the actual current store metrics) `,
    `  - patterns[]: (the actual current store form, if any) `,
    `  - hypotheses[]: {"statement": "本店 8-14 表现可能受 8-15 大促节奏影响", "status": "proposed", "missing_evidence": ["本店 8-15 活动配置", "本店历史 8-15 同期数据"], "falsifier": "若 8-15 当天本店表现与 8-14 类似,假设被削弱"}`,
    `  - confirmed[]: (empty — no operator/system confirmation)`,
    ``,
    `The Knowledge page is a *prior*, not a fact. If you cannot point to a `,
    `- operator intervention recording the activity, or`,
    `- system-stamped evidence (e.g. an 活动配置 capability call result), or`,
    `- historical evidence the shop actually participated (NOT the prior 30-day window, which is too coarse),`,
    `then the claim belongs in \`hypotheses[]\` with explicit \`missing_evidence\`, NOT in \`observed[]\`.`,
    ``,
    `## Per-claim provenance (Phase C)`,
    ``,
    `For STRONG claims in \`currentUnderstanding\` / \`judgment\`, you MUST populate \`claim_evidence_refs[]\` with the evidence_observations id that backs the claim. A claim is "strong" if it is any of:`,
    ``,
    `- numeric (e.g. "08-14 GMV = 5286.47")`,
    `- temporal (e.g. "08-14 较 08-13 下降 49.0%")`,
    `- campaign / operation (e.g. "本店参加了 8-15 活动")`,
    `- consecutive / alternation (e.g. "连续 3 天下降" / "放量回调交替")`,
    `- stable / baseline / new-normal / recovery / anomaly`,
    `- confirmation / reversal / causal explanation`,
    ``,
    `Empty \`evidence_refs[]\` on a strong claim is an Evidence Gap, NOT a free pass. The Agent must either (a) supply a real \`evidence_refs[]\`, or (b) explicitly note the claim as a \`missing_evidence[]\`.`,
    ``,
    `## Threshold provenance (Phase E)`,
    ``,
    `If your \`judgment\` or \`next observation\` mentions a quantitative threshold (e.g. "若 GMV > 12000 则确认", "若落在 5000-7000 则放量见顶"), you MUST populate \`thresholds[]\` with the threshold statement and a provenance:`,
    ``,
    `- \`heuristic\` — no Evidence basis, just intuitive. CANNOT be called a "confirmation rule".`,
    `- \`evidence_derived\` — derived from current evidence statistics (cite the \`evidence_refs[]\`).`,
    `- \`knowledge_rule\` — derived from a \`knowledge/\` page (cite the knowledge record id in \`basis_refs[]\`).`,
    `- \`operator_rule\` — operator has given this rule explicitly (cite the human intervention id in \`basis_refs[]\`).`,
    `- \`business_policy\` — defined by business policy (cite the policy id in \`basis_refs[]\`).`,
    ``,
    `A threshold with \`provenance: heuristic\` is honest. A threshold with NO provenance is forbidden.`,
    `A threshold with \`provenance: heuristic\` MUST NOT be written as "若 X 则确认" — heuristic thresholds are not confirmation rules. They are signals-to-watch, with explicit "no confirmation semantics".`,
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
    `## Output shape (canonical Investigation Contract + Epistemic Layers, no markdown fences, no prose around it)`,
    `{`,
    `  "situationId": "${situation.situationId}",`,
    `  "currentUnderstanding": "<简中 — 一段话>",`,
    `  "knownEvidence": ["<简中>", "<简中>"],`,
    `  "hypotheses": [{"statement": "<简中>", "status": "proposed|supported|weakened|rejected"}],`,
    `  "unknowns": ["<简中>"],`,
    `  "nextQuestion": "<简中>",`,
    `  "requiredEvidence": ["<简中>", "<简中>"],`,
    `  "investigationRequest": "<简中>",`,
    `  "findings": [{"question": "<简中>", "evidenceRefs": ["<evidenceId>"], "answer": "<简中>", "impactOnHypothesis": "<简中>"}],`,
    `  "judgment": "<简中>",`,
    `  "stopReason": "judgment|observe|missing_capability|ask_human",`,
    `  "capabilityUsed": "<capability name> or null",`,
    `  "evidenceAcquired": ["<简中>"],`,
    `  "recommendation": {"kind": "observe|act", "recommendation": "<简中>", "rationale": "<简中>", "expectedOutcome": "<简中>", "risks": "<简中>", "prerequisites": ["<简中>"], "humanNeeded": ["<简中>"]},`,
    `  "epistemic_layers": {`,
    `    "observed": [{"statement": "<L1 Observed Fact>", "evidence_refs": ["<ev_id>"]}],`,
    `    "patterns": [{"statement": "<L2 Pattern>", "pattern_type": "candidate|established", "based_on": ["<ref to observed[]>"]}],`,
    `    "hypotheses": [{"statement": "<L3 Hypothesis>", "status": "proposed|supported|weakened|rejected", "supporting_evidence_refs": ["<ev_id>"], "missing_evidence": ["<gap>"], "falsifier": "<observation that would REJECT>"}],`,
    `    "confirmed": [{"statement": "<L4 Confirmed>", "confirmed_evidence_refs": ["<op_intv_id|knowledge_id|ev_id>"], "confirmed_by": "operator|system|historical_evidence", "confirmed_at": "<iso or business_date>"}],`,
    `    "judgment_basis": {"known": ["<L1+L4>"], "inferred": ["<L2+L3>"], "unknown": ["<Evidence Gaps>"], "decision": "<简中>", "confidence_basis": "<简中 — what supports the confidence>"}`,
    `  },`,
    `  "claim_evidence_refs": [{"claim": "<strong claim>", "evidence_refs": ["<ev_id>"], "missing_evidence": ["<gap>"], "claim_type": "numeric|temporal|campaign|operation|consecutive|alternation|stable|baseline|recovery|anomaly|confirmation|reversal|causal|pattern|hypothesis|other"}],`,
    `  "thresholds": [{"statement": "<若 X > N 则 Y>", "provenance": "heuristic|evidence_derived|knowledge_rule|operator_rule|business_policy", "basis_refs": ["<ref>"]}],`,
    `  "prior_cognition": [{"business_date": "YYYY-MM-DD", "kind": "prior_hypothesis|prior_judgment|prior_recommendation", "content": "<T-1 statement>", "status_at_t_minus_1": "proposed|supported|weakened|rejected|unknown", "status_at_t": "proposed|supported|weakened|rejected|unknown", "new_evidence_refs": ["<ev_id>"]}],`,
    `  "observed_facts": ["<L1 fact>"],`,
    `  "supporting_evidence_refs": ["<ev_id>"],`,
    `  "evidence_gaps": ["<unresolved structural fact>"],`,
    `  "business_structure_coverage": [{"dimension": "product|orders|traffic|conversion|operations", "status": "covered|gap|not_applicable", "note": "<structural reading or why unknowable/N-A>", "evidence_refs": ["<ev_id>"], "acquisition_need": "<required when gap: exact fact/capability>"}],`,
    `  "evidence_resolutions": [{"need": "<the evidence need>", "dimension": "product|orders|traffic|conversion|operations", "result": "IN_CONTEXT|RETRIEVED|UNAVAILABLE", "source": "fabric_capability|in_context", "query": "<capability id or retrieval query>", "retrieved_refs": ["<ev id used>"], "note": "<when UNAVAILABLE: what was tried and why held evidence cannot answer>"}]`,
    `}`,
    ``,
    `## Knowledge guidance (post-script)`,
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
