// Canonical shop-identity normalization (P0010).
//
// Fabric speaks one canonical shop key per shop (`jd_shop_001`). The JD
// provider has its own internal shop number (`11855009`, blueprint.ts
// default). The Investigation agent historically picked the provider number
// up from skill examples and re-acquired Evidence with it, splitting Evidence
// away from the canonical key the producer reads. Every execution boundary
// normalizes the incoming shopId through this module so Evidence is always
// written under the canonical key; unknown ids fail fast.

/** Fabric canonical shop key — the only key Evidence is written under. */
export const FABRIC_CANONICAL_SHOP_KEY = 'jd_shop_001';

/** JD provider-internal shop number (blueprint default; real 商智 shop id). */
export const DEFAULT_JD_PROVIDER_SHOP_ID = '11855009';

/**
 * Map any accepted shop id to the canonical Fabric shop key.
 *
 * @param input The shopId a caller supplied (e.g. from the Investigation agent).
 * @returns the canonical Fabric shop key.
 * @throws when `input` is neither the canonical key nor a known provider id.
 */
export function normalizeFabricShopId(input: string): string {
  if (input === FABRIC_CANONICAL_SHOP_KEY) return input;
  if (input === DEFAULT_JD_PROVIDER_SHOP_ID) return FABRIC_CANONICAL_SHOP_KEY;
  throw new Error(
    `Unknown shopId '${input}'. Expected canonical '${FABRIC_CANONICAL_SHOP_KEY}' or provider shop id '${DEFAULT_JD_PROVIDER_SHOP_ID}'.`,
  );
}
