// P0010.2.4 — Live verify D1: Hermes 0.20.5 on port 9120 with a known
// HERMES_DASHBOARD_SESSION_TOKEN. The test Hermes is started by the
// shell (see /tmp/p0010.2.4-test-session-token.txt) and listens on
// 127.0.0.1:9120 with `auth_required: false`.
//
// This is a REAL Hermes 0.20.5 (not a mock). Scope of the verify:
//   1. The structured `[hermes-connect]` log line proves the
//      auth probe ran, picked up the env-var session token, and
//      the connect succeeded (outcome=ok, latencyMs>0).
//   2. `session.create` JSON-RPC returns a real session_id from
//      Hermes 0.20.5 (i.e. the full JSON-RPC surface is reachable).
//
// Out of scope (intentionally): a full `prompt.submit` → turn
// round-trip. That depends on the operator's LLM API key + network
// latency and is NOT the surface P0010.2.4 fixed. P0010.2.4 fixes the
// connect chain; the LLM call is a separate concern. This is the
// honest boundary per the user's hard scope: "不要伪造
// provenance/time/final outcome".

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import {
  HermesSessionClient,
  probeAuthRequired,
  resetHealthCache,
  setHermesConnectLogger,
} from '#platform/runtime/hermes/index.js';

const TEST_HERMES_URL = 'ws://localhost:9120/api/ws';
const TOKEN_FILE = '/tmp/p0010.2.4-test-session-token.txt';

let token = '';
let connectLog: { authRequired: boolean; tokenSource: string; outcome: string; latencyMs: number; attempt: 1 | 2 } | null = null;
let sessionId: string | null = null;
let probeResult: { authRequired: boolean; probeFailed: boolean } | null = null;

beforeAll(async () => {
  if (!existsSync(TOKEN_FILE)) {
    throw new Error(
      `D1 prerequisites not met: ${TOKEN_FILE} does not exist. ` +
        `Start a test Hermes on port 9120 with HERMES_DASHBOARD_SESSION_TOKEN set ` +
        `and the same token written to ${TOKEN_FILE}.`,
    );
  }
  token = readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!token) throw new Error('test session token file is empty');

  // Capture the next structured [hermes-connect] log line.
  setHermesConnectLogger((info) => {
    if (info.url === TEST_HERMES_URL) {
      connectLog = {
        authRequired: info.authRequired,
        tokenSource: info.tokenSource ?? 'null',
        outcome: info.outcome ?? 'null',
        latencyMs: info.latencyMs,
        attempt: info.attempt,
      };
    }
  });

  // First: probe /api/health. Hermes on 9120 reports auth_required:false.
  resetHealthCache();
  probeResult = await probeAuthRequired(TEST_HERMES_URL);

  // Then: full connect → session.create path.
  const client = new HermesSessionClient({ url: TEST_HERMES_URL, token });
  await client.connect();
  const created = await client.createSession({ cwd: '/tmp/p0010.2.4-fabric-ws', profile: 'default' });
  sessionId = created.sessionId;
  client.close();
}, 30_000);

afterAll(() => {
  // Restore default logger.
  setHermesConnectLogger(null);
  // Reset health cache so other tests get a fresh probe.
  resetHealthCache();
  // Drop the env var so other tests don't pick it up.
  delete process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  // Best-effort cleanup of any stray files (none created here, but
  // be tidy).
  rmSync('/tmp/p0010.2.4-fabric-ws', { recursive: true, force: true });
});

describe('P0010.2.4 D1 — Hermes 0.20.5 (port 9120) connect + session.create', () => {
  test('probe reports auth_required=false on /api/health', () => {
    expect(probeResult).not.toBeNull();
    expect(probeResult!.authRequired).toBe(false);
    expect(probeResult!.probeFailed).toBe(false);
  });

  test('connect log line shows env-dashboard + outcome=ok', () => {
    expect(connectLog).not.toBeNull();
    expect(connectLog!.tokenSource).toBe('env-dashboard');
    expect(connectLog!.outcome).toBe('ok');
    expect(connectLog!.latencyMs).toBeGreaterThan(0);
    expect(connectLog!.attempt).toBe(1);
  });

  test('session.create returned a real session_id from Hermes 0.20.5', () => {
    expect(sessionId).not.toBeNull();
    expect(sessionId!).toMatch(/^[0-9a-f]{8,}$/);
  });
});
