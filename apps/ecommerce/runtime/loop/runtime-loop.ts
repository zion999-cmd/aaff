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
//     ├─ listRecoverableCandidates   ↓ (P0010.2.2: pre-existing situations
//     │                              │   needing recovery from prior crash
//     │                              │   / interrupted turn / retryable fail)
//     └─ for each candidate: InvestigationPolicy.shouldInvestigate
//           ├─ investigate → runInvestigationTurn → materializeWorkItem
//           ├─ skip        → log + continue
//           └─ blocked_runtime_failure → log + emit investigation_blocked
//                                       (operator must POST /clear-block)
//
// The Loop NEVER branches on business state itself. It only owns cadence
// and the mutex. Business decisions live in:
//   - InvestigationPolicy (skip-vs-investigate, includes blocked threshold)
//   - runSituationProducer (deterministic situation creation)
//   - listRecoverableCandidates (deterministic recovery scan)
//   - runInvestigationTurn (the actual Hermes turn + WorkItem materialize)
//
// Strict boundary (per user: "不能让 Scheduler 本身变成业务编排器"):
//   The Loop does NOT call `materializeWorkItem` directly. It calls
//   `runInvestigationTurn`, which is the same code path as the manual
//   POST /api/situation/:id/investigate route. To make WorkItem creation
//   real and idempotent for BOTH paths, the route's `runInvestigationTurn`
//   end-of-function is wired to call `materializeWorkItem` after a
//   successful investigation (single call site).
//
// P0010.2.2 — Self-healing recovery: the Loop is the single recovery path.
// `listRecoverableCandidates` runs on every tick and is the only mechanism
// that drives pre-existing open situations (no parallel startup-time
// autoInvestigatePending chain). The investigation's `blocked` state
// (>= 3 consecutive failures with no operator override) requires an
// explicit POST /api/situation/:id/clear-block to resume — this is the
// only blocking condition the runtime enforces. Other blocking conditions
// (capability boundary, explicit human defer, sustained failure) are
// owned by the policy, not the loop.
//
// No setTimeout-based reconnect, no event bus, no wake engine, no
// durable job queue, no adaptive scheduler, no dynamic cron generation
// — this is the strict-scope v1 of the loop.

import type { Database as Db } from 'better-sqlite3';
import { resolve } from 'node:path';
import { beijingDate, beijingHourBucket, nowIso } from '#shared/utils/time.js';
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
import {
  listRecoverableCandidates,
  countBlockedSituations,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  type RecoveryOptions,
  type RecoverableSituation,
} from './recovery-candidates.js';
import { HermesSessionClient } from '#platform/runtime/hermes/index.js';
import { runInvestigationTurn, markInvestigation, connectWithSituationTrace } from '#platform/server/routes/situation-chat.js';
import type { InvestigationTurnResult } from '#platform/server/routes/situation-chat.js';
import { loadInvestigationFromLearningContext } from '#app/experience/learning-context-producer.js';
import { recordAgentTurn } from '#platform/runtime/hermes/health-state.js';

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
  /**
   * P0010.2.2 — Recovery scan options. The Loop calls
   * `listRecoverableCandidates(db, recoveryOptions)` on every tick to
   * pick up situations the producer did NOT emit (process restart,
   * interrupted turn, retryable failure). Defaults are inherited from
   * `./recovery-candidates.ts`. Pass only the fields you want to
   * override; the rest fall back to the production defaults.
   */
  recoveryOptions?: RecoveryOptions;
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
  /**
   * P0010.2.3 (ADR-059 audit D-2) — count of situations currently in
   * `blocked_runtime_failure` state (threshold-crossing tick already
   * fired the event, operator has not yet cleared the block). One
   * COUNT query against learning_contexts; cheap; updates on every
   * `list()` call. The Workspace's "Runtime 执行" view shows this
   * so operators see blocked situations without opening the URL.
   */
  blockedCount: number;
}

