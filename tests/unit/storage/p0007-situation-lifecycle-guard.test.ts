// P0010.2.5 closure — Unit tests for the `situations.lifecycle` allowlist
// trigger.
//
// The audit (P0010.2.5) found 1 historical row with
// `situations.lifecycle='completed'` — a value NOT in the canonical
// `ContextLifecycleSchema` set ({open, partial, mature}). The value
// was hidden from the recovery queue (recovery-candidates.ts filters
// `WHERE lifecycle IN ('open', 'partial')`) and so the row was never
// retried.
//
// This file pins the prevention: the trigger installed by
// `applySituationLifecycleGuard` MUST reject any non-canonical
// lifecycle value at the write boundary, so the same kind of dirty
// data cannot be re-introduced.
//
// Tested invariants (mirrored from
// tests/unit/storage/p0007-human-intervention-type-guard.test.ts):
//   1. Re-applying the trigger is idempotent.
//   2. INSERT with one of the 3 canonical values succeeds.
//   3. INSERT with a disallowed value (e.g. 'completed') raises.
//   4. UPDATE that changes lifecycle to a disallowed value raises.
//   5. The `SITUATION_LIFECYCLE_ALLOWED_VALUES` export matches the
//      canonical set exported by `ContextLifecycleSchema` (the
//      "two lifecycles in lockstep" invariant).

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyP0007Schema,
  applySituationLifecycleGuard,
  SITUATION_LIFECYCLE_ALLOWED_VALUES,
} from '#platform/storage/p0007-schema.js';
import { ContextLifecycleSchema } from '#shared/schemas/learning-context.js';

type Db = ReturnType<typeof Database>;

const makeDb = (): Db => {
  const db = new Database(':memory:');
  // applyP0007Schema creates `situations` (and the other tables) — keep
  // the schema source of truth in one place.
  applyP0007Schema(db);
  return db as unknown as Db;
};

const insertSituation = (
  db: Db,
  args: { situationId: string; lifecycle?: string | null },
): void => {
  // The trigger fires on `NEW.lifecycle` regardless of WHERE it came
  // from, so we can pass it as a literal, NULL, or rely on the column
  // DEFAULT. Use `'lifecycle' in args` so explicit `null` reaches the
  // SQL as NULL instead of being replaced by the `??` default.
  const lifecycle = 'lifecycle' in args ? args.lifecycle : 'open';
  db.prepare(
    `INSERT INTO situations (
       situation_id, domain, type, entity_id, entity_type, observed_at,
       description, lifecycle, created_at, updated_at
     ) VALUES (?, 'ecommerce', 'performance_analysis', 'p1', 'product', ?, '', ?, ?, ?)`,
  ).run(
    args.situationId,
    '2026-08-27T00:00:00.000Z',
    lifecycle,
    '2026-08-27T00:00:00.000Z',
    '2026-08-27T00:00:00.000Z',
  );
};

describe('situations.lifecycle allowlist trigger (P0010.2.5 closure)', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  test('canonical allowed values match ContextLifecycleSchema options', () => {
    // The "two lifecycles in lockstep" invariant: situations.lifecycle and
    // learning_contexts.lifecycle MUST share the same canonical set, so
    // a Zod-validated reading_context never sees a value that the DB
    // column refuses (or vice versa).
    expect([...SITUATION_LIFECYCLE_ALLOWED_VALUES].sort()).toEqual(
      [...ContextLifecycleSchema.options].sort(),
    );
  });

  test('re-applying the trigger is idempotent', () => {
    applySituationLifecycleGuard(db);
    applySituationLifecycleGuard(db);
    // Smoke: a canonical insert still works.
    expect(() => insertSituation(db, { situationId: 's-idem' })).not.toThrow();
  });

  test.each(SITUATION_LIFECYCLE_ALLOWED_VALUES)(
    'INSERT with lifecycle=%s is allowed',
    (lifecycle) => {
      expect(() =>
        insertSituation(db, { situationId: `s-${lifecycle}`, lifecycle }),
      ).not.toThrow();
      const row = db
        .prepare('SELECT lifecycle FROM situations WHERE situation_id = ?')
        .get(`s-${lifecycle}`) as { lifecycle: string };
      expect(row.lifecycle).toBe(lifecycle);
    },
  );

  test('INSERT with lifecycle=completed is rejected by the trigger (the P0010.2.5 bug)', () => {
    expect(() =>
      insertSituation(db, { situationId: 's-bad', lifecycle: 'completed' }),
    ).toThrow(/situations\.lifecycle is not in the allowlist/);
  });

  test('INSERT with lifecycle=closed is rejected (no Terminal Lifecycle yet)', () => {
    // P0010.3 will introduce `closed` semantics, but as a SEPARATE
    // column — not as a value of `situations.lifecycle`. Today, the
    // trigger must reject any attempt to overload the column.
    expect(() =>
      insertSituation(db, { situationId: 's-closed', lifecycle: 'closed' }),
    ).toThrow(/situations\.lifecycle is not in the allowlist/);
  });

  test('INSERT with lifecycle=NULL is rejected by the trigger (NEW.lifecycle IS NULL clause)', () => {
    // The trigger's WHEN clause is
    //   `NEW.lifecycle IS NULL OR NEW.lifecycle NOT IN (allowlist)`
    // — it catches NULL too, so the column's `NOT NULL` constraint never
    // gets a chance to fire for this path. The trigger is therefore
    // the single source of truth for "what is a valid lifecycle".
    expect(() =>
      insertSituation(db, { situationId: 's-null', lifecycle: null }),
    ).toThrow(/situations\.lifecycle is not in the allowlist/);
  });

  test('INSERT with an unknown lifecycle value is rejected', () => {
    expect(() =>
      insertSituation(db, { situationId: 's-unk', lifecycle: 'whatever' }),
    ).toThrow(/situations\.lifecycle is not in the allowlist/);
  });

  test('UPDATE that changes lifecycle to a disallowed value is rejected', () => {
    insertSituation(db, { situationId: 's-up', lifecycle: 'open' });
    expect(() =>
      db
        .prepare(`UPDATE situations SET lifecycle = 'completed' WHERE situation_id = ?`)
        .run('s-up'),
    ).toThrow(/situations\.lifecycle is not in the allowlist/);
    // The original row is untouched (RAISE ABORT rolls back the UPDATE).
    const row = db
      .prepare('SELECT lifecycle FROM situations WHERE situation_id = ?')
      .get('s-up') as { lifecycle: string };
    expect(row.lifecycle).toBe('open');
  });

  test('UPDATE that changes lifecycle within the canonical set is allowed', () => {
    insertSituation(db, { situationId: 's-promote', lifecycle: 'open' });
    expect(() =>
      db
        .prepare(`UPDATE situations SET lifecycle = 'partial' WHERE situation_id = ?`)
        .run('s-promote'),
    ).not.toThrow();
    const row = db
      .prepare('SELECT lifecycle FROM situations WHERE situation_id = ?')
      .get('s-promote') as { lifecycle: string };
    expect(row.lifecycle).toBe('partial');
  });
});
