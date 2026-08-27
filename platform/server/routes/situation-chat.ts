// Situation Chat Runtime Bridge — Browser ↔ Fabric ↔ Hermes Session.
// P0008.3. Holds Situation → Hermes session mapping SERVER-SIDE (in-memory).
//
// Flow:
//   POST /api/situation/:id/chat  { message }
//     → ensure Hermes session exists for this situation (cwd = Fabric Workspace)
//     → prompt.submit
//     → accumulate message.delta events into response text
//     → return { sessionId, reply }
//
// Session mapping is held here (Fabric server), NOT in the browser. Legacy
// /api/chat remains untouched.

import { Router } from 'express';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Database as Db } from 'better-sqlite3';
import { HermesSessionClient } from '#platform/runtime/hermes/index.js';
import type { HermesEvent, CreateSessionParams, CreateSessionResult } from '#platform/runtime/hermes/index.js';
import { writeProjection } from '#app/runtime/fabric-workspace/index.js';
import { JD_FIXTURE } from '#app/runtime/fabric-workspace/jd-fixture.js';
import { loadCapabilityEntries } from '#app/runtime/fabric-workspace/capability-loader.js';
import { initSharedKnowledgeLayer } from '#app/runtime/shared-knowledge/index.js';
import type { LearningContext, Situation } from '#shared/schemas/learning-context.js';
import { InvestigationSchema, RecommendationSchema } from '#shared/schemas/investigation.js';
import type { Recommendation } from '#shared/schemas/investigation.js';
import { nowIso } from '#shared/utils/time.js';
import {
  loadSituation,
  loadLearningContext,
  loadInvestigationFromLearningContext,
  storeInvestigationInLearningContext,
  recordInterventionInLearningContext,
} from '#app/experience/learning-context-producer.js';
import { buildInvestigationPrompt, parseInvestigation, extractJsonObject } from '#app/runtime/investigation/index.js';
import { writeRecommendationResult } from '#app/runtime/loop/recommendation-to-output.js';
import { traceBuffer, makeTraceEvent } from '#app/runtime/loop/trace-ring-buffer.js';
import { uuid } from '#shared/utils/crypto.js';

// ---- Session registry (server-side) ----

/** Minimal interface the bridge needs from a Hermes session client (testable). */
export interface SituationChatClient {
  connect(): Promise<void>;
  createSession(params: CreateSessionParams): Promise<CreateSessionResult>;
  submitPrompt(sessionId: string, text: string): Promise<void>;
  onEvent(handler: (event: HermesEvent) => void): () => void;
  close(): void;
}

interface ActiveSituationSession {
  client: SituationChatClient;
  hermesSessionId: string;
  /** Slice 2 — unsubscribe the agent-trace buffer subscription. Called
   *  when the session is dropped (catch paths) so the closure isn't
   *  kept alive past its useful lifetime. */
  unsubscribeTrace?: () => void;
}

// ---- Slice 2: Agent-trace buffer subscription -------------------------

/**
 * Register a SECOND `client.onEvent` handler that pushes runtime-agnostic
 * TraceEvents into the ring buffer. The primary `collectTurn` handler in
 * the route accumulates `message.delta` text into the response — that
 * work is independent of observability and continues to work as before.
 *
 * Slice 2 invariants:
 *   - `message.delta` is SKIPPED. Streaming 1k tokens/min would flood
 *     the 200-event buffer in under a second; the operator cares about
 *     turn boundaries, not byte-level deltas.
 *   - `event.session_id !== hermesSessionId` events are dropped. The
 *     same WS client may multiplex other sessions in tests; we only
 *     trace THIS situation's session.
 *   - The subscription lives as long as the cached `ActiveSituationSession`.
 *     On `sessions.delete(...)` the route calls `unsubscribeTrace()` so
 *     the closure is GC-eligible.
 */
const subscribeAgentTrace = (
  client: SituationChatClient,
  situationId: string,
  hermesSessionId: string,
): (() => void) => {
  return client.onEvent((event: HermesEvent) => {
    if (event.session_id !== undefined && event.session_id !== hermesSessionId) return;
    if (event.type === 'message.delta') return;

    const base = {
      source: 'agent' as const,
      situationId,
      sessionId: hermesSessionId,
    };

    switch (event.type) {
      case 'session.created':
        traceBuffer.push(
          makeTraceEvent({
            ...base,
            kind: 'agent.session.created',
            summary: 'Agent 会话已创建',
            detail: { ...event },
          }),
        );
        return;
      case 'turn.start':
      case 'turn.started':
      case 'message.start':
        traceBuffer.push(
          makeTraceEvent({
            ...base,
            kind: 'agent.turn.started',
            summary: 'Agent 正在处理本轮',
            detail: { ...event },
          }),
        );
        return;
      case 'message.complete':
      case 'turn.complete':
      case 'turn.end':
        traceBuffer.push(
          makeTraceEvent({
            ...base,
            kind: 'agent.turn.completed',
            summary: 'Agent 已生成回复',
            detail: { ...event },
          }),
        );
        return;
      case 'message.failed':
      case 'turn.failed':
        traceBuffer.push(
          makeTraceEvent({
            ...base,
            kind: 'agent.turn.failed',
            summary: `Agent 处理失败：${typeof event.payload?.text === 'string' ? event.payload.text : '未知错误'}`,
            detail: { ...event },
          }),
        );
        return;
      case 'tool.call':
        traceBuffer.push(
          makeTraceEvent({
            ...base,
            kind: 'agent.tool.called',
            summary: 'Agent 调用工具',
            detail: { ...event },
          }),
        );
        return;
      case 'tool.result':
        traceBuffer.push(
          makeTraceEvent({
            ...base,
            kind: 'agent.tool.completed',
            summary: 'Agent 工具调用完成',
            detail: { ...event },
          }),
        );
        return;
      // Unknown event types are dropped silently. The buffer is for
      // state changes the operator acts on; raw noise is not.
    }
  });
};

interface SituationChatOptions {
  /** Directory to project the Fabric Workspace into */
  workspaceDir: string;
  /** Hermes serve URL */
  hermesUrl?: string;
  /** Hermes profile name */
  profile?: string;
  /** Client factory (injectable for tests; defaults to HermesSessionClient) */
  clientFactory?: (url?: string) => SituationChatClient;
  /** Database handle — enables delivering the situation's Learning Context to Hermes. */
  db?: Db;
}

