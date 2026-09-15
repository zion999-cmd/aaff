// P0013 Phase 4 — ReplayRunner orchestration.
//
// §5 (real historical data, no synthetic), §7 (1-day step), §10 (Confirmed
// Action impossible without Action Evidence), §15 (append-only snapshots),
// §22 (ReplayRun is a first-class entity), §23 (deterministic time, agent
// output is NOT), §24 (persistence), §32 (Production isolation at the data
// layer; runner writes ONLY to replay_* tables).
//
// Phase 4 hardening (2026-09-03, after acceptance FAILED exposed stub
// cognition):
//   - assertNoStubLiterals — refuse to persist a snapshot whose
//     current_understanding / judgment / recommendation_text matches
//     the documented stub pattern. This is the load-bearing guard: the
//     production kernel MUST emit real Hermes output, not literals.
//   - assertNoFutureLeakage — every kernel-reported evidence id MUST
//     have business_date <= step.business_date. Violations hard-fail
//     the step; the runner NEVER tags future-dated evidence.
//   - assertReplayProposal — the kernel's investigation.recommendation
//     is a PROPOSAL, not an action. recommendation_executed MUST be
//     false (P0013 §14, §10). We add this as a runtime guard; the
//     schema does NOT carry a column (see §10/§14 contract test).
//   - epistemicBoundary — split snapshot into Observed | Inferred |
//     Confirmed Action. Confirmed Action is structurally null during
//     Replay — data can never prove that an operator acted on a past
//     recommendation.
//
// NOT INCLUDED:
//   - This runner does NOT call acquireJdData. It calls an injected
//     `kernel` function. Phase 5 wires the historical-dataset loader +
//     a thin per-day reader into the kernel.
//   - The runner does NOT touch the production `situations` or
//     `learning_contexts` tables. Test #4 of the test file is the
//     load-bearing proof.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { nowIso } from '#shared/utils/time.js';
import {
  createReplayClock,
  nextDate,
  isReplayTerminal,
  type ReplayClockStatus,
} from '#shared/utils/replay-clock.js';
import { tagEvidenceAsReplayVisible } from './temporal-evidence-view.js';
import { loadHistoricalDataset, businessDateCoverageOf } from './historical-dataset.js';
// P0013 G1-fix: import the seed module statically. seed-evidence.ts has
// no circular dep with the runner — it only imports historical-dataset.ts
// + shared/utils, both leaf-level.
import * as seedEvidenceMod from './seed-evidence.js';

export interface CreateReplayRunArgs {
  readonly shopId: string;
  readonly shopName: string;
  readonly sourceDatasetPath: string;
  readonly sourceManifestHash: string;
  readonly startBusinessDate: string;
  readonly endBusinessDate: string;
}

export interface ReplayRunState {
  readonly id: string;
  readonly status: ReplayClockStatus;
  readonly currentStep: number;
  readonly currentBusinessDate: string | null;
  readonly startBusinessDate: string;
  readonly endBusinessDate: string;
  readonly shopId: string;
  readonly shopName: string;
  readonly sourceDatasetPath: string;
  readonly sourceManifestHash: string;
  /** Coverage Gap detail — set while status === 'BLOCKED'. */
  readonly blockedBusinessDate: string | null;
  readonly blockedReason: string | null;
}

export interface KernelStepResult {
  /** The evidence_observation ids the kernel wrote during this step. */
  readonly evidenceObservationIds: readonly number[];
  /** The Investigation the kernel produced. */
  readonly investigation: {
    readonly currentUnderstanding?: string;
    readonly judgment?: string;
    readonly unknowns?: readonly string[];
    readonly evidenceAcquired?: readonly string[];
    readonly recommendation?: { kind: 'observe' | 'act'; recommendation: string; rationale?: string };
    /** P0013 §10/§14 — Confirmed Action is structurally null during Replay.
     *  A kernel that emits a non-null value is a §10/§14 violation. The
     *  runner reads this field for the epistemic-boundary stamp. */
    readonly confirmedAction?: unknown;
    // ── Epistemic Integrity (2026-09-06) — optional 4 new fields ──
    // The kernel MAY populate these. The runner's `stampEpistemicBoundary`
    // and the snapshot persistence will preserve them in the persisted
    // raw_investigation_json. They are OPTIONAL because the existing
    // P0013 contract did not have them; the new InvestigationSchema
    // defaults to empty arrays / {}.
    readonly epistemicLayers?: Record<string, unknown>;
    readonly claimEvidenceRefs?: ReadonlyArray<Record<string, unknown>>;
    readonly thresholds?: ReadonlyArray<Record<string, unknown>>;
    readonly priorCognition?: ReadonlyArray<Record<string, unknown>>;
    // ── P0013.2 shared Analysis Contract formal obligations ──
    readonly observedFacts?: readonly string[];
    readonly evidenceGaps?: readonly string[];
    readonly supportingEvidenceRefs?: readonly string[];
    readonly businessStructureCoverage?: ReadonlyArray<Record<string, unknown>>;
    readonly evidenceResolutions?: ReadonlyArray<Record<string, unknown>>;
    readonly stopReason?: string | null;
  };
}

export interface StepResult {
  readonly status: 'COMPLETED' | 'FAILED' | 'PAUSED' | 'SKIPPED_NO_DATA' | 'BLOCKED';
  readonly currentBusinessDate?: string;
  readonly error?: string;
  /** Set when status === 'BLOCKED': the business date with no coverage. */
  readonly blockedBusinessDate?: string;
  /** Machine-readable coverage-gap reasons (Evidence Contract violation). */
  readonly blockedReasons?: readonly string[];
}

export interface RunCompletionResult {
  readonly status: 'COMPLETED' | 'FAILED' | 'PAUSED' | 'BLOCKED';
  readonly totalSteps: number;
  readonly failedSteps: number;
}

