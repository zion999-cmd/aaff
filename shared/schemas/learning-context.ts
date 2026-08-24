// P0007.1 — Learning Context Contract.
// The runtime-neutral interface between agentFabric and any Agent Runtime.
//
// agentFabric owns:  World → Learning Context (this schema)
// Runtime owns:      Learning Context → Memory → Skill
//
// A Learning Context is the complete, verifiable record of one real-world
// business situation — what was observed, what the Agent proposed, how
// humans intervened, what actions were taken, and what outcomes followed.
//
// Design principles:
//   1. Situation/Case is the anchor — not a chat message, not a task
//   2. Everything is referenced by ID — no data duplication
//   3. Partial contexts are valid — Action/Outcome/Intervention are optional
//   4. Runtime-neutral — no Hermes-specific fields
//   5. Metric snapshots are derived, not authoritative — evidence is the source of truth

import { z } from 'zod';
import { InvestigationSchema } from './investigation.js';
import { IsoDateString } from './common.js';
import { WorkItemSchema } from './output.js';

// ---- Lifecycle ----

/** A Learning Context matures as more real-world data accumulates. */
export const ContextLifecycleSchema = z.enum(['open', 'partial', 'mature']);
export type ContextLifecycle = z.infer<typeof ContextLifecycleSchema>;

// ---- Situation / Case — the business anchor ----

/**
 * A Situation is a real-world business scenario that the Learning Context
 * is about. It is the anchoring concept — everything in the Context
 * (observations, evidence, agent activities, interventions, actions, outcomes)
 * relates back to this Situation.
 *
 * A Situation is NOT a "task" or "chat session". It's a business event
 * like "analyze Qimen Black Tea store traffic decline on 2026-08-12."
 */
export const SituationSchema = z.object({
  /** Unique situation identifier */
  situationId: z.string().min(1),
  /** Business domain (e.g. "ecommerce", "quality_inspection", "supplier_risk") */
  domain: z.string().min(1),
  /** Situation type — broad category of business scenario */
  type: z.enum([
    'performance_analysis',  // analyzing business metrics
    'anomaly_investigation', // investigating unusual patterns
    'decision_support',      // supporting a business decision
    'periodic_review',       // regular review cycle
    'incident_response',     // responding to an event
    'other',
  ]),
  /** Entity this situation is about (shop, product, supplier, etc.) */
  entity: z.object({
    id: z.string(),
    type: z.string(),
    name: z.string().optional(),
    platform: z.string().optional(),
  }),
  /** Temporal scope of the situation */
  temporal: z.object({
    /** When the situation occurred/was detected */
    observedAt: IsoDateString,
    /** Optional analysis window */
    windowStart: IsoDateString.optional(),
    windowEnd: IsoDateString.optional(),
  }),
  /** Human-readable description of the business situation */
  description: z.string().min(1),
  /** Business context tags */
  tags: z.array(z.string()).default([]),
});
export type Situation = z.infer<typeof SituationSchema>;

// ---- Observation Reference ----

/** Reference to a Capability-driven observation. */
export const ObservationRefSchema = z.object({
  /** Unique observation ID */
  observationId: z.string().min(1),
  /** Capability used for this observation */
  capability: z.string().min(1),
  /** Platform + acquisition method */
  provider: z.object({
    platform: z.string(),
    acquisition: z.enum(['cdp', 'api_direct', 'csv_export', 'manual']),
  }),
  /** When the observation was made */
  observedAt: IsoDateString,
  /** What was observed — summary, not raw data */
  summary: z.string(),
  /** Reference to evidence produced by this observation */
  evidenceIds: z.array(z.string()).default([]),
  /** Reference to signals derived from this observation */
  signalIds: z.array(z.string()).default([]),
  /**
   * Metrics snapshot — derived convenience, NOT authoritative.
   * Source of truth: evidence identified by evidenceIds.
   * Included only to avoid Runtime re-fetching all evidence files.
   * Every key maps to a canonical metric name from CapabilityContract.
   */
  metricsSnapshot: z.record(z.string(), z.number()).default({}).describe(
    'Derived metric snapshot. Source of truth: evidenceIds. Not authoritative.',
  ),
});
export type ObservationRef = z.infer<typeof ObservationRefSchema>;

// ---- Agent Activity Reference ----

