// P0013 — Replay cognition kernel: real Hermes wiring (replaces httpStubKernel).
//
// Phase 4 hardening (2026-09-03, after acceptance FAILED exposed stub
// cognition). The OLD kernel in `platform/server/routes/replay.ts:60-76`
// was an inline literal that returned `[HTTP-driven stub] No LLM kernel
// wired at this layer` for every step. That got 30/30 snapshots persisted
// with stub content. This module is the replacement.
//
// INVARIANTS (user 2026-09-03 verbatim, B+C atomic fix):
//   1. visibleEvidenceFor(runId, T) is called BEFORE the prompt is built.
//      The slice is the ONLY data the LLM sees. Future-dated evidence
//      is filtered out at the SQL boundary, not by prompt text.
//   2. We REUSE the production cognition chain:
//        client.submitPrompt  (Hermes WS)
//        collectTurn          (same turn collector as production)
//        parseInvestigation   (same canonical contract parser)
//      We do NOT build a second LLM client, a Replay-specific prompt
//      engine, or duplicate the Hermes integration.
//   3. We do NOT call runInvestigationTurn (it writes to learning_contexts
//      and situations, which is a §32 production-isolation violation).
//   4. We do NOT call mcp__fabric__fabric_execute_capability. Evidence
//      is already on disk (P0011.x fixture, frozen by §6); the LLM
//      reads from the prompt's "Current evidence" section, which we
//      populate from visibleEvidenceFor.
//   5. Confirmed Action is structurally null during Replay (§10/§14).
//      The kernel returns `confirmedAction: null` in its result; the
//      runner's stampEpistemicBoundary carries it forward.
//
// Output shape: matches `KernelStepResult` (see replay-runner-p0013.ts)
// so the runner is unchanged. The interface is kernel-agnostic.

import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import {
  visibleEvidenceFor,
  heldEvidenceFor,
  type VisibleEvidence,
  type HeldEvidenceKind,
} from './temporal-evidence-view.js';
import { collectTurn } from '#platform/server/routes/situation-chat.js';
import type { SituationChatClient } from '#platform/server/routes/situation-chat.js';
import { parseInvestigation } from '#app/runtime/investigation/index.js';
import type { ReplayRunState } from './replay-runner-p0013.js';
import type { KernelStepResult } from './replay-runner-p0013.js';
import {
  computeDirectionalFact,
  formatDirectionalFact,
  formatDirectionalFactShort,
  type DirectionalFact,
} from '#shared/utils/directional-fact.js';
import {
  formatRelativePerformanceShort,
  type RelativePerformanceFact,
} from '#shared/utils/relative-performance.js';
import { renderPerOrderSummary } from './per-order-summary.js';
import type { OrderDetailRow } from '#shared/contracts/historical-dataset.js';
import {
  ANALYSIS_TARGET_SECTION,
  ANALYSIS_OUTPUT_OBLIGATIONS,
  COGNITION_CONTINUITY_SECTION,
  EVIDENCE_RESOLUTION_SECTION,
  KNOWLEDGE_ANALYSIS_SECTION,
  REPLAY_ORDER_RETRIEVAL_SECTION,
  formatPriorCognitionSection,
} from '../investigation/analysis-contract.js';
import { visibleEnrichmentsAt, type EnrichmentRow } from './enrichment-store.js';

// ── P0013.3 Enrichment rendering ───────────────────────────────────────

const ENRICHMENT_LABEL: Record<EnrichmentRow['kind'], string> = {
  fact: 'fact (客观事实)',
  action: 'action (运营动作)',
  operator_feedback: 'operator_feedback (人的判断 — HUMAN INPUT, NOT AN OBSERVED FACT)',
};

const formatEnrichments = (rows: readonly EnrichmentRow[]): string => {
  if (rows.length === 0) {
    return '(no operator enrichments — only the frozen historical evidence is available)';
  }
  return rows
    .map(
      (r) =>
        `- [${r.businessDate} | ${ENRICHMENT_LABEL[r.kind]} | source=${r.source} | ${r.createdAt.slice(0, 16)}] ${r.content}`,
    )
    .join('\n');
};

// ── Prompt builder ──────────────────────────────────────────────────────

/**
 * Read the JSON at `path` and extract a short text summary of the
 * business numbers for the given (capability, data_type, businessDate).
 *
 * P0013 G1-fix (2026-09-03): without this, the LLM sees only metadata
 * (file path, size, hash) and cannot reason about the actual GMV /
 * orders / CVR. The Agent's cognition is gated on seeing the numbers.
 *
 * We read the file each prompt-build. The files are small (< 100 KB)
 * and this runs at most once per day per run; no need to cache.
 *
 * If the file or the expected key is missing, we return null and the
 * prompt shows just the metadata line — better than throwing (the
 * runner would fail the step and the operator would lose the run).
 */
