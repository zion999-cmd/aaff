// P0010.1 Final Repair — Area D: server-side unit test for
// `deriveInvestigationStatus` (in platform/server/routes/p0007.ts).
//
// This is the single source of truth for the
//   /api/situations -> investigation.status
// field. The contract has tightened in this REPAIR:
//   1. The fuzzy text match ("人工核验" / "人工确认" / "无法获取") is REMOVED.
//   2. `needs_human` is now driven by `stopReason` and the structured
//      `recommendation.humanNeeded[]` field — never by passing prose.
//
// Mirrored on the client side by `deriveSituationLifecycle` (presentation.js)
// and pinned by `tests/contract/repair-trust-lifecycle.test.ts` (the
// corresponding cases for `waiting_human` / `watching`).

import { describe, expect, test } from 'vitest';
import { deriveInvestigationStatus } from '#platform/server/routes/p0007.js';

describe('deriveInvestigationStatus — P0010.1 Area D (server-side, mirrored on client)', () => {
  test('null investigation → pending', () => {
    expect(deriveInvestigationStatus(null)).toBe('pending');
  });

  test('status=investigating → investigating', () => {
    expect(deriveInvestigationStatus({ status: 'investigating' })).toBe('investigating');
  });

  test('status=failed → failed (no further logic)', () => {
    expect(deriveInvestigationStatus({ status: 'failed', error: 'turn timeout' } as Parameters<typeof deriveInvestigationStatus>[0])).toBe('failed');
  });

  test('stopReason=observe → observing', () => {
    expect(deriveInvestigationStatus({ status: 'completed', stopReason: 'observe' })).toBe('observing');
  });

  test('stopReason=ask_human → needs_human', () => {
    expect(deriveInvestigationStatus({ status: 'completed', stopReason: 'ask_human' })).toBe('needs_human');
  });

  test('stopReason=missing_capability → needs_human', () => {
    expect(deriveInvestigationStatus({ status: 'completed', stopReason: 'missing_capability' })).toBe('needs_human');
  });

  test('stopReason=judgment + humanNeeded=[item] → needs_human', () => {
    expect(
      deriveInvestigationStatus({
        status: 'completed',
        stopReason: 'judgment',
        recommendation: { humanNeeded: ['confirm supplier'] },
      }),
    ).toBe('needs_human');
  });

  test('stopReason=judgment + humanNeeded=[] → judgment_ready', () => {
    expect(
      deriveInvestigationStatus({
        status: 'completed',
        stopReason: 'judgment',
        recommendation: { humanNeeded: [] },
      }),
    ).toBe('judgment_ready');
  });

  test('stopReason=judgment + no recommendation → judgment_ready', () => {
    expect(
      deriveInvestigationStatus({ status: 'completed', stopReason: 'judgment' }),
    ).toBe('judgment_ready');
  });

  test('stopReason=judgment + recommendation but no humanNeeded field → judgment_ready', () => {
    expect(
      deriveInvestigationStatus({
        status: 'completed',
        stopReason: 'judgment',
        recommendation: { rationale: 'continue observing' },
      } as Parameters<typeof deriveInvestigationStatus>[0]),
    ).toBe('judgment_ready');
  });

  test('REGRESSION: judgment text containing 人工核验 no longer flips to needs_human', () => {
    // The previous version of this function matched "人工核验" / "人工确认" /
    // "无法获取" in the judgment text. That was a heuristic that
    // mis-triggered when the agent was acknowledging past human input.
    // The new contract reads only structured fields.
    expect(
      deriveInvestigationStatus({
        status: 'completed',
        stopReason: 'judgment',
        judgment: '已与运营确认；本轮仍建议继续观察 2 天。',
      }),
    ).toBe('judgment_ready');
  });

  test('REGRESSION: judgment text containing 人工确认 no longer flips to needs_human', () => {
    expect(
      deriveInvestigationStatus({
        status: 'completed',
        stopReason: 'judgment',
        currentUnderstanding: '与运营确认后无新数据',
      }),
    ).toBe('judgment_ready');
  });

  test('unknown stopReason → judgment_ready (not an error)', () => {
    expect(
      deriveInvestigationStatus({ status: 'completed', stopReason: 'something_new' }),
    ).toBe('judgment_ready');
  });

  test('completed status but no stopReason → judgment_ready', () => {
    expect(deriveInvestigationStatus({ status: 'completed' })).toBe('judgment_ready');
  });
});
