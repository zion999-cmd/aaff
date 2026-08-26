// P0010.2.3 (ADR-059 audit G-2) — Timeline stop-reason proxy annotation.
//
// P0010.1 REPAIR-2 (ADR-052) introduced `renderSituationTimeline(detail)`
// with an honesty rule: when the "completed" event anchored on
// `inv.updatedAt` (a proxy for the missing `completedAt` column), the
// summary string includes a `≈` annotation + a footnote. P0010.2.3 audit
// found that the "stopped" event (anchored on `inv.updatedAt ||
// inv.startedAt || observedAt`) did NOT carry the same annotation, and
// would silently use a wall-clock proxy without telling the operator.
//
// The fix: extend the stop-reason summary with the same `≈` annotation
// when the proxy column is in use, or "(时间未记录)" when truly missing.
// This test pins the source-level invariant because the timeline is
// vanilla JS in the browser (no jsdom test runner is configured).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const TIMELINE_PATH = resolve(root, 'apps/ecommerce/workspace/presentation.js');

describe('Timeline stop-reason proxy annotation (ADR-059 audit G-2)', () => {
  it('renderSituationTimeline stop-reason event annotates proxy timestamps with ≈', () => {
    const source = readFileSync(TIMELINE_PATH, 'utf8');
    // Find the stop-reason block. The audit fix added a stopSummary
    // variable that conditionally appends the proxy annotation.
    const stopSummaryIdx = source.indexOf('stopSummary');
    expect(stopSummaryIdx).toBeGreaterThan(-1);
    // The summary must include the ≈ annotation when a proxy is in use.
    const block = source.substring(stopSummaryIdx, stopSummaryIdx + 600);
    expect(block).toContain('停止原因:');
    expect(block).toContain('≈ 停止时间; 实际缺少 stoppedAt 列');
    // The block must also handle the truly-missing case honestly.
    expect(block).toContain('时间未记录');
  });

  it('completed event also keeps its existing ≈ annotation (no regression)', () => {
    const source = readFileSync(TIMELINE_PATH, 'utf8');
    // The completed event is the reference contract — its annotation
    // must not have been edited away.
    expect(source).toContain('调查完成 (≈ 完成时间; 实际缺少 completedAt 列)');
  });

  it('renderSituationTimeline stop-reason never fakes a wall-clock when truly missing', () => {
    const source = readFileSync(TIMELINE_PATH, 'utf8');
    // The proxy detection must guard the annotation: if rawStopT is null,
    // the summary must include "时间未记录" (not the proxy annotation).
    const stopSummaryIdx = source.indexOf('stopSummary');
    const block = source.substring(stopSummaryIdx, stopSummaryIdx + 400);
    // The condition `(rawStopT ? ... : ' (时间未记录)')` must exist —
    // i.e. the annotation is gated on the timestamp being present.
    expect(block).toMatch(/rawStopT\s*\?/);
    expect(block).toContain("' (时间未记录)'");
  });
});
