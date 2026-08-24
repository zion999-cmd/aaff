// Token-resolver unit tests. Mock node:child_process.execFile and
// node:fs/promises.readFile so subprocess calls are hermetic. Cross-platform
// behavior is exercised by overriding `process.platform` per test.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Hoisted mocks — vi.mock is hoisted above the resolver import, so
// `promisify(execFile)` inside the resolver captures these mocks. The
// variables themselves must be hoisted via `vi.hoisted` so the factory
// closures can reference them.
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

// Imports below rely on the mocks above being in place.
import { resolveHermesSessionToken, resetTokenCache } from '#platform/runtime/hermes/token-resolver.js';

const ENV_KEY = 'HERMES_DASHBOARD_SESSION_TOKEN';

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
      // No matcher matched — surface an error to keep the test loud.
      const err = new Error(
        `execFile mock: no matcher matched file=${String(file)} args=${JSON.stringify(args)}`,
      );
      cb(err);
      return;
    }
    if (response.error) {
      cb(response.error);
    } else {
      // Real `child_process.execFile` has `util.promisify.custom` so the
      // promisified wrapper resolves with `{ stdout, stderr }`. The mock
      // doesn't carry that symbol, so we simulate it by calling the callback
      // with a single `{ stdout, stderr }` object as the first value arg.
      // The standard promisify will then resolve with that object.
      cb(null, { stdout: response.stdout ?? '', stderr: '' });
    }
  });
}

function mockLsofPid(pid: string): void {
  setExecResponse(
    (c) => c.file === 'lsof',
    { stdout: pid },
  );
}

function mockLsofMissing(): void {
  setExecResponse(
    (c) => c.file === 'lsof',
    { stdout: '' },
  );
}

function mockLsofError(): void {
  setExecResponse(
    (c) => c.file === 'lsof',
    { error: new Error('lsof not found') },
  );
}

function mockDarwinPsEnv(env: Record<string, string>): void {
  const tail = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const output = `  PID   TT  STAT      TIME COMMAND\n  123   ??  S      0:01.23 /usr/bin/python /Users/bx/.hermes/hermes-agent/venv/bin/python hermes serve --port 9119 --skip-build ${tail}\n`;
  setExecResponse(
    (c) => c.file === 'ps',
    { stdout: output },
  );
}

function mockDarwinPsError(): void {
  setExecResponse(
    (c) => c.file === 'ps',
    { error: new Error('ps failed') },
  );
}

function mockLinuxProcEnv(env: Record<string, string>): void {
  const text = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\0') + '\0';
  readFileMock.mockResolvedValueOnce(Buffer.from(text, 'utf8'));
}

function mockLinuxProcError(): void {
  readFileMock.mockRejectedValueOnce(new Error('EACCES: permission denied'));
}

