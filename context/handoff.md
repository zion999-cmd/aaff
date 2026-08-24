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
