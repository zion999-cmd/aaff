# P0013 — 16-Point Human Operator Acceptance Checklist

> **Date**: 2026-09-04
> **Status**: Phase 8 — formal operator acceptance. This is the
> 16-point checklist the operator personally walks through after
> Claude hands off the dev server. **Claude's report does NOT count
> as acceptance; the operator's hands do.**
>
> **Lineage**: This is the 16-point extension of
> [`p0013-click-path.md`](./p0013-click-path.md) (15 steps), built
> to surface the post-2026-09-03 hardening:
> - B+C atomic fix replaced httpStubKernel with real Hermes cognition
> - G1.5 atomic UPSERT prevents UNIQUE-constraint failure on
>   double-click
> - G1.6 server-side pause button clears orphan RUNNING-step deadlock
> - Anti-stub guards (`assertNoStubLiterals` + empty-content guard)
> - `assertNoFutureLeakage` SQL check at the runner boundary
> - `assertReplayProposal` enforces `confirmedAction === null`
> - Phase 7 monthly review generator at the natural month boundary
>
> **S0002 alignment**: This checklist is the **Business Acceptance
> evidence surface** for P0013. Per `standards/S0002-testing-and-acceptance.md`
> §17 / §20, structural tests (typecheck, contract tests) prove the
> implementation exists; this checklist proves the **Business
> Acceptance**. Both must pass for P0013 to be Closed.

---

## Pre-flight (operator runs first)

```bash
# 0a. Hermes is up (port 9120)
curl -s http://localhost:9120/api/health
# 0b. agentFabric dev server is up (port 3000)
curl -s http://localhost:3000/ -o /dev/null -w "%{http_code}\n"  # 200
# 0c. P0011.x data fixture exists
ls -la data/jd_acquisition_20260903_0834/PROVENANCE_MANIFEST.json
# 0d. Existing run from prior session: this is the one you'll review
sqlite3 data/agentfabric.db "SELECT id, status, current_step, current_business_date FROM replay_runs WHERE source_dataset_path = 'data/jd_acquisition_20260903_0834' ORDER BY created_at DESC LIMIT 1"
```

---

## The 16-Point Checklist

For each point: ☐ = pending, ✓ = operator-confirmed, ✗ = FAIL.

| # | Operator Action | Expected State | What it proves | S0002 § |
|---|---|---|---|---|
| 1 | Open `http://localhost:3000` in **your real Chrome** (not headless) | App shell loads; sidebar shows `历史经营` section with `历史回放` entry | Workspace surface is reachable | §20 / §31 #1 |
| 2 | Click `历史回放` | `#view-replay` panel shows; if a prior run exists (the dev server carries it), timeline is visible. Otherwise the start panel `[开始历史回放]` is visible. | Run state persists across reloads (§24) | §20 / §31 #2 |
| 3 | Click `[开始历史回放]` only if no run exists | A new run is created; controls + 30-cell timeline appear; first cell shows `◀ Current` on 08-04, 29 cells show `○` | Start panel → controls transition; G1.1/G1.2/G1.3 seed evidence correctly | §26 → §27 → §28 |
| 4 | Click **[▶ 下一天]** once | `08-04` cell flips to `●`; `08-05` flips to `◀ Current`; daily view loads 08-04 with the 7-section layout | §7 1-day step; §29 daily view | §31 #3 |
| 5 | In the daily view for `08-04`, find the **"执行状态"** line | Reads the literal `Replay Recommendation — Not Executed` (English, exact) | §14 boundary banner; not paraphrased | §20 |
| 6 | In the daily view, find the **"Evidence (Source references)"** section | Lists at least 2 entries: one `trade.overview`, one `order.overview`. **Read the evidence id numbers** (e.g. `id=969`, `id=999`). | §29 #7 — visible evidence is named, not abstract | §20 / §31 #7 |
| 7 | In a new tab, run the **§23 SQL proof** (below) | 0 future-leak violations; `max(evidence.business_date) <= step.business_date` for every step | §23 — data boundary is SQL-enforced, NOT prompt-enforced | §20 / §20 |
| 8 | Click **any completed cell** in the timeline (e.g. `08-15`) | Daily view reloads for that day with full 7-section layout | §31 #4 — operator can pick any date | §31 #4 |
| 9 | In the `08-15` daily view, count the **evidence references** | Exactly 24 references (12 days × 2 capabilities), all with `business_date <= 2026-08-15` | §3 — temporal filter is the SQL gate | §20 |
| 10 | Click `[查看月度总结]` (visible at `08-31` if reached) | Monthly review panel: header `August 2026 Partial-Coverage Review`, badge `PARTIAL` (NOT `COMPLETE`), `缺失日期` lists `2026-08-01, 2026-08-02, 2026-08-03` | §19 / §21 — PARTIAL is surfaced honestly, not faked | §20 |
| 11 | In the monthly review, find the **"无法验证效果的建议"** section | Every entry carries the literal note `No Action Evidence available; cannot verify execution or outcome.` | §20 — Confirmed Action is structurally null | §20 |
| 12 | Open Chrome DevTools Network tab. Click `[▶ 下一天]` once. Watch the request | `POST /api/replay/runs/:runId/advance` returns `200` with `result.status = 'COMPLETED'` (per step) and a new `state.currentBusinessDate` | Route is real; no httpStubKernel returns literal `[HTTP-driven stub]` | §20 / §20 |
| 13 | In the same DevTools session, find the **WebSocket frames** to `ws://localhost:9120/api/ws` | At least one `submitPrompt` frame per step; reply contains a JSON Investigation Contract (not literal `[HTTP-driven stub]`) | Real Hermes cognition, not stub | §20 |
| 14 | In the daily view for `08-05`, find the **Judgment** text | Real Chinese analysis of GMV / 行业 / 抗跌 (e.g. mentions specific numbers like `+71.8%`, `2.09x → 3.62x`). **Not** `[HTTP-driven stub]` prefix. | Anti-stub guard `assertNoStubLiterals` passes; real LLM output | §20 |
| 15 | F5 (browser refresh) | Replay view reloads; **the same run is still there**; same current step; same current business date. Clicking a completed cell still works. | §24 persistence; §31 #9 page refresh preserves run | §31 #9 |
| 16 | **Manually click 5 different completed days** (e.g. 08-04, 08-10, 08-15, 08-20, 08-25) | Each day shows a **distinct** Judgment, Recommendation, and Unknowns — i.e. no copy-paste, no template fill, no `CONTRACT_INVALID` error | Daily cognition is heterogeneous and grounded in that day's evidence | §20 / §31 #5 / #6 |

