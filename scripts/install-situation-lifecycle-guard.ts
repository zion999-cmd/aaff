// P0010.2.5 closure — install the new situations.lifecycle trigger.
//
// The trigger is added in `applyP0007Schema` (platform/storage/p0007-schema.ts),
// but the running DB has not been re-initialized since the file was edited.
// Running `applyP0007Schema` on the live DB installs the trigger without
// touching the existing data rows (the schema is IF NOT EXISTS; the
// trigger is DROP+CREATE).
//
// Idempotent: re-running on a DB that already has the trigger is a no-op.

import { openDb, closeDb } from '../platform/storage/connection.js';
import { applyP0007Schema } from '../platform/storage/p0007-schema.js';

const main = (): void => {
  const db = openDb();
  console.log('[install-triggers] Re-applying P0007 schema on live DB…');
  applyP0007Schema(db);

  const triggers = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  console.log('[install-triggers] Triggers installed:');
  for (const t of triggers) console.log(`  - ${t.name}`);

  // Quick smoke test: try to insert a bad row, should ABORT.
  const probe = db.transaction(() => {
    try {
      db.prepare(
        `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, observed_at, description, lifecycle, created_at, updated_at)
         VALUES ('__probe__', 'ecommerce', 'anomaly_investigation', 'x', 'shop', '2026-01-01', 'x', 'completed', '2026-01-01', '2026-01-01')`,
      ).run();
      return 'UNEXPECTED: insert succeeded — trigger NOT active';
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('situations.lifecycle is not in the allowlist')) {
        return 'OK: insert with lifecycle=completed was rejected by the trigger';
      }
      return `UNEXPECTED ERROR: ${msg}`;
    }
  });
  const result = probe();
  console.log(`[install-triggers] Smoke test: ${result}`);

  closeDb(db);
};

main();
