// P0013.5 — Replay Evidence-Universe + KPI-representation contract.
//
// The 2026-09-16 cognition-path audit found Replay had no analogue of
// Production's `capabilities/INDEX.md`: the Agent saw only what happened to
// be rendered, so "this run never collected it" and "it is collected but not
// in my prompt" looked identical — and both became an Evidence Gap. Two
// representation defects compounded it:
//   - the getSummary renderer emitted a hardcoded 4 of the file's 12 KPIs,
//     dropping 访客数(UV)/浏览量(PV)/加购 entirely, and its comment claimed a
//     KPI set the file does not have;
//   - nothing said that getSummary is ONE aggregate over the whole
//     acquisition window, so it could be read as a single-day fact.
//
// These assertions pin the fix: the prompt now carries a generated inventory
// of the run's holdings, and the aggregate renders every KPI it actually has
// with its coverage window stated.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { buildReplayInvestigationPrompt } from '#app/runtime/replay/replay-cognition-kernel.js';
import type { ReplayRunState } from '#app/runtime/replay/replay-runner-p0013.js';
import type { HeldEvidenceKind } from '#app/runtime/replay/temporal-evidence-view.js';

const run = {
  id: 'rU',
  shopId: '11855009',
  shopName: '祁门红茶旗舰店',
  sourceDatasetPath: 'data/jd_acquisition_20260914_0231',
  sourceManifestHash: 'h',
  status: 'RUNNING',
  startBusinessDate: '2026-09-02',
  endBusinessDate: '2026-09-12',
  currentBusinessDate: '2026-09-04',
  currentStep: 3,
  blockedBusinessDate: null,
  blockedReason: null,
} as unknown as ReplayRunState;

// The real shape of this dataset: per-day series, plus ONE window aggregate
// whose business_date is the dataset's end date.
const held: HeldEvidenceKind[] = [
  { capability: 'order.overview', data_type: 'perDaySummary', rows: 11, firstDate: '2026-09-02', lastDate: '2026-09-12', visibleAtT: 3 },
  { capability: 'order.overview', data_type: 'perOrder', rows: 11, firstDate: '2026-09-02', lastDate: '2026-09-12', visibleAtT: 3 },
  { capability: 'trade.overview', data_type: 'getSummary', rows: 1, firstDate: '2026-09-13', lastDate: '2026-09-13', visibleAtT: 0 },
  { capability: 'trade.overview', data_type: 'getTrend', rows: 11, firstDate: '2026-09-02', lastDate: '2026-09-12', visibleAtT: 3 },
];

const build = (heldEvidence: HeldEvidenceKind[] = held) =>
  buildReplayInvestigationPrompt({
    run,
    businessDate: '2026-09-04',
    visibleEvidence: [],
    priorSnapshots: [],
    priorCognition: [],
    heldEvidence,
  });

describe('replay Evidence Universe', () => {
  it('states the run is frozen and the inventory is the whole world', () => {
    const p = build();
    expect(p).toContain('## Evidence Universe of this run (complete inventory — the dataset is frozen)');
    expect(p).toMatch(/this list IS the\s+whole world available to this run/);
  });

  it('lists each held capability/data_type with coverage and T-availability', () => {
    const p = build();
    expect(p).toContain('trade.overview/getTrend — 11 rows, business_date 2026-09-02..2026-09-12 — 3/11 visible at T=2026-09-04');
    expect(p).toContain('order.overview/perOrder — 11 rows, business_date 2026-09-02..2026-09-12 — 3/11 visible at T=2026-09-04');
  });

  it('marks a held-but-not-yet-visible row as not available today (the window aggregate)', () => {
    const p = build();
    expect(p).toContain('trade.overview/getSummary — 1 rows, business_date 2026-09-13 — 0 visible at T=2026-09-04 (not available today)');
  });

  it('separates "never collected" from "not in my prompt"', () => {
    const p = build();
    expect(p).toMatch(/if it is NOT listed at all, the frozen dataset never acquired it/);
    expect(p).toMatch(/do NOT describe a fact that was never collected as "hidden from me"/);
    expect(p).toMatch(/do NOT report a collected fact as missing/);
  });

  it('does not turn the inventory into a checklist', () => {
    expect(build()).toMatch(/Do not treat this inventory as an agenda/);
  });

  it('degrades honestly when the run holds nothing', () => {
    expect(build([])).toContain('(the run holds no evidence rows)');
  });

  it('existing callers that omit heldEvidence still get a valid prompt', () => {
    const p = buildReplayInvestigationPrompt({
      run,
      businessDate: '2026-09-04',
      visibleEvidence: [],
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(p).toContain('## Evidence Universe of this run');
    expect(p).toContain('(the run holds no evidence rows)');
  });
});

// Renders the REAL frozen KPI file when it is present. The audit found the
// renderer emitted 4 of its 12 KPIs and never said the file is a window
// aggregate; both defects are pinned here against the actual artifact.
describe('getSummary representation (real frozen artifact)', () => {
  const SUMMARY = 'data/jd_acquisition_20260914_0231/target_a_summary_decoded.json';
  const has = existsSync(SUMMARY);

  it.runIf(has)('renders every KPI the file carries, including the traffic block', () => {
    const p = buildReplayInvestigationPrompt({
      run,
      businessDate: '2026-09-13',
      visibleEvidence: [
        {
          id: 5837,
          shop_id: '11855009',
          capability: 'trade.overview',
          data_type: 'getSummary',
          business_date: '2026-09-13',
          business_time_bucket: '2026-09-13T10',
          acquired_at: '2026-09-14T00:00:00.000Z',
          content_hash: 'deadbeefdeadbeef',
          evidence_file_path: SUMMARY,
          content_size: 5649,
          created_at: '2026-09-14T00:00:00.000Z',
          replay_run_id: 'rU',
          replay_run_step_id: null,
        } as never,
      ],
      priorSnapshots: [],
      priorCognition: [],
    });
    // The traffic + conversion block the operator asked about.
    expect(p).toContain('UV 访客数=');
    expect(p).toContain('PV 浏览量=');
    expect(p).toContain('CVR 转化率=');
    expect(p).toContain('加购');
  });

  it.runIf(has)('states the window the aggregate covers, so it cannot read as a single day', () => {
    const p = buildReplayInvestigationPrompt({
      run,
      businessDate: '2026-09-13',
      visibleEvidence: [
        {
          id: 5837,
          shop_id: '11855009',
          capability: 'trade.overview',
          data_type: 'getSummary',
          business_date: '2026-09-13',
          business_time_bucket: '2026-09-13T10',
          acquired_at: '2026-09-14T00:00:00.000Z',
          content_hash: 'deadbeefdeadbeef',
          evidence_file_path: SUMMARY,
          content_size: 5649,
          created_at: '2026-09-14T00:00:00.000Z',
          replay_run_id: 'rU',
          replay_run_step_id: null,
        } as never,
      ],
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(p).toMatch(/覆盖 2026-09-02\.\.2026-09-13（整段窗口聚合，非单日值）/);
  });
});
