// P0013.1 — dynamic historical acquisition orchestrator.
//
// Need → coverage/gap (pure) → capability resolution (explore in V1)
// → real Hermes turn with the BLIND Need+Evidence goal → intake
// validation → candidate persistence → dataset freeze. The Hermes turn
// is a REAL session client in production (anti-stub contract test);
// tests inject a fake TurnRunner that deposits real intake files, which
// only proves integration, never business acceptance (S0002 §2.2/§6).

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { HistoricalEvidenceNeedSchema, type HistoricalEvidenceNeed } from '#shared/contracts/historical-evidence-need.js';
import { HistoricalEvidenceResultSchema, type HistoricalEvidenceResult } from '#shared/contracts/historical-evidence-result.js';
import { CapabilityCandidateSchema, type CapabilityCandidate } from '#shared/contracts/capability-candidate.js';
import { buildExplorationGoal } from './exploration-goal.js';
import {
  freezeHistoricalDataset,
  FreezeValidationError,
  ReconciliationMismatchError,
} from './freeze-dataset.js';
import { persistCandidate, CandidateStoreError } from './candidate-store.js';
import {
  createHermesTurnRunner,
  HermesUnavailableError,
  type TurnRunner,
} from './hermes-turn-runner.js';
import {
  insertAcquisitionJob,
  getAcquisitionJob,
  updateAcquisitionJob,
  type AcquisitionJobRow,
} from './job-store.js';

export interface CreateAcquisitionInput {
  readonly db: Database.Database;
  readonly need: HistoricalEvidenceNeed;
  readonly dataRoot: string;
  readonly clock?: () => Date;
}

export interface OrchestratorOptions {
  readonly dataRoot: string;
  readonly cwd?: string;
  readonly turnRunner?: TurnRunner;
  readonly clock?: () => Date;
}

export const newJobId = (now: Date = new Date()): string => {
  const stamp = beijingStamp(now);
  return `hacq_${stamp}_${randomBytes(3).toString('hex')}`;
};

