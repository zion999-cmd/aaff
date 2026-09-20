// P0010.2 Fix 2 — recommendation.kind is derived from the main
// Investigation's stopReason, NOT the schema default ('act').
//
// The recommendation sub-turn prompt does not ask the Agent for a `kind`
// field. Before this fix, `runRecommendationTurn` parsed the reply with
// `RecommendationSchema.safeParse` directly, so every recommendation whose
// JSON lacked `kind` got Zod's backward-compat `default('act')` — an observe
// recommendation ("保持观察…") materialized as a yellow-chip to-do. The fix
// stamps `kind = deriveKindFromStopReason(existing.stopReason)` at the parse
// seam, and the materialized WorkItem must carry the SAME kind.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { HermesEvent } from '#platform/runtime/hermes/index.js';
import type { SituationChatClient } from '#platform/server/routes/situation-chat.js';
import { runRecommendationTurn } from '#platform/server/routes/situation-chat.js';
import { writeRecommendationResult } from '#app/runtime/loop/recommendation-to-output.js';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import type { LearningContext, Situation } from '#shared/schemas/learning-context.js';
import type { StopReason } from '#shared/schemas/investigation.js';

const SIT = 'sit_rec_kind_derive';
const NOW = '2026-09-01T00:00:00.000Z';

/** Minimal stub satisfying SituationChatClient — replays one message.complete. */
const makeClient = (reply: string): SituationChatClient => {
  const queued: Array<{ type: string; session_id?: string; payload?: { text?: string } }> = [
    { type: 'message.complete', session_id: 'sess-1', payload: { text: reply } },
  ];
  return {
    async connect() { /* noop */ },
    async createSession() { return { sessionId: 'sess-1' }; },
    async submitPrompt() { /* noop */ },
    onEvent(handler: (e: HermesEvent) => void) {
      for (const evt of queued) {
        handler(evt as unknown as HermesEvent);
      }
      return () => { /* noop */ };
    },
    close() { /* noop */ },
  };
};

/** A completed investigation whose recommendation reply will have NO `kind`. */
const baseExisting = (stopReason: StopReason): NonNullable<LearningContext['investigation']> => ({
  situationId: SIT,
  currentUnderstanding: '访客数与转化率走势相反。',
  knownEvidence: ['UV 下降 26.5%', 'CVR 上升 12%'],
  hypotheses: [{ statement: '伪异常噪声', status: 'supported' }],
  unknowns: [],
  nextQuestion: '',
  findings: [],
  judgment: '属于业务波动，按伪异常噪声处理。',
  stopReason,
  capabilityUsed: '',
  evidenceAcquired: [],
  status: 'completed',
  updatedAt: NOW,
});

// A recommendation reply WITHOUT `kind` — the Agent was never asked for one.
const OBSERVE_REPLY = JSON.stringify({
  recommendation: '保持观察，不做任何投放、商品或承接端调整；按伪异常噪声处理。',
  rationale: '访客下降与转化率提升同源，属于业务波动。',
  expectedOutcome: '持续观察 1-2 天确认波动收敛。',
  risks: [],
  prerequisites: [],
  humanNeeded: ['运营确认是否有活动投放'],
});

const insertSituation = (db: Database.Database) => {
  db.prepare(
    `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
       observed_at, description, tags, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SIT, 'ecommerce', 'anomaly_investigation',
    'jd_shop_001', 'shop', '祁门红茶旗舰店', 'jd',
    NOW, '访客数与转化率走势相反', JSON.stringify(['test']), 'open', NOW, NOW,
  );
};

const insertLearningContext = (db: Database.Database) => {
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
        description: '访客数与转化率走势相反',
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

const buildSituation = (db: Database.Database) => {
  const row = db.prepare('SELECT * FROM situations WHERE situation_id = ?').get(SIT) as Record<string, unknown>;
  return {
    situationId: row.situation_id,
    domain: row.domain,
    type: row.type,
    entity: { id: row.entity_id, type: row.entity_type, name: row.entity_name, platform: row.entity_platform },
    temporal: { observedAt: row.observed_at },
    description: row.description,
    tags: JSON.parse(String(row.tags ?? '[]')),
  };
};

const loadOutputs = (db: Database.Database): Array<Record<string, unknown>> => {
  const row = db
    .prepare('SELECT body FROM learning_contexts WHERE situation_id = ?')
    .get(SIT) as { body: string } | undefined;
  if (!row) return [];
  const body = JSON.parse(row.body) as { outputs?: unknown[] };
  return (body.outputs ?? []) as Array<Record<string, unknown>>;
};

describe('runRecommendationTurn — recommendation.kind derived from stopReason', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    insertSituation(db);
    insertLearningContext(db);
  });

  afterEach(() => {
    db.close();
  });

  const situation = (): Situation => buildSituation(db) as unknown as Situation;

  test('stopReason=observe → kind=observe (reply has no kind field)', async () => {
    const client = makeClient(OBSERVE_REPLY);
    const r = await runRecommendationTurn(client, 'sess-1', situation(), baseExisting('observe'));
    expect(r.ok).toBe(true);
    if (!r.ok || !r.recommendation) return;
    expect(r.recommendation.kind).toBe('observe');
    // The recommendation prose is preserved verbatim.
    expect(r.recommendation.recommendation).toContain('保持观察');
  });

  test('stopReason=judgment → kind=act', async () => {
    const client = makeClient(OBSERVE_REPLY);
    const r = await runRecommendationTurn(client, 'sess-1', situation(), baseExisting('judgment'));
    expect(r.ok).toBe(true);
    if (!r.ok || !r.recommendation) return;
    expect(r.recommendation.kind).toBe('act');
  });

  test('stopReason=missing_capability → kind=observe', async () => {
    const client = makeClient(OBSERVE_REPLY);
    const r = await runRecommendationTurn(client, 'sess-1', situation(), baseExisting('missing_capability'));
    expect(r.ok).toBe(true);
    if (!r.ok || !r.recommendation) return;
    expect(r.recommendation.kind).toBe('observe');
  });

  test('stopReason=ask_human → kind=observe', async () => {
    const client = makeClient(OBSERVE_REPLY);
    const r = await runRecommendationTurn(client, 'sess-1', situation(), baseExisting('ask_human'));
    expect(r.ok).toBe(true);
    if (!r.ok || !r.recommendation) return;
    expect(r.recommendation.kind).toBe('observe');
  });

  test('materialized output.kind matches the derived recommendation.kind (observe)', async () => {
    const client = makeClient(OBSERVE_REPLY);
    const existing = baseExisting('observe');
    const r = await runRecommendationTurn(client, 'sess-1', situation(), existing);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.recommendation) return;
    expect(r.recommendation.kind).toBe('observe');

    // Feed through the unified seam — the WorkItem must carry the SAME kind.
    const seam = writeRecommendationResult(db, situation(), existing, r.recommendation);
    expect(seam.materialize.created).toBe(true);
    const outputs = loadOutputs(db);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.kind).toBe('observe');
    expect(outputs[0]!.content).toContain('保持观察');
  });
});
