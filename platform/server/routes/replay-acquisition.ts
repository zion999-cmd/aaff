// P0013.1 — Historical Replay Dynamic Evidence Acquisition routes.
//
// POST /api/replay/acquisitions
//   Expresses a business Need beyond existing frozen dataset coverage.
//   Fabric computes the gap; when real acquisition is required it starts
//   an async Hermes exploration job. The Workspace polls status — it never
//   drives acquisition through chat and never knows implementation
//   details (endpoints / scripts / browser mechanics).
//
// GET /api/replay/acquisitions[/:id]
//   Job status for polling / recovery.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ok, fail } from '../envelope.js';
import { HistoricalEvidenceNeedSchema } from '#shared/contracts/historical-evidence-need.js';
import { listHistoricalDatasets } from '#app/runtime/replay/dataset-catalog.js';
import { resolveEvidenceGap } from '#app/runtime/acquisition/evidence-gap.js';
import {
  createAcquisitionJob,
  startAcquisitionJob,
} from '#app/runtime/acquisition/acquisition-orchestrator.js';
import {
  getAcquisitionJob,
  listRecentAcquisitionJobs,
} from '#app/runtime/acquisition/job-store.js';
import type { TurnRunner } from '#app/runtime/acquisition/hermes-turn-runner.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const CreateAcquisitionBodySchema = z
  .object({
    shopId: z.string().min(1),
    shopName: z.string().min(1),
    startBusinessDate: z.string().regex(YMD),
    endBusinessDate: z.string().regex(YMD),
  })
  .refine((v) => v.startBusinessDate <= v.endBusinessDate, {
    message: 'startBusinessDate must be <= endBusinessDate',
    path: ['startBusinessDate'],
  });

export interface AcquisitionRouterOptions {
  readonly dataRoot?: string;
  readonly turnRunner?: TurnRunner;
}

export const acquisitionRouter = (
  db: Database.Database,
  options: AcquisitionRouterOptions = {},
): Router => {
  const router = Router();
  const dataRoot = options.dataRoot ?? resolve(process.cwd(), 'data');

  router.post('/acquisitions', (req: Request, res: Response) => {
    const parsedBody = CreateAcquisitionBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      fail(res, 400, `invalid acquisition request: ${parsedBody.error.message}`);
      return;
    }
    const body = parsedBody.data;

    const needParse = HistoricalEvidenceNeedSchema.safeParse({
      subject: { shopId: body.shopId, shopName: body.shopName },
      source: 'jd',
      purpose: 'historical_replay',
      window: { start: body.startBusinessDate, end: body.endBusinessDate },
      domains: ['trade', 'orders'],
    });
    if (!needParse.success) {
      fail(res, 400, `invalid evidence need: ${needParse.error.message}`);
      return;
    }
    const need = needParse.data;

    const catalog = listHistoricalDatasets(dataRoot);
    const gap = resolveEvidenceGap(need, catalog.datasets);
    if (gap.kind === 'covered') {
      fail(
        res,
        409,
        `window already covered by existing dataset ${gap.dataset.dirName} — create a replay run instead`,
      );
      return;
    }

    const job = createAcquisitionJob({ db, need, dataRoot });
    // Real acquisition runs out of band (minute-scale Hermes turn).
    void startAcquisitionJob(db, job.id, {
      dataRoot,
      ...(options.turnRunner ? { turnRunner: options.turnRunner } : {}),
    }).catch((err: unknown) => {
      // Programming-error escape hatch; named business failures already
      // land as FAILED/BLOCKED rows inside startAcquisitionJob.
      // eslint-disable-next-line no-console
      console.error(`[acquisition] job ${job.id} crashed`, err);
    });

    ok(res.status(201), {
      jobId: job.id,
      status: job.status,
      intakeDir: job.intakeDir,
      requestedWindow: { start: body.startBusinessDate, end: body.endBusinessDate },
      gap: {
        missingDates: gap.missingDates,
        gapSegments: gap.gapSegments,
        coveredDates: gap.coveredDates,
      },
    });
  });

  router.get('/acquisitions/:id', (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = getAcquisitionJob(db, id ?? '');
    if (!job) {
      fail(res, 404, `acquisition job not found: ${id ?? ''}`);
      return;
    }
    ok(res, job);
  });

  router.get('/acquisitions', (_req: Request, res: Response) => {
    ok(res, { jobs: listRecentAcquisitionJobs(db, 20) });
  });

  // Live trajectory tail for operator observability during a minute-scale
  // blind turn. The Workspace renders neutral progress; the raw ndjson
  // remains the SC10 audit record. Read-only against the intake file.
  router.get('/acquisitions/:id/events', (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = getAcquisitionJob(db, id ?? '');
    if (!job) {
      fail(res, 404, `acquisition job not found: ${id ?? ''}`);
      return;
    }
    const eventsPath = join(job.intakeDir, 'trajectory', 'events.ndjson');
    if (!existsSync(eventsPath)) {
      ok(res, {
        jobId: job.id,
        status: job.status,
        started: false,
        total: 0,
        toolCalls: 0,
        events: [],
      });
      return;
    }
    const raw = readFileSync(eventsPath, 'utf8');
    const parsed: Array<Record<string, unknown>> = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        // Compact + cap payload sizes: full args/results stay only on disk.
        const compact: Record<string, unknown> = { kind: e.kind, at: e.at };
        if (typeof e.name === 'string') compact.name = e.name;
        if (typeof e.duration_s === 'number') compact.duration_s = Math.round(e.duration_s);
        if (typeof e.text === 'string') compact.text = e.text.slice(-400);
        if (typeof e.result === 'string') compact.result = e.result.slice(0, 200);
        if (e.session_id) compact.session_id = e.session_id;
        parsed.push(compact);
      } catch {
        // skip malformed trailing line
      }
    }
    const tail = parsed.slice(-100);
    ok(res, {
      jobId: job.id,
      status: job.status,
      started: true,
      total: parsed.length,
      toolCalls: parsed.filter((e) => e.kind === 'tool.start').length,
      events: tail,
    });
  });

  return router;
};
