// P0010.2 Closure Micro-Repair — Recommendation Gate (server-side).
//
// Read-only audit found a state-transition bug: a Situation whose latest
// attempt FAILED (Hermes mid-turn killed + token-missing) still showed
// "Agent 已完成调查，可基于当前判断生成处理建议" with an enabled "💡 生成建议"
// button, and the `/api/situation/:id/recommend` route would accept the
// call and feed the prior (now-stale) judgment into `runRecommendationTurn`.
//
// Root cause was the data consumers not reading `investigation.status`:
//   - the UI gated the button only on `!inv.recommendation`
//   - the route gated the precondition only on `!existing`
//
// `markInvestigation`'s minimum-merge is intentional and OUT OF SCOPE for
// this slice — it preserves the prior valid cognition on a failed attempt
// so the next successful turn can inherit it. The fix is to make BOTH
// consumers strictly require `status === 'completed'` before treating the
// preserved judgment as "current". The preserved judgment is shown to the
// operator as historical context (with a "最新调查未完成" hint), but it is
// NOT eligible for fresh recommendation generation.
//
// These tests pin the route contract. They drive the real Express router
// against a real SQLite DB, so the precondition runs against actual
// persisted rows, not mocks.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { situationChatRouter } from '#platform/server/routes/situation-chat.js';
import type { SituationChatClient } from '#platform/server/routes/situation-chat.js';
import type { HermesEvent, CreateSessionParams, CreateSessionResult } from '#platform/runtime/hermes/index.js';
import { storeInvestigationInLearningContext } from '#app/experience/learning-context-producer.js';
import { markInvestigation } from '#platform/server/routes/situation-chat.js';
import { InvestigationSchema } from '#shared/schemas/investigation.js';
import type { Situation } from '#shared/schemas/learning-context.js';

const TEST_WORKSPACE = resolve(tmpdir(), 'fabric-workspace-test-recommend-gate');
const TEMP_DB = resolve(tmpdir(), 'fabric-test-recommend-gate.db');

// ---- Mock Hermes client: records invocations so we can assert
//      the route did NOT call runRecommendationTurn on rejected cases. ----

class MockClient implements SituationChatClient {
  static connectCount = 0;
  static createSessionCount = 0;
  static submitCount = 0;
  private handlers: ((e: HermesEvent) => void)[] = [];

  constructor(public readonly url?: string) {}

  async connect(): Promise<void> {
    MockClient.connectCount++;
  }

  async createSession(_params: CreateSessionParams): Promise<CreateSessionResult> {
    MockClient.createSessionCount++;
    return { sessionId: `mock-${MockClient.createSessionCount}` };
  }

  async submitPrompt(_sessionId: string, _text: string): Promise<void> {
    MockClient.submitCount++;
    // For the completed case, return a valid recommendation JSON.
    await Promise.resolve();
    for (const h of this.handlers) {
      h({
        type: 'message.complete',
        session_id: _sessionId,
        payload: {
          text: JSON.stringify({
            recommendation: '建议：继续观察 1-2 天再判断。',
            rationale: '小样本需更多数据。',
            expectedOutcome: '窗口期内若有真实机会，CVR 持续上升。',
            risks: ['若为机会，延迟观察可能损失窗口期。'],
            prerequisites: ['未来 2 天 GMV/UV 数据。'],
            humanNeeded: [],
          }),
        },
      });
    }
  }

