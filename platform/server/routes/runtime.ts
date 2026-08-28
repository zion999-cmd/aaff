// Runtime HTTP Routes — expose Runtime Kernel operations via HTTP.
// P0006: The Runtime Kernel is currently CLI-only. These routes make it accessible
// to the Workspace UI and Chat endpoint via HTTP.
//
// Thin wrappers — all business logic stays in the kernel. These routes are
// HTTP adapters that parse requests, call kernel methods, and return JSON.

import { Router } from 'express';
import type { Database as Db } from 'better-sqlite3';
import { z } from 'zod';
import { fail, ok } from '../envelope.js';
import { createRuntimeKernel, createEmptyBlueprint } from '#app/runtime/kernel/index.js';
import type { RuntimeKernel } from '#app/runtime/kernel/index.js';
import { loadBlueprint } from '#app/connectors/binding/loader.js';
import type { EnterpriseSignal } from '#shared/schemas/signal.js';
import {
  acquireJdMultiPage,
  isCdpAvailable,
  isJdPageAvailable,
} from '#app/connectors/jd/acquisition/cdp-client.js';
import { createCapabilityAcquire } from '#app/connectors/jd/historical-acquire.js';
import { getDataPages } from '#app/connectors/jd/blueprint.js';
import { saveEvidence } from '#app/connectors/evidence/store.js';
import { parseJdPayload } from '#app/connectors/jd/parsers/index.js';
import { SignalFacade } from '#app/analysis/metrics/facade.js';
import { loadEvidence, listEvidence } from '#app/connectors/evidence/store.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
// ADR-064 — 3-layer Hermes runtime health (gateway / session runtime / agent turn).
// `probeAuthRequired` re-probes the Session Runtime on every readiness/status
// call so the cached layer state does not go stale. `health-state` holds the
// agent-turn layer (only updated by the loop) and a stale-tolerant view of the
// session runtime layer.
import { probeAuthRequired } from '#platform/runtime/hermes/session-client.js';
import { getHermesHealth, recordSessionRuntimeProbe } from '#platform/runtime/hermes/health-state.js';
// P0010.2.7 — single source of truth for the Hermes URL. The readiness
// + status routes resolve through the same helper as health-state /
// session-client / token-resolver so a probe against `url` is
// guaranteed to target the same port that the next investigation
// turn will hit. See resolve-url.ts.
import { resolveHermesWsUrl, resolveHermesPort } from '#platform/runtime/hermes/resolve-url.js';

// ---- Request Schemas ----

/** Upper bound for evidence listing in the provenance route (listEvidence caps at 100 by default). */
const EVIDENCE_LIST_LIMIT = 10_000;

const CollectRequestSchema = z.object({
  platform: z.string().default('jd'),
  shopId: z.string().min(1),
  date: z.string().optional(),
  mock: z.boolean().default(true),
  capabilities: z.array(z.string()).optional(),
  shopName: z.string().optional(),
});

