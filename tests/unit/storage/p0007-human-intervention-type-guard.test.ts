// Unit tests for P0010.1 Final Repair — Area C.2: type-allowlist enforcement on
// `human_interventions.type`.
//
// SQLite does not support `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` for CHECK
// constraints; the constraint is enforced via a BEFORE INSERT/UPDATE trigger
// that RAISEs ABORT. These tests pin the behavior so the wire contract (Zod
// enum) and the storage contract (trigger) cannot drift.
//
// Tested invariants:
//   1. Pre-existing `action_intent` rows are rewritten to `response` on apply.
//   2. Re-applying is idempotent (no error, no double-fire).
//   3. INSERT with one of the 4 canonical types succeeds.
//   4. INSERT with a disallowed type raises.
//   5. UPDATE that changes type to a disallowed value raises.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyHumanInterventionTypeGuard,
  applyP0007Schema,
  HUMAN_INTERVENTION_ALLOWED_TYPES,
  rewriteLegacyActionIntentInterventions,
} from '#platform/storage/p0007-schema.js';

type Db = ReturnType<typeof Database>;

const SCHEMA_SQL = `
  CREATE TABLE situations (
    situation_id   TEXT PRIMARY KEY,
    domain         TEXT NOT NULL,
    type           TEXT NOT NULL,
    entity_id      TEXT NOT NULL,
    entity_type    TEXT NOT NULL,
    entity_name    TEXT,
    entity_platform TEXT,
    observed_at    TEXT NOT NULL,
    window_start   TEXT,
    window_end     TEXT,
    description    TEXT NOT NULL,
    tags           TEXT DEFAULT '[]',
    lifecycle      TEXT NOT NULL DEFAULT 'open',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )
`;

const makeDb = (): Db => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db as unknown as Db;
};

const seedSituation = (db: Db, situationId: string): void => {
  db.prepare(
    `INSERT INTO situations (
       situation_id, domain, type, entity_id, entity_type, observed_at,
       description, created_at, updated_at
     ) VALUES (?, 'ecommerce', 'performance_analysis', 'p1', 'product', ?, '', ?, ?)`,
  ).run(situationId, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
};

const insertIntervention = (
  db: Db,
  args: { id: string; situationId: string; type: string; content?: string },
): void => {
  db.prepare(
    `INSERT INTO human_interventions (
       intervention_id, situation_id, actor_id, actor_role, type, content,
       summary, created_at
     ) VALUES (?, ?, 'u1', 'operator', ?, ?, 't', '2026-08-25T00:00:00.000Z')`,
  ).run(args.id, args.situationId, args.type, args.content ?? '{}');
};

describe('human_interventions type-allowlist trigger (P0010.1 Area C.2)', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    // Replicate the post-applyP0007Schema table layout that includes the
    // human_interventions table (applyP0007Schema also creates it, so we just
    // call that helper to keep the schema source-of-truth in one place).
    applyP0007Schema(db);
  });

  afterEach(() => {
    db.close();
  });

  test('rewrites pre-existing action_intent rows to response', () => {
    seedSituation(db, 's1');
    // Pre-seed an action_intent row directly (bypassing the trigger that does
    // not exist yet on this fresh in-memory DB — we DROP and recreate the
    // trigger after re-applying to simulate "legacy data the trigger must
    // tolerate"). Insert first, then apply the guard; the helper itself must
    // perform the rewrite.
    db.prepare('DROP TRIGGER IF EXISTS trg_human_interventions_type_guard').run();
    db.prepare('DROP TRIGGER IF EXISTS trg_human_interventions_type_guard_update').run();
    insertIntervention(db, { id: 'i1', situationId: 's1', type: 'action_intent' });
    const rewritten = rewriteLegacyActionIntentInterventions(db);
    expect(rewritten).toBe(1);
    const row = db.prepare('SELECT type FROM human_interventions WHERE intervention_id = ?').get('i1') as { type: string };
    expect(row.type).toBe('response');
  });

  test('re-applying the trigger is idempotent', () => {
    applyHumanInterventionTypeGuard(db);
    applyHumanInterventionTypeGuard(db);
    // Smoke: a canonical insert still works.
    seedSituation(db, 's2');
    expect(() => insertIntervention(db, { id: 'i2', situationId: 's2', type: 'response' })).not.toThrow();
  });

  test.each(HUMAN_INTERVENTION_ALLOWED_TYPES)(
    'INSERT with type=%s is allowed',
    (type) => {
      seedSituation(db, `s-${type}`);
      expect(() => insertIntervention(db, { id: `i-${type}`, situationId: `s-${type}`, type })).not.toThrow();
      const row = db.prepare('SELECT type FROM human_interventions WHERE intervention_id = ?').get(`i-${type}`) as { type: string };
      expect(row.type).toBe(type);
    },
  );

  test('INSERT with type=action_intent is rejected by the trigger', () => {
    seedSituation(db, 's-bad');
    expect(() =>
      insertIntervention(db, { id: 'i-bad', situationId: 's-bad', type: 'action_intent' }),
    ).toThrow(/human_interventions\.type is not in the allowlist/);
  });

  test('INSERT with an unknown type is rejected by the trigger', () => {
    seedSituation(db, 's-unk');
    expect(() =>
      insertIntervention(db, { id: 'i-unk', situationId: 's-unk', type: 'whatever' }),
    ).toThrow(/human_interventions\.type is not in the allowlist/);
  });

  test('UPDATE that changes type to a disallowed value is rejected', () => {
    seedSituation(db, 's-up');
    insertIntervention(db, { id: 'i-up', situationId: 's-up', type: 'response' });
    expect(() =>
      db
        .prepare(`UPDATE human_interventions SET type = 'action_intent' WHERE intervention_id = ?`)
        .run('i-up'),
    ).toThrow(/human_interventions\.type is not in the allowlist/);
    // The original row is untouched (RAISE ABORT rolls back the UPDATE).
    const row = db.prepare('SELECT type FROM human_interventions WHERE intervention_id = ?').get('i-up') as { type: string };
    expect(row.type).toBe('response');
  });

  test('rewrite helper is a no-op when there are no legacy rows', () => {
    expect(rewriteLegacyActionIntentInterventions(db)).toBe(0);
  });
});
