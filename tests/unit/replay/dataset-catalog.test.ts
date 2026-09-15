// P0013+ — Historical dataset discovery catalog.
//
// listHistoricalDatasets scans a data root for acquisition directories
// (dirs containing PROVENANCE_MANIFEST.json), loads each through the
// fail-closed HistoricalDataset loader, and returns summaries plus a
// `skipped` list for dirs that CLAIM to be datasets but fail the contract.
// Plain directories without a manifest are silently ignored (data/ holds
// many non-dataset dirs: fabric-workspace, *.db files, etc.).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listHistoricalDatasets } from '#app/runtime/replay/dataset-catalog.js';

let tmpRoot: string;

const MANIFEST = (shopId: string, start: string, end: string, days: number): string =>
  JSON.stringify({
    manifest_version: '1.0',
    acquired_at: '2026-09-03T08:43:52+08:00',
    acquisition_run_id: 'unit-test',
    shop: { shop_id: shopId, shop_name: `Shop ${shopId}` },
    time_window: { start, end, days },
  });

/** Write a minimal fully-valid dataset into `dir`. */
const writeValidDataset = (
  dir: string,
  shopId: string,
  start: string,
  end: string,
  days: number,
  xaxis: string[],
): void => {
  writeFileSync(join(dir, 'PROVENANCE_MANIFEST.json'), MANIFEST(shopId, start, end, days));
  writeFileSync(
    join(dir, 'target_a_summary_decoded.json'),
    JSON.stringify({ shop_id: shopId, all_kpis_readable: {} }),
  );
  writeFileSync(
    join(dir, 'target_a_trend_parsed.json'),
    JSON.stringify({ shop_id: shopId, xaxis, series: [], rows: [] }),
  );
  writeFileSync(
    join(dir, 'target_b_order_detail_summary.json'),
    JSON.stringify({ shop_id: shopId, unique_orders: 0, rows_total: 0, per_day: [] }),
  );
  writeFileSync(join(dir, 'target_b_order_detail_parsed.json'), JSON.stringify([]));
};

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'p0013-catalog-'));

  // Valid dataset A — later window.
  mkdirSync(join(tmpRoot, 'jd_acquisition_20260903_0834'));
  writeValidDataset(
    join(tmpRoot, 'jd_acquisition_20260903_0834'),
    '11855009',
    '2026-08-04',
    '2026-09-02',
    30,
    Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 4 + i));
      return d.toISOString().slice(0, 10);
    }),
  );

  // Valid dataset B — earlier window.
  mkdirSync(join(tmpRoot, 'jd_acquisition_20260804_0900'));
  writeValidDataset(
    join(tmpRoot, 'jd_acquisition_20260804_0900'),
    '11855009',
    '2026-07-05',
    '2026-08-03',
    30,
    ['2026-07-05', '2026-08-03'],
  );

  // Claims to be a dataset (has manifest) but is missing canonical files
  // → must appear in skipped, never throw the whole listing.
  mkdirSync(join(tmpRoot, 'jd_acquisition_broken'));
  writeFileSync(
    join(tmpRoot, 'jd_acquisition_broken', 'PROVENANCE_MANIFEST.json'),
    MANIFEST('11855009', '2026-09-01', '2026-09-02', 2),
  );

  // Plain dir without manifest (e.g. fabric-workspace) → silently ignored.
  mkdirSync(join(tmpRoot, 'fabric-workspace'));
  writeFileSync(join(tmpRoot, 'fabric-workspace', 'readme.txt'), 'not a dataset');

  // A loose file at root level → ignored.
  writeFileSync(join(tmpRoot, 'agentfabric.db'), 'binary');
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('listHistoricalDatasets', () => {
  it('lists every valid dataset directory with window + real manifest hash', () => {
    const { datasets, skipped } = listHistoricalDatasets(tmpRoot);
    expect(skipped).toHaveLength(1);
    expect(datasets).toHaveLength(2);
    for (const ds of datasets) {
      expect(ds.manifestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(ds.rootPath).toContain(ds.dirName);
    }
    const first = datasets[0];
    if (!first) throw new Error('expected first dataset');
    expect(first.dirName).toBe('jd_acquisition_20260903_0834');
    expect(first.shopId).toBe('11855009');
    expect(first.windowStart).toBe('2026-08-04');
    expect(first.windowEnd).toBe('2026-09-02');
    expect(first.windowDays).toBe(30);
  });

  it('sorts datasets by windowEnd descending (newest first)', () => {
    const { datasets } = listHistoricalDatasets(tmpRoot);
    expect(datasets.map((d) => d.dirName)).toEqual([
      'jd_acquisition_20260903_0834',
      'jd_acquisition_20260804_0900',
    ]);
  });

  it('reports broken manifest dirs in skipped with a reason, and ignores manifest-less dirs', () => {
    const { datasets, skipped } = listHistoricalDatasets(tmpRoot);
    expect(skipped[0]?.dirName).toBe('jd_acquisition_broken');
    expect(skipped[0]?.reason.length).toBeGreaterThan(0);
    expect(datasets.find((d) => d.dirName === 'fabric-workspace')).toBeUndefined();
  });

  it('returns an empty catalog (does not throw) when the data root does not exist', () => {
    const missing = join(tmpRoot, 'does-not-exist');
    const result = listHistoricalDatasets(missing);
    expect(result.datasets).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
