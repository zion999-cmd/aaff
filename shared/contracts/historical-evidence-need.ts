// P0013.1 — Historical Evidence Need Contract.
//
// A Need expresses a WORLD FACT requirement in business terms only.
// It MUST NOT name endpoints, tokens, scripts, MCP tools, CDP mechanics,
// or pagination strategies — those belong to Binding/implementation
// (proposal §1). Fabric decides what is needed; the executing agent
// decides how to obtain it from an unknown world.

import { z } from 'zod';

const YMD: RegExp = /^\d{4}-\d{2}-\d{2}$/;
const ymd = z.string().regex(YMD, 'must be YYYY-MM-DD');

export const HISTORICAL_EVIDENCE_DOMAINS = ['trade', 'orders'] as const;
export type HistoricalEvidenceDomain = (typeof HISTORICAL_EVIDENCE_DOMAINS)[number];

export const HistoricalWindowSchema = z
  .object({
    start: ymd,
    end: ymd,
  })
  .superRefine((w, ctx) => {
    if (w.start > w.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `window.start (${w.start}) must be <= window.end (${w.end})`,
        path: ['start'],
      });
    }
  });

export const HistoricalEvidenceNeedSchema = z
  .object({
    subject: z.object({
      shopId: z.string().min(1),
      shopName: z.string().min(1),
    }),
    source: z.literal('jd'),
    purpose: z.literal('historical_replay'),
    window: HistoricalWindowSchema,
    domains: z.array(z.enum(HISTORICAL_EVIDENCE_DOMAINS)).min(1),
  })
  .strict();

export type HistoricalEvidenceNeed = z.infer<typeof HistoricalEvidenceNeedSchema>;
export type HistoricalWindow = z.infer<typeof HistoricalWindowSchema>;