const ReplayRequestSchema = z.object({
  shopId: z.string().min(1).default('jd_shop_001'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
});

const FabricExecuteRequestSchema = z.object({
  capability: z.string().min(1),
  shopId: z.string().min(1).default('jd_shop_001'),
  date: z.string().optional(),
});

// ---- Kernel Lazy Initialization ----

let _kernel: RuntimeKernel | null = null;

/** Get or create the RuntimeKernel singleton, with empty blueprint fallback. */
const getKernel = (db: Db): RuntimeKernel => {
  if (_kernel) return _kernel;
  let blueprint;
  try {
    blueprint = loadBlueprint('jd');
  } catch {
    blueprint = createEmptyBlueprint('jd');
  }
  _kernel = createRuntimeKernel(db, blueprint);
  return _kernel;
};

// Fabric execution boundary uses a local-first kernel: consume collected
// Evidence first, live CDP only for missing dates/endpoints (P0009 correction).
// The default `getKernel` (CDP acquire) stays for collect/discover/chat.
//
// P0010.2.9: trade.overview uses the page-driven tradeSummary acquire
// (getSummary.ajax + getTrend.ajax) so the values match the live 经营概览
// page. Other capabilities keep the local-first path.
//
// P0010.2.11 C1: the per-cap dispatch is now in
// `createCapabilityAcquire` (`apps/ecommerce/connectors/jd/historical-acquire.ts`)
// so the scheduler and `/api/fabric/execute` share the same lower-level
// dispatch (no HTTP roundtrip from the runtime loop).
let _fabricKernel: RuntimeKernel | null = null;

const getFabricKernel = (db: Db): RuntimeKernel => {
  if (_fabricKernel) return _fabricKernel;
  let blueprint;
  try {
    blueprint = loadBlueprint('jd');
  } catch {
    blueprint = createEmptyBlueprint('jd');
  }

  _fabricKernel = createRuntimeKernel(db, blueprint, createCapabilityAcquire());
  return _fabricKernel;
};

/** Reset the kernel singletons (for testing). */
export const resetKernel = (): void => {
  _kernel = null;
  _fabricKernel = null;
};

/** Read the workspace version from context/status.json (fallback constant). */
const readWorkspaceVersion = (): string => {
  try {
    const p = resolve(process.cwd(), 'context', 'status.json');
    if (!existsSync(p)) return '0.x';
    const s = JSON.parse(readFileSync(p, 'utf-8'));
    return typeof s.version === 'string' ? s.version : '0.x';
  } catch {
    return '0.x';
  }
};

// ---- Agent-facing Fabric Execution Return Contract ----

/** One projected signal for the Hermes-facing return contract. */
export interface AgentSignalProjection {
  name: string;
  value: number;
  unit: string;
  direction: string;
  metrics: EnterpriseSignal['metrics'];
  observedAt: string;
}

/**
 * Project Runtime EnterpriseSignals into the Agent-facing contract.
 * Keeps the business values (name/value/unit/direction + metric bundle) Hermes
 * needs to reason; drops internal fields (raw_payload, trace, lifecycle,
 * collector_trace_id, entity internals).
 */
export const projectAgentSignals = (signals: EnterpriseSignal[]): AgentSignalProjection[] => {
  return signals.map((s) => ({
    name: s.signal_name,
    value: s.signal_value,
    unit: s.signal_unit,
    direction: s.signal_direction,
    metrics: s.metrics,
    observedAt: s.observed_at,
  }));
};

// ---- Router ----

export const runtimeRouter = (db: Db): Router => {
  const router = Router();

  // POST /api/runtime/collect — trigger a single-day runtime execution.
  router.post('/runtime/collect', async (req, res) => {
    const parsed = CollectRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, 400, `Invalid request: ${parsed.error.message}`);
      return;
    }

    try {
      const { shopId, date, mock, capabilities, shopName } = parsed.data;

      // Reject future dates — business data cannot exist in the future
      const today = new Date().toISOString().slice(0, 10);
      if (date && date > today) {
        fail(res, 400, `Cannot collect future date: ${date}. Today is ${today}.`);
        return;
      }

      const kernel = getKernel(db);

      const execOpts: Parameters<typeof kernel.execute>[0] = {
        shopId,
        mock,
      };
      if (date !== undefined) execOpts.date = date;
      if (capabilities !== undefined) execOpts.capabilities = capabilities;
      if (shopName !== undefined) execOpts.shopName = shopName;

      const result = await kernel.execute(execOpts);

      ok(res, {
        success: result.success,
        platform: result.platform,
        shopId: result.shopId,
        date: result.date,
        signalCount: result.signals.length,
        evidenceCount: result.evidence.length,
        signals: result.signals,
        evidence: result.evidence,
        errors: result.errors,
        blueprintDriven: result.blueprintDriven,
      });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Runtime execution failed');
    }
  });

  // POST /api/fabric/execute — Fabric execution boundary for Hermes (P0009).
  // Hermes (via an MCP tool) calls this to execute a capability → live JD CDP
  // → Evidence. Returns the Execution Return Contract. Live only — no mock
  // fallback (P0009: no fake success).
  router.post('/fabric/execute', async (req, res) => {
    const parsed = FabricExecuteRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, 400, `Invalid request: ${parsed.error.message}`);
      return;
    }

    try {
      const { capability, shopId, date } = parsed.data;
      const kernel = getFabricKernel(db);
      const result = await kernel.execute({
        shopId,
        mock: false,
        capabilities: [capability],
        ...(date ? { date } : {}),
      });

      ok(res, {
        success: result.success,
        capability,
        status: result.success ? 'completed' : 'failed',
        date: result.date,
        acquisitionMethod: 'cdp',
        // Agent-facing business result: the actual signals + metrics (not just count).
        signals: projectAgentSignals(result.signals),
        evidence: result.evidence,
        errors: result.errors,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Execution failed';
      // Distinguish CDP-unavailable from generic failure (honest readiness).
      if (msg.includes('CDP') || msg.includes('Chrome')) {
        ok(res, {
          success: false,
          capability: parsed.data.capability,
          status: 'cdp_unavailable',
          error: msg,
          evidence: [],
        });
        return;
      }
      fail(res, 500, msg);
    }
  });

  // GET /api/runtime/executions — list recent executions.
  // Query params: ?platform=jd&limit=20
  router.get('/runtime/executions', (req, res) => {
    try {
      const platform = (req.query['platform'] as string | undefined) ?? 'jd';
      const limit = Math.min(
        Number(req.query['limit']) || 200,
        366,
      );

      // An "execution" is a set of signals + evidence for a given date.
      // We group signals by date to reconstruct execution history.
      const allSignals = SignalFacade.listAll(db, 'product');

      // Group by date
      const byDate = new Map<string, { signals: number; evidence: number }>();
      for (const signal of allSignals) {
        const date = signal.observed_at?.slice(0, 10);
        if (!date) continue;
        const entry = byDate.get(date) ?? { signals: 0, evidence: 0 };
        entry.signals++;
        byDate.set(date, entry);
      }

      // Resolve evidence source for each date (P0006.3.2.1 — provenance-aware).
      const evidenceSource = (date: string): string => {
        try {
          const ev = loadEvidence('jd', date, 'summary');
          if (!ev) return 'none';
          const m = ev.record.metadata;
          // P0006.3.2.1: prefer acquisition_method, fall back to deprecated method
          const acq = m.acquisition_method ?? m.method;
          if (acq === 'cdp') return 'cdp';
          if (acq === 'mock') return 'mock';
          if (acq === 'import-agentcms') return 'import';
          return acq ?? 'unknown';
        } catch { return 'unknown'; }
      };

      // Convert to execution list, sorted by date desc
      const executions = [...byDate.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, limit)
        .map(([date, counts]) => ({
          date,
          platform,
          shopId: 'jd_shop_001',
          signalCount: counts.signals,
          evidenceCount: counts.evidence,
          evidenceSource: evidenceSource(date),
          status: 'completed' as const,
        }));

      ok(res, executions, { total: executions.length, page: 1, limit });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to list executions');
    }
  });

  // GET /api/runtime/executions/:date — get execution detail for a specific date.
  router.get('/runtime/executions/:date', (req, res) => {
    try {
      const executionDate = req.params['date'];
      if (!executionDate || !/^\d{4}-\d{2}-\d{2}$/.test(executionDate)) {
        fail(res, 400, 'Invalid date format. Use YYYY-MM-DD.');
        return;
      }

      // Load signals for this date
      const allSignals = SignalFacade.listAll(db, 'product');
      const dateSignals = allSignals.filter(
        (s) => s.observed_at?.startsWith(executionDate),
      );

      // Count by signal type
      const signalTypes = new Map<string, number>();
      for (const s of dateSignals) {
        const name = s.signal_name;
        signalTypes.set(name, (signalTypes.get(name) ?? 0) + 1);
      }

      ok(res, {
        date: executionDate,
        platform: 'jd',
        shopId: 'jd_shop_001',
        signalCount: dateSignals.length,
        signals: dateSignals,
        signalBreakdown: [...signalTypes.entries()].map(([name, count]) => ({
          signal_name: name,
          count,
        })),
        evidenceCount: 0, // Evidence records are tracked separately
        status: dateSignals.length > 0 ? 'completed' : 'not_found',
      });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to load execution detail');
    }
  });

  // GET /api/readiness — product runtime readiness (P0009). Honest: reflects
  // real acquisition prerequisites (JD/CDP), not static config presence.
  //
  // ADR-064: the embedded `hermes` field is the 3-layer shape (gateway /
  // session runtime / agent turn). The session-runtime layer is re-probed
  // here so the readiness chip does not show stale data after a Hermes
  // restart that flipped the port. The agent-turn layer is whatever the
  // Loop last recorded (see `recordAgentTurn` in runtime-loop).
  router.get('/readiness', async (_req, res) => {
    try {
      const [cdpAvailable, jdPageAvailable, capabilityCount, evidenceCount] = await Promise.all([
        isCdpAvailable(9222).catch(() => false),
        isJdPageAvailable(9222).catch(() => false),
        (async () => {
          try {
            const p = resolve(process.cwd(), 'generated', 'capability-contract.json');
            if (!existsSync(p)) return 0;
            const c = JSON.parse(readFileSync(p, 'utf-8'));
            return (c.capabilities ?? []).length;
          } catch { return 0; }
        })(),
        (async () => {
          try { return listEvidence({}).length; } catch { return 0; }
        })(),
        // ADR-064: re-probe the Session Runtime on every readiness call so
        // the chip does not lag behind a Hermes restart. We then record
        // the probe so `getHermesHealth()` agrees with what we just
        // observed. The agent-turn layer is left untouched.
        // ADR-064: force a fresh probe on every readiness call so the chip
        // reflects the actual current state of the Session Runtime (a
        // cached "healthy" from 29s ago must NOT mask a fresh kill). The
        // per-port cache in session-client.ts is still useful for the
        // turn-time connect path (which is the one that pays the
        // network cost); the readiness + hermes/status routes are
        // monitoring seams and must be live.
        (async () => {
          const url = resolveHermesWsUrl();
          const port = resolveHermesPort(url);
          try {
            const probe = await probeAuthRequired(url, { forceRefresh: true });
            recordSessionRuntimeProbe({
              url,
              port,
              authRequired: probe.authRequired,
              probeFailed: probe.probeFailed,
              tokenSource: getHermesHealth().sessionRuntime.tokenSource,
            });
            return { url, port, probeOk: !probe.probeFailed, authRequired: probe.authRequired };
          } catch {
            // probeAuthRequired swallows its own errors; this catch is
            // defensive only.
            return { url, port, probeOk: false, authRequired: null as boolean | null };
          }
        })(),
      ]);

      // Honest JD data-source state: Chrome reachable ≠ JD page open ≠ logged in.
      const jdCdp = !cdpAvailable ? 'unavailable' : jdPageAvailable ? 'ready' : 'auth_required';

      const hermes = getHermesHealth();
      ok(res, {
        workspace: 'ready',
        capabilities: capabilityCount,
        jd_cdp: jdCdp,
        jd_page: jdPageAvailable ? 'available' : 'missing',
        evidence: evidenceCount,
        // P0010.1 UI: workspace version comes from status.json (single source of
        // truth), not a hardcoded string in the SPA.
        version: readWorkspaceVersion(),
        // ADR-064: 3-layer hermes health — see ADR-064 + /api/runtime/hermes/status.
        hermes,
      });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Readiness check failed');
    }
  });

  // GET /api/runtime/hermes/status — dedicated 3-layer Hermes runtime
  // health (ADR-064). Returns the same shape as `readiness.hermes` but
  // without the JD/CDP noise, so the UI / monitoring can poll this
  // endpoint cheaply. The session runtime is re-probed every call.
  // ADR-064: force a fresh probe on every call so monitoring surfaces see
  // the actual current state (a cached "healthy" from 29s ago must NOT
  // mask a fresh kill). The per-port cache in session-client.ts is still
  // useful for the turn-time connect path; this route is a monitoring
  // seam and must be live.
  router.get('/runtime/hermes/status', async (_req, res) => {
    const url = resolveHermesWsUrl();
    const port = resolveHermesPort(url);
    try {
      const probe = await probeAuthRequired(url, { forceRefresh: true });
      recordSessionRuntimeProbe({
        url,
        port,
        authRequired: probe.authRequired,
        probeFailed: probe.probeFailed,
        tokenSource: getHermesHealth().sessionRuntime.tokenSource,
      });
    } catch {
      // probeAuthRequired swallows its own errors; this catch is
      // defensive only.
      recordSessionRuntimeProbe({
        url,
        port,
        authRequired: null,
        probeFailed: true,
        tokenSource: getHermesHealth().sessionRuntime.tokenSource,
      });
    }
    ok(res, getHermesHealth());
  });

  // GET /api/runtime/status — runtime availability and blueprint info.
  router.get('/runtime/status', (_req, res) => {
    try {
      const kernel = getKernel(db);
      ok(res, {
        available: true,
        platform: kernel.platform,
        blueprint: {
          generated_at: kernel.blueprint.generated_at,
          discovery_api_count: kernel.blueprint.discovery_api_count,
          signal_types: kernel.blueprint.manifest.signal_types,
          supported_actions: kernel.blueprint.manifest.supported_actions,
          total_apis_discovered: kernel.blueprint.manifest.total_apis_discovered,
        },
      });
    } catch (err) {
      ok(res, {
        available: false,
        error: err instanceof Error ? err.message : 'Runtime unavailable',
      });
    }
  });

  // POST /api/runtime/replay — replay historical data over a date range.
  // P0006.2: Loops over dates and calls kernel.execute() for each.
  // Kernel, Signal, Evidence, Ranking all unchanged.
  router.post('/runtime/replay', async (req, res) => {
    const parsed = ReplayRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, 400, `Invalid request: ${parsed.error.message}`);
      return;
    }

    try {
      const { shopId, from, to } = parsed.data;

      // Validate date range
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (fromDate > toDate) {
        fail(res, 400, 'from date must be before or equal to to date');
        return;
      }

      // Reject future dates
      const today = new Date().toISOString().slice(0, 10);
      if (from > today || to > today) {
        fail(res, 400, `Cannot replay future dates. Today is ${today}.`);
        return;
      }

      // Limit range to prevent accidentally replaying years of data
      const dayCount = Math.ceil((toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
      if (dayCount > 366) {
        fail(res, 400, `Date range too large (${dayCount} days). Maximum 366 days.`);
        return;
      }

      const { runReplay } = await import('#app/runtime/replay/replay-runner.js');
      const kernel = getKernel(db);
      const result = await runReplay(db, kernel.blueprint, { shopId, from, to });

      ok(res, {
        days: result.days,
        completed: result.completed,
        failed: result.failed,
        signals: result.signals,
        evidence: result.evidence,
        executions: result.executions,
        errors: result.errors.slice(0, 10), // Only return first 10 errors
      });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Replay failed');
    }
  });

  // POST /api/runtime/discover — full JD 商智 multi-page discovery (P0005.3).
  router.post('/runtime/discover', async (_req, res) => {
    try {
      const date = new Date().toISOString().slice(0, 10);
      const pages = getDataPages();
      const result = await acquireJdMultiPage({ pages, date });

      // Save evidence and generate signals per page
      const perPage: Record<string, unknown>[] = [];
      for (const r of result.results) {
        const entry: Record<string, unknown> = {
          page: r.page,
          success: r.success,
          apiCount: r.apiCount,
        };
        if (r.success && r.payload) {
          const now = new Date().toISOString();
          let evidenceCount = 0;
          for (const [dtype, data] of [['summary', r.payload.summary], ['trend', r.payload.trend], ['productTop', r.payload.productTop]] as const) {
            if (data && Array.isArray(data) && data.length > 0) {
              saveEvidence('jd', 'jd_shop_001', date, `${r.page.id}_${dtype}`, data, {
                acquisition_method: 'cdp', processing_method: 'runtime', processed_at: now,
                tags: [`page:${r.page.id}`],
              });
              evidenceCount++;
            }
          }
          try {
            const parsed = parseJdPayload({ date, summary: r.payload.summary||[], trend: r.payload.trend||[], productTop: r.payload.productTop||[] });
            entry['gmv'] = parsed.summary.gmv;
            entry['orders'] = parsed.summary.orders;
            // P0010.2.9: shop-level is primary; product/industry preserved.
            entry['shop_visitors'] = parsed.summary.shop_visitors;
            entry['shop_conversion_rate'] = parsed.summary.shop_conversion_rate;
            entry['product_visitors'] = parsed.summary.product_visitors;
            entry['industry_conversion_rate'] = parsed.summary.industry_conversion_rate;
          } catch { /* page doesn't have summary format */ }
          entry['evidenceCount'] = evidenceCount;
        }
        if (r.error) entry['error'] = r.error;
        perPage.push(entry);
      }

      ok(res, {
        pagesVisited: result.pagesVisited,
        pagesWithData: result.pagesWithData,
        results: perPage,
        errors: result.errors,
      });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Discovery failed');
    }
  });

  // ── Capability Contract API ──────────────────────────────────

  // GET /api/capabilities — list all capability contracts.
  // Query params: ?domain=traffic, ?intent=流量
  router.get('/capabilities', (_req, res) => {
    try {
      const contractPath = resolve(process.cwd(), 'generated', 'capability-contract.json');
      if (!existsSync(contractPath)) {
        ok(res, { capabilities: [], summary: { total_capabilities: 0 } }, { total: 0 });
        return;
      }
      const raw = readFileSync(contractPath, 'utf-8');
      const contract = JSON.parse(raw);
      let capabilities = contract.capabilities || [];

      // Filter by domain
      const domain = _req.query['domain'] as string | undefined;
      if (domain && domain !== 'all') {
        capabilities = capabilities.filter(
          (c: { domain: string }) => c.domain === domain,
        );
      }

      // Search by intent
      const intent = _req.query['intent'] as string | undefined;
      if (intent) {
        const q = intent.toLowerCase();
        capabilities = capabilities.filter((c: { intent: string[]; name: string; description: string }) =>
          (c.intent || []).some((i: string) => i.includes(q)) ||
          c.name.includes(q) ||
          c.description.includes(q),
        );
      }

      ok(res, {
        capabilities,
        summary: contract.summary,
        domains: contract.summary?.domains || [],
      }, { total: capabilities.length });
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to load capabilities');
    }
  });

  // GET /api/evidence/:capabilityId — evidence chain for a capability.
  // Returns provenance data: capability info + discovery artifacts + evidence records.
  router.get('/evidence/:capabilityId', (req, res) => {
    try {
      const capabilityId = req.params['capabilityId'];
      if (!capabilityId) {
        fail(res, 400, 'Missing capability ID');
        return;
      }

      // Load capability contract
      const contractPath = resolve(process.cwd(), 'generated', 'capability-contract.json');
      let capability: Record<string, unknown> | undefined;
      if (existsSync(contractPath)) {
        const contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
        capability = (contract.capabilities || []).find(
          (c: { capability: string }) => c.capability === capabilityId,
        );
      }

      if (!capability) {
        fail(res, 404, `Capability not found: ${capabilityId}`);
        return;
      }

      // Build provenance chain
      const provider = capability.provider as Record<string, string> || {};
      const validation = capability.validation as Record<string, unknown> || {};
      const platform = (provider.platform || 'jd') as string;

      // List evidence records for this platform. Explicit limit: listEvidence
      // defaults to 100, which would silently cap totalRecords below reality.
      let evidenceRecords: unknown[] = [];
      try {
        evidenceRecords = listEvidence({ source: platform, limit: EVIDENCE_LIST_LIMIT });
      } catch {
        // Evidence may not exist yet — that's fine
      }

      // Read discovery artifacts if available
      const discoveryBase = resolve(process.cwd(), 'discovery', 'jd-capability');
      const artifacts: Record<string, unknown> = {};
      const artifactFiles = [
        'capability_matrix.json',
        'api_inventory.json',
        'indicator_dictionary.json',
      ];
      for (const f of artifactFiles) {
        const p = resolve(discoveryBase, f);
        if (existsSync(p)) {
          try {
            artifacts[f] = JSON.parse(readFileSync(p, 'utf-8'));
          } catch { artifacts[f] = null; }
        }
      }

      // Build the provenance chain response
      const provenance = {
        capability: {
          id: capability.capability,
          name: capability.name,
          domain: capability.domain,
          description: capability.description,
        },
        provider: {
          platform: provider.platform,
          platformName: platform === 'jd' ? '京东商智' : provider.platform,
          acquisition: provider.acquisition || 'cdp',
          acquisitionLabel: provider.acquisition === 'cdp' ? 'Live CDP Capture' : provider.acquisition || 'Unknown',
          status: validation.status || 'unknown',
          lastVerified: validation.last_verified || null,
        },
        evidence: {
          totalRecords: evidenceRecords.length,
          // listEvidence walks the tree in ascending date order - sort by
          // acquired_at descending so "recentRecords" really is the most recent.
          recentRecords: [...evidenceRecords]
            .sort((a, b) => {
              const at = (a as { metadata?: { acquired_at?: string } }).metadata?.acquired_at ?? '';
              const bt = (b as { metadata?: { acquired_at?: string } }).metadata?.acquired_at ?? '';
              return bt.localeCompare(at);
            })
            .slice(0, 10),
        },
        discovery: {
          artifacts: Object.keys(artifacts).length > 0 ? artifacts : null,
          artifactCount: Object.keys(artifacts).length,
        },
        validation: {
          status: validation.status,
          verifiedMetrics: validation.verified_metrics || [],
          lastVerified: validation.last_verified || null,
        },
        metrics: capability.metrics || [],
        constraints: capability.constraints || {},
      };

      ok(res, provenance);
    } catch (err) {
      fail(res, 500, err instanceof Error ? err.message : 'Failed to load evidence');
    }
  });


  return router;
};