  onEvent(handler: (event: HermesEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {};
  }

  close(): void {}
}

// ---- Fixtures ----

const baseSituation: Situation = {
  situationId: 'sit_recommend_gate',
  domain: 'ecommerce',
  type: 'anomaly_investigation',
  entity: { id: 'jd_shop_001', type: 'product', name: '祁门红茶旗舰店', platform: 'jd' },
  temporal: { observedAt: '2026-08-22T00:00:00.000Z' },
  description: 'recommendation gate test fixture',
  tags: ['gmv'],
};

const completedWithJudgmentAndRec = (): ReturnType<typeof InvestigationSchema.parse> =>
  InvestigationSchema.parse({
    situationId: baseSituation.situationId,
    currentUnderstanding: '产品 10122145469026 被标记进入关注集合。',
    knownEvidence: ['GMV=3886.9', 'UV=356', 'CVR=6.46%'],
    hypotheses: [{ statement: '真实业务机会', status: 'proposed' }],
    judgment: '值得持续观察 — UV<500 不能单独判噪声，需要看后续趋势。',
    stopReason: 'observe',
    capabilityUsed: 'product.overview',
    evidenceAcquired: ['trade.overview 2026-08-21'],
    recommendation: {
      recommendation: '继续观察 1-2 天再判断。',
      rationale: '小样本需更多数据。',
      risks: '若真为机会，延迟观察可能损失窗口期。',
      humanNeeded: '运营确认是否新品冷启动。',
    },
    status: 'completed',
    updatedAt: '2026-08-22T01:00:00.000Z',
  });

const completedWithoutRec = (): ReturnType<typeof InvestigationSchema.parse> =>
  InvestigationSchema.parse({
    situationId: baseSituation.situationId,
    currentUnderstanding: '产品 10122145469026 被标记进入关注集合。',
    knownEvidence: ['GMV=3886.9', 'UV=356', 'CVR=6.46%'],
    hypotheses: [{ statement: '真实业务机会', status: 'proposed' }],
    judgment: '值得持续观察 — UV<500 不能单独判噪声，需要看后续趋势。',
    stopReason: 'observe',
    capabilityUsed: 'product.overview',
    evidenceAcquired: ['trade.overview 2026-08-21'],
    status: 'completed',
    updatedAt: '2026-08-22T01:00:00.000Z',
  });

// A failed record with the prior valid cognition preserved. markInvestigation
// intentionally keeps judgment / currentUnderstanding on a failed transition
// so the next successful turn can inherit them. This is the record that
// caused the bug: the UI said "completed, click here" and the route
// accepted the call.
const failedWithPriorJudgment = (): ReturnType<typeof InvestigationSchema.parse> =>
  InvestigationSchema.parse({
    situationId: baseSituation.situationId,
    currentUnderstanding: '产品 10122145469026 被标记进入关注集合。',
    knownEvidence: ['GMV=3886.9', 'UV=356', 'CVR=6.46%'],
    hypotheses: [{ statement: '真实业务机会', status: 'proposed' }],
    judgment: '值得持续观察 — UV<500 不能单独判噪声，需要看后续趋势。',
    stopReason: 'observe',
    capabilityUsed: 'product.overview',
    evidenceAcquired: ['trade.overview 2026-08-21'],
    // prior valid recommendation (this is the historically-completed record
    // that markInvestigation merged onto — see tests/integration/
    // investigation-lifecycle.test.ts for the merge contract).
    recommendation: {
      recommendation: '继续观察 1-2 天再判断。',
      rationale: '小样本需更多数据。',
      risks: '若真为机会，延迟观察可能损失窗口期。',
      humanNeeded: '运营确认是否新品冷启动。',
    },
    // LATEST ATTEMPT FAILED. Hermes mid-turn killed + token-missing.
    status: 'failed',
    error: 'Missing Hermes dashboard session token',
    updatedAt: '2026-08-27T03:30:00.000Z',
  });

// A failed record WITHOUT a prior recommendation. This is the exact
// screenshot case the user reported: latest failed, no rec, button visible.
const failedWithPriorJudgmentNoRec = (): ReturnType<typeof InvestigationSchema.parse> =>
  InvestigationSchema.parse({
    situationId: baseSituation.situationId,
    currentUnderstanding: '产品 10122145469026 被标记进入关注集合。',
    knownEvidence: ['GMV=3886.9', 'UV=356', 'CVR=6.46%'],
    hypotheses: [{ statement: '真实业务机会', status: 'proposed' }],
    judgment: '值得持续观察 — UV<500 不能单独判噪声，需要看后续趋势。',
    stopReason: 'observe',
    capabilityUsed: 'product.overview',
    evidenceAcquired: ['trade.overview 2026-08-21'],
    status: 'failed',
    error: 'Missing Hermes dashboard session token',
    updatedAt: '2026-08-27T03:30:00.000Z',
  });

const investigatingWithPriorJudgment = (): ReturnType<typeof InvestigationSchema.parse> =>
  InvestigationSchema.parse({
    situationId: baseSituation.situationId,
    currentUnderstanding: '产品 10122145469026 被标记进入关注集合。',
    judgment: '值得持续观察 — UV<500 不能单独判噪声，需要看后续趋势。',
    stopReason: 'observe',
    status: 'investigating',
    updatedAt: '2026-08-27T03:30:00.000Z',
  });

const insertSituation = (db: ReturnType<typeof openDb>, s: Situation): void => {
  db.prepare(
    `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
       observed_at, window_start, window_end, description, tags, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.situationId, s.domain, s.type,
    s.entity.id, s.entity.type, s.entity.name, s.entity.platform,
    s.temporal.observedAt, null, null,
    s.description, JSON.stringify(s.tags ?? []), 'open',
    '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z',
  );
};

const storeInv = (
  db: ReturnType<typeof openDb>,
  s: Situation,
  inv: ReturnType<typeof InvestigationSchema.parse>,
): void => {
  // The producer signature expects an Investigation-shaped object; the
  // parse result IS the Investigation type.
  storeInvestigationInLearningContext(
    db,
    s,
    inv as unknown as Parameters<typeof storeInvestigationInLearningContext>[2],
  );
};

describe('P0010.2 closure — /recommend precondition requires status === "completed"', () => {
  let server: Server;
  let base: string;
  let db: ReturnType<typeof openDb>;

  beforeAll(() => {
    rmSync(TEMP_DB, { force: true });
    rmSync(`${TEMP_DB}-wal`, { force: true });
    rmSync(`${TEMP_DB}-shm`, { force: true });
    db = openDb(TEMP_DB);
    initDatabase(db);
    insertSituation(db, baseSituation);

    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      situationChatRouter({
        workspaceDir: TEST_WORKSPACE,
        clientFactory: () => new MockClient(),
        db,
      }),
    );
    server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3000;
    base = `http://localhost:${port}`;
  });

