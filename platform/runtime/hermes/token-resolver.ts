// token-resolver.ts — resolve the Hermes dashboard session token for the agentFabric
// `/api/ws` client.
//
// Resolution priority (highest first):
//   1. The `HERMES_DASHBOARD_SESSION_TOKEN` env var in the agentFabric process.
//      This is the ONLY operator-pinned source we accept. `_SESSION_TOKEN` in
//      Hermes 0.20.5 is resolved as
//        `os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN") or secrets.token_urlsafe(32)`
//      (see hermes_cli/web_server.py:540), so any value we send in
//      `?token=` must match whatever the Hermes process generated.
//   2. Auto-discover from the running `hermes serve` process listening on
//      the port derived from the URL (default 9119 — the `hermes serve`
//      default port for the Session Runtime that backs `/api/ws`; it is
//      NOT a hermes gateway port — gateway defaults to 8642 with
//      API_SERVER_KEY Bearer auth and is a separate service, see
//      ADR-064). Reads the serve process's env via `lsof` + `ps eww`
//      (macOS) or `lsof` + `/proc/<pid>/environ` (Linux).
//      Auto-discovery reads HERMES_DASHBOARD_SESSION_TOKEN ONLY — we do
//      NOT accept any other env var as a session token source. In
//      particular, HERMES_GATEWAY_TOKEN and API_SERVER_KEY are the
//      credentials for the SEPARATE hermes gateway service (port 8642)
//      and must NEVER be sent to the /api/ws Session Runtime.
//
// Caching: auto-discovered tokens are cached per port for the lifetime of
// the process (one `lsof` + one `ps eww` per agentFabric boot). The
// cache also stores the source so the structured `HermesConnectInfo`
// log reports the truth. Operator-pinned env tokens are NOT cached —
// they are re-read on every call so an operator export change takes
// effect without a restart.
//
// IMPORTANT: This module must NEVER log the token value, never include it in
// error messages, and never propagate it across process boundaries (no HTTP
// response to the browser, no DB write, no shared file).
//
// Historical note: a previous version of this resolver also accepted
// `HERMES_GATEWAY_TOKEN` as a fallback. That was wrong. `HERMES_GATEWAY_TOKEN`
// is the credential for Hermes' separate HTTP gateway service (see
// `optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py`),
// not the `_SESSION_TOKEN` used by `/api/ws`. Sending it on the WS upgrade
// would have produced 403s that look like "wrong token" instead of the real
// "Hermes generated an in-memory random token we can't read" cause. P0010.2.4
// review repair (ADR-061) removed the gateway fallback.

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

/**
 * Per-port cache so we only shell out once per agentFabric process lifetime.
 * The source is stored alongside the token so the structured log entry can
 * report where the token actually came from on a cache hit.
 */
interface CacheEntry {
  port: number;
  token: string | undefined;
  source: 'auto-dashboard' | null;
}
let cache: CacheEntry | null = null;

export const ENV_TOKEN_NAMES = {
  /** The ONLY env var that maps to Hermes' `_SESSION_TOKEN` (web_server.py:540). */
  dashboard: 'HERMES_DASHBOARD_SESSION_TOKEN',
} as const;

/**
 * The single operator-pinned source for the WS session token.
 *
 * Returns `undefined` if not set. We deliberately do NOT fall through to any
 * other env var — see module header for the rationale.
 */
const resolveFromOperatorEnv = (): { token: string | undefined; source: 'env-dashboard' | null } => {
  const fromDashboard = process.env[ENV_TOKEN_NAMES.dashboard];
  if (fromDashboard && fromDashboard.length > 0) {
    return { token: fromDashboard, source: 'env-dashboard' };
  }
  return { token: undefined, source: null };
};

export interface ResolveHermesTokenResult {
  /** The resolved token. `undefined` when no source returned a value. */
  token: string | undefined;
  /**
   * Where the token came from.
   * - `env-dashboard`   — agentFabric process env
   * - `auto-dashboard`  — discovered from the running `hermes serve` env
   * - `null`            — no source returned a value
   */
  source: 'env-dashboard' | 'auto-dashboard' | null;
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
  // 9119 is the `hermes serve` default (Session Runtime that backs /api/ws).
  // It is NOT a hermes gateway port — gateway uses 8642 and API_SERVER_KEY.
  const port = parsePort(options.url) ?? 9119;

  // (1) Operator-pinned env var wins. Never cached, never auto-refreshed.
  const fromOperator = resolveFromOperatorEnv();
  if (fromOperator.token !== undefined) {
    return fromOperator.token;
  }

  // (2) Auto-discover from the running hermes serve.
  if (!options.forceRefresh && cache && cache.port === port) {
    return cache.token;
  }
  const discovered = await discoverFromRunningServe(port);
  cache = { port, token: discovered.token, source: discovered.source };
  return discovered.token;
}

/**
 * Like `resolveHermesSessionToken` but also returns the source of the token.
 * Used by the session client to surface a structured `HermesConnectInfo`
 * log entry (P0010.2.4 audit A). Operator-pinned tokens are never logged
 * (the source is logged, the value is not).
 *
 * Cache hits return the *real* cached source (not a hardcoded
 * `auto-dashboard`) so the structured log does not lie about origin.
 */
export async function resolveHermesSessionTokenWithSource(
  options: ResolveOptions = {},
): Promise<ResolveHermesTokenResult> {
  // 9119 is the `hermes serve` default (Session Runtime that backs /api/ws).
  // It is NOT a hermes gateway port — gateway uses 8642 and API_SERVER_KEY.
  const port = parsePort(options.url) ?? 9119;

  const fromOperator = resolveFromOperatorEnv();
  if (fromOperator.token !== undefined) {
    return { token: fromOperator.token, source: fromOperator.source };
  }

  if (!options.forceRefresh && cache && cache.port === port) {
    return { token: cache.token, source: cache.source };
  }
  const discovered = await discoverFromRunningServe(port);
  cache = { port, token: discovered.token, source: discovered.source };
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
): Promise<{ token: string | undefined; source: 'auto-dashboard' | null }> {
  const pid = await findListenPid(port);
  if (!pid) return { token: undefined, source: null };
  const env = await readProcessEnv(pid);
  if (!env) return { token: undefined, source: null };
  // Hermes 0.20.5's `_SESSION_TOKEN` is resolved exclusively from
  // HERMES_DASHBOARD_SESSION_TOKEN (web_server.py:540). We MUST NOT
  // accept any other env var here — see module header.
  const dashboard = env[ENV_TOKEN_NAMES.dashboard];
  if (dashboard && dashboard.length > 0) {
    return { token: dashboard, source: 'auto-dashboard' };
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
