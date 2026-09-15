// Epistemic Integrity — Cognition Evidence Discipline (2026-09-06).
//
// P0013 2026-08-14 真实 Replay 暴露: Fabric 提供的事实可以是正确的,但
// Agent 会把 Observation / Pattern / Hypothesis / Causal Explanation /
// Confirmed Conclusion 混成一个层级。当前 contract 只有
// `hypotheses[].status: proposed|supported|weakened|rejected`,没有
// Fact/Pattern/Confirmed 的 epistemic 区分。
//
// 本文件定义 **epistemic layering contract** — 公共 cognitive contract,
// Production + Replay 共用,不存在 Replay-only workaround。
//
// 五层(epistemic layer):
//   L1 Observed Fact   — 直接由当前可见 Evidence 支持
//   L2 Pattern         — 多个 Observed Fact 归纳出的数据形态
//                        (Pattern Candidate != Established Pattern)
//   L3 Hypothesis      — 对原因/机制/未来观察意义的解释
//                        (必须有 supporting_evidence + missing_evidence + falsifier)
//   L4 Confirmed       — 由明确 Evidence 支持的结论
//                        (必须有 confirmed_evidence_refs[] 非空)
//   L5 Judgment        — 建立在以上层级之上
//                        (必须显式列 known / inferred / unknown / decision / confidence_basis)
//
// 设计原则:
//   1. 全部字段是 OPTIONAL,加在 InvestigationSchema 上不破坏老 record
//   2. Production + Replay 共用同一 schema,新字段默认 []
//   3. parseInvestigation 不会 silent-rewrite "confirmed" → "supported"
//      (老的 normalize 行为;现在要求 explicit confirmed_evidence_refs)
//   4. Pattern 与 Hypothesis 不能混在同一字段:Pattern 是形态,
//      Hypothesis 是机制;Pattern Candidate 需要 explicit pattern_type
//   5. Thresholds 必须有 provenance:heuristic / evidence_derived /
//      knowledge_rule / operator_rule / business_policy;没有 provenance
//      不允许被 Agent 写成 confirmation rule

import { z } from 'zod';

/** L1 — Observed Fact. A claim directly supported by current visible Evidence. */
export const ObservedFactSchema = z.object({
  /** The fact statement (one short sentence, Simplified Chinese). */
  statement: z.string().min(1),
  /** evidence_observations ids that back the fact. Empty = ERROR at parse time. */
  evidence_refs: z.array(z.string()).min(1, 'Observed Fact must have ≥1 evidence_ref'),
});
export type ObservedFact = z.infer<typeof ObservedFactSchema>;

/** L2 — Pattern. Inductive inference from multiple Observed Facts. */
export const PatternTypeSchema = z.enum(['candidate', 'established']);
export type PatternType = z.infer<typeof PatternTypeSchema>;

export const PatternSchema = z.object({
  /** The pattern statement (one short sentence, Simplified Chinese). */
  statement: z.string().min(1),
  /**
   * Pattern Type — distinguishes a Pattern Candidate (observed in a few
   * datapoints, not yet stable) from an Established Pattern (multiple
   * windows, statistical basis, or operator-confirmed).
   *
   * Default = 'candidate'. The Agent MUST explicitly upgrade to
   * 'established' with `based_on` referencing ≥ 3 distinct observations
   * across ≥ 2 distinct business windows.
   */
  pattern_type: PatternTypeSchema.default('candidate'),
  /** Indexes/references into observed[] that back the pattern. */
  based_on: z.array(z.string()).default([]),
});
export type Pattern = z.infer<typeof PatternSchema>;

