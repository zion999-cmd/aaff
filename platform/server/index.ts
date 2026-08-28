// Express HTTP server. Mounts API routes + serves the workspace SPA.

import express from 'express';
import type { Express } from 'express';
import type { Database as Db } from 'better-sqlite3';
import { resolve } from 'node:path';
import { healthRouter } from './routes/health.js';
import { rankingRouter } from './routes/ranking.js';
import { memoryRouter, reviewsRouter, traceRouter } from './routes/reviews.js';
import { workspaceRouter } from './routes/workspace.js';
import { chatRouter } from './routes/chat.js';
import { runtimeRouter } from './routes/runtime.js';
import { p0007Router } from './routes/p0007.js';
import { situationChatRouter } from './routes/situation-chat.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { scheduleRouter } from './routes/schedule.js';
import { outputsRouter } from './routes/outputs.js';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { createScheduledAcquisitionRunner } from '#app/runtime/scheduling/index.js';
import type { ScheduledAcquisition } from '#app/runtime/scheduling/index.js';
import { createRuntimeLoop } from '#app/runtime/loop/index.js';
import { stdoutSink } from '#app/runtime/loop/loop-events.js';
import { runtimeLoopRouter } from './routes/runtime-loop.js';

export interface ServerOptions {
  db: Db;
  workspaceDir?: string;
  /**
   * P0010.1 Slice 3 — optional Scheduled Acquisition config. When provided, a
   * minimal scheduler runs the listed capabilities on a daily schedule (REUSE
   * the existing Fabric capability → Evidence path; never judges). Off by
   * default — tests and the plain server do not start any timer.
   *
   * P0010.2 — the same config is reused as the RuntimeLoop's schedule. The
   * Loop's setInterval owns the cadence; the runner's own timer is
   * disabled. Pass `runtimeLoop: false` to start the plain scheduler
   * (per-day-at-HH:MM) instead of the Loop (every 60s).
   */
  schedule?: ScheduledAcquisition[];
  /**
   * P0010.2 — when true (default), the RuntimeLoop owns cadence and the
   * `schedule` config runs every `tickMs` (60s by default). When false,
   * the per-day-at-HH:MM scheduler is used instead (legacy P0010.1 mode).
   */
  runtimeLoop?: boolean;
}

/** Create the Express app with all routes mounted. */
export const createServer = (options: ServerOptions): Express => {
  const { db, workspaceDir } = options;
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // API routes.
  app.use('/api', healthRouter());
  app.use('/api', rankingRouter(db));
  app.use('/api', reviewsRouter(db));
  app.use('/api', memoryRouter(db));
  app.use('/api', traceRouter(db));
  app.use('/api', workspaceRouter(db));
  app.use('/api', chatRouter(db));
  app.use('/api', runtimeRouter(db));
  app.use('/api', p0007Router(db));
  // P0008.3 — Situation Chat Bridge (Hermes session integration).
  // Lazy: only connects to Hermes serve on first chat. Session mapping held server-side.
  app.use(
    '/api',
    situationChatRouter({
      workspaceDir: resolve(process.cwd(), 'data', 'fabric-workspace'),
      profile: 'default',
      db,
    }),
  );

  // P0008.4 §10 — Knowledge Ingest control (Fabric side): status + launch Hermes
  // to run the KNOWLEDGE.md Ingest flow. Shares the same Fabric Workspace dir.
  app.use(
    '/api',
    knowledgeRouter({
      workspaceDir: resolve(process.cwd(), 'data', 'fabric-workspace'),
      profile: 'default',
      db,
    }),
  );

  // P0010.1 Slice 3 — Scheduled Acquisition (optional). Reuses the existing
  // capability → Evidence path; after a successful run, feeds new evidence into
  // the Situation path. P0010.2.2 — investigation is owned by the
  // RuntimeLoop's recovery scan (no parallel auto-investigate chain).
  if (options.schedule && options.schedule.length > 0) {
    const runner = createScheduledAcquisitionRunner(db, options.schedule, async () => {
      const { runSituationProducer } = await import('#app/runtime/situation/index.js');
      runSituationProducer(db, { shopId: 'jd_shop_001', shopName: '祁门红茶旗舰店' });
    });
    runner.start();
    app.use('/api', scheduleRouter(runner));
  }

  // P0010.1 Post-Productization REPAIR — minimal Output / WorkItem API.
  // Mounted at /api so the routes inside can be /situations/:id/outputs/...
  app.use('/api', outputsRouter(db));

  // P0010.2 — Continuous Business Runtime HTTP control surface.
  // Mounted only when the Loop is the active scheduler (the legacy per-day
  // scheduler path keeps its own route and does not expose the Loop API).
  if (options.runtimeLoop !== false) {
    const loop = createRuntimeLoop({
      db,
      ...(options.schedule ? { schedule: options.schedule } : {}),
      workspaceDir: resolve(process.cwd(), 'data', 'fabric-workspace'),
      // P0010.2 closure — wire the Loop's onEvent to the in-memory trace
      // buffer so every LoopEvent (scheduled / skipped / blocked / completed)
      // shows up in the right-pane Execution Trace. The default sink
      // (`formatLoopEventFallback`) only console.logs; without this wire
      // the operator only sees the agent.connect.* events from the session
      // client and never knows whether the Runtime actually scheduled
      // something. `stdoutSink` is the loop's single source of truth for
      // LoopEvent → console + TraceEvent mapping (see loop-events.ts).
      onEvent: stdoutSink,
    });
    app.use('/api', runtimeLoopRouter(loop));
    // Capture on a module-level ref so CLI / main() can start it after the
    // server is up (avoids racing the HTTP server with the first tick).
    pendingLoop = loop;
  }

  // Dashboard SPA (vanilla JS). Served as static files.
  const dashDir = workspaceDir ?? resolve(process.cwd(), 'apps/ecommerce/workspace');
  app.use(express.static(dashDir));

  return app;
};

