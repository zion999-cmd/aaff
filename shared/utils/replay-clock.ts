// P0013 — Replay Business Clock. Pure, deterministic, frozen.
//
// §2 invariant: the Replay Clock is INDEPENDENT of the production clock.
// §23 invariant: same input → same output. No `Date.now()` / `process.env` reads.
// §10 invariant: the clock is a value object; it is NEVER mutated.
//
// This module is the P0013 §2 / §23 proof. It must be loadable in any context
// (CLI / server / browser) and must not depend on Node-specific APIs.

export const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/ as const;

export type ReplayClockStatus =
  | 'READY'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED';

export interface ReplayBusinessClock {
  readonly startBusinessDate: string;
  readonly endBusinessDate: string;
  readonly currentBusinessDate: string;
  readonly step: number;
  readonly status: ReplayClockStatus;
}

const TERMINAL_STATUSES: ReadonlySet<ReplayClockStatus> = new Set([
  'COMPLETED',
  'FAILED',
]);

/** Validates a YYYY-MM-DD string. Pure. */
const assertBusinessDate = (value: string, field: 'start' | 'end' | 'current'): void => {
  if (typeof value !== 'string' || !YYYY_MM_DD.test(value)) {
    throw new Error(
      `ReplayClock: ${field} business date must match YYYY-MM-DD (got ${JSON.stringify(value)})`,
    );
  }
};

/** Adds 1 day to a YYYY-MM-DD string. Pure. Handles month/year/leap boundaries. */
const addOneDay = (value: string): string => {
  // Parse as UTC midnight, advance by 1 day, format YYYY-MM-DD.
  const [y, m, d] = value.split('-').map((n) => Number.parseInt(n, 10));
  const t = Date.UTC(y, m - 1, d) + 24 * 60 * 60 * 1000;
  const out = new Date(t).toISOString();
  return out.slice(0, 10);
};

/** Lexicographic YYYY-MM-DD compare. Pure. */
const isAfter = (a: string, b: string): boolean => a > b;

/** Lexicographic YYYY-MM-DD compare. Pure. */
const isBefore = (a: string, b: string): boolean => a < b;

/**
 * Construct a new Replay Clock. The returned value is frozen.
 *
 * @param startBusinessDate  YYYY-MM-DD, the first Business Date the run will see.
 * @param endBusinessDate    YYYY-MM-DD, the last Business Date the run will see.
 *                           Must be >= start.
 * @param initialStatus      Optional, defaults to 'READY'. Phase 4 uses 'PAUSED'
 *                           when restoring from persistence.
 */
export const createReplayClock = (
  startBusinessDate: string,
  endBusinessDate: string,
  initialStatus: ReplayClockStatus = 'READY',
): ReplayBusinessClock => {
  assertBusinessDate(startBusinessDate, 'start');
  assertBusinessDate(endBusinessDate, 'end');
  if (isAfter(startBusinessDate, endBusinessDate)) {
    throw new Error(
      `ReplayClock: start ${startBusinessDate} must be at or before end ${endBusinessDate}`,
    );
  }
  const clock: ReplayBusinessClock = {
    startBusinessDate,
    endBusinessDate,
    currentBusinessDate: startBusinessDate,
    step: 0,
    status: initialStatus,
  };
  return Object.freeze(clock);
};

/**
 * Advance the clock by one Business Date. Returns a NEW frozen clock.
 * - Inside the window: status becomes 'RUNNING', step += 1.
 * - At or past end: status becomes 'COMPLETED', currentBusinessDate is
 *   frozen at the last valid date, step is frozen at the last advance count.
 *   Subsequent calls return the same completed clock (idempotent).
 *
 * §23: deterministic — never reads Date.now() or any non-deterministic source.
 */
export const nextDate = (clock: ReplayBusinessClock): ReplayBusinessClock => {
  if (clock.status === 'COMPLETED' || clock.status === 'FAILED') {
    return clock;
  }
  const next = addOneDay(clock.currentBusinessDate);
  if (isAfter(next, clock.endBusinessDate)) {
    // One more legal step is `currentBusinessDate == endBusinessDate` if we
    // are AT end. If we are strictly before end, we advance; if we are AT
    // end, calling nextDate transitions to COMPLETED at the same date.
    if (isBefore(clock.currentBusinessDate, clock.endBusinessDate)) {
      // This branch is unreachable: addOneDay(end) > end ⇒ first if wins.
      throw new Error('unreachable');
    }
    const frozen: ReplayBusinessClock = {
      startBusinessDate: clock.startBusinessDate,
      endBusinessDate: clock.endBusinessDate,
      currentBusinessDate: clock.endBusinessDate,
      step: clock.step,
      status: 'COMPLETED',
    };
    return Object.freeze(frozen);
  }
  const advanced: ReplayBusinessClock = {
    startBusinessDate: clock.startBusinessDate,
    endBusinessDate: clock.endBusinessDate,
    currentBusinessDate: next,
    step: clock.step + 1,
    status: clock.status === 'READY' ? 'RUNNING' : clock.status,
  };
  return Object.freeze(advanced);
};

/** True when `a &lt;= b` (lexicographic on YYYY-MM-DD). */
export const isAtOrBefore = (a: string, b: string): boolean => !isAfter(a, b);

/** True when status is one of the terminal states. */
export const isReplayTerminal = (status: ReplayClockStatus): boolean =>
  TERMINAL_STATUSES.has(status);
