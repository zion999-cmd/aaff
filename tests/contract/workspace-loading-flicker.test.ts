// P0010.2.7-followup-2 — Loading flicker regression contract.
//
// P0010.2.7 introduced 4s polling with content-fingerprint dedup on
// the outputs panel (`fetchAndRenderOutputs`) and the runtime view
// (`fetchAndRenderRuntime`). The original implementation wrote a
// "加载中…" / "Loading execution history..." placeholder on every
// render call (including the poller path), which caused the operator
// to see the list flicker between "加载中" and the rendered grid on
// every 4s tick. The user reported this as "我在看输出列表时, 这个列表
// 突然就"加载中", 过了一会又显示列表, 然后又变成"加载中"".
//
// The fix: the "loading" placeholder is written ONLY by the
// user-initiated entry points (`loadOutputs`, `loadRuntime`). The
// poller-shared helpers (`fetchAndRenderOutputs`, `fetchAndRenderRuntime`)
// MUST NOT write a loading placeholder — they just render the final
// result, or write the persistent empty-state copy when there is no
// data. The empty-state copy ("暂无交付物" / "No execution records")
// is a stable state that should persist across polls when nothing
// changes (the fingerprint dedup means the DOM does not churn).
//
// Why source-level (not behaviour-level)? The Workspace is vanilla JS
// in the browser; no jsdom test runner is configured. The contract is
// the shape of the wiring, not the browser behaviour, so we pin the
// source — same approach as `workspace-loop-status.test.ts`.
//
// Invariants pinned (one failure = regression):
//
// 1. `loadOutputs()` writes the "加载中…" placeholder (user clicked,
//    expects feedback). `fetchAndRenderOutputs()` does NOT write it.
// 2. `loadRuntime()` writes the "Loading execution history..."
//    placeholder. `fetchAndRenderRuntime()` does NOT write it.
// 3. The placeholder write in the entry point must happen BEFORE the
//    `await fetchAndRender*` call (so the placeholder is visible
//    while the fetch is in flight).
// 4. The persistent empty-state copy ("暂无交付物" /
//    "No execution records") is written in the poller-shared helper,
//    AFTER the fingerprint dedup check — not before. This means an
//    empty list does not churn the DOM on every poll.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

/**
 * Find the brace-balanced body of the function whose declaration
 * matches `declRegex`. Returns the substring from the opening `{`
 * to the matching `}`. The four target functions are well-formed
 * and do not contain string-literal `{`/`}` before the function
 * body, so a simple brace counter is sufficient.
 */
function bodyOf(source: string, declRegex: RegExp): string {
  const declIdx = source.search(declRegex);
  if (declIdx === -1) return '';
  const openIdx = source.indexOf('{', declIdx);
  if (openIdx === -1) return '';
  let depth = 1;
  let i = openIdx + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return source.substring(openIdx, i);
}

