// P0013.1 — Historical Evidence Result Contract (Evidence Contract).
//
// What a historical acquisition must hand back. "Some JSON arrived" is
// not completion. requested_window is the NEED; actual_window is a WORLD
// FACT computed by Fabric at freeze time from the delivered files — the
// agent's self-reported actual window is a declaration only and Fabric
// re-derives it (S0002 §10-11: never relabel source time).
//
// All artifact paths are relative to the job intake directory.

import { z } from 'zod';

const YMD: RegExp = /^\d{4}-\d{2}-\d{2}$/;
const ymd = z.string().regex(YMD, 'must be YYYY-MM-DD');

/** Per-domain outcome. unavailable = the source structurally could not give it. */
export const DomainAcquisitionStatus = z.enum(['complete', 'partial', 'unavailable']);
export type DomainAcquisitionStatusValue = z.infer<typeof DomainAcquisitionStatus>;

const domainResult = z.object({
  status: DomainAcquisitionStatus,
  notes: z.string().optional(),
});

export const HistoricalEvidenceResultSchema = z
  .object({
    requested_window: z.object({ start: ymd, end: ymd }),
    // Nullable bounds: allowed when a domain returned nothing at all.
    actual_window: z.object({
      start: ymd.nullable(),
      end: ymd.nullable(),
      missing_dates: z.array(ymd),
    }),
    domains: z.object({
      trade: domainResult,
      orders: domainResult,
    }),
    /** Explicit uncovered / unavailable facts. Empty array = no known gaps. */
    gaps: z.array(
      z
        .object({
          range: z.object({ start: ymd, end: ymd }).optional(),
          date: ymd.optional(),
          domain: z.string(),
          reason: z.string().min(1),
        })
        .passthrough(),
    ),
    artifacts: z.object({
      summary: z.string().min(1),
      trend: z.string().min(1),
      order_summary: z.string().min(1),
      order_rows: z.string().min(1),
      raw: z.array(z.string()),
    }),
    provenance: z.object({
      source_system: z.string().min(1),
      source_surfaces: z.array(z.string()),
      acquisition_method: z.string().min(1),
      acquired_at: z.string().min(1),
    }),
    reconciliation: z
      .object({
        orders_gmv: z.number(),
        trade_gmv: z.number(),
        delta: z.number(),
        matches: z.boolean(),
      })
      .optional(),
    stop_reason: z.enum(['verified_real_data', 'partial', 'no_path', 'blocked']),
    /**
     * SC4/SC10 evidence: the executing agent MUST inventory what it
     * reused / rediscovered / newly built. Fabric records it verbatim;
     * the experiment report cross-checks it against the trajectory.
     */
    reuse_report: z
      .object({
        reused: z.array(z.string()),
        rediscovered: z.array(z.string()),
        newly_built: z.array(z.string()),
      })
      .optional(),
  })
  .passthrough();

export type HistoricalEvidenceResult = z.infer<typeof HistoricalEvidenceResultSchema>;
