// token-resolver.ts — resolve the Hermes dashboard session token for the agentFabric
// `/api/ws` client.
//
// Resolution priority (highest first):
//   1. The `HERMES_DASHBOARD_SESSION_TOKEN` env var in the agentFabric process —
//      historical name; the agentFabric → `/api/ws` upgrade authenticates via
//      `?token=<value>`.
//   2. The `HERMES_GATEWAY_TOKEN` env var in the agentFabric process — the
//      canonical variable `hermes serve` exports to its subprocesses. This is
//      the variable that actually appears in `ps eww -p <hermes-serve-pid>`
//      in dev. P0010.2.4 (ADR-060) adds this fallback because
//      HERMES_DASHBOARD_SESSION_TOKEN was missing in dev even though
//      `hermes serve` was up and `auth_required:false`.
//      — operator-pinned, survives `hermes serve` restarts as long as the
//        operator re-exports before starting the serve.
//   3. Auto-discover from the running `hermes serve` process listening on
//      the port derived from the URL (default 9119). Reads the serve
//      process's env via `lsof` + `ps eww` (macOS) or `lsof` +
//      `/proc/<pid>/environ` (Linux). Auto-discovery checks
//      HERMES_DASHBOARD_SESSION_TOKEN first, then HERMES_GATEWAY_TOKEN.
//
// None of the paths throws. All subprocess failures fall through to
// `undefined` and the caller's existing "Missing token" error path
// applies — BUT the session client also runs an `/api/health` probe
// (see session-client.ts#probeAuthRequired); when the running Hermes
// reports `auth_required: false`, the token is bypassed entirely.
//
// IMPORTANT: This module must NEVER log the token value, never include it in
// error messages, and never propagate it across process boundaries (no HTTP
// response to the browser, no DB write, no shared file).

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ResolveOptions {
  /** URL of the form `ws://host:port/api/ws` — port is extracted for process lookup. */
  url?: string;
  /**
   * Force a fresh auto-discovery even if a cached entry exists for this port.
   * Used by the session client's connect-time retry-once path. Has no effect
   * on the env-var branch (env-pinned tokens are never cached by this module
   * and never auto-replaced — that's an operator-controlled decision).
   */
  forceRefresh?: boolean;
}

const SUBPROCESS_TIMEOUT_MS = 5_000;

/** Per-port cache so we only shell out once per agentFabric process lifetime. */
interface CacheEntry {
  port: number;
  token: string | undefined;
}
let cache: CacheEntry | null = null;

export const ENV_TOKEN_NAMES = {
  /** Historical name — used by the agentFabric `/api/ws` upgrade contract. */
  dashboard: 'HERMES_DASHBOARD_SESSION_TOKEN',
  /** Canonical name exported by `hermes serve` to its subprocesses. */
  gateway: 'HERMES_GATEWAY_TOKEN',
} as const;

/** Pick the first non-empty operator-pinned env var, in priority order. */
const resolveFromOperatorEnv = (): { token: string | undefined; source: 'env-dashboard' | 'env-gateway' | null } => {
  const fromDashboard = process.env[ENV_TOKEN_NAMES.dashboard];
  if (fromDashboard && fromDashboard.length > 0) {
    return { token: fromDashboard, source: 'env-dashboard' };
  }
  const fromGateway = process.env[ENV_TOKEN_NAMES.gateway];
  if (fromGateway && fromGateway.length > 0) {
    return { token: fromGateway, source: 'env-gateway' };
  }
  return { token: undefined, source: null };
};

export interface ResolveHermesTokenResult {
  /** The resolved token. `undefined` when no source returned a value. */
  token: string | undefined;
  /** Where the token came from. `null` when nothing was found. */
  source:
    | 'env-dashboard'
    | 'env-gateway'
    | 'auto-dashboard'
    | 'auto-gateway'
    | null;
}

/**
 * Resolve the Hermes dashboard session token. Returns `undefined` if no source
 * is available.
 *
 * Side effect: result is cached per port for the lifetime of the module.
 * Pass `forceRefresh: true` to skip the cache and re-shell-out; the freshly
 * discovered value is then written back to the cache.
 */
export async function resolveHermesSessionToken(
  options: ResolveOptions = {},
): Promise<string | undefined> {
  const port = parsePort(options.url) ?? 9119;

  // (1) Operator-pinned env vars win. Never cached, never auto-refreshed.
  const fromOperator = resolveFromOperatorEnv();
  if (fromOperator.token !== undefined) {
    return fromOperator.token;
  }

  // (2) Auto-discover from the running hermes serve.
  if (!options.forceRefresh && cache && cache.port === port) {
    return cache.token;
  }
  const discovered = await discoverFromRunningServe(port);
  cache = { port, token: discovered.token };
  return discovered.token;
}

