// P0010.1 Post-Productization REPAIR — Trust Links + Lifecycle + Output
// Contract tests.
//
// Pinned behavior:
//   - deriveSituationLifecycle: 5-state operator-facing lifecycle, derived
//     from the persisted investigation + intervention decisions. NO '已处理'
//     state; 'closed' is only when a decision='accept' intervention exists.
//   - deriveObservationCommitment: minimal representation of the
//     observation commitment (NO scheduler, NO wake engine).
//   - getSourcePopoverData: returns the available content for [E]/[K]/[H]/[M]
//     plus the honest "原始来源暂不可定位" surface for kinds without a
//     stable record (Memory always; Evidence/ Knowledge in dev mode only).
//   - WorkItemSchema: additive field on LearningContextSchema, status enum
//     transitions, no transport / no approval / no engine.

import { describe, expect, test } from 'vitest';
import {
  deriveSituationLifecycle,
  deriveObservationCommitment,
  getSourcePopoverData,
  renderSourcePopoverHtml,
  SITUATION_LIFECYCLE_LABEL,
} from '#app/workspace/presentation.js';
import { WorkItemSchema, WorkItemStatusSchema, WorkItemTypeSchema } from '#shared/schemas/output.js';
import { LearningContextSchema } from '#shared/schemas/learning-context.js';

// ── deriveSituationLifecycle ──────────────────────────────────────────

