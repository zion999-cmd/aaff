// P0007 Schema — tables for Situations, Learning Contexts, and Human Interventions.
// Applied idempotently alongside the main schema.ts.

import type Database from 'better-sqlite3';

// P0010.1 Final Repair — Area C.2: ADR-047 declared the canonical operator surface
// to be the 4 high-level kinds — `response` / `correction` / `context_supplement` /
// `decision` — with `decision` sub-typed by `content.decision`. The Zod schema was
// updated in `shared/schemas/learning-context.ts`. This set is mirrored here as
// the database-level enforcement.
//
// SQLite does not support `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` for CHECK
// constraints (only FOREIGN KEYs). The standard alternative is a TRIGGER that
// raises ABORT on disallowed values, which is what the write path is going to hit
// just like a CHECK violation.
export const HUMAN_INTERVENTION_ALLOWED_TYPES: readonly string[] = [
  'response',
  'correction',
  'context_supplement',
  'decision',
] as const;
const HUMAN_INTERVENTION_TYPE_GUARD_TRIGGER =
  'trg_human_interventions_type_guard';

const STATEMENTS = [
  // ── Situations ──────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS situations (
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
  )`,

  // ── Learning Contexts (document store — JSON body) ──────
  `CREATE TABLE IF NOT EXISTS learning_contexts (
    context_id    TEXT PRIMARY KEY,
    situation_id  TEXT NOT NULL UNIQUE,
    lifecycle     TEXT NOT NULL DEFAULT 'open',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    body          TEXT NOT NULL,
    FOREIGN KEY (situation_id) REFERENCES situations(situation_id)
  )`,

  // ── Human Interventions ─────────────────────────────────
  `CREATE TABLE IF NOT EXISTS human_interventions (
    intervention_id         TEXT PRIMARY KEY,
    situation_id            TEXT NOT NULL,
    actor_id                TEXT NOT NULL,
    actor_role              TEXT NOT NULL,
    type                    TEXT NOT NULL,
    content                 TEXT NOT NULL DEFAULT '{}',
    summary                 TEXT NOT NULL,
    responds_to_activity_ids TEXT DEFAULT '[]',
    review_id               TEXT,
    action_id               TEXT,
    legacy_source           TEXT NOT NULL DEFAULT 'none',
    created_at              TEXT NOT NULL,
    FOREIGN KEY (situation_id) REFERENCES situations(situation_id)
  )`,

  // ── Indexes ─────────────────────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_situations_domain ON situations(domain)`,
  `CREATE INDEX IF NOT EXISTS idx_situations_lifecycle ON situations(lifecycle)`,
  `CREATE INDEX IF NOT EXISTS idx_situations_observed ON situations(observed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_interventions_situation ON human_interventions(situation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_interventions_type ON human_interventions(type)`,
  `CREATE INDEX IF NOT EXISTS idx_interventions_actor ON human_interventions(actor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contexts_situation ON learning_contexts(situation_id)`,
];

/**
 * Rewrite any pre-existing `human_interventions` row with `type='action_intent'`
 * (a value that was removed in ADR-047 / P0010.1 Final Repair Area C.1) to the
 * closest canonical equivalent (`response`). Idempotent. Returns the number of
 * rows rewritten so the caller can log it.
 */
export const rewriteLegacyActionIntentInterventions = (
  db: Database.Database,
): number => {
  const stmt = db.prepare(
    `UPDATE human_interventions
       SET type = 'response'
     WHERE type = 'action_intent'`,
  );
  const result = stmt.run();
  return Number(result.changes ?? 0);
};

/**
 * Install the type-allowlist trigger on `human_interventions`. SQLite has no
 * `ALTER TABLE … ADD CONSTRAINT … CHECK (…)`, so the constraint is enforced via
 * a BEFORE INSERT/UPDATE trigger that raises ABORT on disallowed values —
 * semantically identical to a CHECK constraint from the caller's perspective
 * (the write fails with an error before the row is touched).
 *
 * Idempotent: drops any prior version of the trigger before recreating it. Safe
 * to call from `applyP0007Schema` on every boot.
 */
export const applyHumanInterventionTypeGuard = (
  db: Database.Database,
): void => {
  const allowed = HUMAN_INTERVENTION_ALLOWED_TYPES.map((t) => `'${t}'`).join(', ');
  // The error message must be a single-quoted SQL literal with no embedded
  // single quotes (SQLite's RAISE() parser is strict about this). The full
  // allowlist is also written to the comment for operators reading the schema.
  const triggerBody = `
    CREATE TRIGGER ${HUMAN_INTERVENTION_TYPE_GUARD_TRIGGER}
    BEFORE INSERT ON human_interventions
    FOR EACH ROW
    WHEN NEW.type NOT IN (${allowed})
    BEGIN
      SELECT RAISE(ABORT, 'human_interventions.type is not in the allowlist; see trg_human_interventions_type_guard comment for the 4 allowed values');
    END;
  `;
  const updateTriggerBody = `
    CREATE TRIGGER ${HUMAN_INTERVENTION_TYPE_GUARD_TRIGGER}_update
    BEFORE UPDATE OF type ON human_interventions
    FOR EACH ROW
    WHEN NEW.type NOT IN (${allowed})
    BEGIN
      SELECT RAISE(ABORT, 'human_interventions.type is not in the allowlist; see trg_human_interventions_type_guard comment for the 4 allowed values');
    END;
  `;
  // Drop any prior versions (covers the rare case where the allowlist changed).
  db.exec(`
    DROP TRIGGER IF EXISTS ${HUMAN_INTERVENTION_TYPE_GUARD_TRIGGER};
    DROP TRIGGER IF EXISTS ${HUMAN_INTERVENTION_TYPE_GUARD_TRIGGER}_update;
  `);
  db.exec(triggerBody);
  db.exec(updateTriggerBody);
};

/** Apply P0007 schema tables. Safe to call multiple times (IF NOT EXISTS). */
export const applyP0007Schema = (db: Database.Database): void => {
  db.exec(STATEMENTS.join(';\n'));
  // P0010.1 Final Repair — Area C.2: install the type-allowlist enforcement.
  // Order matters: rewrite legacy rows first (so the trigger does not abort on
  // a pre-existing `action_intent` row that the operator never asked for), then
  // install the trigger so future writes are validated.
  rewriteLegacyActionIntentInterventions(db);
  applyHumanInterventionTypeGuard(db);
};
