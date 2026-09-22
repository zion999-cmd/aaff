// P0013.4 — Question-Driven Investigation & Evidence Sufficiency contract.
//
// Same failure shape P0013.5 fixed for Knowledge: if the two analysis paths
// carry DIFFERENT wording for the same cognition rule, they drift, and the
// path that lags silently loses the capability. So this section is asserted
// to be ONE string, embedded verbatim in both prompts.
//
// The second half pins the properties the proposal is explicit about, and
// pins them as ABSENCES as much as presences — those are the ones a future
// "improvement" is most likely to break:
//   - a Business Question is optional (no daily quota);
//   - Sufficiency is not a completeness score (no percentage, no threshold,
//     no N/N, no gate);
//   - stopping the investigation is legal, and unbounded exploration is the
//     named failure mode;
//   - Resolution and Sufficiency stay two different questions.

import { describe, it, expect } from 'vitest';
import { buildInvestigationPrompt } from '#app/runtime/investigation/prompt.js';
import { buildReplayInvestigationPrompt } from '#app/runtime/replay/replay-cognition-kernel.js';
import { EVIDENCE_SUFFICIENCY_SECTION } from '#app/runtime/investigation/analysis-contract.js';
import type { Situation } from '#shared/schemas/learning-context.js';
import type { ReplayRunState } from '#app/runtime/replay/replay-runner-p0013.js';

const situation: Situation = {
  situationId: 'sit_q',
  domain: 'ecommerce',
  type: 'anomaly_investigation',
  entity: { id: 'jd_shop_001', type: 'product', name: '祁门红茶旗舰店', platform: 'jd' },
  temporal: { observedAt: '2026-09-08T00:00:00.000Z' },
  description: '成交金额 较昨日下降 20.0%。',
  tags: ['gmv', 'down'],
};

const run = {
  id: 'rQ',
  shopId: '11855009',
  shopName: '祁门红茶旗舰店',
  sourceDatasetPath: 'data/jd_acquisition_20260914_0231',
  sourceManifestHash: 'h',
  status: 'RUNNING',
  startBusinessDate: '2026-09-02',
  endBusinessDate: '2026-09-12',
  currentBusinessDate: '2026-09-08',
  currentStep: 4,
  blockedBusinessDate: null,
  blockedReason: null,
} as unknown as ReplayRunState;

const productionPrompt = buildInvestigationPrompt(situation, null);
const replayPrompt = buildReplayInvestigationPrompt({
  run,
  businessDate: '2026-09-08',
  visibleEvidence: [],
  priorSnapshots: [],
  priorCognition: [],
  enrichments: [],
});

describe('P0013.4 shared Question-driven Investigation section', () => {
  it('is embedded verbatim in BOTH the production and replay prompts', () => {
    expect(productionPrompt).toContain(EVIDENCE_SUFFICIENCY_SECTION);
    expect(replayPrompt).toContain(EVIDENCE_SUFFICIENCY_SECTION);
  });

  it('states that a Business Question is ALLOWED NOT TO EXIST', () => {
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/ALLOWED NOT TO EXIST/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/NO obligation to produce a question on any day/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/manufacturing one to satisfy this contract is a contract violation/);
  });

  it('defines Decision-changing Evidence and rejects the "may help" grounds', () => {
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/REALISTIC CHANCE of changing your current Hypothesis, Judgment or Recommendation/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/it "might help"/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/would make the analysis more complete/);
  });

  it('states the grain rule with the real window-vs-daily case', () => {
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/A field existing is NOT a requirement being satisfied/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/09-02\.\.09-13/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/CANNOT answer "09-03/);
  });

  it('separates Sufficiency from the existing P0013.2 Evidence Resolution', () => {
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/was the evidence FOUND\?/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/is what we have ENOUGH for this question\?/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/do not build a second retrieval path/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/EXISTING Evidence Resolution rules/);
  });

  it('states the two-directional claim check and that open items need no paperwork', () => {
    // This wording must track analysis-obligations.ts §6d. An earlier version
    // told the Agent every unsatisfied requirement needed a resolution row,
    // and the validator enforced it — which failed a real acceptance turn for
    // an honest forward-looking requirement.
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/Fabric checks both directions of your sufficiency claim/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/is an honest open item and needs no resolution record/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).not.toMatch(/MUST have a matching `evidence_resolutions\[\]` entry/);
  });

  it('names unbounded investigation as the failure mode, not caution', () => {
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/Unbounded investigation is the failure mode here, not caution/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/Reuse the existing `stopReason`/);
  });

  it('defines progress as cognitive-state change, never a count', () => {
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/evidence changing your cognitive state/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/It is NOT: days elapsed, questions asked, tools called/);
  });
});

