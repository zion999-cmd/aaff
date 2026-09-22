# Part B + E — The eleven suspect sections, re-audited

For each: **Methodology or Execution HOW?** · does it hold stable domain value? · should it live in a
system-level stable layer? · is it just verbosity? · is it already runtime/schema-enforced?

The four tests (Part E) are applied verbatim:

- **T1** delete it → the Agent still knows *what to explore*, only not a fixed step order → `EXECUTION_HOW`
- **T2** delete it → the Agent loses domain direction, evidence judgement or falsification awareness → `EXPLORATION_METHODOLOGY`
- **T3** delete it → the system still enforces legality in code → `REDUNDANT / RUNTIME-ENFORCED`
- **T4** it only describes current business facts → `CONTEXT / EVIDENCE`

---

### 1. `## Investigation Workflow` — 2,628 B · **MIXED (mostly T1)**

| question | answer |
|---|---|
| Methodology or Execution? | **Mostly Execution.** It is a numbered control flow: read evidence → read Knowledge → hold prior → form ≤3 hypotheses → ask what changed → resolve before declaring gaps → question step → stop → emit. |
| Stable domain value? | **Partly.** Steps 4/5/7 encode real methodology (bounded hypothesis count; ask what today's evidence *changes*; raise a Business Question only if its answer moves the judgement). Steps 1/2/6/9 are execution ordering, and step 6 contains a concrete tool directive (`call fabric_replay_retrieve_orders`). |
| T1 / T2 | Deleting the *ordering* leaves the Agent fully aware of what to explore (T1). Deleting steps 4/5/7 removes some methodology (T2) — but that content is already stated in the Sufficiency and continuity sections, so nothing is lost. |
| Stable layer? | **No.** Not as written. A fixed 9-step procedure is the strongest candidate in the whole prompt for removal. |
| Verbosity? | Partly — it restates methodology already present elsewhere, plus an execution order. |
| Runtime-enforced? | No. |
| **Verdict** | **2,100 B `EXECUTION_HOW` (remove) / 528 B `METHODOLOGY` (already covered elsewhere → redundant).** |

### 2. Coverage / metric hints — 1,366 B · **MIXED, and the methodology half is load-bearing**

| question | answer |
|---|---|
| Methodology or Execution? | **Methodology.** `"orders"（订单结构）: 订单量、客单价/平均订单金额、订单大小分布、客户数、退款/大单扰动` tells the Agent which variables carry business meaning in this domain. |
| T2 | Deleting the hints leaves the Agent with five dimension *labels* and no idea what constitutes evidence for them → it would guess. **This is exactly the "loses domain direction" case.** |
| Stable layer? | **Yes — the strongest candidate for a system-level stable prefix.** It is domain knowledge that does not change per turn or per run. |
| Verbosity? | No. |
| Runtime-enforced? | The *requirement* to cover five dimensions is enforced (`analysis-obligations.ts`); the hints are not. |
| **Verdict** | **766 B `EXPLORATION_METHODOLOGY` (KEEP — promote to a stable layer) / 600 B `CONTRACT` (the completeness requirement).** |

### 3. `### Decision-changing Evidence` — 834 B · **METHODOLOGY (T2)**

| question | answer |
|---|---|
| Methodology or Execution? | **Methodology.** It defines what makes an evidence request worth making: "has a REALISTIC CHANCE of changing your current Hypothesis, Judgment or Recommendation", plus the four invalid grounds (data happens to exist / field missing / "might help" / nominal coverage). |
| T2 | Deleting it, the Agent reverts to opening requirements whenever a column is missing — precisely the failure P0013.4 was created to fix (the 11/11-observe run). |
| Stable layer? | **Yes.** This is the anti-gap-inflation rule. |
| Verbosity? | The four invalid grounds are illustrative but each corresponds to an observed failure mode. Acceptable. |
| Runtime-enforced? | Partly — Fabric can *refute* a claim (`evaluateRequirementSufficiency`) but cannot decide whether a question was worth asking. That judgement must be stated. |
| **Verdict** | **834 B `EXPLORATION_METHODOLOGY` (KEEP).** |

### 4. Evidence Sufficiency criteria — 594 + 1,034 B · **METHODOLOGY (T2), with a semantics half**

| question | answer |
|---|---|
| Methodology or Execution? | **Methodology.** "Does the remaining Unknown still have a realistic chance of changing the current Judgment? If it does not, stop." That is a domain judgement rule. |
| T2 | Deleting it, the Agent either never stops (unbounded investigation) or stops arbitrarily — both observed. |
| Stable layer? | **Yes.** |
| Verbosity? | Mild. "There is no percentage, no ratio, no threshold, no N of M" is a prohibition against a design Fabric already rejected; one line would carry it. |
| Runtime-enforced? | The ban on scores is not machine-checkable; the *both-directions* check is. |
| **Verdict** | **~1,000 B `METHODOLOGY` (KEEP) / ~700 B `EVIDENCE_SEMANTICS` (Resolution ≠ Sufficiency) — KEEP.** |

### 5. `## Cognition continuity` — 1,927 B · **MIXED: real methodology + writing style**

| question | answer |
|---|---|
| Methodology or Execution? | **Methodology** for the first ~900 B: one continuous reading; carry the prior forward silently; understanding must answer what continued / changed / is still unknown. **Not methodology** for the ~1,000 B forbidden-pattern catalogue. |
| T2 | Deleting the first half, the Agent re-derives its reading every day (the per-day-scorecard regression the section was written to fix). |
| Stable layer? | The methodology half: **yes**. The pattern catalogue: no. |
| Verbosity? | The catalogue is the clearest verbosity in the prompt: five bullets describing *how to write*, several of which duplicate the Threshold-provenance line and the Sufficiency section. |
| Runtime-enforced? | No, but it is the kind of style guidance a Skill owns. |
| **Verdict** | **900 B `METHODOLOGY` (KEEP in a stable layer) / 1,027 B `REDUNDANT` (drop or move to a Hermes skill).** |

### 6. Forbidden-pattern catalog — (inside #5) · **prompt debt**

| question | answer |
|---|---|
| Methodology or Execution? | Neither. It is output *style*. |
| Stable domain value? | Low, and it is **negative knowledge** ("don't write X") that only makes sense against a model that was writing X. |
| T2 | Deleting it does not change what the Agent explores. |
| Verbosity? | Yes — "①命中 ②未命中", "2/2", "分支 A/B/C 计分", "严格门禁", "软化口径" enumerate a contamination that has since been isolated at the source. |
| Runtime-enforced? | No. |
| **Verdict** | **`REDUNDANT` — belongs in a Hermes skill (or nowhere), not in Fabric's per-turn prompt.** |

### 7. Production Tool Surface — ~2,384 B · **EXECUTION_HOW (T1)**

| question | answer |
|---|---|
| Methodology or Execution? | **Execution.** "Use `tool_search` at most once per session", "call ONCE per evidence gap; if it fails retry ONCE", "allowed pattern: A → B → C", "do NOT read `platform/` / `apps/`" — retry policy, call budget, and a search strategy. |
| T2 | Deleting it, the Agent still knows what to explore; it just schedules its own calls. |
| Stable layer? | **No.** Except one line that is contract: *which* tools are permitted (that already lives in the Runtime Trust Boundary). |
| Runtime-enforced? | The side-effect-tool prohibition is enforced at the tool layer (measured: `execute_code` is blocked by the consent gate, not by the prompt). |
| **Verdict** | **~2,000 B `EXECUTION_HOW` (remove) / ~380 B `CAPABILITY_DESCRIPTION` (keep: what can be called).** |

### 8. `## Output Language` — 256 B (Replay) / 2,144 B (Production) · **schema prose + debt**

| question | answer |
|---|---|
| Methodology or Execution? | Neither — output format. |
| Stable value? | The *rule* ("business prose zh-CN; canonical status values stay English") is worth one line. |
| T2 | No effect on exploration. |
| Verbosity? | **Production spends 8× Replay's bytes enumerating which fields must be Chinese.** That is pure debt, and Replay's 256 B version is the proof. |
| Runtime-enforced? | Not by schema (language is not validated), so one line must stay. |
| **Verdict** | **256 B `OUTPUT_SCHEMA` (KEEP) / 1,644 B `REDUNDANT` (Production: drop the enumeration).** |

### 9. `Three Concepts` / `Per-claim + Threshold provenance` — 401 B / 627 B · **debt + contract**

| question | answer |
|---|---|
| Methodology or Execution? | `Three Concepts` — neither; it restates `confirmed_action: null` (already in the Trust Boundary) and Observed-vs-Inferred (already in Epistemic Layers). `Per-claim + Threshold provenance` — **contract**: strong claims need refs; thresholds need a provenance tag. |
| T3 | The provenance rules are **already enforced** — `claim_evidence_refs` and `thresholds[]` are schema fields and `validateAnalysisObligations` rejects contract-invalid turns. |
| **Verdict** | **`Three Concepts` 401 B `REDUNDANT` (drop). Provenance 627 B `CONTRACT` (keep, but it can shrink to the rule without the explanation).** |

### 10. Knowledge guidance — `## Knowledge` 1,973 B (both paths) + `## Knowledge guidance (post-script)` 1,444 B (Production only)

| question | answer |
|---|---|
| Methodology or Execution? | **MIXED.** "Knowledge is a prior about how such businesses behave; it is never evidence about this shop today" is `EVIDENCE_SEMANTICS` and load-bearing. "Knowledge tells you HOW to read this kind of situation — which structural dimensions matter, how to tell a real anomaly from ordinary variation, what the professional diagnostic order is" is **methodology** — but note it *describes* methodology rather than *containing* it: the actual professional knowledge lives in `knowledge/`. The index-first navigation rule is **execution** (a search strategy). |
| T2 | Deleting the boundary loses falsification discipline (Knowledge laundering into fact). Deleting the navigation rule does not lose domain direction — the Agent can find pages its own way. |
| Stable layer? | The boundary: yes. The navigation: no. |
| **Verdict** | **500 B `EVIDENCE_SEMANTICS` + 800 B `METHODOLOGY` (keep) / 673 B `EXECUTION_HOW` (remove). The 1,444 B Production post-script is `METHODOLOGY` but duplicative of the shared section → consolidation candidate, not deletion.** |

### 11. Replay retrieval binding — 1,763 B · **CAPABILITY + contract + execution**

| question | answer |
|---|---|
| Methodology or Execution? | **Mixed.** Which tool is permitted and the five `query` values are `CAPABILITY_DESCRIPTION` (contract). The T-bounded semantics ("the visible slice is cumulative up to T, never future") is contract. But: *"for a SINGLE day's price bands filter rows to `date == businessDate` yourself"* and *"compute ex-top1 AOV and price bands yourself from the rows"* are **execution instructions** — data manipulation steps. |
| T2 | Deleting the capability description removes access. Deleting the filtering note makes the Agent misread a cumulative slice as a daily one — which is a *data semantics* issue, not a step. |
| Stable layer? | The capability + slice semantics: yes. |
| **Verdict** | **900 B `CAPABILITY_DESCRIPTION` + 300 B `CONTRACT` (keep) / 563 B `EXECUTION_HOW` (reframe as slice semantics, drop the "compute it yourself" steps).** |

---

## Part E — results in one table

| section | T1 (execution) | T2 (methodology) | T3 (runtime-enforced) | verdict |
|---|---|---|---|---|
| Investigation Workflow | ✅ dominant | partial (duplicated) | — | mostly EXECUTION_HOW |
| Coverage metric hints | — | ✅ | requirement only | METHODOLOGY, keep |
| Decision-changing Evidence | — | ✅ | only refutation | METHODOLOGY, keep |
| Sufficiency criteria | — | ✅ | only one direction | METHODOLOGY, keep |
| Cognition continuity (1st half) | — | ✅ | — | METHODOLOGY, keep |
| Forbidden-pattern catalog | — | — | — | REDUNDANT |
| Production Tool Surface | ✅ | — | side-effect ban | EXECUTION_HOW |
| Output Language (enumeration) | — | — | not validated | REDUNDANT (keep 1 line) |
| Three Concepts | — | — | ✅ (schema) | REDUNDANT |
| Per-claim/Threshold provenance | — | — | ✅ (schema + validator) | CONTRACT but compressible |
| Knowledge: boundary | — | partial | — | EVIDENCE_SEMANTICS, keep |
| Knowledge: navigation | ✅ | — | — | EXECUTION_HOW |
| Replay retrieval binding | partial | — | — | CAPABILITY + CONTRACT; drop the "compute it yourself" steps |