/** L3 — Hypothesis. Explanation for a pattern, with explicit falsifier. */
export const HypothesisEpistemicSchema = z.object({
  /** The hypothesis statement (one short sentence, Simplified Chinese). */
  statement: z.string().min(1),
  /** Status (canonical 4 — matches existing HypothesisStatusSchema). */
  status: z.enum(['proposed', 'supported', 'weakened', 'rejected']).default('proposed'),
  /** evidence_observations ids that back the hypothesis. May be empty
   *  for a fresh 'proposed' hypothesis (no evidence yet). */
  supporting_evidence_refs: z.array(z.string()).default([]),
  /** Evidence the Agent identifies as missing (would shift status). */
  missing_evidence: z.array(z.string()).default([]),
  /**
   * Falsifier — what observation, if seen, would REJECT this hypothesis.
   * Optional but recommended. Empty = "no clear falsifier yet" (honest).
   */
  falsifier: z.string().default(''),
});
export type HypothesisEpistemic = z.infer<typeof HypothesisEpistemicSchema>;

/** L4 — Confirmed. A claim with explicit confirmed evidence. */
export const ConfirmedBySchema = z.enum(['operator', 'system', 'historical_evidence']);
export type ConfirmedBy = z.infer<typeof ConfirmedBySchema>;

export const ConfirmedSchema = z.object({
  /** The confirmed statement. */
  statement: z.string().min(1),
  /** evidence_observations ids (or knowledge record id, or operator intervention id)
   *  that back the confirmation. ≥1 required. */
  confirmed_evidence_refs: z.array(z.string()).min(1, 'Confirmed must have ≥1 confirmed_evidence_ref'),
  /** Source of the confirmation. */
  confirmed_by: ConfirmedBySchema,
  /** ISO timestamp or business_date when the confirmation was recorded. */
  confirmed_at: z.string().default(''),
});
export type Confirmed = z.infer<typeof ConfirmedSchema>;

/** L5 — Judgment basis. */
export const JudgmentBasisSchema = z.object({
  /** What the Agent considers KNOWN (backed by Evidence). */
  known: z.array(z.string()).default([]),
  /** What the Agent considers INFERRED (Hypothesis or Pattern, NOT Fact). */
  inferred: z.array(z.string()).default([]),
  /** What the Agent considers UNKNOWN (Evidence Gap). */
  unknown: z.array(z.string()).default([]),
  /** The decision statement (what the Agent recommends, in operator-friendly Chinese). */
  decision: z.string().default(''),
  /** Why the confidence level (or "no confidence" if the Evidence is thin). */
  confidence_basis: z.string().default(''),
});
export type JudgmentBasis = z.infer<typeof JudgmentBasisSchema>;

/** Combined L1-L5 contract. */
export const EpistemicLayersSchema = z.object({
  observed: z.array(ObservedFactSchema).default([]),
  patterns: z.array(PatternSchema).default([]),
  hypotheses: z.array(HypothesisEpistemicSchema).default([]),
  confirmed: z.array(ConfirmedSchema).default([]),
  judgment_basis: JudgmentBasisSchema.default({}),
});
export type EpistemicLayers = z.infer<typeof EpistemicLayersSchema>;

