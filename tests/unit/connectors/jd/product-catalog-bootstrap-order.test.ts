// P0010.2.3 (ADR-059 audit A-1 fix) — bootstrap vs startServer ordering.
//
// Background: P0010.1 Final Repair added the product-catalog bootstrap so the
// Situation cards display real product names (e.g. "祁门红茶旗舰店") instead
// of the "未知商品 · SKU <id>" fallback. The bootstrap is implemented in
// `apps/ecommerce/connectors/jd/product-catalog-bootstrap.ts` and called
// from `platform/server/index.ts#main`.
//
// The bug: in P0010.1 the call was placed AFTER `startServer({db, schedule})`
// + `_getPendingLoop()?.start()`. The HTTP server was already listening when
// the bootstrap ran. On a fresh dev box (empty `products` table) the Loop's
// first Situation producer pass writes `entity_name = NULL` for every row,
// and the UI's `entityDisplayName` fallback is what keeps the user from
// seeing nulls. The chain is wired but the wire is racing.
//
// The fix: move the bootstrap BEFORE `startServer()` so the catalog is
// populated before the Loop's first tick (and before the HTTP server starts
// accepting requests). This test pins the ordering invariant by reading
// the source of `platform/server/index.ts` and asserting the line position
// of `bootstrapProductCatalog(...)` is before `startServer({...})`.
//
// Why a source-level test (not a behavior test)? The bootstrap is dynamic-
// imported inside a `try/catch`; spying on it from a unit test would need
// to import the full `main()` machinery, which spawns the HTTP server and
// the Loop. The source-level invariant is the actual contract; the chain
// test is over-engineering for the single line move.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('platform/server/index.ts ordering', () => {
  it('runs product-catalog bootstrap BEFORE startServer (audit A-1 fix)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'platform/server/index.ts'),
      'utf8',
    );

    // Anchor markers — the call sites are stable, named strings in the file.
    const bootstrapMarker = 'await bootstrapProductCatalog(db)';
    const startServerMarker = 'startServer({ db, schedule })';

    const bootstrapIdx = source.indexOf(bootstrapMarker);
    const startServerIdx = source.indexOf(startServerMarker);

    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(startServerIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(startServerIdx);
  });

  it('runs initDatabase() BEFORE the bootstrap (so bootstrap sees a schema)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'platform/server/index.ts'),
      'utf8',
    );
    // Fresh-DB regression: the bootstrap was originally placed after
    // startServer() so the schema was created first. The A-1 fix moved
    // the bootstrap BEFORE startServer(), which broke fresh-DB boots
    // because the schema is created inside startServer(). The follow-up
    // is to call initDatabase(db) explicitly before the bootstrap, so
    // the schema exists by the time the bootstrap walks evidence files.
    const initIdx = source.indexOf('initDatabase(db)');
    const bootstrapIdx = source.indexOf('await bootstrapProductCatalog(db)');
    expect(initIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeLessThan(bootstrapIdx);
  });

  it('places the bootstrap call inside the main() entry, not in a sibling function', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'platform/server/index.ts'),
      'utf8',
    );

    // Sanity: the bootstrap call must live between the `const main = ...` opening
    // brace and the matching `};` — i.e. inside main, not in a helper.
    const mainOpen = source.indexOf('const main = async');
    const bootstrapIdx = source.indexOf('await bootstrapProductCatalog(db)');
    // Find the closing `};` of main() — the first one after mainOpen that
    // closes a top-level const declaration (followed by `if (import.meta`).
    const closingAfterBootstrap = source.indexOf('};', bootstrapIdx);
    const guardAfterClosing = source.indexOf(
      'if (import.meta.url',
      closingAfterBootstrap,
    );

    expect(mainOpen).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(mainOpen);
    expect(closingAfterBootstrap).toBeGreaterThan(bootstrapIdx);
    expect(guardAfterClosing).toBeGreaterThan(-1);
    // The guard must come immediately after main()'s closing brace.
    expect(guardAfterClosing - closingAfterBootstrap).toBeLessThan(20);
  });
});