describe('deriveSituationLifecycle — 5-state operator-facing lifecycle', () => {
  test('null investigation → pending', () => {
    expect(deriveSituationLifecycle(null, 0, false)).toBe('pending');
  });

  test('investigation with status=pending → pending', () => {
    expect(deriveSituationLifecycle({ status: 'pending' }, 0, false)).toBe('pending');
  });

  test('investigation with status=investigating → investigating', () => {
    expect(deriveSituationLifecycle({ status: 'investigating' }, 0, false)).toBe('investigating');
  });

  test('failed-without-prior-cognition → pending (case is not actionable yet)', () => {
    expect(deriveSituationLifecycle({ status: 'failed', error: 'Turn timed out' }, 0, false)).toBe('pending');
  });

  test('stopReason=observe → watching (CASE A: the user-identified gap)', () => {
    const out = deriveSituationLifecycle(
      { status: 'completed', stopReason: 'observe', judgment: 'normal wave' },
      0,
      false,
    );
    expect(out).toBe('watching');
    expect(SITUATION_LIFECYCLE_LABEL.watching).toContain('持续观察');
  });

  test('failed + prior valid cognition → watching (CASE B: stale banner)', () => {
    const out = deriveSituationLifecycle(
      { status: 'failed', error: 'Turn timed out', judgment: 'prior judgment' },
      0,
      false,
    );
    expect(out).toBe('watching');
  });

  test('stopReason=ask_human → waiting_human (CASE C: explicit human ask)', () => {
    expect(
      deriveSituationLifecycle({ status: 'completed', stopReason: 'ask_human' }, 0, false),
    ).toBe('waiting_human');
  });

  test('stopReason=missing_capability → waiting_human', () => {
    expect(
      deriveSituationLifecycle({ status: 'completed', stopReason: 'missing_capability' }, 0, false),
    ).toBe('waiting_human');
  });

  test('P0010.1 Final Repair — Area D: judgment text mentions 人工核验 → NOT waiting_human (no fuzzy text match)', () => {
    // The previous version of deriveSituationLifecycle flipped to
    // 'waiting_human' whenever the agent's prose mentioned 人工核验 / 人工确认
    // / 无法获取. That was a heuristic, not a contract — it mis-triggered
    // on cases where the agent was acknowledging past human input. The
    // tightened derivation only reads structured fields
    // (stopReason + recommendation.humanNeeded[]).
    expect(
      deriveSituationLifecycle({ status: 'completed', judgment: '需要人工核验客服排班' }, 0, false),
    ).toBe('watching');
  });

  test('P0010.1 Final Repair — Area D: stopReason=judgment + humanNeeded=[] → watching', () => {
    expect(
      deriveSituationLifecycle(
        { status: 'completed', stopReason: 'judgment', recommendation: { humanNeeded: [] } },
        0,
        false,
      ),
    ).toBe('watching');
  });

  test('P0010.1 Final Repair — Area D: stopReason=judgment + humanNeeded=[item] → waiting_human', () => {
    expect(
      deriveSituationLifecycle(
        { status: 'completed', stopReason: 'judgment', recommendation: { humanNeeded: ['confirm supplier'] } },
        0,
        false,
      ),
    ).toBe('waiting_human');
  });

  test('completed + decision=accept → still watching (human-accept does NOT close Situation)', () => {
    // RE-REVIEW fix: a human decision='accept' on a recommendation only
    // records "recommendation adopted" — it does NOT close the Situation.
    // The underlying business issue (e.g. "继续观察 2 天") persists until
    // a durable resolution contract exists (which it does not, in this
    // REPAIR). WorkItem.closed and Situation.closed are independent.
    expect(
      deriveSituationLifecycle({ status: 'completed', stopReason: 'judgment' }, 1, true),
    ).toBe('watching');
  });

  test('observe + accept => watching (accept does not close an observation commitment)', () => {
    // Even when the Agent said "继续观察 2 天" and the human accepted that
    // recommendation, the Situation remains 'watching' until the observation
    // window elapses. The ObservationCommitment card (not Situation.closed)
    // is the surface for "what happens next".
    expect(
      deriveSituationLifecycle(
        { status: 'completed', stopReason: 'observe', updatedAt: '2026-08-22T08:00:00.000Z' },
        1,
        true,
      ),
    ).toBe('watching');
  });

  test('completed + decision=reject → still watching (operator decided not to act)', () => {
    expect(
      deriveSituationLifecycle({ status: 'completed', stopReason: 'judgment' }, 1, false),
    ).toBe('watching');
  });

  test('completed without any intervention decision → watching', () => {
    expect(
      deriveSituationLifecycle({ status: 'completed', stopReason: 'judgment' }, 0, false),
    ).toBe('watching');
  });

  test('REPAIR invariant: never returns "已处理" (no state named processed)', () => {
    // Sanity: the label set must NOT contain "已处理" anywhere.
    const all = Object.values(SITUATION_LIFECYCLE_LABEL);
    for (const v of all) {
      expect(v).not.toContain('已处理');
    }
  });

  test('REPAIR invariant: deriveSituationLifecycle can NEVER return "closed" (no durable resolution contract exists)', () => {
    // Human accept does not close the Situation. Reject does not close it.
    // No intervention does not close it. Even observe+accept does not close
    // it. The 'closed' state is RESERVED for a future resolution event
    // that has not been designed yet — this is by spec, not a bug.
    const inputs: Array<Parameters<typeof deriveSituationLifecycle>> = [
      [null, 0, false],
      [{ status: 'pending' }, 0, false],
      [{ status: 'investigating' }, 0, false],
      [{ status: 'completed', stopReason: 'observe' }, 0, false],
      [{ status: 'completed', stopReason: 'observe' }, 1, true],   // observe + accept
      [{ status: 'completed', stopReason: 'judgment' }, 0, false],
      [{ status: 'completed', stopReason: 'judgment' }, 1, true],  // judgment + accept
      [{ status: 'completed', stopReason: 'judgment' }, 1, false], // judgment + reject
      [{ status: 'completed', stopReason: 'ask_human' }, 0, false],
      [{ status: 'completed', stopReason: 'missing_capability' }, 0, false],
      [{ status: 'failed', judgment: 'prior' }, 0, false],
      [{ status: 'failed', judgment: 'prior' }, 1, true],          // failed+hasPrior + accept
    ];
    for (const args of inputs) {
      const lc = deriveSituationLifecycle(...args);
      expect(lc, `deriveSituationLifecycle(${JSON.stringify(args[0])}, ${args[1]}, ${args[2]}) returned ${lc}`).not.toBe('closed');
    }
  });
});

// ── deriveObservationCommitment ───────────────────────────────────────

