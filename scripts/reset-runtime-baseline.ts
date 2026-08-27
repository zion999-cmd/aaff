// P0010.2.x — Clean Runtime Baseline Reset.
//
// Resets the dev DB and runtime filesystem to a known-empty baseline by
// deleting every "runtime fact" the Agent has SEEN, JUDGED, PRODUCED, or
// REMEMBERED, while PRESERVING every "capability / knowledge / config" the
// Agent HAS.
//
// What gets deleted (runtime — derived from past Hermes turns, demo seed,
// mock collection, test-fix runs, and CDP screenshots):
//   - DB tables: situations, learning_contexts, human_interventions,
//     signals, signal_weights, business_traces, ranking_results,
//     hourly_snapshots, hourly_snapshot_signals, context_memories,
//     operator_memories, feedback, reviews, jd_dataset_metadata,
//     jd_collection_runs, jd_raw_data, jd_metric_timeseries
//   - FS paths under data/evidence/** and runtime-only dirs under
//     data/fabric-workspace/{situations,investigations,investigation,
//     investigation_contracts,logs,screenshots,reports,references}/,
//     stray top-level investigation-*.json / investigation_result*.json
//     / investigation_sit_*.json / recommendation*.json,
//     knowledge/cases/case-sit_*.md, context/investigation_contract_*.json,
//     .hermes/
//   - data/discovery-schema/ and data/test-fabric-workspace/ (live test
//     scratch; not source files)
//
// What is preserved (capability / knowledge / config / code):
//   - DB schema + triggers (we DELETE rows, NOT the file)
//   - DB tables: products, orders, ranking_profiles, schema_version,
//     knowledge, collector_registry
//   - FS paths: data/fabric-workspace/knowledge/** (except runtime
//     case-sit_*.md), data/fabric-workspace/knowledge-sources/raw/**,
//     data/fabric-workspace/{capabilities,systems,context/handoff_*.md}/
//     (projector re-emits on next boot), data/fabric-workspace/AGENTS.md,
//     data/fabric-workspace/README.md, data/jd_shangzhi_features/**,
//     data/jd_full_discovery.json, data/jd_live_data.json,
//     generated/**, apps/ecommerce/knowledge/**,
//     .env, Hermes config, ADR-064 topology, HERMES_WS_URL,
//     .collector-auth/jd.json, ~/.agentfabric/chrome-jd-profile/
//
// Idempotency: re-running after a successful reset prints
// "Already clean — nothing to do" and exits 0.
//
// Usage:
//   npx tsx scripts/reset-runtime-baseline.ts            # DRY RUN (default; safe)
//   npx tsx scripts/reset-runtime-baseline.ts --dry-run  # explicit preview
//   npx tsx scripts/reset-runtime-baseline.ts --execute  # apply destructive op
//
// Convention: default to DRY-RUN (opposite of fix-dirty-lifecycle.ts and
// cleanup-polluted-situations.ts which default to APPLY). Reset is
// significantly more dangerous than a one-row UPDATE, so we flip the
// default to prevent accidental destructive runs.

import { readdirSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, closeDb } from '../platform/storage/connection.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface RuntimeTable {
  name: string;
  /** Human-readable reason for the deletion (printed in the audit log). */
  reason: string;
}

/** DB tables to delete. Children before parents (FK-safe). */
const RUNTIME_TABLES: readonly RuntimeTable[] = [
  // Children of hourly_snapshots + signals
  { name: 'hourly_snapshot_signals', reason: 'M2M join table for hourly_snapshots × signals' },
  // Children of reviews
  { name: 'feedback', reason: 'operator feedback on reviews' },
  // Children of situations
  { name: 'human_interventions', reason: 'human decisions on situations' },
  { name: 'learning_contexts', reason: 'agent learning context per situation' },
  // Parents (safe after children)
  { name: 'situations', reason: 'business situations the agent surfaced' },
  { name: 'hourly_snapshots', reason: 'hourly metric rollups' },
  { name: 'reviews', reason: 'review records' },
  // Standalone (no FK dependents)
  { name: 'signals', reason: 'raw metric signals (price/sales/uv/cvr/...)' },
  { name: 'signal_weights', reason: 'cached signal importance weights' },
  { name: 'business_traces', reason: 'agent decision trace records' },
  { name: 'ranking_results', reason: 'per-tick ranking outputs' },
  { name: 'context_memories', reason: 'agent context memory rows' },
  { name: 'operator_memories', reason: 'operator memory rows' },
  // JD runtime history (per user spec §9 — "collected-at" timestamps)
  { name: 'jd_dataset_metadata', reason: 'JD dataset snapshot metadata' },
  { name: 'jd_collection_runs', reason: 'JD collection run history' },
  { name: 'jd_raw_data', reason: 'JD raw collection data' },
  { name: 'jd_metric_timeseries', reason: 'JD metric time-series' },
];

