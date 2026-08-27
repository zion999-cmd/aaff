// P0010.2.x — Workspace Presentation Reducer (truth table).
//
// The reducer is the single source of truth for the operator-facing
// state. These tests pin the 8-step decision tree so a future
// refactor cannot reintroduce audit dead-leg #1 (multiple state
// sources disagreeing on the same Situation).
//
// The four guard tests at the bottom are the user's hard rules from
// the P0010.2.x review:
//
//   1. `humanNeeded[]` does NOT influence `waiting_human`.
//   2. `failed + hasPriorValidCognition` is `recoverable`, not `observing`.
//   3. `blocked` requires BOTH threshold + `blockedEmittedAt` (restart safety).
//   4. `presentationRevision` is stable across same-persisted-state
//      requests but changes when only one field changes.

import { describe, test, expect } from 'vitest';
import { reduce, reduceForFeed } from '#app/workspace/presentation-state.js';
import type { ReducerInput } from '#app/workspace/presentation-state.js';

const NOW = '2026-08-27T10:00:00.000Z';

const baseSituation = {
  situationId: 'sit_test',
  lifecycle: 'open' as const,
  createdAt: NOW,
  updatedAt: NOW,
  description: 'test',
  type: 'anomaly_investigation',
};

const build = (overrides: Partial<ReducerInput>): ReducerInput => ({
  situation: baseSituation,
  learningContext: null,
  interventions: [],
  now: NOW,
  ...overrides,
});

const inv = (status: string | undefined, more: Record<string, unknown> = {}) => ({
  status,
  situationId: 'sit_test',
  requiredEvidence: [],
  knownEvidence: [],
  judgment: '',
  currentUnderstanding: '',
  hypotheses: [],
  ...more,
});

// ---- 8-step decision tree ----

describe('reduce — 8-step decision tree', () => {
  test('(1) blocked — needs all 3 persisted sidecars', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('failed', {
        consecutiveFailures: 3,
        blockedEmittedAt: NOW,
      }) } as any,
    }));
    expect(r.presentation).toBe('blocked');
  });

  test('(1→4) failed but counter below threshold → recoverable, NOT blocked', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('failed', {
        consecutiveFailures: 2,
        blockedEmittedAt: NOW,
      }) } as any,
    }));
    expect(r.presentation).toBe('recoverable');
  });

  test('(1→4) failed and counter meets threshold but blockedEmittedAt missing → recoverable', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('failed', {
        consecutiveFailures: 3,
        blockedEmittedAt: undefined,
      }) } as any,
    }));
    expect(r.presentation).toBe('recoverable');
  });

  test('(2) pending — no investigation yet', () => {
    const r = reduce(build({ learningContext: null }));
    expect(r.presentation).toBe('pending');
  });

  test('(2) pending — status=pending', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('pending') } as any,
    }));
    expect(r.presentation).toBe('pending');
  });

  test('(3) investigating — turn in flight', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('investigating') } as any,
    }));
    expect(r.presentation).toBe('investigating');
  });

  test('(4) recoverable — failed (regardless of prior cognition)', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('failed', {
        judgment: 'prior valid judgment preserved',
      }) } as any,
    }));
    expect(r.presentation).toBe('recoverable');
    expect(r.banner.priorValidCognitionPreserved).toBe(true);
  });

  test('(5) observing — completed + stopReason=observe', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('completed', { stopReason: 'observe' }) } as any,
    }));
    expect(r.presentation).toBe('observing');
  });

  test('(6) waiting_human — completed + stopReason=ask_human', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('completed', { stopReason: 'ask_human' }) } as any,
    }));
    expect(r.presentation).toBe('waiting_human');
  });

  test('(6) waiting_human — completed + stopReason=missing_capability', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('completed', { stopReason: 'missing_capability' }) } as any,
    }));
    expect(r.presentation).toBe('waiting_human');
  });

  test('(7) completed — completed + stopReason=judgment', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('completed', { stopReason: 'judgment' }) } as any,
    }));
    expect(r.presentation).toBe('completed');
  });
});

// ---- Hard rules from the user's review ----

