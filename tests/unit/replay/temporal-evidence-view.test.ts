// P0013 Phase 4 — temporal-evidence-view (the §3 SQL-level filter).
//
// The temporal filter is the §3 "no-future-leak at the data boundary" check.
// It runs at the SQL layer, not the prompt layer. A Replay run can only
// see evidence rows whose `replay_run_id = ?` AND `business_date <= T`.
// Production rows (replay_run_id IS NULL) are NEVER visible to any Replay.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyP0013Schema,
} from '#platform/storage/p0013-schema.js';
import {
  visibleEvidenceFor,
  tagEvidenceAsReplayVisible,
} from '#app/runtime/replay/temporal-evidence-view.js';

let db: Database.Database;

const setupDb = (): Database.Database => {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE evidence_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      data_type TEXT NOT NULL,
      business_date TEXT NOT NULL,
      business_time_bucket TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      evidence_file_path TEXT NOT NULL,
      content_size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      replay_run_id TEXT,
      replay_run_step_id TEXT
    );
  `);
  applyP0013Schema(d);
  return d;
};

const insertEvidence = (
  d: Database.Database,
  args: {
    shop_id: string;
    business_date: string;
    replay_run_id: string | null;
    replay_run_step_id: string | null;
    evidence_file_path: string;
  },
): number => {
  const r = d
    .prepare(
      `INSERT INTO evidence_observations
       (shop_id, capability, data_type, business_date, business_time_bucket,
        acquired_at, content_hash, evidence_file_path, content_size, created_at,
        replay_run_id, replay_run_step_id)
       VALUES (?, 'trade.overview', 'getSummary', ?, '2026-08-04T10',
        '2026-08-04T10:00:00Z', ?, ?, 1, '2026-08-04T10:00:01Z', ?, ?)`,
    )
    .run(
      args.shop_id,
      args.business_date,
      `hash-${Math.random()}`,
      args.evidence_file_path,
      args.replay_run_id,
      args.replay_run_step_id,
    );
  return Number(r.lastInsertRowid);
};

beforeEach(() => {
  db = setupDb();
});
afterEach(() => {
  db.close();
});

describe('visibleEvidenceFor — §3 data boundary', () => {
  it('returns rows whose business_date <= T for the same replay_run_id', () => {
    // Setup: a Replay run with 3 evidence rows on 08-10, 08-15, 08-25.
    insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-10', replay_run_id: 'runA', replay_run_step_id: 's1', evidence_file_path: '/d/08-10' });
    insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-15', replay_run_id: 'runA', replay_run_step_id: 's2', evidence_file_path: '/d/08-15' });
    insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-25', replay_run_id: 'runA', replay_run_step_id: 's3', evidence_file_path: '/d/08-25' });
    const visible = visibleEvidenceFor(db, 'runA', '2026-08-20');
    expect(visible.map((r) => r.business_date).sort()).toEqual(['2026-08-10', '2026-08-15']);
  });

  it('includes the boundary date (≤ is the contract)', () => {
    insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-20', replay_run_id: 'runA', replay_run_step_id: 's1', evidence_file_path: '/d/08-20' });
    const visible = visibleEvidenceFor(db, 'runA', '2026-08-20');
    expect(visible).toHaveLength(1);
  });

  it('NEVER returns production rows (replay_run_id IS NULL)', () => {
    insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-10', replay_run_id: null, replay_run_step_id: null, evidence_file_path: '/d/prod' });
    const visible = visibleEvidenceFor(db, 'runA', '2026-08-20');
    expect(visible).toEqual([]);
  });

  it('NEVER returns rows from a different Replay run', () => {
    insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-10', replay_run_id: 'runA', replay_run_step_id: 's1', evidence_file_path: '/d/A' });
    insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-10', replay_run_id: 'runB', replay_run_step_id: 's1', evidence_file_path: '/d/B' });
    const visible = visibleEvidenceFor(db, 'runA', '2026-08-20');
    expect(visible).toHaveLength(1);
    expect(visible[0]!.evidence_file_path).toBe('/d/A');
  });
});

describe('tagEvidenceAsReplayVisible', () => {
  it('tags the listed evidence_observation ids with the given run + step ids', () => {
    const id1 = insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-10', replay_run_id: null, replay_run_step_id: null, evidence_file_path: '/d/1' });
    const id2 = insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-11', replay_run_id: null, replay_run_step_id: null, evidence_file_path: '/d/2' });
    tagEvidenceAsReplayVisible(db, [id1, id2], 'runA', 'stepA');
    const rows = db
      .prepare(`SELECT id, replay_run_id, replay_run_step_id FROM evidence_observations ORDER BY id`)
      .all() as Array<{ id: number; replay_run_id: string; replay_run_step_id: string }>;
    expect(rows).toEqual([
      { id: id1, replay_run_id: 'runA', replay_run_step_id: 'stepA' },
      { id: id2, replay_run_id: 'runA', replay_run_step_id: 'stepA' },
    ]);
  });

  it('does NOT touch rows not in the ids list (production isolation)', () => {
    const idProd = insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-10', replay_run_id: null, replay_run_step_id: null, evidence_file_path: '/d/prod' });
    const idReplay = insertEvidence(db, { shop_id: 'jd', business_date: '2026-08-10', replay_run_id: null, replay_run_step_id: null, evidence_file_path: '/d/replay' });
    tagEvidenceAsReplayVisible(db, [idReplay], 'runA', 'stepA');
    const prod = db.prepare(`SELECT replay_run_id FROM evidence_observations WHERE id = ?`).get(idProd) as { replay_run_id: string | null };
    expect(prod.replay_run_id).toBeNull();
  });
});
