// P0013.1 — Evidence Coverage / Gap resolution (pure).
//
// Gap = need window calendar dates MINUS the union of truthful existing
// dataset coverage (each dataset window minus its own missing dates).
// It is a REQUIREMENT gap only: it never promises the provider can fill
// it (proposal §2). This module does calendar arithmetic only — no
// dataset merge, no merge product for Replay (proposal §9).

import type { HistoricalDatasetSummary } from '../replay/dataset-catalog.js';
import type { HistoricalEvidenceNeed } from '#shared/contracts/historical-evidence-need.js';

export type GapDatasetSummary = HistoricalDatasetSummary;

export type DateSegment = Readonly<{
  start: string;
  end: string;
}>;

export type EvidenceGapResolution =
  | Readonly<{
      kind: 'covered';
      dataset: GapDatasetSummary;
    }>
  | Readonly<{
      kind: 'gap';
      missingDates: readonly string[];
      gapSegments: readonly DateSegment[];
      coveredDates: readonly string[];
    }>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Inclusive UTC calendar enumeration [start, end]. */
export const enumerateYmd = (start: string, end: string): string[] => {
  const first = Date.UTC(
    Number(start.slice(0, 4)),
    Number(start.slice(5, 7)) - 1,
    Number(start.slice(8, 10)),
  );
  const last = Date.UTC(
    Number(end.slice(0, 4)),
    Number(end.slice(5, 7)) - 1,
    Number(end.slice(8, 10)),
  );
  const out: string[] = [];
  for (let t = first; t <= last; t += MS_PER_DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

/** Compress a sorted list of calendar dates into contiguous segments. */
export const compressSegments = (dates: readonly string[]): DateSegment[] => {
  if (dates.length === 0) return [];
  const segments: DateSegment[] = [];
  let segStart: string = dates[0] as string;
  let segEnd: string = dates[0] as string;
  for (let i = 1; i < dates.length; i += 1) {
    const d = dates[i] as string;
    if (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${segEnd}T00:00:00Z`) === MS_PER_DAY) {
      segEnd = d;
    } else {
      segments.push({ start: segStart, end: segEnd });
      segStart = d;
      segEnd = d;
    }
  }
  segments.push({ start: segStart, end: segEnd });
  return segments;
};

export const resolveEvidenceGap = (
  need: HistoricalEvidenceNeed,
  datasets: readonly GapDatasetSummary[],
): EvidenceGapResolution => {
  const needDates = enumerateYmd(need.window.start, need.window.end);
  // V1: Replay consumes ONE self-contained frozen dataset (proposal §9 —
  // no dataset merge). Coverage therefore requires a single dataset whose
  // truthful dates (window minus its missing dates) include every need
  // date. Fragmented union coverage across datasets is NOT coverable.
  const sameShop = datasets
    .filter((ds) => ds.shopId === need.subject.shopId)
    .sort((a, b) => b.windowEnd.localeCompare(a.windowEnd));
  for (const ds of sameShop) {
    if (ds.windowStart > need.window.start || ds.windowEnd < need.window.end) continue;
    const missing = new Set(ds.missingDateList);
    if (needDates.every((d) => !missing.has(d))) {
      return { kind: 'covered', dataset: ds };
    }
  }
  // Gap reporting still uses the truthful union so the operator sees which
  // dates exist anywhere, but the product decision remains "acquire".
  const covered = new Set<string>();
  for (const ds of sameShop) {
    const missing = new Set(ds.missingDateList);
    for (const d of enumerateYmd(ds.windowStart, ds.windowEnd)) {
      if (!missing.has(d)) covered.add(d);
    }
  }
  const unionMissing = needDates.filter((d) => !covered.has(d));
  // Fragmented-but-complete union coverage still cannot feed Replay V1:
  // the full need window becomes the product gap.
  const productGap = unionMissing.length === 0 ? needDates : unionMissing;
  const coveredInNeed = needDates.filter((d) => covered.has(d));
  return {
    kind: 'gap',
    missingDates: productGap,
    gapSegments: compressSegments(productGap),
    coveredDates: coveredInNeed,
  };
};
