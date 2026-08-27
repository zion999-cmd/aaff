// P0008.3 — HermesSessionClient tests (mock WebSocket).
// Validates JSON-RPC framing: session.create / prompt.submit / event dispatch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock for the resolver so tests are deterministic regardless of whether
// a real `hermes serve` is listening on 9119 in the test environment.
// P0010.2: resolution is now LAZY (inside connect()), so we do NOT need
// `vi.resetModules()` / `vi.doMock()` to drive the auto-discover path.
vi.mock('#platform/runtime/hermes/token-resolver.js', () => ({
  resolveHermesSessionToken: vi.fn().mockResolvedValue(undefined),
  // P0010.2.4 — session-client now reads source-of-truth through
  // `resolveHermesSessionTokenWithSource` for the structured connect log.
  // The mock delegates to the legacy `resolveHermesSessionToken` so
  // existing tests that set `resolveTokenMock.mockResolvedValue('x')`
  // continue to drive both paths.
  resolveHermesSessionTokenWithSource: vi.fn(async (...args: unknown[]) => {
    const token = (await (resolveTokenMock as (...a: unknown[]) => Promise<unknown>)(...args)) as
      | string
      | undefined;
    return { token, source: token ? ('auto-dashboard' as const) : null };
  }),
  resetTokenCache: () => undefined,
  // P0010.2.4 review repair (ADR-061) — `gateway` key removed; the
  // session client now consults ONLY HERMES_DASHBOARD_SESSION_TOKEN.
  ENV_TOKEN_NAMES: { dashboard: 'HERMES_DASHBOARD_SESSION_TOKEN' },
}));

import { HermesSessionClient } from '#platform/runtime/hermes/index.js';
import type { HermesEvent } from '#platform/runtime/hermes/index.js';
import { resolveHermesSessionToken } from '#platform/runtime/hermes/token-resolver.js';

const resolveTokenMock = vi.mocked(resolveHermesSessionToken);

// ---- Mock WebSocket ----

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  sent: string[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
  }

  // Test helpers
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emitError(message: string): void {
    this.onerror?.(new Error(message));
  }
  emitCloseBeforeOpen(code = 4001): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  emitMessage(obj: unknown): void {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
}

/**
 * P0010.2: connect() is fully async — token resolution happens inside it.
 * To inspect MockWebSocket.instances, callers must yield to the microtask
 * queue so the WebSocket constructor runs. This helper drives connect() to
 * that point and returns both the in-flight WebSocket and the original
 * promise so tests can await its resolution/rejection.
 *
 * P0010.2.4: connect() now also probes `/api/health` first (audit A —
 * the dev case where Hermes exports `auth_required: false` and we should
 * skip the token entirely). The probe is stubbed by `beforeEach` to
 * report `auth_required: true` so the existing tests continue to drive
 * the token path. We need ≥3 microtask flushes: probe → resolveToken →
 * tryOnce → new WebSocket.
 */
async function beginConnect(client: HermesSessionClient): Promise<{ ws: MockWebSocket; connectPromise: Promise<void> }> {
  const connectPromise = client.connect();
  // Wait for the WebSocket to actually be constructed. The connect path
  // is now: probeAuthRequired (fetch + .json) → resolveToken → tryOnce
  // → new WebSocket, which is 4+ microtask flushes. Use vi.waitFor
  // (real-time polling) so we don't depend on the exact microtask count.
  await vi.waitFor(
    () => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    },
    { timeout: 1000 },
  );
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  return { ws, connectPromise };
}

// ---- Tests ----

