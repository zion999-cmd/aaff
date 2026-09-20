// P0013.1 — Exploration goal language contract (SC3).
//
// Fabric hands Hermes a business NEED + an EVIDENCE CONTRACT, never a
// technical walkthrough. The goal must name the business facts and the
// required intake artifacts, but MUST NOT contain endpoint names, token
// names, signing machinery, script filenames, or the methods discovered
// during the first acquisition. The first acquisition proved Hermes can
// discover those itself; leaking them in the contract would invalidate
// the SC4 reuse-vs-rediscovery experiment.
//
// Source-level for the same reason as workspace contract tests: the goal
// is emitted text, not a runtime schema.

import { describe, it, expect } from 'vitest';
import { buildExplorationGoal } from '#app/runtime/acquisition/exploration-goal.js';
import { HistoricalEvidenceNeedSchema } from '#shared/contracts/historical-evidence-need.js';

const need = HistoricalEvidenceNeedSchema.parse({
  subject: { shopId: '11855009', shopName: '祁门红茶官方旗舰店' },
  source: 'jd',
  purpose: 'historical_replay',
  window: { start: '2026-09-03', end: '2026-09-12' },
  domains: ['trade', 'orders'],
});

const goal = buildExplorationGoal({
  need,
  intakeDir: '/abs/data/_acquisition_intake/hacq_test',
  jobId: 'hacq_test',
});

describe('exploration goal — required contract content', () => {
  it('names the business subject and requested window (Need Contract)', () => {
    expect(goal).toContain('祁门红茶官方旗舰店');
    expect(goal).toContain('11855009');
    expect(goal).toContain('2026-09-03');
    expect(goal).toContain('2026-09-12');
    expect(goal).toMatch(/trade/i);
    expect(goal).toMatch(/order/i);
  });

  it('states the intake Evidence Contract artifacts (4 canonical files + result + candidate)', () => {
    for (const name of [
      'target_a_summary_decoded.json',
      'target_a_trend_parsed.json',
      'target_b_order_detail_summary.json',
      'target_b_order_detail_parsed.json',
      'result.json',
      'candidate.json',
    ]) {
      expect(goal, `must require ${name}`).toContain(name);
    }
    expect(goal).toMatch(/intake/i);
  });

  it('demands a reuse inventory: reused / rediscovered / newly built (SC4/SC10)', () => {
    expect(goal).toMatch(/reuse/i);
    expect(goal).toMatch(/existing asset/i);
    expect(goal).toMatch(/reused/i);
    expect(goal).toMatch(/rediscovered/i);
    expect(goal).toMatch(/newly built/i);
  });

  it('states execution boundaries about the real browser and operator focus', () => {
    expect(goal).toMatch(/9222/);
    expect(goal).toMatch(/existing tab/i);
  });

  it('states truthful-window and failure semantics', () => {
    expect(goal).toMatch(/actual window/i);
    expect(goal).toMatch(/requested/i);
    expect(goal).toMatch(/BLOCKED/);
    expect(goal).toMatch(/ACQUISITION FAILED/);
    expect(goal).toMatch(/VERIFICATION FAILED/);
  });
});

describe('exploration goal — forbidden technical walkthrough', () => {
  const forbidden = [
    /getDealOrders/i,
    /getSummary/i,
    /getTrend/i,
    /\.ajax/i,
    /user-mnp/i,
    /SzDPParams/i,
    /page\.route/i,
    /acquire_jd/i,
    /cdp-client/i,
    /connect_over_cdp/i,
    /webpack/i,
  ];
  for (const term of forbidden) {
    it(`contains no ${term} hint`, () => {
      expect(goal).not.toMatch(term);
    });
  }
});
