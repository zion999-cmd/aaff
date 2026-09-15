// P0013.1 — Capability Candidate store: schema-validated, immutable,
// always pending review.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistCandidate,
  listCandidates,
  CandidateStoreError,
} from '#app/runtime/acquisition/candidate-store.js';
import type { CapabilityCandidate } from '#shared/contracts/capability-candidate.js';

let dataRoot: string;

const candidate = (id: string): CapabilityCandidate => ({
  id,
  satisfies: { need_category: 'historical_evidence', source: 'jd', domains: ['trade', 'orders'] },
  binding: { source: 'jd', system_identity: 'JD 商智' },
  input_contract: { shop_id: 'string' },
  output_contract: { canonical_files: 4 },
  method: 'a method that worked',
  implementation_assets: [{ kind: 'script', name: 'x' }],
  dependencies: {
    authentication: 'browser session',
    browser_session: 'real browser on debug port',
    environment: ['python3'],
  },
  verified_against: {
    acquisition_job_id: 'hacq_test',
    evidence_files: ['target_b_order_detail_summary.json'],
    verification_notes: 'verified for real',
  },
  limitations: ['one limit'],
  provenance: {
    created_by: 'hermes',
    created_at: '2026-09-13T11:00:00+08:00',
    trajectory_path: 'trajectory/events.ndjson',
  },
  status: 'pending_review',
});

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'af-cand-'));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('candidate store', () => {
  it('persists a valid candidate and lists it', () => {
    const path = persistCandidate(dataRoot, candidate('hcand_20260913_113000_ab12cd'));
    expect(existsSync(path)).toBe(true);
    const { candidates, skipped } = listCandidates(dataRoot);
    expect(skipped).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.status).toBe('pending_review');
  });

  it('rejects schema-invalid candidates', () => {
    const bad = { ...candidate('hcand_20260913_113000_ab12cd'), method: '' };
    expect(() => persistCandidate(dataRoot, bad)).toThrow(CandidateStoreError);
  });

  it('is immutable: identical re-write is idempotent, different content under the same id is rejected', () => {
    persistCandidate(dataRoot, candidate('hcand_20260913_113000_ab12cd'));
    // Same content (salvage retry) — allowed, no overwrite.
    expect(() => persistCandidate(dataRoot, candidate('hcand_20260913_113000_ab12cd'))).not.toThrow();
    // Different content under same id — forbidden.
    const changed = { ...candidate('hcand_20260913_113000_ab12cd'), method: 'different method' };
    expect(() => persistCandidate(dataRoot, changed)).toThrow(CandidateStoreError);
  });

  it('returns empty list when no candidates exist yet', () => {
    expect(listCandidates(dataRoot).candidates).toEqual([]);
  });
});
