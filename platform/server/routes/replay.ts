// P0013 — /api/replay/runs/... HTTP routes.
//
// §3 (data access boundary), §22 (ReplayRun is a first-class entity),
// §24 (persistence), §32 (runId-scoped isolation at the API layer).
//
// 8 endpoints, all using the ok/fail envelope from platform/server/envelope.ts.
//
// Phase 5.5 (2026-09-03, after acceptance FAILED): the runner's
// `kernel` argument is now a REAL kernel that opens a Hermes WS session
// per run and calls `client.submitPrompt` + `collectTurn` (REUSE
// production plumbing). The OLD `httpStubKernel` (which returned
// `[HTTP-driven stub] No LLM kernel wired at this layer` literals) is
// RETIRED. See apps/ecommerce/runtime/replay/replay-cognition-kernel.ts.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { ok, fail } from '../envelope.js';
import {
  createReplayRun,
  runReplayRunStep,
  pauseReplayRun,
  resumeReplayRun,
  getReplayRunState,
  clearOrphanStep,
  clearFailedCognitionForCurrentDate,
  rearmRunForRetry,
  skipCurrentStep,
  type KernelStepResult,
} from '#app/runtime/replay/replay-runner-p0013.js';
import { createReplayCognitionKernel } from '#app/runtime/replay/replay-cognition-kernel.js';
import {
  appendEnrichment,
  listEnrichmentsForRun,
  earliestStaleDate,
  EnrichmentValidationError,
  type EnrichmentKind,
} from '#app/runtime/replay/enrichment-store.js';
import {
  rerunHistoricalStep,
  resetRunToEarliestStale,
  runReplayRunToCompletion,
} from '#app/runtime/replay/replay-runner-p0013.js';
import {
  loadHistoricalDataset,
  HistoricalDatasetContractError,
} from '#app/runtime/replay/historical-dataset.js';
import { listHistoricalDatasets } from '#app/runtime/replay/dataset-catalog.js';
import { HermesSessionClient } from '#platform/runtime/hermes/session-client.js';
import { connectWithSituationTrace } from './situation-chat.js';
import type { SituationChatClient } from './situation-chat.js';
import { resolve } from 'node:path';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const YMD_MESSAGE = 'must be YYYY-MM-DD';

const singleParam = (v: string | string[] | undefined): string | undefined => {
  if (Array.isArray(v)) return v[0];
  return v;
};

const CreateRunBodySchema = z
  .object({
    shopId: z.string().min(1),
    shopName: z.string().min(1),
    sourceDatasetPath: z.string().min(1),
    // P0013+: the server is the hash authority — it recomputes the real
    // manifest hash from disk. Client-supplied hashes (the legacy UI sent
    // the literal 'placeholder-hash') are ignored.
    sourceManifestHash: z.string().min(1).optional(),
    startBusinessDate: z.string().regex(YMD, YMD_MESSAGE),
    endBusinessDate: z.string().regex(YMD, YMD_MESSAGE),
  })
  .refine((v) => v.startBusinessDate <= v.endBusinessDate, {
    message: 'startBusinessDate must be <= endBusinessDate',
    path: ['endBusinessDate'],
  });

const AdvanceBodySchema = z.object({
  mode: z.enum(['step', 'complete', 'pause', 'resume', 'retry', 'skip']),
});

const loadRunStateOr404 = (
  db: Database.Database,
  runId: string,
  res: Response,
): ReturnType<typeof getReplayRunState> | null => {
  try {
    return getReplayRunState(db, runId);
  } catch {
    fail(res, 404, `Replay run not found: ${runId}`);
    return null;
  }
};

interface ActiveReplaySession {
  readonly client: SituationChatClient;
  readonly hermesSessionId: string;
  readonly kernel: (runId: string, stepId: string, businessDate: string) => Promise<KernelStepResult>;
}

