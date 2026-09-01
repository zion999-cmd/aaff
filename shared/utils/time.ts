// Pure time helpers. Zero dependencies.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Current time as ISO 8601 string. */
export const nowIso = (): string => new Date().toISOString();

/** Parse an ISO string; returns null if invalid. */
export const parseIso = (value: string): Date | null => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Whole-day difference between two ISO strings (b - a). */
export const diffDays = (a: string, b: string): number => {
  const da = parseIso(a);
  const db = parseIso(b);
  if (!da || !db) return 0;
  return (db.getTime() - da.getTime()) / MS_PER_DAY;
};

/** Hour bucket for a timestamp, minute/second zeroed. */
export const hourBucket = (iso: string): string => {
  const d = parseIso(iso);
  if (!d) return iso;
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};

/**
 * Split timestamps into recent vs previous equal-length windows.
 * Returns the cutoff index: records at indices < cutoff are "previous",
 * records at >= cutoff are "recent" (those within `windowDays` of `now`).
 */
export const windowBounds = (now: Date, windowDays: number, previousWindowDays: number): {
  recentStart: Date;
  previousStart: Date;
} => {
  const recentStart = new Date(now.getTime() - windowDays * MS_PER_DAY);
  const previousStart = new Date(recentStart.getTime() - previousWindowDays * MS_PER_DAY);
  return { recentStart, previousStart };
};

/** True if an ISO timestamp falls within [start, now]. */
export const isWithin = (iso: string, start: Date, now: Date): boolean => {
  const d = parseIso(iso);
  if (!d) return false;
  return d.getTime() >= start.getTime() && d.getTime() <= now.getTime();
};

/**
 * Asia/Shanghai (UTC+8, fixed offset — no DST) calendar date, YYYY-MM-DD.
 *
 * P0010.2.11 C2: JD 商智 realtime endpoints report the BEIJING business
 * day ("今日实时" / "昨天"), so evidence acquired at e.g. 2026-08-28T23:58Z
 * (= Beijing 2026-08-29 07:58) must be stamped business_date 2026-08-29 —
 * the UTC calendar date mislabeled it as 8/28 while the payload actually
 * described the 8/29 realtime view.
 */
export const beijingDate = (at: Date = new Date()): string =>
  new Date(at.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Beijing (UTC+8) hour bucket — "YYYY-MM-DDTHH", e.g. "2026-08-31T08" for
 * 08:00–08:59 Beijing. Used by the RuntimeLoop acquisition cadence guard:
 * one acquisition per business-hour bucket, re-enabled automatically when the
 * hour rolls over.
 */
export const beijingHourBucket = (at: Date = new Date()): string => {
  const bjHour = (at.getUTCHours() + 8) % 24;
  return `${beijingDate(at)}T${String(bjHour).padStart(2, '0')}`;
};

/** Convenience: compute the Beijing hour bucket from an ISO string. */
export const beijingHourBucketFromISO = (iso: string): string =>
  beijingHourBucket(new Date(iso));
