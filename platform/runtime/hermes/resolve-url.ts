// P0010.2.7 — Single source of truth for the Hermes Session Runtime URL.
//
// Every place that needs to talk to Hermes (readiness probe, status probe,
// situation-chat turn, knowledge agent turn, runtime-loop acquisition)
// MUST resolve the URL through this helper. The explicit goal is the
// invariant the user required for the project:
//
//   configured endpoint == readiness endpoint == status endpoint
//   == actual agent-turn endpoint
//
// How the URL is chosen (priority order, top wins):
//   1. `process.env.HERMES_WS_URL` — operator-pinned. The dev wrapper
//      `scripts/with-hermes-env.ts` sets this before spawn, and
//      `hermes serve --port 9120` is the project's chosen endpoint.
//   2. Default: `ws://localhost:9120/api/ws` — the project-chosen port.
//      9120 was selected during the P0010.2 setup (the prior P0010.2
//      Reset ran Hermes on 9120 to avoid the legacy 9119 that was
//      already taken by another tool on the dev box). This default
//      is intentionally NOT 9119, which is what the original
//      `hermes serve` CLI defaults to but is unrelated to the
//      project's deployed Hermes. If the dev wrapper is not used,
//      this default keeps agentFabric pointed at the right port
//      instead of silently drifting to the wrong one.
//
// We intentionally do NOT auto-discover via `lsof` / `ps eww` / etc.
// The auto-discovery is a deferred diagnostic mechanism (see
// ADR-064 + `hermes-auto-discovery-vs-explicit-contract.md`) and
// MUST NOT override the operator's explicit env. If the operator
// has not set HERMES_WS_URL, the default below is the single
// honest answer.
//
// All call sites in this codebase that previously hard-coded
// `?? 'ws://localhost:9119/api/ws'` or `?? 9119` (4 files: health-state,
// token-resolver, session-client, runtime.ts) now route through this
// helper. A grep for `ws://localhost:9119` should return zero hits in
// `platform/`.

export const DEFAULT_HERMES_WS_URL = 'ws://localhost:9120/api/ws';
export const DEFAULT_HERMES_PORT = 9120;

/**
 * Resolve the Hermes Session Runtime WebSocket URL.
 *
 * @returns the URL to use. Always non-empty.
 */
export function resolveHermesWsUrl(): string {
  if (typeof process !== 'undefined' && process.env) {
    const fromEnv = process.env['HERMES_WS_URL'];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  }
  return DEFAULT_HERMES_WS_URL;
}

/**
 * Parse the port from a `ws://host:port/path` URL. Returns the
 * project default port if the URL is missing or unparseable.
 *
 * @param url optional URL; when omitted, the resolved URL is used.
 */
export function resolveHermesPort(url?: string): number {
  const target = url ?? resolveHermesWsUrl();
  const parsed = parsePortFromUrl(target);
  return parsed ?? DEFAULT_HERMES_PORT;
}

function parsePortFromUrl(url: string): number | undefined {
  // Accept ws://, wss://, http://, https://. Pull host:port from
  // the URL. We deliberately do NOT pull the path port — Hermes
  // puts `/api/ws` on the same port as the daemon.
  try {
    const m = url.match(/^[a-z]+:\/\/[^:/]+(?::(\d+))?/i);
    if (!m) return undefined;
    const p = Number(m[1]);
    if (Number.isFinite(p) && p > 0 && p < 65536) return p;
    return undefined;
  } catch {
    return undefined;
  }
}
