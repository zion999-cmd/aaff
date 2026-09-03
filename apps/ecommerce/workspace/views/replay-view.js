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

  const apiGet = (path) => fetch(path).then((r) => r.json().then((body) => ({ status: r.status, body })));
  const apiPost = (path, body) =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json().then((resp) => ({ status: r.status, body: resp })));
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
    playTimer: null,
    viewedDate: null, // P0013 G2.4: pure-UI viewed date, independent of execution cursor
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
    // G2.5-fix: both RUNNING_ACTIVE and RUNNING_IDLE expose "⏸ 暂停"
    // because the run as a whole is still active in both. The kernel
    // being mid-flight vs idle is irrelevant to whether the operator
    // can pause the run.
    const exec = (() => {
      if (uiState === 'READY') {
        return { enabled: !isAdvancing && !isPlaying, label: '▶ 连续回放', mode: 'play' };
      }
      if (uiState === 'RUNNING_ACTIVE' || uiState === 'RUNNING_IDLE') {
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
      return { enabled: false, label: '连续回放' };
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

    // ── restart (重新回放) — create a fresh run ──
    // G2.5-fix: the playTimer is "playing" in both RUNNING_ACTIVE
    // (kernel mid-flight) and RUNNING_IDLE (kernel idle, waiting
    // for next tick). Both must be paused before restart.
    const restart = (() => {
      if ((uiState === 'RUNNING_ACTIVE' || uiState === 'RUNNING_IDLE' || uiState === 'PAUSED') && isPlaying) {
        return { enabled: false, reason: '请先暂停再重新回放' };
      }
      return { enabled: !isAdvancing, reason: null };
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

  // ── Start panel ───────────────────────────────────────────────────────

  const renderStartPanel = () => {
    const startBtn = document.getElementById('replayStartBtn');
    if (!startBtn) return;
    startBtn.onclick = onStartClick;
  };

  const onStartClick = async () => {
    const btn = document.getElementById('replayStartBtn');
    if (btn) btn.disabled = true;
    const result = await apiPost('/api/replay/runs', {
      shopId: 'jd_shop_001',
      shopName: '祁门红茶官方旗舰店',
      sourceDatasetPath: 'data/jd_acquisition_20260903_0834',
      sourceManifestHash: 'placeholder-hash',
      startBusinessDate: '2026-08-04',
      endBusinessDate: '2026-09-02',
    });
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
      renderTimeline();
      renderStatus();
      applyControls();
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
    // P0013 G-fix (2026-09-03): user can ALWAYS start a new run, even
    // when a prior run (e.g. the stub-era 30/30 run) is in DB. The old
    // run stays as historical record; the new run takes over the view.
    // The button is disabled while a run is actively RUNNING to avoid
    // operator confusion about which run the view is showing.
    // P0013 G1.6-fix: PAUSED is allowed (the operator explicitly paused
    // the run — usually to start fresh). Only RUNNING blocks restart.
    // eslint-disable-next-line no-console
    console.log('[replay] control clicked: restart', 'currentRunId=', state.runId, 'status=', state.run && state.run.status);
    if (state.run && state.run.status === 'RUNNING') {
      alert('当前 run 还在 RUNNING，请先点「⏸ 暂停」再开始新一次。');
      return;
    }
    const btn = document.getElementById('replayRestartBtn');
    if (btn) btn.disabled = true;
    try {
      const result = await apiPost('/api/replay/runs', {
        shopId: 'jd_shop_001',
        shopName: '祁门红茶官方旗舰店',
        sourceDatasetPath: 'data/jd_acquisition_20260903_0834',
        sourceManifestHash: 'placeholder-hash',
        startBusinessDate: '2026-08-04',
        endBusinessDate: '2026-09-02',
      });
      if (result.status === 200 && result.body.success) {
        // eslint-disable-next-line no-console
        console.log('[replay] restart created new runId=', result.body.data.runId);
        state.runId = result.body.data.runId;
        await refreshRunState();
        // Re-render the start panel header to the new run (in case the
        // operator wants to see the start panel state too — the start
        // panel stays hidden once a run exists, but the controls are
        // already visible because we don't hide them).
        // The new run starts at READY with currentStep=0; showControls
        // is already wired so timeline / status / controls render.
        showControls();
        // The new run starts at step 0, so the timeline is all ○ except
        // the ◀ Current on 08-04. The user clicks [▶ 下一天] to begin.
      } else {
        // eslint-disable-next-line no-console
        console.error('[replay] restart failed:', result.status, result.body);
        alert('开始新一次回放失败: ' + (result.body?.error || '未知错误'));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[replay] restart threw:', err);
      alert('开始新一次回放异常: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  const showControls = () => {
    const el = document.getElementById('replayControls');
    if (el) el.style.display = '';
    const start = document.getElementById('replayStartPanel');
    if (start) start.style.display = 'none';
    // addEventListener (not onclick) so any subsequent code that does
    // .onclick = null cannot silently kill the handler. Click any
    // control after Start — if no advance happens, open DevTools
    // console; you'll see "[replay] control clicked: next" if the
    // listener is wired.
    document.getElementById('replayPrevBtn').addEventListener('click', onPrevClick);
    document.getElementById('replayNextBtn').addEventListener('click', onNextClick);
    // P0013 G2.4-fix (2026-09-04): play/pause/resume are ONE button
    // (#replayExecBtn). Label rotates via deriveReplayControls
    // (▶ 连续回放 / ⏸ 暂停 / ▶ 继续). Click handler dispatches by
    // the current control's `mode`.
    document.getElementById('replayExecBtn').addEventListener('click', onExecClick);
    // P0013 G2.4-fix: retry + skip are STABLE buttons. Always in
    // the DOM, just disabled when not applicable. State changes
    // flow through deriveReplayControls (applyControls after every
    // action).
    const retryBtn = document.getElementById('replayRetryBtn');
    if (retryBtn) retryBtn.addEventListener('click', onRetryClick);
    const skipBtn = document.getElementById('replaySkipBtn');
    if (skipBtn) skipBtn.addEventListener('click', onSkipClick);
    // P0013 G-fix: "↻ 开始新一次回放" handler. Always bound; gated at
    // handler entry by the run.status check (refuses while RUNNING/PAUSED).
    const restartBtn = document.getElementById('replayRestartBtn');
    if (restartBtn) restartBtn.addEventListener('click', onRestartClick);
    // P0013 G2.4: apply controls immediately so the buttons reflect
    // the current state on first render. Critical for orphan RUNNING
    // runs: the pause label must be "⏸ 暂停" (not the default "▶ 连
    // 续回放") on page load, BEFORE the operator clicks anything.
    applyControls();
    // eslint-disable-next-line no-console
    console.log('[replay] controls bound: prev/next/exec/retry/skip/restart (6 stable)');
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
  const onSkipClick = async () => {
    // eslint-disable-next-line no-console
    console.log('[replay] control clicked: skip', 'runId=', state.runId, 'status=', state.run && state.run.status);
    if (!state.runId) return;
    if (!confirm('确定要跳过当前 step 吗？这一步的数据会被标记为 SKIPPED_NO_DATA，可后续重新访问。')) {
      return;
    }
    stopPlay();
    const btn = document.getElementById('replaySkipBtn');
    if (btn) btn.disabled = true;
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
      if (btn) btn.disabled = false;
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
    const allDates = enumerateDates('2026-08-04', '2026-09-02');
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
        if (step.status === 'FAILED') {
          cell.textContent = d.slice(5) + ' ✗';
          cell.title = d + ' — FAILED: ' + (step.error || '');
          cell.className = 'replay-cell replay-cell-failed';
        } else if (step.status === 'SKIPPED_NO_DATA') {
          cell.textContent = d.slice(5) + ' ⊘';
          cell.title = d + ' — SKIPPED: ' + (step.error || '');
          cell.className = 'replay-cell replay-cell-skipped';
        } else if (step.status === 'RUNNING') {
          cell.textContent = d.slice(5) + ' ◐';
          cell.title = d + ' — RUNNING (in flight)';
          cell.className = 'replay-cell replay-cell-running';
        } else {
          cell.textContent = d.slice(5) + ' ●';
          cell.title = d + ' — COMPLETED';
        }
        cell.onclick = async () => {
          // P0013 G2.4: clicking a timeline cell navigates viewedDate
          // (does NOT advance execution). The daily view pane re-
          // renders the selected day's persisted snapshot.
          state.viewedDate = d;
          await renderDailyView(d);
          applyControls();
        };
      } else if (d === currentDate) {
        cell.textContent = d.slice(5) + ' ◀';
        cell.title = d + ' — Current';
      } else {
        cell.textContent = d.slice(5) + ' ○';
        cell.title = d + ' — Pending';
      }
      cells.appendChild(cell);
    });
  };

  const enumerateDates = (start, end) => {
    const out = [];
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    const a = Date.UTC(sy, sm - 1, sd);
    const b = Date.UTC(ey, em - 1, ed);
    for (let t = a; t <= b; t += 24 * 60 * 60 * 1000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
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
      ' | step ' + state.run.currentStep + '/30' +
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
      if (content) content.innerHTML = '<p class="muted">这一天还没有 cognition（点击 ▶ 下一天 先产生一次）。</p>';
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
        '<p>' + statusBadge + ' <span class="muted">step ' + escHtml(String(step.step_number)) + ' / 30</span></p>' +
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
  };

  // ── Monthly review ────────────────────────────────────────────────────

  const renderMonthlyReviewIfAny = async () => {
    // Auto-show August review (only one that has a complete 28-day partial window).
    if (!state.runId) return;
    const result = await apiGet('/api/replay/runs/' + state.runId + '/monthly-reviews/2026-08');
    if (result.status === 200 && result.body.success && result.body.data) {
      renderMonthlyReview(result.body.data);
    }
  };

  const renderMonthlyReview = (review) => {
    const wrap = document.getElementById('replayMonthlyReview');
    if (wrap) wrap.style.display = '';
    const content = document.getElementById('replayMonthlyContent');
    if (!content) return;
    const html = [];
    html.push('<div class="replay-section">');
    html.push('<h5>数据覆盖</h5>');
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
    content.innerHTML = html.join('');
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
    // Show the start panel; if a run already exists on the server, surface it.
    const start = document.getElementById('replayStartPanel');
    if (start) start.style.display = '';
    const controls = document.getElementById('replayControls');
    if (controls) controls.style.display = 'none';
    const timeline = document.getElementById('replayTimeline');
    if (timeline) timeline.style.display = 'none';
    const daily = document.getElementById('replayDailyView');
    if (daily) daily.style.display = 'none';
    const review = document.getElementById('replayMonthlyReview');
    if (review) review.style.display = 'none';
    renderStartPanel();
    // Rehydrate existing run if any.
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
      }
    });
  };
})();
