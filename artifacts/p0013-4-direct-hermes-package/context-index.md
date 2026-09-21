# Per-day background data Fabric supplied

Source run: `486e368e-2f99-4f7d-b87e-2e8ce23dc730`

Frozen dataset (data source for every day):

- path: `/Users/bx/Workspace/agentFabric/data/jd_acquisition_20260914_0231`
- manifest hash: `87613e010d44493b2ed58c500ed47dd847c15cbae9136cacd2390d6a71e77fec`
- window: 2026-09-02 → 2026-09-12

**The dataset *manifest file* is NOT sent to Hermes.** Fabric sends only the
path, the manifest hash, the rendered `Current evidence` rows, and the
`Evidence Universe` inventory. Everything else stays on disk unless Hermes
reads it via a tool.

**Situation: NONE.** Historical Replay has no Situation object — no signal,
no anomaly trigger. The task is a daily reading, not an incident response.

**Enrichments: none for this run.** `visibleEnrichmentsAt()` returns 0 rows for
every day, and the prompt renders its empty-state line.

---

## 2026-09-02

- visible evidence rows (SQL `business_date <= 2026-09-02`): **3**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 1 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 1 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 1 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-03

- visible evidence rows (SQL `business_date <= 2026-09-03`): **6**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 2 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 2 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 2 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-04

- visible evidence rows (SQL `business_date <= 2026-09-04`): **9**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |
| 6666 | `trade.overview/getTrend` | 2026-09-04 | 2026-09-04T10 | `target_a_trend_parsed.json` | 5264 | `ef8d3a82f50c` |
| 6678 | `order.overview/perDaySummary` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_summary.json` | 4598 | `c9091583389e` |
| 6690 | `order.overview/perOrder` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_parsed.json` | 802330 | `6a5e9b8e976e` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 3 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 3 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 3 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-05

- visible evidence rows (SQL `business_date <= 2026-09-05`): **12**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |
| 6666 | `trade.overview/getTrend` | 2026-09-04 | 2026-09-04T10 | `target_a_trend_parsed.json` | 5264 | `ef8d3a82f50c` |
| 6678 | `order.overview/perDaySummary` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_summary.json` | 4598 | `c9091583389e` |
| 6690 | `order.overview/perOrder` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_parsed.json` | 802330 | `6a5e9b8e976e` |
| 6667 | `trade.overview/getTrend` | 2026-09-05 | 2026-09-05T10 | `target_a_trend_parsed.json` | 5264 | `dd1f72f8088c` |
| 6679 | `order.overview/perDaySummary` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_summary.json` | 4598 | `87edb6a68583` |
| 6691 | `order.overview/perOrder` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_parsed.json` | 802330 | `a8eb4b29cae7` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 4 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 4 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 4 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-06

- visible evidence rows (SQL `business_date <= 2026-09-06`): **15**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |
| 6666 | `trade.overview/getTrend` | 2026-09-04 | 2026-09-04T10 | `target_a_trend_parsed.json` | 5264 | `ef8d3a82f50c` |
| 6678 | `order.overview/perDaySummary` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_summary.json` | 4598 | `c9091583389e` |
| 6690 | `order.overview/perOrder` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_parsed.json` | 802330 | `6a5e9b8e976e` |
| 6667 | `trade.overview/getTrend` | 2026-09-05 | 2026-09-05T10 | `target_a_trend_parsed.json` | 5264 | `dd1f72f8088c` |
| 6679 | `order.overview/perDaySummary` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_summary.json` | 4598 | `87edb6a68583` |
| 6691 | `order.overview/perOrder` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_parsed.json` | 802330 | `a8eb4b29cae7` |
| 6668 | `trade.overview/getTrend` | 2026-09-06 | 2026-09-06T10 | `target_a_trend_parsed.json` | 5264 | `8f0048c9a5e2` |
| 6680 | `order.overview/perDaySummary` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_summary.json` | 4598 | `f86e60113807` |
| 6692 | `order.overview/perOrder` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_parsed.json` | 802330 | `ed4819fb7f2f` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 5 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 5 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 5 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-07

