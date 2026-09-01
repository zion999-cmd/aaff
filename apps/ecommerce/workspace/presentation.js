// P0010.1 Productization Baseline — presentation-layer pure helpers.
//
// This module is the *single source of truth* for the human-side
// presentation contract helpers. It has zero DOM / window / state
// dependencies so it can be:
//   - loaded by the browser (app.js does `import` from here)
//   - unit-tested by vitest (tests/contract/investigation.contract.ts)
//
// Every helper in this file is a pure function over plain JS objects.
// App.js is the caller that wires these helpers to the live DOM and
// to `state.panelMode`. Tests use them directly.

import { formatLocalTime as formatLocalTimeTz, formatUtcTime, formatBusinessDate, formatProxyTime, formatRelative } from './time-format.js';

/**
 * baseline §3: "What happened" — Business Situation, not ranking-engine event.
 *
 * Pure: input is the persisted Situation + Investigation, output is a single
 * Chinese sentence an operator can read in 3 seconds. NO LLM call. We map the
 * (type, stopReason) tuple to a fixed business-language template and inject
 * the headline number from the original description (e.g. "-67.9%").
 *
 * Unknown tuples fall back to the original description with a small prefix
 * so the operator is never shown a silently-broken page.
 */
export function businessDescribeSituation(situation, investigation) {
  var type = (situation && situation.type) || '';
  var stopReason = (investigation && investigation.stopReason) || '';
  var desc = (situation && situation.description) || '';
  var pctMatch = desc.match(/[-+]?\d+(?:\.\d+)?\s*%/);
  var pct = pctMatch ? pctMatch[0] : '';
  var down = /(下降|下滑|降低|回落|减少)/.test(desc);
  var hasPrior = !!(investigation && (investigation.judgment || investigation.currentUnderstanding));
  var dirSuffix = pct ? '（' + pct + '）' : '';
  // (type, stopReason) -> 业务话术。
  // 没有 stopReason 意味着 Agent 还没给出结论：告诉运营"待整理"。
  if (type === 'ranking_attention' && stopReason === 'observe') {
    return '这个商品近期表现值得关注。系统发现其近期经营表现相对突出，因此进入 Agent 持续观察' + (pct ? '（' + pct + '）' : '') + '。';
  }
  if (type === 'ranking_attention' && stopReason === 'judgment') {
    return 'Agent 已对此商品形成判断，详见下方。';
  }
  if (type === 'meaningful_change' && stopReason === 'observe') {
    return 'Agent 关注到近期经营波动' + dirSuffix + '，结合历史数据判断属于正常范围，建议持续观察。';
  }
  if (type === 'meaningful_change' && stopReason === 'judgment') {
    return (down ? 'Agent 判定此次下降需要重点关注' : 'Agent 判定此次变化需要重点关注') + (pct ? '（' + pct + '）' : '') + '。';
  }
  if (type === 'anomaly_investigation' && stopReason === 'observe') {
    return 'Agent 持续观察中，暂未发现经营异常' + (pct ? '（' + pct + '）' : '') + '。';
  }
  if (type === 'anomaly_investigation' && stopReason === 'judgment') {
    return 'Agent 已形成判断' + (pct ? '（波动 ' + pct + '）' : '') + '，详见下方。';
  }
  if (!stopReason) {
    return '（待整理）' + desc;
  }
  return desc || '（暂无描述）';
}

/**
 * Card-level one-liner for the Situation feed (≤ 30 chars).
 * Pure: same input contract as businessDescribeSituation.
 */
export function businessDescribeSituationShort(situation, investigation) {
  var type = (situation && situation.type) || '';
  var stopReason = (investigation && investigation.stopReason) || '';
  if (type === 'ranking_attention' && stopReason === 'observe') return '持续观察中';
  if (type === 'ranking_attention' && stopReason === 'judgment') return '已形成判断';
  if (type === 'meaningful_change' && stopReason === 'observe') return '波动观察中';
  if (type === 'meaningful_change' && stopReason === 'judgment') return '波动需关注';
  if (type === 'anomaly_investigation' && stopReason === 'observe') return '持续观察中';
  if (type === 'anomaly_investigation' && stopReason === 'judgment') return '异常需关注';
  return '待整理';
}

/**
 * baseline §11: Source tag — citation chain label.
 * Returns a SHORT Chinese label like "[证据]" / "[H1]" / "[规则]" / "[记忆]".
 * Returns "" for unknown kinds so the caller can skip rendering entirely
 * (we do NOT fabricate attribution).
 */
export function sourceTagLabel(kind, refId) {
  if (kind === 'evidence') return '[证据]';
  if (kind === 'knowledge') return '[规则]';
  if (kind === 'human') return '[H' + (refId || '?') + ']';
  if (kind === 'memory') return '[记忆]';
  return '';
}

/**
 * Source tag tooltip — what the operator sees on hover.
 * Always returns a Chinese sentence that admits the schema blocker honestly.
 */
export function sourceTagTooltip(kind) {
  if (kind === 'evidence') return 'Evidence 当前为运行时生成，无跨会话稳定引用。开发模式可看 content_hash。';
  if (kind === 'knowledge') return 'Knowledge 当前无 first-class 记录；引用以 knowledge/INDEX.md 路径为锚。';
  if (kind === 'human') return '本 Situation 人工干预记录。开发模式可看 intervention_id。';
  if (kind === 'memory') return 'Memory 当前为 Runtime 拥有，Fabric 不持久化其稳定 id。';
  return '';
}

/**
 * baseline §4: humanize a raw error string from a failed investigation.
 * Pure table lookup; NO LLM call. Business mode returns the Chinese
 * description only; developer mode includes the original error in parens.
 *
 * panelMode is injected by the caller (app.js reads state.panelMode; tests
 * pass the literal string 'business' or 'developer').
 */
