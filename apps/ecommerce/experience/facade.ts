// Memory façade — the only cross-domain import surface for business memory.

import type { Database as Db } from 'better-sqlite3';
import type { ContextMemory } from '#shared/schemas/memory.js';
import type { RankingMemoryAdjustment } from '#shared/schemas/ranking.js';
import { extractMemories, type ExtractMemoriesInput } from './extraction.js';
import {
  memoryAdjustmentsFor,
  queryActiveMemories,
  storeMemories,
} from './repository.js';

export interface MemoryFacade {
  /** Extract validated memories from reject reviews (pure). */
  extract(input: ExtractMemoriesInput): ContextMemory[];
  /** Persist memories (upsert). */
  store(db: Db, memories: readonly ContextMemory[]): number;
  /** Query active validated memories for an agent. */
  queryActive(db: Db, agentId?: string): ContextMemory[];
  /** Derive ranking adjustments from active memories (un-stubs the ranking hook). */
  adjustmentsFor(db: Db, agentId?: string): RankingMemoryAdjustment[];
}

/**
 * P0010.2.3 (ADR-059 audit J-2) — REMOVE CANDIDATE for `extract` + `store`.
 * `queryActive` + `adjustmentsFor` are LIVE (read side, 4 production callers);
 * `extract` + `store` are inert (zero production callers). Out of scope to
 * delete the facade or its inert members; the JSDoc on the inert members
 * makes the dead leg explicit so future contributors don't reach for it.
 */
export const MemoryFacade: MemoryFacade = {
  extract: (input) => extractMemories(input), // REMOVE CANDIDATE — production zero-call
  store: (db, memories) => storeMemories(db, memories), // REMOVE CANDIDATE — production zero-call
  queryActive: (db, agentId) => queryActiveMemories(db, agentId),
  adjustmentsFor: (db, agentId) => memoryAdjustmentsFor(db, agentId),
};
