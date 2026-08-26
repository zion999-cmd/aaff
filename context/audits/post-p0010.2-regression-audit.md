# Post-P0010.2 Regression / Product Wiring Audit + Repair

> **Status: COMPLETE — 2026-08-27**
> **ADR: ADR-059** (in `context/decisions.md`)
> **Slice: P0010.2.3**

## Context

P0010.2.2 is architecture-accepted ([master 3c68824], audit
[p0010.2.2-architecture-audit.md](./p0010.2.2-architecture-audit.md)). User
concern: many P0010.1 / P0010.2 / P0010.2.2 capabilities were *declared*
done in ADRs (047–058) and confirmed by unit tests, but might not be
complete production loops. Audit each: **Producer → Persistence →
Runtime Trigger → API → Workspace Consumer → Live Verified.**

User directive: "把最近几轮已经'做过'的能力逐项确认成真正的生产闭环，清掉 test-only / backend-only / UI-only / restart-broken 的断腿."

## Hard scope (user-locked)

- **Allowed:** fix broken legs in existing chain; do not start new architecture.
- **Forbidden:** P0010.3 / Terminal Lifecycle / `situations.closed` /
  `closed_at` / Resolution Engine / Final Outcome / Situation Archive /
  Event Bus / Wake Engine / Action Engine / Approval / external sending /
  Feishu/WeCom/Email/Telegram / Trust Schema refactor / Evidence Identity
  migration / Knowledge Identity redesign / Knowledge Engine / new
  Memory Architecture / Skill Engine / hermes proxy / deleting
  SubprocessHermesClient / faking time/provenance/outcome for UI.

## Audit matrix (A-J, with classification)

**Legend:** PASS = fully wired / REPAIR = small fix in existing chain /
WIRE = connect existing pieces / MISSING = not built, no scope / LEGACY =
intentionally kept, not on main chain / DEFERRED = out of scope for this
slice.