const beijingStamp = (d: Date): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}_${get('hour')}${get('minute')}${get('second')}`;
};

/** Validate need, prepare intake dir + goal, persist a QUEUED job. */
export const createAcquisitionJob = (input: CreateAcquisitionInput): AcquisitionJobRow => {
  const need = HistoricalEvidenceNeedSchema.parse(input.need);
  const clock = input.clock ?? (() => new Date());
  const now = clock();
  const id = newJobId(now);
  const intakeDir = resolve(input.dataRoot, '_acquisition_intake', id);
  mkdirSync(intakeDir, { recursive: true });
  const goalText = buildExplorationGoal({ need, intakeDir, jobId: id });
  return insertAcquisitionJob(input.db, {
    id,
    need,
    intakeDir,
    goalText,
    nowIso: now.toISOString(),
  });
};

const readIntakeJson = <T>(
  path: string,
  schema: z.ZodType<T>,
  label: string,
): T => {
  if (!existsSync(path)) {
    throw new FreezeValidationError(`intake missing required ${label}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new FreezeValidationError(
      `intake ${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new FreezeValidationError(`${label} fails contract: ${parsed.error.message}`);
  return parsed.data;
};

/**
 * Validate the intake deliverables and, when they pass the business gate,
 * persist the candidate and freeze the dataset. Completion is decided by
 * ARTIFACTS + the reconciliation gate, not by turn lifecycle events: a turn
 * whose completion event was lost after all deliverables landed still
 * finalizes. `turnNote` truthfully records such anomalies. Returns the
 * terminal job row; validation/gate failures land as FAILED/BLOCKED.
 */
export const finalizeAcquisitionIntake = (
  db: Database.Database,
  job: AcquisitionJobRow,
  options: OrchestratorOptions,
  turnNote: string | null = null,
): AcquisitionJobRow => {
  const clock = options.clock ?? (() => new Date());
  const markFailed = (status: 'FAILED' | 'BLOCKED', failureCode: string, message: string) =>
    updateAcquisitionJob(
      db,
      job.id,
      {
        status,
        failureCode,
        errorMessage: message,
        ...(turnNote ? { turnNote } : {}),
        finished: true,
      },
      clock().toISOString(),
    );

  // ── Intake validation (Evidence Contract) ───────────────────────────
  let result: HistoricalEvidenceResult;
  let candidate: CapabilityCandidate;
  try {
    result = readIntakeJson(
      join(job.intakeDir, 'result.json'),
      HistoricalEvidenceResultSchema,
      'result.json',
    );
    candidate = readIntakeJson(
      join(job.intakeDir, 'candidate.json'),
      CapabilityCandidateSchema,
      'candidate.json',
    );
    for (const rel of candidate.verified_against.evidence_files) {
      if (!existsSync(resolve(job.intakeDir, rel))) {
        throw new FreezeValidationError(`candidate evidence file not found: ${rel}`);
      }
    }
    if (candidate.status !== 'pending_review') {
      throw new FreezeValidationError('candidate status must be pending_review (no self-promotion)');
    }
  } catch (err) {
    return markFailed(
      'FAILED',
      err instanceof CandidateStoreError ? 'CANDIDATE_INVALID' : 'INTAKE_INVALID',
      messageOf(err),
    );
  }

  // ── Capability persistence (pending review only) ────────────────────
  try {
    persistCandidate(options.dataRoot, candidate);
  } catch (err) {
    return markFailed('FAILED', 'CANDIDATE_INVALID', messageOf(err));
  }

  // ── Freeze (Fabric re-derives actual window + reconciliation gate) ──
  try {
    const need = HistoricalEvidenceNeedSchema.parse({
      subject: { shopId: job.shopId, shopName: job.shopName },
      source: 'jd',
      purpose: 'historical_replay',
      window: { start: job.requestedStart, end: job.requestedEnd },
      domains: ['trade', 'orders'],
    });
    const outcome = freezeHistoricalDataset({
      dataRoot: options.dataRoot,
      intakeDir: job.intakeDir,
      need,
      result,
      jobId: job.id,
      candidateId: candidate.id,
      clock,
      ...(turnNote ? { turnNote } : {}),
    });
    return updateAcquisitionJob(
      db,
      job.id,
      {
        status: 'SUCCEEDED',
        failureCode: null,
        errorMessage: null,
        datasetDir: outcome.datasetDir,
        datasetDirName: outcome.datasetDirName,
        manifestHash: outcome.manifestHash,
        candidateId: candidate.id,
        actualStart: outcome.actualWindow.start,
        actualEnd: outcome.actualWindow.end,
        ...(turnNote ? { turnNote } : {}),
        finished: true,
      },
      clock().toISOString(),
    );
  } catch (err) {
    if (err instanceof ReconciliationMismatchError) {
      return markFailed('FAILED', 'RECONCILIATION_MISMATCH', err.message);
    }
    if (err instanceof FreezeValidationError) {
      return markFailed('FAILED', 'FREEZE_INVALID', err.message);
    }
    throw err;
  }
};

/**
 * Execute a QUEUED job through to freeze. Updates the row on every
 * terminal transition; never throws for business failures (they become
 * FAILED/BLOCKED rows) — throws only on programming errors / unknown state.
 */
export const startAcquisitionJob = async (
  db: Database.Database,
  jobId: string,
  options: OrchestratorOptions,
): Promise<AcquisitionJobRow> => {
  const clock = options.clock ?? (() => new Date());
  const job = getAcquisitionJob(db, jobId);
  if (!job) throw new Error(`acquisition job not found: ${jobId}`);
  if (job.status !== 'QUEUED') {
    throw new Error(`job ${jobId} is not QUEUED (status=${job.status})`);
  }

  updateAcquisitionJob(db, jobId, { status: 'RUNNING' }, clock().toISOString());
  const runner = options.turnRunner ?? createHermesTurnRunner();
  const trajectoryDir = join(job.intakeDir, 'trajectory');

  try {
    const turn = await runner.runTurn({
      jobId,
      goal: job.goalText,
      cwd: options.cwd ?? process.cwd(),
      trajectoryDir,
    });
    updateAcquisitionJob(
      db,
      jobId,
      { status: 'RUNNING', hermesSessionId: turn.sessionId },
      clock().toISOString(),
    );
  } catch (err) {
    if (err instanceof HermesUnavailableError) {
      return updateAcquisitionJob(
        db,
        jobId,
        { status: 'BLOCKED', failureCode: 'HERMES_UNAVAILABLE', errorMessage: err.message, finished: true },
        clock().toISOString(),
      );
    }
    // The turn failed client-side (e.g. turn.complete never observed).
    // Deliverables may already be complete on disk — the 2026-09-03 run-C
    // and the 2026-09-14 timeout both finished ALL artifacts before the
    // lifecycle event was lost. Finalize against the gate; stay BLOCKED
    // only when the intake is genuinely unusable (S0002 failure honesty).
    const refreshed = getAcquisitionJob(db, jobId) as AcquisitionJobRow;
    const note = `turn lifecycle error: ${messageOf(err)} — finalized from intake deliverables after the error`;
    const finalized = finalizeAcquisitionIntake(db, refreshed, options, note);
    if (finalized.status === 'SUCCEEDED') return finalized;
    return updateAcquisitionJob(
      db,
      jobId,
      {
        status: 'BLOCKED',
        failureCode: 'TURN_ERROR',
        errorMessage: messageOf(err),
        turnNote: `intake also unusable after turn error: ${finalized.errorMessage ?? ''}`,
        finished: true,
      },
      clock().toISOString(),
    );
  }

  const refreshed = getAcquisitionJob(db, jobId) as AcquisitionJobRow;
  return finalizeAcquisitionIntake(db, refreshed, options);
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