/** Reference to an Agent's observable activity related to this situation. */
export const AgentActivityRefSchema = z.object({
  /** Unique activity ID (maps to execution event or task ID) */
  activityId: z.string().min(1),
  /** What the agent did */
  type: z.enum([
    'capability_discovery',  // found a capability
    'data_acquisition',      // acquired data
    'analysis',              // analyzed signals
    'recommendation',        // made a recommendation
    'clarification',         // asked for clarification
  ]),
  /** The Agent Runtime that performed this activity */
  agentRuntime: z.string().default('hermes'),
  /** When the activity occurred */
  timestamp: IsoDateString,
  /** Summary of what the agent did */
  summary: z.string(),
  /** The agent's output (recommendation, analysis, etc.) */
  output: z.record(z.string(), z.unknown()).optional(),
  /** Task ID this activity belongs to (for cross-reference) */
  taskId: z.string().optional(),
  /** Capability used, if any */
  capabilityId: z.string().optional(),
});
export type AgentActivityRef = z.infer<typeof AgentActivityRefSchema>;

// ---- Human Intervention Grammar (P0007.2) ----

/**
 * The 5-type Human Intervention Grammar.
 *
 * Each type captures a distinct professional behavior:
 *   response          — reacting to Agent output or Signal
 *   correction        — fixing the system's understanding of reality
 *   context_supplement — adding information the system cannot observe
 *   decision          — choosing to act / not act / defer
 *   action_intent     — intending to change the real world
 *
 * Grammar is separate from domain content. The `content` field carries
 * type-specific payload; domain vocabulary evolves independently.
 */

/** Content payload for 'response' — what the human is responding to and what they said. */
export const ResponseContentSchema = z.object({
  /** What triggered this response */
  respondsTo: z.object({
    agentActivityIds: z.array(z.string()).default([]),
    signalIds: z.array(z.string()).default([]),
    observationIds: z.array(z.string()).default([]),
  }),
  /** The human's evaluation */
  evaluation: z.enum(['agree', 'disagree', 'partial', 'uncertain']),
  /** Free-text explanation */
  rationale: z.string().optional(),
});

/** Content payload for 'correction' — what understanding is wrong and what's correct. */
export const CorrectionContentSchema = z.object({
  /** What is being corrected */
  corrects: z.object({
    observationId: z.string().optional(),
    signalId: z.string().optional(),
    metricName: z.string().optional(),
    agentActivityId: z.string().optional(),
  }),
  /** What the correct understanding is */
  correction: z.string().min(1),
  /** Optional corrected value */
  correctedValue: z.unknown().optional(),
});

/** Content payload for 'context_supplement' — unobservable information. */
export const ContextSupplementContentSchema = z.object({
  /** What situation aspect this supplements */
  supplements: z.object({
    observationId: z.string().optional(),
    situationAspect: z.string().optional(),
  }),
  /** The information the system cannot observe */
  information: z.string().min(1),
  /** Structured detail (e.g. supplier status, upcoming event) */
  detail: z.record(z.string(), z.unknown()).default({}),
});

/** Content payload for 'decision' — a choice the human is making. */
export const DecisionContentSchema = z.object({
  /** The decision type */
  decision: z.enum(['accept', 'reject', 'defer', 'override', 'no_action']),
  /** What the decision applies to */
  appliesTo: z.object({
    agentActivityId: z.string().optional(),
    recommendationId: z.string().optional(),
    signalId: z.string().optional(),
  }),
  /** Rationale for the decision */
  rationale: z.string().optional(),
  /** Deferral target (if decision = 'defer') */
  deferUntil: IsoDateString.optional(),
});

/** Content payload for 'action_intent' — human intends to change the real world. */
export const ActionIntentContentSchema = z.object({
  /** What the human intends to do */
  description: z.string().min(1),
  /** What this action targets */
  target: z.string().optional(),
  /** Expected effect */
  expectedEffect: z.string().optional(),
  /** This is a hypothesis — validated by P0007.3+ observation */
  _hypothesis: z.literal(true).default(true),
});