export const ERROR_HUMANIZE = [
  { match: 'turn timed out', text: '调查超时（已超过 10 分钟）' },
  { match: 'timeout', text: '调查超时' },
  { match: 'invalid investigation contract', text: '调查结果未能形成有效判断' },
  { match: 'parse failure', text: '调查结果未能形成有效判断' },
  { match: 'invalid recommendation json', text: '建议生成未形成有效输出' },
  { match: 'no completed investigation', text: '建议生成前需要先完成调查' },
  { match: 'situation not found', text: 'Situation 不存在' },
];

export function humanizeError(raw, panelMode) {
  if (!raw) return '调查未完成（系统已记录原因，会在下一次启动时自动恢复调查）';
  var lower = String(raw).toLowerCase();
  for (var i = 0; i < ERROR_HUMANIZE.length; i++) {
    if (lower.indexOf(ERROR_HUMANIZE[i].match) >= 0) return ERROR_HUMANIZE[i].text;
  }
  if (panelMode === 'developer') return '调查未完成（开发模式可见：' + raw + '）';
  return '调查未完成（系统已记录原因，会在下一次启动时自动恢复调查）';
}

/**
 * baseline §5: descClean — strip system terms from a free-form description
 * so that the persisted `description` field does not leak into the
 * business-language layer. We DO NOT use this on the persisted field — we
 * use it as a safety net on the rendered Layer 1 text in case the seed /
 * producer emits internal terms.
 */
const SYSTEM_TERMS = [
  '综合得分', 'overall_score', '右侧 Track', 'Evidence Viewer', '右侧追踪',
  '已记录', '已捕获', '信号触发', 'signal', '已形成 ranking engine 事件',
];
export function descClean(text) {
  if (!text) return '';
  var out = String(text);
  for (var i = 0; i < SYSTEM_TERMS.length; i++) {
    if (out.indexOf(SYSTEM_TERMS[i]) >= 0) {
      out = out.split(SYSTEM_TERMS[i]).join('近期表现');
    }
  }
  return out;
}

/**
 * baseline §11: has prior valid cognition — used to decide whether the
 * failed banner should show. Mirrors the REPAIR invariant in
 * markInvestigation: status='failed' alone is NOT enough; the prior
 * completed investigation must have written judgment / currentUnderstanding.
 */
export function hasPriorValidCognition(investigation) {
  if (!investigation) return false;
  return !!(investigation.judgment || investigation.currentUnderstanding);
}

// ============================================================================
// P0010.1 Post-Productization REPAIR — Trust Links + Lifecycle + Commitment
// ============================================================================

/**
 * REPAIR §2: Derive the Situation LIFECYCLE (5 business states) from the
 * persisted Investigation + Intervention shape. This is the PRIMARY
 * operator-facing status; the investigation.status is a SECONDARY
 * (failure) signal. They are not the same.
 *
 * Lifecycle semantics (each = a distinct business state, never "已处理"):
 *
 *   - 'pending'        No investigation yet, or inv.status='pending'.
 *                      This is the "待处理" state.
 *   - 'investigating'  inv.status='investigating'. The Agent is running.
 *                      "调查中" — distinct from "watching" (which means
 *                      the Agent is done but the case is still alive).
 *   - 'waiting_human'  The Agent's stopReason or recommendation explicitly
 *                      asks the human to act (ask_human / missing_capability,
 *                      OR stopReason='judgment' AND the recommendation's
 *                      humanNeeded is non-empty). "等待人工".
 *   - 'watching'       The Agent has finished a real investigation (either
 *                      stopReason='observe' OR completed-judgment without
 *                      a decision) OR the latest attempt failed but prior
 *                      valid cognition exists. "持续观察" — NOT "已处理".
 *                      The case is alive; the operator is expected to
 *                      monitor. This is the state the user explicitly
 *                      called out as missing in P0010.1.
 *   - 'closed'         RESERVED for a future durable resolution contract
 *                      (e.g. an explicit Situation-resolution event). In
 *                      this REPAIR the derivation can NEVER return 'closed':
 *                      a human `decision='accept'` on a recommendation
 *                      means the recommendation was adopted, NOT that the
 *                      Situation is over. The underlying business issue
 *                      (e.g. "继续观察 2 天") persists until either (a) the
 *                      Agent explicitly resolves it via a durable protocol
 *                      that does not yet exist, or (b) the human performs
 *                      a separate resolution action that is not "accept
 *                      recommendation". For now: human-accept ⇒ 'watching'.
 *
 * "已处理" is intentionally NOT in this list. There is no state where
 * "the Agent processed this" means "the case is over". The user said:
 *   WATCHING / 持续观察不是"已处理"。
 *
 * Architectural note: Situation.closed and WorkItem.closed are INDEPENDENT.
 * WorkItem.closed is a status on a deliverable (ready → delivered →
 * acknowledged → closed); it has no authority to close the Situation.
 * A WorkItem can be 'closed' while the Situation is still 'watching'.
 */
