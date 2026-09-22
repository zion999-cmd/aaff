# Part G — Historical acquisition goal: segment-by-segment boundary audit

Target: `apps/ecommerce/runtime/acquisition/exploration-goal.ts` (124 lines) →
`buildExplorationGoal({need, intakeDir, jobId})` → sent verbatim via
`hermes-turn-runner.ts:78 submitTurnAndCollect`. This is the one prompt where Fabric hands Hermes a task
that is *pure exploration* (drive a browser, find a way to get data), so it is where the boundary should
be most visible.

**Not modified.** Classification only.

## G.1 The file's own claim

`exploration-goal.ts:1-6` states:

> Fabric gives the executing agent a business NEED + an EVIDENCE CONTRACT + execution boundaries.
> It never supplies endpoint names, token names, signing machinery, concrete script filenames, or the
> methods discovered in the first acquisition (SC3). The agent chooses HOW; Fabric verifies WHAT came back.
> The forbidden-vocabulary contract test pins this.

A contract test does pin the forbidden vocabulary — so the "do not leak the answer" half is enforced. The
audit below tests the other half: does Fabric also refrain from dictating *how*.

## G.2 Segment classification

| # | segment (paraphrased) | class | verdict |
|---|---|---|---|
| 1 | `# Real Historical Business Data Acquisition — {shop}` | `GOAL` | keep |
| 2 | "acquire REAL, VERIFIABLE historical data for {shop} from **JD 商智 (jdsz.jd.com)**" | `CAPABILITY_BINDING` | keep — naming the *source system* is the business need, not the method. (The forbidden list bans endpoint/token/signing, not the source's identity.) |
| 3 | Business need block: subject, source, requested window, "Domains required: **trade + orders** — (a) trade-level operating metrics (e.g. total money, orders, visitors, conversion …); (b) full order-level detail (per-row business time, order identifier, product identity, quantity, amount, payment status)" | `EVIDENCE_REQUIREMENT` + **`EXPLORATION_METHODOLOGY`** | **keep** — this is Fabric defining *what evidence must exist in the domain*, and it is the load-bearing part: it tells the Agent that "trade" means money/orders/visitors/conversion as the source exposes them, and that "orders" means row-level detail with business time and status. Without it the Agent guesses what to collect. |
| 4 | "The requested window is a NEED, not a promise… Record the **actual** window truthfully. Never relabel a source date… Missing/unavailable facts must be reported explicitly as gaps." | `EVIDENCE_SEMANTICS` + `CONTRACT` | **keep** — the anti-fabrication rule, the single most important line in the builder |
| 5 | **"Step 1 — Inventory existing assets before exploring (required)"** + "Before touching the browser, inventory what already exists… Prefer reusing an existing asset over rebuilding." | **`EXECUTION_HOW`** | **move to Hermes** — a required first step and a control-flow ordering. The *preference* for reuse is a legitimate engineering policy, but "before touching the browser" is sequencing, which is the Agent's to schedule. |
| 6 | "Your final report AND result.json MUST partition everything you used into **reused / rediscovered / newly built**" | `OUTPUT_SCHEMA` | keep — a reporting contract, and it is what makes reuse auditable |
| 7 | **"Step 2 — Acquire using whatever reasonable path you choose"** + "Any path is allowed: existing Fabric capabilities, existing repository code or scripts, browser automation, Python, your own temporary tools — whichever you judge most likely to produce real verified data. Neither path is forced." | `CONTRACT` (**permission**) | **keep** — this is the boundary stated explicitly, and it is the opposite of an execution instruction |
| 8 | Execution boundaries: real browser on **:9222** only; login is a human boundary → BLOCKED-ENVIRONMENT; **reuse an existing tab**; at most **one debugger connection per invocation** and **one page object**; never loop "open a new tab + navigate"; do not launch a separate browser | `CONTRACT` (safety / operator boundary) | **keep** — these protect the operator's live Chrome; the measured reason is that looping open-new-tab steals the foreground and invalidates the run. The *reason* is a constraint, even though "one page object" is implementation-shaped. |
| 9 | "If you create new helper code, place it inside the intake directory; do not modify production application code." | `CONTRACT` (write boundary) | keep |
| 10 | "Step 3 — Deliver the Evidence Contract… 'I found the endpoint' without persisted data is not completion. Partial real data with an honest partial status is valid; pretending partial is complete is not." | `EVIDENCE_REQUIREMENT` + `EVIDENCE_SEMANTICS` | keep |
| 11 | **A. Four canonical structured files** (exact names + full JSON shapes) | `OUTPUT_SCHEMA` (machine interface) | keep — Fabric's freezer consumes these. **But** it is a detailed schema written as prose; a schema file would carry it without a paragraph per field. |
| 12 | **B. Raw evidence** — raw responses/downloads/screenshots under `raw/`; "**Keep source field names** in raw artifacts… Preserve source fields rather than forcing a pre-defined schema" | `CONTRACT` (anti-normalization / provenance) | **keep** — this is "only normalize representation, never the fact" encoded as an instruction |
| 13 | **C. `result.json`** — requested vs **actual** window, per-domain status, gaps, artifacts, provenance, reconciliation, stop_reason, reuse_report | `OUTPUT_SCHEMA` + `EVIDENCE_SEMANTICS` | keep — the machine-readable evidence result |
| 14 | "**Reconciliation is mandatory** when both domains have data: sum order money from header rows per day and compare it with the trade-domain total money for the same actual window." | `EVIDENCE_SEMANTICS` (**cross-source verification**) + a thin `EXECUTION_HOW` residue ("sum header rows per day") | **keep as methodology** — "two independent sources must agree before the data is trusted" is exactly a domain verification method. The arithmetic detail is the Agent's. |
| 15 | **D. `candidate.json`** — a capability candidate, explicitly "NOT self-promotion into a formal capability — no registration is performed" | `OUTPUT_SCHEMA` + `CONTRACT` (governance boundary) | keep |
| 16 | **Failure semantics** — BLOCKED-INFRASTRUCTURE / BLOCKED-ENVIRONMENT / EXPLORATION FAILED / ACQUISITION FAILED / VERIFICATION FAILED | `CONTRACT` (output vocabulary) | keep |
| 17 | **"Do not wait on the operator for implementation hints. Do not ask questions. If you find yourself looping on one failing approach, switch path or stop; **do not retry the same path more than 3 times**."** | **`EXECUTION_HOW`** | **move to Hermes** — this is a literal retry budget and an explicit "switch path" control-flow instruction. |
| 18 | "End with ONE final message containing EITHER a complete record summary … OR an explicit failure classification with the reason. Do not leave the turn open-ended." | `CONTRACT` (turn-termination) | keep |

## G.3 Result

| class | segments | share of builder |
|---|---|---|
| `GOAL` | 1 | small |
| `EVIDENCE_REQUIREMENT` / `EVIDENCE_SEMANTICS` | 3, 4, 10, 12, 13, 14 | **largest — the load-bearing part** |
| `CONTRACT` (permissions, safety, boundaries, vocabulary, termination) | 7, 8, 9, 15, 16, 18 | large |
| `OUTPUT_SCHEMA` | 6, 11, 13, 15 | large |
| **`EXECUTION_HOW`** | **5, 17** (+ thin residues in 8, 14) | **two segments — the only genuine violations** |

The builder is **much closer to the boundary than the cognition prompts are.** Its failures are narrow and
fixable: a required "inventory first" step, and a retry budget.

One asymmetry worth recording: the forbidden-vocabulary pin bans **concrete script filenames** (how you
fetch) while the same prompt *requires* **exact output filenames** (what you deliver). That distinction —
`how you fetch` is the Agent's, `what you deliver` is Fabric's — is the boundary working correctly, and it
is the cleanest statement of it anywhere in the repo.

## G.4 If Fabric were to guide exploration of Tmall / Amazon

**Methodology that should stay in Fabric long-term** (source-agnostic, domain-level):

1. **The need is not a promise** — record the actual window truthfully; never relabel a source date to
   match the requested window; never synthesise missing days.
2. **Domains as evidence requirements** — say what must *exist* (trade-level metrics: money, orders,
   visitors, conversion; order-level detail with business time, identifier, product identity, quantity,
   amount, status), and let the Agent discover which surfaces expose them.
3. **Honest partiality** — partial real data with an explicit status is a valid outcome; pretending partial
   is complete is not.
4. **Raw preservation** — keep source field names; preserve source semantics rather than forcing a
   pre-defined schema.
5. **Cross-source verification** — when two domains can be reconciled, they must be; disagreement is a
   finding, not something to smooth over.
6. **Provenance per artifact** — source system, surfaces touched, method, timestamp, and the files that
   prove it worked.
7. **A failure vocabulary** that separates infrastructure, environment, exploration, acquisition and
   verification failures — so a missing result can be triaged instead of re-run blindly.
8. **A reuse report** — what was reused, rediscovered, newly built.
9. **Boundaries** — which credentials/sessions/foreground resources the Agent must not disturb, and where
   "login required" means stop-and-report rather than attempt.

**Execution that must stay with Hermes, for any source:**

- which tool, script or API to try, and in what order;
- how many attempts before switching; whether to parallelise; how to search;
- how to hold a browser session (tabs, connections, page objects);
- how to compute derived values from what was retrieved;
- how to decompose the work and when to stop trying.

**The line, stated once:** Fabric may say *"we need the actual per-day order rows for 09-02..09-12,
reconciled against the source's own trade total, and here is what counts as verified"*. Fabric may not say
*"inventory the repo first, then try the browser, and do not retry more than three times."*
