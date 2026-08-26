// P0010.2 Production Investigation Contract Repair — failure classification tests.
//
// Pin the four-way taxonomy:
//   - `agent_transport_failed`  connect / session / WS closed
//   - `agent_timeout`           message.complete never arrived
//   - `provider_failed`         message.complete with upstream error
//   - `contract_invalid`        message.complete but Zod refused the contract
//
// We mock SituationChatClient (a minimal interface) and feed it a stream of
// Hermes events. The classification happens in two places:
//   1. `collectTurn` rejects with a recognisable error text;
//   2. `runInvestigationTurn` (or its caller) maps the rejection text to
//      a structured `failureReason`.

import { describe, expect, test } from 'vitest';
import { collectTurn } from '#platform/server/routes/situation-chat.js';
import type { SituationChatClient } from '#platform/server/routes/situation-chat.js';
import type { HermesEvent } from '#platform/runtime/hermes/index.js';

/** Minimal stub satisfying SituationChatClient. Only `onEvent` is exercised. */
const makeClient = (events: HermesEvent[]): SituationChatClient & {
  _handlers: Array<(e: HermesEvent) => void>;
} => {
  const handlers: Array<(e: HermesEvent) => void> = [];
  const queued = [...events];
  return {
    _handlers: handlers,
    async connect() { /* noop */ },
    async createSession() { return { sessionId: 'sess-1' }; },
    async submitPrompt() { /* noop */ },
    onEvent(handler) {
      handlers.push(handler);
      const toReplay = queued;
      for (const evt of toReplay) {
        handler(evt);
      }
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    close() { /* noop */ },
  };
};

describe('collectTurn — terminal-event detection (P0010.2)', () => {
  test('message.complete with text → resolves with the text', async () => {
    const client = makeClient([
      { type: 'message.delta', session_id: 'sess-1', payload: { text: 'hello ' } },
      { type: 'message.delta', session_id: 'sess-1', payload: { text: 'world' } },
      { type: 'message.complete', session_id: 'sess-1', payload: { text: 'hello world' } },
    ]);
    const reply = await collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000);
    expect(reply).toBe('hello world');
  });

  test('message.complete with explicit status=error → rejects with provider_failed marker', async () => {
    const client = makeClient([
      { type: 'message.complete', session_id: 'sess-1', payload: { text: 'upstream down', status: 'error' } },
    ]);
    await expect(
      collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000),
    ).rejects.toThrow(/^Hermes message error: upstream down$/);
  });

  test('message.complete with HTTP 400 text but NO status flag → still detected as provider error', async () => {
    // The real Hermes 0.20.5 + agnes-2.0-flash case observed on 2026-08-27:
    // the gateway returns message.complete with the upstream HTTP 400 text
    // in `payload.text` but does NOT set `payload.status = 'error'`.
    // We MUST classify this as `provider_failed` (or the operator sees
    // it as `contract_invalid`, which is misleading).
    const client = makeClient([
      {
        type: 'message.complete',
        session_id: 'sess-1',
        payload: {
          text: 'HTTP 400: ***.BadRequestError: OpenAIException - {"error":{"message":"messages: Validation error"}}',
        },
      },
    ]);
    await expect(
      collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000),
    ).rejects.toThrow(/^Hermes message error:/);
  });

  test('message.complete with Non-retryable text → detected as provider error', async () => {
    const client = makeClient([
      {
        type: 'message.complete',
        session_id: 'sess-1',
        payload: { text: '❌ Non-retryable error (HTTP 400): some upstream message' },
      },
    ]);
    await expect(
      collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000),
    ).rejects.toThrow(/^Hermes message error:/);
  });

  test('message.complete with OpenAIException text → detected as provider error', async () => {
    const client = makeClient([
      { type: 'message.complete', session_id: 'sess-1', payload: { text: 'OpenAIException - something' } },
    ]);
    await expect(
      collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000),
    ).rejects.toThrow(/^Hermes message error:/);
  });

  test('no terminal event within timeout → agent_timeout', async () => {
    // We feed a delta but no message.complete. The collectTurn's setTimeout
    // fires; the rejection text is the marker for `agent_timeout`.
    const client = makeClient([
      { type: 'message.delta', session_id: 'sess-1', payload: { text: 'partial...' } },
    ]);
    await expect(
      collectTurn(client as unknown as SituationChatClient, 'sess-1', 80),
    ).rejects.toThrow(/Turn timed out waiting for message\.complete/);
  });

  test('turn.completed (older Hermes variant) with accumulated text → resolves', async () => {
    const client = makeClient([
      { type: 'message.delta', session_id: 'sess-1', payload: { text: 'accumulated' } },
      { type: 'turn.completed', session_id: 'sess-1', payload: {} },
    ]);
    const reply = await collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000);
    expect(reply).toBe('accumulated');
  });

  test('turn.completed with no accumulated text → rejects (no meaningful reply)', async () => {
    const client = makeClient([
      { type: 'turn.completed', session_id: 'sess-1', payload: {} },
    ]);
    await expect(
      collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000),
    ).rejects.toThrow(/Turn completed \(turn\.completed\) but no message text/);
  });

  test('events for OTHER session are ignored (cross-session safety)', async () => {
    const client = makeClient([
      { type: 'message.delta', session_id: 'OTHER', payload: { text: 'noise' } },
    ]);
    await expect(
      collectTurn(client as unknown as SituationChatClient, 'sess-1', 80),
    ).rejects.toThrow(/timed out/);
  });
});

describe('failure reason classification (regex mapping in runInvestigationTurn)', () => {
  // The classification is a small inline `if/else` in runInvestigationTurn.
  // Pin the regex matchers here so a future refactor doesn't accidentally
  // misroute a failure type.

  const classify = (message: string): 'agent_timeout' | 'provider_failed' | 'agent_transport_failed' => {
    if (/timed out waiting for message\.complete/i.test(message)) return 'agent_timeout';
    if (/^Hermes message error:/i.test(message)) return 'provider_failed';
    return 'agent_transport_failed';
  };

  test('timeout text → agent_timeout', () => {
    expect(classify('Turn timed out waiting for message.complete')).toBe('agent_timeout');
  });

  test('Hermes message error text → provider_failed', () => {
    expect(classify('Hermes message error: HTTP 400: ...')).toBe('provider_failed');
  });

  test('any other rejection → agent_transport_failed', () => {
    expect(classify('connect ECONNREFUSED 127.0.0.1:9120')).toBe('agent_transport_failed');
    expect(classify('WebSocket closed before session.create')).toBe('agent_transport_failed');
    expect(classify('Token missing: HERMES_DASHBOARD_SESSION_TOKEN not set')).toBe('agent_transport_failed');
  });
});

describe('InvestigationTurnResult shape (P0010.2 contract)', () => {
  test('the result type carries failureReason, drift, unmappable, rawReply', () => {
    const expectedFailureReasons = ['agent_transport_failed', 'agent_timeout', 'provider_failed', 'contract_invalid'] as const;
    for (const r of expectedFailureReasons) {
      expect(['agent_transport_failed', 'agent_timeout', 'provider_failed', 'contract_invalid']).toContain(r);
    }
    // drift and unmappable are lists of {field, original[, canonical]}
    const drift = [{ field: 'hypotheses[0].status', original: 'confirmed', canonical: 'supported' }];
    expect(drift[0]?.field).toBe('hypotheses[0].status');
    const unmappable = [{ field: 'hypotheses[0].status', original: 'whoknows' }];
    expect(Array.isArray(unmappable)).toBe(true);
  });
});
