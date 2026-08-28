// P0010.1 Post-Productization REPAIR — minimal Output / WorkItem contract.
//
// A WorkItem is the Agent's "deliverable" — what the Agent has produced that
// the human is supposed to look at / acknowledge / close. This is a thin
// surface, NOT a ticket system. There is no transport, no delivery engine,
// no approval flow. The status enum is the only state machine.
//
// Why JSON-in-body, not a new SQL table:
//   - Existing `learning_contexts.body` is JSON; adding `outputs[]` is
//     additive (default []) and does not require a migration.
//   - The 5-7 existing fields (`interventions[]`, `actions[]`, `outcomes[]`)
//     are already stored this way, so the pattern is established.
//   - The audit (Output/WorkItem) classified this as REUSE with a single new
//     field; no producer changes are required for the 3 demo situations.
//
// What this contract does NOT do:
//   - It does NOT represent Action execution (Agent never executes business
//     actions in this slice — see runtime/investigation/prompt.ts:196-198).
//   - It does NOT transport to Feishu / WeCom / Email / Telegram.
//   - It does NOT poll, wake, or schedule review.
//   - It does NOT have a delivery acknowledgement by an external system.
//     `acknowledged` is set by the human pressing a button in Workspace.
//   - It does NOT auto-advance on page load. The `mark-delivered`
//     convenience endpoint was REMOVED in P0010.1 REPAIR-5; opening the
//     Workspace does not change any WorkItem's status.
//
// Status semantics (the only state machine; canonical Chinese label):
//   - `ready`        — 待交付 — Agent has produced this; the Operator is
//                       expected to look at the deliverable.
//   - `delivered`    — 已交付 — The Agent has surfaced the item to the
//                       Workspace surface. Operator-driven transition
//                       (e.g. via the per-Output acknowledge/close actions
//                       in the Output Detail view), NOT auto on page load.
//   - `acknowledged` — 已确认 — The Operator has explicitly clicked
//                       "已知悉" / "确认收到" on the deliverable.
//   - `closed`       — 已关闭 — The Operator has closed the deliverable.
//                       This is a per-WorkItem transition. It does NOT
//                       close the parent Situation. The Situation has its
//                       own lifecycle (pending / investigating / watching
//                       / waiting_human / closed) and a separate resolution
//                       contract. Recommendation adoption by the Operator
//                       is an Intervention (`decision: accept/reject`),
//                       NOT a close path for either the WorkItem or the
//                       Situation.

import { z } from 'zod';
import { RecommendationKindSchema, RECOMMENDATION_KIND_LABEL } from './investigation.js';

/** What kind of deliverable is this. */
export const WorkItemTypeSchema = z.enum([
  /** A persisted Recommendation from an investigation. */
  'recommendation',
  /** An analysis report (e.g. the full Investigation contract as a deliverable). */
  'analysis',
  /** A concrete work item the operator should perform (e.g. check inventory). */
  'work_item',
  /** A generated report / document (e.g. a CVR analysis report). */
  'report',
]);
export type WorkItemType = z.infer<typeof WorkItemTypeSchema>;

/** Lifecycle status of a WorkItem. */
export const WorkItemStatusSchema = z.enum(['ready', 'delivered', 'acknowledged', 'closed']);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

/**
 * How to find the actual artifact this WorkItem refers to.
 * `kind` names the address space; `ref` is a path or id; `contentHash`
 * is the content-addressable hash (when the address space supports it).
 *
 * Today only `workspace_path` and `learning_context` are real (they resolve
 * to local files we already write). `evidence` is aspirational — see
 * `SB-1` schema blocker in `context/p0010_1_productization_baseline.md`.
 */
export const WorkItemResultRefSchema = z.object({
  kind: z.enum(['workspace_path', 'learning_context', 'evidence', 'none']),
  ref: z.string().min(1).optional(),
  contentHash: z.string().optional(),
});
export type WorkItemResultRef = z.infer<typeof WorkItemResultRefSchema>;

/**
 * Minimal WorkItem — the Operator-visible deliverable.
 * All fields are required unless marked optional.
 */
export const WorkItemSchema = z.object({
  outputId: z.string().min(1),
  situationId: z.string().min(1),
  type: WorkItemTypeSchema,
  status: WorkItemStatusSchema,
  resultRef: WorkItemResultRefSchema.optional(),
  /** Operator-facing prose summary of the deliverable. */
  content: z.string().min(1),
  /**
   * P0010.2.x — Recommendation kind (observe | act). Drives the
   * Workspace chip split (grey "保持观察" vs yellow/red "待交付").
   * Optional for backward compatibility with pre-C WorkItems; the
   * API layer defaults to 'act' for missing values (the historical
   * behavior — every WorkItem was treated as a to-do).
   */
  kind: RecommendationKindSchema.optional(),
  createdAt: z.string().min(1),
  acknowledgedAt: z.string().optional(),
  closedAt: z.string().optional(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

/** Status label for the Operator surface (canonical Chinese, P0010.1 REPAIR-5).
 *  Single source of truth — both server and Workspace import this. */
export const WORK_ITEM_STATUS_LABEL: Readonly<Record<WorkItemStatus, string>> = Object.freeze({
  ready: '待交付',
  delivered: '已交付',
  acknowledged: '已确认',
  closed: '已关闭',
});

/** Type label for the Operator surface (Chinese). */
export const WORK_ITEM_TYPE_LABEL: Readonly<Record<WorkItemType, string>> = Object.freeze({
  recommendation: '建议',
  analysis: '分析',
  work_item: '工作项',
  report: '报告',
});

/** P0010.2.x — Kind label for the Operator surface (Chinese). */
export const WORK_ITEM_KIND_LABEL: Readonly<Record<'observe' | 'act', string>> = Object.freeze({
  observe: RECOMMENDATION_KIND_LABEL.observe,
  act: RECOMMENDATION_KIND_LABEL.act,
});

/** P0010.2.x — CSS class for the kind chip. Workspace renders two
 *  chip styles: `output-kind-observe` (grey status pill) and
 *  `output-kind-act` (yellow/red to-do). The class is the single
 *  source of truth for both the JSX and the stylesheet. */
export const WORK_ITEM_KIND_CSS_CLASS: Readonly<Record<'observe' | 'act', string>> = Object.freeze({
  observe: 'output-kind-observe',
  act: 'output-kind-act',
});
