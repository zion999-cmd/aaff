// P0010.2.4 (ADR-060) + P0010.2.4 review repair (ADR-061) —
// Token-resolver tests.
//
// Pinned contract (post-review-repair):
//   1. The ONLY env var that maps to Hermes' `_SESSION_TOKEN` is
//      `HERMES_DASHBOARD_SESSION_TOKEN` (Hermes 0.20.5
//      `web_server.py:540`). `HERMES_GATEWAY_TOKEN` was previously
//      accepted as a fallback; that was WRONG — it is the credential for
//      Hermes' separate HTTP gateway service, not the WS session token.
//      Sending it on `/api/ws` would 403, and the error would look like
//      "wrong token" instead of the real "Hermes generated an in-memory
//      random token we can't read" cause. ADR-061 removed the gateway
//      path entirely.
//   2. `resolveHermesSessionTokenWithSource` returns the source so the
//      session-client's structured `HermesConnectInfo` log can be emitted
//      without leaking the token value.
//   3. The auto-discovery cache stores the source so a cache hit returns
//      the real source (not a hardcoded `auto-dashboard`).
//
// These tests build on the existing `tests/unit/hermes/token-resolver.test.ts`
// infrastructure (mocks for child_process and fs/promises) and cover the
// new WithSource path + the cache-source-honesty contract.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const { execFileMock, readFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  readFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
}));

import {
  resolveHermesSessionToken,
  resolveHermesSessionTokenWithSource,
  resetTokenCache,
  ENV_TOKEN_NAMES,
} from '#platform/runtime/hermes/token-resolver.js';

const ENV_DASHBOARD = ENV_TOKEN_NAMES.dashboard;

interface ExecFileArgs {
  file: unknown;
  args?: unknown;
  options?: unknown;
  cb: (err: Error | null, stdout?: string, stderr?: string) => void;
}

function setExecResponse(
  matcher: (call: ExecFileArgs) => boolean,
  response: { stdout?: string; error?: Error },
): void {
  execFileMock.mockImplementationOnce((file: unknown, args: unknown, options: unknown, cb: ExecFileArgs['cb']) => {
    const call: ExecFileArgs = { file, args, options, cb };
    if (!matcher(call)) {
      cb(new Error(`execFile mock: no matcher matched file=${String(file)} args=${JSON.stringify(args)}`));
      return;
    }
    if (response.error) cb(response.error);
    else cb(null, { stdout: response.stdout ?? '', stderr: '' });
  });
}

function mockLsofPid(pid: string): void {
  setExecResponse((c) => c.file === 'lsof', { stdout: pid });
}

function mockDarwinPsEnv(env: Record<string, string>): void {
  const tail = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
  const output =
    `  PID   TT  STAT      TIME COMMAND\n  123   ??  S      0:01.23 /usr/bin/python hermes serve --port 9119 ${tail}\n`;
  setExecResponse((c) => c.file === 'ps', { stdout: output });
}

function mockLinuxProcEnv(env: Record<string, string>): void {
  const text = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
  readFileMock.mockResolvedValueOnce(Buffer.from(text, 'utf8'));
}

describe('P0010.2.4 — HERMES_DASHBOARD_SESSION_TOKEN is the single canonical env var', () => {
  let originalDashboard: string | undefined;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    execFileMock.mockReset();
    readFileMock.mockReset();
    originalDashboard = process.env[ENV_DASHBOARD];
    delete process.env[ENV_DASHBOARD];
    originalPlatform = process.platform;
    resetTokenCache();
  });

  afterEach(() => {
    if (originalDashboard === undefined) delete process.env[ENV_DASHBOARD];
    else process.env[ENV_DASHBOARD] = originalDashboard;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('returns the dashboard env var when set', async () => {
    process.env[ENV_DASHBOARD] = 'dashboard-secret';
    const result = await resolveHermesSessionToken();
    expect(result).toBe('dashboard-secret');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('does NOT accept HERMES_GATEWAY_TOKEN as a session token (regression)', async () => {
    // Set only HERMES_GATEWAY_TOKEN (the HTTP gateway credential) and
    // confirm resolveHermesSessionToken does NOT pick it up.
    process.env.HERMES_GATEWAY_TOKEN = 'gateway-secret';
    // Make sure no serve is discoverable on 9119.
    setExecResponse((c) => c.file === 'lsof', { stdout: '' });
    const result = await resolveHermesSessionToken();
    expect(result).toBeUndefined();
    delete process.env.HERMES_GATEWAY_TOKEN;
  });

  it('auto-discovers HERMES_DASHBOARD_SESSION_TOKEN from running serve on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({
      [ENV_DASHBOARD]: 'serve-dashboard',
      PATH: '/usr/bin:/bin',
    });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('serve-dashboard');
  });

  it('does NOT auto-discover HERMES_GATEWAY_TOKEN from serve env (regression)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({
      HERMES_GATEWAY_TOKEN: 'serve-gateway',
      PATH: '/usr/bin:/bin',
    });
    // No dashboard token in serve env — resolver should NOT pick the
    // gateway value.
    const result = await resolveHermesSessionToken();
    expect(result).toBeUndefined();
  });

  it('auto-discovers HERMES_DASHBOARD_SESSION_TOKEN from /proc on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockLsofPid('4242');
    mockLinuxProcEnv({
      [ENV_DASHBOARD]: 'proc-dashboard',
      HOME: '/root',
    });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('proc-dashboard');
  });

  it('does NOT auto-discover HERMES_GATEWAY_TOKEN from /proc (regression)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockLsofPid('4242');
    mockLinuxProcEnv({
      HERMES_GATEWAY_TOKEN: 'proc-gateway',
      HOME: '/root',
    });
    const result = await resolveHermesSessionToken();
    expect(result).toBeUndefined();
  });
});

