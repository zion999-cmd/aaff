// P0013.4 — export the EXACT prompts Fabric sends to Hermes, one per business day.
//
// This does not re-author, summarise, or "improve" anything. It calls the
// shipped `buildReplayInvestigationPrompt` — the same function the Replay kernel
// calls at runtime — with the same data the kernel passes, and writes the
// returned string to disk. Whatever this file outputs IS the prompt Fabric
// sends; fidelity is established by construction, and then checked against a
// prompt captured from a real run.
//
// READ-ONLY: it opens the Fabric DB read-only and writes only to --out.
// It does not run Hermes, does not touch the profile, and changes no code.
//
// Usage:
//   npx tsx scripts/p0013-4-export-prompts.ts <runId> <outDir> [--prior=empty|real]
//
// --prior=real   inject the run's own persisted prior-day cognition (this is
//                what a real multi-day run does; only available for days whose
//                predecessors actually completed).
// --prior=empty  leave the prior-cognition blocks empty, as on day 1. The
//                package ships this for all days because a faithful day-N
//                prior block depends on the outputs of days the manual run has
//                not produced yet.

import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReplayInvestigationPrompt } from '../apps/ecommerce/runtime/replay/replay-cognition-kernel.js';
import { getReplayRunState } from '../apps/ecommerce/runtime/replay/replay-runner-p0013.js';
import {
  visibleEvidenceFor,
  heldEvidenceFor,
} from '../apps/ecommerce/runtime/replay/temporal-evidence-view.js';
import { visibleEnrichmentsAt } from '../apps/ecommerce/runtime/replay/enrichment-store.js';

const [, , runId, outDir, ...flags] = process.argv;
if (!runId || !outDir) {
  process.stderr.write('usage: p0013-4-export-prompts.ts <runId> <outDir> [--prior=empty|real]\n');
  process.exit(2);
}
const priorMode = flags.includes('--prior=real') ? 'real' : 'empty';

const db = new Database('data/agentfabric.db', { readonly: true, fileMustExist: true });
const run = getReplayRunState(db, runId);
mkdirSync(outDir, { recursive: true });

/** Every business date in the run window, inclusive. */
const datesIn = (start: string, end: string): string[] => {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

/** The run's own persisted prior-day cognition, as the kernel loads it. */
const priorFor = (businessDate: string) => {
  if (priorMode === 'empty') return { priorSnapshots: [], priorCognition: [] };
  const rows = db
    .prepare(
      `SELECT s.business_date, snap.judgment, snap.recommendation_text, snap.raw_investigation_json
         FROM replay_run_steps s
         JOIN replay_run_cognitive_snapshots snap ON snap.replay_run_step_id = s.id
        WHERE s.replay_run_id = ? AND s.business_date < ?
        ORDER BY s.business_date ASC`,
    )
    .all(runId, businessDate) as Array<{
    business_date: string;
    judgment: string;
    recommendation_text: string;
    raw_investigation_json: string;
  }>;
  const priorSnapshots = rows.map((r) => ({
    business_date: r.business_date,
    judgment: r.judgment,
    recommendation_text: r.recommendation_text,
  }));
  const priorCognition = rows.map((r) => {
    const inv = JSON.parse(r.raw_investigation_json) as {
      judgment?: string;
      businessQuestions?: unknown[];
    };
    return {
      business_date: r.business_date,
      kind: 'prior_judgment' as const,
      content: inv.judgment ?? '',
      status_at_t_minus_1: 'proposed' as const,
    };
  });
  return { priorSnapshots, priorCognition };
};

const index: string[] = [
  '# Fabric → Hermes prompt index',
  '',
  `- source run: \`${runId}\``,
  `- window: ${run.startBusinessDate} → ${run.endBusinessDate}`,
  `- prior-cognition mode: \`${priorMode}\``,
  '',
  '| business date | prompt file | prompt bytes | visible evidence rows | held kinds | enrichments | prior-cognition entries |',
  '|---|---|---|---|---|---|---|',
];

for (const date of datesIn(run.startBusinessDate, run.endBusinessDate)) {
  const visibleEvidence = visibleEvidenceFor(db, runId, date);
  const heldEvidence = heldEvidenceFor(db, runId, date);
  const enrichments = visibleEnrichmentsAt(db, runId, date);
  const { priorSnapshots, priorCognition } = priorFor(date);

  const prompt = buildReplayInvestigationPrompt({
    run,
    businessDate: date,
    visibleEvidence,
    priorSnapshots,
    priorCognition,
    enrichments,
    heldEvidence,
  });

  const file = `day-${date}-prompt.txt`;
  writeFileSync(join(outDir, file), prompt, 'utf8');
  index.push(
    `| ${date} | \`${file}\` | ${Buffer.byteLength(prompt, 'utf8')} | ${visibleEvidence.length} | ` +
      `${heldEvidence.length} | ${enrichments.length} | ${priorCognition.length} |`,
  );
}

writeFileSync(join(outDir, 'prompt-index.md'), `${index.join('\n')}\n`, 'utf8');
process.stdout.write(`${index.join('\n')}\n`);
db.close();
