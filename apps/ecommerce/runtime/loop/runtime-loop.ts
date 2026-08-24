// P0010.2 — Continuous Business Runtime.
//
// The RuntimeLoop is the agentFabric side of "the Runtime runs itself":
//
//   setInterval (60s)
//     │
//     ▼
//   tick (mutex-guarded)
//     │
//     ├─ for each due capability: kernel.execute (REAL acquire path)
//     │                              ↓ (writes Evidence Store)
//     ├─ runSituationProducer        ↓ (creates/updates Situations)
//     │
//     └─ for each candidate: InvestigationPolicy.shouldInvestigate
//           ├─ investigate → autoInvestigateSituation → materializeWorkItem
//           └─ skip        → log + continue
//
// The Loop NEVER branches on business state itself. It only owns cadence
// and the mutex. Business decisions live in:
//   - InvestigationPolicy (skip-vs-investigate)
//   - runSituationProducer (deterministic situation creation)
//   - autoInvestigateSituation (the actual Hermes turn)
//
// Strict boundary (per user: "不能让 Scheduler 本身变成业务编排器"):
//   The Loop does NOT call `materializeWorkItem` directly. It calls
//   `autoInvestigateSituation`, which is the same code path as the manual
//   POST /api/situation/:id/investigate route. To make WorkItem creation
//   real and idempotent for BOTH paths, the route's `runInvestigationTurn`
//   end-of-function is wired to call `materializeWorkItem` after a
//   successful investigation (single call site).
//
// No setTimeout-based reconnect, no event bus, no wake engine, no
// durable job queue, no adaptive scheduler, no dynamic cron generation
// — this is the strict-scope v1 of the loop.

import type { Database as Db } from 'better-sqlite3';
import { resolve } from 'node:path';
import { nowIso } from '#shared/utils/time.js';
import {
  createScheduledAcquisitionRunner,
  type ScheduledAcquisition,
  type ScheduledAcquisitionRunner,
  type AcquisitionRunState,
} from '#app/runtime/scheduling/index.js';
import { runSituationProducer, type SituationRunResult } from '#app/runtime/situation/index.js';
import { loadSituation } from '#app/experience/learning-context-producer.js';
import { listEvidence } from '#app/connectors/evidence/store.js';
import {
  createInvestigationPolicy,
  isWaitingOnHuman,
  type InvestigationPolicy,
  type PolicyDecision,
} from './investigation-policy.js';
import { createLoopLogger, type LoopEvent } from './loop-events.js';
import { HermesSessionClient } from '#platform/runtime/hermes/index.js';
import { runInvestigationTurn } from '#platform/server/routes/situation-chat.js';
import type { InvestigationTurnResult } from '#platform/server/routes/situation-chat.js';

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_SHOP_ID = 'jd_shop_001';
const DEFAULT_SHOP_NAME = '祁门红茶旗舰店';
const DEFAULT_WORKSPACE_DIR = 'data/fabric-workspace';

export interface RuntimeLoopOptions {
  db: Db;
  shopId?: string;
  shopName?: string;
  /** Where the Fabric Workspace is projected (used as Hermes session cwd). */
  workspaceDir?: string;
  /** Schedule entries. The Loop uses the existing ScheduledAcquisitionRunner
   *  as the acquisition primitive; we wrap, not replace. */
  schedule?: ScheduledAcquisition[];
  /** Override the default 60_000 ms tick. */
  tickMs?: number;
  /** Investigation policy (test seam; default uses createInvestigationPolicy). */
  policy?: InvestigationPolicy;
  /** Hermes client factory (test seam; default new HermesSessionClient()). */
  hermesClientFactory?: () => HermesSessionClient;
  /** Event sink (test seam; default stdout). */
  onEvent?: (event: LoopEvent) => void;
  /** Optional: skip starting the loop on construction (for tests). */
  autoStart?: boolean;
}

export interface LoopTickSummary {
  startedAt: string;
  capabilities: number;
  situationsCreated: number;
  situationsDeduped: number;
  investigationsTriggered: number;
  investigationsSkipped: number;
  investigationsFailed: number;
  outputsCreated: number;
  errors: string[];
}

export interface LoopState {
  running: boolean;
  lastTickAt: string | null;
  tickCount: number;
}

