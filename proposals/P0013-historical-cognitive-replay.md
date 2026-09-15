# P0013: Historical Cognitive Replay — 真实历史经营认知回放

**Status**: Proposed
**Date**: 2026-09-03
**Depends on**: P0012 Continuous Observation / Business Time；P0011.x Historical Data Acquisition

## Lineage

> ```
> P0006.2 Historical Replay Runtime
>     ↓
> P0011 / P0012 (Evidence / Business Time / Continuous Observation)
>     ↓
> P0011.x Acquisition blocker closure (Real Data Acquisition VERIFIED 2026-09-03, 1450 orders / 12 KPIs / 30-day trend)
>     ↓
> P0013 Historical Cognitive Replay (this proposal)
> ```

- **P0006.2-historical-replay-runtime.md** is marked `SUPERSEDED BY P0013` (kept on disk for historical reference only; not the implementation plan).
- The earlier "P0013 Memory Bridge" entry in `context/p0010_1_productization_baseline.md:131` was a roadmap candidate at the time of P0010.1; that numbering is now retired because P0013 is taken by this proposal. Whether Memory Bridge needs a future independent stage (and what its number will be) is undecided.

## 设计原则 (用户硬要求, 写入 Proposal)

**第一版 Replay 的目的不是证明 Agent 当时一定"判断正确", 而是证明它在严格的历史信息边界下, 能够持续形成有证据依据的判断与建议, 并留下认知轨迹。** 这对后面的 Experience 才有意义。

---


## Objective

建立 AgentFabric 第一版 **Historical Cognitive Replay**：使用真实历史业务数据，按照历史 Business Time 逐日释放 Evidence，让现有 Agent 在不知道未来的前提下重新经历过去的经营过程。

第一版使用两类已经验证可获取的真实数据：

* **交易概况**
* **订单明细**

Replay 每个 Business Date 必须形成一次真实 Agent 经营分析，至少输出 **Understanding / Judgment / Recommendation / Unknowns**；自然月结束时生成一次 **Monthly Review**。

最终能力必须可以由用户在 **Workspace 中亲手启动、逐日查看、连续播放并检查结果**，不能只通过 CLI、测试或 Claude 的验收报告证明。

---

# Background

P0012 已解决：

> 从 Runtime 开始持续运行以后，Business Time 不再丢失。

系统已经能够持续积累：

```text
Evidence
   ↓
Situation Fact Refresh
   ↓
Hourly Observation
   ↓
Business Timeline
```

随后我们希望利用真实历史数据，让 Agent 分析系统上线以前已经发生的经营过程。

但实际进入 Historical Replay 前发现一个前置问题：

> Fabric 对历史真实业务数据的 Acquisition 能力不足。

因此临时进入 P0011.x。

P0011.x Experiment D 已验证 Hermes 可以自主完成：

```text
Exploration
    ↓
Acquisition Engineering
    ↓
Failure Diagnosis
    ↓
Adaptive Acquisition
    ↓
Completeness Handling
    ↓
Verification
    ↓
Real Data Persistence
```

真实验收数据包括：

* 店铺：祁门红茶官方旗舰店
* `shop_id = 11855009`
* 时间范围：2026-08-04 → 2026-09-02
* 1450 unique orders
* 2412 order rows
* ¥195,136.89 GMV
* 12 KPIs
* 30-day trend
* brand/category tables
* 20/20 KPI 与真实页面精确对账

因此：

> **Historical Replay 的 Data Acquisition Blocker 已关闭。**

P0013 回到原来的认知主线。

---

# Architecture

```text
                 REAL HISTORICAL WORLD
                         │
              ┌──────────┴──────────┐
              │                     │
        Trade Overview        Order Details
              │                     │
              └──────────┬──────────┘
                         │
                         ▼
               Historical Dataset
                         │
                         ▼
              Historical Replay Run
                         │
                 Replay Business Clock
                         │
          ┌──────────────┴──────────────┐
          │                             │
     Visible Evidence             Future Evidence
        <= T                           > T
          │                             │
          ▼                             X
      Evidence View               MUST NOT ENTER
          │
          ▼
       Situation
          │
          ▼
      Cognition
   ┌──────┼─────────┐
   ▼      ▼         ▼
Understand Judgment Recommendation
   │
   └─────────┬───────────┐
             │           │
          Unknowns   Evidence Gaps
             │
             ▼
      Daily Cognitive Snapshot
             │
             ▼
       Advance Clock T+1
             │
             ▼
         New Evidence
             │
             ▼
      Next Daily Cognition
             │
             ▼
        End of Month
             │
             ▼
        Monthly Review
```