- visible evidence rows (SQL `business_date <= 2026-09-07`): **18**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |
| 6666 | `trade.overview/getTrend` | 2026-09-04 | 2026-09-04T10 | `target_a_trend_parsed.json` | 5264 | `ef8d3a82f50c` |
| 6678 | `order.overview/perDaySummary` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_summary.json` | 4598 | `c9091583389e` |
| 6690 | `order.overview/perOrder` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_parsed.json` | 802330 | `6a5e9b8e976e` |
| 6667 | `trade.overview/getTrend` | 2026-09-05 | 2026-09-05T10 | `target_a_trend_parsed.json` | 5264 | `dd1f72f8088c` |
| 6679 | `order.overview/perDaySummary` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_summary.json` | 4598 | `87edb6a68583` |
| 6691 | `order.overview/perOrder` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_parsed.json` | 802330 | `a8eb4b29cae7` |
| 6668 | `trade.overview/getTrend` | 2026-09-06 | 2026-09-06T10 | `target_a_trend_parsed.json` | 5264 | `8f0048c9a5e2` |
| 6680 | `order.overview/perDaySummary` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_summary.json` | 4598 | `f86e60113807` |
| 6692 | `order.overview/perOrder` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_parsed.json` | 802330 | `ed4819fb7f2f` |
| 6669 | `trade.overview/getTrend` | 2026-09-07 | 2026-09-07T10 | `target_a_trend_parsed.json` | 5264 | `d3bfb44b227a` |
| 6681 | `order.overview/perDaySummary` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_summary.json` | 4598 | `07256da9d7f3` |
| 6693 | `order.overview/perOrder` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_parsed.json` | 802330 | `8693cafc1bb7` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 6 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 6 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 6 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-08

- visible evidence rows (SQL `business_date <= 2026-09-08`): **21**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |
| 6666 | `trade.overview/getTrend` | 2026-09-04 | 2026-09-04T10 | `target_a_trend_parsed.json` | 5264 | `ef8d3a82f50c` |
| 6678 | `order.overview/perDaySummary` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_summary.json` | 4598 | `c9091583389e` |
| 6690 | `order.overview/perOrder` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_parsed.json` | 802330 | `6a5e9b8e976e` |
| 6667 | `trade.overview/getTrend` | 2026-09-05 | 2026-09-05T10 | `target_a_trend_parsed.json` | 5264 | `dd1f72f8088c` |
| 6679 | `order.overview/perDaySummary` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_summary.json` | 4598 | `87edb6a68583` |
| 6691 | `order.overview/perOrder` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_parsed.json` | 802330 | `a8eb4b29cae7` |
| 6668 | `trade.overview/getTrend` | 2026-09-06 | 2026-09-06T10 | `target_a_trend_parsed.json` | 5264 | `8f0048c9a5e2` |
| 6680 | `order.overview/perDaySummary` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_summary.json` | 4598 | `f86e60113807` |
| 6692 | `order.overview/perOrder` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_parsed.json` | 802330 | `ed4819fb7f2f` |
| 6669 | `trade.overview/getTrend` | 2026-09-07 | 2026-09-07T10 | `target_a_trend_parsed.json` | 5264 | `d3bfb44b227a` |
| 6681 | `order.overview/perDaySummary` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_summary.json` | 4598 | `07256da9d7f3` |
| 6693 | `order.overview/perOrder` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_parsed.json` | 802330 | `8693cafc1bb7` |
| 6670 | `trade.overview/getTrend` | 2026-09-08 | 2026-09-08T10 | `target_a_trend_parsed.json` | 5264 | `b253d98733f6` |
| 6682 | `order.overview/perDaySummary` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_summary.json` | 4598 | `07866de09321` |
| 6694 | `order.overview/perOrder` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_parsed.json` | 802330 | `a619414da0de` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 7 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 7 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 7 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-09

