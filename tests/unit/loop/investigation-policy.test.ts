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

  test('returns meaningful_new_evidence when prior.evidenceContentHash !== latestContentHash', () => {
    // The prior recorded hash-A; the latest evidence is hash-B. The metric
    // moved → re-investigate.
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
    expect(decision).toEqual({ kind: 'investigate', reason: 'meaningful_new_evidence' });
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

  test('returns meaningful_new_evidence when prior failed but new evidence arrived', () => {
    // The prior attempt failed on hash-A. The latest evidence is hash-B.
    // A new attempt with fresh content is worth trying.
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
    expect(decision).toEqual({ kind: 'investigate', reason: 'meaningful_new_evidence' });
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