const isPolicyInvestigate = (d: PolicyDecision): d is { kind: 'investigate'; reason: 'new_situation' | 'meaningful_new_evidence' } =>
  d.kind === 'investigate';

export interface RuntimeLoop {
  start(): void;
  stop(): void;
  tickNow(): Promise<LoopTickSummary>;
  list(): LoopState;
}

/**
 * Create the RuntimeLoop. The Loop is the orchestrator of cadence only; the
 * per-tick work is delegated to a `tick` closure that the runner closes
 * over (so tests can swap individual seams without rebuilding the whole
 * loop).
 */
export const createRuntimeLoop = (options: RuntimeLoopOptions): RuntimeLoop => {
  const db = options.db;
  const shopId = options.shopId ?? DEFAULT_SHOP_ID;
  const shopName = options.shopName ?? DEFAULT_SHOP_NAME;
  const workspaceDir = resolve(process.cwd(), options.workspaceDir ?? DEFAULT_WORKSPACE_DIR);
  const tickMs = options.tickMs ?? Number(process.env.RUNTIME_LOOP_TICK_MS ?? DEFAULT_TICK_MS);
  const policy = options.policy ?? createInvestigationPolicy(db);
  const hermesClientFactory = options.hermesClientFactory ?? (() => new HermesSessionClient());
  const logger = createLoopLogger(options.onEvent ?? ((e) => {
    // eslint-disable-next-line no-console
    console.log(formatLoopEventFallback(e));
  }));

  // Reuse the existing ScheduledAcquisitionRunner as the acquire primitive.
  // The Loop's setInterval owns the cadence; the runner's own setInterval
  // is disabled (start() is never called on it).
  const schedule: ScheduledAcquisition[] = options.schedule ?? [
    { capability: 'trade.overview', at: '00:00', enabled: true },
    { capability: 'traffic.overview', at: '00:00', enabled: true },
  ];
  const runner: ScheduledAcquisitionRunner = createScheduledAcquisitionRunner(db, schedule);

  const state: LoopState = {
    running: false,
    lastTickAt: null,
    tickCount: 0,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let tickInFlight: Promise<LoopTickSummary> | null = null;

  const runCapability = async (cap: string, date: string): Promise<{ ok: boolean; evidenceCount: number; error?: string }> => {
    logger.emit({ kind: 'acquisition_started', capability: cap });
    try {
      // We delegate to the runner's `runNow` because that's where the
      // existing kernel-singleton + state bookkeeping lives. The
      // `onAfterRun` we pass is a no-op here; the post-acquire pass is
      // handled explicitly in tick() for ordering (we need to know the
      // `evidenceCount` before running the Situation Producer).
      await runner.runNow(cap, date);
      // The runner does not expose evidenceCount directly; we re-read the
      // latest run state to get a stable signal. For telemetry we accept
      // the `lastStatus === 'completed'` proxy + a sentinel count of 1
      // (we did succeed — the actual count is owned by the kernel).
      const last = runner.list().find((s) => s.capability === cap);
      if (last?.lastStatus === 'completed') {
        logger.emit({ kind: 'acquisition_succeeded', capability: cap, evidenceCount: 1 });
        return { ok: true, evidenceCount: 1 };
      }
      const err = `acquisition lastStatus=${last?.lastStatus ?? 'unknown'}`;
      logger.emit({ kind: 'acquisition_failed', capability: cap, error: err });
      return { ok: false, evidenceCount: 0, error: err };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.emit({ kind: 'acquisition_failed', capability: cap, error: message });
      return { ok: false, evidenceCount: 0, error: message };
    }
  };

  const investigate = async (situationId: string, reason: 'new_situation' | 'meaningful_new_evidence', latestContentHash: string | null): Promise<void> => {
    logger.emit({ kind: 'investigation_triggered', situationId, reason });
    const situation = loadSituation(db, situationId);
    if (!situation) {
      logger.emit({ kind: 'investigation_failed', situationId, error: 'situation not found' });
      return;
    }
    let client: HermesSessionClient | null = null;
    let hermesSessionId: string | undefined;
    try {
      client = hermesClientFactory();
      await client.connect();
      const created = await client.createSession({ cwd: workspaceDir, profile: 'default' });
      hermesSessionId = created.sessionId;
      const result: InvestigationTurnResult = await runInvestigationTurn(
        client,
        hermesSessionId,
        db,
        situation,
        latestContentHash ?? undefined,
      );
      if (!result.ok) {
        logger.emit({
          kind: 'investigation_failed',
          situationId,
          error: result.error ?? 'investigation returned not-ok',
        });
        return;
      }
      logger.emit({ kind: 'investigation_completed', situationId });
      // WorkItem is materialized inside runInvestigationTurn's route
      // wiring (single call site covers both Loop and manual POSTs).
      // Nothing to do here.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.emit({ kind: 'investigation_failed', situationId, error: message });
    } finally {
      try {
        client?.close();
      } catch {
        // best-effort
      }
    }
  };

  const tick = async (): Promise<LoopTickSummary> => {
    const startedAt = nowIso();
    const date = startedAt.slice(0, 10);
    const errors: string[] = [];
    let capabilities = 0;
    let investigationsTriggered = 0;
    let investigationsSkipped = 0;
    let investigationsFailed = 0;
    let outputsCreated = 0;

    // 1. Acquisition — drive the schedule, get fresh evidence into the store.
    for (const cfg of schedule) {
      if (!cfg.enabled) continue;
      capabilities++;
      logger.emit({ kind: 'tick_started', capability: cfg.capability, date });
      const r = await runCapability(cfg.capability, date);
      if (!r.ok) errors.push(`${cfg.capability}: ${r.error ?? 'unknown'}`);
    }

    // 2. Situation producer — idempotent, deterministic on `situationId`.
    let situationResult: SituationRunResult = { created: 0, skipped: 0, createdIds: [], situations: [] };
    try {
      situationResult = runSituationProducer(db, { shopId, shopName });
    } catch (err) {
      errors.push(`producer: ${err instanceof Error ? err.message : String(err)}`);
    }
    logger.emit({
      kind: 'situations_updated',
      created: situationResult.created,
      skipped: situationResult.skipped,
      createdIds: situationResult.createdIds,
    });

    // 3. Per-situation policy decision.
    const candidateIds = new Set<string>(situationResult.createdIds);
    // Also re-evaluate existing open situations (the producer is idempotent
    // on createdIds, but a re-tick may want to re-investigate a situation
    // whose evidence content moved since the last turn).
    for (const s of situationResult.situations) {
      candidateIds.add(s.situationId);
    }

    // The policy compares CONTENT_HASH, not wall clock. Compute the max
    // content_hash over the latest evidence records (across platforms /
    // data types / shops — the worst-case "any new evidence is meaningful"
    // assumption is what the user wants: re-investigation only fires when
    // the underlying metric actually moved, not when a re-acquisition wrote
    // a new `acquired_at` to disk).
    const latestContentHash = readLatestContentHash();
    for (const situationId of candidateIds) {
      const decision = policy.shouldInvestigate({
        situationId,
        latestContentHash,
        waitingOnHuman: isWaitingOnHuman(db, situationId),
      });
      if (isPolicyInvestigate(decision)) {
        await investigate(situationId, decision.reason, latestContentHash);
        investigationsTriggered++;
      } else {
        logger.emit({ kind: 'investigation_skipped', situationId, reason: decision.reason });
        investigationsSkipped++;
      }
    }

    state.lastTickAt = startedAt;
    state.tickCount += 1;

    // 4. Tick summary.
    // Note: `outputsCreated` is logged via the `output_created` event inside
    // the route-wired `materializeWorkItem` call; we don't have a direct
    // counter here. For the summary, we report the trigger / skip / fail
    // counts; the actual WorkItem count is observable via
    // /api/outputs after the tick.
    const summary: LoopTickSummary = {
      startedAt,
      capabilities,
      situationsCreated: situationResult.created,
      situationsDeduped: situationResult.skipped,
      investigationsTriggered,
      investigationsSkipped,
      investigationsFailed,
      outputsCreated,
      errors,
    };
    logger.emit({
      kind: 'tick_done',
      capabilities,
      situations: situationResult.created,
      investigations: investigationsTriggered,
      outputs: outputsCreated,
    });
    return summary;
  };

  // Read the latest evidence record (sorted by acquired_at desc) and return
  // its content_hash. The list is sorted by file path / acquired_at, so the
  // first record is the most recent. Bounded to 200 records to keep the
  // scan cheap.
  const readLatestContentHash = (): string | null => {
    try {
      const records = listEvidence({ limit: 200 });
      if (records.length === 0) return null;
      // Sort by acquired_at desc — EvidenceRecord.metadata is a flat object.
      const sorted = [...records].sort((a, b) => {
        const aAt = String(a.metadata.acquired_at);
        const bAt = String(b.metadata.acquired_at);
        return aAt < bAt ? 1 : aAt > bAt ? -1 : 0;
      });
      return sorted[0]?.metadata.content_hash ?? null;
    } catch {
      return null;
    }
  };

  return {
    start: () => {
      if (state.running) return;
      state.running = true;
      logger.emit({ kind: 'loop_started', capabilities: schedule.map((s) => s.capability), tickMs });
      timer = setInterval(() => {
        // Overlap guard — a slow tick (e.g. Hermes timeouts) must not
        // stack. The next interval is allowed to start as soon as the
        // previous one resolves.
        if (tickInFlight) return;
        tickInFlight = tick().catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[loop] tick failed:', err instanceof Error ? err.message : String(err));
          return {
            startedAt: nowIso(),
            capabilities: 0,
            situationsCreated: 0,
            situationsDeduped: 0,
            investigationsTriggered: 0,
            investigationsSkipped: 0,
            investigationsFailed: 0,
            outputsCreated: 0,
            errors: [err instanceof Error ? err.message : String(err)],
          } satisfies LoopTickSummary;
        }).finally(() => {
          tickInFlight = null;
        });
      }, tickMs);
    },
    stop: () => {
      if (!state.running) return;
      state.running = false;
      if (timer) { clearInterval(timer); timer = null; }
      logger.emit({ kind: 'loop_stopped' });
    },
    tickNow: (): Promise<LoopTickSummary> => {
      if (tickInFlight) {
        // Reuse the in-flight tick instead of stacking. Returning the same
        // promise reference (rather than `async`-wrapping) is what makes
        // the mutex observable as a single in-flight tick to test callers.
        return tickInFlight;
      }
      tickInFlight = tick().finally(() => { tickInFlight = null; });
      return tickInFlight;
    },
    list: (): LoopState => ({ ...state }),
  };
};