Production Runtime 与 Replay Runtime 使用相同的业务认知语义，但使用不同的时间来源和数据可见性边界。

---

# Design

## 1. Historical Replay Is Not Simulation

Historical Cognitive Replay 使用：

> **真实发生过的业务 Evidence。**

不得：

* 生成 synthetic historical data；
* 模拟不存在的订单；
* 修改真实经营结果；
* 让 Agent 假装知道历史真实操作；
* 使用最终结果反向指导早期判断。

Replay 的问题是：

> **如果 Agent 当时已经存在，并且只能看到当时已经发生的数据，它会如何理解、判断和建议？**

而不是：

> "我们现在知道结局以后，怎样解释过去。"

---

# 2. Historical Business Clock

Replay 必须拥有独立的：

```text
ReplayBusinessClock
```

概念上：

```text
Production Clock
2026-09-03  → real world

Replay Clock
2026-08-12  → historical world
```

Replay Clock 只能控制 Replay。

### MUST NOT

* 修改系统真实 Business Clock；
* 修改生产 acquisition scheduler；
* 修改 P0012 当前 Observation 时间；
* 通过修改系统时间实现 Replay；
* 让 Replay Evidence 污染 Current Evidence。

---

# 3. No Future Leakage

这是 P0013 最重要的系统不变量。

Replay Clock：

```text
T = 2026-08-12
```

则 Agent 只能读取：

```text
business_time <= 2026-08-12
```

不得读取：

```text
2026-08-13 → replay_end
```

这个限制必须发生在 **Evidence/Data Boundary**，不能只靠 Prompt：

> "请不要看未来数据。"

LLM 不应该拥有未来 Evidence 后再被要求假装不知道。

正确：

```text
Historical Dataset
       ↓
Temporal Visibility Filter
       ↓
Only Evidence <= T
       ↓
Agent
```

错误：

```text
Full Historical Dataset
       ↓
Agent
       ↓
Prompt: "不要使用未来数据"
```

---

# 4. Source Truthfulness

Historical Evidence 的：

```text
business_date
source date
observation window
provenance
```

必须来源于真实 historical source。

禁止重新出现旧 historical acquisition 曾出现过的错误：

> 请求当前数据，然后只修改 `business_date` 标签伪装成历史数据。

Replay Evidence 必须能够追溯到 P0011.x 已验证的真实 historical artifacts。

---

# 5. Replay Dataset

第一版输入明确限定：

### Required

**Trade Overview**

至少包含真实 source 提供的经营 KPI / trend。

**Order Details**

至少包含真实 source 中可获得的：

* order/business time
* order identifier
* SKU/product identity
* quantity
* amount-related fields
* order/payment-related fields

具体 schema 以真实 acquisition artifact 为准。

不要为了 P0013 自创一套与 source 不一致的业务字段。

---

# 6. Raw Historical Data Is Immutable

P0011.x 获得的 Raw Artifact 继续作为事实来源。

Replay：

```text
Raw Historical Artifact
          ↓
Historical Normalization / View
          ↓
Replay Evidence
```

不得：

```text
Replay
   ↓
修改 Raw
```

Replay 的 Cognition / Situation / Recommendation 必须单独存储。

---

# 7. Daily Replay Unit

第一版步长：

> **1 Business Day**

每一天执行一次认知周期。

例如：

```text
08-04 → Daily Analysis
08-05 → Daily Analysis
08-06 → Daily Analysis
...
08-31 → Daily Analysis + Monthly Review
09-01 → Daily Analysis
09-02 → Daily Analysis
```

第一版不做 hourly Historical Replay。

P0012 的 hourly Observation 能力保持不变。

---

# 8. Daily Evidence Context

每日 Agent 至少可以使用：

```text
Today's Trade Overview
+
Today's Order Details
+
Historical Evidence <= T
+
Previous Replay Cognition <= T-1
+
Existing Knowledge / Skill
```

但不能使用：

```text
Future Evidence
Future Cognition
Future Monthly Review
Future Outcome
```

