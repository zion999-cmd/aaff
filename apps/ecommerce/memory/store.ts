// P0007.3.1 Memory Store
// Persistent storage for OperatorMemory records.
// Before: memories generated ephemerally by buildOperatorMemories(), never saved.
// After: memories persisted to SQLite → survive restarts → accumulate over time.
//
// The store is a thin persistence layer. All business logic lives in
// the Memory Builder (P0007.2) and Matcher (P0007.3.2).

import type { Database as Db } from 'better-sqlite3';
import type { OperatorMemory } from './types.js';

// ---- Schema ----

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS operator_memories (
    memory_id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    trigger_primary_driver TEXT NOT NULL,
    trigger_direction TEXT NOT NULL,
    trigger_season TEXT,
    pattern_description TEXT NOT NULL,
    observations INTEGER NOT NULL DEFAULT 0,
    recovery_count INTEGER NOT NULL DEFAULT 0,
    recovery_probability REAL NOT NULL DEFAULT 0,
    avg_recovery_days REAL NOT NULL DEFAULT 0,
    primary_driver TEXT NOT NULL,
    driver_confidence REAL NOT NULL DEFAULT 0,
    memory_confidence REAL NOT NULL DEFAULT 0,
    last_observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_category ON operator_memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_confidence ON operator_memories(memory_confidence DESC);
`;

/** Ensure the operator_memories table exists. Idempotent. */
export const initMemoryStore = (db: Db): void => {
  db.exec(TABLE_DDL);
};

// ---- CRUD ----

/** Upsert memories — insert new, update existing by operator_memories.memory_id.
 *
 * P0010.2.3 (ADR-059 audit J-1) — REMOVE CANDIDATE.
 * Production zero-call: `apps/ecommerce/memory/index.ts:2` re-exports it,
 * but no production route/orchestrator imports it. Out of scope for this
 * slice to delete (per user spec — no Memory Architecture refactor).
 */
export const upsertMemories = (db: Db, memories: OperatorMemory[]): number => {
  const stmt = db.prepare(`
    INSERT INTO operator_memories (
      memory_id, category, trigger_primary_driver, trigger_direction, trigger_season,
      pattern_description, observations, recovery_count, recovery_probability,
      avg_recovery_days, primary_driver, driver_confidence, memory_confidence,
      last_observed_at, created_at
    ) VALUES (
      @memory_id, @category, @trigger_primary_driver, @trigger_direction, @trigger_season,
      @pattern_description, @observations, @recovery_count, @recovery_probability,
      @avg_recovery_days, @primary_driver, @driver_confidence, @memory_confidence,
      @last_observed_at, @created_at
    )
    ON CONFLICT(memory_id) DO UPDATE SET
      observations = excluded.observations,
      recovery_count = excluded.recovery_count,
      recovery_probability = excluded.recovery_probability,
      avg_recovery_days = excluded.avg_recovery_days,
      memory_confidence = excluded.memory_confidence,
      last_observed_at = excluded.last_observed_at
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const m of memories) {
      stmt.run({
        memory_id: m.memory_id,
        category: m.category,
        trigger_primary_driver: m.trigger_signature.primary_driver,
        trigger_direction: m.trigger_signature.direction,
        trigger_season: m.trigger_signature.season ?? null,
        pattern_description: m.pattern_description,
        observations: m.statistics.observations,
        recovery_count: m.statistics.recovery_count,
        recovery_probability: m.statistics.recovery_probability,
        avg_recovery_days: m.statistics.avg_recovery_days,
        primary_driver: m.primary_driver,
        driver_confidence: m.driver_confidence,
        memory_confidence: m.memory_confidence,
        last_observed_at: m.last_observed_at,
        created_at: m.created_at,
      });
      count++;
    }
  });
  tx();
  return count;
};

/** List all persisted operator_memories, sorted by confidence descending.
 *
 * P0010.2.3 (ADR-059 audit J-1) — REMOVE CANDIDATE.
 * Production zero-call: no route/orchestrator imports it. Out of scope to delete.
 */
export const listMemories = (db: Db, limit = 50): OperatorMemory[] => {
  const rows = db.prepare(`
    SELECT * FROM operator_memories
    ORDER BY memory_confidence DESC
    LIMIT ?
  `).all(limit) as MemoryRow[];

  return rows.map(fromRow);
};

/** Get operator_memories matching a category.
 *
 * P0010.2.3 (ADR-059 audit J-1) — REMOVE CANDIDATE.
 * Production zero-call: no route/orchestrator imports it. Out of scope to delete.
 */
export const findMemoriesByCategory = (db: Db, category: string): OperatorMemory[] => {
  const rows = db.prepare(`
    SELECT * FROM operator_memories
    WHERE category = ?
    ORDER BY memory_confidence DESC
  `).all(category) as MemoryRow[];

  return rows.map(fromRow);
};

// ---- Internal ----

interface MemoryRow {
  memory_id: string;
  category: string;
  trigger_primary_driver: string;
  trigger_direction: string;
  trigger_season: string | null;
  pattern_description: string;
  observations: number;
  recovery_count: number;
  recovery_probability: number;
  avg_recovery_days: number;
  primary_driver: string;
  driver_confidence: number;
  memory_confidence: number;
  last_observed_at: string;
  created_at: string;
}

const fromRow = (r: MemoryRow): OperatorMemory => ({
  memory_id: r.memory_id,
  category: r.category as OperatorMemory['category'],
  trigger_signature: {
    primary_driver: r.trigger_primary_driver,
    direction: r.trigger_direction as 'up' | 'down',
    ...(r.trigger_season ? { season: r.trigger_season } : {}),
  },
  pattern_description: r.pattern_description,
  statistics: {
    observations: r.observations,
    recovery_count: r.recovery_count,
    recovery_probability: r.recovery_probability,
    avg_recovery_days: r.avg_recovery_days,
  },
  primary_driver: r.primary_driver,
  driver_confidence: r.driver_confidence,
  memory_confidence: r.memory_confidence,
  last_observed_at: r.last_observed_at,
  created_at: r.created_at,
});
