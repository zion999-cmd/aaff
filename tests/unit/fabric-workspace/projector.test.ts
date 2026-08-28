// P0008.3 / P0008.6 — FabricAgentWorkspace projector tests.
// Validates: deterministic, rebuildable (projected dirs only), one-way, correct
// P0008.6 topology (systems/ + capabilities/ + INDEX navigation maps), and that
// persistent dirs (knowledge/) are NOT cleared by the projector.

import { describe, it, expect } from 'vitest';
import { projectWorkspace, writeProjection } from '#app/runtime/fabric-workspace/index.js';
import { JD_FIXTURE } from '#app/runtime/fabric-workspace/jd-fixture.js';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CapabilityContractEntry } from '#app/connectors/capability/contract-types.js';

const input = {
  worldModel: JD_FIXTURE.worldModel,
  bindings: JD_FIXTURE.bindings,
};

const CAPABILITIES: CapabilityContractEntry[] = [
  {
    capability: 'trade.overview',
    domain: 'trade',
    name: '交易概览',
    description: '店铺级核心经营指标：GMV、订单、店铺访客、店铺成交转化率。',
    intent: ['今天卖了多少'],
    inputs: { date_range: true, entity_id: false, dimensions: ['time_daily'] },
    // P0010.2.9: shop-level is primary
    outputs: ['gmv', 'orders', 'shop_visitors', 'shop_conversion_rate'],
    metrics: [{ canonical: 'gmv', label: '成交金额', unit: 'currency', confidence: 1, verified: true }],
    dimensions: ['time_daily'],
    provider: { platform: 'jd', acquisition: 'cdp' },
    validation: { status: 'verified', verified_metrics: ['gmv'] },
    constraints: { requires_premium: false, requires_ad_account: false, is_popup: false },
  },
];

describe('FabricAgentWorkspace projector — determinism', () => {
  it('same input → identical contentHash (byte-identical)', () => {
    const a = projectWorkspace(input);
    const b = projectWorkspace(input);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.files).toEqual(b.files);
  });

  it('different object order → same projection (collections sorted)', () => {
    const reordered = {
      worldModel: {
        ...JD_FIXTURE.worldModel,
        objects: [...JD_FIXTURE.worldModel.objects].reverse(),
        assertions: [...JD_FIXTURE.worldModel.assertions].reverse(),
      },
      bindings: [...JD_FIXTURE.bindings].reverse(),
    };
    expect(projectWorkspace(reordered).contentHash).toBe(projectWorkspace(input).contentHash);
  });
});

describe('FabricAgentWorkspace projector — P0008.6 topology', () => {
  it('projects systems/ (not world/) with per-primitive files', () => {
    const result = projectWorkspace(input);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('systems/INDEX.md');
    expect(paths).toContain('systems/jd_shangzhi/system.md');
    expect(paths).toContain('systems/jd_shangzhi/metrics.md');
    expect(paths).toContain('systems/jd_shangzhi/surfaces.md');
    expect(paths).toContain('systems/jd_shangzhi/dimensions.md');
    expect(paths).not.toContain('world/jd_shangzhi/system.md');
  });

  it('projects capabilities/ with INDEX + bindings + cards', () => {
    const result = projectWorkspace({ ...input, capabilities: CAPABILITIES });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('capabilities/INDEX.md');
    expect(paths).toContain('capabilities/bindings.md');
    expect(paths).toContain('capabilities/trade.overview.md');
  });

  it('systems/INDEX.md is a navigation map (no answers, no instruction)', () => {
    const result = projectWorkspace(input);
    const index = result.files.find((f) => f.path === 'systems/INDEX.md')!;
    expect(index.content).toContain('Systems Index');
    expect(index.content).toContain('Navigation');
    expect(index.content).toContain('system.md');
    // Navigation only — must not leak the verified fact value.
    expect(index.content).not.toContain('4.6');
  });

  it('metrics file contains real JD metric names', () => {
    const result = projectWorkspace(input);
    const metrics = result.files.find((f) => f.path === 'systems/jd_shangzhi/metrics.md')!;
    expect(metrics.content).toContain('成交金额');
    expect(metrics.content).toContain('成交单量');
    expect(metrics.content).toContain('客单价');
  });

  it('system.md contains the P0008.5 known facts (shop rating, nav modules)', () => {
    const result = projectWorkspace(input);
    const system = result.files.find((f) => f.path === 'systems/jd_shangzhi/system.md')!;
    expect(system.content).toContain('4.6');
    expect(system.content).toContain('祁门红茶官方旗舰店');
    expect(system.content).toContain('10');
  });

  it('dimensions.md contains the comparison benchmark dimension', () => {
    const result = projectWorkspace(input);
    const dims = result.files.find((f) => f.path === 'systems/jd_shangzhi/dimensions.md')!;
    expect(dims.content).toContain('对比基准');
    expect(dims.content).toContain('同行同级均值');
  });
});

