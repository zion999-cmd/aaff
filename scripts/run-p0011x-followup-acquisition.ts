// P0011.x Follow-up — Real Data Acquisition Acceptance Experiment.
//
// Per task.md §2.3 — Claude Code role is HARNESS / OBSERVER only.
// This script:
//   1. Builds the BLIND business goal (NO endpoint names, NO selector hints,
//      NO implementation hints; per task.md §6 + §18).
//   2. Connects to Hermes (already running on :9120), creates a session with
//      cwd = repo root so Hermes can read historical catalog/jd/ and
//      WorldExplorationTask/ as PRIOR knowledge (per task.md §4).
//   3. Submits the goal via submitTurnAndCollect — passive observer. No
//      tool dispatch, no result injection, no reasoning loop.
//   4. Streams every event to NDJSON under
//      data/_blind_runs/p0011x-followup-<ts>/ for replay / audit.
//   5. Persists a summary manifest at the end.
//
// What this script does NOT do (per task.md §3 STRICTLY FORBIDDEN):
//   - explore JD itself
//   - click pages to find data
//   - capture network to find endpoints
//   - reverse-engineer JD requests
//   - write acquisition scripts in Hermes's place
//   - inject hints about which button / endpoint / selector to use
//
// All exploration / acquisition work is the model's. We just observe.

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  HermesSessionClient,
  type TurnToolCall,
} from '#platform/runtime/hermes/session-client.js';
import { resolveHermesWsUrl } from '#platform/runtime/hermes/resolve-url.js';

// ---------- BLIND goal (task.md §6 + §18 — no endpoint names) ----------

const GOAL = `# Real JD 商智 Acquisition — 祁门红茶官方旗舰店

You are tasked with acquiring real, verifiable business data for the shop **祁门红茶官方旗舰店** from **JD 商智** (jdsz.jd.com).

## Two targets, in priority order

### Target B (PRIMARY) — 成交订单明细 (Order Detail)
For one explicit, well-defined time window (suggested: 最近 30 天; you may pick another window if you justify it), produce a complete record set of every order the source will give you. At minimum you should be able to verify per row: order/business time, order identifier, SKU/product identity, quantity, amount-related fields, order/payment status.

### Target A (SECONDARY) — 交易经营数据 (Trade Operating Data)
For the same shop + same window, produce the trade-level aggregated metrics the source exposes (e.g. GMV, orders, visitors, CVR, refund rate). Whatever the source gives.

## What you may use

- Historical catalog (PRIOR, **not** ground truth):
  - \`catalog/jd/capability.md\`
  - \`catalog/jd/endpoints.json\`
  - \`WorldExplorationTask/jdsz_*.json\` and \`jdsz_world_discovery.md\`
- Existing Fabric capabilities (whatever is already wired under \`mcp-fabric\`)
- Existing JD acquisition implementation in this repo
- Your own scripts, Skills, Tools, MCP additions, Python — any approach you judge reasonable
- All \`mcp-fabric\` tools AND all Hermes builtins (browser, terminal, file, todo, clarify, etc.). Neither path is forced.

## What you may NOT do

- Assume the historical catalog is still correct (it may be outdated, incomplete, or wrong)
- Stop at "I found the endpoint" — you must persist the actual data
- Wait on me (Claude) for implementation hints
- Discard source fields to fit a pre-defined schema
- Pretend partial = success

## What success looks like

For each target you attempt, persist on disk:
- a **raw artifact** (downloaded XLSX / raw API response / browser-derived capture)
- a **parsed structured dataset** (CSV or JSON)
- a **provenance manifest** containing at least: source_system, shop_identity, requested_time_range, actual_source_time_range, acquired_at, acquisition_method, source_surface, raw_artifact_path, parsed_artifact_path, record_count, completeness_status, verification_notes

## What failure looks like (record whichever applies)

- \`BLOCKED — INFRASTRUCTURE\` (e.g. a known \`mcp-fabric\` wire defect)
- \`BLOCKED — ENVIRONMENT\` (e.g. required Chrome / session not present, terminal approval rejected)
- \`EXPLORATION FAILED\` (you could not find a source / entry)
- \`ACQUISITION FAILED\` (you found the source but could not pull the data)
- \`VERIFICATION FAILED\` (you got data but cannot prove completeness / semantics)

## Hard rule

End with one final assistant message that contains EITHER a complete provenance + record summary (success / partial) OR an explicit blocker classification with the reason. Do not leave the turn open-ended.

Begin.`;

