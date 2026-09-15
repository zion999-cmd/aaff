// P0013 — Replay cognition kernel tests (unit, structural).
//
// The real kernel opens a Hermes WS session and calls submitPrompt + collectTurn.
// We CANNOT test that path without a live Hermes (it's exercised end-to-end
// in Phase G: real 3-day run on the operator's Chrome). What we CAN test:
//   - buildReplayInvestigationPrompt emits a prompt grounded ONLY on the
//     visible evidence slice (no future rows, no random additional text)
//   - the kernel's shape is correct (it returns KernelStepResult)
//   - the kernel's prompt includes the §3 boundary assertion
//
// The smoke test of the actual Hermes turn lives in the G phase. A failure
// there (no reply, parseInvestigation contract_invalid) is a real-world
// bug, not a unit-test gap.

import { describe, it, expect } from 'vitest';
import { buildReplayInvestigationPrompt } from '#app/runtime/replay/replay-cognition-kernel.js';
import type { VisibleEvidence } from '#app/runtime/replay/temporal-evidence-view.js';
import type { ReplayRunState } from '#app/runtime/replay/replay-runner-p0013.js';

const sampleRun: ReplayRunState = {
  id: 'r-test-1',
  status: 'RUNNING',
  currentStep: 5,
  currentBusinessDate: '2026-08-08',
  startBusinessDate: '2026-08-04',
  endBusinessDate: '2026-09-02',
  shopId: 'jd_shop_001',
  shopName: '祁门红茶官方旗舰店',
  sourceDatasetPath: 'data/jd_acquisition_20260903_0834',
  sourceManifestHash: 'manifest-hash-abc',
  blockedBusinessDate: null,
  blockedReason: null,
};

const sampleEvidence: VisibleEvidence[] = [
  {
    id: 1,
    shop_id: 'jd_shop_001',
    capability: 'trade.overview',
    data_type: 'getSummary',
    business_date: '2026-08-07',
    business_time_bucket: '2026-08-07T10',
    acquired_at: '2026-08-07T10:00:00Z',
    content_hash: 'h-2026-08-07-1234567890ab',
    evidence_file_path: '/d/2026-08-07.json',
    content_size: 1024,
    created_at: '2026-08-07T10:00:01Z',
    replay_run_id: 'r-test-1',
    replay_run_step_id: 's-1',
  },
  {
    id: 2,
    shop_id: 'jd_shop_001',
    capability: 'trade.overview',
    data_type: 'getTrend',
    business_date: '2026-08-08',
    business_time_bucket: '2026-08-08T10',
    acquired_at: '2026-08-08T10:00:00Z',
    content_hash: 'h-2026-08-08-abcdef123456',
    evidence_file_path: '/d/2026-08-08.json',
    content_size: 2048,
    created_at: '2026-08-08T10:00:01Z',
    replay_run_id: 'r-test-1',
    replay_run_step_id: 's-2',
  },
];

describe('buildReplayInvestigationPrompt', () => {
  it('emits a prompt grounded ONLY on the visible evidence slice (no future rows)', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toContain('business_date <= 2026-08-08');
    expect(prompt).toContain('id=1 business_date=2026-08-07');
    expect(prompt).toContain('id=2 business_date=2026-08-08');
    // The prompt must NOT include any future date in the data list.
    // It MAY mention 08-09 in the boundary assertion ("do not look at 09"),
    // but not in the Current evidence data section.
    const currentSection = prompt.split('## Current evidence')[1]?.split('## ')[0] ?? '';
    expect(currentSection).not.toContain('2026-08-09');
    expect(currentSection).not.toContain('2026-08-10');
  });

  it('includes the §3 boundary assertion explicitly', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toMatch(/business_date <= 2026-08-08/);
    expect(prompt).toMatch(/have NO[\s\S]*access to future days/i);
  });

  it('includes the §10/§14 confirmed_action null invariant', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toMatch(/Confirmed Action is structurally impossible/i);
    expect(prompt).toContain('"confirmed_action": null');
  });

  it('includes the recommendation_executed false invariant (P0013 §14)', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toMatch(/recommendation_executed.*(?:MUST|absent|false)/i);
  });

  it('forbids calling mcp__fabric__fabric_execute_capability (no live acquisition during Replay)', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    // The prompt splits "Do NOT call" and "fabric_execute_capability" across
    // lines, so use [\s\S] to allow newline matching (the `.` flag won't).
    expect(prompt).toMatch(/Do NOT call[\s\S]*fabric_execute_capability/);
  });

  it('includes prior snapshots in the prompt (so the LLM can read its own history)', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [
        {
          business_date: '2026-08-07',
          judgment: '昨天的判断：GMV 正常波动',
          recommendation_text: '继续观察',
        },
      ],
      priorCognition: [],
    });
    expect(prompt).toContain('2026-08-07');
    expect(prompt).toContain('昨天的判断');
  });

  it('emits the canonical Investigation Contract JSON shape', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toContain('"currentUnderstanding"');
    expect(prompt).toContain('"judgment"');
    expect(prompt).toContain('"stopReason"');
    expect(prompt).toContain('"judgment|observe|missing_capability|ask_human"');
    expect(prompt).toContain('"recommendation"');
    expect(prompt).toContain('"confirmed_action": null');
  });

  it('uses Simplified Chinese (zh-CN) for business prose', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toContain('当前理解');
    expect(prompt).toContain('建议');
  });
});