const readEvidenceContentSummary = (
  path: string,
  capability: string,
  dataType: string,
  businessDate: string,
): string | null => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // trade.overview / getSummary — the acquisition's KPI block.
  //
  // P0013.5 cognition-path audit (2026-09-16): this used to render a
  // hardcoded 4 of the file's KPIs (its comment claimed "the 6 KPIs the
  // dataset decoded", which was also wrong). The frozen file decodes 12
  // readable KPIs including 访客数(UV) / 浏览量(PV) / 加购 — the exact
  // traffic block an operator reading "traffic is unavailable" would ask
  // for. Render every KPI that is actually in the file, and state the
  // window it aggregates over: this file is ONE aggregate over the whole
  // acquisition window, so it must never be readable as a single-day fact.
  if (capability === 'trade.overview' && dataType === 'getSummary') {
    const kpis = obj['all_kpis_readable'];
    if (kpis && typeof kpis === 'object') {
      const k = kpis as Record<string, unknown>;
      const parts = Object.entries(k).map(([label, v]) => {
        const rec = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
        const value = rec ? rec['value'] : v;
        const cmp = rec ? rec['compare_pct'] : undefined;
        if (cmp === undefined || cmp === null || Number.isNaN(Number(cmp))) {
          return `${label}=${String(value)}`;
        }
        const pct = (Number(cmp) * 100).toFixed(1);
        return `${label}=${String(value)} (${Number(cmp) >= 0 ? '+' : ''}${pct}% 对比期)`;
      });
      const range = obj['date_range'];
      const r = range && typeof range === 'object' ? (range as Record<string, unknown>) : null;
      const covers = r ? ` — 覆盖 ${String(r['start'])}..${String(r['end'])}（整段窗口聚合，非单日值）` : '';
      return `${parts.join(' | ')}${covers}`;
    }
  }

  // trade.overview / getTrend — find the row whose `date` matches.
  if (capability === 'trade.overview' && dataType === 'getTrend') {
    const rows = obj['rows'];
    if (Array.isArray(rows)) {
      const row = rows.find((r) => {
        if (r && typeof r === 'object') {
          return (r as Record<string, unknown>)['date'] === businessDate;
        }
        return false;
      });
      if (row && typeof row === 'object') {
        const r = row as Record<string, unknown>;
        // The 3 series from the dataset: GMV, industry GMV, prevIndustry GMV.
        const own = String(r['jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot'] ?? '—');
        const ind = String(
          r['jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##industry'] ?? '—',
        );
        const pre = String(
          r['jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##preIndustry'] ?? '—',
        );
        return `本店铺GMV=${own} | 同行业GMV=${ind} | 上期行业GMV=${pre}`;
      }
    }
  }

  // order.overview / perDaySummary — find the per_day[date] entry.
  if (capability === 'order.overview' && dataType === 'perDaySummary') {
    const perDay = obj['per_day'];
    if (Array.isArray(perDay)) {
      const entry = perDay.find((e) => {
        if (Array.isArray(e) && e.length >= 1) return e[0] === businessDate;
        return false;
      });
      if (Array.isArray(entry) && entry.length >= 2) {
        const agg = entry[1] as Record<string, unknown> | undefined;
        if (agg && typeof agg === 'object') {
          return `订单数=${String(agg['orders'] ?? '—')} | 件数=${String(agg['qty'] ?? '—')} | 金额=${String(agg['amt'] ?? '—')}`;
        }
      }
    }
  }

  // order.overview / perOrder — P0013 Task 2 Phase B.
  // The on-disk file `target_b_order_detail_parsed.json` is a RAW ARRAY
  // of 2412 OrderDetailRow entries (header + child). We render a 1-line
  // summary (NOT the rows) so the LLM sees per-order evidence exists.
  // The full rows remain reachable via the Replay-local retrieval route.
  if (capability === 'order.overview' && dataType === 'perOrder') {
    if (Array.isArray(parsed)) {
      // Filter to the day being summarized (the file has all 30 days).
      const dayRows = (parsed as unknown as OrderDetailRow[]).filter(
        (r) => r.biz_date === businessDate,
      );
      return renderPerOrderSummary(dayRows, businessDate);
    }
  }

  return null;
};

// ── Structured Fact Builder (Evidence Semantic Integrity) ──────────────
//
// The LLM is asked to interpret raw absolute values like
//   `本店铺GMV=3961.21 | 同行业GMV=1896.75 | 上期行业GMV=18347.88`
// and to VERBALIZE the direction itself ("回落" / "上涨" / "跑输"). This
// pushes the LLM to combine three signed numbers in its head and pick a
// direction word, which is exactly where double-sign prose like
// "GMV 回落 -44.6%" originates.
//
// The fix: Fabric pre-computes the DirectionalFact (and RelativePerformance
// when both subject + market are available) and emits the canonical prose
// alongside the raw values. The LLM still sees the raw numbers (they are
// the source of truth) but does NOT need to verbalize direction — that
// decision is already made by the contract.
//
// Output shape (one line per evidence row, appended after the raw summary):
//
//   方向性事实 (Structured DirectionalFact, computed by Fabric):
//     - 成交金额: 从 ¥1896.75 下降至 ¥18347.88，降幅 89.7%（vs 上期行业）
//     - 相对表现: 店铺下降 44.6%，大盘下降 89.7%，店铺相对大盘跑赢 45.1pp
//
// The raw values stay above. The structured facts are below, in a
// separate, machine-aligned section. Forbidden patterns (any of
// "下降 -X%" / "回落 X%" / "跑输 X%") are statically impossible because
// the formatter only emits unsigned magnitude (magnitude_pct) + the
// canonical magnitude word (降幅/涨幅/幅度) + the relative gap in pp.

/** A single metric reading extracted from a getSummary / getTrend file. */
interface MetricReading {
  readonly label: string;
  readonly current_value: number;
  readonly previous_value: number;
  /** Human-readable comparison base, e.g. "上期行业" or "昨日同时段". */
  readonly comparison_base: string;
  /** Match the BaselineSource union — fed verbatim to the contract. */
  readonly baseline_source: 'yesterday_same_moment' | 'previous_day_full' | 'prior_window' | 'industry_indicator' | 'product_vs_category';
  /** Optional metric key for the default formatter. */
  readonly metric?: 'gmv' | 'orders' | 'uv' | 'cvr';
}

/**
 * Pull every (current, previous) pair we can recognize from a parsed
 * P0011.x file. Returns MetricReading[] in stable order. Returns [] when
 * the file is unrecognized or all values are missing/non-finite.
 *
 * Recognized shapes:
 *   - getSummary / all_kpis_readable[*] → { value, compare_abs }
 *     (compare_pct is the JD-relative pct; we re-derive from
 *      value/compare_abs to avoid trusting the API's signed float directly)
 *   - getTrend / row[industry] vs row[preIndustry] → industry delta only
 *     (the shop delta is NOT in this file; we surface it as a market fact
 *      labeled "vs 上期行业")
 */
