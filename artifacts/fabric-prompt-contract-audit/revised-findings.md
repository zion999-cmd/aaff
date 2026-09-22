# Revised findings — second-pass audit

Supersedes the first pass's conclusion **without deleting it**: `README.md`, `prompt-inventory.md`,
`prompt-section-classification.md`, `replay-vs-production.md`, `evidence-acquisition-map.md`,
`goal-vs-how.md` and `findings.md` remain as the historical record of pass 1. This file revises pass 1's
central claim.

Read-only. No product code changed, no prompt rewritten, Light not wired, Hermes/Skill/Memory untouched,
P0013.4 acceptance unchanged.

Reproduce the numbers: `npx tsx scripts/audit-prompt-inventory.ts` then
`python3 scripts/audit-prompt-ownership.py`.

---

## Part C — Revised byte ownership

Section sizes measured from the shipped builders (contract-only prompt, zero evidence injected); the
category allocation is explicit per section in `scripts/audit-prompt-ownership.py`, and each section's
allocations must sum to its measured size or the script aborts.

| Category | Replay bytes | Replay % | Production bytes | Production % |
|---|---:|---:|---:|---:|
| `REDUNDANT` | 8,335 | 25.1 % | 9,043 | 23.2 % |
| `EXPLORATION_METHODOLOGY` | 6,542 | 19.7 % | 8,027 | 20.6 % |
| `CONTRACT` | 5,536 | 16.6 % | 6,967 | 17.9 % |
| `EXECUTION_HOW` | 4,401 | 13.2 % | 7,718 | 19.8 % |
| `EVIDENCE_SEMANTICS` | 3,870 | 11.6 % | 2,800 | 7.2 % |
| `OUTPUT_SCHEMA` | 1,356 | 4.1 % | 1,700 | 4.4 % |
| `GOAL` | 1,272 | 3.8 % | 1,263 | 3.2 % |
| `CAPABILITY_DESCRIPTION` | 1,034 | 3.1 % | 459 | 1.2 % |
| `CONTEXT` | 740 | 2.2 % | 886 | 2.3 % |
| `EVIDENCE` | 184 | 0.6 % | 97 | 0.2 % |
| **total** | **33,270** | 100 % | **38,960** | 100 % |

### The three ownership blocks

| block | categories | Replay | Production |
|---|---|---:|---:|
| **Fabric legitimate ownership** | `GOAL + CONTRACT + EXPLORATION_METHODOLOGY + EVIDENCE_SEMANTICS` (+ `CONTEXT`, `EVIDENCE`, `CAPABILITY_DESCRIPTION` as runtime input) | **19,178 B · 57.6 %** | **20,499 B · 52.6 %** |
| **Hermes ownership** | `EXECUTION_HOW` | 4,401 B · **13.2 %** | 7,718 B · **19.8 %** |
| **Pure prompt debt** | `REDUNDANT` + the 1,356 / 1,700 B of `OUTPUT_SCHEMA` that restates the schema | 9,691 B · **29.1 %** | 10,743 B · **27.6 %** |

Read together: **Fabric's legitimate ownership is the majority; Hermes' execution HOW is a minority; and
prompt debt is nearly as large as the whole execution-HOW category.** That is a different diagnosis from
pass 1.

---

## Part F — Is "move HOW to Hermes" too broad?

**Yes, as written in pass 1.** Pass 1 treated `HOW/SKILL` as one bucket and recommended moving it out.
Re-scored, that bucket (17,413 B) splits:

| | share of the bucket |
|---|---:|
| `EXPLORATION_METHODOLOGY` — Fabric keeps | **37 %** |
| `EXECUTION_HOW` — Hermes owns | **22 %** |
| `EVIDENCE_SEMANTICS` / `CONTRACT` — Fabric keeps | 26 % |
| `OUTPUT_SCHEMA` / `REDUNDANT` / `GOAL` | 15 % |

Moving the whole bucket would have stripped Fabric of its domain methodology — the part that makes the
Agent explore the *right* business dimensions. The corrected statement:

