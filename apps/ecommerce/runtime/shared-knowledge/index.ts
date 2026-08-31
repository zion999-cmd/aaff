// P0008.4 / P0008.6 — Agent Shared Knowledge Layer initializer.
// Creates the knowledge-sources/ (immutable raw) + knowledge/ (Read Model)
// directory structure and seeds it with the governance contract + minimal fixtures.
//
// This is NOT a Wiki Engine. It is a thin structure initializer. The "Agent
// Compilation" (raw → knowledge) is done by the Runtime, guided by KNOWLEDGE.md.
//
// P0008.6 persistence correction: two write policies.
//   - Fabric-owned CONTRACT (AGENTS.md, KNOWLEDGE.md) → overwrite (deterministic).
//   - Agent/Human-maintained CONTENT (raw sources, INDEX.md, log.md, seed pages)
//     → seed-if-absent (never overwrite), so Agent maintenance survives restarts.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { KNOWLEDGE_GOVERNANCE, KNOWLEDGE_INDEX } from './governance.js';
import { AGENTS_CONTRACT } from './contract.js';
import {
  RAW_PLATFORM_PROMOTION,
  RAW_MARKETING_CASE,
  SEED_PLATFORM_PAGE,
  SEED_INDEX,
  SEED_LOG,
} from './fixtures.js';

export * from './governance.js';
export * from './contract.js';
export * from './fixtures.js';

export interface SharedKnowledgeInitResult {
  /** Files created (relative paths) */
  files: string[];
}

/**
 * Initialize the Shared Knowledge Layer under a workspace root.
 *
 *   <root>/knowledge-sources/raw/   — immutable provenance sources
 *   <root>/knowledge/               — Agent-consumable Read Model
 *     KNOWLEDGE.md / INDEX.md / log.md / platform/
 *
 * Fabric-owned contract files (AGENTS.md, KNOWLEDGE.md) are overwritten
 * deterministically. Agent/Human-maintained content (raw sources, INDEX.md,
 * log.md, compiled pages) is SEED-IF-ABSENT — existing files are never
 * overwritten, so Agent maintenance survives service restarts.
 */
export const initSharedKnowledgeLayer = (workspaceRoot: string): SharedKnowledgeInitResult => {
  const files: string[] = [];

  // Fabric-owned CONTRACT — deterministic overwrite on every init.
  const write = (relPath: string, content: string): void => {
    const abs = resolve(workspaceRoot, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    files.push(relPath);
  };

  // Agent/Human-maintained CONTENT — seed only if absent; never overwrite
  // existing files (Agent updates to INDEX/log/pages survive restarts).
  const writeIfAbsent = (relPath: string, content: string): void => {
    const abs = resolve(workspaceRoot, relPath);
    if (existsSync(abs)) {
      return; // already present (possibly Agent-modified) — leave untouched
    }
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    files.push(relPath);
  };

  // Workspace-root AGENTS.md contract (Hermes natively loads from cwd).
  write('AGENTS.md', AGENTS_CONTRACT);

  // Governance contract (Fabric-owned).
  write('knowledge/KNOWLEDGE.md', KNOWLEDGE_GOVERNANCE);

  // Immutable raw sources (provenance) — seed if absent.
  writeIfAbsent('knowledge-sources/raw/platform-promotion.md', RAW_PLATFORM_PROMOTION);
  writeIfAbsent('knowledge-sources/raw/marketing-case.md', RAW_MARKETING_CASE);

  // Navigation + log + seed compiled page — seed if absent (Agent-maintained).
  // P0011: knowledge pages are organized by SEMANTIC DOMAIN. 内容化推广 is a
  // platform promotion product → operations (经营) domain.
  writeIfAbsent('knowledge/INDEX.md', SEED_INDEX);
  writeIfAbsent('knowledge/log.md', SEED_LOG);
  writeIfAbsent('knowledge/operations/京东内容化推广.md', SEED_PLATFORM_PAGE);

  return { files };
};

/** Default governance/index content (re-export for projection convenience). */
export { KNOWLEDGE_GOVERNANCE, KNOWLEDGE_INDEX };
