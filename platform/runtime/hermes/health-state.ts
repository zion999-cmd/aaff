// hermes/health-state.ts — 3-layer Hermes runtime health state.
//
// ADR-064: agentFabric's `/api/ws` integration has THREE independent layers
// that must NOT be collapsed into a single "Hermes online/offline" boolean:
//
//   1. gateway           — Hermes gateway (port 8642, API_SERVER_KEY Bearer).
//                          AgentFabric does NOT talk to this. We do not
//                          probe it; we report `not_checked` so the operator
//                          knows agentFabric's view is silent on gateway
//                          health. (operator can still see gateway via
//                          `curl :8642/health` separately.)
//   2. sessionRuntime    — Hermes Session Runtime that backs `/api/ws`
//                          (`hermes serve` / `hermes dashboard`, default
//                          port 9119). This is the ONLY transport
//                          agentFabric uses. State is `healthy` when the
//                          most recent `/api/health` probe succeeded and
//                          we have not since failed to connect, or
//                          `unavailable` when the probe failed / the WS
//                          connect attempt failed.
//   3. agentTurn         — The most recent investigation turn. State is
//                          `healthy` when the last turn completed (with or
//                          without a useful answer, but not threw), or
//                          `failed` when the most recent turn errored out,
//                          or `never_attempted` when no turn has been run
//                          since boot.
//
// This module is a process-singleton (one set of fields, no class). It is
// the SINGLE source of truth for the 3-layer shape returned by
// `/api/runtime/hermes/status` and embedded in `/api/readiness` under
// `hermes`. Both routes call `getHermesHealth()`; both must therefore
// return the SAME data at the same instant.
//
// NOT in scope: Hermes gateway health. agentFabric does not talk to
// gateway. Adding a gateway probe here would invent a dependency that
// does not exist in the production chain.

import type { ResolveHermesTokenResult } from './token-resolver.js';
// P0010.2.7 — single source of truth for the Hermes URL/port default.
// All four files (health-state, token-resolver, session-client, the
// runtime readiness route) now resolve through this helper so the
// readiness probe, status probe, and the actual agent-turn endpoint
// ALWAYS agree on the same URL. See resolve-url.ts for the contract.
import { resolveHermesWsUrl, resolveHermesPort } from './resolve-url.js';

export type SessionRuntimeState =
  | 'healthy' // most recent /api/health probe succeeded
  | 'unavailable'; // probe failed OR WS connect failed

export interface SessionRuntimeLayer {
  /** The /api/ws URL we are configured to talk to. */
  url: string;
  /** Port derived from the URL. 9119 is `hermes serve` default — NOT gateway. */
  port: number;
  state: SessionRuntimeState;
  /** What the /api/health probe reported. `null` when the probe was not run yet. */
  authRequired: boolean | null;
  /** `true` when the probe request errored (network, timeout, non-2xx). */
  probeFailed: boolean;
  /** ISO timestamp of the last probe attempt. `null` until the first probe. */
  lastProbedAt: string | null;
  /**
   * Where the session token came from on the most recent connect attempt.
   * `null` when no connect has been attempted (or when token resolution
   * returned no value).
   */
  tokenSource: ResolveHermesTokenResult['source'];
}

export type AgentTurnState = 'healthy' | 'failed' | 'never_attempted';

export interface AgentTurnLayer {
  state: AgentTurnState;
  /** ISO timestamp of the most recent turn attempt. `null` until the first turn. */
  lastTurnAt: string | null;
  /** Failure reason on the most recent failed turn. `null` on healthy / never_attempted. */
  lastFailureReason: string | null;
}

export interface GatewayLayer {
  /**
   * agentFabric does NOT talk to Hermes gateway. We report `not_checked`
   * so the operator can distinguish "we don't have visibility" from
   * "we know it is up". A future `if (process.env.HERMES_GATEWAY_URL)`
   * branch could turn this into `running` / `unavailable`; ADR-064
   * explicitly defers that — gateway is not part of the production
   * chain.
   */
  state: 'not_checked';
  note: 'agentFabric does not talk to hermes gateway (port 8642). See ADR-064.';
}

export interface HermesHealth {
  gateway: GatewayLayer;
  sessionRuntime: SessionRuntimeLayer;
  agentTurn: AgentTurnLayer;
}

// ---- Module singleton state ----

// P0010.2.7 — replaced the local 9119 fallback with the project-wide
// helper. The explicit goal is: readiness probe, status probe, and
// the actual agent-turn endpoint MUST agree on the same URL. If any
// of them drifts, the operator's "/api/readiness says healthy" and
// "investigation turn says unavailable" results contradict each
// other (this is the exact bug the user screenshotted).

