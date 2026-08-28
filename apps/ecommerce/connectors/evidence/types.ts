// Evidence Store types — the immutable record of every data acquisition.
// Every piece of business data traces back to an Evidence Record.
// Evidence is the foundation of Review, Audit, Replay, and Training.

import { z } from 'zod';

// ---- Evidence Metadata ----

export const EvidenceMetadataSchema = z.object({
  /** Platform source (jd, tmall, etc.) */
  source: z.string().min(1),
  /** Shop identifier */
  shop_id: z.string().min(1),
  /** Data type captured (summary, trend, productTop, screenshot, dom) */
  data_type: z.string().min(1),
  /**
   * P0010.2.10 — Business observation date (YYYY-MM-DD), the date the
   * evidence represents (NOT when it was acquired). This is the date used
   * for "today vs yesterday" comparison, "较昨日" window calculation, and
   * business-day grouping. Distinct from `acquired_at` which is the
   * wall-clock time of the acquisition and may be on a different calendar
   * day (e.g. 23:55 acquisition of yesterday's daily_summary).
   */
  business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** ISO timestamp of original acquisition */
  acquired_at: z.string().min(1),
  /**
   * How the data was originally acquired. Immutable once set.
   *   cdp             — live Chrome CDP interception
   *   mock            — synthetic data from mockJdPayload
   *   import-agentcms — bulk import from agentCMS JSON export
   *   unknown         — provenance not recorded (legacy)
   */
  acquisition_method: z.enum(['cdp', 'mock', 'import-agentcms', 'unknown']).default('unknown'),
  /**
   * How the data was most recently processed. Updated on each pipeline pass.
   *   runtime — single-day kernel.execute() pipeline
   *   replay  — multi-day runReplay() pipeline
   *   import  — executeImportPipeline()
   *   none    — raw acquisition, not yet processed
   */
  processing_method: z.enum(['runtime', 'replay', 'import', 'none']).default('none'),
  /** ISO timestamp of last processing pass */
  processed_at: z.string().optional(),
  /**
   * @deprecated Use acquisition_method + processing_method instead.
   * Kept for backward compatibility with existing evidence files.
   */
  method: z.string().optional(),
  /** Connector version */
  version: z.string().default('1.0.0'),
  /** Who initiated the acquisition (user, cron, system) */
  operator: z.string().default('system'),
  /** Runtime used for acquisition (playwright, curl, etc.) */
  runtime: z.string().default('playwright'),
  /** Connector name */
  connector: z.string().min(1),
  /** SHA-256 hash of the raw payload (tamper detection) */
  content_hash: z.string().min(1),
  /** MIME type of the raw payload */
  mime_type: z.string().default('application/json'),
  /** Optional tags for categorization */
  tags: z.array(z.string()).default([]),
});
export type EvidenceMetadata = z.infer<typeof EvidenceMetadataSchema>;

// ---- Evidence Record ----

export const EvidenceRecordSchema = z.object({
  /** Unique evidence ID (UUID) */
  evidence_id: z.string().min(1),
  /** Metadata about this evidence */
  metadata: EvidenceMetadataSchema,
  /** Relative file path from project root */
  file_path: z.string().min(1),
  /** File size in bytes */
  file_size: z.number().nonnegative(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

// ---- Evidence Listing ----

export const EvidenceListOptionsSchema = z.object({
  source: z.string().optional(),
  shopId: z.string().optional(),
  dataType: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  /** P0010.2.10 — Filter by business_date. */
  businessDate: z.string().optional(),
  limit: z.number().positive().default(100),
});
export type EvidenceListOptions = z.infer<typeof EvidenceListOptionsSchema>;
