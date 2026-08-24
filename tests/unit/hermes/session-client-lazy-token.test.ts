// P0010.2 — HermesSessionClient connect-time retry-once tests (mock WebSocket).
// Validates the new lazy-resolve + retry-once behaviour: when the first
// handshake fails with an auto-discovered token, the client retries exactly
// once with a freshly re-resolved token. Operator-pinned tokens (callerToken /
// env-var) are NEVER auto-replaced.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const resolveTokenMock = vi.fn();
const resetCacheMock = vi.fn();

vi.mock('#platform/runtime/hermes/token-resolver.js', () => ({
  resolveHermesSessionToken: (...args: unknown[]) => (resolveTokenMock as (...a: unknown[]) => unknown)(...args),
  resetTokenCache: () => resetCacheMock(),
}));

import { HermesSessionClient } from '#platform/runtime/hermes/index.js';

// ---- Mock WebSocket ----

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(): void {
    /* unused */
  }
  close(): void {
    this.readyState = 3;
  }

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
}

interface ConnectHandle {
  ws: MockWebSocket;
  connectPromise: Promise<void>;
}

/** Start a connect() and yield to the microtask queue until the WebSocket
 *  has been constructed. Returns both the in-flight WS and the original
 *  promise so tests can await its resolution/rejection. */
async function beginConnect(client: HermesSessionClient): Promise<ConnectHandle> {
  const connectPromise = client.connect();
  // 2 microtask flushes: resolveToken() → tryOnce → new WebSocket.
  await Promise.resolve();
  await Promise.resolve();
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  return { ws, connectPromise };
}

/** Wait for the retry path to construct a second WebSocket after an
 *  emitError / emitCloseBeforeOpen. */
