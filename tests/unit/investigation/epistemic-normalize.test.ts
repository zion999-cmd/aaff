// Epistemic Integrity (2026-09-06) — normalize / soft-drift tests.
//
// Two contracts being locked down here:
//   (1) The REMOVAL of the silent "confirmed" → "supported" rewrite at the
//       raw → canonical vocabulary boundary. The Agent MUST use the new
//       `epistemic_layers.confirmed[]` field with `confirmed_evidence_refs[]`
//       for L4 Confirmed claims. The L3 status enum remains canonical
//       {proposed, supported, weakened, rejected}. A `confirmed` value
//       surfacing today is unmappable drift (not silently re-mapped).
//
//   (2) `validateEpistemicContract` is a SOFT validator. It scans prose
//       fields (currentUnderstanding / judgment / recommendation.*) for
//       allow-listed confirmation language and emits EpistemicDriftRecord[].
//       It does NOT fail-closed (the L3→L4 structural upgrade is already
//       prevented by Zod). The records are surfaced so the operator can
//       see "Agent used 确认 3 times but did not populate the confirmed[] list".

import { describe, it, expect } from 'vitest';
import {
  normalizeHypothesisStatus,
  normalizeInvestigationContract,
  validateEpistemicContract,
} from '#app/runtime/investigation/normalize.js';
import { parseInvestigation } from '#app/runtime/investigation/parse.js';

describe('epistemic / normalizeHypothesisStatus — "confirmed" is no longer silently remapped', () => {
  it('"confirmed" is now UNMAPPABLE (was silently rewritten to "supported" before Epistemic Integrity)', () => {
    const r = normalizeHypothesisStatus('confirmed');
    expect(r.ok).toBe(false);
  });

  it('"Confirmed" (camel variation) is also unmappable', () => {
    const r = normalizeHypothesisStatus('Confirmed');
    expect(r.ok).toBe(false);
  });

  it('canonical statuses pass through unchanged', () => {
    expect(normalizeHypothesisStatus('proposed').ok).toBe(true);
    expect(normalizeHypothesisStatus('supported').ok).toBe(true);
    expect(normalizeHypothesisStatus('weakened').ok).toBe(true);
    expect(normalizeHypothesisStatus('rejected').ok).toBe(true);
  });

  it('"strongly_supported" still maps to "supported" (pure L3 synonym, no L3→L4 upgrade)', () => {
    const r = normalizeHypothesisStatus('strongly_supported');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('supported');
  });

  it('"partially_rejected" still maps to "weakened" (pure L3 synonym)', () => {
    const r = normalizeHypothesisStatus('partially_rejected');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('weakened');
  });
});

describe('epistemic / normalizeInvestigationContract — propagates unmappable status', () => {
  it('a hypotheses[].status="confirmed" yields driftUnmappable, normalized=null', () => {
    const raw = {
      situationId: 'sit_X',
      currentUnderstanding: '...',
      knownEvidence: [],
      hypotheses: [{ statement: 'X', status: 'confirmed' }],
      unknowns: [],
      judgment: '...',
      stopReason: 'observe',
    };
    const out = normalizeInvestigationContract(raw);
    expect(out.normalized).toBeNull();
    expect(out.driftUnmappable.some((d) => d.field === 'hypotheses[0].status' && d.original === 'confirmed')).toBe(true);
  });
});

describe('epistemic / validateEpistemicContract — soft drift detector', () => {
  it('returns [] when no confirmation language is present', () => {
    const r = validateEpistemicContract({
      currentUnderstanding: '08-14 GMV 出现回落',
      judgment: '保持观察',
      recommendation: { recommendation: '继续观察', rationale: 'Evidence 不足', expectedOutcome: '...' },
    });
    expect(r).toEqual([]);
  });

  it('records 确认 occurrences in currentUnderstanding when no confirmed[] is present', () => {
    const r = validateEpistemicContract({
      currentUnderstanding: '已确认 8-14 GMV 出现明显回调',
      judgment: '...',
    });
    expect(r.length).toBeGreaterThan(0);
    const hit = r.find((x) => x.field === 'currentUnderstanding' && x.word === '已确认');
    expect(hit).toBeDefined();
    expect(hit?.hasConfirmedEntry).toBe(false);
    expect(hit?.count).toBeGreaterThanOrEqual(1);
  });

  it('records English confirmation in judgment', () => {
    const r = validateEpistemicContract({
      currentUnderstanding: '...',
      judgment: 'definitely confirmed the operator change',
    });
    const hit = r.find((x) => x.field === 'judgment' && x.word === 'confirmed');
    expect(hit).toBeDefined();
  });

  it('does NOT record when confirmed[] is populated (Agent earns the word)', () => {
    const r = validateEpistemicContract({
      currentUnderstanding: '已确认 operator 调整了 listing copy',
      judgment: '...',
      epistemic_layers: {
        observed: [],
        patterns: [],
        hypotheses: [],
        confirmed: [
          {
            statement: 'operator 调整了 listing copy',
            confirmed_evidence_refs: ['op_intv_42'],
            confirmed_by: 'operator',
          },
        ],
        judgment_basis: {},
      },
    });
    // Word still appears, but the hasConfirmedEntry flag means "the
    // contract owns the word" — we still emit the record (audit
    // transparency) but the operator sees hasConfirmedEntry: true.
    const hit = r.find((x) => x.word === '已确认');
    expect(hit?.hasConfirmedEntry).toBe(true);
  });
});

describe('epistemic / parseInvestigation — contract returns epistemicDrift', () => {
  it('returns epistemicDrift[] when the Agent used 确认 without confirmed[]', () => {
    const reply = JSON.stringify({
      situationId: 'sit_001',
      currentUnderstanding: '已确认 8-14 出现放量',
      knownEvidence: ['ev_001'],
      observed_facts: ['fact'],
      supporting_evidence_refs: ['ev_001'],
      evidence_gaps: [],
      business_structure_coverage: (['product', 'orders', 'traffic', 'conversion', 'operations'] as const).map(
        (dimension) => ({ dimension, status: 'covered', note: `examined ${dimension}`, evidence_refs: ['ev_001'] }),
      ),
      hypotheses: [{ statement: 'X', status: 'proposed' }],
      unknowns: [],
      judgment: '五维结构已检查，为正常波动，无结构变化，不干预',
      stopReason: 'observe',
    });
    const r = parseInvestigation(reply, 'sit_001');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.epistemicDrift).toBeDefined();
      expect(r.epistemicDrift?.some((d) => d.word === '已确认')).toBe(true);
    }
  });

  it('"confirmed" hypothesis status fails the contract (no silent rewrite)', () => {
    const reply = JSON.stringify({
      situationId: 'sit_001',
      currentUnderstanding: '...',
      knownEvidence: [],
      hypotheses: [{ statement: 'X', status: 'confirmed' }],
      unknowns: [],
      judgment: 'j',
      stopReason: 'observe',
    });
    const r = parseInvestigation(reply, 'sit_001');
    expect(r.ok).toBe(false);
  });
});
