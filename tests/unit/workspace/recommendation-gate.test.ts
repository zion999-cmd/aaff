// P0010.2 Closure Micro-Repair — Recommendation Gate (UI side).
//
// The user reported a state-transition bug: a Situation whose latest
// attempt FAILED (Hermes mid-turn killed + token-missing) still showed
// "Agent 已完成调查，可基于当前判断生成处理建议" with an enabled "💡 生成建议"
// button, and clicking it fed the prior (now-stale) judgment into
// `runRecommendationTurn`.
//
// Root cause: `renderCurrentUnderstanding` in `apps/ecommerce/workspace/
// app.js` gated the "建议" block on `if (rec)` only — it never read
// `inv.status`. Because `markInvestigation`'s minimum-merge preserves
// the prior valid cognition on a failed attempt, the row had a non-null
// `judgment` (and the row's `status` was `'failed'`), so the
// `hasPriorCognition` branch at line 1591-1595 entered the render path
// and the `if (rec)` gate failed to block the button.
//
// The micro-repair (this slice) does NOT change `markInvestigation`'s
// minimum-merge (that is the recovery contract). It makes the UI's
// "建议" branch strictly require `inv.status === 'completed'` before
// showing the button. The prior valid cognition is still rendered in the
// Understanding surface (with a "最新调查未完成" hint) — the button is
// the only thing the guard touches.
//
// These tests pin the UI contract by source-text assertion, matching the
// pattern in `investigation-display-state.test.ts` (the workspace layer
// is plain JS in a browser, so we cannot unit-test the rendered DOM in
// Node without a JSDOM harness that matches production rendering).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_SRC = readFileSync(
  resolve(process.cwd(), 'apps/ecommerce/workspace/app.js'),
  'utf8',
);

// Extract the body of `renderCurrentUnderstanding` so each assertion is
// scoped to the function that owns the "建议" block, not the whole file.
// This makes the test specific: a `inv.status !== 'completed'` check
// elsewhere in app.js (e.g. in renderLifecycleCard) does not satisfy
// these assertions.
const fnMatch = APP_SRC.match(/function\s+renderCurrentUnderstanding\s*\([^)]*\)\s*\{/);
if (!fnMatch || fnMatch.index === undefined) {
  throw new Error('renderCurrentUnderstanding not found in app.js');
}
const fnStart = fnMatch.index + fnMatch[0].length;
const FN_BODY = APP_SRC.slice(fnStart);

describe('P0010.2 closure — UI "建议" gate requires inv.status === "completed"', () => {
  it('renderCurrentUnderstanding explicitly checks inv.status (not only inv.recommendation)', () => {
    // The previous code was `if (rec) { ... } else { /* render button */ }` —
    // it never read inv.status. The micro-repair introduces a status
    // check inside the function. Pin: the literal string "completed"
    // must appear inside the function body, paired with inv.status.
    expect(FN_BODY).toMatch(/inv\.status\s*===?\s*['"]completed['"]/);
  });

  it('the "生成建议" button literal is reachable ONLY inside a status-guarded branch', () => {
    // The button HTML is rendered as a literal string. The micro-repair
    // wraps it (or its surrounding else-block) in a status check.
    // Pin: the button literal must appear AFTER (i.e. deeper than) a
    // status check in the function body.
    const buttonIdx = FN_BODY.indexOf('生成建议');
    expect(buttonIdx).toBeGreaterThan(0);
    // Look for any inv.status check (=== or !==) that appears before
    // the button literal.
    const head = FN_BODY.slice(0, buttonIdx);
    expect(head).toMatch(/inv\.status\s*[!=]==?\s*['"]completed['"]/);
  });

  it('the misleading "Agent 已完成调查" copy is also gated by status (not unconditional)', () => {
    // The literal Chinese string is the operator-facing claim that
    // "the investigation has completed". The micro-repair must gate
    // it (or remove it) so a failed record does not produce this
    // copy. Pin: a status check must appear before the literal.
    const completedIdx = FN_BODY.indexOf('Agent 已完成调查');
    expect(completedIdx).toBeGreaterThan(0);
    const head = FN_BODY.slice(0, completedIdx);
    expect(head).toMatch(/inv\.status\s*[!=]==?\s*['"]completed['"]/);
  });

  it('hasPriorCognition branch is preserved (recovery context still shown — no architectural regression)', () => {
    // The fix must NOT remove the hasPriorCognition entry path — the
    // operator still needs to see the prior valid judgment and
    // Understanding surface (with a "最新调查未完成" hint). The only
    // change is the local "建议" gate inside renderCurrentUnderstanding.
    expect(APP_SRC).toMatch(/hasPriorCognition/);
    // The "最新调查未完成" copy remains (the failure hint, separate
    // from the button affordance).
    expect(APP_SRC).toMatch(/最新调查未完成/);
  });
});
