// P0013 Task 2 Phase D — Replay-local order retrieval route.
//
// POST /api/replay/runs/:runId/orders/retrieve
//   body: { businessDate: YYYY-MM-DD, query: RetrievalQuery, queryParams?: { skuId?, topN? } }
//   200: { success: true, data: { rows: OrderDetailRow[], meta: {...} } }
//   400: { success: false, error: '...' } (bad body / future-date)
//   404: { success: false, error: 'Replay run not found' }
//
// The route is operator-facing (NOT in the kernel prompt). It does NOT
// touch mcp__fabric__fabric_execute_capability. It reads from the frozen
// P0011.x dataset via the HistoricalDataset loader.
//
// INVARIANTS:
//   1. The route RE-CHECKS businessDate <= replay_runs.current_business_date
//      as a belt-and-suspenders against the caller. The retrieval function
//      ALSO filters at the function boundary (defense in depth).
//   2. The route NEVER writes to the DB. Read-only.
//   3. The route NEVER calls production capability acquisition.
//   4. The route returns rows in the canonical OrderDetailRow shape; the
//      caller formats the display.

import type { Request, Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import { ok, fail } from '../envelope.js';
import { loadHistoricalDataset } from '#app/runtime/replay/historical-dataset.js';
import {
  retrieveOrders,
  ALL_RETRIEVAL_QUERIES,
  type RetrievalQuery,
} from '#app/runtime/replay/order-retrieval.js';

const RetrievalQuerySchema = z.enum(
  ALL_RETRIEVAL_QUERIES as readonly [RetrievalQuery, ...RetrievalQuery[]],
);

const BodySchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  query: RetrievalQuerySchema,
  queryParams: z
    .object({
      skuId: z.number().int().positive().optional(),
      topN: z.number().int().positive().max(1000).optional(),
    })
    .optional(),
});

const getRun = (
  db: Database,
  runId: string,
): { source_dataset_path: string; current_business_date: string } | null => {
  const r = db
    .prepare(
      `SELECT source_dataset_path, current_business_date FROM replay_runs WHERE id = ?`,
    )
    .get(runId) as { source_dataset_path: string; current_business_date: string } | undefined;
  return r ?? null;
};

export const replayOrdersRouter = (db: Database): Router => {
  const router = express.Router();

  router.post(
    '/runs/:runId/orders/retrieve',
    (req: Request, res: Response): Response => {
      const runId = String(req.params.runId ?? '');
      if (!runId) return fail(res, 400, 'runId required');

      const parsed = BodySchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(
          res,
          400,
          `bad request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }

      const run = getRun(db, runId);
      if (!run) return fail(res, 404, `Replay run not found: ${runId}`);

      const { businessDate, query, queryParams } = parsed.data;

      // Belt-and-suspenders No-Future-Leak: route-level check against
      // the run's current_business_date. The retrieval function also
      // filters, but this gives a clean 400 with a named error.
      if (businessDate > run.current_business_date) {
        return fail(
          res,
          400,
          `business_date (${businessDate}) > run.current_business_date (${run.current_business_date}) — No-Future-Leak`,
        );
      }

      // Load the frozen P0011.x dataset. Read-only on disk.
      const dataset = loadHistoricalDataset(run.source_dataset_path);

      // Delegate to the pure retrieval function (Phase C). The function
      // also re-filters by biz_date <= businessDate (defense in depth).
      const retrievalParams: { skuId?: number; topN?: number } = {};
      if (queryParams?.skuId !== undefined) retrievalParams.skuId = queryParams.skuId;
      if (queryParams?.topN !== undefined) retrievalParams.topN = queryParams.topN;
      const rows = retrieveOrders(
        dataset.orderDetails.rows,
        businessDate,
        query,
        retrievalParams,
      );

      return ok(res, {
        rows,
        meta: {
          capability: 'order.overview',
          dataType: 'perOrder',
          businessDate,
          sourceManifestHash: dataset.manifestHash,
          runCurrentBusinessDate: run.current_business_date,
          totalMatched: rows.length,
        },
      });
    },
  );

  return router;
};
