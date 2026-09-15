// P0013.3 — Historical Evidence Enrichment prompt contract.
//
// Source-level + rendered-prompt checks:
//  - operator_feedback is explicitly HUMAN INPUT, never an Observed Fact;
//  - action → later outcome must not be stated as causal;
//  - enrichments are the only human-provided historical context and do
//    not modify the frozen dataset;
//  - empty enrichment list renders a sentinel (agent is not told there
//    are records it cannot see).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReplayInvestigationPrompt } from '#app/runtime/replay/replay-cognition-kernel.js';
import type { ReplayRunState } from '#app/runtime/replay/replay-runner-p0013.js';
import type { EnrichmentRow } from '#app/runtime/replay/enrichment-store.js';

const KERNEL_SRC = readFileSync(
  resolve('apps/ecommerce/runtime/replay/replay-cognition-kernel.ts'),
  'utf8',
);

const sampleRun = {
  id: 'rE',
  shopId: '11855009',
  shopName: '祁门红茶官方旗舰店',
  sourceDatasetPath: '/d/x',
  sourceManifestHash: 'h',
  status: 'COMPLETED',
  startBusinessDate: '2026-08-10',
  endBusinessDate: '2026-08-12',
  currentBusinessDate: '2026-08-13',
  currentStep: 3,
} as unknown as ReplayRunState;

const build = (enrichments: EnrichmentRow[]) =>
  buildReplayInvestigationPrompt({
    run: sampleRun,
    businessDate: '2026-08-11',
    visibleEvidence: [],
    priorSnapshots: [],
    priorCognition: [],
    enrichments,
  });

const row = (over: Partial<EnrichmentRow>): EnrichmentRow => ({
  id: 'e1',
  replayRunId: 'rE',
  businessDate: '2026-08-11',
  kind: 'fact',
  content: '当天上线满减',
  source: 'operator',
  createdAt: '2026-09-15T01:00:00.000Z',
  ...over,
});

describe('Replay enrichment prompt contract', () => {
  it('renders the three kinds with operator_feedback flagged as human input, not Observed Fact', () => {
    const prompt = build([
      row({ id: 'a', kind: 'fact', content: '新品上架' }),
      row({ id: 'b', kind: 'action', content: '上线满 300 减 40' }),
      row({ id: 'c', kind: 'operator_feedback', content: '运营认为是礼赠拉动' }),
    ]);
    expect(prompt).toContain('Operator enrichments');
    expect(prompt).toContain('fact (客观事实)');
    expect(prompt).toContain('action (运营动作)');
    expect(prompt).toContain('operator_feedback');
    expect(prompt).toMatch(/HUMAN INPUT, NOT AN OBSERVED FACT/);
    expect(prompt).toContain('do NOT put it in observed');
    expect(prompt).toContain('新品上架');
    expect(prompt).toContain('上线满 300 减 40');
    expect(prompt).toContain('运营认为是礼赠拉动');
  });

  it('forbids auto-causal action→outcome narration', () => {
    const prompt = build([row({ kind: 'action' })]);
    expect(prompt).toMatch(/MUST NOT be stated as caused by the action/);
    expect(prompt).toMatch(/describe sequence, not causation/);
  });

  it('states enrichments never modify the frozen dataset', () => {
    expect(KERNEL_SRC).toMatch(/do not modify the frozen dataset/);
  });

  it('renders an explicit empty sentinel instead of silently omitting the section', () => {
    const prompt = build([]);
    expect(prompt).toContain('no operator enrichments');
  });

  it('labels every record with its business date (T-scoping is enforced at SQL boundary)', () => {
    const prompt = build([row({ businessDate: '2026-08-10', content: 'earlier-day fact' })]);
    expect(prompt).toContain('[2026-08-10 |');
    // A T+1 record would never reach the builder (visibleEnrichmentsAt
    // filters business_date <= T); the prompt header states the bound.
    expect(prompt).toContain('business_date <= 2026-08-11');
  });
});
