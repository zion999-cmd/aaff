// P0013 Phase 7 — Monthly Review generator (deterministic, §19 §20 §21).
//
// §19 fields (12): data_coverage, coverage_status, missing_dates,
// business_summary, business_phases, key_situations, judgment_evolution,
// major_recommendations, supported_judgments, revised_judgments,
// persistent_unknowns, evidence_gaps.
// §20: unverified_recommendations — every recommendation carries the
//   top-level note "No Action Evidence available; cannot verify execution
//   or outcome." This is the §14 boundary echoed at the monthly level.
// §21: PARTIAL is honest for August 2026 (P0011.x starts 2026-08-04).
//
// All computation is deterministic. No LLM. No Knowledge writes. Reads
// ONLY from replay_run_cognitive_snapshots + replay_run_evidence_refs +
// replay_run_steps. Idempotent: re-running the same month overwrites the
// UNIQUE(replay_run_id, business_month) row with the same body.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from '#shared/utils/time.js';
import type { ReplayCoverageStatus } from '#platform/storage/p0013-schema.js';

export interface MonthlyReviewBody {
  readonly business_summary: string;
  readonly business_phases: ReadonlyArray<{ phase: string; days: string; judgment: string }>;
  readonly key_situations: ReadonlyArray<{ business_date: string; judgment: string }>;
  readonly judgment_evolution: ReadonlyArray<{ business_date: string; judgment: string; status: string }>;
  readonly major_recommendations: ReadonlyArray<{ business_date: string; kind: string; text: string }>;
  readonly supported_judgments: ReadonlyArray<{ business_date: string; judgment: string; supporting_dates: string[] }>;
  readonly revised_judgments: ReadonlyArray<{ business_date: string; old_judgment: string; new_judgment: string; revised_at: string }>;
  readonly persistent_unknowns: ReadonlyArray<{ unknown: string; occurrences: number; first_seen: string }>;
  readonly evidence_gaps: ReadonlyArray<{ gap: string; business_date: string }>;
  readonly unverified_recommendations: ReadonlyArray<{
    business_date: string;
    note: string;
  }>;
}

export interface GeneratedMonthlyReview {
  readonly runId: string;
  readonly businessMonth: string;
  readonly dataCoverageStart: string;
  readonly dataCoverageEnd: string;
  readonly coverageStatus: ReplayCoverageStatus;
  readonly missingDates: ReadonlyArray<string>;
  readonly body: MonthlyReviewBody;
}

export interface GenerateMonthlyReviewArgs {
  readonly runId: string;
  readonly businessMonth: string; // YYYY-MM
}

// ── helpers ─────────────────────────────────────────────────────────────

const uuid = (): string => randomUUID();

const daysInMonth = (yyyymm: string): number => {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyymm);
  if (!m) throw new Error(`businessMonth must be YYYY-MM, got: ${yyyymm}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  return new Date(year, month, 0).getDate();
};

const enumerateMonthDates = (yyyymm: string): string[] => {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyymm);
  if (!m) throw new Error(`businessMonth must be YYYY-MM, got: ${yyyymm}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const last = daysInMonth(yyyymm);
  const out: string[] = [];
  for (let day = 1; day <= last; day += 1) {
    const dd = String(day).padStart(2, '0');
    out.push(`${year}-${String(month).padStart(2, '0')}-${dd}`);
  }
  return out;
};

const sameJudgment = (a: string, b: string): boolean => a.trim() === b.trim() && a.trim().length > 0;

interface SnapshotRow {
  readonly id: string;
  readonly business_date: string;
  readonly observed_facts: string;
  readonly current_understanding: string;
  readonly judgment: string;
  readonly recommendation_kind: string;
  readonly recommendation_text: string;
  readonly unknowns: string;
  readonly evidence_gaps: string;
  readonly supporting_evidence_refs: string;
}

