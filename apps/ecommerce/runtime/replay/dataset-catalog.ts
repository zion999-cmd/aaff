// P0013+ — Historical dataset discovery catalog.
//
// The Replay start UI used to hardcode the single acquisition directory
// (`data/jd_acquisition_20260903_0834`), its shop, its window, and a
// placeholder manifest hash. This module makes discovery data-driven:
// scan the data root for acquisition directories (dirs containing
// PROVENANCE_MANIFEST.json) and summarize each through the fail-closed
// HistoricalDataset loader.
//
// Boundaries:
//   - Pure read. Never writes, never acquires, never falls back to mock.
//   - A directory WITHOUT a manifest is silently ignored — data/ holds
//     many non-dataset entries (fabric-workspace/, *.db, ...).
//   - A directory WITH a manifest that fails the dataset contract is
//     reported in `skipped` (with the reason), never silently dropped and
//     never fatal to the rest of the listing.
//   - A missing data root yields an empty catalog (fresh checkout).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadHistoricalDataset,
  type HistoricalDataset,
} from './historical-dataset.js';

const MANIFEST_FILE = 'PROVENANCE_MANIFEST.json';

export interface HistoricalDatasetSummary {
  /** Absolute path to the dataset root (what POST /runs receives). */
  readonly rootPath: string;
  /** Directory name only, e.g. `jd_acquisition_20260903_0834`. */
  readonly dirName: string;
  readonly shopId: string;
  readonly shopName: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly windowDays: number;
  /** Calendar days in the declared window absent from the trend xaxis. */
  readonly missingDates: number;
  /** The actual missing calendar dates (P0013.1 gap resolution). */
  readonly missingDateList: readonly string[];
  /** Real sha256 of PROVENANCE_MANIFEST.json bytes — the provenance credential. */
  readonly manifestHash: string;
}

export interface SkippedDataset {
  readonly dirName: string;
  readonly reason: string;
}

export interface HistoricalDatasetCatalog {
  readonly datasets: readonly HistoricalDatasetSummary[];
  readonly skipped: readonly SkippedDataset[];
}

const summarize = (rootPath: string, dirName: string): HistoricalDatasetSummary => {
  const dataset: HistoricalDataset = loadHistoricalDataset(rootPath);
  return {
    rootPath,
    dirName,
    shopId: dataset.shop.shopId,
    shopName: dataset.shop.shopName,
    windowStart: dataset.window.start,
    windowEnd: dataset.window.end,
    windowDays: dataset.window.days,
    missingDates: dataset.coverage.missingBusinessDates.length,
    missingDateList: dataset.coverage.missingBusinessDates,
    manifestHash: dataset.manifestHash,
  };
};

/**
 * List discoverable historical acquisition datasets under `dataRoot`.
 * Newest windowEnd first. Never throws for per-dataset contract failures.
 */
export const listHistoricalDatasets = (dataRoot: string): HistoricalDatasetCatalog => {
  if (!existsSync(dataRoot)) {
    return { datasets: [], skipped: [] };
  }

  const entries = readdirSync(dataRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  const datasets: HistoricalDatasetSummary[] = [];
  const skipped: SkippedDataset[] = [];

  for (const entry of entries) {
    const rootPath = join(dataRoot, entry.name);
    if (!existsSync(join(rootPath, MANIFEST_FILE))) {
      continue; // not an acquisition dataset — ignore without noise
    }
    try {
      datasets.push(summarize(rootPath, entry.name));
    } catch (err: unknown) {
      skipped.push({
        dirName: entry.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Newest acquisition window first (YYYY-MM-DD strings sort lexicographically).
  datasets.sort((a, b) => b.windowEnd.localeCompare(a.windowEnd));
  return { datasets, skipped };
};