describe('Workspace loading-flicker contract (P0010.2.7-followup-2)', () => {
  const js = readFileSync(
    resolve(root, 'apps/ecommerce/workspace/app.js'),
    'utf8',
  );

  it('loadOutputs() writes the "加载中…" placeholder; fetchAndRenderOutputs() does NOT', () => {
    const loadOutputsBody = bodyOf(js, /async function loadOutputs\s*\(/);
    const fetchOutputsBody = bodyOf(js, /async function fetchAndRenderOutputs\s*\(/);

    // The user-initiated entry point must show the loading placeholder.
    expect(loadOutputsBody).toContain('加载中');
    // The placeholder write must come BEFORE the fetch call.
    const placeholderIdx = loadOutputsBody.indexOf('加载中');
    const fetchCallIdx = loadOutputsBody.indexOf('await fetchAndRenderOutputs()');
    expect(placeholderIdx).toBeGreaterThan(-1);
    expect(fetchCallIdx).toBeGreaterThan(-1);
    expect(placeholderIdx).toBeLessThan(fetchCallIdx);

    // The poller-shared helper must NOT write a "加载中…" placeholder.
    // It may still write the persistent empty-state copy
    // ("暂无交付物"), which is a stable terminal state, not a
    // transient loading state. We strip comments before checking
    // because the body's explanation comments naturally contain
    // the word "加载中" in prose.
    const fetchOutputsCode = fetchOutputsBody
      .replace(/\/\/[^\n]*/g, '')   // strip // line comments
      .replace(/\/\*[\s\S]*?\*\//g, ''); // strip /* block comments */
    expect(fetchOutputsCode).not.toMatch(/加载中/);
  });

  it('fetchAndRenderOutputs() writes empty-state copy AFTER the fingerprint dedup check', () => {
    const fetchOutputsBody = bodyOf(js, /async function fetchAndRenderOutputs\s*\(/);
    // The persistent empty-state copy must be present.
    expect(fetchOutputsBody).toContain('暂无交付物');
    // The fingerprint dedup check must be present.
    expect(fetchOutputsBody).toContain('state.outputsFingerprint');
    // The empty-state write must happen AFTER the dedup check, so
    // an empty list does not churn the DOM on every poll.
    const dedupIdx = fetchOutputsBody.indexOf('state.outputsFingerprint');
    const emptyIdx = fetchOutputsBody.indexOf('暂无交付物');
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(dedupIdx);
  });

  it('loadRuntime() writes the "Loading execution history..." placeholder; fetchAndRenderRuntime() does NOT', () => {
    const loadRuntimeBody = bodyOf(js, /async function loadRuntime\s*\(/);
    const fetchRuntimeBody = bodyOf(js, /async function fetchAndRenderRuntime\s*\(/);

    // The user-initiated entry point must show the loading placeholder.
    expect(loadRuntimeBody).toContain('Loading execution history');
    // The placeholder write must come BEFORE the fetch call.
    const placeholderIdx = loadRuntimeBody.indexOf('Loading execution history');
    const fetchCallIdx = loadRuntimeBody.indexOf('await fetchAndRenderRuntime()');
    expect(placeholderIdx).toBeGreaterThan(-1);
    expect(fetchCallIdx).toBeGreaterThan(-1);
    expect(placeholderIdx).toBeLessThan(fetchCallIdx);

    // The poller-shared helper must NOT write a "Loading..." placeholder.
    // We strip comments before checking because the body's explanation
    // comments naturally contain the word "Loading" in prose.
    const fetchRuntimeCode = fetchRuntimeBody
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(fetchRuntimeCode).not.toMatch(/Loading execution history/);
  });

  it('fetchAndRenderRuntime() writes empty-state copy AFTER the fingerprint dedup check', () => {
    const fetchRuntimeBody = bodyOf(js, /async function fetchAndRenderRuntime\s*\(/);
    // The persistent empty-state copy must be present.
    expect(fetchRuntimeBody).toContain('No execution records');
    // The fingerprint dedup check must be present.
    expect(fetchRuntimeBody).toContain('state.runtimeFingerprint');
    // The empty-state write must happen AFTER the dedup check.
    const dedupIdx = fetchRuntimeBody.indexOf('state.runtimeFingerprint');
    const emptyIdx = fetchRuntimeBody.indexOf('No execution records');
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(dedupIdx);
  });

  it('the outputs + runtime entry points still wire their fetch helpers (initial load is not broken)', () => {
    // Structural sanity: the user-initiated entry points still call
    // their fetch helpers, so initial load still works. The fix did
    // not break the wiring — it only moved the placeholder write.
    expect(js).toMatch(/async function loadOutputs\s*\(/);
    expect(js).toMatch(/await fetchAndRenderOutputs\(\)/);
    expect(js).toMatch(/async function loadRuntime\s*\(/);
    expect(js).toMatch(/await fetchAndRenderRuntime\(\)/);
  });
});
