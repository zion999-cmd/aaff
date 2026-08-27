// Type declarations for apps/ecommerce/workspace/presentation.js.
// This module is a pure ES module of presentation-layer helpers used by
// app.js (browser) and tests/contract/investigation.contract.ts (vitest).
// The .d.ts is intentionally loose: every function accepts "any object"
// because the helpers are defensive (null-safe, unknown-safe) and the
// tests pin the BEHAVIOR. Tight types here would force every call site
// to thread the full Situation/Investigation types, which the vanilla
// JS app.js path does not have.

export function businessDescribeSituation(
  situation: { type?: string; description?: string } | null | undefined,
  investigation: { stopReason?: string; status?: string; judgment?: string; currentUnderstanding?: string } | null | undefined,
): string;

export function businessDescribeSituationShort(
  situation: { type?: string; description?: string } | null | undefined,
  investigation: { stopReason?: string; status?: string; judgment?: string; currentUnderstanding?: string } | null | undefined,
): string;

export function sourceTagLabel(kind: string, refId?: number | string | null): string;
export function sourceTagTooltip(kind: string): string;

export const ERROR_HUMANIZE: ReadonlyArray<{ match: string; text: string }>;

export function humanizeError(raw: string | null | undefined, panelMode: 'business' | 'developer' | string): string;

export function descClean(text: string | null | undefined): string;

export function hasPriorValidCognition(
  investigation: { status?: string; error?: string; judgment?: string; currentUnderstanding?: string } | null | undefined,
): boolean;

// ---- P0010.1 Post-Productization REPAIR additions ----

export type SituationLifecycle = 'pending' | 'investigating' | 'watching' | 'waiting_human' | 'closed';

export function deriveSituationLifecycle(
  investigation: any,
  interventionCount: number,
  hasAcceptedDecision: boolean,
): SituationLifecycle;

export const SITUATION_LIFECYCLE_LABEL: Readonly<Record<SituationLifecycle, string>>;
export const INVESTIGATION_STATUS_LABEL: Readonly<Record<string, string>>;

export interface ObservationCommitment {
  type: 'observe';
  startedAt: string;
  reviewAt: string | null;
  /** Human-readable labels of what an operator should look for before
   *  re-evaluating. NOT auto-wake conditions: there is no scheduler. */
  checkpoints: string[];
  note: string;
}

export function deriveObservationCommitment(investigation: any): ObservationCommitment | null;

export interface SourcePopoverField {
  label: string;
  value: string;
  devOnly?: boolean;
}

export interface SourcePopover {
  title: string;
  fields: SourcePopoverField[];
  unavailable?: { reason: string; detail: string };
}

export function popoverContentForEvidence(evidenceString: string | null | undefined): SourcePopover | null;
export function popoverContentForKnowledge(knownEvidenceText: string | null | undefined): SourcePopover | null;
export function popoverContentForHuman(intervention: any): SourcePopover | null;
export function popoverContentForMemory(): SourcePopover;

export function getSourcePopoverData(
  kind: 'evidence' | 'knowledge' | 'human' | 'memory',
  refId: number | string | null,
  context: { evidenceStrings?: string[]; knownEvidence?: string[]; interventions?: unknown[] },
): SourcePopover | null;

export function renderSourcePopoverHtml(data: SourcePopover | null): string;

// ---- P0010.1 Final Repair — Area B additions ----

/**
 * Map a HumanIntervention to a Chinese business label.
 * `decision` sub-type (accept / reject / defer / override / no_action) is
 * exposed here so the timeline can distinguish them — currently collapsed
 * to a single "决策" label in `app.js:1376`.
 */
export function timelineEventLabel(
  type: string | null | undefined,
  content: { decision?: string } | null | undefined,
): string;

/**
 * Render a vertical Situation timeline as an HTML string. Pure function over
 * the `/api/situations/:id` response — no DOM, no fetch, no LLM. Every event
 * comes from a real persisted timestamp. Empty input → empty string.
 */
