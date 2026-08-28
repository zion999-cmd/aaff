// P0010.2.11 C1 — regression tests for the per-capability acquisition dispatch.
//
// Covers three layers that together enforce the "same capability → same acquisition"
// invariant between the scheduler and /api/fabric/execute:
//
//   1. historical-acquire.ts#endpointToDataType — keep canonical lowcode names
//      as their own dataType so the local-first lookup does NOT silently reuse
//      legacy `summary` evidence as if it satisfied `getSummary`.
//   2. historical-acquire.ts#createCapabilityAcquire — the shared per-cap
//      dispatch routes trade.overview to the page-driven acquirer, other
//      capabilities to the local-first path.
//   3. binding/planner.ts#inferModuleFromEndpoint regex — `getSummary` /
//      `getTrend` now match indexSummary so the planner returns a non-empty
//      plan for `capabilities: ['trade.overview']`.

import { describe, it, expect, vi, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createLocalFirstLiveAcquire,
  createCapabilityAcquire,
} from '#app/connectors/jd/historical-acquire.js';
import { saveEvidence } from '#app/connectors/evidence/store.js';
import { buildExecutionPlan, loadBlueprint } from '#app/connectors/binding/index.js';
import type { AcquireResult } from '#app/connectors/jd/acquisition/index.js';

const EVIDENCE_JD_DIR = resolve(process.cwd(), 'data', 'evidence', 'jd');
const DATE_C1_A = '2099-04-01';
const DATE_C1_B = '2099-04-02';

const makeLive = (payload: Record<string, unknown>) =>
  vi.fn(async (): Promise<AcquireResult> => ({
    success: true,
    method: 'cdp',
    rawPayload: payload,
  }));

const makeTradeOverview = (result: {
  success: boolean;
  summary?: unknown[];
  trend?: unknown[];
  errors?: string[];
}) =>
  vi.fn(async () => ({
    success: result.success,
    date: '2099-04-01',
    summary: result.summary ?? [],
    trend: result.trend ?? [],
    cdpAvailable: true,
    ...(result.errors ? { errors: result.errors } : {}),
  }));

describe('P0010.2.11 C1 — endpointToDataType heuristic', () => {
  afterAll(() => {
    for (const d of [DATE_C1_A, DATE_C1_B]) {
      const [y, m, dd] = d.split('-');
      rmSync(resolve(EVIDENCE_JD_DIR, y!, m!, `${dd}_getSummary.json`), { force: true });
      rmSync(resolve(EVIDENCE_JD_DIR, y!, m!, `${dd}_getSummary.meta.json`), { force: true });
      rmSync(resolve(EVIDENCE_JD_DIR, y!, m!, `${dd}_getTrend.json`), { force: true });
      rmSync(resolve(EVIDENCE_JD_DIR, y!, m!, `${dd}_getTrend.meta.json`), { force: true });
      rmSync(resolve(EVIDENCE_JD_DIR, y!, m!, `${dd}_summary.json`), { force: true });
      rmSync(resolve(EVIDENCE_JD_DIR, y!, m!, `${dd}_summary.meta.json`), { force: true });
    }
  });

  it('does NOT reuse legacy `summary` evidence as getSummary (C1 Bug 2 regression)', async () => {
    // Legacy `summary.ajax` evidence exists. Without the Bug 2 fix,
    // endpointToDataType('getSummary.ajax') would be 'summary' and the
    // local-first lookup would reuse the legacy file as if it satisfied
    // the new endpoint. After the fix, getSummary has its own dataType —
    // legacy `summary` evidence does NOT satisfy getSummary.ajax.
    saveEvidence('jd', 'jd_shop_001', DATE_C1_A, 'summary', { gmv: 1, legacy: true });
    // Live acquire returns the canonical lowcode payload under
    // rawPayload.getSummary (matching the orchestrator's own
    // endpointToDataType contract after P0010.2.9).
    const live = makeLive({ getSummary: { gmv: 999, canonical: true } });
    const acquire = createLocalFirstLiveAcquire(live);

    const data = await acquire(
      'jd_shop_001',
      ['getSummary.ajax'],
      { date: DATE_C1_A },
    );

    // The legacy `summary` evidence MUST NOT be returned as the
    // getSummary.ajax payload. The path may either fall through to
    // live (returning the canonical payload) or skip entirely — but
    // it must never return the legacy { gmv: 1, legacy: true } file.
    expect(data['getSummary.ajax']).not.toEqual({ gmv: 1, legacy: true });
    if (data['getSummary.ajax'] !== undefined) {
      expect(data['getSummary.ajax']).toEqual({ gmv: 999, canonical: true });
    }
  });

  it('keeps getSummary as its own dataType when looking up local evidence (Bug 2)', async () => {
    // Save evidence under the canonical lowcode dataType. The lookup must
    // find it via the `getSummary` dataType, not via the legacy `summary`.
    saveEvidence('jd', 'jd_shop_001', DATE_C1_B, 'getSummary', { gmv: 123, lowcode: true });
    const live = makeLive({});
    const acquire = createLocalFirstLiveAcquire(live);

    const data = await acquire('jd_shop_001', ['getSummary.ajax'], { date: DATE_C1_B });

    expect(live).not.toHaveBeenCalled();
    expect(data['getSummary.ajax']).toEqual({ gmv: 123, lowcode: true });
  });
});

