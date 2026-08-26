// P0010.2 Closure Micro-Repair — Clear-Block Dispatcher + 运营/开发模式 Toggle Removal.
//
// Slice 1 fixes two production bugs that surfaced in screenshots:
//
//   (1) The "解除阻塞并重新调度" button in the blocked state was supposed to
//       POST to /api/situation/:id/clear-block. The previous dispatcher
//       sniffed the button's text content with
//         btn.textContent.indexOf('清除阻塞') !== -1
//       but the actual button text is "解除阻塞并重新调度" — the substring
//       "清除阻塞" is NOT in it. So the check never matched, the clear-block
//       branch was unreachable, and every blocked-state click fell through
//       to the legacy /investigate path. /investigate returned a fresh
//       "completed" investigation, the recommendation gate (P0010.2 prior
//       slice) correctly rendered "生成建议", and the operator saw the
//       symptom: clicking 解除阻塞 instantly produced 生成建议.
//
//       The fix: add `data-action="clear-block"` to the button when in the
//       blocked state, `data-action="manual-investigate"` to the normal
//       button, and switch the dispatcher on `btn.dataset.action` (not on
//       Chinese text matching). The visible copy stays the same — only the
//       dispatch signal changes.
//
//   (2) The 运营/开发模式 toggle (and the dev-only renderTracePanel +
//       dev-mode scrubber branches) was old architecture residue. The
//       Investigation flow never reads panelMode (decisionContent is
//       rewritten by renderInvestigationTrace in any case), and the
//       toggle's only other consumer was selectFinding → updatePanel,
//       which we hard-pinned to the business path. Per the user's
//       "产品视图永久采用业务可读 scrubber" decision, the toggle and
//       its CSS are removed; the scrubber, capabilityLabel,
//       renderSourceTag, and humanizeError always run in business mode.
//
// These tests pin the contracts by source-text assertion. The workspace
// layer is plain JS in a browser, so we cannot unit-test the rendered
// DOM in Node without a JSDOM harness that matches production rendering.
// The pattern matches the prior recommendation-gate / display-state tests
// in this directory.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_SRC = readFileSync(
  resolve(process.cwd(), 'apps/ecommerce/workspace/app.js'),
  'utf8',
);
const HTML_SRC = readFileSync(
  resolve(process.cwd(), 'apps/ecommerce/workspace/index.html'),
  'utf8',
);
const CSS_SRC = readFileSync(
  resolve(process.cwd(), 'apps/ecommerce/workspace/styles.css'),
  'utf8',
);

// --- Slice 1 (1) — clear-block dispatcher -------------------------------

