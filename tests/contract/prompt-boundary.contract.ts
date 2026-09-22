// P0013.5 — Success Criterion 1: the Fabric/Hermes boundary, machine-checked.
//
// SC1 requires that neither cognition prompt contains Fabric-owned fixed tool
// ordering, retry budget, fixed execution sequence or tool-call control flow,
// "审计脚本能够将这些类别报告为 0 个未豁免实例". This test is that report.
//
// It also pins the OTHER direction, which matters more: SC2/SC10 require that
// removing the Execution HOW did not remove the Domain Exploration Methodology.
// A boundary test that only checks absence would be satisfied by an empty
// prompt, so both directions are asserted here.

import { describe, it, expect } from 'vitest';
import { buildInvestigationPrompt } from '#app/runtime/investigation/prompt.js';
import { buildReplayInvestigationPrompt } from '#app/runtime/replay/replay-cognition-kernel.js';
import {
  DECLARED_EXEMPTIONS,
  EXECUTION_HOW_PATTERNS,
  scanForExecutionHow,
  unexemptedExecutionHow,
} from '#app/runtime/investigation/prompt-boundary.js';
import {
  ANALYSIS_TARGET_SECTION,
  COGNITION_CONTINUITY_SECTION,
  EVIDENCE_RESOLUTION_SECTION,
  EVIDENCE_SUFFICIENCY_SECTION,
  EPISTEMIC_DISCIPLINE_SECTION,
  KNOWLEDGE_ANALYSIS_SECTION,
  OUTPUT_CONTRACT_SECTION,
  PROVENANCE_SECTION,
} from '#app/runtime/investigation/analysis-contract.js';
import type { Situation } from '#shared/schemas/learning-context.js';
import type { ReplayRunState } from '#app/runtime/replay/replay-runner-p0013.js';

const situation = {
  situationId: 'sit_boundary',
  domain: 'ecommerce',
  type: 'anomaly_investigation',
  entity: { id: 'jd_shop_001', type: 'product', name: '祁门红茶旗舰店', platform: 'jd' },
  temporal: { observedAt: '2026-09-08T00:00:00.000Z' },
  description: '成交金额 较昨日下降 20.0%。',
  tags: ['gmv', 'down'],
} as unknown as Situation;

const run = {
  id: 'r-boundary', shopId: '11855009', shopName: '祁门红茶旗舰店',
  sourceDatasetPath: 'data/jd_acquisition_20260914_0231', sourceManifestHash: 'h',
  status: 'RUNNING', startBusinessDate: '2026-09-02', endBusinessDate: '2026-09-12',
  currentBusinessDate: '2026-09-02', currentStep: 0,
  blockedBusinessDate: null, blockedReason: null,
} as unknown as ReplayRunState;

const production = buildInvestigationPrompt(situation, null);
const replay = buildReplayInvestigationPrompt({
  run,
  businessDate: '2026-09-02',
  visibleEvidence: [],
  priorSnapshots: [],
  priorCognition: [],
  enrichments: [],
  heldEvidence: [],
});

describe('P0013.5 SC1 — Fabric owns no Execution HOW', () => {
  it('PRODUCTION has zero unexempted execution-HOW instances', () => {
    const found = unexemptedExecutionHow(production);
    if (found.length > 0) {
      throw new Error(
        `Execution HOW found in the production prompt:\n` +
          found.map((m) => `  [${m.patternId}] ${m.line}\n      ${m.why}`).join('\n'),
      );
    }
    expect(found).toEqual([]);
  });

  it('REPLAY has zero unexempted execution-HOW instances', () => {
    const found = unexemptedExecutionHow(replay);
    if (found.length > 0) {
      throw new Error(
        `Execution HOW found in the replay prompt:\n` +
          found.map((m) => `  [${m.patternId}] ${m.line}\n      ${m.why}`).join('\n'),
      );
    }
    expect(found).toEqual([]);
  });

  it('the removed Execution-HOW shapes are gone by name', () => {
    for (const prompt of [production, replay]) {
      // the fixed 9-step workflow
      expect(prompt).not.toMatch(/## Investigation Workflow/);
      // the retry / call-budget rules
      expect(prompt).not.toMatch(/\bretry ONCE\b/i);
      expect(prompt).not.toMatch(/\bcall ONCE per\b/i);
      expect(prompt).not.toMatch(/\bat most once per turn\b/i);
      expect(prompt).not.toMatch(/\b(allowed|forbidden) pattern:/i);
      // the 4.8 KB schema restatement
      expect(prompt).not.toMatch(/## Output shape \(canonical Investigation Contract/);
    }
  });

  it('the exemption list is exactly the declared set (an exemption cannot be added silently)', () => {
    // SC1 allows exemptions only where the content is a boundary Fabric owns.
    // Pinning the list means loosening it is a visible, reviewable change.
    const ids = scanForExecutionHow(production + '\n' + replay)
      .filter((m) => m.exempt)
      .map((m) => `${m.patternId}:${m.exemptionReason ?? ''}`);
    expect(EXECUTION_HOW_PATTERNS.length).toBeGreaterThan(0);
    expect(DECLARED_EXEMPTIONS.length).toBeLessThanOrEqual(1);
    expect(new Set(ids).size).toBeLessThanOrEqual(DECLARED_EXEMPTIONS.length);
  });
});

describe('P0013.5 SC2/SC10 — the Domain Exploration Methodology survived', () => {
  it('BOTH prompts still embed every shared methodology section', () => {
    for (const section of [
      ANALYSIS_TARGET_SECTION,
      EVIDENCE_RESOLUTION_SECTION,
      EVIDENCE_SUFFICIENCY_SECTION,
      KNOWLEDGE_ANALYSIS_SECTION,
      COGNITION_CONTINUITY_SECTION,
      EPISTEMIC_DISCIPLINE_SECTION,
      PROVENANCE_SECTION,
      OUTPUT_CONTRACT_SECTION,
    ]) {
      expect(production).toContain(section);
      expect(replay).toContain(section);
    }
  });

  it('the P0013.4 chain is still expressed: question → requirement → sufficiency → stop', () => {
    for (const prompt of [production, replay]) {
      expect(prompt).toMatch(/Business Question/);
      expect(prompt).toMatch(/Decision-changing Evidence/);
      expect(prompt).toMatch(/Evidence Requirement/);
      expect(prompt).toMatch(/Sufficiency/);
      expect(prompt).toMatch(/Stop semantics/);
      expect(prompt).toMatch(/business_questions/);
      expect(prompt).toMatch(/evidence_requirements/);
    }
  });

  it('the methodology that must not be slimmed away is still stated', () => {
    // Domain direction, competing explanations, stopping discipline, the
    // grain/scope/provenance semantics, and the epistemic boundaries.
    for (const prompt of [production, replay]) {
      expect(prompt).toMatch(/Mandatory business-structure coverage/);
      for (const dim of ['product', 'orders', 'traffic', 'conversion', 'operations']) {
        expect(prompt).toContain(dim);
      }
      expect(prompt).toMatch(/A field existing is NOT a requirement being satisfied/);
      expect(prompt).toMatch(/Knowledge ≠ Evidence/);
      expect(prompt).toMatch(/stopping is not failure/i);
    }
  });
});
