# agentFabric Prompt / Contract / Evidence Audit

Read-only architecture audit. **No code was changed, no prompt was rewritten, no capability was added,
no Hermes/Skill/Memory was touched, and P0013.4's acceptance status is unchanged.**

Question under audit:

> **Fabric defines WHAT must be achieved / constrained. Hermes decides HOW to achieve it.**
> Does the current code hold that boundary?

## Method

Everything here is either **measured** from the working tree or **read** from primary artifacts; nothing
is inferred from filenames.

| evidence | how obtained |
|---|---|
| prompt inventory | `grep -rn "submitPrompt\|submitTurnAndCollect"` across `apps/ platform/ scripts/` — the only call sites that reach Hermes |
| prompt sizes & section breakdown | `scripts/audit-prompt-inventory.ts` calls the **shipped builders** and prints byte size per section |
| Replay/Production fork analysis | same run, comparing section byte sizes between the two builders |
| capability inventory | `data/fabric-workspace/capabilities/INDEX.md` + its generator `fabric-workspace/projector.ts:176-180` (the icon legend is code, not prose) |
| frozen-dataset facts | `data/jd_acquisition_20260914_0231/raw/*.json` inspected directly (captured HTTP calls) |
| prior measurements reused | `artifacts/p0013-4-direct-hermes-package/{heavy-prompt-anatomy,data-exposure-report}.md` |

Reproduce the size measurements:

```
npx tsx scripts/audit-prompt-inventory.ts
```

## Deliverables

| file | Part | answers |
|---|---|---|
| `README.md` | — | scope, method, evidence sources |
| `prompt-inventory.md` | A | every path that actually sends text to Hermes |
| `prompt-section-classification.md` | B | each section classified, with sizes and code locations |
| `replay-vs-production.md` | C | shared vs forked contract, size comparison |
| `evidence-acquisition-map.md` | D | the real acquisition chain, per-domain table, A–E classes |
| `goal-vs-how.md` | E | what is Fabric's, what is Hermes' |
| `findings.md` | — | KEEP / MOVE / ENGINEERING GAP |

## Headline numbers

- **8** distinct Fabric→Hermes prompt paths (2 of them P0013.4-era variants of Replay).
- Production investigation prompt: **38,995 B** — with **zero** evidence injected. Replay heavy:
  **33,299 B** with zero evidence. Replay light variant: **4,513 B**.
- In the real Replay prompt, **~12 % of bytes are the day's data; ~88 % are contract/format/explanation
  prose repeated byte-for-byte every day.**
- Fabric's own capability index declares **11** capabilities; exactly **1** is `verified`
  (`trade.overview`). The Replay frozen dataset contains **2** capabilities / **4** data types.
- `exploration-goal.ts` states the WHAT/HOW principle in its own header comment **and** prescribes a
  3-step method in the prompt body — the audit's cleanest in-repo example of the boundary being asserted
  and crossed in the same file.
