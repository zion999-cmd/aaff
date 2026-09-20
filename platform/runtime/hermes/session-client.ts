// HermesSessionClient — a thin JSON-RPC WebSocket client for Hermes' `/api/ws`.
// P0008.3. Speaks Hermes' existing session protocol; does NOT reimplement session logic.
//
// Protocol (from Hermes source, tui_gateway/):
//   connect        → ws://host:port/api/ws?token=<_SESSION_TOKEN>
//   session.create  {"jsonrpc":"2.0","method":"session.create","params":{cwd,profile,...},"id":N}
//                   → {"result":{"session_id":"8-hex",...}}
//   prompt.submit   {"jsonrpc":"2.0","method":"prompt.submit","params":{session_id,text},"id":N}
//   events          {"jsonrpc":"2.0","method":"event","params":{"type":"message.delta",...}}
//
// Turn lifecycle events: turn.start → message.start → message.delta* → message.complete
// Tool lifecycle events: tool.start → tool.complete (result is INSIDE the event payload;
//                       the model never asks the client to execute a tool).
//
// Token lifecycle (P0010.2):
//   Resolution is LAZY — happens inside connect(), not at module load. This makes
//   the client survive `hermes serve` late-start, restart, and token rotation
//   without requiring an agentFabric restart.
//
//   1. Connect-time first attempt: callerToken ?? env-var ?? auto-discover.
//   2. If the first attempt fails (handshake rejected, timeout, close before open),
//      the client retries exactly once with a freshly re-discovered token
//      (skipping the cache). The env-var branch is never auto-replaced: an
//      operator-pinned token is a deliberate choice and the operator must
//      re-export to rotate it.
//
// Uses Node's built-in WHATWG WebSocket (no external dependency).

import {
  resetTokenCache,
  resolveHermesSessionTokenWithSource,
  ENV_TOKEN_NAMES,
  type ResolveHermesTokenResult,
} from './token-resolver.js';
import { traceBuffer, makeTraceEvent } from '#app/runtime/loop/trace-ring-buffer.js';
// P0010.2.7 — single source of truth for the Hermes URL/port default.
// The session client is the one that actually opens a WS connection
// to /api/ws, so the URL it picks MUST be the same one the readiness
// probe and status probe are reporting on. See resolve-url.ts.
import { resolveHermesWsUrl, resolveHermesPort } from './resolve-url.js';
import {
  recordSessionRuntimeProbe,
  recordSessionRuntimeConnectOk,
  recordSessionRuntimeConnectFailure,
} from './health-state.js';

// ---- Types ----

