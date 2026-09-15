// P0013.1 — Capability Candidate persistence.
//
// Candidates are review artifacts, not a registry of executable
// capabilities: files under data/capability-candidates/, always
// 'pending_review', immutable once written. Capability Resolution does
// NOT execute them (proposal §6-7, SC9).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CapabilityCandidateSchema,
  type CapabilityCandidate,
} from '#shared/contracts/capability-candidate.js';

const CANDIDATE_DIR = 'capability-candidates';

export class CandidateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateStoreError';
  }
}

const candidatesRoot = (dataRoot: string): string => join(dataRoot, CANDIDATE_DIR);

/** Validate and persist a candidate. Throws if its id file already exists. */
export const persistCandidate = (dataRoot: string, candidate: CapabilityCandidate): string => {
  const parsed = CapabilityCandidateSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CandidateStoreError(`candidate fails contract: ${parsed.error.message}`);
  }
  const dir = candidatesRoot(dataRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${parsed.data.id}.json`);
  if (existsSync(path)) {
    // Idempotent re-finalize: identical content is allowed (a salvage may
    // retry after a later gate failure). Different content under the same
    // id remains forbidden (immutability of the historical record).
    let existing: unknown = null;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // malformed existing file → real conflict
    }
    if (existing && JSON.stringify(existing) === JSON.stringify(parsed.data)) {
      return path;
    }
    throw new CandidateStoreError(`candidate already exists (immutable): ${parsed.data.id}`);
  }
  writeFileSync(path, JSON.stringify(parsed.data, null, 2), 'utf8');
  return path;
};

/** Read all candidates; malformed files are reported, never silently dropped. */
export const listCandidates = (
  dataRoot: string,
): { candidates: CapabilityCandidate[]; skipped: Array<{ file: string; reason: string }> } => {
  const dir = candidatesRoot(dataRoot);
  if (!existsSync(dir)) return { candidates: [], skipped: [] };
  const candidates: CapabilityCandidate[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = CapabilityCandidateSchema.safeParse(
      JSON.parse(readFileSync(join(dir, name), 'utf8')),
    );
    if (parsed.success) candidates.push(parsed.data);
    else skipped.push({ file: name, reason: parsed.error.message });
  }
  return { candidates, skipped };
};
