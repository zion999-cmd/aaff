# Data exposure — why Replay reports daily UV/PV, CVR/加购 and operations as unavailable

Task 4 deliverable. Read-only: no acquisition was re-run and nothing was fixed. Dataset:
`data/jd_acquisition_20260914_0231` (manifest `87613e01…`), window 2026-09-02 → 2026-09-13.

The question: the 2026-09-02 Replay cognition says daily UV/PV is unavailable, daily CVR/加购 is
unavailable, and operations is unavailable. Are those fields in the frozen data, and if so where were
they lost?

**Short answer: they were never acquired. Nothing was lost in the Evidence Store or in prompt
packaging.** But "never acquired" is an *acquisition-shape decision*, not a source limitation — see §4.

---

## 1. Layer-by-layer trace

### Layer 1 — Frozen dataset (what is on disk)

Four canonical files plus 8 raw artefacts:

| file | rows | grain |
|---|---|---|
| `target_a_summary_decoded.json` | **1** | one row for the whole window `2026-09-02..2026-09-13` |
| `target_a_trend_parsed.json` | 12 | one row per business_date |
| `target_b_order_detail_summary.json` | 12 | `per_day[{orders,qty,amt}]` |
| `target_b_order_detail_parsed.json` | per-order lines | one set per business_date |

Which files mention the traffic/conversion indicators at all:

```
grep -l 'browse_page_cnt_shop_last_src' → target_a_summary_decoded.json, raw/target_a_trade_raw.json
grep -l 'fo_jdr_sch_shop_deal_rate'     → target_a_summary_decoded.json, raw/target_a_trade_raw.json
```

So UV/PV/CVR/加购 exist **only** in the single summary payload — never anywhere else.

### Layer 2 — What the raw HTTP calls actually requested and received

The dataset keeps all 8 captured calls in `raw/target_a_trade_raw.json`. Inspecting the two
`getSummary` calls (indices 2 and 5):

```
requested : startDate=2026-09-02  endDate=2026-09-13  interval=DAY  dateType=day
compare   : compareStartDate=2026-08-21 .. compareEndDate=2026-09-01   compareType=hb
response  : body.data is a list of length 1   (body.size = 1)
            body.data[0].jdr_sch_traffic_enter_shop__browse_page_cnt_shop_last_src = 8053
            body.data[0].fo_jdr_sch_shop_deal_rate                                   = 0.0936…
```

**The endpoint returned exactly one row for the whole requested range, with a scalar per indicator** —
even though `interval=DAY` was requested. There is no per-day array to lose.

The two `getTrend` calls (indices 0 and 6) requested **3 indicators, all GMV-family**:
`jdr_sch_trade_deal_ord_ord_amt_…` ×3. Neither the traffic nor the conversion indicator was ever
requested from the trend endpoint. (The trend response does return one row per day — 12 xaxis points —
but only for the series it was asked for, which are GMV and industry GMV.)

### Layer 3 — Evidence Store

`seed-evidence.ts` inserts exactly **4 kinds**, one per canonical file:
`trade.overview/getSummary`, `trade.overview/getTrend`, `order.overview/perDaySummary`,
`order.overview/perOrder`. Nothing is dropped on the way in — there is simply no other traffic payload
to import.

### Layer 4 — Replay prompt

- The getSummary row is stamped `business_date = dataset.window.end = 2026-09-13` (it is an aggregate
  *ending* there).
- `visibleEvidenceFor()` filters `business_date <= T`. For every T in a 09-02→09-12 run,
  `T <= 09-12 < 09-13`, so **that row is never visible**.
- The **Evidence Universe does list it**, with `0 visible at T`:

```
- trade.overview/getSummary — 1 rows, business_date 2026-09-13 — 0 visible at T=2026-09-02 (not available today)
    grain=window_aggregate | subjects=成交金额 GMV | … | 访客数 UV | … | 加购率 cart_uv_rate
    ONE row summarizing the whole requested range (its business_date is the range END); per-day values are NOT present. Cannot answer a single-day question.
```

