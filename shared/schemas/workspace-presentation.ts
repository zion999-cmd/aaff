// P0010.2.x — Workspace Presentation Output (single source of truth for the
// operator-facing state of a Situation in the Workspace).
//
// Architectural boundary (DO NOT VIOLATE):
//   * WorkspacePresentation is a DERIVED VIEW, not a new business lifecycle.
//   * It is NOT persisted. The reducer recomputes it on every request.
//   * It MUST NOT write to DB, MUST NOT mutate `situations.lifecycle`,
//     `investigation.status`, or `outputs[].status`. Those three real
//     state machines continue to be the only authoritative persisted facts.
//   * It is consumed ONLY by Workspace UI (Feed, Detail, badges, buttons).
//   * It MUST NOT depend on LoopEvent (ring buffer is non-durable across
//     agentFabric restart). Only persisted sidecars
//     (`investigation.consecutiveFailures`, `investigation.blockedEmittedAt`)
//     are used to determine `blocked`.
//
// Two distinct questions, two distinct surfaces:
//   * WorkspacePresentationOutput answers: "What business state is this
//     Situation in, and what should the operator do with it?"
//   * Execution Trace (loop-events.ts /api/runtime/loop/events) answers:
//     "What is the Runtime/Agent doing right now?"
// They MUST NOT be mixed — see audit §6.7.

import { z } from 'zod';
import { IsoDateString } from './common.js';
import { WorkItemTypeSchema, WorkItemStatusSchema } from './output.js';
import {
  HypothesisStatusSchema,
  StopReasonSchema,
  RecommendationSchema,
} from './investigation.js';
import { ContextLifecycleSchema } from './learning-context.js';

// ---- Presentation State enum (7 states, single source of truth) ----

/**
 * The 7 Workspace Presentation States. Each value is a distinct, mutually
 * exclusive operator-facing state. The reducer at
 * `apps/ecommerce/workspace/presentation-state.ts` is the only thing that
 * returns one of these strings; UI MUST NOT compute it.
 *
 * State semantics (see audit §6.2 for the precedence tree):
 *   - `pending`        No investigation yet, or inv.status='pending'.
 *   - `investigating`  inv.status='investigating'; the Agent is running.
 *   - `recoverable`    inv.status='failed' (any failure, regardless of
 *                      whether prior valid cognition exists). Content
 *                      layer MAY show "prior cognition preserved" as
 *                      a *supplement*, but the state is `recoverable`
 *                      until a new turn actually completes. CRITICAL:
 *                      `failed + hasPriorValidCognition` is NOT
 *                      `observing` — that was the pre-P0010.2.x
 *                      regression we are explicitly closing.
 *   - `completed`      inv.status='completed' (default — includes
 *                      stopReason='judgment'). The investigation
 *                      landed cleanly; the operator reviews the
 *                      recommendation.
 *   - `observing`      inv.status='completed' AND
 *                      inv.stopReason='observe'. The Agent has
 *                      explicitly chosen to watch the case.
 *   - `waiting_human`  inv.status='completed' AND inv.stopReason ∈
 *                      {'ask_human', 'missing_capability'}. CRITICAL:
 *                      `recommendation.humanNeeded.length > 0` does
 *                      NOT promote to this state — that field is
 *                      "may need human at execution time", not
 *                      "Agent is blocked waiting for human".
 *   - `blocked`        inv.status='failed' AND
 *                      inv.consecutiveFailures >= inv.maxConsecutiveFailures
 *                      AND inv.blockedEmittedAt != null. All three
 *                      conditions are PERSISTED sidecars; the LoopEvent
 *                      ring buffer is NOT consulted.
 */
export const WorkspacePresentationStateSchema = z.enum([
  'pending',
  'investigating',
  'recoverable',
  'completed',
  'observing',
  'waiting_human',
  'blocked',
]);
export type WorkspacePresentationState = z.infer<typeof WorkspacePresentationStateSchema>;

// ---- Presentation Banner (operator-facing copy) ----

/**
 * The operator-facing banner rendered at the top of the Investigation
 * card. Headline + detail are pre-derived by the reducer so the UI does
 * zero string-sniffing. `availableActions` is the SINGLE source of
 * button visibility — UI MUST NOT derive button visibility from
 * `presentation` or any other field.
 */
export const PresentationBannerSchema = z.object({
  /** Single emoji + short label, e.g. "🔍 调查中". */
  headline: z.string(),
  /** One-sentence explanation in Chinese, e.g. "Runtime 已锁定该 Situation 的调查上下文。". */
  detail: z.string(),
  /** Buttons the operator can press in this state. The UI MUST read
   *  this map to decide button visibility — never `inv.status === '...'`. */
  availableActions: z.object({
    /** Show "生成建议" / "立即调查(恢复)" affordance. */
    showGenerateRecommendation: z.boolean(),
    /** Show "解除阻塞并重新调度" affordance (only meaningful in `blocked`). */
    showClearBlock: z.boolean(),
    /** Legacy "立即调查" start button (only when no investigation has
     *  ever run; soft-deprecated, kept for back-compat). */
    showLegacyStart: z.boolean(),
  }),
  /** True iff the latest attempt is `failed` AND a prior turn produced
   *  valid cognition (judgment OR currentUnderstanding). The reducer
   *  exposes this flag so the content layer can render the
   *  "上一次有效判断仍保留；最新调查失败，Runtime 正在重试" copy —
   *  the flag does NOT change `presentation` itself. */
  priorValidCognitionPreserved: z.boolean(),
});
export type PresentationBanner = z.infer<typeof PresentationBannerSchema>;

