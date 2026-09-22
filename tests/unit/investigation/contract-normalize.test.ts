// P0010.2 Production Investigation Contract Repair — unit tests.
//
// Pin the contract repair behavior so future refactors can't silently:
//   - re-expand the Zod enum (pollutes the canonical persisted schema);
//   - accept arbitrary drift values (defeats fail-closed on unknown drift);
//   - drop the drift/unmappable fields the operator needs to debug;
//   - regress the prompt vocabulary instruction.

import { describe, expect, test } from 'vitest';
import {
  normalizeHypothesisStatus,
  normalizeStopReason,
  normalizeRecommendationKind,
  normalizeInvestigationContract,
  deriveKindFromStopReason,
  CANONICAL_HYPOTHESIS_STATUSES,
  CANONICAL_STOP_REASONS,
  CANONICAL_RECOMMENDATION_KINDS,
  parseInvestigation,
  extractJsonObject,
  buildInvestigationPrompt,
} from '#app/runtime/investigation/index.js';

// Hoisted: shared by both prompt-vocabulary describe blocks (the
// original hypothesis / stopReason block, and the P0010.2.x kind block).
// Keep ONE source of truth so a future refactor that changes the shape
// of a Situation (or its required fields) only has to update this one
// stub.
const STUB_SITUATION = {
  situationId: 'sit-1',
  type: 'anomaly_investigation' as const,
  entity: { id: 'e1', type: 'shop', name: 'shop', platform: 'jd' as const },
  temporal: { observedAt: '2026-08-22T00:00:00.000Z' },
  description: 'desc',
  domain: 'ecommerce' as const,
  tags: ['test'],
  lifecycle: 'open' as const,
  interventionCount: 0,
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
};

describe('normalizeHypothesisStatus (raw → canonical, fail-closed on unknown drift)', () => {
  test('canonical values pass through unchanged', () => {
    for (const canonical of ['proposed', 'supported', 'weakened', 'rejected'] as const) {
      const r = normalizeHypothesisStatus(canonical);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe(canonical);
    }
  });

  // Epistemic Integrity (2026-09-06): "confirmed" is NO LONGER a
  // raw → canonical mapping. Confirmed is an L4 epistemic layer that
  // REQUIRES `confirmed_evidence_refs[]`. Silently rewriting
  // "confirmed" → "supported" hid the L3→L4 distinction. Now unmappable.
  test('confirmed is UNMAPPABLE (Epistemic Integrity 2026-09-06 — was silently "supported" before)', () => {
    const r = normalizeHypothesisStatus('confirmed');
    expect(r.ok).toBe(false);
  });

  test('strongly_supported → supported', () => {
    const r = normalizeHypothesisStatus('strongly_supported');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('supported');
  });

  test('partially_rejected → weakened', () => {
    const r = normalizeHypothesisStatus('partially_rejected');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('weakened');
  });

  test('whitespace is trimmed on the surface', () => {
    const r = normalizeHypothesisStatus('  supported  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('supported');
  });

  test('unknown drift value → fail-closed (no status)', () => {
    const r = normalizeHypothesisStatus('definitely_yes');
    expect(r.ok).toBe(false);
  });

  test('case-folded canonical is NOT accepted (preserves the contract)', () => {
    // We do NOT case-fold. The prompt says EXACTLY 'supported'. A model
    // that emits 'Supported' is drifting and we want the operator to see
    // the rejection, not a silent accept.
    const r = normalizeHypothesisStatus('Supported');
    expect(r.ok).toBe(false);
  });

  test('non-string input → fail-closed', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
      const r = normalizeHypothesisStatus(bad);
      expect(r.ok).toBe(false);
    }
  });
});

describe('normalizeStopReason (raw → canonical, fail-closed on unknown drift)', () => {
  test('canonical values pass through unchanged', () => {
    for (const canonical of ['judgment', 'observe', 'missing_capability', 'ask_human'] as const) {
      const r = normalizeStopReason(canonical);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe(canonical);
    }
  });

  test('complete → judgment', () => {
    const r = normalizeStopReason('complete');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('judgment');
  });

  test('wait → observe', () => {
    const r = normalizeStopReason('wait');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('observe');
  });

  test('unknown stop reason → fail-closed', () => {
    const r = normalizeStopReason('totally_made_up');
    expect(r.ok).toBe(false);
  });
});

