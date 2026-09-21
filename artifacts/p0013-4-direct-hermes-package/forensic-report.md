# Forensic report — what Fabric actually sends to Hermes during Historical Replay

Scope: run window 2026-09-02 → 2026-09-12, frozen dataset `data/jd_acquisition_20260914_0231`
(manifest `87613e01…`). Sources: the shipped prompt builder, the Replay kernel that calls it,
Fabric's persisted rows, and prompts captured from real Replay sessions. Read-only; no code changed,
no Hermes run.

---

## 1. How the prompt is assembled

There is exactly **one assembly point**:

```
apps/ecommerce/runtime/replay/replay-cognition-kernel.ts
  buildReplayInvestigationPrompt({ run, businessDate, visibleEvidence, priorSnapshots,
                                   priorCognition, enrichments, heldEvidence })  → string
```

It is a **pure function of its arguments** — no DB access, no clock, no randomness — and it returns a
single string. The kernel then sends that string verbatim:

```
const replyPromise = collectTurn(client, sessionId, turnTimeoutMs);
const submitP = client.submitPrompt(sessionId, prompt);
```

`platform/server/routes/replay.ts` → `createReplayCognitionKernel(db, {client, sessionId})` is the only
construction site.

### Is there a system / developer / user split?

**No layering from Fabric.** Measured against real sessions: each business day appears as exactly **one
`role='user'` message** — day 09-02 session had `{user: 1, assistant: 5, tool: 9}`, day 09-03 had
`{user: 1, assistant: 4, tool: 9}`. Fabric never sends a system or developer message.

The **system** prompt is built by Hermes itself (skills index, memories, toolset rendering) and is not
authored or controlled by Fabric. So the division is:

| Layer | Authored by | Content |
|---|---|---|
| system | **Hermes** | skill index, memory, toolset, harness posture |
| developer | nobody | — |
| user | **Fabric** | the entire Replay prompt, one per business day |

The prompt opens with a one-line preamble that is the only place the day is stated up front:

```
You are running P0013 Historical Cognitive Replay. The business day is 2026-09-02.
```

### Fidelity of this export

`scripts/p0013-4-export-prompts.ts` calls the shipped builder and writes its return value. Checked
against prompts captured from a **real** Replay run (session `20260921_052444_e832a4` and
`20260921_053101_ab2118`):

| day | real capture | regenerated | result |
|---|---|---|---|
| 2026-09-02 | 36,159 bytes | 36,159 bytes | **byte-identical** |
| 2026-09-03 | 38,837 bytes | 38,837 bytes | **byte-identical** |

Day 09-03 is the strong case: it includes a real prior-cognition block, and it still matches exactly.
So the package's prompts are Fabric's prompts, not a paraphrase.

## 2. Static vs per-business-day (measured, not read off the code)

Diffing the generated day-09-02 prompt against day-09-12:

- **335 of 405 lines are byte-identical (82%)** — the contract prose does not move.
- Only **6 sections** change, plus the preamble line:

| Section | What varies |
|---|---|
| preamble | the business date |
| `## Runtime Trust Boundary` | T repeated in "SQL `WHERE business_date <= T`" |
| `## Run context` | `current_business_date (T)` |
| `## Current evidence` | the rendered evidence rows (**3 rows on day 1 → 33 on day 11**) |
| `## Evidence Universe of this run` | `visible at T` counts + T in the header |
| `## Operator enrichments` | the empty-state line / any entries visible at T |
| `## Output shape` | `"situationId": "<runId>-<businessDate>"` |

Everything else — Analysis Target, Evidence Resolution, Question-driven/Sufficiency, Knowledge
obligation, Cognition continuity, Workflow, output obligations, Epistemic Layers, output language,
per-claim provenance, the three concepts, the Replay retrieval binding — is **static text**.

Prompt size grows with the visible slice: 36,159 B (day 1) → 48,214 B (day 11).

## 3. Source attribution per section

| Section in the prompt | Source | Introduced by |
|---|---|---|
| preamble + `## Runtime Trust Boundary` | kernel literal | P0013 |
| `## Run context` | kernel literal | P0013 |
| `## Current evidence` | `visibleEvidenceFor()` + `readEvidenceContentSummary()` | P0013, KPI rendering widened by P0013.5 |
| `## Evidence Universe of this run` | `heldEvidenceFor()` + `formatHeldEvidence()` | **P0013.5** (audit) |
| `## Operator enrichments` | `visibleEnrichmentsAt()` | P0013.3 |
| `## Evidence Resolution` | `EVIDENCE_RESOLUTION_SECTION` | P0013.2 |
| `### Replay V1 retrieval binding` | `REPLAY_ORDER_RETRIEVAL_SECTION` | P0013.2 |
| `## Question-driven investigation & Evidence Sufficiency` | `EVIDENCE_SUFFICIENCY_SECTION` | **P0013.4** |
| `## Prior days' judgments` | `formatPriorSnapshots()` | P0013 |
| `## Prior Cognition (Historical, NOT Current)` | `formatPriorCognitionSection()` | Phase F (epistemic) |
| `## Epistemic Layers` | kernel literal | Phase B |
| `## Knowledge` | `KNOWLEDGE_ANALYSIS_SECTION` | **P0013.5** (moved into the shared contract) |
| `## Per-claim provenance` | kernel literal | Phase C/E |
| `## Three concepts` | kernel literal | P0013 |
| `## Output language` | kernel literal | P0010.2.5 |
| `## Cognition continuity` | `COGNITION_CONTINUITY_SECTION` | P0013.4-era (ADR-091) |
| `## Analysis Target` | `ANALYSIS_TARGET_SECTION` | P0013.2 |
| `## Investigation Workflow` | kernel literal | P0013, extended by P0013.4 step 7 |
| `## Formal output obligations` | `ANALYSIS_OUTPUT_OBLIGATIONS` | P0013.2 |
| `## Output shape` | kernel literal | P0013, extended by P0013.2/3.4 fields |

