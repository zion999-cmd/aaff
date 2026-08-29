# Quarantine 2026-08-30 — P0010.2.11 poisoned evidence (C2.0 cleanup)

清理由 C2.0 审计确认的污染 Evidence。**隔离而非删除**（本目录），DB 另有整库备份
`agentfabric.db.bak`（清理前快照）。可随时回滚。

## 1. realtime-payload-盖历史-date 类（shop_id=11855009，2026-08-29 14:04–14:08Z 写入）

payload 全部是 2026-08-29 当天 todayRealtime 快照（gmv≈6245.55 / 22 与 27 content_hash
逐字节相同 `5221de49…`），却被盖上调用方传入的历史 business_date。
根因：direct-fetch 路径 `options.date` 只用于 stamping（ADR-073，已由 commit 262dce2 堵死）。

| 原路径 (data/evidence/jd/2026/08/) | business_date (错误) | acquired_at | shop_id |
|---|---|---|---|
| 22_getSummary.json / .meta.json | 2026-08-22 | 2026-08-29T14:08:00Z | 11855009 |
| 22_getTrend.json / .meta.json   | 2026-08-22 | 2026-08-29T14:08:00Z | 11855009 |
| 28_getSummary.json / .meta.json | 2026-08-28 | 2026-08-29T14:04:58Z | 11855009 |
| 28_getTrend.json / .meta.json   | 2026-08-28 | 2026-08-29T14:04:58Z | 11855009 |

派生 DB 行（signals 表，同批写入，一并清理）：

- `jd-daily-2026-08-28-0831ce7d`（6245.55, obs 8/28, ingested 14:04Z）
- `jd-daily-2026-08-27-75201eee`（6245.55, obs 8/27, ingested 14:07Z）
- `jd-daily-2026-08-22-517b2896`（6245.55, obs 8/22, ingested 14:08Z）

## 2. 测试污染类（mock fixture 盖历史 date，2026-08-29 15:38Z 写入）

写入者：`tests/unit/runtime/kernel/executor.test.ts:212` —
`kernel.execute({shopId:'jd_shop_001', date:'2026-08-27', mock:true, capabilities:['daily_summary']})`
在 `npm test` 中通过真实 kernel pipeline 把 P0010.2.10 的 Case-2 fixture
（gmv 6801.02 / orders 125 / uv 928 / cvr 0.1336）写进真实 evidence 目录。

| 原路径 | business_date (错误) | acquired_at | method |
|---|---|---|---|
| 27_getSummary.json / .meta.json | 2026-08-27 | 2026-08-29T15:38:52Z | **mock** |
| 27_getTrend.json / .meta.json   | 2026-08-27 | 2026-08-29T15:38:52Z | mock (空 trend) |

派生 DB 行：`jd-daily-2026-08-27-fab3a57e`（6801.02, obs 8/27, ingested 15:38Z）。
（producer 的 cdp-only 过滤挡住了它的比较语义污染，但假数据不应留在真实 store。）

## 3. 保留（非污染，明确不动）

- `29_getSummary/getTrend`（@2026-08-29T15:39Z, cdp, business_date 8/29 = 采集时北京日 ✓）
- signals `8ab87eb8`（8/28 全天 12805.54，旧 boot 捕获）、`35813c33`（8/29 21:50）、
  `bf200655`（8/29 23:36）— 真实数据
- 4 条 12:45:51Z Situations —— 已确认的窗口错配产物（部分天 vs 全天），
  按用户指示随本次清理一并移除（观察干扰源，非污染 Evidence 本体）

## 4. 遗留（本轮不改代码，仅记录）

- **测试污染向量未堵**：executor.test.ts 仍向真实 `data/evidence/jd` 写 mock evidence
  （P0010.2.10 曾修过 situation-producer.test.ts 的同类问题，executor.test.ts 漏网）。
- **RuntimeLoop UTC date**：loop `startedAt.slice(0,10)` 是 UTC —— 北京 00:00–07:59
  之间 autonomous tick 的 trade.overview 会被 ADR-073 guard 诚实拒绝（date=UTC昨日 ≠ 北京今天）。
  下一刀候选：loop 改用 beijingDate。
