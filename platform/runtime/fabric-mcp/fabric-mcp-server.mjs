#!/usr/bin/env node
// Fabric Execution Boundary — a minimal MCP (Model Context Protocol) stdio server.
// P0009: exposes the Fabric Runtime execution capability to Hermes as an MCP tool.
//
// Hermes config (per profile):  mcp_servers.fabric = { command: "node", args: ["<abs>/fabric-mcp-server.mjs"] }
//
// This is a THIN HTTP bridge: it does NOT import the Fabric kernel. It forwards
// `tools/call` to the running agentFabric server's /api/fabric/execute endpoint,
// so the kernel / JD connector / evidence store stay in the server (single source
// of truth). No external deps — stdio JSON-RPC + global fetch only.

import { createInterface } from 'node:readline';
import process from 'node:process';

const FABRIC_BASE_URL = process.env.FABRIC_BASE_URL ?? 'http://localhost:3000';
const SERVER_INFO = { name: 'agentfabric-fabric-execution', version: '0.1.0' };

// ---- Lifecycle diagnostics (P0010.2.x followup, READ-ONLY behavior) ----
// Purpose: leave exit-cause evidence in stderr for the next MCP death.
// No behavior change beyond adding a stderr log line per event. NO keep-alive,
// NO respawn, NO stdin-EOF suppression, NO payload / token / header / env dump.
const _oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 200);
const diag = (event, fields = {}) => {
  const ts = new Date().toISOString();
  const parts = Object.entries(fields)
    .map(([k, v]) => `${k}=${_oneLine(v)}`)
    .join(' ');
  process.stderr.write(
    `[fabric-mcp] ${ts} pid=${process.pid} ppid=${process.ppid} event=${event} ${parts}\n`,
  );
};
// Startup banner (no token / no env / no payload — only metadata).
diag('startup', {
  node: process.version,
  script: process.argv[1] ? process.argv[1].split('/').pop() : '',
  cwd: process.cwd().split('/').pop() || '/',
  fabricBaseUrl: FABRIC_BASE_URL, // local URL only, not a credential
});
// stdin: EOF / close are the two signals MCP-client teardown produces.
process.stdin.on('end', () => {
  diag('stdin_end');
  // Do NOT prevent default — let readline's normal end-of-input flow take over.
});
process.stdin.on('close', () => {
  diag('stdin_close');
});
// stdout: EPIPE means the MCP client tore down the read pipe before we flushed.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    diag('stdout_epipe');
  } else {
    diag('stdout_error', { code: err && err.code ? err.code : 'unknown' });
  }
  // Default: do not swallow — let Node's stdout.on('error') propagate.
});
// Signals: log, then exit with the conventional code for that signal.
process.on('SIGTERM', () => {
  diag('sigterm');
  process.exit(128 + 15); // 143, default for SIGTERM
});
process.on('SIGPIPE', () => {
  diag('sigpipe');
  process.exit(128 + 13); // 141, default for SIGPIPE
});
process.on('SIGHUP', () => {
  diag('sighup');
  process.exit(128 + 1); // 129, default for SIGHUP
});
process.on('SIGINT', () => {
  diag('sigint');
  process.exit(128 + 2); // 130, default for SIGINT
});
// beforeExit / exit: pure sync. No async work.
process.on('beforeExit', (code) => {
  diag('before_exit', { code });
});
process.on('exit', (code) => {
  process.stderr.write(
    `[fabric-mcp] ${new Date().toISOString()} pid=${process.pid} event=exit code=${code === null || code === undefined ? 'null' : code}\n`,
  );
});
// Last-resort: uncaught + unhandled. Log then exit non-zero (mimics default).
process.on('uncaughtException', (err) => {
  diag('uncaught_exception', {
    name: err && err.name ? err.name : 'Error',
    message: err && err.message ? err.message : '',
  });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const isErr = reason instanceof Error;
  diag('unhandled_rejection', {
    name: isErr ? reason.name : 'NonError',
    message: isErr ? reason.message : String(reason),
  });
  process.exit(1);
});

// ---- MCP protocol (JSON-RPC 2.0 over stdio, newline-delimited) ----

const TOOLS = [
  {
    name: 'fabric_execute_capability',
    description:
      'Execute a Fabric data capability against the live JD (京东商智) system and return real evidence. ' +
      'Choose this when the user needs fresh JD business data (e.g. traffic, trade, product metrics). ' +
      'Arguments: capability (e.g. "traffic.overview"), optional shopId, optional date (YYYY-MM-DD).',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'Capability id, e.g. traffic.overview / trade.overview' },
        shopId: { type: 'string', description: 'Shop id (default jd_shop_001)' },
        date: { type: 'string', description: 'Target date YYYY-MM-DD (default today)' },
      },
      required: ['capability'],
    },
  },
  {
    name: 'fabric_list_capabilities',
    description:
      'List the Fabric data capabilities available in this workspace (what live JD data can be acquired).',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** Write a JSON-RPC response/notification to stdout (the MCP channel). */
const send = (obj) => {
  process.stdout.write(JSON.stringify(obj) + '\n');
};

const handleInitialize = (id) => {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    },
  });
};

const handleToolsList = (id) => {
  send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
};

const textContent = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  isError,
});

const handleToolsCall = async (id, params) => {
  const name = params?.name;
  const args = (params?.arguments ?? {}) || {};
  try {
    if (name === 'fabric_list_capabilities') {
      const res = await fetch(`${FABRIC_BASE_URL}/api/capabilities`);
      const body = await res.json();
      const caps = (body?.data?.capabilities ?? body?.capabilities ?? []);
      const summary = caps
        .map((c) => `${c.capability} — ${c.name} (${c.domain}, ${c.validation?.status ?? 'unknown'})`)
        .join('\n');
      send({ jsonrpc: '2.0', id, result: textContent(summary || '(none)') });
      return;
    }
    if (name === 'fabric_execute_capability') {
      const capability = args.capability;
      if (!capability) {
        send({ jsonrpc: '2.0', id, result: textContent('Missing required arg: capability', true) });
        return;
      }
      const res = await fetch(`${FABRIC_BASE_URL}/api/fabric/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability,
          shopId: args.shopId ?? 'jd_shop_001',
          ...(args.date ? { date: args.date } : {}),
        }),
      });
      const body = await res.json();
      const payload = body?.data ?? body;
      const text = JSON.stringify(payload, null, 2);
      send({ jsonrpc: '2.0', id, result: textContent(text, payload?.success === false) });
      return;
    }
    send({ jsonrpc: '2.0', id, result: textContent(`Unknown tool: ${name}`, true) });
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      result: textContent(`Fabric execution failed: ${err instanceof Error ? err.message : String(err)}`, true),
    });
  }
};

const dispatch = async (msg) => {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — ignore
  if (method === 'initialize') return handleInitialize(id);
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return handleToolsList(id);
  if (method === 'tools/call') return handleToolsCall(id, params);
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON lines
  }
  dispatch(msg).catch((err) => {
    // Last-resort: report an internal error on the wire.
    send({ jsonrpc: '2.0', id: msg?.id, error: { code: -32603, message: String(err) } });
  });
});
