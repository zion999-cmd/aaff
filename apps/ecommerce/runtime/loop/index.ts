// P0010.2 — Runtime Loop barrel.

export { createRuntimeLoop } from './runtime-loop.js';
export type { RuntimeLoop, RuntimeLoopOptions, LoopTickSummary, LoopState } from './runtime-loop.js';
export { createInvestigationPolicy, isWaitingOnHuman } from './investigation-policy.js';
export type { InvestigationPolicy, PolicyDecision, PolicyContext } from './investigation-policy.js';
export { materializeWorkItem } from './recommendation-to-output.js';
export type { MaterializeResult } from './recommendation-to-output.js';
export { createLoopLogger, stdoutSink } from './loop-events.js';
export type { LoopEvent, SkipReason } from './loop-events.js';
export { listRecoverableCandidates, countConsecutiveFailures, DEFAULT_MAX_CONSECUTIVE_FAILURES, DEFAULT_RECOVERY_STALE_AFTER_MS } from './recovery-candidates.js';
export type { RecoverableSituation, RecoveryOptions, RecoveryKind } from './recovery-candidates.js';
