// P0013.1 — real Hermes turn runner for historical acquisition.
//
// Drives an external `hermes serve` over the WS session client exactly
// like the 2026-09-03 blind harnesses: passive observer, no tool dispatch,
// no hint injection. The full trajectory (tool args included) is appended
// to events.ndjson so the experiment can answer reuse-vs-rediscovery
// without guessing (SC4/SC10). Tool RESULTS are truncated — they may be
// multi-megabyte API payloads; the artifacts themselves live in intake.

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { HermesSessionClient } from '#platform/runtime/hermes/session-client.js';
import { resolveHermesWsUrl } from '#platform/runtime/hermes/resolve-url.js';

export interface TurnRunArgs {
  readonly jobId: string;
  readonly goal: string;
  readonly cwd: string;
  readonly trajectoryDir: string;
  readonly timeoutMs?: number;
}

export interface TurnRunResult {
  readonly sessionId: string;
  readonly toolCallCount: number;
  readonly finalMessage: string;
}

export interface TurnRunner {
  runTurn(args: TurnRunArgs): Promise<TurnRunResult>;
}

const RESULT_PREVIEW_LIMIT = 4000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

const preview = (value: unknown, limit = RESULT_PREVIEW_LIMIT): string => {
  const s = typeof value === 'string' ? value : safeStringify(value);
  return s.length > limit ? `${s.slice(0, limit)}…<truncated>` : s;
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export class HermesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesUnavailableError';
  }
}

/** Production turn runner: real Hermes over WebSocket, repo cwd. */
export const createHermesTurnRunner = (urlOverride?: string): TurnRunner => ({
  async runTurn(args: TurnRunArgs): Promise<TurnRunResult> {
    mkdirSync(args.trajectoryDir, { recursive: true });
    const eventsPath = join(args.trajectoryDir, 'events.ndjson');
    const emit = (event: Record<string, unknown>): void => {
      appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    };

    const url = urlOverride ?? resolveHermesWsUrl();
    const client = new HermesSessionClient({ url });
    try {
      try {
        await client.connect();
      } catch (err) {
        throw new HermesUnavailableError(
          `cannot connect to Hermes at ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const session = await client.createSession({ cwd: args.cwd });
      emit({ kind: 'session.created', at: new Date().toISOString(), session_id: session.sessionId });

      const result = await client.submitTurnAndCollect(session.sessionId, args.goal, {
        timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        onProgress: {
          onTurnStart: () => emit({ kind: 'turn.start', at: new Date().toISOString() }),
          onMessageDelta: (text) =>
            emit({ kind: 'message.delta', at: new Date().toISOString(), text }),
          onToolStart: (toolId, name, toolArgs) =>
            emit({
              kind: 'tool.start',
              at: new Date().toISOString(),
              tool_id: toolId,
              name,
              args: preview(toolArgs, 8000),
            }),
          onToolComplete: (toolId, name, toolResult, duration_s) =>
            emit({
              kind: 'tool.complete',
              at: new Date().toISOString(),
              tool_id: toolId,
              name,
              duration_s,
              result: preview(toolResult),
            }),
          onTurnComplete: () => emit({ kind: 'turn.complete', at: new Date().toISOString() }),
        },
      });

      emit({
        kind: 'turn.result',
        at: new Date().toISOString(),
        error: result.error ?? null,
        tool_calls: result.toolCalls.length,
      });
      if (result.error) {
        throw new Error(`Hermes turn failed: ${result.error}`);
      }
      return {
        sessionId: session.sessionId,
        toolCallCount: result.toolCalls.length,
        finalMessage: result.messageText,
      };
    } finally {
      try {
        client.close();
      } catch {
        // best-effort close
      }
    }
  },
});