- visible evidence rows (SQL `business_date <= 2026-09-09`): **24**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |
| 6666 | `trade.overview/getTrend` | 2026-09-04 | 2026-09-04T10 | `target_a_trend_parsed.json` | 5264 | `ef8d3a82f50c` |
| 6678 | `order.overview/perDaySummary` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_summary.json` | 4598 | `c9091583389e` |
| 6690 | `order.overview/perOrder` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_parsed.json` | 802330 | `6a5e9b8e976e` |
| 6667 | `trade.overview/getTrend` | 2026-09-05 | 2026-09-05T10 | `target_a_trend_parsed.json` | 5264 | `dd1f72f8088c` |
| 6679 | `order.overview/perDaySummary` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_summary.json` | 4598 | `87edb6a68583` |
| 6691 | `order.overview/perOrder` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_parsed.json` | 802330 | `a8eb4b29cae7` |
| 6668 | `trade.overview/getTrend` | 2026-09-06 | 2026-09-06T10 | `target_a_trend_parsed.json` | 5264 | `8f0048c9a5e2` |
| 6680 | `order.overview/perDaySummary` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_summary.json` | 4598 | `f86e60113807` |
| 6692 | `order.overview/perOrder` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_parsed.json` | 802330 | `ed4819fb7f2f` |
| 6669 | `trade.overview/getTrend` | 2026-09-07 | 2026-09-07T10 | `target_a_trend_parsed.json` | 5264 | `d3bfb44b227a` |
| 6681 | `order.overview/perDaySummary` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_summary.json` | 4598 | `07256da9d7f3` |
| 6693 | `order.overview/perOrder` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_parsed.json` | 802330 | `8693cafc1bb7` |
| 6670 | `trade.overview/getTrend` | 2026-09-08 | 2026-09-08T10 | `target_a_trend_parsed.json` | 5264 | `b253d98733f6` |
| 6682 | `order.overview/perDaySummary` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_summary.json` | 4598 | `07866de09321` |
| 6694 | `order.overview/perOrder` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_parsed.json` | 802330 | `a619414da0de` |
| 6671 | `trade.overview/getTrend` | 2026-09-09 | 2026-09-09T10 | `target_a_trend_parsed.json` | 5264 | `7f09b57f1b06` |
| 6683 | `order.overview/perDaySummary` | 2026-09-09 | 2026-09-09T10 | `target_b_order_detail_summary.json` | 4598 | `f236d40a3249` |
| 6695 | `order.overview/perOrder` | 2026-09-09 | 2026-09-09T10 | `target_b_order_detail_parsed.json` | 802330 | `5e5f344fc8cd` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 8 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 8 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 8 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-10

