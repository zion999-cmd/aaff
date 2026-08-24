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
// Uses Node's built-in WHATWG WebSocket (no external dependency).

import { resolveHermesSessionToken } from './token-resolver.js';

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
  /** Hermes dashboard session token. Authenticates the /api/ws upgrade via
   *  `?token=`. Falls back to the HERMES_DASHBOARD_SESSION_TOKEN env var. */
  token?: string;
  /** Connection timeout ms */
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

// Eagerly kick off auto-discovery at module load so the synchronous constructor
// can read a populated `resolvedToken` snapshot. Resolution typically completes
// in <50ms (one `lsof` + one `ps eww` / `cat /proc/...`); the first WS connect
// always happens well after the constructor returns. If the resolver is still
// in flight when the first connect() is called, the connect path falls through
// to "Missing token" — the caller can retry a moment later.
let resolvedToken: string | undefined;
resolveHermesSessionToken()
  .then((t) => {
    resolvedToken = t;
  })
  .catch(() => {
    resolvedToken = undefined;
  });

// ---- Client ----

export class HermesSessionClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly url: string;
  private readonly token: string | undefined;

  constructor(options: HermesSessionClientOptions = {}) {
    const port = 9119;
    this.url = options.url ?? `ws://localhost:${port}/api/ws`;
    // Resolution priority:
    //   1. Explicit `options.token` (caller-supplied, e.g. tests).
    //   2. `HERMES_DASHBOARD_SESSION_TOKEN` in this process env (operator-pinned).
    //   3. Auto-discovered from the running `hermes serve` process env (set at
    //      module load via `resolveHermesSessionToken()`; cached for the
    //      process lifetime). See `token-resolver.ts` for the cross-platform
    //      discovery implementation.
    this.token = options.token ?? process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? resolvedToken;
  }

  /** Connect to Hermes serve /api/ws. Resolves when the socket opens. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.token) {
        reject(
          new Error(
            'Missing Hermes dashboard session token. Either (a) export ' +
              'HERMES_DASHBOARD_SESSION_TOKEN in the agentFabric process env to match ' +
              'the value used by `hermes serve`, or (b) start `hermes serve` (defaults ' +
              'to port 9119) so the token can be auto-discovered from its process env. ' +
              'See platform/runtime/hermes/token-resolver.ts for details.',
          ),
        );
        return;
      }
      const wsUrl = `${this.url}?token=${encodeURIComponent(this.token)}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`WebSocket error connecting to ${this.url}: ${String(e)}`));
      ws.onmessage = (msg) => this.handleMessage(msg);
      ws.onclose = () => {
        // Fail any pending requests on close.
        for (const [, p] of this.pending) {
          p.reject(new Error('Hermes connection closed'));
        }
        this.pending.clear();
      };
    });
  }

  /** Subscribe to streamed events (message.delta, message.complete, tool.*, etc.). */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
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

  /** Close the connection. */
  close(): void {
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
