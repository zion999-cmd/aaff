// P0013.1 — Evidence Coverage / Gap pure resolution.
//
// Gap = need window calendar dates MINUS union of truthful existing
// dataset coverage (dataset window minus its missing dates). It is a
// REQUIREMENT gap, never a promise that the provider can fill it.

import { describe, it, expect } from 'vitest';
import {
  resolveEvidenceGap,
  enumerateYmd,
  compressSegments,
  type GapDatasetSummary,
} from '#app/runtime/acquisition/evidence-gap.js';
import { HistoricalEvidenceNeedSchema } from '#shared/contracts/historical-evidence-need.js';

const need = (start: string, end: string) =>
  HistoricalEvidenceNeedSchema.parse({
    subject: { shopId: '11855009', shopName: '祁门红茶官方旗舰店' },
    source: 'jd',
    purpose: 'historical_replay',
    window: { start, end },
    domains: ['trade', 'orders'],
  });

const ds = (
  dirName: string,
  windowStart: string,
  windowEnd: string,
  missingDateList: string[] = [],
  shopId = '11855009',
): GapDatasetSummary => ({
  rootPath: `/data/${dirName}`,
  dirName,
  shopId,
  shopName: '祁门红茶官方旗舰店',
  windowStart,
  windowEnd,
  windowDays: enumerateYmd(windowStart, windowEnd).length,
  missingDates: missingDateList.length,
  missingDateList,
  manifestHash: `hash-${dirName}`,
});

describe('enumerateYmd', () => {
  it('enumerates inclusive UTC calendar dates', () => {
    expect(enumerateYmd('2026-08-04', '2026-08-06')).toEqual([
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
    ]);
  });

  it('returns one day for start == end', () => {
    expect(enumerateYmd('2026-09-02', '2026-09-02')).toEqual(['2026-09-02']);
  });
});

describe('compressSegments', () => {
  it('compresses contiguous dates into start/end segments', () => {
    expect(
      compressSegments(['2026-09-03', '2026-09-04', '2026-09-05', '2026-09-08']),
    ).toEqual([
      { start: '2026-09-03', end: '2026-09-05' },
      { start: '2026-09-08', end: '2026-09-08' },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(compressSegments([])).toEqual([]);
  });
});

describe('resolveEvidenceGap', () => {
  it('returns covered when one dataset fully contains the need window', () => {
    const r = resolveEvidenceGap(need('2026-08-20', '2026-09-02'), [
      ds('jd_acquisition_20260903_0834', '2026-08-04', '2026-09-02'),
    ]);
    expect(r.kind).toBe('covered');
    if (r.kind === 'covered') expect(r.dataset.dirName).toBe('jd_acquisition_20260903_0834');
  });

  it('returns the gap tail when need extends past the latest coverage', () => {
    const r = resolveEvidenceGap(need('2026-08-04', '2026-09-12'), [
      ds('old', '2026-08-04', '2026-09-02'),
    ]);
    expect(r.kind).toBe('gap');
    if (r.kind === 'gap') {
      expect(r.gapSegments).toEqual([{ start: '2026-09-03', end: '2026-09-12' }]);
      expect(r.missingDates).toHaveLength(10);
    }
  });

  it('returns the full need window as gap with no datasets', () => {
    const r = resolveEvidenceGap(need('2026-08-04', '2026-09-12'), []);
    expect(r.kind).toBe('gap');
    if (r.kind === 'gap') {
      expect(r.gapSegments).toEqual([{ start: '2026-08-04', end: '2026-09-12' }]);
    }
  });

  it('treats a missing date INSIDE a dataset window as not covered', () => {
    const r = resolveEvidenceGap(need('2026-09-01', '2026-09-03'), [
      ds('d', '2026-09-01', '2026-09-03', ['2026-09-02']),
    ]);
    expect(r.kind).toBe('gap');
    if (r.kind === 'gap') {
      expect(r.missingDates).toEqual(['2026-09-02']);
    }
  });

  it('fragmented coverage across two datasets is still a gap in V1 (no merge product)', () => {
    const r = resolveEvidenceGap(need('2026-08-04', '2026-09-12'), [
      ds('new', '2026-09-03', '2026-09-12'),
      ds('old', '2026-08-04', '2026-09-02'),
    ]);
    expect(r.kind).toBe('gap');
    if (r.kind === 'gap') {
      // Whole window is the product gap — Replay cannot consume A+B.
      expect(r.gapSegments).toEqual([{ start: '2026-08-04', end: '2026-09-12' }]);
    }
  });

  it('a single new dataset fully spanning the need is covered (newest wins)', () => {
    const r = resolveEvidenceGap(need('2026-09-03', '2026-09-12'), [
      ds('old', '2026-08-04', '2026-09-02'),
      ds('new', '2026-08-14', '2026-09-12'),
    ]);
    expect(r.kind).toBe('covered');
    if (r.kind === 'covered') expect(r.dataset.dirName).toBe('new');
  });

  it('ignores datasets for a different shop', () => {
    const r = resolveEvidenceGap(need('2026-09-01', '2026-09-02'), [
      ds('other-shop', '2026-08-01', '2026-09-30', [], '99999999'),
    ]);
    expect(r.kind).toBe('gap');
  });
});