/** Filesystem paths to delete. */
interface RuntimePath {
  path: string;
  reason: string;
  /**
   * When true, only delete the matching contents of the dir, not the dir itself.
   * Used to remove stray runtime files while keeping sibling KEEP files.
   */
  contentsOnly?: boolean;
  /**
   * When set, only delete entries whose basename matches one of these regex
   * patterns. If omitted, ALL entries in the dir are deleted (only safe for
   * the full-rm case where the dir is recreated empty below).
   */
  patterns?: readonly RegExp[];
  /**
   * When true, descend into subdirs and apply the same patterns recursively.
   * Used for data/evidence which has nested year/month dirs.
   */
  recursive?: boolean;
}

const RUNTIME_PATHS: readonly RuntimePath[] = [
  // Evidence — every runtime evidence file across all sources
  { path: 'data/evidence', reason: 'runtime evidence files (jd/2024, jd/2026, ...)', recursive: true },
  // Situation JSON files (incl. 4 demo fixtures)
  { path: 'data/fabric-workspace/situations', reason: 'runtime situation JSONs', recursive: true },
  // Investigation JSONs + reports
  { path: 'data/fabric-workspace/investigations', reason: 'runtime investigation JSONs', recursive: true },
  { path: 'data/fabric-workspace/investigation', reason: 'runtime investigation (singular)', recursive: true },
  { path: 'data/fabric-workspace/investigation_contracts', reason: 'runtime contract files', recursive: true },
  // Stray top-level runtime cognition files
  {
    path: 'data/fabric-workspace',
    reason: 'top-level investigation-*.json / investigation_result*.json / recommendation*.json / investigation_sit_*.json',
    contentsOnly: true,
    patterns: [
      /^investigation-.*\.json$/,
      /^investigation_result.*\.json$/,
      /^investigation_sit_.*\.json$/,
      /^recommendation.*\.json$/,
    ],
  },
  // Loop log + screenshots + case-log/reports
  { path: 'data/fabric-workspace/logs', reason: 'P0010.2.2 restart-invariant log', recursive: true },
  { path: 'data/fabric-workspace/screenshots', reason: 'CDP capture-demo screenshots', recursive: true },
  { path: 'data/fabric-workspace/reports', reason: 'cross-situation case logs', recursive: true },
  { path: 'data/fabric-workspace/references', reason: 'case-log-sit_*.md, sit_*_report.*', recursive: true },
  // Runtime contract artifact
  {
    path: 'data/fabric-workspace/context',
    reason: 'investigation_contract_*.json (runtime)',
    contentsOnly: true,
    patterns: [/^investigation_contract_.*\.json$/],
  },
  // .hermes — leftover dotfile (NOT written by projector)
  { path: 'data/fabric-workspace/.hermes', reason: 'leftover .hermes dir', recursive: true },
  // Runtime case logs (named after Situation; not part of long-term knowledge)
  {
    path: 'data/fabric-workspace/knowledge/cases',
    reason: 'case-sit_*.md (runtime case logs)',
    contentsOnly: true,
    patterns: [/^case-sit_.*\.md$/],
  },
  // Live schema-derivation output + test scratch
  { path: 'data/discovery-schema', reason: 'live schema-derivation output', recursive: true },
  { path: 'data/test-fabric-workspace', reason: 'test scratch (not source)', recursive: true },
];

/** KEEP paths we want to verify are unchanged after the reset. */
const KEEP_PATHS_FOR_HASH: readonly string[] = [
  'data/fabric-workspace/knowledge',
  'data/fabric-workspace/knowledge-sources',
  'data/fabric-workspace/capabilities',
  'data/fabric-workspace/systems',
  'data/fabric-workspace/AGENTS.md',
  'data/fabric-workspace/README.md',
  'data/fabric-workspace/context/handoff.md',
  'generated/capability-contract.json',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CountSnapshot {
  table: string;
  rows: number;
}

interface DirSnapshot {
  path: string;
  files: number;
}

const countTables = (db: ReturnType<typeof openDb>): CountSnapshot[] => {
  const result: CountSnapshot[] = [];
  for (const t of RUNTIME_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number };
    result.push({ table: t.name, rows: row.n });
  }
  return result;
};