export function renderSituationTimeline(detail: any): string;

// ---- P0010.1 Final Repair — Area C.4 declarations ----

/**
 * Best-effort: return the id of the most recent agent activity for the given
 * situation context. Today this is the investigation's `startedAt` (unique
 * per situation). Returns null if nothing is known.
 */
export function deriveLatestAgentActivityId(
  situationContext: {
    situationId?: string;
    invData?: { startedAt?: string | null } | null;
    agentActivities?: Array<{ activityId?: string; timestamp?: string }>;
  } | null | undefined,
): string | null;

/**
 * Project the structured `content.respondsTo.agentActivityIds` array onto
 * the top-level `respondsToActivityIds` field. Only meaningful for
 * `type === 'response'`; other types always return `[]`.
 */
export function flattenRespondsToActivityIds(
  type: string,
  content: { respondsTo?: { agentActivityIds?: unknown[] } } | null | undefined,
): string[];

// ---- P0010.2.4 (ADR-060 audit B) — Investigation display state ----

/**
 * Five-state enum the investigation panel collapses into. Replaces the
 * fuzzy `invStatus === 'investigating' / invBlockedRuntimeFailure /
 * invStatus === 'failed' / else` chain that used to contradict itself
 * in the UI ("auto-recover, no human" while a clear-block button was
 * shown). The runtime reads this single value; the banner map below is
 * the only place operator-facing copy is defined.
 *
 * P0010.2.4 review repair (ADR-061): the previous 6-state enum
 * (`pending / recoverable / investigating / blocked / completed /
 * failed_unrecoverable`) included a `failed_unrecoverable` member
 * that no code path ever returned. The dead member is removed; the
 * contract now matches the actual state machine.
 */
export type InvestigationDisplayState =
  | 'pending'
  | 'recoverable'
  | 'investigating'
  | 'blocked'
  | 'completed';

/**
 * Pure: maps the structured `investigation` block + the runtime's
 * `blockedRuntimeFailure` flag + the failure counter to exactly one of
 * the five states. Operator override (`blockedRuntimeFailure === true`)
 * wins over everything else so the "解除阻塞并重新调度" button is
 * guaranteed to show.
 *
 * `consecutiveFailures` is an INPUT but is only used to enrich the
 * `blocked` banner's detail text; the state itself is determined by
 * `blockedRuntimeFailure`.
 */
export function deriveInvestigationDisplayState(
  investigation: { status?: string } | null | undefined,
  blockedRuntimeFailure: boolean,
  consecutiveFailures: number,
): InvestigationDisplayState;

export interface InvestigationDisplayBanner {
  headline: string;
  /**
   * Either a static string (most states) or a function
   * `(consecutiveFailures, threshold) => string` (the `blocked` state).
   * The workspace calls this with the live counter so the operator
   * sees the actual count instead of a hard-coded "已连续失败 N 次".
   */
  detail: string | ((consecutiveFailures: number, threshold: number) => string);
  /** Show the "解除阻塞并重新调度" clear-block button (only in `blocked`). */
  showClearBlock: boolean;
  /** Show the legacy "立即调查" button (only in `recoverable`). */
  showLegacyStart: boolean;
}

export const INVESTIGATION_DISPLAY_BANNER: Readonly<
  Record<InvestigationDisplayState, InvestigationDisplayBanner>
>;

// ---- P0010.2.x — Workspace Presentation (single source of truth) ----
//
// These types mirror `shared/schemas/workspace-presentation.ts` on the
// server side. The browser app reads `workspacePresentation` from
// `/api/situations/:id` and `presentation` / `headline` /
// `presentationRevision` from `/api/situations` (Feed).
//
// Architectural rule (audit §6.7): the WorkspacePresentation is a
// DERIVED VIEW computed server-side. The browser MUST NOT recompute
// state from raw `learningContext` fields. The two old per-route
// helpers (P0010.1's `deriveInvestigationStatus` and P0010.2.4's
// `deriveInvestigationDisplayState`) are still exported for back-
// compat, but new code MUST consume the WorkspacePresentation types
// below.

