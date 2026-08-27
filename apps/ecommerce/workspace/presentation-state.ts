// P0010.2.x — Workspace Presentation Reducer (PURE / SERVER-SIDE).
//
// This module is the ONLY place that produces a `WorkspacePresentationState`
// (and the `WorkspacePresentationOutput` envelope). The Detail page and
// the Feed read what this reducer returns. UI MUST NOT derive state on
// its own.
//
// Architectural rules (from P0010.2.x Workspace State Convergence, audit §6.7):
//
//   * Input is ONLY persisted facts: situation row, learning_context body,
//     interventions, investigation sidecars. No LoopEvent, no Trace ring
//     buffer, no HTTP request time, no UI state.
//   * Output is a stable JSON object with a stable `presentationRevision`
//     hash. Two requests with the same persisted state MUST produce the
//     same revision (so the UI polling can skip re-render).
//   * The function is pure: same input → same output. No DB write, no
//     `Date.now()` substitution for "now" (the caller passes the snapshot
//     timestamp as `now` so the function remains deterministic in tests).
//   * `humanNeeded[]` does NOT participate in `waiting_human`. Only
//     `stopReason ∈ {ask_human, missing_capability}` does.
//   * `failed + hasPriorValidCognition` is `recoverable`, NOT `observing`.
//     The flag `priorValidCognitionPreserved` is exposed in the banner
//     so the content layer can render the supplemental copy, but the
//     state is `recoverable`.
//   * `blocked` requires BOTH `consecutiveFailures >= threshold` AND
//     `blockedEmittedAt != null`. The latter is a persisted sidecar —
//     agentFabric restart does not lose the blocked state.

import { createHash } from 'node:crypto';
import type {
  WorkspacePresentationOutput,
  WorkspacePresentationState,
  FeedEntrySummary,
  PresentationBanner,
  InvestigationSummary,
  WorkItemSummary,
  InterventionSummary,
} from '#shared/schemas/workspace-presentation.js';
import type { LearningContext, HumanIntervention } from '#shared/schemas/learning-context.js';
import type { WorkItem } from '#shared/schemas/output.js';

// The presentation reducer does NOT import from `recovery-candidates.ts`
// even though that module exports the same constant. Coupling the
// presentation layer to the runtime-loop layer would force a server-side
// runtime dependency into what is meant to be a pure module. The constant
// is duplicated here by design; it MUST stay in sync with
// `apps/ecommerce/runtime/loop/recovery-candidates.ts#DEFAULT_MAX_CONSECUTIVE_FAILURES`
// (asserted by `tests/unit/workspace/reducer.test.ts`).
const DEFAULT_THRESHOLD = 3;

// ---- Inputs (only persisted facts) ----

export interface ReducerInput {
  /** Situation row as already serialized by p0007.ts:176. */
  situation: {
    situationId: string;
    lifecycle: 'open' | 'partial' | 'mature';
    createdAt: string;
    updatedAt: string;
    description: string;
    type: string;
    // Optional fields are written as `T | undefined` rather than `?:` so the
    // call site can pass `r.entity_name` (a nullable DB column) without
    // tripping `exactOptionalPropertyTypes`.
    entity?: { id?: string; type?: string; name?: string | undefined; platform?: string | undefined };
    temporal?: { observedAt?: string | undefined };
  };
  /** Full learning_context.body (parsed). May be null when no context exists. */
  learningContext: (LearningContext & {
    outputs?: WorkItem[];
  }) | null;
  /** Human interventions, oldest first. */
  interventions: ReadonlyArray<HumanIntervention>;
  /** Caller-supplied "now" — UTC ISO. The reducer uses it for `computedAt`
   *  and `presentationRevision`, which keeps the function pure under tests. */
  now: string;
}

// ---- Presentation decision tree (audit §6.2) ----

