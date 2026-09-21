// P0013.4 acceptance — the Replay turn wait ceiling.
//
// Why this exists as a test rather than a constant: a 2026-09-21 11-day run
// completed 2026-09-02 in 526s and then lost 2026-09-03 twice at 603s, so the
// ceiling — not the cognition — decided which days produced output at all.
// It is now configurable, and these assertions pin the two properties that
// make that safe:
//
//   1. the DEFAULT is still 600_000ms, so every existing caller is unchanged;
//   2. the resolved value actually reaches `collectTurn`, rather than being
//      accepted and dropped on the floor.
//
// The second one is the interesting one — a configurable knob that nothing
// reads is a worse failure than no knob, because the run looks configured.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const collectTurnCalls: number[] = [];

vi.mock('#platform/server/routes/situation-chat.js', () => ({
  collectTurn: vi.fn(async (_client: unknown, _session: unknown, timeoutMs: number) => {
    collectTurnCalls.push(timeoutMs);
    // Stop the kernel at the WS boundary — this test is about the ceiling, not
    // about parsing a reply.
    throw new Error('collectTurn stub: stopping after capturing the timeout');
  }),
}));

vi.mock('#app/runtime/replay/temporal-evidence-view.js', () => ({
  visibleEvidenceFor: () => [],
  heldEvidenceFor: () => [],
}));

vi.mock('#app/runtime/replay/enrichment-store.js', () => ({
  visibleEnrichmentsAt: () => [],
}));

/**
 * The kernel loads the run through a DYNAMIC RELATIVE import
 * (`await import('./replay-runner-p0013.js')`), which does not resolve to the
 * same module id as the `#app/...` alias — so a `vi.mock` on the alias path
 * does not intercept it. Rather than fight the resolver, hand the kernel a
 * minimal db stub that satisfies the one query it makes
 * (`replay-runner-p0013.ts:272` loadRun). Everything after that point is the
 * WS boundary this test is about.
 */
const RUN_ROW = {
  id: 'r-timeout', status: 'RUNNING', current_step: 0,
  current_business_date: '2026-09-02',
  start_business_date: '2026-09-02', end_business_date: '2026-09-12',
  shop_id: 's', shop_name: 'n', source_dataset_path: 'data/x',
  source_manifest_hash: 'h', blocked_business_date: null, blocked_reason: null,
};

const fakeDb = {
  prepare: () => ({ get: () => RUN_ROW, all: () => [], run: () => ({ changes: 0 }) }),
} as never;

const { createReplayCognitionKernel, DEFAULT_REPLAY_TURN_TIMEOUT_MS } = await import(
  '#app/runtime/replay/replay-cognition-kernel.js'
);
const { resolveReplayTurnTimeoutMs } = await import('#platform/server/routes/replay.js');

const fakeClient = {
  submitPrompt: async () => undefined,
  close: () => undefined,
} as never;

const runKernel = async (opts: { turnTimeoutMs?: number } = {}) => {
  const kernel = createReplayCognitionKernel(fakeDb, {
    client: fakeClient,
    sessionId: 'sess-timeout',
    ...opts,
  });
  await expect(kernel('r-timeout', 'step-1', '2026-09-02')).rejects.toThrow();
};

describe('Replay turn wait ceiling', () => {
  beforeEach(() => { collectTurnCalls.length = 0; });

  it('defaults to 600_000ms so existing callers are unchanged', async () => {
    // Act
    await runKernel();

    // Assert
    expect(DEFAULT_REPLAY_TURN_TIMEOUT_MS).toBe(600_000);
    expect(collectTurnCalls).toEqual([600_000]);
  });

  it('passes an explicit override through to collectTurn', async () => {
    // Act — the P0013.4 acceptance value
    await runKernel({ turnTimeoutMs: 900_000 });

    // Assert
    expect(collectTurnCalls).toEqual([900_000]);
  });
});

describe('resolveReplayTurnTimeoutMs', () => {
  it('falls back to the 600s default when unset or blank', () => {
    expect(resolveReplayTurnTimeoutMs(undefined)).toBe(600_000);
    expect(resolveReplayTurnTimeoutMs('')).toBe(600_000);
    expect(resolveReplayTurnTimeoutMs('   ')).toBe(600_000);
  });

  it('accepts a positive integer of milliseconds', () => {
    expect(resolveReplayTurnTimeoutMs('900000')).toBe(900_000);
    expect(resolveReplayTurnTimeoutMs('1200000')).toBe(1_200_000);
  });

  it('falls back — and says so — on a malformed value rather than silently changing timing', () => {
    // Arrange — a typo must not disable the ceiling, and must not be silent.
    const warnings: string[] = [];
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(((w: string | Error) => {
      warnings.push(String(w));
    }) as never);

    // Act
    const result = resolveReplayTurnTimeoutMs('ten minutes');

    // Assert
    expect(result).toBe(600_000);
    expect(warnings.join(' ')).toMatch(/REPLAY_TURN_TIMEOUT_MS/);
    spy.mockRestore();
  });

  it('rejects zero and negative values', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation((() => undefined) as never);
    expect(resolveReplayTurnTimeoutMs('0')).toBe(600_000);
    expect(resolveReplayTurnTimeoutMs('-1')).toBe(600_000);
    spy.mockRestore();
  });
});
