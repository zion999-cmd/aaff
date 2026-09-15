// P0013.1 — Capability Resolution.
//
// SC9: a Capability Candidate is NOT a formal binding. Even when a
// pending candidate exists for exactly this need category, V1 resolution
// must route to Hermes Exploration — promotion is a separate human /
// architecture decision.

import { describe, it, expect } from 'vitest';
import { resolveHistoricalBinding } from '#app/runtime/acquisition/capability-resolution.js';
import { HistoricalEvidenceNeedSchema } from '#shared/contracts/historical-evidence-need.js';
import { CapabilityCandidateSchema } from '#shared/contracts/capability-candidate.js';

const need = HistoricalEvidenceNeedSchema.parse({
  subject: { shopId: '11855009', shopName: '祁门红茶官方旗舰店' },
  source: 'jd',
  purpose: 'historical_replay',
  window: { start: '2026-09-03', end: '2026-09-12' },
  domains: ['trade', 'orders'],
});

const candidate = CapabilityCandidateSchema.parse({
  id: 'hcand_20260913_000000_deadbe',
  satisfies: { need_category: 'historical_evidence', source: 'jd', domains: ['trade', 'orders'] },
  binding: { source: 'jd', system_identity: 'JD 商智 szgateway.jd.com' },
  input_contract: { shop_id: 'string', window: 'YYYY-MM-DD range' },
  output_contract: { canonical_files: 4 },
  method: 'per-day requests with natural-key dedup',
  implementation_assets: [
    { kind: 'script', name: 'historical method', path: 'scripts/example.py' },
  ],
  dependencies: {
    authentication: 'logged-in browser session',
    browser_session: 'real Chrome with remote debugging',
    environment: ['python3', 'playwright'],
  },
  verified_against: {
    acquisition_job_id: 'hacq_test',
    evidence_files: ['target_b_order_detail_summary.json'],
    verification_notes: 'verified once in blind experiment',
  },
  limitations: ['single-day row count observed under cap'],
  provenance: {
    created_by: 'hermes',
    created_at: '2026-09-13T10:00:00+08:00',
    trajectory_path: 'data/_acquisition_intake/hacq_test/trajectory/events.ndjson',
  },
  status: 'pending_review',
});

describe('resolveHistoricalBinding', () => {
  it('routes to explore with no candidates', () => {
    const r = resolveHistoricalBinding(need, []);
    expect(r).toEqual({ kind: 'explore', reason: 'no_verified_historical_binding' });
  });

  it('STILL routes to explore when matching candidates exist (SC9 — no auto-promotion)', () => {
    const r = resolveHistoricalBinding(need, [candidate]);
    expect(r.kind).toBe('explore');
  });

  it('does not mutate its inputs', () => {
    const before = JSON.stringify(candidate);
    resolveHistoricalBinding(need, [candidate]);
    expect(JSON.stringify(candidate)).toBe(before);
  });
});
