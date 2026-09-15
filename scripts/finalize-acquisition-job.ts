// P0013.1 — operator salvage for an acquisition job whose Hermes turn
// ended with a lifecycle error (e.g. turn.complete never observed after
// the 30-min client timeout) AFTER all intake deliverables landed.
//
// This re-runs the SAME formal gate as startAcquisitionJob:
//   result.json + candidate.json schema validation
//   → candidate evidence files exist + pending_review
//   → freezeHistoricalDataset (actual window re-derived from files,
//     business reconciliation gate, machine manifest with per-file hashes)
//
// Nothing is bypassed. If the intake is unusable the job stays FAILED and
// no dataset is frozen. The timeout is recorded truthfully as turn_note.
//
// Usage: npx tsx scripts/finalize-acquisition-job.ts <jobId>

import { resolve } from 'node:path';
import { openDb } from '#platform/storage/connection.js';
import { applyP0013Schema } from '#platform/storage/p0013-schema.js';
import { getAcquisitionJob } from '#app/runtime/acquisition/job-store.js';
import { finalizeAcquisitionIntake } from '#app/runtime/acquisition/acquisition-orchestrator.js';

const jobId = process.argv[2];
if (!jobId) throw new Error('usage: finalize-acquisition-job.ts <jobId>');

const db = openDb();
applyP0013Schema(db); // idempotent; ensures turn_note column exists
try {
  const job = getAcquisitionJob(db, jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);
  if (!['BLOCKED', 'FAILED', 'INTERRUPTED'].includes(job.status)) {
    throw new Error(`job ${jobId} is ${job.status}; salvage applies only to BLOCKED/FAILED/INTERRUPTED`);
  }
  const dataRoot = resolve(process.cwd(), 'data');
  const note =
    'salvaged after turn lifecycle error: intake deliverables validated and frozen ' +
    'by the same formal gate (no bypass); see trajectory/events.ndjson for details';
  const finalRow = finalizeAcquisitionIntake(db, job, { dataRoot }, note);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    status: finalRow.status,
    failureCode: finalRow.failureCode,
    errorMessage: finalRow.errorMessage,
    datasetDirName: finalRow.datasetDirName,
    manifestHash: finalRow.manifestHash,
    candidateId: finalRow.candidateId,
    actualStart: finalRow.actualStart,
    actualEnd: finalRow.actualEnd,
  }, null, 2));
  if (finalRow.status !== 'SUCCEEDED') process.exitCode = 1;
} finally {
  db.close();
}