具体 Context Builder 应尽量复用现有 cognition infrastructure。

不要建立第二套 Agent reasoning system。

---

# 9. Daily Analysis Contract

每个 Business Date 必须形成一个持久化 Daily Cognitive Snapshot。

最低输出：

```text
business_date

observed_facts

understanding

judgment

recommendations

unknowns

evidence_gaps

supporting_evidence_refs
```

允许沿用现有 cognition schema，只要语义能够表达这些内容。

不要为了字段名字完全一致而重复造 schema。

---

# 10. Observed Fact / Inference / Confirmed Action Boundary

交易概况和订单明细主要描述：

> **经营结果。**

它们不能可靠证明具体运营人员做过什么。

因此 Replay 必须严格区分：

### Observed Fact

Evidence 直接支持。

例如：

```text
SKU A 销量明显增加
平均成交金额下降
订单数量上升
```

### Inference / Hypothesis

Agent 根据结果推测：

```text
可能存在促销、价格调整或流量变化
```

### Confirmed Action

只有存在直接 Action Evidence 才能确认：

```text
确认参加某活动
确认修改价格
确认增加广告预算
```

第一版没有这些 Evidence 时：

> **不得把 Inference 写成 Confirmed Action。**

---

# 11. Evidence Gap Is a Valid Output

信息不足不是 Replay Failure。

例如：

```text
Observed:
SKU A 成交突然增加

Inference:
可能存在促销或流量资源变化

Evidence Gap:
缺少营销活动记录
缺少流量来源数据
缺少商品价格变更记录
```

这是非常有价值的结果。

未来 Fabric Acquisition 应优先补什么世界数据，可以由重复出现的 Evidence Gap 提供 Evidence。

P0013 不负责补这些数据。

---

# 12. Judgment Is Mandatory

Replay 不能长期只输出：

> "需要更多数据才能判断。"

即使 Evidence 有限，Agent 也应该形成：

> **基于当前 Evidence 的有限判断。**

例如：

```text
Judgment:
当前增长主要集中于少数 SKU，
增长是真实的，但驱动原因尚不能确认。
```

Judgment 可以包含：

* confidence
* uncertainty
* unresolved causes

但必须存在明确的当前判断。

---

# 13. Recommendation Is Mandatory

每个 Daily Cognitive Snapshot 必须输出 Recommendation。

即使：

* 没有 Action capability；
* 当前不能真正执行；
* 不知道历史运营是否采取类似动作；

Agent 仍必须回答：

> **基于当时 Evidence，我建议接下来做什么？**

Recommendation 可以包括：

```text
Business Action Recommendation
Investigation Recommendation
Evidence Acquisition Recommendation
Continue Observation
```

---

# 14. Recommendation ≠ Action

Replay 第一版：

```text
Recommendation
      ↓
PROPOSED
      ↓
NOT EXECUTED
```

不得为了制造闭环：

* 假装执行建议；
* 修改历史业务结果；
* 模拟 Action 后果；
* 假装运营人员接受建议。

这给未来真正的 Action / Feedback Learning 留下边界。

---

# 15. Daily Cognitive Trajectory

Replay 的价值不只是 30 份日报。

必须保留认知演变：

```text
08-05
Judgment A
Recommendation X

08-06
Judgment A strengthened
Recommendation X

08-10
New Evidence
Judgment A → B
Recommendation X → Y

08-15
Situation resolved
Judgment B revised
```

因此历史 Cognition 必须是 append/history semantic。

不得只保留：

```text
latest_judgment
```

而覆盖过去。

---

# 16. Situation Relationship

第一版应尽量复用现有 Situation semantic：

```text
Evidence
   ↓
Situation
   ↓
Cognition
```

但 Replay Situation 必须与 Production Situation 隔离。

至少需要能够回答：

```text
这个 Situation 属于哪个 replay_run？
它在哪个 business_date 出现？
它什么时候持续？
什么时候消失？
它对应哪些 historical Evidence？
```

不得让 Replay Situation 出现在当前生产 Situation 列表中并被当成实时异常。

---

# 17. Cognition Path

P0013 不要求提前完成未来完整的：

> Lightweight Judgment / Deep Investigation Router。

第一版允许复用当前已经存在的 cognition/investigation path。

但是 Replay 需要保留：

```text
judgment
unknowns
evidence_gaps
recommendation
```