const countPaths = (): DirSnapshot[] => {
  const result: DirSnapshot[] = [];
  for (const p of RUNTIME_PATHS) {
    if (!existsSync(p.path)) {
      result.push({ path: p.path, files: 0 });
      continue;
    }
    const stat = statSync(p.path);
    if (stat.isFile()) {
      result.push({ path: p.path, files: 1 });
    } else {
      let n = 0;
      try {
        if (p.patterns) {
          // Pattern-mode count: only count entries whose basename matches.
          // Non-recursive: only the top-level children.
          const entries = readdirSync(p.path);
          for (const e of entries) {
            if (p.patterns.some((re) => re.test(e))) n++;
          }
        } else if (p.recursive) {
          // Recursive file count for full-rm paths.
          const all = readdirSync(p.path, { recursive: true } as { recursive: true }) as
            | string[]
            | Array<{ name: string; parentPath: string }>;
          const flat: string[] = Array.isArray(all) && typeof all[0] === 'string'
            ? (all as string[])
            : (all as Array<{ name: string; parentPath: string }>).map((e) =>
                join(e.parentPath, e.name),
              );
          for (const entry of flat) {
            try {
              if (statSync(join(p.path, entry)).isFile()) n++;
            } catch {
              // skip unreadable
            }
          }
        } else {
          n = readdirSync(p.path).length;
        }
      } catch {
        n = -1;
      }
      result.push({ path: p.path, files: n });
    }
  }
  return result;
};

const hashFile = (path: string): string => {
  // Simple non-crypto hash for change detection (Node's built-in).
  // We use the file's mtime + size as a cheap proxy — sufficient to detect
  // mutations without pulling in crypto deps.
  const s = statSync(path);
  return `${s.mtimeMs.toString(16)}-${s.size.toString(16)}`;
};

const snapshotKeepPaths = (): Map<string, string> => {
  const map = new Map<string, string>();
  for (const p of KEEP_PATHS_FOR_HASH) {
    if (!existsSync(p)) continue;
    const s = statSync(p);
    if (s.isFile()) {
      map.set(p, `file:${hashFile(p)}`);
    } else if (s.isDirectory()) {
      for (const f of readdirSync(p, { recursive: true } as { recursive: true }) as string[]) {
        const full = join(p, f.toString());
        try {
          if (statSync(full).isFile()) map.set(full, `file:${hashFile(full)}`);
        } catch {
          // skip unreadable
        }
      }
    }
  }
  return map;
};

