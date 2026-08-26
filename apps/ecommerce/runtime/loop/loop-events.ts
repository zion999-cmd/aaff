// P0010.2 — Loop event tagged-union. Single source of truth for what the
// RuntimeLoop emits (logs + the onEvent callback). Tagged so consumers can
// narrow with `kind`.

import type { Database as Db } from 'better-sqlite3';

export type LoopEvent =
  | { kind: 'tick_started'; capability: string; date: string }
  | { kind: 'acquisition_started'; capability: string }
  | { kind: 'acquisition_succeeded'; capability: string; evidenceCount: number }
  | { kind: 'acquisition_failed'; capability: string; error: string }
  | { kind: 'situations_updated'; created: number; skipped: number; createdIds: string[] }
  | {
      kind: 'investigation_triggered';
      situationId: string;
      reason:
        | 'new_situation'
        | 'meaningful_new_evidence'
        | 'recovery_no_investigation'
        | 'recovery_interrupted'
        | 'recovery_failed_retryable';
    }
  | { kind: 'investigation_skipped'; situationId: string; reason: SkipReason }
  | { kind: 'investigation_completed'; situationId: string }
  | { kind: 'investigation_failed'; situationId: string; error: string }
  /**
   * P0010.2.2 — emitted when the Loop's recovery scan finds pre-existing
   * situations that need Agent attention (no_investigation /
   * failed_retryable / interrupted). Distinct from `situations_updated`
   * which is reserved for the producer's current-tick output — recovery
   * is about catching up to a prior process run, not the world moving
   * forward. The `kinds` array lets operators see at a glance whether
   * the backlog is mostly "never investigated" vs "Hermes was down".
   */
  | {
      kind: 'recovery_candidates_found';
      count: number;
      kinds: Array<'no_investigation' | 'failed_retryable' | 'interrupted'>;
    }
  /**
   * P0010.2.2 — emitted when InvestigationPolicy returns
   * `blocked_runtime_failure`. The operator must explicitly
   * POST /api/situation/:id/clear-block to resume. Distinct from
   * `investigation_skipped` because blocked = operator attention required,
   * not a normal "no change" case. The Loop also stamps the
   * `consecutiveFailures` count so the operator can see how close the
   * situation was to unblocking itself before the threshold tripped.
   */
  | {
      kind: 'investigation_blocked';
      situationId: string;
      consecutiveFailures: number;
    }
  | { kind: 'output_created'; situationId: string; outputId: string }
  | { kind: 'tick_done'; capabilities: number; situations: number; investigations: number; outputs: number }
  | { kind: 'loop_started'; capabilities: string[]; tickMs: number }
  | { kind: 'loop_stopped' };

export type SkipReason =
  | 'no_evidence'
  | 'no_meaningful_change'
  | 'waiting_human'
  | 'already_investigated'
  | 'no_situation'
  | 'blocked_runtime_failure';

/**
 * Create a tagged event logger. The Loop uses one of these for the
 * `[loop]` console-log tag; tests inject a fake `onEvent` to assert on the
 * event stream without touching stdout.
 */
export const createLoopLogger = (sink: (event: LoopEvent) => void) => {
  return {
    emit(event: LoopEvent): void {
      sink(event);
    },
  };
};

/** Default sink: write to stdout with the `[loop]` tag. The Loop keeps a
 *  test seam by letting the caller pass any sink (production defaults to
 *  this). */
export const stdoutSink = (event: LoopEvent): void => {
  // The Loop is the only operator of this logger, so the eslint-disable
  // comment lives at the call site, not here. This helper is pure
  // formatting.
  // eslint-disable-next-line no-console
  console.log(formatLoopEvent(event));
};

const formatLoopEvent = (e: LoopEvent): string => {
  switch (e.kind) {
    case 'tick_started':
      return `[loop] tick capability=${e.capability} date=${e.date}`;
    case 'acquisition_started':
      return `[loop] acquisition started capability=${e.capability}`;
    case 'acquisition_succeeded':
      return `[loop] evidence updated capability=${e.capability} count=${e.evidenceCount}`;
    case 'acquisition_failed':
      return `[loop] acquisition failed capability=${e.capability} error=${e.error}`;
    case 'situations_updated':
      return `[loop] situation updated created=${e.created} skipped=${e.skipped}`;
    case 'investigation_triggered':
      return `[loop] investigation triggered situation=${e.situationId} reason=${e.reason}`;
    case 'investigation_skipped':
      return `[loop] investigation skipped situation=${e.situationId} reason=${e.reason}`;
    case 'investigation_completed':
      return `[loop] investigation completed situation=${e.situationId}`;
    case 'investigation_failed':
      return `[loop] investigation failed situation=${e.situationId} error=${e.error}`;
    case 'recovery_candidates_found':
      return `[loop] recovery eligible count=${e.count} kinds=${e.kinds.join(',')}`;
    case 'investigation_blocked':
      return `[loop] investigation BLOCKED situation=${e.situationId} consecutiveFailures=${e.consecutiveFailures} — operator must POST /api/situation/:id/clear-block to resume`;
    case 'output_created':
      return `[loop] output created ${e.outputId} for situation=${e.situationId}`;
    case 'tick_done':
      return `[loop] tick done capabilities=${e.capabilities} situations=${e.situations} investigations=${e.investigations} outputs=${e.outputs}`;
    case 'loop_started':
      return `[loop] loop started capabilities=${e.capabilities.join(',')} tickMs=${e.tickMs}`;
    case 'loop_stopped':
      return `[loop] loop stopped`;
  }
};

// Re-export for tests that want to seed a Learning Context without a real db.
export type { Db };