/** Lazily build the Fabric Agent Workspace: systems/ + capabilities/ (projected) + knowledge/ (seeded, persistent). */
export const ensureWorkspace = (dir: string): string => {
  writeProjection(
    {
      worldModel: JD_FIXTURE.worldModel,
      bindings: JD_FIXTURE.bindings,
      capabilities: loadCapabilityEntries(),
    },
    dir,
  );
  // P0008.4: seed the Shared Knowledge layer (raw immutable + knowledge Read Model).
  // Idempotent — never deletes Agent-maintained knowledge pages.
  initSharedKnowledgeLayer(dir);
  return resolve(dir);
};

/** Deliver a situation's Learning Context into the Hermes session workspace. */
const writeLearningContextToWorkspace = (dir: string, situationId: string, ctx: unknown): void => {
  const situationsDir = resolve(dir, 'situations');
  mkdirSync(situationsDir, { recursive: true });
  writeFileSync(resolve(situationsDir, `${situationId}.json`), JSON.stringify(ctx, null, 2), 'utf-8');
};

/**
 * P0010.2 closure Repair — connect to the Agent Runtime AND emit
 * situation-stamped `agent.connect.*` events into the trace buffer.
 *
 * Why this is separate from `session-client.ts#defaultConnectLogger`:
 * the connect logger is process-level and has no `situationId` (a
 * connect is not bound to any single situation). The right-pane UI
 * filters the buffer by `situationId`, so the process-level connect
 * event is invisible to it. This helper stamps `situationId` on the
 * connect events that the route triggered, so the situation-scoped
 * right pane shows the actual connect state for THIS investigation.
 *
 * Schema-stability note: the helper re-uses the same `agent.connect.*`
 * kinds the connect logger pushes (no Hermes-specific shape change).
 * The `situationId` field is already part of the runtime-agnostic
 * `TraceEvent` schema, so when a non-Hermes Agent Runtime ships, the
 * same shape carries the correlation. The helper itself is the only
 * runtime-aware piece (it knows which client method to call); the
 * events it emits are NOT.
 */
// P0010.2 closure Repair — exported so `runtime-loop.ts` (the
// RuntimeLoop's auto-investigation path) can stamp connect events with
// the situationId too. The chat/recommendation routes still call it
// directly via this module; the runtime loop imports the SAME function
// so the situation-scoped Trace includes every investigation's connect
// state, not just the ones triggered by an operator click. The helper
// is runtime-agnostic: it only stamps a situationId on the connect
// events; the connect method itself belongs to whichever client is
// passed in (Hermes today; any Agent tomorrow).
export const connectWithSituationTrace = async (
  client: SituationChatClient,
  situationId: string,
): Promise<void> => {
  const base = { source: 'agent' as const, situationId };
  traceBuffer.push(
    makeTraceEvent({
      ...base,
      kind: 'agent.connect.started',
      summary: 'Agent 开始连接（为本 Situation）',
    }),
  );
  try {
    await client.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    traceBuffer.push(
      makeTraceEvent({
        ...base,
        kind: 'agent.connect.failed',
        summary: 'Agent 连接失败（为本 Situation）：' + message,
        detail: { error: message },
      }),
    );
    throw err;
  }
  traceBuffer.push(
    makeTraceEvent({
      ...base,
      kind: 'agent.connect.ok',
      summary: 'Agent 已连接（为本 Situation）',
    }),
  );
};

/**
 * P0010.2 Review Repair — grace window for `turn.completed` /
 * `turn.complete` to be treated as a hard terminal. Hermes 0.20.5 does
 * NOT emit these on the wire today (tui_gateway/server.py audited),
 * but if a future Hermes variant does, we wait this long for the
 * canonical `message.complete` to arrive before falling back to the
 * accumulated delta text. 2s is short enough to keep the turn
 * responsive; long enough to cover WS reordering on a slow relay.
 */
const TURN_COMPLETE_GRACE_MS = 2_000;

/** Accumulate message.delta text until message.complete, resolve with full reply. */
export const collectTurn = (client: SituationChatClient, sessionId: string, timeoutMs = 300_000): Promise<string> => {
  return new Promise((resolveTurn, rejectTurn) => {
    let text = '';
    let timedOut = false;
    let turnGraceTimer: ReturnType<typeof setTimeout> | null = null;

    // P0010.2 — bug fix: declare `unsubscribe` as `let` and assign it
    // AFTER the closure is created. The previous `const unsubscribe =
    // client.onEvent(...)` pattern is a TDZ trap when the client
    // synchronously replays buffered events inside `onEvent` (which our
    // test mock does, and which the real Hermes WS client also does on
    // reconnect). The closure would call `unsubscribe()` before its
    // declaration was reached, raising "Cannot access 'unsubscribe'
    // before initialization".
    let unsubscribe: () => void = () => { /* replaced below */ };

    const timeout = setTimeout(() => {
      timedOut = true;
      if (turnGraceTimer) {
        clearTimeout(turnGraceTimer);
        turnGraceTimer = null;
      }
      unsubscribe();
      rejectTurn(new Error('Turn timed out waiting for message.complete'));
      // Hermes model latency is unstable (documented: 71-77s fast path, >180s
      // slow path; an ingest that reads sources + writes pages takes longer).
      // 300s keeps the Agent's real completion time inside the window.
    }, timeoutMs);

    unsubscribe = client.onEvent((event: HermesEvent) => {
      if (event.session_id !== undefined && event.session_id !== sessionId) return;

      if (event.type === 'message.delta') {
        const delta = String(event.payload?.text ?? '');
        text += delta;
      } else if (event.type === 'message.complete') {
        // CANONICAL terminal event (Hermes 0.20.5 tui_gateway/server.py
        // _emit() calls — we audited the source: server.py:9116 / 11943
        // / 6879 etc. all emit `message.complete`, NEVER `turn.completed`
        // or `turn.complete` as wire events). If a `turn.*` event arrived
        // first, we already set up the grace timer; cancel it now and
        // resolve with the full message.complete text.
        if (timedOut) return;
        clearTimeout(timeout);
        if (turnGraceTimer) {
          clearTimeout(turnGraceTimer);
          turnGraceTimer = null;
        }
        unsubscribe();
        // P0010.2 — provider-error detection. The canonical signal is
        // `payload.status === 'error'`. When Hermes does NOT set the flag
        // but the upstream LLM provider rejected the request, Hermes
        // emits a recognisable envelope in `payload.text`:
        //
        //   - `HTTP <3-digit>: <class>.<Error>: <message>`
        //     (e.g. `HTTP 400: ***.BadRequestError: OpenAIException - {...}`)
        //   - `❌ Non-retryable error (HTTP <3-digit>): ...`
        //
        // We MUST NOT do a generic keyword sniff on Agent's normal prose:
        // the Agent's investigation JSON may legitimately quote "HTTP
        // 400" / "BadRequestError" / "OpenAIException" as text inside the
        // judgment. So `isProviderError` only matches the upstream-error
        // envelope (HTTP <code>: ***, or the Non-retryable sentinel),
        // and treats `OpenAIException` / `BadRequestError` / etc. as
        // provider signals ONLY when they co-occur with the HTTP code.
        const payload = event.payload ?? {};
        const status = (payload as { status?: string }).status;
        const complete = String(payload.text ?? '');
        if (status === 'error' || isProviderErrorEnvelope(complete)) {
          rejectTurn(new Error(`Hermes message error: ${complete || '<empty>'}`));
          return;
        }
        // message.complete carries the full text; prefer it (the
        // accumulated delta is a streaming prefix that may be partial).
        resolveTurn((complete.trim() || text.trim()).trim());
      } else if (event.type === 'turn.completed' || event.type === 'turn.complete') {
        // LIFECYCLE-ONLY signal. Hermes 0.20.5 tui_gateway/server.py does
        // NOT emit these as wire events today (we audited the source —
        // there is no `_emit("turn.completed", ...)` call anywhere), so
        // treating them as a hard terminal here would cause us to resolve
        // with a half-accumulated delta stream before `message.complete`
        // arrives. That is exactly the bug the previous P0010.2 version
        // introduced: `delta → turn.completed → message.complete(full)`
        // would resolve on the partial delta and then `message.complete`
        // would never reach the parser.
        //
        // Correct behaviour: mark the lifecycle event, set a short grace
        // window for `message.complete` to arrive, and ONLY resolve
        // ourselves with the accumulated text if the grace window
        // expires without a `message.complete`. The 2000ms grace is
        // short enough to keep the investigation turn responsive, long
        // enough to let Hermes deliver the canonical terminal.
        if (timedOut) return;
        if (turnGraceTimer) return; // already saw a turn.* event this turn
        turnGraceTimer = setTimeout(() => {
          if (timedOut) return;
          clearTimeout(timeout);
          unsubscribe();
          if (text.trim()) {
            // Best-effort fallback for hypothetical Hermes variants that
            // emit `turn.completed` as the SOLE terminal without a
            // follow-up `message.complete`. Today (0.20.5) this path
            // should never fire — we keep it as a forward-compat net.
            resolveTurn(text.trim());
          } else {
            rejectTurn(new Error(`Turn completed (${event.type}) but no message text was accumulated.`));
          }
        }, TURN_COMPLETE_GRACE_MS);
      }
    });
  });
};

