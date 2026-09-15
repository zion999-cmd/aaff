// P0013.1 — Workspace dynamic acquisition UX contract (SC1/SC11).
//
// A need beyond frozen coverage must be expressible from the Replay
// start panel and drive the real acquisition product path — never a
// chat instruction to Hermes, and never with implementation vocabulary
// (scripts / browser mechanics / endpoint names) leaking into the UI.
// Vanilla-JS workspace → source-level contract (no jsdom runner).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const viewSrc = readFileSync(
  resolve(process.cwd(), 'apps/ecommerce/workspace/views/replay-view.js'),
  'utf8',
);
const htmlSrc = readFileSync(
  resolve(process.cwd(), 'apps/ecommerce/workspace/index.html'),
  'utf8',
);

describe('start panel gap surface exists in the DOM', () => {
  it('index.html contains the hidden gap section + acquisition button', () => {
    expect(htmlSrc).toContain('id="replayGapSection"');
    expect(htmlSrc).toContain('id="replayAcquireBtn"');
    expect(htmlSrc).toContain('id="replayAcquireDetail"');
    expect(htmlSrc).toMatch(/id="replayGapSection"[^>]*display:\s*none/);
  });
});

describe('replay-view acquisition flow', () => {
  it('posts a business need to /api/replay/acquisitions and polls the job', () => {
    expect(viewSrc).toMatch(/apiPost\(\s*'\/api\/replay\/acquisitions'/);
    expect(viewSrc).toMatch(/apiGet\('\/api\/replay\/acquisitions\/'\s*\+\s*jobId/);
  });

  it('polls trajectory events and renders progress (no blind 10-30 min wait)', () => {
    expect(viewSrc).toMatch(/\/events/);
    expect(viewSrc).toContain('renderAcquireEvents');
    expect(viewSrc).toContain('replayAcquireLog');
  });

  it('surfaces create-request errors instead of hanging (stale server / non-JSON)', () => {
    expect(viewSrc).toContain('采集任务请求失败');
  });

  it('binds the acquisition button and gates on in-flight single-flight', () => {
    expect(viewSrc).toMatch(/acquireBtn\.onclick\s*=\s*onAcquireClick/);
    expect(viewSrc).toContain('acquireInFlight');
  });

  it('out-of-coverage dates reveal the gap section instead of alerting a hard block', () => {
    // buildCreateBody returns { gap } and onStartClick shows the section.
    expect(viewSrc).toContain('built.gap');
    expect(viewSrc).toContain('showGapSection');
  });

  it('SUCCESS refreshes dataset discovery and clamps to the truthful actual window', () => {
    expect(viewSrc).toMatch(/job\.status === 'SUCCEEDED'/);
    expect(viewSrc).toContain('refreshDatasetPanel()');
    expect(viewSrc).toContain('job.actualStart');
    expect(viewSrc).toContain('job.actualEnd');
  });

  it('renders FAILED/BLOCKED/INTERRUPTED honestly with failure code (no fake success)', () => {
    expect(viewSrc).toContain('job.failureCode');
    expect(viewSrc).toMatch(/采集未成功/);
  });

  it('never drives acquisition through chat / investigate endpoints', () => {
    expect(viewSrc).not.toMatch(/\/api\/chat/);
    expect(viewSrc).not.toMatch(/\/investigate/);
  });
});

describe('workspace knows no acquisition implementation details', () => {
  const forbidden = [
    /\.ajax/i,
    /python/i,
    /\bCDP\b/,
    /endpoint/i,
    /9222/,
    /page\.route/i,
    /connect_over/i,
    /SzDP/i,
    /getDealOrders/i,
    /getSummary/i,
  ];
  for (const term of forbidden) {
    it(`view source contains no ${term}`, () => {
      expect(viewSrc).not.toMatch(term);
    });
  }
});
