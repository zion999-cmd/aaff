# P0013 — Historical Cognitive Replay: Real-Page Acceptance Click Path

> **Status**: Phase 8 — formal acceptance. The 9 §31 assertions + the
> §23 mid-window SQL proof + the 15-step operator click script below
> are the load-bearing pieces. Claude's report does NOT count as
> acceptance; the operator's hands do.
>
> **Why this doc exists**: P0006.2-era "Replay Runner" never had a
> formal acceptance surface; the goal kept shifting (sometimes
> "demonstrate reproducibility", sometimes "verify the Agent"). P0013
> sets a fixed bar: prove the Agent can sustain a daily
> Understanding / Judgment / Recommendation / Unknowns output under a
> strict historical information boundary, leaving a usable Cognitive
> Trajectory. Clicking through this script, end-to-end, on a real
> browser, is the proof.
>
> **What this does NOT prove**: that the Agent was "right at the time"
> for any business decision. P0013 v1 is a cognitive-trajectory
> generator under information boundary — the operator's review of the
> trajectory's quality is the next P-ticket (out of scope here).

---

## Pre-flight (operator runs these first)

```bash
# 1. Confirm Hermes is up
curl -s http://localhost:9120/api/health | jq .
# Expect: { "status": "ok" } (or similar)

# 2. Start the dev server (uses the real P0011.x data on disk)
cd /Users/bx/Workspace/agentFabric
npm run db:init
npm run dev

# 3. Confirm the server is up
curl -s http://localhost:3000/api/health | jq .
# Expect: { "status": "ok" } (or similar)

# 4. Confirm the P0011.x data fixture exists
ls -la data/jd_acquisition_20260903_0834/PROVENANCE_MANIFEST.json
# Expect: a real file (1450 orders / 12 KPIs / 30-day trend)
```

---

## The 15-Step Click Script

| # | Operator Action | Expected UI State | What it proves |
|---|---|---|---|
| 1 | Open `http://localhost:3000` in Chrome | App shell loads; left sidebar shows sections: 经营 / 经营观察 / 系统 / Advanced | §31 #1 — surface is reachable |
| 2 | Find the **"历史经营"** section in the left sidebar (new in P0013) → click **"历史回放"** | Center panel transitions to `#view-replay`; start panel is visible | §31 #1 — entry point exists |
| 3 | Observe the start panel | Renders: 店铺 `祁门红茶官方旗舰店`; 数据 ✓ 交易概况 / ✓ 订单明细; 数据范围 `2026-08-04 → 2026-09-02`; 数据完整性 `30 天 (完整)`; 步长 每日; one big `[开始历史回放]` button | §26 — start panel surfaces real dataset (§5) |
| 4 | Click **[开始历史回放]** | UI flips: start panel hides, controls + timeline appear | §26 → §27 transition |
| 5 | Observe the timeline | 30 date cells in a row. State: 0 ●, ◀ Current on `08-04`, 29 ○ | §28 — initial state |
| 6 | Click **[▶ 下一天]** | `08-04` cell becomes ●, `08-05` becomes ◀ Current, daily view loads `2026-08-04` | §7 — 1-day step, §29 — daily view |
| 7 | Observe the daily view for `2026-08-04` | 7 sections: 发生了什么 / Agent 当前理解 / Agent 判断 / Agent 建议 / 仍待确认 / 缺少的 Evidence / Evidence (Source references) + a **"执行状态"** banner showing the literal string `Replay Recommendation — Not Executed` | §29 — IA mirrors Situation Detail, §14 — boundary banner |
| 8 | Click **[▶ 连续回放]** | All 30 cells become ● over ~30s (1.5s tick interval × 30 = ~45s) | §27 — auto-advance, §22 — persists COMPLETED |
| 9 | Once the run reaches COMPLETED, click any completed cell (e.g. `08-15`) | Daily view reloads for that day | §31 #4 — operator can pick any date |
| 10 | Open DevTools console; run the §23 SQL proof (below) | All rows for `supporting_evidence_refs` of the `08-20` step have `business_date <= 2026-08-20`. Zero violations. | §23 — data boundary is SQL-enforced, not prompt-enforced |
| 11 | Find `08-31` in the timeline (last August cell) | Cell shows ● (completed) | §22 — completed state |
| 12 | Click `08-31` | Daily view loads `2026-08-31`; the `查看月度总结` button is visible at the bottom of the daily view | §19 — month boundary surfaced |
| 13 | Click **[查看月度总结]** | Monthly review panel opens. Header: `August 2026 Partial-Coverage Review` | §21 — PARTIAL surfaced honestly |
| 14 | Observe the monthly review | Renders 11 sections: 数据覆盖 (with `PARTIAL` badge), 缺失日期, 经营总结, 经营阶段, 关键 Situation, Agent 判断演变, 主要建议, 后续支持 / 后续修正, 持续未知, Evidence Gaps, 无法验证效果的建议. `缺失日期` lists `2026-08-01, 2026-08-02, 2026-08-03`. Every entry under `无法验证效果的建议` carries the note `No Action Evidence available; cannot verify execution or outcome.` | §19, §20, §21 — all 12 fields populated, §20 boundary note present, §21 PARTIAL honest |
| 15 | F5 (refresh the browser) | Replay view reloads, the same run is still there, all 30 cells still ●, clicking any cell still works | §24 — persistence, §31 #9 — page refresh preserves the run |

---

## §23 Mid-Window SQL Proof (Load-Bearing)

Run this against the SQLite database after step 8 (or any time after the
`08-20` step has been completed):

```sql
-- §23 — every Replay evidence reference for the 08-20 step
-- must have business_date <= 2026-08-20. Zero violations.
SELECT id, business_date, evidence_file_path
FROM evidence_observations
WHERE id IN (
  SELECT evidence_observation_id
  FROM replay_run_evidence_refs
  WHERE replay_run_step_id = (
    SELECT id FROM replay_run_steps
    WHERE replay_run_id = (
      SELECT id FROM replay_runs
      WHERE source_dataset_path = 'data/jd_acquisition_20260903_0834'
        AND end_business_date = '2026-09-02'
      ORDER BY created_at DESC
      LIMIT 1
    )
    AND business_date = '2026-08-20'
  )
)
-- Assert: every row's business_date <= '2026-08-20'
ORDER BY business_date;
```

Expected result: every row's `business_date` ≤ `2026-08-20`. If any
row violates this invariant, the Agent was given a future-leak and
P0013 §23 has failed.

To run it:

```bash
# The DB is at data/agentfabric.db (or wherever init wrote it)
sqlite3 data/agentfabric.db < /tmp/p0013-§23-proof.sql
```

---

## Acceptance Gate Summary

The 9 §31 contract assertions are codified in
[`tests/contract/p0013-acceptance.contract.ts`](../../tests/contract/p0013-acceptance.contract.ts).
The contract test runs the SQL proof + production-row-isolation
assertions + the §14 boundary default in code. It is the machine-checked
half of acceptance. The 15-step click script above is the
operator-checked half. **Both must pass for P0013 to be closed.**

If the operator follows the 15-step script and any of the "Expected
UI State" cells does not match reality, P0013 is **NOT** closed. Open
a follow-up ticket and link the failing step number.

---

## What "Reopen" Means

A follow-up P0013+ ticket that:
- References the failing step number from this doc.
- Diagnoses via the `replay_run_cognitive_snapshots` table for
  data-layer issues, or `apps/ecommerce/workspace/views/replay-view.js`
  for UI-layer issues.
- Does NOT silently re-route the operator to a different page.
  Operators must be able to verify P0013 on the surface they
  originally reached.