> **Fabric is not an Agent Runtime.**
> Fabric defines **Goal + Exploration Methodology + Evidence Semantics + Contract/Boundary**.
> Hermes Runtime owns **Execution Planning, Tool Use, Retry/Search/Branching, Runtime Orchestration**.

### F1. Does Fabric still own professional methodology?

**Yes, and it should — that is 19.7 % (Replay) / 20.6 % (Production) of the prompt.** The load-bearing
examples: which variables carry business meaning per structural dimension; what makes an evidence request
legitimate (the Decision-changing test); when remaining unknowns no longer justify continuing; keeping
alternative explanations alive. Removing these does not make the Agent more autonomous — it makes it
explore the wrong things.

### F2. Does that make Fabric an Agent?

**No.** Owning domain methodology is a *knowledge* claim; being an agent is an *execution* claim. An agent
runtime decides what to do next from intermediate results. Fabric defines the domain and the contract, then
sends one message and awaits one reply.

### F3. What behaviour would actually constitute "becoming an Agent"?

From the engineering boundary, Fabric would have become an agent when it:

1. **branches on intermediate results** — inspects a partial result and chooses a different next action;
2. **owns a loop** — iterates until a condition it evaluates itself;
3. **owns retry/fallback policy** — decides how many attempts, when to switch approach;
4. **schedules tool calls** — ordering, parallelism, call budgeting;
5. **holds mutable working state across steps** — a plan it revises;
6. **lets domain method leak into per-step control flow** — where "what to explore" is expressed as "do A
   then B".

Fabric does (1) exactly once, minimally; (2)–(5) not at all; (6) in three places.

### F4. How far has the existing code gone?

**One step short of the line: Fabric prescribes the loop instead of running it.**

| position | what it does | how agent-like |
|---|---|---|
| `routes/situation-chat.ts:817-831` — the `finalizePrompt` re-prompt | Fabric parses the reply, and **on failure issues a different prompt** to the same session | **the most agent-like thing Fabric does today**: it is a branch on an intermediate result, owned by Fabric. One branch, no loop, no state beyond the parse result — but it is genuinely a runtime decision. |
| `exploration-goal.ts` Step 1 ("inventory existing assets **before** exploring (required)") + "do not retry the same path more than **3** times" | a required first step and a literal retry budget written into the prompt | prescribes control flow; Hermes executes it. This is the clearest textual violation. |
| Production `### ALLOWED / ADVISORY` Tool Surface blocks (~2,000 B) | "call ONCE per evidence gap, retry ONCE", "allowed pattern A → B → C", "use `tool_search` at most once per session" | call budgeting and retry policy — the Agent's job, written as prompt text |
| `## Investigation Workflow` (both prompts) | a fixed 9-step order | static loop prescription |
| `replay-cognition-kernel.ts` + `createReplayCognitionKernel` | **does not branch**: one prompt, one `collectTurn`, one parse; failure ⇒ the step FAILS | correctly non-agentic |

So: Fabric has **not** become an Agent Runtime — it never runs a loop and never branches except the single
parse-retry — but it has written the Agent's control flow into three prompts, which is the same boundary
crossed in a weaker form (prescription instead of execution).

---

## KEEP IN FABRIC

- **Goal** — the turn's target ("business state and structure; curve narration is not a judgment");
  the business date / run identity; the Situation (Production) or daily framing (Replay).
