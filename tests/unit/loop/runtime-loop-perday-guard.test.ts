// P0010.2.11 C1.7 — RuntimeLoop autonomous per-day acquisition guard.
//
// The Loop drives acquisition through `runner.runNow()`, which does NOT
// check the scheduler's per-day guard (that guard only lives inside
// scheduler.tick(), behind `start()`). C1.7 moved the guard into the
// Loop's `runCapability`: the first COMPLETED acquisition for a
// (capability, business_date) pair is executed; every later tick on the
// same date skips — no JD page visit, no evidence overwrite, and the
// event emitted is `acquisition_skipped` (never a synthetic
// `acquisition_succeeded`). A new business_date re-enables acquisition.
//
// The real ScheduledAcquisitionRunner is mocked out here: these tests
// assert the Loop's coordination ONLY, and must not touch the network /
// CDP (the real runner would route trade.overview to a live Chrome).

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';

const runNowMock = vi.hoisted(() => vi.fn());
const runnerListMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn());
const stopRunnerMock = vi.hoisted(() => vi.fn());

vi.mock('#app/runtime/scheduling/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#app/runtime/scheduling/index.js')>();
  return {
    ...actual,
    createScheduledAcquisitionRunner: vi.fn(() => ({
      start: startMock,
      stop: stopRunnerMock,
      runNow: runNowMock,
      list: runnerListMock,
    })),
  };
});

const runSituationProducerMock = vi.hoisted(() => vi.fn());
vi.mock('#app/runtime/situation/index.js', () => ({
  runSituationProducer: runSituationProducerMock,
}));

const { createRuntimeLoop } = await import('#app/runtime/loop/runtime-loop.js');

describe('RuntimeLoop per-day acquisition guard (C1.7)', () => {
  let db: Database.Database;

  const makeLoop = () => {
    const events: Array<{ kind: string; [key: string]: unknown }> = [];
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      autoStart: false,
      onEvent: (e) => events.push(e as { kind: string }),
    });
    return { loop, events };
  };

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    runNowMock.mockReset();
    runnerListMock.mockReset();
    runSituationProducerMock.mockReset();
    // Default: runNow "succeeds" — kernel wrote evidence, status completed.
    runNowMock.mockResolvedValue(undefined);
    runnerListMock.mockReturnValue([
      { capability: 'trade.overview', at: '00:00', enabled: true, lastRunAt: 'x', lastStatus: 'completed' },
    ]);
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  test('first tick of a business_date executes acquisition (started → succeeded)', async () => {
    const { loop, events } = makeLoop();
    await loop.tickNow();
    expect(runNowMock).toHaveBeenCalledTimes(1);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('acquisition_started');
    expect(kinds).toContain('acquisition_succeeded');
    expect(kinds).not.toContain('acquisition_skipped');
    loop.stop();
  });

  test('second tick on the same business_date skips (no runNow, no fake success)', async () => {
    const { loop, events } = makeLoop();
    await loop.tickNow();
    await loop.tickNow();

    expect(runNowMock).toHaveBeenCalledTimes(1); // only the first tick acquired
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'acquisition_succeeded')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'acquisition_skipped')).toHaveLength(1);
    const skip = events.find((e) => e.kind === 'acquisition_skipped');
    expect(skip?.capability).toBe('trade.overview');
    expect(skip?.date).toBe('2026-08-29');
    expect(skip?.reason).toBe('already_acquired_for_business_date');
    loop.stop();
  });

  test('a failed acquisition is not recorded — the next tick retries', async () => {
    runnerListMock.mockReturnValue([
      { capability: 'trade.overview', at: '00:00', enabled: true, lastRunAt: 'x', lastStatus: 'failed' },
    ]);
    const { loop, events } = makeLoop();
    await loop.tickNow(); // fails
    await loop.tickNow(); // retries

    expect(runNowMock).toHaveBeenCalledTimes(2);
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'acquisition_failed')).toHaveLength(2);
    expect(kinds).not.toContain('acquisition_skipped');
    loop.stop();
  });

  test('a new business_date re-enables acquisition', async () => {
    const { loop, events } = makeLoop();
    await loop.tickNow(); // 2026-08-29 — executes
    vi.setSystemTime(new Date('2026-08-30T10:00:00.000Z'));
    await loop.tickNow(); // 2026-08-30 — must execute again

    expect(runNowMock).toHaveBeenCalledTimes(2);
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'acquisition_succeeded')).toHaveLength(2);
    expect(kinds).not.toContain('acquisition_skipped');
    loop.stop();
  });
});
