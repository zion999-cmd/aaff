// P0010.2.x — Time formatting for the Agent Operations Workspace.
//
// Single source of truth for "how to display a timestamp". Replaces ad-hoc
// `new Date().toLocaleString()` and `iso.slice(0, 16)` scattered across
// app.js / presentation.js.
//
// Rules (from P0010.2.x audit §6.6 + the user's IMPORTANT note):
//
//   1. Storage is UTC ISO. The agentFabric DB and the Loop write
//      `new Date().toISOString()` and never local time.
//   2. Display goes through ONE of the four functions below. The operator
//      sees local timezone (browser), but business date is always the
//      raw `YYYY-MM-DD` — never padded with `00:00:00` to fake a
//      "we have a time" promise.
//   3. Each render is one of four named modes. If you find yourself
//      hand-formatting a date in app.js, add it here instead.
//   4. "Proxy" timestamps (timestamps we know exist but did not capture
//      from the producer) MUST be marked with `≈`. The `formatProxyTime`
//      function does this — never strip the marker.
//   5. Missing timestamps render as "—" (em-dash), not as the current
//      time and not as empty string. The empty string lies.
//
// Modes:
//
//   formatLocalTime(iso)  → "2026-08-27 14:30:42"   (browser local)
//   formatUtcTime(iso)    → "2026-08-27 06:30:42Z"  (explicit UTC)
//   formatBusinessDate(iso) → "2026-08-27"            (date only, NO time)
//   formatProxyTime(iso)  → "≈2026-08-27 14:30"     (proxy marker, no sec)
//
// `now` can be injected for tests; defaults to `Date.now()` so the
// function is callable in production without a clock argument.

// ---- Internal: zero-pad to 2 digits ----

const pad2 = (n) => {
  return n < 10 ? '0' + n : String(n);
};

// ---- Internal: parse an ISO string into a Date ----
//
// `Date.parse` accepts the full ISO 8601 form. We fail soft to `null` so
// the formatters can render "—" instead of "NaN-NaN-NaN" on bad input.

const parseIso = (iso) => {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
};

// ---- formatLocalTime ----

/**
 * UTC ISO → "YYYY-MM-DD HH:mm:ss" in the BROWSER's local timezone.
 * Use this for the human-facing timeline. If the operator is in Shanghai
 * (UTC+8) and the timestamp is "2026-08-27T06:30:42Z", the output is
 * "2026-08-27 14:30:42".
 *
 * @param {string|null|undefined} iso UTC ISO string from the DB.
 * @returns {string} formatted local time, or "—" when missing/invalid.
 */
export function formatLocalTime(iso) {
  const d = parseIso(iso);
  if (!d) return '—';
  return (
    d.getFullYear() + '-' +
    pad2(d.getMonth() + 1) + '-' +
    pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' +
    pad2(d.getMinutes()) + ':' +
    pad2(d.getSeconds())
  );
}

// ---- formatUtcTime ----

/**
 * UTC ISO → "YYYY-MM-DD HH:mm:ssZ" (UTC). Use this for log/audit lines
 * where the operator wants to compare across timezones.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatUtcTime(iso) {
  const d = parseIso(iso);
  if (!d) return '—';
  return (
    d.getUTCFullYear() + '-' +
    pad2(d.getUTCMonth() + 1) + '-' +
    pad2(d.getUTCDate()) + ' ' +
    pad2(d.getUTCHours()) + ':' +
    pad2(d.getUTCMinutes()) + ':' +
    pad2(d.getUTCSeconds()) + 'Z'
  );
}

// ---- formatBusinessDate ----

/**
 * UTC ISO → "YYYY-MM-DD" (DATE ONLY, in the operator's local timezone).
 * Use this for "业务日期" fields where adding a fake "00:00:00" would
 * mislead the operator into thinking we captured a precise moment.
 *
 * IMPORTANT: never pad this with " 00:00:00" — the business date
 * intentionally hides time-of-day to make the operator read the date
 * column without inferring a fake precision.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatBusinessDate(iso) {
  const d = parseIso(iso);
  if (!d) return '—';
  return (
    d.getFullYear() + '-' +
    pad2(d.getMonth() + 1) + '-' +
    pad2(d.getDate())
  );
}

// ---- formatProxyTime ----

/**
 * UTC ISO → "≈YYYY-MM-DD HH:mm" (PROXY MARKER + truncated to minute).
 * Use this when we know a moment happened but we did not capture a true
 * producer timestamp — the `≈` is a contract with the operator that
 * "this is approximate, do not pin decisions to the minute".
 *
 * The function NEVER strips the `≈` marker. The whole point is to be
 * honest about provenance.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatProxyTime(iso) {
  const d = parseIso(iso);
  if (!d) return '—';
  return (
    '≈' +
    d.getFullYear() + '-' +
    pad2(d.getMonth() + 1) + '-' +
    pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' +
    pad2(d.getMinutes())
  );
}

// ---- formatRelative (not in initial spec, but useful for "x 秒前" chips) ----

/**
 * Format a timestamp as relative time against `now` (ms since epoch).
 * Buckets:
 *   <  60 s   → "刚刚"
 *   <  60 m   → "{n} 分钟前"
 *   <  24 h   → "{n} 小时前"
 *   <  7 d    → "{n} 天前"
 *   else      → formatBusinessDate(iso)
 *
 * This is the only formatter that compares against "now". Pass
 * `now = Date.now()` from production; pass a fixed ms in tests.
 *
 * @param {string|null|undefined} iso
 * @param {number} [now] ms since epoch
 * @returns {string}
 */
export function formatRelative(iso, now) {
  const d = parseIso(iso);
  if (!d) return '—';
  const t = now != null ? now : Date.now();
  const deltaMs = t - d.getTime();
  if (deltaMs < 0) return formatBusinessDate(iso);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const day = Math.floor(hr / 24);
  if (day < 7) return day + ' 天前';
  return formatBusinessDate(iso);
}
