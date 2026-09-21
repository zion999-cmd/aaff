# Direct-Hermes test package — replicating what Fabric sends during Historical Replay

> ## 标注 / LABEL
>
> **类型**：`DIRECT-HERMES TEST PACKAGE`（人工复刻 Fabric → Hermes 输入的测试包）
> **用途**：**仅用于执行速度对比** —— 由人工扮演 Fabric，把相同的 prompt 交给 Hermes。
> **不是** P0013.4 验收结果；**不标记** 任何 Success Criterion 通过；**不评价** 业务质量。
> **内容真实性**：prompt 文本由 agentFabric 自身的 `buildReplayInvestigationPrompt` 生成，
> 与真实 Replay 会话抓取逐字节一致（见 `forensic-report.md` §1）。
> **已知不忠实项**：11 个文件中的 prior-cognition 块为空（见下文 §3）。
>
> 生成时间：2026-09-21 · 源 run：`486e368e-2f99-4f7d-b87e-2e8ce23dc730` · 时间范围：2026-09-02 → 2026-09-12

Purpose: let you play Fabric by hand and hand Hermes the **same** work, so you can compare execution
speed. Nothing here is rewritten, summarised, or "improved" — see `forensic-report.md` §1 for the
byte-identical fidelity check against two prompts captured from a real run.

```
p0013-4-direct-hermes-package/
├── README.md              ← this file
├── forensic-report.md     ← how Fabric assembles the prompt; source attribution; the 5 checks
├── context-index.md       ← per-day background data (evidence rows, universe, enrichments, prior)
├── prompts/               ← THE 11 PROMPTS TO SEND (day-09-02 … day-09-12)
│   ├── day-2026-09-02-prompt.txt  …  day-2026-09-12-prompt.txt
│   └── prompt-index.md
└── real-captures/         ← verbatim prompts from a real Replay session, for reference
    ├── day-2026-09-02-prompt.txt   (byte-identical to prompts/)
    └── day-2026-09-03-prompt.txt   (includes a real prior-cognition block)
```

## 1. How to send it

Fabric sends **one complete prompt per business day**, in **one session reused across days**. Reproduce
that:

1. Start one Hermes session in the `agentFabric` directory.
2. Send `prompts/day-2026-09-02-prompt.txt` **verbatim** as a single message.
3. Let Hermes finish the whole turn (it will call tools; see §4).
4. Then send `prompts/day-2026-09-03-prompt.txt` verbatim, in the **same session**.
5. …continue through `day-2026-09-12-prompt.txt`.

Do **not** paste two day-prompts into one message, and do not merge them into an 11-day prompt — that
matches nothing Fabric does (forensic-report §6.5).

Each file is the day's entire instruction: no preamble from you, no framing, no extra context. The
first line already states the business day.

## 2. What Fabric would do with the reply

For each day, Fabric: parses the reply as JSON against the Investigation Contract, runs fail-closed
obligations (`observed_facts`, five-dimension coverage, gap↔UNAVAILABLE resolution pairing, stop-reason
legality, and the P0013.4 grain/business-time check on any `satisfied` requirement), and persists the
snapshot. A reply that fails those is a **FAILED day**, not a completed one.

If you only care about speed, you can ignore this — but it is the difference between "the model
answered" and "the day completed".

## 3. What is faithful, and the one thing that is not

Faithful:

- the prompt text is Fabric's own output, byte-identical to a real run for the days that can be checked;
- per-day visible evidence, Evidence Universe, and dataset identifiers are the real ones for this run;
- every constraint, obligation and prohibition is preserved untouched — nothing was removed to make the
  test easier.

Not faithful — **the prior-cognition blocks are empty for all 11 days.** A real run fills them from its
own persisted snapshots, and that grows:

| day | prior-cognition entries in a real run |
|---|---|
| 09-02 | 0 |
| 09-03 | 1 |
| … | … |
| 09-12 | 10 (one per completed prior day — the SQL is `business_date < T`, no LIMIT) |

Measured cost of one entry: day 09-02 → 09-03 grows 36,159 → 38,837 bytes with +1 entry and +3 evidence
rows; the prior-judgment text alone is ≈1.6 KB. So a real day-11 prompt would be roughly **15 KB larger**
than the file here.

This is not fixable from this package: a faithful day-N prior block is *by definition* made of the days
your run has not produced yet. Compare speed on day 09-02 (where the package is exact), and treat the
later days as slightly lighter than the real thing.

Two smaller notes:

- `visibleEnrichmentsAt()` returns **0** for every day of this run, so the enrichments section renders
  its empty-state line in all 11 prompts. That is the real state, not an omission.
- the `run_id` inside the prompt is a real run id, carried only because Fabric stamps
  `"situationId": "<runId>-<businessDate>"`. It is an identifier, not an instruction.

## 4. Tools — what the prompt already contains vs what Hermes must fetch

| Content | In the prompt | Requires a tool call |
|---|---|---|
| visible evidence rows (id, capability/data_type, business_date, bucket, path, size, hash) | ✅ | |
| rendered KPI / trend / per-order summary text | ✅ | |
| Evidence Universe inventory + each kind's declared temporal grain and subjects | ✅ | |
| dataset path + manifest hash | ✅ | |
| dataset **manifest file contents** | ❌ | not available at all |
| full per-order rows (price bands, ex-top1 AOV, top orders, SKU mix) | ❌ | `mcp__fabric__fabric_replay_retrieve_orders` |
| Knowledge pages | ❌ (only the navigation rule) | `read_file knowledge/…` |
| Hermes' own skills | ❌ | `skill_view` |
| tool schemas | ❌ | `tool_describe` |

The prompt forbids live acquisition explicitly: *"Do NOT call
`mcp__fabric__fabric_execute_capability` or the browser tools — no LIVE acquisition"*, and names
`fabric_replay_retrieve_orders` as *"the only permitted ACQUISITION tool"*.

Observed in real Replay days: `read_file` (Knowledge), `skill_view`, `tool_describe`,
`tool_call` → `fabric_replay_retrieve_orders`, and one attempted `execute_code` that the tool layer
**blocked**. Note the Replay prompt does **not** carry the Production prompt's side-effect-tool advisory
(`terminal` / `execute_code` / `run_command` / file writes) — that prohibition is enforced by the tool
layer, not stated in the prompt.

**For a speed comparison, keep your toolset comparable.** If your session has `fabric` MCP registered
with the replay retrieval route and the same knowledge tree, the work is comparable; if not, the model
will fail differently and the timing will not be about Fabric.

## 5. Keeping the comparison honest

- Send each prompt **verbatim** — no trimming, no "just the important parts".
- One session, sequential days, one message per day.
- Same model and provider as the run you are comparing against (this package makes no assumption; it
  only changes nothing).
- Record wall-clock per day and note whether the turn ended in a valid contract or failed — Fabric
  distinguishes those, so a fast failure is not a fast day.

## 6. Reference: what the real ones look like

`real-captures/` holds the two prompts captured from an actual Replay session.
`day-2026-09-02-prompt.txt` is byte-identical to `prompts/day-2026-09-02-prompt.txt`.
`day-2026-09-03-prompt.txt` differs from the package copy in exactly two places — the
`## Prior days' judgments` and `## Prior Cognition` blocks — which is the §3 gap made visible.

Per-day background data (evidence ids, held inventory, enrichments, prior entries) is listed in
`context-index.md` if you want to cross-check what a given day's prompt was built from.
