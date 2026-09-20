// P0011.x — Thin Exploration Entry.
//
// POST /api/explore/run
//
// Body:
//   {
//     "prompt":      "explore trade data surface...",
//     "toolsets":    "browser-exploration"     (string | string[]; optional)
//     "max_actions": 20                        (int; optional)
//     "timeout_ms":  600000                    (int; optional)
//     "cwd":         "/abs/path"               (optional)
//   }
//
// Behavior:
//   1. Creates a Hermes session (cwd = current working dir or provided).
//   2. Calls `submitTurnAndCollect` with the given prompt.
//   3. Streams a transcript of message.delta / tool.start / tool.complete
//      to the response via NDJSON (one JSON object per line).
//   4. Ends the stream with a final `{kind:"turn.result", turnResult}`.
//
// This endpoint does NOT reason. It does NOT decide what to do next.
// It is a thin bridge between agentFabric's HTTP layer and Hermes's
// native MCP-driven tool loop. The model lives in Hermes; the model
// decides; we only collect events.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { resolve } from 'node:path';
import {
  HermesSessionClient,
  type TurnObserver,
} from '#platform/runtime/hermes/session-client.js';
import { HermesOneShotRequestSchema } from '#platform/runtime/hermes/types.js';
import { resolveHermesWsUrl } from '#platform/runtime/hermes/resolve-url.js';

const exploreRunSchema = z.object({
  prompt: z.string().min(1),
  toolsets: z.union([z.string(), z.array(z.string())]).optional(),
  max_actions: z.number().int().positive().max(100).optional(),
  timeout_ms: z.number().int().positive().max(30 * 60_000).optional(),
  cwd: z.string().optional(),
});

export const exploreRunRouter = Router();

exploreRunRouter.post('/run', async (req: Request, res: Response) => {
  // Validate the body — but NEVER inspect prompt contents (no leakage).
  let args: z.infer<typeof exploreRunSchema>;
  try {
    const parsed = exploreRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.message });
      return;
    }
    args = parsed.data;
  } catch {
    res.status(400).json({ success: false, error: 'invalid body' });
    return;
  }

  const url = resolveHermesWsUrl();
  const client = new HermesSessionClient({ url });
  try {
    await client.connect();
  } catch (err) {
    res.status(503).json({
      success: false,
      error: `hermes connect failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
  const session = await client.createSession({ cwd });

  // Normalize toolsets → comma-joined string (Hermes oneShot schema).
  // P0011.x — unified Fabric MCP toolset is `mcp-fabric` (server name `fabric`
  // is the registered alias). The 7 fabric_browser_* Exploration tools live
  // under this single toolset after Step 1's `mcp_servers.fabric_browser`
  // removal. Verified at runtime: tools.list + tools.show on a real session
  // show `mcp-fabric` with 9 tools (2 fabric_execute + 7 fabric_browser_*).
  const toolsetsStr = Array.isArray(args.toolsets)
    ? args.toolsets.join(',')
    : (args.toolsets ?? 'mcp-fabric');
  const validate = HermesOneShotRequestSchema.parse({
    prompt: args.prompt,
    toolsets: toolsetsStr,
  });
  // Note: validate.prompt is the user prompt. We do NOT inject any JD
  // vocabulary, endpoint name, or DOM selector into it. The model decides.

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (obj: unknown) => {
    try {
      res.write(JSON.stringify(obj) + '\n');
    } catch {
      // ignore
    }
  };

  const observer: TurnObserver = {
    onTurnStart: () => write({ kind: 'turn.start', sessionId: session.sessionId }),
    onMessageDelta: (text) => write({ kind: 'message.delta', text }),
    onToolStart: (toolId, name, args) =>
      write({ kind: 'tool.start', tool_id: toolId, name, args }),
    onToolComplete: (toolId, name, result, duration_s) =>
      write({ kind: 'tool.complete', tool_id: toolId, name, result, duration_s }),
    onTurnComplete: () => write({ kind: 'turn.complete' }),
  };

  try {
    const result = await client.submitTurnAndCollect(
      session.sessionId,
      validate.prompt,
      {
        timeoutMs: args.timeout_ms ?? 10 * 60_000,
        onProgress: observer,
      },
    );
    write({ kind: 'turn.result', turnResult: result });
  } catch (err) {
    write({ kind: 'turn.error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    try { res.end(); } catch { /* ignore */ }
    try { client.close(); } catch { /* ignore */ }
  }
});
