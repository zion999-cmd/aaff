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
 * Six-state enum the investigation panel collapses into. Replaces the
 * fuzzy `invStatus === 'investigating' / invBlockedRuntimeFailure /
 * invStatus === 'failed' / else` chain that used to contradict itself
 * in the UI ("auto-recover, no human" while a clear-block button was
 * shown). The runtime reads this single value; the banner map below is
 * the only place operator-facing copy is defined.
 */
export type InvestigationDisplayState =
  | 'pending'
  | 'recoverable'
  | 'investigating'
  | 'blocked'
  | 'completed'
  | 'failed_unrecoverable';

/**
 * Pure: maps the structured `investigation` block + the runtime's
 * `blockedRuntimeFailure` flag + the failure counter to exactly one of
 * the six states. Operator override (`blockedRuntimeFailure === true`)
 * wins over everything else so the "解除阻塞并重新调度" button is
 * guaranteed to show.
 */
export function deriveInvestigationDisplayState(
  investigation: { status?: string } | null | undefined,
  blockedRuntimeFailure: boolean,
  consecutiveFailures: number,
): InvestigationDisplayState;

export interface InvestigationDisplayBanner {
  headline: string;
  detail: string;
  /** Show the "解除阻塞并重新调度" clear-block button (only in `blocked`). */
  showClearBlock: boolean;
  /** Show the legacy "立即调查" button (only in `recoverable`). */
  showLegacyStart: boolean;
}

export const INVESTIGATION_DISPLAY_BANNER: Readonly<
  Record<InvestigationDisplayState, InvestigationDisplayBanner>
>;
