// P0010.2.11 C2.0.1 — RuntimeLoop Beijing business date.
//
// The tick used to derive the capability business date from
// `startedAt.slice(0, 10)` — a UTC calendar date. During Beijing
// 00:00–08:00 (UTC 16:00–24:00 of the previous day) every autonomous
// trade.overview tick stamped the acquisition with YESTERDAY's date and
// the ADR-073 guard honestly rejected it (fail-closed, zero evidence
// written — correct behavior, wrong date input).
//
// These tests pin the LOOP's contract: the business date the tick
// computes and passes into `runner.runNow` MUST be the Beijing business
// date of the tick time — proved at the loop level (both the
// `tick_started` event and the `runNow` argument), not just on the
// `beijingDate()` utility.
//
// The acquisition seam is faked (mock ScheduledAcquisitionRunner) so no
// real CDP acquisition runs; a faked clock (Date only) drives the three
// required cases:
//   Case 1  2026-08-29T17:05:00Z  → 2026-08-30 (Beijing 8/30 01:05)
//   Case 2  2026-08-30T08:00:00Z  → 2026-08-30 (Beijing 8/30 16:00)
//   Case 3  15:59:59Z → 2026-08-29, 16:00:00Z → 2026-08-30 (rollover)

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { HermesSessionClient } from '#platform/runtime/hermes/index.js';

// ---- Hoisted mocks --------------------------------------------------------

const runNowMock = vi.hoisted(() => vi.fn());
const runSituationProducerMock = vi.hoisted(() => vi.fn());
const runInvestigationTurnMock = vi.hoisted(() => vi.fn());
const markInvestigationMock = vi.hoisted(() => vi.fn());
const closeClientMock = vi.hoisted(() => vi.fn());
const connectClientMock = vi.hoisted(() => vi.fn());
const createSessionMock = vi.hoisted(() => vi.fn());
const connectWithSituationTraceMock = vi.hoisted(() => vi.fn());

// Fake acquisition runner — records (capability, date) and reports
// `completed` so the per-day guard marks the date as done.
vi.mock('#app/runtime/scheduling/index.js', () => ({
  createScheduledAcquisitionRunner: () => ({
    start: () => {},
    stop: () => {},
    runNow: runNowMock,
    list: () =>
      runNowMock.mock.calls.map((call: unknown[]) => ({
        capability: call[0] as string,
        lastStatus: 'completed',
      })),
  }),
  resetSchedulerKernel: () => {},
}));

vi.mock('#app/runtime/situation/index.js', () => ({
  runSituationProducer: runSituationProducerMock,
}));

vi.mock('#platform/server/routes/situation-chat.js', () => ({
  runInvestigationTurn: runInvestigationTurnMock,
  markInvestigation: markInvestigationMock,
  connectWithSituationTrace: connectWithSituationTraceMock,
}));

class FakeHermesClient extends HermesSessionClient {
  override connect = connectClientMock;
  override createSession = createSessionMock;
  override close = closeClientMock;
}

const { createRuntimeLoop } = await import('#app/runtime/loop/runtime-loop.js');

const collectEvents = () => {
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  const sink = (e: { kind: string; [key: string]: unknown }) => { events.push(e); };
  return { events, sink };
};

describe('createRuntimeLoop business date (C2.0.1 — Beijing business date)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    runNowMock.mockReset();
    runSituationProducerMock.mockReset();
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    connectClientMock.mockReset().mockResolvedValue(undefined);
    createSessionMock.mockReset().mockResolvedValue({ sessionId: 'sess_test_001' });
    closeClientMock.mockReset();
    runInvestigationTurnMock.mockReset();
    markInvestigationMock.mockReset();
    connectWithSituationTraceMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  const buildLoop = (sink: (e: { kind: string }) => void) =>
    createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy: { shouldInvestigate: () => ({ kind: 'skip', reason: 'no_meaningful_change' as const }) },
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
    });

  const tickStartedDates = (events: Array<{ kind: string; [key: string]: unknown }>) =>
    events
      .filter((e) => e.kind === 'tick_started')
      .map((e) => e.date as string);

  test('Case 1: tick at 2026-08-29T17:05:00Z (Beijing 8/30 01:05) uses business_date 2026-08-30', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-29T17:05:00.000Z'), toFake: ['Date'] });
    const { events, sink } = collectEvents();
    const loop = buildLoop(sink);

    await loop.tickNow();

    // The date the LOOP computed (event) AND the date it passed into the
    // acquisition seam must both be the Beijing business date.
    expect(tickStartedDates(events)).toEqual(['2026-08-30']);
    expect(runNowMock).toHaveBeenCalledWith('trade.overview', '2026-08-30');
    loop.stop();
  });

  test('Case 2: tick at 2026-08-30T08:00:00Z (Beijing 16:00) uses business_date 2026-08-30', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-30T08:00:00.000Z'), toFake: ['Date'] });
    const { events, sink } = collectEvents();
    const loop = buildLoop(sink);

    await loop.tickNow();

    expect(tickStartedDates(events)).toEqual(['2026-08-30']);
    expect(runNowMock).toHaveBeenCalledWith('trade.overview', '2026-08-30');
    loop.stop();
  });

  test('Case 3: Beijing rollover — 15:59:59Z → 2026-08-29, then 16:00:00Z → 2026-08-30', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-29T15:59:59.000Z'), toFake: ['Date'] });
    const { events, sink } = collectEvents();
    const loop = buildLoop(sink);

    // Tick 1 — still Beijing 2026-08-29 (23:59:59).
    await loop.tickNow();
    // Tick 2 — one second later, Beijing midnight crossed → new business
    // date, so the per-day guard must NOT suppress the second acquisition.
    vi.setSystemTime(new Date('2026-08-29T16:00:00.000Z'));
    await loop.tickNow();

    expect(tickStartedDates(events)).toEqual(['2026-08-29', '2026-08-30']);
    expect(runNowMock).toHaveBeenCalledTimes(2);
    expect(runNowMock.mock.calls.map((c) => c[1])).toEqual(['2026-08-29', '2026-08-30']);
    // No per-day-guard skip: the rollover re-enabled acquisition.
    expect(events.some((e) => e.kind === 'acquisition_skipped')).toBe(false);
    loop.stop();
  });
});
