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
  const port = parsePortFromUrl(url) ?? 9119;
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

function urlToHttp(wsUrl: string): string {
  // ws://localhost:9119/api/ws → http://localhost:9119/api/health
  const replaced = wsUrl.replace(/^ws(s)?:\/\//, 'http$1://');
  return replaced.replace(/\/api\/ws\/?$/, '/api/health');
}

function parsePortFromUrl(url: string): number | undefined {
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
    readonly reason: 'connect_failed' | 'connect_closed' | 'connect_timeout' | 'retry_exhausted' | 'missing_token',
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
    // `HERMES_WS_URL` env var. Default 9119 is preserved for the
    // production deployment shape. The dev env commonly runs Hermes on a
    // non-default port (e.g. 9120) so an explicit env var lets the same
    // agentFabric binary talk to a non-standard Hermes without code
    // changes. The `options.url` parameter still wins (programmatic
    // override), then the env var, then the default.
    const DEFAULT_PORT = 9119;
    const fromEnv = typeof process !== 'undefined' && process.env
      ? process.env['HERMES_WS_URL']
      : undefined;
    const port = parsePortFromUrl(options.url ?? fromEnv ?? `ws://localhost:${DEFAULT_PORT}/api/ws`) ?? DEFAULT_PORT;
    this.url = options.url ?? fromEnv ?? `ws://localhost:${port}/api/ws`;
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
    const port = parsePortFromUrl(this.url) ?? 9119;
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
      throw new Error(
        `Hermes connect failed (${firstErr.message}); auto-re-resolve also returned no token. ` +
          `If ${ENV_TOKEN_NAMES.dashboard} is set in the agentFabric env, ` +
          `refresh it to match the value in the running 'hermes serve' process; otherwise verify ` +
          `'hermes serve' is up on ${this.url} with auth_required=${probe.authRequired ? 'true' : 'false'}.`,
      );
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

    throw new Error(
      `Hermes connect failed twice. First: ${firstErr.message}. ` +
        `Second (after token refresh): ${secondErr.message}. ` +
        `Verify 'hermes serve' is up on ${this.url} and the token in its env matches.`,
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
   * P0010.2.4 — error when no token is available. Now takes the probe
   * result so the message can mention whether the running Hermes is in
   * `auth_required: false` (loopback) mode, in which case the operator
   * must still set the env var (or have `hermes serve` running for
   * auto-discover) — Hermes 0.20.5 authenticates the WebSocket upgrade
   * in both modes (see web_server.py:_ws_auth_reason).
   */
  private missingTokenError(probe: { authRequired: boolean; probeFailed: boolean }): HermesAuthError {
    const modeHint = probe.probeFailed
      ? ' (could not probe /api/health; assuming auth_required)'
      : probe.authRequired
        ? ' (Hermes reports auth_required=true)'
        : ' (Hermes reports auth_required=false; loopback mode still requires ?token=)';
    return new HermesAuthError(
      'missing_token',
      `Missing Hermes dashboard session token${modeHint}. Either (a) export ` +
        `${ENV_TOKEN_NAMES.dashboard} in the agentFabric process env ` +
        `to match the value used by 'hermes serve', or (b) start 'hermes serve' (defaults to port 9119) ` +
        `so the token can be auto-discovered from its process env. ` +
        `See platform/runtime/hermes/token-resolver.ts for details.`,
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
