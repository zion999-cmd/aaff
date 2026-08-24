// P0010.1 Final Repair — Area B. Contract test for the Situation timeline.
//
// Pinned behavior:
//   - Pure renderer: every event in the rendered timeline comes from a real
//     persisted timestamp on the /api/situations/:id response. No fabricated
//     `completedAt` / `deliveredAt` / `askedAt` / `closedAt` / `resumedAt`.
//   - Empty input → empty string (the section is hidden entirely, not an
//     empty <ol>).
//   - Events sorted by timestamp ascending (string compare, ISO-8601 is
//     lexicographically correct).
//   - Each event has a `data-event-type` and `data-actor` attribute so CSS
//     can style by type without a per-event class.
//   - The "completed" event uses `updatedAt` as a proxy and is annotated
//     `(≈ 完成时间; 实际缺少 completedAt 列)` so the operator sees the gap.
//   - `timelineEventLabel` exposes the `decision` sub-type (accept / reject /
//     defer / override / no_action) instead of collapsing to a single
//     "决策" label.
//   - Stop-reason is rendered as an annotation on a synthetic event anchored
//     to the latest of (updatedAt, startedAt, observedAt).

import { describe, expect, test } from 'vitest';
import { renderSituationTimeline, timelineEventLabel } from '#app/workspace/presentation.js';

describe('renderSituationTimeline', () => {
  test('returns empty string when input is null/undefined', () => {
    expect(renderSituationTimeline(null)).toBe('');
    expect(renderSituationTimeline(undefined)).toBe('');
  });

  test('returns empty string when no events can be constructed', () => {
    expect(renderSituationTimeline({})).toBe('');
    expect(renderSituationTimeline({ interventions: [], outputs: [] })).toBe('');
  });

  test('renders a Situation · 发现 event from createdAt', () => {
    const html = renderSituationTimeline({ createdAt: '2026-08-24T09:12:00.000Z' });
    expect(html).toContain('<ol class="situation-timeline">');
    expect(html).toContain('data-event-type="situation.created"');
    expect(html).toContain('data-actor="agent"');
    expect(html).toContain('发现 Situation');
    expect(html).toContain('datetime="2026-08-24T09:12:00.000Z"');
  });

  test('renders the observation window event when temporal.observedAt is set', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      temporal: {
        observedAt: '2026-08-22T00:00:00.000Z',
        windowStart: '2026-08-15T00:00:00.000Z',
        windowEnd: '2026-08-22T00:00:00.000Z',
      },
    });
    expect(html).toContain('观察窗口');
    expect(html).toContain('data-event-type="situation.observed"');
    expect(html).toContain('data-actor="system"');
  });

  test('renders investigation.started from learningContext.investigation.startedAt', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      learningContext: {
        investigation: { status: 'completed', startedAt: '2026-08-24T09:13:00.000Z' },
      },
    });
    expect(html).toContain('data-event-type="investigation.started"');
    expect(html).toContain('开始调查');
  });

  test('renders investigation.completed with the ≈ completedAt proxy annotation', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      learningContext: {
        investigation: {
          status: 'completed',
          startedAt: '2026-08-24T09:13:00.000Z',
          updatedAt: '2026-08-24T09:20:00.000Z',
        },
      },
    });
    expect(html).toContain('data-event-type="investigation.completed"');
    expect(html).toContain('(≈ 完成时间; 实际缺少 completedAt 列)');
  });

  test('renders investigation.failed with the error if present', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      learningContext: {
        investigation: { status: 'failed', updatedAt: '2026-08-24T09:20:00.000Z', error: 'turn timeout' },
      },
    });
    expect(html).toContain('data-event-type="investigation.failed"');
    expect(html).toContain('turn timeout');
  });

  test('renders a stop-reason event with the right Chinese label', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      learningContext: {
        investigation: {
          status: 'completed',
          stopReason: 'judgment',
          startedAt: '2026-08-24T09:13:00.000Z',
          updatedAt: '2026-08-24T09:20:00.000Z',
        },
      },
    });
    expect(html).toContain('data-event-type="investigation.stopped"');
    expect(html).toContain('形成判断');
  });

  test('renders an ask_human stop reason as 需要人工', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      learningContext: {
        investigation: {
          status: 'completed',
          stopReason: 'ask_human',
          startedAt: '2026-08-24T09:13:00.000Z',
          updatedAt: '2026-08-24T09:20:00.000Z',
        },
      },
    });
    expect(html).toContain('需要人工');
  });

  test('sorts events by timestamp ascending', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      interventions: [
        { type: 'correction', content: {}, summary: 'wrong date', timestamp: '2026-08-24T09:08:00.000Z' },
        { type: 'response', content: {}, summary: 'agree', timestamp: '2026-08-24T09:14:00.000Z' },
      ],
    });
    // The correction event (09:08) should appear before the response event (09:14) in the markup.
    const correctionIdx = html.indexOf('data-event-type="intervention.correction"');
    const responseIdx = html.indexOf('data-event-type="intervention.response"');
    expect(correctionIdx).toBeGreaterThan(-1);
    expect(responseIdx).toBeGreaterThan(correctionIdx);
  });

  test('renders an intervention event with the typed decision label (accept)', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      interventions: [
        {
          type: 'decision',
          content: { decision: 'accept' },
          summary: '同意采用',
          timestamp: '2026-08-24T09:30:00.000Z',
        },
      ],
    });
    expect(html).toContain('已采用建议');
  });

  test('renders an intervention event with the typed decision label (defer)', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      interventions: [
        {
          type: 'decision',
          content: { decision: 'defer' },
          summary: '稍后',
          timestamp: '2026-08-24T09:30:00.000Z',
        },
      ],
    });
    expect(html).toContain('稍后处理');
  });

  test('renders an output.created event from outputs[].createdAt', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      outputs: [
        {
          outputId: 'o1',
          situationId: 's1',
          type: 'recommendation',
          status: 'ready',
          content: 'x',
          createdAt: '2026-08-24T09:30:00.000Z',
        },
      ],
    });
    expect(html).toContain('data-event-type="output.created"');
    expect(html).toContain('建议 已生成');
  });

  test('renders output.acknowledged and output.closed events when timestamps are set', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      outputs: [
        {
          outputId: 'o1',
          situationId: 's1',
          type: 'report',
          status: 'closed',
          content: 'x',
          createdAt: '2026-08-24T09:30:00.000Z',
          acknowledgedAt: '2026-08-24T09:35:00.000Z',
          closedAt: '2026-08-24T09:40:00.000Z',
        },
      ],
    });
    expect(html).toContain('data-event-type="output.acknowledged"');
    expect(html).toContain('data-event-type="output.closed"');
  });

  test('never fabricates a missing timestamp (no NaN dates)', () => {
    const html = renderSituationTimeline({
      createdAt: '2026-08-24T09:12:00.000Z',
      outputs: [
        // No createdAt — should not appear in the timeline.
        { outputId: 'o1', situationId: 's1', type: 'analysis', status: 'ready', content: 'x' },
      ],
    });
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });
});

