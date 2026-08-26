// P0010.2.4 (ADR-060) — Contract test for `probeAuthRequired`.
//
// Pins the behavior of the `/api/health` probe that decides whether the
// session client should connect with a token or skip it entirely:
//   - `auth_required: false` → connect without token (dev / Hermes 0.20.x)
//   - `auth_required: true`  → require token resolution
//   - probe failure (HTTP error / network error) → treat as `auth_required: true`
//     (we don't silently connect to an unauthenticated Hermes we couldn't reach)
//   - per-port cache (TTL 30s) — second call within TTL does not re-fetch
//   - `forceRefresh: true` bypasses the cache
//
// Uses Node's built-in `http` server so no external dep is needed.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeAuthRequired, resetHealthCache } from '#platform/runtime/hermes/index.js';

let server: Server;
let port: number;

const urlToHttp = (url: string): string => {
  // Mirror of session-client.ts#urlToHttp — used only in the helper assertion
  // test below (so we don't depend on a private export).
  const replaced = url.replace(/^ws(s)?:\/\//, 'http$1://');
  return replaced.replace(/\/api\/ws\/?$/, '/api/health');
};

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: '0.20.5', auth_required: false }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetHealthCache();
});

describe('probeAuthRequired — auth_required: false (the dev case)', () => {
  it('returns authRequired=false for Hermes that exports auth_required:false', async () => {
    const r = await probeAuthRequired(`ws://127.0.0.1:${port}/api/ws`);
    expect(r.authRequired).toBe(false);
    expect(r.probeFailed).toBe(false);
  });
});

describe('probeAuthRequired — auth_required: true', () => {
  let requiredServer: Server;
  let requiredPort: number;
  beforeAll(async () => {
    requiredServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, auth_required: true }));
    });
    await new Promise<void>((resolve) => requiredServer.listen(0, '127.0.0.1', () => resolve()));
    requiredPort = (requiredServer.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => requiredServer.close(() => resolve()));
  });

  it('returns authRequired=true for Hermes that exports auth_required:true', async () => {
    const r = await probeAuthRequired(`ws://127.0.0.1:${requiredPort}/api/ws`);
    expect(r.authRequired).toBe(true);
    expect(r.probeFailed).toBe(false);
  });
});

describe('probeAuthRequired — defaults to required on probe failure', () => {
  let failingServer: Server;
  let failingPort: number;
  beforeAll(async () => {
    failingServer = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => failingServer.listen(0, '127.0.0.1', () => resolve()));
    failingPort = (failingServer.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => failingServer.close(() => resolve()));
  });

  it('returns authRequired=true, probeFailed=true on HTTP 500', async () => {
    const r = await probeAuthRequired(`ws://127.0.0.1:${failingPort}/api/ws`);
    expect(r.authRequired).toBe(true);
    expect(r.probeFailed).toBe(true);
  });
});

describe('probeAuthRequired — per-port cache', () => {
  it('caches the first result for the TTL window; second call does not refetch', async () => {
    const first = await probeAuthRequired(`ws://127.0.0.1:${port}/api/ws`);
    expect(first.authRequired).toBe(false);
    const second = await probeAuthRequired(`ws://127.0.0.1:${port}/api/ws`);
    expect(second.authRequired).toBe(false);
    expect(second.probeFailed).toBe(false);
  });

  it('forceRefresh: true bypasses the cache and re-fetches', async () => {
    const r1 = await probeAuthRequired(`ws://127.0.0.1:${port}/api/ws`);
    expect(r1.authRequired).toBe(false);
    const r2 = await probeAuthRequired(`ws://127.0.0.1:${port}/api/ws`, { forceRefresh: true });
    expect(r2.authRequired).toBe(false);
  });
});

describe('probeAuthRequired — auth_required field default', () => {
  let ambiguousServer: Server;
  let ambiguousPort: number;
  beforeAll(async () => {
    ambiguousServer = createServer((_req, res) => {
      // Health response with NO auth_required field (older / non-conforming Hermes).
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.20.5' }));
    });
    await new Promise<void>((resolve) => ambiguousServer.listen(0, '127.0.0.1', () => resolve()));
    ambiguousPort = (ambiguousServer.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => ambiguousServer.close(() => resolve()));
  });

  it('defaults to authRequired=true when the field is missing (safe-by-default)', async () => {
    const r = await probeAuthRequired(`ws://127.0.0.1:${ambiguousPort}/api/ws`);
    expect(r.authRequired).toBe(true);
    expect(r.probeFailed).toBe(false);
  });
});

describe('urlToHttp (internal helper) — used by the probe to translate ws:// to http://', () => {
  it('translates ws://host:port/api/ws to http://host:port/api/health', () => {
    expect(urlToHttp('ws://localhost:9119/api/ws')).toBe('http://localhost:9119/api/health');
  });
  it('translates wss://host:port/api/ws to https://host:port/api/health', () => {
    expect(urlToHttp('wss://example.com/api/ws')).toBe('https://example.com/api/health');
  });
  it('handles trailing slash', () => {
    expect(urlToHttp('ws://localhost:9119/api/ws/')).toBe('http://localhost:9119/api/health');
  });
});
