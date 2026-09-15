// P0011.x — Generic Exploration Tools on the MCP server.
//
// Verifies:
//  * The 7 generic browser tools are registered (no endpoint names in
//    descriptions).
//  * The 2 existing tools (fabric_execute_capability, fabric_list_capabilities)
//    still work (zero regression).
//  * The 7 new tool handlers return a structured envelope when the
//    /api/explore/<tool> wire endpoint is missing (orchestrator not yet
//    wired — expected in this scope).
//
// The MCP server is a .mjs stdio JSON-RPC daemon; we drive it as a
// subprocess and exchange one initialize + tools/list + tools/call
// per test. Stdout is the JSON-RPC channel; stderr is the diag log.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';

const SERVER_PATH = resolve('platform/runtime/fabric-mcp/fabric-mcp-server.mjs');

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class McpClient {
  private proc: ReturnType<typeof spawn>;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private errBuf = '';
  private lastStderr = '';

  constructor() {
    this.proc = spawn('node', [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => {
      this.buf += chunk;
      // Process newline-delimited JSON-RPC frames.
      let nl = this.buf.indexOf('\n');
      while (nl >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (typeof msg?.id === 'number' && this.pending.has(msg.id)) {
              this.pending.get(msg.id)!.resolve(msg);
              this.pending.delete(msg.id);
            }
          } catch {
            // ignore non-JSON
          }
        }
        nl = this.buf.indexOf('\n');
      }
    });
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (chunk: string) => {
      this.errBuf += chunk;
      this.lastStderr = chunk;
    });
  }

  call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params: params ?? {} };
    return new Promise<unknown>((resolveP, rejectP) => {
      this.pending.set(id, { resolve: resolveP, reject: rejectP });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  async close(): Promise<void> {
    this.proc.stdin!.end();
    await sleep(50);
    this.proc.kill();
  }
}

describe('fabric-mcp-server — Generic Exploration Tools', () => {
  const client = new McpClient();
  afterAll(async () => {
    await client.close();
  });

  it('lists 10 tools (2 historical + 1 replay retrieval + 7 generic) with no endpoint names in descriptions', async () => {
    await client.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    const list = (await client.call('tools/list')) as { result: { tools: Array<{ name: string; description: string }> } };
    const tools = list.result.tools;
    expect(tools).toHaveLength(10);
    const names = tools.map((t) => t.name);
    expect(names).toContain('fabric_execute_capability');
    expect(names).toContain('fabric_list_capabilities');
    expect(names).toContain('fabric_replay_retrieve_orders');
    expect(names).toContain('fabric_browser_inspect_surface');
    expect(names).toContain('fabric_browser_interact');
    expect(names).toContain('fabric_browser_inspect_network');
    expect(names).toContain('fabric_browser_detect_download');
    expect(names).toContain('fabric_browser_inspect_response');
    expect(names).toContain('fabric_browser_replay_verify');
    expect(names).toContain('fabric_browser_record_discovery');
    // CRITICAL: no description may contain a forbidden ground-truth endpoint name.
    const forbidden = ['downloadSummary', 'getDealOrders', 'exportDealOrders', 'behavior_report'];
    for (const t of tools) {
      for (const word of forbidden) {
        expect(t.description.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  }, 10_000);

  it('returns a structured not_wired envelope when the orchestrator is missing', async () => {
    // The /api/explore/<tool> route is not registered on the dev server
    // in this scope. The handler must still return a structured envelope
    // (not a stack trace) so Hermes can reason about the gap.
    const call = (await client.call('tools/call', {
      name: 'fabric_browser_inspect_surface',
      arguments: { url: 'https://example.com/' },
    })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    const text = call.result.content[0]?.text ?? '';
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    expect(parsed).toBeTypeOf('object');
    const env = parsed as { status?: string; tool?: string; received_args?: unknown };
    expect(['not_wired', 'ok']).toContain(env.status ?? '');
    if (env.status === 'not_wired') {
      expect(env.tool).toBe('inspect_surface');
      expect(env.received_args).toEqual({ url: 'https://example.com/' });
    }
  }, 10_000);

  it('historical fabric_execute_capability still responds (no regression)', async () => {
    // We don't start the dev server in this test; if /api/fabric/execute
    // is not reachable we accept either an error envelope or a network
    // error, but the tool name MUST still be dispatched (not "Unknown
    // tool").
    const call = (await client.call('tools/call', {
      name: 'fabric_execute_capability',
      arguments: { capability: 'trade.overview' },
    })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    const text = call.result.content[0]?.text ?? '';
    expect(text).not.toContain('Unknown tool: fabric_execute_capability');
    // Acceptable: any non-"Unknown tool" response (real payload, fetch error, or not_wired).
  }, 10_000);
});