/** Per-claim evidence provenance (Phase C). */
export const ClaimTypeSchema = z.enum([
  'numeric',        // 数值事实
  'temporal',       // 时间事实
  'campaign',       // 活动/促销事实
  'operation',      // 运营动作
  'consecutive',    // 连续 N 天
  'alternation',    // 交替
  'stable',         // 稳定
  'baseline',       // 基线
  'recovery',       // 恢复
  'anomaly',        // 异常
  'confirmation',   // 确认
  'reversal',       // 推翻
  'causal',         // 因果解释
  'pattern',        // 形态描述
  'hypothesis',     // 假说
  'other',
]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const ClaimEvidenceRefSchema = z.object({
  /** The claim text. */
  claim: z.string().min(1),
  /** evidence_observations ids that back the claim. Empty = Evidence Gap. */
  evidence_refs: z.array(z.string()).default([]),
  /** Evidence the Agent identifies as missing. */
  missing_evidence: z.array(z.string()).default([]),
  claim_type: ClaimTypeSchema.default('other'),
});
export type ClaimEvidenceRef = z.infer<typeof ClaimEvidenceRefSchema>;

/** Threshold provenance (Phase E). */
export const ThresholdProvenanceSchema = z.enum([
  'heuristic',            // 无 evidence basis,only intuitive
  'evidence_derived',     // 由具体 evidence 统计得出
  'knowledge_rule',       // 由 knowledge/ 规则得出
  'operator_rule',        // 由 operator 显式给出
  'business_policy',      // 由业务策略规定
]);
export type ThresholdProvenance = z.infer<typeof ThresholdProvenanceSchema>;

export const ThresholdSchema = z.object({
  /** The threshold statement (e.g. "GMV > 12000"). */
  statement: z.string().min(1),
  /** Provenance — required. heuristic 不允许被写成 "confirmation rule". */
  provenance: ThresholdProvenanceSchema,
  /** Refs to source: evidence ids, knowledge record id, operator intervention id, etc. */
  basis_refs: z.array(z.string()).default([]),
});
export type Threshold = z.infer<typeof ThresholdSchema>;

/** Prior cognition (Phase F — Replay). */
export const PriorCognitionKindSchema = z.enum(['prior_hypothesis', 'prior_judgment', 'prior_recommendation']);
export type PriorCognitionKind = z.infer<typeof PriorCognitionKindSchema>;

export const PriorCognitionSchema = z.object({
  /** T-1 business_date. */
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: PriorCognitionKindSchema,
  /** Content (the prior statement). */
  content: z.string().min(1),
  /** Status at T-1 (canonical 4). */
  status_at_t_minus_1: z.enum(['proposed', 'supported', 'weakened', 'rejected', 'unknown']).default('unknown'),
  /**
   * Status AT TIME T — the Agent's current view. Critical invariant:
   * T-1's status MUST NOT auto-upgrade to T's "current fact". A
   * 'proposed' hypothesis at T-1 is still 'proposed' (or weakened /
   * rejected) at T, until NEW Evidence shifts it.
   */
  status_at_t: z.enum(['proposed', 'supported', 'weakened', 'rejected', 'unknown']).default('unknown'),
  /** Evidence at T that shifted the status (if any). Empty = no new evidence. */
  new_evidence_refs: z.array(z.string()).default([]),
});
export type PriorCognition = z.infer<typeof PriorCognitionSchema>;

/** Epistemic status enum (per claim). */
export const EpistemicStatusSchema = z.enum([
  'observed_fact',     // L1
  'observed_pattern',  // L2
  'hypothesis',        // L3
  'confirmed',         // L4
  'judgment',          // L5
]);
export type EpistemicStatus = z.infer<typeof EpistemicStatusSchema>;

/** Word allow-list for natural-language "confident" / "confirmed" checks.
 *  Used by parseInvestigation to detect unsourced confirmation language
 *  in `currentUnderstanding` / `judgment` / `recommendation` text.
 *  The list is CLOSED — adding a word requires an explicit ADR. */
export const CONFIDENT_LANGUAGE_ALLOWLIST: ReadonlySet<string> = Object.freeze(
  new Set([
    '确认', '已确认', '确认无疑', '明确', '明确确认', '证实', '已证实',
    'confirmed', 'verified', 'definitely', 'certainly', 'definitively',
  ]),
);

/** Heuristic / threshold language (Phase E). Detected for warning only,
 *  not for fail-closed rewriting. */
export const HEURISTIC_LANGUAGE_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /若\s*[\w.]+\s*[><=]+\s*\d/,           // 若 GMV > 12000
  /如果\s*.+[><=]/,                       // 如果 X > N
  /when\s+[\w.]+\s*[><=]/i,              // when X > N
  /if\s+[\w.]+\s*[><=]/i,                // if X > N
  /确认\s*(?:阈值|条件|规则|rule)/,        // 确认阈值/条件
]);