// ── helpers ─────────────────────────────────────────────────────────────

const uuid = (): string => randomUUID();

// Phase 4 hardening (2026-09-03) — anti-stub + §3 future-leak + §10/§14
// epistemic-boundary guards. These run in the runner BEFORE persistence, so
// a regression at the kernel layer is caught here instead of polluting the
// cognitive trajectory. The stubs in the OLD httpStubKernel (route layer)
// matched these patterns; the new anti-stub guard is what makes
// "runner ran != runner cognited" observable.
//
// P0013 §10 / §14 — recommendation_executed MUST be false. A kernel that
// emits recommendation_executed=true is a §10 violation. P0013 §14 — the
// runner does not execute anything; recommendation is a proposal.
// P0013 §3 — evidence_observation ids MUST have business_date <= step
// business_date. A kernel that reports a future-dated id is a §3 violation.
// P0013 §32 — production situations/learning_contexts are NEVER written.

// The pattern set is intentionally narrow: a real Hermes output WILL
// contain the word "stub" inside a Chinese sentence (e.g. "该商品流量
// 走 stub 路径"); the only thing we forbid is the documented placeholder
// shape used by the old httpStubKernel.
const STUB_LITERAL_PATTERN = /^\s*\[HTTP-driven stub\]/;

/** Throw if any of the three cognitive-text fields look like the old
 *  httpStubKernel placeholder. Throws with a precise message so the
 *  failed step + run state is recoverable (the runner catches it and
 *  marks FAILED with the message). */
const assertNoStubLiterals = (
  inv: KernelStepResult['investigation'],
  businessDate: string,
): void => {
  const cu = inv.currentUnderstanding ?? '';
  const j = inv.judgment ?? '';
  const r = inv.recommendation?.recommendation ?? '';
  for (const [field, value] of [
    ['currentUnderstanding', cu],
    ['judgment', j],
    ['recommendation.recommendation', r],
  ] as const) {
    if (STUB_LITERAL_PATTERN.test(value)) {
      throw new Error(
        `[P0013 anti-stub] ${field} at business_date=${businessDate} matches the stub-literal pattern. ` +
          `Replay MUST emit real Hermes output; httpStubKernel was retired on 2026-09-03. ` +
          `Got: ${value.slice(0, 80)}`,
      );
    }
  }
  // Empty content is also a regression — a real Hermes turn always
  // populates these. (An empty field is functionally indistinguishable
  // from a stub.)
  if (cu.trim().length === 0) {
    throw new Error(
      `[P0013 anti-stub] currentUnderstanding is empty at business_date=${businessDate}. ` +
        `Replay MUST emit non-stub content; an empty string is the same regression.`,
    );
  }
  if (j.trim().length === 0) {
    throw new Error(
      `[P0013 anti-stub] judgment is empty at business_date=${businessDate}. ` +
        `Replay MUST emit non-stub content; an empty string is the same regression.`,
    );
  }
};

/** P0013 §10/§14 — the kernel's investigation.recommendation is a proposal.
 *  recommendation_executed MUST be absent OR false. Any true value is a
 *  §10/§14 violation; Replay NEVER executes.
 *
 *  P0013 §10 also — Confirmed Action is structurally null during Replay.
 *  A kernel that emits a non-null confirmedAction is a §10 violation. */
const assertReplayProposal = (
  inv: KernelStepResult['investigation'],
  businessDate: string,
): void => {
  // Confirmed Action must be absent, null, or undefined. Anything else
  // (a string, an object, true) is a §10/§14 violation: data cannot
  // prove action.
  if (inv.confirmedAction !== undefined && inv.confirmedAction !== null) {
    throw new Error(
      `[P0013 §10/§14] confirmedAction at business_date=${businessDate} is non-null ` +
        `(${JSON.stringify(inv.confirmedAction)}). Confirmed Action is structurally ` +
        `null during Replay; data cannot prove the operator acted.`,
    );
  }
};

/** P0013 §3 — every kernel-reported evidence_observation id MUST have
 *  business_date <= step.business_date. Throw on the first violation;
 *  the runner catches and marks FAILED, so a kernel that peeks future
 *  cannot silently pollute the trajectory. */
const assertNoFutureLeakage = (
  db: Database.Database,
  evidenceIds: readonly number[],
  businessDate: string,
): void => {
  if (evidenceIds.length === 0) return;
  const placeholders = evidenceIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, business_date FROM evidence_observations WHERE id IN (${placeholders})`,
    )
    .all(...evidenceIds) as Array<{ id: number; business_date: string }>;
  for (const r of rows) {
    if (r.business_date > businessDate) {
      throw new Error(
        `[P0013 §3 future-leak] evidence_observation id=${r.id} has business_date=${r.business_date} ` +
          `which is AFTER step business_date=${businessDate}. Replay MUST NOT see future data.`,
      );
    }
  }
};

/** P0013 §10/§14 + epistemic boundary — the snapshot's raw_investigation_json
 *  gets a `_epistemic_boundary` marker. Confirmed Action is structurally
 *  null during Replay. Observed and Inferred are derived from the
 *  kernel's current_understanding + judgment (the Agent's own words).
 *  This is a runner-side invariant, not a schema column. */
const stampEpistemicBoundary = (
  rawInvJson: string,
  observedFacts: readonly string[],
  inferredClaims: readonly string[],
): string => {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawInvJson) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  raw['_epistemic_boundary'] = {
    observed: observedFacts,
    inferred: inferredClaims,
    confirmed_action: null, // P0013 §10/§14 — structurally null during Replay
    boundary_checked_at: nowIso(),
  };
  return JSON.stringify(raw);
};

const loadRun = (db: Database.Database, runId: string): ReplayRunState | null => {
  const row = db
    .prepare(
      `SELECT id, status, current_step, current_business_date, start_business_date,
              end_business_date, shop_id, shop_name, source_dataset_path,
              source_manifest_hash, blocked_business_date, blocked_reason
       FROM replay_runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        id: string;
        status: ReplayClockStatus;
        current_step: number;
        current_business_date: string | null;
        start_business_date: string;
        end_business_date: string;
        shop_id: string;
        shop_name: string;
        source_dataset_path: string;
        source_manifest_hash: string;
        blocked_business_date: string | null;
        blocked_reason: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    currentStep: row.current_step,
    currentBusinessDate: row.current_business_date,
    startBusinessDate: row.start_business_date,
    endBusinessDate: row.end_business_date,
    shopId: row.shop_id,
    shopName: row.shop_name,
    sourceDatasetPath: row.source_dataset_path,
    sourceManifestHash: row.source_manifest_hash,
    blockedBusinessDate: row.blocked_business_date ?? null,
    blockedReason: row.blocked_reason ?? null,
  };
};

