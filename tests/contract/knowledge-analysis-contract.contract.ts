// P0013.5 — Shared Knowledge obligation contract.
//
// The 2026-09-16 audit found the two analysis paths disagreed on professional
// Knowledge: production instructed a three-layer `knowledge/INDEX.md`
// navigation step, replay carried only the `Knowledge ≠ Evidence`
// prohibition. Measured consequence in the current contract era: 2/28 real
// replay sessions read any knowledge page (0/12 on the audit day) — replay
// cognition ran on Evidence + five-dimension structure + continuity alone.
//
// These assertions pin the fix:
//   - ONE shared section, embedded verbatim in both prompts;
//   - it states navigation (index-first, index-drives-page), bounded reading,
//     use-as-method, hypothesis-from-Knowledge+Evidence, and the boundary;
//   - neither prompt keeps a forked path-specific restatement of the rule.
//
// Source + rendered-prompt level (the prompts are emitted text).

import { describe, it, expect } from 'vitest';
import { buildInvestigationPrompt } from '#app/runtime/investigation/prompt.js';
import { buildReplayInvestigationPrompt } from '#app/runtime/replay/replay-cognition-kernel.js';
import { KNOWLEDGE_ANALYSIS_SECTION } from '#app/runtime/investigation/analysis-contract.js';
import type { Situation } from '#shared/schemas/learning-context.js';
import type { ReplayRunState } from '#app/runtime/replay/replay-runner-p0013.js';

const situation: Situation = {
  situationId: 'sit_k',
  domain: 'ecommerce',
  type: 'anomaly_investigation',
  entity: { id: 'jd_shop_001', type: 'product', name: '祁门红茶旗舰店', platform: 'jd' },
  temporal: { observedAt: '2026-09-08T00:00:00.000Z' },
  description: '成交金额 较昨日下降 20.0%。',
  tags: ['gmv', 'down'],
};

const run = {
  id: 'rK',
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

describe('P0013.5 shared Knowledge obligation', () => {
  it('the shared section names the index as an available asset without mandating a search procedure', () => {
    // P0013.5 (Design §6) removed the prescribed index-first SEQUENCE: how to
    // search is Execution HOW and belongs to the Runtime. What must survive is
    // that the Agent knows the index exists and that no page is compulsory.
    expect(KNOWLEDGE_ANALYSIS_SECTION).toContain('knowledge/INDEX.md');
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/semantic router/i);
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/domain has its own `INDEX\.md`/i);
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/How you search it is yours to decide/i);
  });

  it('the shared section keeps reading unbounded by quota (no compulsory page)', () => {
    // The old "exactly ONE page, a second only if cross-referenced" rule was a
    // reading procedure. The requirement that survives — and the one that
    // matters for behaviour — is that no page is mandatory and no reference
    // count is required.
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/no required number of knowledge references and no page you must read/i);
  });

  it('the shared section requires using Knowledge as method, with Evidence as the world', () => {
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/tells you HOW to read/i);
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/Evidence tells you what is actually true/i);
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/Knowledge together with Evidence may produce a/i);
  });

  it('the shared section forbids count/checklist framing of Knowledge', () => {
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/no required number of knowledge references/i);
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/no page you must read on a given day/i);
  });

  it('the shared section keeps the Knowledge != Evidence boundary (no manufacture / no override / no causation proof)', () => {
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/manufacture current-world fact/i);
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/overriding or replacing a current metric/i);
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/proof of a causal link/i);
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/hypotheses\[\]` with explicit `missing_evidence/i);
  });

  it('BOTH prompts embed the shared section verbatim (no per-path fork)', () => {
    expect(productionPrompt).toContain(KNOWLEDGE_ANALYSIS_SECTION);
    expect(replayPrompt).toContain(KNOWLEDGE_ANALYSIS_SECTION);
  });

  it('BOTH prompts carry the shared Knowledge section, and it names the index', () => {
    for (const prompt of [productionPrompt, replayPrompt]) {
      expect(prompt).toContain(KNOWLEDGE_ANALYSIS_SECTION);
      expect(prompt).toContain('knowledge/INDEX.md');
      expect(prompt).toMatch(/never evidence about what happened in this shop today/i);
    }
  });

  it('BOTH prompts make Knowledge + Evidence a hypothesis source', () => {
    // P0013.5 removed the fixed Investigation Workflow that used to carry this
    // sentence. The requirement is unchanged and now lives once, in the shared
    // section both prompts embed.
    expect(KNOWLEDGE_ANALYSIS_SECTION).toMatch(/Knowledge together with Evidence may produce a `hypotheses\[\]` entry/);
    for (const prompt of [productionPrompt, replayPrompt]) {
      expect(prompt).toContain(KNOWLEDGE_ANALYSIS_SECTION);
    }
  });

  it('replay no longer restricts reading to the single retrieval tool', () => {
    // The boundary must scope the single-tool rule to ACQUISITION, otherwise
    // the shared Knowledge section is contradicted by the same prompt.
    expect(replayPrompt).toMatch(/only permitted\s+ACQUISITION tool/i);
    expect(replayPrompt).not.toMatch(/The ONE permitted tool\s+call/i);
    expect(replayPrompt).toMatch(/you READ[\s\S]{0,80}never write/i);
  });

  it('production no longer carries its own duplicate Knowledge navigation paragraph', () => {
    // The old production-only block restated navigation + anomaly-gate detail
    // that now lives in the shared section. One statement, one place.
    expect(productionPrompt).not.toMatch(/Navigate in three layers/i);
    expect(productionPrompt).not.toMatch(/The anomaly gate is inlined in the root INDEX/i);
  });

  it('the Evidence Resolution rule is scoped to Evidence, not to all file reads', () => {
    expect(productionPrompt).toMatch(/bypass the retrieval surface to obtain EVIDENCE/i);
    expect(replayPrompt).toMatch(/bypass the retrieval surface to obtain EVIDENCE/i);
    expect(productionPrompt).not.toMatch(/Do NOT read arbitrary files/);
    expect(replayPrompt).not.toMatch(/Do NOT read arbitrary files/);
  });
});
