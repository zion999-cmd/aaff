// P0010.2 — RuntimeLoop tests.
//
// The Loop composes three heavy modules: the ScheduledAcquisitionRunner
// (acquire), runSituationProducer (detect), and runInvestigationTurn (via
// a fake HermesSessionClient). We mock the dynamically-imported situation
// producer and the situation-chat route, inject a fake policy, and inject
// a fake Hermes client. What we test is the Loop's *coordination*: cadence
// (mutex), per-tick event sequence, schedule honors `enabled`, and
// investigation skipped when policy says skip.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// These tests run the REAL ScheduledAcquisitionRunner → real CDP acquisition
// against the live Chrome (no runner injection seam yet — see P0010.2.11 C1.7
// handoff). F1's forced 实时 mode click pushed a full tick past the 5s
// default; the file-wide budget reflects the real acquisition cost.
vi.setConfig({ testTimeout: 30_000 });
import type Database from 'better-sqlite3';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { HermesSessionClient } from '#platform/runtime/hermes/index.js';
import type {
  InvestigationPolicy,
  PolicyDecision,
  PolicyContext,
} from '#app/runtime/loop/investigation-policy.js';

// ---- Hoisted mocks (declared before any `import` of the SUT) -------------

const runSituationProducerMock = vi.hoisted(() => vi.fn());
const runInvestigationTurnMock = vi.hoisted(() => vi.fn());
const markInvestigationMock = vi.hoisted(() => vi.fn());
const closeClientMock = vi.hoisted(() => vi.fn());
const connectClientMock = vi.hoisted(() => vi.fn());
const createSessionMock = vi.hoisted(() => vi.fn());
// P0010.2 Final Closure Repair (191cdd1) — `connectWithSituationTrace` is
// imported from the same route module; the test factory must export a stub
// or the call inside the loop's `investigate()` will throw (undefined is not
// a function), which fails every test that expects the connect → createSession
// → runInvestigationTurn → close chain to fire.
const connectWithSituationTraceMock = vi.hoisted(() => vi.fn());

vi.mock('#app/runtime/situation/index.js', () => ({
  runSituationProducer: runSituationProducerMock,
}));

vi.mock('#platform/server/routes/situation-chat.js', () => ({
  runInvestigationTurn: runInvestigationTurnMock,
  markInvestigation: markInvestigationMock,
  connectWithSituationTrace: connectWithSituationTraceMock,
}));

// Fake HermesSessionClient — the Loop's `hermesClientFactory` returns one of
// these. We extend the real class so the structural type matches; only the
// three methods the Loop actually calls are wired to the hoisted mocks.
class FakeHermesClient extends HermesSessionClient {
  override connect = connectClientMock;
  override createSession = createSessionMock;
  override close = closeClientMock;
}

const { createRuntimeLoop } = await import('#app/runtime/loop/runtime-loop.js');

const fakePolicy = (decisions: Map<string, PolicyDecision>): InvestigationPolicy => ({
  shouldInvestigate: (ctx: PolicyContext): PolicyDecision => {
    const d = decisions.get(ctx.situationId);
    if (d) return d;
    return { kind: 'investigate', reason: 'new_situation' };
  },
});

const NOW = '2026-08-25T00:00:00.000Z';

const seedSituation = (db: Database.Database, situationId: string) => {
  db.prepare(
    `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
       observed_at, description, tags, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    situationId, 'ecommerce', 'anomaly_investigation',
    'jd_shop_001', 'shop', '祁门红茶旗舰店', 'jd',
    NOW, 'test', JSON.stringify(['test']), 'open', NOW, NOW,
  );
};

const insertLearningContext = (
  db: Database.Database,
  situationId: string,
  body: Record<string, unknown>,
) => {
  db.prepare(
    `INSERT INTO learning_contexts (context_id, situation_id, lifecycle, created_at, updated_at, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`ctx_${situationId}`, situationId, 'partial', NOW, NOW, JSON.stringify(body));
};

const buildContextBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contextId: 'ctx_test',
  situation: {
    situationId: 'sit_default',
    domain: 'ecommerce',
    type: 'anomaly_investigation',
    entity: { id: 'jd_shop_001', type: 'shop' },
    temporal: { observedAt: NOW },
    description: 'test',
    tags: ['test'],
  },
  lifecycle: 'partial',
  createdAt: NOW,
  updatedAt: NOW,
  observations: [],
  evidenceIds: [],
  signalIds: [],
  agentActivities: [],
  humanInterventions: [],
  actions: [],
  outcomes: [],
  outputs: [],
  summary: {
    capabilitiesUsed: [],
    agentRuntimes: [],
    humanActors: [],
    totalEvidence: 0,
    totalSignals: 0,
  },
  ...overrides,
});