/** Hard 8-step precedence. Each `return` is terminal; no fallthrough. */
const decidePresentation = (
  inv: LearningContext['investigation'],
  threshold: number,
): WorkspacePresentationState => {
  // (1) blocked — must be evaluated BEFORE the generic `failed` branch.
  //     Needs all three persisted sidecars to claim the situation is
  //     blocked. `blockedEmittedAt` is the durable "the Loop has crossed
  //     the threshold at least once" marker (see recovery-candidates.ts,
  //     P0010.2.2 audit R4 fix).
  if (
    inv &&
    inv.status === 'failed' &&
    (inv.consecutiveFailures ?? 0) >= threshold &&
    inv.blockedEmittedAt != null &&
    inv.blockedEmittedAt !== ''
  ) {
    return 'blocked';
  }

  // (2) pending — no investigation ever, or marker says pending.
  if (!inv || inv.status === undefined || inv.status === 'pending') {
    return 'pending';
  }

  // (3) investigating — turn in flight.
  if (inv.status === 'investigating') {
    return 'investigating';
  }

  // (4) recoverable — failed. CRITICAL: regardless of whether prior valid
  //     cognition exists. Content layer renders the preservation note
  //     using `priorValidCognitionPreserved`, but the state stays
  //     `recoverable` until a NEW turn actually completes.
  if (inv.status === 'failed') {
    return 'recoverable';
  }

  // (5) observing — explicitly chosen by the Agent (stopReason='observe').
  if (inv.status === 'completed' && inv.stopReason === 'observe') {
    return 'observing';
  }

  // (6) waiting_human — only the two blocking stopReasons. NEVER
  //     `recommendation.humanNeeded.length > 0` (that field is "may need
  //     human at execution time", not "Agent is blocked").
  if (
    inv.status === 'completed' &&
    (inv.stopReason === 'ask_human' || inv.stopReason === 'missing_capability')
  ) {
    return 'waiting_human';
  }

  // (7) completed — default for inv.status='completed'. Includes
  //     stopReason='judgment' (the most common path).
  if (inv.status === 'completed') {
    return 'completed';
  }

  // (8) unknown / malformed — explicit `pending` rather than fake-success.
  return 'pending';
};

// ---- Banner copy (single source — replaces SITUATION_LIFECYCLE_LABEL
//                    + INVESTIGATION_DISPLAY_BANNER + ad-hoc strings) ----

const bannerFor = (
  presentation: WorkspacePresentationState,
  priorValidCognitionPreserved: boolean,
  consecutiveFailures: number,
  threshold: number,
): PresentationBanner => {
  switch (presentation) {
    case 'pending':
      return {
        headline: '⏳ 待处理',
        detail: '等待 Agent 自动调查（已进入 Runtime 调度队列）。Runtime 将自动安排下一轮调查，无需人工操作。',
        availableActions: {
          showGenerateRecommendation: false,
          showClearBlock: false,
          showLegacyStart: false,
        },
        priorValidCognitionPreserved: false,
      };
    case 'investigating':
      return {
        headline: '🔍 调查中',
        detail: '请稍候。Runtime 已锁定该 Situation 的调查上下文。',
        availableActions: {
          showGenerateRecommendation: false,
          showClearBlock: false,
          showLegacyStart: false,
        },
        priorValidCognitionPreserved: false,
      };
    case 'recoverable':
      return {
        headline: '🔄 调查中（已失败 · Runtime 正在重试）',
        detail: priorValidCognitionPreserved
          ? '上一次有效判断仍保留；最新调查失败，Runtime 正在重试。'
          : 'Runtime 将在下一轮 tick 重新尝试。',
        availableActions: {
          showGenerateRecommendation: false,
          showClearBlock: false,
          showLegacyStart: false,
        },
        priorValidCognitionPreserved,
      };
    case 'blocked':
      return {
        headline: '⚠ 自动调查已暂停',
        detail: `已连续失败 ${consecutiveFailures} 次（阈值 ${threshold}）。请执行「解除阻塞并重新调度」让 Runtime 重新安排下一轮调查。`,
        availableActions: {
          showGenerateRecommendation: false,
          showClearBlock: true,
          showLegacyStart: false,
        },
        priorValidCognitionPreserved,
      };
    case 'completed':
      return {
        headline: '✅ 调查已完成',
        detail: 'Agent 已形成判断，可基于当前判断生成处理建议。',
        availableActions: {
          // The reducer overrides these below in `reduce()` for the
          // completed state, because the showGenerateRecommendation flag
          // depends on whether a Recommendation already exists.
          showGenerateRecommendation: false,
          showClearBlock: false,
          showLegacyStart: false,
        },
        priorValidCognitionPreserved: false,
      };
    case 'observing':
      return {
        headline: '👀 持续观察',
        detail: 'Agent 已完成调查并选择持续观察。',
        availableActions: {
          showGenerateRecommendation: false,
          showClearBlock: false,
          showLegacyStart: false,
        },
        priorValidCognitionPreserved: false,
      };
    case 'waiting_human':
      return {
        headline: '👤 等待人工',
        detail: 'Agent 已明确请求人工介入（ask_human 或 missing_capability）。请处理后通过判断反馈按钮告知 Agent。',
        availableActions: {
          showGenerateRecommendation: false,
          showClearBlock: false,
          showLegacyStart: false,
        },
        priorValidCognitionPreserved: false,
      };
  }
};

