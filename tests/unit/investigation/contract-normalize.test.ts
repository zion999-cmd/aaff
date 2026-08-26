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
  normalizeInvestigationContract,
  CANONICAL_HYPOTHESIS_STATUSES,
  CANONICAL_STOP_REASONS,
  parseInvestigation,
  extractJsonObject,
  buildInvestigationPrompt,
} from '#app/runtime/investigation/index.js';

describe('normalizeHypothesisStatus (raw → canonical, fail-closed on unknown drift)', () => {
  test('canonical values pass through unchanged', () => {
    for (const canonical of ['proposed', 'supported', 'weakened', 'rejected'] as const) {
      const r = normalizeHypothesisStatus(canonical);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe(canonical);
    }
  });

  test('confirmed → supported', () => {
    const r = normalizeHypothesisStatus('confirmed');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('supported');
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
        { statement: 'a', status: 'confirmed' },
        { statement: 'b', status: 'strongly_supported' },
        { statement: 'c', status: 'partially_rejected' },
      ],
      stopReason: 'complete',
    };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.driftUnmappable).toEqual([]);
    expect(norm.drift).toEqual([
      { field: 'hypotheses[0].status', original: 'confirmed', canonical: 'supported' },
      { field: 'hypotheses[1].status', original: 'strongly_supported', canonical: 'supported' },
      { field: 'hypotheses[2].status', original: 'partially_rejected', canonical: 'weakened' },
      { field: 'stopReason', original: 'complete', canonical: 'judgment' },
    ]);
    expect(norm.normalized).toEqual({
      situationId: 'sit-1',
      hypotheses: [
        { statement: 'a', status: 'supported' },
        { statement: 'b', status: 'supported' },
        { statement: 'c', status: 'weakened' },
      ],
      stopReason: 'judgment',
    });
  });

  test('refuses unmappable status — parser will fail-closed, NOT silently invent', () => {
    const raw = {
      situationId: 'sit-1',
      hypotheses: [
        { statement: 'a', status: 'confirmed' }, // mappable
        { statement: 'b', status: 'maybe_true' }, // NOT mappable
      ],
    };
    const norm = normalizeInvestigationContract(raw);
    expect(norm.normalized).toBeNull();
    expect(norm.drift).toEqual([
      { field: 'hypotheses[0].status', original: 'confirmed', canonical: 'supported' },
    ]);
    expect(norm.driftUnmappable).toEqual([
      { field: 'hypotheses[1].status', original: 'maybe_true' },
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
    });
    const result = parseInvestigation(reply, 'sit-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.investigation.judgment).toBe('j');
      expect(result.drift).toEqual([]);
    }
  });

  test('drift values are normalized and the contract still parses', () => {
    const reply = JSON.stringify({
      situationId: 'sit-1',
      currentUnderstanding: 'Got it',
      knownEvidence: [],
      hypotheses: [
        { statement: 'h1', status: 'confirmed' },
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
        { statement: 'h1', status: 'confirmed' }, // mappable
        { statement: 'h2', status: 'whoknows' }, // NOT mappable
      ],
      judgment: 'j',
    });
    const result = parseInvestigation(reply, 'sit-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unmappable).toBeDefined();
      expect(result.unmappable).toEqual([{ field: 'hypotheses[1].status', original: 'whoknows' }]);
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
  const stub = {
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

  test('prompt lists the four canonical hypothesis statuses as EXACT strings', () => {
    const p = buildInvestigationPrompt(stub, null);
    expect(p).toMatch(/"proposed"/);
    expect(p).toMatch(/"supported"/);
    expect(p).toMatch(/"weakened"/);
    expect(p).toMatch(/"rejected"/);
  });

  test('prompt names the known drift values that the system normalizes', () => {
    const p = buildInvestigationPrompt(stub, null);
    // The prompt must teach the Agent what we will (and won't) accept.
    expect(p).toMatch(/confirmed/);
    expect(p).toMatch(/strongly_supported/);
    expect(p).toMatch(/partially_rejected/);
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
});