describe('HermesSessionClient', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    // P0010.2.4 — stub the auth probe so it reports `auth_required: true`
    // (default; matches a token-required Hermes). This keeps the existing
    // tests focused on the token + retry path, while the auth-probe
    // behavior is covered separately in
    // `tests/contract/hermes-auth-probe.test.ts`.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, auth_required: true }),
      }),
    );
    // Default: a token is available via env (matches a correctly-configured deploy).
    process.env.HERMES_DASHBOARD_SESSION_TOKEN = 'test-secret';
    resolveTokenMock.mockReset();
    resolveTokenMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  });

  it('connect opens a WebSocket to /api/ws and appends ?token=', async () => {
    const client = new HermesSessionClient({ url: 'ws://localhost:9119/api/ws', token: 'explicit-secret' });
    const connectPromise = client.connect();
    // 4 microtask flushes: probeAuthRequired (fetch + .json) →
    // resolveToken (callerToken path) → tryOnce → new WebSocket.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=explicit-secret');
  });

  it('reads the token from HERMES_DASHBOARD_SESSION_TOKEN env when none passed', async () => {
    process.env.HERMES_DASHBOARD_SESSION_TOKEN = 'env-secret';
    const client = new HermesSessionClient();
    const { ws } = await beginConnect(client);
    ws.emitOpen();
    await Promise.resolve();
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=env-secret');
    // The resolver should NOT be called when env is set.
    expect(resolveTokenMock).not.toHaveBeenCalled();
  });

  it('explicit token option wins over the env var', async () => {
    process.env.HERMES_DASHBOARD_SESSION_TOKEN = 'env-secret';
    const client = new HermesSessionClient({ token: 'option-secret' });
    const { ws } = await beginConnect(client);
    ws.emitOpen();
    await Promise.resolve();
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=option-secret');
    expect(resolveTokenMock).not.toHaveBeenCalled();
  });

  it('fails explicitly when no token is available', async () => {
    // ADR-064 — the diagnostic contract is fixed: the operator must see
    // the exact "Hermes Session Runtime unavailable at <url>. AgentFabric
    // requires 'hermes serve' for the configured session adapter." text.
    // The previous "Missing Hermes dashboard session token" wording was
    // ambiguous because it conflated "no token" with "runtime down".
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
    resolveTokenMock.mockResolvedValue(undefined);
    const client = new HermesSessionClient();
    await expect(client.connect()).rejects.toThrow(
      /Hermes Session Runtime unavailable at ws:\/\/localhost:9119\/api\/ws\./,
    );
    await expect(client.connect().catch((e: Error) => e.message)).resolves.toMatch(
      /AgentFabric requires 'hermes serve' for the configured session adapter\./,
    );
  });

  it('rejects connect() when the server rejects the credential (onerror)', async () => {
    // ADR-064 — even on a connect-after-token failure, the operator
    // must see the user-required prefix "Hermes Session Runtime
    // unavailable at <url>...". The inner cause (handshake rejected)
    // is preserved in the message body.
    const client = new HermesSessionClient({ token: 'wrong-secret' });
    const { ws, connectPromise } = await beginConnect(client);
    ws.emitError('WebSocket handshake rejected');
    // Wait for the retry path to construct a second WebSocket.
    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
    });
    const second = MockWebSocket.instances[1]!;
    second.emitError('WebSocket handshake rejected (retry)');
    await expect(connectPromise).rejects.toThrow(/Hermes Session Runtime unavailable at/);
    await expect(connectPromise.catch((e: Error) => e.message)).resolves.toMatch(
      /WebSocket upgrade failed after token accepted/,
    );
    // The WS URL is the same for both attempts because the token is the same.
    expect(MockWebSocket.instances[0]!.url).toBe('ws://localhost:9119/api/ws?token=wrong-secret');
    expect(MockWebSocket.instances[1]!.url).toBe('ws://localhost:9119/api/ws?token=wrong-secret');
  });

  it('createSession sends a valid session.create JSON-RPC frame', async () => {
    const client = new HermesSessionClient();
    const { ws } = await beginConnect(client);
    ws.emitOpen();
    await Promise.resolve();

    const createPromise = client.createSession({ cwd: '/tmp/fabric-ws', profile: 'jd' });
    const frame = JSON.parse(ws.sent[0]!);
    expect(frame.jsonrpc).toBe('2.0');
    expect(frame.method).toBe('session.create');
    expect(frame.params.cwd).toBe('/tmp/fabric-ws');
    expect(frame.params.profile).toBe('jd');
    expect(typeof frame.id).toBe('number');

    // Respond with session_id.
    ws.emitMessage({ jsonrpc: '2.0', id: frame.id, result: { session_id: 'abc12345' } });
    const result = await createPromise;
    expect(result.sessionId).toBe('abc12345');
  });

  it('submitPrompt sends a valid prompt.submit frame', async () => {
    const client = new HermesSessionClient();
    const { ws } = await beginConnect(client);
    ws.emitOpen();
    await Promise.resolve();

    const submitPromise = client.submitPrompt('abc12345', '流量为什么下降？');
    const frame = JSON.parse(ws.sent[0]!);
    expect(frame.method).toBe('prompt.submit');
    expect(frame.params.session_id).toBe('abc12345');
    expect(frame.params.text).toBe('流量为什么下降？');

    ws.emitMessage({ jsonrpc: '2.0', id: frame.id, result: {} });
    await submitPromise;
  });

  it('dispatches streamed events to onEvent handlers', async () => {
    const client = new HermesSessionClient();
    const { ws } = await beginConnect(client);
    ws.emitOpen();
    await Promise.resolve();

    const events: HermesEvent[] = [];
    client.onEvent((e) => events.push(e));

    ws.emitMessage({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', payload: { text: '流量' }, session_id: 'abc12345' } });
    ws.emitMessage({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', payload: { text: '流量下降' }, session_id: 'abc12345' } });

    expect(events.map((e) => e.type)).toEqual(['message.delta', 'message.complete']);
  });

  it('rejects createSession when server returns an error', async () => {
    const client = new HermesSessionClient();
    const { ws } = await beginConnect(client);
    ws.emitOpen();
    await Promise.resolve();

    const createPromise = client.createSession({ cwd: '/tmp' });
    const frame = JSON.parse(ws.sent[0]!);
    ws.emitMessage({ jsonrpc: '2.0', id: frame.id, error: { code: 1, message: 'profile not found' } });
    await expect(createPromise).rejects.toThrow(/Hermes error/);
  });
});

// Separate describe block to test the auto-discovery path. P0010.2: resolution
// is now lazy, so we just mock the resolver and call connect() — no
// vi.resetModules / vi.doMock dance required.
describe('HermesSessionClient — auto-discovered token', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    resolveTokenMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  });

  it('uses the auto-discovered token when env is unset', async () => {
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
    resolveTokenMock.mockResolvedValue('discovered-secret');
    const client = new HermesSessionClient();
    // beginConnect: after 2 microtask flushes, tryOnce has run.
    const { ws } = await beginConnect(client);
    expect(resolveTokenMock).toHaveBeenCalledTimes(1);
    ws.emitOpen();
    await Promise.resolve();
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=discovered-secret');
  });

  it('explicit token option still wins over the auto-discovered value', async () => {
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
    resolveTokenMock.mockResolvedValue('discovered-secret');
    const client = new HermesSessionClient({ token: 'option-wins' });
    const { ws } = await beginConnect(client);
    // Resolver should not be touched because callerToken is set.
    expect(resolveTokenMock).not.toHaveBeenCalled();
    ws.emitOpen();
    await Promise.resolve();
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=option-wins');
  });
});