const extractMetricReadings = (parsed: unknown, businessDate: string): MetricReading[] => {
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;

  // Shape 1 — trade.overview / getSummary (all_kpis_readable)
  const kpis = obj['all_kpis_readable'];
  if (kpis && typeof kpis === 'object') {
    const k = kpis as Record<string, unknown>;
    const out: MetricReading[] = [];
    // The 7 known KPIs. The label after the space is the canonical
    // Chinese name; the part before is the JD metric name.
    const kpiKeys: ReadonlyArray<{ key: string; label: string; metric?: 'gmv' | 'orders' | 'uv' | 'cvr' }> = [
      { key: 'GMV 成交金额', label: '成交金额', metric: 'gmv' },
      { key: 'orders 成交单量', label: '订单量', metric: 'orders' },
      { key: 'customers 成交客户数', label: '成交客户数' },
      { key: 'sku_pieces 成交商品件数', label: '成交商品件数' },
      { key: 'AOV 客单价', label: '客单价' },
      { key: 'CVR 转化率', label: '转化率', metric: 'cvr' },
      { key: 'UV 访客数', label: '访客数', metric: 'uv' },
      { key: 'PV 浏览量', label: '浏览量' },
    ];
    for (const { key, label, metric } of kpiKeys) {
      const entry = k[key];
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const cur = e['value'];
      const prev = e['compare_abs'];
      if (typeof cur !== 'number' || typeof prev !== 'number') continue;
      if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) continue;
      out.push({
        label,
        current_value: cur,
        previous_value: prev,
        comparison_base: '上期 30 天',
        baseline_source: 'prior_window',
        ...(metric ? { metric } : {}),
      });
    }
    return out;
  }

  // Shape 2 — trade.overview / getTrend (per-day row)
  const rows = obj['rows'];
  if (Array.isArray(rows)) {
    const row = rows.find((r) => {
      if (r && typeof r === 'object') {
        return (r as Record<string, unknown>)['date'] === businessDate;
      }
      return false;
    });
    if (row && typeof row === 'object') {
      const r = row as Record<string, unknown>;
      const industry = r['jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##industry'];
      const preIndustry = r['jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##preIndustry'];
      const own = r['jdr_sch_trade_deal_ord_ord_amt_sz_trade_deal_snapshot'];
      const out: MetricReading[] = [];
      if (
        typeof industry === 'number' &&
        typeof preIndustry === 'number' &&
        Number.isFinite(industry) &&
        Number.isFinite(preIndustry) &&
        preIndustry !== 0
      ) {
        out.push({
          label: '行业 GMV',
          current_value: industry,
          previous_value: preIndustry,
          comparison_base: '上期同时段',
          baseline_source: 'industry_indicator',
          metric: 'gmv',
        });
      }
      // Shop's OWN same-day reading is also a fact (no prior in this file,
      // so it has no direction — we surface it as a flat direction-less
      // entry to make the LLM aware the value exists).
      if (typeof own === 'number' && Number.isFinite(own)) {
        out.push({
          label: '店铺 GMV (今日同行业时段)',
          current_value: own,
          previous_value: 0, // explicit zero → contract returns null → no fake fact
          comparison_base: '上期同时段',
          baseline_source: 'industry_indicator',
          metric: 'gmv',
        });
      }
      return out;
    }
  }

  return [];
};

/** Compute the structured DirectionalFacts for a parsed evidence file. */
const computeDirectionalFacts = (parsed: unknown, businessDate: string): DirectionalFact[] => {
  const readings = extractMetricReadings(parsed, businessDate);
  const facts: DirectionalFact[] = [];
  for (const r of readings) {
    const fact = computeDirectionalFact({
      current: r.current_value,
      previous: r.previous_value,
      comparison_base: r.comparison_base,
      observation_window: `business_date=${businessDate}`,
      baseline_source: r.baseline_source,
    });
    if (fact) facts.push(fact);
  }
  return facts;
};

/** Format the structured facts as canonical prose for the LLM prompt. */
const formatStructuredFacts = (parsed: unknown, businessDate: string): string | null => {
  const facts = computeDirectionalFacts(parsed, businessDate);
  if (facts.length === 0) return null;
  const lines = facts.map((f) => {
    // One line per fact. For getSummary we use the long form (with the
    // A → B transition), for getTrend the short form (just direction +
    // magnitude + comparison_base) to keep the prompt concise.
    const long = formatDirectionalFact(f, {
      metric_label: f.comparison_base,
      value_formatter:
        f.delta_signed && Math.abs(f.delta_signed) > 100
          ? (v) => `¥${v.toFixed(2)}`
          : (v) => v.toFixed(2),
    });
    const short = formatDirectionalFactShort(f, { metric_label: '' });
    return `      - ${f.observation_window} | ${long} | short: ${short}`;
  });
  return `  方向性事实 (Structured DirectionalFact, computed by Fabric — do NOT verbalize direction yourself):\n${lines.join('\n')}`;
};

/**
 * Compute the second-order fact: shop vs market. Only emitted when BOTH
 * a shop fact and a market fact exist in the SAME parsed file (i.e. for
 * getTrend rows where we have both). For mixed getSummary + getTrend
 * (different windows), the contract would return null — the LLM should
 * not combine windows of different granularity.
 */
const computeRelativePerformanceForFile = (
  parsed: unknown,
  businessDate: string,
): RelativePerformanceFact | null => {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const rows = obj['rows'];
  if (!Array.isArray(rows)) return null;
  const row = rows.find((r) => {
    if (r && typeof r === 'object') {
      return (r as Record<string, unknown>)['date'] === businessDate;
    }
    return false;
  });
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const industry = r['jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##industry'];
  const preIndustry = r['jdr_sch_trade_deal_ord_ord_amt_sz_trade_shop_cate_and_level_snapshot##preIndustry'];
  if (
    typeof industry !== 'number' ||
    typeof preIndustry !== 'number' ||
    !Number.isFinite(industry) ||
    !Number.isFinite(preIndustry) ||
    preIndustry === 0
  ) {
    return null;
  }
  // Without a prior shop GMV in this file, we cannot compute a shop
  // DirectionalFact for relative comparison. The honest answer is null.
  // (The shop's direction comes from getSummary, which is a different
  //  window — combining 30-day with same-day is not a valid comparison.)
  return null;
};

/**
 * P0013.5 — render the run's holdings. Describes only what exists (kind,
 * count, business_date coverage, how many rows are visible at T). It never
 * describes a value, and it does not widen what the Agent may read:
 * "Current evidence" remains the only visible slice.
 */
const formatHeldEvidence = (
  kinds: readonly HeldEvidenceKind[],
  businessDate: string,
): string => {
  if (kinds.length === 0) {
    return '(the run holds no evidence rows)';
  }
  return kinds
    .map((k) => {
      const coverage =
        k.firstDate === k.lastDate ? k.firstDate : `${k.firstDate}..${k.lastDate}`;
      const availability =
        k.visibleAtT === 0
          ? `0 visible at T=${businessDate} (not available today)`
          : `${k.visibleAtT}/${k.rows} visible at T=${businessDate}`;
      return `- ${k.capability}/${k.data_type} — ${k.rows} rows, business_date ${coverage} — ${availability}`;
    })
    .join('\n');
};