export interface HermesEvent {
  type: string;
  session_id?: string;
  /** Event payload — e.g. `{ text }` for message.delta / message.complete. */
  payload?: {
    text?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** One tool call observed within a turn. `result` is null until `tool.complete`. */
export interface TurnToolCall {
  toolId: string;
  name: string;
  args: unknown;
  result: unknown;
  duration_s?: number;
}

/** Result of one `submitTurnAndCollect` invocation. Pure collector output. */
export interface TurnResult {
  messageText: string;
  toolCalls: TurnToolCall[];
  turnStartedAt: number | null;
  durationMs: number | null;
  /** Set when the collector timed out or saw a `message.error`. */
  error?: string;
}

/**
 * P0011.x — passive observer callbacks. Implementations MUST NOT dispatch
 * tool results, drive loops, or make decisions; the model is the sole
 * reasoner. These callbacks exist only to let the caller stream progress.
 */
export interface TurnObserver {
  onTurnStart?(): void;
  onMessageDelta?(text: string): void;
  onToolStart?(toolId: string, name: string, args: unknown): void;
  onToolComplete?(toolId: string, name: string, result: unknown, duration_s: number): void;
  onTurnComplete?(): void;
}

export interface HermesSessionClientOptions {
  /** Hermes serve host/port (default localhost:9119) */
  url?: string;
  /**
   * Hermes dashboard session token. Authenticates the /api/ws upgrade via
   * `?token=`. Takes priority over the env var and over auto-discovery.
   * If omitted, the env var and then auto-discovery are used.
   */
  token?: string;
  /** Connection timeout ms. Defaults to 10_000. */
  connectTimeoutMs?: number;
}

export interface CreateSessionParams {
  /** Working directory for the session (the Fabric Agent Workspace) */
  cwd: string;
  /** Hermes profile name */
  profile?: string;
  /** Model override (optional) */
  model?: string;
}

export interface CreateSessionResult {
  sessionId: string;
  storedSessionId?: string | undefined;
}

type EventHandler = (event: HermesEvent) => void;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Structured log emitted on every connect attempt. Used by the runtime-loop
 * tick to surface "what we did to talk to Hermes" in the dev log, and by
 * P0010.2.4 live-verify cases to prove the production chain is healthy
 * (or to localize the failure when it isn't).
 *
 * Never includes the actual token value.
 */
export interface HermesConnectInfo {
  url: string;
  port: number;
  /** Where the token came from. May be `null` if resolution failed (no
   *  env-var set and auto-discover returned no token). */
  tokenSource: ResolveHermesTokenResult['source'];
  authRequired: boolean;
  /** Set when the auth probe failed and we fell back to token-required. */
  probeFailed?: boolean;
  /** Connect outcome — `null` when connect() resolves. */
  outcome: 'ok' | 'no-token-resolved' | 'failed' | null;
  /** Human-readable error (no token value). */
  error?: string;
  /** ms since connect() started. */
  latencyMs: number;
  attempt: 1 | 2;
}

/** Optional structured logger; defaults to `console.info`. */
export type HermesConnectLogger = (info: HermesConnectInfo) => void;

// ---- Slice 2: HermesConnectInfo -> TraceEvent mapping -----------------

/**
 * Runtime-agnostic mapping from a HermesConnectInfo to a TraceEvent. The
 * `source` is `agent` (the Agent Runtime layer — Hermes today, any
 * non-Hermes Agent tomorrow), and the `kind` is one of the
 * `agent.connect.*` set. Connect events are situation-less (the connect
 * happens before any specific situation is bound to the client), so
 * `situationId` is intentionally omitted. The UI renders them as
 * process-level signals; the API's situationId filter naturally excludes
 * them when an operator scopes to a single Situation.
 */
const connectInfoToTraceEvent = (info: HermesConnectInfo): ReturnType<typeof makeTraceEvent> => {
  const port = info.port;
  const tokenSource = info.tokenSource ?? 'unknown';
  const attempt = info.attempt;
  const auth = info.authRequired ? 'auth_required' : 'no_auth';
  if (info.outcome === 'ok') {
    return makeTraceEvent({
      source: 'agent',
      kind: 'agent.connect.ok',
      summary: `Agent 连接成功（port=${port} · ${auth} · tokenSource=${tokenSource} · attempt=${attempt} · ${info.latencyMs}ms）`,
      detail: { ...info },
    });
  }
  if (info.outcome === 'no-token-resolved') {
    return makeTraceEvent({
      source: 'agent',
      kind: 'agent.connect.failed',
      summary: `Agent 连接失败：未解析到 token（port=${port} · ${auth}）`,
      detail: { ...info },
    });
  }
  // 'failed' (or null outcome during in-flight attempt 1) — both are
  // connect failures from the operator's POV. We split them by attempt
  // so the operator can see "first try failed; second try succeeded" or
  // "both attempts failed".
  return makeTraceEvent({
    source: 'agent',
    kind: 'agent.connect.failed',
    summary: `Agent 连接失败（attempt=${attempt} · port=${port} · ${auth}）：${info.error ?? '未知错误'}`,
    detail: { ...info },
  });
};

let defaultConnectLogger: HermesConnectLogger = (info) => {
  // eslint-disable-next-line no-console
  console.info(
    `[hermes-connect] port=${info.port} authRequired=${info.authRequired} ` +
      `tokenSource=${info.tokenSource} attempt=${info.attempt} ` +
      `outcome=${info.outcome} latencyMs=${info.latencyMs}` +
      (info.error ? ` error=${info.error}` : ''),
  );
  // Slice 2: also push the runtime-agnostic trace event. Connect
  // events are situation-less; the right-pane UI renders them as
  // "agent-layer" rows when no situationId filter is applied.
  traceBuffer.push(connectInfoToTraceEvent(info));
};

export function setHermesConnectLogger(logger: HermesConnectLogger | null): void {
  defaultConnectLogger =
    logger ??
    ((info) => {
      // eslint-disable-next-line no-console
      console.info(
        `[hermes-connect] port=${info.port} authRequired=${info.authRequired} ` +
          `tokenSource=${info.tokenSource} attempt=${info.attempt} ` +
          `outcome=${info.outcome} latencyMs=${info.latencyMs}` +
          (info.error ? ` error=${info.error}` : ''),
      );
      // Slice 2: same buffer push as the default logger. We DO NOT
      // try to push events from a caller-supplied logger (the operator
      // may have redirected to a different sink for live-verify
      // scenarios). Buffer is the in-process observability surface;
      // a custom logger is the external log surface; they are
      // independent. The default (and `setHermesConnectLogger(null)`
      // fallback) keep the buffer populated.
      traceBuffer.push(connectInfoToTraceEvent(info));
    });
}

// ---- /api/health probe ----

interface HermesHealthResponse {
  ok: boolean;
  version?: string;
  auth_required?: boolean;
  [key: string]: unknown;
}

/** Per-port cache: server name + auth_required, plus a "probe failed" flag. */
interface HealthCacheEntry {
  port: number;
  authRequired: boolean;
  probeFailed: boolean;
  cachedAt: number;
}
const healthCache: Map<number, HealthCacheEntry> = (globalThis as {
  __hermesHealthCache?: Map<number, HealthCacheEntry>;
}).__hermesHealthCache ??= new Map();

const HEALTH_PROBE_TIMEOUT_MS = 3_000;
/** Reuse the probe result for this many ms before re-probing. */
const HEALTH_PROBE_TTL_MS = 30_000;

/**
 * Probe Hermes' HTTP `/api/health` to learn whether the running serve
 * reports `auth_required: true` or `auth_required: false`.
 *
 * IMPORTANT: the probe result is **diagnostic only**. It does NOT
 * control whether the WebSocket upgrade sends `?token=`. Hermes 0.20.5
 * (web_server.py:_ws_auth_reason) validates `?token=<_SESSION_TOKEN>` in
 * BOTH modes — loopback (`auth_required: false`) only skips the OAuth
 * ticket, not the session token. The connect path always sends a
 * token; the probe only changes the log metadata and the missing-token
 * error message.
 *
 * Result is cached per-port for `HEALTH_PROBE_TTL_MS`. A failed probe is
 * cached as `probeFailed=true, authRequired=true` so we treat the
 * server as auth-required rather than assuming a non-authenticated
 * mode we couldn't reach.
 */
export async function probeAuthRequired(
  url: string,
  options: { forceRefresh?: boolean } = {},
): Promise<{ authRequired: boolean; probeFailed: boolean }> {
  const port = resolveHermesPort(url);
  const cached = healthCache.get(port);
  if (!options.forceRefresh && cached && Date.now() - cached.cachedAt < HEALTH_PROBE_TTL_MS) {
    return { authRequired: cached.authRequired, probeFailed: cached.probeFailed };
  }
  const httpUrl = urlToHttp(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(httpUrl, { signal: ac.signal });
    if (!resp.ok) {
      const entry: HealthCacheEntry = {
        port,
        authRequired: true,
        probeFailed: true,
        cachedAt: Date.now(),
      };
      healthCache.set(port, entry);
      return { authRequired: true, probeFailed: true };
    }
    const body = (await resp.json()) as HermesHealthResponse;
    const authRequired = body.auth_required !== false; // default to required
    const entry: HealthCacheEntry = {
      port,
      authRequired,
      probeFailed: false,
      cachedAt: Date.now(),
    };
    healthCache.set(port, entry);
    return { authRequired, probeFailed: false };
  } catch {
    const entry: HealthCacheEntry = {
      port,
      authRequired: true,
      probeFailed: true,
      cachedAt: Date.now(),
    };
    healthCache.set(port, entry);
    return { authRequired: true, probeFailed: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Clear the per-port health cache (used by the retry path). */
export function resetHealthCache(): void {
  healthCache.clear();
}

/**
 * Translate a `/api/ws` URL to its `/api/health` probe counterpart.
 * This is the Session Runtime probe (the same endpoint `hermes serve` and
 * `hermes dashboard` both expose on their default port 9119). It is NOT
 * a hermes gateway endpoint — port 8642 is a separate service.
 */
function urlToHttp(wsUrl: string): string {
  // ws://localhost:9119/api/ws → http://localhost:9119/api/health
  const replaced = wsUrl.replace(/^ws(s)?:\/\//, 'http$1://');
  return replaced.replace(/\/api\/ws\/?$/, '/api/health');
}

export function parsePortFromUrl(url: string): number | undefined {
  try {
    const u = new URL(url);
    if (!u.port) return undefined;
    const n = Number.parseInt(u.port, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Thrown when a connect-time authentication failure indicates the token is
 * stale or wrong (handshake rejected, server close before open, or auto-retry
 * also failed). Carries no token value — messages must NEVER include the
 * actual token.
 */
export class HermesAuthError extends Error {
  override readonly name = 'HermesAuthError';
  constructor(
    readonly reason: 'connect_failed' | 'connect_closed' | 'connect_timeout' | 'retry_exhausted' | 'missing_token' | 'session_runtime_unreachable',
    message: string,
  ) {
    super(message);
  }
}

// ---- Client ----

export class HermesSessionClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly url: string;
  private readonly callerToken: string | undefined;
  private readonly connectTimeoutMs: number;
  /** Set by close(); the connect path inspects this to decide whether a
   *  mid-connect onclose should trigger the retry-once path. */
  private closedByUser = false;

  constructor(options: HermesSessionClientOptions = {}) {
    // P0010.2 closure Repair — the WS URL is overridable via the
    // P0010.2.7 — `options.url` (programmatic) wins, then the operator
    // env var, then the project-wide default from resolve-url.ts. The
    // previous hard-coded 9119 default drifted when the project's
    // chosen Hermes was moved to 9120; the helper now keeps this
    // constructor in lockstep with the readiness probe and the
    // auto-discovery lsof+ps eww probe in token-resolver.ts.
    const fromEnv = typeof process !== 'undefined' && process.env
      ? process.env['HERMES_WS_URL']
      : undefined;
    this.url = options.url ?? fromEnv ?? resolveHermesWsUrl();
    this.callerToken = options.token;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  }

  /**
   * Connect to Hermes serve /api/ws. Resolves when the socket opens.
   *
   * Token resolution happens here, lazily:
   *   1. Probe `/api/health`. The result is used as **log metadata** and to
   *      choose the actionable error message — it does NOT control whether
   *      we send `?token=`. Hermes 0.20.5's `_ws_auth_reason`
   *      (web_server.py:16313-16427) requires `?token=<_SESSION_TOKEN>` on
   *      the WS upgrade in BOTH `auth_required: true` AND `auth_required: false`
   *      (loopback) modes. The probe's `auth_required` field only describes
   *      whether an OAuth ticket is required in addition to the session token.
   *   2. Resolve a candidate token: callerToken > env-var > auto-discover.
   *      The only env var we accept is `HERMES_DASHBOARD_SESSION_TOKEN`
   *      (Hermes 0.20.5 reads the same name; see web_server.py:540).
   *   3. tryOnce(token). If it fails, reset the auto-discover cache and
   *      try a fresh candidate — but only if the failure wasn't a
   *      deliberate close() and the prior token was NOT callerToken /
   *      env-pinned (operator-pinned tokens are never auto-replaced).
   *
   * Every attempt emits a structured `HermesConnectInfo` log (see
   * `defaultConnectLogger`) so live verification can prove the production
   * chain is healthy without leaking the token value.
   */
  async connect(): Promise<void> {
    this.closedByUser = false;
    // 9119 is the `hermes serve` default (Session Runtime), not gateway.
    // P0010.2.7 — resolved through the project-wide helper so the actual
    // WS connect targets the same port readiness/turn use.
    const port = resolveHermesPort(this.url);
    const startedAt = Date.now();
    const log = (info: Partial<HermesConnectInfo> & { attempt: 1 | 2 }): void => {
      const merged: HermesConnectInfo = {
        url: this.url,
        port,
        tokenSource: info.tokenSource ?? null,
        authRequired: info.authRequired ?? false,
        outcome: info.outcome ?? null,
        latencyMs: Date.now() - startedAt,
        attempt: info.attempt,
      };
      if (info.probeFailed !== undefined) merged.probeFailed = info.probeFailed;
      if (info.error !== undefined) merged.error = info.error;
      defaultConnectLogger(merged);
    };

    // (1) Probe Hermes' /api/health. The result is used as log metadata +
    // to choose the actionable error message. It does NOT change whether
    // we send `?token=` — see probeAuthRequired() JSDoc above.
    const probe = await probeAuthRequired(this.url);
    // ADR-064: publish the probe result to the 3-layer health state so
    // /api/runtime/hermes/status and /api/readiness agree on what the
    // last observation was. The tokenSource is still unknown at this
    // point — it gets overwritten on the connect-ok / connect-failure
    // path below.
    recordSessionRuntimeProbe({
      url: this.url,
      port,
      authRequired: probe.authRequired,
      probeFailed: probe.probeFailed,
      tokenSource: null,
    });

    // (2) Resolve a candidate token: callerToken > env-var > auto-discover.
    //
    // P0010.2.4 review repair (ADR-061): the only env var we accept is
    // `HERMES_DASHBOARD_SESSION_TOKEN`. `HERMES_GATEWAY_TOKEN` was removed
    // because it is the credential for Hermes' separate HTTP gateway
    // service, not the `_SESSION_TOKEN` that the `/api/ws` upgrade
    // validates via `hmac.compare_digest` in `web_server.py:16421`.
    const resolveToken = (): Promise<ResolveHermesTokenResult> => {
      if (this.callerToken) {
        return Promise.resolve({ token: this.callerToken, source: 'env-dashboard' });
      }
      const envDashboard = process.env[ENV_TOKEN_NAMES.dashboard];
      if (envDashboard) {
        return Promise.resolve({ token: envDashboard, source: 'env-dashboard' });
      }
      return resolveHermesSessionTokenWithSource({ url: this.url });
    };

    const first = await resolveToken();
    if (!first.token) {
      log({
        attempt: 1,
        authRequired: probe.authRequired,
        probeFailed: probe.probeFailed,
        tokenSource: first.source,
        outcome: 'no-token-resolved',
        error: 'no_token_found',
      });
      // ADR-064: no session token resolvable — the Session Runtime is
      // not usable through the configured adapter. Mark unavailable
      // before throwing so the readiness/status route surfaces the
      // actual reason.
      recordSessionRuntimeConnectFailure({
        url: this.url,
        port,
        reason: 'no session token resolvable (env-dashboard unset, auto-discover returned no token)',
      });
      throw this.missingTokenError(probe);
    }
    log({
      attempt: 1,
      authRequired: probe.authRequired,
      probeFailed: probe.probeFailed,
      tokenSource: first.source,
      outcome: null,
    });

    const firstErr = await this.tryOnce(first.token).catch((err: unknown) => err);
    if (!(firstErr instanceof Error)) {
      log({
        attempt: 1,
        authRequired: probe.authRequired,
        probeFailed: probe.probeFailed,
        tokenSource: first.source,
        outcome: 'ok',
      });
      // ADR-064: connect succeeded — overwrite the health state with the
      // confirmed source and mark Session Runtime healthy.
      recordSessionRuntimeConnectOk({
        url: this.url,
        port,
        tokenSource: first.source,
      });
      return;
    }
    log({
      attempt: 1,
      authRequired: probe.authRequired,
      probeFailed: probe.probeFailed,
      tokenSource: first.source,
      outcome: 'failed',
      error: firstErr.message,
    });

    if (this.closedByUser) throw firstErr;

    // Determine whether the failing token came from auto-discovery. If it
    // did, clear the cache so the retry re-shells-out to the running serve
    // (handles `hermes serve` restarts and token rotation).
    // Operator-pinned tokens (callerToken or env var) are NEVER auto-replaced.
    const tokenIsAutoDiscovered = first.source === 'auto-dashboard';
    if (tokenIsAutoDiscovered) resetTokenCache();

    const fresh = await resolveToken();
    if (!fresh.token) {
      const reason = `token re-resolve returned empty after first attempt failed: ${firstErr.message}. ` +
        `${ENV_TOKEN_NAMES.dashboard} is NOT a fallback to a different transport; the configured session adapter is 'hermes serve' at ${this.url}.`;
      // ADR-064: token re-resolve failed after a connect failure — the
      // Session Runtime is not reachable through the configured adapter.
      recordSessionRuntimeConnectFailure({ url: this.url, port, reason });
      throw this.sessionRuntimeUnreachableError(new Error(reason));
    }

    const secondErr = await this.tryOnce(fresh.token).catch((err: unknown) => err);
    if (!(secondErr instanceof Error)) {
      log({
        attempt: 2,
        authRequired: probe.authRequired,
        probeFailed: probe.probeFailed,
        tokenSource: fresh.source,
        outcome: 'ok',
      });
      // ADR-064: second-attempt connect succeeded — overwrite the health
      // state with the confirmed source (the post-refresh token source
      // is the one that actually worked).
      recordSessionRuntimeConnectOk({
        url: this.url,
        port,
        tokenSource: fresh.source,
      });
      return;
    }
    log({
      attempt: 2,
      authRequired: probe.authRequired,
      probeFailed: probe.probeFailed,
      tokenSource: fresh.source,
      outcome: 'failed',
      error: secondErr.message,
    });

    // ADR-064: both connect attempts failed — Session Runtime is not
    // reachable through the configured adapter. Mark the health state
    // accordingly BEFORE throwing so the readiness/status routes reflect
    // the failure even if no caller is awaiting the throw.
    recordSessionRuntimeConnectFailure({
      url: this.url,
      port,
      reason: `connect failed twice — first: ${firstErr.message}; second (after token refresh): ${secondErr.message}`,
    });
    throw this.sessionRuntimeUnreachableError(
      new Error(`connect failed twice — first: ${firstErr.message}; second (after token refresh): ${secondErr.message}`),
    );
  }

  /**
   * One WebSocket handshake attempt with the given token. Resolves on
   * `onopen`, rejects on `onerror` / `onclose` before open / timeout.
   */
  private tryOnce(token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = `${this.url}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore: ws may already be closed by the server
        }
        reject(new HermesAuthError('connect_timeout', `connect timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      const settle = (err?: HermesAuthError): void => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      ws.onopen = () => settle();
      ws.onerror = (e) =>
        settle(new HermesAuthError('connect_failed', `WebSocket error connecting to ${this.url}: ${String(e)}`));
      ws.onclose = (ev) => {
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          settle(new HermesAuthError('connect_closed', `WebSocket closed before open (code=${ev.code})`));
        }
        // If the socket opened and then later closed, the open handler has
        // already settled with resolve(); ignore.
      };
      ws.onmessage = (msg) => this.handleMessage(msg);
    });
  }

  /**
   * P0010.2.4 + ADR-064 — error when no session token is available, OR the
   * configured session-runtime endpoint is unreachable.
   *
   * Per ADR-064 diagnostic contract (user verbatim):
   *   * AgentFabric's only Hermes transport is `HermesSessionClient` →
   *     `hermes serve` → `/api/ws`. The hermes gateway (port 8642, OpenAI-
   *     compatible API server, `API_SERVER_KEY` Bearer) is a SEPARATE
   *     service and is NOT a fallback.
   *   * The error MUST name the **Session Runtime** as the missing
   *     dependency, not "Hermes" generically, and MUST say `hermes serve`
   *     is the required subcommand (NOT `hermes gateway` or `hermes
   *     dashboard`).
   *   * The two distinct failure modes (probe unreachable vs token missing)
   *     are surfaced as different `modeHint` suffixes so the operator can
   *     tell the cases apart without reading source.
   */
  private missingTokenError(probe: { authRequired: boolean; probeFailed: boolean }): HermesAuthError {
    const modeHint = probe.probeFailed
      ? ' (session runtime probe failed: /api/health not reachable at this URL)'
      : probe.authRequired
        ? ' (session runtime reports auth_required=true)'
        : ' (session runtime reports auth_required=false; loopback mode still requires ?token=)';
    return new HermesAuthError(
      'missing_token',
      `Hermes Session Runtime unavailable at ${this.url}. ` +
        `AgentFabric requires 'hermes serve' for the configured session adapter.${modeHint}\n` +
        `Resolution: (a) start the Session Runtime with 'hermes serve' and ` +
        `export HERMES_DASHBOARD_SESSION_TOKEN=<chosen_value> in BOTH the 'hermes serve' shell and the agentFabric shell, OR ` +
        `(b) set HERMES_WS_URL to point at an already-running 'hermes serve' instance. ` +
        `The configured endpoint is ${this.url} (project default: ws://localhost:9120/api/ws). ` +
        `NOT a fallback: hermes gateway (port 8642, API_SERVER_KEY Bearer) is a separate service and is NOT supported by the configured session adapter.`,
    );
  }

  /**
   * P0010.2.4 + ADR-064 — error when the configured session-runtime endpoint
   * is reachable enough to be probed but the WebSocket upgrade itself
   * failed after the token was accepted. Distinguished from
   * `missingTokenError` so the operator can tell "I have a token but my
   * session runtime is misbehaving" apart from "I have no token at all".
   */
  private sessionRuntimeUnreachableError(err: unknown): HermesAuthError {
    const reason = err instanceof Error ? err.message : String(err);
    return new HermesAuthError(
      'session_runtime_unreachable',
      `Hermes Session Runtime unavailable at ${this.url}. ` +
        `AgentFabric requires 'hermes serve' for the configured session adapter. ` +
        `(WebSocket upgrade failed after token accepted: ${reason})`,
    );
  }

  /** Subscribe to streamed events (message.delta, message.complete, tool.*, etc.). */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** Create a session. Returns the 8-hex session_id. */
  async createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
    const result = await this.request('session.create', {
      cwd: params.cwd,
      profile: params.profile ?? null,
      model: params.model ?? '',
      source: 'fabric',
    });
    const r = result as { session_id: string; stored_session_id?: string };
    return { sessionId: r.session_id, storedSessionId: r.stored_session_id };
  }

  /** Submit a user prompt to a session. */
  async submitPrompt(sessionId: string, text: string): Promise<void> {
    await this.request('prompt.submit', { session_id: sessionId, text });
  }

  /**
   * P0011.x — submit a prompt and COLLECT the full turn transcript as a
   * passive observer. No dispatch, no tool-result injection, no reasoning
   * loop. The model remains the sole reasoner; we just collect every
   * `message.*` + `tool.*` event Hermes broadcasts until `turn.complete`
   * (or `turn.timeout` / `message.error`) signals the end of the turn.
   *
   * Use this when the model is expected to call MCP-loaded tools
   * (e.g. `fabric_browser_*`) inside one turn. The returned `TurnResult`
   * is the canonical, replayable record of what the model did.
   */
  async submitTurnAndCollect(
    sessionId: string,
    text: string,
    options?: { timeoutMs?: number; onProgress?: TurnObserver },
  ): Promise<TurnResult> {
    const timeoutMs = options?.timeoutMs ?? 10 * 60_000;
    const observer = options?.onProgress;

    type RecordedToolCall = TurnResult['toolCalls'][number];
    const toolCalls: RecordedToolCall[] = [];
    let lastMessageText = '';
    let turnStartedAt: number | null = null;
    let turnCompleted = false;
    let lastError: string | null = null;

    const timer = setTimeout(() => {
      if (!turnCompleted) {
        // We do NOT decide what to do here. The collector times out and
        // returns the partial transcript. The caller decides next step.
        lastError = `submitTurnAndCollect timed out after ${timeoutMs}ms (turn.complete not observed)`;
        // Resolve the inner promise; main flow reads `lastError`.
        finalize();
      }
    }, timeoutMs);

    const finishOnce = (() => {
      let called = false;
      return () => {
        if (called) return;
        called = true;
        clearTimeout(timer);
        turnCompleted = true;
      };
    })();

    let resolveFinal: () => void = () => {};
    const final = new Promise<void>((r) => { resolveFinal = r; });
    const finalize = () => { resolveFinal(); };

    const unsubscribe = this.onEvent((event) => {
      if (event.session_id && event.session_id !== sessionId) return;
      const type = String(event['type'] ?? '');
      const payload = (event['payload'] ?? {}) as Record<string, unknown>;

      switch (type) {
        case 'turn.start': {
          turnStartedAt = Date.now();
          observer?.onTurnStart?.();
          break;
        }
        case 'message.delta': {
          const text = String(payload['text'] ?? '');
          if (text) {
            lastMessageText += text;
            observer?.onMessageDelta?.(text);
          }
          break;
        }
        case 'message.complete': {
          const text = String(payload['text'] ?? '');
          if (text) lastMessageText = text;
          break;
        }
        case 'message.error': {
          lastError = String(payload['error'] ?? payload['text'] ?? 'message.error');
          break;
        }
        case 'tool.start': {
          const tc: RecordedToolCall = {
            toolId: String(payload['tool_id'] ?? ''),
            name: String(payload['name'] ?? ''),
            args: payload['args'] ?? null,
            result: null,
          };
          toolCalls.push(tc);
          observer?.onToolStart?.(tc.toolId, tc.name, tc.args);
          break;
        }
        case 'tool.complete': {
          const toolId = String(payload['tool_id'] ?? '');
          const idx = toolCalls.findIndex((c) => c.toolId === toolId);
          const result = payload['result'] ?? null;
          if (idx >= 0) {
            const completed: RecordedToolCall = {
              ...toolCalls[idx]!,
              result,
              ...(typeof payload['duration_s'] === 'number'
                ? { duration_s: payload['duration_s'] as number }
                : {}),
            };
            toolCalls[idx] = completed;
            observer?.onToolComplete?.(completed.toolId, completed.name, completed.result, completed.duration_s ?? 0);
          } else {
            // tool.complete arrived without a prior tool.start; record it anyway.
            const tc: RecordedToolCall = {
              toolId,
              name: String(payload['name'] ?? ''),
              args: payload['args'] ?? null,
              result,
              ...(typeof payload['duration_s'] === 'number'
                ? { duration_s: payload['duration_s'] as number }
                : {}),
            };
            toolCalls.push(tc);
            observer?.onToolComplete?.(tc.toolId, tc.name, tc.result, tc.duration_s ?? 0);
          }
          break;
        }
        case 'turn.complete':
        case 'turn.timeout': {
          observer?.onTurnComplete?.();
          finishOnce();
          finalize();
          break;
        }
        default:
          break;
      }
    });

    try {
      await this.submitPrompt(sessionId, text);
      await final;
    } finally {
      unsubscribe();
      finishOnce();
    }

    return {
      messageText: lastMessageText,
      toolCalls,
      turnStartedAt,
      durationMs: turnStartedAt ? Date.now() - turnStartedAt : null,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  /** Respond to a pending approval request (choice: 'approve' | 'deny'). */
  async respondApproval(sessionId: string, choice: 'approve' | 'deny', all = false): Promise<void> {
    await this.request('approval.respond', {
      session_id: sessionId,
      choice,
      all,
    });
  }

  /** Resume an existing session (by id/prefix). */
  async resumeSession(sessionId: string): Promise<void> {
    await this.request('session.resume', { session_id: sessionId });
  }

  /** Close the connection. Marks the client as user-closed so a subsequent
   *  reconnect attempt (or an in-flight connect()) won't trigger the
   *  retry-once path. */
  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }

  // ---- Internals ----

  private handleMessage(msg: MessageEvent): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(String(msg.data));
    } catch {
      return; // ignore non-JSON frames
    }

    // Event frame (no id): dispatch to handlers.
    if (obj['method'] === 'event') {
      const params = (obj['params'] ?? {}) as HermesEvent;
      for (const handler of this.eventHandlers) handler(params);
      return;
    }

    // Response frame (has id): resolve the pending request.
    if (typeof obj['id'] === 'number') {
      const id = obj['id'] as number;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);

      if (obj['error'] != null) {
        pending.reject(new Error(`Hermes error: ${JSON.stringify(obj['error'])}`));
      } else {
        pending.resolve(obj['result']);
      }
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to Hermes serve'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ jsonrpc: '2.0', method, params, id });
      this.ws!.send(frame);
    });
  }
}
