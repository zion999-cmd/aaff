// P0008.4 — Agent Shared Knowledge Layer tests.
// Verifies: governance contract, directory structure, immutable raw, provenance.

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initSharedKnowledgeLayer } from '#app/runtime/shared-knowledge/index.js';
import { KNOWLEDGE_GOVERNANCE, KNOWLEDGE_INDEX, SEED_INDEX, AGENTS_CONTRACT } from '#app/runtime/shared-knowledge/index.js';

const TEST_ROOT = resolve(tmpdir(), 'shared-knowledge-test');

describe('KNOWLEDGE.md governance contract', () => {
  it('specifies raw is immutable', () => {
    expect(KNOWLEDGE_GOVERNANCE).toContain('immutable');
    expect(KNOWLEDGE_GOVERNANCE).toContain('NEVER modify');
  });

  it('specifies one source may update multiple pages', () => {
    expect(KNOWLEDGE_GOVERNANCE).toContain('One source may update multiple pages');
  });

  it('specifies contradiction preservation (no silent overwrite)', () => {
    expect(KNOWLEDGE_GOVERNANCE).toContain('PRESERVE');
    expect(KNOWLEDGE_GOVERNANCE).toContain('Never silently overwrite');
  });

  it('specifies provenance (sources in frontmatter)', () => {
    expect(KNOWLEDGE_GOVERNANCE).toContain('sources');
    expect(KNOWLEDGE_GOVERNANCE).toContain('provenance');
  });

  it('is governance, NOT business knowledge', () => {
    // Governance should not contain domain-specific business guidance.
    expect(KNOWLEDGE_GOVERNANCE).not.toContain('流量下降先看访客数');
  });

  it('INDEX is a semantic router, not a page dump', () => {
    expect(KNOWLEDGE_INDEX).toContain('Knowledge Index');
    // P0011: the root INDEX routes by semantic domain, not by content type.
    expect(KNOWLEDGE_INDEX).toContain('流量问题');
    expect(KNOWLEDGE_INDEX).toContain('knowledge/traffic/INDEX.md');
    expect(KNOWLEDGE_INDEX).toContain('knowledge/operations/INDEX.md');
  });
});

describe('AGENTS.md — Fabric Agent Workspace Contract', () => {
  it('describes workspace topology (systems/knowledge/raw/capabilities)', () => {
    expect(AGENTS_CONTRACT).toContain('systems/');
    expect(AGENTS_CONTRACT).toContain('knowledge/');
    expect(AGENTS_CONTRACT).toContain('knowledge-sources/raw/');
    expect(AGENTS_CONTRACT).toContain('capabilities/');
    // P0008.6 rename: world/ is gone from the runtime-facing vocabulary.
    expect(AGENTS_CONTRACT).not.toContain('world/');
  });

  it('specifies read/write boundaries (systems + raw read-only, knowledge writable)', () => {
    expect(AGENTS_CONTRACT).toContain('READ-ONLY');
    expect(AGENTS_CONTRACT).toContain('never modify');
    expect(AGENTS_CONTRACT).toContain('maintain Shared Knowledge here');
  });

  it('expresses READ-side routing by context-source semantics, not filesystem-first', () => {
    expect(AGENTS_CONTRACT).toContain('Routing');
    expect(AGENTS_CONTRACT).toContain('systems/INDEX.md');
    expect(AGENTS_CONTRACT).toContain('knowledge/INDEX.md');
    expect(AGENTS_CONTRACT).toContain('capabilities/INDEX.md');
    // External tools are gated on insufficiency / freshness / exploration.
    expect(AGENTS_CONTRACT).toContain('insufficient');
    expect(AGENTS_CONTRACT).toContain('freshness');
  });

  it('separates epistemic status from freshness', () => {
    expect(AGENTS_CONTRACT).toContain('verified');
    expect(AGENTS_CONTRACT).toContain('suspected');
    expect(AGENTS_CONTRACT).toContain('AT DISCOVERY TIME');
    // verified must NOT be framed as "fresher than live data".
    expect(AGENTS_CONTRACT).toContain('NOT a freshness guarantee');
  });

  it('specifies Capability Execution Semantics (Runtime-native discovery, not a hard-coded tool name)', () => {
    // Native discovery flow is described (Runtime-independent + Hermes concrete).
    expect(AGENTS_CONTRACT).toContain('tool_search');
    expect(AGENTS_CONTRACT).toContain('tool_describe');
    expect(AGENTS_CONTRACT).toContain('tool_call');
    expect(AGENTS_CONTRACT).toContain('tool-discovery mechanism');
    // Must NOT hard-code a specific tool name or MCP namespace (Runtime internal detail).
    expect(AGENTS_CONTRACT).not.toContain('fabric_execute_capability');
    expect(AGENTS_CONTRACT).not.toContain('mcp__');
    // systems/ + knowledge/ are CONTEXT, explicitly NOT a substitute for live data.
    expect(AGENTS_CONTRACT).toContain('not a substitute for live operational data');
    // Internal implementation storage (SQLite/db) is explicitly banned as a data source.
    expect(AGENTS_CONTRACT).toContain('SQLite');
    expect(AGENTS_CONTRACT).toContain('NOT a data source');
    // External web cannot replace an existing Fabric capability.
    expect(AGENTS_CONTRACT).toContain('not replaced by external web search');
  });

  it('generated workspace AGENTS.md carries the discovery semantics verbatim', () => {
    const root = resolve(tmpdir(), 'sk-execution-semantics');
    rmSync(root, { recursive: true, force: true });
    initSharedKnowledgeLayer(root);
    const onDisk = readFileSync(resolve(root, 'AGENTS.md'), 'utf-8');
    expect(onDisk).toContain('Capability Execution');
    expect(onDisk).toContain('tool_search');
    expect(onDisk).not.toContain('mcp__fabric__');
    rmSync(root, { recursive: true, force: true });
  });

  it('points to KNOWLEDGE.md, does NOT copy its content', () => {
    expect(AGENTS_CONTRACT).toContain('knowledge/KNOWLEDGE.md');
    // AGENTS.md is a contract/pointer, not a duplicate of KNOWLEDGE.md governance rules.
    expect(AGENTS_CONTRACT).not.toContain('One source may update multiple pages');
  });

  it('declares Runtime Self ownership (Memory/Skill/Soul NOT in workspace)', () => {
    expect(AGENTS_CONTRACT).toContain('Memory');
    expect(AGENTS_CONTRACT).toContain('Runtime profile');
    expect(AGENTS_CONTRACT).toContain('NOT this workspace');
  });

  it('is written to workspace ROOT (cwd), where Hermes natively loads', () => {
    const result = initSharedKnowledgeLayer(TEST_ROOT);
    expect(result.files).toContain('AGENTS.md');
    expect(existsSync(resolve(TEST_ROOT, 'AGENTS.md'))).toBe(true);
  });
});