// ─── Epistemic Integrity (2026-09-06) — Prior Cognition (Phase F) ─────
//
// The Replay kernel is the surface most exposed to the L3→L4 silent
// upgrade bug: T-1's hypothesis ("10000+ 新常态") is a HISTORICAL
// HYPOTHESIS at T, not a current fact. The previous kernel just dumped
// prior days' judgments as plain text and let the LLM either re-cite them
// as "still true" (silent L3→L4 upgrade) or ignore them.
//
// The fix: prior_cognition is a TYPED LIST with `status_at_t_minus_1`,
// rendered under a "Prior Cognition (Historical, NOT Current)" section
// that EXPLICITLY tells the LLM "T-1 hypothesis is still hypothesis".
// These tests pin:
//   (1) priorCognition entries are rendered under the new section
//   (2) the section name itself is in the prompt (UX signal)
//   (3) the invariant statement "T-1 status: proposed is still proposed"
//       is verbatim in the prompt
//   (4) the §3 Epistemic Layers (L1-L5) table is in the prompt (NO
//       Replay-only workaround — same contract as production)
//   (5) the §4 Knowledge ≠ Evidence boundary is in the prompt
//   (6) per-claim provenance + threshold provenance are in the prompt
//   (7) the output JSON shape includes epistemic_layers, claim_evidence_refs,
//       thresholds, prior_cognition

describe('buildReplayInvestigationPrompt — Epistemic Integrity (Phase F) Prior Cognition', () => {
  it('renders prior_cognition entries under a dedicated "Prior Cognition (Historical, NOT Current)" section', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [
        {
          business_date: '2026-08-07',
          kind: 'prior_judgment',
          content: '10000+ 新常态成立',
          status_at_t_minus_1: 'proposed',
        },
      ],
    });
    expect(prompt).toMatch(/## Prior Cognition \(Historical, NOT Current/i);
    expect(prompt).toContain('10000+ 新常态成立');
    expect(prompt).toContain('2026-08-07');
    expect(prompt).toContain('prior_judgment');
    expect(prompt).toContain('proposed');
  });

  it('includes the invariant "T-1 status: proposed is still proposed" verbatim', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    // Hard guard: the invariant must appear in the prompt so the LLM
    // sees it before it writes prior_cognition[].status_at_t.
    expect(prompt).toMatch(/T-1[\s\S]*status: proposed[\s\S]*STILL[\s\S]*proposed/);
  });

  it('includes the L1-L5 Epistemic Layers section (no Replay-only workaround)', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toMatch(/## Epistemic Layers/);
    expect(prompt).toContain('L1 Observed Fact');
    expect(prompt).toContain('L2 Pattern');
    expect(prompt).toContain('L3 Hypothesis');
    expect(prompt).toContain('L4 Confirmed');
    expect(prompt).toContain('L5 Judgment');
  });

  it('includes the "Knowledge ≠ Evidence" boundary section', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toMatch(/## Knowledge.*Evidence/i);
  });

  it('includes per-claim provenance + threshold provenance sections', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toMatch(/Per-claim provenance/i);
    expect(prompt).toMatch(/Threshold provenance/i);
  });

  it('output JSON shape includes epistemic_layers, claim_evidence_refs, thresholds, prior_cognition', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [],
    });
    expect(prompt).toContain('"epistemic_layers"');
    expect(prompt).toContain('"claim_evidence_refs"');
    expect(prompt).toContain('"thresholds"');
    expect(prompt).toContain('"prior_cognition"');
  });

  it('rendered prior_cognition[] is a flat list, not free prose', () => {
    const prompt = buildReplayInvestigationPrompt({
      run: sampleRun,
      businessDate: '2026-08-08',
      visibleEvidence: sampleEvidence,
      priorSnapshots: [],
      priorCognition: [
        { business_date: '2026-08-04', kind: 'prior_hypothesis', content: 'A', status_at_t_minus_1: 'proposed' },
        { business_date: '2026-08-05', kind: 'prior_hypothesis', content: 'B', status_at_t_minus_1: 'proposed' },
        { business_date: '2026-08-06', kind: 'prior_judgment', content: 'C', status_at_t_minus_1: 'proposed' },
      ],
    });
    // Each row must show business_date, kind, status_at_t_minus_1, content.
    const section =
      prompt.split('## Prior Cognition (Historical, NOT Current')[1]?.split('## ')[0] ?? '';
    expect(section).toContain('2026-08-04');
    expect(section).toContain('2026-08-05');
    expect(section).toContain('2026-08-06');
    expect(section).toContain('prior_hypothesis');
    expect(section).toContain('prior_judgment');
  });
});