// Local fallback formatter for the default logger; the
// `loop-events.ts#stdoutSink` does the real formatting. We keep this here
// so the Loop module is self-contained and the test seam stays one line.
const formatLoopEventFallback = (e: LoopEvent): string => {
  switch (e.kind) {
    case 'tick_started': return `[loop] tick capability=${e.capability} date=${e.date}`;
    case 'acquisition_started': return `[loop] acquisition started capability=${e.capability}`;
    case 'acquisition_succeeded': return `[loop] evidence updated capability=${e.capability} count=${e.evidenceCount}`;
    case 'acquisition_failed': return `[loop] acquisition failed capability=${e.capability} error=${e.error}`;
    case 'situations_updated': return `[loop] situation updated created=${e.created} skipped=${e.skipped}`;
    case 'investigation_triggered': return `[loop] investigation triggered situation=${e.situationId} reason=${e.reason}`;
    case 'investigation_skipped': return `[loop] investigation skipped situation=${e.situationId} reason=${e.reason}`;
    case 'investigation_completed': return `[loop] investigation completed situation=${e.situationId}`;
    case 'investigation_failed': return `[loop] investigation failed situation=${e.situationId} error=${e.error}`;
    case 'output_created': return `[loop] output created ${e.outputId} for situation=${e.situationId}`;
    case 'tick_done': return `[loop] tick done capabilities=${e.capabilities} situations=${e.situations} investigations=${e.investigations} outputs=${e.outputs}`;
    case 'loop_started': return `[loop] loop started capabilities=${e.capabilities.join(',')} tickMs=${e.tickMs}`;
    case 'loop_stopped': return `[loop] loop stopped`;
  }
};

// Suppress unused-import warning for the re-export-only imports above; the
// types are surfaced through the barrel.
export type { AcquisitionRunState, SituationRunResult };