describe('reduce — hard rules', () => {
  test('humanNeeded[] does NOT influence waiting_human (rule 1)', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('completed', {
        stopReason: 'judgment',
        recommendation: {
          recommendation: '...',
          rationale: '...',
          humanNeeded: [{ kind: 'manual_review', reason: 'verify' }],
        },
      }) } as any,
    }));
    expect(r.presentation).toBe('completed');
    expect(r.banner.priorValidCognitionPreserved).toBe(false);
  });

  test('failed + hasPriorValidCognition → recoverable, NOT observing (rule 2)', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('failed', {
        judgment: 'agent had a prior judgment',
        currentUnderstanding: 'agent had prior context',
        consecutiveFailures: 2,
        blockedEmittedAt: undefined,
      }) } as any,
    }));
    expect(r.presentation).toBe('recoverable');
    expect(r.banner.priorValidCognitionPreserved).toBe(true);
    expect(r.presentation).not.toBe('observing');
  });

  test('blocked survives a "process restart" (rule 3)', () => {
    const r1 = reduce(build({
      learningContext: { investigation: inv('failed', {
        consecutiveFailures: 3,
        blockedEmittedAt: NOW,
      }) } as any,
    }));
    expect(r1.presentation).toBe('blocked');
    const r2 = reduce(build({
      learningContext: { investigation: inv('failed', {
        consecutiveFailures: 3,
        blockedEmittedAt: NOW,
      }) } as any,
      now: '2026-09-01T00:00:00.000Z',
    }));
    expect(r2.presentation).toBe('blocked');
  });
});

// ---- Banner copy ----

describe('reduce — banner copy', () => {
  test('blocked banner explains the threshold + counter', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('failed', {
        consecutiveFailures: 3,
        blockedEmittedAt: NOW,
      }) } as any,
    }));
    expect(r.banner.headline).toContain('暂停');
    expect(r.banner.detail).toContain('3');
    expect(r.banner.availableActions.showClearBlock).toBe(true);
  });

  test('completed banner shows generate-recommendation when no rec yet', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('completed', {
        stopReason: 'judgment',
        judgment: 'agent judgment',
      }) } as any,
    }));
    expect(r.banner.availableActions.showGenerateRecommendation).toBe(true);
    expect(r.banner.availableActions.showClearBlock).toBe(false);
  });

  test('completed banner hides generate-recommendation when rec exists', () => {
    const r = reduce(build({
      learningContext: { investigation: inv('completed', {
        stopReason: 'judgment',
        judgment: 'agent judgment',
        recommendation: {
          recommendation: 'act on this',
          rationale: 'because',
        },
      }) } as any,
    }));
    expect(r.banner.availableActions.showGenerateRecommendation).toBe(false);
  });
});

// ---- Revision stability ----

describe('reduce — presentationRevision', () => {
  test('same persisted state → same revision (purity)', () => {
    const a = reduce(build({
      learningContext: { investigation: inv('completed', { stopReason: 'judgment' }) } as any,
    }));
    const b = reduce(build({
      learningContext: { investigation: inv('completed', { stopReason: 'judgment' }) } as any,
      now: '2026-08-27T11:00:00.000Z',
    }));
    expect(a.presentationRevision).toBe(b.presentationRevision);
  });

  test('changing updatedAt changes the revision', () => {
    const a = reduce(build({
      learningContext: { investigation: inv('completed', {
        stopReason: 'judgment',
        updatedAt: '2026-08-27T10:00:00.000Z',
      }) } as any,
    }));
    const b = reduce(build({
      learningContext: { investigation: inv('completed', {
        stopReason: 'judgment',
        updatedAt: '2026-08-27T10:00:01.000Z',
      }) } as any,
    }));
    expect(a.presentationRevision).not.toBe(b.presentationRevision);
  });

  test('changing recommendation presence changes the revision', () => {
    const a = reduce(build({
      learningContext: { investigation: inv('completed', { stopReason: 'judgment' }) } as any,
    }));
    const b = reduce(build({
      learningContext: { investigation: inv('completed', {
        stopReason: 'judgment',
        recommendation: { recommendation: 'do X', rationale: 'why' },
      }) } as any,
    }));
    expect(a.presentationRevision).not.toBe(b.presentationRevision);
  });
});

// ---- reduceForFeed ----

describe('reduceForFeed — feed projection', () => {
  test('FeedEntrySummary carries the same presentation state', () => {
    const f = reduceForFeed(build({
      learningContext: { investigation: inv('failed', {
        consecutiveFailures: 3,
        blockedEmittedAt: NOW,
      }) } as any,
    }));
    expect(f.presentation).toBe('blocked');
    expect(f.headline).toContain('暂停');
    expect(f.shortLabel).toContain('暂停');
  });

  test('feed revision matches full revision', () => {
    const full = reduce(build({ learningContext: null }));
    const feed = reduceForFeed(build({ learningContext: null }));
    expect(feed.presentationRevision).toBe(full.presentationRevision);
  });
});
