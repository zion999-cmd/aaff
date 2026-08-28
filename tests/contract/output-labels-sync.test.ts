// P0010.1 REPAIR-5 — contract test that asserts the vanilla-JS label
// mirror in `apps/ecommerce/workspace/output-labels.js` stays in
// 1:1 sync with the canonical `shared/schemas/output.ts`. Drift
// here would cause UI to display wrong status / type labels while
// the API / CLI / tests still used the correct ones.
//
// The JS file runs in a browser context and assigns to `window.*`.
// We cannot `import` it directly in vitest, so we read + parse it
// and compare key-by-key.

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  WORK_ITEM_KIND_CSS_CLASS,
  WORK_ITEM_KIND_LABEL,
  WORK_ITEM_STATUS_LABEL,
  WORK_ITEM_TYPE_LABEL,
  WorkItemStatusSchema,
  WorkItemTypeSchema,
} from '#shared/schemas/output.js';

/** Extract `window.<NAME> = Object.freeze({...})` from a JS file as a
 *  plain object. We only need the literal keys & string values — we
 *  parse a tiny, well-bounded DSL (`'key': 'value'`) so the test is
 *  hermetic and does not need a JS runtime. */
const extractObjectLiteral = (source: string, varName: string): Record<string, string> => {
  const re = new RegExp(`${varName}\\s*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)\\s*;`);
  const m = source.match(re);
  if (!m) throw new Error(`Could not locate \`${varName} = Object.freeze({...})\` in source`);
  const body = m[1]!;
  // Match `key: 'string value'` lines. Allow any whitespace.
  const out: Record<string, string> = {};
  const pairRe = /(\w+)\s*:\s*'([^']*)'/g;
  let pm;
  while ((pm = pairRe.exec(body)) !== null) {
    out[pm[1]!] = pm[2]!;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`Parsed zero keys from \`${varName}\` — regex miss?`);
  }
  return out;
};