/**
 * Like `resolveHermesSessionToken` but also returns the source of the token.
 * Used by the session client to surface a structured `HermesConnectInfo`
 * log entry (P0010.2.4 audit A). Operator-pinned tokens are never logged
 * (the source is logged, the value is not).
 */
export async function resolveHermesSessionTokenWithSource(
  options: ResolveOptions = {},
): Promise<ResolveHermesTokenResult> {
  const port = parsePort(options.url) ?? 9119;

  const fromOperator = resolveFromOperatorEnv();
  if (fromOperator.token !== undefined) {
    return { token: fromOperator.token, source: fromOperator.source };
  }

  if (!options.forceRefresh && cache && cache.port === port) {
    return { token: cache.token, source: cache.token ? 'auto-dashboard' : null };
  }
  const discovered = await discoverFromRunningServe(port);
  cache = { port, token: discovered.token };
  return { token: discovered.token, source: discovered.source };
}

/**
 * Clear the per-port cache so the next `resolveHermesSessionToken` call
 * re-discovers from the running serve. Exported (no leading underscore) so
 * the session-client's connect-time retry path can call it.
 *
 * This module is process-singleton. Tests that exercise cache behaviour
 * should call this in `beforeEach` and `afterEach`.
 */
export function resetTokenCache(): void {
  cache = null;
}

async function discoverFromRunningServe(
  port: number,
): Promise<{ token: string | undefined; source: 'auto-dashboard' | 'auto-gateway' | null }> {
  const pid = await findListenPid(port);
  if (!pid) return { token: undefined, source: null };
  const env = await readProcessEnv(pid);
  if (!env) return { token: undefined, source: null };
  // Try both names; prefer the historical (HERMES_DASHBOARD_SESSION_TOKEN)
  // so behavior on environments that already export it is unchanged.
  const dashboard = env[ENV_TOKEN_NAMES.dashboard];
  if (dashboard && dashboard.length > 0) {
    return { token: dashboard, source: 'auto-dashboard' };
  }
  const gateway = env[ENV_TOKEN_NAMES.gateway];
  if (gateway && gateway.length > 0) {
    return { token: gateway, source: 'auto-gateway' };
  }
  return { token: undefined, source: null };
}

async function findListenPid(port: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { timeout: SUBPROCESS_TIMEOUT_MS },
    );
    const first = stdout.trim().split(/\s+/)[0];
    if (!first) return undefined;
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function readProcessEnv(pid: number): Promise<Record<string, string> | undefined> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pid)], {
        timeout: SUBPROCESS_TIMEOUT_MS,
      });
      return parseDarwinPsEnv(stdout);
    } catch {
      return undefined;
    }
  }
  // Linux: /proc/<pid>/environ is NUL-separated KEY=VALUE pairs.
  try {
    const buf = await readFile(`/proc/${pid}/environ`);
    return parseLinuxProcEnv(buf);
  } catch {
    return undefined;
  }
}

/**
 * Parse `ps eww -p <pid>` output. BSD ps on macOS appends the process's
 * environment after the command, e.g.:
 *
 *   PID   TT  STAT      TIME COMMAND
 *   123   ??  S      0:01.23 /usr/bin/python ... KEY1=VAL1 KEY2=VAL2
 *
 * We extract tokens after the COMMAND column that look like `KEY=VALUE` (no
 * leading `-`, contain `=`).
 */
function parseDarwinPsEnv(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = stdout.split('\n');
  for (const line of lines) {
    // Match the standard 6-column ps header followed by an optional tail.
    const m = line.match(/^\s*\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+(?:\s+(.*))?$/);
    if (!m) continue;
    const tail = m[1];
    if (!tail) continue;
    for (const tok of tail.split(/\s+/)) {
      const eq = tok.indexOf('=');
      if (eq <= 0) continue;
      const k = tok.slice(0, eq);
      if (k.startsWith('-')) continue;
      out[k] = tok.slice(eq + 1);
    }
  }
  return out;
}

function parseLinuxProcEnv(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of buf.toString('utf8').split('\0')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

function parsePort(url?: string): number | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (!u.port) return undefined;
    const n = Number.parseInt(u.port, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
