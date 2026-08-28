// shared/utils/text.ts — P0010.2.x — Text normalization helpers for
// content fingerprinting.
//
// Why this file exists:
//   The runtime materializes an Agent's recommendation into a WorkItem
//   in `learning_contexts.body.outputs[]`. The dedup fingerprint must
//   catch re-runs that produce effectively the SAME recommendation with
//   small surface variations — because a re-investigation on the same
//   Situation with the same evidence and the same Agent judgment
//   SHOULD collapse to the same WorkItem, not accumulate 90+ near-
//   identical entries (the audit observed exactly this runaway pattern
//   in production: 164 outputs across 5 situations, 90+ for one).
//
// What counts as "effectively the same":
//   - Round counters ("第 7 轮", "已 3 轮", "连续 5 轮") — these are
//     investigation-counters, not recommendation substance.
//   - Embedded timestamps ("18:56:48", "18:56") — the time the turn
//     ran, not what the Agent advises.
//   - Date stamps ("2026-08-27", "08-27") — same as timestamps.
//   - Numeric durations ("3 天", "5 小时", "2-3 天") — observation
//     windows, not the recommendation itself.
//   - Whitespace / formatting differences.
//
// What is deliberately NOT stripped (the substance):
//   - The actual advice ("维持持续观察名单", "不升级、不干预",
//     "调整主推位 + 同步提高广告出价").
//   - The judgment-style reasons ("数据缺失", "异常波动").
//   - Operator action verbs ("调整", "排查", "下架").
//   - Prerequisites and humanNeeded lists (these are stable semantic
//     content).
//
// Stability contract:
//   - The output is a STRING (so it can be a fingerprint input). The
//     exact canonical form is implementation-defined — callers must
//     NOT regex-match against the canonical strings ("第N轮", "TIME",
//     "DATE", "N DURATION") for any business logic. They are markers
//     to prove two different inputs collapse to the same canonical
//     string; they are not load-bearing semantics.
//   - The function is pure. No state, no I/O, no `Math.random`.
//   - Idempotent: `normalize(normalize(x)) === normalize(x)`.

/**
 * Normalize a free-form Agent prose string for the dedup fingerprint.
 *
 * The output is a canonical string that is stable across re-runs of
 * the same Agent judgment on the same Situation. Round counters,
 * timestamps, and durations are collapsed to fixed markers; whitespace
 * is normalized; the substance of the recommendation is preserved.
 *
 * @param text The raw recommendation / rationale / judgment text.
 * @returns A canonical string suitable for use in a content fingerprint.
 */
export const normalizeForFingerprint = (text: string): string => {
  if (!text) return '';
  return text
    // Round counters — "本情境已第 7 轮连续 missing_capability"
    //                  "本情境已第 7 轮"
    //                  "第 7 轮"
    //                  "已 7 轮"
    //                  "连续 7 轮"
    //                  "7 轮连续"
    .replace(/本情境已第\s*\d+\s*轮/g, '本情境已第N轮')
    .replace(/第\s*\d+\s*轮/g, '第N轮')
    .replace(/已\s*\d+\s*轮/g, '已N轮')
    .replace(/连续\s*\d+\s*轮/g, '连续N轮')
    .replace(/\d+\s*轮连续/g, 'N轮连续')
    // Generic round / attempt counter (Chinese-only)
    .replace(/第\s*\d+\s*次/g, '第N次')
    // Embedded timestamps — "18:56:48", "18:56"
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, 'TIME')
    // Date stamps — "2026-08-27", "2026/08/27", "08-27", "08/27"
    .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, 'DATE')
    .replace(/\d{1,2}[-/]\d{1,2}(?!\d)/g, 'DATE')
    // Numeric ranges with units — "2-3 天", "5 ~ 7 小时"
    .replace(/\d+\s*[-~到至]\s*\d+\s*(天|日|小时|分钟|秒|周|月)/g, 'N-M DURATION')
    // Single numeric durations — "3 天", "5 小时", "2 周", "30 分钟"
    .replace(/\d+\s*(天|日|小时|分钟|秒|周|月|个|条|次|人|分|时)/g, 'N DURATION')
    // Whitespace collapse
    .replace(/\s+/g, ' ')
    .trim();
};