async function waitForRetry(): Promise<void> {
  // 3 microtask flushes: catch handler → resolveToken() → new WebSocket.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---- Tests ----

describe('HermesSessionClient — lazy token + retry-once (P0010.2)', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    resolveTokenMock.mockReset();
    resetCacheMock.mockReset();
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  });

  it('lazy-resolves the token on first connect (no module-load side effect)', async () => {
    resolveTokenMock.mockResolvedValue('lazy-secret');
    const client = new HermesSessionClient();
    // No connect attempted yet — resolver should not be touched.
    expect(resolveTokenMock).not.toHaveBeenCalled();
    const { ws, connectPromise } = await beginConnect(client);
    expect(resolveTokenMock).toHaveBeenCalledTimes(1);
    ws.emitOpen();
    await connectPromise;
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=lazy-secret');
  });

  it('retries exactly once with a fresh token when the first handshake fails (auto-discovered)', async () => {
    resolveTokenMock.mockResolvedValueOnce('stale-secret').mockResolvedValueOnce('fresh-secret');
    const client = new HermesSessionClient();

    const { ws: first, connectPromise } = await beginConnect(client);
    first.emitError('handshake rejected for stale-secret');
    await waitForRetry();
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = MockWebSocket.instances[1]!;
    second.emitOpen();
    await connectPromise;

    expect(resolveTokenMock).toHaveBeenCalledTimes(2);
    expect(resetCacheMock).toHaveBeenCalledTimes(1);
    expect(first.url).toBe('ws://localhost:9119/api/ws?token=stale-secret');
    expect(second.url).toBe('ws://localhost:9119/api/ws?token=fresh-secret');
  });

  it('throws an actionable error when the first AND second attempts both fail', async () => {
    resolveTokenMock.mockResolvedValue('any-token');
    const client = new HermesSessionClient();

    const { ws: first, connectPromise } = await beginConnect(client);
    first.emitError('first attempt failed');
    await waitForRetry();
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = MockWebSocket.instances[1]!;
    second.emitError('second attempt failed');
    await expect(connectPromise).rejects.toThrow(/Hermes connect failed twice/);
    await expect(connectPromise).rejects.toThrow(/first attempt failed/);
    await expect(connectPromise).rejects.toThrow(/second attempt failed/);
    await expect(connectPromise).rejects.toThrow(/Verify 'hermes serve' is up/);
  });

  it('does NOT reset the cache when the failing token was operator-pinned (env-var)', async () => {
    process.env.HERMES_DASHBOARD_SESSION_TOKEN = 'pinned-secret';
    const client = new HermesSessionClient();

    const { ws: first, connectPromise } = await beginConnect(client);
    // Resolver must NOT be called because env-var wins.
    expect(resolveTokenMock).not.toHaveBeenCalled();
    first.emitError('handshake rejected for pinned-secret');
    await waitForRetry();
    const second = MockWebSocket.instances[1]!;
    second.emitError('handshake rejected (retry)');
    await expect(connectPromise).rejects.toThrow(/Hermes connect failed twice/);
    expect(resetCacheMock).not.toHaveBeenCalled();
    expect(first.url).toBe('ws://localhost:9119/api/ws?token=pinned-secret');
    expect(second.url).toBe('ws://localhost:9119/api/ws?token=pinned-secret');
  });

  it('does NOT reset the cache when the failing token was supplied via options.token', async () => {
    const client = new HermesSessionClient({ token: 'option-pinned' });

    const { ws: first, connectPromise } = await beginConnect(client);
    expect(resolveTokenMock).not.toHaveBeenCalled();
    first.emitError('handshake rejected for option-pinned');
    await waitForRetry();
    const second = MockWebSocket.instances[1]!;
    second.emitError('handshake rejected (retry)');
    await expect(connectPromise).rejects.toThrow(/Hermes connect failed twice/);
    expect(resetCacheMock).not.toHaveBeenCalled();
    expect(first.url).toBe('ws://localhost:9119/api/ws?token=option-pinned');
    expect(second.url).toBe('ws://localhost:9119/api/ws?token=option-pinned');
  });

  it('throws an actionable error when the second re-resolve returns no token', async () => {
    resolveTokenMock.mockResolvedValueOnce('stale-secret').mockResolvedValueOnce(undefined);
    const client = new HermesSessionClient();

    const { ws: first, connectPromise } = await beginConnect(client);
    first.emitError('stale rejected');
    await expect(connectPromise).rejects.toThrow(/auto-re-resolve also returned no token/);
    await expect(connectPromise).rejects.toThrow(/If HERMES_DASHBOARD_SESSION_TOKEN is set/);
    // No second WebSocket is constructed when the retry path cannot get a token.
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('honours connectTimeoutMs (no in-flight timer leak)', async () => {
    resolveTokenMock.mockResolvedValue('will-timeout');
    const client = new HermesSessionClient({ connectTimeoutMs: 25 });
    const { ws: first, connectPromise } = await beginConnect(client);
    // First handshake times out.
    await new Promise((r) => setTimeout(r, 40));
    // After the timeout, the retry path runs.
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = MockWebSocket.instances[1]!;
    second.emitError('retry also failed');
    await expect(connectPromise).rejects.toThrow(/Hermes connect failed twice/);
    expect(first.url).toBe('ws://localhost:9119/api/ws?token=will-timeout');
  });

  it('close() before connect() does not affect the next connect()', async () => {
    resolveTokenMock.mockResolvedValue('token-x');
    const client = new HermesSessionClient();
    client.close();
    const { ws: first, connectPromise } = await beginConnect(client);
    // close() is a no-op for a future connect(); the WS is created normally.
    first.emitError('failed');
    await vi.waitFor(() => {
      expect(MockWebSocket.instances).toHaveLength(2);
    });
    const second = MockWebSocket.instances[1]!;
    second.emitOpen();
    await connectPromise;
    expect(first.url).toBe('ws://localhost:9119/api/ws?token=token-x');
    expect(second.url).toBe('ws://localhost:9119/api/ws?token=token-x');
  });
});
