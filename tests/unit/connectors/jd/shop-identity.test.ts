// Unit tests for canonical shop-identity normalization.
//
// P0010 — the Investigation agent historically learned the real JD provider
// shop id (11855009) from Hermes skill examples and re-acquired evidence with
// `shopId=11855009`, splitting evidence from the canonical Fabric key
// `jd_shop_001` and making it invisible to the producer. normalizeFabricShopId
// maps provider internal ids → canonical at the execution boundary so Evidence
// is always written under the canonical key.

import { describe, expect, test } from 'vitest';
import {
  FABRIC_CANONICAL_SHOP_KEY,
  DEFAULT_JD_PROVIDER_SHOP_ID,
  normalizeFabricShopId,
} from '#app/connectors/jd/shop-identity.js';

describe('normalizeFabricShopId', () => {
  test('keeps the canonical key unchanged', () => {
    // Act
    const result = normalizeFabricShopId(FABRIC_CANONICAL_SHOP_KEY);

    // Assert
    expect(result).toBe(FABRIC_CANONICAL_SHOP_KEY);
  });

  test('maps the provider internal shop id to the canonical key', () => {
    // Arrange — the JD provider number is what the Investigation agent
    // historically picked up from skill examples.
    const providerShopId = DEFAULT_JD_PROVIDER_SHOP_ID;

    // Act
    const result = normalizeFabricShopId(providerShopId);

    // Assert — evidence must land under the canonical key the producer reads.
    expect(result).toBe(FABRIC_CANONICAL_SHOP_KEY);
  });

  test('throws on a shopId that is neither canonical nor the provider id', () => {
    // Arrange — an unknown key must fail fast instead of silently writing
    // evidence under a key nothing can read.
    const input = 'jd_shop_002';

    // Act / Assert
    expect(() => normalizeFabricShopId(input)).toThrow(/Unknown shopId/);
    expect(() => normalizeFabricShopId(input)).toThrow(/jd_shop_001/);
  });

  test('throws on an empty shopId', () => {
    // Act / Assert
    expect(() => normalizeFabricShopId('')).toThrow(/Unknown shopId/);
  });
});