以便未来 Cognition Path 分层能够直接作用于 Replay 和 Production。

---

# 18. Monthly Review

自然 Business Month 结束时，生成一次 Monthly Review。

Monthly Review 不能只是：

> 30 个 Daily Analysis 拼接。

输入应该包括：

```text
Monthly Evidence
+
Daily Cognitive Trajectory
+
Situation Trajectory
+
Judgment Evolution
+
Recommendations
```

---

# 19. Monthly Review Output

至少包含：

```text
business_month

data_coverage

business_summary

business_phases

key_situations

judgment_evolution

major_recommendations

supported_judgments

revised_judgments

persistent_unknowns

evidence_gaps

unverified_recommendations
```

其中最重要的是：

> **这个月 Agent 的认知是怎么变化的。**

---

# 20. Recommendation Retrospective Boundary

Monthly Review 可以说：

> 后续 Evidence 支持了 8 月 10 日的判断。

或者：

> 后续 Evidence 使此前判断需要修正。

但没有 Action Evidence 时不能说：

> 8 月 10 日的建议有效。

因为：

```text
Recommendation
≠
Executed Action
≠
Business Outcome caused by Action
```

第一版必须守住因果边界。

---

# 21. Incomplete Month

当前真实数据：

```text
2026-08-04 → 2026-09-02
```

并不包含完整 8 月自然月。

因此正式 Monthly Review 必须记录：

```text
data_coverage
coverage_status
```

如果 8 月只有：

```text
08-04 → 08-31
```

则不得伪装成：

> 完整 8 月经营月报。

可以生成：

> **August Partial-Coverage Review**

并明确：

```text
coverage:
2026-08-04 → 2026-08-31

missing:
2026-08-01 → 2026-08-03
```

如果后续已有 Acquisition 能力能够补齐数据，可以另行获取。

**P0013 本身不重新启动 JD Exploration/Acquisition。**

---

# 22. Replay Run

Replay 必须是明确的一等运行实体，例如概念上：

```text
ReplayRun
```

至少需要：

```text
id
shop_id
source_dataset
start_business_date
end_business_date
current_business_date
step
status
created_at
completed_at
```

状态至少表达：

```text
READY
RUNNING
PAUSED
COMPLETED
FAILED
```

具体 schema 由实现阶段结合现有存储设计确定。

---

# 23. Deterministic Time, Non-Deterministic Cognition

Replay 中必须区分：

### Deterministic

* Business Clock
* Evidence visibility
* source dataset
* date slicing
* provenance
* raw data
* replay order

### Agent-generated

* understanding
* hypothesis
* judgment
* recommendation
* unknowns

不能要求 LLM 两次 Replay 文本 byte-identical。

真正需要可重复的是：

> **同样的历史信息边界。**

---

# 24. Replay Persistence

至少持久化：

```text
Replay Run
Daily Replay Step
Evidence References
Situation References
Cognition Snapshot
Judgment
Recommendations
Monthly Review
```

用户关闭浏览器或重启 dev server 后：

> Replay 结果不能消失。

---

# 25. Workspace — Required Product Surface

Workspace 是 P0013 的正式验收面。

不是 optional UI。

必须提供一个清晰入口：

> **历史回放**

用户无需 CLI。

---

# 26. Workspace — Start Replay

至少能够看到：

```text
历史回放
────────────────────────

店铺
祁门红茶官方旗舰店

数据
✓ 交易概况
✓ 订单明细

数据范围
2026-08-04 → 2026-09-02

数据完整性
[coverage status]

步长
每日

[开始历史回放]
```

用户点击按钮后才启动 Replay。

---

# 27. Workspace — Replay Controls

至少提供：

```text
[◀ 上一天]

[▶ 下一天]

[▶ 连续回放]

[暂停]
```

不要求复杂动画。

重点是：

> 用户能够控制 Business Clock。

---

# 28. Workspace — Timeline

需要能够快速看到 Replay 进度：

```text
08-04 ●
08-05 ●
08-06 ●
08-07 ●
...
08-12 ◀ Current
...
09-02 ○
```

点击已经完成的日期，可以查看当天 Cognition Snapshot。

---

# 29. Workspace — Daily View

点击某一天至少显示：

