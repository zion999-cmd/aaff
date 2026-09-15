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
  // ---- P0013.2 Evidence Resolution — V1 binding: Replay order evidence ----
  //
  // Read-only retrieval over the FROZEN historical dataset of a Replay run.
  // This is NOT live acquisition: it answers an order-structure question
  // (amount bands, ex-top1 AOV, top orders, SKU mix) from rows the system
  // already holds. Server enforces business_date <= run cursor.
  {
    name: 'fabric_replay_retrieve_orders',
    description:
      'Retrieve frozen order-detail rows already held for a Historical Replay run, to answer an ' +
      'order-structure question WITHOUT new acquisition: full per-day parent orders (price bands, ' +
      'ex-top1 AOV), top contributing orders, SKU child lines, per-SKU GMV contribution. ' +
      'Read-only; future-dated rows are never returned. Use this BEFORE declaring an order-structure gap. ' +
      'It cannot answer buyer identity or refund/cancel status (those fields do not exist in the frozen rows).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Replay run id (from the prompt Run context).' },
        businessDate: { type: 'string', description: 'Business date YYYY-MM-DD (<= current business date).' },
        query: {
          type: 'string',
          enum: [
            'parentOrdersByDay',
            'topContributingOrders',
            'skuLinesByDay',
            'skuGmvContribution',
            'perSkuDailyOrders',
          ],
          description: 'Retrieval shape.',
        },
        topN: { type: 'number', description: 'Optional N for topContributingOrders (default 10).' },
        skuId: { type: 'number', description: 'Required for perSkuDailyOrders.' },
      },
      required: ['runId', 'businessDate', 'query'],
    },
  },
  // ---- P0011.x — Generic Exploration Tools (additive, host-agnostic) ----
  //
  // These 7 tools are deliberately generic. Their descriptions do not name
  // any host, any endpoint, or any provider-specific path. The orchestrator
  // (a Python script) carries the same genericity in the orchestrator's own
  // surface. Together they let Hermes reason about an unknown external
  // system without ever receiving a ground-truth endpoint name.
  //
  // The tool bodies call a small set of JSON-RPC over HTTP endpoints that the
  // orchestrator exposes (`/api/explore/*`). Those endpoints are intentionally
  // host-agnostic too. The MCP server is the only place a generic tool name
  // is bound to a real wire call; the wire call itself is generic.
  {
    name: 'fabric_browser_inspect_surface',
    description:
      'Enumerate actionable elements on the current page (anchors, buttons, role=button, inputs, ' +
      'elements whose class hints at download / export / tab). Returns a structured list. ' +
      'Use this to discover what the user could click on the current page without assuming any ' +
      'endpoint or vendor-specific selector.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page URL to inspect (omit to use the active tab)' },
      },
    },
  },
  {
    name: 'fabric_browser_interact',
    description:
      'Perform a single deterministic browser action: click, hover, fill, select, or date_pick. ' +
      'Returns the structured result of the action and the URL the page settled on. ' +
      'Call this with selectors returned by `inspect_surface`. Do NOT hardcode selectors ' +
      'the inspector has not surfaced.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS / role / text selector (from inspect_surface)' },
        action: { type: 'string', enum: ['click', 'hover', 'fill', 'select', 'date_pick'] },
        value: { type: 'string', description: 'For fill / select / date_pick — the value to set' },
      },
      required: ['selector', 'action'],
    },
  },
  {
    name: 'fabric_browser_inspect_network',
    description:
      'Return the structured network log: every ajax / fetch / beacon / download request the ' +
      'page has issued since the last reset. Each entry has a transport tag, url, method, ' +
      'status, body preview, and an optional `initiator` (the DOM element that triggered it). ' +
      'Use this to find new business data calls after a click.',
    inputSchema: {
      type: 'object',
      properties: {
        since_ms: { type: 'number', description: 'Epoch ms — only return entries newer than this' },
      },
    },
  },
  {
    name: 'fabric_browser_detect_download',
    description:
      'Return the download-event log: Content-Disposition responses and window.URL.createObjectURL ' +
      'blob creations. These are the signals for "this page produced a downloadable file". ' +
      'Use this after a click on a download / export / report element.',
    inputSchema: {
      type: 'object',
      properties: {
        since_ms: { type: 'number', description: 'Epoch ms — only return events newer than this' },
      },
    },
  },
  {
    name: 'fabric_browser_inspect_response',
    description:
      'Given a request_id from `inspect_network`, return the response body shape (top-level keys, ' +
      'field types, sample values). Use this to determine whether a captured call is a real ' +
      'business endpoint before recording it as a discovery candidate.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'request_id from inspect_network' },
      },
      required: ['request_id'],
    },
  },
  {
    name: 'fabric_browser_replay_verify',
    description:
      'Re-issue a captured request with mutated query params (e.g. change date, change filter). ' +
      'Returns the new response status, code, and a structured diff of changed fields. ' +
      'Use this to confirm that a candidate endpoint is a real, parameter-sensitive business ' +
      'capability rather than a static asset. `mutate` is a partial override of the captured ' +
      'request payload.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'request_id from inspect_network' },
        mutate: {
          type: 'object',
          description: 'Partial override of the request payload (host-agnostic keys)',
          additionalProperties: true,
        },
      },
      required: ['request_id'],
    },
  },
  {
    name: 'fabric_browser_record_discovery',
    description:
      'Persist a captured candidate as a discovery record: url_pattern, transport, trigger, intent, ' +
      'fields, sample. Returns the assigned endpoint_id. Use this only AFTER inspect_response ' +
      'confirmed the candidate is a real business endpoint AND replay_verify confirmed it is ' +
      'parameter-sensitive. Recording without verification stays in status `captured` and never ' +
      'becomes a verified capability.',
    inputSchema: {
      type: 'object',
      properties: {
        url_pattern: { type: 'string', description: 'URL template (with {param} placeholders)' },
        transport: { type: 'string', enum: ['xhr', 'fetch', 'beacon', 'navigation', 'download'] },
        trigger: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['click', 'route', 'navigation', 'timer', 'form_submit', 'unknown'] },
            selector: { type: 'string' },
            text: { type: 'string' },
            at_ms: { type: 'number' },
          },
        },
        intent: { type: 'string', enum: ['page_query', 'history', 'drill_in', 'export', 'analytics', 'unknown'] },
        fields: { type: 'array', items: { type: 'string' } },
        sample: { type: 'object', description: 'Small redacted body sample', additionalProperties: true },
      },
      required: ['url_pattern', 'transport', 'intent', 'fields'],
    },
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
    // ---- P0013.2 — Replay order evidence retrieval (read-only) ----
    if (name === 'fabric_replay_retrieve_orders') {
      const { runId, businessDate, query, topN, skuId } = args;
      if (!runId || !businessDate || !query) {
        send({
          jsonrpc: '2.0',
          id,
          result: textContent('Missing required args: runId, businessDate, query', true),
        });
        return;
      }
      const res = await fetch(
        `${FABRIC_BASE_URL}/api/replay/runs/${encodeURIComponent(runId)}/orders/retrieve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            businessDate,
            query,
            ...(topN != null ? { queryParams: { topN } } : {}),
            ...(skuId != null ? { queryParams: { skuId } } : {}),
          }),
        },
      );
      const body = await res.json();
      if (!res.ok || !body?.success) {
        send({
          jsonrpc: '2.0',
          id,
          result: textContent(body?.error ?? `retrieval failed (${res.status})`, true),
        });
        return;
      }
      const rawRows = Array.isArray(body.data?.rows) ? body.data.rows : [];
      // Compact projection — do NOT pour the full raw schema into context.
      const project = (r) => ({
        order_id: String(r.order_id),
        date: r.biz_date,
        kind: r.row_kind,
        sku_id: r.sku_id,
        sku_name: typeof r.sku_name === 'string' ? r.sku_name.slice(0, 40) : r.sku_name,
        qty: r.sale_qty,
        amount: r.ord_amt,
        pay: r.pay_method_desc,
      });
      const rows = rawRows.map(project);
      const headers = rows.filter((r) => r.kind === 'header');
      const amounts = headers.map((r) => Number(r.amount) || 0).sort((a, b) => a - b);
      const bands = [0, 0, 0, 0, 0]; // 0-50, 50-100, 100-300, 300-1000, 1000+
      for (const a of amounts) {
        if (a < 50) bands[0] += 1;
        else if (a < 100) bands[1] += 1;
        else if (a < 300) bands[2] += 1;
        else if (a < 1000) bands[3] += 1;
        else bands[4] += 1;
      }
      const sum = amounts.reduce((a, b) => a + b, 0);
      const payload = {
        query,
        businessDate,
        rowCount: rows.length,
        summary: {
          parent_orders: headers.length,
          gmv: Number(sum.toFixed(2)),
          ...(headers.length ? { average_order_amount: Number((sum / headers.length).toFixed(2)) } : {}),
          order_amount_bands: {
            '0-50': bands[0],
            '50-100': bands[1],
            '100-300': bands[2],
            '300-1000': bands[3],
            '1000+': bands[4],
          },
          fields_unavailable: ['buyer_identity', 'refund_or_cancel_status'],
        },
        rows,
      };
      send({ jsonrpc: '2.0', id, result: textContent(JSON.stringify(payload, null, 2)) });
      return;
    }
    // ---- P0011.x — Generic Exploration Tools ----
    //
    // Each tool forwards to a /api/explore/<name> endpoint on the dev server.
    // The endpoint may return 404 in a fresh server (the orchestrator route
    // is not yet registered in this scope). The fallback is a structured
    // envelope that tells Hermes what the tool would do, so Hermes can
    // still reason about the next step. Real orchestrator wiring is
    // out of scope; this keeps the MCP surface forward-compatible.
    if (name && name.startsWith('fabric_browser_')) {
      const tool = name.replace('fabric_browser_', '');
      const wirePath = `/api/explore/${tool}`;
      let wireEnvelope = null;
      try {
        const res = await fetch(`${FABRIC_BASE_URL}${wirePath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        });
        if (res.ok) {
          const body = await res.json();
          wireEnvelope = body?.data ?? body;
        }
      } catch {
        // orchestrator not running or route missing — fall through
      }
      const envelope = wireEnvelope ?? {
        status: 'not_wired',
        tool,
        reason:
          'orchestrator route not registered on this dev server; the tool surface is reserved ' +
          'but the wire call is not in scope of this change. Hermes should record this gap.',
        received_args: args,
      };
      send({ jsonrpc: '2.0', id, result: textContent(JSON.stringify(envelope, null, 2), wireEnvelope == null) });
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
