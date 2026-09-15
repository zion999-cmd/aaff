// P0013 — Temporal Visibility Filter. The §3 "no-future-leak at the data boundary".
//
// This module is the LOAD-BEARING safety boundary between a historical dataset
// and the Agent's prompt. The Agent NEVER sees evidence dated after the
// current Replay Business Clock. The check is at the data layer, not at the
// prompt — LLMs that hold a future fact cannot be trusted to "pretend they
// don't know" it. So we strip future items BEFORE the prompt is built.
//
// §3: "No future leakage" — enforced here, not in the prompt.
// §23: deterministic. Pure functions. No clock reads.

import {
  isAtOrBefore,
  type ReplayBusinessClock,
} from './replay-clock.js';

export interface VisibleItem<T> {
  readonly item: T;
  readonly businessDate: string;
}

/**
 * Returns a NEW array of items whose businessDate is at or before
 * `clock.currentBusinessDate`. Items past the clock are silently dropped.
 * The order of the input is preserved in the output.
 *
 * If the items themselves are already filtered, the caller can use
 * `assertNoLeakage` to verify the contract. This is the §3 enforcement point.
 */
export const filterToVisible = <T>(
  clock: ReplayBusinessClock,
  items: readonly T[],
  getBusinessDate: (item: T) => string,
): T[] => {
  const out: T[] = [];
  for (const item of items) {
    const d = getBusinessDate(item);
    if (isAtOrBefore(d, clock.currentBusinessDate)) {
      out.push(item);
    }
  }
  return out;
};

/**
 * The hard guard. If ANY item's businessDate is strictly greater than the
 * clock, this throws. The error message names the offending dates so the
 * upstream caller can either rebuild the filter or surface a UI error.
 *
 * This is the §3 canonical enforcement. The LLM prompt is built from
 * `filterToVisible(clock, ...)` output; the surrounding code calls
 * `assertNoLeakage` on that output before composing the prompt.
 */
export const assertNoLeakage = <T>(
  clock: ReplayBusinessClock,
  items: readonly T[],
  getBusinessDate: (item: T) => string,
): void => {
  const leaked: string[] = [];
  for (const item of items) {
    const d = getBusinessDate(item);
    if (!isAtOrBefore(d, clock.currentBusinessDate)) {
      leaked.push(d);
    }
  }
  if (leaked.length > 0) {
    const sample = leaked.slice(0, 5).join(', ');
    const more = leaked.length > 5 ? `, …(+${leaked.length - 5} more)` : '';
    throw new Error(
      `Replay temporal leakage: ${leaked.length} item(s) carry a future businessDate ` +
        `past clock=${clock.currentBusinessDate}. First offenders: ${sample}${more}. ` +
        `Call filterToVisible(clock, items, getBusinessDate) first.`,
    );
  }
};

/**
 * Count (do not throw) how many items would leak. Useful for diagnostics
 * and operator-facing "X rows held back by the temporal filter" messages.
 */
export const countLeakedDates = <T>(
  clock: ReplayBusinessClock,
  items: readonly T[],
  getBusinessDate: (item: T) => string,
): number => {
  let n = 0;
  for (const item of items) {
    const d = getBusinessDate(item);
    if (!isAtOrBefore(d, clock.currentBusinessDate)) n += 1;
  }
  return n;
};
