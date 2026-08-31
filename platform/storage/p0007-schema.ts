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

// P0010.2.5 closure — Area B "防止脏 Situation 再生":
//   The DB column `situations.lifecycle` is a free-form TEXT and the
//   Zod SituationSchema has no `lifecycle` field. The audit found 1
//   historical row with `lifecycle='completed'` (a value not in the
//   canonical set) that hid the situation from the recovery queue
//   (recovery-candidates.ts filters WHERE lifecycle IN ('open','partial')).
//
//   We DO NOT add a CHECK constraint (SQLite doesn't support
//   ALTER TABLE … ADD CONSTRAINT, and the existing rows already contain
//   historical drift). Instead we mirror the human_interventions pattern
//   above: a BEFORE INSERT/UPDATE trigger that raises ABORT on
//   non-canonical values, fail-closed at the write boundary.
//
//   Vocabulary compatibility is the CURRENT invariant: `situations.lifecycle`
//   shares the canonical set `{open, partial, mature}` with
//   `learning_contexts.lifecycle` (validated by `ContextLifecycleSchema` in
//   shared/schemas/learning-context.ts).
//
//   What is NOT an invariant: state-transition synchronization between the
//   two columns. The two lifecycles are written by DIFFERENT paths on
//   different schedules (situation producer writes 'open' on insert; p0007
//   route writes 'partial' on first human intervention; the
//   learning_contexts.lifecycle is set by the document body writer). We
//   DO NOT claim they must move in lockstep. DO NOT add a sync service,
//   reconciliation worker, or DB trigger that mutates one from the other.
//   P0010.3 will decide the long-term role of `situations.lifecycle`
//   (Terminal Lifecycle / Resolution Engine). Until then, the two columns
//   share a vocabulary but not a state machine.
//
//   This trigger does NOT introduce a new business state machine. It
//   enforces the existing canonical vocabulary at the write boundary,
//   matching what the Zod layer already does for learning_contexts.
export const SITUATION_LIFECYCLE_ALLOWED_VALUES: readonly string[] = [
  'open',
  'partial',
  'mature',
] as const;
const SITUATION_LIFECYCLE_GUARD_TRIGGER = 'trg_situations_lifecycle_guard';

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

  // P0010.2.11 — `latest_*` projection columns are added in
  // `applyP0007Schema` via idempotent PRAGMA-table_info-guarded ALTERs
  // (SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on the
  // versions we support). Statements below must remain CREATE-only so
  // `db.exec(STATEMENTS.join(';\n'))` stays re-runnable.

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

/**
 * P0010.2.5 closure — install the lifecycle-allowlist trigger on
 * `situations`. Mirrors the `human_interventions` pattern above. Idempotent.
 *
 * The historical drift (1 row with lifecycle='completed') is rewritten
 * by `scripts/fix-dirty-lifecycle.ts` — this trigger only protects
 * future writes.
 */
export const applySituationLifecycleGuard = (db: Database.Database): void => {
  const allowed = SITUATION_LIFECYCLE_ALLOWED_VALUES.map((v) => `'${v}'`).join(', ');
  const insertTriggerBody = `
    CREATE TRIGGER ${SITUATION_LIFECYCLE_GUARD_TRIGGER}
    BEFORE INSERT ON situations
    FOR EACH ROW
    WHEN NEW.lifecycle IS NULL OR NEW.lifecycle NOT IN (${allowed})
    BEGIN
      SELECT RAISE(ABORT, 'situations.lifecycle is not in the allowlist (open|partial|mature); see trg_situations_lifecycle_guard comment');
    END;
  `;
  const updateTriggerBody = `
    CREATE TRIGGER ${SITUATION_LIFECYCLE_GUARD_TRIGGER}_update
    BEFORE UPDATE OF lifecycle ON situations
    FOR EACH ROW
    WHEN NEW.lifecycle IS NULL OR NEW.lifecycle NOT IN (${allowed})
    BEGIN
      SELECT RAISE(ABORT, 'situations.lifecycle is not in the allowlist (open|partial|mature); see trg_situations_lifecycle_guard comment');
    END;
  `;
  db.exec(`
    DROP TRIGGER IF EXISTS ${SITUATION_LIFECYCLE_GUARD_TRIGGER};
    DROP TRIGGER IF EXISTS ${SITUATION_LIFECYCLE_GUARD_TRIGGER}_update;
  `);
  db.exec(insertTriggerBody);
  db.exec(updateTriggerBody);
};

/** Apply P0007 schema tables. Safe to call multiple times (IF NOT EXISTS). */
export const applyP0007Schema = (db: Database.Database): void => {
  db.exec(STATEMENTS.join(';\n'));
  // P0010.2.11 — idempotent ALTER for the 6 latest_* projection columns.
  // ALTER TABLE ADD COLUMN fails on re-run (column already exists) on
  // older SQLite; we guard with PRAGMA table_info so the migration is
  // safe to apply to both fresh and pre-existing DBs.
  const hasColumn = (col: string): boolean => {
    const rows = db.prepare(`PRAGMA table_info(situations)`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === col);
  };
  for (const col of [
    'latest_current_value',
    'latest_baseline_value',
    'latest_change_pct',
    'latest_evidence_id',
    'latest_evidence_acquired_at',
    'latest_evidence_content_hash',
  ]) {
    if (!hasColumn(col)) db.exec(`ALTER TABLE situations ADD COLUMN ${col} ${col === 'latest_change_pct' ? 'REAL' : col.startsWith('latest_evidence_') ? 'TEXT' : 'REAL'}`);
  }
  // P0010.1 Final Repair — Area C.2: install the type-allowlist enforcement.
  // Order matters: rewrite legacy rows first (so the trigger does not abort on
  // a pre-existing `action_intent` row that the operator never asked for), then
  // install the trigger so future writes are validated.
  rewriteLegacyActionIntentInterventions(db);
  applyHumanInterventionTypeGuard(db);
  // P0010.2.5 closure — Area B: install the lifecycle-allowlist trigger.
  // The historical drift has already been rewritten by
  // scripts/fix-dirty-lifecycle.ts before this runs (when applied at boot,
  // no drift is expected to exist; the trigger is a forward-looking guard).
  applySituationLifecycleGuard(db);
};
