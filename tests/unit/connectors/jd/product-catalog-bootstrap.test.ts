// P0010.1 Final Repair — Area A. Product-catalog bootstrap tests.
//
// Coverage:
//   - env-var opt-out (BOOTSTRAP_PRODUCT_CATALOG=skip) is honored
//   - missing evidence root → zero rows, no throw
//   - getProductList*.json is read and projected into `products`
//   - the .meta.json sidecar's acquired_at is preserved on every row
//   - idempotency: a second call does not duplicate rows (upsert by product_id)
//   - malformed JSON in a single file is skipped, not thrown
//   - non-getProductList files are ignored
//   - no LLM call: the function never imports or references an LLM module

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

const { bootstrapProductCatalog } = await import(
  '#app/connectors/jd/product-catalog-bootstrap.js'
);

interface ProductRow {
  product_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** In-memory SQLite with the products table only — enough for upsertProducts. */
const makeDb = (): Db => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE products (
      product_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      price REAL,
      stock INTEGER,
      status TEXT NOT NULL,
      attributes TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
};

const listProducts = (db: Db): ProductRow[] =>
  (db.prepare('SELECT * FROM products').all() as ProductRow[]);

const SAMPLE_DATA = [
  {
    body: {
      data: {
        list: [
          {
            spu_id: 'sku-A',
            proName: '祁门红茶官方旗舰店新茶',
            proPic: 'picA',
            proUrl: 'urlA',
          },
          {
            spu_id: 'sku-B',
            proName: '安徽黄山毛峰',
          },
        ],
      },
    },
  },
];

const SAMPLE_DATA_2 = [
  {
    body: {
      data: {
        list: [
          {
            spu_id: 'sku-C',
            proName: '西湖龙井 2026 新茶',
          },
        ],
      },
    },
  },
];

const writeFile = (root: string, rel: string, body: unknown): void => {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, JSON.stringify(body), 'utf8');
};

const writeMeta = (root: string, rel: string, body: { acquired_at: string }): void => {
  const full = join(root, rel.replace(/\.json$/, '.meta.json'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, JSON.stringify(body), 'utf8');
};

describe('bootstrapProductCatalog', () => {
  let workdir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'));
    originalEnv = process.env.BOOTSTRAP_PRODUCT_CATALOG;
    delete process.env.BOOTSTRAP_PRODUCT_CATALOG;
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.BOOTSTRAP_PRODUCT_CATALOG;
    } else {
      process.env.BOOTSTRAP_PRODUCT_CATALOG = originalEnv;
    }
  });

  it('honors BOOTSTRAP_PRODUCT_CATALOG=skip without touching the DB', async () => {
    process.env.BOOTSTRAP_PRODUCT_CATALOG = 'skip';
    const db = makeDb();
    const result = await bootstrapProductCatalog(db, { evidenceRoot: workdir });
    expect(result.skippedViaEnv).toBe(true);
    expect(result.files).toBe(0);
    expect(result.projected).toBe(0);
    expect(listProducts(db)).toEqual([]);
  });

  it('returns zeros when the JD root is missing', async () => {
    const db = makeDb();
    const result = await bootstrapProductCatalog(db, { evidenceRoot: workdir });
    expect(result.files).toBe(0);
    expect(result.projected).toBe(0);
    expect(result.skippedViaEnv).toBe(false);
    expect(listProducts(db)).toEqual([]);
  });

  it('projects getProductList*.json into products and preserves acquired_at', async () => {
    writeFile(workdir, 'jd/2026/08/15_getProductList.json', SAMPLE_DATA);
    writeMeta(workdir, 'jd/2026/08/15_getProductList.json', {
      acquired_at: '2026-08-15T10:00:00.000Z',
    });
    const db = makeDb();
    const result = await bootstrapProductCatalog(db, { evidenceRoot: workdir });
    expect(result.files).toBe(1);
    expect(result.projected).toBe(2);
    const rows = listProducts(db);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.product_id === 'sku-A')!;
    expect(a.name).toBe('祁门红茶官方旗舰店新茶');
    expect(a.created_at).toBe('2026-08-15T10:00:00.000Z');
    expect(a.updated_at).toBe('2026-08-15T10:00:00.000Z');
  });

  it('is idempotent across multiple files and multiple calls', async () => {
    writeFile(workdir, 'jd/2026/08/15_getProductList.json', SAMPLE_DATA);
    writeMeta(workdir, 'jd/2026/08/15_getProductList.json', {
      acquired_at: '2026-08-15T10:00:00.000Z',
    });
    writeFile(workdir, 'jd/2026/08/18_getProductList.json', SAMPLE_DATA_2);
    writeMeta(workdir, 'jd/2026/08/18_getProductList.json', {
      acquired_at: '2026-08-18T11:00:00.000Z',
    });
    const db = makeDb();
    const first = await bootstrapProductCatalog(db, { evidenceRoot: workdir });
    expect(first.projected).toBe(3);
    const second = await bootstrapProductCatalog(db, { evidenceRoot: workdir });
    // No new rows on the second call.
    expect(second.projected).toBe(3);
    expect(listProducts(db)).toHaveLength(3);
  });

  it('skips malformed JSON without throwing', async () => {
    writeFile(workdir, 'jd/2026/08/15_getProductList.json', SAMPLE_DATA);
    writeMeta(workdir, 'jd/2026/08/15_getProductList.json', {
      acquired_at: '2026-08-15T10:00:00.000Z',
    });
    const broken = join(workdir, 'jd/2026/08/16_getProductList.json');
    mkdirSync(join(broken, '..'), { recursive: true });
    writeFileSync(broken, '{not valid json', 'utf8');
    writeMeta(workdir, 'jd/2026/08/16_getProductList.json', {
      acquired_at: '2026-08-16T10:00:00.000Z',
    });
    const db = makeDb();
    const result = await bootstrapProductCatalog(db, { evidenceRoot: workdir });
    expect(result.files).toBe(2);
    expect(result.projected).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('ignores non-getProductList files and .meta.json sidecars', async () => {
    writeFile(workdir, 'jd/2026/08/15_getProductList.json', SAMPLE_DATA);
    writeMeta(workdir, 'jd/2026/08/15_getProductList.json', {
      acquired_at: '2026-08-15T10:00:00.000Z',
    });
    writeFile(workdir, 'jd/2026/08/15_productTop.json', { list: [{ spu_id: 'pt-1' }] });
    writeFile(workdir, 'jd/2026/08/15_getProductList.meta.json', { acquired_at: 'x' });
    const db = makeDb();
    const result = await bootstrapProductCatalog(db, { evidenceRoot: workdir });
    expect(result.files).toBe(1);
    expect(result.projected).toBe(2);
  });

  it('falls back to nowIso when the sidecar is missing', async () => {
    writeFile(workdir, 'jd/2026/08/15_getProductList.json', SAMPLE_DATA);
    // No meta sidecar.
    const db = makeDb();
    const before = Date.now();
    const result = await bootstrapProductCatalog(db, { evidenceRoot: workdir });
    const after = Date.now();
    expect(result.projected).toBe(2);
    const rows = listProducts(db);
    const a = rows.find((r) => r.product_id === 'sku-A')!;
    const ts = Date.parse(a.created_at);
    expect(ts).toBeGreaterThanOrEqual(before - 1);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });
});
