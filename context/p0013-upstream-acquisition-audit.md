# P0013 上游审计报告 — Historical Dataset Acquisition Capability

- 日期：2026-09-13
- 性质：**只读审计**。未修改任何 production code、Replay、Dataset Catalog、Hermes、prompt，未启动 Chrome/CDP 采集，未调用真实 JD endpoint，未新建 Proposal。
- 事实优先级：actual code → executable scripts → trace/runtime artifacts → dataset/manifest → context/ADR → Proposal。文档与代码冲突处以代码/trace 为准并标注。
- 审计方法：4 路并行只读 Explore（执行链重建、能力体系盘点、Replay 反向追踪、文档/ADR 挖掘）+ 承重事实自验（git tracking、目录、manifest sha256 已由子审计核对）。

---

## 1. Executive Verdict

**结论：当前不存在一个 Fabric 可发现、可调用、可复用的正式 Historical Dataset Acquisition Capability。**

三个子能力的成熟度必须拆开看：

| 子能力 | 评级 | 依据 |
|---|---|---|
| Exploration（找端点/找路径） | **PARTIAL** | 有正式 HTTP + MCP 入口（`/api/explore/*`、9 工具单 MCP），但 `record_discovery` 是不持久化的 stub，探索成果不回写 contract/blueprint；静态探索产物存在（`discovery/jd-capability/`，dev-time 被 CLI 消费）。 |
| Acquisition（已知路径再次取数）— **当日** trade.overview | **FORMAL（当日限定）** | 有身份、有契约、可发现、可调度、Hermes 可经 MCP 调用、有 evidence provenance、可重复执行；但只能取北京当日，历史窗口被 ADR-073 fail-closed 显式挡住。 |
| Acquisition — **历史窗口**（getDealOrders 按日切片 + tradeSummary d30 route 改写） | **EXPERIMENTAL** | 仅以 Hermes 09-03 临场写的 9 个 Python 脚本存在，且全部 **untracked（不在 git）**；无身份、无契约、无注册、无产品入口，仅能由 agent 经 terminal 手动重跑。
| Dataset Productization（冻结 5 文件 + manifest 封印） | **ARTIFACT_ONLY** | 消费端（loader/catalog）是 FORMAL；生产端在整个 TS 代码库中不存在。4 个 canonical 数据文件由 Python 脚本写出，`PROVENANCE_MANIFEST.run_id` 和 4 数据文件的能力。
| Replay 消费链（catalog → loader → seed → run） | **FORMAL** | 全部是产品代码、有测试、有路由、有服务端权威校验。 |

**Replay 的上游断点 = Case 3（主导）**：只有 Experiment 脚本和 artifact，没有正式 Historical Acquisition Capability；并带一点 Case 4 的成分（Exploration 相对成形，Acquisition/Productization 仍实验化）。

**最重要的事实纠偏（文档 vs trace 冲突，以 trace 为准）**：

> 09-03 数据集**不是 Experiment D 采集的**。全部 23 个数据文件是 **run C**（`p0011x-followup-2026-09-03T00-33-21-963Z`，北京 08:33–08:43，Hermes session 1aa6ce57）在 10.5 分钟内采集并序列化落盘的；run D（08:54–09:54）**没有做任何采集**，只做了 artifact 审计、2 次 vision_analyze、重算对账，最后在 08:57 用一次 `write_file` 手写了 `PROVENANCE_MANIFEST.json`。

证据：文件 mtime 全部落在 08:35–08:43（manifest 为 08:57）；run C 的 `events.ndjson` 在 631.5s 处完整记录了 Target A 脚本成功执行的 stdout；run D 的 `tool-calls.ndjson` 可枚举全部 18 次工具调用（terminal×14、vision_analyze×2、internal-delete等特殊记法略、write_file×1 = manifest）；D 自己的 `final-message.txt:5-7` 明确写："The previous run did not actually fail — it stopped mid-turn after producing all the deliverables … I audited what was already produced and sealed it with a manifest." ADR-081（`context/decisions.md:2902-2947`）、两份 acceptance report、`context/handoff.md:4103+` 的 "C 失败、D 成功取数" 叙事与 trace 矛盾。

---

## 2. Experiment D Actual Execution Chain

> 严格说：**C 采数、D 封印**。下面按真实执行顺序重建，标注每一步的准确文件/函数。

### 2.1 目录与 trace 证据