const isPolicyInvestigate = (d: PolicyDecision): d is { kind: 'investigate'; reason: 'new_situation' | 'meaningful_new_evidence' | 'recovery_no_investigation' | 'recovery_interrupted' | 'recovery_failed_retryable' } =>
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
    blockedCount: 0,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let tickInFlight: Promise<LoopTickSummary> | null = null;

  // P0010.2.11 — autonomous per-HOUR-BUCKET acquisition guard.
  //
  // The scheduler's per-day guard (scheduler.ts tick()) lives behind
  // `start()`, but the Loop drives acquisition through `runNow()`, which
  // never checks it — so before C1.7 every 60s tick re-ran a real CDP
  // acquisition for the same capability + business_date, overwriting the
  // same evidence files. The guard belongs HERE (autonomous scheduling
  // policy), not in `runNow` / the kernel: the manual
  // `/api/fabric/execute` route builds its own kernel directly and must
  // keep explicit execution semantics (an operator asking for a run gets
  // a run).
  //
  // Semantics (Business-Time hourly bucket): acquisition is allowed once per
  // Beijing business-hour bucket (e.g. 2026-08-31T08 = 08:00–08:59). Only a
  // COMPLETED acquisition is recorded (a failed tick may retry on the next
  // tick). Rolling into the next hour re-enables acquisition automatically
  // (keyed by hour bucket, not a per-day boolean) — steady-state: new
  // Evidence flows every hour, not once per day. Skip is reported as its own
  // event — never as `acquisition_succeeded`.
  const completedBusinessHour = new Map<string, string>();

  const runCapability = async (
    cap: string,
    date: string,
    hourBucket: string,
  ): Promise<{ ok: boolean; evidenceCount: number; error?: string }> => {
    if (completedBusinessHour.get(cap) === hourBucket) {
      logger.emit({
        kind: 'acquisition_skipped',
        capability: cap,
        date,
        hour: hourBucket,
        reason: 'already_acquired_for_hour_bucket',
      });
      return { ok: true, evidenceCount: 0 };
    }
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
        completedBusinessHour.set(cap, hourBucket);
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

  const investigate = async (
    situationId: string,
    reason: 'new_situation' | 'meaningful_new_evidence' | 'recovery_no_investigation' | 'recovery_interrupted' | 'recovery_failed_retryable',
    latestContentHash: string | null,
  ): Promise<void> => {
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
      // P0010.2 closure Repair — use the same situation-stamping connect
      // helper the chat/recommendation routes use, so the right-pane
      // UI's situation-scoped Trace shows the auto-investigation's
      // connect state too. Without this, the recovery scan's connect
      // events were process-level (no situationId) and the operator
      // never saw "Agent connect started → ok" for the situation they
      // were looking at.
      await connectWithSituationTrace(client, situationId);
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
        // P0010.2.2 — track the consecutive-failure counter on the
        // investigation marker so the next tick can decide whether
        // retrying again is worth it. We read the prior counter off
        // the marker (canonical source), increment, and stamp it back
        // via markInvestigation. This is the Loop's authoritative
        // view of "how many retries have we burned on this situation"
        // — the operator's clear-block route resets it via the same
        // mechanism.
        const priorInv = loadInvestigationFromLearningContext(db, situationId);
        const priorCount =
          typeof (priorInv as { consecutiveFailures?: unknown } | null)?.consecutiveFailures === 'number'
            ? ((priorInv as { consecutiveFailures: number }).consecutiveFailures)
            : 0;
        markInvestigation(db, situation, {
          status: 'failed',
          // P0010.2 — preserve the structured failure reason on the
          // marker so the operator can see the taxonomy, not just the
          // raw error text.
          error: result.failureReason
            ? `[${result.failureReason}] ${result.error ?? 'investigation returned not-ok'}`
            : (result.error ?? 'investigation returned not-ok'),
          ...(latestContentHash ? { evidenceContentHash: latestContentHash } : {}),
          consecutiveFailures: priorCount + 1,
        });
        logger.emit({
          kind: 'investigation_failed',
          situationId,
          error: result.error ?? 'investigation returned not-ok',
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
          ...(result.drift && result.drift.length > 0 ? { drift: result.drift } : {}),
          ...(result.unmappable && result.unmappable.length > 0 ? { unmappable: result.unmappable } : {}),
        });
        // ADR-064: agent turn reported not-ok — record so the readiness
        // chip and /api/runtime/hermes/status can report `agentTurn: failed`
        // (the most recent observation wins over any prior success).
        recordAgentTurn({
          ok: false,
          failureReason: result.failureReason ?? 'investigation_returned_not_ok',
        });
        return;
      }
      // P0010.2.2 — success resets the counter to 0. Without this, a
      // single transient blip would leave a partial counter on the
      // marker that would later block the situation after N-1 more
      // (unrelated) failures.
      markInvestigation(db, situation, {
        status: 'completed',
        ...(latestContentHash ? { evidenceContentHash: latestContentHash } : {}),
        consecutiveFailures: 0,
      });
      logger.emit({
        kind: 'investigation_completed',
        situationId,
        // P0010.2 — surface vocabulary drift the parser normalized at
        // the raw boundary, so the operator can see "the Agent said
        // `confirmed` and we mapped it to `supported`" without having
        // to dig into the Investigation's persisted payload.
        ...(result.drift && result.drift.length > 0 ? { drift: result.drift } : {}),
      });
      // ADR-064: agent turn completed cleanly — record so the readiness
      // chip and /api/runtime/hermes/status can report `agentTurn: healthy`.
      recordAgentTurn({ ok: true });
      // WorkItem is materialized inside runInvestigationTurn's route
      // wiring (single call site covers both Loop and manual POSTs).
      // Nothing to do here.
    } catch (err) {
      // Same counter bookkeeping on a thrown error (the common case
      // when hermes is unreachable: connect fails, collectTurn rejects,
      // etc.). The thrown path is structurally identical to the
      // result.ok === false path from the block-threshold perspective.
      const message = err instanceof Error ? err.message : String(err);
      const priorInv = loadInvestigationFromLearningContext(db, situationId);
      const priorCount =
        typeof (priorInv as { consecutiveFailures?: unknown } | null)?.consecutiveFailures === 'number'
          ? ((priorInv as { consecutiveFailures: number }).consecutiveFailures)
          : 0;
      markInvestigation(db, situation, {
        status: 'failed',
        error: message,
        ...(latestContentHash ? { evidenceContentHash: latestContentHash } : {}),
        consecutiveFailures: priorCount + 1,
      });
      logger.emit({ kind: 'investigation_failed', situationId, error: message });
      // ADR-064: agent turn threw — same surface as the result.ok=false
      // path; record so /api/runtime/hermes/status reports the failure
      // even when the connect never returned a structured result.
      recordAgentTurn({ ok: false, failureReason: 'turn_threw' });
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
    // C2.0.1 — the capability business date is the BEIJING business date of
    // the tick time, not the UTC calendar date. During Beijing 00:00–08:00
    // the UTC date is still yesterday, which made every autonomous
    // trade.overview tick fail the ADR-073 guard (fail-closed). Reuses the
    // shared timezone helper — no local UTC+8 re-implementation.
    const date = beijingDate(new Date(startedAt));
    // Business-Time hourly acquisition cadence: one acquisition per Beijing
    // hour bucket, re-enabled when the hour rolls over.
    const hour = beijingHourBucket(new Date(startedAt));
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
      const r = await runCapability(cfg.capability, date, hour);
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

    // P0010.2.2 — Recovery scan. P0010.2's loop only re-evaluated situations
    // the producer just emitted; pre-existing open situations whose
    // investigation was never run, was interrupted (process died mid-turn),
    // or was retryable (failed but below the threshold) were silently
    // ignored. The recovery scan picks those up on EVERY tick (not just
    // startup), so a process restart / hermes restart / mid-tick crash
    // self-heals the next tick.
    const recoveryOptions: RecoveryOptions = {
      ...(options.recoveryOptions ?? {}),
      excludeIds: candidateIds,
    };
    const recovered: RecoverableSituation[] = listRecoverableCandidates(db, recoveryOptions);
    const recoveryHints = new Map<string, { kind: RecoverableSituation['recoveryKind']; consecutiveFailures: number }>();
    for (const r of recovered) {
      candidateIds.add(r.situationId);
      recoveryHints.set(r.situationId, {
        kind: r.recoveryKind,
        consecutiveFailures: r.consecutiveFailures,
      });
    }
    if (recovered.length > 0) {
      // Distinct event from `situations_updated` (producer output) so
      // operators can tell apart "new situations the world produced" from
      // "situations the runtime is recovering from a prior crash".
      logger.emit({
        kind: 'recovery_candidates_found',
        count: recovered.length,
        kinds: recovered.map((r) => r.recoveryKind),
      });
    }

    // The policy compares CONTENT_HASH, not wall clock. Compute the max
    // content_hash over the latest evidence records (across platforms /
    // data types / shops — the worst-case "any new evidence is meaningful"
    // assumption is what the user wants: re-investigation only fires when
    // the underlying metric actually moved, not when a re-acquisition wrote
    // a new `acquired_at` to disk).
    const latestContentHash = readLatestContentHash();
    const maxConsecutiveFailures = recoveryOptions.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    for (const situationId of candidateIds) {
      const hint = recoveryHints.get(situationId);
      const decision = policy.shouldInvestigate({
        situationId,
        latestContentHash,
        waitingOnHuman: isWaitingOnHuman(db, situationId),
        ...(hint ? { recoveryHint: hint.kind, consecutiveFailures: hint.consecutiveFailures } : {}),
        maxConsecutiveFailures,
      });
      if (decision.kind === 'skip' && decision.reason === 'blocked_runtime_failure') {
        const count = hint?.consecutiveFailures ?? maxConsecutiveFailures;
        // Audit R4 fix (P0010.2.2): stamp blockedEmittedAt on the
        // threshold-crossing tick so subsequent ticks suppress the
        // event. The clear-block route resets this to undefined
        // along with consecutiveFailures=0. Only write the marker
        // when this is a fresh block (not already emitted) — the
        // defensive `if (priorInv && !priorInv.blockedEmittedAt)`
        // check below makes the no-re-emit invariant explicit at
        // the policy boundary, independent of whether the situation
        // arrived via the recovery scan (has a `hint`) or via the
        // producer path (no `hint`, but `candidateIds` included it
        // on this tick).
        //
        // P0010.2.7 follow-up: the previous code wrapped this whole
        // block in `if (hint)`, which silently skipped the stamp
        // for producer-emitted situations (the recovery scan
        // excludes `candidateIds`, so producer-path situations
        // have no `hint`). The result: `blockedEmittedAt` was never
        // written, the workspacePresentation reducer fell through
        // to `recoverable` instead of `blocked`, the operator's
        // "解除阻塞" button was hidden, and the right panel kept
        // emitting `investigation_blocked` events every tick
        // without ever settling into the canonical `blocked` state.
        const situation = loadSituation(db, situationId);
        if (situation) {
          const priorInv = loadInvestigationFromLearningContext(db, situationId);
          if (priorInv && !(priorInv as { blockedEmittedAt?: unknown }).blockedEmittedAt) {
            markInvestigation(db, situation, {
              status: priorInv.status ?? 'failed',
              ...(priorInv.error ? { error: priorInv.error } : {}),
              ...(priorInv.evidenceContentHash ? { evidenceContentHash: priorInv.evidenceContentHash } : {}),
              consecutiveFailures: count,
              blockedEmittedAt: nowIso(),
            });
          }
        }
        logger.emit({ kind: 'investigation_blocked', situationId, consecutiveFailures: count });
        investigationsSkipped++;
        continue;
      }
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
    list: (): LoopState => {
      // P0010.2.3 (ADR-059 audit D-2) — surface blockedCount alongside
      // the in-process state. The count is read live (each call) from
      // learning_contexts, not cached, so it reflects operator /clear-block
      // actions immediately.
      return { ...state, blockedCount: countBlockedSituations(db) };
    },
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
    case 'acquisition_skipped': return `[loop] acquisition skipped capability=${e.capability} date=${e.date} hour=${e.hour} reason=${e.reason}`;
    case 'situations_updated': return `[loop] situation updated created=${e.created} skipped=${e.skipped}`;
    case 'investigation_triggered': return `[loop] investigation triggered situation=${e.situationId} reason=${e.reason}`;
    case 'investigation_skipped': return `[loop] investigation skipped situation=${e.situationId} reason=${e.reason}`;
    case 'investigation_completed': return `[loop] investigation completed situation=${e.situationId}`;
    case 'investigation_failed': return `[loop] investigation failed situation=${e.situationId} error=${e.error}`;
    case 'recovery_candidates_found': return `[loop] recovery eligible count=${e.count} kinds=${e.kinds.join(',')}`;
    case 'investigation_blocked': return `[loop] investigation BLOCKED situation=${e.situationId} consecutiveFailures=${e.consecutiveFailures} — operator must POST /api/situation/:id/clear-block to resume`;
    case 'output_created': return `[loop] output created ${e.outputId} for situation=${e.situationId}`;
    case 'tick_done': return `[loop] tick done capabilities=${e.capabilities} situations=${e.situations} investigations=${e.investigations} outputs=${e.outputs}`;
    case 'loop_started': return `[loop] loop started capabilities=${e.capabilities.join(',')} tickMs=${e.tickMs}`;
    case 'loop_stopped': return `[loop] loop stopped`;
  }
};

// Suppress unused-import warning for the re-export-only imports above; the
// types are surfaced through the barrel.
export type { AcquisitionRunState, SituationRunResult };