describe('initSharedKnowledgeLayer', () => {
  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('creates the correct directory structure', () => {
    const root = resolve(tmpdir(), 'sk-structure');
    rmSync(root, { recursive: true, force: true });
    const result = initSharedKnowledgeLayer(root);
    expect(result.files).toContain('knowledge-sources/raw/platform-promotion.md');
    expect(result.files).toContain('knowledge-sources/raw/marketing-case.md');
    expect(result.files).toContain('knowledge/KNOWLEDGE.md');
    expect(result.files).toContain('knowledge/INDEX.md');
    expect(result.files).toContain('knowledge/log.md');
    expect(result.files).toContain('knowledge/operations/京东内容化推广.md');
    rmSync(root, { recursive: true, force: true });
  });

  it('writes immutable raw sources to disk', () => {
    const raw = readFileSync(resolve(TEST_ROOT, 'knowledge-sources/raw/platform-promotion.md'), 'utf-8');
    expect(raw).toContain('内容化推广');
    expect(raw).toContain('CPM');
  });

  it('writes compiled knowledge page with provenance (sources frontmatter)', () => {
    const page = readFileSync(resolve(TEST_ROOT, 'knowledge/operations/京东内容化推广.md'), 'utf-8');
    expect(page).toContain('sources:');
    expect(page).toContain('knowledge-sources/raw/platform-promotion.md');
  });

  it('is idempotent — re-init overwrites only contract, preserves seeded content', () => {
    const root = resolve(tmpdir(), 'sk-idempotent');
    rmSync(root, { recursive: true, force: true });
    const r1 = initSharedKnowledgeLayer(root);
    expect(r1.files).toContain('knowledge/operations/京东内容化推广.md');
    const r2 = initSharedKnowledgeLayer(root);
    // Second init writes only the Fabric contract files (seed content already present).
    expect(r2.files).toEqual(['AGENTS.md', 'knowledge/KNOWLEDGE.md']);
    expect(existsSync(resolve(root, 'knowledge/KNOWLEDGE.md'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('is seed-if-absent — Agent modifications survive re-init (restart)', () => {
    const root = resolve(tmpdir(), 'sk-seed-preserve');
    rmSync(root, { recursive: true, force: true });
    initSharedKnowledgeLayer(root);
    const idx = resolve(root, 'knowledge/INDEX.md');
    const log = resolve(root, 'knowledge/log.md');
    const page = resolve(root, 'knowledge/operations/京东内容化推广.md');
    writeFileSync(idx, 'AGENT-MODIFIED-INDEX', 'utf-8');
    writeFileSync(log, 'AGENT-APPENDED-LOG', 'utf-8');
    writeFileSync(page, 'AGENT-MODIFIED-PAGE', 'utf-8');
    // Re-init (service restart).
    initSharedKnowledgeLayer(root);
    expect(readFileSync(idx, 'utf-8')).toBe('AGENT-MODIFIED-INDEX');
    expect(readFileSync(log, 'utf-8')).toBe('AGENT-APPENDED-LOG');
    expect(readFileSync(page, 'utf-8')).toBe('AGENT-MODIFIED-PAGE');
    // Contract files still overwritten deterministically.
    expect(readFileSync(resolve(root, 'AGENTS.md'), 'utf-8')).toContain('AGENTS.md');
    rmSync(root, { recursive: true, force: true });
  });

  it('new workspace seeds correctly', () => {
    const root = resolve(tmpdir(), 'sk-fresh');
    rmSync(root, { recursive: true, force: true });
    const result = initSharedKnowledgeLayer(root);
    expect(result.files).toContain('knowledge/operations/京东内容化推广.md');
    expect(result.files).toContain('knowledge/INDEX.md');
    expect(result.files).toContain('knowledge-sources/raw/platform-promotion.md');
    rmSync(root, { recursive: true, force: true });
  });

  it('INDEX uses runtime-readable paths that resolve on disk (no [[wikilink]])', () => {
    expect(SEED_INDEX).not.toContain('[[');
    // P0011: root INDEX routes to domain INDEXes via runtime-readable paths.
    expect(SEED_INDEX).toContain('knowledge/traffic/INDEX.md');
    const root = resolve(tmpdir(), 'sk-index-resolve');
    rmSync(root, { recursive: true, force: true });
    initSharedKnowledgeLayer(root);
    expect(existsSync(resolve(root, 'knowledge/operations/京东内容化推广.md'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