// ── public API ──────────────────────────────────────────────────────────

export const createReplayRun = (db: Database.Database, args: CreateReplayRunArgs): ReplayRunState => {
  const id = uuid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO replay_runs
     (id, shop_id, shop_name, source_dataset_path, source_manifest_hash,
      start_business_date, end_business_date, current_business_date,
      current_step, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'READY', ?)`,
  ).run(
    id,
    args.shopId,
    args.shopName,
    args.sourceDatasetPath,
    args.sourceManifestHash,
    args.startBusinessDate,
    args.endBusinessDate,
    args.startBusinessDate,
    now,
  );
  // P0013 G1.2-fix (2026-09-03): seed evidence_observations rows from the
  // P0011.x on-disk dataset, tagged with this new runId. Without this,
  // visibleEvidenceFor() returns 0 rows and the LLM reports an empty
  // evidence list (the operator-surfaced regression on 2026-09-03).
  // Resolve relative paths against process.cwd() so the route's
  // "data/jd_acquisition_20260903_0834" string Just Works.
  //
  // P0013 G1.3-fix (2026-09-03): the evidence_observations natural-key
  // UNIQUE INDEX is (shop_id, data_type, business_date, acquired_at,
  // content_hash). Both `acquired_at` (from the dataset manifest, fixed)
  // and `content_hash` (sha256 of the file, fixed) are stable across
  // runs, so INSERT OR IGNORE was skipping the new rows on every run
  // after the first — leaving the new run's evidence_observations
  // table empty even though the seed "appeared" to succeed. Fix: use
  // THIS run's created_at as the evidence's acquired_at, so different
  // runs have different natural keys. The operator-facing alias in
  // replay_runs.shop_id is unaffected.
  try {
    // Top-level static import (no circular dep — seed-evidence.ts only
    // imports historical-dataset.ts + shared/utils, not the runner).
    // P0013 G1.1-fix (2026-09-03): use the DATASET's declared shopId
    // (e.g. "11855009") as the source of truth for the evidence rows'
    // shop_id, NOT the operator-facing alias "jd_shop_001". The
    // natural-key UNIQUE INDEX on (shop_id, data_type, business_date,
    // acquired_at, content_hash) would otherwise force one of the two
    // shops' evidence into the wrong bucket. The operator's alias stays
    // in replay_runs.shop_id for human reading; the evidence layer
    // uses the dataset's real shopId.
    const { seedReplayEvidence, getDatasetShopId } = seedEvidenceMod;
    const absPath = resolve(process.cwd(), args.sourceDatasetPath);
    const datasetShopId = getDatasetShopId(absPath);
    // Use the run's own created_at (already stored in `now`) as the
    // evidence's acquired_at. This is unique per run, so each run gets
    // its own evidence_observations rows (G1.3-fix: otherwise the natural
    // key collision makes every seed INSERT after the first silently
    // no-op via INSERT OR IGNORE).
    seedReplayEvidence(db, id, absPath, datasetShopId, now);
  } catch (err: unknown) {
    // Seed failure does NOT fail the run creation — the run row is in
    // DB and the operator can see the failure in the response. The
    // kernel will report an empty evidence list, which is the same
    // surface as a missing dataset, so the operator can diagnose via
    // the run state + console.
    //
    // Mute the log under vitest (NODE_ENV === 'test') because most
    // contract tests pass a synthetic `data/x` path that intentionally
    // does not exist — the log is just noise there. In dev/prod the
    // log fires.
    if (process.env['NODE_ENV'] !== 'test') {
      // eslint-disable-next-line no-console
      console.error(
        `[replay] seedReplayEvidence failed for run=${id} dataset=${args.sourceDatasetPath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const r = loadRun(db, id);
  if (!r) throw new Error('createReplayRun: row missing immediately after insert');
  return r;
};

export const getReplayRunState = (db: Database.Database, runId: string): ReplayRunState => {
  const r = loadRun(db, runId);
  if (!r) throw new Error(`Replay run not found: ${runId}`);
  return r;
};

const markRunFailed = (db: Database.Database, runId: string): void => {
  db.prepare(`UPDATE replay_runs SET status = 'FAILED' WHERE id = ?`).run(runId);
};

const persistSnapshot = (
  db: Database.Database,
  stepId: string,
  businessDate: string,
  kernelResult: KernelStepResult,
): void => {
  const snapId = uuid();
  const inv = kernelResult.investigation;
  // Phase 4 hardening — guards run BEFORE persistence. If any guard throws,
  // the runner's catch block marks the step FAILED and the run FAILED; no
  // half-written snapshot row survives.
  assertNoStubLiterals(inv, businessDate);
  assertReplayProposal(inv, businessDate);
  // §3 future-leak check — runs before tagging, so a future-dated id
  // never gets tagged with the run_id.
  assertNoFutureLeakage(db, kernelResult.evidenceObservationIds, businessDate);

  // Epistemic boundary: observed = the visible-evidence summary lines
  // (read-only, never synthesized). inferred = the agent's currentUnderstanding +
  // judgment. confirmed_action = null (P0013 §10/§14 invariant).
  // P0013.2: persist the Agent's formal obligation fields. observed_facts
  // falls back to evidenceAcquired lines only when the Agent did not
  // populate the new field (parser now makes that case contract-invalid).
  const observedFacts = (
    inv.observedFacts && inv.observedFacts.length > 0
      ? inv.observedFacts
      : inv.evidenceAcquired ?? []
  ).map((s) => String(s));
  const evidenceGaps = (inv.evidenceGaps ?? []).map((s) => String(s));
  const supportingRefs = (
    inv.supportingEvidenceRefs && inv.supportingEvidenceRefs.length > 0
      ? inv.supportingEvidenceRefs
      : inv.evidenceAcquired ?? []
  ).map((s) => String(s));
  const inferredClaims = [inv.currentUnderstanding ?? '', inv.judgment ?? ''].filter((s) => s.length > 0);
  const stampedRaw = stampEpistemicBoundary(JSON.stringify(inv), observedFacts, inferredClaims);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO replay_run_cognitive_snapshots
       (id, replay_run_step_id, business_date, observed_facts, current_understanding,
        judgment, recommendation_kind, recommendation_text, unknowns, evidence_gaps,
        supporting_evidence_refs, temporal_boundary_checked_at, raw_investigation_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      snapId,
      stepId,
      businessDate,
      JSON.stringify(observedFacts),
      inv.currentUnderstanding ?? '',
      inv.judgment ?? '',
      inv.recommendation?.kind ?? 'observe',
      inv.recommendation?.recommendation ?? '',
      JSON.stringify(inv.unknowns ?? []),
      // P0013.2: the Agent's real evidence gaps (data-pipeline backlog),
      // not the old hardcoded empty array.
      JSON.stringify(evidenceGaps),
      JSON.stringify(supportingRefs),
      nowIso(),
      stampedRaw,
      nowIso(),
    );
  });
  tx();
};

