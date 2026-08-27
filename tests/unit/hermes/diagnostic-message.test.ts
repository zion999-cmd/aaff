// P0010.2.4 + ADR-064 — Hermes diagnostic contract tests.
//
// Pin the exact wording the operator sees when the configured session
// adapter is unreachable. These tests are the regression net for the
// 3-layer health model + the new error message contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordSessionRuntimeProbe,
  recordSessionRuntimeConnectOk,
  recordSessionRuntimeConnectFailure,
  recordAgentTurn,
  getHermesHealth,
  resetHermesHealthState,
  type HermesHealth,
} from '#platform/runtime/hermes/health-state.js';

describe('Hermes health state — 3-layer shape (ADR-064)', () => {
  beforeEach(() => {
    resetHermesHealthState();
  });
  afterEach(() => {
    resetHermesHealthState();
  });

  it('gateway layer is always not_checked (agentFabric does not talk to gateway)', () => {
    const h = getHermesHealth();
    expect(h.gateway.state).toBe('not_checked');
    expect(h.gateway.note).toMatch(/does not talk to hermes gateway/);
  });

  it('session runtime starts unavailable until a probe is recorded', () => {
    const h = getHermesHealth();
    expect(h.sessionRuntime.state).toBe('unavailable');
    expect(h.sessionRuntime.lastProbedAt).toBeNull();
    expect(h.sessionRuntime.tokenSource).toBeNull();
  });

  it('agent turn starts never_attempted', () => {
    const h = getHermesHealth();
    expect(h.agentTurn.state).toBe('never_attempted');
    expect(h.agentTurn.lastTurnAt).toBeNull();
    expect(h.agentTurn.lastFailureReason).toBeNull();
  });

  it('records session runtime probe success as healthy', () => {
    recordSessionRuntimeProbe({
      url: 'ws://localhost:9119/api/ws',
      port: 9119,
      authRequired: false,
      probeFailed: false,
      tokenSource: null,
    });
    const h = getHermesHealth();
    expect(h.sessionRuntime.state).toBe('healthy');
    expect(h.sessionRuntime.probeFailed).toBe(false);
    expect(h.sessionRuntime.lastProbedAt).not.toBeNull();
    expect(h.sessionRuntime.url).toBe('ws://localhost:9119/api/ws');
    expect(h.sessionRuntime.port).toBe(9119);
  });

  it('records session runtime probe failure as unavailable', () => {
    recordSessionRuntimeProbe({
      url: 'ws://localhost:9119/api/ws',
      port: 9119,
      authRequired: null,
      probeFailed: true,
      tokenSource: null,
    });
    const h = getHermesHealth();
    expect(h.sessionRuntime.state).toBe('unavailable');
    expect(h.sessionRuntime.probeFailed).toBe(true);
  });

  it('records connect ok as healthy with token source', () => {
    recordSessionRuntimeConnectOk({
      url: 'ws://localhost:9119/api/ws',
      port: 9119,
      tokenSource: 'env-dashboard',
    });
    const h = getHermesHealth();
    expect(h.sessionRuntime.state).toBe('healthy');
    expect(h.sessionRuntime.tokenSource).toBe('env-dashboard');
  });

  it('records connect failure as unavailable (overrides prior healthy)', () => {
    recordSessionRuntimeConnectOk({
      url: 'ws://localhost:9119/api/ws',
      port: 9119,
      tokenSource: 'env-dashboard',
    });
    expect(getHermesHealth().sessionRuntime.state).toBe('healthy');
    recordSessionRuntimeConnectFailure({
      url: 'ws://localhost:9119/api/ws',
      port: 9119,
      reason: 'connect failed twice',
    });
    const h = getHermesHealth();
    expect(h.sessionRuntime.state).toBe('unavailable');
    expect(h.sessionRuntime.tokenSource).toBeNull();
  });

  it('records agent turn success as healthy and clears prior failure', () => {
    recordAgentTurn({ ok: false, failureReason: 'connect_timeout' });
    expect(getHermesHealth().agentTurn.state).toBe('failed');
    recordAgentTurn({ ok: true });
    const h = getHermesHealth();
    expect(h.agentTurn.state).toBe('healthy');
    expect(h.agentTurn.lastFailureReason).toBeNull();
    expect(h.agentTurn.lastTurnAt).not.toBeNull();
  });

  it('records agent turn failure with the structured reason', () => {
    recordAgentTurn({ ok: true });
    recordAgentTurn({ ok: false, failureReason: 'session_runtime_unreachable' });
    const h = getHermesHealth();
    expect(h.agentTurn.state).toBe('failed');
    expect(h.agentTurn.lastFailureReason).toBe('session_runtime_unreachable');
  });

  it('3 layers are independent (changing one does not touch the others)', () => {
    recordSessionRuntimeProbe({
      url: 'ws://localhost:9119/api/ws',
      port: 9119,
      authRequired: false,
      probeFailed: false,
      tokenSource: 'auto-dashboard',
    });
    recordAgentTurn({ ok: true });
    const h1: HermesHealth = getHermesHealth();
    recordAgentTurn({ ok: false, failureReason: 'turn_threw' });
    const h2: HermesHealth = getHermesHealth();
    expect(h2.gateway).toEqual(h1.gateway);
    expect(h2.sessionRuntime).toEqual(h1.sessionRuntime);
    expect(h2.agentTurn.state).toBe('failed');
    expect(h2.agentTurn.state).not.toBe(h1.agentTurn.state);
  });
});

describe('Hermes diagnostic message contract (ADR-064)', () => {
  it('HermesAuthError accepts the session_runtime_unreachable reason', async () => {
    const mod = await import('#platform/runtime/hermes/session-client.js');
    const err = new mod.HermesAuthError(
      'session_runtime_unreachable',
      'Hermes Session Runtime unavailable at ws://localhost:9119/api/ws.',
    );
    expect(err.reason).toBe('session_runtime_unreachable');
    expect(err.message).toMatch(/Hermes Session Runtime unavailable at/);
  });

  it('HermesAuthError accepts the missing_token reason with the required wording', async () => {
    const mod = await import('#platform/runtime/hermes/session-client.js');
    const required =
      'Hermes Session Runtime unavailable at ws://localhost:9119/api/ws. ' +
      `AgentFabric requires 'hermes serve' for the configured session adapter.`;
    const err = new mod.HermesAuthError('missing_token', required);
    expect(err.reason).toBe('missing_token');
    expect(err.message.startsWith('Hermes Session Runtime unavailable at')).toBe(true);
    expect(err.message).toContain("AgentFabric requires 'hermes serve' for the configured session adapter.");
  });
});

describe('Token domain separation (ADR-064)', () => {
  it('resolveHermesSessionToken reads ONLY HERMES_DASHBOARD_SESSION_TOKEN, not HERMES_GATEWAY_TOKEN', async () => {
    const saved = { ...process.env };
    try {
      delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
      process.env.HERMES_GATEWAY_TOKEN = 'gateway-secret-should-not-leak';
      const mod = await import('#platform/runtime/hermes/token-resolver.js');
      mod.resetTokenCache();
      const result = await mod.resolveHermesSessionToken();
      expect(result).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});
