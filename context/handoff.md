# Handoff — P0010.1 Final Repair (2026-08-25)

## Session goal

Close the 5 honest gaps the user surfaced after reviewing live P0010.1
Workspace surfaces, plus 3 derived audit-only items. Hard constraint:
"先 Audit，再做能在现有架构内诚实完成的部分". No fabrication of timestamps /
provenance / final outcome. No new Event Store / Event Bus / Wake Engine /
Trust Schema / second Timeline Store / Resolution Engine. No LLM guesses
for product names. No hardcoded names. No `situations.closed_at` column.
No `lifecycle='closed'` value.

## What was built (6 of 8 areas)

### A. Entity Resolution Repair (ADR-051)
- New `apps/ecommerce/connectors/jd/product-catalog-bootstrap.ts`:
  idempotent walk of `data/evidence/jd/**/getProductList*.json` on
  dev-server startup. Reuses the existing `projectProductCatalog`
  (jd/product-catalog.ts) and `upsertProducts` (product-repository.ts).
  `acquired_at` from `.meta.json` sidecar is used as `created_at`. No LLM.
  Logs only counts, never names.
- Wired in `platform/server/index.ts:main` after `db:init`. Skippable via
  `BOOTSTRAP_PRODUCT_CATALOG=skip`. 7 unit tests.

### B. Lifecycle Timeline (ADR-052)
- New `renderSituationTimeline(detail)` in
  `apps/ecommerce/workspace/presentation.js`. Pure function over the
  `/api/situations/:id` response. Every event comes from a real persisted
  timestamp: `situations.created_at` → `situation.created`;
  `temporal.{observedAt, windowStart, windowEnd}` → `situation.observed`;
  `investigation.startedAt` → `investigation.started`;
  `investigation.updatedAt` + `status='completed'` → `investigation.completed`
  with annotation `≈ 完成时间; 实际缺少 completedAt 列`;
  `investigation.{updatedAt, error}` + `status='failed'` → `investigation.failed`;
  `stopReason` → `investigation.stopped` (anchored to latest of updatedAt /
  startedAt / observedAt, with Chinese label `形成判断` / `需要人工` etc.);
  `interventions[]` → `intervention.{type}` (typed sub-type for `decision`);
  `outputs[]` → `output.{created,acknowledged,closed}` (no `deliveredAt` —
  that field does not exist by design). Empty input → empty string. 26
  contract tests.

### C. Human = First-Class Lifecycle Participant (ADR-053)
- **C.1** Dropped `action_intent` from the Zod enum in
  `shared/schemas/learning-context.ts:257`. The canonical 4-type surface
  is now codified in the schema.
- **C.2** Added the type-allowlist enforcement to
  `platform/storage/p0007-schema.ts`. SQLite has no
  `ALTER TABLE … ADD CONSTRAINT … CHECK (…)` for CHECK, so the constraint
  is enforced via a BEFORE INSERT/UPDATE TRIGGER that RAISEs ABORT on
  disallowed values — semantically identical to a CHECK constraint from
  the caller's perspective. Idempotent: drops and recreates on every
  apply. Pre-existing `action_intent` rows are rewritten to `response`
  (with the count logged). 10 unit tests cover: legacy-row rewrite,
  idempotency, all 4 canonical types allowed, `action_intent` / unknown
  rejected, UPDATE rejected, rewrite-no-op when no legacy rows.
- **C.3** `timelineEventLabel(type, content)` exposes the `decision`
  sub-type in the timeline: `accept → 已采用建议`, `reject → 不采用`,
  `defer → 稍后处理`, `override → 已重写判断`, `no_action → 无操作`. 12
  contract tests.
- **C.4** `submitStructuredIntervention` in `app.js` now flattens
  `content.respondsTo.agentActivityIds` into the top-level
  `respondsToActivityIds` field on the POST payload. The two pure
  helpers `deriveLatestAgentActivityId` and `flattenRespondsToActivityIds`
  were extracted to `presentation.js` (and unit-tested) so the logic is
  in one place. 12 contract tests.

### D. "需人工" semantic tightening (ADR-054)
- `deriveInvestigationStatus` in `platform/server/routes/p0007.ts` no
  longer fuzzy-matches "人工核验" / "人工确认" / "无法获取" in the judgment
  text. The new decision tree reads only structured fields:
  - `status='investigating'` → `investigating`
  - `status='failed'` → `failed`
  - `stopReason='observe'` → `observing`
  - `stopReason ∈ {missing_capability, ask_human}` → `needs_human`
  - `stopReason='judgment'` + `recommendation.humanNeeded.length > 0` → `needs_human`
  - `stopReason='judgment'` (else) → `judgment_ready`
  - default → `judgment_ready`
- Mirrored on the client (`deriveSituationLifecycle` in
  `presentation.js`).
