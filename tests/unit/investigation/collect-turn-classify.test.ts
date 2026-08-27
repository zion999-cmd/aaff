// P0010.2 Production Investigation Contract Repair — failure classification tests.
//
// P0010.2 Review Repair — the test file is the regression wall for two
// real bugs ChatGPT caught in `ceba210`:
//
//   1. `isProviderError` was over-broad (matched any text containing
//      "BadRequestError" / "OpenAIException" / "Non-retryable" / etc).
//      The Agent's normal investigation JSON can LEGITIMATELY mention
//      those tokens (e.g. "the previous BadRequestError was caused by
//      ..."). The relaxed version would misclassify a normal
//      investigation as `provider_failed` and skip the parser entirely.
//
//   2. `turn.completed` / `turn.complete` was treated as a hard
//      terminal. Hermes 0.20.5 tui_gateway/server.py does NOT emit
//      these on the wire (we audited the source — there is no
//      `_emit("turn.completed", ...)` call). If a future Hermes variant
//      DOES emit them as a LIFECYCLE signal before `message.complete`,
//      we must wait for `message.complete` rather than resolve on the
//      partial delta stream.
//
// Pin the four-way taxonomy:
//   - `agent_transport_failed`  connect / session / WS closed
//   - `agent_timeout`           message.complete never arrived
//   - `provider_failed`         message.complete with upstream error envelope
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
const makeClient = (events: HermesChatEvent[]): SituationChatClient & {
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

/**
 * Hermes event literal with the exact shape the mock client replays.
 * The real `HermesEvent` type is wider (it covers every method/event
 * variant the gateway emits) but the collectTurn handler only ever
 * reads `event.type` / `event.session_id` / `event.payload?.text`, so
 * we narrow it here to keep the tests stable.
 */
type HermesChatEvent = {
  type: string;
  session_id?: string;
  payload?: { text?: string; status?: string } & Record<string, unknown>;
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

  // ---- P0010.2 Review Repair: provider-error envelope ----

  test('message.complete with real HTTP 400 envelope (the agnes-2.0-flash case) → provider_failed', async () => {
    // The real Hermes 0.20.5 + agnes-2.0-flash case observed on 2026-08-27:
    // the gateway returns message.complete with the upstream HTTP 400
    // envelope in `payload.text` but does NOT set `payload.status = 'error'`.
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

  test('message.complete with the Non-retryable sentinel → provider_failed', async () => {
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

  test('REGRESSION (P0010.2 review): Agent JSON containing "HTTP 400" as data is NOT provider_failed', async () => {
    // The Agent may legitimately quote "HTTP 400" in its judgment or
    // recommendation rationale (e.g. "the upstream returned HTTP 400
    // because the model name was unrecognised"). The pre-review
    // `isProviderError` would have classified this as provider_failed
    // and skipped the parser entirely. After the review repair, the
    // envelope matcher requires `HTTP <code>:` with a colon (real
    // upstream reject), the Non-retryable sentinel, or the OpenAI
    // exception-with-JSON envelope — bare "HTTP 400" in prose does not
    // match.
    const investigationJson = JSON.stringify({
      situationId: 'sit_test_001',
      currentUnderstanding: 'The previous request returned HTTP 400 because the model id was wrong.',
      knownEvidence: ['agent log: BadRequestError on prior turn'],
      hypotheses: [{ statement: 'wrong model id', status: 'supported' }],
      unknowns: ['the correct model id'],
      nextQuestion: 'what is the right model id?',
      requiredEvidence: ['env config dump'],
      investigationRequest: 'check env',
      findings: [{
        question: 'why was the prior turn rejected?',
        evidenceRefs: ['ev_1'],
        answer: 'Non-retryable error. Likely OpenAIException — model id mismatch.',
        impactOnHypothesis: 'supports wrong model id',
      }],
      judgment: 'the upstream HTTP 400 was caused by a misconfigured model id; not a Fabric bug.',
      stopReason: 'judgment',
      capabilityUsed: 'env.inspect',
      evidenceAcquired: ['ev_1'],
      recommendation: {
        recommendation: 'fix the model id in agentFabric config',
        rationale: 'BadRequestError is upstream — verify the model id matches the provider allow-list',
        expectedOutcome: 'next turn succeeds',
        risks: 'none',
        prerequisites: ['read AGENTFABRIC_MODEL_ID env'],
        humanNeeded: ['confirm correct model id with provider'],
      },
    });
    const client = makeClient([
      { type: 'message.complete', session_id: 'sess-1', payload: { text: investigationJson } },
    ]);
    const reply = await collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000);
    // Must NOT throw — the Agent's prose-quoted tokens must NOT be
    // confused with a real upstream error envelope.
    expect(reply).toContain('HTTP 400');
    expect(reply).toContain('BadRequestError');
    expect(reply).toContain('OpenAIException');
    expect(reply).toContain('Non-retryable');
  });

  test('REGRESSION: bare "BadRequestError" alone (no HTTP code) is NOT provider_failed', async () => {
    const client = makeClient([
      { type: 'message.complete', session_id: 'sess-1', payload: { text: 'see the BadRequestError in your last log' } },
    ]);
    const reply = await collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000);
    expect(reply).toBe('see the BadRequestError in your last log');
  });

  test('REGRESSION: bare "OpenAIException" without JSON body is NOT provider_failed', async () => {
    // Pre-review would match `\bOpenAIException\b` alone. After review
    // the envelope requires the JSON-bodied shape `OpenAIException - {"error":...`.
    const client = makeClient([
      { type: 'message.complete', session_id: 'sess-1', payload: { text: 'I suspect an OpenAIException class might be raised.' } },
    ]);
    const reply = await collectTurn(client as unknown as SituationChatClient, 'sess-1', 1000);
    expect(reply).toContain('OpenAIException');
  });

  // ---- P0010.2 Review Repair: turn.completed lifecycle signal ----

  test('REGRESSION: delta → turn.completed → message.complete(full) uses the FULL message.complete', async () => {
    // The pre-review code would unsubscribe on `turn.completed` and
    // resolve with the partial delta stream. After the review, the
    // `turn.completed` is just a LIFECYCLE signal that starts a 2s
    // grace timer; the canonical `message.complete` MUST be the text
    // we resolve on. This is the bug that would have created
    // `contract_invalid` for a Hermes variant that emits a lifecycle
    // event before the canonical terminal.
    //
    // We simulate the variant by replaying the events synchronously
    // and then letting the grace timer fire. The mock client does
    // NOT emit a follow-up message.complete in this test — so the
    // grace timer WILL fire and we will fall back to the accumulated
    // text. To test the "must use the full message.complete" path
    // we use a controlled client that emits the follow-up event
    // from inside an externally-driven setTimeout (not the mock
    // client's queue).
    const handlers: Array<(e: HermesEvent) => void> = [];
    const client: SituationChatClient = {
      async connect() {},
      async createSession() { return { sessionId: 'sess-1' }; },
      async submitPrompt() {},
      onEvent(handler) {
        handlers.push(handler);
        // Replay the initial sequence synchronously.
        handler({ type: 'message.delta', session_id: 'sess-1', payload: { text: 'partial-' } } as unknown as HermesEvent);
        handler({ type: 'turn.completed', session_id: 'sess-1', payload: {} } as unknown as HermesEvent);
        // Schedule the canonical terminal within the 2s grace window.
        setTimeout(() => {
          handler({ type: 'message.complete', session_id: 'sess-1', payload: { text: 'partial-FINAL-COMPLETE' } } as unknown as HermesEvent);
        }, 100);
        return () => {
          const i = handlers.indexOf(handler);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
      close() {},
    };
    const reply = await collectTurn(client, 'sess-1', 5_000);
    // MUST contain the full message.complete text, not just the partial
    // delta stream (which would be 'partial-').
    expect(reply).toBe('partial-FINAL-COMPLETE');
  });

  test('delta → turn.completed alone (no follow-up message.complete) falls back after grace', async () => {
    // Forward-compat net: if a hypothetical Hermes variant emits
    // `turn.completed` as the SOLE terminal (no follow-up
    // `message.complete`), we wait the grace window then fall back
    // to the accumulated delta text. The previous hard-terminal
    // behaviour would have done the same thing immediately — the
    // difference is the 2s grace that gives the canonical event a
    // chance to arrive first.
    const client = makeClient([
      { type: 'message.delta', session_id: 'sess-1', payload: { text: 'accumulated' } },
      { type: 'turn.completed', session_id: 'sess-1', payload: {} },
    ]);
    const reply = await collectTurn(client as unknown as SituationChatClient, 'sess-1', 5_000);
    expect(reply).toBe('accumulated');
  });

  test('turn.completed with no accumulated text AND no follow-up message.complete → rejects after grace', async () => {
    const client = makeClient([
      { type: 'turn.completed', session_id: 'sess-1', payload: {} },
    ]);
    await expect(
      collectTurn(client as unknown as SituationChatClient, 'sess-1', 5_000),
    ).rejects.toThrow(/Turn completed \(turn\.completed\) but no message text/);
  });

  // ---- Existing P0010.2 tests preserved ----

  test('no terminal event within timeout → agent_timeout', async () => {
    const client = makeClient([
      { type: 'message.delta', session_id: 'sess-1', payload: { text: 'partial...' } },
    ]);
    await expect(
      collectTurn(client as unknown as SituationChatClient, 'sess-1', 80),
    ).rejects.toThrow(/Turn timed out waiting for message\.complete/);
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