describe('P0013.4 forbids a new fixed cognition template', () => {
  it('contains no completeness score, ratio, threshold ladder or gate', () => {
    // These are the shapes the proposal bans by name. A future edit that
    // reintroduces "score" / "threshold" as a Sufficiency mechanism would
    // flip this test.
    expect(EVIDENCE_SUFFICIENCY_SECTION).not.toMatch(/completeness\s*[:=]\s*\d/i);
    expect(EVIDENCE_SUFFICIENCY_SECTION).not.toMatch(/Sufficiency\s*(score|%|percentage)/i);
    expect(EVIDENCE_SUFFICIENCY_SECTION).not.toMatch(/\d+\s*\/\s*\d+\s*(resolved|satisfied)/i);
    expect(EVIDENCE_SUFFICIENCY_SECTION).not.toMatch(/threshold ladder/i);
  });

  it('declares Sufficiency is not a completeness measure', () => {
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/It is NOT a completeness measure/);
    expect(EVIDENCE_SUFFICIENCY_SECTION).toMatch(/no percentage, no ratio, no threshold/);
  });
});

describe('P0013.4 output shape carries the new artifacts on both paths', () => {
  it('both prompts ask for business_questions[] and evidence_requirements[]', () => {
    for (const prompt of [productionPrompt, replayPrompt]) {
      expect(prompt).toContain('"business_questions"');
      expect(prompt).toContain('"evidence_requirements"');
      expect(prompt).toContain('"temporal_grain": "daily|window_aggregate|any"');
      expect(prompt).toContain('"decision_relevance"');
    }
  });

  it('the replay prompt declares the grain and subjects of what the run holds', () => {
    // Arrange — the real frozen kinds.
    const heldEvidence = [
      {
        capability: 'trade.overview',
        data_type: 'getSummary',
        rows: 1,
        firstDate: '2026-09-13',
        lastDate: '2026-09-13',
        visibleAtT: 0,
      },
      {
        capability: 'trade.overview',
        data_type: 'getTrend',
        rows: 12,
        firstDate: '2026-09-02',
        lastDate: '2026-09-13',
        visibleAtT: 7,
      },
    ];

    // Act
    const prompt = buildReplayInvestigationPrompt({
      run,
      businessDate: '2026-09-08',
      visibleEvidence: [],
      priorSnapshots: [],
      priorCognition: [],
      enrichments: [],
      heldEvidence,
    });

    // Assert — the Agent can see that the UV/CVR row is a window aggregate
    // and that the per-day row carries only GMV, so it cannot honestly claim
    // a 09-03 daily traffic requirement is satisfied.
    expect(prompt).toMatch(/trade\.overview\/getSummary[^\n]*\n\s+grain=window_aggregate/);
    expect(prompt).toMatch(/trade\.overview\/getTrend[^\n]*\n\s+grain=daily/);
    // The FULL subject list renders: a truncated prefix would drop the
    // traffic indicators, which are precisely what this rule is about.
    expect(prompt).toContain('访客数 UV');
    expect(prompt).toContain('加购率 cart_uv_rate');
    expect(prompt).toMatch(/Cannot answer a single-day question/);
  });
});
