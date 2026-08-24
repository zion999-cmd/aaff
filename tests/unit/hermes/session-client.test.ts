// P0008.3 — HermesSessionClient tests (mock WebSocket).
// Validates JSON-RPC framing: session.create / prompt.submit / event dispatch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock for the resolver so tests are deterministic regardless of whether
// a real `hermes serve` is listening on 9119 in the test environment. The
// resolver is also called eagerly at module-load — without this mock the cached
// `resolvedToken` snapshot inside session-client.ts could pick up a live token
// in some dev setups and silently break the "no token" test below.
vi.mock('#platform/runtime/hermes/token-resolver.js', () => ({
  resolveHermesSessionToken: () => Promise.resolve(undefined),
  _resetTokenCache: () => undefined,
}));

import { HermesSessionClient } from '#platform/runtime/hermes/index.js';
import type { HermesEvent } from '#platform/runtime/hermes/index.js';

// ---- Mock WebSocket ----

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  sent: string[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

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
  emitOpen(): void { this.readyState = 1; this.onopen?.(); }
  emitMessage(obj: unknown): void {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
}

// ---- Tests ----

describe('HermesSessionClient', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    // Default: a token is available via env (matches a correctly-configured deploy).
    process.env.HERMES_DASHBOARD_SESSION_TOKEN = 'test-secret';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  });

  it('connect opens a WebSocket to /api/ws and appends ?token=', async () => {
    const client = new HermesSessionClient({ url: 'ws://localhost:9119/api/ws', token: 'explicit-secret' });
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=explicit-secret');
  });

  it('reads the token from HERMES_DASHBOARD_SESSION_TOKEN env when none passed', async () => {
    process.env.HERMES_DASHBOARD_SESSION_TOKEN = 'env-secret';
    const client = new HermesSessionClient();
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=env-secret');
  });

  it('explicit token option wins over the env var', async () => {
    process.env.HERMES_DASHBOARD_SESSION_TOKEN = 'env-secret';
    const client = new HermesSessionClient({ token: 'option-secret' });
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=option-secret');
  });

  it('fails explicitly when no token is available', async () => {
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
    const client = new HermesSessionClient();
    await expect(client.connect()).rejects.toThrow(/Missing Hermes dashboard session token/);
  });

  it('rejects connect() when the server rejects the credential (onerror)', async () => {
    const client = new HermesSessionClient({ token: 'wrong-secret' });
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.onerror?.(new Error('WebSocket handshake rejected'));
    await expect(connectPromise).rejects.toThrow(/WebSocket error/);
  });

  it('createSession sends a valid session.create JSON-RPC frame', async () => {
    const client = new HermesSessionClient();
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;

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
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;

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
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;

    const events: HermesEvent[] = [];
    client.onEvent((e) => events.push(e));

    ws.emitMessage({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', payload: { text: '流量' }, session_id: 'abc12345' } });
    ws.emitMessage({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', payload: { text: '流量下降' }, session_id: 'abc12345' } });

    expect(events.map((e) => e.type)).toEqual(['message.delta', 'message.complete']);
  });

  it('rejects createSession when server returns an error', async () => {
    const client = new HermesSessionClient();
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;

    const createPromise = client.createSession({ cwd: '/tmp' });
    const frame = JSON.parse(ws.sent[0]!);
    ws.emitMessage({ jsonrpc: '2.0', id: frame.id, error: { code: 1, message: 'profile not found' } });
    await expect(createPromise).rejects.toThrow(/Hermes error/);
  });
});

// Separate describe block to test the auto-discovery path. We must reset
// modules and re-mock the resolver (vi.doMock) so a fresh session-client
// module instance picks up the auto-discovered token via the eager
// `resolvedToken` snapshot.
describe('HermesSessionClient — auto-discovered token', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  });

  it('uses the auto-discovered token when env is unset', async () => {
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
    vi.resetModules();
    vi.doMock('#platform/runtime/hermes/token-resolver.js', () => ({
      resolveHermesSessionToken: () => Promise.resolve('discovered-secret'),
      _resetTokenCache: () => undefined,
    }));
    const { HermesSessionClient: Fresh } = await import('#platform/runtime/hermes/index.js');
    // Yield to the microtask queue so the eager resolver promise resolves
    // before the constructor reads `resolvedToken`.
    await Promise.resolve();
    const client = new Fresh();
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=discovered-secret');
  });

  it('explicit token option still wins over the auto-discovered value', async () => {
    delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
    vi.resetModules();
    vi.doMock('#platform/runtime/hermes/token-resolver.js', () => ({
      resolveHermesSessionToken: () => Promise.resolve('discovered-secret'),
      _resetTokenCache: () => undefined,
    }));
    const { HermesSessionClient: Fresh } = await import('#platform/runtime/hermes/index.js');
    await Promise.resolve();
    const client = new Fresh({ token: 'option-wins' });
    const connectPromise = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.emitOpen();
    await connectPromise;
    expect(ws.url).toBe('ws://localhost:9119/api/ws?token=option-wins');
  });
});
