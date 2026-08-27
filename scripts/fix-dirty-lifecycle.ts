// P0010.2.5 closure — One-shot fix of dirty `situations.lifecycle` rows.
//
// Audit (2026-08-27) found 1 row with a non-canonical lifecycle value:
//   sit_68065996f8fcd48b0842   lifecycle='completed'
//   learning_contexts.body.investigation.status='failed'
//   learning_contexts.body.investigation.consecutiveFailures=1
//   0 human_interventions
//
// The DB column `situations.lifecycle` has no CHECK constraint and the
// Zod SituationSchema has no `lifecycle` field — so historical / buggy
// writes can persist any string. The canonical set is defined by
// `ContextLifecycleSchema` in `shared/schemas/learning-context.ts`:
// 'open' | 'partial' | 'mature'.
//
// Why this row is broken:
//   - investigation.status='failed' (agent_timeout) means the Loop SHOULD
//     retry it on the next tick — but the recovery-candidates scan filters
//     out rows where situations.lifecycle is NOT in ('open', 'partial').
//   - So the 'completed' value hides the row from the recovery queue.
//     The row will never be retried.
//
// This script rewrites the dirty value to the canonical 'open' (no
// human_interventions → not 'partial'; investigation failed → not
// 'mature'/'completed' since we have no Terminal Lifecycle state machine
// yet). After the fix, the Loop's recovery scan will pick the row up
// and the next Hermes tick will retry the investigation.
//
// Idempotent: re-running finds 0 dirty rows and is a no-op.
//
// Usage:
//   npx tsx scripts/fix-dirty-lifecycle.ts            # apply
//   npx tsx scripts/fix-dirty-lifecycle.ts --dry-run  # preview only

import { openDb, closeDb } from '../platform/storage/connection.js';

const CANONICAL_LIFECYCLE: readonly string[] = ['open', 'partial', 'mature'];

interface DirtyRow {
  situation_id: string;
  lifecycle: string;
  intervention_count: number;
  investigation_status: string | null;
  consecutive_failures: number | null;
}

interface FixDecision {
  situationId: string;
  oldLifecycle: string;
  newLifecycle: string;
  reason: string;
}

const main = (): void => {
  const dryRun = process.argv.includes('--dry-run');
  const db = openDb();

  console.log(`[fix-lifecycle] P0010.2.5 closure — non-canonical situations.lifecycle purge — ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  console.log(`[fix-lifecycle] DB: ${process.env.DB_PATH ?? './data/agentfabric.db'}`);
  console.log(`[fix-lifecycle] Canonical set: ${CANONICAL_LIFECYCLE.join(', ')}`);

  // Find all situations whose lifecycle is NOT in the canonical set.
  // We also count human_interventions (rows where an operator already
  // weighed in) and read investigation.status / consecutive_failures
  // from the body JSON.
  const dirty = db
    .prepare(
      `SELECT
         s.situation_id,
         s.lifecycle,
         (SELECT COUNT(*) FROM human_interventions hi WHERE hi.situation_id = s.situation_id) AS intervention_count,
         json_extract(lc.body, '$.investigation.status') AS investigation_status,
         json_extract(lc.body, '$.investigation.consecutiveFailures') AS consecutive_failures
       FROM situations s
       LEFT JOIN learning_contexts lc ON lc.situation_id = s.situation_id
       WHERE s.lifecycle IS NULL OR s.lifecycle NOT IN (${CANONICAL_LIFECYCLE.map(() => '?').join(',')})`,
    )
    .all(...CANONICAL_LIFECYCLE) as DirtyRow[];

  console.log(`[fix-lifecycle] Non-canonical rows: ${dirty.length}`);
  if (dirty.length === 0) {
    console.log('[fix-lifecycle] No action needed — DB is clean.');
    closeDb(db);
    return;
  }

  // Decide the canonical replacement per row.
  //
  // Decision matrix (P0010.2.5 closure — explicit and conservative):
  //   human_interventions > 0       → 'partial'  (operator already weighed in)
  //   investigation.status='failed' → 'open'     (truth: failed, retry needed)
  //   investigation.status='completed' or 'mature' → 'mature'
  //                                       (only if human_interventions > 0;
  //                                        otherwise log a warning and SKIP
  //                                        because we have no Terminal
  //                                        Lifecycle state machine yet)
  //   else (pending / investigating / null) → 'open' (safe default)
  const decisions: FixDecision[] = [];
  for (const row of dirty) {
    if (row.intervention_count > 0) {
      decisions.push({
        situationId: row.situation_id,
        oldLifecycle: row.lifecycle,
        newLifecycle: 'partial',
        reason: `has ${row.intervention_count} human_intervention(s) — canonical 'partial'`,
      });
      continue;
    }
    if (row.investigation_status === 'failed') {
      decisions.push({
        situationId: row.situation_id,
        oldLifecycle: row.lifecycle,
        newLifecycle: 'open',
        reason: `investigation.status='failed' (consecutive_failures=${row.consecutive_failures}) — eligible for retry, canonical 'open'`,
      });
      continue;
    }
    if (row.investigation_status === 'completed' || row.investigation_status === 'mature') {
      // We do NOT auto-fix this case: a 'completed' lifecycle on a situation
      // with no human_interventions and no Terminal Lifecycle state machine
      // is an undefined business state. Log it for human review and skip.
      console.log(
        `[fix-lifecycle] WARN: ${row.situation_id} lifecycle='${row.lifecycle}' but investigation.status='${row.investigation_status}' and 0 interventions — SKIP (no Terminal Lifecycle yet, see P0010.3)`,
      );
      continue;
    }
    // Default: pending / investigating / null → 'open' (safe).
    decisions.push({
      situationId: row.situation_id,
      oldLifecycle: row.lifecycle,
      newLifecycle: 'open',
      reason: `investigation.status='${row.investigation_status ?? '<null>'}' (no interventions) — safe default 'open'`,
    });
  }

  console.log('');
  console.log('[fix-lifecycle] Decisions:');
  for (const d of decisions) {
    console.log(`  - ${d.situationId}: '${d.oldLifecycle}' → '${d.newLifecycle}'  (${d.reason})`);
  }
  console.log('');

  if (dryRun) {
    console.log('[fix-lifecycle] DRY RUN — no rows modified.');
    closeDb(db);
    return;
  }

  // Apply. One UPDATE per row inside a single transaction.
  const tx = db.transaction((rows: readonly FixDecision[]) => {
    const stmt = db.prepare(
      `UPDATE situations SET lifecycle = ?, updated_at = ? WHERE situation_id = ?`,
    );
    const now = new Date().toISOString();
    for (const d of rows) {
      stmt.run(d.newLifecycle, now, d.situationId);
    }
    return rows.length;
  });
  const applied = tx(decisions);

  // Post-check.
  const remaining = (db
    .prepare(
      `SELECT COUNT(*) AS c FROM situations WHERE lifecycle IS NULL OR lifecycle NOT IN (${CANONICAL_LIFECYCLE.map(() => '?').join(',')})`,
    )
    .get(...CANONICAL_LIFECYCLE) as { c: number }).c;
  console.log(`[fix-lifecycle] Applied: ${applied}  Remaining non-canonical: ${remaining}`);

  closeDb(db);
};

main();
