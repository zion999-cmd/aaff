// Evidence Store — file-based immutable storage for all acquired data.
// Organizes evidence as: data/evidence/{platform}/{year}/{month}/{date}_{type}.json
// Every write also writes a companion .meta.json with EvidenceMetadata.

import { resolve, dirname } from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EvidenceMetadataSchema, EvidenceRecordSchema } from './types.js';
import type { EvidenceMetadata, EvidenceRecord, EvidenceListOptions } from './types.js';
import { uuid } from '#shared/utils/crypto.js';
import { beijingHourBucketFromISO, nowIso } from '#shared/utils/time.js';
import type { Database as Db } from 'better-sqlite3';

const EVIDENCE_ROOT = resolve(process.cwd(), 'data', 'evidence');

/**
 * P0012: optional Database handle for evidence_observations history inserts.
 * Lazy-injected via setDb so existing callers (no Db) keep working.
 */
let _db: Db | undefined;
export const setEvidenceHistoryDb = (db: Db | undefined): void => {
  _db = db;
};

/** Map an evidence `dataType` to its parent capability. Trade.overview
 *  groups 3 dataTypes (summary/trend/productTop) under one capability. */
const capabilityForDataType = (dataType: string): string => {
  if (dataType === 'summary' || dataType === 'trend' || dataType === 'productTop') {
    return 'trade.overview';
  }
  return dataType;
};

/** Build the evidence file path for a given platform, date, and data type. */
const evidencePath = (
  platform: string,
  dateStr: string,
  dataType: string,
  suffix: string,
): string => {
  const d = new Date(dateStr);
  const year = d.getFullYear().toString();
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return resolve(EVIDENCE_ROOT, platform, year, month, `${day}_${dataType}${suffix}`);
};

/** Compute SHA-256 hash of a JSON-serializable payload. */
const hashPayload = (payload: unknown): string => {
  const json = JSON.stringify(payload);
  return createHash('sha256').update(json).digest('hex');
};

/**
 * Save raw evidence to the file system.
 * Returns the EvidenceRecord for the saved evidence.
 *
 * P0012: also appends an immutable row to `evidence_observations` so the
 * acquisition history is queryable independent of the (overwritable)
 * filesystem file. Best-effort: a missing/failed DB does NOT roll back
 * the filesystem write — Evidence persistence is the source of truth,
 * the history table is a derived projection.
 */
