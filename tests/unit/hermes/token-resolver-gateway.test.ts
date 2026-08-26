// P0010.2.4 (ADR-060) — Token-resolver extensions:
//   1. `HERMES_GATEWAY_TOKEN` env var is now accepted as a canonical fallback
//      (Hermes 0.20.x exports this name, not `HERMES_DASHBOARD_SESSION_TOKEN`).
//   2. `resolveHermesSessionTokenWithSource` returns the source of the token
//      so the session-client's structured `HermesConnectInfo` log can be
//      emitted without leaking the token value.
//
// These tests build on the existing `tests/unit/hermes/token-resolver.test.ts`
// infrastructure (mocks for child_process and fs/promises) and only add the
// new env-var paths and the WithSource assertions.

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
const ENV_GATEWAY = ENV_TOKEN_NAMES.gateway;

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

describe('P0010.2.4 — HERMES_GATEWAY_TOKEN env-var fallback', () => {
  let originalDashboard: string | undefined;
  let originalGateway: string | undefined;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    execFileMock.mockReset();
    readFileMock.mockReset();
    originalDashboard = process.env[ENV_DASHBOARD];
    originalGateway = process.env[ENV_GATEWAY];
    delete process.env[ENV_DASHBOARD];
    delete process.env[ENV_GATEWAY];
    originalPlatform = process.platform;
    resetTokenCache();
  });

  afterEach(() => {
    if (originalDashboard === undefined) delete process.env[ENV_DASHBOARD];
    else process.env[ENV_DASHBOARD] = originalDashboard;
    if (originalGateway === undefined) delete process.env[ENV_GATEWAY];
    else process.env[ENV_GATEWAY] = originalGateway;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('HERMES_GATEWAY_TOKEN is accepted when HERMES_DASHBOARD_SESSION_TOKEN is unset', async () => {
    process.env[ENV_GATEWAY] = 'gateway-secret';
    const result = await resolveHermesSessionToken();
    expect(result).toBe('gateway-secret');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('HERMES_DASHBOARD_SESSION_TOKEN still wins when both are set (priority preserved)', async () => {
    process.env[ENV_DASHBOARD] = 'dashboard-secret';
    process.env[ENV_GATEWAY] = 'gateway-secret';
    const result = await resolveHermesSessionToken();
    expect(result).toBe('dashboard-secret');
  });

  it('empty HERMES_GATEWAY_TOKEN falls through to auto-discovery', async () => {
    process.env[ENV_GATEWAY] = '';
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_DASHBOARD]: 'serve-dashboard' });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('serve-dashboard');
  });

  it('auto-discovers HERMES_GATEWAY_TOKEN from running serve on macOS when dashboard is missing', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({
      [ENV_GATEWAY]: 'serve-gateway',
      PATH: '/usr/bin:/bin',
    });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('serve-gateway');
  });

  it('prefers HERMES_DASHBOARD_SESSION_TOKEN over HERMES_GATEWAY_TOKEN in serve env (back-compat)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({
      [ENV_DASHBOARD]: 'serve-dashboard',
      [ENV_GATEWAY]: 'serve-gateway',
    });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('serve-dashboard');
  });

  it('auto-discovers HERMES_GATEWAY_TOKEN from /proc on Linux when dashboard is missing', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockLsofPid('4242');
    mockLinuxProcEnv({
      [ENV_GATEWAY]: 'proc-gateway',
      HOME: '/root',
    });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('proc-gateway');
  });
});

describe('P0010.2.4 — resolveHermesSessionTokenWithSource', () => {
  let originalDashboard: string | undefined;
  let originalGateway: string | undefined;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    execFileMock.mockReset();
    readFileMock.mockReset();
    originalDashboard = process.env[ENV_DASHBOARD];
    originalGateway = process.env[ENV_GATEWAY];
    delete process.env[ENV_DASHBOARD];
    delete process.env[ENV_GATEWAY];
    originalPlatform = process.platform;
    resetTokenCache();
  });

  afterEach(() => {
    if (originalDashboard === undefined) delete process.env[ENV_DASHBOARD];
    else process.env[ENV_DASHBOARD] = originalDashboard;
    if (originalGateway === undefined) delete process.env[ENV_GATEWAY];
    else process.env[ENV_GATEWAY] = originalGateway;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('returns source=env-dashboard when HERMES_DASHBOARD_SESSION_TOKEN is set', async () => {
    process.env[ENV_DASHBOARD] = 'a';
    const r = await resolveHermesSessionTokenWithSource();
    expect(r).toEqual({ token: 'a', source: 'env-dashboard' });
  });

  it('returns source=env-gateway when only HERMES_GATEWAY_TOKEN is set', async () => {
    process.env[ENV_GATEWAY] = 'b';
    const r = await resolveHermesSessionTokenWithSource();
    expect(r).toEqual({ token: 'b', source: 'env-gateway' });
  });

  it('returns source=auto-dashboard when auto-discovery finds HERMES_DASHBOARD_SESSION_TOKEN', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_DASHBOARD]: 'c' });
    const r = await resolveHermesSessionTokenWithSource();
    expect(r).toEqual({ token: 'c', source: 'auto-dashboard' });
  });

  it('returns source=auto-gateway when auto-discovery finds only HERMES_GATEWAY_TOKEN', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_GATEWAY]: 'd' });
    const r = await resolveHermesSessionTokenWithSource();
    expect(r).toEqual({ token: 'd', source: 'auto-gateway' });
  });

  it('returns token=undefined, source=null when nothing is found', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    setExecResponse((c) => c.file === 'lsof', { stdout: '' });
    const r = await resolveHermesSessionTokenWithSource();
    expect(r.token).toBeUndefined();
    expect(r.source).toBeNull();
  });

  it('cached auto-discovery uses source=auto-dashboard on cache hit', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_DASHBOARD]: 'cached' });
    const first = await resolveHermesSessionTokenWithSource();
    expect(first.source).toBe('auto-dashboard');
    // Second call should not re-shell-out.
    const second = await resolveHermesSessionTokenWithSource();
    expect(second).toEqual({ token: 'cached', source: 'auto-dashboard' });
    expect(execFileMock).toHaveBeenCalledTimes(2); // lsof + ps on the first call only
  });

  it('returns the value via the legacy `resolveHermesSessionToken` (string only) for back-compat', async () => {
    process.env[ENV_GATEWAY] = 'legacy-string';
    const r = await resolveHermesSessionToken();
    expect(r).toBe('legacy-string');
  });
});

describe('P0010.2.4 — ENV_TOKEN_NAMES export', () => {
  it('exposes the two canonical env var names', () => {
    expect(ENV_TOKEN_NAMES.dashboard).toBe('HERMES_DASHBOARD_SESSION_TOKEN');
    expect(ENV_TOKEN_NAMES.gateway).toBe('HERMES_GATEWAY_TOKEN');
  });
});