describe('resolveHermesSessionToken', () => {
  let originalEnv: string | undefined;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    execFileMock.mockReset();
    readFileMock.mockReset();
    originalEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    originalPlatform = process.platform;
    resetTokenCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('returns the env var when set, without calling lsof', async () => {
    process.env[ENV_KEY] = 'env-secret';
    const result = await resolveHermesSessionToken();
    expect(result).toBe('env-secret');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('env var wins over a running serve on the same port (macOS)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env[ENV_KEY] = 'env-secret';
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_KEY]: 'serve-secret' });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('env-secret');
  });

  it('auto-discovers the token from a running serve on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_KEY]: 'serve-secret', PATH: '/usr/bin:/bin' });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('serve-secret');
  });

  it('auto-discovers the token from /proc on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockLsofPid('4242');
    mockLinuxProcEnv({ [ENV_KEY]: 'proc-secret', HOME: '/root' });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('proc-secret');
    // `ps` is macOS-only — on Linux only `lsof` (for the PID) and `readFile`
    // (for /proc/<pid>/environ) should fire.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[0]).toBe('lsof');
  });

  it('returns undefined when lsof finds no listener', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofMissing();
    const result = await resolveHermesSessionToken();
    expect(result).toBeUndefined();
  });

  it('returns undefined when lsof throws (tool not installed)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofError();
    const result = await resolveHermesSessionToken();
    expect(result).toBeUndefined();
  });

  it('returns undefined when ps throws on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('1234');
    mockDarwinPsError();
    const result = await resolveHermesSessionToken();
    expect(result).toBeUndefined();
  });

  it('returns undefined when /proc read fails on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mockLsofPid('1234');
    mockLinuxProcError();
    const result = await resolveHermesSessionToken();
    expect(result).toBeUndefined();
  });

  it('returns undefined when the serve env has no HERMES_DASHBOARD_SESSION_TOKEN', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('1234');
    mockDarwinPsEnv({ PATH: '/usr/bin', HOME: '/Users/bx' });
    const result = await resolveHermesSessionToken();
    expect(result).toBeUndefined();
  });

  it('caches the resolved token per port — second call does not re-shell-out', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_KEY]: 'cached-secret' });
    const first = await resolveHermesSessionToken();
    expect(first).toBe('cached-secret');
    expect(execFileMock).toHaveBeenCalledTimes(2); // lsof + ps

    // No additional mocks set up — a real second call would fail without mocks.
    const second = await resolveHermesSessionToken();
    expect(second).toBe('cached-secret');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('parses a non-default port from the URL option', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('9000');
    mockDarwinPsEnv({ [ENV_KEY]: 'port-9120-secret' });
    const result = await resolveHermesSessionToken({ url: 'ws://localhost:9120/api/ws' });
    expect(result).toBe('port-9120-secret');
  });

  it('treats empty env var as unset and falls through to discovery', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env[ENV_KEY] = '';
    mockLsofPid('79723');
    mockDarwinPsEnv({ [ENV_KEY]: 'serve-secret' });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('serve-secret');
  });

  it('resetTokenCache forces a re-resolution', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('111');
    mockDarwinPsEnv({ [ENV_KEY]: 'first' });
    const first = await resolveHermesSessionToken();
    expect(first).toBe('first');

    resetTokenCache();
    mockLsofPid('222');
    mockDarwinPsEnv({ [ENV_KEY]: 'second' });
    const second = await resolveHermesSessionToken();
    expect(second).toBe('second');
  });

  it('forceRefresh:true skips the per-port cache and re-shells-out', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('777');
    mockDarwinPsEnv({ [ENV_KEY]: 'cached-secret' });
    const first = await resolveHermesSessionToken();
    expect(first).toBe('cached-secret');
    expect(execFileMock).toHaveBeenCalledTimes(2);

    // Without forceRefresh the cache is used; no additional mocks would be needed.
    const second = await resolveHermesSessionToken();
    expect(second).toBe('cached-secret');
    expect(execFileMock).toHaveBeenCalledTimes(2);

    // With forceRefresh the resolver re-shells-out and overwrites the cache.
    mockLsofPid('888');
    mockDarwinPsEnv({ [ENV_KEY]: 'fresh-secret' });
    const third = await resolveHermesSessionToken({ forceRefresh: true });
    expect(third).toBe('fresh-secret');
    expect(execFileMock).toHaveBeenCalledTimes(4); // +lsof +ps for the refresh

    // Cache should now hold the refreshed value.
    const fourth = await resolveHermesSessionToken();
    expect(fourth).toBe('fresh-secret');
    expect(execFileMock).toHaveBeenCalledTimes(4); // no new shells
  });

  it('forceRefresh:true has no effect on the env-pinned branch', async () => {
    process.env[ENV_KEY] = 'env-secret';
    const result = await resolveHermesSessionToken({ forceRefresh: true });
    expect(result).toBe('env-secret');
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('parses Darwin ps env across multiple key=value tokens after the command path', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mockLsofPid('555');
    // Realistic tail: command path then env vars.
    const output =
      '  PID   TT  STAT      TIME COMMAND\n' +
      '  555   ??  S      0:01.23 /Users/bx/.hermes/hermes-agent/venv/bin/python ' +
      '/Users/bx/.hermes/hermes-agent/hermes serve --port 9119 ' +
      'ANTHROPIC_AUTH_TOKEN=ark-abc ' +
      `${ENV_KEY}=my-pin ` +
      'PATH=/usr/bin:/bin HOME=/Users/bx\n';
    setExecResponse((c) => c.file === 'ps', { stdout: output });
    const result = await resolveHermesSessionToken();
    expect(result).toBe('my-pin');
  });
});
