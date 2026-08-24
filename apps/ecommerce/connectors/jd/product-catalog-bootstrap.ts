// P0010.1 Final Repair — Area A. Idempotent product-catalog bootstrap.
//
// Why this file exists:
// The canonical product-catalog producer `projectProductCatalog` (in ./product-catalog.ts)
// is wired and tested but has no production caller. The `products` table is therefore
// empty in dev, and Situation cards display "未知商品 · SKU <id>" because the
// situation producer's `listProducts(db)` lookup returns nothing.
//
// What this file does NOT do:
//   - Does NOT call an LLM to invent product names.
//   - Does NOT introduce a second Product Store.
//   - Does NOT mutate any non-`products` table.
//   - Does NOT log product names (counts only).
//
// Behavior:
//   - Walks every `getProductList*.json` evidence file under the platform's
//     evidence root (default `data/evidence/jd`), reads its `.meta.json` sidecar
//     for `acquired_at`, projects via `projectProductCatalog`, and upserts via
//     the existing `upsertProducts` repository.
//   - Idempotent: re-runnable on every startup; `upsertProducts` overwrites by
//     primary key `product_id`.
//   - Skippable: set `BOOTSTRAP_PRODUCT_CATALOG=skip` to opt out (tests, CI).
//   - Safe on missing files: any read/parse error is logged and the file is
//     skipped, never thrown.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { projectProductCatalog } from './product-catalog.js';
import { upsertProducts } from '#platform/storage/product-repository.js';
import { evidenceRoot } from '../evidence/store.js';
import { nowIso } from '#shared/utils/time.js';

export interface BootstrapOptions {
  /** Override the evidence root. Default: `evidenceRoot()` (process.cwd() + data/evidence). */
  evidenceRoot?: string;
}

export interface BootstrapResult {
  /** Number of getProductList files found (under the platform tree). */
  files: number;
  /** Number of products upserted (post-dedup inside each file). */
  projected: number;
  /** Number of files skipped due to missing sidecar / parse error / empty list. */
  skipped: number;
  /** Set when BOOTSTRAP_PRODUCT_CATALOG=skip. */
  skippedViaEnv: boolean;
}

const SKIP_ENV = 'BOOTSTRAP_PRODUCT_CATALOG';

/**
 * Bootstrap the products table from on-disk `getProductList*` evidence.
 * Safe to call on every server start; idempotent and non-throwing.
 */
export const bootstrapProductCatalog = async (
  db: Db,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> => {
  if (process.env[SKIP_ENV] === 'skip') {
    return { files: 0, projected: 0, skipped: 0, skippedViaEnv: true };
  }
  const root = options.evidenceRoot ?? evidenceRoot();
  // Only bootstrap from the JD platform tree (today's only source of getProductList).
  const jdRoot = join(root, 'jd');
  const files = await findGetProductListFiles(jdRoot);
  let projected = 0;
  let skipped = 0;
  for (const dataFile of files) {
    try {
      const acquiredAt = await readAcquiredAt(dataFile);
      const raw = JSON.parse(await readFile(dataFile, 'utf8'));
      const rows = projectProductCatalog(raw);
      if (rows.length === 0) {
        skipped++;
        continue;
      }
      // Stamp every projected row with the evidence's acquired_at (preserved
      // provenance) — projectProductCatalog already set created_at/updated_at
      // to nowIso, so re-stamp both to keep the lifecycle consistent.
      const stamped = rows.map((r) => ({
        ...r,
        created_at: acquiredAt,
        updated_at: acquiredAt,
      }));
      projected += upsertProducts(db, stamped);
    } catch (err) {
      skipped++;
      // eslint-disable-next-line no-console
      console.warn(
        `[bootstrap] skip ${dataFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // eslint-disable-next-line no-console
  console.info(
    `[bootstrap] products projected: ${projected} from ${files.length} files (${skipped} skipped)`,
  );
  return { files: files.length, projected, skipped, skippedViaEnv: false };
};

/** Walk `root/**` and return every `.json` (NOT `.meta.json`) whose name
 *  matches the evidence-naming convention: `<DD>_<dataType>.json` where
 *  dataType is `getProductList`. The DD prefix is the day-of-month. */
const GET_PRODUCT_LIST_NAME = /^\d{2}_getProductList\.json$/;
const findGetProductListFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or unreadable — treat as empty.
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && GET_PRODUCT_LIST_NAME.test(e.name)) {
        out.push(full);
      }
    }
  }
  // Deterministic order for tests and logs.
  out.sort();
  return out;
};

/** Read the .meta.json sidecar for `dataFile` and return its `acquired_at`. */
const readAcquiredAt = async (dataFile: string): Promise<string> => {
  const metaPath = dataFile.replace(/\.json$/, '.meta.json');
  try {
    const raw = JSON.parse(await readFile(metaPath, 'utf8'));
    if (typeof raw?.acquired_at === 'string' && raw.acquired_at.length > 0) {
      return raw.acquired_at;
    }
  } catch {
    // fall through to fallback
  }
  // No sidecar or no acquired_at: stamp with now. This is the only fallback
  // path; the evidence root on every dev box has the sidecar.
  return nowIso();
};