---

## §23 SQL Proof (load-bearing — point #7)

Run against `data/agentfabric.db` after the 08-15 step is COMPLETED:

```sql
-- For every step, every evidence ref must have business_date <= step.business_date.
-- The count MUST be 0.
SELECT s.business_date AS step, COUNT(*) AS future_leak_violations
FROM replay_run_evidence_refs r
JOIN replay_run_steps s ON s.id = r.replay_run_step_id
JOIN evidence_observations e ON e.id = r.evidence_observation_id
WHERE s.replay_run_id = (
  SELECT id FROM replay_runs
  WHERE source_dataset_path = 'data/jd_acquisition_20260903_0834'
  ORDER BY created_at DESC LIMIT 1
)
  AND e.business_date > s.business_date
GROUP BY s.business_date;
-- Expected: 0 rows. ANY row = §23 FAIL = P0013 NOT closed.
```

A more strict one-step proof (use after step 08-15 is COMPLETED):

```sql
SELECT
  s.business_date AS step_date,
  MAX(e.business_date) AS max_evidence_date,
  MAX(e.business_date) <= s.business_date AS no_future_leak
FROM replay_run_steps s
JOIN replay_run_evidence_refs r ON r.replay_run_step_id = s.id
JOIN evidence_observations e ON e.id = r.evidence_observation_id
WHERE s.replay_run_id = (
  SELECT id FROM replay_runs
  WHERE source_dataset_path = 'data/jd_acquisition_20260903_0834'
  ORDER BY created_at DESC LIMIT 1
)
  AND s.business_date = '2026-08-15'
GROUP BY s.business_date;
-- Expected: step_date=2026-08-15, max_evidence_date=2026-08-15, no_future_leak=1
```

---

## §6 P0011.x Raw Immutable Proof (point #14 supporting check)

```bash
# File mtimes MUST be unchanged from the original acquisition date (2026-09-03)
stat -f "%Sm %N" data/jd_acquisition_20260903_0834/*.json
# Expected: all mtimes are 2026-09-03 08:xx (or earlier)
# If any file's mtime is later than 2026-09-03 23:59:59, P0013 §6 has FAILED.
```

---

## §32 Production Isolation Proof (supporting check)

```sql
-- Production rows MUST have replay_run_id IS NULL.
SELECT COUNT(*) AS production_untouched
FROM evidence_observations
WHERE replay_run_id IS NULL;
-- Expected: a non-zero number (the agentFabric's pre-P0013 evidence rows).

-- Replay-tagged rows MUST all belong to ONE run (the one being reviewed).
SELECT replay_run_id, COUNT(*) AS rows
FROM evidence_observations
WHERE replay_run_id IS NOT NULL
GROUP BY replay_run_id;
-- Expected: 1 row in the result set (the active run).
```

---

## Pass/Fail Summary

After walking all 16 points:

| Outcome | Action |
|---|---|
| **All 16 = ✓** | P0013 may be Closed (per S0002). Update proposal frontmatter to `Closed`. Update `context/handoff.md` and `context/current_state.md`. |
| **Any = ✗** | P0013 is **NOT** closed. Open a P0013+ follow-up ticket. **Do NOT** modify source code in this session. Reference the failing point number in the ticket. |
| **§23 SQL = violations > 0** | P0013 §23 has FAILED at the data boundary. The Agent was given a future-leak. This is a load-bearing failure; do not close. |
| **Point #10 PARTIAL badge missing** | P0013 §21 has FAILED. The monthly review faked coverage as COMPLETE. |
| **Point #14 finds `[HTTP-driven stub]`** | P0013 §20 has FAILED. The `httpStubKernel` was wired back in. Re-revert. |

---

## Out of scope (do NOT include in P0013 acceptance)

- Whether the Agent's Judgment was "right" for the business at the time.
  That is operator review of cognitive trajectory quality — a separate
  P-ticket.
- Auto-promotion of judgments to Experience / Knowledge. P0013 writes
  only to `replay_*` tables. P0014+ is the follow-up.
- Connector Factory or additional data sources. P0011.x frozen dataset
  is the only source.
