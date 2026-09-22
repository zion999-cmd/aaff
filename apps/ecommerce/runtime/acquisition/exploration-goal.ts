// P0013.1 — Exploration goal builder (pure text).
//
// Fabric gives the executing agent a business NEED + an EVIDENCE CONTRACT
// + execution boundaries. It never supplies endpoint names, token names,
// signing machinery, concrete script filenames, or the methods discovered
// in the first acquisition (SC3). The agent chooses HOW; Fabric verifies
// WHAT came back. The forbidden-vocabulary contract test pins this.

import type { HistoricalEvidenceNeed } from '#shared/contracts/historical-evidence-need.js';

export interface ExplorationGoalInput {
  readonly need: HistoricalEvidenceNeed;
  readonly intakeDir: string;
  readonly jobId: string;
}

export const buildExplorationGoal = ({ need, intakeDir, jobId }: ExplorationGoalInput): string => {
  const domains = need.domains.join(' + ');
  return `# Real Historical Business Data Acquisition — ${need.subject.shopName}

You are tasked with acquiring REAL, VERIFIABLE historical business data for the shop **${need.subject.shopName}** (shop id: ${need.subject.shopId}) from **JD 商智 (jdsz.jd.com)**.

## Business need

- Subject: ${need.subject.shopName} (${need.subject.shopId})
- Source: JD 商智
- Requested historical window: **${need.window.start} → ${need.window.end}** (business dates, inclusive)
- Domains required: **${domains}** — (a) trade-level operating metrics (e.g. total money, orders, visitors, conversion, whatever the source exposes for the domain "trade"); (b) full order-level detail (per-row business time, order identifier, product identity, quantity, amount fields, order/payment status) for the domain "orders".

The requested window is a NEED, not a promise about what the source can provide. The source may cover only part of it (for example it may only serve a recent rolling window). Record the **actual window** truthfully. Never relabel a source date to match the requested window, never synthesize missing days, never treat the requested window as satisfied when it is not. Missing/unavailable facts must be reported explicitly as gaps.

## Report what you reused

You are free to inventory this repository, prior acquisition scripts, prior experiment outputs and the capabilities Fabric exposes, and reusing a proven path is a good outcome rather than a failure — but which assets you consult, and in what order, is yours to decide.

Your final report AND result.json MUST explicitly partition everything you used into three lists:
- **reused**: existing assets you used as-is (name each file/tool),
- **rediscovered**: facts/methods that already existed somewhere but you found again yourself,
- **newly built**: assets you had to create.

## How to acquire — your choice

Any path is allowed: existing Fabric capabilities, existing repository code or scripts, browser automation, Python, your own temporary tools — whichever you judge most likely to produce real verified data. Neither path is forced. If you create new helper code, place it **inside the intake directory**; do not modify production application code. If you run an existing script, direct all of its outputs into the intake directory.

### Execution boundaries (hard rules)

- The only browser available is the operator's REAL browser with remote debugging on port **9222**, which is already logged in. Login is a human boundary — if the session is not authenticated, stop and report BLOCKED — ENVIRONMENT.
- Reuse an **existing tab** already open on the business console: inspect the browser's existing pages first and attach to a matching one.
- At most one debugger connection per script invocation, and reuse ONE page object across that whole script. Never loop "open a new tab + navigate" — doing so steals the operator's foreground and invalidates the run.
- Do not launch a separate browser instance.

## What to deliver — the Evidence Contract

Intake directory (write everything here):
${intakeDir}

You must produce ALL of the following. "I found the endpoint" without persisted data is not completion. Partial real data with an honest partial status is valid; pretending partial is complete is not.

### A. Four canonical structured files (exact names)

1. **target_a_summary_decoded.json** — trade operating metrics:
   { "shop_id": "<id>", "all_kpis_readable": { "<metric_key>": { "value": <number>, "compare_pct"?: <number> } } }
2. **target_a_trend_parsed.json** — daily trade series for the actual window:
   { "shop_id": "<id>", "xaxis": ["YYYY-MM-DD", ...], "series": [ { "code": "<series code>", "data": [<number>, ...] } ], "rows": [ { "date": "YYYY-MM-DD", ... } ] }
3. **target_b_order_detail_summary.json** — per-day order aggregates:
   { "shop_id": "<id>", "per_day": [ ["YYYY-MM-DD", { "orders": <int>, "qty": <number>, "amt": <number> }], ... ] }
4. **target_b_order_detail_parsed.json** — flattened order rows, one object per parent order and one per child line:
   ["order_id","shop_id","spu_id","sku_id","sku_name","sale_qty","ord_amt","pre_discount_amt","sku_jd_price","delivery_service_fee","sku_freight_amt","ord_type","channel_code","pay_method_desc","biz_date","sale_ord_tm","pay_tm","row_kind(header|child)"] plus optional "is_same_member", "pay_method_code". Keep parent and child line semantics distinct; do not flatten away source meaning. Preserve source fields rather than forcing a pre-defined schema.

### B. Raw evidence

Place raw source responses, downloads, and page-evidence screenshots under **${intakeDir}/raw/**. Keep source field names in raw artifacts.

### C. result.json — the Historical Evidence Result

{
  "requested_window": { "start": "${need.window.start}", "end": "${need.window.end}" },
  "actual_window": { "start": "YYYY-MM-DD or null", "end": "YYYY-MM-DD or null", "missing_dates": ["YYYY-MM-DD"] },
  "domains": { "trade": { "status": "complete|partial|unavailable", "notes"?: "..." }, "orders": { "status": "complete|partial|unavailable", "notes"?: "..." } },
  "gaps": [ { "range"?: {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}, "date"?: "YYYY-MM-DD", "domain": "trade|orders", "reason": "..." } ],
  "artifacts": { "summary": "<relative path>", "trend": "<relative path>", "order_summary": "<relative path>", "order_rows": "<relative path>", "raw": ["<relative path>"] },
  "provenance": { "source_system": "...", "source_surfaces": ["..."], "acquisition_method": "...", "acquired_at": "ISO-8601" },
  "reconciliation": { "orders_gmv": <number>, "trade_gmv": <number>, "delta": <number>, "matches": <boolean> },
  "stop_reason": "verified_real_data|partial|no_path|blocked",
  "reuse_report": { "reused": ["..."], "rediscovered": ["..."], "newly_built": ["..."] }
}

Reconciliation is mandatory when both domains have data: sum order money from header rows per day and compare it with the trade-domain total money for the same actual window.

### D. candidate.json — Capability Candidate

A description of the method that actually worked, as a candidate for FUTURE reuse (this is NOT self-promotion into a formal capability — no registration is performed):

{
  "id": "hcand_YYYYMMDD_HHMMSS_xxxxxx",
  "satisfies": { "need_category": "historical_evidence", "source": "jd", "domains": ["trade","orders"] },
  "binding": { "source": "jd", "system_identity": "<system this method talks to>" },
  "input_contract": { "<what a future caller must supply>": "..." },
  "output_contract": { "<what the method returns>": "..." },
  "method": "<reusable description of the working method, no secrets>",
  "implementation_assets": [ { "kind": "tool|skill|script|mcp|code|workflow|other", "name": "...", "path": "...", "description"?: "..." } ],
  "dependencies": { "authentication": "...", "browser_session": "...", "environment": ["..."] },
  "verified_against": { "acquisition_job_id": "${jobId}", "evidence_files": ["<relative paths proving it worked>"], "verification_notes": "<counts/totals/page evidence>" },
  "limitations": ["<unsupported or unverified boundaries, e.g. row ceilings, token lifetime, window length limits>"],
  "provenance": { "created_by": "hermes", "created_at": "ISO-8601", "trajectory_path": "${intakeDir}/trajectory/events.ndjson" },
  "status": "pending_review"
}

## Failure semantics (record whichever applies)

- BLOCKED — INFRASTRUCTURE (a known Fabric/Hermes wire defect)
- BLOCKED — ENVIRONMENT (required browser/session/approval unavailable)
- EXPLORATION FAILED (no source/entry found)
- ACQUISITION FAILED (source found but data could not be pulled)
- VERIFICATION FAILED (data obtained but completeness or semantics cannot be proven)

Do not wait on the operator for implementation hints. Do not ask questions. If you find yourself looping on one failing approach, change approach or stop.

## Final message

End with ONE final message containing EITHER a complete record summary (actual window, per-domain status, row counts, reconciliation result, gaps, delivered file list, candidate id) OR an explicit failure classification with the reason. Do not leave the turn open-ended.

Begin.`;
};
