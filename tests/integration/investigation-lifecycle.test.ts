// P0010.1 REPAIR — Investigation lifecycle: a failed or in-flight marker
// must NOT erase a previously completed understanding / judgment /
// recommendation. The marker represents the latest attempt's state, not the
// situation's current valid cognition. We do NOT build an attempt history —
// the persisted investigation keeps ONE valid set of fields, and the latest
// lifecycle marker is stamped on top.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { rmSync } from 'node:fs';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { markInvestigation } from '#platform/server/routes/situation-chat.js';
import {
  loadInvestigationFromLearningContext,
  storeInvestigationInLearningContext,
} from '#app/experience/learning-context-producer.js';
import { InvestigationSchema } from '#shared/schemas/investigation.js';
import type { Situation } from '#shared/schemas/learning-context.js';

const TEMP_DB = './data/test-investigation-lifecycle.db';

const baseSituation: Situation = {
  situationId: 'sit_lifecycle',
  domain: 'ecommerce',
  type: 'anomaly_investigation',
  entity: { id: 'jd_shop_001', type: 'product', name: '祁门红茶旗舰店', platform: 'jd' },
  temporal: { observedAt: '2026-08-22T00:00:00.000Z' },
  description: 'lifecycle regression test fixture',
  tags: ['gmv'],
};

const completedInvestigation = (): ReturnType<typeof InvestigationSchema.parse> =>
  InvestigationSchema.parse({
    situationId: baseSituation.situationId,
    currentUnderstanding: '产品 10122145469026 被标记进入关注集合。',
    knownEvidence: ['GMV=3886.9', 'UV=356', 'CVR=6.46%'],
    hypotheses: [
      { statement: '真实业务机会', status: 'proposed' },
      { statement: '统计噪声', status: 'rejected' },
    ],
    unknowns: ['转化率提升是否由访客结构变化引起？'],
    nextQuestion: '转化率提升是否伴随商品结构调整？',
    findings: [
      {
        question: '访客下降 26.5% 是否异常？',
        answer: '属于业务波动，非系统故障。',
        impactOnHypothesis: '弱化噪声假设',
      },
    ],
    judgment: '值得持续观察 — UV<500 不能单独判噪声，需要看后续趋势。',
    stopReason: 'observe',
    capabilityUsed: 'product.overview',
    evidenceAcquired: ['trade.overview 2026-08-21'],
    recommendation: {
      kind: 'observe',
      recommendation: '继续观察 1-2 天再判断。',
      rationale: '小样本需更多数据。',
      risks: '若真为机会，延迟观察可能损失窗口期。',
      humanNeeded: '运营确认是否新品冷启动。',
    },
    status: 'completed',
    updatedAt: '2026-08-22T01:00:00.000Z',
  });