const formatVisibleEvidence = (rows: readonly VisibleEvidence[]): string => {
  if (rows.length === 0) {
    return '(no visible evidence yet — this is the first day of the run, or no data was acquired for any prior business_date)';
  }
  return rows
    .map((r) => {
      const summary = readEvidenceContentSummary(
        r.evidence_file_path,
        r.capability,
        r.data_type,
        r.business_date,
      );
      // Also compute the structured facts (Phase E.2 — Evidence Semantic
      // Integrity). This is a separate section so the LLM can read the
      // raw values (source of truth) AND the normalized direction
      // (Fabric's structured interpretation).
      let structuredSection = '';
      try {
        const raw = readFileSync(r.evidence_file_path, 'utf8');
        const parsed = JSON.parse(raw);
        const factsPart = formatStructuredFacts(parsed, r.business_date);
        const relPart = computeRelativePerformanceForFile(parsed, r.business_date);
        const parts: string[] = [];
        if (factsPart) parts.push(factsPart);
        if (relPart) {
          parts.push(`  相对表现 (RelativePerformance): ${formatRelativePerformanceShort(relPart)}`);
        }
        if (parts.length > 0) {
          structuredSection = '\n' + parts.join('\n');
        }
      } catch {
        // Parsing failed — fall back to raw-only. The LLM sees the raw
        // values; the absence of a structured-facts line is honest
        // ("Fabric could not compute the fact" rather than fabricating
        // a direction from a malformed file).
      }
      const summaryPart = summary ? `\n    内容: ${summary}` : '';
      return (
        `- id=${r.id} business_date=${r.business_date} bucket=${r.business_time_bucket} ` +
        `capability=${r.capability} data_type=${r.data_type} path=${r.evidence_file_path} ` +
        `size=${r.content_size}B hash=${r.content_hash.slice(0, 12)}` +
        summaryPart +
        structuredSection
      );
    })
    .join('\n');
};

const formatPriorSnapshots = (
  rows: ReadonlyArray<{ business_date: string; judgment: string; recommendation_text: string }>,
): string => {
  if (rows.length === 0) return '(no prior days in this run yet)';
  return rows
    .map((r) => `- ${r.business_date} | judgment=${r.judgment} | recommendation=${r.recommendation_text}`)
    .join('\n');
};

// ── Prior Cognition (Epistemic Integrity, 2026-09-06, Phase F) ────────
//
// The Replay layer is where the L3→L4 silent upgrade bug is most dangerous:
// T-1's hypothesis (e.g. "10000+ 新常态") is a HISTORICAL HYPOTHESIS at T,
// not a current fact. The previous kernel just formatted prior days' judgments
// as plain text, leaving the LLM free to either re-cite them as "still true"
// or ignore them silently. Both behaviors are epistemic violations.
//
// The fix: load T-1's epistemic_layers (or fall back to judgment +
// recommendation_text) as a typed `PriorCognition[]` array. The prompt
// renders it under a "## Prior Cognition (Historical, not Current)" section
// that explicitly tells the LLM "T-1's hypothesis is still a hypothesis".
// The LLM may shift status_at_t with new evidence_refs[], but the layer
// is structurally isolated from current_understanding / observed[].

const loadPriorCognition = (
  db: Database.Database,
  runId: string,
  upToBusinessDateExclusive: string,
): ReadonlyArray<{
  readonly business_date: string;
  readonly judgment: string;
  readonly recommendation_text: string;
}> => {
  // Pull each prior step's persisted judgment + recommendation as a flat
  // prior-cognition list. We do NOT pre-compute status_at_t — that's the
  // LLM's job, with T's evidence as input. The pre-load is strictly T-1
  // status (the persisted invariant).
  return db
    .prepare(
      `SELECT s.business_date, snap.judgment, snap.recommendation_text
       FROM replay_run_steps s
       JOIN replay_run_cognitive_snapshots snap ON snap.replay_run_step_id = s.id
       WHERE s.replay_run_id = ?
         AND s.business_date < ?
       ORDER BY s.business_date ASC`,
    )
    .all(runId, upToBusinessDateExclusive) as Array<{
      business_date: string;
      judgment: string;
      recommendation_text: string;
    }>;
};

/**
 * Build the Replay Investigation prompt. Sibling of `buildInvestigationPrompt`,
 * NOT a replacement. Output is the canonical Investigation Contract JSON
 * shape (same fields as production). The prompt explicitly forbids
 * looking at future evidence and forbids `confirmed_action`.
 *
 * Epistemic Integrity (2026-09-06) — adds:
 *   - explicit Observed Fact / Pattern / Hypothesis / Confirmed / Judgment
 *     layer contract (same as production — NO Replay-only workaround)
 *   - prior_cognition section so T-1's hypothesis does NOT auto-upgrade
 *     to T's current fact
 *   - per-claim evidence_refs[] (no bare "10000+ 新常态" as Fact)
 *   - threshold provenance (no invented ">12000 = confirmed" rule)
 *   - knowledge ≠ evidence boundary
 */