// P0010.2 Review Repair — Hermes 0.20.5 upstream-error envelope matcher.
//
// Real envelopes observed on 2026-08-27 with hermes serve --port 9120 +
// agnes-2.0-flash on https://apihub.agnes-ai.com/v1:
//
//   - "HTTP 400: ***.BadRequestError: OpenAIException - {\"error\":{...}}"
//   - "❌ Non-retryable error (HTTP 400): <message>"
//
// Hermes 0.20.5 puts the upstream error text in `payload.text` but does
// NOT set `payload.status = 'error'`, so we need envelope matching.
//
// We deliberately DO NOT match:
//   - bare "HTTP 400" alone (Agent's investigation JSON may quote the
//     number as data, e.g. "the HTTP 400 was caused by ...");
//   - bare "OpenAIException" / "BadRequestError" / "AuthenticationError"
//     / "RateLimitError" — these are class names that the Agent may
//     legitimately mention in the recommendation rationale;
//   - bare "Non-retryable" — same reason;
//   - any of the above as an ANYWHERE-IN-STRING substring, even when
//     the substring LOOKS like an envelope. The Agent can paste a real
//     log line as a quoted evidence string. The envelope must be at
//     the TOP-LEVEL of `payload.text` (after `trimStart`), the same
//     place Hermes actually puts upstream rejects.
//
// We DO match the upstream-error envelope shape at the top of the
// payload text (after leading whitespace is stripped):
//   - starts with `HTTP <3-digit>:` (provider reject with code),
//   - OR starts with `❌ Non-retryable error (HTTP <3-digit>)`
//     (the hard-reject sentinel Hermes 0.20.5 emits),
//   - OR starts with `OpenAIException - {"error":` (the OpenAI
//     provider's standard JSON-bodied class throw).
const isProviderErrorEnvelope = (s: string): boolean => {
  if (!s) return false;
  // trimStart only — leading whitespace is common in WS frames, but
  // we MUST NOT trimEnd because the envelope terminator (e.g. the
  // trailing `}` of the OpenAI JSON body) is part of the shape.
  const top = s.trimStart();
  return /^HTTP\s+\d{3}\s*:/i.test(top)
    || /^❌\s*Non-retryable\s+error\s*\(\s*HTTP\s+\d{3}\b/i.test(top)
    || /^OpenAIException\s*-\s*\{["']error["']\s*:/i.test(top);
};

// ---- P0010 Investigation turn (shared by the route + automatic trigger) ----

/**
 * P0010.2 Production Investigation Contract Repair — structured failure
 * classification. The previous behaviour was a single opaque "failed" with a
 * raw `error` string. The Workspace then showed a generic "Runtime 调查失败"
 * and the operator had to guess whether to fix Hermes, fix the prompt, or
 * fix the LLM provider.
 *
 * The new classification has FOUR reasons and each is actionable:
 *
 *  - `agent_transport_failed`  WS connect refused / session create failed
 *                             / WS closed mid-turn. The Agent never received
 *                             the prompt. Fix: check Hermes is up, token is
 *                             valid, port is reachable.
 *  - `agent_timeout`           Turn started, message.complete never arrived
 *                             within `timeoutMs`. Fix: bump timeout OR
 *                             check that Hermes is actually returning
 *                             message.complete (not some other terminal
 *                             event name).
 *  - `provider_failed`         Hermes returned message.complete with
 *                             `payload.status === 'error'`. The upstream
 *                             LLM provider rejected the request (e.g.
 *                             400 / 401 / 429). Fix: check provider
 *                             config / API key / model name.
 *  - `contract_invalid`        Hermes returned a valid message.complete
 *                             with text, but the text is not a valid
 *                             Investigation Contract (Zod failed after
 *                             vocabulary normalization). Fix: Agent
 *                             drifted from the prompt; check
 *                             parseInvestigation's `unmappable` list for
 *                             the exact field that was off.
 */
export type InvestigationFailureReason =
  | 'agent_transport_failed'
  | 'agent_timeout'
  | 'provider_failed'
  | 'contract_invalid';

export interface InvestigationTurnResult {
  ok: boolean;
  status?: 'failed' | 'completed';
  investigation?: LearningContext['investigation'];
  error?: string;
  /**
   * P0010.2 — structured failure reason. `undefined` when `ok === true`.
   *
   * P0010.2 Review Repair — durability note: `failureReason` is NOT a
   * first-class column on the investigation marker. It surfaces in two
   * places:
   *   (1) the in-memory `LoopEvent.investigation_failed.failureReason`
   *       field (TraceEvent detail) — consumed live by the Workspace;
   *   (2) the durable `error` string on the marker, prefixed with the
   *       reason in square brackets, e.g. `"[provider_failed] HTTP 400: ..."`.
   *
   * The bracket-prefixed error is the ONLY durable form. A future
   * schema widening that adds a real `failure_reason` column is a
   * separate ADR (and would let operators query the failure taxonomy
   * over time). For now, parse the prefix on read if you need it.
   */
  failureReason?: InvestigationFailureReason;
  /**
   * P0010.2 — drift the parser successfully normalized at the raw
   * boundary. Surfaced in the TraceEvent so the operator can see that a
   * near-synonym was accepted and rewritten. `undefined` when the
   * contract was already canonical. Same durability as `failureReason`:
   * only in the LoopEvent + agent trace; not a marker column.
   */
  drift?: Array<{ field: string; original: string; canonical: string }>;
  /**
   * P0010.2 — drift the parser REFUSED (not on the allow-list). Present
   * only when `failureReason === 'contract_invalid'`. The operator can
   * use this list to know exactly which field tripped the contract.
   * Same durability caveat as `failureReason` / `drift`.
   */
  unmappable?: Array<{ field: string; original: string }>;
  /** First 2 KB of the raw Agent reply for diagnosis. Never logged at INFO. */
  rawReply?: string;
}

/**
 * Persist a minimal investigation status marker (no silent loss of a turn).
 *
 * P0010.1 REPAIR — investigation lifecycle must NOT erase a previously
 * completed understanding/judgment/recommendation when the latest attempt
 * fails or is still in flight. The marker represents the *latest attempt*'s
 * state, not the situation's *current valid cognition*.
 *
 *   investigating → keep the existing investigation intact, just stamp
 *                   status='investigating' + startedAt + updatedAt.
 *   failed        → keep the existing investigation's currentUnderstanding /
 *                   judgment / recommendation / knownEvidence / etc. intact,
 *                   stamp status='failed' + error + updatedAt. The Workspace
 *                   surfaces a clear "最新调查未完成" hint next to the prior
 *                   valid cognition.
 *   pending       → no prior completed content expected; write the marker as
 *                   a fresh investigation.
 *   completed     → not used here (full Investigation is written via
 *                   storeInvestigationInLearningContext after a successful
 *                   parse, which is the only place the situation's cognition
 *                   should be fully replaced).
 */
export const markInvestigation = (
  db: Db,
  situation: Situation,
  marker: {
    status: 'pending' | 'investigating' | 'failed' | 'completed';
    error?: string;
    /** P0010.2 — content hash of the evidence that triggered this turn.
     *  Stamped on the marker so a failed attempt also "remembers" the
     *  content it was looking at; the next tick can then decide to skip
     *  (same content) vs retry (new content) without guessing. */
    evidenceContentHash?: string;
    /** P0010.2.2 — consecutive-failure counter for the runtime block
     *  threshold. When the caller explicitly sets this, it overrides the
     *  existing value (used by the Loop to track retries and by the
     *  /clear-block route to reset). When omitted, the existing value
     *  is preserved (preserves the counter on a status flip that isn't
     *  tied to a retry). */
    consecutiveFailures?: number;
    /** P0010.2.2 (audit R4 fix) — timestamp at which the Loop most
     *  recently emitted `investigation_blocked` for this situation. Set
     *  on the threshold-crossing tick; cleared by /clear-block. */
    blockedEmittedAt?: string;
  },
): void => {
  const now = nowIso();
  const existing = loadInvestigationFromLearningContext(db, situation.situationId);
  // Only merge if the prior investigation is a real completed one (has
  // content the operator already saw). A prior 'failed' / 'investigating'
  // marker has no valid cognition to preserve — write the new marker as-is.
  const priorHasCognition =
    !!existing &&
    (existing.status === 'completed' || !!existing.judgment || !!existing.currentUnderstanding);

  let next: LearningContext['investigation'];
  if (priorHasCognition && (marker.status === 'investigating' || marker.status === 'failed')) {
    // Minimum merge: only the lifecycle fields are updated. The previous
    // currentUnderstanding / judgment / recommendation / knownEvidence /
    // findings / hypotheses / capabilityUsed / evidenceAcquired are all
    // preserved verbatim. We do NOT track per-attempt history.
    next = {
      ...existing,
      status: marker.status,
      ...(marker.error ? { error: marker.error } : { error: undefined }),
      startedAt: marker.status === 'investigating' ? now : existing.startedAt,
      updatedAt: now,
    };
  } else {
    // No prior completed content — write a fresh marker (defaults are filled
    // by the schema, so the result is a valid Investigation with only the
    // status / error / timestamps populated).
    next = InvestigationSchema.parse({
      situationId: situation.situationId,
      status: marker.status,
      ...(marker.error ? { error: marker.error } : {}),
      startedAt: now,
      updatedAt: now,
    });
  }
  // P0010.2: stamp the contentHash sidecar on the marker so the next
  // tick can recognize "same content as the last attempt" — including
  // failed attempts. Without this, a slow LLM that always times out
  // would re-trigger investigation every tick forever.
  if (marker.evidenceContentHash) {
    (next as Record<string, unknown>).evidenceContentHash = marker.evidenceContentHash;
  }
  // P0010.2.2: same pattern for the consecutive-failure sidecar. The Loop
  // increments it on each failed attempt; the /clear-block route resets
  // it to 0 on operator override. Without this, the runtime cannot
  // distinguish "transient blip" from "sustained outage" — and would
  // either retry forever (no counter) or block on the first failure
  // (counter that never resets).
  if (marker.consecutiveFailures !== undefined) {
    (next as Record<string, unknown>).consecutiveFailures = marker.consecutiveFailures;
  }
  // P0010.2.2 (audit R4 fix): blockedEmittedAt sidecar. The Loop
  // stamps it on the threshold-crossing tick; /clear-block resets
  // it. The recovery scan filters out situations whose marker has
  // this set, so subsequent ticks no longer re-emit the
  // `investigation_blocked` event (one final per block cycle, not
  // every 60s). Setting it to undefined removes the field.
  if (marker.blockedEmittedAt !== undefined) {
    (next as Record<string, unknown>).blockedEmittedAt = marker.blockedEmittedAt;
  } else {
    delete (next as Record<string, unknown>).blockedEmittedAt;
  }

  storeInvestigationInLearningContext(db, situation, next);
};

/** Run the Recommendation follow-up turn for a completed investigation (same session). */
export const runRecommendationTurn = async (
  client: SituationChatClient,
  sessionId: string,
  situation: Situation,
  existing: LearningContext['investigation'],
): Promise<{ ok: boolean; recommendation?: Recommendation; error?: string }> => {
  const prompt = [
    `You investigated situation ${situation.situationId}. Your judgment was: ${existing?.judgment ?? ''} (stopReason: ${existing?.stopReason ?? ''}).`,
    `Now produce a Recommendation that follows ONLY from that judgment and the investigation findings.`,
    `Output ONLY a JSON object: {"recommendation":"...","rationale":"...","expectedOutcome":"...","risks":[...],"prerequisites":[...],"humanNeeded":[...]}`,
    `Rules: if judgment is observe (pseudo-anomaly/insufficient evidence), recommend NOT acting (continue observing, do not intervene). If human verification is needed, list the facts under humanNeeded. Never recommend an external business Action — recommendation is what to consider, not an execution order.`,
  ].join('\n');

  const replyPromise = collectTurn(client, sessionId, 600_000);
  await client.submitPrompt(sessionId, prompt);
  const reply = await replyPromise;

  const candidate = extractJsonObject(reply);
  if (!candidate) return { ok: false, error: 'Invalid recommendation JSON' };
  try {
    const parsed = RecommendationSchema.safeParse(JSON.parse(candidate));
    if (!parsed.success) return { ok: false, error: 'Invalid recommendation JSON' };
    return { ok: true, recommendation: parsed.data };
  } catch {
    return { ok: false, error: 'Invalid recommendation JSON' };
  }
};

/**
 * Run ONE P0010 investigation turn in an existing Hermes session: build the
 * investigation prompt (situation + evidence as data), submit, two-phase
 * contract extraction (prose → structured follow-up in the SAME session), and
 * persist the contract into the situation's Learning Context. Fabric never
 * synthesizes the contract.
 *
 * P0010.1 recovery: an 'investigating' marker is persisted BEFORE the turn, a
 * completed contract (status=completed) after success, and a 'failed' marker on
 * timeout/error — so a failed/timed-out turn is never silently lost and can be
 * retried by the recovery pass. For a completed investigation with a judgment,
 * the Recommendation is auto-generated in the SAME session (no manual step).
 */
export const runInvestigationTurn = async (
  client: SituationChatClient,
  sessionId: string,
  db: Db,
  situation: Situation,
  /** P0010.2 — the contentHash of the evidence that triggered this turn.
   *  Persisted on the Investigation record so the next tick can detect
   *  "no meaningful change" without re-comparing the whole evidence set. */
  evidenceContentHash?: string,
): Promise<InvestigationTurnResult> => {
  markInvestigation(db, situation, {
    status: 'investigating',
    ...(evidenceContentHash ? { evidenceContentHash } : {}),
  });

  const ctx = loadLearningContext(db, situation.situationId);
  const prompt = buildInvestigationPrompt(situation, ctx);

  let reply: string;
  try {
    const replyPromise = collectTurn(client, sessionId, 600_000);
    await client.submitPrompt(sessionId, prompt);
    reply = await replyPromise;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Investigation failed';
    // P0010.2 — classify the failure. The two collectTurn rejection paths
    // are 'Turn timed out waiting for message.complete' (agent_timeout)
    // and 'Hermes message error: ...' (provider_failed). Everything else
    // (e.g. submitPrompt throwing) is transport.
    const failureReason: InvestigationFailureReason = /timed out waiting for message\.complete/i.test(message)
      ? 'agent_timeout'
      : /^Hermes message error:/i.test(message)
        ? 'provider_failed'
        : 'agent_transport_failed';
    markInvestigation(db, situation, {
      status: 'failed',
      error: `[${failureReason}] ${message}`,
      ...(evidenceContentHash ? { evidenceContentHash } : {}),
    });
    return { ok: false, status: 'failed', error: message, failureReason };
  }

  let parsed = parseInvestigation(reply, situation.situationId);
  if (!parsed.ok) {
    const finalizePrompt = [
      `You just investigated situation ${situation.situationId}. Now output ONLY the Investigation Contract as a single JSON object (no prose, no markdown fences).`,
      `Use the exact shape: {"situationId":"${situation.situationId}","currentUnderstanding":"...","knownEvidence":[...],"hypotheses":[{"statement":"...","status":"..."}],"unknowns":[...],"nextQuestion":"...","requiredEvidence":[...],"investigationRequest":"...","findings":[{"question":"...","evidenceRefs":[...],"answer":"...","impactOnHypothesis":"..."}],"judgment":"...","stopReason":"...","capabilityUsed":"...","evidenceAcquired":[...]}`,
      `Base every field on what you actually did and observed in this investigation. Do not invent capabilities or evidence you did not acquire.`,
      // P0010.2 — re-affirm the vocabulary explicitly so the re-prompt
      // is also a teaching moment.
      `hypotheses[].status MUST be EXACTLY one of: "proposed", "supported", "weakened", "rejected". stopReason MUST be EXACTLY one of: "judgment", "observe", "missing_capability", "ask_human". No synonyms.`,
    ].join('\n');
    try {
      const reply2Promise = collectTurn(client, sessionId, 240_000);
      await client.submitPrompt(sessionId, finalizePrompt);
      const reply2 = await reply2Promise;
      const parsed2 = parseInvestigation(reply2, situation.situationId);
      if (!parsed2.ok) {
        const errorMsg = `[contract_invalid] ${parsed2.error}`;
        markInvestigation(db, situation, {
          status: 'failed',
          error: errorMsg,
          ...(evidenceContentHash ? { evidenceContentHash } : {}),
        });
        return {
          ok: false,
          status: 'failed',
          error: parsed2.error,
          failureReason: 'contract_invalid',
          ...(parsed2.unmappable ? { unmappable: parsed2.unmappable } : {}),
          rawReply: (reply + '\n---\n' + reply2).slice(0, 2000),
        };
      }
      parsed = parsed2;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Investigation failed';
      // The re-prompt itself failed — same classification rules as the
      // first turn. The fact that this was a re-prompt is in the error
      // text already; the classification is the same.
      const failureReason: InvestigationFailureReason = /timed out waiting for message\.complete/i.test(message)
        ? 'agent_timeout'
        : /^Hermes message error:/i.test(message)
          ? 'provider_failed'
          : 'agent_transport_failed';
      markInvestigation(db, situation, {
        status: 'failed',
        error: `[${failureReason}] ${message}`,
        ...(evidenceContentHash ? { evidenceContentHash } : {}),
      });
      return { ok: false, status: 'failed', error: message, failureReason };
    }
  }

  let completed: LearningContext['investigation'] = { ...parsed.investigation, status: 'completed' };
  if (evidenceContentHash) {
    // Stamp the sidecar marker. The schema doesn't model this field, so
    // we attach it as a defensive cast — the InvestigationPolicy reads
    // it back with the same pattern. fail-open: a missing marker means
    // "no prior content snapshot" → re-investigate.
    (completed as Record<string, unknown>).evidenceContentHash = evidenceContentHash;
  }
  storeInvestigationInLearningContext(db, situation, completed);

  // P0010.1 Slice 4: auto-generate the Recommendation from the Judgment (same
  // session, best-effort) so it is not a mandatory manual step.
  if (completed.stopReason === 'judgment' || completed.stopReason === 'observe') {
    try {
      const rec = await runRecommendationTurn(client, sessionId, situation, completed);
      if (rec.ok && rec.recommendation) {
        completed = { ...completed, recommendation: rec.recommendation };
        storeInvestigationInLearningContext(db, situation, completed);
      }
    } catch { /* recommendation is best-effort — never blocks the investigation */ }
  }

  // P0010.2.x: unified seam — the `/chat` turn-end and `/recommend`
  // both end here so a WorkItem always exists for any complete
  // Recommendation. No-Recommendation turns are a safe no-op.
  try {
    writeRecommendationResult(db, situation, completed, completed.recommendation ?? null);
  } catch { /* Output materialization is best-effort — never blocks the investigation */ }

  return {
    ok: true,
    status: 'completed',
    investigation: completed,
    // P0010.2 — surface the drift we normalized at the raw boundary. Empty
    // when the Agent honored the canonical vocabulary (the common case).
    ...(parsed.drift.length > 0 ? { drift: parsed.drift } : {}),
  };
};

// ---- Router ----

export const situationChatRouter = (options: SituationChatOptions): Router => {
  const router = Router();
  const sessions = new Map<string, ActiveSituationSession>();
  const workspaceDir = ensureWorkspace(options.workspaceDir);

  // POST /api/situation/:id/chat — send a message in a situation-scoped session.
  router.post('/situation/:id/chat', async (req, res) => {
    const situationId = req.params['id'];
    if (!situationId) {
      res.status(400).json({ error: 'Missing situation ID' });
      return;
    }
    const message = (req.body?.message ?? '').toString().trim();
    if (!message) {
      res.status(400).json({ error: 'Missing message' });
      return;
    }

    try {
      // Ensure session (create on first message, reuse after).
      let active = sessions.get(situationId);
      if (!active) {
        // Deliver the situation's Learning Context into the session workspace so
        // Hermes can read it (Fabric's experience delivery layer — Memory stays
        // with Hermes). Best-effort: absence of a context is not fatal.
        if (options.db) {
          const ctx = loadLearningContext(options.db, situationId);
          if (ctx) writeLearningContextToWorkspace(workspaceDir, situationId, ctx);
        }

        const client = options.clientFactory
          ? options.clientFactory(options.hermesUrl)
          : new HermesSessionClient(options.hermesUrl ? { url: options.hermesUrl } : {});
        // P0010.2 closure Repair — use the situation-stamping connect
        // helper so the right-pane UI's situation-scoped Trace sees
        // this investigation's connect state (the default connect
        // logger is process-level and would be filtered out by
        // `situationId`).
        await connectWithSituationTrace(client, situationId);
        const created = await client.createSession({
          cwd: workspaceDir,
          ...(options.profile ? { profile: options.profile } : {}),
        });
        active = { client, hermesSessionId: created.sessionId };
        // Slice 2 — register the agent-trace buffer subscription for the
        // session's lifetime. We register HERE (not later) so we don't
        // miss any events between session create and prompt submit. The
        // unsubscribe is stashed on the active session for the catch
        // path below.
        active.unsubscribeTrace = subscribeAgentTrace(client, situationId, created.sessionId);
        sessions.set(situationId, active);
      }

      // Register event collection BEFORE submit — no events are missed.
      const replyPromise = collectTurn(active.client, active.hermesSessionId);
      await active.client.submitPrompt(active.hermesSessionId, message);
      const reply = await replyPromise;

      res.json({
        success: true,
        sessionId: active.hermesSessionId,
        reply,
      });
    } catch (err) {
      // On failure, drop the cached session so the next message can retry fresh.
      const dropped = sessions.get(situationId);
      dropped?.unsubscribeTrace?.();
      sessions.delete(situationId);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Chat failed',
      });
    }
  });

  // GET /api/situation/:id/session — expose the server-held session mapping (read-only).
  router.get('/situation/:id/session', (req, res) => {
    const situationId = req.params['id'];
    const active = sessions.get(situationId ?? '');
    res.json({
      situationId,
      hasSession: Boolean(active),
      hermesSessionId: active?.hermesSessionId ?? null,
    });
  });

  // POST /api/situation/:id/recommend — P0010.1 Recommendation.
  // Produces a Recommendation ONLY from the persisted Investigation/Judgment
  // (never from Signal/Ranking/threshold). Runs a short follow-up turn in the
  // SAME session; the recommendation is persisted additively into the
  // investigation. Human feedback (accept/reject/correction) reuses the
  // existing Intervention grammar.
  //
  // P0010.1 Post-Review REPAIR — KNOWN GAP (recorded, not fixed in this slice):
  //   When runRecommendationTurn's JSON parse fails (rec.ok === false), the
  //   situation is left WITHOUT a recommendation. The route returns a soft
  //   { success: false, agentStatus: 'error', error: ... } to the client;
  //   the operator must re-call /recommend to retry. We deliberately do NOT
  //   auto-restart: this would re-enter the same Hermes session, risk
  //   inflating attempt history, and require session-architecture changes
  //   out of scope for the P0010.1 closeout. If a follow-up slice wants to
  //   address this, the surface is exactly the if-branch below — do NOT
  //   add retry / finalize-prompt logic here without an explicit plan.
  router.post('/situation/:id/recommend', async (req, res) => {
    const situationId = req.params['id'];
    if (!situationId || !options.db) {
      res.status(400).json({ success: false, error: 'Missing situation ID or database' });
      return;
    }
    const situation = loadSituation(options.db, situationId);
    const existing = loadLearningContext(options.db, situationId)?.investigation;
    if (!situation || !existing) {
      res.status(400).json({ success: false, error: 'No completed investigation to recommend from' });
      return;
    }
    // P0010.2 closure micro-repair — the /recommend precondition is now
    // strict on the LATEST attempt's status, not just on the existence
    // of the investigation record.
    //
    // Why this is required (paired with the UI gate in
    // apps/ecommerce/workspace/app.js:2172-2235):
    //   `markInvestigation` does a minimum-merge on a failed attempt,
    //   preserving the prior valid `judgment` / `currentUnderstanding`
    //   (this is the recovery contract — the next successful turn
    //   inherits them). So a row whose LATEST attempt is `status:
    //   'failed'` can still carry a non-null `judgment`. The previous
    //   `!existing`-only check accepted such rows and let
    //   `runRecommendationTurn` generate a fresh recommendation from
    //   stale evidence.
    //
    // `markInvestigation`'s minimum-merge is intentionally OUT OF
    // SCOPE for this slice — we make the consumers strict instead. The
    // prior valid cognition is still shown in the UI as historical
    // context (with a "最新调查未完成" hint); it is just NOT eligible
    // for fresh recommendation generation until the next successful
    // turn lands.
    if (existing.status !== 'completed') {
      res.status(400).json({
        success: false,
        error: `Cannot generate recommendation: latest investigation status is "${existing.status ?? 'unknown'}" (must be "completed"). The prior valid judgment is preserved as historical context only — wait for the next successful investigation turn before requesting a new recommendation.`,
        currentStatus: existing.status ?? 'unknown',
      });
      return;
    }

    try {
      let active = sessions.get(situationId);
      if (!active) {
        const client = options.clientFactory
          ? options.clientFactory(options.hermesUrl)
          : new HermesSessionClient(options.hermesUrl ? { url: options.hermesUrl } : {});
        // P0010.2 closure Repair — use the situation-stamping connect
        // helper so the right-pane UI's situation-scoped Trace sees
        // this investigation's connect state (the default connect
        // logger is process-level and would be filtered out by
        // `situationId`).
        await connectWithSituationTrace(client, situationId);
        const created = await client.createSession({
          cwd: workspaceDir,
          ...(options.profile ? { profile: options.profile } : {}),
        });
        active = { client, hermesSessionId: created.sessionId };
        // Slice 2 — same as /chat: register agent-trace subscription at
        // session-create so we don't miss events from prompt submit onward.
        active.unsubscribeTrace = subscribeAgentTrace(client, situationId, created.sessionId);
        sessions.set(situationId, active);
      }

      const rec = await runRecommendationTurn(active.client, active.hermesSessionId, situation, existing);
      // KNOWN GAP: parse failure leaves no recommendation; do NOT auto-restart
      // here (see block comment on the route above). Operator retries by
      // re-calling /recommend. No attempt history, no session rewrite.
      if (!rec.ok || !rec.recommendation) {
        res.status(200).json({ success: false, agentStatus: 'error', error: rec.error ?? 'Invalid recommendation JSON' });
        return;
      }

      // P0010.2.x — same unified seam as the `/chat` turn-end. The
      // previous code only wrote `recommendation` to the investigation
      // block and never produced a WorkItem, which is what surfaced the
      // "已生成建议 + 生成建议 按钮" contradiction in the UI.
      const seam = writeRecommendationResult(
        options.db,
        situation,
        existing,
        rec.recommendation,
      );
      if (!seam.materialize.created && seam.materialize.reason !== 'duplicate') {
        // Non-fatal: the investigation row was updated (or not — surfaced
        // via seam.investigationPersisted), but no WorkItem was created.
        // We log this so the live-verify case can detect it; the Loop
        // will retry the materialization on the next tick if the
        // content changes.
        // eslint-disable-next-line no-console
        console.warn(
          `[situation/:id/recommend] WorkItem not materialized: reason=${seam.materialize.reason} situation=${situationId}`,
        );
      }

      res.json({ success: true, agentStatus: 'completed', situationId, recommendation: rec.recommendation });
    } catch (err) {
      const dropped = sessions.get(situationId);
      dropped?.unsubscribeTrace?.();
      sessions.delete(situationId);
      const message = err instanceof Error ? err.message : 'Recommendation failed';
      res.status(200).json({
        success: false,
        agentStatus: /timed out/i.test(message) ? 'timeout' : 'error',
        error: message,
        recommendation: loadLearningContext(options.db, situationId)?.investigation?.recommendation ?? null,
      });
    }
  });

  // GET /api/situation/:id/investigation — the situation's stored P0010
  // Investigation Contract (read-only; null when not yet investigated).
  // P0010.2.2 — also surfaces `blockedRuntimeFailure` so the Workspace UI
  // can decide whether to show the recovery button. The flag is computed
  // from the same `countConsecutiveFailures` helper the policy uses, so
  // the UI and the policy cannot disagree.
  router.get('/situation/:id/investigation', async (req, res) => {
    const situationId = req.params['id'];
    if (!options.db) {
      res.json({ success: false, error: 'Investigation requires a database' });
      return;
    }
    const investigation = loadLearningContext(options.db, situationId)?.investigation ?? null;
    let blockedRuntimeFailure = false;
    let consecutiveFailures = 0;
    if (investigation) {
      const { countConsecutiveFailures, DEFAULT_MAX_CONSECUTIVE_FAILURES } = await import(
        '#app/runtime/loop/recovery-candidates.js'
      );
      // `humanInterventions` lives on the Learning Context, not the
      // investigation. Pass the full context so the count includes
      // everything the policy sees.
      const fullCtx = loadLearningContext(options.db, situationId);
      consecutiveFailures = countConsecutiveFailures((fullCtx ?? investigation) as unknown as Record<string, unknown>);
      blockedRuntimeFailure = consecutiveFailures >= DEFAULT_MAX_CONSECUTIVE_FAILURES;
    }
    res.json({ success: true, situationId, investigation, blockedRuntimeFailure, consecutiveFailures });
  });

  // POST /api/situation/:id/clear-block — P0010.2.2 operator escape hatch.
  // Resets the consecutive-failure counter for a situation that the Loop
  // marked `blocked_runtime_failure`. The mechanism is intentionally the
  // SAME as an operator clicking "重试调查": append a `decision: override`
  // human intervention, which `countConsecutiveFailures` recognizes as a
  // counter-reset. The next tick's policy will see the override and stop
  // returning `blocked_runtime_failure` for this situation.
  //
  // This is NOT a manual re-investigation — the Loop still owns the next
  // turn. It is just the "operator acknowledges the block, resume" surface
  // for the self-healing runtime.
  router.post('/situation/:id/clear-block', (req, res) => {
    const situationId = req.params['id'];
    if (!situationId) {
      res.status(400).json({ success: false, error: 'Missing situation ID' });
      return;
    }
    if (!options.db) {
      res.status(500).json({ success: false, error: 'Clear-block requires a database' });
      return;
    }
    const situation = loadSituation(options.db, situationId);
    if (!situation) {
      res.status(404).json({ success: false, error: 'Situation not found' });
      return;
    }
    const intervention = {
      interventionId: `int_clearblock_${uuid()}`,
      situationId,
      actor: { id: 'system:clear-block', role: 'operator' },
      type: 'decision' as const,
      content: { decision: 'override', rationale: 'Operator cleared runtime_failure block; resume auto-investigation.' },
      timestamp: nowIso(),
      summary: 'Clear runtime-failure block (operator override).',
      respondsToActivityIds: [],
      _legacySource: 'none' as const,
    };
    recordInterventionInLearningContext(options.db, situation, intervention);
    // P0010.2.2 — also reset the canonical counter on the investigation
    // marker so the next tick's `listRecoverableCandidates` no longer
    // sees this situation as blocked. The decision intervention above
    // is the audit trail; the marker field is what the runtime reads.
    const priorInv = loadInvestigationFromLearningContext(options.db, situationId);
    if (priorInv) {
      // Audit R4 fix (P0010.2.2): reset blockedEmittedAt along with
      // consecutiveFailures so the next block cycle can re-emit
      // the investigation_blocked event when the threshold is
      // crossed again. The defensive `delete` is a no-op for
      // prior markers that never had a block cycle (the field is
      // already absent), so it is safe to always do.
      const next: Record<string, unknown> = {
        status: priorInv.status ?? 'pending',
        ...(priorInv.error ? { error: priorInv.error } : {}),
        ...(priorInv.evidenceContentHash ? { evidenceContentHash: priorInv.evidenceContentHash } : {}),
        consecutiveFailures: 0,
      };
      delete next['blockedEmittedAt'];
      markInvestigation(options.db, situation, next as Parameters<typeof markInvestigation>[2]);
    }
    res.json({ success: true, situationId, interventionId: intervention.interventionId });
  });

  // POST /api/situation/:id/investigate — P0010 Knowledge-Guided Investigation.
  // Runs in the SAME Hermes session as the situation chat (sessions Map), so the
  // capability-execution result returns into the same turn. Fabric owns: trigger,
  // situation+evidence delivery, capability tool, persistence, workspace surface.
  // Hermes owns: reading Knowledge, forming understanding, choosing the Next
  // Question, selecting a capability, acquiring evidence, updating understanding.
  // On timeout, returns agentStatus:'timeout' + the persisted state (never
  // fabricates a completed investigation).
  router.post('/situation/:id/investigate', async (req, res) => {
    const situationId = req.params['id'];
    if (!situationId) {
      res.status(400).json({ success: false, error: 'Missing situation ID' });
      return;
    }
    if (!options.db) {
      res.status(500).json({ success: false, error: 'Investigation requires a database' });
      return;
    }

    const situation = loadSituation(options.db, situationId);
    if (!situation) {
      res.status(404).json({ success: false, error: 'Situation not found' });
      return;
    }

    try {
      // Ensure the SAME session used by situation chat (reuse, no new session).
      let active = sessions.get(situationId);
      if (!active) {
        if (options.db) {
          const ctx = loadLearningContext(options.db, situationId);
          if (ctx) writeLearningContextToWorkspace(workspaceDir, situationId, ctx);
        }
        const client = options.clientFactory
          ? options.clientFactory(options.hermesUrl)
          : new HermesSessionClient(options.hermesUrl ? { url: options.hermesUrl } : {});
        // P0010.2 closure Repair — use the situation-stamping connect
        // helper so the right-pane UI's situation-scoped Trace sees
        // this investigation's connect state (the default connect
        // logger is process-level and would be filtered out by
        // `situationId`).
        await connectWithSituationTrace(client, situationId);
        const created = await client.createSession({
          cwd: workspaceDir,
          ...(options.profile ? { profile: options.profile } : {}),
        });
        active = { client, hermesSessionId: created.sessionId };
        // Slice 2 — same as /chat and /recommend: register the
        // agent-trace subscription so the right-pane UI sees the
        // connect / session / turn / tool events.
        active.unsubscribeTrace = subscribeAgentTrace(client, situationId, created.sessionId);
        sessions.set(situationId, active);
      }

      const result = await runInvestigationTurn(active.client, active.hermesSessionId, options.db, situation, undefined);
      if (!result.ok) {
        // runInvestigationTurn persists a 'failed' marker (no silent loss) and
        // returns status='failed' for timeouts/errors. Surface it honestly.
        res.status(200).json({
          success: false,
          agentStatus: result.status === 'failed' ? 'failed' : 'error',
          error: result.error,
          rawReply: result.rawReply,
          investigation: loadLearningContext(options.db, situationId)?.investigation ?? null,
        });
        return;
      }

      res.json({
        success: true,
        agentStatus: 'completed',
        situationId,
        sessionId: active.hermesSessionId,
        investigation: result.investigation,
      });
    } catch (err) {
      const dropped = sessions.get(situationId);
      dropped?.unsubscribeTrace?.();
      sessions.delete(situationId);
      const message = err instanceof Error ? err.message : 'Investigation failed';
      res.status(200).json({
        success: false,
        agentStatus: /timed out/i.test(message) ? 'timeout' : 'error',
        error: message,
        // Persisted state is the ground truth if Hermes wrote an investigation
        // before the turn timed out (never fabricate completion).
        investigation: loadLearningContext(options.db, situationId)?.investigation ?? null,
      });
    }
  });

  return router;
};