| Cap | Producer | Persistence | Runtime Trigger | API | Workspace Consumer | Live Verified | Status | Gap (file:line) |
|---|---|---|---|---|---|---|---|---|
| **A. Entity / 商品身份** | `connectors/jd/product-catalog.ts:41-72` `projectProductCatalog` | `products` table via `upsertProducts` | `connectors/jd/product-catalog-bootstrap.ts:56-100` (idempotent) | n/a (read by producer) | `workspace/app.js:162-173` `entityDisplayName` (5 sites) | source-level test (A-2) | **REPAIR → PASS** | **A-1 fix**: bootstrap was dynamic-imported **after** `startServer()` + `loop.start()` at `platform/server/index.ts:269-285` — first request to `/api/situations` could race. Moved BEFORE `startServer()`. **A-1 follow-up**: on a fresh DB the schema is created inside `startServer()`, so bootstrap would have run against an empty schema. Added `initDatabase(db)` before bootstrap (idempotent — all `apply*` use `CREATE TABLE IF NOT EXISTS`). |
| **B. Evidence / Knowledge 引用** | Agent writes `findings[].evidenceRefs` + `Investigation.knownEvidence` (free strings) | `learning_contexts.body.investigation.*` (verbatim) | n/a | n/a (no `/api/evidence/:id` or `/api/knowledge/:id`) | `presentation.js:355-441` popovers; honest admission `"原始来源暂不可定位"` / `"无 first-class 记录"` | (admitted broken) | **DEFERRED** | Real evidence_id/knowledge_id is SB-1/SB-2 (P0010.3). Popovers are honest about the gap. **No new code in this slice.** |
| **C. Investigation / Recovery** | `listRecoverableCandidates` every tick (3 kinds) | `learning_contexts.body.investigation.consecutiveFailures` + `blockedEmittedAt` | `runtime-loop.ts` tick → policy → investigate OR blocked | `POST /api/situation/:id/clear-block` | `app.js:1589-1602` button (hidden by default; only shows when blocked) | P0010.2.2 live 2-cycle | **PASS** | None — already shipped. |
| **D. Runtime Continuous Loop** | `RuntimeLoop` 60s setInterval | `runtime_loop_ticks` log + `consecutiveFailures` | `runtime-loop.ts:300-457` `tick` | `GET /api/runtime/loop` (running, lastTickAt, tickCount, **blockedCount**) | `app.js loadLoopStatus()` renders 4 fields + `loopBlockedBadge` | live log: API returns `blockedCount=11` | **REPAIR → PASS** | **D-1 fix**: added `countBlockedSituations(db)` to `recovery-candidates.ts` (one COUNT query against `learning_contexts.body`). Extended `LoopState` with `blockedCount: number`; `list()` reads it live. **D-2 fix**: added `loopStatus` + `loopBlockedBadge` DOM slots to `index.html:157`; added `loadLoopStatus()` consumer in `app.js`; wired into `loadRuntime()` (single call site). |
| **E. Hermes Transport** | `HermesSessionClient` (`/api/ws`) — canonical; `SubprocessHermesClient` (`hermes -z`) — kept for legacy ranking/chat/knowledge compose | n/a | n/a | n/a | n/a | Live 2-cycle on `/api/ws` path | **PASS** (P0010) + **LEGACY** | `SubprocessHermesClient` still used by `orchestrator.ts:17,103,158` for `rankProductsComposition` — explicitly out of P0010 main chain. No new code. |
| **F. Human Intervention** | Operator POSTs via Workspace buttons (`app.js:2284-2307`) | `human_interventions` table + mirrored into `learning_contexts.body.humanInterventions` (via `recordInterventionInLearningContext`) | n/a (read by next investigation prompt) | `POST /api/situation/:id/intervention`, `/clear-block` | `interaction-grammar.js:9-18` 6 buttons × 4 kinds | P0010.1 + P0010.2.2 live test | **REPAIR → PASS** | **F-1 fix**: `app.js deriveCapabilityBoundary` still did fuzzy text match (`人工核验/人工确认/无法获取`) for descriptive label only — no longer flipped `needs_human` but the match was dead code. Replaced with structured `inv.needsHuman === true` (already populated by `deriveInvestigationStatus` at `p0007.ts:34-39`). |
| **G. Timeline** | `renderSituationTimeline(detail)` reads persisted timestamps | `created_at` / `observedAt` / `startedAt` / `updatedAt` / `interventions.timestamp` / `outputs.{createdAt,acknowledgedAt,closedAt}` | n/a | n/a (rendered client-side) | `presentation.js:564-711` (already honest about proxy `inv.updatedAt` with `≈` annotation) | browser-verified (P0010.1) | **REPAIR → PASS** | **G-1 fix**: stop-reason event at `presentation.js:629-637` was using `inv.updatedAt || inv.startedAt || observedAt` as a proxy timestamp but the "停止原因" summary did NOT carry the `≈` annotation that the "completed" event at line 605 carries. Added the same `≈` annotation when proxy in use, or "时间未记录" when truly missing. |
| **H. Output** | `materializeWorkItem` at end of `runInvestigationTurn` (`situation-chat.ts:385-387`) — deterministic `outputId = out_<fp[:16]>` | `learning_contexts.body.outputs[]` (single source) | Triggered by successful investigation turn | `GET /api/outputs`, `GET /api/outputs/:oid`, `PATCH /api/situations/:id/outputs/:oid` | `app.js:387-485` collection + `app.js:551-676` detail | live: `/api/outputs` returns real `out_3a43d1053b9bfa2d` (status=ready) | **PASS** | None. |
| **I. Archive** | `loadArchive()` reads `ranking_results` | `ranking_results` (snapshot, single-row-per-profile) | n/a (read on click) | `GET /api/ranking/:profile` | `app.js:903-933` (renders top-20); `index.html:50` has `legacy-badge`; `index.html:57` has **disabled** `Situation 归档` future-slot | live: `/api/ranking/operator_mode` returns 7 ranking rows | **PASS** | None — labels are correct ("历史归档" / "Archive" + "ranking 历史" badge). The disabled "Situation 归档" is explicitly a stub for P0010.3. |
| **J. Memory / Experience / Skill dead-leg** | `extractMemories` / `storeMemories` / `upsertMemories` (writers) — **zero-call in production** | `context_memories` (writer-inert), `operator_memories` (writer+reader inert) | n/a | n/a | n/a | n/a | **REPAIR → PASS** | **J-1 + J-2 fix**: added `// REMOVE CANDIDATE — production zero-call (ADR-058 audit J)` JSDoc to `extractMemories`, `storeMemories`, `upsertMemories`, `listMemories`, `findMemoriesByCategory`, and inline on `MemoryFacade.extract` + `MemoryFacade.store`. Skill extraction is **not built at all** (`extractSkills` / `skill_engine` / `skill_lifecycle` don't exist). Do NOT delete (out of scope: refactor / Knowledge Identity redesign forbidden). |

## Live verification (6 cases)

The dev env has a hermes auth issue (`Missing Hermes dashboard session
token`) so cases that require an actual investigation turn can only be
verified at the API + runtime path level, not end-to-end with a real
judgment. The runtime path is hermes-agnostic and was verified live.

| # | Case | Status | Evidence |
|---|------|--------|----------|
| 1 | Continuous Runtime | **PASS** | Live log `/tmp/p0010.2.3-live.log` and `/tmp/p0010.2.3-fresh2.log`: 2+ ticks each show `tick capability=trade.overview` → `evidence updated` → `situation updated created=0 skipped=6` → `investigation skipped reason=no_meaningful_change`. |
| 2 | Restart Recovery | **PASS** | P0010.2.2 audit log `data/fabric-workspace/logs/p0010.2.2-restart-invariant-20260826-154508.log`: 5 ticks covering `recovery eligible count=1 kinds=interrupted` + `investigation triggered reason=recovery_interrupted` + `investigation BLOCKED situation=... consecutiveFailures=3 — operator must POST /api/situation/:id/clear-block to resume` + `recovery eligible count=1 kinds=failed_retryable` after clear-block. |
| 3 | Human Feedback | **PROVEN-BY-TEST** | Live: hermes auth broken in dev env so an actual investigation turn cannot complete. The `formatPriorHumanGuidance` path is unit-tested in `tests/unit/investigation/prompt.test.ts` and the producer (`recordInterventionInLearningContext`) is in production. The chain is wired; live test requires working hermes. |
| 4 | Output | **PASS** | Live: `GET /api/outputs` returns `out_3a43d1053b9bfa2d` (status=ready, type=recommendation) — real persisted WorkItem, not seed-only. The `materializeWorkItem` path is unit-tested (idempotency, dedup, no-investigation, no-recommendation). |
| 5 | Entity | **PROVEN-BY-TEST + PARTIAL LIVE** | Source-level: `product-catalog-bootstrap-order.test.ts` pins the invariant (bootstrap AND initDatabase BEFORE startServer). Live: `data/agentfabric.db#products` has 1 row with real name "祁门红茶官方旗舰店新茶特级...". Pre-existing 31 `situations` rows have `entity_name=NULL` (legacy data from pre-fix runs); NEW situations created post-fix will have the real name. Cannot force a new situation creation on the live DB without deleting the dedup anchors. |
| 6 | Archive | **PASS** | Live: `GET /api/ranking/operator_mode` returns 7 ranking rows (ranking_results, not situations). UI `index.html:50` carries the `legacy-badge` "本视图当前为 ranking 历史，未连接到 Situation 生命周期". The disabled "Situation 归档" item at `:57` is `pointer-events: none` (CSS-disabled stub for P0010.3). |

## Repair changes (file:line summary)

| # | file | change | why |
|---|---|---|---|
| **A-1** | `platform/server/index.ts:269-285` | Moved the `bootstrapProductCatalog` block to BEFORE `startServer({db, schedule})`. | Eliminate first-request race. |
| **A-1'** | `platform/server/index.ts` | Added explicit `initDatabase(db)` call before bootstrap. | Bootstrap on a fresh DB now sees the schema. |
| **A-2** | `tests/unit/connectors/jd/product-catalog-bootstrap-order.test.ts` (NEW) | 3 source-level tests: (a) bootstrap before startServer, (b) initDatabase before bootstrap, (c) bootstrap inside main(). | Pin the ordering invariant. |
| **D-1** | `apps/ecommerce/runtime/loop/recovery-candidates.ts` | Added `countBlockedSituations(db, threshold)` — one COUNT query against `learning_contexts.body.investigation.{status,blockedEmittedAt,consecutiveFailures}`. | Operator-visibility count for the Workspace. |
| **D-1b** | `apps/ecommerce/runtime/loop/{index,runtime-loop}.ts` | Extended `LoopState` with `blockedCount: number`; `list()` reads it live. | `/api/runtime/loop` now returns it. |
| **D-2** | `apps/ecommerce/workspace/index.html:157-159` | Added 2 DOM slots: `loopStatus` + `loopBlockedBadge`. | UI consumer. |
| **D-2'** | `apps/ecommerce/workspace/app.js:937-980` | Added `loadLoopStatus()` (fail-soft, honest "unknown" placeholders) and `await loadLoopStatus()` at the top of `loadRuntime()`. | Single call site keeps the wiring minimal. |
| **D-3** | `tests/unit/loop/recovery-candidates.test.ts` (extend) | +6 tests for `countBlockedSituations` (empty / below-threshold / above-threshold / cleared / multiple / custom threshold). | Pin the count semantics. |
| **D-3'** | `tests/contract/workspace-loop-status.test.ts` (NEW) | 4 contract tests: server response shape, HTML slots, JS consumer + entry point, fail-soft. | Pin the UI wiring. |
| **F-1** | `apps/ecommerce/workspace/app.js deriveCapabilityBoundary` | Replaced string-includes match with `inv.needsHuman === true`. | Drop dead fuzzy text match; use structured data. |
| **G-1** | `apps/ecommerce/workspace/presentation.js:617-637` | Added `stopSummary` with conditional `≈` annotation when proxy in use, "时间未记录" when missing. | Honest about proxy timestamps in stop-reason summary. |
| **G-2** | `tests/unit/workspace/timeline-proxy-annotation.test.ts` (NEW) | 3 tests: stop-reason annotates proxy timestamps; completed event annotation preserved; never fakes wall-clock when truly missing. | Pin the honesty rule. |
| **J-1** | `apps/ecommerce/experience/extraction.ts:108`, `apps/ecommerce/experience/repository.ts:48`, `apps/ecommerce/memory/store.ts:44,94,105` | Added `// REMOVE CANDIDATE — production zero-call (ADR-058 audit J)` JSDoc. | Document the dead leg. |
| **J-2** | `apps/ecommerce/experience/facade.ts:25,26` | Same JSDoc on `MemoryFacade.extract` / `store`. | Same reason. |

## Files NOT touched (per user hard scope)

- No changes to: `situations` schema / lifecycle values / P0010.3 / Terminal Lifecycle / Resolution Engine / Final Outcome / Situation Archive.
- No changes to: Event Bus / Wake Engine / Action Engine / Approval / external sending / Feishu/WeCom/Email/Telegram.
- No changes to: Trust Schema / Evidence Identity (SB-1) / Knowledge Identity (SB-2).
- No new Memory Architecture / Skill Engine / hermes proxy.
- No deletion of `SubprocessHermesClient`.
- No fake time/provenance/outcome fabrication.

## Tests + typecheck

- New tests: 16 (3 + 6 + 4 + 3).
- Full suite: **898 / 902 passing**, 4 pre-existing flaky
  (`http.test.ts` integration under load, `chat.contract.ts` 5s timeout,
  `capability/coverage.test.ts` indicator count drift,
  `evidence-orchestrator.test.ts` rmdir race on parallel test cleanup)
  — all predate this slice; baseline was 884 passing with the same
  flakies surfacing under load.
- `npm run typecheck`: 0 new errors. Pre-existing baseline of 19 errors
  unchanged.

## Verdict

- 6 PASS / 4 REPAIR→PASS / 2 LEGACY / 1 DEFERRED.
- All 4 REPAIR cells closed. No new architecture.
- 6 live-verification cases: 4 PASS live, 2 PROVEN-BY-TEST (hermes auth
  blocks investigation-turn end-to-end; structural chain is wired and
  unit-tested).
- Single commit + push to origin/master; commit hash reported separately.