export const buildReplayInvestigationPrompt = (
  args: {
    readonly run: ReplayRunState;
    readonly businessDate: string;
    readonly visibleEvidence: readonly VisibleEvidence[];
    readonly priorSnapshots: ReadonlyArray<{
      readonly business_date: string;
      readonly judgment: string;
      readonly recommendation_text: string;
    }>;
    readonly priorCognition: ReadonlyArray<{
      readonly business_date: string;
      readonly kind: 'prior_hypothesis' | 'prior_judgment' | 'prior_recommendation';
      readonly content: string;
      readonly status_at_t_minus_1: 'proposed' | 'supported' | 'weakened' | 'rejected' | 'unknown';
    }>;
    /** P0013.3 operator enrichments visible at business time T. */
    readonly enrichments?: readonly EnrichmentRow[];
    /** P0013.5 — inventory of what the run's frozen dataset holds. */
    readonly heldEvidence?: readonly HeldEvidenceKind[];
  },
): string => {
  const {
    run,
    businessDate,
    visibleEvidence,
    priorSnapshots,
    priorCognition,
    enrichments = [],
    heldEvidence = [],
  } = args;
  return [
    `You are running P0013 Historical Cognitive Replay. The business day is ${businessDate}.`,
    ``,
    `## Runtime Trust Boundary`,
    `Read this ONCE. It applies to every section below.`,
    ``,
    `- The "Current evidence" section below is the ONLY data you see. It was `,
    `  computed by SQL \`WHERE business_date <= ${businessDate}\`. You have NO `,
    `  access to future days. Do not request them, do not speculate about them.`,
    `- Confirmed Action is structurally impossible during Replay. The system `,
    `  has no way to know whether the operator acted on any past recommendation. `,
    `  Output \`confirmed_action: null\` (do not synthesize an outcome).`,
    `- Your output is a proposal, not an action. P0013 §14 — Replay NEVER `,
    `  executes. \`recommendation_executed\` MUST be omitted or false.`,
    `- Evidence / knowledge boundaries: \`knowledge/\` is read-only (you READ `,
    `  it for the shared Knowledge section; you never write it), `,
    `  \`capabilities/\` is read-only. Do NOT call `,
    `  \`mcp__fabric__fabric_execute_capability\` or the browser tools — no LIVE `,
    `  acquisition; the data is already frozen on disk. The only permitted `,
    `  ACQUISITION tool is the read-only \`fabric_replay_retrieve_orders\` (see `,
    `  Evidence Resolution); it reads the frozen rows, never acquires and `,
    `  never crosses T.`,
    ``,
    `## Run context`,
    `- run_id: ${run.id}`,
    `- shop: ${run.shopName} (${run.shopId})`,
    `- source_dataset_path: ${run.sourceDatasetPath}`,
    `- source_manifest_hash: ${run.sourceManifestHash}`,
    `- current_business_date (T): ${businessDate}`,
    `- run window: ${run.endBusinessDate} is the last day`,
    ``,
    `## Current evidence (already observed, business_date <= ${businessDate})`,
    formatVisibleEvidence(visibleEvidence),
    ``,
    // ===== P0013.5 — the run's Evidence Universe =====
    // Production can read `capabilities/INDEX.md` to learn what Fabric is
    // able to observe; Replay had no equivalent, so a need the Agent could
    // not see was indistinguishable from a need the system never collected.
    // This inventory is generated from the run's own frozen rows.
    `## Evidence Universe of this run (complete inventory — the dataset is frozen)`,
    formatHeldEvidence(heldEvidence, businessDate),
    ``,
    `How to read this inventory: Replay cannot acquire anything, so this list IS the `,
    `whole world available to this run. When you need a fact:`,
    `- if its capability/data_type is listed AND has visible rows at T, it is in "Current evidence" above — use it;`,
    `- if it is listed with 0 rows visible at T, the run holds it but not yet at T — it is NOT available today;`,
    `- if it is NOT listed at all, the frozen dataset never acquired it. Record an Evidence Gap with a concrete acquisition_need, and say it was not acquired — do NOT describe a fact that was never collected as "hidden from me", and do NOT report a collected fact as missing.`,
    `Do not treat this inventory as an agenda: it lists what exists, not what you must use.`,
    ``,
    // ===== P0013.3 Historical Evidence Enrichment =====
    `## Operator enrichments (human-provided, append-only, business_date <= ${businessDate})`,
    formatEnrichments(enrichments),
    ``,
    `Enrichment rules:`,
    `- These records are BACKGROUND CONTEXT the operator happened to record. They are dated inputs alongside the frozen evidence — operator-attributed, not system-acquired. They are NOT an agenda: you are not required to address them, explain them, verify them, or produce any verdict about them.`,
    `- Use an entry ONLY when it actually bears on today's reading of the business (for example it changes what a structural reading means). When it is not relevant, say nothing about it. Silence is the correct form — do not add a daily "this did not cause that" line, and do not re-verify yesterday's enrichment.`,
    `- "fact" / "action" entries are human-supplied records of what objectively happened or was done on the recorded business date; weigh them against the evidence the way you would any dated input.`,
    `- "operator_feedback" is a PERSON'S JUDGMENT / interpretation. It is HUMAN INPUT, never an Observed Fact: do NOT put it in observed[]/observed_facts/knownEvidence as a fact; weigh it like guidance and surface disagreement with evidence instead of silently overriding either side.`,
    `- WHEN an enrichment IS relevant and an action is followed (on a later date) by an outcome, that outcome MUST NOT be stated as caused by the action. No causal "action → outcome" claim without evidence beyond temporal order; describe sequence, not causation.`,
    `- These records do not modify the frozen dataset or original evidence; they are the only human-provided historical context you see.`,
    ``,
    // ===== P0013.2 Evidence Resolution (shared Production + Replay) =====
    EVIDENCE_RESOLUTION_SECTION,
    ``,
    REPLAY_ORDER_RETRIEVAL_SECTION,
    ``,
    `## Prior days' judgments (read-only; do not re-investigate)`,
    formatPriorSnapshots(priorSnapshots),
    ``,
    // ===== Epistemic Integrity (Phase F — Prior Cognition boundary) =====
    //
    // The previous Replay kernel just dumped prior days' judgments as plain
    // text. The LLM then either re-cited them as "still true" (silent L3→L4
    // upgrade) or ignored them silently. Both are epistemic violations.
    //
    // The fix: prior_cognition is now a TYPED LIST of T-1's prior
    // hypothesis / judgment / recommendation with explicit status_at_t_minus_1.
    // The LLM may shift `status_at_t` based on T's NEW evidence, but it
    // CANNOT silently upgrade T-1's hypothesis to T's current fact.
    `## Prior Cognition (Historical, NOT Current — Phase F)`,
    formatPriorCognitionSection(priorCognition),
    ``,
    `INVARIANT: A T-1 \`status: proposed\` hypothesis is STILL \`proposed\` at T until NEW Evidence at T shifts it. A T-1 \`status: supported\` hypothesis does NOT auto-upgrade to Confirmed at T. You may write a fresh \`prior_cognition[]\` entry showing how T's new Evidence shifts the T-1 status — but this list is your standing understanding, NOT a set of questions to answer back. Do not score it item by item; carry it forward silently unless today's evidence changes it.`,
    ``,
    `## Epistemic Layers — DO NOT COLLAPSE (Phase B)`,
    ``,
    `Your cognition MUST distinguish 5 layers:`,
    `| L1 Observed Fact | direct read of current Evidence | ≥1 evidence_refs[] |`,
    `| L2 Pattern | inductive form from multiple Observed Facts | based_on[] ≥2 obs OR pattern_type: candidate |`,
    `| L3 Hypothesis | causal/mechanism explanation | supporting_evidence_refs[] + missing_evidence[] + falsifier |`,
    `| L4 Confirmed | claim with explicit confirmation | confirmed_evidence_refs[] ≥1 (operator/system) |`,
    `| L5 Judgment | decision grounded in L1-L4 | known / inferred / unknown + decision + confidence_basis |`,
    ``,
    `Hard rules:`,
    `- A statement that says "近期存在放量日 + 回调日交替规律" without an \`observed[]\` list is a Pattern Candidate, NOT an Established Pattern.`,
    `- A statement that says "8-14 是 88 大促 8-15 前夜" without operator-confirmed activity records is a Knowledge Prior, NOT a current store fact. Put it in \`hypotheses[]\` with status: proposed + falsifier.`,
    `- A statement that says "确认为订单前置" without an operator intervention record is NOT Confirmed. It is a \`hypothesis\` with status: proposed.`,
    `- "确认" / "已确认" / "definitely" / "confirmed" in any natural-language field is unsourced confirmation language UNLESS paired with \`confirmed_evidence_refs[]\`. The parser does NOT silently rewrite "confirmed" → "supported" anymore.`,
    ``,
    // ===== P0013.5 shared Knowledge obligation (Production + Replay) =====
    KNOWLEDGE_ANALYSIS_SECTION,
    ``,
    `## Per-claim provenance (Phase C) + Threshold provenance (Phase E)`,
    ``,
    `Strong claims (numeric / temporal / consecutive / alternation / stable / baseline / recovery / anomaly / confirmation / reversal / causal) MUST have \`claim_evidence_refs[].evidence_refs[]\`. Empty = Evidence Gap.`,
    `Quantitative thresholds MUST have \`thresholds[]\` with provenance: heuristic | evidence_derived | knowledge_rule | operator_rule | business_policy. Emit a threshold only when a real operator decision depends on it — do NOT invent classification gates or ladders to label the day's state, and a heuristic MUST NOT be called a "confirmation rule".`,
    ``,
    `## Three concepts — DO NOT CONFLATE`,
    `| Observed | facts in the visible evidence list above | read-only | always have a `,
    `  source row |`,
    `| Inferred | your current understanding + judgment | synthesized from `,
    `  observed | subject to §10/§14 — Confirmed Action is null |`,
    `| Confirmed Action | whether the operator acted on a prior recommendation | `,
    `  STRUCTURALLY NULL during Replay | output \`null\` |`,
    ``,
    `## Output language — Simplified Chinese (zh-CN)`,
    `Business-facing natural-language fields MUST be in Simplified Chinese. The `,
    `Investigation Contract's canonical status values (judgment/observe/`,
    `missing_capability/ask_human) MUST stay in canonical English.`,
    ``,
    // ===== P0013.4 Cognition continuity (shared) =====
    COGNITION_CONTINUITY_SECTION,
    ``,
    // ===== P0013.2 Shared Analysis Contract (Production + Replay) =====
    ANALYSIS_TARGET_SECTION,
    ``,
    `## Investigation Workflow`,
    `1. Read the visible evidence list. What facts does it support? → populate \`observed[]\`.`,
    `2. Read relevant Knowledge — follow the shared Knowledge section: \`knowledge/INDEX.md\` → the matching domain \`INDEX.md\` → the ONE most relevant page.`,
    `3. Hold the prior_cognition list as your standing understanding. Continue it, revise it, or drop what no longer matters — silently. Do NOT produce a per-item verdict on it, and do NOT re-cite it as current fact.`,
    `4. Form at most 3 hypotheses from Knowledge + Evidence. Mark each \`proposed\`. Each MUST have \`missing_evidence[]\` + \`falsifier\`.`,
    `5. Ask what today's evidence CHANGES about that understanding (what continued / what changed / what is still unknown). Record only the gaps that actually block today's reading; a quantitative threshold belongs in \`thresholds[]\` ONLY when a real decision hinges on it — never as a way to classify the day.`,
    `6. Use the EXISTING evidence, and RESOLVE held evidence before declaring gaps: for any order-structure question (price bands, ex-top1 AOV/GMV, top orders, SKU mix), call fabric_replay_retrieve_orders (it reads frozen rows <= T). Update hypothesis status and cite evidence_refs[]. Examine ALL FIVE business-structure dimensions; a dimension is "gap" ONLY when neither present evidence nor a retrieval can answer it — record the UNAVAILABLE resolution.`,
    `7. Stop per the Analysis Target rule: sufficient structure evidence => business judgment (judgment); unresolved structural gap => missing_capability with evidence_gaps + acquisition_need; observe ONLY when all five dimensions were examined and the reading is normal variation.`,
    `8. Emit the Investigation Contract JSON (shape below) WITH \`epistemic_layers\`, \`claim_evidence_refs\`, \`thresholds\`, \`prior_cognition\`, \`business_structure_coverage\`, \`observed_facts\`, \`supporting_evidence_refs\`, \`evidence_gaps\` populated.`,
    ``,
    ANALYSIS_OUTPUT_OBLIGATIONS,
    ``,
    `## Output shape (canonical Investigation Contract + Epistemic Layers, no markdown fences, no prose around it)`,
    `{`,
    `  "situationId": "${run.id}-${businessDate}",`,
    `  "currentUnderstanding": "<简中 — 一段话 — 你对今天业务的当前理解>",`,
    `  "knownEvidence": ["<简中>", "<简中>"],`,
    `  "hypotheses": [{"statement": "<简中>", "status": "proposed|supported|weakened|rejected"}],`,
    `  "unknowns": ["<简中>"],`,
    `  "nextQuestion": "<简中>",`,
    `  "requiredEvidence": ["<简中>"],`,
    `  "investigationRequest": "<简中>",`,
    `  "findings": [{"question": "<简中>", "evidenceRefs": ["<evidenceId>"], "answer": "<简中>", "impactOnHypothesis": "<简中>"}],`,
    `  "judgment": "<简中 — 终局判断>",`,
    `  "stopReason": "judgment|observe|missing_capability|ask_human",`,
    `  "capabilityUsed": null,`,
    `  "evidenceAcquired": ["<简中 — 你读到的证据的简短描述>"],`,
    `  "recommendation": {"kind": "observe|act", "recommendation": "<简中 — 建议做什么>", "rationale": "<简中 — 为什么>", "expectedOutcome": "<简中>", "risks": "<简中>", "prerequisites": ["<简中>"], "humanNeeded": ["<简中>"]},`,
    `  "epistemic_layers": {`,
    `    "observed": [{"statement": "<L1 Observed Fact>", "evidence_refs": ["<ev_id>"]}],`,
    `    "patterns": [{"statement": "<L2 Pattern>", "pattern_type": "candidate|established", "based_on": ["<ref to observed[]>"]}],`,
    `    "hypotheses": [{"statement": "<L3 Hypothesis>", "status": "proposed|supported|weakened|rejected", "supporting_evidence_refs": ["<ev_id>"], "missing_evidence": ["<gap>"], "falsifier": "<observation that would REJECT>"}],`,
    `    "confirmed": [{"statement": "<L4 Confirmed>", "confirmed_evidence_refs": ["<op_intv_id|knowledge_id|ev_id>"], "confirmed_by": "operator|system|historical_evidence", "confirmed_at": "<iso or business_date>"}],`,
    `    "judgment_basis": {"known": ["<L1+L4>"], "inferred": ["<L2+L3>"], "unknown": ["<Evidence Gaps>"], "decision": "<简中>", "confidence_basis": "<简中 — what supports the confidence>"}`,
    `  },`,
    `  "claim_evidence_refs": [{"claim": "<strong claim>", "evidence_refs": ["<ev_id>"], "missing_evidence": ["<gap>"], "claim_type": "numeric|temporal|campaign|operation|consecutive|alternation|stable|baseline|recovery|anomaly|confirmation|reversal|causal|pattern|hypothesis|other"}],`,
    `  "thresholds": [{"statement": "<若 X > N 则 Y>", "provenance": "heuristic|evidence_derived|knowledge_rule|operator_rule|business_policy", "basis_refs": ["<ref>"]}],`,
    `  "prior_cognition": [{"business_date": "YYYY-MM-DD", "kind": "prior_hypothesis|prior_judgment|prior_recommendation", "content": "<T-1 statement>", "status_at_t_minus_1": "proposed|supported|weakened|rejected|unknown", "status_at_t": "proposed|supported|weakened|rejected|unknown", "new_evidence_refs": ["<ev_id>"]}],`,
    `  "observed_facts": ["<L1 fact>"],`,
    `  "supporting_evidence_refs": ["<ev_id>"],`,
    `  "evidence_gaps": ["<unresolved structural fact>"],`,
    `  "business_structure_coverage": [{"dimension": "product|orders|traffic|conversion|operations", "status": "covered|gap|not_applicable", "note": "<structural reading or why unknowable/N-A>", "evidence_refs": ["<ev_id>"], "acquisition_need": "<required when gap: exact fact/data pipeline backlog>"}],`,
    `  "evidence_resolutions": [{"need": "<the evidence need>", "dimension": "product|orders|traffic|conversion|operations", "result": "IN_CONTEXT|RETRIEVED|UNAVAILABLE", "source": "order_replay_retrieval|in_context", "query": "parentOrdersByDay|topContributingOrders|skuLinesByDay|skuGmvContribution|perSkuDailyOrders|", "retrieved_refs": ["<order id / sku id / ev_id used>"], "note": "<when UNAVAILABLE: what was tried and why the held evidence cannot answer>"}],`,
    `  "confirmed_action": null`,
    `}`,
    ``,
    `The recommendation MUST follow from your judgment — not from a single metric. `,
    `If your judgment is "observe" (pseudo-anomaly / insufficient evidence), the `,
    `recommendation should reflect NOT acting. If human verification is required, `,
    `list the needed facts under "humanNeeded". Output \`confirmed_action: null\` `,
    `— data cannot prove action.`,
  ].join('\n');
};