describe('FabricAgentWorkspace projector — capability projection', () => {
  it('capabilities/INDEX.md lists capability by domain with status icon', () => {
    const result = projectWorkspace({ ...input, capabilities: CAPABILITIES });
    const index = result.files.find((f) => f.path === 'capabilities/INDEX.md')!;
    expect(index.content).toContain('Capability Index');
    expect(index.content).toContain('trade');
    expect(index.content).toContain('trade.overview');
    expect(index.content).toContain('交易概览');
  });

  it('capability card projects registry fields (not a redefinition)', () => {
    const result = projectWorkspace({ ...input, capabilities: CAPABILITIES });
    const card = result.files.find((f) => f.path === 'capabilities/trade.overview.md')!;
    expect(card.content).toContain('trade.overview');
    expect(card.content).toContain('交易概览');
    expect(card.content).toContain('gmv');
    expect(card.content).toContain('verified');
  });

  it('bindings.md preserves the P0008.2 CapabilityBinding contract', () => {
    const result = projectWorkspace({ ...input, capabilities: CAPABILITIES });
    const bindings = result.files.find((f) => f.path === 'capabilities/bindings.md')!;
    expect(bindings.content).toContain('Capability Bindings');
    expect(bindings.content).toContain('jd_metric_gmv');
    expect(bindings.content).toContain('observable_by');
    expect(bindings.content).toContain('trade.overview');
  });
});

describe('FabricAgentWorkspace projector — rebuildable + one-way + persistent-preserving', () => {
  it('clears drift inside projected dirs (systems/) but NOT the workspace root', () => {
    const dir = resolve(tmpdir(), `fabric-ws-test-${Date.now()}`);
    writeProjection(input, dir);
    // Drift inside a projected directory → removed on re-project.
    const straySystem = resolve(dir, 'systems', 'STRAY.md');
    writeFileSync(straySystem, 'drift', 'utf-8');
    // Drift at the root → NOT removed (root is shared with persistent dirs).
    const strayRoot = resolve(dir, 'STRAY.md');
    writeFileSync(strayRoot, 'drift', 'utf-8');
    writeProjection(input, dir);
    expect(existsSync(straySystem)).toBe(false);
    expect(existsSync(strayRoot)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves persistent knowledge/ across re-projection', () => {
    const dir = resolve(tmpdir(), `fabric-ws-persist-${Date.now()}`);
    writeProjection(input, dir);
    // Simulate an Agent-maintained knowledge page.
    const page = resolve(dir, 'knowledge', 'my-note.md');
    mkdirSync(resolve(page, '..'), { recursive: true });
    writeFileSync(page, 'agent-compiled knowledge', 'utf-8');
    // Re-project → the persistent knowledge page survives.
    writeProjection(input, dir);
    expect(existsSync(page)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('projector is pure — no workspace read-back into authoritative state', () => {
    const result = projectWorkspace(input);
    expect(JD_FIXTURE.worldModel.objects.length).toBe(10);
    expect(result.files.every((f) => typeof f.content === 'string')).toBe(true);
  });
});