describe('deriveObservationCommitment — minimal commitment representation', () => {
  test('returns null for non-watching-like states', () => {
    expect(deriveObservationCommitment(null)).toBeNull();
    expect(deriveObservationCommitment({ status: 'pending' })).toBeNull();
    expect(deriveObservationCommitment({ status: 'completed', stopReason: 'judgment' })).toBeNull();
    expect(deriveObservationCommitment({ status: 'failed', error: 'x' })).toBeNull(); // no prior
  });

  test('returns commitment for stopReason=observe', () => {
    const c = deriveObservationCommitment({ status: 'completed', stopReason: 'observe', updatedAt: '2026-08-22T08:00:00.000Z' });
    expect(c).not.toBeNull();
    expect(c!.type).toBe('observe');
    expect(c!.startedAt).toBe('2026-08-22T08:00:00.000Z');
    expect(c!.checkpoints).toContain('新证据到达');
    expect(c!.checkpoints).toContain('复查时间到达');
    expect(c!.note).toContain('未实现自动唤醒');
  });

  test('parses "继续观察 24-48 小时" duration from recommendation', () => {
    const c = deriveObservationCommitment({
      status: 'completed',
      stopReason: 'observe',
      updatedAt: '2026-08-22T08:00:00.000Z',
      recommendation: { recommendation: '继续观察 24-48 小时。' },
    });
    expect(c).not.toBeNull();
    expect(c!.reviewAt).not.toBeNull();
    const reviewAt = new Date(c!.reviewAt!);
    const started = new Date(c!.startedAt);
    // 24h or 48h after start
    const diffH = (reviewAt.getTime() - started.getTime()) / 3_600_000;
    expect(diffH === 24 || diffH === 48).toBe(true);
  });

  test('parses "观察 2 天" from recommendation', () => {
    const c = deriveObservationCommitment({
      status: 'completed',
      stopReason: 'observe',
      updatedAt: '2026-08-22T08:00:00.000Z',
      recommendation: { recommendation: '继续观察 2 天再判断' },
    });
    expect(c!.reviewAt).not.toBeNull();
    const diffDays = (new Date(c!.reviewAt!).getTime() - new Date(c!.startedAt).getTime()) / 86_400_000;
    expect(diffDays).toBe(2);
  });

  test('returns null reviewAt when no duration parseable', () => {
    const c = deriveObservationCommitment({
      status: 'completed',
      stopReason: 'observe',
      updatedAt: '2026-08-22T08:00:00.000Z',
      recommendation: { recommendation: '不调整任何配置。' },
    });
    expect(c!.reviewAt).toBeNull();
  });

  test('note is honest about no auto-wake engine', () => {
    const c = deriveObservationCommitment({ status: 'completed', stopReason: 'observe' });
    expect(c!.note).toMatch(/未实现自动唤醒|无自动唤醒/);
  });
});

// ── getSourcePopoverData ─────────────────────────────────────────────

describe('getSourcePopoverData — [E]/[K]/[H]/[M] click popover content', () => {
  test('evidence: returns the evidence string + honest unavailable', () => {
    const data = getSourcePopoverData('evidence', null, { evidenceStrings: ['trade.overview 2026-08-21→2026-08-22'] });
    expect(data).not.toBeNull();
    expect(data!.title).toContain('证据');
    expect(data!.fields.length).toBeGreaterThan(0);
    expect(data!.unavailable).toBeDefined();
    expect(data!.unavailable?.reason).toContain('原始来源暂不可定位');
  });

  test('evidence: returns null when no evidence strings', () => {
    expect(getSourcePopoverData('evidence', null, { evidenceStrings: [] })).toBeNull();
  });

  test('knowledge: returns the knownEvidence text + honest unavailable', () => {
    const data = getSourcePopoverData('knowledge', null, { knownEvidence: ['GMV -67.9%'] });
    expect(data).not.toBeNull();
    expect(data!.fields[0]?.value).toContain('GMV -67.9%');
    expect(data!.unavailable).toBeDefined();
    expect(data!.unavailable?.reason).toContain('Knowledge 暂无 first-class 记录');
  });

  test('human: returns intervention summary with interventionId in devOnly', () => {
    const data = getSourcePopoverData('human', 1, {
      interventions: [{
        interventionId: 'int_h1',
        type: 'correction',
        summary: '纠正: ...',
        actor: { id: 'operator_1' },
        timestamp: '2026-08-22T10:15:00.000Z',
        content: { type: 'correction' },
      }],
    });
    expect(data).not.toBeNull();
    expect(data!.title).toContain('人工干预');
    const allLabels = data!.fields.map((f) => f.label);
    expect(allLabels).toContain('类型');
    expect(allLabels).toContain('interventionId');
    // interventionId is marked devOnly — UI hides it in business mode
    const devField = data!.fields.find((f) => f.label === 'interventionId');
    expect(devField?.devOnly).toBe(true);
  });

  test('memory: always returns the unavailable surface (memory is Runtime-owned)', () => {
    const data = getSourcePopoverData('memory', null, {});
    expect(data).not.toBeNull();
    expect(data!.unavailable).toBeDefined();
    expect(data!.unavailable?.reason).toContain('Memory 永属 Runtime');
  });

  test('unknown kind → null (no fabrication)', () => {
    expect(getSourcePopoverData('foo' as any, null, {})).toBeNull();
  });

  test('renderSourcePopoverHtml produces HTML with a warning block when unavailable is set', () => {
    const data = getSourcePopoverData('memory', null, {});
    const html = renderSourcePopoverHtml(data);
    expect(html).toContain('popover-warning');
    expect(html).toContain('Memory 永属 Runtime');
  });
});