export function deriveSituationLifecycle(
  investigation,
  interventionCount,
  hasAcceptedDecision,
) {
  if (!investigation || investigation.status === 'pending') return 'pending';
  if (investigation.status === 'investigating') return 'investigating';

  // failed-without-prior is "still pending" — the case is not actionable yet.
  if (investigation.status === 'failed' && !hasPriorValidCognition(investigation)) {
    return 'pending';
  }

  // needs_human check (priority over watching). This is a Human-side
  // requirement: the Agent is asking the operator to act.
  // P0010.1 Final Repair — Area D: tightened to read only structured fields
  // (stopReason + recommendation.humanNeeded[]). The previous version
  // matched "人工核验" / "人工确认" / "无法获取" in the judgment text, which
  // was a fuzzy heuristic and mis-triggered on passing mentions.
  var stop = investigation.stopReason || '';
  if (stop === 'missing_capability' || stop === 'ask_human') return 'waiting_human';
  if (stop === 'judgment') {
    var rec = investigation.recommendation;
    if (rec && Array.isArray(rec.humanNeeded) && rec.humanNeeded.length > 0) {
      return 'waiting_human';
    }
  }

  // Observation: the Agent's recommendation is "继续观察".
  if (stop === 'observe') return 'watching';

  // Failed with prior valid cognition = watching prior judgment.
  if (investigation.status === 'failed' && hasPriorValidCognition(investigation)) {
    return 'watching';
  }

  // Completed judgment (stopReason='judgment'): the case is in 'watching'
  // until a future durable resolution contract exists. A human
  // decision='accept' only records "recommendation adopted" — it does NOT
  // close the Situation. decision='reject' likewise keeps it 'watching'.
  // hasAcceptedDecision is accepted as input for forward-compat with the
  // eventual resolution contract, but the derivation currently ignores it.
  void hasAcceptedDecision; // intentionally unused in this REPAIR
  return 'watching';
}

/** Chinese label + emoji for each lifecycle.
 *  `closed` is RESERVED — the derivation can never return it in this REPAIR. */
export const SITUATION_LIFECYCLE_LABEL = Object.freeze({
  pending:        '⏳ 待处理',
  investigating:  '🔍 调查中',
  waiting_human:  '👤 等待人工',
  watching:       '👀 持续观察',
  closed:         '✓ 已结束（保留 · 尚无可触发条件）',
});

/**
 * P0010.2.4 (ADR-060 audit B) + P0010.2.4 review repair (ADR-061) —
 * Investigation DISPLAY state.
 *
 * The Operator-facing banner for "what is the runtime doing with this
 * situation's investigation" is a SEPARATE state from the Situation
 * lifecycle. The previous code conflated the two (string-matched
 * `invBlockedRuntimeFailure` and `inv.status` separately, leading to
 * contradictions like "auto-recover, no human action" while a
 * "clear-block" button was shown).
 *
 * This helper takes the structured `investigation` block + the
 * `blockedRuntimeFailure` flag surfaced by the runtime and returns
 * exactly ONE of 5 states. The banner copy + button visibility is
 * driven entirely by the returned state — no string guesswork.
 *
 * State precedence (highest first):
 *   1. `blockedRuntimeFailure === true` → `'blocked'` (operator override wins).
 *      This is the only state that ever shows the "解除阻塞并重新调度"
 *      button. The `consecutiveFailures` counter is part of the
 *      threshold-crossing decision (the runtime already emitted
 *      `investigation_blocked` when it crossed the line) and is
 *      surfaced in the banner's detail text.
 *   2. `investigation == null` → `'pending'` (no investigation ever run).
 *   3. `status === 'investigating'` → `'investigating'`.
 *   4. `status === 'completed'` → `'completed'`.
 *   5. `status === 'failed'` → `'recoverable'`. The runtime's recovery
 *      candidates logic
 *      (apps/ecommerce/runtime/loop/recovery-candidates.ts) gates this
 *      on `consecutiveFailures < maxConsecutiveFailures` (default 3).
 *      When the threshold is crossed, the runtime emits
 *      `investigation_blocked` and sets `blockedRuntimeFailure=true`,
 *      so we land back in the `blocked` state.
 *   6. otherwise → `'pending'`.
 *
 * P0010.2.4 review repair (ADR-061): the previous 6-state enum included
 * a `failed_unrecoverable` member that was never returned by any code
 * path (the runtime either keeps retrying → `recoverable`, or trips the
 * threshold → `blocked`). The dead member is removed; the contract now
 * matches the actual state machine.
 *
 * `consecutiveFailures` is an INPUT but is only used to enrich the
 * `blocked` banner's detail text with the actual count. The state
 * itself is determined by `blockedRuntimeFailure`, not by the counter.
 */
export function deriveInvestigationDisplayState(investigation, blockedRuntimeFailure, consecutiveFailures) {
  // (1) Operator override path — wins over everything else.
  if (blockedRuntimeFailure === true) return 'blocked';

  if (!investigation) return 'pending';
  var status = investigation.status || 'pending';
  if (status === 'investigating') return 'investigating';
  if (status === 'completed') return 'completed';
  if (status === 'pending') return 'pending';
  if (status === 'failed') {
    // Below threshold + may or may not have prior cognition — the
    // runtime will retry. We are NOT blocked.
    return 'recoverable';
  }
  // Unknown status — do NOT default to "recoverable" (would lie).
  return 'pending';
}

/**
 * P0010.2.4 (ADR-060 audit B) — Banner copy for each display state.
 *
 * Each entry is the canonical HTML snippet. The runtime drives the
 * state; this map is the ONLY source of banner copy. If you find
 * yourself wanting to inline string-match copy in app.js, add a state
 * here instead.
 */
export const INVESTIGATION_DISPLAY_BANNER = Object.freeze({
  pending: {
    headline: '等待 Agent 自动调查（已进入 Runtime 调度队列）',
    detail: 'Runtime 将自动安排下一轮调查，无需人工操作。',
    showClearBlock: false,
    showLegacyStart: false,
  },
  recoverable: {
    headline: 'Runtime 正在自动恢复调查（无需人工操作）',
    detail: 'Runtime 将在下一轮 tick 重新尝试。',
    showClearBlock: false,
    showLegacyStart: false,
  },
  investigating: {
    headline: 'Agent 正在调查中',
    detail: '请稍候。Runtime 已锁定该 Situation 的调查上下文。',
    showClearBlock: false,
    showLegacyStart: false,
  },
  blocked: {
    headline: '⚠ 自动调查已暂停',
    // P0010.2.4 review repair (ADR-061) — the detail is a FUNCTION
    // that takes `(consecutiveFailures, threshold)` and returns the
    // operator-facing message. We removed the literal `**…**` markdown
    // (the workspace renders detail via textContent, not innerHTML, so
    // the asterisks were showing as literal characters). app.js calls
    // this with the live counter so the operator sees the actual
    // count and threshold instead of a hard-coded "已连续失败 N 次".
    detail: function (consecutiveFailures, threshold) {
      var n = Number.isFinite(consecutiveFailures) ? consecutiveFailures : 0;
      var t = Number.isFinite(threshold) && threshold > 0 ? threshold : 3;
      return '已连续失败 ' + n + ' 次（阈值 ' + t + '）。请执行「解除阻塞并重新调度」让 Runtime 重新安排下一轮调查。';
    },
    showClearBlock: true,
    showLegacyStart: false,
  },
  completed: {
    headline: '调查已完成',
    detail: '查看右栏的判断与建议；如需复审请使用判断反馈按钮。',
    showClearBlock: false,
    showLegacyStart: false,
  },
});

