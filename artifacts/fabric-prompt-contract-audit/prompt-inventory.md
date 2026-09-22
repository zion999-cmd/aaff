# Part A — Prompt inventory: every path that actually sends text to Hermes

Source of truth = the call sites that reach Hermes, found by grepping `submitPrompt` /
`submitTurnAndCollect` across `apps/ platform/ scripts/`. A prompt builder that nothing calls is not a
path; a call site with an inline literal is a path even though it has no builder.

```bash
grep -rn "submitPrompt\|submitTurnAndCollect" apps/ platform/ scripts/ --include="*.ts"
```

**Result: 8 distinct paths.** Five are product runtime paths, two are acceptance/experiment scripts,
one is a knowledge-maintenance flow.

| # | Runtime path | Builder / file | Caller | Trigger | Hermes role | Approx size | Session reused? |
|---|---|---|---|---|---|---|---|
| 1 | **Replay cognition** (heavy, default) | `buildReplayInvestigationPrompt` — `apps/ecommerce/runtime/replay/replay-cognition-kernel.ts:605` | `createReplayCognitionKernel:878` ← `routes/replay.ts:181 ensureSession()` | `POST /api/replay/runs/:id/advance` per business day | Investigate the day, emit the Investigation Contract | **33.3 KB** empty + evidence → **36–48 KB** real | **yes** — one session per run, reused across all days (`sessions` Map, `routes/replay.ts:133`) |
| 2 | **Replay cognition (light)** | `buildReplayLightPrompt` — `replay-prompt-light.ts:67` | *(exporter script only)* | `npx tsx scripts/p0013-4-export-prompts.ts --variant=light` | Same goal, minimal scaffolding | **4.5 KB** empty → **7–19 KB** real | n/a (not wired to runtime) |
| 3 | **Production investigation** | `buildInvestigationPrompt` — `apps/ecommerce/runtime/investigation/prompt.ts:260` | `runInvestigationTurn` — `routes/situation-chat.ts:792` | `POST /api/situation/:id/investigate`, and the runtime Loop's investigation policy | Investigate a **Situation**, acquire evidence, emit the contract | **38,995 B** with zero evidence (measured) | **yes** — per-situation session, reused for the follow-up turns |
| 4 | **Recommendation turn** | inline array — `routes/situation-chat.ts:687-692` | `runRecommendationTurn:680` | second Hermes turn after a judgment exists | Produce a Recommendation from the judgment | ~**0.9 KB** (4 lines) | **yes** — same session as #3 |
| 5 | **Contract finalize re-prompt** | inline array — `routes/situation-chat.ts:819-826` | `runInvestigationTurn` failure path | first reply failed `parseInvestigation` | Re-emit ONLY the JSON contract | ~**1.2 KB** (5 lines) | **yes** — same session as #3 |
| 6 | **Workspace chat** | *(none — the user's message is forwarded)* | `routes/situation-chat.ts:986` | `POST /api/chat` | Free-form operator conversation | user-supplied | **yes** — long-lived chat session |
| 7 | **Knowledge ingest** | `INGEST_PROMPT` — `routes/knowledge.ts:76` | `routes/knowledge.ts:164` | `POST /api/knowledge/ingest` | Read raw sources → organize → write `knowledge/*.md` → update INDEX → append log | a **multi-step operating procedure** (list-literal, tens of lines) | **yes** — one workspace session |
| 8 | **Historical acquisition goal** | `buildExplorationGoal` — `apps/ecommerce/runtime/acquisition/exploration-goal.ts:17` | `acquisition-orchestrator.ts:79` → `hermes-turn-runner.ts:78` | `POST /api/replay/acquisitions` (gap → acquire) | Drive a **browser** to acquire real historical data into an intake dir | a **3-step procedure + execution boundaries + exact output filenames** (124-line builder) | one session per acquisition job |

### Script-only paths (not product runtime, listed for completeness)

| path | file | note |
|---|---|---|
| follow-up acquisition D | `scripts/run-p0011x-followup-acquisition-d.ts:77` | hand-written goal, `submitTurnAndCollect` |
| follow-up acquisition | `scripts/run-p0011x-followup-acquisition.ts:168` | `GOAL` literal at :36, ~100 lines |
| generic exploration | `platform/server/routes/explore-run.ts:116` | **caller-supplied** `validate.prompt` — Fabric does not author it; the P0011.x wire takes the prompt as an argument |

### Not Fabric-authored (observed in the same session, worth distinguishing)

| input | who authors it |
|---|---|
| Hermes **system prompt** (skill index, memories, toolset) | Hermes |
| `skill_view` returns (e.g. 17 KB + 28 KB in real Replay days) | Hermes' profile skills |
| **background review** turn (`agent/background_review.py`) | Hermes — Fabric cannot see or shape it, but it writes profile skills between Fabric turns |

The last row matters for the audit: Hermes runs a **second, uncached conversation** per turn that Fabric
neither authors nor observes. Measured in a real manual session: 4 calls, 78k→99k input tokens, **0 %
cache hit**, ~355 s wall clock (`~/.hermes/logs/agent.log`, `bg-review ... cache_read=270656`).

## Observations

1. **Two builders are near-duplicates of one contract**: #1 and #3 embed the same shared constants from
   `analysis-contract.ts`, but each also maintains its own copies of several sections (see Part C).
2. **Fabric authors procedures, not only goals.** #7 and #8 are method documents (how to ingest, how to
   acquire) — the clearest WHAT/HOW mixing in the inventory.
3. **Only #1, #3 are "cognition" paths** in the sense the audit cares about; #4–#6 are follow-ups,
   #7–#8 are operational flows.