// ── Prior-snapshot loader ───────────────────────────────────────────────

const loadPriorSnapshots = (
  db: Database.Database,
  runId: string,
  upToBusinessDateExclusive: string,
): ReadonlyArray<{
  readonly business_date: string;
  readonly judgment: string;
  readonly recommendation_text: string;
}> => {
  return db
    .prepare(
      `SELECT s.business_date, snap.judgment, snap.recommendation_text
       FROM replay_run_steps s
       JOIN replay_run_cognitive_snapshots snap ON snap.replay_run_step_id = s.id
       WHERE s.replay_run_id = ?
         AND s.business_date < ?
       ORDER BY s.business_date ASC`,
    )
    .all(runId, upToBusinessDateExclusive) as Array<{
    business_date: string;
    judgment: string;
    recommendation_text: string;
  }>;
};

// ── Kernel factory ──────────────────────────────────────────────────────

/**
 * P0013.4 acceptance — how long one Replay cognition turn may take before
 * `collectTurn` gives up.
 *
 * This is a WAIT CEILING ONLY. It changes nothing about what the Agent is
 * asked, what evidence it is given, how the reply is parsed, or which model
 * and provider serve it — a turn that finishes inside the ceiling produces
 * byte-identical input and output either way. It exists because measured turn
 * durations straddle the old fixed value: a 2026-09-21 11-day run completed
 * 2026-09-02 in 526s and then lost 2026-09-03 twice at 603s, so the deadline
 * decided which days produced cognition at all.
 *
 * 600_000 remains the default; raising it is opt-in per environment.
 */
