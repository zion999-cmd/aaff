// Investigation Contract — the business-level artifacts of a Knowledge-Guided
// Investigation (P0010). These are domain-auditable objects (Known Evidence /
// Hypotheses / Unknowns / Next Question / Findings / Judgment), NOT model
// Chain-of-Thought. The Runtime (Hermes) produces them; Fabric persists and
// surfaces them to the Workspace.
//
// Anti-goals: no reasoning tokens, no hidden reasoning, no investigation DSL.

import { z } from 'zod';

/** How a hypothesis fares after new evidence. */
export const HypothesisStatusSchema = z.enum(['proposed', 'supported', 'weakened', 'rejected']);
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;

/** A single business hypothesis under investigation. */
export const HypothesisSchema = z.object({
  statement: z.string().min(1),
  status: HypothesisStatusSchema.default('proposed'),
});
export type Hypothesis = z.infer<typeof HypothesisSchema>;

/** A question the Agent chose to answer next, with the evidence it needs. */
export const InvestigationQuestionSchema = z.object({
  question: z.string().min(1),
  purpose: z.string().default(''),
  requiredEvidence: z.array(z.string()).default([]),
});
export type InvestigationQuestion = z.infer<typeof InvestigationQuestionSchema>;

/** A finding: one question was answered by evidence. */
export const FindingSchema = z.object({
  question: z.string().default(''),
  evidenceRefs: z.array(z.string()).default([]),
  answer: z.string().default(''),
  impactOnHypothesis: z.string().default(''),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Why the investigation stopped. */
export const StopReasonSchema = z.enum(['judgment', 'observe', 'missing_capability', 'ask_human']);
export type StopReason = z.infer<typeof StopReasonSchema>;

/**
 * P0010.1 Recommendation — the Agent's suggested handling, produced ONLY from
 * its Investigation/Judgment (never directly from Signal/Ranking/threshold).
 * Human feedback (accept/reject/correction) reuses the existing Intervention
 * grammar and lands in the Learning Context.
 *
 * The Agent may emit risk/precondition/human items as a single string or a
 * list — normalize both to arrays for the Workspace.
 */
const stringOrList = z.union([z.string(), z.array(z.string())]);
const toList = (v: string | string[]): string[] => (typeof v === 'string' ? (v ? [v] : []) : v);

export const RecommendationSchema = z.object({
  recommendation: z.string().min(1),
  /** Linked judgment (prose) this recommendation is based on. */
  rationale: z.string().default(''),
  expectedOutcome: z.string().default(''),
  risks: stringOrList.transform(toList).default([]),
  prerequisites: stringOrList.transform(toList).default([]),
  /** Information only a human can provide, if any. */
  humanNeeded: stringOrList.transform(toList).default([]),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/**
 * The full Investigation Contract for one situation.
 * Fabric stores this (additively in the situation's Learning Context) and the
 * Workspace renders it so a professional can judge whether the Agent asked the
 * right question.
 */
export const InvestigationSchema = z.object({
  /** The situation this investigation explains. */
  situationId: z.string().min(1),
  /** What the Agent currently understands (prose). */
  currentUnderstanding: z.string().default(''),
  /** Evidence the Agent already holds (short labels; refs live in findings). */
  knownEvidence: z.array(z.string()).default([]),
  hypotheses: z.array(HypothesisSchema).default([]),
  /** What the Agent does not yet know. */
  unknowns: z.array(z.string()).default([]),
  /** The single next question the Agent chose. */
  nextQuestion: z.string().default(''),
  /** Evidence the next question needs. */
  requiredEvidence: z.array(z.string()).default([]),
  /** How the Agent plans to acquire the required evidence (Fabric capability, existing evidence, …). */
  investigationRequest: z.string().default(''),
  findings: z.array(FindingSchema).default([]),
  judgment: z.string().default(''),
  stopReason: StopReasonSchema.optional(),
  /**
   * Which Fabric capability was actually executed during this investigation.
   *
   * P0010.1 REPAIR: `null` is the HONEST representation for "this turn did not
   * execute any Fabric capability" (e.g. the Agent was interrupted before it
   * could call fabric_execute_capability, or it stopped with judgment purely
   * from prior context + Knowledge). The previous `z.string().optional()` only
   * accepted `undefined`; Zod rejected `null`, so the contract was lost even
   * though the Agent was being truthful.
   *
   * The schema normalizes the persisted field to a non-null string (empty when
   * the Agent made no Fabric call), so the Workspace and downstream consumers
   * can keep using a single falsy-check (`if (inv.capabilityUsed)`) without
   * scattering `?.` or `?? ''` across the codebase. This normalization
   * explicitly does NOT allow the Agent to invent a capability id just to pass
   * schema: when it has no real capability to report, the empty string is the
   * canonical "honest null".
   */
  capabilityUsed: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v == null ? '' : v)),
  /** Evidence entries acquired during this investigation (evidence ids / labels). */
  evidenceAcquired: z.array(z.string()).default([]),
  /** P0010.1 Recommendation (optional — produced from Judgment, not Signal). */
  recommendation: RecommendationSchema.optional(),
  /**
   * Lifecycle status of the investigation (P0010.1 recovery). A completed
   * investigation carries stopReason; a partial marker (status=investigating)
   * is persisted BEFORE the turn so the Workspace shows a running state and a
   * failed/timeout turn leaves a recoverable marker instead of silently
   * disappearing.
   */
  status: z.enum(['pending', 'investigating', 'failed', 'completed']).optional(),
  /** Error detail when status=failed (timeout / contract error). */
  error: z.string().optional(),
  /** When the current status was set (marker timestamps). */
  startedAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  /**
   * P0010.2 — content hash of the evidence that triggered this investigation.
   * Stamped on BOTH completed and failed markers so the next tick can detect
   * "same content as last attempt" (skip) vs "new content arrived" (retry).
   * The Loop's InvestigationPolicy uses this to avoid re-running a known
   * broken turn on the same evidence (the "infinite retry on a slow LLM"
   * anti-pattern). Stored as a sidecar field rather than a top-level
   * schema field on the Learning Context because the Investigation's
   * contract is content-agnostic — this is a P0010.2 runtime marker, not
   * part of the Investigation's domain shape. */
  evidenceContentHash: z.string().optional(),
  /**
   * P0010.2.2 — consecutive-failure counter for the runtime block threshold.
   * Incremented by the Loop when an investigation fails on the same content,
   * reset to 0 on success OR when the operator explicitly clears the block
   * via POST /api/situation/:id/clear-block. When the counter reaches
   * `maxConsecutiveFailures` (default 3), InvestigationPolicy returns
   * `blocked_runtime_failure` and the Loop emits `investigation_blocked`.
   * Like `evidenceContentHash`, this is a runtime sidecar — not part of the
   * Investigation's domain contract. The canonical operator surface for
   * blocking remains the human intervention grammar (decision: accept |
   * reject | override); this counter is the runtime's authoritative view
   * of "how many retries have we burned on this situation". */
  consecutiveFailures: z.number().int().min(0).optional(),
  /**
   * P0010.2.2 (audit R4 fix) — timestamp at which the Loop most recently
   * emitted the `investigation_blocked` event for this situation. Set on
   * the threshold-crossing tick so subsequent ticks see the marker and
   * suppress re-emission; the operator's clear-block route resets this
   * to `undefined` along with `consecutiveFailures`. Without this, every
   * post-threshold tick would re-emit the blocked event (the counter
   * stays at max because the policy returns `skip` instead of
   * `investigate`, so the counter never increments past max). Sidecar
   * pattern parallels `evidenceContentHash` and `consecutiveFailures`. */
  blockedEmittedAt: z.string().optional(),
});
export type Investigation = z.infer<typeof InvestigationSchema>;
