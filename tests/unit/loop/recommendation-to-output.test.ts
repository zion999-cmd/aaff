// P0010.2 — WorkItem materializer tests.
// The materializer is the single fix for audit dead-leg #3: when an
// investigation completes with a Recommendation, the WorkItem is persisted
// into `learning_contexts.body.outputs[]` with a deterministic outputId.
// Re-runs with the same content must NOT duplicate; different content must.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import {
  materializeWorkItem,
  type InvestigationLike,
} from '#app/runtime/loop/recommendation-to-output.js';

const SIT = 'sit_outputs_materialize';
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

const completedInvestigation = (overrides: Partial<{
  recommendation: string;
  rationale: string;
  judgment: string;
  updatedAt: string;
}> = {}): InvestigationLike => ({
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
});

const loadOutputs = (db: Database.Database): Array<Record<string, unknown>> => {
  const row = db
    .prepare('SELECT body FROM learning_contexts WHERE situation_id = ?')
    .get(SIT) as { body: string } | undefined;
  if (!row) return [];
  const body = JSON.parse(row.body) as { outputs?: unknown[] };
  return (body.outputs ?? []) as Array<Record<string, unknown>>;
};

describe('materializeWorkItem', () => {
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

  test('first call creates a WorkItem with a deterministic outputId (out_<16hex>)', () => {
    const result = materializeWorkItem(db, SIT, completedInvestigation());
    expect(result.created).toBe(true);
    if (!result.created) return;
    expect(result.outputId).toMatch(/^out_[a-f0-9]{16}$/);

    const outputs = loadOutputs(db);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.outputId).toBe(result.outputId);
    expect(outputs[0]!.situationId).toBe(SIT);
    expect(outputs[0]!.type).toBe('recommendation');
    expect(outputs[0]!.status).toBe('ready');
    expect(outputs[0]!.content).toBe('先排查昨日流量来源变化，再决定是否调价。');
  });

  test('second call with the same investigation is a no-op (idempotent)', () => {
    const inv = completedInvestigation();
    const first = materializeWorkItem(db, SIT, inv);
    const second = materializeWorkItem(db, SIT, inv);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    if (second.created) return;
    expect(second.reason).toBe('duplicate');
    expect(second.outputId).toBe(first.outputId);
    expect(loadOutputs(db)).toHaveLength(1);
  });

  test('different judgment produces a new WorkItem (different outputId)', () => {
    const a = materializeWorkItem(db, SIT, completedInvestigation({
      recommendation: '调整主推位',
      rationale: '流量端异常',
      judgment: 'judgment A: traffic-side',
    }));
    const b = materializeWorkItem(db, SIT, completedInvestigation({
      recommendation: '检查库存',
      rationale: '转化端异常',
      judgment: 'judgment B: conversion-side',
      updatedAt: '2026-08-25T02:00:00.000Z', // also a different updatedAt
    }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    if (!a.created || !b.created) return;
    expect(a.outputId).not.toBe(b.outputId);
    expect(loadOutputs(db)).toHaveLength(2);
  });

  test('returns no_recommendation when investigation has no recommendation (e.g. observe stopReason)', () => {
    // "observe" stopReason is the case where the agent decides to stop without
    // making a recommendation — the materializer should NOT create a WorkItem.
    const result = materializeWorkItem(db, SIT, {
      judgment: 'no anomaly detected, continue monitoring',
      updatedAt: '2026-08-25T01:00:00.000Z',
    });
    expect(result.created).toBe(false);
    if (result.created) return;
    expect(result.reason).toBe('no_recommendation');
    expect(loadOutputs(db)).toHaveLength(0);
  });

  test('returns no_investigation when investigation is null', () => {
    const result = materializeWorkItem(db, SIT, null);
    expect(result.created).toBe(false);
    if (result.created) return;
    expect(result.reason).toBe('no_investigation');
  });

  test('returns no_investigation when no learning_context row exists for the situation', () => {
    // Use a situation id that has no learning_contexts row.
    const ghostSit = 'sit_no_learning_context';
    db.prepare(
      `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
         observed_at, description, tags, lifecycle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ghostSit, 'ecommerce', 'anomaly_investigation',
      'jd_shop_001', 'shop', '祁门红茶旗舰店', 'jd',
      NOW, 'ghost', JSON.stringify(['test']), 'open', NOW, NOW,
    );
    const result = materializeWorkItem(db, ghostSit, completedInvestigation());
    expect(result.created).toBe(false);
    if (result.created) return;
    expect(result.reason).toBe('no_investigation');
  });
});
