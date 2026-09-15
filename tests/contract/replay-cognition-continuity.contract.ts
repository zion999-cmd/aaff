// P0013.4 — Replay cognition continuity contract.
//
// The 2026-09-16 audit of a real trajectory (run 5babef67) found the Agent
// had converted continuous business cognition into a per-day scorecard:
//   "严格高客单 2/2（未升稳态）" / "软化口径 3/3 仅作门禁记账" /
//   "①命中 ②未命中" — every day a hit/miss tally, every prior day re-scored,
//   an invented classification gate ("门禁"/"软化口径") driving the labels,
//   and each reading opening with a metrics dump.
//
// Root cause: the contract never said what prior cognition IS (standing
// understanding vs a checklist) nor that enrichment is background context
// rather than a daily agenda item. These assertions pin the fix so a later
// prompt edit cannot silently reintroduce the scorecard.
//
// Source + rendered-prompt level (the prompt is emitted text).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReplayInvestigationPrompt } from '#app/runtime/replay/replay-cognition-kernel.js';
import {
  COGNITION_CONTINUITY_SECTION,
  ANALYSIS_TARGET_SECTION,
} from '#app/runtime/investigation/analysis-contract.js';
import type { ReplayRunState } from '#app/runtime/replay/replay-runner-p0013.js';
import type { EnrichmentRow } from '#app/runtime/replay/enrichment-store.js';

const run = {
  id: 'rC',
  shopId: '11855009',
  shopName: '祁门红茶官方旗舰店',
  sourceDatasetPath: '/d/x',
  sourceManifestHash: 'h',
  status: 'RUNNING',
  startBusinessDate: '2026-09-04',
  endBusinessDate: '2026-09-12',
  currentBusinessDate: '2026-09-08',
  currentStep: 4,
  blockedBusinessDate: null,
  blockedReason: null,
} as unknown as ReplayRunState;

const enrichment: EnrichmentRow = {
  id: 'e1',
  replayRunId: 'rC',
  businessDate: '2026-09-04',
  kind: 'action',
  content: '当天上线教师节优惠',
  source: 'operator',
  createdAt: '2026-09-16T00:00:00.000Z',
};

const build = (enrichments: EnrichmentRow[] = []) =>
  buildReplayInvestigationPrompt({
    run,
    businessDate: '2026-09-08',
    visibleEvidence: [],
    priorSnapshots: [],
    priorCognition: [
      { business_date: '2026-09-07', kind: 'prior_judgment', content: '昨日判断', status_at_t_minus_1: 'supported' },
    ],
    enrichments,
  });

describe('cognition continuity — prior cognition is not a checklist', () => {
  it('states that prior cognition is standing understanding to carry forward', () => {
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/standing understanding/i);
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/not a scorecard/i);
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/NOT a list of questions you must answer back/i);
  });

  it('forbids per-day hit/miss tallies explicitly', () => {
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/hit\/miss tallies/i);
    expect(COGNITION_CONTINUITY_SECTION).toContain('①命中 ②未命中');
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/"2\/2", "3\/3"/);
  });

  it('forbids inventing classification gates / threshold ladders', () => {
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/classification gates or threshold ladders/i);
    expect(COGNITION_CONTINUITY_SECTION).toContain('严格门禁');
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/never as a scoring rubric/i);
  });

  it('forbids the metrics-dump opening and requires a cross-day state reading', () => {
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/metrics dump/i);
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/Numbers SUPPORT the reading/);
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/what has continued, what has changed, what is still unknown/i);
  });

  it('is embedded in the replay prompt, next to the analysis target', () => {
    const prompt = build();
    expect(prompt).toContain('## Cognition continuity');
    expect(prompt).toContain(ANALYSIS_TARGET_SECTION.split('\n')[0]);
    // Prior cognition section tells the model not to score it item by item.
    expect(prompt).toMatch(/Do not score it item by item/);
  });
});

describe('enrichment is background context, not a daily agenda', () => {
  it('says the Agent is not required to address/verify enrichment', () => {
    const prompt = build([enrichment]);
    expect(prompt).toMatch(/NOT an agenda/i);
    expect(prompt).toMatch(/not required to address them, explain them, verify them/i);
    expect(prompt).toMatch(/Silence is the correct form/);
    expect(prompt).toMatch(/do not add a daily "this did not cause that" line/);
  });

  it('keeps the causal discipline for the case where it IS relevant', () => {
    const prompt = build([enrichment]);
    expect(prompt).toMatch(/WHEN an enrichment IS relevant/);
    expect(prompt).toMatch(/MUST NOT be stated as caused by the action/);
    expect(prompt).toMatch(/describe sequence, not causation/);
  });

  it('keeps operator_feedback out of Observed Facts', () => {
    const feedback: EnrichmentRow = { ...enrichment, id: 'e2', kind: 'operator_feedback', content: '店长认为是礼赠拉动' };
    const prompt = build([feedback]);
    expect(prompt).toMatch(/HUMAN INPUT, NOT AN OBSERVED FACT/);
    expect(prompt).toContain('do NOT put it in observed');
  });
});

describe('coverage is a completeness check, not a scorecard', () => {
  it('reframes business_structure_coverage accordingly', () => {
    expect(ANALYSIS_TARGET_SECTION).toMatch(/COMPLETENESS check/i);
    expect(ANALYSIS_TARGET_SECTION).toMatch(/NOT a scorecard/i);
    // The five dimensions remain mandatory (the fail-closed validator needs them).
    for (const dim of ['product', 'orders', 'traffic', 'conversion', 'operations']) {
      expect(ANALYSIS_TARGET_SECTION).toContain(dim);
    }
  });

  it('no longer models an invented confirmation threshold in the prompt', () => {
    const prompt = build();
    expect(prompt).not.toContain('若 GMV > 12000 则确认');
    expect(prompt).toMatch(/do NOT invent classification gates or ladders/i);
  });
});

describe('replay kernel source invariants', () => {
  const src = readFileSync(
    resolve('apps/ecommerce/runtime/replay/replay-cognition-kernel.ts'),
    'utf8',
  );

  it('workflow no longer instructs a per-item verdict on prior cognition', () => {
    expect(src).not.toMatch(/What did T-1 already conclude\? → keep as prior/);
    expect(src).toMatch(/silently\. Do NOT produce a per-item verdict/);
  });

  it('evidence, prior cognition and enrichment all feed one updated reading', () => {
    // The reasoning order the contract requires: update understanding first,
    // then judge — not: restate the day, then grade yesterday.
    expect(COGNITION_CONTINUITY_SECTION).toMatch(/Each turn updates that reading/);
  });
});