// P0013 G1.5-fix (2026-09-03): atomic INSERT-or-fetch of the RUNNING
// step row, used as the entry point of runReplayRunStep.
//
// The natural-key UNIQUE INDEX on replay_run_steps(replay_run_id, business_date)
// is the load-bearing constraint. A plain INSERT throws on the second
// concurrent call with the same (runId, currentBusinessDate) — the
// symptom the operator surfaced on 2026-09-03 with "回放下一天失败:
// UNIQUE constraint failed: replay_run_steps.replay_run_id,
// replay_run_steps.business_date". The race is real: when "▶ 下一天"
// is double-clicked (or "▶ 连续回放" fires twice rapidly), two
// runReplayRunStep calls both read the same run.currentBusinessDate
// before either has UPDATEd it, then both try to INSERT the same step.
//
// The fix: `ON CONFLICT ... DO NOTHING RETURNING id` is atomic at the
// SQLite level. If RETURNING returns a row, the INSERT happened and
// we own the new step. If RETURNING returns nothing, a row already
// exists for (runId, businessDate) and we read its state to decide
// what to return. No pre-SELECT race window, no transaction wrapping
// the async kernel call.
type InsertOrFetchResult =
  | { readonly kind: 'inserted'; readonly stepId: string }
  | {
      readonly kind: 'existing';
      readonly status: 'COMPLETED' | 'FAILED' | 'RUNNING' | 'SKIPPED_NO_DATA';
      readonly error: string | null;
    };

const insertOrFetchRunningStep = (
  db: Database.Database,
  args: {
    runId: string;
    stepId: string;
    stepNumber: number;
    businessDate: string;
  },
): InsertOrFetchResult => {
  const inserted = db
    .prepare(
      `INSERT INTO replay_run_steps
         (id, replay_run_id, step_number, business_date, status, error, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'RUNNING', NULL, ?, NULL)
       ON CONFLICT (replay_run_id, business_date) DO NOTHING
       RETURNING id`,
    )
    .get(args.stepId, args.runId, args.stepNumber, args.businessDate, nowIso()) as
    | { id: string }
    | undefined;
  if (inserted) {
    return { kind: 'inserted', stepId: args.stepId };
  }
  // Existing row — fetch its state. We never overwrite a pre-existing
  // step; the runner either returns its status (idempotent no-op) or
  // surfaces its error (no auto-retry of a failed step).
  const row = db
    .prepare(
      `SELECT status, error FROM replay_run_steps
       WHERE replay_run_id = ? AND business_date = ?`,
    )
    .get(args.runId, args.businessDate) as
    | { status: string; error: string | null }
    | undefined;
  if (!row) {
    // Should be impossible: ON CONFLICT said a row exists, but the
    // SELECT found nothing. Surface this loudly; do NOT insert again.
    throw new Error(
      `[replay] UNIQUE on (replay_run_id, business_date) fired but no row found ` +
        `for run=${args.runId} date=${args.businessDate} — DB corruption?`,
    );
  }
  const status = row.status as 'COMPLETED' | 'FAILED' | 'RUNNING' | 'SKIPPED_NO_DATA';
  return { kind: 'existing', status, error: row.error };
};

/**
 * Resolve the Evidence Contract status of one business date for a run.
 * Returns null when the date is within the dataset window and covered;
 * a gap descriptor when it is not covered; and a "window" gap when the
 * date falls outside the dataset window entirely (should be impossible
 * for a run created through POST /runs, which validates the window).
 */
