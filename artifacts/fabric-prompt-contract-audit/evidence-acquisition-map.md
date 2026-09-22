# Part D — Evidence acquisition audit

The 11-day Replay experiment surfaced long-running absences (daily UV/PV, daily CVR/funnel, traffic
source, operations, inventory, buyer type, refund state) **and** a working capability that failed
(`parentOrdersByDay`: `Fabric execution failed: fetch failed` → `MCP server 'fabric' is unreachable
after 6 consecutive failures`).

The task is not "add endpoints". It is to separate five different conditions that all currently read as
"missing data".

## D.1 The real chain

```text
Business Question                       (Hermes forms it; contract: P0013.4)
    ↓
Evidence Requirement                    (Hermes states subject/business_time/grain; Fabric validates grain
                                         claims against the declared inventory)
    ↓
Evidence Universe                       (Fabric, from the RUN's frozen rows: heldEvidenceFor(runId, T))
    ↓
Capability discovery / exposure         PRODUCTION: capabilities/INDEX.md  (11 capabilities, maturity icons)
                                        REPLAY:     the Universe block, plus the one permitted tool
    ↓
Resolution                              IN_CONTEXT → RETRIEVED → UNAVAILABLE   (P0013.2 contract)
    ↓
Retrieval                               mcp__fabric__fabric_replay_retrieve_orders
                                          → MCP stdio server (fabric-mcp-server.mjs:358)
                                          → POST ${FABRIC_BASE_URL}/api/replay/runs/:id/orders/retrieve
                                          → routes/replay-orders.ts:64
                                          → loadHistoricalDataset(run.source_dataset_path)   ← disk, not SQLite
                                          → retrieveOrders(rows, T, query)  order-retrieval.ts:56
                                        PRODUCTION: mcp__fabric__fabric_execute_capability → /api/fabric/execute
    ↓
Evidence returned to Hermes             (Replay: compact projection of frozen order rows)
```

Note the two data planes: **SQLite (`evidence_observations`) feeds the prompt**, while **retrieval
re-reads the frozen dataset from disk**. They are not the same source, which is why a row can be
"held but not visible" without being unreachable, and vice versa.

## D.2 Per-domain table

"Existing Capability?" = the status Fabric declares in `capabilities/INDEX.md` (legend read from
`fabric-workspace/projector.ts:176-180`: ✅ `verified` · ⚠️ `captured` · 💰 `premium_required` ·
⬜ anything else). Only **1 of 11** capabilities is `verified`, and only **1** has a dedicated acquire
function (`acquireJdTradeOverviewViaCDP`; there is **no** `acquireJdTrafficOverviewViaCDP`).