- 数据集目录 [data/jd_acquisition_20260903_0834/](data/jd_acquisition_20260903_0834/)：**23 文件 / 约 32MB**（文档常说"24 文件/30MB"，不一致）。
- trace：[data/_blind_runs/p0011x-followup-2026-09-03T00-33-21-963Z/](data/_blind_runs/p0011x-followup-2026-09-03T00-33-21-963Z/)（run C：goal、events.ndjson 329 events、一份**结论错误**的 acceptance-report.md）；[data/_blind_runs/p0011x-followup-d-2026-09-03T00-54-43-736Z/](data/_blind_runs/p0011x-followup-d-2026-09-03T00-54-43-736Z/)（run D：events、tool-calls.ndjson 完整参数+结果、summary.json、final-message.txt）。
- manifest 字段：`manifest_version:"1.0"`、`acquired_at:"2026-09-03T08:43:52+08:00"`（补盖的时间戳，取 Target A 完成时刻，非 08:57 写文件时）、`acquisition_run_id` = **C 的 harness run id**（不是 Hermes session id、不是 D）、shop 11855009 祁门红茶官方旗舰店、window 2026-08-04→09-02 共 30 天 end=today-1、method、endpoints、CSRF 观察、completeness 对账（2412=1450+962、GMV ¥195,136.89、orphan 0）、stop_condition_1_VERIFIED_REAL_DATA。
- **manifest 不记录**：tool chain（Hermes/Playwright/Python）、Hermes session id、逐请求日志、任何内容哈希。它是 LLM 手写的审计摘要，不是机器发射的 provenance。全仓库无任何代码写它（grep 仅命中 loader/catalog 的读取点 [dataset-catalog.ts:26](apps/ecommerce/runtime/replay/dataset-catalog.ts#L26)、[historical-dataset.ts:163](apps/ecommerce/runtime/replay/historical-dataset.ts#L163)）。
- sha256（仅 manifest 字节）= `df8783a72fa21d9f98bf743ed95413f4de781c96ccc3fd569c7ffb7b0dd0499a`，与 DB run、`context/phasej-final-report-2026-09-12.md:6` 一致。

### 2.2 角色分工（trace 证实，非文档转述）

| 角色 | 干了什么 |
|---|---|
| 人 | 启动带 :9222 CDP 的真实 Chrome 并保持 JD 登录；在 Claude Code 里 `npx tsx` 启动盲测 harness；中途因抢前台停掉 run C；批准/打断过一次 D 的命令（D tool-calls call 12: `BLOCKED: Command timed out without user response`）。启动命令本身无 shell 日志，属**文档级证据**。 |
| Claude Code（开发机） | 写两个被动观察的 TS harness 和 goal 文本；起 hermes serve；跑 harness；事后写报告/ADR；用真实页面对账 20 KPI（`/tmp/live_page_evidence.txt` 已随 tmp 消失，**该 20/20 目前不可复现**，仅文档证据）。 |
| **Hermes run C（session 1aa6ce57）** | **写了全部 9 个 Python 脚本（write_file/patch），经 `terminal` 执行，完成发现、CSRF 诊断、1000 行上限诊断、按日切片取单、route 改写取 KPI、全部文件序列化——所有采集动作**。C 的 fabric MCP 调用 = 0，agentFabric 平台在采集阶段零参与。 |
| **Hermes run D（session 7c5a8a97）** | 零采集。ls/find/cat 清点、vision_analyze×2 验证截图、内嵌 python 重算 2412/1450/962/195136.89、**write_file 手写 manifest**；60 分钟 harness 超时结束（无 turn.complete）。 |
| agentFabric 平台 | 采集时无角色；P0013 阶段才变成数据集的消费方。 |

### 2.3 端到端执行链（逐步对应代码）

1. **启动器**：人跑 [scripts/run-p0011x-followup-acquisition.ts](scripts/run-p0011x-followup-acquisition.ts)（D 对应 [-d.ts](scripts/run-p0011x-followup-acquisition-d.ts)）；harness 经 `HermesSessionClient` 连 `ws://localhost:9120/api/ws`（[resolve-url.ts:15](platform/runtime/hermes/resolve-url.ts#L15)），`createSession({cwd: repo})`，提交盲 goal。无 package.json 脚本、无 HTTP 入口调它。
2. **Chrome 附着**：`connect_over_cdp("http://127.0.0.1:9222")`（如 [acquire_jd_orders_discover.py:27](scripts/acquire_jd_orders_discover.py#L27)），用 `browser.contexts[0]` 继承用户 cookie；首个 discover 脚本**复用已有商智 tab**（:30-41），其余脚本 `ctx.new_page()` 一次（同一 cookie context 内开新 tab，不抢当前 tab 导航，但会在前台开 tab）。
3. **Target B 发现**：discover 脚本先挂 response 监听再 goto `orderDetails.html`，点 近30天/查询，被动抓到 SPA 自然发出的 2 个 `getDealOrders.ajax`（**单日** body startDate=endDate=2026-09-02）+ 周边 10 端点；写 `step1_discovery_capture.json`（406KB）、`step1_apis_summary.json`。脚本在抓完后的表格检查阶段崩溃（:213-224，`first_row['headers']` on None），但两个 JSON 已落盘。
4. **宽窗口尝试 + CSRF 捕获**：[acquire_jd_orders_target_b.py](scripts/acquire_jd_orders_target_b.py) 开新 tab，`on_response`  harvest 反 CSRF 三件套 `user-mnp`（每次调用轮换）/`user-mup`/`uuid`（:49-77）；`page.route()` 把 SPA 自然请求 body 改宽到 30 天、pageSize 2000（:82-111）——SPA 自己的 cookie/签名原样搭车，不伪造响应。结果 totalCount=1000，暴露硬上限。
5. **上限实证（3 个诊断脚本）**：[jd_pagination_diag.py](scripts/jd_pagination_diag.py) 9 种翻页/pageSize 组合返回**同样 1000 个订单号**；[walk_jd_orders_all_pages.py](scripts/walk_jd_orders_all_pages.py) 20 页 = 20,000 行但仅 1,000 unique（27MB 重复行归档，**不是 20,000 订单**）；[jd_size_vs_window.py](scripts/jd_size_vs_window.py) 证明返回随行数随窗口线性增长，30 天被截断（¥194,686.89 < ¥195,136.89）。
6. **按日切片（Target B 工作路径）**：[acquire_jd_orders_perday.py](scripts/acquire_jd_orders_perday.py) — 模块加载时从上一脚本 raw 文件读 CSRF（:31-41）；30 次页内 `fetch()`，每天 startDate=endDate=D、pageSize 1000（:63-92）；`header.code==0` 门控（:95-99）；按 `SaleOrdId` 去重（:103-108）；header/child 拍平（:147-191）；写 raw/parsed/csv/summary（:127-259）。08:40 完成：30/30 code=0 → **1450 parent + 962 child = 2412 行，unique 1450**。
7. **Target A 发现与 -407 诊断**：[acquire_jd_target_a_discover.py](scripts/acquire_jd_target_a_discover.py) 抓 tradeSummary 17 个网络事件 + 新鲜 CSRF；[jd_tradesummary_csrf_diag.py](scripts/jd_tradesummary_csrf_diag.py) 用捕获的 header 重放合成请求 → `code=-407/-402 不安全的请求`，确认 summary 类端点因旋转 token 拒绝合成调用，必须搭车 SPA。
8. **route 拦截取数（Target A 工作路径）**：[acquire_jd_target_a.py](scripts/acquire_jd_target_a.py) — route 注册在 goto 前（:102-104）；`handle_route` 把自然请求改成 d30、30 天+环比窗口、hb、industryType（:72-99）；on_response 捕获全部真实响应（:45-70）；选含 d30 的最近 200 响应（:183-204）；解 12 KPI（:205-242）、30 天趋势（:243-274）、品牌/类目（:275-284）；08:43:52 写 `target_a_*` 6 文件 + 截图。
9. **对账（run 内）**：perday summary 做 header GMV/渠道/每日完整性；run D 事后重算并 vision 验证两张页面截图，三角验证 A 的 GMV == B 的 header 合计 == 页面。
10. **封印**：run D Hermes `write_file`（events.ndjson:76，bytes_written 4668）→ `PROVENANCE_MANIFEST.json`。
11. **后来的冻结消费**：P0013 loader 读 manifest 算 sha256（[historical-dataset.ts:154-163](apps/ecommerce/runtime/replay/historical-dataset.ts#L154-L163)），catalog 发现它；文件再未被重写。

### 2.4 注意：09-03 脚本里没有 SzDPParams/Fe/M 签名

09-03 Python 路径是**普通 JSON POST + CSRF 三件套**（orders 合成 fetch 成功；summary 靠 page.route 搭车 SPA）。`SzDPParams`、webpack 模块 99859 `Fe`、4461、22886 那套签名 transport 只存在于**后来（9-07）的 TS** [cdp-client.ts:435](apps/ecommerce/connectors/jd/acquisition/cdp-client.ts#L435)（即 ADR-072 的 trade.overview direct-fetch），与 09-03 数据生产无关——但它是历史窗口取数提升时必须评估的候选 transport（见 §7/§9）。

---

#### 3. Existing Capability Inventory

### 3.1 能力台账（B 问表格）

| Component | Exists | Formal Capability | Callable by Hermes | Production Path | Used by C/D | Reusable |
|---|---|---|---|---|---|---|
| 能力契约定义 [contract-types.ts](apps/ecommerce/connectors/capability/contract-types.ts) | ✅ | 部分（有契约条目 schema，**无强类型 output 契约**，outputs 只是 canonical 指标名列表） | 经 registry/bridge 只读 | build-time 手工配置 + JSON 供应 | ❌ | 中 |
| 能力声明 11 项 [contract-generator.ts:68-339](apps/ecommerce/connectors/capability/contract-generator.ts#L68-L339) `DOMAIN_CONFIGS` | ✅ | **声明式配置，非运行时 registry**；无 register API | `fabric_list_capabilities` 读 JSON | `cli generate-contract` 生成 [generated/capability-contract.json](generated/capability-contract.json)（endpoints 全 null） | ❌ | 中 |
| CapabilityRegistry 意图匹配 [contract-registry.ts:80](apps/ecommerce/connectors/capability/contract-registry.ts#L80) | ✅ | FORMAL（但只服务聊天意图，非取数 dispatch） | 经 chat bridge | `/api/chat`、cli describe | ❌ | 中 |
| 静态 API 清点 [discovery/api-inventory.ts](apps/ecommerce/connectors/discovery/api-inventory.ts) | ✅ | dev-time 模块，**无 route/MCP/调度调用方**；消费方全是 generate-* CLI | ❌ | 仅 CLI 管线 | ✅ 其产物含 09-03 前的探索结果 | 低（对历史取数） |
| 通用 Exploration HTTP+MCP（9 工具）[exploration.ts](platform/server/routes/exploration.ts)、[fabric-mcp-server.mjs:101-258](platform/runtime/fabric-mcp/fabric-mcp-server.mjs#L101-L258) | ✅ | **PARTIAL**：入口正式，但 `record_discovery` stub 不持久化（exploration.ts:730-742）；MCP interact schema 与 wire 不匹配（发 selector，wire 要 element_id）→ 真调 400 | ✅（mcp-fabric 9 工具） | `/api/explore/*` + `/api/explore/run` | ❌（09-03 为 0 fabric 调用） | 中 |
| 当日 direct-fetch 取数 `acquireJdTradeOverviewViaCDP` [cdp-client.ts:829](apps/ecommerce/connectors/jd/acquisition/cdp-client.ts#L829) | ✅ | **FORMAL（当日限定）** | ✅ `fabric_execute_capability`（trade.overview） | `/api/fabric/execute`、scheduler、runtime loop、investigation prompt | ❌ | 高（transport 候选） |
| 快照漫游取数 `acquireJdViaCDP` [cdp-client.ts:192](apps/ecommerce/connectors/jd/acquisition/cdp-client.ts#L192) | ✅ | 半正式：只截 5 个轮询 API，10/11 声明能力取不到数 | 间接（miss path） | `/api/runtime/collect`、cli collect live、chat discover | ❌ | 低 |
| 多页探索 `acquireJdMultiPage` [cdp-client.ts:1035](apps/ecommerce/connectors/jd/acquisition/cdp-client.ts#L1035) | ✅ | Exploration，非结构化取数；仅首页有数据 | ❌ | `POST /api/runtime/discover`、`cli discover jd` | ❌ | 低 |
| dispatch 规划 [binding/planner.ts](apps/ecommerce/connectors/binding/planner.ts) | ✅ | 能力→module→blueprint 端点启发式映射；validation 状态不强制 | 经 execute | fabric/execute | ❌ | 中 |
| Evidence 落盘/入库 [evidence/store.ts:64](apps/ecommerce/connectors/evidence/store.ts#L64) | ✅ | FORMAL for ≤6 dataType；**11 个声明能力中 10 个没有 acquirer，72 条 capture_rules 中 66 条永远不会触发** | 经 kernel | data/evidence 树 + evidence_observations | ❌ | 低（与数据集布局不同） |
| 调度器 [scheduling/scheduler.ts](apps/ecommerce/runtime/scheduling/scheduler.ts) + [runtime-loop.ts](apps/ecommerce/runtime/loop/runtime-loop.ts) | ✅ | FORMAL；生产配置仅 trade.overview enabled，traffic.overview disabled（[index.ts:306-309](platform/server/index.ts#L306-L309)） | ❌ | setInterval 60s | ❌ | — |
| **历史订单按日切片取数** [acquire_jd_orders_perday.py](scripts/acquire_jd_orders_perday.py) | ✅ 工作 | **EXPERIMENTAL**：无身份、无契约、无注册、依赖 conda env + Playwright，**git untracked** | 仅 agent terminal 手动 | 无 | ✅ **Target B 真正生产者** | **高（提取对象 #1）** |
| **历史 KPI/趋势 route 改写取数** [acquire_jd_target_a.py](scripts/acquire_jd_target_a.py) | ✅ 工作 | **EXPERIMENTAL** 同上 | 同上 | 无 | ✅ **Target A 真正生产者** | **高（提取对象 #2）** |
| 发现/诊断脚本 7 个（discover×2、target_b 宽窗尝试、pagination/size/csrf/walk diagnostics） | ✅ | EXPERIMENTAL/一次性 | ❌ | 无 | ✅ | 诊断留档，不提升 |
| 盲测 harness [run-p0011x-followup*.ts](scripts/run-p0011x-followup-acquisition.ts) | ✅ | EXPERIMENTAL：无 npm 入口，人手动 tsx | ❌ | 无 | ✅ 启动器 | 低 |
| Dataset 5 文件 + manifest 写入器 | ❌ **MISSING** | — | — | — | C 的脚本写 4 数据文件；manifest 是 D 的 LLM write_file | — |
| `paginateByWindow()` | ❌ **MISSING** | ADR-081 明确记为工程债（decisions.md:2914,2919,2941） | — | — | 09-03 模式即原型 | — |
| Frozen loader [historical-dataset.ts](apps/ecommerce/runtime/replay/historical-dataset.ts) | ✅ | **FORMAL**（5 文件、Zod、deepFreeze、manifest sha256） | 经 route | catalog/routes/orders | ❌（消费者） | 直接复用 |
| Catalog [dataset-catalog.ts](apps/ecommerce/runtime/replay/dataset-catalog.ts) | ✅ | **FORMAL**（按 PROVENANCE_MANIFEST.json 自动发现） | 经 `GET /api/replay/datasets` | 产品路径 | ❌ | 直接复用（冻结后零改动即可发现新数据集） |
| Replay runner/seeder [replay-runner-p0013.ts](apps/ecommerce/runtime/replay/replay-runner-p0013.ts)、[seed-evidence.ts](apps/ecommerce/runtime/replay/seed-evidence.ts) | ✅ | FORMAL | — | POST /runs | ❌ | 直接复用 |
| Chrome 生命周期 [session-lifecycle.ts](apps/ecommerce/connectors/jd/acquisition/session-lifecycle.ts) | ✅ | 半正式：可启动 Chrome/开商智 tab，但**不能替人登录**；生产 boot 调用 | 间接 | boot `ensureJdSession`（index.ts:357） | ❌ | 高（采集前置复用） |
| cookie 文件路径 `cli onboard-jd` → `.collector-auth/jd.json` | ✅ | **DEAD**：写出的 cookie 文件无任何生产取数代码读取 | ❌ | 无 | ❌ | 不提升 |
| Collector registry [registry.ts](apps/ecommerce/connectors/registry.ts) | ✅ | **DEAD**（仅 barrel re-export，零生产调用方） | ❌ | 无 | ❌ | 不提升 |
| Mock acquirer [mock.ts](apps/ecommerce/connectors/jd/acquisition/mock.ts) | ✅ | 仅 dev/test | ❌ | mock=true 默认 | ❌ | 不进入历史能力 |

### 3.2 能力生命周期实况

`声明(手工DOMAIN_CONFIGS) → build(CLI 产 JSON/blueprint) → 探索(两条互不相通：cli多页/explore工具) → 契约供应(GET /capabilities) → 规划(planner 启发式) → 执行(只有 trade.overview 全通) → evidence(6 dataType) → 消费(situation/replay)`。

对历史采集而言缺失的环节：**①历史 acquirer 本身缺失（orders 完全没有；summary 被当日 guard 挡）；②acquisition→dataset 的 freezer/manifest 发射缺失；③探索成果不回写契约（record_discovery stub + generate 仅 dev-time）**。

### 3.3 MCP 工具全量（9 个，单一 stdio server，默认打 :3000）

[fabric-mcp-server.mjs](platform/runtime/fabric-mcp/fabric-mcp-server.mjs)：`fabric_execute_capability`（→POST /api/fabric/execute，**唯一触发实时取数的 MCP 工具**，当日 trade.overview）、`fabric_list_capabilities`、`fabric_browser_inspect_surface/interact/inspect_network/detect_download/inspect_response/replay_verify/record_discovery`（通用探索，无业务 evidence 写出，record 不持久化）。**没有任何工具产生 frozen dataset**。fabric_browser 重复注册已在 09-03 合并为一个 mcp-fabric toolset（仓库内无 .mcp.json；Hermes 侧注册在仓库外 ~/.hermes/config.yaml，按任务边界未检查）。

---

## 4. Formal Capability Classification

对每个候选按 11 条标准（身份/输入契约/输出契约/可发现/可dispatch/Hermes可调用/不依赖隐藏脚本/不需知道内部端点/provenance/失败语义/可重复执行）判定：

| # | 候选能力 | 评级 | 关键缺口 |
|---|---|---|---|
| 1 | trade.overview 当日采集（getSummary/getTrend via signed direct-fetch） | **FORMAL（当日限定）** | 历史日期被 [trade-overview-date.ts:29](apps/ecommerce/connectors/jd/acquisition/trade-overview-date.ts#L29) + ADR-073 fail-closed 拒绝；依赖人工登录的真实 Chrome :9222（这是既定人机边界，不算缺口）；capability 条目无强类型 output 契约 |
| 2 | 通用 browser Exploration（inspect/interact/network/…） | **PARTIAL** | record_discovery 不持久化；interact 400 schema 错配；发现不回写契约；但 HTTP/MCP 入口、CDP 复用真实 Chrome 是正式的 |
| 3 | 静态 exploration 产物供应（discovery inventory → contract/blueprint） | **PARTIAL** | 纯 build-time；15 页/89 端点的静态清点是资产，但运行时无法通过它取数 |
| 4 | 历史订单采集（getDealOrders 按日切片 + SaleOrdId 去重 + header/child 拍平） | **EXPERIMENTAL** | 仅 [acquire_jd_orders_perday.py](scripts/acquire_jd_orders_perday.py)；无身份/契约/入口；token 跨脚本文件传递（模块加载读上一个脚本的 raw）；SHOP_ID/输出硬编码；**untracked** |
| 5 | 历史 KPI/趋势采集（tradeSummary d30 via page.route 改写） | **EXPERIMENTAL** | 仅 [acquire_jd_target_a.py](scripts/acquire_jd_target_a.py)；同上 |
| 6 | CSRF/动态 token 处理原语（page.route 搭车 SPA） | **EXPERIMENTAL**（Python 侧）/ **FORMAL（仅当日 trade.overview 的 TS signed-fetch 侧）** | 两套机制未统一；历史窗口用哪套未验证（见 §9 风险） |
| 7 | 1000 行上限/按时间分片 | **EXPERIMENTAL**（知识+诊断证据）；`paginateByWindow()` **MISSING** | catalog/jd/endpoints.json 至今不记录 getDealOrders 与 cap；ADR-081 的记账从未兑现 |
| 8 | Dataset Productization（5 文件冻结 + manifest provenance + hash） | **ARTIFACT_ONLY**（消费 FORMAL，生产 MISSING） | 无写入器；现存 manifest 是 LLM 手写、无文件哈希、无 toolchain 记录；测试 tmpdir builder（[dataset-catalog.test.ts:28-50](tests/unit/replay/dataset-catalog.test.ts#L28-L50)）事实上是唯一"布局可执行规范" |
| 9 | Frozen Dataset 消费（loader/catalog/route coverage 400/seed 91 行） | **FORMAL** | 仅注：route 的 path resolve 无 containment 检查（独立问题，§9） |
| 10 | 09-03 盲测 harness（人→Hermes→脚本） | **EXPERIMENTAL** | 一次性验收装置；"Hermes 临场写脚本"按任务明令不能算作可调用能力 |
| 11 | 多店/调度/自动刷新历史数据集 | **MISSING** | 本次也明确不设计 |

---

## 5. Replay Upstream Dependency Gap

反向链（全部 file:line 已核）：

```
Replay UI (replay-view.js:426 GET /datasets；:497 buildCreateBody 不传 hash)
  → route GET /datasets            platform/server/routes/replay.ts:155-162
  → catalog                        dataset-catalog.ts:73-100（扫 data/*/PROVENANCE_MANIFEST.json）
  → POST /runs                     replay.ts:165-216（resolve path :174 → loadHistoricalDataset :177
                                    → 覆盖窗口校验 400 :187-198 → 磁盘真 hash 覆盖客户端 :199-203）
  → createReplayRun                replay-runner-p0013.ts:289-368（INSERT run → seedReplayEvidence :345）
  → seeder 91 行 evidence          seed-evidence.ts:74-249（1 getSummary+30 getTrend+30 perDay+30 perOrder）
  → loader                         historical-dataset.ts:147-278（5 canonical 文件、Zod、deepFreeze）
  → manifest sha256（仅 manifest 字节）historical-dataset.ts:154-163
  → 磁盘 data/jd_acquisition_20260903_0834/
```

**链的终点是人工/agent 一次性生产的冻结目录。断点有两个，且都在生产代码边界之外：**

- **断点 1（Acquisition）**：没有任何 TS 模块、HTTP route、MCP 工具、scheduler 能再次取得"历史窗口的订单+KPI"。当日 trade.overview 是 FORMAL 但被 ADR-073 锁死在当日；历史路径的工作代码只存在于 9 个 untracked Python 脚本，且只能由 Hermes/人经 terminal 运行。
- **断点 2（Productization）**：没有 dataset freezer。即使再次取到数，也没有任何产品代码把输出写成 catalog 可发现的 5 文件布局 + 机器发射的 manifest。现存 manifest 是 run D 的 Hermes 用 `write_file` 手写的（[events.ndjson:76](data/_blind_runs/p0011x-followup-d-2026-09-03T00-54-43-736Z/events.ndjson)）；4 个 canonical 数据文件的生产者是两个 Python 脚本（[acquire_jd_target_a.py:240,258](scripts/acquire_jd_target_a.py#L240)、[acquire_jd_orders_perday.py:193,256](scripts/acquire_jd_orders_perday.py#L193)）。全仓库 `PROVENANCE_MANIFEST` 的写入点为零（产品/脚本中），仅有测试 tmpdir 写。

**判定：Case 3（只有 Experiment D/C 的脚本与 artifact，没有正式 Acquisition Capability）为主，Case 4（Exploration 较正式、Acquisition/Productization 实验化）为辅。** Replay 之所以能跑，是因为冻结 artifact 在磁盘上；删除该目录，Replay 没有任何正式上游可以再生它。

补充：live 采集写的是另一套布局（`data/evidence/jd/2026/…` via [store.ts:35-46](apps/ecommerce/connectors/evidence/store.ts#L35-L46)），与 dataset 5 文件布局互不兼容，没有转换器。

---

## 6. Can We Acquire Again Today?（只读判断，不执行）

**不能。** 不存在可以表达 `AcquireHistoricalDataset(shop, window) → {datasetId, actualWindow, manifestHash, provenance, status}` 的正式入口。

现有入口全部不满足：

| 入口 | 能做什么 | 为什么不算 |
|---|---|---|
| `POST /api/fabric/execute {capability:'trade.overview', date}` / MCP `fabric_execute_capability` | 当日 getSummary/getTrend → evidence 树 | 历史日期被当日 guard 拒绝（ADR-073）；**没有订单端点**；输出不进 dataset 布局 |
| `npm run cli -- collect jd <shop> --mode live --days N` | 快照漫游，截 5 个轮询 API | 同样没有 getDealOrders；输出 evidence 而非 dataset；多日是轮询截获不是显式历史请求 |
| `POST /api/runtime/discover` / `cli discover jd` | 多页探索落 evidence | Exploration 性质，只首页有数据，结构化历史数据取不到 |
| `/api/explore/*` + MCP browser 工具 | 通用页面操作/网络检查 | 无业务取数契约、无 dataset 写出、record 不持久化 |
| Hermes 再写/再跑 Python 脚本 | 事实上能复现 | **任务明令不算**：依赖隐藏脚本与内部端点知识，且脚本 untracked，manifest 还得手写 |

**最小缺口（4 个，缺一不可）：**

1. **历史 acquirer（TS）**：把 perday 按日切片+去重和 tradeSummary route 改写两个已验证模式提升为 `connectors/jd/acquisition/` 下的正式函数，输入 `{cdpPort, shopId, startDate, endDate}`，输出强类型结果 + 失败语义（每日 code、缺日、cap 命中告警）。
2. **1000-cap 感知的窗口分片原语**（ADR-081 欠债 `paginateByWindow`）：宽窗→观察截断→按日切片→自然键去重→求和对账；并把 cap 事实记入 `catalog/jd/endpoints.json`。
3. **Dataset freezer**：把结果序列化成 loader 已锁定的 4 个 canonical 文件（Zod schema 已存在于 [shared/contracts/historical-dataset.ts](shared/contracts/historical-dataset.ts)），并**机器发射** `PROVENANCE_MANIFEST.json`（run id、window、method、逐文件 sha256、toolchain、对账结果——schema 是 `.passthrough()`，加字段不破坏 loader）。
4. **一个编排入口**：最简为 CLI（`cli acquire-historical jd <shopId> --from --to`），写 `data/jd_acquisition_YYYYMMDD_HHMM/`；Catalog 零改动即可自动发现。HTTP/MCP/调度都不必在首版做（YAGNI；任务也明确不做 scheduler）。

前置条件（与现有 FORMAL trade.overview 相同的既定人机边界）：操作员真实 Chrome :9222 + 已登录商智；遵守复用 tab、不抢前台、不开 9223 的硬规则。登录永远是人。

---

## 7. Reuse / Promote / Experimental / Do Not Promote

### 7.1 Reuse As-Is（已满足正式运行要求）

- [dataset-catalog.ts](apps/ecommerce/runtime/replay/dataset-catalog.ts)、[historical-dataset.ts](apps/ecommerce/runtime/replay/historical-dataset.ts)、[shared/contracts/historical-dataset.ts](shared/contracts/historical-dataset.ts)（5 文件契约/Zod/hash/deepFreeze）——新数据集落盘即被发现，**冻结侧零改动**。
- Replay route 的服务端覆盖校验与磁盘 hash 权威（[replay.ts:174-203](platform/server/routes/routes/replay.ts)）、runner/seeder。
- CDP 连接与就绪探针：`isCdpAvailable`/`isJdPageAvailable`、[session-lifecycle.ts](apps/ecommerce/connectors/jd/acquisition/session-lifecycle.ts)（Chrome 启动/tab 打开；登录仍人工）。
- 当日 trade.overview 的完整正式链（MCP/route/scheduler/evidence/对账）——它证明 runtime seam 可用，并作为历史 KPI transport 的对照实验基准。
- Evidence 三角对账思想：orders header GMV == summary GMV（perday summary 已实现该计算，[acquire_jd_orders_perday.py:209-259](scripts/acquire_jd_orders_perday.py#L209-L259)）。

### 7.2 Wrap / Promote（能力已存在，只缺正式契约/编排/翻译）

- **提取 #1：[acquire_jd_orders_perday.py](scripts/acquire_jd_orders_perday.py) → TS `acquireJdHistoricalOrdersViaCDP({shopId,startDate,endDate})`**：按日 fetch、SaleOrdId 去重、header/child 拍平、per_day 汇总（输出形状已被 `OrderDetailRowSchema`/`OrderDetailPerDaySummarySchema` 锁定）。
- **提取 #2：[acquire_jd_target_a.py](scripts/acquire_jd_target_a.py) → TS 历史 tradeSummary acquirer**：route 改写 d30+环比窗口、best-200 选择、12 KPI/趋势解码（输出形状对应 `TradeOverviewSummarySchema`/`TrendPerDaySchema`）。需先做一个只读验证：现有 TS signed webpack transport 在**显式历史窗口**下是否可用；若可用优先复用 TS，否则平移 page.route 模式；ADR-073 的当日 guard 只能经新 ADR 明确豁免（显式历史模式），不能偷偷改。
- **新建薄层 #3：freezeHistoricalDataset()**——这不是重写采集，是补上唯一完全缺失的产品环节：4 文件序列化 + 机器 manifest（含逐文件 sha256）+ 对账门控。
- cap/分片知识 → `catalog/jd/endpoints.json`（getDealOrders 的 1000 cap、按日切片）与能力契约 `endpoints[]`（现在全 null）。
- 测试 tmpdir fixture builder（[dataset-catalog.test.ts:28-50](tests/unit/replay/dataset-catalog.test.ts#L28-L50)）可作为 freezer 输出的校验黄金规范。

### 7.3 Keep Experimental（留档，不进正式路径）

- 3 个诊断脚本（pagination 9 探针、size-vs-window、csrf -407 诊断）——cap 与 token 轮换的**证据资产**，保留只读。
- discover×2 脚本、盲测 harness 两个 TS、09-07 的通用 explorer（collect_jd_data.py / network_interceptor.py / discover-jd-capability-v2.py）——探索/验收装置。
- 27MB `target_b_order_detail_all_orders.json`——重复行归档，证明翻页无效的证据，**绝不能当数据摄入**。
- `acquire_jd_orders_target_b.py`——被 perday 取代的失败宽窗路径，留档。
- `data/_blind_runs/` 全部 trace——历史真相来源（含纠偏证据）。

### 7.4 Do Not Promote

- 脚本里的硬编码 `SHOP_ID="11855009"`、默认 `OUT_DIR=data/jd_acquisition_test`。
- 跨脚本文件传递 CSRF 的脆弱耦合（perday 模块加载时读 target_b raw 文件 :31-41）——正式实现必须在同一会话内获取并即时用 token。
- **手写 manifest 的 provenance 模式**——LLM write_file 不能作为数据集真伪凭据；未来机器发射也**不得重写现有 manifest**（会改变 df8783a7… 哈希，破坏既有 run 的证据链）。
- mock 数据路径、dead 的 onboard-jd cookie 文件、collector registry、disabled backfill、record_discovery stub 的"假成功"语义。
- 盲测报告里错误的"C 失败/D 取数"叙事（在本报告纠偏；不在本任务改历史 ADR）。

---

## 8. Minimal Productization Boundary（只设计，不实现）

目标形态，不引入 Connector Factory、不做通用采集平台、不做多店/调度：

```
操作员发起（CLI 首版；将来可选 HTTP/MCP）
  acquire-historical jd --shop 11855009 --from 2026-08-04 --to 2026-09-02
        │
        ▼
HistoricalAcquisitionOrchestrator（新增薄层，connectors/jd/acquisition/）
  ├─ 前置：isCdpAvailable + isJdPageAvailable（复用）；登录人工
  ├─ orders:  acquireJdHistoricalOrdersViaCDP   ← EXTRACT perday.py
  │            paginateByWindow（cap 感知：按日切片→去重→缺日/cap 告警）
  ├─ trade:   acquireJdHistoricalTradeViaCDP    ← EXTRACT target_a.py（route 改写或验证后的 signed transport）
  ├─ 对账门控：header GMV == summary GMV；每日 code=0；orphan child=0；行数/天数核对
  ▼
freezeHistoricalDataset(rootDir, result, provenance)（新增薄层，runtime/replay/ 或 connectors/jd/）
  ├─ 写 4 canonical 文件（形状 = 现有 Zod 契约；纯函数、不可变风格）
  └─ 机器发射 PROVENANCE_MANIFEST.json：{manifest_version, acquired_at(机器时钟),
       acquisition_run_id(CLI 调用生成的 uuid), shop, time_window(actualWindow),
       method, endpoints, csrf_observations, completeness,
       file_hashes:{每个 canonical 文件 sha256}, toolchain:{runtime, mechanism},
       reconciliation:{…}}
        │
        ▼
data/jd_acquisition_YYYYMMDD_HHMM/   ← 目录名由编排器生成，不再靠 agent mkdir
        │
        ▼
Dataset Catalog（零改动）→ GET /api/replay/datasets 自动出现 → Historical Replay
```

边界约束：

- **提升而非重写**：采集逻辑逐行对应两个已验证 Python 脚本；不"改进"取数方法。
- **契约先行**：输入 `{shopId,startDate,endDate}`（Zod，end≤北京昨日、start≤end），输出 `{datasetId, actualWindow, manifestHash, fileHashes, reconciliation, status}`；失败有正式语义（CDP 不可用/未登录/端点 code≠0/缺日/对账不平 → 命名错误 + 非零退出，不产半成品目录或落 quarantine）。
- **身份**：在 `DOMAIN_CONFIGS` 增一个能力条目（如 `historical.acquisition`，状态先 captured→真实对账后 verified）；是否暴露给 MCP 是后续票的事，首版 CLI 即可（操作员场景是低频、人工监督的窗口采集）。
- **Catalog/Replay 不动**；现有冻结目录字节不动。
- 接受标准必须含**真实页面三角对账**（项目硬规则：测试通过≠验收），以及"Hermes 必须调用 Fabric 正式函数而非自己的脚本"的 Experiment E（D 报告 :390-404 已预留）。
- 建议新 Proposal 承接（本任务不创建）：可命名 P0014 / P0011.x-E "Historical Dataset Acquisition Capability Promotion"。

---

## 9. Risks / Unknowns（独立问题只记录，不修）

1. **脚本未入 git（高）**：9 个 09-03 脚本 + 2 个 TS harness 全部 untracked（本次已自验 `git ls-files` = 0）。唯一工作采集实现可能因一次清理永久丢失。建议提升任务先把它们 commit 留档（原样，不作为产品代码）。
2. **文档/trace 冲突（高，已在 §1 纠偏）**：ADR-081、C/D acceptance report、handoff:4103+、current_state:70,74 把取数归功于 D；还有 ADR 编号撞车（P0013 ADR 块标题误写 ADR-076，decisions.md:2950）、`paginateByWindow` 引用错挂 ADR-075（实为 ADR-081，:3012）、roadmap 停在 08-29 无 P0011.x/P0013 条目、SKU 数 65/70 口径不一、1476 vs 1450 typo、23/24 文件数不一。按 NOT Included 未改任何文档。
3. **单日 1000 上限未知（中）**：按日切片隐含"单日订单 <1000"。09-03 实测单日最多 139 行；大店/大促日可能击穿，需要日内分页或更细切片——目标端点是否支持日内参数未知。
4. **CSRF token 时效（中）**：09-03 orders 用捕获的三件套合成 fetch 30 次全部成功，但 summary 类 -407 必须搭车 SPA；mnp 轮换周期、token 在更长窗口/隔天重跑的有效性未知。正式实现必须会话内即时取 token 并对 -407 有命名失败。
5. **历史窗口 transport 选择未验证（中）**：TS signed direct-fetch（99859/4461/22886）目前只验证过当日且被 ADR-073 guard 显式挡住；它能否携带任意历史日期需要一次受控只读实验决定提取路线（平移 page.route vs 放开/新增历史模式）。
6. **JD 商智可回溯多长（低）**：只实证过近 30 天（end=today-1）；更长窗口是否被服务端接受未知。
7. **manifest 证明力有限（中）**：sha256 只覆盖 manifest 自身字节，4 个数据文件无哈希；现存 artifact 若被改，loader 发现不了。freezer 的 file_hashes 只能保护未来数据集；对现存数据集建议保持字节冻结即可（其证据力另有 DB 91 行与 phase J 对账背书）。
8. **route path 无 containment（低/安全）**：POST /runs `resolve(cwd, sourceDatasetPath)` 接受任意可读路径（[replay.ts:174](platform/server/routes/replay.ts#L174)）；本地单操作员风险低，但属于独立输入校验问题。
9. **既有独立缺陷（不本次修）**：MCP browser `interact` schema 与 wire element_id 不匹配（真调 400）；`record_discovery` stub 假成功；traffic.overview 无 acquirer 且调度保持 disabled 正确；~630 个无 child 的 header 订单台账未平；getSummary `[object Object]` 指标名；backfill/registry/onboard-cookie 为 dead code。
10. **环境依赖（流程）**：若选择 wrap Python 而非 EXTRACT TS，会引入 conda agentFabric + playwright/openpyxl/pandas 的隐藏环境依赖；倾向 TS 提取以与仓库技术栈和"不依赖隐藏脚本"标准一致。
11. **前台干扰（人机规则）**：09-03 脚本除首个 discover 外都 new_page()（会在用户 Chrome 开新 tab，但不导航现有 tab）；正式实现必须遵守复用 tab/不抢前台硬规则，编排期需要操作员知情的会话窗口。
12. **20/20 页面对账不可复现（低）**：当时对账证据在 /tmp 已失；新能力验收必须重新做真实页面对账并留存。

---

## 10. Recommended Next Task

**P0011.x-E（新 Proposal，本次不创建）：Historical Dataset Acquisition Capability Promotion**，建议切片：

1. 先把 9 个 untracked 脚本原样 commit 留档（不改变实验性质）。
2. EXTRACT：TS `acquireJdHistoricalOrdersViaCDP`（按日切片+去重+拍平+per_day）与 `paginateByWindow` 原语（TDD，用 09-03 诊断事实做 cap 行为规格）。
3. 先做只读验证实验决定 Target A transport（signed fetch 历史日期 vs page.route），再 EXTRACT 历史 trade acquirer；如需越过 ADR-073 当日 guard，走新 ADR 的"显式历史模式"。
4. 新建 `freezeHistoricalDataset` + 机器 manifest（file_hashes、run id、toolchain、对账门控）。
5. CLI 编排入口 `acquire-historical jd <shop> --from --to` → `data/jd_acquisition_YYYYMMDD_HHMM/`；Catalog 零改动验证自动发现。
6. 验收（非测试替代）：真实 Chrome :9222 + 真实页面三角对账；随后 Experiment E——Hermes 只能经 Fabric 正式入口完成一次新窗口采集；新旧数据集并存，Replay 时间区间选择器自然出现第二个选项（多数据集下拉在那时才需要，现在继续 YAGNI）。
7. cap 事实回写 `catalog/jd/endpoints.json` 与能力契约；不做调度、不做多店铺框架、不做 Connector Factory。

---

## Final Verdict

> **Historical Dataset Acquisition is: EXPERIMENTAL.**
>
> （工作取数代码真实存在并曾产出 1450 订单/12 KPI 的冻结数据集，但它只以 untracked 的、agent 临场编写的 Python 脚本 + 一次手写 manifest 存在；没有正式身份、契约、dispatch、Hermes 正式边界或 dataset freezer。消费侧 FORMAL，生产侧 EXPERIMENTAL + ARTIFACT_ONLY。）

> **Recommended action: EXTRACT.**
>
> （把两个已验证 Python 脚本的成功路径提升为 TS 正式 acquirer，补上唯一缺失的薄层 freeze/manifest 发射与一个 CLI 编排入口；Catalog/Replay 零改动。不是 REBUILD，不是通用采集平台。）