const findCoverageGap = (
  db: Database.Database,
  runId: string,
  businessDate: string,
): { businessDate: string; reasons: readonly string[] } | null => {
  const row = db
    .prepare(`SELECT source_dataset_path FROM replay_runs WHERE id = ?`)
    .get(runId) as { source_dataset_path: string } | undefined;
  if (!row?.source_dataset_path) return null; // run row already gone — let caller fail normally
  let dataset;
  try {
    dataset = loadHistoricalDataset(resolve(process.cwd(), row.source_dataset_path));
  } catch {
    // Unreadable dataset is a separate failure mode; the kernel path and the
    // POST /runs validation already surface it. Do not mask it as a gap.
    return null;
  }
  const coverage = businessDateCoverageOf(dataset, businessDate);
  if (!coverage) {
    return { businessDate, reasons: ['outside_dataset_window'] };
  }
  return coverage.covered ? null : { businessDate, reasons: coverage.reasons };
};

/** Persist the Coverage Gap on the run so the operator sees an explicit state. */
const blockRunOnCoverageGap = (
  db: Database.Database,
  runId: string,
  gap: { businessDate: string; reasons: readonly string[] },
): void => {
  db.prepare(
    `UPDATE replay_runs
        SET status = 'BLOCKED', blocked_business_date = ?, blocked_reason = ?
      WHERE id = ?`,
  ).run(gap.businessDate, gap.reasons.join(', '), runId);
};

const linkEvidenceRefs = (
  db: Database.Database,
  stepId: string,
  evidenceIds: readonly number[],
): void => {
  if (evidenceIds.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO replay_run_evidence_refs (replay_run_step_id, evidence_observation_id) VALUES (?, ?)`,
  );
  const tx = db.transaction((ids: readonly number[]) => {
    for (const id of ids) stmt.run(stepId, id);
  });
  tx(evidenceIds);
};

export const runReplayRunStep = async (
  db: Database.Database,
  runId: string,
  kernel: (runId: string, stepId: string, businessDate: string) => Promise<KernelStepResult>,
): Promise<StepResult> => {
  const run = getReplayRunState(db, runId);
  if (run.status === 'PAUSED') {
    return { status: 'PAUSED' };
  }
  if (isReplayTerminal(run.status)) {
    return run.currentBusinessDate
      ? { status: 'COMPLETED', currentBusinessDate: run.currentBusinessDate }
      : { status: 'COMPLETED' };
  }

  // Build the Replay Business Clock from persisted state.
  const startDate = run.currentBusinessDate ?? (await import('#shared/utils/time.js')).beijingDate(new Date());
  const clock = createReplayClock(startDate, run.endBusinessDate, run.status);
  const businessDate = clock.currentBusinessDate;
  const stepId = uuid();
  const stepNumber = run.currentStep + 1;

  // ── Coverage Gate (Evidence Contract) ────────────────────────────────
  // Cognition may only run for a business date the frozen acquisition can
  // actually answer. A date lacking evidence is a Coverage Gap: it must be
  // resolved by acquisition (P0013.1) + a new run, never by running the
  // Agent on an empty day. Checked for EVERY advance path (step / next /
  // continuous) because they all funnel through this function.
  const coverageGap = findCoverageGap(db, runId, businessDate);
  if (coverageGap) {
    blockRunOnCoverageGap(db, runId, coverageGap);
    return {
      status: 'BLOCKED',
      currentBusinessDate: businessDate,
      blockedBusinessDate: coverageGap.businessDate,
      blockedReasons: coverageGap.reasons,
      error: `Coverage Gap ${coverageGap.businessDate}: ${coverageGap.reasons.join(', ')}`,
    };
  }

  // Insert a RUNNING step row first. P0013 G1.5-fix: idempotent against
  // concurrent / double-clicked calls. If a step already exists at
  // (runId, businessDate), return its state without running the kernel
  // again or advancing the clock. See `insertOrFetchRunningStep` for
  // the atomic UPSERT pattern that prevents the UNIQUE constraint from
  // firing.
  const insertOrFetch = insertOrFetchRunningStep(db, { runId, stepId, stepNumber, businessDate });
  if (insertOrFetch.kind === 'existing') {
    if (insertOrFetch.status === 'COMPLETED') {
      return { status: 'COMPLETED', currentBusinessDate: businessDate };
    }
    if (insertOrFetch.status === 'FAILED') {
      return {
        status: 'FAILED',
        error: insertOrFetch.error ?? 'step already FAILED',
        currentBusinessDate: businessDate,
      };
    }
    if (insertOrFetch.status === 'SKIPPED_NO_DATA') {
      return { status: 'SKIPPED_NO_DATA', currentBusinessDate: businessDate };
    }
    // RUNNING — another concurrent advance call is in flight for this
    // (runId, businessDate). Don't double-insert. The in-flight call
    // will finish and advance the clock. The route's step-mode handler
    // will return this as a 200 with status='PAUSED'; the view's
    // onNextClick will see the same state and not error.
    return {
      status: 'PAUSED',
      currentBusinessDate: businessDate,
      error: 'concurrent advance in flight',
    };
  }

  // Call the kernel. The kernel writes evidence_observations as a SIDE EFFECT
  // (via its own pipeline). We tag the rows it reports back with replay_run_id
  // AFTER the call returns. The runner itself NEVER writes to evidence_observations
  // — only the tagging helper does, and only on the explicit ID list.
  let kernelResult: KernelStepResult;
  try {
    kernelResult = await kernel(runId, stepId, businessDate);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE replay_run_steps
       SET status = 'FAILED', error = ?, completed_at = ?
       WHERE id = ?`,
    ).run(message, nowIso(), stepId);
    markRunFailed(db, runId);
    return { status: 'FAILED', error: message };
  }

  // §3 future-leak check BEFORE tagging — a kernel that reports a future
  // evidence id MUST NOT be tagged with the run_id. The guard throws on
  // the first violation; the catch below marks the step + run FAILED.
  try {
    assertNoFutureLeakage(db, kernelResult.evidenceObservationIds, businessDate);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE replay_run_steps
       SET status = 'FAILED', error = ?, completed_at = ?
       WHERE id = ?`,
    ).run(message, nowIso(), stepId);
    markRunFailed(db, runId);
    return { status: 'FAILED', error: message };
  }

  // Tag the kernel-written evidence with the replay_run_id (the §32 isolation
  // bridge — production rows not in this list stay NULL).
  tagEvidenceAsReplayVisible(db, kernelResult.evidenceObservationIds, runId, stepId);

  // Persist the cognitive snapshot (§15 append-only). The snapshot's own
  // anti-stub + §10/§14 guards are inside persistSnapshot; a guard
  // throw here also marks the step + run FAILED.
  try {
    persistSnapshot(db, stepId, businessDate, kernelResult);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // The snapshot was NOT written (the transaction rolled back). Evidence
    // is already tagged — we leave it tagged, but the run is FAILED so no
    // future step can read it. The next operator decision is to either
    // delete the tagged evidence (recovery) or restart the run with a
    // fixed kernel.
    db.prepare(
      `UPDATE replay_run_steps
       SET status = 'FAILED', error = ?, completed_at = ?
       WHERE id = ?`,
    ).run(message, nowIso(), stepId);
    markRunFailed(db, runId);
    return { status: 'FAILED', error: message };
  }
  linkEvidenceRefs(db, stepId, kernelResult.evidenceObservationIds);

  // Mark step COMPLETED.
  db.prepare(
    `UPDATE replay_run_steps SET status = 'COMPLETED', completed_at = ? WHERE id = ?`,
  ).run(nowIso(), stepId);

  // Advance the clock. The clock is rebuilt fresh from persisted state each
  // call (it carries no in-memory identity), so nextClock.step starts at 0
  // for a brand-new window. We offset it by the run's already-completed
  // step count so the DB's current_step advances monotonically.
  const next = nextDate(clock);

  // P0013 Phase 7 — at the natural month boundary, generate the
  // monthly review for the month we just LEFT, BEFORE writing the
  // clock advance. Idempotent (UNIQUE on run_id+month), so re-running
  // the same month on a later restart is harmless. Triggered only when
  // the NEXT clock position is in a different YYYY-MM than the current
  // one.
  const currentMonth = businessDate.slice(0, 7); // YYYY-MM
  const nextMonth = next.currentBusinessDate ? next.currentBusinessDate.slice(0, 7) : currentMonth;
  if (nextMonth !== currentMonth) {
    try {
      const { generateMonthlyReview } = await import('./monthly-review.js');
      generateMonthlyReview(db, { runId, businessMonth: currentMonth });
    } catch (err: unknown) {
      // Monthly review failure does NOT fail the step — it's an
      // aggregation, not part of the cognitive trace. Log to stderr
      // and continue. The next restart will regenerate.
      // eslint-disable-next-line no-console
      console.error(
        `[replay] monthly review failed for run=${runId} month=${currentMonth}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const newStepNumber = run.currentStep + 1;
  db.prepare(
    `UPDATE replay_runs
     SET current_business_date = ?, current_step = ?, status = ?, last_advanced_at = ?,
         completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END
     WHERE id = ?`,
  ).run(
    next.currentBusinessDate,
    newStepNumber,
    next.status,
    nowIso(),
    next.status,
    nowIso(),
    runId,
  );

  return { status: 'COMPLETED', currentBusinessDate: next.currentBusinessDate };
};