// ── WorkItem schema ──────────────────────────────────────────────────

describe('WorkItem schema — minimal Output/WorkItem contract', () => {
  test('valid WorkItem passes', () => {
    const ok = WorkItemSchema.safeParse({
      outputId: 'out_1',
      situationId: 'sit_1',
      type: 'recommendation',
      status: 'ready',
      content: '建议先排查库存。',
      createdAt: '2026-08-22T08:00:00.000Z',
    });
    expect(ok.success).toBe(true);
  });

  test('invalid status fails', () => {
    const bad = WorkItemSchema.safeParse({
      outputId: 'out_1',
      situationId: 'sit_1',
      type: 'recommendation',
      status: 'in_progress', // not in enum
      content: 'x',
      createdAt: '2026-08-22T08:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });

  test('status enum has exactly 4 values (ready/delivered/acknowledged/closed)', () => {
    expect(WorkItemStatusSchema.options).toEqual(['ready', 'delivered', 'acknowledged', 'closed']);
  });

  test('type enum has exactly 4 values (recommendation/analysis/work_item/report)', () => {
    expect(WorkItemTypeSchema.options).toEqual(['recommendation', 'analysis', 'work_item', 'report']);
  });

  test('LearningContextSchema body has outputs[] defaulting to []', () => {
    const ctx = LearningContextSchema.parse({
      contextId: 'ctx_x',
      situation: {
        situationId: 'sit_x',
        domain: 'ecommerce',
        type: 'anomaly_investigation',
        entity: { id: 'e1', type: 'shop' },
        temporal: { observedAt: '2026-08-22T08:00:00.000Z' },
        description: 'x',
        tags: [],
      },
      createdAt: '2026-08-22T08:00:00.000Z',
      updatedAt: '2026-08-22T08:00:00.000Z',
    });
    expect(Array.isArray(ctx.outputs)).toBe(true);
    expect(ctx.outputs).toEqual([]);
  });

  test('LearningContextSchema body accepts a WorkItem in outputs[]', () => {
    const ctx = LearningContextSchema.parse({
      contextId: 'ctx_x',
      situation: {
        situationId: 'sit_x',
        domain: 'ecommerce',
        type: 'anomaly_investigation',
        entity: { id: 'e1', type: 'shop' },
        temporal: { observedAt: '2026-08-22T08:00:00.000Z' },
        description: 'x',
        tags: [],
      },
      createdAt: '2026-08-22T08:00:00.000Z',
      updatedAt: '2026-08-22T08:00:00.000Z',
      outputs: [
        {
          outputId: 'out_1',
          situationId: 'sit_x',
          type: 'recommendation',
          status: 'ready',
          content: 'x',
          createdAt: '2026-08-22T08:00:00.000Z',
        },
      ],
    });
    expect(ctx.outputs).toHaveLength(1);
    expect(ctx.outputs[0]!.type).toBe('recommendation');
  });

  test('REPAIR invariant: WorkItem.closed is independent from Situation.closed', () => {
    // A WorkItem can be 'closed' (deliverable acknowledged-and-shelved)
    // while the Situation is still 'watching' (e.g. an "继续观察 2 天"
    // recommendation that the human accepted but the observation window
    // has not elapsed yet). The two state machines are independent.
    const closedWorkItem = WorkItemSchema.parse({
      outputId: 'out_1',
      situationId: 'sit_1',
      type: 'recommendation',
      status: 'closed',
      content: '继续观察 2 天。',
      createdAt: '2026-08-22T08:00:00.000Z',
      closedAt: '2026-08-22T08:30:00.000Z',
    });
    expect(closedWorkItem.status).toBe('closed');

    // The Situation is still watching (2-day window not elapsed, no
    // durable resolution event has occurred).
    const lc = deriveSituationLifecycle(
      { status: 'completed', stopReason: 'observe', updatedAt: '2026-08-22T08:00:00.000Z' },
      1,
      true,
    );
    expect(lc).toBe('watching');
    expect(lc).not.toBe('closed');
  });
});
