// P0013.1 — source-level invariants for the historical acquisition path:
// 1. The freezer is the ONLY production writer of PROVENANCE_MANIFEST.json
//    (the P0013 upstream audit proved the 2026-09-03 one was hand-authored).
// 2. Freeze logic must never reference the existing frozen dataset path —
//    it constructs new datasets generically and must not touch the old one.
// 3. Orchestrator will be added in Phase 3 and must drive a real Hermes
//    session client (anti-stub), checked here once present.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const acquisitionDir = resolve(process.cwd(), 'apps/ecommerce/runtime/acquisition');

const listTsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isFile() && e.name.endsWith('.ts') ? [resolve(dir, e.name)] : [],
  );

describe('freezer manifest writer contract', () => {
  it('writes PROVENANCE_MANIFEST.json in exactly one acquisition module (freeze-dataset)', () => {
    const writers = listTsFiles(acquisitionDir)
      .map((p) => ({ p, src: readFileSync(p, 'utf8') }))
      .filter(({ src }) => src.includes('PROVENANCE_MANIFEST.json'))
      .filter(({ src }) => /writeFile/i.test(src));
    expect(writers.map((w) => w.p.split('/').pop())).toEqual(['freeze-dataset.ts']);
  });

  it('freeze code contains no reference to the existing 2026-09-03 dataset', () => {
    const src = readFileSync(resolve(acquisitionDir, 'freeze-dataset.ts'), 'utf8');
    expect(src).not.toContain('jd_acquisition_20260903_0834');
  });
});

describe('orchestrator anti-stub contract (SC3/SC8 production path)', () => {
  const orchestratorPath = resolve(acquisitionDir, 'acquisition-orchestrator.ts');
  const runnerPath = resolve(acquisitionDir, 'hermes-turn-runner.ts');

  it('orchestrator defaults to the real Hermes turn runner (no inline success)', () => {
    expect(existsSync(orchestratorPath)).toBe(true);
    const src = readFileSync(orchestratorPath, 'utf8');
    expect(src).toMatch(/createHermesTurnRunner/);
    expect(src).not.toContain('SUCCEEDED-without-hermes');
  });

  it('turn runner drives the real Hermes WS session client', () => {
    expect(existsSync(runnerPath)).toBe(true);
    const src = readFileSync(runnerPath, 'utf8');
    expect(src).toMatch(/HermesSessionClient/);
    expect(src).toMatch(/submitTurnAndCollect/);
  });
});
