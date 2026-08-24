// token-resolver.ts — resolve the Hermes dashboard session token for the agentFabric
// `/api/ws` client.
//
// Resolution priority (highest first):
//   1. The `HERMES_DASHBOARD_SESSION_TOKEN` env var in the agentFabric process —
//      operator-pinned, survives `hermes serve` restarts as long as the operator
//      re-exports before starting the serve.
//   2. Auto-discover from the running `hermes serve` process listening on the
//      port derived from the URL (default 9119). Reads the serve process's env
//      via `lsof` + `ps eww` (macOS) or `lsof` + `/proc/<pid>/environ` (Linux).
//
// Neither path throws. All subprocess failures fall through to `undefined` and
// the caller's existing "Missing token" error path applies.
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
}

const SUBPROCESS_TIMEOUT_MS = 5_000;

/** Per-port cache so we only shell out once per agentFabric process lifetime. */
interface CacheEntry {
  port: number;
  token: string | undefined;
}
let cache: CacheEntry | null = null;

/**
 * Resolve the Hermes dashboard session token. Returns `undefined` if no source
 * is available.
 *
 * Side effect: result is cached per port for the lifetime of the module.
 */
export async function resolveHermesSessionToken(
  options: ResolveOptions = {},
): Promise<string | undefined> {
  const port = parsePort(options.url) ?? 9119;

  // (1) Operator-pinned env var wins.
  const fromEnv = process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  // (2) Auto-discover from the running hermes serve.
  if (cache && cache.port === port) {
    return cache.token;
  }
  const discovered = await discoverFromRunningServe(port);
  cache = { port, token: discovered };
  return discovered;
}

/** For tests and explicit override: clear the per-port cache. */
export function _resetTokenCache(): void {
  cache = null;
}

async function discoverFromRunningServe(port: number): Promise<string | undefined> {
  const pid = await findListenPid(port);
  if (!pid) return undefined;
  const env = await readProcessEnv(pid);
  if (!env) return undefined;
  const token = env['HERMES_DASHBOARD_SESSION_TOKEN'];
  return token && token.length > 0 ? token : undefined;
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