describe('normalizeInvestigationContract (walk the contract, surface drift)', () => {
  test('passes through canonical contract unchanged (no drift reported)', () => {
    const raw = {
      situationId: 'sit-1',
      hypotheses: [
        { statement: 'a', status: 'proposed' },
        { statement: 'b', status: 'supported' },
        { statement: 'c', status: 'weakened' },
        { statement: 'd', status: 'rejected' },
      ],
      stopReason: 'judgment',
    };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.drift).toEqual([]);
    expect(norm.driftUnmappable).toEqual([]);
    expect(norm.normalized).toEqual(raw);
  });

  test('rewrites all three known drift values to canonical + reports drift', () => {
    const raw = {
      situationId: 'sit-1',
      hypotheses: [
        { statement: 'a', status: 'strongly_supported' },
        { statement: 'b', status: 'partially_rejected' },
        { statement: 'c', status: 'partially_rejected' },
      ],
      stopReason: 'complete',
    };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.driftUnmappable).toEqual([]);
    expect(norm.drift).toEqual([
      { field: 'hypotheses[0].status', original: 'strongly_supported', canonical: 'supported' },
      { field: 'hypotheses[1].status', original: 'partially_rejected', canonical: 'weakened' },
      { field: 'hypotheses[2].status', original: 'partially_rejected', canonical: 'weakened' },
      { field: 'stopReason', original: 'complete', canonical: 'judgment' },
    ]);
    expect(norm.normalized).toEqual({
      situationId: 'sit-1',
      hypotheses: [
        { statement: 'a', status: 'supported' },
        { statement: 'b', status: 'weakened' },
        { statement: 'c', status: 'weakened' },
      ],
      stopReason: 'judgment',
    });
  });

  test('refuses unmappable status — parser will fail-closed, NOT silently invent', () => {
    const raw = {
      situationId: 'sit-1',
      hypotheses: [
        { statement: 'a', status: 'strongly_supported' }, // mappable L3 synonym
        { statement: 'b', status: 'maybe_true' }, // NOT mappable
        { statement: 'c', status: 'confirmed' }, // NOT mappable (Epistemic Integrity)
      ],
    };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.normalized).toBeNull();
    expect(norm.drift).toEqual([
      { field: 'hypotheses[0].status', original: 'strongly_supported', canonical: 'supported' },
    ]);
    expect(norm.driftUnmappable).toEqual([
      { field: 'hypotheses[1].status', original: 'maybe_true' },
      { field: 'hypotheses[2].status', original: 'confirmed' },
    ]);
  });

  test('hypothesis without status field is passed through (Zod defaults to "proposed")', () => {
    const raw = { situationId: 'sit-1', hypotheses: [{ statement: 'a' }] };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.drift).toEqual([]);
    expect(norm.driftUnmappable).toEqual([]);
    expect(norm.normalized).toEqual(raw);
  });

  test('does not mutate the input object', () => {
    const raw = {
      situationId: 'sit-1',
      hypotheses: [{ statement: 'a', status: 'confirmed' }],
      stopReason: 'complete',
    };
    const snapshot = JSON.stringify(raw);
    normalizeInvestigationContract(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  test('non-object root → fail-closed', () => {
    for (const bad of [null, 'string', 42, [], true]) {
      const norm = normalizeInvestigationContract(bad);
      expect(norm.normalized).toBeNull();
      expect(norm.driftUnmappable.length).toBe(1);
    }
  });
});

describe('parseInvestigation (raw → normalized → Zod fail-closed on unmappable drift)', () => {
  test('canonical contract parses on the direct path, no drift reported', () => {
    const reply = JSON.stringify({
      situationId: 'sit-1',
      currentUnderstanding: 'Got it',
      knownEvidence: ['e1'],
      hypotheses: [
        { statement: 'h1', status: 'supported' },
        { statement: 'h2', status: 'rejected' },
      ],
      unknowns: [],
      nextQuestion: '',
      requiredEvidence: [],
      investigationRequest: '',
      findings: [],
      judgment: 'j',
      stopReason: 'judgment',
      capabilityUsed: '',
      evidenceAcquired: [],
      // P0013.2 shared Analysis Contract obligations.
      observed_facts: ['fact'],
      supporting_evidence_refs: ['e1'],
      evidence_gaps: [],
      business_structure_coverage: (['product', 'orders', 'traffic', 'conversion', 'operations'] as const).map(
        (dimension) => ({ dimension, status: 'covered', note: `note ${dimension}`, evidence_refs: ['e1'] }),
      ),
    });
    const result = parseInvestigation(reply, 'sit-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.investigation.judgment).toBe('j');
      expect(result.drift).toEqual([]);
    }
  });

  test('drift values are normalized and the contract still parses', () => {
    // Epistemic Integrity (2026-09-06): "confirmed" is no longer a mappable
    // L3 synonym — it's an L4 layer that requires `confirmed_evidence_refs[]`.
    // We use the still-mappable L3 synonyms strongly_supported /
    // partially_rejected here to exercise the normalization path.
    const reply = JSON.stringify({
      situationId: 'sit-1',
      currentUnderstanding: 'Got it',
      knownEvidence: [],
      hypotheses: [
        { statement: 'h1', status: 'strongly_supported' },
        { statement: 'h2', status: 'partially_rejected' },
      ],
      unknowns: [],
      nextQuestion: '',
      requiredEvidence: [],
      investigationRequest: '',
      findings: [],
      judgment: 'j',
      stopReason: 'complete',
      capabilityUsed: '',
      evidenceAcquired: [],
      // P0013.2 shared Analysis Contract obligations.
      observed_facts: ['fact'],
      supporting_evidence_refs: ['e1'],
      evidence_gaps: [],
      business_structure_coverage: (['product', 'orders', 'traffic', 'conversion', 'operations'] as const).map(
        (dimension) => ({ dimension, status: 'covered', note: `note ${dimension}`, evidence_refs: ['e1'] }),
      ),
    });
    const result = parseInvestigation(reply, 'sit-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.drift.length).toBe(3);
      // The persisted hypotheses are canonical.
      const statuses = result.investigation.hypotheses.map((h) => h.status);
      expect(statuses).toEqual(['supported', 'weakened']);
      // The persisted stopReason is canonical.
      expect(result.investigation.stopReason).toBe('judgment');
    }
  });

  test('unmappable drift fails the contract and surfaces the exact field', () => {
    const reply = JSON.stringify({
      situationId: 'sit-1',
      hypotheses: [
        { statement: 'h1', status: 'whoknows' }, // NOT mappable
        { statement: 'h2', status: 'confirmed' }, // NOT mappable (Epistemic Integrity 2026-09-06)
      ],
      judgment: 'j',
    });
    const result = parseInvestigation(reply, 'sit-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unmappable).toBeDefined();
      // Order: hypotheses are walked in source order, so [0] surfaces first.
      expect(result.unmappable).toEqual([
        { field: 'hypotheses[0].status', original: 'whoknows' },
        { field: 'hypotheses[1].status', original: 'confirmed' },
      ]);
    }
  });

  test('malformed JSON fails with the JSON parse error, not a contract error', () => {
    const result = parseInvestigation('not even close to JSON', 'sit-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/No JSON Investigation Contract found/);
      expect(result.unmappable).toBeUndefined();
    }
  });

  test('no JSON at all fails the same way', () => {
    const result = parseInvestigation('just prose, no braces', 'sit-1');
    expect(result.ok).toBe(false);
  });
});

describe('extractJsonObject (defensive last-balanced-brace scan)', () => {
  test('finds the last balanced {...} object in prose', () => {
    const text = 'before {"a":1, "b": {"c": 2}} after';
    expect(extractJsonObject(text)).toBe('{"a":1, "b": {"c": 2}}');
  });
  test('returns null when there is no closing brace', () => {
    expect(extractJsonObject('hello world')).toBeNull();
  });
});

describe('buildInvestigationPrompt — vocabulary constraint is enforced in the prompt', () => {
  // The parser only sees what the Agent wrote. The prompt is the first line
  // of defense. These tests pin the explicit vocabulary so a future refactor
  // doesn't accidentally drop the constraint or change the vocabulary.
  const stub = STUB_SITUATION;

  test('prompt lists the four canonical hypothesis statuses as EXACT strings', () => {
    const p = buildInvestigationPrompt(stub, null);
    expect(p).toMatch(/"proposed"/);
    expect(p).toMatch(/"supported"/);
    expect(p).toMatch(/"weakened"/);
    expect(p).toMatch(/"rejected"/);
  });

  test('enum legality is runtime-enforced: the live synonyms normalize, the removed one fails closed', () => {
    // P0013.5 moved this guarantee (Design §3 — "enum legality" is
    // Runtime-Enforced, and the code is the final authority), so the assertion
    // lives with the normalizer that owns it.
    //
    // The prompt used to advertise a drift allow-list that was itself stale:
    // it listed `confirmed -> supported`, a rewrite the 2026-09-06 Epistemic
    // Integrity work had DELETED (it masked an L3->L4 silent upgrade). Removing
    // the list from the prompt removed stale guidance; the live behaviour is
    // asserted here instead.
    expect(normalizeHypothesisStatus('strongly_supported')).toEqual({ ok: true, status: 'supported', original: 'strongly_supported' });
    expect(normalizeHypothesisStatus('partially_rejected')).toEqual({ ok: true, status: 'weakened', original: 'partially_rejected' });
    expect(normalizeHypothesisStatus('confirmed')).toEqual({ ok: false, original: 'confirmed' });
  });

  test('prompt lists the four canonical stop reasons as EXACT strings', () => {
    const p = buildInvestigationPrompt(stub, null);
    expect(p).toMatch(/"judgment"/);
    expect(p).toMatch(/"observe"/);
    expect(p).toMatch(/"missing_capability"/);
    expect(p).toMatch(/"ask_human"/);
  });
});

describe('CANONICAL_* (public surface pinned to the schema)', () => {
  test('canonical hypothesis statuses are exactly the four', () => {
    expect([...CANONICAL_HYPOTHESIS_STATUSES].sort()).toEqual(['proposed', 'rejected', 'supported', 'weakened']);
  });
  test('canonical stop reasons are exactly the four', () => {
    expect([...CANONICAL_STOP_REASONS].sort()).toEqual(['ask_human', 'judgment', 'missing_capability', 'observe']);
  });
  // P0010.2.x — recommendation kind is a binary surface.
  test('canonical recommendation kinds are exactly observe | act', () => {
    expect([...CANONICAL_RECOMMENDATION_KINDS].sort()).toEqual(['act', 'observe']);
  });
});

// ---- P0010.2.x — Recommendation kind (observe | act) --------------------
//
// Same fail-closed policy as hypothesis status and stop reason. We accept
// the canonical English forms plus a small drift allow-list of Chinese
// and English near-synonyms. Anything not on the allow-list surfaces as
// `driftUnmappable` and the parser fails closed.

describe('normalizeRecommendationKind (raw → canonical, fail-closed on unknown drift)', () => {
  test('canonical values pass through unchanged', () => {
    expect(normalizeRecommendationKind('observe')).toEqual({ ok: true, status: 'observe', original: 'observe' });
    expect(normalizeRecommendationKind('act')).toEqual({ ok: true, status: 'act', original: 'act' });
  });

  test('Chinese near-synonyms (observe-side) rewrite to canonical observe', () => {
    const observed = ['观察', '保持观察', '持续观察', '等待', '不干预', '暂不干预', '不行动'];
    for (const raw of observed) {
      const r = normalizeRecommendationKind(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe('observe');
    }
  });

  test('Chinese near-synonyms (act-side) rewrite to canonical act', () => {
    const acted = ['行动', '干预', '调整', '采取行动', '待执行', '待交付'];
    for (const raw of acted) {
      const r = normalizeRecommendationKind(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe('act');
    }
  });

  test('English near-synonyms rewrite to canonical', () => {
    const observed = ['watch', 'wait', 'hold', 'do_nothing'];
    for (const raw of observed) {
      const r = normalizeRecommendationKind(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe('observe');
    }
    const acted = ['intervene', 'action', 'take_action'];
    for (const raw of acted) {
      const r = normalizeRecommendationKind(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe('act');
    }
  });

  test('whitespace is trimmed on the surface', () => {
    expect(normalizeRecommendationKind('  observe  ')).toEqual({ ok: true, status: 'observe', original: '  observe  ' });
  });

  test('unknown drift value → fail-closed (no kind)', () => {
    const r = normalizeRecommendationKind('kind_of_maybe');
    expect(r.ok).toBe(false);
  });

  test('case-folded canonical is NOT accepted (preserves the contract)', () => {
    expect(normalizeRecommendationKind('OBSERVE').ok).toBe(false);
    expect(normalizeRecommendationKind('Act').ok).toBe(false);
  });

  test('non-string input → fail-closed', () => {
    expect(normalizeRecommendationKind(undefined).ok).toBe(false);
    expect(normalizeRecommendationKind(null).ok).toBe(false);
    expect(normalizeRecommendationKind(42).ok).toBe(false);
  });
});

describe('deriveKindFromStopReason — authoritative kind from the Investigation stopReason (P0010.2 Fix 2)', () => {
  // The recommendation sub-turn does NOT ask the Agent for a kind. The kind
  // MUST come from the main Investigation's stopReason via this single
  // shared mapping. Only `judgment` means act; every other stop reason means
  // observe (do not act). `undefined` → observe (conservative: no confirmed
  // judgment means no action recommendation).
  test('judgment → act', () => {
    expect(deriveKindFromStopReason('judgment')).toBe('act');
  });
  test('observe → observe', () => {
    expect(deriveKindFromStopReason('observe')).toBe('observe');
  });
  test('missing_capability → observe', () => {
    expect(deriveKindFromStopReason('missing_capability')).toBe('observe');
  });
  test('ask_human → observe', () => {
    expect(deriveKindFromStopReason('ask_human')).toBe('observe');
  });
  test('undefined stopReason → observe (no judgment means no action)', () => {
    expect(deriveKindFromStopReason(undefined)).toBe('observe');
  });
});

describe('normalizeInvestigationContract — recommendation.kind (P0010.2.x)', () => {
  test('explicit canonical kind: pass through, no drift reported', () => {
    const raw = {
      situationId: 'sit-1',
      stopReason: 'judgment',
      recommendation: {
        kind: 'act',
        recommendation: '调整主推位',
        rationale: '流量端异常',
      },
    };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.drift).toEqual([]);
    expect(norm.normalized).toEqual(raw);
  });

  test('drift kind: rewrite to canonical + report drift on recommendation.kind', () => {
    const raw = {
      situationId: 'sit-1',
      stopReason: 'observe',
      recommendation: {
        kind: '保持观察', // Chinese drift
        recommendation: '持续观察，不干预',
        rationale: '数据缺失',
      },
    };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.drift).toEqual([
      { field: 'recommendation.kind', original: '保持观察', canonical: 'observe' },
    ]);
    expect((norm.normalized as any).recommendation.kind).toBe('observe');
  });

  test('missing kind: derive from stopReason (judgment → act, others → observe) + report derivation as drift', () => {
    // judgment → derive to 'act'
    const r1 = normalizeInvestigationContract({
      situationId: 'sit-1',
      stopReason: 'judgment',
      recommendation: { recommendation: '调整主推位', rationale: '流量端异常' },
    });
    expect(r1.drift).toEqual([
      { field: 'recommendation.kind', original: '<derived from stopReason>', canonical: 'act' },
    ]);
    expect((r1.normalized as any).recommendation.kind).toBe('act');

    // observe → derive to 'observe'
    const r2 = normalizeInvestigationContract({
      situationId: 'sit-1',
      stopReason: 'observe',
      recommendation: { recommendation: '持续观察', rationale: '数据缺失' },
    });
    expect((r2.normalized as any).recommendation.kind).toBe('observe');

    // missing_capability → derive to 'observe'
    const r3 = normalizeInvestigationContract({
      situationId: 'sit-1',
      stopReason: 'missing_capability',
      recommendation: { recommendation: '等待 MCP 恢复', rationale: 'platform has no capability' },
    });
    expect((r3.normalized as any).recommendation.kind).toBe('observe');

    // ask_human → derive to 'observe'
    const r4 = normalizeInvestigationContract({
      situationId: 'sit-1',
      stopReason: 'ask_human',
      recommendation: { recommendation: '请人工确认', rationale: 'fact not machine-observable' },
    });
    expect((r4.normalized as any).recommendation.kind).toBe('observe');
  });

  test('missing kind + missing stopReason: leave field unset (Zod defaults to act on parse)', () => {
    const raw = {
      situationId: 'sit-1',
      recommendation: { recommendation: '调整主推位', rationale: '流量端异常' },
    };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.drift).toEqual([]);
    expect((norm.normalized as any).recommendation.kind).toBeUndefined();
  });

  test('unmappable kind: surfaces as driftUnmappable (parser fails closed)', () => {
    const raw = {
      situationId: 'sit-1',
      stopReason: 'judgment',
      recommendation: {
        kind: 'kinda_important', // not on allow-list
        recommendation: 'do something',
        rationale: 'because',
      },
    };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.driftUnmappable).toEqual([
      { field: 'recommendation.kind', original: 'kinda_important' },
    ]);
    expect(norm.normalized).toBeNull();
  });

  test('investigation with no recommendation object: no kind walking happens', () => {
    const raw = { situationId: 'sit-1', stopReason: 'judgment' };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.drift).toEqual([]);
    expect(norm.normalized).toEqual(raw);
  });
});

describe('P0010.2.x — buildInvestigationPrompt teaches the Agent to fill recommendation.kind', () => {
  // The runtime/UI contract is that the Agent fills `kind` explicitly.
  // The derive-from-stopReason shim in `normalizeInvestigationContract`
  // is the backwards-compat path, but the prompt must teach the
  // canonical case so the Agent stops emitting near-synonyms.

  test('prompt lists the two canonical kind values as EXACT strings', () => {
    const p = buildInvestigationPrompt(STUB_SITUATION, null);
    expect(p).toMatch(/"observe"/);
    expect(p).toMatch(/"act"/);
  });

  test('prompt names `recommendation.kind` as a contract field', () => {
    const p = buildInvestigationPrompt(STUB_SITUATION, null);
    expect(p).toMatch(/recommendation\.kind/);
  });
});