describe('P0010.1 REPAIR-5 — output-labels.js mirror stays in sync with the schema', () => {
  const labelsPath = resolve(__dirname, '../../apps/ecommerce/workspace/output-labels.js');
  const source = readFileSync(labelsPath, 'utf-8');

  test('the mirror file declares both window.WORK_ITEM_STATUS_LABEL and window.WORK_ITEM_TYPE_LABEL', () => {
    expect(source).toMatch(/window\.WORK_ITEM_STATUS_LABEL/);
    expect(source).toMatch(/window\.WORK_ITEM_TYPE_LABEL/);
  });

  test('window.WORK_ITEM_STATUS_LABEL — keys match the schema enum', () => {
    const fromJs = extractObjectLiteral(source, 'window.WORK_ITEM_STATUS_LABEL');
    const schemaKeys = WorkItemStatusSchema.options.slice().sort();
    expect(Object.keys(fromJs).sort()).toEqual(schemaKeys);
  });

  test('window.WORK_ITEM_STATUS_LABEL — values match the schema canonical Chinese labels', () => {
    const fromJs = extractObjectLiteral(source, 'window.WORK_ITEM_STATUS_LABEL');
    for (const k of Object.keys(WORK_ITEM_STATUS_LABEL)) {
      expect(fromJs[k]).toBe(WORK_ITEM_STATUS_LABEL[k as keyof typeof WORK_ITEM_STATUS_LABEL]);
    }
  });

  test('window.WORK_ITEM_TYPE_LABEL — keys match the schema enum', () => {
    const fromJs = extractObjectLiteral(source, 'window.WORK_ITEM_TYPE_LABEL');
    const schemaKeys = WorkItemTypeSchema.options.slice().sort();
    expect(Object.keys(fromJs).sort()).toEqual(schemaKeys);
  });

  test('window.WORK_ITEM_TYPE_LABEL — values match the schema canonical Chinese labels', () => {
    const fromJs = extractObjectLiteral(source, 'window.WORK_ITEM_TYPE_LABEL');
    for (const k of Object.keys(WORK_ITEM_TYPE_LABEL)) {
      expect(fromJs[k]).toBe(WORK_ITEM_TYPE_LABEL[k as keyof typeof WORK_ITEM_TYPE_LABEL]);
    }
  });

  test('canonical Chinese labels use the agreed semantics (REPAIR-5 unification)', () => {
    // The whole point of REPAIR-5 is to remove the duplicate
    // "待查看 / 已送达 / 已结束" surface and unify on the schema's
    // "待交付 / 已交付 / 已确认 / 已关闭" — the only labels the
    // Workspace must display.
    expect(WORK_ITEM_STATUS_LABEL.ready).toBe('待交付');
    expect(WORK_ITEM_STATUS_LABEL.delivered).toBe('已交付');
    expect(WORK_ITEM_STATUS_LABEL.acknowledged).toBe('已确认');
    expect(WORK_ITEM_STATUS_LABEL.closed).toBe('已关闭');
  });

  // ---- P0010.2.x — kind label / CSS class mirror -----------------------

  test('the mirror file declares both window.WORK_ITEM_KIND_LABEL and window.WORK_ITEM_KIND_CSS_CLASS', () => {
    expect(source).toMatch(/window\.WORK_ITEM_KIND_LABEL/);
    expect(source).toMatch(/window\.WORK_ITEM_KIND_CSS_CLASS/);
  });

  test('window.WORK_ITEM_KIND_LABEL — keys match the schema kind enum', () => {
    const fromJs = extractObjectLiteral(source, 'window.WORK_ITEM_KIND_LABEL');
    const schemaKeys = Object.keys(WORK_ITEM_KIND_LABEL).slice().sort();
    expect(Object.keys(fromJs).sort()).toEqual(schemaKeys);
  });

  test('window.WORK_ITEM_KIND_LABEL — values match the schema canonical Chinese labels', () => {
    const fromJs = extractObjectLiteral(source, 'window.WORK_ITEM_KIND_LABEL');
    for (const k of Object.keys(WORK_ITEM_KIND_LABEL)) {
      expect(fromJs[k]).toBe(WORK_ITEM_KIND_LABEL[k as keyof typeof WORK_ITEM_KIND_LABEL]);
    }
  });

  test('window.WORK_ITEM_KIND_CSS_CLASS — keys match the schema kind enum', () => {
    const fromJs = extractObjectLiteral(source, 'window.WORK_ITEM_KIND_CSS_CLASS');
    const schemaKeys = Object.keys(WORK_ITEM_KIND_CSS_CLASS).slice().sort();
    expect(Object.keys(fromJs).sort()).toEqual(schemaKeys);
  });

  test('window.WORK_ITEM_KIND_CSS_CLASS — values match the schema canonical CSS class names', () => {
    const fromJs = extractObjectLiteral(source, 'window.WORK_ITEM_KIND_CSS_CLASS');
    for (const k of Object.keys(WORK_ITEM_KIND_CSS_CLASS)) {
      expect(fromJs[k]).toBe(WORK_ITEM_KIND_CSS_CLASS[k as keyof typeof WORK_ITEM_KIND_CSS_CLASS]);
    }
  });

  test('canonical kind labels use the agreed observe/act semantics', () => {
    // P0010.2.x — the kind chip is the load-bearing UI surface that
    // separates "do nothing / keep watching" from "act on this". The
    // Operator's mental model is "保持观察 = system is watchful, no
    // operator action needed" vs "待交付 = there is a concrete to-do
    // here". These two strings must stay stable across changes.
    expect(WORK_ITEM_KIND_LABEL.observe).toBe('保持观察');
    expect(WORK_ITEM_KIND_LABEL.act).toBe('待交付');
    expect(WORK_ITEM_KIND_CSS_CLASS.observe).toBe('output-kind-observe');
    expect(WORK_ITEM_KIND_CSS_CLASS.act).toBe('output-kind-act');
  });
});
