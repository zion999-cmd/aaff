// P0010.2.2 — Recovery Candidates tests.
//
// The recovery scan is the Loop's self-healing core: it must catch
// pre-existing open situations whose investigation was never run,
// was interrupted (process died mid-turn), or is retryable below the
// failure threshold. It must NOT include completed situations (the
// policy's `meaningful_new_evidence` path owns re-investigation on
// new evidence), and must honor excludeIds + maxCandidatesPerTick.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import {
  listRecoverableCandidates,
  countConsecutiveFailures,
  countBlockedSituations,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_RECOVERY_STALE_AFTER_MS,
} from '#app/runtime/loop/recovery-candidates.js';

const NOW = '2026-08-25T00:00:00.000Z';
const STALE_THRESHOLD_MS = DEFAULT_RECOVERY_STALE_AFTER_MS;

const insertSituation = (
  db: Database.Database,
  situationId: string,
  lifecycle: string = 'open',
  observedAt: string = NOW,
) => {
  db.prepare(
    `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
       observed_at, description, tags, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    situationId, 'ecommerce', 'anomaly_investigation',
    'jd_shop_001', 'shop', '祁门红茶旗舰店', 'jd',
    observedAt, 'test', JSON.stringify(['test']), lifecycle, observedAt, observedAt,
  );
};

const insertLearningContext = (
  db: Database.Database,
  situationId: string,
  body: Record<string, unknown>,
) => {
  db.prepare(
    `INSERT INTO learning_contexts (context_id, situation_id, lifecycle, created_at, updated_at, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `ctx_${situationId}`,
    situationId,
    'partial',
    NOW,
    NOW,
    JSON.stringify(body),
  );
};

const buildContextBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    contextId: 'ctx_test',
    situation: {
      situationId: 'sit_default',
      domain: 'ecommerce',
      type: 'anomaly_investigation',
      entity: { id: 'jd_shop_001', type: 'shop' },
      temporal: { observedAt: NOW },
      description: 'test',
      tags: ['test'],
    },
    lifecycle: 'partial',
    createdAt: NOW,
    updatedAt: NOW,
    observations: [],
    evidenceIds: [],
    signalIds: [],
    agentActivities: [],
    humanInterventions: [],
    actions: [],
    outcomes: [],
    summary: {
      capabilitiesUsed: [],
      agentRuntimes: [],
      humanActors: [],
      totalEvidence: 0,
      totalSignals: 0,
    },
    outputs: [],
  };
  return { ...base, ...overrides };
};