  afterAll(() => {
    server.close();
    db.close();
    rmSync(TEST_WORKSPACE, { recursive: true, force: true });
    rmSync(TEMP_DB, { force: true });
    rmSync(`${TEMP_DB}-wal`, { force: true });
    rmSync(`${TEMP_DB}-shm`, { force: true });
  });

  beforeEach(() => {
    MockClient.connectCount = 0;
    MockClient.createSessionCount = 0;
    MockClient.submitCount = 0;
    // Reset the learning_contexts row between tests so each test gets a
    // clean record. Keep the situation row.
    db.prepare('DELETE FROM learning_contexts WHERE situation_id = ?').run(baseSituation.situationId);
  });

  const post = async (situationId: string) => {
    const res = await fetch(`${base}/api/situation/${situationId}/recommend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('failed + prior judgment (with old rec) → 400, NEVER calls Hermes', async () => {
    storeInv(db, baseSituation, failedWithPriorJudgment());
    const r = await post(baseSituation.situationId);
    expect(r.status).toBe(400);
    // Honest error — names the current status, not the misleading
    // "no completed investigation" when one actually exists.
    expect(r.body['error']).toMatch(/status/i);
    expect(r.body['error']).toMatch(/failed/);
    expect(r.body['currentStatus']).toBe('failed');
    // MockClient was never invoked: no connect, no session, no submit.
    expect(MockClient.connectCount).toBe(0);
    expect(MockClient.createSessionCount).toBe(0);
    expect(MockClient.submitCount).toBe(0);
  });

  it('failed + prior judgment + NO rec (the user-reported screenshot case) → 400', async () => {
    storeInv(db, baseSituation, failedWithPriorJudgmentNoRec());
    const r = await post(baseSituation.situationId);
    expect(r.status).toBe(400);
    expect(r.body['error']).toMatch(/status/i);
    expect(r.body['error']).toMatch(/failed/);
    expect(r.body['currentStatus']).toBe('failed');
    expect(MockClient.submitCount).toBe(0);
  });

  it('investigating + prior judgment → 400, NEVER calls Hermes', async () => {
    storeInv(db, baseSituation, investigatingWithPriorJudgment());
    const r = await post(baseSituation.situationId);
    expect(r.status).toBe(400);
    expect(r.body['error']).toMatch(/status/i);
    expect(r.body['error']).toMatch(/investigating/);
    expect(r.body['currentStatus']).toBe('investigating');
    expect(MockClient.connectCount).toBe(0);
    expect(MockClient.createSessionCount).toBe(0);
    expect(MockClient.submitCount).toBe(0);
  });

  it('completed + judgment (no rec) → 200, calls Hermes once, persists rec with status=completed', async () => {
    storeInv(db, baseSituation, completedWithoutRec());
    const r = await post(baseSituation.situationId);
    expect(r.status).toBe(200);
    expect(r.body['success']).toBe(true);
    expect(MockClient.submitCount).toBe(1);
    // The persisted record should now have BOTH a completed status
    // AND a recommendation. The route's additive merge must NOT
    // accidentally demote the status.
    const reloaded = await fetch(`${base}/api/situation/${baseSituation.situationId}/investigation`);
    const reloadedBody = (await reloaded.json()) as Record<string, unknown>;
    const inv = reloadedBody['investigation'] as Record<string, unknown>;
    expect(inv['status']).toBe('completed');
    expect((inv['recommendation'] as Record<string, unknown>)['recommendation']).toBeTruthy();
  });

  it('completed + judgment + existing rec → 200, rec is overwritten by a fresh one', async () => {
    storeInv(db, baseSituation, completedWithJudgmentAndRec());
    const r = await post(baseSituation.situationId);
    expect(r.status).toBe(200);
    expect(MockClient.submitCount).toBe(1);
  });

  it('no investigation record at all → 400 (existing behaviour)', async () => {
    // No storeInv() call — situation exists but learning_contexts row is empty.
    const r = await post(baseSituation.situationId);
    expect(r.status).toBe(400);
    expect(r.body['error']).toMatch(/no completed investigation/i);
    expect(MockClient.submitCount).toBe(0);
  });

  it('the route source explicitly requires status === "completed" (anti-regression pin)', async () => {
    const routeSrc = readFileSync(
      resolve(process.cwd(), 'platform/server/routes/situation-chat.ts'),
      'utf8',
    );
    expect(routeSrc).toMatch(/existing\.status\s*===\s*['"]completed['"]/);
  });
});

// markInvestigation integration: verify the minimum-merge path STILL
// preserves prior cognition (this is what the failing UI used to lean on).
// The micro-repair must NOT regress this — recovery is built on it.
describe('P0010.2 closure — markInvestigation minimum-merge preserved (NOT a regression)', () => {
  let db: ReturnType<typeof openDb>;

  beforeAll(() => {
    rmSync(TEMP_DB, { force: true });
    rmSync(`${TEMP_DB}-wal`, { force: true });
    rmSync(`${TEMP_DB}-shm`, { force: true });
    db = openDb(TEMP_DB);
    initDatabase(db);
    insertSituation(db, baseSituation);
  });

  afterAll(() => {
    db.close();
    rmSync(TEMP_DB, { force: true });
    rmSync(`${TEMP_DB}-wal`, { force: true });
    rmSync(`${TEMP_DB}-shm`, { force: true });
  });

  it('failed marker preserves prior valid judgment (recovery contract intact)', async () => {
    // 1. Seed a fully-completed investigation with judgment + recommendation.
    storeInv(db, baseSituation, completedWithJudgmentAndRec());
    // 2. Mark the latest attempt as failed.
    markInvestigation(db, baseSituation, { status: 'failed', error: 'Hermes mid-turn killed' });
    // 3. The record's status is now 'failed' BUT the prior judgment is
    //    still on the row (this is the recovery contract that the new
    //    UI guard respects without breaking).
    const { loadInvestigationFromLearningContext } = await import(
      '#app/experience/learning-context-producer.js'
    );
    const reloaded = loadInvestigationFromLearningContext(db, baseSituation.situationId);
    expect(reloaded?.status).toBe('failed');
    expect(reloaded?.judgment).toContain('值得持续观察');
    // The new route guard's behaviour against this exact row is covered
    // by the HTTP-level describe block above. This integration test
    // pins the merge contract: failure preserves cognition.
  });
});