/** Discriminated content union — type determines payload shape. */
export const InterventionContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('response'), ...ResponseContentSchema.shape }),
  z.object({ type: z.literal('correction'), ...CorrectionContentSchema.shape }),
  z.object({ type: z.literal('context_supplement'), ...ContextSupplementContentSchema.shape }),
  z.object({ type: z.literal('decision'), ...DecisionContentSchema.shape }),
  z.object({ type: z.literal('action_intent'), ...ActionIntentContentSchema.shape }),
]);
export type InterventionContent = z.infer<typeof InterventionContentSchema>;

/**
 * A Human Intervention is any professional input into the situation.
 * It may or may not lead to an Action.
 *
 * P0007.2: Defines the 5-type Grammar. Type determines content payload.
 * Grammar is stable; domain content (values inside `content`) can evolve.
 */
export const HumanInterventionSchema = z.object({
  /** Unique intervention ID */
  interventionId: z.string().min(1),
  /** The situation this intervention belongs to */
  situationId: z.string().min(1),
  /** Who intervened */
  actor: z.object({
    id: z.string(),
    role: z.string(),
  }),
  /** Grammar type + type-specific content.
   *  P0010.1 Final Repair — Area C.1: `action_intent` is removed. ADR-047
   *  declared the canonical operator surface to be the 4 high-level kinds
   *  (response / correction / context_supplement / decision), with `decision`
   *  sub-typed by `content.decision` ∈ accept | reject | defer | override |
   *  no_action. The DB CHECK constraint enforces the same set. */
  type: z.enum(['response', 'correction', 'context_supplement', 'decision']),
  content: z.record(z.string(), z.unknown()).default({}),
  /** When the intervention occurred */
  timestamp: IsoDateString,
  /** Human-readable summary */
  summary: z.string().min(1),
  /** Reference to the review/feedback that captured this intervention */
  reviewId: z.string().optional(),
  /** If this intervention led to an action */
  actionId: z.string().optional(),
  /** Which agent activities this intervention responds to (if any) */
  respondsToActivityIds: z.array(z.string()).default([]),
  /** Provenance: was this created by a legacy adapter? */
  _legacySource: z.enum(['legacy_review', 'legacy_feedback', 'none']).default('none'),
});
export type HumanIntervention = z.infer<typeof HumanInterventionSchema>;

// ---- Action Reference ----

/**
 * An Action is something that changed the real world.
 *
 * P0007.2 will extend this with the full Action Grammar.
 * P0007.1 only defines the minimal reference.
 */
export const ActionRefSchema = z.object({
  /** Unique action ID */
  actionId: z.string().min(1),
  /** What kind of action */
  type: z.string().min(1),   // domain-specific: "price_change", "inventory_restock"...
  /** Who/what performed the action */
  actor: z.object({
    type: z.enum(['human', 'system', 'agent']),
    id: z.string().optional(),
  }),
  /** When the action was taken */
  timestamp: IsoDateString,
  /** Human-readable description */
  description: z.string().min(1),
  /** Structured detail of what changed */
  detail: z.record(z.string(), z.unknown()).default({}),
  /** The intervention that triggered this action */
  interventionId: z.string().optional(),
  /** Capability that executed this action, if system-executed */
  executionCapability: z.string().optional(),
});
export type ActionRef = z.infer<typeof ActionRefSchema>;

// ---- Outcome Reference ----

/**
 * An Outcome is what happened after an Action — observed via re-acquisition
 * of the real world through existing Capabilities.
 *
 * P0007.1 defines only the reference placeholder (actionId, evidenceIds).
 * P0007.4 will add: observationWindow, baseline snapshot, postValue snapshot,
 * and the full Outcome Observation model.
 */
export const OutcomeRefSchema = z.object({
  /** Unique outcome ID */
  outcomeId: z.string().min(1),
  /**
   * Actions that preceded this outcome observation.
   * Plural + "related" — NOT singular + "causedBy".
   * agentFabric records temporal association, not causation.
   * Example: three actions (换主图, 降价, 增加投放) all precede CTR+8%.
   * The Contract records that all three are related; Runtime infers causality.
   */
  relatedActionIds: z.array(z.string()).default([]),
  /** When the outcome was observed */
  observedAt: IsoDateString,
  /** Evidence produced by outcome observation (source of truth) */
  evidenceIds: z.array(z.string()).default([]),
  /** Human-readable summary */
  summary: z.string().optional(),
  /** The capability used to re-observe */
  observationCapability: z.string().optional(),
});
export type OutcomeRef = z.infer<typeof OutcomeRefSchema>;

