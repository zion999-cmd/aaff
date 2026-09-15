// P0013 — Historical Cognitive Replay Workspace view.
//
// Reuses the existing apiGet / apiPost helpers (defined in app.js as
// `apiGet(path) -> Promise<{ status, body }>` and `apiPost(path, body)`).
// Reuses the `escHtml` helper. Does NOT poll — the Replay has its own
// user-driven clock (Phase 0 invariant: Replay clock is INDEPENDENT of
// production clock).
//
// IA mirrors the live Situation Detail:
//   - 发生了什么 (Observed Facts)
//   - Agent 当前理解 (Understanding)
//   - Agent 判断 (Judgment)
//   - Agent 建议 (Recommendation)
//   - 仍待确认 (Unknowns)
//   - 缺少的 Evidence (Evidence Gaps)
//   - Evidence (Source references)
//   - 执行状态 (Execution status: Replay Recommendation — Not Executed)

(function () {
  'use strict';

  // Tolerant of non-JSON error bodies (e.g. Express 404 HTML on stale
  // servers) — callers must never get stuck because .json() threw.
  const readBody = async (r) => {
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      return { success: false, error: 'HTTP ' + r.status + ' (非 JSON 响应: ' + text.slice(0, 120) + ')' };
    }
  };
  const apiGet = (path) =>
    fetch(path).then((r) => readBody(r).then((body) => ({ status: r.status, body })));
  const apiPost = (path, body) =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => readBody(r).then((resp) => ({ status: r.status, body: resp })));
  const escHtml = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Replay state lives on the module — survives within the same view, NOT
  // shared with other views. The Server is the source of truth (replay_runs
  // table). On F5 we re-fetch.
  //
  // P0013 G2.4-fix (2026-09-04): THREE orthogonal concepts are
  // separately tracked to avoid the historic "viewedDate vs
  // executionCursor" conflation:
  //   run.status          — server-side lifecycle (READY/RUNNING/PAUSED/COMPLETED/FAILED)
  //   run.currentBusinessDate  — execution cursor (next day to run)
  //   state.viewedDate    — pure UI: which day's snapshot the daily
  //                          view pane is currently rendering. The
  //                          operator can browse ANY persisted day
  //                          (including days before the cursor) without
  //                          advancing execution. Default = cursor
  //                          when entering the view.
  const state = {
    runId: null,
    run: null, // { id, status, currentStep, currentBusinessDate, ... }
    steps: [], // [{ step_number, business_date, status, ... }]
    // P0013+: dataset discovery result (newest acquisition on disk).
    // { rootPath, shopId, shopName, windowStart, windowEnd, windowDays, missingDates, manifestHash }
    dataset: null,
    // P0013.1: all discovered datasets (newest first) for gap resolution.
    allDatasets: [],
    acquirePollTimer: null,
    acquireInFlight: false,
    playTimer: null,
    viewedDate: null, // P0013 G2.4: pure-UI viewed date, independent of execution cursor
    // P0013.3: operator enrichments (date → rows) + marker dates + stale flag.
    enrichmentsByDate: new Map(),
    enrichedDates: [],
    enrichmentsLoadedFor: null,
    // P0013 G2.3-fix (2026-09-04): client-side concurrency lock. The
    // playTimer (setInterval 5s) used to fire advance() before the
    // previous call's kernel round-trip returned, so the runner kept
    // receiving "concurrent advance in flight" PAUSED responses and
    // the network panel showed an "infinite retry" pattern. With this
    // flag, the playTimer (and the retry/skip handlers) skip their
    // tick if an advance call is already in flight. Also drives a
    // visible "🌀 思考中 (Xs)" indicator so the operator sees the
    // kernel is working, not stuck.
    isAdvancing: false,
    advancingSince: null, // ms timestamp when the current advance started
    indicatorTimer: null, // setInterval that re-renders the elapsed counter
  };

  // ── Concurrency lock + visible indicator ─────────────────────────────

  // Toggle the client-side advance lock and (de)activate the elapsed-time
  // indicator. The runner on the server still has its own "existing
  // RUNNING" check (P0013 §22 append-only guard); this client lock just
  // prevents the view from SPAMMING that guard with overlap calls.
  const setIsAdvancing = (on) => {
    state.isAdvancing = on;
    if (on) {
      state.advancingSince = Date.now();
      if (!state.indicatorTimer) {
        state.indicatorTimer = setInterval(() => {
          // Re-render the status line so the operator sees seconds tick by.
          renderStatus();
        }, 1000);
      }
    } else {
      state.advancingSince = null;
      if (state.indicatorTimer) {
        clearInterval(state.indicatorTimer);
        state.indicatorTimer = null;
      }
    }
    renderStatus();
  };

  const elapsedSeconds = () => {
    if (!state.advancingSince) return 0;
    return Math.floor((Date.now() - state.advancingSince) / 1000);
  };

  // ── Control state machine (P0013 G2.4-fix) ──────────────────────────
  //
  // Single source of truth for the replay control bar. ALL button
  // enabled/disabled/label/click behavior is derived from this one
  // function. The DOM is stable: 6 buttons always present, only their
  // attributes change.
  //
  // Inputs:
  //   run          — replay_runs row (server lifecycle)
  //   currentStep  — latest replay_run_steps row (if any), the
  //                  "active" step whose status drives UI state when
  //                  run.status is RUNNING/PAUSED
  //   viewedDate   — pure UI: which day the daily view is showing
  //   steps        — full list of steps for navigation math
  //   isAdvancing  — client lock (kernel call in flight)
  //   isPlaying    — local playTimer active
  //
  // Returns: { uiState, prev, next, exec, retry, skip, restart }
  // where each control is { enabled, label?, reason?, mode?, click? }
  // and uiState is one of:
  //   READY | RUNNING_ACTIVE | RUNNING_IDLE | PAUSED | STEP_FAILED | COMPLETED
  const deriveReplayControls = () => {
    const run = state.run;
    if (!run) return null; // no run → no controls derived

    const currentStep =
      state.steps && state.steps.length > 0 ? state.steps[state.steps.length - 1] : null;
    const viewedDate = state.viewedDate || run.currentBusinessDate || run.startBusinessDate;
    const executionCursor = run.currentBusinessDate;
    const firstDate = run.startBusinessDate;
    const lastDate = run.endBusinessDate;
    const isAdvancing = state.isAdvancing;
    const isPlaying = state.playTimer !== null;

    // Derive the 5-state UI state. STEP_FAILED overrides the run.status
    // because a FAILED current step is the operator's primary concern,
    // regardless of whether the run as a whole is RUNNING/PAUSED/FAILED.
    //
    // P0013 G2.5-fix (2026-09-04): run.status='RUNNING' alone is NOT
    // a "kernel in flight" signal — the runner only flips run.status
    // on pause/complete/fail. Between steps, run.status stays RUNNING
    // while the kernel is idle waiting for the next operator click.
    // The "kernel in flight" signal is currentStep.status === 'RUNNING'.
    // We split RUNNING into:
    //   RUNNING_ACTIVE   — kernel is in flight, lock the next button
    //   RUNNING_IDLE     — run is active but no kernel in flight,
    //                       next button should be enabled to drive
    //                       the next step's execution
    // Both render the same exec label "⏸ 暂停" (run is still
    // pausable) and same retry/skip gating (only RUNNING_ACTIVE has
    // a step to recover).
    const uiState = (() => {
      const s = run.status;
      if (s === 'COMPLETED') return 'COMPLETED';
      if (s === 'FAILED') return 'STEP_FAILED';
      if (s === 'READY') return 'READY';
      if (s === 'PAUSED') {
        if (currentStep && (currentStep.status === 'FAILED' || currentStep.status === 'RUNNING')) {
          return 'STEP_FAILED';
        }
        return 'PAUSED';
      }
      if (s === 'RUNNING') {
        if (currentStep && currentStep.status === 'FAILED') return 'STEP_FAILED';
        if (currentStep && currentStep.status === 'RUNNING') return 'RUNNING_ACTIVE';
        return 'RUNNING_IDLE';
      }
      return 'READY';
    })();

    // Set of business_dates that have a persisted step row. Used for
    // navigation math (does a "next" day exist that the operator can
    // browse?).
    const persistedDates = new Set(
      (state.steps || [])
        .filter((s) => s.business_date)
        .map((s) => s.business_date),
    );
    const sortedPersisted = Array.from(persistedDates).sort();
    const nextPersisted = sortedPersisted.find((d) => d > viewedDate) || null;
    const prevPersisted = [...sortedPersisted].reverse().find((d) => d < viewedDate) || null;

    // ── prev (上一天) — pure navigation ──
    const prev = (() => {
      if (viewedDate <= firstDate) {
        return { enabled: false, reason: '当前已是第一天' };
      }
      // If previous persisted day exists OR the window allows going
      // back, enable. (Even if no step row exists for the prev day,
      // the daily view can render "no cognition yet" — that's a
      // valid browse state.)
      return { enabled: true };
    })();

    // ── next (下一天) — navigation OR execution ──
    // G2.5-fix: split RUNNING into ACTIVE (kernel in flight → lock)
    // and IDLE (run active but kernel idle, at frontier → enable
    // execution so the operator can drive the next day). This is
    // the root-cause fix for "永远都只能第一天".
    //
    // G2.6-fix (2026-09-04): the original atFrontier formula
    // `viewedDate === executionCursor` was too strict. After step N
    // completes, viewedDate stays on the just-ran day (one behind
    // cursor), so atFrontier was always false. The real frontier is:
    //   "cursor is the next unexecuted day AND viewedDate is on or
    //    exactly one day before cursor"
    // i.e. execute iff cursor has no step row AND
    //   (viewedDate === cursor OR viewedPlus1 === cursor).
    const cursorHasStep =
      executionCursor !== null &&
      executionCursor !== undefined &&
      persistedDates.has(executionCursor);
    const viewedPlus1 = nextWindowDate(viewedDate);
    const isAtExecuteFrontier =
      executionCursor !== null &&
      executionCursor !== undefined &&
      !cursorHasStep &&
      (viewedDate === executionCursor || viewedPlus1 === executionCursor);
    const next = (() => {
      if (uiState === 'RUNNING_ACTIVE') {
        // Mid-execution: next is locked (kernel is the only driver).
        return { enabled: false, reason: '当前 step 正在执行' };
      }
      if (uiState === 'STEP_FAILED') {
        return { enabled: false, reason: '当前 step 失败, 请重试或跳过' };
      }
      if (uiState === 'COMPLETED') {
        if (nextPersisted) return { enabled: true, label: '▶ 下一天', mode: 'navigate' };
        return { enabled: false, reason: '已到最后一天' };
      }
      // READY, RUNNING_IDLE, PAUSED — same logic.
      if (isAtExecuteFrontier) {
        return { enabled: !isAdvancing, label: '▶ 下一天 (执行)', mode: 'execute' };
      }
      if (nextPersisted) {
        // A later persisted day exists — pure navigation to it.
        return { enabled: true, label: '▶ 下一天 (查看)', mode: 'navigate' };
      }
      return { enabled: false, reason: '下一天尚未执行' };
    })();

    // ── exec (连续回放 / 暂停 / 继续) — single slot, label rotates ──
    // P0013 P1-1/P1-2-fix (2026-09-04): the canonical signal for
    // "continuous replay is playing" is `state.playTimer` (UI autoplay
    // state), NOT `run.status` (server lifecycle). The three orthogonal
    // concepts are:
    //   1. run.status         — server lifecycle (READY/RUNNING/PAUSED/...)
    //   2. execution cursor   — run.currentBusinessDate
    //   3. viewed date        — state.viewedDate (pure UI)
    //   4. continuous play    — state.playTimer !== null (NEW, separate)
    // Mapping (canonical semantics):
    //   playTimer active                            → "⏸ 暂停", mode=pause
    //   run.status==='PAUSED' && !playTimer         → "▶ 继续", mode=resume
    //   uiState ∈ {READY, RUNNING_IDLE} && !playTimer → "▶ 连续回放", mode=play
    //   otherwise                                    → disabled
    // P1-2: this also fixes the "READY + isPlaying=true → 连续回放
    // disabled for 5s" window — the moment playTimer is set, exec
    // re-derives to "⏸ 暂停" enabled, so the operator can stop the
    // first scheduled advance.
    const exec = (() => {
      if (isPlaying) {
        // Continuous play is active. Always offer to pause it, no
        // matter what run.status is.
        return { enabled: !isAdvancing, label: '⏸ 暂停', mode: 'pause' };
      }
      if (uiState === 'PAUSED') {
        return { enabled: !isAdvancing, label: '▶ 继续', mode: 'resume' };
      }
      if (uiState === 'STEP_FAILED') {
        return { enabled: false, label: '连续回放', reason: '当前 step 失败, 无法自动执行' };
      }
      if (uiState === 'COMPLETED') {
        return { enabled: false, label: '已完成', reason: '回放已完成' };
      }
      if (uiState === 'RUNNING_ACTIVE') {
        // Kernel mid-flight. Don't start a parallel autoplay; the
        // kernel is the driver. Once it returns, uiState becomes
        // RUNNING_IDLE and play becomes available.
        return { enabled: false, label: '▶ 连续回放', reason: '当前 step 正在执行' };
      }
      // READY, RUNNING_IDLE — run can accept more execution and
      // playTimer is not active, so the operator can start autoplay.
      return { enabled: !isAdvancing, label: '▶ 连续回放', mode: 'play' };
    })();

    // ── retry (重试这一天) — current execution day re-run ──
    // G2.5-fix: only RUNNING_ACTIVE has a stuck-RUNNING-step to
    // recover. RUNNING_IDLE's current step is COMPLETED and doesn't
    // need a retry.
    const retry = (() => {
      if (uiState === 'STEP_FAILED') {
        return { enabled: !isAdvancing, reason: '重新执行当前失败的 step' };
      }
      if (uiState === 'RUNNING_ACTIVE') {
        // Orphan RUNNING at frontier (kernel stuck mid-flight)
        return { enabled: !isAdvancing, reason: '重置当前卡住的 RUNNING step' };
      }
      return { enabled: false, reason: '当前 step 不需要重试' };
    })();

    // ── skip (跳过这一天) — abandon current step, mark SKIPPED_NO_DATA ──
    // G2.5-fix: skip only makes sense when the current step is in a
    // non-terminal stuck/failed state. RUNNING_IDLE's current step is
    // already COMPLETED — there's nothing to abandon.
    const skip = (() => {
      if (uiState === 'STEP_FAILED') {
        return { enabled: !isAdvancing, reason: '明确放弃当前 step, 标记 SKIPPED_NO_DATA' };
      }
      if (uiState === 'RUNNING_ACTIVE') {
        // Orphan RUNNING at frontier — skip is also a recovery path
        return { enabled: !isAdvancing, reason: '放弃当前卡住的 step' };
      }
      if (uiState === 'PAUSED' && currentStep && currentStep.status === 'RUNNING') {
        // Paused while a kernel is mid-flight (rare: operator pauses
        // between start and completion). The step row is still RUNNING.
        return { enabled: !isAdvancing, reason: '放弃当前卡住的 step' };
      }
      return { enabled: false, reason: '当前不能跳过' };
    })();

    // ── restart (重新回放) — back to the start panel ──
    // P0013.3 repair: never present the unreachable "请先暂停" state.
    // The click handler itself pauses the scheduler (existing runner
    // capability) before leaving; a step mid-flight disables until it
    // completes (the control explains the transient wait).
    const restart = (() => {
      if (uiState === 'RUNNING_ACTIVE') {
        return { enabled: false, reason: '当前 step 执行中，完成后即可重新回放（无需手动暂停）' };
      }
      return { enabled: true, reason: null };
    })();

    return {
      uiState,
      executionCursor,
      viewedDate,
      prev,
      next,
      exec,
      retry,
      skip,
      restart,
      nextPersisted,
      prevPersisted,
    };
  };

  // Apply a single control's state to a DOM button. NEVER removes the
  // button — only sets disabled, textContent, and title.
  const setControlState = (btn, ctrl) => {
    if (!btn) return;
    if (!ctrl) {
      btn.disabled = true;
      return;
    }
    btn.disabled = !ctrl.enabled;
    if (ctrl.label) btn.textContent = ctrl.label;
    if (ctrl.reason) {
      btn.title = ctrl.reason;
    } else {
      btn.removeAttribute('title');
    }
  };

  // The single entry point that re-derives and applies all 6 controls.
  // Called from refreshRunState and after every action (start, advance,
  // retry, skip, pause, resume, restart, view-change).
  const applyControls = () => {
    const ctrls = deriveReplayControls();
    if (!ctrls) return;
    setControlState(document.getElementById('replayPrevBtn'), ctrls.prev);
    setControlState(document.getElementById('replayNextBtn'), ctrls.next);
    setControlState(document.getElementById('replayExecBtn'), ctrls.exec);
    setControlState(document.getElementById('replayRetryBtn'), ctrls.retry);
    setControlState(document.getElementById('replaySkipBtn'), ctrls.skip);
    setControlState(document.getElementById('replayRestartBtn'), ctrls.restart);
  };

  // ── Start panel (P0013+: dataset discovery, no hardcoded window) ──────

  // P0013+ fix (2026-09-12): the date inputs live ONLY in the start panel.
  // Previously 重新回放 POSTed a new run immediately, reading the hidden
  // inputs (always full-window defaults) — the operator could never reach
  // the range selector after the first run. Now 重新回放 returns here:
  // hide the run surfaces, prefill the inputs with the abandoned run's
  // window so the operator can edit it, and let 开始回放 create the run.
  const showStartPanel = () => {
    stopPlay();
    stopAcquirePolling();
    state.acquireInFlight = false;
    hideGapSection();
    const controls = document.getElementById('replayControls');
    if (controls) controls.style.display = 'none';
    const timeline = document.getElementById('replayTimeline');
    if (timeline) timeline.style.display = 'none';
    const daily = document.getElementById('replayDailyView');
    if (daily) daily.style.display = 'none';
    const review = document.getElementById('replayMonthlyReview');
    if (review) review.style.display = 'none';
    const start = document.getElementById('replayStartPanel');
    if (start) start.style.display = '';
    // Prefill from the run being abandoned (refreshDatasetPanel only fills
    // empty inputs, so these values survive the fetch).
    const startInput = document.getElementById('replayStartDate');
    const endInput = document.getElementById('replayEndDate');
    if (state.run) {
      if (startInput && state.run.startBusinessDate) startInput.value = state.run.startBusinessDate;
      if (endInput && state.run.endBusinessDate) endInput.value = state.run.endBusinessDate;
    }
    refreshDatasetPanel();
  };

  // Fetch GET /api/replay/datasets and render the panel: shop, coverage,
  // date-input bounds/defaults, day count. The panel NEVER trusts literals
  // — the server is the authority for window, hash, and dataset path.
  const refreshDatasetPanel = async () => {
    const shopEl = document.getElementById('replayShopName');
    const rangeEl = document.getElementById('replayDatasetRange');
    const coverageEl = document.getElementById('replayCoverageText');
    const noticeEl = document.getElementById('replayDatasetNotice');
    const startInput = document.getElementById('replayStartDate');
    const endInput = document.getElementById('replayEndDate');
    const btn = document.getElementById('replayStartBtn');
    if (shopEl) shopEl.textContent = '加载中…';
    const result = await apiGet('/api/replay/datasets');
    if (result.status !== 200 || !result.body.success) {
      state.dataset = null;
      if (shopEl) shopEl.textContent = '数据集发现失败';
      if (rangeEl) rangeEl.textContent = '—';
      if (noticeEl) {
        noticeEl.style.display = '';
        noticeEl.textContent = '无法获取历史数据集: ' + (result.body?.error || result.status);
      }
      if (btn) btn.disabled = true;
      return;
    }
    const list = Array.isArray(result.body.data?.datasets) ? result.body.data.datasets : [];
    state.allDatasets = list;
    if (list.length === 0) {
      state.dataset = null;
      if (shopEl) shopEl.textContent = '—';
      if (rangeEl) rangeEl.textContent = '无可用历史数据集（可在下方发起真实采集）';
      if (coverageEl) coverageEl.textContent = '—';
      if (btn) btn.disabled = true;
      const acquireBtn0 = document.getElementById('replayAcquireBtn');
      if (acquireBtn0) acquireBtn0.disabled = true;
      if (startInput) startInput.disabled = false;
      if (endInput) endInput.disabled = false;
      return;
    }
    // Newest acquisition window first (server sorts). Multiple datasets are
    // not selectable yet (YAGNI); gap resolution considers all of them.
    const ds = list[0];
    state.dataset = ds;
    if (shopEl) shopEl.textContent = ds.shopName;
    if (rangeEl) {
      rangeEl.textContent = ds.windowStart + ' → ' + ds.windowEnd + ' (' + ds.windowDays + ' 天)';
    }
    if (coverageEl) {
      coverageEl.textContent =
        ds.missingDates === 0
          ? ds.windowDays + ' 天 (完整)'
          : ds.windowDays - ds.missingDates + ' / ' + ds.windowDays + ' 天 (缺 ' + ds.missingDates + ' 天)';
    }
    // P0013.1: inputs are NOT bounded to dataset coverage — a need beyond
    // coverage is a legal business request routed to real acquisition.
    [startInput, endInput].forEach((el) => {
      if (el) {
        el.removeAttribute('min');
        el.removeAttribute('max');
        el.disabled = false;
        el.onchange = updateRangeDays;
      }
    });
    // Default to the full window; preserve an in-progress operator choice
    // across view re-entries.
    if (startInput && !startInput.value) startInput.value = ds.windowStart;
    if (endInput && !endInput.value) endInput.value = ds.windowEnd;
    if (btn) btn.disabled = false;
    const acquireBtn = document.getElementById('replayAcquireBtn');
    if (acquireBtn && !state.acquireInFlight) acquireBtn.disabled = false;
    updateRangeDays();
    if (noticeEl) {
      const skipped = Array.isArray(result.body.data?.skipped) ? result.body.data.skipped : [];
      if (skipped.length > 0) {
        noticeEl.style.display = '';
        noticeEl.textContent = '注意: 已跳过无法加载的数据集目录: ' + skipped.map((s) => s.dirName).join(', ');
      }
    }
  };

  const updateRangeDays = () => {
    const daysEl = document.getElementById('replayRangeDays');
    const startInput = document.getElementById('replayStartDate');
    const endInput = document.getElementById('replayEndDate');
    if (!daysEl || !startInput || !endInput) return;
    const n = enumerateDates(startInput.value, endInput.value).length;
    daysEl.textContent = n > 0 ? '共 ' + n + ' 天' : '区间无效';
  };

  // Read + validate the two date inputs. Returns { start, end } or { error }.
  // P0013.1: out-of-coverage dates are NOT an error — they express a
  // business need routed to real acquisition.
  const readRequestedWindow = () => {
    const startInput = document.getElementById('replayStartDate');
    const endInput = document.getElementById('replayEndDate');
    const start = startInput ? startInput.value : '';
    const end = endInput ? endInput.value : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { error: '请选择合法的起止日期 (YYYY-MM-DD)' };
    }
    if (start > end) return { error: '起始日期不能晚于结束日期' };
    return { start, end };
  };

  // V1 coverage = ONE self-contained dataset containing every requested
  // date (no dataset merge). Mirrors the server gap resolver; server stays
  // the authority and re-checks on POST.
  const findCoveringDataset = (start, end) => {
    const all = Array.isArray(state.allDatasets) && state.allDatasets.length > 0
      ? state.allDatasets
      : (state.dataset ? [state.dataset] : []);
    const dates = enumerateDates(start, end);
    return (
      all.find((ds) => {
        if (ds.windowStart > start || ds.windowEnd < end) return false;
        const holes = new Set(Array.isArray(ds.missingDateList) ? ds.missingDateList : []);
        return dates.every((d) => !holes.has(d));
      }) || null
    );
  };

  // Build the POST /runs body. Returns { body } or { gap } or { error }.
  const buildCreateBody = () => {
    const win = readRequestedWindow();
    if (win.error) return { error: win.error };
    const covered = findCoveringDataset(win.start, win.end);
    if (!covered) return { gap: { start: win.start, end: win.end } };
    return {
      body: {
        shopId: covered.shopId,
        shopName: covered.shopName,
        // Absolute path from discovery; the server re-resolves and reads
        // the real manifest hash itself (no client-supplied hash).
        sourceDatasetPath: covered.rootPath,
        startBusinessDate: win.start,
        endBusinessDate: win.end,
      },
    };
  };

  const showGapSection = (start, end) => {
    const section = document.getElementById('replayGapSection');
    const text = document.getElementById('replayGapText');
    const status = document.getElementById('replayAcquireStatus');
    const ranges = (state.allDatasets || [])
      .map((ds) => ds.windowStart + ' → ' + ds.windowEnd)
      .join('；');
    if (text) {
      text.textContent =
        '请求区间 ' + start + ' → ' + end +
        ' 超出已冻结数据覆盖（现有: ' + (ranges || '无') + '）。';
    }
    if (status) status.textContent = '';
    if (section) section.style.display = '';
  };

  const hideGapSection = () => {
    const section = document.getElementById('replayGapSection');
    if (section) section.style.display = 'none';
    const detail = document.getElementById('replayAcquireDetail');
    if (detail) detail.style.display = 'none';
  };

  const setAcquireStatus = (message, isError) => {
    const status = document.getElementById('replayAcquireStatus');
    if (status) {
      status.textContent = message;
      status.style.color = isError ? '#b00020' : '';
    }
  };

  const stopAcquirePolling = () => {
    if (state.acquirePollTimer) {
      clearInterval(state.acquirePollTimer);
      state.acquirePollTimer = null;
    }
  };

  // Neutral operator-facing labels for agent tool names. The raw names
  // stay in the on-disk trajectory for audit; the panel never prints
  // acquisition-implementation vocabulary.
  const ACQUIRE_TOOL_LABELS = {
    terminal: '执行操作',
    read_file: '读取文件',
    write_file: '写入文件',
    patch: '修改文件',
    search_files: '搜索文件',
    vision_analyze: '核验截图',
    execute_code: '执行代码',
    todo: '规划任务',
    browser_exec: '浏览器操作',
  };

  const fmtEventTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
  };

  const renderAcquireEvents = (payload) => {
    const detail = document.getElementById('replayAcquireDetail');
    const log = document.getElementById('replayAcquireLog');
    if (!detail || !log) return;
    const events = Array.isArray(payload.events) ? payload.events : [];
    if (events.length === 0) return;
    detail.style.display = '';
    const lines = [];
    let lastDelta = '';
    for (const e of events) {
      const t = fmtEventTime(e.at);
      if (e.kind === 'tool.start') {
        lines.push(
          '<div>[' + escHtml(t) + '] ▶ ' + escHtml(ACQUIRE_TOOL_LABELS[e.name] || 'Agent 动作') + '</div>',
        );
      } else if (e.kind === 'tool.complete') {
        lines.push(
          '<div>[' + escHtml(t) + '] ✓ ' +
          escHtml(ACQUIRE_TOOL_LABELS[e.name] || 'Agent 动作') +
          (e.duration_s != null ? ' (' + e.duration_s + 's)' : '') + '</div>',
        );
      } else if (e.kind === 'message.delta' && e.text) {
        lastDelta = e.text;
      } else if (e.kind === 'turn.start') {
        lines.push('<div>[' + escHtml(t) + '] 采集开始</div>');
      } else if (e.kind === 'turn.result') {
        lines.push('<div>[' + escHtml(t) + '] 回合结束</div>');
      }
    }
    if (lastDelta) {
      lines.push('<div class="muted" style="margin-top:4px">Agent: ' + escHtml(lastDelta) + '</div>');
    }
    log.innerHTML = lines.slice(-80).join('');
    log.scrollTop = log.scrollHeight;
  };

  const finishAcquireUi = (job, btn) => {
    stopAcquirePolling();
    state.acquireInFlight = false;
    if (btn) btn.disabled = false;
    if (job.status === 'SUCCEEDED') {
      setAcquireStatus(
        '采集完成并已冻结: 实际覆盖 ' + (job.actualStart || '?') + ' → ' + (job.actualEnd || '?') +
        '。数据集已加入发现列表，请确认区间后点「开始历史回放」。',
      );
      void refreshDatasetPanel().then(() => {
        // Clamp the request to what the source actually provided.
        const startInput = document.getElementById('replayStartDate');
        const endInput = document.getElementById('replayEndDate');
        if (startInput && job.actualStart) startInput.value = job.actualStart;
        if (endInput && job.actualEnd) endInput.value = job.actualEnd;
        updateRangeDays();
        hideGapSection();
      });
    } else {
      setAcquireStatus(
        '采集未成功: ' + job.status + (job.failureCode ? ' (' + job.failureCode + ')' : '') +
        (job.errorMessage ? ' — ' + job.errorMessage : ''),
        true,
      );
    }
  };

  const pollAcquireJob = (jobId, btn, startedAt) => {
    stopAcquirePolling();
    state.acquirePollTimer = setInterval(async () => {
      const [jobR, eventsR] = await Promise.all([
        apiGet('/api/replay/acquisitions/' + jobId),
        apiGet('/api/replay/acquisitions/' + jobId + '/events'),
      ]);
      if (jobR.status === 200 && jobR.body.success && eventsR.status === 200 && eventsR.body.success) {
        renderAcquireEvents(eventsR.body.data);
      }
      if (jobR.status !== 200 || !jobR.body.success) return;
      const job = jobR.body.data;
      if (job.status === 'RUNNING' || job.status === 'QUEUED') {
        const mins = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 60000)) : 0;
        const steps = eventsR.body?.data?.toolCalls ?? 0;
        setAcquireStatus(
          '真实采集进行中: ' + job.status + ' — 已 ' + mins + ' 分钟、约 ' + steps +
          ' 个动作（约需 10–30 分钟，请保持商智登录，可展开执行轨迹查看进度）…',
        );
        return;
      }
      finishAcquireUi(job, btn);
    }, 3000);
  };

  const onAcquireClick = async () => {
    if (state.acquireInFlight) return;
    const win = readRequestedWindow();
    if (win.error) {
      alert(win.error);
      return;
    }
    const ds = state.dataset;
    if (!ds) {
      setAcquireStatus('缺少店铺身份：尚无已发现数据集，无法发起采集。', true);
      return;
    }
    const btn = document.getElementById('replayAcquireBtn');
    state.acquireInFlight = true;
    if (btn) btn.disabled = true;
    setAcquireStatus('正在创建真实采集任务…');
    let created;
    try {
      created = await apiPost('/api/replay/acquisitions', {
        shopId: ds.shopId,
        shopName: ds.shopName,
        startBusinessDate: win.start,
        endBusinessDate: win.end,
      });
    } catch (err) {
      state.acquireInFlight = false;
      if (btn) btn.disabled = false;
      setAcquireStatus('采集任务请求失败（服务可能未重启/不可达）: ' + (err && err.message ? err.message : err), true);
      return;
    }
    if (created.status !== 201 || !created.body.success) {
      state.acquireInFlight = false;
      if (btn) btn.disabled = false;
      setAcquireStatus('采集任务创建失败: ' + (created.body.error || created.status), true);
      return;
    }
    const jobId = created.body.data.jobId;
    setAcquireStatus('采集任务已提交 (' + jobId + ')，等待真实采集与对账冻结…');
    pollAcquireJob(jobId, btn, Date.now());
  };

  const onStartClick = async () => {
    hideGapSection();
    const built = buildCreateBody();
    if (built.error) {
      alert(built.error);
      return;
    }
    if (built.gap) {
      showGapSection(built.gap.start, built.gap.end);
      return;
    }
    const btn = document.getElementById('replayStartBtn');
    if (btn) btn.disabled = true;
    const result = await apiPost('/api/replay/runs', built.body);
    if (btn) btn.disabled = false;
    if (result.status === 200 && result.body.success) {
      state.runId = result.body.data.runId;
      await refreshRunState();
      // P0013 G2.4: initialize viewedDate to the execution cursor
      // (the just-created run starts at startBusinessDate).
      if (state.run) state.viewedDate = state.run.currentBusinessDate;
      showControls();
      showTimeline();
    } else {
      alert('回放启动失败: ' + (result.body.error || '未知错误'));
    }
  };

  // ── Run state ────────────────────────────────────────────────────────

  const refreshRunState = async () => {
    if (!state.runId) return;
    const result = await apiGet('/api/replay/runs/' + state.runId);
    if (result.status === 200 && result.body.success) {
      state.run = result.body.data;
      const steps = await apiGet('/api/replay/runs/' + state.runId + '/steps');
      if (steps.status === 200 && steps.body.success) {
        state.steps = steps.body.data || [];
      }
      // P0013.3 — load operator enrichments (timeline markers + day pane).
      const enr = await apiGet('/api/replay/runs/' + state.runId + '/enrichments');
      if (enr.status === 200 && enr.body.success) {
        const byDate = new Map();
        (enr.body.data.enrichments || []).forEach((e) => {
          if (!byDate.has(e.businessDate)) byDate.set(e.businessDate, []);
          byDate.get(e.businessDate).push(e);
        });
        state.enrichmentsByDate = byDate;
        state.enrichedDates = enr.body.data.enrichedDates || [];
        state.enrichmentsLoadedFor = state.runId;
      }
      renderTimeline();
      renderStaleBanner();
      renderStatus();
      applyControls();
      if (state.viewedDate) renderEnrichmentPane(state.viewedDate);
    }
  };

  // P0013 G2.4-fix (2026-09-04): applyControls is now the single
  // function that updates the 6 stable buttons' enabled/disabled/label
  // /title state. The old updateControlVisibility toggled
  // `style.display = 'none'`, which violated the "no disappearing
  // controls" hard rule. The DOM structure of #replayControls is now
  // FIXED: 6 buttons + 3 separators + 1 status text, always present
  // (when a run exists). State changes flow through deriveReplayControls.
  // (Kept the name applyControls to call out the contract change.)

  // ── Controls ─────────────────────────────────────────────────────────

  const onRestartClick = async () => {
    // P0013+ fix: restart returns to the start panel (the old run stays
    // in DB untouched). P0013.3 repair — no "please pause first" dead
    // end: if the scheduler is idle-RUNNING we pause it ourselves
    // (existing pauseReplayRun capability via advance mode=pause); if a
    // step is mid-flight the button is disabled by deriveReplayControls
    // until it completes. PAUSED runs need no action.
    // eslint-disable-next-line no-console
    console.log('[replay] control clicked: restart → back to start panel', 'currentRunId=', state.runId, 'status=', state.run && state.run.status);
    if (state.run && state.run.status === 'RUNNING') {
      const stepRunning = (state.steps || []).some((s) => s.status === 'RUNNING');
      if (stepRunning) return; // control disabled; transient wait
      stopPlay();
      await apiPost('/api/replay/runs/' + state.runId + '/advance', { mode: 'pause' });
      await refreshRunState();
    }
    showStartPanel();
  };

  // The 6 stable buttons are bound to their handlers EXACTLY ONCE
  // (P0013 P0-1-fix, 2026-09-04). Previous implementation called
  // addEventListener inside showControls() every time it ran, which
  // caused:
  //   - duplicate advance requests on every click after the first
  //     re-entry (start / restart / view-switch)
  //   - duplicate restart Run creation
  //   - multiple play timers (setInterval) that the stopPlay path
  //     could not drain
  // We use `btn.onclick = ...` (which overwrites any prior binding)
  // and gate the entire binding block behind a one-time guard. The
  // guard lives at module scope so it survives re-entries of
  // loadReplay / onRestartClick / view-leave-handler churn.
  let controlsBound = false;
  const bindControlHandlers = () => {
    if (controlsBound) return;
    const prevBtn = document.getElementById('replayPrevBtn');
    const nextBtn = document.getElementById('replayNextBtn');
    const execBtn = document.getElementById('replayExecBtn');
    const retryBtn = document.getElementById('replayRetryBtn');
    const skipBtn = document.getElementById('replaySkipBtn');
    const restartBtn = document.getElementById('replayRestartBtn');
    if (prevBtn) prevBtn.onclick = onPrevClick;
    if (nextBtn) nextBtn.onclick = onNextClick;
    if (execBtn) execBtn.onclick = onExecClick;
    if (retryBtn) retryBtn.onclick = onRetryClick;
    if (skipBtn) skipBtn.onclick = onSkipClick;
    if (restartBtn) restartBtn.onclick = onRestartClick;
    // P0013.3 — enrichment + stale continuous replay (bound once).
    const enrSave = document.getElementById('replayEnrichmentSaveBtn');
    const enrRerun = document.getElementById('replayEnrichmentRerunBtn');
    const rerunStale = document.getElementById('replayRerunStaleBtn');
    if (enrSave) enrSave.onclick = () => submitEnrichment(false);
    if (enrRerun) enrRerun.onclick = () => submitEnrichment(true);
    if (rerunStale) {
      rerunStale.onclick = async () => {
        rerunStale.disabled = true;
        const r = await apiPost('/api/replay/runs/' + state.runId + '/rerun', { mode: 'stale' });
        await refreshRunState();
        if (state.viewedDate) renderDailyView(state.viewedDate);
        rerunStale.disabled = false;
        if (r.status !== 200 || !r.body.success) {
          alert('连续重放失败: ' + ((r.body && r.body.error) || r.status));
        }
      };
    }
    controlsBound = true;
    // eslint-disable-next-line no-console
    console.log('[replay] controls bound: prev/next/exec/retry/skip/restart (6 stable, one-time)');
  };

  const showControls = () => {
    const el = document.getElementById('replayControls');
    if (el) el.style.display = '';
    const start = document.getElementById('replayStartPanel');
    if (start) start.style.display = 'none';
    // Bind handlers EXACTLY ONCE per page-load. The guard inside
    // bindControlHandlers ensures subsequent showControls() calls
    // (from onStartClick, onRestartClick, refreshRunState) only
    // toggle visibility and re-apply the state-machine output.
    bindControlHandlers();
    // P0013 G2.4: apply controls immediately so the buttons reflect
    // the current state on first render. Critical for orphan RUNNING
    // runs: the pause label must be "⏸ 暂停" (not the default "▶ 连
    // 续回放") on page load, BEFORE the operator clicks anything.
    applyControls();
  };

  // P0013 G2.4-fix: pure navigation. Moves state.viewedDate to the
  // previous persisted day (or the previous window day if no step
  // row exists). Does NOT touch the execution cursor. Does NOT call
  // the server. Re-renders the daily view pane.
  const onPrevClick = async () => {
    // eslint-disable-next-line no-console
    console.log('[replay] control clicked: prev', 'viewedDate=', state.viewedDate);
    const ctrls = deriveReplayControls();
    if (!ctrls || !ctrls.prev.enabled) return;
    const target = ctrls.prevPersisted || previousWindowDate(state.viewedDate, ctrls);
    if (!target) return;
    state.viewedDate = target;
    await renderDailyView(target);
    applyControls();
  };

  // P0013 G2.4-fix: dual semantic. If viewedDate is at the execution
  // frontier and run allows execution, this triggers the actual
  // advance API. Otherwise it is pure navigation to the next
  // persisted day.
  const onNextClick = async () => {
    // eslint-disable-next-line no-console
    console.log('[replay] control clicked: next', 'viewedDate=', state.viewedDate, 'cursor=', state.run && state.run.currentBusinessDate);
    const ctrls = deriveReplayControls();
    if (!ctrls || !ctrls.next.enabled) return;
    // P0013 G2.3-fix: client-side concurrency lock.
    if (state.isAdvancing) {
      // eslint-disable-next-line no-console
      console.log('[replay] next skipped: previous advance still in flight (', elapsedSeconds(), 's)');
      return;
    }
    if (ctrls.next.mode === 'navigate') {
      // Pure navigation: just move viewedDate. No server call.
      const target = ctrls.nextPersisted || nextWindowDate(state.viewedDate, ctrls);
      if (!target) return;
      state.viewedDate = target;
      await renderDailyView(target);
      applyControls();
      return;
    }
    // mode === 'execute' — actually advance the run.
    setIsAdvancing(true);
    try {
      const result = await apiPost('/api/replay/runs/' + state.runId + '/advance', { mode: 'step' });
      // eslint-disable-next-line no-console
      console.log('[replay] advance result:', result.status, result.body?.data?.state?.currentStep, result.body?.data?.state?.currentBusinessDate);
      if (result.status === 200 && result.body.success) {
        await refreshRunState();
        // P0013 F-fix (2026-09-03): render the just-completed day, not
        // the already-advanced cursor. Source: latest step in
        // state.steps (refreshRunState loaded it from /steps).
        const justRanDate = pickJustRanDate();
        if (justRanDate) {
          state.viewedDate = justRanDate;
          await renderDailyView(justRanDate);
        }
        if (state.run && state.run.status === 'COMPLETED') {
          stopPlay();
          await renderMonthlyReviewIfAny();
        }
      } else {
        // eslint-disable-next-line no-console
        console.error('[replay] advance failed:', result.status, result.body);
        alert('回放下一天失败: ' + (result.body?.error || '未知错误'));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[replay] advance threw:', err);
      alert('回放下一天异常: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsAdvancing(false);
    }
  };

  // P0013 G2.4-fix: unified execution control. Replaces onPlayClick +
  // onPauseClick. Dispatches by deriveReplayControls().exec.mode:
  //   mode === 'play'   → start the local playTimer
  //   mode === 'pause'  → stop local timer + flip DB to PAUSED
  //   mode === 'resume' → flip DB to RUNNING + start local playTimer
  const onExecClick = async () => {
    // eslint-disable-next-line no-console
    console.log('[replay] control clicked: exec', 'runId=', state.runId, 'status=', state.run && state.run.status);
    const ctrls = deriveReplayControls();
    if (!ctrls || !ctrls.exec.enabled) return;
    const mode = ctrls.exec.mode;
    if (mode === 'pause') {
      stopPlay();
      if (!state.runId) return;
      try {
        const result = await apiPost('/api/replay/runs/' + state.runId + '/advance', { mode: 'pause' });
        if (result.status === 200 && result.body.success) {
          await refreshRunState();
        } else {
          // eslint-disable-next-line no-console
          console.error('[replay] server pause failed:', result.status, result.body);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[replay] server pause threw:', err);
      }
      return;
    }
    if (mode === 'resume') {
      if (!state.runId) return;
      try {
        const result = await apiPost('/api/replay/runs/' + state.runId + '/advance', { mode: 'resume' });
        if (result.status === 200 && result.body.success) {
          await refreshRunState();
        } else {
          // eslint-disable-next-line no-console
          console.error('[replay] server resume failed:', result.status, result.body);
          return;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[replay] server resume threw:', err);
        return;
      }
      // fall through to start the play timer
    }
    // mode === 'play' OR (mode === 'resume' after server success):
    // start the local play loop.
    state.playTimer = setInterval(async () => {
      if (state.isAdvancing) return;
      if (state.run && (state.run.status === 'FAILED' || state.run.status === 'COMPLETED')) {
        stopPlay();
        return;
      }
      await onNextClick();
    }, 5000);
    applyControls();
  };

  const stopPlay = () => {
    if (state.playTimer) {
      clearInterval(state.playTimer);
      state.playTimer = null;
    }
    applyControls();
  };

  // Helper: find the previous window date (for navigation when no
  // step row exists yet — e.g. operator is on the first day of a
  // fresh run and wants to "go back" to view an earlier window day).
  // Returns the date immediately before `from` within [start, end].
  const previousWindowDate = (from) => {
    if (!from) return null;
    const start = state.run.startBusinessDate;
    if (from <= start) return null;
    const [y, m, d] = from.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d) - 24 * 60 * 60 * 1000;
    const prev = new Date(t).toISOString().slice(0, 10);
    if (prev < start) return null;
    return prev;
  };

  // Helper: find the next window date.
  const nextWindowDate = (from) => {
    if (!from) return null;
    const end = state.run.endBusinessDate;
    if (from >= end) return null;
    const [y, m, d] = from.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d) + 24 * 60 * 60 * 1000;
    const next = new Date(t).toISOString().slice(0, 10);
    if (next > end) return null;
    return next;
  };

  // Helper: pick the date the just-finished step ran for. After a
  // /advance call returns, run.currentBusinessDate has already been
  // advanced to the NEXT day, so the just-completed step is the
  // previous day in the steps list.
  const pickJustRanDate = () => {
    if (!state.steps || state.steps.length === 0) return null;
    const last = state.steps[state.steps.length - 1];
    if (last && last.business_date) return last.business_date;
    return null;
  };

  // P0013 G2.2-fix (2026-09-04): retry handler. The operator uses
  // this when the current step is stuck (RUNNING) or FAILED. The
  // server's `mode: 'retry'` clears the orphan / failed step row and
  // re-runs the kernel for the SAME business_date (so the operator
  // gets a fresh attempt at the same day, not the next day).
  //
  // This is the recovery path the operator explicitly asked for
  // after the G-walk: "如果某天数据获取失败, 或者错误, 点任何键都不
  // 能继续, 或者重新获取数据并分析, 只能选择开始新一期回放清空所有
  // 状态". The retry button is visibility-gated; it only shows when
  // there is something to recover.
  const onRetryClick = async () => {
    // eslint-disable-next-line no-console
    console.log('[replay] control clicked: retry', 'runId=', state.runId, 'status=', state.run && state.run.status);
    if (!state.runId) return;
    // P0013 G2.3-fix (2026-09-04): same lock as onNextClick. Retry also
    // posts to /advance (mode=retry), so it would hit the same
    // "concurrent in flight" gate if a previous call is still flying.
    if (state.isAdvancing) {
      // eslint-disable-next-line no-console
      console.log('[replay] retry skipped: previous advance still in flight (', elapsedSeconds(), 's)');
      return;
    }
    stopPlay();
    setIsAdvancing(true);
    const btn = document.getElementById('replayRetryBtn');
    if (btn) btn.disabled = true;
    try {
      const result = await apiPost('/api/replay/runs/' + state.runId + '/advance', { mode: 'retry' });
      // eslint-disable-next-line no-console
      console.log('[replay] retry result:', result.status, result.body?.data?.result?.status, result.body?.data?.result?.error);
      if (result.status === 200 && result.body.success) {
        await refreshRunState();
        const stepResult = result.body.data && result.body.data.result;
        if (stepResult && stepResult.status === 'COMPLETED') {
          // P0013 G2.4: render the just-completed day AND update
          // viewedDate so the operator sees the kernel's output.
          if (state.steps && state.steps.length > 0) {
            const last = state.steps[state.steps.length - 1];
            if (last && last.business_date) {
              state.viewedDate = last.business_date;
              await renderDailyView(last.business_date);
            }
          }
        }
        if (state.run && state.run.status === 'COMPLETED') {
          stopPlay();
          await renderMonthlyReviewIfAny();
        }
      } else {
        // eslint-disable-next-line no-console
        console.error('[replay] retry failed:', result.status, result.body);
        alert('重试这一步失败: ' + (result.body?.error || '未知错误'));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[replay] retry threw:', err);
      alert('重试这一步异常: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (btn) btn.disabled = false;
      setIsAdvancing(false);
    }
  };

  // P0013 G2.2-fix (2026-09-04): skip handler. The operator uses
  // this when a step's data is known-bad or the kernel consistently
  // fails. The server's `mode: 'skip'` marks the current step
  // SKIPPED_NO_DATA, advances the clock, and the operator moves on
  // to the next day.
  //
  // Skip is a non-destructive escape hatch — the data is preserved
  // (the step row exists with status=SKIPPED_NO_DATA), and the
  // operator can re-try it later (via a future "revisit skipped
  // days" feature; P0013+ follow-up).
  //
  // P0013 P1-4-fix (2026-09-04): skip mutates replay execution state
  // (the server's runReplayRunStep advances the cursor), so it MUST
  // follow the same single-flight discipline as Next/Retry:
  //   1. Refuse if isAdvancing (no double-tap, no parallel advance).
  //   2. Wrap the API call in setIsAdvancing(true/false).
  //   3. Restore control state in finally (applyControls) so the
  //      button reflects the post-API state even on error.
  // Do not rely only on btn.disabled — the state machine (isAdvancing)
  // is the source of truth.
  const onSkipClick = async () => {
    // eslint-disable-next-line no-console
    console.log('[replay] control clicked: skip', 'runId=', state.runId, 'status=', state.run && state.run.status);
    if (!state.runId) return;
    if (state.isAdvancing) {
      // eslint-disable-next-line no-console
      console.log('[replay] skip skipped: previous advance still in flight (', elapsedSeconds(), 's)');
      return;
    }
    if (!confirm('确定要跳过当前 step 吗？这一步的数据会被标记为 SKIPPED_NO_DATA，可后续重新访问。')) {
      return;
    }
    stopPlay();
    setIsAdvancing(true);
    try {
      const result = await apiPost('/api/replay/runs/' + state.runId + '/advance', { mode: 'skip' });
      // eslint-disable-next-line no-console
      console.log('[replay] skip result:', result.status, result.body?.data?.state?.currentStep, result.body?.data?.state?.currentBusinessDate);
      if (result.status === 200 && result.body.success) {
        await refreshRunState();
        // P0013 G2.4: render the just-skipped day AND update
        // viewedDate. The operator sees the SKIPPED badge + reason.
        if (state.steps && state.steps.length > 0) {
          const last = state.steps[state.steps.length - 1];
          if (last && last.business_date) {
            state.viewedDate = last.business_date;
            await renderDailyView(last.business_date);
          }
        }
      } else {
        // eslint-disable-next-line no-console
        console.error('[replay] skip failed:', result.status, result.body);
        alert('跳过这一步失败: ' + (result.body?.error || '未知错误'));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[replay] skip threw:', err);
      alert('跳过这一步异常: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsAdvancing(false);
      // P1-4: restore the control bar from the state machine, not
      // from a button.disabled flag (which was the prior P0-1 root
      // cause — it desyncs from the state machine on error).
      applyControls();
    }
  };

  // ── Timeline ─────────────────────────────────────────────────────────

  const showTimeline = () => {
    const el = document.getElementById('replayTimeline');
    if (el) el.style.display = '';
  };

  const renderTimeline = () => {
    const cells = document.getElementById('replayTimelineCells');
    if (!cells) return;
    cells.innerHTML = '';
    // P0013+: the timeline follows THIS run's persisted window, not a
    // hardcoded 30-day range.
    const allDates = enumerateDates(state.run.startBusinessDate, state.run.endBusinessDate);
    const stepMap = new Map();
    state.steps.forEach((s) => stepMap.set(s.business_date, s));
    const currentDate = state.run && state.run.currentBusinessDate;
    allDates.forEach((d) => {
      const cell = document.createElement('button');
      cell.className = 'replay-cell';
      const step = stepMap.get(d);
      if (step) {
        // P0013 G2.2-fix (2026-09-04): show distinct icons per step
        // status so the operator can scan the timeline for
        // failures / skips at a glance. COMPLETED = ●, FAILED = ✗,
        // SKIPPED_NO_DATA = ⊘, RUNNING = ◐. All clickable to open
        // the daily view (FAILED/SKIPPED show the reason in the
        // status header).
        const enriched = state.enrichedDates.includes(d);
        const stale = !!step.enrichment_stale_at;
        const enrMark = enriched ? ' ✎' : '';
        if (step.status === 'FAILED') {
          cell.textContent = d.slice(5) + ' ✗' + enrMark;
          cell.title = d + ' — FAILED: ' + (step.error || '');
          cell.className = 'replay-cell replay-cell-failed';
        } else if (step.status === 'SKIPPED_NO_DATA') {
          cell.textContent = d.slice(5) + ' ⊘' + enrMark;
          cell.title = d + ' — SKIPPED: ' + (step.error || '');
          cell.className = 'replay-cell replay-cell-skipped';
        } else if (step.status === 'RUNNING') {
          cell.textContent = d.slice(5) + ' ◐' + enrMark;
          cell.title = d + ' — RUNNING (in flight)';
          cell.className = 'replay-cell replay-cell-running';
        } else {
          cell.textContent = d.slice(5) + ' ●' + enrMark;
          cell.title = d + ' — COMPLETED' + (stale ? ' — STALE (补充后待重放)' : '') + (enriched ? ' — 有补充' : '');
          if (stale) cell.className = 'replay-cell replay-cell-stale';
        }
      } else if (d === currentDate) {
        cell.textContent = d.slice(5) + ' ◀';
        cell.title = d + ' — Current（可点击查看/补充）';
      } else {
        cell.textContent = d.slice(5) + ' ○';
        cell.title = d + ' — Pending（未 replay，可点击预置补充）';
      }
      // P0013.3 repair: EVERY in-window date is clickable — browsing is
      // decoupled from the execution cursor. Future/pending dates show
      // the enrichment pane so operators can preset fact/action/feedback
      // that replay will consume when it reaches the date.
      cell.onclick = async () => {
        state.viewedDate = d;
        await renderDailyView(d);
        applyControls();
      };
      cells.appendChild(cell);
    });
  };

  const enumerateDates = (start, end) => {
    const out = [];
    if (!start || !end) return out;
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    const a = Date.UTC(sy, sm - 1, sd);
    const b = Date.UTC(ey, em - 1, ed);
    if (Number.isNaN(a) || Number.isNaN(b) || a > b) return out;
    for (let t = a; t <= b; t += 24 * 60 * 60 * 1000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  };

  // P0013+: total planned days for the CURRENT run (replaces hardcoded /30).
  const runTotalDays = () => {
    if (!state.run || !state.run.startBusinessDate) return 0;
    return enumerateDates(state.run.startBusinessDate, state.run.endBusinessDate).length;
  };

  const renderStatus = () => {
    const el = document.getElementById('replayStatusText');
    if (!el || !state.run) return;
    // P0013 G2.4: show THREE separate concepts so the operator
    // can disambiguate "where execution is" vs "what I'm looking at".
    //   state   — replay_runs.status
    //   cursor  — replay_runs.currentBusinessDate (next-to-execute)
    //   viewed  — state.viewedDate (UI daily view pane)
    const viewed = state.viewedDate || state.run.currentBusinessDate || '-';
    const cursor = state.run.currentBusinessDate || '-';
    const divergeTag = viewed !== cursor ? ' (browsing)' : '';
    let line =
      'state=' + state.run.status +
      ' | cursor=' + cursor +
      ' | viewed=' + viewed + divergeTag +
      ' | step ' + state.run.currentStep + '/' + runTotalDays() +
      ' | Run ' + state.run.id.slice(0, 8);
    // P0013 G2.3-fix: when an advance call is in flight, append the
    // elapsed seconds so the operator sees the kernel is working,
    // not stuck. Re-rendered every 1s by setIsAdvancing's indicatorTimer.
    if (state.isAdvancing) {
      line += ' | 🌀 思考中 (' + elapsedSeconds() + 's)';
    }
    el.textContent = line;
  };

  // ── Daily view (P0013 §29) ────────────────────────────────────────────

  const renderDailyView = async (businessDate) => {
    if (!state.runId) return;
    const wrap = document.getElementById('replayDailyView');
    if (wrap) wrap.style.display = '';
    const dateEl = document.getElementById('replayDailyDate');
    if (dateEl) dateEl.textContent = businessDate;
    const content = document.getElementById('replayDailyContent');
    if (content) content.innerHTML = '<p class="muted">加载中…</p>';
    const result = await apiGet('/api/replay/runs/' + state.runId + '/steps/' + businessDate);
    if (result.status !== 200 || !result.body.success) {
      if (content) content.innerHTML = '<p class="muted">这一天还没有 cognition（可先在下方补充当时情况，再重放；或点击 ▶ 下一天 产生一次）。</p>';
      renderEnrichmentPane(businessDate);
      return;
    }
    const { step, snapshot, evidenceRefs } = result.body.data;
    const html = [];
    // P0013 G2.2-fix (2026-09-04): show the step status as a banner
    // BEFORE the §29 sections, so the operator immediately sees
    // whether this day succeeded, failed, or was skipped. The error
    // message is surfaced verbatim (no normalization) so the operator
    // can copy it for the bug report. FAILED / SKIPPED_NO_DATA get
    // distinct background colors (red/grey) so the operator does not
    // have to read the badge text to know something is wrong.
    const stepStatus = step.status || 'UNKNOWN';
    const statusBadge = (() => {
      if (stepStatus === 'FAILED') {
        return '<span class="replay-badge" data-step-status="FAILED" style="background:#fee2e2;color:#991b1b">FAILED</span>';
      }
      if (stepStatus === 'SKIPPED_NO_DATA') {
        return '<span class="replay-badge" data-step-status="SKIPPED_NO_DATA" style="background:#e5e7eb;color:#374151">SKIPPED</span>';
      }
      if (stepStatus === 'RUNNING') {
        return '<span class="replay-badge" data-step-status="RUNNING" style="background:#dbeafe;color:#1e40af">RUNNING</span>';
      }
      if (stepStatus === 'COMPLETED') {
        return '<span class="replay-badge" data-step-status="COMPLETED" style="background:#dcfce7;color:#166534">COMPLETED</span>';
      }
      return '<span class="replay-badge">' + escHtml(stepStatus) + '</span>';
    })();
    html.push(
      '<div class="replay-section replay-step-status" data-step-status="' +
        escHtml(stepStatus) +
        '"><h5>Step 状态</h5>' +
        '<p>' + statusBadge + ' <span class="muted">step ' + escHtml(String(step.step_number)) + ' / ' + runTotalDays() + '</span></p>' +
        (step.error ? '<p class="muted">错误: ' + escHtml(step.error) + '</p>' : '') +
        '</div>',
    );
    // 发生了什么 (Observed Facts) — P0013 G1.4-fix: was a hardcoded
    // 'stub kernel placeholder' string. The LLM kernel is wired (BC.2),
    // so this section now renders real observed_facts (the Agent's own
    // short descriptions of what it read from the evidence slice) plus
    // the visible evidence refs (ids + business dates) for this step.
    html.push('<div class="replay-section"><h5>发生了什么 (Observed Facts)</h5>');
    if (snapshot) {
      const observedFacts = (() => {
        try {
          const v = JSON.parse(snapshot.observed_facts || '[]');
          return Array.isArray(v) ? v : [];
        } catch {
          return [];
        }
      })();
      if (observedFacts.length > 0) {
        html.push('<p class="muted">从 Hermes 实际读取的证据（snapshot.observed_facts，evidenceAcquired）：</p>');
        html.push('<ul>' + observedFacts.map((f) => '<li>' + escHtml(f) + '</li>').join('') + '</ul>');
      } else {
        html.push('<p class="muted">— (本 step 的 observed_facts 为空)</p>');
      }
      if (evidenceRefs && evidenceRefs.length > 0) {
        html.push('<p class="muted">本 step 可见的 evidence_observations（按 visibleEvidenceFor SQL 过滤，business_date ≤ ' + escHtml(snapshot.business_date) + '）：</p>');
        html.push('<ul>');
        evidenceRefs.forEach((r) => {
          html.push(
            '<li>evidence_observations.id=' + r.evidence_observation_id +
              ' | business_date=' + escHtml(r.business_date) + '</li>',
          );
        });
        html.push('</ul>');
      } else {
        html.push('<p class="muted">— (本 step 没有 evidence refs)</p>');
      }
    } else {
      html.push('<p class="muted">— (snapshot 尚未生成)</p>');
    }
    html.push('</div>');

    if (snapshot) {
      html.push('<div class="replay-section"><h5>Agent 当前理解 (Understanding)</h5>');
      html.push('<p>' + escHtml(snapshot.current_understanding || '—') + '</p></div>');

      html.push('<div class="replay-section"><h5>Agent 判断 (Judgment)</h5>');
      html.push('<p>' + escHtml(snapshot.judgment || '—') + '</p></div>');

      html.push('<div class="replay-section"><h5>Agent 建议 (Recommendation)</h5>');
      html.push('<p><strong>' + escHtml(snapshot.recommendation_kind) + '</strong>: ' + escHtml(snapshot.recommendation_text || '—') + '</p></div>');

      const unknowns = JSON.parse(snapshot.unknowns || '[]');
      html.push('<div class="replay-section"><h5>仍待确认 (Unknowns)</h5>');
      if (unknowns.length === 0) html.push('<p class="muted">—</p>');
      else html.push('<ul>' + unknowns.map((u) => '<li>' + escHtml(u) + '</li>').join('') + '</ul>');
      html.push('</div>');

      const evidenceGaps = JSON.parse(snapshot.evidence_gaps || '[]');
      html.push('<div class="replay-section"><h5>缺少的 Evidence (Evidence Gaps)</h5>');
      if (evidenceGaps.length === 0) html.push('<p class="muted">—</p>');
      else html.push('<ul>' + evidenceGaps.map((g) => '<li>' + escHtml(g) + '</li>').join('') + '</ul>');
      html.push('</div>');

      html.push('<div class="replay-section"><h5>Evidence (Source references)</h5>');
      if (evidenceRefs && evidenceRefs.length > 0) {
        html.push('<ul>');
        evidenceRefs.forEach((r) => {
          html.push(
            '<li>evidence_observations.id=' +
              r.evidence_observation_id +
              ' | business_date=' +
              escHtml(r.business_date) +
              '</li>',
          );
        });
        html.push('</ul>');
      } else {
        html.push('<p class="muted">—</p>');
      }
      html.push('</div>');

      html.push(
        '<div class="replay-section replay-execution"><h5>执行状态</h5>' +
          '<p><span class="replay-badge">Replay Recommendation — Not Executed</span> (P0013 §14)</p>' +
          '<p class="muted">Reason: P0013 Replay 不执行 Replay Recommendation。仅记录为 proposal。</p>' +
          '</div>',
      );
    } else {
      html.push('<p class="muted">该 step 已运行但未产生 cognition snapshot。</p>');
    }
    if (content) content.innerHTML = html.join('');

    // P0013.3 — stale cognition badge (this day was invalidated by an
    // enrichment at/after it and has not been re-played).
    if (step.enrichment_stale_at) {
      const statusWrap = document.querySelector('.replay-step-status');
      if (statusWrap) {
        statusWrap.insertAdjacentHTML(
          'beforeend',
          ' <span class="replay-badge" style="background:#fff8ef;color:#92400e;border:1px solid #d9b38c">STALE · 补充后待重放</span>',
        );
      }
    }
    renderEnrichmentPane(businessDate);
  };

  // ── P0013.3 Historical Evidence Enrichment ────────────────────────────

  const renderStaleBanner = () => {
    const banner = document.getElementById('replayStaleBanner');
    if (!banner) return;
    const staleDates = (state.steps || [])
      .filter((s) => s.enrichment_stale_at)
      .map((s) => s.business_date);
    if (staleDates.length === 0) {
      banner.style.display = 'none';
      return;
    }
    banner.style.display = '';
    const text = document.getElementById('replayStaleText');
    if (text) {
      text.textContent = '有 ' + staleDates.length + ' 天 cognition 已 stale（最早 ' + staleDates[0] + '，补充后需重放）。';
    }
  };

  // P0013.3 repair — enrichments belong to Run + Business Date (NOT to a
  // step / completed cognition / created_at). The pane is therefore
  // available for EVERY in-window date the operator clicks, including
  // future (never-replayed) dates. Preset enrichments are consumed
  // naturally when replay reaches that date.
  const renderEnrichmentPane = (businessDate) => {
    const wrap = document.getElementById('replayEnrichment');
    if (!wrap) return;
    wrap.style.display = '';
    const dateEl = document.getElementById('replayEnrichmentDate');
    if (dateEl) dateEl.textContent = businessDate;
    const listEl = document.getElementById('replayEnrichmentList');
    const rows = state.enrichmentsByDate.get(businessDate) || [];
    const step = (state.steps || []).find((s) => s.business_date === businessDate);
    const cursor = state.run && state.run.currentBusinessDate;
    const rel =
      step && step.status === 'COMPLETED'
        ? '已 replay（补充将把本日及以后标 stale）'
        : businessDate >= (state.run?.startBusinessDate || '') && businessDate > (cursor || '')
          ? '未 replay（预置补充：执行到该日自动读取）'
          : '该日尚无 cognition（补充为预置，执行到该日自动读取）';
    if (listEl) {
      const header =
        '<div class="muted" style="font-size:0.74rem;margin-bottom:6px">' +
        escHtml(rel) +
        '</div>';
      if (rows.length === 0) {
        listEl.innerHTML = header + '<span class="muted">该业务日暂无补充（追加保存，不覆盖历史）。</span>';
      } else {
        listEl.innerHTML =
          header +
          rows
            .map(
              (e) =>
                '<div class="replay-enrichment enr-' +
                escHtml(e.kind) +
                '"><span class="enr-kind">' +
                escHtml(e.kind) +
                '</span>' +
                escHtml(e.content) +
                '<div class="muted" style="font-size:0.72rem">Business Date ' +
                escHtml(e.businessDate) +
                ' · 录入时间 ' +
                escHtml((e.createdAt || '').slice(0, 16).replace('T', ' ')) +
                ' · source=' +
                escHtml(e.source) +
                '</div></div>',
            )
            .join('');
      }
    }
    const contentEl = document.getElementById('replayEnrichmentContent');
    if (contentEl) {
      contentEl.value = '';
      contentEl.dataset.businessDate = businessDate;
    }
    // "保存并重放这一天" is only actionable when this business date has
    // already been reached by the run cursor (rerunning a future day has
    // no cognition to replace; the preset is consumed on natural arrival).
    const rerunBtn = document.getElementById('replayEnrichmentRerunBtn');
    if (rerunBtn) {
      const reached = !!step;
      rerunBtn.disabled = !reached;
      rerunBtn.title = reached
        ? '保存后立即重新形成该业务日认知（约 2–7 分钟）'
        : '该业务日尚未 replay；保存为预置补充，连续回放到达该日时自动读取';
    }
  };

  const submitEnrichment = async (andRerun) => {
    const date = state.viewedDate;
    const contentEl = document.getElementById('replayEnrichmentContent');
    const kindEl = document.getElementById('replayEnrichmentKind');
    const statusEl = document.getElementById('replayEnrichmentStatus');
    if (!date || !contentEl || !kindEl) return;
    const content = contentEl.value.trim();
    if (!content) {
      if (statusEl) statusEl.textContent = '请输入补充内容';
      return;
    }
    const btn1 = document.getElementById('replayEnrichmentSaveBtn');
    const btn2 = document.getElementById('replayEnrichmentRerunBtn');
    const setBusy = (b) => {
      if (btn1) btn1.disabled = b;
      if (btn2 && btn2.title.startsWith('保存后')) btn2.disabled = b;
    };
    setBusy(true);
    if (statusEl) statusEl.textContent = '保存中…';
    const body = { businessDate: date, kind: kindEl.value, content };
    const created = await apiPost('/api/replay/runs/' + state.runId + '/enrichments', body);
    if (created.status !== 201 || !created.body.success) {
      if (statusEl) statusEl.textContent = '保存失败: ' + (created.body.error || created.status);
      setBusy(false);
      return;
    }
    if (statusEl) statusEl.textContent = '已保存（Business Date ' + date + '）';
    await refreshRunState();
    renderEnrichmentPane(date);
    contentEl.value = '';
    setBusy(false);
    if (!andRerun) return;

    // ── Save + rerun: never a dead end. If a step is mid-flight
    // (RUNNING), wait for it to finish; if the run is mid continuous
    // replay (RUNNING, idle), pause the scheduler first (existing
    // pauseReplayRun capability surfaced through advance mode=pause),
    // then rerun the single business date. ──
    if (statusEl) statusEl.textContent = '准备重放 ' + date + '…';
    const waitForNotRunningStep = async () => {
      for (let i = 0; i < 120; i += 1) {
        const step = (state.steps || []).find((s) => s.business_date === date);
        const anyRunning = (state.steps || []).some((s) => s.status === 'RUNNING');
        if (!anyRunning) return true;
        await new Promise((r) => setTimeout(r, 5000));
        await refreshRunState();
        void step;
      }
      return false;
    };

    let anyRunning = (state.steps || []).some((s) => s.status === 'RUNNING');
    if (anyRunning) {
      if (statusEl) statusEl.textContent = '有 step 正在执行，等待其完成（最多 10 分钟）…';
      const ok = await waitForNotRunningStep();
      if (!ok) {
        if (statusEl) statusEl.textContent = '当前 step 仍在执行；补充已保存，可稍后用「连续重放 stale」补算';
        return;
      }
    }
    // Continuous replay scheduler idle (run=RUNNING, no RUNNING step):
    // pause the run state so the scheduler cannot interleave, rerun, then
    // the run is left PAUSED (operator resumes via 继续).
    if (state.run && state.run.status === 'RUNNING') {
      await apiPost('/api/replay/runs/' + state.runId + '/advance', { mode: 'pause' });
      await refreshRunState();
    }
    if (statusEl) statusEl.textContent = '正在重放 ' + date + '（真实 Hermes，约 2–7 分钟）…';
    const rerun = await apiPost('/api/replay/runs/' + state.runId + '/rerun', {
      mode: 'day',
      businessDate: date,
    });
    await refreshRunState();
    await renderDailyView(date);
    if (rerun.status === 200 && rerun.body.success && rerun.body.data.result.status !== 'FAILED') {
      if (statusEl) {
        statusEl.textContent =
          '已基于补充重放 ' + date + '（后续日期若 stale，可用「从最早 stale 连续重放」）';
      }
    } else {
      if (statusEl) {
        statusEl.textContent =
          '补充已保存，但重放失败: ' +
          ((rerun.body && rerun.body.error) || (rerun.body?.data?.result?.error) || rerun.status);
      }
    }
  };

  // ── Monthly review ────────────────────────────────────────────────────

  const renderMonthlyReviewIfAny = async () => {
    // P0013+: the review month is derived from THIS run's window (the runner
    // generates a review whenever a step crosses a month boundary), not a
    // hardcoded 2026-08. List first, then fetch each generated review.
    if (!state.runId) return;
    const listResult = await apiGet('/api/replay/runs/' + state.runId + '/monthly-reviews');
    if (listResult.status !== 200 || !listResult.body.success || !Array.isArray(listResult.body.data)) {
      return;
    }
    const months = listResult.body.data.map((m) => m.business_month).filter(Boolean).sort();
    const reviews = [];
    for (const month of months) {
      const detail = await apiGet('/api/replay/runs/' + state.runId + '/monthly-reviews/' + month);
      if (detail.status === 200 && detail.body.success && detail.body.data) {
        reviews.push(detail.body.data);
      }
    }
    if (reviews.length > 0) renderMonthlyReviews(reviews);
  };

  const renderMonthlyReviews = (reviews) => {
    const wrap = document.getElementById('replayMonthlyReview');
    if (wrap) wrap.style.display = '';
    const content = document.getElementById('replayMonthlyContent');
    if (!content) return;
    content.innerHTML = reviews.map((review) => buildMonthlyReviewHtml(review)).join('<hr/>');
  };

  const buildMonthlyReviewHtml = (review) => {
    const html = [];
    html.push('<div class="replay-section">');
    html.push('<h5>月度评审 ' + escHtml(review.business_month || '') + ' — 数据覆盖</h5>');
    html.push(
      '<p>' +
        escHtml(review.data_coverage_start) +
        ' → ' +
        escHtml(review.data_coverage_end) +
        ' <span class="replay-badge">' +
        escHtml(review.coverage_status) +
        '</span></p>',
    );
    const missing = JSON.parse(review.missing_dates || '[]');
    if (missing.length > 0) {
      html.push('<p>缺失日期: ' + missing.map((d) => escHtml(d)).join(', ') + '</p>');
    }
    html.push('</div>');
    const body = JSON.parse(review.body_json || '{}');
    const sections = [
      ['经营总结', 'business_summary'],
      ['经营阶段', 'business_phases'],
      ['关键 Situation', 'key_situations'],
      ['Agent 判断演变', 'judgment_evolution'],
      ['主要建议', 'major_recommendations'],
      ['后续支持的判断', 'supported_judgments'],
      ['后续修正的判断', 'revised_judgments'],
      ['持续未知', 'persistent_unknowns'],
      ['Evidence Gaps', 'evidence_gaps'],
      ['无法验证效果的建议', 'unverified_recommendations'],
    ];
    sections.forEach(([label, key]) => {
      html.push('<div class="replay-section"><h5>' + label + '</h5>');
      const v = body[key];
      if (v == null) {
        html.push('<p class="muted">— (Phase 7 generator 未填)</p>');
      } else if (Array.isArray(v)) {
        if (v.length === 0) html.push('<p class="muted">—</p>');
        else html.push('<ul>' + v.map((x) => '<li>' + escHtml(typeof x === 'string' ? x : JSON.stringify(x)) + '</li>').join('') + '</ul>');
      } else if (typeof v === 'string') {
        html.push('<p>' + escHtml(v) + '</p>');
      } else {
        html.push('<pre>' + escHtml(JSON.stringify(v, null, 2)) + '</pre>');
      }
      html.push('</div>');
    });
    return html.join('');
  };

  // ── Entry: loadReplay ────────────────────────────────────────────────

  // Exposed for the view-leave handler in app.js to tear down the play
  // timer when the operator switches away from the Replay view. Without
  // this, a background setInterval keeps firing API calls after the
  // panel is hidden. IIFE-scoped `stopPlay` is not enough.
  window.__replayStopPlay = stopPlay;

  window.loadReplay = function loadReplay() {
    state.runId = null;
    state.run = null;
    state.steps = [];
    state.viewedDate = null;
    stopPlay();
    // P0013+ fix: do NOT flash the start panel first — with an existing run
    // it appeared for a moment and then vanished, which read as "the range
    // selector disappeared". Decide from the runs list, then render once.
    const controls = document.getElementById('replayControls');
    if (controls) controls.style.display = 'none';
    const timeline = document.getElementById('replayTimeline');
    if (timeline) timeline.style.display = 'none';
    const daily = document.getElementById('replayDailyView');
    if (daily) daily.style.display = 'none';
    const review = document.getElementById('replayMonthlyReview');
    if (review) review.style.display = 'none';
    const start = document.getElementById('replayStartPanel');
    if (start) start.style.display = 'none';
    const startBtn = document.getElementById('replayStartBtn');
    if (startBtn) startBtn.onclick = onStartClick;
    const acquireBtn = document.getElementById('replayAcquireBtn');
    if (acquireBtn) acquireBtn.onclick = onAcquireClick;
    // Rehydrate existing run if any; only show the start panel when none.
    apiGet('/api/replay/runs').then((result) => {
      if (result.status === 200 && result.body.success && Array.isArray(result.body.data) && result.body.data.length > 0) {
        const run = result.body.data[0];
        state.runId = run.id;
        refreshRunState().then(() => {
          // P0013 G2.4: initialize viewedDate to the execution cursor
          // (the next-to-run day, or the last run day if COMPLETED).
          // Operator can navigate freely from there.
          if (state.run) {
            state.viewedDate = state.run.currentBusinessDate || state.run.startBusinessDate;
          }
          showControls();
          showTimeline();
        });
      } else {
        showStartPanel();
      }
    }).catch(() => {
      // Never leave the view blank: the panel renders its own fetch-failure state.
      showStartPanel();
    });
  };
})();
