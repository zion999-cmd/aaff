// JD 商智 Blueprint Loader
// Reads the Navigation Blueprint (sources/jd_smart/blueprint.yaml) that was
// hand-crafted during JD exploration. The blueprint maps every JD 商智 page,
// its URL, and whether it contains business data.
//
// This is NOT the Connector Blueprint (generated/ from D0002).
// This is the Navigation Blueprint — the map of the platform's pages.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_JD_PROVIDER_SHOP_ID } from './shop-identity.js';

// ---- Types ----

export interface JdPage {
  id: string;
  name: string;
  url: string;
  fullUrl: string;
  has_data: boolean;
  note?: string;
}

export interface JdBlueprint {
  platform: string;
  name: string;
  base_url: string;
  shop_id: string;
  shop_name: string;
  pages: JdPage[];
}

// ---- Loader ----

let _cachedBlueprint: JdBlueprint | null = null;

/**
 * Load the JD Navigation Blueprint from sources/jd_smart/blueprint.yaml.
 * Simple YAML parsing (no js-yaml dependency — the blueprint structure is stable).
 */
export const loadJdBlueprint = (): JdBlueprint => {
  if (_cachedBlueprint) return _cachedBlueprint;

  const yamlPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../sources/jd_smart/blueprint.yaml',
  );

  if (!existsSync(yamlPath)) {
    throw new Error(`JD Blueprint not found at ${yamlPath}`);
  }

  const yaml = readFileSync(yamlPath, 'utf-8');
  const bp = parseBlueprintYaml(yaml);

  _cachedBlueprint = bp;
  return bp;
};

/** Pages that have business data and should be visited. */
export const getDataPages = (): JdPage[] => {
  return loadJdBlueprint().pages.filter((p) => p.has_data);
};

/** Flush cached blueprint (testing). */
export const resetBlueprintCache = (): void => {
  _cachedBlueprint = null;
};

// ---- Minimal YAML Parser for blueprint structure ----

const parseBlueprintYaml = (yaml: string): JdBlueprint => {
  const lines = yaml.split('\n');

  const getValue = (key: string): string => {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}:`)) {
        return trimmed.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
      }
    }
    return '';
  };

  // Extract pages from top_level_menus
  const pages: JdPage[] = [];
  let inMenus = false;
  let currentPage: Partial<JdPage> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'top_level_menus:') {
      inMenus = true;
      continue;
    }

    if (inMenus) {
      if (trimmed === 'sub_menus:') break; // stop at sub_menus

      if (trimmed.startsWith('- id:')) {
        // Save previous page
        if (currentPage.id) {
          pages.push(currentPage as JdPage);
        }
        currentPage = { id: trimmed.slice(5).trim() };
      } else if (trimmed.startsWith('name:') && currentPage.id) {
        currentPage.name = trimmed.slice(5).trim();
      } else if (trimmed.startsWith('url:') && currentPage.id) {
        const relPath = trimmed.slice(4).trim();
        currentPage.url = `https://jdsz.jd.com${relPath}`;
        currentPage.fullUrl = currentPage.url;
      } else if (trimmed.startsWith('has_data:') && currentPage.id) {
        currentPage.has_data = trimmed.includes('true');
      } else if (trimmed.startsWith('note:') && currentPage.id) {
        currentPage.note = trimmed.slice(5).trim();
      }
    }
  }

  // Save last page
  if (currentPage.id) {
    pages.push(currentPage as JdPage);
  }

  return {
    platform: 'jd',
    name: getValue('name') || '京东商智',
    base_url: getValue('base_url') || 'https://jdsz.jd.com',
    // Provider-internal shop id (JD real shop number), NOT the Fabric canonical
    // key ('jd_shop_001'). Execution boundaries normalize it via
    // normalizeFabricShopId so Evidence is always written under the canonical
    // key (see apps/ecommerce/connectors/jd/shop-identity.ts).
    shop_id: getValue('shop_id') || DEFAULT_JD_PROVIDER_SHOP_ID,
    shop_name: getValue('name') || '祁门红茶旗舰店',
    pages,
  };
};