// ---- prior cognition (used for `recoverable` content copy) ----

const hasPriorValidCognition = (
  inv: NonNullable<LearningContext['investigation']> | undefined,
): boolean => {
  if (!inv) return false;
  return !!(inv.judgment && inv.judgment.length > 0) ||
    !!(inv.currentUnderstanding && inv.currentUnderstanding.length > 0);
};

// ---- Investigation summary (projection) ----

const projectInvestigation = (
  inv: LearningContext['investigation'],
  presentation: WorkspacePresentationState,
  threshold: number,
): InvestigationSummary | null => {
  if (!inv) return null;
  return {
    status: presentation,
    stopReason: inv.stopReason,
    judgment: inv.judgment ?? '',
    currentUnderstanding: inv.currentUnderstanding ?? '',
    recommendation: inv.recommendation,
    hypotheses: (inv.hypotheses ?? []).map((h) => ({
      statement: h.statement,
      status: h.status,
    })),
    consecutiveFailures: inv.consecutiveFailures ?? 0,
    maxConsecutiveFailures: threshold,
    startedAt: inv.startedAt,
    updatedAt: inv.updatedAt,
  };
};

// ---- WorkItem projection ----

const projectOutputs = (outputs: WorkItem[] | undefined): WorkItemSummary[] => {
  if (!outputs || outputs.length === 0) return [];
  // Newest first by createdAt. The schema requires createdAt; fall back
  // to lexical sort so the function is total.
  return [...outputs]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map((o) => ({
      outputId: o.outputId,
      type: o.type,
      status: o.status,
      content: o.content,
      createdAt: o.createdAt,
      acknowledgedAt: o.acknowledgedAt,
      closedAt: o.closedAt,
    }));
};

// ---- Intervention projection ----

const projectInterventions = (
  rows: ReadonlyArray<HumanIntervention>,
): InterventionSummary[] => {
  return rows.map((i) => {
    // decision: stored inside content (per learning-context.ts:197-210).
    // Only present for type='decision'.
    const decision =
      i.type === 'decision' && i.content && typeof i.content === 'object'
        ? (i.content as { decision?: string }).decision
        : undefined;
    return {
      interventionId: i.interventionId,
      type: i.type,
      decision:
        decision === 'accept' ||
        decision === 'reject' ||
        decision === 'defer' ||
        decision === 'override' ||
        decision === 'no_action'
          ? decision
          : undefined,
      summary: i.summary,
      timestamp: i.timestamp,
    };
  });
};

// ---- presentationRevision (stable hash) ----

/**
 * Stable hash of the facts that change what the operator sees. Two
 * requests with the same persisted state produce the same revision;
 * the polling UI skips re-render when it matches the cached one.
 *
 * Inputs to the hash:
 *   * presentation state
 *   * situation lifecycle
 *   * investigation: status, stopReason, updatedAt, consecutiveFailures,
 *     blockedEmittedAt, recommendation presence + content fingerprint
 *   * outputs: ids, statuses, count
 *   * interventions: ids, types, decisions
 *   * situation updatedAt
 *
 * Deliberately EXCLUDED (per audit §6.5 IMPORTANT):
 *   * `computedAt` (the reducer's own timestamp would change every poll)
 *   * any timestamps that the UI does not depend on for state
 *   * LoopEvent id (non-durable)
 */
const computeRevision = (input: ReducerInput, presentation: WorkspacePresentationState): string => {
  const inv = input.learningContext?.investigation;
  const outputs = input.learningContext?.outputs ?? [];
  const interventionFingerprint = input.interventions
    .map((i) => `${i.interventionId}:${i.type}:${JSON.stringify(i.content ?? {})}`)
    .join('|');
  const outputFingerprint = outputs
    .map(
      (o) =>
        `${o.outputId}:${o.status}:${(o.content || '').slice(0, 32)}:${o.createdAt}`,
    )
    .join('|');
  const recommendationFingerprint = inv?.recommendation
    ? `${inv.recommendation.recommendation.slice(0, 32)}|${(inv.recommendation.humanNeeded ?? []).length}`
    : 'none';
  const payload = JSON.stringify({
    presentation,
    situationLifecycle: input.situation.lifecycle,
    situationUpdatedAt: input.situation.updatedAt,
    invStatus: inv?.status ?? 'none',
    invStopReason: inv?.stopReason ?? 'none',
    invUpdatedAt: inv?.updatedAt ?? 'none',
    invConsecutiveFailures: inv?.consecutiveFailures ?? 0,
    invBlockedEmittedAt: inv?.blockedEmittedAt ?? 'none',
    invStartedAt: inv?.startedAt ?? 'none',
    recommendation: recommendationFingerprint,
    outputs: outputFingerprint,
    interventions: interventionFingerprint,
  });
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
};

