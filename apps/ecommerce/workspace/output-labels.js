// P0010.1 REPAIR-5 — expose Output / WorkItem labels from the schema
// (shared/schemas/output.ts) to the vanilla-JS Workspace, which cannot
// import TypeScript directly.
//
// This file MUST stay in 1:1 sync with `shared/schemas/output.ts` —
// `WORK_ITEM_STATUS_LABEL`, `WORK_ITEM_TYPE_LABEL`, and
// `WORK_ITEM_KIND_LABEL` — and the vitest contract test
// `tests/contract/output-labels-sync.test.ts` asserts that automatically.
//
// Rationale for the mirror (not a duplicate schema):
//   - The Workspace is a vanilla-JS SPA; it cannot import .ts at runtime.
//   - The labels are *display* constants, not validation logic; the
//     schema keeps them as the single source of truth.
//   - The contract test catches drift on every CI run.

window.WORK_ITEM_STATUS_LABEL = Object.freeze({
  ready: '待交付',
  delivered: '已交付',
  acknowledged: '已确认',
  closed: '已关闭',
});

window.WORK_ITEM_TYPE_LABEL = Object.freeze({
  recommendation: '建议',
  analysis: '分析',
  work_item: '工作项',
  report: '报告',
});

// P0010.2.x — recommendation kind labels (mirror of WORK_ITEM_KIND_LABEL
// in shared/schemas/output.ts). Drives the Workspace chip split
// (observe → grey "保持观察", act → yellow/red "待交付").
window.WORK_ITEM_KIND_LABEL = Object.freeze({
  observe: '保持观察',
  act: '待交付',
});

// P0010.2.x — CSS class names for the kind chip. Workspace renders two
// chip styles: `output-kind-observe` (grey status pill) and
// `output-kind-act` (yellow/red to-do). The class is the single
// source of truth for both the JSX and the stylesheet.
window.WORK_ITEM_KIND_CSS_CLASS = Object.freeze({
  observe: 'output-kind-observe',
  act: 'output-kind-act',
});
