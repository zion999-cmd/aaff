// P0010.2.2 — Investigation Recovery Candidates.
//
// Why this file exists:
//   P0010.2's RuntimeLoop only re-evaluates situations the situation producer
//   emitted on the current tick. Pre-existing open situations whose
//   investigation was never run (or was interrupted, or failed and the server
//   restarted before recovery) were silently ignored forever.
//
//   This module is the SINGLE source of truth for "which existing situations
//   need the Loop's attention this tick". The Loop calls it on every tick;
//   the startup-time `autoInvestigatePending` chain in platform/server/index.ts
//   becomes redundant once the Loop's first tick can see them.
//
// Strict boundary (per user: "不能引入第二个 Recovery 逻辑"):
//   - This is NOT a parallel recovery path. It is the recovery path. The
//     Loop calls it; nothing else should.
//   - No new lifecycle value, no new schema migration, no new SQL table.
//     The query joins `situations` (lifecycle='open'|'partial') with
//     `learning_contexts` (read the optional `investigation` marker).
//
// Strict no-side-effects:
//   Pure function over the DB. Returns a list of `{ situationId,
//   recoveryKind, consecutiveFailures }` — the Loop decides what to do
//   with them.

import type { Database as Db } from 'better-sqlite3';
import { loadLearningContext } from '#app/experience/learning-context-producer.js';
import { nowIso } from '#shared/utils/time.js';

export type RecoveryKind = 'no_investigation' | 'failed_retryable' | 'interrupted';

export interface RecoverableSituation {
  situationId: string;
  /**
   * Why the situation is recoverable. Drives the `reason` field of the
   * Loop's policy decision (cosmetic for log lines; the actual go/no-go
   * decision is made by InvestigationPolicy):
   *   - 'no_investigation'   — never had a complete investigation; brand new
   *                            or only has a 'pending' / 'investigating' marker
   *                            from before contentHash tracking existed.
   *   - 'failed_retryable'    — last attempt failed but the consecutive
   *                            failure count is below the threshold.
   *   - 'interrupted'         — 'investigating' marker is older than the
   *                            recovery-stale window → the process died
   *                            mid-turn. Safe to start a fresh attempt.
   */
  recoveryKind: RecoveryKind;
  /** Number of consecutive failed attempts since the last operator accept /
   *  reject / override decision. The Loop uses this to surface the
   *  blocked-state event when the threshold is reached. */
  consecutiveFailures: number;
}

export interface RecoveryOptions {
  /** Cutoff: an `investigating` marker with `startedAt` older than this is
   *  considered interrupted (process died mid-turn). Default 10 min, which
   *  matches `collectTurn`'s default 600s timeout. */
  recoveryStaleAfterMs?: number;
  /** Max consecutive failures before declaring `blocked_runtime_failure`.
   *  Default 3. */
  maxConsecutiveFailures?: number;
  /** Hard cap on candidates per tick — protect against huge backlogs after
   *  a long outage. Default 20. */
  maxCandidatesPerTick?: number;
  /** Set of situation_ids to exclude (e.g. already in this tick's producer
   *  output — dedup, no double-investigate). */
  excludeIds?: ReadonlySet<string>;
  /** Now provider (test seam). Default Date.now. */
  now?: () => number;
}

const DEFAULT_RECOVERY_STALE_MS = 10 * 60_000;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_MAX_CANDIDATES = 20;

/**
 * Scan `situations` for rows that need Agent attention:
 *   - `lifecycle IN ('open', 'partial')` — never archived, never closed.
 *   - And one of:
 *     (a) no learning_context OR the lc has no `investigation` field
 *         → `no_investigation`
 *     (b) prior investigation.status='failed' and consecutive failures < threshold
 *         → `failed_retryable`
 *     (c) prior investigation.status='investigating' and `startedAt` is older
 *         than `recoveryStaleAfterMs`
 *         → `interrupted`
 *   - And NOT in `excludeIds`.
 *   - And not 'completed' / 'mature' / 'waiting_human' (skipped here).
 *
 * Order: never-investigated first (highest information gain), then by
 * `situations.updated_at` ASC (oldest first → backlog drains FIFO).
 *
 * Returns at most `maxCandidatesPerTick` rows.
 */