describe('listRecoverableCandidates', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  test('returns no_investigation for an open situation without a learning_context', () => {
    insertSituation(db, 'sit_a');
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      situationId: 'sit_a',
      recoveryKind: 'no_investigation',
      consecutiveFailures: 0,
    });
  });

  test('returns no_investigation for an open situation with a learning_context that has no investigation', () => {
    insertSituation(db, 'sit_b');
    insertLearningContext(db, 'sit_b', buildContextBody());
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(1);
    expect(out[0]?.recoveryKind).toBe('no_investigation');
  });

  test('returns failed_retryable when prior failed and consecutiveFailures < threshold', () => {
    insertSituation(db, 'sit_c');
    insertLearningContext(db, 'sit_c', buildContextBody({
      investigation: {
        status: 'failed',
        error: 'previous turn timed out',
        updatedAt: NOW,
        consecutiveFailures: 1,
      },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(1);
    expect(out[0]?.recoveryKind).toBe('failed_retryable');
    expect(out[0]?.consecutiveFailures).toBe(1);
  });

  test('returns failed_retryable at exactly the threshold (so the policy emits investigation_blocked)', () => {
    // count == max is the THRESHOLD-CROSSING tick. The scan includes it
    // so the policy's `blocked_runtime_failure` decision can fire the
    // `investigation_blocked` event. Without this, the event would
    // never fire — the scan would silently skip the situation the
    // tick before the threshold was reached.
    insertSituation(db, 'sit_at_threshold');
    insertLearningContext(db, 'sit_at_threshold', buildContextBody({
      investigation: {
        status: 'failed',
        error: 'failed exactly N times',
        updatedAt: NOW,
        consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
      },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(1);
    expect(out[0]?.recoveryKind).toBe('failed_retryable');
    expect(out[0]?.consecutiveFailures).toBe(DEFAULT_MAX_CONSECUTIVE_FAILURES);
  });

  test('does NOT return a failed situation strictly ABOVE the threshold (already-blocked silence)', () => {
    // count > max means the policy already returned `blocked_runtime_failure`
    // on a prior tick and the operator hasn't cleared it. Skip silently
    // — the next emitted `investigation_blocked` event was the
    // threshold-crossing tick, not every subsequent tick.
    insertSituation(db, 'sit_blocked');
    insertLearningContext(db, 'sit_blocked', buildContextBody({
      investigation: {
        status: 'failed',
        error: 'still failing',
        updatedAt: NOW,
        consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES + 1,
      },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(0);
  });

  // Audit R4 fix (P0010.2.2): the threshold-crossing tick fires the
  // `investigation_blocked` event AND stamps `blockedEmittedAt` on the
  // marker. Subsequent ticks see the marker and skip — without this,
  // the recovery scan would re-include the situation on every tick
  // (counter == max is INCLUDED) and the operator's log would re-fire
  // the event every 60s until clear-block.
  test('does NOT return a threshold-crossing situation that has already emitted blockedEmittedAt', () => {
    insertSituation(db, 'sit_already_emitted');
    insertLearningContext(db, 'sit_already_emitted', buildContextBody({
      investigation: {
        status: 'failed',
        error: 'failed 3 times, blocked event already fired',
        updatedAt: NOW,
        consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
        blockedEmittedAt: '2026-08-25T00:00:00.000Z',
      },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(0);
  });

  test('DOES return a threshold-crossing situation that has NOT yet emitted (fresh block cycle)', () => {
    // The first tick the counter hits max — the recovery scan returns
    // it, the policy returns blocked, the Loop emits the event AND
    // stamps blockedEmittedAt. On the NEXT tick, the test above
    // (already_emitted) takes over and the scan skips.
    insertSituation(db, 'sit_threshold_fresh');
    insertLearningContext(db, 'sit_threshold_fresh', buildContextBody({
      investigation: {
        status: 'failed',
        error: 'failed 3 times for the first time',
        updatedAt: NOW,
        consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
        // no blockedEmittedAt — first threshold-crossing tick
      },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(1);
    expect(out[0]?.recoveryKind).toBe('failed_retryable');
    expect(out[0]?.consecutiveFailures).toBe(DEFAULT_MAX_CONSECUTIVE_FAILURES);
  });

  test('returns interrupted for an investigating marker older than the stale threshold', () => {
    insertSituation(db, 'sit_int');
    const staleStartedAt = new Date(Date.now() - (STALE_THRESHOLD_MS + 60_000)).toISOString();
    insertLearningContext(db, 'sit_int', buildContextBody({
      investigation: {
        status: 'investigating',
        startedAt: staleStartedAt,
        updatedAt: staleStartedAt,
      },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(1);
    expect(out[0]?.recoveryKind).toBe('interrupted');
  });

  test('does NOT return a fresh investigating marker (live tick owns it)', () => {
    insertSituation(db, 'sit_live');
    insertLearningContext(db, 'sit_live', buildContextBody({
      investigation: {
        status: 'investigating',
        startedAt: new Date(Date.now() - 1000).toISOString(), // 1s old
        updatedAt: new Date().toISOString(),
      },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(0);
  });

  test('does NOT return a completed situation (policy owns the meaningful_new_evidence path)', () => {
    insertSituation(db, 'sit_done');
    insertLearningContext(db, 'sit_done', buildContextBody({
      investigation: {
        status: 'completed',
        judgment: 'all good',
        stopReason: 'judgment',
        updatedAt: NOW,
      },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(0);
  });

  test('does NOT return a mature situation (already archived / closed path)', () => {
    insertSituation(db, 'sit_mature', 'mature');
    insertLearningContext(db, 'sit_mature', buildContextBody({
      investigation: { status: 'completed', stopReason: 'judgment', updatedAt: NOW },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(0);
  });

  test('honors excludeIds (dedup against the producer output)', () => {
    insertSituation(db, 'sit_x1');
    insertSituation(db, 'sit_x2');
    const out = listRecoverableCandidates(db, { excludeIds: new Set(['sit_x1']) });
    expect(out.map((r) => r.situationId)).toEqual(['sit_x2']);
  });

  test('honors maxCandidatesPerTick', () => {
    for (let i = 0; i < 5; i += 1) insertSituation(db, `sit_cap_${i}`);
    const out = listRecoverableCandidates(db, { maxCandidatesPerTick: 2 });
    expect(out).toHaveLength(2);
  });

  test('orders no_investigation before failed_retryable (highest information gain first)', () => {
    insertSituation(db, 'sit_old', 'open', '2026-08-20T00:00:00.000Z');
    insertSituation(db, 'sit_new', 'open', '2026-08-25T00:00:00.000Z');
    insertLearningContext(db, 'sit_old', buildContextBody({
      investigation: { status: 'failed', updatedAt: NOW, consecutiveFailures: 1 },
    }));
    const out = listRecoverableCandidates(db);
    // sit_new has no learning_context → no_investigation
    // sit_old has a failed retryable → failed_retryable
    // no_investigation should come first regardless of updated_at order
    expect(out[0]?.situationId).toBe('sit_new');
    expect(out[0]?.recoveryKind).toBe('no_investigation');
    expect(out[1]?.situationId).toBe('sit_old');
    expect(out[1]?.recoveryKind).toBe('failed_retryable');
  });

  test('treats investigating marker with no startedAt as interrupted (conservative)', () => {
    insertSituation(db, 'sit_nostart');
    insertLearningContext(db, 'sit_nostart', buildContextBody({
      investigation: { status: 'investigating', updatedAt: NOW },
    }));
    const out = listRecoverableCandidates(db);
    expect(out).toHaveLength(1);
    expect(out[0]?.recoveryKind).toBe('interrupted');
  });
});

describe('countConsecutiveFailures', () => {
  test('returns 0 when the counter field is missing (fresh / never-failed investigation)', () => {
    expect(countConsecutiveFailures({})).toBe(0);
    expect(countConsecutiveFailures({ investigation: {} })).toBe(0);
  });

  test('returns 0 when the counter is 0 (operator just cleared the block)', () => {
    expect(countConsecutiveFailures({ investigation: { consecutiveFailures: 0 } })).toBe(0);
  });

  test('reads the counter directly from the investigation marker', () => {
    expect(countConsecutiveFailures({ investigation: { consecutiveFailures: 3 } })).toBe(3);
    expect(countConsecutiveFailures({ investigation: { consecutiveFailures: 1 } })).toBe(1);
  });

  test('tolerates the marker being passed directly (not wrapped in a context)', () => {
    expect(countConsecutiveFailures({ consecutiveFailures: 2 })).toBe(2);
  });

  test('returns 0 for non-numeric / negative / NaN values (defensive)', () => {
    expect(countConsecutiveFailures({ investigation: { consecutiveFailures: 'three' } })).toBe(0);
    expect(countConsecutiveFailures({ investigation: { consecutiveFailures: -1 } })).toBe(0);
    expect(countConsecutiveFailures({ investigation: { consecutiveFailures: NaN } })).toBe(0);
    expect(countConsecutiveFailures({ investigation: { consecutiveFailures: null } })).toBe(0);
    expect(countConsecutiveFailures({ investigation: { consecutiveFailures: undefined } })).toBe(0);
  });

  test('the humanInterventions array is no longer the canonical source (regression test for the bug fix)', () => {
    // Even if the humanInterventions array has 5 failed entries, the
    // canonical counter on the marker is the single source of truth.
    // The runtime no longer walks humanInterventions for this — that
    // walking was the original (broken) implementation that was
    // abandoned in favor of the marker sidecar.
    const inv = {
      investigation: { consecutiveFailures: 1 },
      humanInterventions: [
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T00:00:00.000Z' },
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T01:00:00.000Z' },
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T02:00:00.000Z' },
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T03:00:00.000Z' },
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T04:00:00.000Z' },
      ],
    };
    expect(countConsecutiveFailures(inv)).toBe(1);
  });
});

// P0010.2.3 (ADR-059 audit D-2) — countBlockedSituations surface.
describe('countBlockedSituations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  test('returns 0 when there are no learning_contexts at all', () => {
    expect(countBlockedSituations(db)).toBe(0);
  });

  test('returns 0 when failed situations are below the threshold', () => {
    insertSituation(db, 'sit_below');
    insertLearningContext(db, 'sit_below', buildContextBody({
      investigation: {
        status: 'failed',
        error: 'transient blip',
        updatedAt: NOW,
        consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES - 1,
        blockedEmittedAt: '2026-08-25T00:00:00.000Z',
      },
    }));
    expect(countBlockedSituations(db)).toBe(0);
  });

  test('counts a failed+blocked situation exactly once (no double-fire)', () => {
    // Mirror of the R4-fix contract: the threshold-crossing tick stamps
    // blockedEmittedAt, and the count sees it as one blocked situation.
    insertSituation(db, 'sit_blocked_1');
    insertLearningContext(db, 'sit_blocked_1', buildContextBody({
      investigation: {
        status: 'failed',
        error: '3rd consecutive failure',
        updatedAt: NOW,
        consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
        blockedEmittedAt: '2026-08-25T00:00:00.000Z',
      },
    }));
    expect(countBlockedSituations(db)).toBe(1);
  });

  test('does NOT count a blocked situation that has been cleared (consecutiveFailures=0, no blockedEmittedAt)', () => {
    // After /clear-block, consecutiveFailures=0 and blockedEmittedAt is deleted.
    // The count must drop to 0 immediately.
    insertSituation(db, 'sit_cleared');
    insertLearningContext(db, 'sit_cleared', buildContextBody({
      investigation: {
        status: 'failed',
        error: 'cleared by operator',
        updatedAt: NOW,
        consecutiveFailures: 0,
        // no blockedEmittedAt
      },
    }));
    expect(countBlockedSituations(db)).toBe(0);
  });

  test('counts multiple blocked situations independently', () => {
    insertSituation(db, 'sit_a');
    insertSituation(db, 'sit_b');
    insertSituation(db, 'sit_c');
    const blocked = (_sitId: string) => buildContextBody({
      investigation: {
        status: 'failed',
        error: 'blocked',
        updatedAt: NOW,
        consecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
        blockedEmittedAt: '2026-08-25T00:00:00.000Z',
      },
    });
    insertLearningContext(db, 'sit_a', blocked('sit_a'));
    insertLearningContext(db, 'sit_b', blocked('sit_b'));
    // sit_c is below threshold — must NOT be counted.
    insertLearningContext(db, 'sit_c', buildContextBody({
      investigation: {
        status: 'failed',
        error: 'transient',
        updatedAt: NOW,
        consecutiveFailures: 1,
      },
    }));
    expect(countBlockedSituations(db)).toBe(2);
  });

  test('respects a custom threshold', () => {
    insertSituation(db, 'sit_low');
    insertLearningContext(db, 'sit_low', buildContextBody({
      investigation: {
        status: 'failed',
        error: 'failed twice',
        updatedAt: NOW,
        consecutiveFailures: 2,
        blockedEmittedAt: '2026-08-25T00:00:00.000Z',
      },
    }));
    // Default threshold (3) excludes it.
    expect(countBlockedSituations(db)).toBe(0);
    // Custom threshold (2) includes it.
    expect(countBlockedSituations(db, 2)).toBe(1);
  });
});
