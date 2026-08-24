// P0010.1 Final Repair — Area C.4: contract test for the intervention-link
// helpers. Pins the behavior of:
//   1. `deriveLatestAgentActivityId(situationContext)` — return the id of
//      the most recent agent activity for a situation.
//   2. `flattenRespondsToActivityIds(type, content)` — project the structured
//      `content.respondsTo.agentActivityIds` onto the top-level
//      `respondsToActivityIds` field on the POST payload.
//
// Today the only stable agent activity is the investigation itself (its
// `startedAt` timestamp is unique per situation). The producer-side
// `agentActivities[]` is still hard-coded to `[]` (see
// `learning-context-producer.ts:103`) — that gap is reported in the next-slice
// blockers in context/handoff.md, not fixed in this round.

import { describe, expect, test } from 'vitest';
import {
  deriveLatestAgentActivityId,
  flattenRespondsToActivityIds,
} from '#app/workspace/presentation.js';

describe('deriveLatestAgentActivityId', () => {
  test('returns null for null/undefined input', () => {
    expect(deriveLatestAgentActivityId(null)).toBeNull();
    expect(deriveLatestAgentActivityId(undefined)).toBeNull();
  });

  test('returns null when there is no invData and no agentActivities', () => {
    expect(deriveLatestAgentActivityId({})).toBeNull();
    expect(deriveLatestAgentActivityId({ invData: null, agentActivities: [] })).toBeNull();
  });

  test('falls back to invData.startedAt when agentActivities is empty', () => {
    const ctx = { invData: { startedAt: '2026-08-25T09:13:00.000Z' } };
    expect(deriveLatestAgentActivityId(ctx)).toBe('2026-08-25T09:13:00.000Z');
  });

  test('prefers the most recent agentActivities[] row when present', () => {
    const ctx = {
      invData: { startedAt: '2026-08-25T09:13:00.000Z' },
      agentActivities: [
        { activityId: 'a-old', timestamp: '2026-08-25T09:00:00.000Z' },
        { activityId: 'a-new', timestamp: '2026-08-25T10:00:00.000Z' },
      ],
    };
    expect(deriveLatestAgentActivityId(ctx)).toBe('a-new');
  });

  test('skips rows with missing activityId', () => {
    const ctx = {
      agentActivities: [
        { timestamp: '2026-08-25T09:00:00.000Z' },
        { activityId: 'a-valid', timestamp: '2026-08-25T10:00:00.000Z' },
        { activityId: '', timestamp: '2026-08-25T11:00:00.000Z' },
      ] as Array<{ activityId?: string; timestamp?: string }>,
    };
    expect(deriveLatestAgentActivityId(ctx)).toBe('a-valid');
  });

  test('falls through to invData.startedAt when all agentActivities are invalid', () => {
    const ctx = {
      invData: { startedAt: '2026-08-25T09:13:00.000Z' },
      agentActivities: [{}, { activityId: '' }, null] as unknown as Array<{ activityId?: string; timestamp?: string }>,
    };
    expect(deriveLatestAgentActivityId(ctx)).toBe('2026-08-25T09:13:00.000Z');
  });
});

describe('flattenRespondsToActivityIds', () => {
  test('returns [] for non-response types (no implicit link)', () => {
    expect(flattenRespondsToActivityIds('correction', { respondsTo: { agentActivityIds: ['a1'] } })).toEqual([]);
    expect(flattenRespondsToActivityIds('context_supplement', { respondsTo: { agentActivityIds: ['a1'] } })).toEqual([]);
    expect(flattenRespondsToActivityIds('decision', { respondsTo: { agentActivityIds: ['a1'] } })).toEqual([]);
  });

  test('returns [] when content is null/undefined', () => {
    expect(flattenRespondsToActivityIds('response', null)).toEqual([]);
    expect(flattenRespondsToActivityIds('response', undefined)).toEqual([]);
  });

  test('returns [] when respondsTo is missing', () => {
    expect(flattenRespondsToActivityIds('response', {})).toEqual([]);
  });

  test('returns [] when agentActivityIds is not an array', () => {
    expect(flattenRespondsToActivityIds('response', { respondsTo: { agentActivityIds: 'a1' as unknown as string[] } })).toEqual([]);
    expect(flattenRespondsToActivityIds('response', { respondsTo: { agentActivityIds: null as unknown as string[] } })).toEqual([]);
  });

  test('returns the filtered list for response + valid ids', () => {
    const result = flattenRespondsToActivityIds('response', {
      respondsTo: { agentActivityIds: ['a1', 'a2'] },
    });
    expect(result).toEqual(['a1', 'a2']);
  });

  test('filters out empty / non-string ids', () => {
    const result = flattenRespondsToActivityIds('response', {
      respondsTo: { agentActivityIds: ['a1', '', null, 42, 'a2'] as unknown as string[] },
    });
    expect(result).toEqual(['a1', 'a2']);
  });
});