describe('P0010.2.11 C1 — createCapabilityAcquire dispatch', () => {
  it('routes trade.overview endpoints (getSummary/getTrend) to the page-driven acquirer', async () => {
    const tradeOverview = makeTradeOverview({
      success: true,
      summary: [{ indicator: 'gmv', value: 6585.24 }],
      trend: [{ code: 'gmv', data: [1, 2, 3], categories: ['a', 'b', 'c'] }],
    });
    const live = makeLive({});
    const acquire = createCapabilityAcquire(live, tradeOverview);

    const data = await acquire(
      'jd_shop_001',
      ['getSummary.ajax', 'getTrend.ajax'],
      { date: '2099-04-01' },
    );

    expect(tradeOverview).toHaveBeenCalledTimes(1);
    expect(tradeOverview).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2099-04-01' }),
    );
    expect(live).not.toHaveBeenCalled();
    expect(data['getSummary.ajax']).toEqual([{ indicator: 'gmv', value: 6585.24 }]);
    expect(data['getTrend.ajax']).toEqual([{ code: 'gmv', data: [1, 2, 3], categories: ['a', 'b', 'c'] }]);
  });

  it('falls through to the local-first path for non-trade capabilities', async () => {
    const tradeOverview = makeTradeOverview({ success: true });
    const live = makeLive({ summary: { gmv: 1 } });
    const acquire = createCapabilityAcquire(live, tradeOverview);

    const data = await acquire('jd_shop_001', ['summary.ajax'], { date: '2099-04-01' });

    expect(tradeOverview).not.toHaveBeenCalled();
    expect(data['summary.ajax']).toEqual({ gmv: 1 });
  });

  it('throws on trade.overview CDP failure (no silent fallback to summary.ajax)', async () => {
    const tradeOverview = makeTradeOverview({
      success: false,
      errors: ['Chrome CDP not available'],
    });
    const live = makeLive({ summary: { gmv: 1 } });
    const acquire = createCapabilityAcquire(live, tradeOverview);

    await expect(
      acquire('jd_shop_001', ['getSummary.ajax'], { date: '2099-04-01' }),
    ).rejects.toThrow('Chrome CDP not available');
    // Live acquire MUST NOT have been called — that would have produced
    // the legacy `summary` payload under the `getSummary.ajax` key.
    expect(live).not.toHaveBeenCalled();
  });

  it('recognizes trade endpoints with paths and query strings', async () => {
    const tradeOverview = makeTradeOverview({
      success: true,
      summary: [{ kind: 'gmv', value: 1 }],
      trend: [{ kind: 'gmv', data: [1, 2] }],
    });
    const live = makeLive({});
    const acquire = createCapabilityAcquire(live, tradeOverview);

    const data = await acquire(
      'jd_shop_001',
      [
        '/api/lowcode/tradeSummary/summary/getSummary.ajax?date=2026-08-28',
        '/api/lowcode/tradeSummary/summary/getTrend.ajax',
      ],
      { date: '2099-04-01' },
    );

    expect(tradeOverview).toHaveBeenCalledTimes(1);
    expect(data['/api/lowcode/tradeSummary/summary/getSummary.ajax?date=2026-08-28']).toEqual(
      [{ kind: 'gmv', value: 1 }],
    );
    expect(data['/api/lowcode/tradeSummary/summary/getTrend.ajax']).toEqual([
      { kind: 'gmv', data: [1, 2] },
    ]);
  });
});

describe('P0010.2.11 C1 — planner inferModuleFromEndpoint regex (Bug 1)', () => {
  it('resolves trade.overview to a non-empty plan that includes getSummary + getTrend', () => {
    const model = loadBlueprint('jd');
    const plan = buildExecutionPlan(model, { capabilities: ['trade.overview'] });

    expect(plan.target_capabilities).toContain('trade.overview');
    const endpoints = plan.apis_to_call.map((api) => api.endpoint);
    expect(endpoints).toContain('getSummary');
    expect(endpoints).toContain('getTrend');
  });
});