The five `_SECTION`/`ANALYSIS_OUTPUT_OBLIGATIONS` constants live in
`apps/ecommerce/runtime/investigation/analysis-contract.ts` and are embedded **verbatim in both** the
Production prompt and the Replay prompt — they are the shared cognition contract, not Replay-specific.

## 4. Data Fabric supplies vs data Hermes must fetch

| Content | In the prompt | Needs a tool call |
|---|---|---|
| visible evidence rows (id, capability/data_type, business_date, bucket, path, size, hash) | ✅ | |
| rendered KPI / trend / per-order summary **text** | ✅ (`readEvidenceContentSummary`) | |
| Evidence Universe inventory + declared grain & subjects | ✅ | |
| dataset path + manifest hash | ✅ | |
| the dataset **manifest file itself** | ❌ | not provided at all |
| full per-order rows (price bands, ex-top1 AOV, top orders, SKU mix) | ❌ | `mcp__fabric__fabric_replay_retrieve_orders` |
| Knowledge pages | ❌ (only the navigation instruction) | `read_file knowledge/…` |
| Hermes' own skills | ❌ | `skill_view` |
| tool schemas | ❌ | `tool_describe` |

## 5. What is *not* in the prompt

- **No Situation object.** Historical Replay has no signal and no anomaly trigger; the task is a daily
  reading, not incident response. `Situation: NONE`.
- **No plan/todo request.** The output schema has no plan field, and no bundled Replay day ever called a
  `todo`/plan tool. `## Investigation Workflow` is a list of contract obligations, not an artifact Hermes
  must produce.
- **No enrichments** for this run (`visibleEnrichmentsAt()` returns 0 for every day).
- **The prior-cognition blocks are empty in this package** — see README §3.

## 6. Answers to the five checks

**1. Does Fabric send a complete prompt every day?** **Yes.** One complete, self-contained prompt per
business day, as a single user message (measured `user: 1` per session). Nothing is incremental — the
day's prompt restates every rule it relies on.

**2. Does one Replay run reuse one Hermes session?** **Yes.** `platform/server/routes/replay.ts:133`:
`const sessions = new Map<string, ActiveReplaySession>()` — *"One Hermes session per runId, lifetime =
the entire Replay run."* Proof from a real run: session `20260920_165118_e4e013` contains **two** user
prompts (34,536 B and 36,065 B) — two business days in one session.
(Exception, not the norm: a session is dropped when a run goes FAILED, and the P0013.4 acceptance
harness deliberately restarts Fabric between days so each day gets a *fresh* session. Both behaviours
are observable; the default is reuse.)

**3. Is prior-day cognition explicitly injected, or kept by session continuity?** **Both, and they are
different mechanisms.**
- *Explicit*: `prior_cognition[]` and `## Prior days' judgments` are rendered into the prompt from
  Fabric's persisted snapshots by `loadPriorCognition()`, SQL `WHERE business_date < ? ORDER BY
  business_date ASC` — **no LIMIT, so it accumulates every prior day**, not just T-1.
- *Session continuity*: because the session is reused, day T's turn also still literally contains days
  1..T-1's full prompt and reply text in the conversation.

So for day N, Hermes sees prior days **twice**: verbatim in session history, and summarised as
`prior_cognition` in the day's prompt.

**4. What exists only in session memory, not in the day's prompt?**
- every previous day's **full assistant reply** — the complete Investigation Contract JSON, not just the
  judgment/recommendation text that `prior_cognition` carries;
- every previous day's **tool calls and their returned rows** (e.g. the retrieved order slices);
- Hermes' **own system prompt** (skill index, memory, toolset) — Fabric never authors it;
- any **`skill_view` content** the model pulled earlier in the session.

**5. For a manual 11-day test, which is closer to real Fabric?** **One session, 11 sequential day
prompts.** Reasons: Fabric emits one message per day (Q1); the session is reused across days (Q2); and
the per-day differences (T, a visible slice growing 3→33 rows, date-scoped retrieval) only exist day by
day. A single 11-day prompt matches none of that — it would let the model see all days at once, which
the real contract explicitly forbids ("You have NO access to future days").

---

### Reproduce

```
npx tsx scripts/p0013-4-export-prompts.ts <runId> <outDir> [--prior=empty|real]
```

Read-only: opens `data/agentfabric.db` with `readonly: true`, writes only into `--out`.