So the Agent is told, explicitly, that this kind exists, that it is a window aggregate, and that it is
not available today. **Its statement "daily UV/PV unavailable" is therefore correct and well-founded**,
not a packaging failure.

## 2. Answers to the four questions

**1. Are the fields in the original frozen data?**
- UV / PV / CVR / 加购: present **only as one whole-window aggregate** (09-02..09-13), in the summary
  payload. **No per-day values exist anywhere in the dataset.**
- operations (campaigns / coupons / price changes / stock): **absent entirely.**
  `grep -ril` for `promotion|campaign|coupon|优惠券|活动|stock|库存|marketPlan|actId` across the whole
  dataset returns **0 files**.

**2. If present, at which layer were they lost?**
Nothing was lost. Layer 2 shows the source returned one row for a range request; layer 3 imported what
existed; layer 4 faithfully published it as a window aggregate that is out of view at T ≤ 09-12.

**3. Why doesn't the prompt / Evidence Universe expose them to the Agent?**
It does expose *what exists* — the universe names the kind, its declared grain, its subjects (including
`访客数 UV`, `加购率 cart_uv_rate`) and its `0 visible at T` status. What it cannot expose is per-day
values, because there are none. The one nuance worth flagging is a *presentation* one: the universe is
honest but easy to misread — "held but 0 visible" is a different situation from "not collected", and
both currently read as "unavailable" in a casual reading.

**4. Is `getSummary` exposing only a `window_aggregate` at 09-13 an original-data limitation or a replay
packaging problem?**
**Neither, strictly. It is an acquisition-shape decision — and the endpoint can do better:**

- The P0013.1 historical acquisition called `getSummary` **once for the whole 12-day window**
  (`startDate=2026-09-02, endDate=2026-09-13`), so it received one range aggregate. It did *not* loop
  the endpoint per day.
- **A single-day getSummary is an established, working path in this same codebase** —
  `apps/ecommerce/connectors/jd/acquisition/cdp-client.ts:353-358` builds the production body as
  `startDate: "${dateStr} 00:00:00", endDate: "${dateStr} 23:59:59"` with the compare window set to
  yesterday. That is the call shape that yields a single day's UV/PV/CVR.
- The orders side of the same acquisition *did* loop per day — the manifest records
  *"12/12 per-day getDealOrders calls succeeded"* — so per-day cycling was clearly achievable.

Conclusion: **daily UV/PV/CVR were obtainable from the same endpoint and same session, with a per-day
call shape the project already uses in production. The frozen dataset does not contain them because the
historical acquisition chose a single window call for the KPI block.** The replay packaging is not at
fault; it recorded what was fetched, and stamped it at the range end, which is the only honest stamp for
an aggregate.

## 3. Additional exposure gaps found while tracing

Two more payloads are on disk but outside the run's world:

| artefact | size | contains | status |
|---|---|---|---|
| `raw/target_a_brand_parsed.json` (from `getBrandTable.ajax`) | 538 B | brand-level GMV / order qty / unit qty / user count + `##proportion` | **captured but not seeded** — not in the Evidence Store, not in the Universe |
| `raw/target_a_category_parsed.json` (from `getCateTable.ajax`) | 1,026 B | category-level (2 rows) of the same metrics | **captured but not seeded** |

`seed-evidence.ts` references only the 4 canonical files (verified: no `brand` / `cate` match in the
seeder). These are product-structure evidence — exactly what the `product` dimension asks for — and the
Agent has no way to know they exist, because the Universe is generated from the seeded rows. Per the
Universe's own rule ("if it is NOT listed at all, the frozen dataset never acquired it"), the Agent must
report their content as never collected, which is true *of the run* but understates what is on disk.

Note this is a different category from §2: UV/PV/CVR were never fetched; brand/category **were** fetched
and then not imported.

## 4. Not done (per the task)

No collector was changed, no JD data was re-acquired, no Signal/Situation logic was touched, no Replay
architecture was redesigned, and nothing was "fixed". This is a location report only.
