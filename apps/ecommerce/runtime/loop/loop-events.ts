// P0010.2 — Loop event tagged-union. Single source of truth for what the
// RuntimeLoop emits (logs + the onEvent callback). Tagged so consumers can
// narrow with `kind`.
//
// P0010.2 closure Slice 2 — `stdoutSink` ALSO pushes a runtime-agnostic
// TraceEvent into the in-memory ring buffer (see `./trace-ring-buffer.ts`).
// The mapping `mapLoopEventToTraceEvent` translates each LoopEvent into the
// TraceEvent shape that the right-pane UI consumes. Sub-second noise
// (per-capability acquisition ticks) returns `null` from the mapper and
// is dropped at the buffer boundary; everything the operator actually
// acts on is preserved.

import type { Database as Db } from 'better-sqlite3';
import {
  traceBuffer,
  makeTraceEvent,
  type TraceEvent,
  type TraceSource,
} from './trace-ring-buffer.js';

export type LoopEvent =
  | { kind: 'tick_started'; capability: string; date: string }
  | { kind: 'acquisition_started'; capability: string }
  | { kind: 'acquisition_succeeded'; capability: string; evidenceCount: number }
  | { kind: 'acquisition_failed'; capability: string; error: string }
  /**
   * P0010.2.11 C1.7 — the autonomous per-day guard satisfied this tick
   * without executing acquisition. Emitted INSTEAD OF
   * `acquisition_succeeded` (skip ≠ success — the evidence store was not
   * touched, no JD page was visited). `reason` states why; currently the
   * only producer is the same-capability+business_date guard in
   * runtime-loop.ts runCapability.
   */
  | { kind: 'acquisition_skipped'; capability: string; date: string; reason: string }
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
  | {
      kind: 'investigation_completed';
      situationId: string;
      /**
       * P0010.2 — vocabulary drift the parser normalized at the raw
       * boundary. Empty when the Agent honored the canonical vocabulary.
       */
      drift?: Array<{ field: string; original: string; canonical: string }>;
    }
  | {
      kind: 'investigation_failed';
      situationId: string;
      error: string;
      /**
       * P0010.2 — structured failure reason. See
       * platform/server/routes/situation-chat.ts:InvestigationFailureReason
       * for the full taxonomy. The Workspace renders this with a specific
       * actionable message instead of a generic "Runtime 调查失败".
       */
      failureReason?:
        | 'agent_transport_failed'
        | 'agent_timeout'
        | 'provider_failed'
        | 'contract_invalid';
      /**
       * P0010.2 — vocabulary drift the parser normalized at the raw
       * boundary. Empty when the Agent honored the canonical vocabulary.
       */
      drift?: Array<{ field: string; original: string; canonical: string }>;
      /**
       * P0010.2 — vocabulary drift the parser REFUSED (not on the
       * allow-list). Present only when `failureReason === 'contract_invalid'`.
       */
      unmappable?: Array<{ field: string; original: string }>;
    }
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
  | 'blocked_runtime_failure'
  /**
   * P0010.2.x followup — Global `latestContentHash` changed but we
   * cannot prove this Situation's underlying metric moved (no
   * per-Situation evidence-dependency model yet). Skip rather than
   * re-fire on unrelated platform evidence churn.
   */
  | 'no_situation_specific_evidence_change';

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

// ---- Slice 2: LoopEvent -> TraceEvent mapping -------------------------

/**
 * Runtime-agnostic mapping from a LoopEvent to a TraceEvent. The kind
 * field of the TraceEvent is prefixed with `runtime.` so the UI can
 * distinguish Runtime-loop events from Agent events without knowing
 * anything about the Hermes wire format. When the Runtime is replaced,
 * the same shape stays valid (the producer in `runtime-loop.ts` still
 * emits LoopEvents; only the Agent-side producer changes).
 *
 * Returns `null` for events the operator does not need to see in the
 * right pane (e.g. `tick_started` / `acquisition_started` are
 * sub-second noise; `loop_started` / `loop_stopped` are process-level
 * signals that are better surfaced as the panel header, not per-event
 * rows). The buffer's 200-event capacity is reserved for what the
 * operator actually acts on.
 */
