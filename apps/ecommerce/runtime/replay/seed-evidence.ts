// P0013 G1-fix (2026-09-03): Seed Replay evidence from the P0011.x on-disk
// dataset at run creation time.
//
// Why this exists: the Replay cognition kernel calls
//   visibleEvidenceFor(db, runId, T)
// which queries `WHERE replay_run_id = ? AND business_date <= ?`. The
// kernel RECEIVES zero rows unless someone has INSERTed evidence_observations
// rows tagged with the new runId. The P0007 evidence_observations table
// holds PRODUCTION rows (replay_run_id IS NULL); the on-disk P0011.x
// dataset (`data/jd_acquisition_*/PROVENANCE_MANIFEST.json` + 4 canonical
// files) is the frozen historical source. Without this seed, the Agent
// sees an empty evidence list — exactly the regression the operator
// surfaced on 2026-09-03 (LLM correctly observed: "证据为空,已超冷启动
// 窗口").
//
// INVARIANTS:
//   1. The seed runs ONCE per run, at createReplayRun time (not per step).
//      Re-running on restart is idempotent (the natural-key UNIQUE INDEX
//      on evidence_observations + INSERT OR IGNORE).
//   2. Source is the P0011.x FROZEN dataset (read-only on disk; §6 raw
//      immutable is preserved — we never write back to the dataset files).
//   3. Each row's business_date is taken from the DATASET, not from
//      process time. The dataset has 30 business_dates from
//      2026-08-04 to 2026-09-02.
//   4. The seed writes rows for 3 capabilities:
//        - trade.overview  (data_type=getSummary, 1 row, business_date = dataset.end)
//        - trade.overview  (data_type=getTrend, 30 rows, one per business_date)
//        - order.overview  (data_type=perDaySummary, 30 rows, one per business_date)

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  loadHistoricalDataset,
  HistoricalDatasetContractError,
} from './historical-dataset.js';
import { nowIso } from '#shared/utils/time.js';

export interface SeedReplayEvidenceResult {
  readonly totalRowsInserted: number;
  readonly byCapabilityDataType: ReadonlyArray<{
    readonly capability: string;
    readonly dataType: string;
    readonly rows: number;
  }>;
  readonly firstBusinessDate: string;
  readonly lastBusinessDate: string;
}

const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

/**
 * Read the dataset's declared shopId without throwing. The runner uses
 * this to pick the canonical shop_id for the evidence rows (the dataset
 * is the source of truth — the operator's alias "jd_shop_001" stays in
 * replay_runs.shop_id for human reading, but the evidence_observations
 * natural key needs the real shopId "11855009").
 */
export const getDatasetShopId = (datasetPath: string): string => {
  const dataset = loadHistoricalDataset(datasetPath);
  return dataset.shop.shopId;
};

/**
 * Seed `evidence_observations` with one row per (business_date, capability,
 * data_type) tuple from the P0011.x on-disk dataset, tagged with the new
 * `replay_run_id` so `visibleEvidenceFor` returns them.
 *
 * Idempotent: uses INSERT OR IGNORE against the natural-key UNIQUE INDEX
 * (shop_id, data_type, business_date, acquired_at, content_hash).
 */