const loadMonthSnapshots = (db: Database.Database, runId: string, yyyymm: string): SnapshotRow[] => {
  const prefix = `${yyyymm}-`;
  // Join snapshots to steps so we can filter on run_id + month cleanly.
  const rows = db
    .prepare(
      `SELECT snap.id, snap.business_date, snap.observed_facts, snap.current_understanding,
              snap.judgment, snap.recommendation_kind, snap.recommendation_text,
              snap.unknowns, snap.evidence_gaps, snap.supporting_evidence_refs
       FROM replay_run_cognitive_snapshots snap
       JOIN replay_run_steps step ON step.id = snap.replay_run_step_id
       WHERE step.replay_run_id = ? AND snap.business_date LIKE ?
       ORDER BY snap.business_date ASC`,
    )
    .all(runId, `${prefix}%`) as SnapshotRow[];
  return rows;
};

const parseJsonArray = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

// ── §19 computations ────────────────────────────────────────────────────

const computeJudgmentEvolution = (snaps: ReadonlyArray<SnapshotRow>) => {
  return snaps.map((s) => ({
    business_date: s.business_date,
    judgment: s.judgment,
    status: s.recommendation_kind,
  }));
};

const computeMajorRecommendations = (snaps: ReadonlyArray<SnapshotRow>) => {
  return snaps
    .filter((s) => s.recommendation_kind === 'act' && s.recommendation_text.trim().length > 0)
    .map((s) => ({
      business_date: s.business_date,
      kind: s.recommendation_kind,
      text: s.recommendation_text,
    }));
};

const computeSupportedJudgments = (snaps: ReadonlyArray<SnapshotRow>) => {
  // A judgment at day N is "supported" if the SAME judgment (or a
  // semantically equivalent one — for v1 we use exact match) appears in
  // a later snapshot within the next 7 days. This is a coarse proxy;
  // see [[p0013-monthly-review-semantics]] for why we keep it simple.
  const result: Array<{ business_date: string; judgment: string; supporting_dates: string[] }> = [];
  for (let i = 0; i < snaps.length; i += 1) {
    const a = snaps[i]!;
    if (a.judgment.trim().length === 0) continue;
    const aDateMs = Date.UTC(
      Number(a.business_date.slice(0, 4)),
      Number(a.business_date.slice(5, 7)) - 1,
      Number(a.business_date.slice(8, 10)),
    );
    const supporting: string[] = [];
    for (let j = i + 1; j < snaps.length; j += 1) {
      const b = snaps[j]!;
      const bDateMs = Date.UTC(
        Number(b.business_date.slice(0, 4)),
        Number(b.business_date.slice(5, 7)) - 1,
        Number(b.business_date.slice(8, 10)),
      );
      const diffDays = (bDateMs - aDateMs) / 86_400_000;
      if (diffDays > 7) break;
      if (sameJudgment(a.judgment, b.judgment)) supporting.push(b.business_date);
    }
    if (supporting.length > 0) {
      result.push({ business_date: a.business_date, judgment: a.judgment, supporting_dates: supporting });
    }
  }
  return result;
};

const computeRevisedJudgments = (snaps: ReadonlyArray<SnapshotRow>) => {
  // A judgment is "revised" if a later day carries a DIFFERENT judgment
  // within 7 days. We report the original and the first revision.
  const result: Array<{ business_date: string; old_judgment: string; new_judgment: string; revised_at: string }> = [];
  for (let i = 0; i < snaps.length; i += 1) {
    const a = snaps[i]!;
    if (a.judgment.trim().length === 0) continue;
    const aDateMs = Date.UTC(
      Number(a.business_date.slice(0, 4)),
      Number(a.business_date.slice(5, 7)) - 1,
      Number(a.business_date.slice(8, 10)),
    );
    for (let j = i + 1; j < snaps.length; j += 1) {
      const b = snaps[j]!;
      const bDateMs = Date.UTC(
        Number(b.business_date.slice(0, 4)),
        Number(b.business_date.slice(5, 7)) - 1,
        Number(b.business_date.slice(8, 10)),
      );
      const diffDays = (bDateMs - aDateMs) / 86_400_000;
      if (diffDays > 7) break;
      if (b.judgment.trim().length > 0 && !sameJudgment(a.judgment, b.judgment)) {
        result.push({
          business_date: a.business_date,
          old_judgment: a.judgment,
          new_judgment: b.judgment,
          revised_at: b.business_date,
        });
        break;
      }
    }
  }
  return result;
};