/** The 7-state operator-facing state. Mirrors `WorkspacePresentationStateSchema`. */
export type WorkspacePresentationState =
  | 'pending'
  | 'investigating'
  | 'recoverable'
  | 'completed'
  | 'observing'
  | 'waiting_human'
  | 'blocked';

/** The "available actions" map the reducer attaches to the banner.
 *  The browser uses these to show/hide buttons deterministically
 *  instead of guessing from the presentation state. */
export interface PresentationAvailableActions {
  showGenerateRecommendation: boolean;
  showClearBlock: boolean;
  showLegacyStart: boolean;
}

/** The single banner contract. Every operator-facing copy lives here. */
export interface PresentationBanner {
  headline: string;
  detail: string;
  availableActions: PresentationAvailableActions;
  /** True when there was a prior valid judgment/understanding and the
   *  current attempt failed — used by the content layer to render the
   *  "上一次有效判断仍保留" supplemental copy. The state itself remains
   *  `recoverable` (audit §6.7 rule: prior cognition never auto-promotes
   *  to `observing`). */
  priorValidCognitionPreserved: boolean;
}

/** Per-situation summary the reducer derives from
 *  `learningContext.investigation`. Status is the presentation state,
 *  not the raw `investigation.status` field. */
export interface PresentationInvestigationSummary {
  status: WorkspacePresentationState;
  stopReason?: string;
  judgment: string;
  currentUnderstanding: string;
  recommendation: any;
  hypotheses: Array<{ statement: string; status: string }>;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  startedAt?: string;
  updatedAt?: string;
}

/** Per-output summary, newest first. */
export interface PresentationWorkItemSummary {
  outputId: string;
  type: string;
  status: string;
  content: string;
  createdAt: string;
  acknowledgedAt?: string;
  closedAt?: string;
}

/** Per-intervention summary. */
export interface PresentationInterventionSummary {
  interventionId: string;
  type: string;
  decision?: 'accept' | 'reject' | 'defer' | 'override' | 'no_action';
  summary: string;
  timestamp: string;
}

/** The single envelope the Detail page consumes. */
export interface WorkspacePresentationOutput {
  situationId: string;
  presentation: WorkspacePresentationState;
  situationLifecycle: 'open' | 'partial' | 'mature';
  banner: PresentationBanner;
  investigation: PresentationInvestigationSummary | null;
  outputs: PresentationWorkItemSummary[];
  interventions: PresentationInterventionSummary[];
  /** The reducer's wall-clock when the snapshot was computed. The browser
   *  uses this for the "已更新于 X" chip, NOT for the revision hash. */
  computedAt: string;
  /** sha1 hash of the relevant persisted facts (excludes `computedAt`).
   *  Two requests with the same persisted state produce the same revision.
   *  The 4-second polling loop skips re-render when this matches. */
  presentationRevision: string;
}

/** The lighter shape the Feed list returns per row. */
export interface FeedEntrySummary {
  situationId: string;
  presentation: WorkspacePresentationState;
  headline: string;
  shortLabel: string;
  observedAt: string;
  interventionCount: number;
  hasAcceptedDecision: boolean;
  judgmentPreview: string;
  presentationRevision: string;
}

/** Get the single WorkspacePresentation snapshot for one situation.
 *  Replaces the old `deriveInvestigationDisplayState` chain — the Detail
 *  page reads ONLY this value, never raw investigation fields. */
export function getWorkspacePresentation(detail: any): WorkspacePresentationOutput | null;

/** Get a FeedEntrySummary for a situation. Same derivation as
 *  getWorkspacePresentation but projects to the lighter shape. */
export function getFeedEntrySummary(detail: any): FeedEntrySummary | null;