/** Investigation secondary status (the "Investigation attempt" sub-state).
 *  Mirrors the existing 4 in shared/schemas/investigation.ts. */
export const INVESTIGATION_STATUS_LABEL = Object.freeze({
  pending: '调查待启动',
  investigating: '调查中',
  completed: '已完成',
  failed: '⚠️ 最新调查未完成',
});

/**
 * REPAIR §3: Derive a minimal "Observation Commitment" from the
 * persisted Investigation. No new schema, no scheduler, no wake engine.
 * Just the operator-facing representation of the "observation plan":
 * "this case is being watched; here's when the next checkpoint is
 * expected AND what humans should look for before re-evaluating."
 *
 * Returns null when the situation is not in a watching-like state
 * (pending / investigating / failed-no-prior — none of these
 * make sense as a commitment). The Operator UI hides the card in that
 * case.
 *
 * The `checkpoints` field is a HUMAN-READABLE label of what an operator
 * should look for before re-evaluating (e.g. "new evidence arrives",
 * "review time reached"). It is NOT an auto-wake condition: there is no
 * scheduler, no wake engine, no event bus. The note field makes this
 * explicit so the UI cannot be misread as "the system will wake me up".
 */
export function deriveObservationCommitment(investigation) {
  if (!investigation) return null;
  // Only "watching-like" states produce a commitment.
  var stop = investigation.stopReason || '';
  var isObserve = stop === 'observe';
  var isFailedWithPrior = investigation.status === 'failed' && hasPriorValidCognition(investigation);
  var isWatchingLike = isObserve || isFailedWithPrior;
  if (!isWatchingLike) return null;

  // startedAt = investigation.updatedAt (when the latest valid cognition
  // was written). Fall back to createdAt if updatedAt is missing.
  var startedAt = investigation.updatedAt || investigation.createdAt || new Date().toISOString();
  // reviewAt: heuristic — if the recommendation mentions a duration,
  // try to parse it; otherwise null (no implied review date).
  var reviewAt = parseReviewAtFromRecommendation(startedAt, investigation.recommendation);
  return {
    type: 'observe',
    startedAt: startedAt,
    reviewAt: reviewAt,
    // checkpoints: human-readable labels of what to watch for, NOT
    // auto-wake conditions. The UI must surface this as "观察重点",
    // not "自动唤醒条件".
    checkpoints: ['新证据到达', '复查时间到达', '运营主动复查'],
    note: isFailedWithPrior
      ? '上次有效判断仍在跟踪中；最新调查未完成，详见顶部红条。系统当前未实现自动唤醒，需运营主动复查。'
      : '观察计划：等待新证据或复查时间到达。系统当前未实现自动唤醒，需运营主动复查。',
  };
}

/** Heuristic: pull "继续观察 N 天" / "观察 N 小时" out of the
 *  recommendation rationale. Returns an ISO date or null. */
function parseReviewAtFromRecommendation(startedAt, recommendation) {
  if (!recommendation) return null;
  var txt = (recommendation.recommendation || '') + ' ' + (recommendation.rationale || '');
  var m = txt.match(/(\d+)\s*[-~— ]?\s*(天|日)/);
  if (m) {
    var days = parseInt(m[1], 10);
    if (!isNaN(days) && days > 0 && days < 365) {
      return new Date(new Date(startedAt).getTime() + days * 86400_000).toISOString();
    }
  }
  var m2 = txt.match(/(\d+)\s*小时/);
  if (m2) {
    var hours = parseInt(m2[1], 10);
    if (!isNaN(hours) && hours > 0 && hours < 24 * 30) {
      return new Date(new Date(startedAt).getTime() + hours * 3600_000).toISOString();
    }
  }
  return null;
}

// ============================================================================
// REPAIR §1: Trust Reference Popover — content for [E]/[K]/[H] click.
// ============================================================================

/**
 * Build the popover data for a [证据] tag. We have NO stable id (SB-1),
 * so we surface what the Agent actually wrote (the evidenceAcquired
 * string) + a best-effort parse of capability + date range. There is no
 * underlying record to fetch. The popover must be honest about that.
 */
export function popoverContentForEvidence(evidenceString) {
  if (!evidenceString) return null;
  // Common Agent-written shapes:
  //   "trade.overview 2026-08-21→2026-08-22"
  //   "orders.overview 2026-08-21"
  //   "product.overview 2026-08-21→2026-08-22"
  var parts = String(evidenceString).split(/\s+/);
  var capabilityId = parts[0] || '';
  var dateRange = parts.slice(1).join(' ') || '';
  // best-effort: human label (no real mapping; use id directly)
  return {
    title: '证据引用',
    fields: [
      { label: '能力', value: capabilityId || '（未提供）' },
      { label: '日期', value: dateRange || '（未提供）' },
    ],
    unavailable: {
      reason: '原始来源暂不可定位',
      detail: 'Evidence 当前为运行时生成，无跨会话稳定引用。本字段展示的是 Agent 写入 evidenceAcquired 的字面值。',
    },
  };
}