const mapLoopEventToTraceEvent = (e: LoopEvent): TraceEvent | null => {
  const source: TraceSource = 'runtime-loop';
  switch (e.kind) {
    case 'investigation_triggered':
      return makeTraceEvent({
        source,
        kind: 'runtime.scheduled',
        situationId: e.situationId,
        summary: `Runtime 已安排 Agent 调查（触发原因：${triggerReasonLabel(e.reason)}）`,
        detail: { reason: e.reason },
      });
    case 'investigation_skipped':
      return makeTraceEvent({
        source,
        kind: e.reason === 'blocked_runtime_failure' ? 'runtime.blocked' : 'runtime.skipped',
        situationId: e.situationId,
        summary: skipReasonLabel(e.reason, e.situationId),
        detail: { reason: e.reason },
      });
    case 'investigation_failed':
      return makeTraceEvent({
        source,
        kind: 'runtime.skipped',
        situationId: e.situationId,
        summary: `Runtime 调查失败：${e.error}`,
        detail: { reason: 'investigation_failed', error: e.error },
      });
    case 'investigation_completed':
      return makeTraceEvent({
        source,
        kind: 'runtime.completed',
        situationId: e.situationId,
        summary: 'Runtime 调查完成，已形成当前判断',
      });
    case 'investigation_blocked':
      return makeTraceEvent({
        source,
        kind: 'runtime.blocked',
        situationId: e.situationId,
        summary: `Runtime 已暂停调查（连续失败 ${e.consecutiveFailures} 次），需运营点击「解除阻塞」`,
        detail: { consecutiveFailures: e.consecutiveFailures },
      });
    case 'recovery_candidates_found':
      return makeTraceEvent({
        source,
        kind: 'runtime.recovery_attempt',
        summary: `Runtime 恢复扫描发现 ${e.count} 个待补调查的 Situation（${e.kinds.join('、')}）`,
        detail: { count: e.count, kinds: e.kinds },
      });
    case 'output_created':
      return makeTraceEvent({
        source,
        kind: 'runtime.completed',
        situationId: e.situationId,
        summary: `Runtime 已生成工作输出（${e.outputId}）`,
        detail: { outputId: e.outputId },
      });
    case 'tick_done':
      return makeTraceEvent({
        source,
        kind: 'runtime.completed',
        summary: `Runtime tick 完成：capabilities=${e.capabilities} situations=${e.situations} investigations=${e.investigations}`,
        detail: {
          capabilities: e.capabilities,
          situations: e.situations,
          investigations: e.investigations,
          outputs: e.outputs,
        },
      });
    case 'loop_started':
    case 'loop_stopped':
      return makeTraceEvent({
        source: 'system',
        kind: e.kind === 'loop_started' ? 'runtime.completed' : 'runtime.skipped',
        summary:
          e.kind === 'loop_started'
            ? `Runtime loop 已启动（capabilities=${e.capabilities.join(',')}）`
            : 'Runtime loop 已停止',
        detail: e.kind === 'loop_started' ? { capabilities: e.capabilities, tickMs: e.tickMs } : undefined,
      });
    case 'tick_started':
    case 'acquisition_started':
    case 'acquisition_succeeded':
    case 'acquisition_failed':
    case 'acquisition_skipped':
    case 'situations_updated':
      return null;
  }
};

const triggerReasonLabel = (
  r: 'new_situation' | 'meaningful_new_evidence' | 'recovery_no_investigation' | 'recovery_interrupted' | 'recovery_failed_retryable',
): string => {
  switch (r) {
    case 'new_situation': return '新发现 Situation';
    case 'meaningful_new_evidence': return '新证据';
    case 'recovery_no_investigation': return '补调查（从未调查）';
    case 'recovery_interrupted': return '补调查（上次中断）';
    case 'recovery_failed_retryable': return '补调查（上次失败可重试）';
  }
};

const skipReasonLabel = (r: SkipReason, situationId: string): string => {
  switch (r) {
    case 'no_evidence': return `Runtime 暂未安排（尚无新证据） — ${situationId}`;
    case 'no_meaningful_change': return `Runtime 暂未安排（证据无变化） — ${situationId}`;
    case 'waiting_human': return `Runtime 暂未安排（等待运营反馈） — ${situationId}`;
    case 'already_investigated': return `Runtime 暂未安排（已完成） — ${situationId}`;
    case 'no_situation': return `Runtime 暂未安排（Situation 不存在） — ${situationId}`;
    case 'blocked_runtime_failure': return `Runtime 已暂停调查（连续失败达到阈值） — ${situationId}`;
    case 'no_situation_specific_evidence_change': return `Runtime 暂未安排（其他 evidence 哈希变化，与本 Situation 无关） — ${situationId}`;
  }
};

/** Default sink: write to stdout with the `[loop]` tag AND push a derived
 *  TraceEvent into the in-memory ring buffer. The Loop keeps a test seam
 *  by letting the caller pass any sink (production defaults to this). */
export const stdoutSink = (event: LoopEvent): void => {
  // The Loop is the only operator of this logger, so the eslint-disable
  // comment lives at the call site, not here. This helper is pure
  // formatting.
  // eslint-disable-next-line no-console
  console.log(formatLoopEvent(event));
  // Slice 2: also push the runtime-agnostic trace event. We push
  // BEFORE returning so test sinks that capture TraceEvents see them
  // in the same tick as the LoopEvent they derive from. The map
  // returns `null` for sub-second noise (acquisition ticks) — those
  // still log to stdout but do not pollute the buffer.
  const trace = mapLoopEventToTraceEvent(event);
  if (trace) traceBuffer.push(trace);
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
    case 'acquisition_skipped':
      return `[loop] acquisition skipped capability=${e.capability} date=${e.date} reason=${e.reason}`;
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

// Internal export so the route wiring in situation-chat.ts can reuse
// `triggerReasonLabel` for the /api/situation/:id/investigate path's
// "manual" events (so the UI sees the same wording whether the
// investigation was scheduled by the Loop or by the operator).
export { triggerReasonLabel, skipReasonLabel };
