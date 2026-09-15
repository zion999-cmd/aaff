// P0013.3 — Historical Evidence Enrichment store.
//
// Append-only operator records for a historical business date:
//   fact              — objective reality that happened then
//   action            — operational action the team actually took
//   operator_feedback — a person's judgment/interpretation (human input,
//                        NEVER an Observed Fact)
//
// Invariants:
//   1. Records are ONLY inserted (append). No update, no delete API.
//   2. The frozen dataset and original evidence rows are never touched.
//   3. The replay kernel sees only records with business_date <= T
//      (same Business Time boundary as evidence_observations).
//   4. Adding an enrichment for T stamps every COMPLETED step at
//      business_date >= T stale (cognition must be re-formed).
//   5. A fresh re-run clears the stale stamp for the re-computed day;
//      later days stay stale until re-run.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type EnrichmentKind = 'fact' | 'action' | 'operator_feedback';

export interface EnrichmentInput {
  readonly businessDate: string;
  readonly kind: EnrichmentKind;
  readonly content: string;
}

export interface EnrichmentRow extends EnrichmentInput {
  readonly id: string;
  readonly replayRunId: string;
  readonly source: 'operator';
  readonly createdAt: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: ReadonlySet<string> = new Set(['fact', 'action', 'operator_feedback']);

export class EnrichmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentValidationError';
  }
}

const nowIso = (): string => new Date().toISOString();

/** Validate input against the run window before inserting. */
const assertWithinWindow = (
  db: Database.Database,
  runId: string,
  businessDate: string,
): void => {
  const run = db
    .prepare(`SELECT start_business_date, end_business_date FROM replay_runs WHERE id = ?`)
    .get(runId) as { start_business_date: string; end_business_date: string } | undefined;
  if (!run) throw new EnrichmentValidationError(`replay run not found: ${runId}`);
  if (
    businessDate < run.start_business_date ||
    businessDate > run.end_business_date
  ) {
    throw new EnrichmentValidationError(
      `business_date ${businessDate} outside run window ${run.start_business_date}..${run.end_business_date}`,
    );
  }
};

/**
 * Append one enrichment and invalidate cognition at/after T.
 * Returns the stored row + the list of business dates newly marked stale.
 */
export const appendEnrichment = (
  db: Database.Database,
  runId: string,
  input: EnrichmentInput,
): { enrichment: EnrichmentRow; staleDates: string[] } => {
  const businessDate = input.businessDate;
  if (!YMD.test(businessDate)) {
    throw new EnrichmentValidationError('businessDate must be YYYY-MM-DD');
  }
  if (!KINDS.has(input.kind)) {
    throw new EnrichmentValidationError(`kind must be fact|action|operator_feedback`);
  }
  const content = input.content.trim();
  if (content.length === 0) {
    throw new EnrichmentValidationError('content must be non-empty');
  }
  assertWithinWindow(db, runId, businessDate);

  const row: EnrichmentRow = {
    id: randomUUID(),
    replayRunId: runId,
    businessDate,
    kind: input.kind,
    content,
    source: 'operator',
    createdAt: nowIso(),
  };

  const tx = db.transaction((): string[] => {
    db.prepare(
      `INSERT INTO replay_evidence_enrichments
         (id, replay_run_id, business_date, kind, content, source, created_at)
       VALUES (?, ?, ?, ?, ?, 'operator', ?)`,
    ).run(row.id, runId, businessDate, row.kind, content, row.createdAt);

    // Invalidation: T and every later COMPLETED cognition becomes stale
    // (one stamp per day — repeated enrichment before re-run keeps the
    // earliest invalidation time).
    db.prepare(
      `UPDATE replay_run_steps
         SET enrichment_stale_at = COALESCE(enrichment_stale_at, ?)
       WHERE replay_run_id = ?
         AND business_date >= ?
         AND status = 'COMPLETED'
         AND enrichment_stale_at IS NULL`,
    ).run(row.createdAt, runId, businessDate);

    const stale = db
      .prepare(
        `SELECT DISTINCT business_date FROM replay_run_steps
           WHERE replay_run_id = ? AND enrichment_stale_at IS NOT NULL
           ORDER BY business_date`,
      )
      .all(runId) as Array<{ business_date: string }>;
    return stale.map((r) => r.business_date);
  });

  return { enrichment: row, staleDates: tx() };
};

/** All enrichments for one run (timeline markers + admin views). */
export const listEnrichmentsForRun = (
  db: Database.Database,
  runId: string,
): EnrichmentRow[] => {
  const rows = db
    .prepare(
      `SELECT id, replay_run_id, business_date, kind, content, source, created_at
         FROM replay_evidence_enrichments
        WHERE replay_run_id = ?
        ORDER BY business_date ASC, created_at ASC`,
    )
    .all(runId) as Array<{
    id: string;
    replay_run_id: string;
    business_date: string;
    kind: EnrichmentKind;
    content: string;
    source: string;
    created_at: string;
  }>;
  return rows.map(mapRow);
};

/** Enrichments visible at business time T (business_date <= T). */
export const visibleEnrichmentsAt = (
  db: Database.Database,
  runId: string,
  businessDate: string,
): EnrichmentRow[] => {
  const rows = db
    .prepare(
      `SELECT id, replay_run_id, business_date, kind, content, source, created_at
         FROM replay_evidence_enrichments
        WHERE replay_run_id = ? AND business_date <= ?
        ORDER BY business_date ASC, created_at ASC`,
    )
    .all(runId, businessDate) as Array<{
    id: string;
    replay_run_id: string;
    business_date: string;
    kind: EnrichmentKind;
    content: string;
    source: string;
    created_at: string;
  }>;
  return rows.map(mapRow);
};

/** Distinct business dates that carry at least one enrichment (timeline dots). */
export const enrichedDates = (
  db: Database.Database,
  runId: string,
): string[] => {
  const rows = db
    .prepare(
      `SELECT DISTINCT business_date FROM replay_evidence_enrichments
        WHERE replay_run_id = ? ORDER BY business_date`,
    )
    .all(runId) as Array<{ business_date: string }>;
  return rows.map((r) => r.business_date);
};

/** Earliest stale business date for a run, or null when cognition is fresh. */
export const earliestStaleDate = (
  db: Database.Database,
  runId: string,
): string | null => {
  const row = db
    .prepare(
      `SELECT MIN(business_date) AS d FROM replay_run_steps
        WHERE replay_run_id = ? AND enrichment_stale_at IS NOT NULL`,
    )
    .get(runId) as { d: string | null } | undefined;
  return row?.d ?? null;
};

const mapRow = (r: {
  id: string;
  replay_run_id: string;
  business_date: string;
  kind: EnrichmentKind;
  content: string;
  source: string;
  created_at: string;
}): EnrichmentRow => ({
  id: r.id,
  replayRunId: r.replay_run_id,
  businessDate: r.business_date,
  kind: r.kind,
  content: r.content,
  source: 'operator',
  createdAt: r.created_at,
});