/**
 * Build the popover data for a [规则] tag. We have NO first-class
 * Knowledge record (SB-2), so we show the knownEvidence text the Agent
 * wrote + admit the schema blocker.
 */
export function popoverContentForKnowledge(knownEvidenceText) {
  if (!knownEvidenceText) return null;
  return {
    title: '知识/规则引用',
    fields: [
      { label: '规则文本', value: knownEvidenceText },
    ],
    unavailable: {
      reason: 'Knowledge 暂无 first-class 记录',
      detail: '当前引用以 knowledge/INDEX.md 路径为锚，无独立 provenance 元数据。',
    },
  };
}

/**
 * Build the popover data for a [H{n}] tag. We have full fidelity here:
 * interventionId, type, summary, actor, createdAt all live in the
 * human_interventions table.
 */
export function popoverContentForHuman(intervention) {
  if (!intervention) return null;
  var content = intervention.content;
  var contentStr = '';
  if (content && typeof content === 'object') {
    // The DB column is `{"type":"<type>"}` for seeded rows; richer
    // fields live in learning_contexts.body.humanInterventions[].content.
    var keys = Object.keys(content);
    contentStr = keys
      .filter(function (k) { return k !== 'type'; })
      .map(function (k) { return k + ': ' + JSON.stringify(content[k]); })
      .join('\n');
  }
  return {
    title: '人工干预 [H]',
    fields: [
      { label: '类型', value: intervention.type || '（未提供）' },
      { label: '摘要', value: intervention.summary || '（未提供）' },
      { label: '操作员', value: (intervention.actor && intervention.actor.id) || '（未提供）' },
      { label: '时间', value: (intervention.timestamp || intervention.createdAt || '').slice(0, 19).replace('T', ' ') || '（未提供）' },
      { label: 'interventionId', value: intervention.interventionId || '（未提供）', devOnly: true },
      { label: '附加内容', value: contentStr || '（无附加内容 — 仅类型）' },
    ],
  };
}

/**
 * Build the popover data for a [记忆] tag. Memory is Runtime-owned;
 * Fabric never persists it (SB-3). We always return the unavailable
 * surface so the click is honest.
 */
export function popoverContentForMemory() {
  return {
    title: '记忆引用',
    fields: [],
    unavailable: {
      reason: 'Memory 永属 Runtime',
      detail: 'Memory 当前为 Runtime 拥有，Fabric 不持久化其稳定 id。',
    },
  };
}

/** Dispatch by kind — the caller (app.js) hands us a kind + the matching
 *  context (evidence string / knownEvidence text / intervention object).
 *  Returns the popover data or null when the kind is unknown. */
export function getSourcePopoverData(kind, refId, context) {
  context = context || {};
  if (kind === 'evidence') {
    var evs = context.evidenceStrings || [];
    // The track emits [证据] without a specific refId; we just show the
    // first one. (The Operator will see this is a coarse surface and
    // can ask for finer citation in P0011.)
    return popoverContentForEvidence(evs[refId ? refId - 1 : 0] || evs[0] || null);
  }
  if (kind === 'knowledge') {
    var ks = context.knownEvidence || [];
    return popoverContentForKnowledge(ks[0] || null);
  }
  if (kind === 'human') {
    var interventions = context.interventions || [];
    var idx = refId ? refId - 1 : 0;
    return popoverContentForHuman(interventions[idx] || null);
  }
  if (kind === 'memory') return popoverContentForMemory();
  return null;
}

