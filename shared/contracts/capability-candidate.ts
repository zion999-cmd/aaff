// P0013.1 — Capability Candidate Contract (Capability Persistence).
//
// A Candidate says: "a method exists that worked for real and is worth
// reusing." It does NOT say "this is now a formal Fabric Capability."
// Candidates are always status 'pending_review'; promotion to a verified
// binding is a separate human / architecture decision (proposal §6-7,
// SC9). Resolution never executes candidates automatically.

import { z } from 'zod';

export const CAPABILITY_CANDIDATE_STATUS = ['pending_review'] as const;

export const CapabilityCandidateSchema = z.object({
  id: z
    .string()
    .regex(/^hcand_[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/, 'must be hcand_YYYYMMDD_HHMMSS_xxxxxx'),
  satisfies: z.object({
    need_category: z.literal('historical_evidence'),
    source: z.literal('jd'),
    domains: z.array(z.string()).min(1),
  }),
  binding: z.object({
    source: z.literal('jd'),
    system_identity: z.string().min(1),
  }),
  input_contract: z.record(z.string(), z.unknown()),
  output_contract: z.record(z.string(), z.unknown()),
  method: z.string().min(1),
  implementation_assets: z
    .array(
      z
        .object({
          kind: z.enum(['tool', 'skill', 'script', 'mcp', 'code', 'workflow', 'other']),
          name: z.string().min(1),
          path: z.string().optional(),
          description: z.string().optional(),
        })
        .passthrough(),
    )
    .min(1),
  dependencies: z.object({
    authentication: z.string().min(1),
    browser_session: z.string().min(1),
    environment: z.array(z.string()),
  }),
  verified_against: z.object({
    acquisition_job_id: z.string().min(1),
    evidence_files: z.array(z.string()).min(1),
    verification_notes: z.string().min(1),
  }),
  limitations: z.array(z.string()),
  provenance: z.object({
    created_by: z.string().min(1),
    created_at: z.string().min(1),
    trajectory_path: z.string().min(1),
  }),
  status: z.enum(CAPABILITY_CANDIDATE_STATUS),
});

export type CapabilityCandidate = z.infer<typeof CapabilityCandidateSchema>;