export const listRecoverableCandidates = (
  db: Db,
  options: RecoveryOptions = {},
): RecoverableSituation[] => {
  const maxCandidates = options.maxCandidatesPerTick ?? DEFAULT_MAX_CANDIDATES;
  const recoveryStaleAfterMs = options.recoveryStaleAfterMs ?? DEFAULT_RECOVERY_STALE_MS;
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES;
  const excludeIds = options.excludeIds ?? new Set<string>();
  const now = options.now ?? Date.now;

  // Bound the candidate scan to 5× the cap to keep this query O(small) even
  // when the table has tens of thousands of closed-out situations. The
  // FIFO ordering on `updated_at ASC` means the freshest candidates are
  // skipped first if we ever hit this ceiling, but in practice 5× cap is
  // way more than the working set of recoverable situations.
  const scanLimit = maxCandidates * 5;
  const rows = db.prepare(
    `SELECT s.situation_id, s.lifecycle, s.updated_at, lc.body AS lc_body
     FROM situations s
     LEFT JOIN learning_contexts lc ON lc.situation_id = s.situation_id
     WHERE s.lifecycle IN ('open', 'partial')
     ORDER BY
       CASE WHEN lc.body IS NULL THEN 0
            WHEN json_extract(lc.body, '$.investigation') IS NULL THEN 0
            ELSE 1 END,
       s.updated_at ASC
     LIMIT ?`,
  ).all(scanLimit) as Array<{
    situation_id: string;
    lifecycle: string;
    updated_at: string;
    lc_body: string | null;
  }>;

  const result: RecoverableSituation[] = [];
  for (const row of rows) {
    if (result.length >= maxCandidates) break;
    if (excludeIds.has(row.situation_id)) continue;

    // Load the full Learning Context (not just the investigation) — the
    // `humanInterventions` array lives on the context, and we need it
    // to count consecutive failures for the `failed_retryable` /
    // `blocked` decision below.
    const ctx = loadLearningContext(db, row.situation_id);
    const investigation = ctx?.investigation ?? null;
    if (!investigation) {
      result.push({
        situationId: row.situation_id,
        recoveryKind: 'no_investigation',
        consecutiveFailures: 0,
      });
      continue;
    }

    if (investigation.status === 'completed' || investigation.stopReason) {
      // Already has a completed investigation — not a recovery target. The
      // policy's `meaningful_new_evidence` path handles re-investigation
      // when new evidence actually moves the metric.
      continue;
    }

    if (investigation.status === 'failed') {
      const consecutiveFailures = countConsecutiveFailures(ctx as unknown as Record<string, unknown>);
      if (consecutiveFailures > maxConsecutiveFailures) {
        // Already strictly above the block threshold — the policy
        // already returned `blocked_runtime_failure` for this on a
        // prior tick, and the operator has not yet cleared it. Skip
        // silently; the next emitted `investigation_blocked` event was
        // the threshold-crossing tick, not every subsequent tick.
        continue;
      }
      // count == maxConsecutiveFailures is intentionally INCLUDED so
      // the Loop's policy call this tick returns `blocked_runtime_failure`
      // and the Loop emits the `investigation_blocked` event (one final
      // time, on the threshold-crossing tick). count < max is the normal
      // retry path.
      result.push({
        situationId: row.situation_id,
        recoveryKind: 'failed_retryable',
        consecutiveFailures,
      });
      continue;
    }

    if (investigation.status === 'investigating') {
      const startedAt = investigation.startedAt;
      if (!startedAt) {
        // No startedAt → treat as interrupted (conservative; better to
        // re-fire than to wait forever for a turn that never began).
        result.push({
          situationId: row.situation_id,
          recoveryKind: 'interrupted',
          consecutiveFailures: 0,
        });
        continue;
      }
      const startedAtMs = Date.parse(startedAt);
      if (Number.isNaN(startedAtMs)) {
        // Corrupt timestamp — same conservative path.
        result.push({
          situationId: row.situation_id,
          recoveryKind: 'interrupted',
          consecutiveFailures: 0,
        });
        continue;
      }
      if (now() - startedAtMs < recoveryStaleAfterMs) {
        // Fresh in-flight marker — the live tick (or another concurrent
        // process) is presumably still driving it. Skip; the live tick
        // path owns this turn.
        continue;
      }
      result.push({
        situationId: row.situation_id,
        recoveryKind: 'interrupted',
        consecutiveFailures: 0,
      });
      continue;
    }

    // 'pending' or unknown status — treat as no investigation.
    result.push({
      situationId: row.situation_id,
      recoveryKind: 'no_investigation',
      consecutiveFailures: 0,
    });
  }
  return result;
};

/**
 * Read the canonical consecutive-failure counter from the Investigation
 * marker. P0010.2.2 — the Loop's investigate() function stamps this
 * field on the marker on every failure and resets it on every success
 * (and the /clear-block route resets it on operator override). It is
 * the runtime's authoritative view of "how many retries have we burned
 * on this situation" — the canonical operator surface for blocking
 * remains the human intervention grammar (decision: accept | reject |
 * override), which the marker reset is the runtime projection of.
 *
 * Accepts a `LearningContext` shape (which has `.investigation` at the
 * top level) OR an `Investigation` shape. When given a context, we
 * unwrap to the investigation; when given an investigation, we read
 * the field directly. The legacy humanInterventions-walking fallback
 * was retired because the runtime's failure path (markInvestigation)
 * does not append to that array — the marker is the single source of
 * truth.
 */
export const countConsecutiveFailures = (invOrContext: Record<string, unknown>): number => {
  // Tolerate both shapes. Context first; fall back to the field on the
  // investigation itself.
  const investigation =
    (invOrContext as { investigation?: { consecutiveFailures?: unknown } }).investigation ??
    (invOrContext as { consecutiveFailures?: unknown });
  const value = investigation?.consecutiveFailures;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
};

/** Convenience: exposed so the clear-block route can advertise the
 *  threshold in its response, and so tests can assert the contract
 *  from one place. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = DEFAULT_MAX_FAILURES;
export const DEFAULT_RECOVERY_STALE_AFTER_MS = DEFAULT_RECOVERY_STALE_MS;

// Re-export so consumers have a single canonical source of the "now"
// ISO helper (used by tests to seed deterministic `startedAt` values).
export { nowIso };