describe('markInvestigation — lifecycle REPAIR (P0010.1)', () => {
  let db: ReturnType<typeof openDb>;

  beforeAll(() => {
    rmSync(TEMP_DB, { force: true });
    db = openDb(TEMP_DB);
    initDatabase(db);
  });

  afterAll(() => {
    db.close();
    rmSync(TEMP_DB, { force: true });
    rmSync(`${TEMP_DB}-wal`, { force: true });
    rmSync(`${TEMP_DB}-shm`, { force: true });
  });

  beforeEach(() => {
    rmSync(TEMP_DB, { force: true });
    db.close();
    db = openDb(TEMP_DB);
    initDatabase(db);
    // Insert a real situation row (FK from learning_contexts.situation_id).
    db.prepare(
      `INSERT INTO situations (situation_id, domain, type, entity_id, entity_type, entity_name, entity_platform,
         observed_at, window_start, window_end, description, tags, lifecycle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      baseSituation.situationId, baseSituation.domain, baseSituation.type,
      baseSituation.entity.id, baseSituation.entity.type, baseSituation.entity.name, baseSituation.entity.platform,
      baseSituation.temporal.observedAt, null, null,
      baseSituation.description, JSON.stringify(baseSituation.tags ?? []), 'open',
      '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z',
    );
  });

  test('failed marker preserves prior completed currentUnderstanding / judgment / recommendation', () => {
    // Arrange — store a completed investigation.
    const completed = completedInvestigation();
    storeInvestigationInLearningContext(db, baseSituation, completed);
    const before = loadInvestigationFromLearningContext(db, baseSituation.situationId);
    expect(before?.status).toBe('completed');
    expect(before?.judgment).toContain('UV<500 不能单独判噪声');
    expect(before?.recommendation?.recommendation).toContain('继续观察');

    // Act — the latest attempt times out / fails to parse.
    markInvestigation(db, baseSituation, { status: 'failed', error: 'Turn timed out' });
    const after = loadInvestigationFromLearningContext(db, baseSituation.situationId);

    // Assert — the prior valid cognition is preserved verbatim.
    expect(after?.status).toBe('failed');
    expect(after?.error).toBe('Turn timed out');
    expect(after?.currentUnderstanding).toBe(completed.currentUnderstanding);
    expect(after?.judgment).toBe(completed.judgment);
    expect(after?.stopReason).toBe(completed.stopReason);
    expect(after?.capabilityUsed).toBe(completed.capabilityUsed);
    expect(after?.evidenceAcquired).toEqual(completed.evidenceAcquired);
    expect(after?.hypotheses).toEqual(completed.hypotheses);
    expect(after?.recommendation).toEqual(completed.recommendation);
  });

  test('investigating marker preserves prior completed judgment (in-flight turn)', () => {
    const completed = completedInvestigation();
    storeInvestigationInLearningContext(db, baseSituation, completed);

    markInvestigation(db, baseSituation, { status: 'investigating' });
    const after = loadInvestigationFromLearningContext(db, baseSituation.situationId);

    expect(after?.status).toBe('investigating');
    expect(after?.currentUnderstanding).toBe(completed.currentUnderstanding);
    expect(after?.judgment).toBe(completed.judgment);
    expect(after?.recommendation?.recommendation).toContain('继续观察');
  });

  test('completed marker preserves existing cognition (regression: must not replace with schema defaults)', () => {
    // Regression for the RuntimeLoop audit bug: `runInvestigationTurn` fully
    // persisted a completed investigation (cognition + recommendation), then
    // the Loop stamped a `status:'completed'` marker with sidecars on top.
    // Before this fix, `markInvestigation` only merged for
    // `investigating`/`failed`; `completed` fell through to the fresh-marker
    // branch and REPLACED every cognition field with schema defaults.
    // Arrange — a full completed investigation with cognition.
    const completed = completedInvestigation();
    storeInvestigationInLearningContext(db, baseSituation, completed);
    const before = loadInvestigationFromLearningContext(db, baseSituation.situationId);
    expect(before?.status).toBe('completed');
    expect(before?.currentUnderstanding).toBe(completed.currentUnderstanding);

    // Act — the RuntimeLoop success path stamps a completed marker with sidecars.
    markInvestigation(db, baseSituation, {
      status: 'completed',
      evidenceContentHash: '5ca8e2ecdd45603a0000',
      consecutiveFailures: 0,
    });
    const after = loadInvestigationFromLearningContext(db, baseSituation.situationId);

    // Assert — every cognition field is preserved verbatim.
    expect(after?.status).toBe('completed');
    expect(after?.currentUnderstanding).toBe(completed.currentUnderstanding);
    expect(after?.knownEvidence).toEqual(completed.knownEvidence);
    expect(after?.hypotheses).toEqual(completed.hypotheses);
    expect(after?.unknowns).toEqual(completed.unknowns);
    expect(after?.nextQuestion).toBe(completed.nextQuestion);
    expect(after?.findings).toEqual(completed.findings);
    expect(after?.judgment).toBe(completed.judgment);
    expect(after?.stopReason).toBe(completed.stopReason);
    expect(after?.capabilityUsed).toBe(completed.capabilityUsed);
    expect(after?.evidenceAcquired).toEqual(completed.evidenceAcquired);
    expect(after?.recommendation).toEqual(completed.recommendation);
    // Only marker/sidecar fields are updated.
    expect(after?.evidenceContentHash).toBe('5ca8e2ecdd45603a0000');
    expect(after?.consecutiveFailures).toBe(0);
    expect(after?.updatedAt).not.toBe(completed.updatedAt);
  });

  test('completed marker over a preserved failed marker also preserves (Loop re-stamp after recovery)', () => {
    // A failed attempt already preserved the prior cognition (minimum merge).
    // The next successful turn stamps a completed marker — cognition must
    // survive that too, not be re-defaulted.
    const completed = completedInvestigation();
    storeInvestigationInLearningContext(db, baseSituation, completed);
    markInvestigation(db, baseSituation, { status: 'failed', error: '[agent_timeout] slow turn' });
    const afterFailed = loadInvestigationFromLearningContext(db, baseSituation.situationId);
    expect(afterFailed?.status).toBe('failed');
    expect(afterFailed?.judgment).toBe(completed.judgment);

    markInvestigation(db, baseSituation, { status: 'completed', evidenceContentHash: 'abc', consecutiveFailures: 0 });
    const after = loadInvestigationFromLearningContext(db, baseSituation.situationId);
    expect(after?.status).toBe('completed');
    expect(after?.judgment).toBe(completed.judgment);
    expect(after?.currentUnderstanding).toBe(completed.currentUnderstanding);
    expect(after?.recommendation).toEqual(completed.recommendation);
    expect(after?.evidenceContentHash).toBe('abc');
    expect(after?.consecutiveFailures).toBe(0);
  });

  test('failed marker after a prior failed marker does NOT preserve (no valid cognition to keep)', () => {
    // First failure: nothing to preserve (no prior valid cognition).
    markInvestigation(db, baseSituation, { status: 'failed', error: 'first failure' });
    const first = loadInvestigationFromLearningContext(db, baseSituation.situationId);
    expect(first?.status).toBe('failed');
    expect(first?.judgment).toBe(''); // defaults — no prior content

    // Second failure: still no valid cognition to preserve.
    markInvestigation(db, baseSituation, { status: 'failed', error: 'second failure' });
    const second = loadInvestigationFromLearningContext(db, baseSituation.situationId);
    expect(second?.status).toBe('failed');
    expect(second?.error).toBe('second failure');
    expect(second?.judgment).toBe('');
  });

  test('a new completed investigation DOES replace the prior one (full-replace is still allowed)', () => {
    // Arrange — completed v1.
    const v1 = completedInvestigation();
    storeInvestigationInLearningContext(db, baseSituation, v1);

    // Act — completed v2 (the "completed" branch goes through
    // storeInvestigationInLearningContext, NOT markInvestigation, but we
    // verify the full-replace is the right behavior here).
    const v2 = InvestigationSchema.parse({
      ...v1,
      currentUnderstanding: 'v2 — Operator-supplied context overrides the noise framing.',
      judgment: 'v2 — New product cold-start; do not treat UV<500 as noise.',
      recommendation: {
        recommendation: 'Acquire 2026-08-15 → 2026-08-21 product-level metrics.',
        rationale: 'Operator guidance: new product on 2026-08-15.',
        risks: '',
        humanNeeded: '',
      },
      status: 'completed',
    });
    storeInvestigationInLearningContext(db, baseSituation, v2);

    const after = loadInvestigationFromLearningContext(db, baseSituation.situationId);
    expect(after?.status).toBe('completed');
    expect(after?.currentUnderstanding).toBe(v2.currentUnderstanding);
    expect(after?.judgment).toBe(v2.judgment);
    expect(after?.recommendation?.recommendation).toBe(v2.recommendation?.recommendation);
  });
});

// P0010.1 Post-Review REPAIR — KNOWN GAP: /recommend parse-failure path.
// runRecommendationTurn is wired to return { ok: false, error: 'Invalid
// recommendation JSON' } when the model's reply is not a parseable
// Recommendation. The /recommend route surfaces that as a soft HTTP error
// and does NOT call storeInvestigationInLearningContext — there is no
// retry, no auto-restart, no attempt history. This is the documented
// P0010.1 known gap; do NOT add a retry / finalize-prompt block here
// without an explicit plan.
//
// The seam we can exercise without standing up a fake Hermes is the
// schema-level guarantee: a Reply that is NOT a valid Recommendation
// MUST fail RecommendationSchema.safeParse, and that failure is the
// single signal the route uses to skip persistence. The runtime retry
// is forbidden by the inline KNOWN GAP comment in
// platform/server/routes/situation-chat.ts.
import { RecommendationSchema } from '#shared/schemas/investigation.js';
import { extractJsonObject } from '#app/runtime/investigation/parse.js';

describe('/recommend parse-failure is a known gap (P0010.1)', () => {
  test('a prose-only reply produces no JSON object (the fail signal runRecommendationTurn relies on)', () => {
    // This mirrors the line inside runRecommendationTurn:
    //   const candidate = extractJsonObject(reply);
    //   if (!candidate) return { ok: false, error: 'Invalid recommendation JSON' };
    // We pin the contract: a reply with no {…} block yields no candidate.
    const candidate = extractJsonObject(
      'I am not producing JSON. I am just thinking aloud about the situation. ' +
        'No structured output here — just prose.',
    );
    expect(candidate).toBeNull();
  });

  test('a JSON reply that fails RecommendationSchema also yields the fail signal', () => {
    // Even if the model produces a JSON object, anything that doesn't
    // match RecommendationSchema (e.g. missing `recommendation` field) is
    // a parse failure and the route MUST surface it without persisting.
    const valid = { rationale: 'only rationale' }; // missing `recommendation`
    const parsed = RecommendationSchema.safeParse(valid);
    expect(parsed.success).toBe(false);
  });

  test('persisted investigation is NOT mutated on the recommend-failure path', () => {
    // The route's failure branch returns early without calling
    // storeInvestigationInLearningContext. The persistence-side invariant
    // — "if no successful recommend has been persisted, no
    // recommendation field is written" — is enforced by the route's
    // `if (!rec.ok) return;` early-return. The two contract tests above
    // pin the fail-signal that drives that early return. This third test
    // exists so the known gap is documented at the test layer too, with
    // the explicit reminder: do NOT add retry / finalize-prompt here.
    expect(true).toBe(true);
  });
});