export const DEFAULT_REPLAY_TURN_TIMEOUT_MS = 600_000;

export interface ReplayCognitionKernelOptions {
  /** Open SituationChatClient. Lifetime: the entire Replay run. */
  readonly client: SituationChatClient;
  /** Hermes session id (created once per Replay run, reused across days). */
  readonly sessionId: string;
  /**
   * Turn wait ceiling in milliseconds. Defaults to
   * `DEFAULT_REPLAY_TURN_TIMEOUT_MS` (600s) when omitted, so existing callers
   * keep the previous behaviour exactly.
   */
  readonly turnTimeoutMs?: number;
}

/**
 * Build a Replay cognition kernel that REUSES the production Hermes WS
 * path. Returns a function that matches the runner's `kernel` parameter
 * signature: `(runId, stepId, businessDate) => Promise<KernelStepResult>`.
 *
 * Per-day flow:
 *   1. visibleEvidenceFor(db, runId, T) — SQL < T filter at the boundary.
 *   2. loadPriorSnapshots(db, runId, T) — read-only prior days.
 *   3. buildReplayInvestigationPrompt — emits canonical Investigation Contract.
 *   4. client.submitPrompt + collectTurn (REUSE production turn collector).
 *   5. parseInvestigation (REUSE production contract parser).
 *   6. Map Investigation → KernelStepResult (immutable).
 *
 * Failure modes:
 *   - collectTurn throws → runner catches, marks FAILED.
 *   - parseInvestigation returns ok=false → throw with the contract_invalid
 *     reason; the runner's anti-stub guard catches it.
 *   - visibleEvidenceFor returns [] → still valid; the prompt says
 *     "(no visible evidence yet)".
 */