describe('P0010.2 closure — clear-block dispatcher uses data-action (not Chinese text sniff)', () => {
  it('the normal "🔍 交给 Agent 调查" button has data-action="manual-investigate"', () => {
    // The button is rendered as a literal in the situation detail HTML.
    // Pin: the data-action attribute is right next to the id (so the
    // dispatcher can read it on click), and the value is the legacy
    // "manual investigate" intent — NOT "clear-block" (which would route
    // every manual click to /clear-block and break normal flow).
    const buttonIdx = APP_SRC.indexOf('🔍 交给 Agent 调查');
    expect(buttonIdx).toBeGreaterThan(0);
    const head = APP_SRC.slice(Math.max(0, buttonIdx - 400), buttonIdx);
    expect(head).toMatch(/data-action\s*=\s*["']manual-investigate["']/);
    // The same HTML line must carry the startInvestigation_<id> id, so
    // the dispatcher's getElementById call resolves the button.
    expect(head).toMatch(/startInvestigation_/);
  });

  it('the blocked-state "解除阻塞并重新调度" button sets btn.dataset.action = "clear-block"', () => {
    // The button copy stays the same (it is the operator-facing string);
    // the dispatch signal is now a data-action attribute. Pin: when the
    // banner is in the blocked state, the renderer sets the dataset, not
    // a textContent sniff.
    //
    // The actual layout is:
    //   if (banner.showClearBlock) {
    //     // ... comments ...
    //     btn.style.display = 'block';
    //     btn.textContent = '解除阻塞并重新调度';
    //     btn.dataset.action = 'clear-block';   <-- AFTER the copy
    //   } else { ... }
    //
    // We anchor on the showClearBlock block (which is unique) and assert
    // the dataset assignment is inside the same block.
    const blockStart = APP_SRC.indexOf('banner.showClearBlock');
    expect(blockStart).toBeGreaterThan(0);
    // Walk forward into the same `if (btn) { ... }` block. A 1500-char
    // slice is plenty for the dataset assignment + else branch.
    const blockBody = APP_SRC.slice(blockStart, blockStart + 1500);
    expect(blockBody).toMatch(/btn\.dataset\.action\s*=\s*["']clear-block["']/);
    // Sanity: the visible copy is in the same block (so the operator
    // still sees "解除阻塞并重新调度").
    expect(blockBody).toMatch(/解除阻塞并重新调度/);
  });

  it('the startInvestigation dispatcher reads btn.dataset.action (NOT a textContent.indexOf sniff)', () => {
    // Pin the dispatcher shape: it must read intent from a stable,
    // machine-readable signal. The previous substring check is the bug
    // we are fixing; this assertion guards against re-introducing it.
    const fnMatch = APP_SRC.match(/async\s+function\s+startInvestigation\s*\([^)]*\)\s*\{/);
    expect(fnMatch).not.toBeNull();
    if (!fnMatch || fnMatch.index === undefined) {
      throw new Error('startInvestigation not found in app.js');
    }
    // Walk forward to the next top-level "return;" (the clear-block
    // branch ends with `return;` at the end of its try/catch). The
    // dispatch body is everything before that.
    const fnStart = fnMatch.index + fnMatch[0].length;
    const fnBody = APP_SRC.slice(fnStart);

    // The dispatcher reads data-action and switches on it.
    expect(fnBody).toMatch(/btn\.dataset\.action/);
    expect(fnBody).toMatch(/===?\s*["']clear-block["']/);
    // The clear-block path is reachable (we pin the literal route call).
    // The route is built by string concatenation:
    //   '/api/situation/' + encodeURIComponent(situationId) + '/clear-block'
    // so the segment literals are the right pin targets.
    expect(fnBody).toMatch(/['"]\/api\/situation\/['"]/);
    expect(fnBody).toMatch(/['"]\/clear-block['"]/);
    // The manual-investigate path is the legacy fallback (it still POSTs
    // to /investigate for the case where data-action is "manual-investigate"
    // or unset).
    expect(fnBody).toMatch(/['"]\/api\/situation\/['"]/);
    expect(fnBody).toMatch(/['"]\/investigate['"]/);
  });

  it('regression pin — dispatcher does NOT contain the broken substring sniff', () => {
    // The old buggy code: `btn.textContent.indexOf('清除阻塞') !== -1`
    // This string must NOT appear anywhere in app.js. Even outside the
    // function body — the old comment is fine, but the literal code path
    // is the bug.
    expect(APP_SRC).not.toMatch(/textContent\.indexOf\(\s*['"]清除阻塞['"]\s*\)/);
    // The broader pattern: textContent + indexOf is no longer used for
    // dispatch anywhere in the file. This guards against any future
    // similar regression.
    expect(APP_SRC).not.toMatch(/textContent\.indexOf/);
  });
});

// --- Slice 1 (2) — 运营/开发模式 toggle removed -------------------------

describe('P0010.2 closure — 运营/开发模式 toggle is fully removed (UI + state + dispatcher + CSS)', () => {
  it('state.panelMode field is removed (operator view is the only view)', () => {
    // Pin: no field in the state literal carries panelMode, and no
    // assignment to state.panelMode exists. Comments explaining the
    // removal are allowed.
    expect(APP_SRC).not.toMatch(/state\.panelMode\s*=/);
    expect(APP_SRC).not.toMatch(/panelMode:\s*['"]/);
  });

  it('togglePanelMode function is removed (the toggle handler is gone)', () => {
    // The function used to be defined at app.js around line 3392. The
    // P0010.2 closure removes the function entirely. Any reference to
    // togglePanelMode (besides the explanatory comment naming it as
    // removed) is a regression.
    expect(APP_SRC).not.toMatch(/function\s+togglePanelMode\s*\(/);
    expect(APP_SRC).not.toMatch(/togglePanelMode\s*\(/);
  });

  it('the panelModeToggle DOM listener is removed', () => {
    // The old listener attached to the toggle's "change" event. With
    // the toggle gone, the listener is also gone.
    expect(APP_SRC).not.toMatch(/getElementById\(\s*['"]panelModeToggle['"]\s*\)/);
  });

  it('updatePanel no longer branches on state.panelMode (always renders business)', () => {
    // Extract the body of updatePanel and assert it does NOT have the
    // `if (state.panelMode === 'business')` branch — the previous code
    // routed business to renderBusinessPanel and dev to renderTracePanel.
    // The dev branch is gone, and the if-guard is gone with it.
    const fnMatch = APP_SRC.match(/async\s+function\s+updatePanel\s*\([^)]*\)\s*\{/);
    expect(fnMatch).not.toBeNull();
    if (!fnMatch || fnMatch.index === undefined) {
      throw new Error('updatePanel not found in app.js');
    }
    const fnStart = fnMatch.index + fnMatch[0].length;
    // Walk to the end of the function (next top-level "}" at column 0).
    // Simpler: take a generous slice and assert within it.
    const fnBody = APP_SRC.slice(fnStart, fnStart + 4000);
    expect(fnBody).not.toMatch(/state\.panelMode\s*===\s*['"]business['"]/);
    // The only render call left is the business one.
    expect(fnBody).toMatch(/renderBusinessPanel\s*\(/);
  });

  it('scrubber always runs in business mode (capabilityLabel / scrubCapabilityIdsInProse / renderSourceTag / humanizeError)', () => {
    // The five scrubber call sites used to read state.panelMode to
    // decide whether to expose raw ids / English technical literals /
    // metric scalars. With panelMode gone, the dev-only branches are
    // gone too. Pin: no surviving `state.panelMode === 'developer'`
    // check anywhere in app.js.
    expect(APP_SRC).not.toMatch(/state\.panelMode\s*===\s*['"]developer['"]/);
    // humanizeError still takes a panelMode parameter (for the contract),
    // but the call site now passes the literal 'business' (or, more
    // permissively, never reads state.panelMode).
    expect(APP_SRC).toMatch(/humanizeError\(\s*inv\.error\s*,\s*['"]business['"]\s*\)/);
  });

  it('i18n mode.* keys are removed from both language tables', () => {
    // The four keys used to be: mode.business, mode.developer,
    // mode.operator, mode.builder. With the toggle gone, no key prefix
    // `mode.` should remain.
    expect(APP_SRC).not.toMatch(/['"]mode\.(business|developer|operator|builder)['"]\s*:/);
  });

  it('index.html no longer contains the mode-toggle-group block', () => {
    // The toggle's container was a <div class="mode-toggle-group">
    // inside the right-pane header (P0003.1 V1 sidebar header). The
    // P0010.2 closure removes the entire block, including the wrapping
    // <div class="decision-header-row"> that existed only to hold the
    // toggle. Pin: no `mode-toggle-group` class in the rendered HTML.
    expect(HTML_SRC).not.toMatch(/mode-toggle-group/);
    expect(HTML_SRC).not.toMatch(/panelModeToggle/);
    // The "决策依据" title (which used to share the same header row) is
    // still rendered — pin its presence so we know the header didn't
    // disappear with the toggle.
    expect(HTML_SRC).toMatch(/决策依据/);
  });

  it('styles.css no longer contains the .mode-* rules', () => {
    // Five selectors used to be defined:
    //   .mode-toggle-group / .mode-label / .mode-label.muted /
    //   .mode-switch / .mode-switch input / .mode-slider / ...
    // With the toggle removed, no class selector starting with `.mode-`
    // should remain.
    expect(CSS_SRC).not.toMatch(/\.mode-(toggle-group|label|switch|slider)/);
  });
});