const collectEvents = () => {
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  const sink = (e: { kind: string; [key: string]: unknown }) => { events.push(e); };
  return { events, sink };
};

describe('createRuntimeLoop', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    initDatabase(db);
    runSituationProducerMock.mockReset();
    runInvestigationTurnMock.mockReset();
    connectClientMock.mockReset();
    createSessionMock.mockReset();
    closeClientMock.mockReset();
    // Default no-op — connectWithSituationTrace would normally forward to
    // client.connect() and stamp a situation-scoped trace event. In tests
    // we don't care about the trace; the FakeHermesClient already wires
    // `connect = connectClientMock`, so calling client.connect() would
    // double-count. The stub below forwards to the connect mock instead,
    // preserving the existing assertion that `connectClientMock` fires
    // once per investigation.
    connectWithSituationTraceMock.mockImplementation(
      async (client: { connect: () => Promise<void> }) => client.connect(),
    );
    // Default impls — tests override as needed.
    connectClientMock.mockResolvedValue(undefined);
    createSessionMock.mockResolvedValue({ sessionId: 'sess_test_001' });
    runInvestigationTurnMock.mockResolvedValue({
      ok: true,
      status: 'completed',
      investigation: {
        status: 'completed',
        judgment: 'mock judgment',
        stopReason: 'judgment',
        updatedAt: NOW,
        recommendation: {
          recommendation: 'mock rec',
          rationale: '',
          expectedOutcome: '',
          risks: [],
          prerequisites: [],
          humanNeeded: [],
        },
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  test('start() emits loop_started; tickNow runs the full chain and emits tick_started → tick_done', async () => {
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy: fakePolicy(new Map()),
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
    });

    loop.start();
    expect(events.some((e) => e.kind === 'loop_started')).toBe(true);
    expect(loop.list().running).toBe(true);

    const summary = await loop.tickNow();
    expect(summary.capabilities).toBe(1);
    expect(summary.situationsCreated).toBe(0);
    expect(summary.situationsDeduped).toBe(0);
    expect(summary.investigationsTriggered).toBe(0);
    expect(summary.investigationsSkipped).toBe(0);
    expect(summary.errors).toEqual([]);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('loop_started');
    expect(kinds).toContain('tick_started');
    expect(kinds).toContain('acquisition_started');
    expect(kinds).toContain('acquisition_succeeded');
    expect(kinds).toContain('situations_updated');
    expect(kinds).toContain('tick_done');

    loop.stop();
  });

  test('two consecutive ticks dedup the situation producer (first creates, second dedupes)', async () => {
    // Tick 1: producer creates 2 situations (sit_a, sit_b). Policy says skip both.
    // Tick 2: producer returns 0 created / 2 skipped (no candidates) — the
    // dedup is reported in the summary but no investigation runs.
    runSituationProducerMock
      .mockReturnValueOnce({ created: 2, skipped: 0, createdIds: ['sit_a', 'sit_b'], situations: [] })
      .mockReturnValueOnce({ created: 0, skipped: 2, createdIds: [], situations: [] });

    const policy = fakePolicy(new Map([
      ['sit_a', { kind: 'skip', reason: 'no_meaningful_change' as const }],
      ['sit_b', { kind: 'skip', reason: 'no_meaningful_change' as const }],
    ]));
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy,
      hermesClientFactory: () => new FakeHermesClient(),
      autoStart: false,
    });

    const s1 = await loop.tickNow();
    expect(s1.situationsCreated).toBe(2);
    expect(s1.situationsDeduped).toBe(0);
    expect(s1.investigationsSkipped).toBe(2);
    expect(s1.investigationsTriggered).toBe(0);

    const s2 = await loop.tickNow();
    expect(s2.situationsCreated).toBe(0);
    expect(s2.situationsDeduped).toBe(2);
    // Second tick: no createdIds and no `situations` → no candidates → no
    // policy decisions are made. The "skipped" count is 0 even though the
    // situation producer reported 2 deduped.
    expect(s2.investigationsSkipped).toBe(0);
    expect(s2.investigationsTriggered).toBe(0);

    loop.stop();
  });

  test('mutex: a slow tickNow reuses the in-flight promise (no stacking)', async () => {
    // Make the connect() mock slow so the first tickNow() is mid-flight
    // when the second call happens. The producer is sync (the loop calls
    // it sync), so we use connect() as the blocking seam.
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    let releaseConnect: () => void = () => {};
    connectClientMock.mockImplementation(
      () => new Promise<void>((resolve) => { releaseConnect = resolve; }),
    );

    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      // policy triggers investigation for the (empty) candidate set — but
      // since `situationResult.createdIds` is empty, no investigation runs
      // and the slow connect() never blocks the producer-driven path. We
      // use a policy that returns skip so the test stays deterministic.
      policy: fakePolicy(new Map([
        ['anything', { kind: 'skip', reason: 'no_meaningful_change' as const }],
      ])),
      hermesClientFactory: () => new FakeHermesClient(),
      autoStart: false,
    });

    // First tickNow: starts a tick. The connect() inside the (skipped)
    // investigation path waits on the release. Both calls should reuse
    // the same in-flight promise.
    const a = loop.tickNow();
    const b = loop.tickNow();
    expect(a).toBe(b);

    // Release connect — the (empty) tick resolves.
    releaseConnect();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(ra.situationsCreated).toBe(0);

    loop.stop();
  });

  test('per-tick lastTickAt and tickCount advance after a successful tick', async () => {
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    const loop = createRuntimeLoop({
      db,
      schedule: [
        { capability: 'trade.overview', at: '00:00', enabled: true },
        { capability: 'traffic.overview', at: '00:05', enabled: true },
      ],
      tickMs: 60_000,
      policy: fakePolicy(new Map()),
      hermesClientFactory: () => new FakeHermesClient(),
      autoStart: false,
    });

    expect(loop.list().tickCount).toBe(0);
    expect(loop.list().lastTickAt).toBeNull();

    await loop.tickNow();
    const state = loop.list();
    expect(state.tickCount).toBe(1);
    expect(state.lastTickAt).not.toBeNull();
    // lastTickAt is an ISO 8601 string. Don't pin the date (the test runs at
    // real wall-clock time) — just assert it is a valid date.
    expect(() => new Date(state.lastTickAt!).toISOString()).not.toThrow();
    expect(Number.isNaN(new Date(state.lastTickAt!).getTime())).toBe(false);

    await loop.tickNow();
    expect(loop.list().tickCount).toBe(2);

    loop.stop();
  });

  test('stop() then start() resets the timer and emits a fresh loop_started', async () => {
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy: fakePolicy(new Map()),
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
    });

    loop.start();
    loop.stop();
    expect(events.filter((e) => e.kind === 'loop_started')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'loop_stopped')).toHaveLength(1);
    expect(loop.list().running).toBe(false);

    loop.start();
    expect(events.filter((e) => e.kind === 'loop_started')).toHaveLength(2);
    expect(loop.list().running).toBe(true);
    loop.stop();
  });

  test('disabled schedule entries are skipped (capabilities=0)', async () => {
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    const loop = createRuntimeLoop({
      db,
      schedule: [
        { capability: 'trade.overview', at: '00:00', enabled: false },
        { capability: 'traffic.overview', at: '00:05', enabled: false },
      ],
      tickMs: 60_000,
      policy: fakePolicy(new Map()),
      hermesClientFactory: () => new FakeHermesClient(),
      autoStart: false,
    });

    const summary = await loop.tickNow();
    expect(summary.capabilities).toBe(0);
    expect(connectClientMock).not.toHaveBeenCalled();

    loop.stop();
  });

  test('investigation triggered path calls connect → createSession → runInvestigationTurn → close', async () => {
    runSituationProducerMock.mockReturnValue({
      created: 1,
      skipped: 0,
      createdIds: ['sit_inv'],
      situations: [],
    });
    const policy = fakePolicy(new Map([
      ['sit_inv', { kind: 'investigate', reason: 'new_situation' as const }],
    ]));
    seedSituation(db, 'sit_inv');

    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy,
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
    });

    const summary = await loop.tickNow();
    expect(summary.investigationsTriggered).toBe(1);
    expect(summary.investigationsSkipped).toBe(0);
    expect(connectClientMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(runInvestigationTurnMock).toHaveBeenCalledTimes(1);
    expect(closeClientMock).toHaveBeenCalledTimes(1);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('investigation_triggered');
    expect(kinds).toContain('investigation_completed');

    loop.stop();
  });

  test('investigation skipped when policy says skip (no connect, no investigation_turn)', async () => {
    runSituationProducerMock.mockReturnValue({
      created: 1,
      skipped: 0,
      createdIds: ['sit_only'],
      situations: [],
    });
    const policy = fakePolicy(new Map([
      ['sit_only', { kind: 'skip', reason: 'no_meaningful_change' as const }],
    ]));
    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy,
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
    });

    const summary = await loop.tickNow();
    expect(summary.investigationsTriggered).toBe(0);
    expect(summary.investigationsSkipped).toBe(1);
    const skipped = events.find((e) => e.kind === 'investigation_skipped');
    expect(skipped).toBeDefined();
    expect(skipped?.['reason']).toBe('no_meaningful_change');
    expect(skipped?.['situationId']).toBe('sit_only');
    expect(events.find((e) => e.kind === 'investigation_triggered')).toBeUndefined();
    expect(connectClientMock).not.toHaveBeenCalled();
    expect(runInvestigationTurnMock).not.toHaveBeenCalled();

    loop.stop();
  });

  test('tickNow is synchronous (no start needed)', async () => {
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy: fakePolicy(new Map()),
      hermesClientFactory: () => new FakeHermesClient(),
      autoStart: false, // explicit — we do NOT call start()
    });
    expect(loop.list().running).toBe(false);
    const summary = await loop.tickNow();
    expect(summary.capabilities).toBe(1);
  });

  // P0010.2.2 — Recovery integration tests.
  // The Loop calls listRecoverableCandidates on every tick; this section
  // pins the integration contract:
  //   - pre-existing open situation without a learning_context → recovery
  //     triggers the policy + investigation
  //   - a recovered candidate is excluded from the producer's output
  //     (no double-investigation)
  //   - a blocked situation (>= 3 failures) emits investigation_blocked
  //     and does NOT call Hermes
  //   - the recovery_candidates_found event is emitted with the kinds

  test('recovers a pre-existing open situation that has no learning_context', async () => {
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    seedSituation(db, 'sit_orphan');
    const policy = fakePolicy(new Map([
      ['sit_orphan', { kind: 'investigate', reason: 'recovery_no_investigation' as const }],
    ]));
    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy,
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
    });

    const summary = await loop.tickNow();
    expect(summary.investigationsTriggered).toBe(1);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('recovery_candidates_found');
    const recovered = events.find((e) => e.kind === 'recovery_candidates_found') as
      | { kind: 'recovery_candidates_found'; count: number; kinds: string[] }
      | undefined;
    expect(recovered?.count).toBe(1);
    expect(recovered?.kinds).toContain('no_investigation');
    const triggered = events.find((e) => e.kind === 'investigation_triggered') as
      | { kind: 'investigation_triggered'; situationId: string; reason: string }
      | undefined;
    expect(triggered?.reason).toBe('recovery_no_investigation');
    expect(connectClientMock).toHaveBeenCalledTimes(1);
    expect(runInvestigationTurnMock).toHaveBeenCalledTimes(1);

    loop.stop();
  });

  test('excludes producer-emitted situations from the recovery scan (no double-investigation)', async () => {
    // The producer emits sit_a (createdId). The DB has a separate
    // open situation sit_b without a learning_context. The recovery
    // scan must NOT include sit_a (it's already in the producer output).
    runSituationProducerMock.mockReturnValue({
      created: 1,
      skipped: 0,
      createdIds: ['sit_a'],
      situations: [],
    });
    seedSituation(db, 'sit_a');
    seedSituation(db, 'sit_b');
    const policy = fakePolicy(new Map([
      ['sit_a', { kind: 'investigate', reason: 'new_situation' as const }],
      ['sit_b', { kind: 'investigate', reason: 'recovery_no_investigation' as const }],
    ]));
    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy,
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
    });

    const summary = await loop.tickNow();
    expect(summary.investigationsTriggered).toBe(2);
    // sit_a is in the producer output; recovery scan should report
    // only sit_b.
    const recovered = events.find((e) => e.kind === 'recovery_candidates_found') as
      | { kind: 'recovery_candidates_found'; count: number; kinds: string[] }
      | undefined;
    expect(recovered?.count).toBe(1);
    expect(connectClientMock).toHaveBeenCalledTimes(2);
    expect(runInvestigationTurnMock).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  test('emits investigation_blocked and skips Hermes when the recovery scan sees a threshold-crossing candidate', async () => {
    // The recovery scan INCLUDES a situation whose consecutiveFailures
    // exactly equals the threshold (this is the threshold-crossing
    // tick — the policy's `blocked_runtime_failure` decision fires the
    // event, and the situation is then excluded on subsequent ticks).
    seedSituation(db, 'sit_blocked');
    insertLearningContext(db, 'sit_blocked', buildContextBody({
      situation: { situationId: 'sit_blocked', domain: 'ecommerce', type: 'anomaly_investigation',
        entity: { id: 'jd_shop_001', type: 'shop' },
        temporal: { observedAt: NOW }, description: 'test', tags: ['test'] },
      lifecycle: 'partial',
      createdAt: NOW,
      updatedAt: NOW,
      observations: [],
      evidenceIds: [],
      signalIds: [],
      agentActivities: [],
      humanInterventions: [],
      actions: [],
      outcomes: [],
      outputs: [],
      summary: { capabilitiesUsed: [], agentRuntimes: [], humanActors: [], totalEvidence: 0, totalSignals: 0 },
      investigation: { status: 'failed', error: 'crossed the threshold', updatedAt: NOW, consecutiveFailures: 3 },
    }));
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    const policy = fakePolicy(new Map([
      ['sit_blocked', { kind: 'skip', reason: 'blocked_runtime_failure' as const }],
    ]));
    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy,
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
      recoveryOptions: { maxConsecutiveFailures: 3 },
    });

    const summary = await loop.tickNow();
    expect(summary.investigationsTriggered).toBe(0);
    // Threshold-crossing tick: the recovery scan includes the situation,
    // the policy returns `blocked_runtime_failure`, the Loop emits the
    // `investigation_blocked` event, and Hermes is NOT called.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('investigation_blocked');
    expect(connectClientMock).not.toHaveBeenCalled();
    expect(runInvestigationTurnMock).not.toHaveBeenCalled();

    loop.stop();
  });

  test('does NOT include strictly-above-threshold situations (silence after the crossing tick)', async () => {
    // Once the policy has returned `blocked_runtime_failure` for a
    // situation and the operator has not cleared it, the recovery scan
    // excludes the situation entirely (count > max). Subsequent ticks
    // produce no event for it.
    seedSituation(db, 'sit_already_blocked');
    insertLearningContext(db, 'sit_already_blocked', buildContextBody({
      situation: { situationId: 'sit_already_blocked', domain: 'ecommerce', type: 'anomaly_investigation',
        entity: { id: 'jd_shop_001', type: 'shop' },
        temporal: { observedAt: NOW }, description: 'test', tags: ['test'] },
      lifecycle: 'partial',
      createdAt: NOW,
      updatedAt: NOW,
      observations: [],
      evidenceIds: [],
      signalIds: [],
      agentActivities: [],
      humanInterventions: [],
      actions: [],
      outcomes: [],
      outputs: [],
      summary: { capabilitiesUsed: [], agentRuntimes: [], humanActors: [], totalEvidence: 0, totalSignals: 0 },
      investigation: { status: 'failed', error: 'silenced', updatedAt: NOW, consecutiveFailures: 4 },
    }));
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    const policy = fakePolicy(new Map()); // empty — situation is not in the candidate set
    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy,
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
      recoveryOptions: { maxConsecutiveFailures: 3 },
    });

    const summary = await loop.tickNow();
    expect(summary.investigationsTriggered).toBe(0);
    const kinds = events.map((e) => e.kind);
    expect(kinds).not.toContain('investigation_blocked');
    expect(connectClientMock).not.toHaveBeenCalled();
    expect(runInvestigationTurnMock).not.toHaveBeenCalled();

    loop.stop();
  });

  test('emits investigation_blocked when a manually-pinned candidate crosses the threshold mid-tick (excludeIds bypass)', async () => {
    // Bypass the recovery scan by setting excludeIds to include the
    // blocked situation, and set a tight maxConsecutiveFailures=1 so
    // the policy's threshold check fires on the call.
    runSituationProducerMock.mockReturnValue({ created: 1, skipped: 0, createdIds: ['sit_x'], situations: [] });
    seedSituation(db, 'sit_x');
    const policy = fakePolicy(new Map([
      ['sit_x', { kind: 'skip', reason: 'blocked_runtime_failure' as const }],
    ]));
    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy,
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
      recoveryOptions: { excludeIds: new Set(['sit_x']), maxConsecutiveFailures: 1 },
    });

    await loop.tickNow();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('investigation_blocked');
    expect(connectClientMock).not.toHaveBeenCalled();

    loop.stop();
  });

  test('no recovery_candidates_found event when there is nothing to recover (normal tick)', async () => {
    runSituationProducerMock.mockReturnValue({ created: 0, skipped: 0, createdIds: [], situations: [] });
    const { events, sink } = collectEvents();
    const loop = createRuntimeLoop({
      db,
      schedule: [{ capability: 'trade.overview', at: '00:00', enabled: true }],
      tickMs: 60_000,
      policy: fakePolicy(new Map()),
      hermesClientFactory: () => new FakeHermesClient(),
      onEvent: sink,
      autoStart: false,
    });

    await loop.tickNow();
    const kinds = events.map((e) => e.kind);
    expect(kinds).not.toContain('recovery_candidates_found');

    loop.stop();
  });
});
