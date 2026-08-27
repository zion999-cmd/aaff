// P0010.2.x — writeRecommendationResult unified seam tests.
//
// The seam is the single fix for audit dead-leg #3 (the
// "已生成建议 + 生成建议 按钮" contradiction that came from /recommend
// writing to `body.investigation.recommendation` while only /chat
// materialized the WorkItem). After this seam, BOTH paths call
// `writeRecommendationResult` and the WorkItem-vs-Recommendation
// parity is enforced by the seam itself.
//
// These tests pin:
//   1. /chat turn-end calls the seam with the recommendation, gets a
//      `created: true` materialize result, persists one WorkItem.
//   2. /recommend (manual regenerate) with the same recommendation is
//      a no-op for outputs[] (idempotent on content fingerprint).
//   3. /recommend with a different recommendation creates a NEW
//      WorkItem (different judgment → different fingerprint).
//   4. Passing `recommendation: null` is a total no-op (no error, no
//      write, no WorkItem).

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { writeRecommendationResult } from '#app/runtime/loop/recommendation-to-output.js';

const SIT = 'sit_write_recommendation';
const NOW = '2026-08-25T00:00:00.000Z';

const insertSituation = (db: Database.Database) => {
  db.prepare(
    `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
       observed_at, description, tags, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SIT, 'ecommerce', 'anomaly_investigation',
    'jd_shop_001', 'shop', '祁门红茶旗舰店', 'jd',
    NOW, 'test situation', JSON.stringify(['test']), 'open', NOW, NOW,
  );
};

const insertEmptyLearningContext = (db: Database.Database) => {
  db.prepare(
    `INSERT INTO learning_contexts (context_id, situation_id, lifecycle, created_at, updated_at, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `ctx_${SIT}`, SIT, 'open', NOW, NOW,
    JSON.stringify({
      contextId: `ctx_${SIT}`,
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
      summary: { capabilitiesUsed: [], agentRuntimes: [], humanActors: [], totalEvidence: 0, totalSignals: 0 },
      outputs: [],
    }),
  );
};

const loadSituation = (db: Database.Database) => {
  return db.prepare('SELECT * FROM situations WHERE situation_id = ?').get(SIT) as any;
};

const loadOutputs = (db: Database.Database): Array<Record<string, unknown>> => {
  const row = db
    .prepare('SELECT body FROM learning_contexts WHERE situation_id = ?')
    .get(SIT) as { body: string } | undefined;
  if (!row) return [];
  const body = JSON.parse(row.body) as { outputs?: unknown[] };
  return (body.outputs ?? []) as Array<Record<string, unknown>>;
};

const completedInvestigation = (overrides: Partial<{
  recommendation: string;
  rationale: string;
  judgment: string;
  updatedAt: string;
}> = {}) => ({
  judgment: overrides.judgment ?? 'GMV dropped 30% week-over-week — likely traffic-side.',
  updatedAt: overrides.updatedAt ?? '2026-08-25T01:00:00.000Z',
  recommendation: {
    recommendation: overrides.recommendation ?? '先排查昨日流量来源变化，再决定是否调价。',
    rationale: overrides.rationale ?? 'Linked judgment',
    expectedOutcome: '稳定 GMV',
    risks: [],
    prerequisites: [],
    humanNeeded: [],
  },
  status: 'completed' as const,
  stopReason: 'judgment' as const,
  situationId: SIT,
  requiredEvidence: [],
  knownEvidence: [],
  currentUnderstanding: 'Current understanding text',
  hypotheses: [],
  startedAt: NOW,
  createdAt: NOW,
});

const buildSituation = (db: Database.Database) => {
  const row = loadSituation(db);
  return {
    situationId: row.situation_id,
    domain: row.domain,
    type: row.type,
    entity: { id: row.entity_id, type: row.entity_type, name: row.entity_name, platform: row.entity_platform },
    temporal: { observedAt: row.observed_at, windowStart: row.window_start, windowEnd: row.window_end },
    description: row.description,
    tags: JSON.parse(row.tags ?? '[]'),
    lifecycle: row.lifecycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as any;
};

describe('writeRecommendationResult — unified seam', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    insertSituation(db);
    insertEmptyLearningContext(db);
  });

  afterEach(() => {
    db.close();
  });

  test('/chat turn-end: writes recommendation, materializes a WorkItem', () => {
    const situation = buildSituation(db);
    const inv = completedInvestigation();
    const r = writeRecommendationResult(
      db,
      situation,
      inv as any,
      (inv as any).recommendation,
    );
    expect(r.investigationPersisted).toBe(true);
    expect(r.materialize.created).toBe(true);
    if (!r.materialize.created) return;
    expect(r.materialize.outputId).toMatch(/^out_[a-f0-9]{16}$/);
    const outputs = loadOutputs(db);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.outputId).toBe(r.materialize.outputId);
  });

  test('/recommend with the SAME content is idempotent (audit dead-leg #3 fix)', () => {
    const situation = buildSituation(db);
    const inv = completedInvestigation();
    // /chat writes first
    const first = writeRecommendationResult(db, situation, inv as any, (inv as any).recommendation);
    expect(first.materialize.created).toBe(true);
    // /recommend with the same content — no new WorkItem
    const second = writeRecommendationResult(db, situation, inv as any, (inv as any).recommendation);
    expect(second.materialize.created).toBe(false);
    if (second.materialize.created) return;
    expect(second.materialize.reason).toBe('duplicate');
    expect(loadOutputs(db)).toHaveLength(1);
  });

  test('/recommend with a DIFFERENT recommendation creates a NEW WorkItem', () => {
    const situation = buildSituation(db);
    const inv1 = completedInvestigation();
    writeRecommendationResult(db, situation, inv1 as any, (inv1 as any).recommendation);
    // Operator pushes a follow-up question; Agent produces a new
    // recommendation. /recommend writes the new content.
    const newRec = {
      recommendation: '调整主推位 + 同步提高广告出价',
      rationale: 'traffic + position',
      expectedOutcome: '稳定 GMV',
      risks: [],
      prerequisites: [],
      humanNeeded: [],
    };
    const inv2 = completedInvestigation({
      judgment: 'judgment B: more direct',
      updatedAt: '2026-08-25T02:00:00.000Z',
    });
    (inv2 as any).recommendation = newRec;
    const r = writeRecommendationResult(db, situation, inv2 as any, newRec);
    expect(r.materialize.created).toBe(true);
    const outputs = loadOutputs(db);
    expect(outputs).toHaveLength(2);
  });

  test('null recommendation is a total no-op (no error, no write)', () => {
    const situation = buildSituation(db);
    const inv = completedInvestigation();
    const r = writeRecommendationResult(db, situation, inv as any, null);
    expect(r.investigationPersisted).toBe(false);
    expect(r.materialize.created).toBe(false);
    if (r.materialize.created) return;
    expect(r.materialize.reason).toBe('no_recommendation');
    expect(loadOutputs(db)).toHaveLength(0);
  });

  test('undefined recommendation is also a total no-op', () => {
    const situation = buildSituation(db);
    const inv = completedInvestigation();
    const r = writeRecommendationResult(db, situation, inv as any, undefined);
    expect(r.investigationPersisted).toBe(false);
    expect(r.materialize.created).toBe(false);
    if (r.materialize.created) return;
    expect(r.materialize.reason).toBe('no_recommendation');
  });
});
