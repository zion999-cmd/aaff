// Memory persistence: read/write ContextMemory records to SQLite.

import type { Database as Db } from 'better-sqlite3';
import type { ContextMemory } from '#shared/schemas/memory.js';
import type { RankingMemoryAdjustment } from '#shared/schemas/ranking.js';

interface MemoryRow {
  memory_id: string;
  memory_type: string;
  scope_entity_type: string | null;
  scope_entity_ids: string | null;
  statement: string;
  evidence: string;
  weight: string;
  temporal: string;
  status: string;
  validation_state: string;
  validator: string | null;
  validated_at: string | null;
  override: string;
  trace: string;
  adjustment: string | null;
  agent_id: string | null;
  created_at: string;
}

const toRow = (m: ContextMemory, agentId?: string): MemoryRow => ({
  memory_id: m.memory_id,
  memory_type: m.memory_type,
  scope_entity_type: m.scope.entity_type,
  scope_entity_ids: JSON.stringify(m.scope.entity_ids),
  statement: m.statement,
  evidence: JSON.stringify(m.evidence),
  weight: JSON.stringify(m.weight),
  temporal: JSON.stringify(m.temporal),
  status: m.status,
  validation_state: m.validation.state,
  validator: m.validation.validator ?? null,
  validated_at: m.validation.validated_at ?? null,
  override: JSON.stringify(m.override),
  trace: JSON.stringify(m.trace),
  adjustment: m.adjustment ? JSON.stringify(m.adjustment) : null,
  agent_id: agentId ?? m.scope.agent_id ?? null,
  created_at: m.created_at,
});

/** Upsert memories (insert or replace by memory_id). Returns count.
 *
 * P0010.2.3 (ADR-059 audit J-1) — REMOVE CANDIDATE.
 * Production zero-call: only the in-memory wrapper `MemoryFacade.store`
 * (itself unused) calls this. Out of scope for this slice to delete.
 * Do not use in new code; the canonical write side is
 * `recordInterventionInLearningContext` (writes `learning_contexts.body`,
 * not `context_memories`).
 */
export const storeMemories = (db: Db, memories: readonly ContextMemory[]): number => {
  const stmt = db.prepare(
    `INSERT INTO context_memories (
       memory_id, memory_type, scope_entity_type, scope_entity_ids, statement, evidence,
       weight, temporal, status, validation_state, validator, validated_at, override, trace,
       adjustment, agent_id, created_at
     ) VALUES (
       @memory_id, @memory_type, @scope_entity_type, @scope_entity_ids, @statement, @evidence,
       @weight, @temporal, @status, @validation_state, @validator, @validated_at, @override, @trace,
       @adjustment, @agent_id, @created_at
     )
     ON CONFLICT(memory_id) DO UPDATE SET
       status = excluded.status, validation_state = excluded.validation_state,
       weight = excluded.weight, temporal = excluded.temporal, override = excluded.override,
       adjustment = excluded.adjustment`,
  );
  let count = 0;
  const tx = db.transaction((rows: readonly MemoryRow[]) => {
    for (const row of rows) {
      stmt.run(row);
      count += 1;
    }
  });
  tx(memories.map((m) => toRow(m)));
  return count;
};

/** Query active, validated memories for an agent. */
export const queryActiveMemories = (db: Db, agentId?: string): ContextMemory[] => {
  const rows = agentId
    ? (db
        .prepare(
          `SELECT * FROM context_memories WHERE status = 'active' AND validation_state = 'validated' AND agent_id = ?`,
        )
        .all(agentId) as MemoryRow[])
    : (db
        .prepare(
          `SELECT * FROM context_memories WHERE status = 'active' AND validation_state = 'validated'`,
        )
        .all() as MemoryRow[]);
  return rows.map(fromRow);
};

/** Convert active memories into ranking adjustments (un-stubs the ranking hook). */
export const memoryAdjustmentsFor = (db: Db, agentId?: string): RankingMemoryAdjustment[] => {
  const memories = queryActiveMemories(db, agentId);
  const adjustments: RankingMemoryAdjustment[] = [];
  for (const m of memories) {
    if (m.override.is_overridden) continue; // overridden = explanation-only
    if (!m.adjustment) continue;
    adjustments.push(m.adjustment);
  }
  return adjustments;
};

const fromRow = (r: MemoryRow): ContextMemory => ({
  memory_id: r.memory_id,
  memory_type: r.memory_type as ContextMemory['memory_type'],
  scope: {
    entity_type: (r.scope_entity_type ?? 'signal') as ContextMemory['scope']['entity_type'],
    entity_ids: r.scope_entity_ids ? JSON.parse(r.scope_entity_ids) : [],
    ...(r.agent_id ? { agent_id: r.agent_id } : {}),
  },
  statement: r.statement,
  evidence: JSON.parse(r.evidence),
  weight: JSON.parse(r.weight),
  temporal: JSON.parse(r.temporal),
  status: r.status as ContextMemory['status'],
  validation: {
    state: r.validation_state as ContextMemory['validation']['state'],
    ...(r.validator ? { validator: r.validator as 'human' | 'rule' } : {}),
    ...(r.validated_at ? { validated_at: r.validated_at } : {}),
  },
  override: JSON.parse(r.override),
  trace: JSON.parse(r.trace),
  ...(r.adjustment ? { adjustment: JSON.parse(r.adjustment) } : {}),
  created_at: r.created_at,
});