const diffHashes = (
  before: Map<string, string>,
  after: Map<string, string>,
): { addedOrChanged: string[]; removed: string[] } => {
  const addedOrChanged: string[] = [];
  const removed: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k) || before.get(k) !== v) {
      addedOrChanged.push(`+ ${k}  ${v}`);
    }
  }
  for (const [k, v] of before) {
    if (!after.has(k)) {
      removed.push(`- ${k}  ${v}`);
    }
  }
  return { addedOrChanged, removed };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = (): void => {
  const args = process.argv.slice(2);
  const hasDry = args.includes('--dry-run');
  const hasExec = args.includes('--execute');

  if (hasDry && hasExec) {
    console.error('[reset] ERROR: pass either --dry-run OR --execute, not both.');
    process.exit(2);
  }
  const execute = hasExec;
  const mode = execute ? 'EXECUTE' : 'DRY RUN';

  console.log('======================================================================');
  console.log(`[reset] P0010.2.x — Clean Runtime Baseline Reset — ${mode}`);
  console.log(`[reset] DB:   ${process.env.DB_PATH ?? './data/agentfabric.db'}`);
  console.log(`[reset] CWD:  ${process.cwd()}`);
  console.log('======================================================================');
  console.log('');

  const db = openDb();
  try {
    // ----- Pre-snapshot (always) -----
    console.log('[reset] Pre-snapshot — DB tables:');
    const tableBefore = countTables(db);
    for (const s of tableBefore) {
      console.log(`  ${s.table.padEnd(30)} ${String(s.rows).padStart(6)} rows  → DELETE`);
    }
    console.log('');
    console.log('[reset] Pre-snapshot — Filesystem paths:');
    const pathBefore = countPaths();
    for (const s of pathBefore) {
      console.log(`  ${s.path.padEnd(50)} ${String(s.files).padStart(6)} files → DELETE`);
    }
    console.log('');

    const keepBefore = snapshotKeepPaths();
    console.log(`[reset] Captured ${keepBefore.size} KEEP-path entries for hash check.`);
    console.log('');

    // Idempotency check: if everything is already 0, exit.
    const allZero =
      tableBefore.every((s) => s.rows === 0) && pathBefore.every((s) => s.files === 0);
    if (allZero) {
      console.log('[reset] Already clean — nothing to do.');
      return;
    }

    if (!execute) {
      console.log('[reset] DRY RUN complete. Re-run with --execute to apply.');
      return;
    }

    // ----- DB phase -----
    console.log('[reset] DB phase: applying DELETE in FK-safe order...');
    const tx = db.transaction(() => {
      for (const t of RUNTIME_TABLES) {
        const res = db.prepare(`DELETE FROM ${t.name}`).run();
        console.log(`  [tx] DELETE FROM ${t.name.padEnd(30)}  ${res.changes} rows`);
      }
    });
    tx();
    console.log('');

    // ----- Filesystem phase -----
    console.log('[reset] Filesystem phase: removing runtime paths...');
    let totalRemoved = 0;
    for (const p of RUNTIME_PATHS) {
      if (!existsSync(p.path)) {
        console.log(`  [fs] skip (missing): ${p.path}`);
        continue;
      }
      try {
        if (p.patterns) {
          // Pattern-mode: only delete entries whose basename matches.
          const entries = readdirSync(p.path);
          for (const e of entries) {
            if (!p.patterns.some((re) => re.test(e))) continue;
            const full = join(p.path, e);
            try {
              rmSync(full, { recursive: true, force: true });
              totalRemoved++;
              console.log(`  [fs] rm ${full}`);
            } catch (err) {
              console.log(`  [fs] WARN: failed to rm ${full}: ${(err as Error).message}`);
            }
          }
        } else if (p.contentsOnly) {
          // contentsOnly without patterns: delete ALL immediate children
          // (preserve the dir itself).
          const stat = statSync(p.path);
          if (stat.isDirectory()) {
            const entries = readdirSync(p.path);
            for (const e of entries) {
              const full = join(p.path, e);
              try {
                rmSync(full, { recursive: true, force: true });
                totalRemoved++;
                console.log(`  [fs] rm ${full}`);
              } catch (err) {
                console.log(`  [fs] WARN: failed to rm ${full}: ${(err as Error).message}`);
              }
            }
          } else {
            rmSync(p.path, { force: true });
            totalRemoved++;
            console.log(`  [fs] rm ${p.path}`);
          }
        } else {
          // Full-rm: remove the entire path, then recreate as empty dir
          // so the code that expects these dirs to exist does not NPE.
          rmSync(p.path, { recursive: true, force: true });
          totalRemoved++;
          console.log(`  [fs] rm ${p.path}`);
          mkdirSync(p.path, { recursive: true });
          console.log(`  [fs] mkdir ${p.path} (empty)`);
        }
      } catch (err) {
        console.log(`  [fs] ERROR: failed on ${p.path}: ${(err as Error).message}`);
      }
    }
    console.log(`  [fs] Total entries removed: ${totalRemoved}`);
    console.log('');

    // ----- Post-snapshot -----
    console.log('[reset] Post-snapshot — DB tables:');
    const tableAfter = countTables(db);
    let badTables = 0;
    for (const s of tableAfter) {
      const flag = s.rows === 0 ? 'OK' : 'FAIL';
      if (s.rows !== 0) badTables++;
      console.log(`  ${s.table.padEnd(30)} ${String(s.rows).padStart(6)} rows  [${flag}]`);
    }
    console.log('');
    console.log('[reset] Post-snapshot — Filesystem paths:');
    const pathAfter = countPaths();
    let badPaths = 0;
    for (const s of pathAfter) {
      const flag = s.files === 0 ? 'OK' : 'FAIL';
      if (s.files !== 0) badPaths++;
      console.log(`  ${s.path.padEnd(50)} ${String(s.files).padStart(6)} files [${flag}]`);
    }
    console.log('');

    // ----- KEEP-path hash diff -----
    const keepAfter = snapshotKeepPaths();
    const diff = diffHashes(keepBefore, keepAfter);
    // Exclude expected mutations:
    //   - The 'cases' subdir lost case-sit_*.md files, so those removals
    //     are expected.
    const expectedRemovals = diff.removed.filter((line) => {
      const m = line.match(/^-\s+(.*?)\s+/);
      if (!m) return false;
      const p = m[1]!;
      return p.includes('/knowledge/cases/case-sit_');
    });
    const unexpectedChanges = [
      ...diff.addedOrChanged,
      ...diff.removed.filter((l) => !expectedRemovals.some((e) => e === l)),
    ];
    console.log(`[reset] KEEP-path hash check:`);
    console.log(`  expected removals (case-sit_*.md): ${expectedRemovals.length}`);
    console.log(`  unexpected changes:                ${unexpectedChanges.length}`);
    if (unexpectedChanges.length > 0) {
      console.log('  --- unexpected changes (first 20) ---');
      for (const c of unexpectedChanges.slice(0, 20)) console.log(`    ${c}`);
    }
    console.log('');

    if (badTables > 0 || badPaths > 0 || unexpectedChanges.length > 0) {
      console.log(
        `[reset] PARTIAL: ${badTables} table(s) with rows>0, ${badPaths} path(s) with files>0, ${unexpectedChanges.length} unexpected KEEP changes.`,
      );
      process.exit(1);
    }
    console.log('[reset] OK: clean runtime baseline achieved.');
  } finally {
    closeDb(db);
  }
};

main();