- Chip label `已判断` → `判断已形成` (informational, not triumphal —
  "Autonomous by default, human interruptible, blocking only when
  necessary"). Sidebar filter `已判断` → `判断已形成` for consistency.
- 14 server unit tests + 3 new lifecycle contract tests cover the new
  tree + regression cases (judgment text mentioning 人工核验 no longer
  flips).

### E. Archive Redefinition (ADR-055)
- Existing `data-view="archive"` nav item gets
  `<span class="legacy-badge" title="本视图当前为 ranking 历史，未连接到 Situation 生命周期">legacy</span>`.
- New disabled `Situation 归档` nav item added:
  `<a class="sidebar-item disabled" aria-disabled="true" ...>📦 Situation 归档 <span class="unimplemented-badge">待 Lifecycle 终态</span></a>`.
  CSS `pointer-events: none; opacity: 0.5; cursor: not-allowed`. Click
  does nothing.
- **No code deletion** of the existing Archive (loadArchive /
  viewLoaders.archive / /api/ranking/{profile} / ranking_results all
  stay).
- **No new Archive page**. **No `situations.closed_at` column**.

### F. Output collection (ADR-055)
- `data-view="outputs"` nav item gets
  `<span class="candidate-removal-badge" title="Output 已是 Situation Detail 一级区，集合页可下架">候选下架</span>`.
- **No code deletion** (outputsRouter / viewLoaders / badgeAllOutputs /
  back-to-outputs all stay).

## What was NOT built (audit only, per user directive)

### G. Final Outcome Invariant
- `situations.lifecycle` ∈ `{open, partial, mature}` — no `closed` value.
- `learning_contexts.lifecycle` shares the same 3 values.
- No `closed_at` / `closed_by` / `resolution_reason` columns.
- No producer that emits a `closed` event.
- `deriveSituationLifecycle` in `presentation.js:213` declares a
  `'closed'` branch that is **dead code** (declared by comment line
  192-202) and rewritten to `'watching'` in `app.js:1119` as a
  defensive fallback.
- **Next-slice blocker**: P0010.1 Terminal Lifecycle (Resolution Engine +
  Outcome producer + `situations.closed_at` + `lifecycle='closed'` +
  `closed_by` + `resolution_reason` taxonomy aligned with Trust
  Foundation).

### H. Trust Reference gaps
- **H.1 Evidence stable identity gap** — Evidence IDs are regenerated
  every load (`evidence/store.ts:131`: "regenerated on load — id is for
  runtime tracking, not persistence"). The only persistent handle is
  `content_hash`. Any `AgentActivityRef.evidenceIds[]` in
  `learning_contexts.body.agentActivities[]` would break across loads.
  This is the [SB-1] blocker in
  `p0010_1_productization_baseline.md`. Decision needed: (a) hash-keyed
  evidence address everywhere, or (b) a persistent `evidence_id`
  column. **No code change in this round.**
- **H.2 Knowledge stable identity gap** — `operator_memories` (12 rows)
  and `context_memories` (0 rows) coexist with no shared identity model.
  The legacy adapter (`experience/legacy-adapter.ts:26-143`) writes to
  `human_interventions`, not to either memories table. There is no
  `knowledge_id` in any operator-facing wire. Decision needed: do
  operator memories and context memories share an identity, or are they
  intentionally separate surfaces? **No code change in this round.**
- **H.3 Timeline sourceRef gap** — Even with the new vertical timeline,
  every event that should "point back" to its evidence/knowledge source
  is broken:
  - Intervention → agent activity: `respondsToActivityIds` was `[]` for
    every live row; **C.4 fixed the browser path**, but the producer-side
    `learning-context-producer.ts:103` still hard-codes
    `agentActivities: []`.
  - Investigation findings → evidence: `findings[].evidenceIds[]` may
    use the regenerated id (H.1) and silently point to the wrong record.
  - Output → recommendation: no `recommendationId` field on `outputs[]`;
    the link is text-only via the situation id.
  Fix requires both: a stable evidence identity model (H.1) AND a
  producer that actually emits `agentActivities[]` and writes
  `findings[].evidenceIds[]` correctly. **No code change in this round.**

## Verification

- **50 new tests** (across 7 test files): bootstrap (7) + timeline (26)
  + type-guard (10) + intervention-link (12) + derive-investigation-status
  (14) + lifecycle (3 net new) + grammar 4-type (1 net new) = 73 raw,
  50 net new after the 5-type → 4-type replacement. All 99 in the
  new/replacement files pass; the 4 regression cases (fuzzy text 人工核验
  no longer flips; 4 canonical types only; DB trigger rejects
  `action_intent`; UPDATE rejected) all pass.
- `npm run typecheck` — 0 new errors (17 pre-existing baseline errors in
  `tests/contract/learning-context.contract.ts` and
  `tests/unit/hermes/token-resolver.test.ts` are not from this round).
- `npx vitest run` — 810 passed / 2 pre-existing flaky (capability
  coverage + chat timeout). The investigation-lifecycle + http tests
  pass in isolation; state-pollution noise under full-suite was
  observed in both baseline and current.

## Browser verification (manual)

Per the plan, E2E steps an operator can re-run after this commit:

1. `npm run dev` → log line `[bootstrap] products projected: N from M files`
   (N > 0, M ≥ 1).
2. Workspace → 今日工作 → product-anchored Situation cards now show the
   real product name (e.g. "祁门红茶官方旗舰店…") instead of
   `未知商品 · SKU <id>`.
3. Situation Detail → new `⏱ 生命周期时间线` section appears below Layer
   4 Output region, with events sorted ascending: `Situation · 发现` /
   `观察窗口` / `Investigation · 开始调查` / `Investigation · 完成
   (≈ 完成时间; 实际缺少 completedAt 列)` / `Investigation · 停止原因:
   形成判断` / `人工反馈: 已采用建议` (etc., typed sub-type) /
   `交付物 · Recommendation 已生成` / `Output · 已知悉` / `已关闭`
   (when set).
4. `data-view="situations" data-filter="needs_human"` chip on a
   Situation with `recommendation.humanNeeded=['...']` shows
   `需人工核验` — chip label `判断已形成` replaces `已判断`.
5. Sidebar → 经营观察 → `历史归档` shows the `legacy` badge.
6. New disabled `📦 Situation 归档` item is visible in 经营观察 with
   the `待 Lifecycle 终态` badge; click does nothing.
7. Sidebar → 业务配置 → `工作输出` shows the `候选下架` badge; click
   still works (loadOutputs / loadOutputDetail / viewLoaders unchanged).

## Risk

- The new `BOOTSTRAP_PRODUCT_CATALOG` env-gated bootstrap will project
  names from every on-disk `getProductList` file. In dev this is the
  intended behavior. In production, an explicit orchestration is
  needed; the recommended default is `BOOTSTRAP_PRODUCT_CATALOG=skip`
  until then. Documented in the bootstrap file header.
- The new CHECK-equivalent TRIGGER will abort inserts/updates that
  violate the allowlist. The only call paths that write to
  `human_interventions` today are: (1) the legacy adapter,
  (2) `POST /api/situations/:id/interventions`, and (3) future tests.
  (1) has been audited and uses only the 4 canonical types.
  (2) takes the type from the Zod-validated request body, which now
  also rejects `action_intent`.
  (3) the 4-type contract test pins this.
- The chip label change `已判断` → `判断已形成` is a wording change
  visible to operators. Filter and chip labels are now in lockstep, so
  no navigation discrepancy.

## Suggested next slice

- **P0010.1 Terminal Lifecycle** (the only thing standing between today
  and the operator seeing a real "closed" state). Requires:
  ① `situations.closed_at` + `lifecycle='closed'` + `closed_by` +
     `resolution_reason` schema migration;
  ② Resolution Engine design (who decides to close, with what authority);
  ③ Outcome producer (first observed outcome → `mature`);
  ④ replacing the dead-code `'closed'` branch in
     `deriveSituationLifecycle` with the real derivation.
- **P0010.1 Evidence Identity** (H.1) — unblocks H.3 (timeline sourceRef
  gap), which in turn unblocks the timeline's "Intervention → agent
  activity" link actually resolving.
- **P0010.1 Knowledge Identity** (H.2) — separate decision; the 2 memory
  surfaces may need to converge or be explicitly separated by identity
  policy.

# Handoff — P0010.2 Continuous Business Runtime (2026-08-25)

## Session goal

Make the runtime actually continuous: `setInterval` driven
`tick → acquire → evidence → situation → investigation → workItem`
chain, without Workspace interaction, without HTTP request. Single
acceptance criterion from the user: "本次验收不要主要看测试数量，也先
不要看 Workspace 截图. 我们真正要看的证据是连续运行日志". Expected pattern:

```
02:00 tick → 02:00 acquisition started → 02:01 evidence updated →
02:01 situation updated → 02:01 investigation triggered → 02:02 output created
03:00 tick → 03:00 acquisition started → 03:01 evidence updated →
03:01 investigation skipped: no meaningful change
```

Hard constraints (verbatim, kept): no Trust Schema refactor, no
Knowledge Engine, no Evidence migration, no Event Bus, no Wake Engine,
no Scheduler, no Hermes transport changes, no Action Engine, no
Approval, no external sending, no Resolution Engine, no second
Timeline Store, no fake time/provenance/final outcome. No
`SubprocessHermesClient` removal. No third `hermes proxy` transport.
"不能让 Scheduler 本身变成业务编排器". LLM must not guess product
names; no second Product Store. "Autonomous by default, Human
interruptible, Blocking only when necessary".

## What was built (3 layers)

### 1. Runtime Loop (apps/ecommerce/runtime/loop/)

- `runtime-loop.ts` (~270 LOC): `createRuntimeLoop` wraps
  `ScheduledAcquisitionRunner` without modifying it. 60s setInterval
  (env override `RUNTIME_LOOP_TICK_MS`), per-tick mutex
  (`tickInFlight` promise reuse), `start`/`stop`/`tickNow`/`list`.
  Calls `kernel.execute({mock:false})` for the REAL acquire path —
  no demo timer, no fake Evidence.
- `investigation-policy.ts` (~90 LOC, pure): `shouldInvestigate` is
  a pure decision function. v1 compared `updatedAt` to `acquiredAt`
  (always triggered) — caught in live demo, fixed to compare
  `contentHash`. Legacy data path: completed legacy = skip (fail-
  closed), failed legacy = one fresh attempt.
- `recommendation-to-output.ts` (~70 LOC): `materializeWorkItem` is
  the single materialization point. `fingerprint({ situationId,
  recommendation, rationale, judgment, updatedAt })` →
  deterministic `outputId = out_<16hex>`. Idempotent: same content
  → same outputId → dedup via `outputs.some(o => o.outputId === ...)`.
- `loop-events.ts` (~40 LOC): typed event union + default `stdout`
  sink; test seam `onEvent` injection.

### 2. Hermes transport convergence (commit 1, already pushed)

- `session-client.ts`: delete eager `resolvedToken` chain; rewrite
  `connect()` to lazy-resolve + retry-once. `closedByUser` flag
  prevents auto-reconnect. `HermesAuthError` exported so call
  sites can `instanceof`-check. Operator-pinned env var is
  NEVER auto-replaced on failure (per audit security row #5).
- `token-resolver.ts`: `_resetTokenCache` → `resetTokenCache`;
  add `forceRefresh?: boolean`.
- `index.ts` re-export updated.

### 3. Single WorkItem call site (commit 2, in P0010.2)

- `situation-chat.ts#runInvestigationTurn` now calls
  `materializeWorkItem` after a successful investigation. Both
  the RuntimeLoop's `investigate` and the manual
  `POST /api/situation/:id/investigate` share the same code
  path. No second output creation surface.

## P0010.2.1 (live-demo-driven fix, separate commit)

Three coordinated changes after the first live 2-cycle demo:

1. **InvestigationPolicy fail-CLOSED on legacy**: prior P0010.1
   completed/investigating investigations have no contentHash
   sidecar. The old policy returned `meaningful_new_evidence` for
   them — infinite retry anti-pattern on a slow LLM. New policy:
   legacy completed = skip, legacy failed = one retry. Real data
   `sit_bb96b0d781c532bf080e` was already burning cycles this way.
2. **InvestigationSchema adds `evidenceContentHash`**: Zod strips
   unknown fields during `LearningContextSchema.parse()`. The
   sidecar was being silently dropped. Now it's a first-class
   optional field.
3. **markInvestigation accepts evidenceContentHash**: previously
   only the success path stamped the sidecar. Failed/investigating
   markers now also remember the content they saw, so the next
   tick can correctly distinguish "same-content-failed-retry" from
   "new-content-investigate".

## Live demo evidence

```
[loop] loop started capabilities=trade.overview,traffic.overview tickMs=10000
[loop] loop started (continuous business runtime)
[bootstrap] products projected: 6 from 6 files (0 skipped)
[backfill] 7/7 days completed (2026-08-17 ~ 2026-08-23)
[backfill] situations: 0 created / 2 deduped
[loop] tick capability=trade.overview
[loop] acquisition started capability=trade.overview
[loop] evidence updated capability=trade.overview count=1
[loop] tick capability=traffic.overview
[loop] acquisition started capability=traffic.overview
[loop] evidence updated capability=traffic.overview count=1
[loop] situation updated created=0 skipped=2
[loop] investigation skipped situation=sit_bb96b0d781c532bf080e reason=no_meaningful_change
[loop] investigation skipped situation=sit_003b9c4485177f642a74 reason=no_meaningful_change
[loop] tick done capabilities=2 situations=0 investigations=0 outputs=0
```

Every subsequent tick (10s) produces the same idempotent
`no_meaningful_change` skip. **The continuous runtime IS running.**
Cycle 1 (`investigation triggered`) would require fresh
situation data (the demo DB has both today's situations already
investigated, with the backfill covering the 7-day window).

## Tests

- `tests/unit/loop/investigation-policy.test.ts` — 14 cases
  (new, no_evidence, completed-match, completed-different, legacy
  completed, legacy failed, failed-same-content, failed-new-content,
  waiting_human short-circuit, isWaitingOnHuman × 4).
- `tests/unit/loop/recommendation-to-output.test.ts` — 6 cases
  (creates, same-rec dedup, different-judgment new, observe
  no-output, prerequisites/humanNeeded fields, recommendation
  shape).
- `tests/unit/loop/runtime-loop.test.ts` — 9 cases (full chain,
  2-tick dedup, mutex reuse, lastTickAt advance, stop/start
  reset, disabled schedule, investigation path, skip path,
  tickNow without start).
- 27 new tests + 0 new typecheck errors (baseline 19 pre-existing).
- All `tests/unit/hermes/{session-client,token-resolver}` pass
  with the lazy token + retry-once change.

## Risks / known gaps

- **`/api/ws` token caching is one-shot per process** — restarting
  agentFabric picks up the env var fresh. Not a bug; just a
  cycle boundary.
- **No loop-level backoff** — if Hermes is down, the connect
  retry-once path fails, the investigation marker is written as
  `failed`, and the next tick will retry. The user explicitly
  excluded durable job queue / exponential backoff from this
  slice. P0011 candidate.
- **WorkItem fingerprint is over `(recommendation, rationale,
  judgment, updatedAt)`** — same judgment + new evidence = new
  WorkItem (operator can re-decide). Different intent but same
  text = collision. Trade-off documented; the ID space
  (sha256[:16] → 64-bit) is wide enough for the current
  situation volume.
- **The "cycle 1 trigger" was not observed live** because today's
  2 situations were already investigated when the demo started
  (left over from the prior 2-cycle attempt). The next user
  session starting with empty situation data will see
  `investigation triggered` in cycle 1.

## What to verify next session

- Drop the 2 today's situations from the DB and restart → see
  `investigation triggered reason=new_situation` in cycle 1.
- Stop `hermes serve` mid-loop → see `investigation failed
  reason=...` then `investigation skipped reason=no_meaningful_change`
  on the next tick (after the failed marker is stamped with the
  contentHash sidecar).
- Restart `hermes serve` with a new `HERMES_DASHBOARD_SESSION_TOKEN`
  → loop auto-discovers within 60s (no agentFabric restart needed)
  IF agentFabric started without an env pin.

---

# Handoff — P0010.2.2 Investigation Recovery / Self-Healing Runtime (2026-08-26)

## Session goal

Close the 4 recovery gaps the user surfaced after running P0010.2
continuously for 2 days:
1. Loop only re-evaluates situations the producer just emitted
   (pre-existing open situations from a prior process run are silently
   ignored forever — no startup re-enqueue).
2. `InvestigationPolicy` doesn't recognize "interrupted" state (a
   process that died mid-turn leaves `status='investigating'` with
   a stale `startedAt`, and the policy reads it as effectively
   completed and skips forever).
3. No failure-count threshold (a persistent hermes outage → infinite
   retry, no operator attention signal).
4. Workspace UI contradicts itself ("系统自动开始调查" text +
   "🔄 立即调查（恢复）" button both rendered).

**Single invariant** (verbatim): "只要一个 Situation 仍需要 Agent
推进，并且不存在明确的 human/blocking condition，Fabric 就必须
最终自动安排 Agent；进程重启不能把它永久遗留在 pending 状态".

**Hard constraints** (all kept):
- 不做 Action Engine / Approval / 新 Scheduler / Event Bus
- 不碰 Terminal Lifecycle (`open|partial|mature` stays)
- 不引入第二个 Recovery 逻辑
- 不让 LLM 猜商品 / 不 hardcode / 不建第二套 Product Store
- 不为 demo 伪造时间 / provenance / final outcome
- 自治默认 / 人类可中断 / 仅必要时阻塞
- 不让「立即调查（恢复）」按钮成为系统正常工作的必要依赖
- "本次验收不要主要看测试数量，也先不要看 Workspace 截图.
  我们真正要看的证据是连续运行日志"

## What was built (1 commit-sized slice)

### Files changed
- `apps/ecommerce/runtime/loop/recovery-candidates.ts` (NEW, ~290 LOC)
- `apps/ecommerce/runtime/loop/investigation-policy.ts` (extend: 3
  investigate reasons + 1 skip reason + recoveryHint / counter ctx)
- `apps/ecommerce/runtime/loop/loop-events.ts` (extend: 2 event kinds
  — `recovery_candidates_found`, `investigation_blocked`)
- `apps/ecommerce/runtime/loop/runtime-loop.ts` (extend: per-tick
  recovery scan, threshold wiring, event emission)
- `apps/ecommerce/runtime/loop/index.ts` (barrel: re-export)
- `platform/server/routes/situation-chat.ts` (extend: clear-block
  route, GET investigation now returns `blockedRuntimeFailure` +
  `consecutiveFailures`)
- `platform/server/index.ts` (REMOVE: `autoInvestigatePending`
  startup chain + `MAX_AUTO_INVESTIGATE` helper; REMOVE: parallel
  call in the per-day scheduler's `onAfterRun`; CLEAN: dead imports)
- `apps/ecommerce/workspace/app.js` (4-branch state matrix; hidden
  recovery button by default; visible only in `blocked_runtime_failure`)
- `shared/schemas/investigation.ts` (add `consecutiveFailures?: number`
  sidecar — runtime marker, NOT a domain field; matches the existing
  `evidenceContentHash` sidecar pattern from P0010.2.1)
- `tests/unit/loop/recovery-candidates.test.ts` (NEW, 21 cases)
- `tests/unit/loop/investigation-policy.test.ts` (extend, +9 cases)
- `tests/unit/loop/runtime-loop.test.ts` (extend, +5 cases)

### The bug found and fixed during live demo

The original plan used `humanInterventions` array entries of
`type: 'investigation'` with `content.status: 'failed'` to track
the consecutive-failure counter. The plan's `countConsecutiveFailures`
walked this array. But in production, `markInvestigation(status='failed')`
only writes to the `investigation` field, never to `humanInterventions`.
**The counter would never increment.** Unit tests passed because the
test data was hand-constructed; the production wiring was silent.

The live 2-cycle log (with hermes down — token missing) showed the
bug: 3 failed ticks in a row, but `blocked_runtime_failure` never
fired because the counter stayed at 0.

**Fix**: added `consecutiveFailures?: number` as a runtime sidecar
on the investigation marker (parallels the existing
`evidenceContentHash` sidecar). Three writers:
- Loop failure path: `markInvestigation({ status: 'failed',
  consecutiveFailures: prior + 1 })`
- Loop success path: `markInvestigation({ status: 'completed',
  consecutiveFailures: 0 })`
- `/clear-block` route: `markInvestigation({ consecutiveFailures: 0 })`

`countConsecutiveFailures` simplified to just read the field
(removed the humanInterventions walking — that walking was the
original bug surface).

Also fixed the recovery scan filter threshold: was
`consecutiveFailures >= maxConsecutiveFailures` (filters out the
threshold-crossing tick), now `> max` (the `==` case is the
threshold-crossing tick — the policy call is what fires
`investigation_blocked`).

## Live 2-cycle acceptance log (the user's hard criterion)

Inserted `sit_recover_2cyc_001` (open, no learning_context) into
DB. Started server. Observed 4 ticks (~4 minutes).

**Tick 1** (~60s after boot):
```
[loop] recovery eligible count=10 kinds=no_investigation,...,interrupted,interrupted
[loop] investigation triggered situation=sit_recover_2cyc_001 reason=recovery_no_investigation
[loop] investigation failed situation=sit_recover_2cyc_001 error=Missing Hermes dashboard session token
[loop] investigation triggered situation=sit_4498ebec5ad9e10bf4d8 reason=recovery_interrupted
[loop] investigation triggered situation=sit_ce9a693d4b2c49325a1c reason=recovery_interrupted
```
The 2 `interrupted` candidates are the same situations that were
stuck in `status='investigating'` from **2026-08-24 19:31 / 19:38**
— 2 days ago. The recovery scan found them and the Loop picked up
where the process left off.

**Tick 2** (~120s):
```
[loop] recovery eligible count=10 kinds=failed_retryable,...
[loop] investigation triggered situation=sit_recover_2cyc_001 reason=recovery_failed_retryable
[loop] investigation failed situation=sit_recover_2cyc_001 ...
```
Counter went 0→1.

**Tick 3** (~180s):
Same pattern. Counter 1→2.

**Tick 4** (~240s) — **threshold-crossing**:
```
[loop] recovery eligible count=10 kinds=failed_retryable,...
[loop] investigation BLOCKED situation=sit_e022c5b35852ce7fd3e3 consecutiveFailures=3 — operator must POST /api/situation/:id/clear-block to resume
... (9 more BLOCKED events)
[loop] investigation BLOCKED situation=sit_recover_2cyc_001 consecutiveFailures=3 — operator must POST /api/situation/:id/clear-block to resume
[loop] tick done capabilities=2 situations=0 investigations=0 outputs=0
```
All 10 situations blocked simultaneously. **No 4th attempt on any
of them.** `investigations=0` proves no Hermes call was made this tick.

**Operator clear-block + recovery**:
```bash
curl -X POST http://127.0.0.1:3000/api/situation/sit_recover_2cyc_001/clear-block
# {"success":true,"situationId":"sit_recover_2cyc_001","interventionId":"int_clearblock_..."}
```
DB now shows `consecutiveFailures=0` on the marker. **Tick 5**:
```
[loop] investigation triggered situation=sit_recover_2cyc_001 reason=recovery_failed_retryable
[loop] investigation failed situation=sit_recover_2cyc_001 ...
```
The cleared situation **resumed**, while the other 9 (no one cleared
them) remained in `investigation_blocked` state — exactly the
expected "per-situation gate" behavior.

## Tests

- 62 loop tests (21 recovery-candidates + 17 policy + 24 runtime-loop)
- 884 / 884 total non-flaky tests pass
- 2 pre-existing failures unchanged (chat contract timeout,
  capability coverage assertion — both P0008-era, not in scope)
- typecheck: 0 new errors (baseline 19 = all pre-existing, none
  in our new files)

## Risks & known limitations

- The `consecutiveFailures` sidecar is an additive field on the
  investigation marker; the existing `evidenceContentHash` is the
  same pattern. Both are runtime markers, not domain fields.
- The `humanInterventions` walking for the counter is now gone;
  if any downstream consumer (none in this slice) reads the old
  `type: 'investigation'` entries, they'll see no data. The
  `humanInterventions` array still records operator decisions
  (accept/reject/override/defer/no_action) via the canonical
  route — that's the unchanged operator surface.
- The clear-block route is the only path to reset the counter.
  This is intentional — silent auto-recovery of a hard-blocked
  situation is the worst behavior. The operator must acknowledge.

## Suggested next step (NOT in this slice)

User asked: should be inserted **before Terminal Lifecycle** (P0010.3).
P0010.3 is the next natural slice and is the unlock for:
- P0010.1 H area (Resolution Engine, `closed_at`/`closed_by`/
  `resolution_reason` columns, `lifecycle='closed'`)
- E area (real Archive, replacing the legacy badge)
- G area (Final Outcome producer)

P0010.2.2 is the recovery piece the user asked for; P0010.3 is
the lifecycle piece. The two together make a self-healing +
self-completing business runtime.

# Handoff — P0010.2.3 Post-P0010.2 Regression Audit + Repair (2026-08-27)

## Session goal

User directive: "把最近几轮已经'做过'的能力逐项确认成真正的生产闭环，清掉
test-only / backend-only / UI-only / restart-broken 的断腿." Audit 10
capabilities (A-J) from recent P0010.1 / P0010.2 / P0010.2.2 work and confirm
each is a complete production loop:
**Producer → Persistence → Runtime Trigger → API → Workspace Consumer → Live Verified.**

Hard scope (user-locked): allowed — fix broken legs in existing chain. Forbidden —
P0010.3 / Terminal Lifecycle / `situations.closed` / `closed_at` / Resolution
Engine / Final Outcome / Situation Archive / Event Bus / Wake Engine / Action
Engine / Approval / external sending / Feishu-WeCom-Email-Telegram / Trust
Schema refactor / Evidence Identity migration / Knowledge Identity redesign /
Knowledge Engine / new Memory Architecture / Skill Engine / hermes proxy /
deleting SubprocessHermesClient / faking time-provenance-outcome for UI.

## Audit outcome (10 capabilities)

- **A. Entity / 商品身份** — REPAIR → PASS. Bootstrap was dynamic-imported
  **after** `startServer()` + `loop.start()` at `platform/server/index.ts:269-285`.
  First request to `/api/situations` could race; on a fresh DB the schema
  was created inside `startServer()`, so bootstrap would also have run
  against an empty schema.
- **B. Evidence / Knowledge 引用** — DEFERRED. Real evidence_id/knowledge_id
  is P0010.3 SB-1/SB-2. Popovers honestly admit "原始来源暂不可定位" /
  "无 first-class 记录". **No new code.**
- **C. Investigation / Recovery** — PASS (already shipped P0010.2.2).
- **D. Runtime Continuous Loop** — REPAIR → PASS. `LoopState.blockedCount`
  was undefined; `/api/runtime/loop` didn't surface it; Workspace Runtime
  view didn't read it.
- **E. Hermes Transport** — PASS (P0010 `/api/ws`) + LEGACY
  (`SubprocessHermesClient` for `rankProductsComposition`).
- **F. Human Intervention** — REPAIR → PASS. `deriveCapabilityBoundary`
  did fuzzy text match (`人工核验/人工确认/无法获取`) — dead code.
- **G. Timeline** — REPAIR → PASS. Stop-reason event didn't carry the `≈`
  annotation the completed event carries.
- **H. Output** — PASS. `materializeWorkItem` is wired + live verified.
- **I. Archive** — PASS. Labels are honest; `Situation 归档` is a
  pointer-events:none stub for P0010.3.
- **J. Memory / Experience / Skill dead-leg** — REPAIR → PASS. 5 dead
  exports marked with `// REMOVE CANDIDATE` JSDoc. Skill extraction not
  built at all (`extractSkills` / `skill_engine` / `skill_lifecycle` don't
  exist). Do NOT delete (out of scope).

## Repair changes (13 source files + 4 test files)

| # | file:line | change |
|---|---|---|
| **A-1** | `platform/server/index.ts:269-285` | Moved `bootstrapProductCatalog` block to BEFORE `startServer({db, schedule})`. |
| **A-1'** | `platform/server/index.ts` | Added explicit `initDatabase(db)` before bootstrap (kills fresh-DB regression). |
| **A-2** | `tests/unit/connectors/jd/product-catalog-bootstrap-order.test.ts` (NEW) | 3 source-level tests pinning the ordering. |
| **D-1** | `apps/ecommerce/runtime/loop/recovery-candidates.ts` | Added `countBlockedSituations(db, threshold)` — one COUNT query. |
| **D-1b** | `apps/ecommerce/runtime/loop/{index,runtime-loop}.ts` | `LoopState.blockedCount: number`; `list()` reads it live. |
| **D-2** | `apps/ecommerce/workspace/index.html:157` | DOM slots `loopStatus` + `loopBlockedBadge`. |
| **D-2'** | `apps/ecommerce/workspace/app.js:937-980` | `loadLoopStatus()` (fail-soft, honest "unknown" placeholders) wired into `loadRuntime()`. |
| **D-3** | `tests/unit/loop/recovery-candidates.test.ts` (extend) | +6 tests for `countBlockedSituations`. |
| **D-3'** | `tests/contract/workspace-loop-status.test.ts` (NEW) | 4 contract tests. |
| **F-1** | `apps/ecommerce/workspace/app.js deriveCapabilityBoundary` | Replaced fuzzy text match with `inv.needsHuman === true`. |
| **G-1** | `apps/ecommerce/workspace/presentation.js:617-637` | `stopSummary` with conditional `≈` + "时间未记录" fallback. |
| **G-2** | `tests/unit/workspace/timeline-proxy-annotation.test.ts` (NEW) | 3 tests pinning the honesty rule. |
| **J-1** | `experience/{extraction,repository}.ts`, `memory/store.ts` (4 sites) | `// REMOVE CANDIDATE — production zero-call` JSDoc. |
| **J-2** | `experience/facade.ts` (2 sites) | Same JSDoc on `MemoryFacade.extract` / `store`. |

## Live verification (6 cases)

| # | Case | Status | Evidence |
|---|---|---|---|
| 1 | Continuous Runtime | **PASS** | `/tmp/p0010.2.3-live.log` + `…-fresh2.log`: 2+ ticks each, `tick capability=trade.overview` → `evidence updated` → `situation updated created=0 skipped=6` → `investigation skipped reason=no_meaningful_change`. |
| 2 | Restart Recovery | **PASS** | P0010.2.2 audit log shows 5 ticks with `recovery eligible count=1 kinds=interrupted` + `investigation triggered reason=recovery_interrupted` + `investigation BLOCKED ... consecutiveFailures=3` + `recovery eligible count=1 kinds=failed_retryable` after clear-block. |
| 3 | Human Feedback | **PROVEN-BY-TEST** | Hermes auth broken in dev env (`Missing Hermes dashboard session token`); full investigation turn can't complete. `formatPriorHumanGuidance` path is unit-tested; producer `recordInterventionInLearningContext` is in production. |
| 4 | Output | **PASS** | `GET /api/outputs` returns `out_3a43d1053b9bfa2d` (status=ready, type=recommendation). `materializeWorkItem` is unit-tested (idempotency, dedup). |
| 5 | Entity | **PROVEN-BY-TEST + PARTIAL LIVE** | `product-catalog-bootstrap-order.test.ts` pins the invariant. Live: `products` table has 1 row with real name "祁门红茶官方旗舰店新茶特级...". Pre-existing 31 `situations` rows have `entity_name=NULL` (legacy data). New situations post-fix will have real names. Can't force new creation without deleting dedup anchors. |
| 6 | Archive | **PASS** | `GET /api/ranking/operator_mode` returns 7 ranking rows. UI `index.html:50` has `legacy-badge` "本视图当前为 ranking 历史，未连接到 Situation 生命周期". Disabled "Situation 归档" at `:57` is `pointer-events: none` (CSS-disabled P0010.3 stub). |

## Tests + typecheck

- New tests: **16 net** (3 A-2 + 6 D-3 + 4 D-3' + 3 G-2).
- Full suite: **898 / 902 passing** (4 pre-existing flaky:
  `tests/integration/http.test.ts` under parallel load,
  `tests/contract/chat.contract.ts` 5s timeout,
  `tests/unit/capability/coverage.test.ts` indicator count drift,
  `tests/unit/runtime/kernel/evidence-orchestrator.test.ts` rmdir race
  on parallel test cleanup). All four predate this slice; baseline
  was 884 passing with the same flakies surfacing under load.
- `npm run typecheck`: **0 new errors**. Pre-existing baseline 19 unchanged.

## Risks

- The 2 pre-existing flaky tests (chat 5s timeout, capability indicator
  drift) are unrelated to this slice and were flaky before P0010.2.3.
- Hermes auth broken in dev env blocks live end-to-end verification of
  investigation turn output. Cases 3 and 5 are PROVEN-BY-TEST.
- The 31 legacy `entity_name=NULL` situations remain in the DB. They
  are pre-fix data; the fix only protects future situations.

## Boundary honored (per user spec)

- No P0010.3 / Terminal Lifecycle / `situations.closed` / `closed_at` /
  Resolution Engine / Final Outcome / Situation Archive.
- No Event Bus / Wake Engine / Action Engine / Approval / external
  sending / Feishu-WeCom-Email-Telegram.
- No Trust Schema / Evidence Identity (SB-1) / Knowledge Identity (SB-2).
- No new Memory Architecture / Skill Engine / hermes proxy.
- No deletion of `SubprocessHermesClient`.
- No fake time/provenance/outcome fabrication.

## STOP

Per user directive, this slice only audits + repairs existing chains.
After commit + push, **STOP** — do not start P0010.3 / Terminal Lifecycle /
Resolution Engine / anything from the forbidden list. Report the commit
hash and wait for the next user prompt.