- visible evidence rows (SQL `business_date <= 2026-09-10`): **27**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |
| 6666 | `trade.overview/getTrend` | 2026-09-04 | 2026-09-04T10 | `target_a_trend_parsed.json` | 5264 | `ef8d3a82f50c` |
| 6678 | `order.overview/perDaySummary` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_summary.json` | 4598 | `c9091583389e` |
| 6690 | `order.overview/perOrder` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_parsed.json` | 802330 | `6a5e9b8e976e` |
| 6667 | `trade.overview/getTrend` | 2026-09-05 | 2026-09-05T10 | `target_a_trend_parsed.json` | 5264 | `dd1f72f8088c` |
| 6679 | `order.overview/perDaySummary` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_summary.json` | 4598 | `87edb6a68583` |
| 6691 | `order.overview/perOrder` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_parsed.json` | 802330 | `a8eb4b29cae7` |
| 6668 | `trade.overview/getTrend` | 2026-09-06 | 2026-09-06T10 | `target_a_trend_parsed.json` | 5264 | `8f0048c9a5e2` |
| 6680 | `order.overview/perDaySummary` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_summary.json` | 4598 | `f86e60113807` |
| 6692 | `order.overview/perOrder` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_parsed.json` | 802330 | `ed4819fb7f2f` |
| 6669 | `trade.overview/getTrend` | 2026-09-07 | 2026-09-07T10 | `target_a_trend_parsed.json` | 5264 | `d3bfb44b227a` |
| 6681 | `order.overview/perDaySummary` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_summary.json` | 4598 | `07256da9d7f3` |
| 6693 | `order.overview/perOrder` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_parsed.json` | 802330 | `8693cafc1bb7` |
| 6670 | `trade.overview/getTrend` | 2026-09-08 | 2026-09-08T10 | `target_a_trend_parsed.json` | 5264 | `b253d98733f6` |
| 6682 | `order.overview/perDaySummary` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_summary.json` | 4598 | `07866de09321` |
| 6694 | `order.overview/perOrder` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_parsed.json` | 802330 | `a619414da0de` |
| 6671 | `trade.overview/getTrend` | 2026-09-09 | 2026-09-09T10 | `target_a_trend_parsed.json` | 5264 | `7f09b57f1b06` |
| 6683 | `order.overview/perDaySummary` | 2026-09-09 | 2026-09-09T10 | `target_b_order_detail_summary.json` | 4598 | `f236d40a3249` |
| 6695 | `order.overview/perOrder` | 2026-09-09 | 2026-09-09T10 | `target_b_order_detail_parsed.json` | 802330 | `5e5f344fc8cd` |
| 6672 | `trade.overview/getTrend` | 2026-09-10 | 2026-09-10T10 | `target_a_trend_parsed.json` | 5264 | `2ff639d6964e` |
| 6684 | `order.overview/perDaySummary` | 2026-09-10 | 2026-09-10T10 | `target_b_order_detail_summary.json` | 4598 | `fb44aa212801` |
| 6696 | `order.overview/perOrder` | 2026-09-10 | 2026-09-10T10 | `target_b_order_detail_parsed.json` | 802330 | `99c70c8cca7c` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 9 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 9 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 9 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-11

- visible evidence rows (SQL `business_date <= 2026-09-11`): **30**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |
| 6666 | `trade.overview/getTrend` | 2026-09-04 | 2026-09-04T10 | `target_a_trend_parsed.json` | 5264 | `ef8d3a82f50c` |
| 6678 | `order.overview/perDaySummary` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_summary.json` | 4598 | `c9091583389e` |
| 6690 | `order.overview/perOrder` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_parsed.json` | 802330 | `6a5e9b8e976e` |
| 6667 | `trade.overview/getTrend` | 2026-09-05 | 2026-09-05T10 | `target_a_trend_parsed.json` | 5264 | `dd1f72f8088c` |
| 6679 | `order.overview/perDaySummary` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_summary.json` | 4598 | `87edb6a68583` |
| 6691 | `order.overview/perOrder` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_parsed.json` | 802330 | `a8eb4b29cae7` |
| 6668 | `trade.overview/getTrend` | 2026-09-06 | 2026-09-06T10 | `target_a_trend_parsed.json` | 5264 | `8f0048c9a5e2` |
| 6680 | `order.overview/perDaySummary` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_summary.json` | 4598 | `f86e60113807` |
| 6692 | `order.overview/perOrder` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_parsed.json` | 802330 | `ed4819fb7f2f` |
| 6669 | `trade.overview/getTrend` | 2026-09-07 | 2026-09-07T10 | `target_a_trend_parsed.json` | 5264 | `d3bfb44b227a` |
| 6681 | `order.overview/perDaySummary` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_summary.json` | 4598 | `07256da9d7f3` |
| 6693 | `order.overview/perOrder` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_parsed.json` | 802330 | `8693cafc1bb7` |
| 6670 | `trade.overview/getTrend` | 2026-09-08 | 2026-09-08T10 | `target_a_trend_parsed.json` | 5264 | `b253d98733f6` |
| 6682 | `order.overview/perDaySummary` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_summary.json` | 4598 | `07866de09321` |
| 6694 | `order.overview/perOrder` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_parsed.json` | 802330 | `a619414da0de` |
| 6671 | `trade.overview/getTrend` | 2026-09-09 | 2026-09-09T10 | `target_a_trend_parsed.json` | 5264 | `7f09b57f1b06` |
| 6683 | `order.overview/perDaySummary` | 2026-09-09 | 2026-09-09T10 | `target_b_order_detail_summary.json` | 4598 | `f236d40a3249` |
| 6695 | `order.overview/perOrder` | 2026-09-09 | 2026-09-09T10 | `target_b_order_detail_parsed.json` | 802330 | `5e5f344fc8cd` |
| 6672 | `trade.overview/getTrend` | 2026-09-10 | 2026-09-10T10 | `target_a_trend_parsed.json` | 5264 | `2ff639d6964e` |
| 6684 | `order.overview/perDaySummary` | 2026-09-10 | 2026-09-10T10 | `target_b_order_detail_summary.json` | 4598 | `fb44aa212801` |
| 6696 | `order.overview/perOrder` | 2026-09-10 | 2026-09-10T10 | `target_b_order_detail_parsed.json` | 802330 | `99c70c8cca7c` |
| 6673 | `trade.overview/getTrend` | 2026-09-11 | 2026-09-11T10 | `target_a_trend_parsed.json` | 5264 | `4dd744b144ef` |
| 6685 | `order.overview/perDaySummary` | 2026-09-11 | 2026-09-11T10 | `target_b_order_detail_summary.json` | 4598 | `2716b25e93ed` |
| 6697 | `order.overview/perOrder` | 2026-09-11 | 2026-09-11T10 | `target_b_order_detail_parsed.json` | 802330 | `f712725c6767` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 10 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 10 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 10 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

