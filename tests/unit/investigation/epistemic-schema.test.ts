// Epistemic Integrity (2026-09-06) — schema tests for the new L1-L5
// epistemic layering contract, claim_evidence_refs, thresholds, and
// prior_cognition. All fields are OPTIONAL/ADDITIVE — pre-epistemic
// InvestigationSchema rows must still parse byte-for-byte.

import { describe, it, expect } from 'vitest';
import { InvestigationSchema } from '#shared/schemas/investigation.js';
import {
  EpistemicLayersSchema,
  ObservedFactSchema,
  PatternSchema,
  HypothesisEpistemicSchema,
  ConfirmedSchema,
  JudgmentBasisSchema,
  ClaimEvidenceRefSchema,
  ThresholdSchema,
  PriorCognitionSchema,
  CONFIDENT_LANGUAGE_ALLOWLIST,
} from '#shared/schemas/epistemic.js';

describe('epistemic / ObservedFactSchema (L1)', () => {
  it('accepts a fact with >=1 evidence_refs', () => {
    const r = ObservedFactSchema.safeParse({
      statement: '08-14 GMV = 5286.47',
      evidence_refs: ['ev_001'],
    });
    expect(r.success).toBe(true);
  });

  it('REJECTS a fact with empty evidence_refs (L1 requires evidence)', () => {
    const r = ObservedFactSchema.safeParse({
      statement: 'some claim without refs',
      evidence_refs: [],
    });
    expect(r.success).toBe(false);
  });
});

describe('epistemic / PatternSchema (L2)', () => {
  it('defaults pattern_type to candidate', () => {
    const r = PatternSchema.parse({
      statement: 'recent volatility',
      based_on: ['obs_1'],
    });
    expect(r.pattern_type).toBe('candidate');
  });

  it('accepts explicit pattern_type=established', () => {
    const r = PatternSchema.parse({
      statement: 'weekend rhythm: 4 consecutive Fridays GMV up',
      pattern_type: 'established',
      based_on: ['obs_1', 'obs_2', 'obs_3'],
    });
    expect(r.pattern_type).toBe('established');
  });
});

describe('epistemic / HypothesisEpistemicSchema (L3)', () => {
  it('defaults status to proposed and allows empty supporting_evidence_refs', () => {
    const r = HypothesisEpistemicSchema.parse({
      statement: 'order pre-release hypothesis',
    });
    expect(r.status).toBe('proposed');
    expect(r.supporting_evidence_refs).toEqual([]);
    expect(r.missing_evidence).toEqual([]);
  });

  it('rejects unknown status (only canonical 4)', () => {
    const r = HypothesisEpistemicSchema.safeParse({
      statement: 'x',
      status: 'confirmed',
    });
    expect(r.success).toBe(false);
  });
});

describe('epistemic / ConfirmedSchema (L4)', () => {
  it('REQUIRES >=1 confirmed_evidence_refs (L4 cannot exist without refs)', () => {
    const r = ConfirmedSchema.safeParse({
      statement: 'operator changed listing copy',
      confirmed_evidence_refs: [],
      confirmed_by: 'operator',
    });
    expect(r.success).toBe(false);
  });

  it('accepts a Confirmed with operator intervention id', () => {
    const r = ConfirmedSchema.parse({
      statement: 'operator changed listing copy',
      confirmed_evidence_refs: ['op_intv_42'],
      confirmed_by: 'operator',
      confirmed_at: '2026-08-14T15:30:00Z',
    });
    expect(r.confirmed_by).toBe('operator');
  });

  it('rejects unknown confirmed_by enum', () => {
    const r = ConfirmedSchema.safeParse({
      statement: 'x',
      confirmed_evidence_refs: ['x'],
      confirmed_by: 'ai_synthesis',
    });
    expect(r.success).toBe(false);
  });
});

describe('epistemic / JudgmentBasisSchema (L5)', () => {
  it('all fields default to safe empties', () => {
    const r = JudgmentBasisSchema.parse({});
    expect(r.known).toEqual([]);
    expect(r.inferred).toEqual([]);
    expect(r.unknown).toEqual([]);
    expect(r.decision).toBe('');
    expect(r.confidence_basis).toBe('');
  });
});

describe('epistemic / ClaimEvidenceRefSchema (Phase C)', () => {
  it('accepts a strong claim with empty evidence_refs (Evidence Gap, NOT free pass)', () => {
    const r = ClaimEvidenceRefSchema.parse({
      claim: '08-14 down 49% vs 08-13',
      claim_type: 'temporal',
    });
    expect(r.evidence_refs).toEqual([]);
  });

  it('rejects unknown claim_type', () => {
    const r = ClaimEvidenceRefSchema.safeParse({
      claim: 'x',
      claim_type: 'foobar',
    });
    expect(r.success).toBe(false);
  });
});

describe('epistemic / ThresholdSchema (Phase E)', () => {
  it('REQUIRES provenance (no free-floating thresholds)', () => {
    const r = ThresholdSchema.safeParse({
      statement: 'GMV > 12000',
    });
    expect(r.success).toBe(false);
  });

  it('accepts heuristic threshold (honest, but cannot be called confirmation rule)', () => {
    const r = ThresholdSchema.parse({
      statement: 'GMV > 12000',
      provenance: 'heuristic',
    });
    expect(r.provenance).toBe('heuristic');
  });

  it('rejects unknown provenance', () => {
    const r = ThresholdSchema.safeParse({
      statement: 'x',
      provenance: 'oracle',
    });
    expect(r.success).toBe(false);
  });
});

