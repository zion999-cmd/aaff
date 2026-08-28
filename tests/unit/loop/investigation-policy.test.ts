// P0010.2 — Investigation Policy tests.
// The policy is a pure decision function: given a situation id, the latest
// evidence timestamp, and a `waitingOnHuman` flag, return either an
// `investigate` decision with a reason, or a `skip` decision with a reason.
// No DB writes, no side effects — only `loadInvestigationFromLearningContext`
// is read.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { createInvestigationPolicy, isWaitingOnHuman } from '#app/runtime/loop/investigation-policy.js';

const SIT = 'sit_investigation_policy_test';
const OTHER_SIT = 'sit_other_policy_test';
const NOW = '2026-08-25T00:00:00.000Z';

const insertSituation = (db: Database.Database, situationId: string) => {
  db.prepare(
    `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
       observed_at, description, tags, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    situationId, 'ecommerce', 'anomaly_investigation',
    'jd_shop_001', 'shop', '祁门红茶旗舰店', 'jd',
    NOW, 'test situation', JSON.stringify(['test']), 'open', NOW, NOW,
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
    'open',
    NOW,
    NOW,
    JSON.stringify(body),
  );
};

const buildContextBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contextId: 'ctx_test',
  situation: {
    situationId: SIT,
    domain: 'ecommerce',
    type: 'anomaly_investigation',
    entity: { id: 'jd_shop_001', type: 'shop' },
    temporal: { observedAt: NOW },
    description: 'test',
    tags: ['test'],
  },
  lifecycle: 'open',
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
  ...overrides,
});

describe('createInvestigationPolicy', () => {
  let db: Database.Database;
  let policy: ReturnType<typeof createInvestigationPolicy>;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    insertSituation(db, SIT);
    insertSituation(db, OTHER_SIT);
    policy = createInvestigationPolicy(db);
  });

  afterEach(() => {
    db.close();
  });

  test('returns no_evidence when latestContentHash is null', () => {
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: null,
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'no_evidence' });
  });

  test('returns no_situation when situationId is empty', () => {
    const decision = policy.shouldInvestigate({
      situationId: '',
      latestContentHash: 'hash-123',
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'no_situation' });
  });

  test('returns new_situation when no prior investigation exists', () => {
    // No learning context row → loadInvestigationFromLearningContext returns null.
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-new',
    });
    expect(decision).toEqual({ kind: 'investigate', reason: 'new_situation' });
  });

  test('returns no_meaningful_change when prior.evidenceContentHash === latestContentHash', () => {
    // Prior completed investigation has the SAME content hash as the latest
    // evidence → the underlying metric did not move → no re-investigation.
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'completed',
        judgment: 'existing judgment',
        stopReason: 'judgment',
        updatedAt: '2026-08-25T12:00:00.000Z',
        evidenceContentHash: 'hash-same',
      },
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-same',
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'no_meaningful_change' });
  });

  test('returns no_situation_specific_evidence_change when prior.evidenceContentHash !== latestContentHash (P0010.2.x followup)', () => {
    // P0010.2.x followup — The Loop's `latestContentHash` is a single
    // global hash (most recent evidence file in the entire platform
    // store). The hash moving from A → B is NOT proof that THIS
    // Situation's underlying metric moved — a different capability's
    // re-acquisition (e.g. the daily `trade.overview` cron at 00:00)
    // writes a new evidence file with a new hash, and that hash
    // becomes the global "latest" even when nothing about the
    // Situation's evidence set changed. We do not yet have a
    // per-Situation evidence-dependency model, so the default is skip
    // (do not guess by re-firing on unrelated platform evidence churn).
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'completed',
        judgment: 'existing judgment',
        stopReason: 'judgment',
        updatedAt: '2026-08-25T12:00:00.000Z',
        evidenceContentHash: 'hash-A',
      },
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-B',
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'no_situation_specific_evidence_change' });
  });

  test('global evidence hash churn alone does NOT re-trigger investigation (invariant)', () => {
    // P0010.2.x followup — explicit regression test. The diagnostic
    // from the read-only trace (2026-08-28): the Loop's
    // `readLatestContentHash` returns the SHA-256 of the most recent
    // evidence file in the entire platform store. A different
    // capability re-acquiring ANY data point produces a new evidence
    // file, which moves the global hash, which used to flip every
    // open Situation into `meaningful_new_evidence` and re-fire every
    // investigation. After this fix, the same Situation with the
    // same prior content marker is skipped, regardless of how the
    // global hash moved.
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'completed',
        judgment: 'existing judgment',
        stopReason: 'judgment',
        updatedAt: '2026-08-25T12:00:00.000Z',
        evidenceContentHash: 'hash-prior',
      },
    }));
    // Simulate: the platform's most recent evidence file changed
    // (e.g. trade.overview's daily 00:00 cron wrote a new file), so
    // the Loop sees a new global latestContentHash. Without a
    // per-Situation evidence-dependency proof, the Situation must NOT
    // be re-investigated.
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-from-other-capability',
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'no_situation_specific_evidence_change' });
    // The skip reason is a stable, observable signal (not just a
    // silent drop) — operators can see in the trace panel that the
    // Situation was skipped because the global hash moved but we
    // cannot prove Situation-specific change.
    expect(decision.kind).toBe('skip');
  });

  test('returns no_meaningful_change when prior is completed legacy (no content marker)', () => {
    // Older completed investigations (P0010.1) did not stamp the
    // contentHash sidecar. The continuous-runtime default is to skip
    // — we have no honest way to compare content, and the alternative
    // is the "infinite retry" anti-pattern on already-investigated
    // situations. New evidence (different content_hash) gets
    // re-investigated normally via a fresh situation creation.
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'completed',
        judgment: 'legacy investigation',
        stopReason: 'judgment',
        updatedAt: '2026-08-25T12:00:00.000Z',
        // no evidenceContentHash field
      },
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-latest',
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'no_meaningful_change' });
  });

  test('returns no_meaningful_change when prior failed on the SAME content (do not loop on a slow LLM)', () => {
    // The prior attempt failed but its recorded contentHash equals the
    // current latestContentHash — re-running the same broken turn on
    // the same evidence is the "infinite retry" anti-pattern. Skip.
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'failed',
        error: 'previous turn timed out',
        updatedAt: '2026-08-25T12:00:00.000Z',
        evidenceContentHash: 'hash-same',
      },
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-same',
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'no_meaningful_change' });
  });

  test('returns no_situation_specific_evidence_change when prior failed and global hash changed (P0010.2.x followup)', () => {
    // P0010.2.x followup — Prior failed on hash-A; the global
    // latestContentHash is now hash-B. The hash move is not enough
    // proof of Situation-specific change (see the invariant test
    // above). The natural decision is skip; only the recovery scan
    // (recoveryHint === 'failed_retryable') is allowed to upgrade
    // this to investigate on the operator's explicit intent, and the
    // recovery semantics are intentionally unchanged by this fix.
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'failed',
        error: 'previous turn timed out',
        updatedAt: '2026-08-25T12:00:00.000Z',
        evidenceContentHash: 'hash-A',
      },
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-B',
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'no_situation_specific_evidence_change' });
  });

  test('returns new_situation when prior is failed legacy (no content marker)', () => {
    // Older failed investigations (P0010.1) have no contentHash sidecar.
    // Best-effort: treat as a fresh attempt.
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'failed',
        error: 'legacy failure',
        updatedAt: '2026-08-25T12:00:00.000Z',
        // no evidenceContentHash
      },
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-latest',
    });
    expect(decision).toEqual({ kind: 'investigate', reason: 'new_situation' });
  });

  test('returns waiting_human when ctx.waitingOnHuman is true (short-circuits other checks)', () => {
    // No learning context row, has evidence — would normally be new_situation.
    // waitingOnHuman short-circuits.
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-latest',
      waitingOnHuman: true,
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'waiting_human' });
  });

  // P0010.2.2 — Recovery reason rewriting.
  // The hint is purely cosmetic for the `reason` field; the actual
  // decision is still content-driven. These cases pin the contract so
  // a future refactor cannot silently change the go/no-go behavior.
  test('recovery_no_investigation rewrites the investigate reason (no prior investigation)', () => {
    // No learning context row, has evidence, recoveryHint='no_investigation'.
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-latest',
      recoveryHint: 'no_investigation',
    });
    expect(decision).toEqual({ kind: 'investigate', reason: 'recovery_no_investigation' });
  });

  test('recovery_interrupted rewrites the investigate reason (interrupted marker, same content)', () => {
    // Prior has a contentHash sidecar equal to the latest (so the
    // content-driven decision is skip), but recoveryHint says
    // 'interrupted' → the recovery should still investigate the
    // interrupted turn. The recovery scan lives in recovery-candidates.ts
    // and only emits an interrupted candidate when startedAt is past
    // the stale window; the policy trusts the hint.
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'investigating',
        startedAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
        evidenceContentHash: 'hash-same',
      },
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-same',
      recoveryHint: 'interrupted',
    });
    expect(decision).toEqual({ kind: 'investigate', reason: 'recovery_interrupted' });
  });

  test('recovery_failed_retryable rewrites the investigate reason (failed, count below threshold)', () => {
    // Prior has a contentHash sidecar equal to the latest, but the
    // recovery scan flagged it as retryable (consecutive failures
    // below the threshold). The hint still drives investigate — the
    // content-driven skip is overridden by the recovery scan's
    // judgment that this is a different problem space (a stuck turn,
    // not a stable completed state).
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'failed',
        error: 'previous turn timed out',
        updatedAt: '2026-08-25T12:00:00.000Z',
        evidenceContentHash: 'hash-same',
      },
      humanInterventions: [
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T12:00:00.000Z' },
      ],
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-same',
      recoveryHint: 'failed_retryable',
      consecutiveFailures: 1,
    });
    expect(decision).toEqual({ kind: 'investigate', reason: 'recovery_failed_retryable' });
  });

  test('no recoveryHint keeps the default reason (new_situation, no prior)', () => {
    // The producer's current-tick output path. No hint means "this
    // came from the producer, not the recovery scan" → the reason is
    // the canonical 'new_situation', not a recovery_* reason.
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-latest',
    });
    expect(decision).toEqual({ kind: 'investigate', reason: 'new_situation' });
  });

  // P0010.2.2 — Blocked threshold.
  // N consecutive failures (default 3) → blocked_runtime_failure. The
  // operator must explicitly POST /clear-block to resume. The hint
  // rewrite is irrelevant when the decision is skip (the operator
  // doesn't see an investigate reason).
  test('blocked_runtime_failure when consecutiveFailures >= maxConsecutiveFailures', () => {
    insertLearningContext(db, SIT, buildContextBody({
      investigation: { status: 'failed', error: 'x', updatedAt: NOW },
      humanInterventions: [
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T00:00:00.000Z' },
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T01:00:00.000Z' },
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T02:00:00.000Z' },
      ],
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-latest',
      consecutiveFailures: 3,
      maxConsecutiveFailures: 3,
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'blocked_runtime_failure' });
  });

  test('blocked_runtime_failure takes precedence over no_meaningful_change', () => {
    // Even when the content is identical (so the natural decision
    // would be no_meaningful_change), the threshold wins. The runtime
    // is the single source of truth for "should we fire again?" — it
    // does not let the content-driven decision mask the operator
    // block state.
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'failed',
        error: 'still failing',
        evidenceContentHash: 'hash-same',
        updatedAt: NOW,
      },
      humanInterventions: [
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T00:00:00.000Z' },
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T01:00:00.000Z' },
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T02:00:00.000Z' },
      ],
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-same',
      consecutiveFailures: 3,
      maxConsecutiveFailures: 3,
    });
    expect(decision).toEqual({ kind: 'skip', reason: 'blocked_runtime_failure' });
  });

  test('below the threshold the policy still investigates (no block)', () => {
    insertLearningContext(db, SIT, buildContextBody({
      investigation: { status: 'failed', error: 'x', updatedAt: NOW },
      humanInterventions: [
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T00:00:00.000Z' },
        { type: 'investigation', content: { status: 'failed' }, at: '2026-08-25T01:00:00.000Z' },
      ],
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-latest',
      consecutiveFailures: 2,
      maxConsecutiveFailures: 3,
    });
    expect(decision.kind).toBe('investigate');
    // Reason is the content-driven one (failed legacy, no sidecar → new_situation).
    expect(decision).toEqual({ kind: 'investigate', reason: 'new_situation' });
  });

  test('operator override resets the consecutive-failure counter on the investigation marker', () => {
    // The /clear-block route writes consecutiveFailures=0 to the
    // investigation marker. After the reset, the policy sees a
    // 0-count investigation and does not block.
    insertLearningContext(db, SIT, buildContextBody({
      investigation: {
        status: 'failed',
        error: 'x',
        updatedAt: NOW,
        consecutiveFailures: 0, // operator just cleared
      },
    }));
    const decision = policy.shouldInvestigate({
      situationId: SIT,
      latestContentHash: 'hash-latest',
      maxConsecutiveFailures: 3,
    });
    expect(decision.kind).toBe('investigate');
  });
});

describe('isWaitingOnHuman', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    insertSituation(db, SIT);
  });

  afterEach(() => {
    db.close();
  });

  test('returns false when no learning context exists', () => {
    expect(isWaitingOnHuman(db, SIT)).toBe(false);
  });

  test('returns false when no defer intervention is recorded', () => {
    insertLearningContext(db, SIT, buildContextBody({
      humanInterventions: [
        { type: 'feedback', content: { comment: 'good' }, at: NOW },
      ],
    }));
    expect(isWaitingOnHuman(db, SIT)).toBe(false);
  });

  test('returns true when a decision:defer intervention is present', () => {
    insertLearningContext(db, SIT, buildContextBody({
      humanInterventions: [
        { type: 'decision', content: { decision: 'defer' }, at: NOW },
      ],
    }));
    expect(isWaitingOnHuman(db, SIT)).toBe(true);
  });

  test('returns false for non-defer decision (accept)', () => {
    insertLearningContext(db, SIT, buildContextBody({
      humanInterventions: [
        { type: 'decision', content: { decision: 'accept' }, at: NOW },
      ],
    }));
    expect(isWaitingOnHuman(db, SIT)).toBe(false);
  });
});