// P0010.2 — exposed so main() can start the Loop after the HTTP server is up.
// Set by createServer when runtimeLoop !== false.
let pendingLoop: { start: () => void; stop: () => void; tickNow: () => Promise<unknown>; list: () => unknown } | null = null;
export const _getPendingLoop = () => pendingLoop;
export const _resetPendingLoop = () => { pendingLoop = null; };

/** Start the server on a port. Returns the http.Server. */
export const startServer = (options: ServerOptions, port: number = Number(process.env.PORT ?? 3000)) => {
  const app = createServer(options);
  return app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[agentFabric] workspace running at http://localhost:${port}`);
  });
};

// P0009: supplement missing recent data on startup. Traverses the last N days and
// runs the runtime pipeline with a local-first (live-on-miss) acquire, so the
// "今日工作" / "经营观察" views have up-to-date signals/rankings with timestamps.
// Runs in the background — never blocks the HTTP server.
const backfillRecentData = async (db: Db, days = 7): Promise<void> => {
  try {
    const { createRuntimeKernel } = await import('#app/runtime/kernel/index.js');
    const { loadBlueprint } = await import('#app/connectors/binding/loader.js');
    const { createLocalFirstLiveAcquire } = await import('#app/connectors/jd/historical-acquire.js');

    const blueprint = loadBlueprint('jd');
    const kernel = createRuntimeKernel(db, blueprint, createLocalFirstLiveAcquire());

    // Prepare the JD browser session (Chrome + 商智 page) — the acquisition
    // dependency. Idempotent; login itself stays a human boundary (Pass 1.1).
    const { ensureJdSession } = await import('#app/connectors/jd/acquisition/session-lifecycle.js');
    const session = await ensureJdSession();
    // eslint-disable-next-line no-console
    console.log(
      `[backfill] jd session: chrome=${session.chrome} page=${session.jdPage}` +
        (session.ready ? '' : ' (acquisition will fail honestly if not logged in)'),
    );

    const to = new Date(Date.now() - 86400_000); // yesterday (today is not final yet)
    const from = new Date(to.getTime() - (days - 1) * 86400_000);
    const dates: string[] = [];
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    let completed = 0;
    let latestTopProducts: import('#app/connectors/jd/parsers/index.js').JdProductTopEntry[] = [];
    const missed: string[] = [];
    for (const date of dates) {
      // P0010.2.11 C1 — backfill is productTop → rankings → situations.
      // trade.overview and traffic.overview MUST NOT run here, because
      // without the capability filter, the planner falls back to ALL
      // capabilities, and trade.overview falls through to the OLD
      // snapshot walker (writes `summary` / `trend` evidence — the wrong
      // dataType, rejected by P0010.2.10). traffic.overview has no
      // acquire function and writes only 1 wrong evidence file per day.
      // Scope backfill to the only capability whose data it consumes.
      const result = await kernel.execute({
        shopId: 'jd_shop_001',
        mock: false,
        date,
        capabilities: ['product.overview'],
      });
      if (result.success) {
        completed++;
        if (result.parsed?.top_products && result.parsed.top_products.length > 0) {
          latestTopProducts = result.parsed.top_products;
        }
      } else {
        missed.push(`${date}${result.errors.length > 0 ? ` (${result.errors[0]})` : ''}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[backfill] ${completed}/${dates.length} days completed (${dates[0]} ~ ${dates[dates.length - 1]})` +
        (missed.length > 0 ? ` · ${missed.length} missed: ${missed.join('; ')}` : ''),
    );

    // Regenerate rankings from the JD productTop (real per-SKU GMV).
    // Ranking Data Consolidation: the stale agentCMS migration data is REMOVED from
    // the canonical ranking input — productTop is now the only source. No JD data
    // means no ranking (honest empty, no fabricated differences).
    const { RankingFacade } = await import('#app/analysis/decision/facade.js');
    const { generateProductTopSignals } = await import('#app/analysis/metrics/product-top-signals.js');
    const { TraceFacade } = await import('#app/analysis/explainability/facade.js');
    const productTopSignals = generateProductTopSignals(latestTopProducts);
    if (productTopSignals.length > 0) {
      const rankings = RankingFacade.rankByProfile(productTopSignals, 'operator_mode', []);
      RankingFacade.store(db, 'operator_mode', rankings);

      // Explainability/Trust Consolidation: wire the real productTop ranking into
      // the existing buildTrace → business_traces producer. One trace per ranking;
      // trust is computed from the ranking's real confidence (0.9) / coverage (0.2).
      const namesByEntity = new Map(latestTopProducts.map((p) => [p.sku_id, p.name]));
      rankings.forEach((ranking, index) => {
        const entitySignals = productTopSignals.filter((s) => s.entity_id === ranking.entity_id);
        TraceFacade.store(
          db,
          TraceFacade.explainRanking({
            ranking,
            entitySignals,
            profile: 'operator_mode',
            rank: index + 1,
            entityName: namesByEntity.get(ranking.entity_id),
          }),
        );
      });

      // eslint-disable-next-line no-console
      console.log(`[backfill] rankings regenerated from JD productTop (${rankings.length} ranked / ${productTopSignals.length} signals) · ${rankings.length} traces persisted`);
    }

    // P0009.1: generate Situations from the completed Signals/Rankings.
    // Idempotent — deterministic ids dedupe across restarts. No acquisition, no LLM.
    const { runSituationProducer } = await import('#app/runtime/situation/index.js');
    const situationResult = runSituationProducer(db, {
      shopId: 'jd_shop_001',
      shopName: '祁门红茶旗舰店',
    });
    // eslint-disable-next-line no-console
    console.log(`[backfill] situations: ${situationResult.created} created / ${situationResult.skipped} deduped`);

    // P0010.2.2 — Investigation Recovery is owned by the RuntimeLoop (every
    // tick) via `listRecoverableCandidates`. The Loop's first tick will
    // pick up any pre-existing open situations whose investigation was
    // never run / was interrupted / is retryable. We deliberately do NOT
    // call any startup-time recovery helper here — that would be a
    // second recovery path, which the user explicitly forbade. (See
    // ADR-058 for the rationale.)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[backfill] failed:', err instanceof Error ? err.message : String(err));
  }
};

// CLI entry: `npm run dev` / `npm start`
const main = async (): Promise<void> => {
  const db = openDb();
  // P0010.2: schedule is enabled by default and the RuntimeLoop owns
  // cadence (every 60s, configurable via RUNTIME_LOOP_TICK_MS). The
  // `at` field is now informational only — the Loop ticks on its own
  // clock, not on a daily HH:MM. Pass `runtimeLoop: false` to fall back
  // to the per-day-at-HH:MM scheduler.
  // P0010.2.11 Step 1: traffic.overview is disabled at the scheduler boundary.
  // There is no `acquireJdTrafficOverviewViaCDP` and the planner's local-first
  // path for traffic falls through to the OLD snapshot walker, writing wrong
  // evidence (only 1 of 11 planned endpoints actually writes a file, and that
  // file is a product list, not traffic metrics). Re-enable when a page-driven
  // traffic acquire exists AND the catalog/parser-plan endpoint mismatch is
  // reconciled. See [[p0010-2-11a-traffic-overview-broken]].
  const schedule: ScheduledAcquisition[] = [
    { capability: 'trade.overview', at: '00:00', enabled: true },
    { capability: 'traffic.overview', at: '00:00', enabled: false },
  ];
  // P0010.1 Final Repair — Area A: idempotent product-catalog bootstrap.
  // Walks every getProductList*.json under data/evidence/jd and projects
  // (spu_id, proName) into the canonical products table so the Situation
  // cards display real product names (not "未知商品 · SKU <id>"). Skippable
  // via BOOTSTRAP_PRODUCT_CATALOG=skip. Failures are logged, never thrown.
  //
  // P0010.2.3 (audit A-1 fix): MUST run BEFORE startServer(). Otherwise the
  // first /api/situations request races the bootstrap and the Situation
  // producer inserts `entity_name = NULL` for every row (the catalog is
  // empty at producer time). The UI then falls back to "未知商品 · SKU <id>".
  //
  // The schema (products / situations / signals tables) is normally created
  // inside startServer(). On a fresh DB (no schema yet) bootstrap would run
  // against an empty schema and silently skip every file. So we explicitly
  // call initDatabase() here — it is idempotent (all `apply*` use
  // CREATE TABLE IF NOT EXISTS), so the duplicate call inside startServer
  // is a no-op.
  initDatabase(db);
  try {
    const { bootstrapProductCatalog } = await import(
      '#app/connectors/jd/product-catalog-bootstrap.js'
    );
    await bootstrapProductCatalog(db);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[bootstrap] product-catalog bootstrap failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
  startServer({ db, schedule });
  // Start the Loop after the HTTP server is listening. The Loop's first
  // tick runs after `tickMs` (60s) so it does not race the server start.
  // Force an immediate first tick so the operator sees a log line within
  // seconds of `npm run dev` (the user-stated acceptance criterion).
  const loop = _getPendingLoop();
  if (loop) {
    loop.start();
    // eslint-disable-next-line no-console
    console.log('[loop] loop started (continuous business runtime)');
  }
  // Supplement missing data in the background (non-blocking).
  void backfillRecentData(db);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