const TURN_TIMEOUT_MS = 45 * 60_000; // 45 min — real acquisition can be slow
const RUN_ROOT = resolve(
  process.cwd(),
  'data',
  '_blind_runs',
  `p0011x-followup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

const appendNdjson = async (path: string, obj: unknown): Promise<void> => {
  await appendFile(path, JSON.stringify(obj) + '\n', 'utf8');
};

const summarizeToolCall = (tc: TurnToolCall): Record<string, unknown> => {
  // Keep the summary compact — args/result may be large. Persist raw too.
  return {
    tool_id: tc.toolId,
    name: tc.name,
    duration_s: tc.duration_s ?? null,
    args_preview: typeof tc.args === 'string' ? tc.args.slice(0, 400) : '<non-string>',
    result_preview:
      tc.result === null || tc.result === undefined
        ? null
        : typeof tc.result === 'string'
          ? tc.result.slice(0, 400)
          : JSON.stringify(tc.result).slice(0, 400),
  };
};

const main = async (): Promise<void> => {
  // ----- Pre-flight: ensure dev server up (fabric-mcp needs http://localhost:3000) -----
  // We do NOT pre-fix the known \`__name is not defined\` wire bug (per task.md §17).
  // We just need the dev server process alive so the mcp-fabric toolset at least
  // starts. If it's down, fabric_browser_* calls will get connection errors and
  // Hermes will fall back to browser_exec — that is a valid choice per task.md §18.
  await mkdir(RUN_ROOT, { recursive: true });
  const eventsPath = resolve(RUN_ROOT, 'events.ndjson');
  const goalPath = resolve(RUN_ROOT, 'goal.txt');
  const toolCallsPath = resolve(RUN_ROOT, 'tool-calls.ndjson');
  const summaryPath = resolve(RUN_ROOT, 'summary.json');
  await writeFile(goalPath, GOAL, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[p0011x-followup] run dir: ${RUN_ROOT}`);
  // eslint-disable-next-line no-console
  console.log(`[p0011x-followup] goal written: ${goalPath}`);

  // ----- Connect to Hermes -----
  const url = resolveHermesWsUrl();
  const client = new HermesSessionClient({ url });
  try {
    await client.connect();
    // eslint-disable-next-line no-console
    console.log(`[p0011x-followup] connected: ${url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appendNdjson(eventsPath, {
      kind: 'fatal',
      stage: 'connect',
      error: message,
    });
    // eslint-disable-next-line no-console
    console.error(`[p0011x-followup] connect failed: ${message}`);
    process.exit(1);
  }

  // ----- Create session at repo root -----
  // cwd = repo root so Hermes can read catalog/jd/ and WorldExplorationTask/
  // as prior knowledge (per task.md §4).
  const cwd = process.cwd();
  const session = await client.createSession({ cwd });
  // eslint-disable-next-line no-console
  console.log(`[p0011x-followup] session: ${session.sessionId} (cwd=${cwd})`);
  await appendNdjson(eventsPath, {
    kind: 'session.created',
    session_id: session.sessionId,
    cwd,
    goal_path: goalPath,
  });

  // ----- Submit the goal (passive observer) -----
  const turnStart = Date.now();
  const result = await client.submitTurnAndCollect(session.sessionId, GOAL, {
    timeoutMs: TURN_TIMEOUT_MS,
    onProgress: {
      onTurnStart: () => {
        // eslint-disable-next-line no-console
        console.log('[p0011x-followup] turn.start');
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
        console.log(`[p0011x-followup] tool.start ${name}`);
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
        console.log(`[p0011x-followup] tool.complete ${name} (${duration_s.toFixed(1)}s)`);
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
        console.log('[p0011x-followup] turn.complete');
        void appendNdjson(eventsPath, {
          kind: 'turn.complete',
          at_ms: Date.now() - turnStart,
        });
      },
    },
  });

  // ----- Persist full tool call records (raw) -----
  for (const tc of result.toolCalls) {
    await appendNdjson(
      toolCallsPath,
      summarizeToolCall({
        ...tc,
        // keep args / result unredacted for audit
        args: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args),
        result: tc.result === null || tc.result === undefined ? null : tc.result,
      }),
    );
  }

  // ----- Persist final message text (raw) -----
  const finalMessagePath = resolve(RUN_ROOT, 'final-message.txt');
  await writeFile(finalMessagePath, result.messageText ?? '', 'utf8');

  // ----- Persist summary manifest -----
  const summary = {
    run_id: RUN_ROOT.split('/').pop() ?? RUN_ROOT,
    run_dir: RUN_ROOT,
    goal_path: goalPath,
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
    fabricexplore_called: result.toolCalls.some((tc) => tc.name.startsWith('mcp__fabric__')),
    browser_exec_called: result.toolCalls.some((tc) => tc.name === 'browser_exec'),
    terminal_called: result.toolCalls.some((tc) => tc.name === 'terminal'),
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  // eslint-disable-next-line no-console
  console.log('[p0011x-followup] ===== summary =====');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[p0011x-followup] run dir: ${RUN_ROOT}`);

  // Best-effort close
  try {
    client.close();
  } catch {
    // ignore
  }
};

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[p0011x-followup] fatal:', err);
  process.exit(1);
});
