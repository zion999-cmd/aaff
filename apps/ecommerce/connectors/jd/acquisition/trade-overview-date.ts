// C2.0 — trade.overview business-date guard.
//
// The direct-fetch transport (P0010.2.11, ADR-072) always returns the
// CURRENT Beijing business day's `todayRealtime` data — the requested date
// never changes what the endpoint sends back. A caller-supplied historical
// date therefore can only end up as a WRONG business_date stamp on a
// realtime payload, which is exactly how 2026-08-22/27/28_getSummary.json
// got poisoned with 2026-08-29 realtime data on 2026-08-29.
//
// Invariant: payload semantic business date MUST equal evidence
// metadata.business_date. The only safe stamp is the current Beijing day;
// anything else fails closed with an explicit error.

import { beijingDate } from '#shared/utils/time.js';

export type TradeOverviewDateResolution =
  | { ok: true; date: string }
  | { ok: false; date: string; error: string };

/**
 * Resolve the business_date a trade.overview direct-fetch acquisition may
 * legitimately be stamped with. Pure and injectable (`now`) for tests.
 *
 * - No requested date → current Beijing business day.
 * - Requested date === current Beijing business day → accepted.
 * - Any other date (historical, future, or UTC-derived-stale) → rejected
 *   with an error naming both dates.
 */
export const resolveTradeOverviewBusinessDate = (
  requested: string | undefined,
  now: Date = new Date(),
): TradeOverviewDateResolution => {
  const today = beijingDate(now);
  const date = requested ?? today;
  if (date === today) {
    return { ok: true, date };
  }
  return {
    ok: false,
    date,
    error:
      `trade.overview direct-fetch returns realtime data for the CURRENT Beijing business day (${today}) only; ` +
      `refusing to stamp a realtime payload as business_date ${date}. ` +
      'Historical dates must use the snapshot walker (acquireJdData), not trade.overview.',
  };
};