## 2026-09-12

- visible evidence rows (SQL `business_date <= 2026-09-12`): **33**
- held kinds: **4**

Visible evidence rows (these ARE rendered inside the prompt by the kernel):

| id | capability/data_type | business_date | bucket | file | bytes | hash12 |
|---|---|---|---|---|---|---|
| 6664 | `trade.overview/getTrend` | 2026-09-02 | 2026-09-02T10 | `target_a_trend_parsed.json` | 5264 | `01ca5b804a29` |
| 6676 | `order.overview/perDaySummary` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_summary.json` | 4598 | `1c17d827b43b` |
| 6688 | `order.overview/perOrder` | 2026-09-02 | 2026-09-02T10 | `target_b_order_detail_parsed.json` | 802330 | `1fe0990e3e21` |
| 6665 | `trade.overview/getTrend` | 2026-09-03 | 2026-09-03T10 | `target_a_trend_parsed.json` | 5264 | `6e6b4f4af8df` |
| 6677 | `order.overview/perDaySummary` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_summary.json` | 4598 | `75ffbd29faca` |
| 6689 | `order.overview/perOrder` | 2026-09-03 | 2026-09-03T10 | `target_b_order_detail_parsed.json` | 802330 | `60ca7b8b9746` |
| 6666 | `trade.overview/getTrend` | 2026-09-04 | 2026-09-04T10 | `target_a_trend_parsed.json` | 5264 | `ef8d3a82f50c` |
| 6678 | `order.overview/perDaySummary` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_summary.json` | 4598 | `c9091583389e` |
| 6690 | `order.overview/perOrder` | 2026-09-04 | 2026-09-04T10 | `target_b_order_detail_parsed.json` | 802330 | `6a5e9b8e976e` |
| 6667 | `trade.overview/getTrend` | 2026-09-05 | 2026-09-05T10 | `target_a_trend_parsed.json` | 5264 | `dd1f72f8088c` |
| 6679 | `order.overview/perDaySummary` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_summary.json` | 4598 | `87edb6a68583` |
| 6691 | `order.overview/perOrder` | 2026-09-05 | 2026-09-05T10 | `target_b_order_detail_parsed.json` | 802330 | `a8eb4b29cae7` |
| 6668 | `trade.overview/getTrend` | 2026-09-06 | 2026-09-06T10 | `target_a_trend_parsed.json` | 5264 | `8f0048c9a5e2` |
| 6680 | `order.overview/perDaySummary` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_summary.json` | 4598 | `f86e60113807` |
| 6692 | `order.overview/perOrder` | 2026-09-06 | 2026-09-06T10 | `target_b_order_detail_parsed.json` | 802330 | `ed4819fb7f2f` |
| 6669 | `trade.overview/getTrend` | 2026-09-07 | 2026-09-07T10 | `target_a_trend_parsed.json` | 5264 | `d3bfb44b227a` |
| 6681 | `order.overview/perDaySummary` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_summary.json` | 4598 | `07256da9d7f3` |
| 6693 | `order.overview/perOrder` | 2026-09-07 | 2026-09-07T10 | `target_b_order_detail_parsed.json` | 802330 | `8693cafc1bb7` |
| 6670 | `trade.overview/getTrend` | 2026-09-08 | 2026-09-08T10 | `target_a_trend_parsed.json` | 5264 | `b253d98733f6` |
| 6682 | `order.overview/perDaySummary` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_summary.json` | 4598 | `07866de09321` |
| 6694 | `order.overview/perOrder` | 2026-09-08 | 2026-09-08T10 | `target_b_order_detail_parsed.json` | 802330 | `a619414da0de` |
| 6671 | `trade.overview/getTrend` | 2026-09-09 | 2026-09-09T10 | `target_a_trend_parsed.json` | 5264 | `7f09b57f1b06` |
| 6683 | `order.overview/perDaySummary` | 2026-09-09 | 2026-09-09T10 | `target_b_order_detail_summary.json` | 4598 | `f236d40a3249` |
| 6695 | `order.overview/perOrder` | 2026-09-09 | 2026-09-09T10 | `target_b_order_detail_parsed.json` | 802330 | `5e5f344fc8cd` |
| 6672 | `trade.overview/getTrend` | 2026-09-10 | 2026-09-10T10 | `target_a_trend_parsed.json` | 5264 | `2ff639d6964e` |
| 6684 | `order.overview/perDaySummary` | 2026-09-10 | 2026-09-10T10 | `target_b_order_detail_summary.json` | 4598 | `fb44aa212801` |
| 6696 | `order.overview/perOrder` | 2026-09-10 | 2026-09-10T10 | `target_b_order_detail_parsed.json` | 802330 | `99c70c8cca7c` |
| 6673 | `trade.overview/getTrend` | 2026-09-11 | 2026-09-11T10 | `target_a_trend_parsed.json` | 5264 | `4dd744b144ef` |
| 6685 | `order.overview/perDaySummary` | 2026-09-11 | 2026-09-11T10 | `target_b_order_detail_summary.json` | 4598 | `2716b25e93ed` |
| 6697 | `order.overview/perOrder` | 2026-09-11 | 2026-09-11T10 | `target_b_order_detail_parsed.json` | 802330 | `f712725c6767` |
| 6674 | `trade.overview/getTrend` | 2026-09-12 | 2026-09-12T10 | `target_a_trend_parsed.json` | 5264 | `83bf476fd9d4` |
| 6686 | `order.overview/perDaySummary` | 2026-09-12 | 2026-09-12T10 | `target_b_order_detail_summary.json` | 4598 | `8ce879a0fd00` |
| 6698 | `order.overview/perOrder` | 2026-09-12 | 2026-09-12T10 | `target_b_order_detail_parsed.json` | 802330 | `7fa9aa876b4b` |

Evidence Universe (held inventory; rendered inside the prompt with each kind's declared temporal grain):

| capability/data_type | rows | business_date span | visible at T |
|---|---|---|---|
| `order.overview/perDaySummary` | 12 | 2026-09-02..2026-09-13 | 11 |
| `order.overview/perOrder` | 12 | 2026-09-02..2026-09-13 | 11 |
| `trade.overview/getSummary` | 1 | 2026-09-13..2026-09-13 | 0 |
| `trade.overview/getTrend` | 12 | 2026-09-02..2026-09-13 | 11 |

- prior-day cognition injected: **0** (package is generated with `--prior=empty`; a real
  multi-day run accumulates one entry per completed prior day — see README)
- enrichments: **0**
- Situation: **NONE**

---

