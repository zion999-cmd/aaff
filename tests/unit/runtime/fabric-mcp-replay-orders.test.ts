// P0013.2 — MCP tool `fabric_replay_retrieve_orders` registration.
//
// Drives the stdio MCP server and verifies the V1 Evidence Resolution
// binding is present on the tool list. Behavior against the live retrieval
// route is exercised in the integration/real-acceptance paths (the tool
// forwards to POST /api/replay/runs/:id/orders/retrieve and projects
// compact rows); no live server is needed for this structural test.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const SERVER_PATH = resolve('platform/runtime/fabric-mcp/fabric-mcp-server.mjs');

const listTools = async (): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> => {
  const proc = spawn('node', [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const frames: unknown[] = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) frames.push(JSON.parse(line));
      nl = buf.indexOf('\n');
    }
  });
  const send = (obj: unknown) => proc.stdin.write(JSON.stringify(obj) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await sleep(100);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await sleep(150);
  proc.kill();
  const msg = frames.find((f) => (f as { id: number }).id === 2) as {
    result?: { tools?: Array<{ name: string; description: string; inputSchema: unknown }> };
  };
  return msg?.result?.tools ?? [];
};

describe('fabric_replay_retrieve_orders', () => {
  it('is registered as a read-only retrieval tool (V1 Evidence Resolution binding)', async () => {
    const tools = await listTools();
    const tool = tools.find((t) => t.name === 'fabric_replay_retrieve_orders');
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/read-only/i);
    expect(tool?.description).toMatch(/BEFORE declaring/i);
    const schema = tool?.inputSchema as {
      required?: string[];
      properties?: { query?: { enum?: string[] } };
    };
    expect(schema.required).toEqual(expect.arrayContaining(['runId', 'businessDate', 'query']));
    expect(schema.properties?.query?.enum).toEqual(
      expect.arrayContaining(['parentOrdersByDay', 'topContributingOrders', 'skuGmvContribution']),
    );
  });
});