const computePersistentUnknowns = (snaps: ReadonlyArray<SnapshotRow>) => {
  // Group identical unknowns (exact match) across days. Threshold: 3+ days.
  const occurrences = new Map<string, { count: number; first_seen: string }>();
  for (const s of snaps) {
    const list = parseJsonArray(s.unknowns);
    for (const u of list) {
      const key = u.trim();
      if (key.length === 0) continue;
      const entry = occurrences.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        occurrences.set(key, { count: 1, first_seen: s.business_date });
      }
    }
  }
  const out: Array<{ unknown: string; occurrences: number; first_seen: string }> = [];
  for (const [unknown, info] of occurrences) {
    if (info.count >= 3) out.push({ unknown, occurrences: info.count, first_seen: info.first_seen });
  }
  out.sort((a, b) => b.occurrences - a.occurrences);
  return out;
};

const computeBusinessPhases = (snaps: ReadonlyArray<SnapshotRow>) => {
  // Contiguous-day clusters sharing the same judgment (exact match). Each
  // cluster is one "phase". Day gaps break the cluster.
  if (snaps.length === 0) return [];
  const phases: Array<{ phase: string; days: string; judgment: string }> = [];
  let clusterStart = snaps[0]!.business_date;
  let clusterEnd = snaps[0]!.business_date;
  let clusterJudgment = snaps[0]!.judgment;
  for (let i = 1; i < snaps.length; i += 1) {
    const cur = snaps[i]!;
    const prevDateMs = Date.UTC(
      Number(clusterEnd.slice(0, 4)),
      Number(clusterEnd.slice(5, 7)) - 1,
      Number(clusterEnd.slice(8, 10)),
    );
    const curDateMs = Date.UTC(
      Number(cur.business_date.slice(0, 4)),
      Number(cur.business_date.slice(5, 7)) - 1,
      Number(cur.business_date.slice(8, 10)),
    );
    const isNextDay = (curDateMs - prevDateMs) === 86_400_000;
    if (isNextDay && sameJudgment(cur.judgment, clusterJudgment)) {
      clusterEnd = cur.business_date;
    } else {
      phases.push({
        phase: clusterStart === clusterEnd ? clusterStart : `${clusterStart} → ${clusterEnd}`,
        days: clusterStart === clusterEnd ? clusterStart : `${clusterStart} → ${clusterEnd}`,
        judgment: clusterJudgment,
      });
      clusterStart = cur.business_date;
      clusterEnd = cur.business_date;
      clusterJudgment = cur.judgment;
    }
  }
  phases.push({
    phase: clusterStart === clusterEnd ? clusterStart : `${clusterStart} → ${clusterEnd}`,
    days: clusterStart === clusterEnd ? clusterStart : `${clusterStart} → ${clusterEnd}`,
    judgment: clusterJudgment,
  });
  return phases;
};

const computeKeySituations = (snaps: ReadonlyArray<SnapshotRow>) => {
  // Top N snapshots ranked by evidence_gaps length (proxy for "richest
  // unknown surface"). 5 is enough for the monthly summary; the operator
  // can click into any date in the timeline for the full view.
  const ranked = [...snaps]
    .map((s) => ({ s, gapCount: parseJsonArray(s.evidence_gaps).length }))
    .sort((a, b) => b.gapCount - a.gapCount)
    .slice(0, 5)
    .filter((x) => x.gapCount > 0);
  return ranked.map((x) => ({ business_date: x.s.business_date, judgment: x.s.judgment }));
};

const computeEvidenceGaps = (snaps: ReadonlyArray<SnapshotRow>) => {
  const out: Array<{ gap: string; business_date: string }> = [];
  for (const s of snaps) {
    for (const g of parseJsonArray(s.evidence_gaps)) {
      if (g.trim().length === 0) continue;
      out.push({ gap: g, business_date: s.business_date });
    }
  }
  return out;
};

const computeBusinessSummary = (snaps: ReadonlyArray<SnapshotRow>, coverageStart: string, coverageEnd: string): string => {
  if (snaps.length === 0) {
    return `No daily cognitive snapshots were produced between ${coverageStart} and ${coverageEnd}.`;
  }
  const observedCount = snaps.filter((s) => parseJsonArray(s.observed_facts).length > 0).length;
  const judgmentsNonEmpty = snaps.filter((s) => s.judgment.trim().length > 0).length;
  const recsAct = snaps.filter((s) => s.recommendation_kind === 'act').length;
  const recsObserve = snaps.filter((s) => s.recommendation_kind === 'observe').length;
  return (
    `Coverage: ${coverageStart} → ${coverageEnd} (${snaps.length} days). ` +
    `Non-empty observed_facts: ${observedCount}; non-empty judgments: ${judgmentsNonEmpty}; ` +
    `act recommendations: ${recsAct}; observe recommendations: ${recsObserve}.`
  );
};

