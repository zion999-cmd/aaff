import { openDb } from '#platform/storage/connection.js';
import { loadSituation } from '#app/experience/learning-context-producer.js';

const SIT_ID = 'sit_kill_during_investigation_test';

// Simulate "process died 15 minutes ago in the middle of an investigation turn"
// — we seed a learning_context with an `investigating` marker whose startedAt
// is 15 min in the past. The recovery scan should pick this up as
// `interrupted` and re-fire on the next tick.
const STALE_START = new Date(Date.now() - 15 * 60_000).toISOString();

const db = openDb('data/agentfabric.db');

// Ensure the situation row exists (idempotent — if it already does, delete first)
db.prepare('DELETE FROM learning_contexts WHERE situation_id = ?').run(SIT_ID);
db.prepare('DELETE FROM situations WHERE situation_id = ?').run(SIT_ID);
db.prepare(`INSERT INTO situations
  (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
   observed_at, description, tags, lifecycle, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  SIT_ID, 'ecommerce', 'anomaly_investigation',
  'jd_shop_001', 'shop', '祁门红茶旗舰店', 'jd',
  STALE_START,
  'kill-during-investigation test: simulate process death 15min ago mid-turn',
  JSON.stringify(['kill_restart_test']),
  'open',
  STALE_START,
  STALE_START,
);

// Seed the learning context with an `investigating` marker from 15 min ago
const ctxBody = {
  contextId: 'ctx_kill_test',
  situation: {
    situationId: SIT_ID,
    domain: 'ecommerce',
    type: 'anomaly_investigation',
    entity: { id: 'jd_shop_001', type: 'shop' },
    temporal: { observedAt: STALE_START },
    description: 'kill-during-investigation test',
    tags: ['kill_restart_test'],
  },
  lifecycle: 'open',
  createdAt: STALE_START,
  updatedAt: STALE_START,
  observations: [],
  evidenceIds: [],
  signalIds: [],
  agentActivities: [],
  humanInterventions: [],
  actions: [],
  outcomes: [],
  summary: { capabilitiesUsed: [], agentRuntimes: [], humanActors: [], totalEvidence: 0, totalSignals: 0 },
  outputs: [],
  investigation: {
    situationId: SIT_ID,
    status: 'investigating',
    startedAt: STALE_START,
    updatedAt: STALE_START,
    consecutiveFailures: 0,
  },
};
db.prepare(`INSERT INTO learning_contexts
  (context_id, situation_id, lifecycle, created_at, updated_at, body)
  VALUES (?, ?, ?, ?, ?, ?)`).run(
  'ctx_kill_test',
  SIT_ID,
  'open',
  STALE_START,
  STALE_START,
  JSON.stringify(ctxBody),
);

const sit = loadSituation(db, SIT_ID);
console.log('Seeded situation:', sit?.situationId, 'with startedAt', STALE_START);
db.close();