- **Contract / Boundary** — business-time ≤ T; no future days; proposal-not-action; tool permissions;
  write boundaries; acquisition execution boundaries (the operator's live browser); the legal stop and
  status vocabularies; turn-termination.
- **Exploration Methodology** — the five structural dimensions and *what evidence constitutes them*;
  the Decision-changing-Evidence test and its invalid grounds; Sufficiency as a semantic judgement (the
  remaining-unknown test); when stopping is correct and unbounded investigation is a failure; the
  progress definition (cognitive-state change); carrying one continuous reading forward; the
  cross-source reconciliation requirement; the "need is not a promise" truthfulness rule.
- **Evidence Semantics** — `Knowledge ≠ Evidence`; grain ≠ field existence; the declared grain and
  subjects inventory; IN_CONTEXT / RETRIEVED / UNAVAILABLE; `operator_feedback` is not an Observed Fact;
  no causation from temporal order alone; preserve source fields rather than normalise the fact.

## MOVE TO HERMES

Execution HOW only — **4,401 B Replay / 7,718 B Production**, comprising:

1. `## Investigation Workflow`'s step ordering (and its one concrete tool directive) — 2,100 B / 2,200 B.
2. Production's Tool Surface blocks — retry counts, call budgets, "allowed pattern A → B → C" — ~2,000 B.
3. `exploration-goal.ts` Step 1 required ordering and the "no more than 3 times" retry budget.
4. `## Knowledge`'s index-first navigation rule (a search strategy) — 673 B in both.
5. `Epistemic Layers`' four worked examples (how to classify a statement) — 665 B / 1,600 B.
6. The Replay retrieval binding's "filter rows to `date == businessDate` yourself / compute ex-top1 AOV
   yourself" steps — 563 B (the *slice semantics* stays; the arithmetic goes).
7. `Evidence Resolution`'s "retrieve it via the available read-only retrieval surface, then continue"
   procedure — ~400–520 B.
8. Production `## Recommendation kind`'s mapping table — ~800 B (keep one contract sentence).

## REMOVE FROM PROMPT

1. **`## Output shape`** — 4,813 B Replay / 4,269 B Production. `InvestigationSchema` already validates it;
   a minimal field list would carry the same information.
2. **`## Formal output obligations`** — 922 B in both. `validateAnalysisObligations` already rejects
   violations fail-closed at parse (`parse.ts:87,106`).
3. **`## Three concepts`** — 401 B / 1,181 B. Restates `confirmed_action: null` and Observed/Inferred
   already stated elsewhere.
4. **The forbidden-pattern catalogue inside `## Cognition continuity`** — 1,027 B. Output style; stale
   against a contamination that has since been isolated; duplicates the Threshold-provenance line.
5. **Production's `## Output Language` enumeration** — 1,644 B of the 2,144 B. Replay's 256 B version proves
   one line suffices.
6. **The enrichment-rules block when there are zero enrichments** — 1,172 B of 1,652 B. Six explanatory
   bullets describing a case that cannot arise.
7. **Forked duplicates** — ~13,500 B maintained twice across paths (`replay-vs-production.md` C2).

**Total pure prompt debt ≈ 9.7 KB (Replay, 29 %) / 10.7 KB (Production, 28 %).**

## ENGINEERING GAP

Unchanged from pass 1 — these are not prompt problems (evidence in `evidence-acquisition-map.md`):

1. **DATA ABSENT** — daily UV/PV, daily CVR/加购/funnel, traffic source, operations, inventory, refunds,
   buyer type. The captured HTTP calls show the whole window was requested in one `getSummary` call
   (`body.size = 1`) and `getTrend` was only asked for 3 GMV-family indicators.
2. **WRONG GRAIN** — the one summary row is a 12-day aggregate stamped at the range end (09-13), hence
   never visible at T ≤ 09-12.
3. **NOT EXPOSED / NOT IMPLEMENTED** — 11 capabilities declared, **1** `verified`, **1** with a dedicated
   acquire function; `acquireJdTrafficOverviewViaCDP` does not exist. A capability being *listed* is
   indistinguishable from *obtainable* for the Agent.
4. **BROKEN (client wiring)** — `parentOrdersByDay → Fabric execution failed: fetch failed` when no Fabric
   server listens on `FABRIC_BASE_URL` (default `:3000`, `fabric-mcp-server.mjs:15,369,477`; Hermes breaker
   `tools/mcp_tool.py:6086`). Recorded, **not fixed**.
5. **PROMPT framing** — "not collected for this run" and "not collectable by Fabric" render as the same gap
   language.

---

## One-line revision of pass 1

> Pass 1 said: *"~28 % is HOW and should move to Hermes."*
> Pass 2 says: *"~20 % is Fabric-owned exploration methodology (keep); 13 % is Hermes execution HOW (move);
> 29 % is pure prompt debt (delete or move to a Skill); 53–58 % is legitimate Fabric ownership."*
> The boundary problem is real but smaller than pass 1 claimed — and the larger problem is volume,
> duplication and mixing, not ownership.