```text
2026-08-12
──────────────────────

发生了什么
[Observed Facts]

Agent 当前理解
[Understanding]

Agent 判断
[Judgment]

Agent 建议
[Recommendations]

仍待确认
[Unknowns]

缺少的 Evidence
[Evidence Gaps]

Evidence
[Source references]

执行状态
Replay Recommendation — Not Executed
```

这部分应尽量延续当前 Workspace Situation/Cognition 的 IA，而不是另造完全不同的视觉语言。

---

# 30. Workspace — Monthly Review

自然月节点提供：

> **查看月度总结**

至少展示：

```text
经营总结

经营阶段

关键 Situation

Agent 判断演变

主要建议

后来得到 Evidence 支持的判断

后来修正的判断

持续未知问题

Evidence Gaps

无法验证效果的建议
```

---

# 31. Workspace Is Part of Acceptance

以下不能作为 P0013 最终验收：

> "Claude 跑了 30 天 Replay，全部 PASS。"

必须由真实 Workspace 证明：

1. 用户能看到真实 historical dataset；
2. 用户能点击开始；
3. 用户能控制 Replay；
4. 用户能点击具体日期；
5. 用户能看到 Judgment；
6. 用户能看到 Recommendation；
7. 用户能看到 Evidence；
8. 用户能查看月末 Review；
9. 页面刷新后历史 Replay 仍存在。

---

# 32. Data Isolation

必须严格区分：

```text
Production Evidence
Production Situations
Production Cognition

vs

Replay Evidence
Replay Situations
Replay Cognition
```

Replay 不得：

* 触发现实 scheduler；
* 触发现实 Action；
* 污染当前 Situation；
* 修改 Current Evidence；
* 影响 P0012 Observation；
* 被 production recovery 当成未完成任务恢复。

---

# 33. Knowledge / Memory Boundary

Replay 可以读取在该设计下允许的通用 Knowledge/Skill。

但第一版：

### MUST NOT

自动把 Replay 输出直接写入正式 Knowledge。

### MUST NOT

自动把 Recommendation 变成 Skill。

### MUST NOT

让后一个 Replay 日期通过"未来生成的 Knowledge"间接看到未来。

Replay 产生的是：

> **Cognitive Trajectory / Experience Candidate**

不是自动晋升后的 Knowledge。

---

# 34. Experience Candidate

P0013 可以为未来 Experience Layer 留下结构化输入：

```text
Evidence
Judgment
Recommendation
Subsequent Evidence
Judgment Revision
```

但第一版不负责回答：

> "Agent 从这段历史学到了什么永久规则？"

这是后续阶段。

---

# 35. Relationship to P0011.x

P0011.x 已 CLOSED。

P0013 可以消费它已经产生的真实历史数据。

不得重新打开：

* Browser Exploration benchmark；
* JD endpoint discovery；
* Connector Factory；
* acquisition method research；
* `paginateByWindow()`；
* Experiment E。

如果当前 historical artifacts 无法被 Replay 正确消费：

> 报告 Data Contract Blocker。

不要借 P0013 顺手重新开发 Acquisition。

---

# Directory Structure

最终文件位置应结合现有目录确认，但架构上预计涉及：

```text
platform/
  replay/
    historical-replay.*          # replay orchestration / business clock
    replay-store.*               # replay state / trajectory

shared/
  contracts/
    historical-replay.*          # replay contracts if needed

apps/
  ecommerce/
    ...                          # historical dataset adapter/view only if needed

platform/server/
  ...                            # replay API surface

workspace/
  ...                            # existing Workspace UI integration
```

**实现前必须先检查现有 Runtime/Store/API/Workspace 结构，优先 EXTEND，而不是按上面示意创建平行子系统。**

---

# Boundaries

## Included

* 真实历史交易概况输入
* 真实历史订单明细输入
* Historical Dataset contract
* Replay Business Clock
* strict no-future-leak
* daily Business Date stepping
* 每日 Evidence view
* 每日 Situation/Cognition
* 每日 Understanding
* 每日 Judgment
* 每日 Recommendation
* Unknown / Evidence Gap
* Daily Cognitive Snapshot persistence
* Cognitive Trajectory
* natural-month boundary detection
* Monthly Review
* incomplete-month coverage semantics
* Replay Run persistence
* Production / Replay isolation
* Workspace 历史回放入口
* Workspace 开始按钮
* Workspace previous/next/play/pause
* Workspace timeline
* Workspace daily cognition view
* Workspace monthly review view
* 使用 P0011.x 已验证真实数据做 acceptance