export const seedReplayEvidence = (
  db: Database.Database,
  runId: string,
  datasetPath: string,
  shopId: string,
  runAcquiredAt: string,
): SeedReplayEvidenceResult => {
  const dataset = loadHistoricalDataset(datasetPath);

  // ShopId is now resolved by the runner via getDatasetShopId; this
  // assertion is defensive — if the caller passes a different shopId,
  // it's a programmer error.
  if (dataset.shop.shopId !== shopId) {
    throw new HistoricalDatasetContractError(
      `seedReplayEvidence: shopId mismatch — caller=${shopId} dataset=${dataset.shop.shopId}`,
    );
  }

  // P0013 G1.3-fix: use the run's own created_at as the evidence's
  // acquired_at. The natural-key UNIQUE INDEX includes acquired_at, and
  // using the same manifest timestamp for every run makes every seed
  // INSERT collide with prior runs' rows. Per-run acquired_at gives
  // each run its own rows. (Stable across restarts of the SAME run,
  // because we pass the run's persisted created_at — not nowIso().)
  const acquiredAt = runAcquiredAt;

  const insertRow = db.prepare(
    `INSERT OR IGNORE INTO evidence_observations
       (shop_id, capability, data_type, business_date, business_time_bucket,
        acquired_at, content_hash, evidence_file_path, content_size, created_at,
        replay_run_id, replay_run_step_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );

  const byCapabilityDataType = new Map<string, number>();
  let totalRowsInserted = 0;

  const tx = db.transaction(() => {
    // 1) trade.overview / getSummary — 1 row at dataset.end.
    {
      const filePath = join(datasetPath, 'target_a_summary_decoded.json');
      const fileContent = readFileSync(filePath, 'utf8');
      const fileSize = Buffer.byteLength(fileContent, 'utf8');
      const hash = sha256(fileContent);
      const r = insertRow.run(
        shopId,
        'trade.overview',
        'getSummary',
        dataset.window.end,
        `${dataset.window.end}T10`,
        acquiredAt,
        hash,
        filePath,
        fileSize,
        nowIso(),
        runId,
      );
      if (r.changes > 0) totalRowsInserted += 1;
      const k = 'trade.overview|getSummary';
      byCapabilityDataType.set(k, (byCapabilityDataType.get(k) ?? 0) + 1);
    }

    // 2) trade.overview / getTrend — 30 rows, one per business_date.
    {
      const filePath = join(datasetPath, 'target_a_trend_parsed.json');
      const fileContent = readFileSync(filePath, 'utf8');
      const fileSize = Buffer.byteLength(fileContent, 'utf8');
      const baseHash = sha256(fileContent);
      for (let i = 0; i < dataset.trend.xaxis.length; i += 1) {
        const date = dataset.trend.xaxis[i];
        if (!date) continue;
        const hash = sha256(baseHash + '|' + date);
        const r = insertRow.run(
          shopId,
          'trade.overview',
          'getTrend',
          date,
          `${date}T10`,
          acquiredAt,
          hash,
          filePath,
          fileSize,
          nowIso(),
          runId,
        );
        if (r.changes > 0) totalRowsInserted += 1;
        const k = 'trade.overview|getTrend';
        byCapabilityDataType.set(k, (byCapabilityDataType.get(k) ?? 0) + 1);
      }
    }

    // 3) order.overview / perDaySummary — 30 rows, one per business_date.
    {
      const filePath = join(datasetPath, 'target_b_order_detail_summary.json');
      const fileContent = readFileSync(filePath, 'utf8');
      const fileSize = Buffer.byteLength(fileContent, 'utf8');
      const baseHash = sha256(fileContent);
      // The loader converts the dataset's per_day array to a Record so
      // it can be frozen; iterate via Object.keys().
      for (const date of Object.keys(dataset.orderDetails.perDay)) {
        const hash = sha256(baseHash + '|' + date);
        const r = insertRow.run(
          shopId,
          'order.overview',
          'perDaySummary',
          date,
          `${date}T10`,
          acquiredAt,
          hash,
          filePath,
          fileSize,
          nowIso(),
          runId,
        );
        if (r.changes > 0) totalRowsInserted += 1;
        const k = 'order.overview|perDaySummary';
        byCapabilityDataType.set(k, (byCapabilityDataType.get(k) ?? 0) + 1);
      }
    }

    // 4) order.overview / perOrder — 30 rows, one per business_date.
    // P0013 Task 2 Phase B: expose the per-order evidence file as a
    // DISCOVERABLE Evidence row per day. The full 1450 rows are NOT
    // dumped to the prompt (NOT-to-do 17) — only a 1-line summary is
    // rendered by readEvidenceContentSummary. The full rows remain
    // reachable via the Replay-local retrieval route (Phase D).
    //
    // All 30 rows point to the SAME evidence file (one parsed file,
    // 30 daily slices). The natural-key UNIQUE INDEX requires distinct
    // content_hash per (shop_id, data_type, business_date, acquired_at,
    // content_hash) tuple, so we derive a per-day hash from
    // baseHash + 'perOrder' + date.
    {
      const filePath = join(datasetPath, 'target_b_order_detail_parsed.json');
      const fileContent = readFileSync(filePath, 'utf8');
      const fileSize = Buffer.byteLength(fileContent, 'utf8');
      const baseHash = sha256(fileContent);
      for (const date of Object.keys(dataset.orderDetails.perDay)) {
        const hash = sha256(baseHash + '|perOrder|' + date);
        const r = insertRow.run(
          shopId,
          'order.overview',
          'perOrder',
          date,
          `${date}T10`,
          acquiredAt,
          hash,
          filePath,
          fileSize,
          nowIso(),
          runId,
        );
        if (r.changes > 0) totalRowsInserted += 1;
        const k = 'order.overview|perOrder';
        byCapabilityDataType.set(k, (byCapabilityDataType.get(k) ?? 0) + 1);
      }
    }
  });
  tx();

  const byCapDataTypeList = Array.from(byCapabilityDataType.entries()).map(
    ([k, rows]) => {
      const parts = k.split('|');
      const capability = parts[0] ?? '';
      const dataType = parts[1] ?? '';
      return { capability, dataType, rows };
    },
  );

  return {
    totalRowsInserted,
    byCapabilityDataType: byCapDataTypeList,
    firstBusinessDate: dataset.window.start,
    lastBusinessDate: dataset.window.end,
  };
};
