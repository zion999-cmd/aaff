#!/usr/bin/env python3
"""Read-only audit helper — recompute prompt byte ownership under the revised
Fabric/Hermes boundary.

This does NOT read the prompts themselves; it applies an explicit, auditable
allocation table to the section sizes measured by
`scripts/audit-prompt-inventory.ts`. Every number is either a measured section
size or an allocation stated here, so the totals can be checked and challenged
line by line.

Categories (second-pass boundary):
  GOAL                     what this turn must achieve
  CONTRACT                 legality, boundary, provenance, stop/output vocabulary
  EXPLORATION_METHODOLOGY  how this DOMAIN should be explored  (Fabric keeps)
  EXECUTION_HOW            how THIS RUN is executed             (Hermes owns)
  EVIDENCE_SEMANTICS       what evidence means / permits
  CONTEXT                  current situation, carried state
  EVIDENCE                 the day's facts
  CAPABILITY_DESCRIPTION   what can be queried or called
  OUTPUT_SCHEMA            the shape of the reply
  REDUNDANT                already enforced elsewhere, or prose with no semantic value

Usage: python3 scripts/audit-prompt-ownership.py
"""

from __future__ import annotations

from collections import defaultdict

# (section, bytes, {category: bytes}) — allocations must sum to the section size.
REPLAY: list[tuple[str, int, dict[str, int]]] = [
    ("preamble", 83, {"GOAL": 83}),
    ("Runtime Trust Boundary", 1136, {"CONTRACT": 1136}),
    ("Run context", 238, {"CONTEXT": 238}),
    ("Current evidence", 184, {"EVIDENCE": 184}),
    ("Evidence Universe", 834, {"EVIDENCE_SEMANTICS": 700, "CAPABILITY_DESCRIPTION": 134}),
    ("Operator enrichments", 1652, {"CONTEXT": 60, "EVIDENCE_SEMANTICS": 420, "REDUNDANT": 1172}),
    ("Evidence Resolution", 1701, {"EVIDENCE_SEMANTICS": 850, "CONTRACT": 251,
                                   "EXECUTION_HOW": 400, "OUTPUT_SCHEMA": 200}),
    ("Question-driven header", 205, {"GOAL": 205}),
    ("Business Question", 803, {"EXPLORATION_METHODOLOGY": 803}),
    ("Decision-changing Evidence", 834, {"EXPLORATION_METHODOLOGY": 834}),
    ("Evidence Requirement", 1736, {"OUTPUT_SCHEMA": 900, "EVIDENCE_SEMANTICS": 700,
                                    "EXPLORATION_METHODOLOGY": 136}),
    ("Evidence Sufficiency", 594, {"EXPLORATION_METHODOLOGY": 594}),
    ("Resolution vs Sufficiency", 1034, {"EVIDENCE_SEMANTICS": 700, "EXPLORATION_METHODOLOGY": 334}),
    ("Investigation progress", 485, {"EXPLORATION_METHODOLOGY": 485}),
    ("Stop semantics", 762, {"CONTRACT": 400, "EXPLORATION_METHODOLOGY": 362}),
    ("Replay V1 retrieval binding", 1763, {"CAPABILITY_DESCRIPTION": 900, "EXECUTION_HOW": 563,
                                           "CONTRACT": 300}),
    ("Prior days' judgments", 92, {"CONTEXT": 92}),
    ("Prior Cognition", 582, {"CONTEXT": 350, "CONTRACT": 232}),
    ("Epistemic Layers", 1365, {"CONTRACT": 700, "EXECUTION_HOW": 665}),
    ("Knowledge", 1973, {"EXPLORATION_METHODOLOGY": 800, "EVIDENCE_SEMANTICS": 500,
                         "EXECUTION_HOW": 673}),
    ("Per-claim + Threshold provenance", 627, {"CONTRACT": 627}),
    ("Three concepts", 401, {"REDUNDANT": 401}),
    ("Output language", 256, {"OUTPUT_SCHEMA": 256}),
    ("Cognition continuity", 1927, {"EXPLORATION_METHODOLOGY": 900, "REDUNDANT": 1027}),
    ("Analysis Target", 984, {"GOAL": 984}),
    ("Mandatory coverage", 1366, {"CONTRACT": 600, "EXPLORATION_METHODOLOGY": 766}),
    ("Stop-rule decision", 1290, {"CONTRACT": 1290}),
    ("Investigation Workflow", 2628, {"EXECUTION_HOW": 2100, "EXPLORATION_METHODOLOGY": 528}),
    ("Formal output obligations", 922, {"REDUNDANT": 922}),
    ("Output shape", 4813, {"REDUNDANT": 4813}),
]

