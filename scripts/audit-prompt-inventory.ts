// Read-only audit helper — measure the cognition prompts Fabric builds.
//
// Calls the SHIPPED builders with representative inputs and reports size and
// section structure. It sends nothing to Hermes, opens no session, and writes
// no files. Used by the fabric-prompt-contract-audit deliverables so the
// inventory is measured rather than estimated.
//
// Usage: npx tsx scripts/audit-prompt-inventory.ts

import { buildInvestigationPrompt } from '../apps/ecommerce/runtime/investigation/prompt.js';
import { buildReplayInvestigationPrompt } from '../apps/ecommerce/runtime/replay/replay-cognition-kernel.js';
import { buildReplayLightPrompt } from '../apps/ecommerce/runtime/replay/replay-prompt-light.js';
import type { Situation } from '../shared/schemas/learning-context.js';
import type { ReplayRunState } from '../apps/ecommerce/runtime/replay/replay-runner-p0013.js';

const situation = {
  situationId: 'sit_audit',
  domain: 'ecommerce',
  type: 'anomaly_investigation',
  entity: { id: 'jd_shop_001', type: 'product', name: '祁门红茶旗舰店', platform: 'jd' },
  temporal: { observedAt: '2026-09-08T00:00:00.000Z' },
  description: '成交金额 较昨日下降 20.0%。',
  tags: ['gmv', 'down'],
} as unknown as Situation;

const run = {
  id: 'r-audit', shopId: '11855009', shopName: '祁门红茶旗舰店',
  sourceDatasetPath: 'data/jd_acquisition_20260914_0231', sourceManifestHash: 'h',
  status: 'RUNNING', startBusinessDate: '2026-09-02', endBusinessDate: '2026-09-12',
  currentBusinessDate: '2026-09-02', currentStep: 0,
  blockedBusinessDate: null, blockedReason: null,
} as unknown as ReplayRunState;

const sections = (text: string): Array<{ heading: string; bytes: number }> => {
  const lines = text.split('\n');
  const out: Array<{ heading: string; bytes: number }> = [];
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (cur !== null) out.push({ heading: cur, bytes: Buffer.byteLength(buf.join('\n'), 'utf8') });
  };
  for (const l of lines) {
    if (l.startsWith('## ') || l.startsWith('### ')) {
      flush();
      cur = l;
      buf = [l];
    } else {
      if (cur === null) cur = '(preamble)';
      buf.push(l);
    }
  }
  flush();
  return out;
};

const report = (name: string, text: string): void => {
  const bytes = Buffer.byteLength(text, 'utf8');
  console.log(`\n########## ${name}`);
  console.log(`  total: ${bytes} bytes, ${text.split('\n').length} lines`);
  for (const s of sections(text)) {
    const pct = ((s.bytes / bytes) * 100).toFixed(1);
    console.log(`    ${pct.padStart(5)}%  ${String(s.bytes).padStart(6)} B  ${s.heading.slice(0, 70)}`);
  }
};

// Production investigation prompt (empty evidence/prompt context — the shape
// and the contract prose dominate; real evidence adds to it).
report('PRODUCTION buildInvestigationPrompt', buildInvestigationPrompt(situation, null));

// Replay heavy, day 1 shape (empty evidence: contract prose only).
report(
  'REPLAY buildReplayInvestigationPrompt (no evidence)',
  buildReplayInvestigationPrompt({
    run, businessDate: '2026-09-02', visibleEvidence: [],
    priorSnapshots: [], priorCognition: [], enrichments: [], heldEvidence: [],
  }),
);

report(
  'REPLAY buildReplayLightPrompt (no evidence)',
  buildReplayLightPrompt({
    run, businessDate: '2026-09-02', visibleEvidence: [],
    priorCognition: [], enrichments: [], heldEvidence: [],
  }),
);