const computeUnverifiedRecommendations = (snaps: ReadonlyArray<SnapshotRow>) => {
  // §20 — every recommendation (kind=observe OR kind=act) carries the
  // same top-level note. This is the §14 boundary echoed at month level.
  const NOTE = 'No Action Evidence available; cannot verify execution or outcome.';
  return snaps
    .filter((s) => s.recommendation_text.trim().length > 0)
    .map((s) => ({
      business_date: s.business_date,
      note: NOTE,
    }));
};

// ── public API ──────────────────────────────────────────────────────────

/**
 * Generate a deterministic Monthly Review for `(runId, businessMonth)`.
 * Persists to `replay_monthly_reviews` (UNIQUE on the pair, so re-running
 * overwrites the same row). Returns the generated body so the caller can
 * surface it without re-querying.
 *
 * Pure read of replay_* tables — never touches production rows.
 */
export const generateMonthlyReview = (
  db: Database.Database,
  args: GenerateMonthlyReviewArgs,
): GeneratedMonthlyReview => {
  const { runId, businessMonth } = args;
  if (!/^\d{4}-\d{2}$/.test(businessMonth)) {
    throw new Error(`businessMonth must be YYYY-MM, got: ${businessMonth}`);
  }
  const monthDates = enumerateMonthDates(businessMonth);
  const firstOfMonth = monthDates[0]!;

  const snaps = loadMonthSnapshots(db, runId, businessMonth);

  // §21 — coverage is COMPLETE iff the snapshot set spans the full
  // calendar month, PARTIAL otherwise. The min/max business_date in the
  // snapshot set is the data coverage range.
  let dataCoverageStart: string;
  let dataCoverageEnd: string;
  if (snaps.length === 0) {
    dataCoverageStart = firstOfMonth;
    dataCoverageEnd = firstOfMonth; // empty: degenerate start = end at the first day
  } else {
    dataCoverageStart = snaps[0]!.business_date;
    dataCoverageEnd = snaps[snaps.length - 1]!.business_date;
  }
  const presentDates = new Set(snaps.map((s) => s.business_date));
  const missingDates = monthDates.filter((d) => !presentDates.has(d));
  const coverageStatus: ReplayCoverageStatus = missingDates.length === 0 ? 'COMPLETE' : 'PARTIAL';

  const body: MonthlyReviewBody = {
    business_summary: computeBusinessSummary(snaps, dataCoverageStart, dataCoverageEnd),
    business_phases: computeBusinessPhases(snaps),
    key_situations: computeKeySituations(snaps),
    judgment_evolution: computeJudgmentEvolution(snaps),
    major_recommendations: computeMajorRecommendations(snaps),
    supported_judgments: computeSupportedJudgments(snaps),
    revised_judgments: computeRevisedJudgments(snaps),
    persistent_unknowns: computePersistentUnknowns(snaps),
    evidence_gaps: computeEvidenceGaps(snaps),
    unverified_recommendations: computeUnverifiedRecommendations(snaps),
  };

  // Persist (idempotent: UNIQUE(run_id, month)). Delete-then-insert keeps
  // the schema simple and avoids a partial-update path.
  db.prepare(`DELETE FROM replay_monthly_reviews WHERE replay_run_id = ? AND business_month = ?`).run(
    runId,
    businessMonth,
  );
  db.prepare(
    `INSERT INTO replay_monthly_reviews
     (id, replay_run_id, business_month, data_coverage_start, data_coverage_end,
      coverage_status, missing_dates, body_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid(),
    runId,
    businessMonth,
    dataCoverageStart,
    dataCoverageEnd,
    coverageStatus,
    JSON.stringify(missingDates),
    JSON.stringify(body),
    nowIso(),
  );

  return {
    runId,
    businessMonth,
    dataCoverageStart,
    dataCoverageEnd,
    coverageStatus,
    missingDates,
    body,
  };
};
