// P0013 Phase 3 — InvestigationSchema additive extension.

import { describe, it, expect } from 'vitest';
import { InvestigationSchema } from '#shared/schemas/investigation.js';

const baseInvestigation = {
  situationId: 'sit-test',
  currentUnderstanding: 'test',
  judgment: 'test',
};

describe('InvestigationSchema — pre-P0013 records still parse', () => {
  it('accepts a minimal pre-P0013 record', () => {
    const r = InvestigationSchema.safeParse({
      situationId: 'sit-1',
      currentUnderstanding: 'x',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a full pre-P0013 record with all 11 original fields', () => {
    const r = InvestigationSchema.safeParse({
      situationId: 'sit-1',
      currentUnderstanding: 'x',
      knownEvidence: ['e1'],
      hypotheses: [],
      unknowns: ['u1'],
      nextQuestion: 'q',
      requiredEvidence: ['r1'],
      investigationRequest: 'capability=trade.overview',
      findings: [],
      judgment: 'j',
      stopReason: 'observe',
      evidenceAcquired: ['ea1'],
    });
    expect(r.success).toBe(true);
  });
});

describe('InvestigationSchema — P0013 §9 daily analysis fields', () => {
  it('accepts all 8 new fields populated', () => {
    const r = InvestigationSchema.safeParse({
      ...baseInvestigation,
      business_date: '2026-08-12',
      observed_facts: ['GMV = 6062.55', 'orders = 122'],
      evidence_gaps: ['per-day traffic source'],
      temporal_boundary_checked_at: '2026-09-03T10:00:00Z',
      supporting_evidence_refs: ['42', '43'],
      recommendation_executed: false,
      month_anchor: '2026-08',
      replay_run_id: 'run-001',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a malformed business_date', () => {
    const r = InvestigationSchema.safeParse({
      ...baseInvestigation,
      business_date: '2026-8-12',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed month_anchor (must be YYYY-MM)', () => {
    const r = InvestigationSchema.safeParse({
      ...baseInvestigation,
      month_anchor: '2026/08',
    });
    expect(r.success).toBe(false);
  });

  it('defaults recommendation_executed to false when omitted (the §14 boundary guard)', () => {
    const r = InvestigationSchema.safeParse({
      ...baseInvestigation,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      const v = (r.data as Record<string, unknown>)['recommendation_executed'];
      expect(v).toBe(false);
    }
  });

  it('accepts recommendation_executed: true (for future Action system, NOT Replay v1)', () => {
    const r = InvestigationSchema.safeParse({
      ...baseInvestigation,
      recommendation_executed: true,
    });
    expect(r.success).toBe(true);
  });

  it('replay_run_id is optional — production rows do not have one', () => {
    const r = InvestigationSchema.safeParse({ ...baseInvestigation });
    expect(r.success).toBe(true);
  });

  it('observed_facts defaults to [] when omitted', () => {
    const r = InvestigationSchema.safeParse({ ...baseInvestigation });
    expect(r.success).toBe(true);
    if (r.success) {
      const v = (r.data as Record<string, unknown>)['observed_facts'];
      expect(v).toEqual([]);
    }
  });

  it('evidence_gaps defaults to [] when omitted', () => {
    const r = InvestigationSchema.safeParse({ ...baseInvestigation });
    expect(r.success).toBe(true);
    if (r.success) {
      const v = (r.data as Record<string, unknown>)['evidence_gaps'];
      expect(v).toEqual([]);
    }
  });

  it('supporting_evidence_refs defaults to [] when omitted', () => {
    const r = InvestigationSchema.safeParse({ ...baseInvestigation });
    expect(r.success).toBe(true);
    if (r.success) {
      const v = (r.data as Record<string, unknown>)['supporting_evidence_refs'];
      expect(v).toEqual([]);
    }
  });
});