PRODUCTION: list[tuple[str, int, dict[str, int]]] = [
    ("preamble", 74, {"GOAL": 74}),
    ("Runtime Trust Boundary", 973, {"CONTRACT": 973}),
    ("Three Concepts", 1181, {"REDUNDANT": 1181}),
    ("Tool Surface — Read by Purpose", 36, {"EXECUTION_HOW": 36}),
    ("ALLOWED — read-only context retrieval", 808, {"EXECUTION_HOW": 600,
                                                    "CAPABILITY_DESCRIPTION": 208}),
    ("ALLOWED — evidence acquisition", 751, {"EXECUTION_HOW": 500,
                                             "CAPABILITY_DESCRIPTION": 251}),
    ("ADVISORY — tool discovery", 228, {"EXECUTION_HOW": 228}),
    ("ADVISORY — source code exploration", 297, {"EXECUTION_HOW": 297}),
    ("ADVISORY — side-effect tools", 264, {"EXECUTION_HOW": 264}),
    ("Cognition continuity", 1927, {"EXPLORATION_METHODOLOGY": 900, "REDUNDANT": 1027}),
    ("Analysis Target", 984, {"GOAL": 984}),
    ("Mandatory coverage", 1366, {"CONTRACT": 600, "EXPLORATION_METHODOLOGY": 766}),
    ("Stop-rule decision", 1290, {"CONTRACT": 1290}),
    ("Evidence Resolution", 2020, {"EVIDENCE_SEMANTICS": 900, "CONTRACT": 300,
                                   "EXECUTION_HOW": 520, "OUTPUT_SCHEMA": 300}),
    ("Question-driven header", 205, {"GOAL": 205}),
    ("Business Question", 803, {"EXPLORATION_METHODOLOGY": 803}),
    ("Decision-changing Evidence", 834, {"EXPLORATION_METHODOLOGY": 834}),
    ("Evidence Requirement", 1736, {"OUTPUT_SCHEMA": 900, "EVIDENCE_SEMANTICS": 700,
                                    "EXPLORATION_METHODOLOGY": 136}),
    ("Evidence Sufficiency", 594, {"EXPLORATION_METHODOLOGY": 594}),
    ("Resolution vs Sufficiency", 1034, {"EVIDENCE_SEMANTICS": 700,
                                         "EXPLORATION_METHODOLOGY": 334}),
    ("Investigation progress", 485, {"EXPLORATION_METHODOLOGY": 485}),
    ("Stop semantics", 762, {"CONTRACT": 400, "EXPLORATION_METHODOLOGY": 362}),
    ("Investigation Workflow", 2769, {"EXECUTION_HOW": 2200, "EXPLORATION_METHODOLOGY": 569}),
    ("Situation", 186, {"CONTEXT": 186}),
    ("Prior Human Guidance", 300, {"CONTEXT": 300}),
    ("Current evidence", 97, {"EVIDENCE": 97}),
    ("Output Language", 2144, {"OUTPUT_SCHEMA": 500, "REDUNDANT": 1644}),
    ("Recommendation kind", 1354, {"CONTRACT": 554, "EXECUTION_HOW": 800}),
    ("Epistemic Layers", 2300, {"CONTRACT": 700, "EXECUTION_HOW": 1600}),
    ("Knowledge", 1973, {"EXPLORATION_METHODOLOGY": 800, "EVIDENCE_SEMANTICS": 500,
                         "EXECUTION_HOW": 673}),
    ("Per-claim provenance", 756, {"CONTRACT": 756}),
    ("Threshold provenance", 1069, {"CONTRACT": 1069}),
    ("Prior Cognition", 725, {"CONTEXT": 400, "CONTRACT": 325}),
    ("Formal output obligations", 922, {"REDUNDANT": 922}),
    ("Output shape", 4269, {"REDUNDANT": 4269}),
    ("Knowledge guidance (post-script)", 1444, {"EXPLORATION_METHODOLOGY": 1444}),
]