/** Render the popover HTML (caller passes into the DOM). Pure — no state. */
export function renderSourcePopoverHtml(data) {
  if (!data) return '';
  var html = '<div class="popover-header"><span class="popover-title">' + escHtml(data.title) + '</span><button class="popover-close" type="button" aria-label="关闭">×</button></div>';
  html += '<div class="popover-body">';
  if (data.fields && data.fields.length) {
    html += '<table class="popover-table">';
    for (var i = 0; i < data.fields.length; i++) {
      var f = data.fields[i];
      if (f.devOnly) {
        html += '<tr class="popover-dev-row" data-popover-dev="1"><th>' + escHtml(f.label) + '</th><td><code>' + escHtml(f.value) + '</code></td></tr>';
      } else {
        html += '<tr><th>' + escHtml(f.label) + '</th><td>' + escHtml(f.value) + '</td></tr>';
      }
    }
    html += '</table>';
  }
  if (data.unavailable) {
    html += '<div class="popover-warning"><div class="popover-warning-reason">⚠ ' + escHtml(data.unavailable.reason) + '</div><div class="popover-warning-detail">' + escHtml(data.unavailable.detail) + '</div></div>';
  }
  html += '</div>';
  return html;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// P0010.1 Final Repair — Area B: vertical Situation Timeline.
//
// Pure functions over the `/api/situations/:id` response. Every event in
// the rendered timeline comes from a REAL persisted timestamp — no fabricated
// `completedAt` / `deliveredAt` / `askedAt`. Rows that proxy a real-but-weak
// field (e.g. `updatedAt` for an "Investigation completed" event) carry a
// small `≈` annotation in the summary so the operator can see exactly which
// fields are approximate.
//
// This module does NOT add a Timeline Store / Event Bus. It only projects
// existing data: situations.createdAt, human_interventions.created_at,
// outputs[].createdAt/acknowledgedAt/closedAt, and the investigation marker
// fields. Anything not in the input is left out — no defaults, no LLM.
// ---------------------------------------------------------------------------

/**
 * Map a HumanIntervention to a Chinese business label.
 * The `decision` sub-type is exposed (accept/reject/defer/override/no_action)
 * so the timeline can distinguish between "采用建议" and "稍后处理" — currently
 * collapsed to a single "决策" label in `app.js:1376`.
 */
export function timelineEventLabel(type, content) {
  if (type === 'decision') {
    var d = content && content.decision;
    if (d === 'accept') return '已采用建议';
    if (d === 'reject') return '不采用';
    if (d === 'defer') return '稍后处理';
    if (d === 'override') return '已重写判断';
    if (d === 'no_action') return '无操作';
    return '决策';
  }
  if (type === 'response') return '认同判断';
  if (type === 'correction') return '纠正事实';
  if (type === 'context_supplement') return '补充背景';
  return type || '事件';
}

/** Map a Chinese label for an event actor (rendered in the timeline row). */
function actorLabel(actor) {
  if (actor === 'agent') return 'Agent';
  if (actor === 'human') return '运营';
  if (actor === 'system') return '系统';
  return actor || '';
}

/** Format an ISO timestamp for display in the timeline row.
 *  Delegates to time-format.js (browser local timezone, second precision).
 *  Kept as a local wrapper so existing call sites that import
 *  `formatLocalTime` from this module keep working. */
function formatLocalTime(iso) {
  return formatLocalTimeTz(iso);
}

// ---- re-exports for backward-compat ----
//
// Some legacy code paths import the time formatters directly from
// `presentation.js`. Re-export them here so we don't have to update
// every call site just to switch to the new module.
export { formatLocalTimeTz as formatLocalTimeStrict, formatUtcTime, formatBusinessDate, formatProxyTime, formatRelative };

/** Push an event only if its timestamp is present. Skips silently on missing data. */
function pushIfTimed(events, ev) {
  if (ev && ev.t) events.push(ev);
}

/**
 * Render the Situation timeline. Returns the HTML string for `<ol class="situation-timeline">…</ol>`,
 * or an empty string if there are no events (so the section is hidden entirely).
 */
export function renderSituationTimeline(detail) {
  if (!detail) return '';
  var events = [];
  // 1. Situation created
  pushIfTimed(events, {
    t: detail.createdAt,
    actor: 'agent',
    type: 'situation.created',
    summary: '发现 Situation',
  });
  // 2. Observation window
  if (detail.temporal && detail.temporal.observedAt) {
    var window =
      '观察窗口 ' +
      (detail.temporal.windowStart || detail.temporal.observedAt) +
      ' → ' +
      (detail.temporal.windowEnd || detail.temporal.observedAt);
    pushIfTimed(events, {
      t: detail.temporal.observedAt,
      actor: 'system',
      type: 'situation.observed',
      summary: window,
    });
  }
  // 3. Investigation lifecycle — only if learningContext.investigation is present
  var lc = detail.learningContext;
  var inv = lc && lc.investigation;
  if (inv) {
    if (inv.startedAt) {
      pushIfTimed(events, {
        t: inv.startedAt,
        actor: 'agent',
        type: 'investigation.started',
        summary: '开始调查',
      });
    }
    if (inv.status === 'completed' && inv.updatedAt) {
      pushIfTimed(events, {
        t: inv.updatedAt,
        actor: 'agent',
        type: 'investigation.completed',
        summary: '调查完成 (≈ 完成时间; 实际缺少 completedAt 列)',
      });
    }
    if (inv.status === 'failed' && inv.updatedAt) {
      pushIfTimed(events, {
        t: inv.updatedAt,
        actor: 'agent',
        type: 'investigation.failed',
        summary: '调查失败' + (inv.error ? ': ' + inv.error : ''),
      });
    }
    // 4. Stop reason — no separate timestamp, so it's an annotation on the most recent agent event.
    if (inv.stopReason) {
      var stopLabel =
        inv.stopReason === 'judgment'
          ? '形成判断'
          : inv.stopReason === 'observe'
            ? '持续观察'
            : inv.stopReason === 'missing_capability'
              ? '能力边界'
              : inv.stopReason === 'ask_human'
                ? '需要人工'
                : inv.stopReason;
      // Anchor the stop-reason event to the latest of (startedAt, updatedAt, observedAt) so it
      // sorts after the events it depends on but before the next human action.
      // P0010.2.3 (ADR-059 audit G-1) — same honesty rule as the "completed" event above:
      // when the timestamp came from a proxy (inv.updatedAt || inv.startedAt) rather
      // than a dedicated `stoppedAt` column, surface the same `≈` annotation. When
      // truly missing, fall back to "时间未记录" rather than fabricating a wall-clock.
      var rawStopT = inv.updatedAt || inv.startedAt || (detail.temporal && detail.temporal.observedAt);
      var isStopTProxy = !!(inv.updatedAt || inv.startedAt); // a real proxy column exists
      var stopSummary = '停止原因: ' + stopLabel
        + (rawStopT ? (isStopTProxy ? ' (≈ 停止时间; 实际缺少 stoppedAt 列)' : '') : ' (时间未记录)');
      pushIfTimed(events, {
        t: rawStopT,
        actor: 'agent',
        type: 'investigation.stopped',
        summary: stopSummary,
      });
    }
  }
  // 5. Human interventions
  var interventions = Array.isArray(detail.interventions) ? detail.interventions : [];
  for (var i = 0; i < interventions.length; i++) {
    var ii = interventions[i];
    pushIfTimed(events, {
      t: ii.timestamp || ii.createdAt,
      actor: 'human',
      type: 'intervention.' + (ii.type || 'event'),
      summary: timelineEventLabel(ii.type, ii.content) + (ii.summary ? ' — ' + ii.summary : ''),
    });
  }
  // 6. Outputs (created/acknowledged/closed — no `deliveredAt` field, so skip delivered)
  var outputs = Array.isArray(detail.outputs) ? detail.outputs : [];
  for (var o = 0; o < outputs.length; o++) {
    var out = outputs[o];
    var typeLabel = out.type === 'recommendation' ? '建议' : out.type === 'analysis' ? '分析' : out.type === 'report' ? '报告' : out.type === 'work_item' ? '工作项' : '交付物';
    pushIfTimed(events, {
      t: out.createdAt,
      actor: 'agent',
      type: 'output.created',
      summary: typeLabel + ' 已生成',
    });
    pushIfTimed(events, {
      t: out.acknowledgedAt,
      actor: 'human',
      type: 'output.acknowledged',
      summary: typeLabel + ' 已确认',
    });
    pushIfTimed(events, {
      t: out.closedAt,
      actor: 'human',
      type: 'output.closed',
      summary: typeLabel + ' 已关闭',
    });
  }
  if (events.length === 0) return '';
  // Sort by timestamp ascending; events with identical timestamps stay in source order.
  events.sort(function (a, b) {
    return String(a.t).localeCompare(String(b.t));
  });
  var items = events
    .map(function (e) {
      return (
        '<li class="timeline-event" data-event-type="' +
        escHtml(e.type) +
        '" data-actor="' +
        escHtml(e.actor) +
        '">' +
        '<time class="timeline-time" datetime="' +
        escHtml(e.t) +
        '">' +
        escHtml(formatLocalTime(e.t)) +
        '</time>' +
        '<span class="timeline-actor">' +
        escHtml(actorLabel(e.actor)) +
        '</span>' +
        '<span class="timeline-summary">' +
        escHtml(e.summary) +
        '</span>' +
        '</li>'
      );
    })
    .join('');
  return (
    '<div class="situation-timeline-section">' +
    '<h3 class="situation-layer-title">⏱ 生命周期时间线</h3>' +
    '<p class="muted" style="font-size:0.74rem;margin:0 0 8px 0">每个事件都来自持久化的时间戳；不伪造。</p>' +
    '<ol class="situation-timeline">' +
    items +
    '</ol>' +
    '</div>'
  );
}

// ---- P0012 Continuous Observation timeline ----
//
// Renders a per-metric time series of Business Time observations
// (one row per Phase A refresh tick — same hour bucket → no-op dedup).
// Lifecycle timeline stays unchanged; this section is appended after it
// and only renders when at least one observation exists. Per-row fields:
// time (Beijing local via formatLocalTimeTz), baseline → current
// (both via the metric format in metricFormat), change % with direction
// arrow, business_time_bucket stamp for cross-day visibility.

function metricFormat(metric) {
  if (metric === 'gmv') return function (v) { return '¥' + v.toFixed(2); };
  if (metric === 'orders') return function (v) { return String(Math.round(v)); };
  if (metric === 'uv') return function (v) { return String(Math.round(v)); };
  if (metric === 'cvr') return function (v) { return (v * 100).toFixed(1) + '%'; };
  return function (v) { return String(v); };
}

function directionArrow(pct) {
  if (pct > 0) return '↑';
  if (pct < 0) return '↓';
  return '·';
}

export function renderObservationTimeline(observations) {
  if (!observations || !observations.length) return '';
  // Group by metric for readability.
  var byMetric = {};
  for (var i = 0; i < observations.length; i++) {
    var o = observations[i];
    (byMetric[o.metric] = byMetric[o.metric] || []).push(o);
  }
  var metricOrder = ['gmv', 'orders', 'uv', 'cvr'];
  var keys = Object.keys(byMetric).sort(function (a, b) {
    var ai = metricOrder.indexOf(a); ai = ai < 0 ? 999 : ai;
    var bi = metricOrder.indexOf(b); bi = bi < 0 ? 999 : bi;
    return ai - bi;
  });
  var sections = '';
  for (var k = 0; k < keys.length; k++) {
    var metric = keys[k];
    var fmt = metricFormat(metric);
    var rows = byMetric[metric];
    var items = '';
    for (var j = 0; j < rows.length; j++) {
      var o = rows[j];
      var pct = o.change_pct;
      var arrow = directionArrow(pct);
      var pctText = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
      items +=
        '<li class="observation-item" data-bucket="' + escHtml(o.business_time_bucket) + '">' +
        '<time class="timeline-time" datetime="' + escHtml(o.observed_at) + '">' +
        escHtml(formatLocalTimeTz(o.observed_at)) +
        '</time>' +
        '<span class="observation-arrow">' + arrow + '</span>' +
        '<span class="observation-values">' +
        escHtml(fmt(o.baseline_value)) + ' → ' + escHtml(fmt(o.current_value)) +
        '</span>' +
        '<span class="observation-pct ' + (pct >= 0 ? 'up' : 'down') + '">' +
        escHtml(pctText) +
        '</span>' +
        '</li>';
    }
    sections +=
      '<div class="observation-metric-block" data-metric="' + escHtml(metric) + '">' +
      '<h4 class="observation-metric-title">' + escHtml(metric) + ' <span class="muted">(' + rows.length + ')</span></h4>' +
      '<ol class="observation-list">' + items + '</ol>' +
      '</div>';
  }
  return (
    '<div class="observation-timeline-section">' +
    '<h3 class="situation-layer-title">📈 持续观察 / Observation Timeline</h3>' +
    '<p class="muted" style="font-size:0.74rem;margin:0 0 8px 0">P0012 — 每个 hour bucket 由 producer 投影一次。事实持续滚动；判断不自动重跑。</p>' +
    sections +
    '</div>'
  );
}

// ---- P0010.1 Final Repair — Area C.4 helpers ----
//
// Pure functions that pin the behavior of:
//   1. deriveLatestAgentActivityId(situationContext)
//        — return the id of the most recent agent activity for a situation
//   2. flattenRespondsToActivityIds(type, content)
//        — project the structured `content.respondsTo.agentActivityIds` into
//          the top-level `respondsToActivityIds` field on the POST payload
//
// These were previously inlined in app.js and never had a unit test. Today the
// only stable agent activity we have is the investigation itself (its
// `startedAt` timestamp is unique per situation). The producer-side
// `agentActivities[]` is still hard-coded to `[]` (see
// `learning-context-producer.ts:103`) — that gap is reported in the next-slice
// blockers in context/handoff.md, not fixed in this round.

/**
 * @param {{
 *   situationId?: string,
 *   invData?: { startedAt?: string | null } | null,
 *   agentActivities?: Array<{ activityId?: string, timestamp?: string }>
 * }} situationContext
 * @returns {string | null}
 */
export function deriveLatestAgentActivityId(situationContext) {
  if (!situationContext) return null;
  // Prefer an explicit agentActivities[] projection when the producer
  // eventually emits it. Today this list is empty, so we fall back to the
  // investigation's startedAt.
  var list = Array.isArray(situationContext.agentActivities)
    ? situationContext.agentActivities
    : [];
  for (var i = list.length - 1; i >= 0; i--) {
    var a = list[i];
    if (a && typeof a.activityId === 'string' && a.activityId.length > 0) {
      return a.activityId;
    }
  }
  var inv = situationContext.invData;
  if (inv && typeof inv.startedAt === 'string' && inv.startedAt.length > 0) {
    return inv.startedAt;
  }
  return null;
}

/**
 * @param {string} type — the HumanIntervention.type (one of the 4 canonical kinds)
 * @param {{ respondsTo?: { agentActivityIds?: string[] } } | null | undefined} content
 * @returns {string[]}
 */
export function flattenRespondsToActivityIds(type, content) {
  if (type !== 'response') return [];
  if (!content || !content.respondsTo) return [];
  var ids = content.respondsTo.agentActivityIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter(function (x) {
    return typeof x === 'string' && x.length > 0;
  });
}

// ---- P0010.2.x — WorkspacePresentation wrapper for the browser ----
//
// The authoritative state is computed server-side by
// `apps/ecommerce/workspace/presentation-state.ts`. The browser MUST
// consume the pre-computed snapshot via `/api/situations/:id`'s
// `workspacePresentation` field, NOT recompute state from raw
// `learningContext` fields.
//
// These two thin functions are the browser-side accessors. They
// handle the three possible response shapes:
//
//   * `detail.workspacePresentation` is set  → return it as-is
//   * `detail.workspacePresentation` is null → return null (e.g. 404
//                                             or a non-Workspace
//                                             consumer endpoint)
//   * `detail` itself is null/undefined      → return null
//
// The two P0010.1/P0010.2.4 helpers above (`deriveInvestigationStatus`
// in p0007.ts and `deriveInvestigationDisplayState` here) are KEPT for
// back-compat with any caller still using them. New code MUST use
// these two functions instead.

/**
 * Get the single WorkspacePresentation snapshot for one situation.
 * @param {object|null|undefined} detail The `/api/situations/:id` response body.
 * @returns {WorkspacePresentationOutput|null}
 */
export function getWorkspacePresentation(detail) {
  if (!detail) return null;
  var wp = detail.workspacePresentation;
  if (!wp) return null;
  return wp;
}

/**
 * Get a FeedEntrySummary for a situation, projecting from the full
 * WorkspacePresentation snapshot. The server already returns a
 * pre-computed FeedEntrySummary at `/api/situations` (each list row
 * carries `presentation` / `headline` / `presentationRevision`), so
 * the browser usually reads those directly. This function is for
 * callers that only have the Detail response.
 *
 * @param {object|null|undefined} detail
 * @returns {FeedEntrySummary|null}
 */
export function getFeedEntrySummary(detail) {
  var wp = getWorkspacePresentation(detail);
  if (!wp) return null;
  return {
    situationId: wp.situationId,
    presentation: wp.presentation,
    headline: wp.banner ? wp.banner.headline : '',
    shortLabel: wp.banner ? wp.banner.detail : '',
    observedAt: (detail.temporal && detail.temporal.observedAt) || detail.createdAt || '',
    interventionCount: Array.isArray(wp.interventions) ? wp.interventions.length : 0,
    hasAcceptedDecision: false, // Detail endpoint does not compute this; caller falls back to /api/situations.
    judgmentPreview: wp.investigation && wp.investigation.judgment
      ? (wp.investigation.judgment.length > 70 ? wp.investigation.judgment.slice(0, 70) : wp.investigation.judgment)
      : '',
    presentationRevision: wp.presentationRevision,
  };
}

/**
 * Read the `availableActions` flags from a WorkspacePresentation banner.
 * The browser renders the generate-recommendation / clear-block /
 * legacy-start buttons based on these flags rather than re-deriving
 * from the presentation state.
 *
 * @param {WorkspacePresentationOutput|null|undefined} wp
 * @returns {{showGenerateRecommendation: boolean, showClearBlock: boolean, showLegacyStart: boolean}}
 */
export function getAvailableActions(wp) {
  if (!wp || !wp.banner || !wp.banner.availableActions) {
    return { showGenerateRecommendation: false, showClearBlock: false, showLegacyStart: false };
  }
  return wp.banner.availableActions;
}

// ---- P0010.2.x — Presentation state code path (DEPRECATED comment) ----
//
// The 5-state enum + `INVESTIGATION_DISPLAY_BANNER` +
// `deriveInvestigationDisplayState` above (P0010.2.4) are KEPT for
// back-compat with any code path that still derives the operator-
// facing state client-side from raw investigation fields. They are
// SUPERSEDED by the server-side WorkspacePresentation reducer
// (presentation-state.ts → p0007.ts → `workspacePresentation` field).
// The 7-state enum (pending / investigating / recoverable / completed
// / observing / waiting_human / blocked) is the single source of
// truth.
//
// New UI code MUST consume `getWorkspacePresentation()` and read the
// `banner` / `availableActions` from there. Do NOT add new code
// paths that re-derive presentation state from raw
// `investigation.*` fields or from the old 5-state enum — they
// contradict the server-side reducer and reintroduce audit dead-leg
// #1 (multiple state sources disagreeing on the same Situation).

