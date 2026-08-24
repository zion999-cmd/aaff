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
import { situationChatRouter, runInvestigationTurn } from './routes/situation-chat.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { scheduleRouter } from './routes/schedule.js';
import { outputsRouter } from './routes/outputs.js';
import { openDb } from '#platform/storage/connection.js';
import { HermesSessionClient } from '#platform/runtime/hermes/index.js';
import { loadSituation } from '#app/experience/learning-context-producer.js';
import { createScheduledAcquisitionRunner } from '#app/runtime/scheduling/index.js';
import type { ScheduledAcquisition } from '#app/runtime/scheduling/index.js';

export interface ServerOptions {
  db: Db;
  workspaceDir?: string;
  /**
   * P0010.1 Slice 3 — optional Scheduled Acquisition config. When provided, a
   * minimal scheduler runs the listed capabilities on a daily schedule (REUSE
   * the existing Fabric capability → Evidence path; never judges). Off by
   * default — tests and the plain server do not start any timer.
   */
  schedule?: ScheduledAcquisition[];
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
  // the Situation path (→ automatic investigation for newly created situations).
  if (options.schedule && options.schedule.length > 0) {
    const fabricDir = resolve(process.cwd(), 'data', 'fabric-workspace');
    const runner = createScheduledAcquisitionRunner(db, options.schedule, async () => {
      const { runSituationProducer } = await import('#app/runtime/situation/index.js');
      const result = runSituationProducer(db, { shopId: 'jd_shop_001', shopName: '祁门红茶旗舰店' });
      for (const sid of result.createdIds ?? []) void autoInvestigateSituation(db, fabricDir, sid);
    });
    runner.start();
    app.use('/api', scheduleRouter(runner));
  }

  // P0010.1 Post-Productization REPAIR — minimal Output / WorkItem API.
  // Mounted at /api so the routes inside can be /situations/:id/outputs/...
  app.use('/api', outputsRouter(db));

  // Dashboard SPA (vanilla JS). Served as static files.
  const dashDir = workspaceDir ?? resolve(process.cwd(), 'apps/ecommerce/workspace');
  app.use(express.static(dashDir));

  return app;
};

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
      const result = await kernel.execute({ shopId: 'jd_shop_001', mock: false, date });
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

    // P0010.1 Slice 2 (recovery): automatic investigation — newly created
    // Situations AND existing situations without a COMPLETED investigation are
    // investigated WITHOUT a manual click (steady-state). Failures/timeouts
    // leave a 'failed' marker (recoverable), so no turn is silently lost.
    // Fire-and-forget, processed sequentially in the background; startup is
    // never blocked. Hermes unreachable → the turn fails and is retried later.
    const fabricDir = resolve(process.cwd(), 'data', 'fabric-workspace');
    const todo = new Set<string>(situationResult.createdIds ?? []);
    for (const sid of findRecoveryCandidates(db, todo, MAX_AUTO_INVESTIGATE)) todo.add(sid);
    if (todo.size > 0) {
      void autoInvestigatePending(db, fabricDir, [...todo]);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[backfill] failed:', err instanceof Error ? err.message : String(err));
  }
};

/** Bounded recovery: situations without a completed investigation (old, failed, or stale-investigating).
 * A situation counts as completed if its investigation has status='completed' OR a stopReason
 * (the 4 pre-existing investigations were persisted before the status field existed). */
const MAX_AUTO_INVESTIGATE = 3;
const findRecoveryCandidates = (db: Db, exclude: Set<string>, limit: number): string[] => {
  const rows = db.prepare(
    `SELECT s.situation_id FROM situations s
     WHERE NOT EXISTS (
       SELECT 1 FROM learning_contexts lc
       WHERE lc.situation_id = s.situation_id
         AND (
           json_extract(lc.body, '$.investigation.status') = 'completed'
           OR json_extract(lc.body, '$.investigation.stopReason') IS NOT NULL
         )
     )
     ORDER BY s.observed_at DESC
     LIMIT ?`,
  ).all(limit * 2) as { situation_id: string }[];
  return rows.map((r) => r.situation_id).filter((id) => !exclude.has(id)).slice(0, limit);
};

/** Investigate a list of situations SEQUENTIALLY in the background (no Queue/Engine — a plain loop). */
const autoInvestigatePending = async (db: Db, fabricDir: string, ids: string[]): Promise<void> => {
  for (const sid of ids) {
    await autoInvestigateSituation(db, fabricDir, sid);
  }
};

/** P0010.1: run one P0010 investigation for a situation in a fresh Hermes session. */
export const autoInvestigateSituation = async (db: Db, workspaceDir: string, situationId: string): Promise<void> => {
  const situation = loadSituation(db, situationId);
  if (!situation) return;
  try {
    const client = new HermesSessionClient();
    await client.connect();
    const created = await client.createSession({ cwd: workspaceDir, profile: 'default' });
    const result = await runInvestigationTurn(client, created.sessionId, db, situation);
    // eslint-disable-next-line no-console
    console.log(`[auto-investigate] ${situationId}: ${result.ok ? 'completed' : 'contract error: ' + (result.error ?? '')}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`[auto-investigate] ${situationId}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// CLI entry: `npm run dev` / `npm start`
const main = async (): Promise<void> => {
  const db = openDb();
  // P0010.1 Slice 3: scheduled acquisition config. Disabled by default — the
  // operator explicitly enables capabilities so no surprise CDP runs happen.
  const schedule: ScheduledAcquisition[] = [
    { capability: 'trade.overview', at: '02:00', enabled: false },
    { capability: 'traffic.overview', at: '02:05', enabled: false },
  ];
  startServer({ db, schedule });
  // P0010.1 Final Repair — Area A: idempotent product-catalog bootstrap.
  // Walks every getProductList*.json under data/evidence/jd and projects
  // (spu_id, proName) into the canonical products table so the Situation
  // cards display real product names (not "未知商品 · SKU <id>"). Skippable
  // via BOOTSTRAP_PRODUCT_CATALOG=skip. Failures are logged, never thrown.
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
  // Supplement missing data in the background (non-blocking).
  void backfillRecentData(db);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
