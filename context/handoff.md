# Handoff — P0013.3 Product Acceptance Repair（2026-09-15）

> 人工验收 6 缺陷已修并重新 Workspace E2E。Enrichment 语义统一为 Run+Business Date（非 step/completed/created_at）。

## 修复
1. 所有时间轴格（含 pending ○/未来日）可点 → viewedDate 与 cursor 完全解耦；run 创建后任意合法日即可补充（无 cognition 也显示补充面板）。
2. Business Date 粗体主显示（#replayEnrichmentDate），录入时间次要；DB/API（窗口校验）/kernel（business_date<=T）三层绑定一致。
3. 表单 CSS：类名失配修正（replay-enrich-form）+ 确定宽度 600px/max-width:100%，桌面 1440 实测 600px 不遮挡。
4. 死路消除：「重新回放」RUNNING idle 时自动 pause（复用已有 runner 能力，无新 pause UI）后回面板；in-flight 临时禁用+说明；「保存并重放」等待 in-flight/自动 pause 后 rerun；未来日 rerun 按钮禁用并说明"预置，到达时自动读取"。
5. 未来日预置不产生 stale（仅 COMPLETED step 被打标），到 T 自然消费。
6. Action T+n 可见性审计：visibleEnrichmentsAt business_date<=T 已满足，未重写；prompt 共现非因果规则已在 ADR-089。

## 真实验收（真 Hermes，run bf740b90，09-04→09-08）
- 创建 run 不 replay → 09-07 预置 action（零 step/零 stale）→ resume+连续 replay：09-07 judgment "券与 GMV 只记序列"；09-08 运行中预置 fact → "停券与软化只记序列"；09-06 UI 追加的 operator_feedback 被执行为 L3 hypothesis（"店长礼赠判断非 L1"），未升 Fact。
- 运行中给未来 09-08 补 fact：无死锁、零 stale；已完成 09-04 补 fact：stale=[04,05]；mode=stale 从 09-04 重放到窗口末 5 步 COMPLETED、0 stale；frozen hash 87613e01 不变。
- Headless Chrome（独立 9334，不碰 9222）Workspace E2E 15/15。
- 回归：135 replay/契约测试通过；typecheck 84（=基线）。

## 注意
- 踩坑：排查布局时发现 GET / 与 /index.html 一度比对异常，实为 CSS 类名 replay-enrichment-form(误) vs replay-enrich-form(实) 失配；已修。
- headless 测试产生的 READY run 已清理。
- Workspace 手工点击请硬刷新（Cmd+Shift+R）。

---