// ---- Top-level reducer ----

/**
 * Pure: same input + same `now` → same output. The caller must pass
 * `now` so tests can pin the timestamp. In production, the route layer
 * passes `new Date().toISOString()`.
 */
export const reduce = (input: ReducerInput): WorkspacePresentationOutput => {
  const inv = input.learningContext?.investigation;
  const threshold = DEFAULT_THRESHOLD;

  const presentation = decidePresentation(inv, threshold);
  const priorValidCognitionPreserved =
    presentation === 'recoverable' && hasPriorValidCognition(inv);
  const consecutiveFailures = inv?.consecutiveFailures ?? 0;

  // Start from the static banner; then refine two states that need
  // the recommendation presence check (no recompute paths elsewhere).
  let banner = bannerFor(presentation, priorValidCognitionPreserved, consecutiveFailures, threshold);
  if (presentation === 'completed') {
    // Only show "生成建议" when no Recommendation exists yet. This
    // mirrors the historical `rec == null` gate at app.js:2232-2233
    // but lifted to the reducer so the UI does not need to do it.
    const hasRecommendation =
      inv?.recommendation != null &&
      typeof inv.recommendation.recommendation === 'string' &&
      inv.recommendation.recommendation.length > 0;
    banner = {
      ...banner,
      detail: hasRecommendation
        ? '查看右栏的判断与建议；如需复审请使用判断反馈按钮。'
        : 'Agent 已完成调查，可基于当前判断生成处理建议。',
      availableActions: {
        ...banner.availableActions,
        showGenerateRecommendation: !hasRecommendation,
      },
    };
  }

  const investigation = projectInvestigation(inv, presentation, threshold);
  const outputs = projectOutputs(input.learningContext?.outputs);
  const interventions = projectInterventions(input.interventions);

  const presentationRevision = computeRevision(input, presentation);

  return {
    situationId: input.situation.situationId,
    presentation,
    situationLifecycle: input.situation.lifecycle,
    banner,
    investigation,
    outputs,
    interventions,
    computedAt: input.now,
    presentationRevision,
  };
};

// ---- Feed-list reduction (lighter shape) ----

const feedShortLabel = (
  presentation: WorkspacePresentationState,
  inv: LearningContext['investigation'],
): string => {
  switch (presentation) {
    case 'pending': return '待处理';
    case 'investigating': return '调查中';
    case 'recoverable': return '调查中（已失败 · Runtime 正在重试）';
    case 'completed':
      return inv?.recommendation ? '判断已形成 · 已生成建议' : '判断已形成';
    case 'observing': return '持续观察';
    case 'waiting_human': return '等待人工';
    case 'blocked': return '自动调查已暂停';
  }
};

const hasAcceptedDecisionFlag = (rows: ReadonlyArray<HumanIntervention>): boolean => {
  return rows.some((i) => {
    if (i.type !== 'decision') return false;
    const c = i.content as { decision?: string } | undefined;
    return c?.decision === 'accept';
  });
};

const judgmentPreview = (inv: LearningContext['investigation']): string => {
  if (!inv?.judgment) return '';
  return inv.judgment.length > 70 ? inv.judgment.slice(0, 70) : inv.judgment;
};

export const reduceForFeed = (input: ReducerInput): FeedEntrySummary => {
  const full = reduce(input);
  const inv = input.learningContext?.investigation;
  return {
    situationId: input.situation.situationId,
    presentation: full.presentation,
    headline: full.banner.headline,
    shortLabel: feedShortLabel(full.presentation, inv),
    observedAt: (input.situation.temporal?.observedAt ?? input.situation.createdAt) as string,
    interventionCount: input.interventions.length,
    hasAcceptedDecision: hasAcceptedDecisionFlag(input.interventions),
    judgmentPreview: judgmentPreview(inv),
    presentationRevision: full.presentationRevision,
  };
};