export const runReplayRunToCompletion = async (
  db: Database.Database,
  runId: string,
  kernel: (runId: string, stepId: string, businessDate: string) => Promise<KernelStepResult>,
): Promise<RunCompletionResult> => {
  let totalSteps = 0;
  let failedSteps = 0;
  // Safety: 366 step cap (replay-runner.ts convention). For 30-day P0011.x we
  // expect exactly 30; the cap protects against an infinite loop if a bug
  // ever lets the clock advance past the end.
  for (let i = 0; i < 366; i += 1) {
    const state = getReplayRunState(db, runId);
    if (isReplayTerminal(state.status)) break;
    const result = await runReplayRunStep(db, runId, kernel);
    totalSteps += 1;
    if (result.status === 'FAILED') {
      failedSteps += 1;
      return { status: 'FAILED', totalSteps, failedSteps };
    }
    // Coverage Gap: stop the continuous replay. No further cognition runs
    // for this run until the gap is resolved by acquisition (new run).
    if (result.status === 'BLOCKED') {
      return { status: 'BLOCKED', totalSteps, failedSteps };
    }
    if (result.status === 'PAUSED') {
      return { status: 'PAUSED', totalSteps, failedSteps };
    }
  }
  const final = getReplayRunState(db, runId);
  return {
    status: isReplayTerminal(final.status)
      ? (final.status as 'COMPLETED' | 'FAILED' | 'BLOCKED')
      : 'FAILED',
    totalSteps,
    failedSteps,
  };
};

// ── P0013.3 Historical Evidence Enrichment: historical re-runs ────────

/** Enumerate calendar dates [start..end] inclusive. */
const enumerateWindowDates = (start: string, end: string): string[] => {
  const out: string[] = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur.getTime() <= last.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
};

const assertDateInWindow = (run: ReplayRunState, businessDate: string): void => {
  if (businessDate < run.startBusinessDate || businessDate > run.endBusinessDate) {
    throw new Error(
      `business_date ${businessDate} outside run window ${run.startBusinessDate}..${run.endBusinessDate}`,
    );
  }
};

/**
 * Delete one day's cognition (step + snapshot + refs). Evidence rows are
 * NOT deleted (frozen seed stays; tagging is re-applied on re-run).
 */