export const createReplayCognitionKernel = (
  db: Database.Database,
  options: ReplayCognitionKernelOptions,
): ((runId: string, stepId: string, businessDate: string) => Promise<KernelStepResult>) => {
  const { client, sessionId } = options;
  // Wait ceiling only — see DEFAULT_REPLAY_TURN_TIMEOUT_MS. Everything the turn
  // is asked and everything it returns is unaffected by this value.
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_REPLAY_TURN_TIMEOUT_MS;

  return async (
    _runId: string,
    _stepId: string,
    businessDate: string,
  ): Promise<KernelStepResult> => {
    // Load the run state for prompt context. We do NOT mutate the run here.
    const { getReplayRunState } = await import('./replay-runner-p0013.js');
    const run = getReplayRunState(db, _runId);

    // §3 data-boundary — SQL is the gate. The LLM literally only sees these rows.
    const visibleEvidence = visibleEvidenceFor(db, _runId, businessDate);
    const priorSnapshots = loadPriorSnapshots(db, _runId, businessDate);
    // Epistemic Integrity (Phase F, 2026-09-06) — load T-1's prior
    // cognition as a typed list. The prompt renders it under "Prior
    // Cognition (Historical, NOT Current)" so the LLM cannot silently
    // re-cite T-1 hypothesis as T's current fact.
    const priorCognitionRaw = loadPriorCognition(db, _runId, businessDate);
    const priorCognition = priorCognitionRaw.map((p) => {
      // Per-row classification: if the snapshot's judgment is non-empty,
      // it's a prior_judgment; if recommendation_text is non-empty, it's
      // a prior_recommendation; if neither but the prior content is
      // non-empty, it's a prior_hypothesis. status_at_t_minus_1 always
      // starts as 'proposed' (the persisted T-1 epistemic state was
      // always L3 with no further evaluation; the LLM may shift it
      // based on T's new evidence_refs[]).
      const isJudgment = p.judgment && p.judgment.trim().length > 0;
      const isRecommendation = p.recommendation_text && p.recommendation_text.trim().length > 0;
      const kind: 'prior_hypothesis' | 'prior_judgment' | 'prior_recommendation' = isJudgment
        ? 'prior_judgment'
        : isRecommendation
          ? 'prior_recommendation'
          : 'prior_hypothesis';
      return {
        business_date: p.business_date,
        kind,
        content: isJudgment ? p.judgment : isRecommendation ? p.recommendation_text : '',
        status_at_t_minus_1: 'proposed' as const,
      };
    });

    // P0013.3 — operator enrichments visible at T (business_date <= T).
    const enrichments = visibleEnrichmentsAt(db, _runId, businessDate);

    // P0013.5 — the run's Evidence Universe, so "not collected" and "not in
    // my prompt" stop looking identical to the Agent.
    const heldEvidence = heldEvidenceFor(db, _runId, businessDate);

    const prompt = buildReplayInvestigationPrompt({
      run,
      businessDate,
      visibleEvidence,
      priorSnapshots,
      priorCognition,
      enrichments,
      heldEvidence,
    });

    // REUSE the production turn collector. Same WS plumbing, same
    // turn.complete grace window, same error classification.
    // The kernel awaits BOTH the submit AND the collected reply (mirrors
    // the production runInvestigationTurn pattern at
    // platform/server/routes/situation-chat.ts:790-797).
    const replyPromise = collectTurn(client, sessionId, turnTimeoutMs);
    const submitP = client.submitPrompt(sessionId, prompt);
    const reply = await replyPromise;
    await submitP;

    // REUSE the production contract parser.
    const parsed = parseInvestigation(reply, `${run.id}-${businessDate}`);
    if (!parsed.ok) {
      throw new Error(
        `[P0013 replay kernel] parseInvestigation failed at business_date=${businessDate}: ${parsed.error}`,
      );
    }

    // Map Investigation → KernelStepResult (the runner's contract).
    const inv = parsed.investigation;
    const result: KernelStepResult = {
      evidenceObservationIds: visibleEvidence.map((v) => v.id),
      investigation: {
        currentUnderstanding: inv.currentUnderstanding,
        judgment: inv.judgment,
        unknowns: inv.unknowns ?? [],
        evidenceAcquired: (inv.evidenceAcquired ?? []).map((s) => String(s)),
        ...(inv.recommendation
          ? {
              recommendation: {
                kind: inv.recommendation.kind,
                recommendation: inv.recommendation.recommendation,
                ...(inv.recommendation.rationale ? { rationale: inv.recommendation.rationale } : {}),
              },
            }
          : {}),
        // P0013 §10/§14 — Confirmed Action is structurally null during Replay.
        // Set to `undefined` here so the runner's assertReplayProposal can
        // verify the kernel did not synthesize an outcome. The runner
        // records `confirmed_action: null` in the snapshot's raw json
        // via stampEpistemicBoundary, regardless of what the kernel returned.
        confirmedAction: null,
        // Epistemic Integrity (2026-09-06) — pass through the new 4 fields
        // (epistemic_layers, claim_evidence_refs, thresholds, prior_cognition)
        // from the parsed investigation. They are optional; the runner
        // and the snapshot persistence will preserve them as-is.
        ...(inv.epistemic_layers ? { epistemicLayers: inv.epistemic_layers as unknown as Record<string, unknown> } : {}),
        ...(inv.claim_evidence_refs && inv.claim_evidence_refs.length > 0
          ? { claimEvidenceRefs: inv.claim_evidence_refs as unknown as ReadonlyArray<Record<string, unknown>> }
          : {}),
        ...(inv.thresholds && inv.thresholds.length > 0
          ? { thresholds: inv.thresholds as unknown as ReadonlyArray<Record<string, unknown>> }
          : {}),
        ...(inv.prior_cognition && inv.prior_cognition.length > 0
          ? { priorCognition: inv.prior_cognition as unknown as ReadonlyArray<Record<string, unknown>> }
          : {}),
        // P0013.2 shared Analysis Contract — pass the formal obligations
        // through so the runner persists the Agent's real values rather
        // than empty-array placeholders.
        observedFacts: inv.observed_facts ?? [],
        evidenceGaps: inv.evidence_gaps ?? [],
        supportingEvidenceRefs: inv.supporting_evidence_refs ?? [],
        businessStructureCoverage: (inv.business_structure_coverage ?? []) as unknown as ReadonlyArray<
          Record<string, unknown>
        >,
        evidenceResolutions: (inv.evidence_resolutions ?? []) as unknown as ReadonlyArray<
          Record<string, unknown>
        >,
        // P0013.2 — persist the canonical stop reason so observe-vs-gap
        // is auditable from the snapshot, not just the parser moment.
        stopReason: inv.stopReason ?? null,
      },
    };
    return result;
  };
};
