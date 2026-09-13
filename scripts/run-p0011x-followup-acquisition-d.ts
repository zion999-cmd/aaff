// P0011.x Follow-up D — Continuation experiment harness.
// Claude's role per user spec 2026-09-03: ONLY stabilize the experiment
// environment. Reuse Chrome :9222 / existing JD tab. Do NOT explore, do NOT
// write acquisition, do NOT give Hermes hints. This script is a thin
// passive observer: it loads the continuation goal from a file, hands it
// to Hermes via submitTurnAndCollect, and records the result.
//
// The goal file is the contract:
//   data/_blind_runs/p0011x-followup-d-goal.md
//
// Everything Hermes does / says / writes / calls is captured in:
//   data/_blind_runs/p0011x-followup-d-<ts>/events.ndjson
//   data/_blind_runs/p0011x-followup-d-<ts>/final-message.txt
//   data/_blind_runs/p0011x-followup-d-<ts>/summary.json

import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  HermesSessionClient,
  type TurnToolCall,
} from '#platform/runtime/hermes/session-client.js';
import { resolveHermesWsUrl } from '#platform/runtime/hermes/resolve-url.js';

const TURN_TIMEOUT_MS = 60 * 60_000; // 60 min — D is a continuation; give it room
const GOAL_PATH = resolve(process.cwd(), 'data', '_blind_runs', 'p0011x-followup-d-goal.md');
const RUN_ROOT = resolve(
  process.cwd(),
  'data',
  '_blind_runs',
  `p0011x-followup-d-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

const appendNdjson = async (path: string, obj: unknown): Promise<void> => {
  await appendFile(path, JSON.stringify(obj) + '\n', 'utf8');
};

const main = async (): Promise<void> => {
  await mkdir(RUN_ROOT, { recursive: true });

  const eventsPath = resolve(RUN_ROOT, 'events.ndjson');
  const toolCallsPath = resolve(RUN_ROOT, 'tool-calls.ndjson');
  const summaryPath = resolve(RUN_ROOT, 'summary.json');
  const finalMessagePath = resolve(RUN_ROOT, 'final-message.txt');
  const goalCopyPath = resolve(RUN_ROOT, 'goal.txt');

  // Load the continuation goal (the contract with Hermes).
  const goal = await readFile(GOAL_PATH, 'utf8');
  await writeFile(goalCopyPath, goal, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[p0011x-d] goal loaded (${goal.length} chars) from ${GOAL_PATH}`);
  // eslint-disable-next-line no-console
  console.log(`[p0011x-d] run dir: ${RUN_ROOT}`);

  // Connect to Hermes.
  const url = resolveHermesWsUrl();
  const client = new HermesSessionClient({ url });
  try {
    await client.connect();
    // eslint-disable-next-line no-console
    console.log(`[p0011x-d] connected: ${url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendNdjson(eventsPath, { kind: 'fatal', stage: 'connect', error: message });
    // eslint-disable-next-line no-console
    console.error(`[p0011x-d] connect failed: ${message}`);
    process.exit(1);
  }

  // Session at repo root so Hermes can read its own previous scripts and logs.
  const cwd = process.cwd();
  const session = await client.createSession({ cwd });
  // eslint-disable-next-line no-console
  console.log(`[p0011x-d] session: ${session.sessionId} (cwd=${cwd})`);
  await appendNdjson(eventsPath, { kind: 'session.created', session_id: session.sessionId, cwd, goal_path: goalCopyPath });

  const turnStart = Date.now();
  const result = await client.submitTurnAndCollect(session.sessionId, goal, {
    timeoutMs: TURN_TIMEOUT_MS,
    onProgress: {
      onTurnStart: () => {
        // eslint-disable-next-line no-console
        console.log('[p0011x-d] turn.start');
        void appendNdjson(eventsPath, { kind: 'turn.start', at_ms: Date.now() - turnStart });
      },
      onMessageDelta: (text) => {
        void appendNdjson(eventsPath, {
          kind: 'message.delta',
          at_ms: Date.now() - turnStart,
          text_preview: text.length > 200 ? text.slice(-200) : text,
        });
      },
      onToolStart: (toolId, name, args) => {
        // eslint-disable-next-line no-console
        console.log(`[p0011x-d] tool.start ${name}`);
        void appendNdjson(eventsPath, {
          kind: 'tool.start',
          at_ms: Date.now() - turnStart,
          tool_id: toolId,
          name,
          args_preview: typeof args === 'string' ? args.slice(0, 600) : '<non-string>',
        });
      },
      onToolComplete: (toolId, name, result, duration_s) => {
        // eslint-disable-next-line no-console
        console.log(`[p0011x-d] tool.complete ${name} (${duration_s.toFixed(1)}s)`);
        void appendNdjson(eventsPath, {
          kind: 'tool.complete',
          at_ms: Date.now() - turnStart,
          tool_id: toolId,
          name,
          duration_s,
          result_preview:
            result === null || result === undefined
              ? null
              : typeof result === 'string'
                ? result.slice(0, 600)
                : JSON.stringify(result).slice(0, 600),
        });
      },
      onTurnComplete: () => {
        // eslint-disable-next-line no-console
        console.log('[p0011x-d] turn.complete');
        void appendNdjson(eventsPath, { kind: 'turn.complete', at_ms: Date.now() - turnStart });
      },
    },
  });

  // Persist tool call records (raw).
  for (const tc of result.toolCalls) {
    await appendNdjson(toolCallsPath, {
      tool_id: tc.toolId,
      name: tc.name,
      duration_s: tc.duration_s ?? null,
      args: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
      result: tc.result === null || tc.result === undefined ? null : tc.result,
    });
  }

  // Persist final message.
  await writeFile(finalMessagePath, result.messageText ?? '', 'utf8');

  // Summary manifest.
  const summary = {
    run_id: RUN_ROOT.split('/').pop() ?? RUN_ROOT,
    run_dir: RUN_ROOT,
    goal_path: goalCopyPath,
    events_path: eventsPath,
    tool_calls_path: toolCallsPath,
    final_message_path: finalMessagePath,
    session_id: session.sessionId,
    cwd,
    started_at: new Date(turnStart).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - turnStart,
    turn_status: result.error ? 'error' : 'completed',
    turn_error: result.error ?? null,
    final_message_chars: result.messageText.length,
    tool_call_count: result.toolCalls.length,
    tool_call_distribution: result.toolCalls.reduce<Record<string, number>>((acc, tc) => {
      acc[tc.name] = (acc[tc.name] ?? 0) + 1;
      return acc;
    }, {}),
    fabric_explore_called: result.toolCalls.some((tc) => tc.name.startsWith('mcp__fabric__')),
    browser_exec_called: result.toolCalls.some((tc) => tc.name === 'browser_exec'),
    terminal_called: result.toolCalls.some((tc) => tc.name === 'terminal'),
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  // eslint-disable-next-line no-console
  console.log('[p0011x-d] ===== summary =====');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));

  try {
    client.close();
  } catch {
    // ignore
  }
};

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[p0011x-d] fatal:', err);
  process.exit(1);
});