export const saveEvidence = async (
  platform: string,
  shopId: string,
  dateStr: string,
  dataType: string,
  payload: unknown,
  overrides: Partial<EvidenceMetadata> = {},
): Promise<EvidenceRecord> => {
  const evidenceId = uuid();
  const contentHash = hashPayload(payload);

  // Build metadata with P0006.3.2.1 provenance (acquisition_method + processing_method).
  // Backward compat: if old 'method' is passed in overrides, derive new fields from it.
  const baseMetadata: Record<string, unknown> = {
    source: platform,
    shop_id: shopId,
    data_type: dataType,
    // P0010.2.10: business_date is the calendar date the evidence
    // REPRESENTS (the JD 商智 business date), NOT the wall-clock time
    // of acquisition. Caller passes it as dateStr — the path already
    // encodes it, and the metadata now does too. This is the field
    // used for "today vs yesterday" comparison, "较昨日" window
    // calculation, and business-day grouping.
    business_date: dateStr,
    acquired_at: new Date().toISOString(),
    acquisition_method: 'unknown' as const,
    processing_method: 'none' as const,
    version: '1.0.0',
    operator: 'system',
    runtime: 'node',
    connector: platform,
    content_hash: contentHash,
    mime_type: 'application/json',
    tags: [],
  };

  // Merge overrides
  const merged = { ...baseMetadata, ...overrides };

  // If old 'method' was passed but no new provenance fields, derive them
  if (overrides.method && !overrides.acquisition_method) {
    const legacyMethod = overrides.method as string;
    if (legacyMethod === 'cdp' || legacyMethod === 'mock' || legacyMethod === 'import-agentcms') {
      merged.acquisition_method = legacyMethod;
    }
    if (legacyMethod === 'import-agentcms') {
      merged.processing_method = 'import';
    }
  }

  // Ensure backward-compat 'method' field is present
  if (!merged.method) {
    merged.method = merged.acquisition_method;
  }

  const metadata = EvidenceMetadataSchema.parse(merged);

  const dataPath = evidencePath(platform, dateStr, dataType, '.json');
  const metaPath = evidencePath(platform, dateStr, dataType, '.meta.json');

  // Ensure directory exists
  mkdirSync(dirname(dataPath), { recursive: true });

  // Write data and metadata
  writeFileSync(dataPath, JSON.stringify(payload, null, 2), 'utf-8');
  writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

  const fileSize = Buffer.byteLength(JSON.stringify(payload), 'utf-8');

  // P0012: append immutable history row (best-effort, no rollback on failure)
  if (_db) {
    const acquiredAt = metadata.acquired_at;
    try {
      _db.prepare(
        `INSERT OR IGNORE INTO evidence_observations (
           shop_id, capability, data_type, business_date,
           business_time_bucket, acquired_at, content_hash,
           evidence_file_path, content_size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        shopId,
        capabilityForDataType(dataType),
        dataType,
        metadata.business_date,
        beijingHourBucketFromISO(acquiredAt),
        acquiredAt,
        contentHash,
        dataPath,
        fileSize,
        nowIso(),
      );
    } catch {
      // best-effort: never fail the acquisition because the history append errored
    }
  }

  return EvidenceRecordSchema.parse({
    evidence_id: evidenceId,
    metadata,
    file_path: dataPath,
    file_size: fileSize,
  });
};

/**
 * Load an evidence record by reading its metadata file.
 * Returns null if the evidence does not exist.
 */
export const loadEvidence = (
  platform: string,
  dateStr: string,
  dataType: string,
): { record: EvidenceRecord; data: unknown } | null => {
  const dataPath = evidencePath(platform, dateStr, dataType, '.json');
  const metaPath = evidencePath(platform, dateStr, dataType, '.meta.json');

  if (!existsSync(dataPath) || !existsSync(metaPath)) return null;

  // P0010.2.10: business_date is the canonical "what day does this evidence
  // represent" field. For legacy .meta.json files written before the field
  // existed, derive it from the path (the path encodes business date).
  // This guarantees the field is always present, so callers can trust
  // metadata.business_date without a fallback check.
  const rawMeta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
  if (typeof rawMeta.business_date !== 'string' || rawMeta.business_date.length === 0) {
    rawMeta.business_date = dateStr;
  }
  const metadata = EvidenceMetadataSchema.parse(rawMeta);
  const data = JSON.parse(readFileSync(dataPath, 'utf-8'));

  const fileSize = Buffer.byteLength(JSON.stringify(data), 'utf-8');

  return {
    record: EvidenceRecordSchema.parse({
      evidence_id: uuid(), // regenerated on load — id is for runtime tracking, not persistence
      metadata,
      file_path: dataPath,
      file_size: fileSize,
    }),
    data,
  };
};

/**
 * List evidence records matching the given filters.
 * Walks the file system under data/evidence/.
 */
export const listEvidence = (options: Partial<EvidenceListOptions> = {}): EvidenceRecord[] => {
  const { source, shopId, dataType, fromDate, toDate, businessDate, limit = 100 } = options;
  const results: EvidenceRecord[] = [];

  if (!existsSync(EVIDENCE_ROOT)) return results;

  const platforms = source ? [source] : readdirSync(EVIDENCE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const platform of platforms) {
    const platformDir = resolve(EVIDENCE_ROOT, platform);
    if (!existsSync(platformDir)) continue;

    const years = readdirSync(platformDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const year of years) {
      const yearDir = resolve(platformDir, year);
      const months = readdirSync(yearDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const month of months) {
        const monthDir = resolve(yearDir, month);
        const files = readdirSync(monthDir, { withFileTypes: true })
          .filter((f) => f.isFile() && f.name.endsWith('.meta.json'))
          .map((f) => f.name);

        for (const metaFile of files) {
          if (results.length >= limit) break;

          const metaPath = resolve(monthDir, metaFile);
          try {
            // P0010.2.10: business_date is the canonical "what day does this
            // evidence represent" field. For legacy .meta.json files written
            // before the field existed, derive it from the path (the path
            // encodes business date as `${year}-${month}-${day}_${type}`).
            const rawMeta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
            const dateStr = `${year}-${month}-${metaFile.slice(0, 2)}`;
            if (typeof rawMeta.business_date !== 'string' || rawMeta.business_date.length === 0) {
              rawMeta.business_date = dateStr;
            }
            const metadata = EvidenceMetadataSchema.parse(rawMeta);

            // Apply filters
            if (shopId && metadata.shop_id !== shopId) continue;
            if (dataType && metadata.data_type !== dataType) continue;
            if (fromDate && metadata.business_date < fromDate) continue;
            if (toDate && metadata.business_date > toDate) continue;
            if (businessDate && metadata.business_date !== businessDate) continue;

            results.push(
              EvidenceRecordSchema.parse({
                evidence_id: uuid(),
                metadata,
                file_path: resolve(monthDir, metaFile.replace('.meta.json', '.json')),
                file_size: 0, // not computed for listings
              }),
            );
          } catch {
            // Skip invalid metadata files
          }
        }
      }
    }
  }

  return results;
};

/** Get the absolute root path of the evidence store. */
export const evidenceRoot = (): string => EVIDENCE_ROOT;