| Domain | Existing data? | Granularity | Existing capability? | Exposed to Replay? | Prompt tells Hermes? | Runtime works? | Class |
|---|---|---|---|---|---|---|---|
| **GMV (shop)** | yes | daily (`getTrend`, 12 rows) **and** window (`getSummary`, 1 row) | `trade.overview` ✅ verified | `getTrend` yes; `getSummary` **never visible at T≤09-12** (stamped 09-13) | yes (Universe + retrieval binding) | yes | **B** (the window row) |
| **Industry GMV** | yes | daily (`getTrend` `##industry` series) | `industry.benchmark` ⚠️ captured | yes | yes | yes | fine |
| **Orders** | yes | daily (`perDaySummary`) + per-order lines (`perOrder`) | `order.overview` (not in the INDEX at all — an internal seed kind) | yes | yes | yes (in Fabric-driven runs) | **D** in the manual experiment only (client wiring) |
| **SKU** | yes | per-order lines, per day | via `order.overview` | yes (`skuLinesByDay`, `skuGmvContribution`, `perSkuDailyOrders`) | yes | yes | fine |
| **Traffic (UV/PV)** | **daily: no** · window aggregate: yes (one row, 09-02..09-13) | window only | `traffic.overview` ⚠️ captured; **no acquire fn exists** | listed in the Universe with `0 visible at T` | yes | n/a | **A + B** (never fetched per day; the aggregate is the wrong grain) — and **C** for production acquire |
| **Conversion (CVR / 加购 / funnel)** | same as traffic: window aggregate only | window only | `traffic.overview` / `service.overview` ⚠️ | `0 visible at T` | yes | n/a | **A + B** |
| **Traffic source split** | **no** (no source-dimension capture anywhere) | — | `traffic.overview` ⚠️ | not listed | Universe says "never collected" | n/a | **A** |
| **Operations (campaign/coupon/price/stock-move)** | **no** — `grep -ril promotion\|campaign\|coupon\|活动\|stock\|库存\|marketPlan\|actId` over the whole dataset returns **0 files** | — | `marketing.overview` ⬜ | not listed | Universe says "never collected" | n/a | **A** (+ **C** for production) |
| **Inventory** | **no** | — | `supply_chain.inventory` ⬜ | not listed | same | n/a | **A** (+ **C**) |
| **Refunds / cancel** | **no field in the frozen order rows** (the retrieval tool's own description says so) | — | `service.overview` ⚠️ | not listed | Universe + tool description both say UNAVAILABLE | n/a | **A** |
| **Buyer / customer type** | **no field in the frozen order rows** | — | `customer.overview` ⬜ | not listed | tool description says "cannot answer buyer identity" | n/a | **A** (+ **C**) |
| **Order amount bands / AOV** | yes (derivable from `perOrder`) | per day | via `order.overview` | yes | yes | yes | fine |

## D.3 The five classes, kept separate

### A. DATA ABSENT — never acquired
- traffic source split, operations, inventory, refunds, buyer/customer type.
- **daily** UV/PV/CVR/加购: the raw capture shows this was never even requested per day — both
  `getSummary` calls asked for the whole range `2026-09-02..2026-09-13` and the response was a single
  row (`body.size = 1`); both `getTrend` calls requested only 3 GMV-family indicators.
- Evidence: `data/jd_acquisition_20260914_0231/raw/target_a_trade_raw.json`, `captured_calls[2]` and
  `[5]` (request bodies + responses).

### B. DATA EXISTS BUT WRONG GRAIN
- The `trade.overview/getSummary` row: UV, PV, CVR, 加购 and 11 other KPIs exist as **one window
  aggregate stamped at the range end (2026-09-13)**. It is real, true, and cannot answer any single-day
  question — the case P0013.4's sufficiency rule was built around.
- Consequence inside Replay: because `visibleEvidenceFor` filters `business_date <= T` and the stamp is
  09-13, for a run ending 09-12 the row is **never visible**, only *declared* in the Universe with
  `0 visible at T`.

### C. CAPABILITY EXISTS BUT NOT EXPOSED / NOT IMPLEMENTED
- Fabric's own catalog declares **11** capabilities; the Replay run's world is **2 capabilities / 4 data
  types**. There is no mechanism by which Replay could reach the other nine — correct by design (the
  dataset is frozen), but it means the Agent's "unavailable" and the operator's "we have a capability
  for that" are both true.
- On the production side, `traffic.overview`, `product.overview`, `service.overview`,
  `industry.benchmark` and `trade.detail` are marked ⚠️ `captured` (contract recorded, not verified),
  and `customer.overview`, `marketing.overview`, `supply_chain.inventory`, `trade.reports` are ⬜
  (unverified). Only `trade.overview` is ✅ `verified`, and only it has a dedicated acquire function.
  A capability being *listed* in `capabilities/INDEX.md` does not mean **Hermes can obtain it**.

### D. CAPABILITY EXPOSED BUT BROKEN
- `parentOrdersByDay` failing with `fetch failed` in the manual experiment is a **client wiring**
  failure, not a retrieval bug: the MCP server resolves
  `FABRIC_BASE_URL = process.env.FABRIC_BASE_URL ?? 'http://localhost:3000'`
  (`fabric-mcp-server.mjs:15`) and POSTs to `…/api/replay/runs/:id/orders/retrieve` (`:369`). With no
  Fabric server listening on 3000 the fetch is refused; the catch-all at `:477` renders it as
  `Fabric execution failed: fetch failed`, and Hermes' own breaker
  (`~/.hermes/hermes-agent/tools/mcp_tool.py:6086`) then reports the server unreachable.
- **Reproduction**: run any Hermes turn that calls the replay retrieval tool while no Fabric server
  listens on `FABRIC_BASE_URL`. **Impact**: every replay retrieval fails, so every order-structure
  question degrades to UNAVAILABLE — which then looks like a data gap. **Not fixed** (audit only).

### E. PROMPT / CONTRACT PROBLEM — capability fine, Agent unclear when to call it
- The weakest instance: **the Replay prompt never names the 11 production capabilities**, and it lists
  only the *subjects* of the declared kinds. If a fact is absent from the Universe the Agent is told to
  report it as "never collected" — correct — but there is no path by which it could learn that Fabric can
  obtain it (production) or that it was obtainable per-day at acquisition time. The distinction
  "not collected for this run" vs "not collectable" is not available to the Agent, so both collapse into
  the same gap language. This is a **framing** limitation, not a missing tool.
- Secondary: the `## Evidence Universe` phrasing "0 visible at T" is accurate but easy to read as
  "missing"; the same row is simultaneously *held* and *unusable today*.

## D.4 The single most misleading thing in the current design

`capabilities/INDEX.md` is what Production Hermes reads to decide what Fabric can observe. It lists 11
capabilities with a maturity icon — **and the icon is the only signal that ten of them are not
verified.** For the Agent, "listed in the capability index" is indistinguishable from "I can get this
data". That is a **CAPABILITY_DESCRIPTION** that over-promises, and it is a Fabric-side problem
independent of any dataset.

No fix applied; recorded for a future proposal.