---

## NOT Included — CRITICAL

* 不重新探索 JD
* 不重新设计 JD Acquisition
* 不跑 Experiment E
* 不实现 Connector Factory
* 不实现 `paginateByWindow()`
* 不扩商品/流量/营销/用户数据
* 不模拟运营人员真实 Action
* 不伪造历史 Action
* 不执行 Replay Recommendation
* 不模拟 Recommendation 的业务效果
* 不根据未来结果修正过去输入
* 不允许 Future Evidence 泄漏
* 不生成 synthetic historical data
* 不修改 Production Business Clock
* 不污染 Production Evidence/Situation/Cognition
* 不重构现有 Situation Runtime
* 不重写 Investigation architecture
* 不实现完整 Lightweight Judgment / Deep Investigation Router
* 不实现 Experience Learning
* 不自动写 Knowledge
* 不自动生成正式 Skill
* 不训练模型
* 不实现预测未来
* 不做复杂 Replay debugger
* 不为了 UI 建第二套 Workspace
* 不因为 Historical Dataset contract 不顺手而重构整个 Acquisition Layer

---

# Success Criteria

1. Replay 使用真实交易概况 + 订单明细，不使用 seed/mock/synthetic historical business data。

2. Replay 拥有独立 Historical Business Clock，不修改 Production Clock。

3. 在 Business Date `T`，Agent 的输入中不存在任何 `> T` 的 business Evidence。

4. No-future-leak 由数据访问边界保证，而不是仅依赖 Prompt。

5. 每个 Replay Business Date 实际运行一次 Agent cognition。

6. 每日产生并持久化 Observed Facts / Understanding / Judgment / Recommendation / Unknowns / Evidence Gaps。

7. Recommendation 即使无法执行也必须产生，并明确标记为未执行。

8. Agent 不把订单结果推断出的运营行为描述成 Confirmed Action。

9. 每日 Cognition Snapshot 不覆盖历史 Snapshot，可以重建 Judgment evolution。

10. Replay Situation/Cognition 与 Production 数据严格隔离。

11. 月末能够基于当月 Evidence + Daily Cognition Trajectory 生成 Monthly Review。

12. 月报能够区分 Supported Judgment / Revised Judgment / Unverified Recommendation。

13. 不完整自然月必须明确显示 coverage，不得伪装成完整月报。

14. Replay 结果重启后仍可查看。

15. Workspace 中存在明确的"历史回放"入口。

16. 用户可以在 Workspace 中亲手点击启动 Replay。

17. 用户可以手动执行"下一天"，并看到 Business Date 和 Cognition 随之变化。

18. 用户可以连续播放并暂停。

19. 用户可以点击已经 Replay 的某一天查看当天 Judgment + Recommendation + Evidence。

20. 用户可以在 Workspace 查看 Monthly Review。

21. Workspace 明确显示当前 Replay 使用的历史数据范围和完整性。

22. 真实 JD acceptance 至少跑过连续多个 Business Date，而不是单日 demo。

23. Acceptance 必须检查某个中间日期，证明该日 cognition 没有引用未来 Evidence。

24. Claude 的测试报告不能替代 Workspace acceptance；最终必须给出用户可实际点击的调用路径。

25. P0013 完成后，我们能够得到一条真实的：

```text
Historical Evidence
        ↓
Daily Cognition
        ↓
Judgment
        ↓
Recommendation
        ↓
Subsequent Evidence
        ↓
Judgment Evolution
        ↓
Monthly Review
```

而不是只有历史数据图表。

---

## Final Design Principle

P0013 不是：

> "让 AI 总结 30 天 Excel。"

它要建立的是：

> **让 Agent 在严格的历史时间边界下，一天一天重新经历真实经营过程。**

它不知道未来。

它每天必须判断。

它每天必须提出建议。

后来的 Evidence 可以支持或者推翻它以前的判断，但不能改变它当时看到的世界。

月底，我们得到的也不只是一份经营月报，而是一条：

> **Agent Cognitive Trajectory。**

这条轨迹才是未来进入：

```text
Experience
    ↓
Knowledge
    ↓
Skill
    ↓
Agent Growth
```

真正有价值的原材料。