describe('timelineEventLabel', () => {
  test('decision + accept → 已采用建议', () => {
    expect(timelineEventLabel('decision', { decision: 'accept' })).toBe('已采用建议');
  });
  test('decision + reject → 不采用', () => {
    expect(timelineEventLabel('decision', { decision: 'reject' })).toBe('不采用');
  });
  test('decision + defer → 稍后处理', () => {
    expect(timelineEventLabel('decision', { decision: 'defer' })).toBe('稍后处理');
  });
  test('decision + override → 已重写判断', () => {
    expect(timelineEventLabel('decision', { decision: 'override' })).toBe('已重写判断');
  });
  test('decision + no_action → 无操作', () => {
    expect(timelineEventLabel('decision', { decision: 'no_action' })).toBe('无操作');
  });
  test('decision with unknown sub-type → 决策', () => {
    expect(timelineEventLabel('decision', { decision: '?' })).toBe('决策');
  });
  test('response → 认同判断', () => {
    expect(timelineEventLabel('response', {})).toBe('认同判断');
  });
  test('correction → 纠正事实', () => {
    expect(timelineEventLabel('correction', {})).toBe('纠正事实');
  });
  test('context_supplement → 补充背景', () => {
    expect(timelineEventLabel('context_supplement', {})).toBe('补充背景');
  });
  test('unknown type → type string itself (no fabrication)', () => {
    expect(timelineEventLabel('foo', {})).toBe('foo');
  });
  test('null content + decision → falls through to 决策 (not crashed)', () => {
    expect(timelineEventLabel('decision', null)).toBe('决策');
  });
});