describe('epistemic / PriorCognitionSchema (Phase F)', () => {
  it('accepts a T-1 prior_hypothesis with status_at_t unset (LLM fills at T)', () => {
    const r = PriorCognitionSchema.parse({
      business_date: '2026-08-13',
      kind: 'prior_hypothesis',
      content: 'T-1 10000+ new normal',
    });
    expect(r.status_at_t_minus_1).toBe('unknown');
    expect(r.status_at_t).toBe('unknown');
  });

  it('rejects non-date business_date', () => {
    const r = PriorCognitionSchema.safeParse({
      business_date: '2026/08/13',
      kind: 'prior_hypothesis',
      content: 'x',
    });
    expect(r.success).toBe(false);
  });
});

describe('epistemic / EpistemicLayersSchema (L1-L5 combined)', () => {
  it('all sections default to safe empties', () => {
    const r = EpistemicLayersSchema.parse({});
    expect(r.observed).toEqual([]);
    expect(r.patterns).toEqual([]);
    expect(r.hypotheses).toEqual([]);
    expect(r.confirmed).toEqual([]);
    expect(r.judgment_basis).toEqual({
      known: [],
      inferred: [],
      unknown: [],
      decision: '',
      confidence_basis: '',
    });
  });
});

describe('epistemic / InvestigationSchema — ADDITIVE integration', () => {
  it('a pre-epistemic Investigation still parses (no new fields)', () => {
    const r = InvestigationSchema.safeParse({
      situationId: 'sit_001',
      currentUnderstanding: '08-14 GMV down',
      knownEvidence: ['ev_001'],
      hypotheses: [{ statement: 'X', status: 'proposed' }],
      unknowns: ['u1'],
      judgment: 'j',
      stopReason: 'observe',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.epistemic_layers).toBeUndefined();
      expect(r.data.claim_evidence_refs).toEqual([]);
      expect(r.data.thresholds).toEqual([]);
      expect(r.data.prior_cognition).toEqual([]);
    }
  });

  it('a fully-epistemic Investigation parses with all 4 new fields', () => {
    const r = InvestigationSchema.safeParse({
      situationId: 'sit_002',
      currentUnderstanding: '08-14 出现明显回落',
      knownEvidence: ['ev_001'],
      hypotheses: [{ statement: 'X', status: 'proposed' }],
      unknowns: ['u1'],
      judgment: 'j',
      stopReason: 'observe',
      epistemic_layers: {
        observed: [{ statement: '08-14 GMV = 5286.47', evidence_refs: ['ev_001'] }],
        patterns: [{ statement: '放量回调交替', pattern_type: 'candidate', based_on: ['obs_1'] }],
        hypotheses: [
          {
            statement: '可能存在订单前置',
            status: 'proposed',
            supporting_evidence_refs: [],
            missing_evidence: ['本店 8-15 活动配置'],
            falsifier: '若 8-15 与 8-14 类似, 假设被削弱',
          },
        ],
        confirmed: [],
        judgment_basis: {
          known: ['08-14 GMV 5286.47'],
          inferred: ['可能存在订单前置'],
          unknown: ['本店 8-15 活动配置'],
          decision: '保持观察',
          confidence_basis: 'Evidence 不足, 不做判断',
        },
      },
      claim_evidence_refs: [
        {
          claim: '08-14 较 08-13 下降 49.0%',
          evidence_refs: ['ev_001', 'ev_002'],
          claim_type: 'temporal',
        },
      ],
      thresholds: [{ statement: 'GMV > 12000', provenance: 'heuristic' }],
      prior_cognition: [
        {
          business_date: '2026-08-13',
          kind: 'prior_hypothesis',
          content: '10000+ new normal at T-1',
          status_at_t_minus_1: 'proposed',
          status_at_t: 'weakened',
          new_evidence_refs: ['ev_001'],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects Confirmed with empty confirmed_evidence_refs at the Investigation level', () => {
    const r = InvestigationSchema.safeParse({
      situationId: 'sit_003',
      currentUnderstanding: '...',
      knownEvidence: [],
      hypotheses: [],
      unknowns: [],
      judgment: '...',
      stopReason: 'observe',
      epistemic_layers: {
        observed: [],
        patterns: [],
        hypotheses: [],
        confirmed: [
          { statement: 'confirmed with no refs', confirmed_evidence_refs: [], confirmed_by: 'operator' },
        ],
        judgment_basis: {},
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('epistemic / CONFIDENT_LANGUAGE_ALLOWLIST', () => {
  it('contains the high-stakes confirmation words (zh-CN + en)', () => {
    expect(CONFIDENT_LANGUAGE_ALLOWLIST.has('确认')).toBe(true);
    expect(CONFIDENT_LANGUAGE_ALLOWLIST.has('已确认')).toBe(true);
    expect(CONFIDENT_LANGUAGE_ALLOWLIST.has('confirmed')).toBe(true);
    expect(CONFIDENT_LANGUAGE_ALLOWLIST.has('definitely')).toBe(true);
  });

  it('is a ReadonlySet (immutable)', () => {
    expect(typeof CONFIDENT_LANGUAGE_ALLOWLIST.size).toBe('number');
  });
});