// ---- Learning Context — top-level ----

/**
 * A Learning Context is the complete, verifiable record of one real-world
 * business situation. It is the interface between agentFabric (which
 * observes and records the world) and any Agent Runtime (which learns
 * from these records).
 *
 * Fields are INCREMENTAL — a Context can start with just a Situation
 * and observations, then accumulate interventions, actions, and outcomes
 * as real-world events unfold.
 *
 * Runtime-neutral: This schema contains no Hermes-specific fields.
 * Any Agent Runtime can consume a Learning Context.
 */
export const LearningContextSchema = z.object({
  /** Unique context identifier */
  contextId: z.string().min(1),
  /** The business situation this context is about */
  situation: SituationSchema,
  /** Lifecycle — how much real-world data has been accumulated */
  lifecycle: ContextLifecycleSchema.default('open'),
  /** When this context was first created */
  createdAt: IsoDateString,
  /** When this context was last updated */
  updatedAt: IsoDateString,

  /** What was observed about the real world */
  observations: z.array(ObservationRefSchema).default([]),
  /** What evidence was produced */
  evidenceIds: z.array(z.string()).default([]),
  /** What signals were derived */
  signalIds: z.array(z.string()).default([]),

  /** What the agent did */
  agentActivities: z.array(AgentActivityRefSchema).default([]),

  /** How humans intervened */
  humanInterventions: z.array(HumanInterventionSchema).default([]),

  /** What real-world actions were taken */
  actions: z.array(ActionRefSchema).default([]),

  /**
   * P0010.1 Post-Productization REPAIR — Operator-visible deliverables
   * produced by the Agent. Each WorkItem is something the human is expected
   * to look at (e.g. a Recommendation persisted as an Output). Additive —
   * the field is optional on the wire and defaults to `[]`; producers do
   * not need to populate it (a Situation without Outputs is valid).
   *
   * No transport, no delivery engine, no approval flow. Status transitions
   * are: ready → delivered → acknowledged → closed (set by operator).
   */
  outputs: z.array(WorkItemSchema).default([]),

  /** What outcomes were observed */
  outcomes: z.array(OutcomeRefSchema).default([]),

  /**
   * P0010 Knowledge-Guided Investigation state (optional, additive).
   * The business-level artifacts of an investigation (Known / Hypotheses /
   * Unknowns / Next Question / Findings / Judgment). NOT Chain-of-Thought.
   */
  investigation: InvestigationSchema.optional(),

  /**
   * Context summary — aggregated metadata for quick inspection.
   * NOT provenance. Provenance is the ID reference chains woven through
   * observations, evidence, interventions, actions, and outcomes.
   * P0007.5 will define the full Provenance model.
   */
  summary: z.object({
    /** Capabilities used across all observations */
    capabilitiesUsed: z.array(z.string()).default([]),
    /** Agent runtimes involved */
    agentRuntimes: z.array(z.string()).default([]),
    /** Human actors involved */
    humanActors: z.array(z.string()).default([]),
    /** Total evidence artifacts referenced */
    totalEvidence: z.number().int().nonnegative().default(0),
    /** Total signals referenced */
    totalSignals: z.number().int().nonnegative().default(0),
  }).default({}),
});
export type LearningContext = z.infer<typeof LearningContextSchema>;

// ---- Partial Context Validation ----

/**
 * Check if a Learning Context has enough data for Runtime learning.
 * "Enough" means: at minimum, observations + agent activity exist.
 * Intervention, Action, and Outcome are optional enrichments.
 */
export const isLearnable = (ctx: LearningContext): boolean => {
  return ctx.observations.length > 0 && ctx.agentActivities.length > 0;
};

/**
 * Determine lifecycle from context contents.
 * - open:   only situation + observations (no human input yet)
 * - partial: has interventions and/or actions (human involved)
 * - mature:  has outcomes (real-world results observed)
 */
export const determineLifecycle = (ctx: LearningContext): ContextLifecycle => {
  if (ctx.outcomes && ctx.outcomes.length > 0) return 'mature';
  if ((ctx.humanInterventions && ctx.humanInterventions.length > 0) ||
      (ctx.actions && ctx.actions.length > 0)) return 'partial';
  return 'open';
};