const deleteCognitionForDate = (db: Database.Database, runId: string, businessDate: string): void => {
  const step = db
    .prepare(`SELECT id FROM replay_run_steps WHERE replay_run_id = ? AND business_date = ?`)
    .get(runId, businessDate) as { id: string } | undefined;
  const tx = db.transaction(() => {
    if (step) {
      db.prepare(`DELETE FROM replay_run_evidence_refs WHERE replay_run_step_id = ?`).run(step.id);
      db.prepare(`DELETE FROM replay_run_cognitive_snapshots WHERE replay_run_step_id = ?`).run(step.id);
    }
    db.prepare(
      `DELETE FROM replay_run_steps WHERE replay_run_id = ? AND business_date = ?`,
    ).run(runId, businessDate);
  });
  tx();
};

/**
 * Re-run ONE historical date after an enrichment. Does NOT move the run
 * clock; later days keep their stale flags. Post-kernel pipeline is the
 * same as a normal step (future-leak guard, tag, snapshot, refs).
 */
export const rerunHistoricalStep = async (
  db: Database.Database,
  runId: string,
  businessDate: string,
  kernel: (runId: string, stepId: string, businessDate: string) => Promise<KernelStepResult>,
): Promise<StepResult> => {
  const run = getReplayRunState(db, runId);
  assertDateInWindow(run, businessDate);
  const wasTerminal = isReplayTerminal(run.status);

  // Same Coverage Gate as a forward step: a rerun may not run cognition on
  // a business date the frozen acquisition cannot answer.
  const rerunGap = findCoverageGap(db, runId, businessDate);
  if (rerunGap) {
    blockRunOnCoverageGap(db, runId, rerunGap);
    return {
      status: 'BLOCKED',
      currentBusinessDate: businessDate,
      blockedBusinessDate: rerunGap.businessDate,
      blockedReasons: rerunGap.reasons,
      error: `Coverage Gap ${rerunGap.businessDate}: ${rerunGap.reasons.join(', ')}`,
    };
  }

  deleteCognitionForDate(db, runId, businessDate);
  db.prepare(`UPDATE replay_runs SET status = 'RUNNING' WHERE id = ?`).run(runId);

  const stepNumber = enumerateWindowDates(run.startBusinessDate, businessDate).length;
  const stepId = randomUUID();
  db.prepare(
    `INSERT INTO replay_run_steps
       (id, replay_run_id, step_number, business_date, status, started_at)
     VALUES (?, ?, ?, ?, 'RUNNING', ?)`,
  ).run(stepId, runId, stepNumber, businessDate, nowIso());

  let kernelResult: KernelStepResult;
  try {
    kernelResult = await kernel(runId, stepId, businessDate);
    assertNoFutureLeakage(db, kernelResult.evidenceObservationIds, businessDate);
    tagEvidenceAsReplayVisible(db, kernelResult.evidenceObservationIds, runId, stepId);
    persistSnapshot(db, stepId, businessDate, kernelResult);
    linkEvidenceRefs(db, stepId, kernelResult.evidenceObservationIds);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE replay_run_steps SET status='FAILED', error=?, completed_at=? WHERE id=?`,
    ).run(message, nowIso(), stepId);
    if (wasTerminal) markRunFailed(db, runId);
    return { status: 'FAILED', error: message, currentBusinessDate: businessDate };
  }

  // Fresh step row → enrichment_stale_at stays NULL (fresh cognition).
  db.prepare(
    `UPDATE replay_run_steps SET status='COMPLETED', completed_at=? WHERE id=?`,
  ).run(nowIso(), stepId);

  if (wasTerminal) {
    // Single-day rerun on a finished run: restore the terminal status the
    // run had before the rerun. A BLOCKED run stays BLOCKED — its coverage
    // gap is unresolved and is not cleared by rerunning another date.
    const restored = run.status === 'BLOCKED' ? 'BLOCKED' : 'COMPLETED';
    db.prepare(
      `UPDATE replay_runs SET status=?, last_advanced_at=? WHERE id=?`,
    ).run(restored, nowIso(), runId);
  }
  return { status: 'COMPLETED', currentBusinessDate: businessDate };
};

/**
 * Prepare a continuous replay from the earliest stale date: delete
 * cognition at/after T and reset the run cursor to T. The caller then
 * invokes runReplayRunStep repeatedly (or runReplayRunToCompletion) with
 * the same real kernel. Returns the earliest stale date, or null.
 */
export const resetRunToEarliestStale = (
  db: Database.Database,
  runId: string,
): { businessDate: string; staleDates: string[] } | null => {
  const staleDates = (
    db
      .prepare(
        `SELECT DISTINCT business_date FROM replay_run_steps
          WHERE replay_run_id = ? AND enrichment_stale_at IS NOT NULL
          ORDER BY business_date`,
      )
      .all(runId) as Array<{ business_date: string }>
  ).map((r) => r.business_date);
  if (staleDates.length === 0 || !staleDates[0]) return null;

  const first = staleDates[0];
  const run = getReplayRunState(db, runId);
  const stepNumber = enumerateWindowDates(run.startBusinessDate, first).length;

  const tx = db.transaction(() => {
    const steps = db
      .prepare(
        `SELECT id FROM replay_run_steps
          WHERE replay_run_id = ? AND business_date >= ?`,
      )
      .all(runId, first) as Array<{ id: string }>;
    for (const s of steps) {
      db.prepare(`DELETE FROM replay_run_evidence_refs WHERE replay_run_step_id = ?`).run(s.id);
      db.prepare(`DELETE FROM replay_run_cognitive_snapshots WHERE replay_run_step_id = ?`).run(s.id);
    }
    db.prepare(`DELETE FROM replay_run_steps WHERE replay_run_id = ? AND business_date >= ?`).run(
      runId,
      first,
    );
    // Reset cursor; new steps are inserted fresh (no stale stamp).
    db.prepare(
      `UPDATE replay_runs
         SET status='RUNNING', current_business_date=?, current_step=?
       WHERE id=?`,
    ).run(first, stepNumber - 1, runId);
  });
  tx();

  return { businessDate: first, staleDates };
};

export const pauseReplayRun = (db: Database.Database, runId: string): void => {
  const run = getReplayRunState(db, runId);
  if (isReplayTerminal(run.status)) return;
  db.prepare(`UPDATE replay_runs SET status = 'PAUSED' WHERE id = ?`).run(runId);
};

export const resumeReplayRun = (db: Database.Database, runId: string): void => {
  const run = getReplayRunState(db, runId);
  if (isReplayTerminal(run.status)) return;
  db.prepare(`UPDATE replay_runs SET status = 'RUNNING' WHERE id = ?`).run(runId);
};

// P0013 G2.2-fix (2026-09-04): clear any stuck RUNNING step row for a
// run, marking it FAILED with a "manually retried" note. This is the
// recovery helper for the orphan RUNNING-step deadlock: a previous
// runner crashed mid-flight, leaving the step row in RUNNING state,
// and the next runReplayRunStep call detects the existing row and
// returns PAUSED "concurrent advance in flight" (never advancing).
//
// After clearOrphanStep is called, the next runReplayRunStep call
// will hit the "existing FAILED" branch in insertOrFetchRunningStep
// (return FAILED, no kernel call) — so the caller must DELETE the
// failed row first, then re-insert. The route's `mode: 'retry'`
// handler does both: this function marks FAILED, then the route
// DELETEs and re-runs runReplayRunStep.
export const clearOrphanStep = (db: Database.Database, runId: string): number => {
  const result = db
    .prepare(
      `UPDATE replay_run_steps
         SET status = 'FAILED', error = COALESCE(error, '') || ' [manually retried]', completed_at = ?
       WHERE replay_run_id = ? AND status = 'RUNNING'`,
    )
    .run(nowIso(), runId);
  return result.changes;
};

// P0013 G2.2-fix (2026-09-04): skip the current step (mark
// SKIPPED_NO_DATA, advance the clock). The step row is preserved
// (P0013 §22 append-only) so the operator can revisit skipped days
// later via a P0013+ follow-up feature. The clock advances to the
// next business_date, mirroring the natural end-of-step advance.
/**
 * Re-arm a run whose current business date has a FAILED step so the operator's
 * 重试这一天 action can actually re-run it.
 *
 * Before this helper, retry only cleared rows carrying the
 * '[manually retried]' marker written by clearOrphanStep, so a step that
 * FAILED on its own (e.g. a Hermes turn timeout) blocked retry forever: the
 * runner saw the existing FAILED row and returned FAILED without running.
 *
 * Deletes ONLY the failed cognition row for the run's current business date.
 * A failed step carries no snapshot and no evidence refs (persistSnapshot is
 * transactional and linkEvidenceRefs runs after success), so nothing else is
 * orphaned. Returns the number of rows cleared.
 */
export const clearFailedCognitionForCurrentDate = (
  db: Database.Database,
  runId: string,
): number => {
  const info = db
    .prepare(
      `DELETE FROM replay_run_steps
        WHERE replay_run_id = ? AND status = 'FAILED'
          AND business_date = (
            SELECT current_business_date FROM replay_runs WHERE id = ?
          )`,
    )
    .run(runId, runId);
  return info.changes;
};

/** Re-arm a FAILED/BLOCKED run so a retry can execute (and re-evaluate the gate). */
export const rearmRunForRetry = (db: Database.Database, runId: string): number => {
  const info = db
    .prepare(
      `UPDATE replay_runs SET status = 'RUNNING'
        WHERE id = ? AND status IN ('FAILED', 'BLOCKED')`,
    )
    .run(runId);
  return info.changes;
};

export const skipCurrentStep = (db: Database.Database, runId: string): void => {
  const run = getReplayRunState(db, runId);
  if (isReplayTerminal(run.status)) return;
  const businessDate = run.currentBusinessDate;
  if (!businessDate) return;
  // Mark the step row SKIPPED_NO_DATA (or insert a marker if no row
  // exists — orphan-at-current case). Use INSERT-or-UPDATE so we
  // handle both shapes.
  const stepNumber = run.currentStep + 1;
  const stepId = (() => {
    // Prefer the existing step row id if one is present.
    const existing = db
      .prepare(`SELECT id FROM replay_run_steps WHERE replay_run_id = ? AND business_date = ?`)
      .get(runId, businessDate) as { id: string } | undefined;
    return existing ? existing.id : uuid();
  })();
  db.prepare(
    `INSERT INTO replay_run_steps
       (id, replay_run_id, step_number, business_date, status, error, started_at, completed_at)
     VALUES (?, ?, ?, ?, 'SKIPPED_NO_DATA', 'manually skipped', ?, ?)
     ON CONFLICT (replay_run_id, business_date) DO UPDATE
       SET status = 'SKIPPED_NO_DATA',
           error  = 'manually skipped',
           completed_at = excluded.completed_at`,
  ).run(stepId, runId, stepNumber, businessDate, nowIso(), nowIso());
  // Advance the clock.
  const clock = createReplayClock(businessDate, run.endBusinessDate, run.status);
  const next = nextDate(clock);
  db.prepare(
    `UPDATE replay_runs
       SET current_business_date = ?, current_step = current_step + 1, status = ?,
           last_advanced_at = ?,
           completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END
     WHERE id = ?`,
  ).run(
    next.currentBusinessDate,
    next.status,
    nowIso(),
    next.status,
    nowIso(),
    runId,
  );
};