export interface ReplayRouterOptions {
  /** Hermes WS URL. Default: ws://localhost:9120/api/ws. */
  hermesUrl?: string;
  /** Workspace cwd for the Hermes session. Default: data/fabric-workspace. */
  workspaceDir?: string;
  /** Optional profile name passed to createSession. */
  profile?: string;
  /**
   * Inject a custom client factory (for tests). The default is
   * `new HermesSessionClient({ url })` (same constructor as the
   * production chat route uses).
   */
  clientFactory?: (hermesUrl: string) => SituationChatClient;
  /**
   * Root directory scanned by GET /api/replay/datasets. Default:
   * `<cwd>/data` — the P0011.x acquisition root.
   */
  dataRoot?: string;
}

const defaultClientFactory = (hermesUrl: string): SituationChatClient => {
  return new HermesSessionClient(hermesUrl ? { url: hermesUrl } : {}) as unknown as SituationChatClient;
};

export const replayRouter = (db: Database.Database, options: ReplayRouterOptions = {}): Router => {
  const router = Router();
  const hermesUrl = options.hermesUrl ?? process.env['HERMES_WS_URL'] ?? 'ws://localhost:9120/api/ws';
  const workspaceDir = options.workspaceDir ?? resolve(process.cwd(), 'data', 'fabric-workspace');
  const dataRoot = options.dataRoot ?? resolve(process.cwd(), 'data');
  const clientFactory = options.clientFactory ?? defaultClientFactory;

  // Active Replay sessions. One Hermes session per runId, lifetime = the
  // entire Replay run. We mirror the situation-chat pattern: lazy
  // connect on first /advance call, drop the session on run FAILED.
  const sessions = new Map<string, ActiveReplaySession>();

  /** Lazily create the Hermes session + real cognition kernel for a run. */
  const ensureSession = async (runId: string): Promise<ActiveReplaySession> => {
    const existing = sessions.get(runId);
    if (existing) return existing;
    const client = clientFactory(hermesUrl);
    await connectWithSituationTrace(client, `replay-${runId}`);
    const created = await client.createSession({
      cwd: workspaceDir,
      ...(options.profile ? { profile: options.profile } : {}),
    });
    const kernel = createReplayCognitionKernel(db, {
      client,
      sessionId: created.sessionId,
    });
    const active: ActiveReplaySession = { client, hermesSessionId: created.sessionId, kernel };
    sessions.set(runId, active);
    return active;
  };

  /** Drop the cached session (e.g. on FAILED). Next /advance reconnects. */
  const dropSession = (runId: string): void => {
    const s = sessions.get(runId);
    if (!s) return;
    try { s.client.close(); } catch { /* best effort */ }
    sessions.delete(runId);
  };

  // GET /api/replay/datasets — discover on-disk P0011.x acquisition
  // datasets (dirs under dataRoot with a valid PROVENANCE_MANIFEST.json).
  // The start panel renders its shop/coverage/date bounds from this; the
  // list never comes from hardcoded UI literals.
  router.get('/datasets', (_req: Request, res: Response) => {
    try {
      const catalog = listHistoricalDatasets(dataRoot);
      return ok(res, catalog);
    } catch (err: unknown) {
      return fail(res, 500, err instanceof Error ? err.message : 'dataset discovery failed');
    }
  });

  // POST /api/replay/runs — create a new run.
  router.post('/runs', async (req: Request, res: Response) => {
    const parsed = CreateRunBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    try {
      // P0013+: the dataset on disk is the authority for BOTH the provenance
      // hash and the legal run window. A relative path ('data/jd_...') is
      // resolved against cwd exactly like the runner's evidence seed does.
      const datasetPath = resolve(process.cwd(), parsed.data.sourceDatasetPath);
      let dataset;
      try {
        dataset = loadHistoricalDataset(datasetPath);
      } catch (err: unknown) {
        const reason =
          err instanceof HistoricalDatasetContractError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return fail(res, 400, `数据集不可读 (${parsed.data.sourceDatasetPath}): ${reason}`);
      }
      const { startBusinessDate, endBusinessDate } = parsed.data;
      if (
        startBusinessDate < dataset.window.start ||
        endBusinessDate > dataset.window.end
      ) {
        return fail(
          res,
          400,
          `requested window [${startBusinessDate}, ${endBusinessDate}] outside dataset coverage ` +
            `[${dataset.window.start}, ${dataset.window.end}] — No-Future-Leak / No-Past-Coverage`,
        );
      }

      // Coverage Gate (Evidence Contract). A run may only be created for a
      // window the frozen acquisition can actually answer. Dates inside the
      // dataset window but without evidence (null source value, absent
      // per-day aggregate, or an acquisition-declared gap) are an Evidence
      // Gap: they must go through the P0013.1 acquisition path first, not
      // through Replay cognition.
      const uncovered = dataset.coverage.byBusinessDate
        .filter(
          (c) =>
            !c.covered && c.businessDate >= startBusinessDate && c.businessDate <= endBusinessDate,
        )
        .map((c) => ({ businessDate: c.businessDate, reasons: c.reasons }));
      if (uncovered.length > 0) {
        return fail(
          res,
          409,
          `Evidence Coverage Gap: ${uncovered
            .map((u) => `${u.businessDate} (${u.reasons.join(', ')})`)
            .join('; ')} — 该窗口未被冻结数据集覆盖。请先通过 POST /api/replay/acquisitions ` +
            `对该区间发起真实历史采集，采集成功后再用新数据集创建 Replay run。`,
        );
      }
      const run = createReplayRun(db, {
        ...parsed.data,
        sourceDatasetPath: datasetPath,
        sourceManifestHash: dataset.manifestHash,
      });
      return ok(res, {
        runId: run.id,
        status: run.status,
        currentStep: run.currentStep,
        currentBusinessDate: run.currentBusinessDate,
        endBusinessDate: run.endBusinessDate,
        shopId: run.shopId,
        sourceManifestHash: run.sourceManifestHash,
      });
    } catch (err: unknown) {
      return fail(res, 500, err instanceof Error ? err.message : 'create failed');
    }
  });

  // GET /api/replay/runs — list runs.
  router.get('/runs', (_req: Request, res: Response) => {
    try {
      const rows = db
        .prepare(
          `SELECT id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
                  start_business_date, end_business_date, current_business_date,
                  current_step, status, created_at, last_advanced_at, completed_at,
                  blocked_business_date, blocked_reason
           FROM replay_runs
           ORDER BY created_at DESC
           LIMIT 100`,
        )
        .all();
      return ok(res, rows);
    } catch (err: unknown) {
      return fail(res, 500, err instanceof Error ? err.message : 'list failed');
    }
  });

  // GET /api/replay/runs/:runId — full run state.
  router.get('/runs/:runId', (req: Request, res: Response) => {
    const runId = singleParam(req.params['runId']);
    if (!runId) return fail(res, 400, 'runId required');
    const run = loadRunStateOr404(db, runId, res);
    if (!run) return;
    return ok(res, run);
  });

  // POST /api/replay/runs/:runId/advance — advance / pause / resume.
  router.post('/runs/:runId/advance', async (req: Request, res: Response) => {
    const runId = singleParam(req.params['runId']);
    if (!runId) return fail(res, 400, 'runId required');
    const run = loadRunStateOr404(db, runId, res);
    if (!run) return;
    const parsed = AdvanceBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const { mode } = parsed.data;
    try {
      if (mode === 'pause') {
        pauseReplayRun(db, runId);
        return ok(res, { mode, state: getReplayRunState(db, runId) });
      }
      if (mode === 'resume') {
        resumeReplayRun(db, runId);
        return ok(res, { mode, state: getReplayRunState(db, runId) });
      }
      // P0013 G2.2-fix (2026-09-04): 'retry' mode is the recovery path
      // for an orphan RUNNING-step deadlock (kernel crashed mid-flight
      // leaving the step row in RUNNING) OR a FAILED step (kernel
      // returned an error). Flow:
      //   1. Mark any RUNNING step for this run as FAILED with
      //      " [manually retried]" appended to its error.
      //   2. DELETE that FAILED step row (so the next runReplayRunStep
      //      can INSERT a fresh one for the same business_date).
      //   3. Call runReplayRunStep — the kernel re-runs for the same
      //      business_date, giving the operator a fresh attempt.
      // The route uses the same ensureSession + kernel as step mode.
      if (mode === 'retry') {
        clearOrphanStep(db, runId);
        // P0013 correctness patch — retry must be reachable for ANY failed
        // step, not only the ones clearOrphanStep just marked. A step that
        // FAILED on its own (e.g. a Hermes turn timeout) previously blocked
        // retry forever: the runner sees the existing FAILED row and
        // returns FAILED without running. Clear the failed cognition row
        // for the current business date so the kernel can re-INSERT a
        // fresh one. Failed steps carry no snapshot / refs by construction
        // (persistSnapshot is transactional), so nothing else is orphaned.
        clearFailedCognitionForCurrentDate(db, runId);
        // A BLOCKED run is re-armed so the retry actually executes; the
        // coverage gate re-evaluates on the way in.
        rearmRunForRetry(db, runId);
        const active = await ensureSession(runId);
        const result = await runReplayRunStep(db, runId, active.kernel);
        if (result.status === 'FAILED') dropSession(runId);
        return ok(res, { mode, result, state: getReplayRunState(db, runId) });
      }
      // P0013 G2.2-fix (2026-09-04): 'skip' mode is the non-destructive
      // escape hatch. Mark the current step SKIPPED_NO_DATA, advance
      // the clock, and the operator moves on. The step row is preserved
      // (P0013 §22 append-only) so it can be revisited later.
      if (mode === 'skip') {
        skipCurrentStep(db, runId);
        return ok(res, { mode, state: getReplayRunState(db, runId) });
      }
      // step / complete — needs the real Hermes session.
      const active = await ensureSession(runId);
      if (mode === 'step') {
        const result = await runReplayRunStep(db, runId, active.kernel);
        if (result.status === 'FAILED') dropSession(runId);
        return ok(res, { mode, result, state: getReplayRunState(db, runId) });
      }
      // mode === 'complete': step until terminal.
      let lastResult: { status: string; error?: string } = { status: 'RUNNING' };
      for (let i = 0; i < 366; i += 1) {
        const r = await runReplayRunStep(db, runId, active.kernel);
        lastResult = r;
        if (r.status === 'FAILED') {
          dropSession(runId);
          break;
        }
        if (r.status === 'PAUSED') break;
        if (r.status === 'COMPLETED') break;
        const state = getReplayRunState(db, runId);
        if (state.status === 'COMPLETED' || state.status === 'FAILED') break;
      }
      return ok(res, { mode, lastResult, state: getReplayRunState(db, runId) });
    } catch (err: unknown) {
      return fail(res, 500, err instanceof Error ? err.message : 'advance failed');
    }
  });

  // GET /api/replay/runs/:runId/steps — list steps.
  router.get('/runs/:runId/steps', (req: Request, res: Response) => {
    const runId = singleParam(req.params['runId']);
    if (!runId) return fail(res, 400, 'runId required');
    const run = loadRunStateOr404(db, runId, res);
    if (!run) return;
    try {
      const rows = db
        .prepare(
          `SELECT id, replay_run_id, step_number, business_date, status, error,
                  started_at, completed_at, enrichment_stale_at
           FROM replay_run_steps
           WHERE replay_run_id = ?
           ORDER BY step_number ASC`,
        )
        .all(runId);
      return ok(res, rows);
    } catch (err: unknown) {
      return fail(res, 500, err instanceof Error ? err.message : 'list steps failed');
    }
  });

  // GET /api/replay/runs/:runId/steps/:businessDate — single step + snapshot.
  router.get('/runs/:runId/steps/:businessDate', (req: Request, res: Response) => {
    const runId = singleParam(req.params['runId']);
    const businessDate = singleParam(req.params['businessDate']);
    if (!runId || !businessDate) return fail(res, 400, 'runId + businessDate required');
    if (!YMD.test(businessDate)) return fail(res, 400, 'businessDate must be YYYY-MM-DD');
    try {
      const step = db
        .prepare(
          `SELECT s.id AS step_id, s.step_number, s.business_date, s.status, s.error,
                  s.started_at, s.completed_at, s.enrichment_stale_at
           FROM replay_run_steps s
           WHERE s.replay_run_id = ? AND s.business_date = ?`,
        )
        .get(runId, businessDate) as
        | {
            step_id: string;
            step_number: number;
            business_date: string;
            status: string;
            error: string | null;
            started_at: string | null;
            completed_at: string | null;
          }
        | undefined;
      if (!step) return fail(res, 404, `No step at ${businessDate} for run ${runId}`);
      const snap = db
        .prepare(
          `SELECT id, business_date, observed_facts, current_understanding, judgment,
                  recommendation_kind, recommendation_text, unknowns, evidence_gaps,
                  supporting_evidence_refs, temporal_boundary_checked_at, created_at
           FROM replay_run_cognitive_snapshots
           WHERE replay_run_step_id = ?`,
        )
        .get(step.step_id);
      const refs = db
        .prepare(
          `SELECT evidence_observation_id, eo.business_date
           FROM replay_run_evidence_refs r
           JOIN evidence_observations eo ON eo.id = r.evidence_observation_id
           WHERE r.replay_run_step_id = ?`,
        )
        .all(step.step_id);
      return ok(res, { step, snapshot: snap, evidenceRefs: refs });
    } catch (err: unknown) {
      return fail(res, 500, err instanceof Error ? err.message : 'get step failed');
    }
  });

  // ── P0013.3 Historical Evidence Enrichment ──────────────────────────

  // Append an operator enrichment (fact | action | operator_feedback)
  // and mark cognition at/after businessDate stale. Append-only; the
  // frozen dataset is never touched.
  router.post('/runs/:runId/enrichments', (req: Request, res: Response) => {
    const runId = singleParam(req.params['runId']);
    if (!runId) return fail(res, 400, 'runId required');
    if (!loadRunStateOr404(db, runId, res)) return;
    const parsed = z
      .object({
        businessDate: z.string().regex(YMD),
        kind: z.enum(['fact', 'action', 'operator_feedback']),
        content: z.string().min(1),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return fail(
        res,
        400,
        `bad enrichment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    try {
      const { enrichment, staleDates } = appendEnrichment(db, runId, {
        businessDate: parsed.data.businessDate,
        kind: parsed.data.kind as EnrichmentKind,
        content: parsed.data.content,
      });
      return ok(res.status(201), { enrichment, staleDates });
    } catch (err: unknown) {
      if (err instanceof EnrichmentValidationError) return fail(res, 400, err.message);
      return fail(res, 500, err instanceof Error ? err.message : 'append enrichment failed');
    }
  });

  // List enrichments (all run, or ?businessDate= for the selected day).
  router.get('/runs/:runId/enrichments', (req: Request, res: Response) => {
    const runId = singleParam(req.params['runId']);
    if (!runId) return fail(res, 400, 'runId required');
    if (!loadRunStateOr404(db, runId, res)) return;
    const all = listEnrichmentsForRun(db, runId);
    const day = typeof req.query['businessDate'] === 'string' ? req.query['businessDate'] : null;
    const rows = day ? all.filter((e) => e.businessDate === day) : all;
    return ok(res, {
      enrichments: rows,
      enrichedDates: [...new Set(all.map((e) => e.businessDate))],
    });
  });

  // Replay after enrichment:
  //   {mode:'day', businessDate} → recompute one historical day
  //   {mode:'stale'}             → continuous replay from earliest stale date
  router.post('/runs/:runId/rerun', async (req: Request, res: Response) => {
    const runId = singleParam(req.params['runId']);
    if (!runId) return fail(res, 400, 'runId required');
    if (!loadRunStateOr404(db, runId, res)) return;
    const mode = req.body?.['mode'] === 'day' ? 'day' : req.body?.['mode'] === 'stale' ? 'stale' : null;
    if (!mode) return fail(res, 400, "mode must be 'day' or 'stale'");
    // NO_STALE is resolved without a Hermes session (read-only check).
    try {
      if (mode === 'stale' && earliestStaleDate(db, runId) === null) {
        return ok(res, { mode, result: { status: 'NO_STALE' }, state: getReplayRunState(db, runId) });
      }
      const active = await ensureSession(runId);
      if (mode === 'day') {
        const businessDate = String(req.body?.['businessDate'] ?? '');
        if (!YMD.test(businessDate)) return fail(res, 400, 'businessDate must be YYYY-MM-DD');
        const result = await rerunHistoricalStep(db, runId, businessDate, active.kernel);
        if (result.status === 'FAILED') dropSession(runId);
        return ok(res, { mode, result, state: getReplayRunState(db, runId) });
      }
      const reset = resetRunToEarliestStale(db, runId);
      if (!reset) {
        return ok(res, { mode, result: { status: 'NO_STALE' }, state: getReplayRunState(db, runId) });
      }
      const completion = await runReplayRunToCompletion(db, runId, active.kernel);
      if (completion.status === 'FAILED') dropSession(runId);
      return ok(res, {
        mode,
        from: reset.businessDate,
        replayedDates: reset.staleDates,
        result: completion,
        state: getReplayRunState(db, runId),
      });
    } catch (err: unknown) {
      return fail(res, 500, err instanceof Error ? err.message : 'rerun failed');
    }
  });

  // GET /api/replay/runs/:runId/monthly-reviews — list.
  router.get('/runs/:runId/monthly-reviews', (req: Request, res: Response) => {
    const runId = singleParam(req.params['runId']);
    if (!runId) return fail(res, 400, 'runId required');
    const run = loadRunStateOr404(db, runId, res);
    if (!run) return;
    try {
      const rows = db
        .prepare(
          `SELECT id, replay_run_id, business_month, data_coverage_start, data_coverage_end,
                  coverage_status, missing_dates, created_at
           FROM replay_monthly_reviews
           WHERE replay_run_id = ?
           ORDER BY business_month ASC`,
        )
        .all(runId);
      return ok(res, rows);
    } catch (err: unknown) {
      return fail(res, 500, err instanceof Error ? err.message : 'list monthly reviews failed');
    }
  });

  // GET /api/replay/runs/:runId/monthly-reviews/:businessMonth — single review.
  router.get('/runs/:runId/monthly-reviews/:businessMonth', (req: Request, res: Response) => {
    const runId = singleParam(req.params['runId']);
    const month = singleParam(req.params['businessMonth']);
    if (!runId || !month) return fail(res, 400, 'runId + businessMonth required');
    if (!/^\d{4}-\d{2}$/.test(month)) return fail(res, 400, 'businessMonth must be YYYY-MM');
    try {
      const row = db
        .prepare(
          `SELECT id, replay_run_id, business_month, data_coverage_start, data_coverage_end,
                  coverage_status, missing_dates, body_json, created_at
           FROM replay_monthly_reviews
           WHERE replay_run_id = ? AND business_month = ?`,
        )
        .get(runId, month);
      if (!row) return fail(res, 404, `No monthly review for ${month}`);
      return ok(res, row);
    } catch (err: unknown) {
      return fail(res, 500, err instanceof Error ? err.message : 'get review failed');
    }
  });

  return router;
};