describe('P0010.2.4 review repair (ADR-061) — resolveHermesSessionTokenWithSource', () => {
  let originalDashboard: string | undefined;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    execFileMock.mockReset();
    readFileMock.mockReset();
    originalDashboard = process.env[ENV_DASHBOARD];
    delete process.env[ENV_DASHBOARD];
    originalPlatform = process.platform;
    resetTokenCache();
  });

  afterEach(() => {
    if (originalDashboard === undefined) delete process.env[ENV_DASHBOARD];
    else process.env[ENV_DASHBOARD] = originalDashboard;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('returns source=env-dashboard when HERMES_DASHBOARD_SESSION_TOKEN is set', async () => {
    process.env[ENV_DASHBOARD] = 'a';
    const r = await resolveHermesSessionTokenWithSource();
    expect(r).toEqual({ token: 'a', source: 'env-dashboard' });
  });

  it('returns source=auto-dashboard when auto-discovery finds HERMES_DASHBOARD_SESSION_TOKEN', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_DASHBOARD]: 'c' });
    const r = await resolveHermesSessionTokenWithSource();
    expect(r).toEqual({ token: 'c', source: 'auto-dashboard' });
  });

  it('returns token=undefined, source=null when nothing is found', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    setExecResponse((c) => c.file === 'lsof', { stdout: '' });
    const r = await resolveHermesSessionTokenWithSource();
    expect(r.token).toBeUndefined();
    expect(r.source).toBeNull();
  });

  it('cache hit preserves the real auto-dashboard source (regression: no longer hardcoded)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_DASHBOARD]: 'cached' });
    const first = await resolveHermesSessionTokenWithSource();
    expect(first.source).toBe('auto-dashboard');
    // Second call should not re-shell-out AND should return the real
    // cached source (not a hardcoded `auto-dashboard`). This was the
    // P0010.2.4 review bug: the previous cache only stored the token,
    // not the source, so the structured log lied on every cache hit.
    const second = await resolveHermesSessionTokenWithSource();
    expect(second).toEqual({ token: 'cached', source: 'auto-dashboard' });
    expect(execFileMock).toHaveBeenCalledTimes(2); // lsof + ps on the first call only
  });

  it('cached source survives a forceRefresh: false second call', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_DASHBOARD]: 'cached-once' });
    const a = await resolveHermesSessionTokenWithSource();
    expect(a).toEqual({ token: 'cached-once', source: 'auto-dashboard' });
    const b = await resolveHermesSessionTokenWithSource({ forceRefresh: false });
    expect(b).toEqual({ token: 'cached-once', source: 'auto-dashboard' });
  });
});

describe('P0010.2.4 review repair (ADR-061) — ENV_TOKEN_NAMES only exposes dashboard', () => {
  it('exposes HERMES_DASHBOARD_SESSION_TOKEN as the only env var name', () => {
    expect(ENV_TOKEN_NAMES.dashboard).toBe('HERMES_DASHBOARD_SESSION_TOKEN');
    // The `gateway` key was removed in ADR-061.
    expect(Object.keys(ENV_TOKEN_NAMES)).toEqual(['dashboard']);
  });
});