FABRIC_LEGITIMATE = ("GOAL", "CONTRACT", "EXPLORATION_METHODOLOGY", "EVIDENCE_SEMANTICS",
                     "CONTEXT", "EVIDENCE", "CAPABILITY_DESCRIPTION")


def report(name: str, rows: list[tuple[str, int, dict[str, int]]]) -> dict[str, int]:
    total = sum(b for _, b, _ in rows)
    agg: dict[str, int] = defaultdict(int)
    for section, size, alloc in rows:
        s = sum(alloc.values())
        if s != size:
            raise SystemExit(f"allocation mismatch in {name}: {section} {s} != {size}")
        for k, v in alloc.items():
            agg[k] += v
    print(f"\n########## {name} — {total} B")
    print(f"  {'category':26} {'bytes':>7} {'share':>7}")
    for k in sorted(agg, key=lambda x: -agg[x]):
        print(f"  {k:26} {agg[k]:>7} {agg[k] * 100 / total:>6.1f}%")
    legit = sum(agg[k] for k in FABRIC_LEGITIMATE)
    print(f"  {'-' * 26} {'-' * 7} {'-' * 7}")
    print(f"  {'FABRIC LEGITIMATE (sum)':26} {legit:>7} {legit * 100 / total:>6.1f}%")
    print(f"  {'EXECUTION_HOW (Hermes)':26} {agg['EXECUTION_HOW']:>7} "
          f"{agg['EXECUTION_HOW'] * 100 / total:>6.1f}%")
    print(f"  {'PROMPT DEBT (redundant)':26} {agg['REDUNDANT']:>7} "
          f"{agg['REDUNDANT'] * 100 / total:>6.1f}%")
    print(f"  {'OUTPUT_SCHEMA':26} {agg['OUTPUT_SCHEMA']:>7} "
          f"{agg['OUTPUT_SCHEMA'] * 100 / total:>6.1f}%")
    return dict(agg)


r = report("REPLAY heavy (contract only, 0 evidence)", REPLAY)
p = report("PRODUCTION investigation (contract only, 0 evidence)", PRODUCTION)

# The exact sections the FIRST pass labelled HOW/SKILL (prompt-section-classification.md),
# recomputed under the revised boundary. Their sizes sum to the first pass's ~13.9 KB bucket;
# the first pass reported "~9,300 B / 28%" as a rounded aggregate.
FIRST_PASS_HOW = [
    "Evidence Resolution", "Question-driven header", "Business Question",
    "Decision-changing Evidence", "Evidence Requirement", "Evidence Sufficiency",
    "Resolution vs Sufficiency", "Investigation progress", "Stop semantics",
    "Epistemic Layers", "Knowledge", "Cognition continuity", "Investigation Workflow",
    "Mandatory coverage",
]
print("\n########## second-pass split of the sections the FIRST pass called HOW/SKILL")
bucket = [r_ for r_ in REPLAY if r_[0] in FIRST_PASS_HOW]
size = sum(b for _, b, _ in bucket)
agg: dict[str, int] = defaultdict(int)
for _s, _b, alloc in bucket:
    for k, v in alloc.items():
        agg[k] += v
print(f"  bucket size: {size} B")
for k in sorted(agg, key=lambda x: -agg[x]):
    print(f"    {k:26} {agg[k]:>6} B  {agg[k] * 100 // size:>3}%")
print(f"  -> EXECUTION_HOW is {agg['EXECUTION_HOW'] * 100 // size}% of the bucket; the rest is NOT")
print("     Hermes execution: it reclassifies into EXPLORATION_METHODOLOGY (Fabric keeps),")
print("     EVIDENCE_SEMANTICS / CONTRACT (Fabric keeps) and REDUNDANT (prompt debt).")
