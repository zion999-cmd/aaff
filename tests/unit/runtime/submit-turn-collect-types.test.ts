// P0011.x — Type contract test for submitTurnAndCollect.
//
// We don't open a real WebSocket here (the live blind acceptance is the
// integration test for that). This file only pins the observer / result
// type contract so future changes to the seam don't accidentally leak
// into "reasoning" or "dispatch" responsibilities.

import { describe, it, expect } from 'vitest';
import type { TurnObserver, TurnResult, TurnToolCall } from '#platform/runtime/hermes/session-client.js';

describe('P0011.x — submitTurnAndCollect type contract', () => {
  it('TurnObserver is a passive callback set (no dispatch / no injection)', () => {
    const o: TurnObserver = {
      onTurnStart: () => {},
      onMessageDelta: () => {},
      onToolStart: () => {},
      onToolComplete: () => {},
      onTurnComplete: () => {},
    };
    // Compile-time only — no runtime assertion. The shape is the
    // contract: every field is optional, every callback is one-way.
    expect(Object.keys(o).sort()).toEqual([
      'onMessageDelta',
      'onToolComplete',
      'onToolStart',
      'onTurnComplete',
      'onTurnStart',
    ]);
  });

  it('TurnToolCall carries the canonical fields a discovery record needs', () => {
    const tc: TurnToolCall = {
      toolId: 'tc-1',
      name: 'fabric_browser_inspect_surface',
      args: { url: 'https://example.com/' },
      result: { candidate_count: 12 },
      duration_s: 0.42,
    };
    expect(tc.name).toMatch(/^fabric_browser_/);
    expect(tc.toolId).toBeTruthy();
    expect(tc.result).toBeTruthy();
  });

  it('TurnResult is the canonical post-turn record', () => {
    const r: TurnResult = {
      messageText: 'done',
      toolCalls: [],
      turnStartedAt: 1,
      durationMs: 100,
    };
    expect(r.messageText).toBe('done');
    expect(r.toolCalls).toEqual([]);
    // error is optional
    expect(r.error).toBeUndefined();
  });
});
