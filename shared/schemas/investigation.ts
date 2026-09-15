// Investigation Contract — the business-level artifacts of a Knowledge-Guided
// Investigation (P0010). These are domain-auditable objects (Known Evidence /
// Hypotheses / Unknowns / Next Question / Findings / Judgment), NOT model
// Chain-of-Thought. The Runtime (Hermes) produces them; Fabric persists and
// surfaces them to the Workspace.
//
// Anti-goals: no reasoning tokens, no hidden reasoning, no investigation DSL.

import { z } from 'zod';
import {
  EpistemicLayersSchema,
  ClaimEvidenceRefSchema,
  ThresholdSchema,
  PriorCognitionSchema,
} from './epistemic.js';

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
 * P0010.2.x — what KIND of recommendation this is.
 *
 * The Operator-facing surface has two fundamentally different
 * recommendation types, and conflating them in one chip ("👤 等待人工"
 * or "📋 待交付") produces exactly the noise the audit surfaced:
 * 90+ "维持持续观察名单" rows that the Operator can neither act on
 * nor clear, and that bury any real action item.
 *
 *   - `observe` — the Agent's recommendation is "do nothing / wait /
 *     keep watching". Typical when `stopReason ∈ {observe,
 *     missing_capability}` and the judgment is "insufficient evidence
 *     to act". The WorkItem for an `observe` recommendation is a
 *     STATUS pill (grey, "保持观察"), NOT a to-do. The Operator
 *     should NOT be asked to acknowledge / close it; it represents
 *     the system's own watchful state.
 *
 *   - `act` — the Agent's recommendation is something the Operator
 *     should consider doing ("调整主推位", "下架此 SKU"). Typical when
 *     `stopReason=judgment` and the judgment is a supported/rejected
 *     hypothesis with a concrete next step. The WorkItem for an `act`
 *     recommendation IS a to-do (yellow / red chip, "待交付"). The
 *     Operator should look at it, accept/reject/correct via the
 *     existing Intervention grammar.
 *
 * This enum is the operator-trust contract that drives the Workspace
 * chip split. It is intentionally binary — there is no third "ask the
 * user to provide information" state because that is the existing
 * `stopReason=ask_human` and the Operator surface for it is the
 * Investigation summary, not a WorkItem.
 */
export const RecommendationKindSchema = z.enum(['observe', 'act']);
export type RecommendationKind = z.infer<typeof RecommendationKindSchema>;

/** Canonical Chinese label for the Operator surface (Workspace chip). */
export const RECOMMENDATION_KIND_LABEL: Readonly<Record<RecommendationKind, string>> = Object.freeze({
  observe: '保持观察',
  act: '待交付',
});

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
  /**
   * P0010.2.x — what KIND of recommendation this is. Drives the
   * Workspace chip split (observe → grey "保持观察" status pill,
   * act → yellow/red "待交付" to-do). Defaults to 'act' for backward
   * compatibility with pre-C WorkItems that did not set the field;
   * the parser/normalizer prefers the explicit value when present.
   * The boundary normalizer in `runtime/investigation/normalize.ts`
   * also derives a default from `stopReason` when the field is
   * missing (observe / missing_capability / ask_human → 'observe',
   * judgment → 'act') so a non-C Agent still gets the right chip.
   */
  kind: RecommendationKindSchema.default('act'),
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
 * P0013.2 Evidence Resolution — Context Missing ≠ Evidence Missing.
 * Before declaring an Evidence Gap the agent must attempt resolution
 * against evidence the system already holds. Three results:
 *   IN_CONTEXT  — prompt already carries enough evidence;
 *   RETRIEVED   — held evidence was retrieved and answered the need;
 *   UNAVAILABLE — neither context nor held evidence answers it (true gap).
 */
export const EvidenceResolutionResultSchema = z.enum([
  'IN_CONTEXT',
  'RETRIEVED',
  'UNAVAILABLE',
]);
export type EvidenceResolutionResult = z.infer<typeof EvidenceResolutionResultSchema>;

export const EvidenceResolutionSchema = z.object({
  /** The evidence need that triggered resolution. */
  need: z.string().min(1),
  /** Which structure dimension the need belongs to (when dimension-specific). */
  dimension: z.enum(['product', 'orders', 'traffic', 'conversion', 'operations']).optional(),
  result: EvidenceResolutionResultSchema,
  /** Where the evidence came from (e.g. 'order_replay_retrieval', 'fabric_capability'). */
  source: z.string().default(''),
  /** The specific retrieval query executed (when RETRIEVED / attempted). */
  query: z.string().default(''),
  /** Evidence refs obtained — non-empty when RETRIEVED. */
  retrieved_refs: z.preprocess((v) => v ?? [], z.array(z.string())).default([]),
  /** Why held evidence cannot answer — required when UNAVAILABLE. */
  note: z.string().default(''),
});
export type EvidenceResolution = z.infer<typeof EvidenceResolutionSchema>;

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
  // ─── P0013 §9 / §10 / §14 / §15 / §33 ───
  // Daily Cognitive Snapshot fields. ADDITIVE — every field is .optional()
  // or has a default so pre-P0013 records still parse byte-for-byte.
  // No field here is renamed, removed, or required. The parseInvestigation
  // caller does NOT need to change; the new defaults are filled in by Zod.
  /** §9 — Business Date the Agent observed. The replay clock anchor. */
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** §9 — Raw "what happened today" facts (Evidence-supported only). */
  observed_facts: z.preprocess((v) => v ?? [], z.array(z.string())).default([]),
  /** §11 — Evidence the Agent identified it DOES NOT have. A valid output, not a failure. */
  evidence_gaps: z.preprocess((v) => v ?? [], z.array(z.string())).default([]),
  /** §3 / §23 — ISO timestamp at which the temporal filter was enforced for this turn. */
  temporal_boundary_checked_at: z.string().optional(),
  /** §9 — evidence_observations ids the Agent relied on (the §3 data-boundary proof). */
  supporting_evidence_refs: z.preprocess((v) => v ?? [], z.array(z.string())).default([]),
  /**
   * §7 / §10 / §14 — Defaults to false. P0013 NEVER writes true (Replay
   * recommendations are PROPOSED, NOT EXECUTED, per §14). A future Action
   * system can flip this to true when a recommendation is actually executed.
   */
  recommendation_executed: z.boolean().default(false),
  /** §18 / §21 — YYYY-MM. Set when a snapshot is finalized for a month review. */
  month_anchor: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  /** §16 / §32 — Partition key. Production rows have no replay_run_id. */
  replay_run_id: z.string().optional(),
  // ─── Epistemic Integrity (2026-09-06, P0013 08-14 incident) ───
  //
  // The Agent MUST distinguish:
  //   L1 Observed Fact   — directly supported by visible Evidence
  //   L2 Pattern         — inductive inference from multiple Observed Facts
  //                        (Pattern Candidate != Established Pattern)
  //   L3 Hypothesis      — causal/mechanism explanation with explicit falsifier
  //   L4 Confirmed       — claim backed by explicit confirmed_evidence_refs
  //   L5 Judgment        — known / inferred / unknown / decision / confidence_basis
  //
  // Production + Replay share the SAME contract. No Replay-only workaround.
  // All fields are OPTIONAL with safe defaults; pre-epistemic rows still parse.
  //
  // The previous InvestigationSchema had NO Fact/Pattern/Confirmed layering.
  // currentUnderstanding was a free-prose dump where Observation / Pattern /
  // Hypothesis / Causal Explanation / Confirmed Conclusion all collapsed into
  // one string. The Agent then had no structural way to mark "this is a
  // Pattern Candidate" vs "this is a Confirmed fact" — so it verbalized
  // "10000+ 新常态" as a Fact even though the only Evidence was a 1-day
  // window. This section is the fix.
  //
  // See shared/schemas/epistemic.ts for the layered contract.
  /** L1-L5 epistemic layering. Optional — default empty. */
  epistemic_layers: EpistemicLayersSchema.optional(),
  /** Per-claim provenance for strong claims (numeric, temporal, campaign,
   *  consecutive-N, alternation, stable, baseline, recovery, anomaly,
   *  confirmation, reversal, causal). Optional — default empty. */
  claim_evidence_refs: z.array(ClaimEvidenceRefSchema).default([]),
  /** Threshold provenance — every quantitative threshold the Agent mentions
   *  (e.g. "GMV > 12000") MUST carry a provenance. heuristic thresholds
   *  are allowed but cannot be called "confirmation rules". */
  thresholds: z.array(ThresholdSchema).default([]),
  /** Prior cognition (T-1 hypothesis / judgment / recommendation) — the
   *  Replay layer. At T, T-1's hypothesis is still a hypothesis until
   *  NEW Evidence shifts it; it MUST NOT auto-upgrade to "current fact"
   *  just because the run clock advanced. */
  prior_cognition: z.array(PriorCognitionSchema).default([]),
  /**
   * P0013.2 Shared Analysis Contract — mandatory five-dimension business
   * structure coverage. Fail-closed obligations for these are enforced by
   * validateAnalysisObligations at parse time (missing/gap/observe rules).
   */
  business_structure_coverage: z
    .array(
      z
        .object({
          dimension: z.enum(['product', 'orders', 'traffic', 'conversion', 'operations']),
          status: z.enum(['covered', 'gap', 'not_applicable']),
          note: z.string().min(1),
          // Models commonly emit explicit null for "not applicable here";
          // coerce to the empty default rather than rejecting the turn.
          evidence_refs: z.array(z.string()).nullable().transform((v) => v ?? []).default([]),
          /** Required (non-empty) when status === 'gap'. */
          acquisition_need: z.string().nullable().transform((v) => v ?? '').default(''),
        })
        .superRefine((c, ctx) => {
          if (c.status === 'gap' && c.acquisition_need.trim().length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `business_structure_coverage[${c.dimension}] gap requires acquisition_need`,
              path: ['acquisition_need'],
            });
          }
        }),
    )
    .default([]),
  /**
   * P0013.2 Evidence Resolution attempts performed BEFORE declaring gaps.
   * Fail-closed obligations for these live in analysis-obligations.ts.
   */
  evidence_resolutions: z
    .preprocess((v) => v ?? [], z.array(EvidenceResolutionSchema))
    .default([]),
});
export type Investigation = z.infer<typeof InvestigationSchema>;