// ---- Investigation Summary (projection, not raw) ----

/** A flattened projection of the investigation block for UI consumption.
 *  Carries only the fields the Workspace actually renders. The raw
 *  `investigation` object is still returned alongside (compat), but the
 *  Workspace MUST consume this projection. */
export const InvestigationSummarySchema = z.object({
  /** Mirrors the top-level `presentation` — provided here so the
   *  Understanding surface does not have to reach for the parent
   *  field. */
  status: WorkspacePresentationStateSchema,
  stopReason: StopReasonSchema.optional(),
  /** Raw prose. */
  judgment: z.string().default(''),
  currentUnderstanding: z.string().default(''),
  /** The Agent's recommendation (when one exists). Carries `humanNeeded`
   *  for rendering purposes ONLY — it MUST NOT be consulted to derive
   *  presentation state. */
  recommendation: RecommendationSchema.optional(),
  /** Hypothesis list (for the Investigation Track view). */
  hypotheses: z
    .array(
      z.object({
        statement: z.string(),
        status: HypothesisStatusSchema,
      }),
    )
    .default([]),
  /** P0010.2.2 sidecar — consecutive failure count. */
  consecutiveFailures: z.number().int().min(0).default(0),
  /** P0010.2.2 sidecar — threshold (default 3). */
  maxConsecutiveFailures: z.number().int().positive().default(3),
  /** UTC ISO; the only timestamp the UI gets for the investigation. */
  startedAt: IsoDateString.optional(),
  updatedAt: IsoDateString.optional(),
});
export type InvestigationSummary = z.infer<typeof InvestigationSummarySchema>;

// ---- WorkItem Summary ----

export const WorkItemSummarySchema = z.object({
  outputId: z.string(),
  type: WorkItemTypeSchema,
  status: WorkItemStatusSchema,
  content: z.string(),
  createdAt: IsoDateString,
  acknowledgedAt: IsoDateString.optional(),
  closedAt: IsoDateString.optional(),
});
export type WorkItemSummary = z.infer<typeof WorkItemSummarySchema>;

// ---- Intervention Summary ----

export const InterventionSummarySchema = z.object({
  interventionId: z.string(),
  type: z.enum(['response', 'correction', 'context_supplement', 'decision']),
  /** For type='decision' only; otherwise undefined. */
  decision: z.enum(['accept', 'reject', 'defer', 'override', 'no_action']).optional(),
  summary: z.string(),
  /** UTC ISO. */
  timestamp: IsoDateString,
});
export type InterventionSummary = z.infer<typeof InterventionSummarySchema>;

// ---- Top-level WorkspacePresentationOutput ----

/**
 * The single response shape for the Detail page. Returned by
 * `GET /api/situations/:id` (and embedded in the Feed list response).
 *
 * `presentationRevision` is the polling dedup key. It is a stable hash
 * of the persisted facts that actually change the operator's view
 * (presentation, outputs, interventions, sidecars, lifecycle). It is
 * NOT a function of `computedAt`; two requests with the same persisted
 * state MUST produce the same revision. This is what lets the UI
 * skip a full re-render when nothing relevant changed.
 */
export const WorkspacePresentationOutputSchema = z.object({
  situationId: z.string(),
  /** The single Presentation state. UI reads this and nothing else
   *  for "what is this situation doing". */
  presentation: WorkspacePresentationStateSchema,
  /** Convenience — `situations.lifecycle` is the persisted open/partial/mature
   *  flag. Exposed here so the UI does not have to re-read the situation row. */
  situationLifecycle: ContextLifecycleSchema,
  /** Pre-rendered banner (headline + detail + available actions). */
  banner: PresentationBannerSchema,
  /** The investigation summary (projection). */
  investigation: InvestigationSummarySchema.nullable(),
  /** All WorkItems for this Situation, newest first. */
  outputs: z.array(WorkItemSummarySchema).default([]),
  /** All human interventions, oldest first. */
  interventions: z.array(InterventionSummarySchema).default([]),
  /** UTC ISO — the moment the reducer produced this output. NOT used
   *  as a revision key; see `presentationRevision` below. */
  computedAt: IsoDateString,
  /** Stable hash of the relevant persisted facts. UI uses this to
   *  decide whether to re-render after a poll. */
  presentationRevision: z.string().min(1),
});
export type WorkspacePresentationOutput = z.infer<typeof WorkspacePresentationOutputSchema>;

// ---- Feed-list summary (lighter shape, same enum) ----

/** What the Feed needs per Situation card. Same `presentation` enum. */
export const FeedEntrySummarySchema = z.object({
  situationId: z.string(),
  presentation: WorkspacePresentationStateSchema,
  headline: z.string(),
  /** E.g. "调查完成 · 已形成判断" — short, fits in a card. */
  shortLabel: z.string(),
  /** UTC ISO date (YYYY-MM-DD) for the card's date stamp. UI formats. */
  observedAt: IsoDateString,
  /** Human intervention count (for the "X 条反馈" footer). */
  interventionCount: z.number().int().nonnegative().default(0),
  /** Has a `decision: accept` intervention been recorded? Drives the
   *  legacy "判断已采纳" badge; pure presentational. */
  hasAcceptedDecision: z.boolean().default(false),
  /** First 70 chars of the Agent judgment, if any. */
  judgmentPreview: z.string().default(''),
  /** Stable revision for the Feed card. */
  presentationRevision: z.string().min(1),
});
export type FeedEntrySummary = z.infer<typeof FeedEntrySummarySchema>;