const initialUrl = (): string => resolveHermesWsUrl();

const state: {
  url: string;
  port: number;
  sessionRuntime: SessionRuntimeState;
  authRequired: boolean | null;
  probeFailed: boolean;
  lastProbedAt: string | null;
  tokenSource: ResolveHermesTokenResult['source'];
  agentTurn: AgentTurnState;
  lastTurnAt: string | null;
  lastFailureReason: string | null;
} = {
  url: initialUrl(),
  port: resolveHermesPort(initialUrl()),
  sessionRuntime: 'unavailable', // pessimistic default until first probe
  authRequired: null,
  probeFailed: false,
  lastProbedAt: null,
  tokenSource: null,
  agentTurn: 'never_attempted',
  lastTurnAt: null,
  lastFailureReason: null,
};

/**
 * Update the Session Runtime layer. Called from the readiness route after
 * `probeAuthRequired()` and (optionally) after a connect attempt.
 */
export function recordSessionRuntimeProbe(input: {
  url: string;
  port: number;
  authRequired: boolean | null;
  probeFailed: boolean;
  tokenSource: ResolveHermesTokenResult['source'];
}): void {
  state.url = input.url;
  state.port = input.port;
  state.authRequired = input.authRequired;
  state.probeFailed = input.probeFailed;
  state.lastProbedAt = new Date().toISOString();
  state.tokenSource = input.tokenSource;
  // Probe alone does not prove the WS is open. We mark healthy only when
  // the probe succeeded AND we have not seen a connect failure. The
  // connect path is responsible for marking unavailable on a failed
  // connect attempt.
  state.sessionRuntime = input.probeFailed ? 'unavailable' : 'healthy';
}

export function recordSessionRuntimeConnectFailure(input: {
  url: string;
  port: number;
  reason: string;
}): void {
  state.url = input.url;
  state.port = input.port;
  state.sessionRuntime = 'unavailable';
  state.lastProbedAt = new Date().toISOString();
  state.probeFailed = true;
  state.tokenSource = null;
  // Caller already logs the reason; we keep the failure for structured read.
  void input.reason;
}

/** Mark the Session Runtime layer as healthy (used by a successful connect). */
export function recordSessionRuntimeConnectOk(input: {
  url: string;
  port: number;
  tokenSource: ResolveHermesTokenResult['source'];
}): void {
  state.url = input.url;
  state.port = input.port;
  state.sessionRuntime = 'healthy';
  state.tokenSource = input.tokenSource;
  state.lastProbedAt = new Date().toISOString();
}

/**
 * Update the Agent Turn layer. Called from the investigation loop after
 * each turn resolves.
 */
export function recordAgentTurn(input: {
  ok: boolean;
  failureReason?: string;
}): void {
  state.lastTurnAt = new Date().toISOString();
  if (input.ok) {
    state.agentTurn = 'healthy';
    state.lastFailureReason = null;
  } else {
    state.agentTurn = 'failed';
    state.lastFailureReason = input.failureReason ?? 'unknown';
  }
}

/**
 * Read the 3-layer health shape. Both `/api/runtime/hermes/status` and
 * the embedded `hermes` field in `/api/readiness` MUST go through here.
 */
export function getHermesHealth(): HermesHealth {
  return {
    gateway: {
      state: 'not_checked',
      note: 'agentFabric does not talk to hermes gateway (port 8642). See ADR-064.',
    },
    sessionRuntime: {
      url: state.url,
      port: state.port,
      state: state.sessionRuntime,
      authRequired: state.authRequired,
      probeFailed: state.probeFailed,
      lastProbedAt: state.lastProbedAt,
      tokenSource: state.tokenSource,
    },
    agentTurn: {
      state: state.agentTurn,
      lastTurnAt: state.lastTurnAt,
      lastFailureReason: state.lastFailureReason,
    },
  };
}

/**
 * Reset to boot-time defaults. Used by tests; not called from production
 * code. The reset is intentionally NOT safe across multiple parallel
 * callers — tests are expected to call this in `beforeEach`.
 */
export function resetHermesHealthState(): void {
  state.url = initialUrl();
  state.port = resolveHermesPort(initialUrl());
  state.sessionRuntime = 'unavailable';
  state.authRequired = null;
  state.probeFailed = false;
  state.lastProbedAt = null;
  state.tokenSource = null;
  state.agentTurn = 'never_attempted';
  state.lastTurnAt = null;
  state.lastFailureReason = null;
}
