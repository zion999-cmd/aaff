/**
 * agentFabric — Agent Workspace
 * V1 Sidebar + Agent Transparency / Trace Panel (P0003.1)
 */

// P0010.1 Productization Baseline — pure presentation helpers are
// imported from `./presentation.js` (the single source of truth, also
// unit-tested in tests/contract/investigation.contract.ts). The two
// DOM-coupled wrappers below (renderSourceTag / humanizeError call sites
// inside renderHeroSummary) reuse the pure helpers and inject `escHtml`
// from this module.
//
// P0010.2 closure — the legacy 运营/开发模式 toggle was removed. The
// Workspace permanently renders in operator (business) language. The
// dev-mode branches in `capabilityLabel` / `scrubCapabilityIdsInProse` /
// `renderSourceTag` / `renderHeroSummary` are gone, so the presentation
// helpers are now always invoked with `panelMode = 'business'` (or, in
// the case of `humanizeError`, with the literal constant).

import {
  businessDescribeSituation,
  businessDescribeSituationShort,
  sourceTagLabel,
  sourceTagTooltip,
  humanizeError,
  descClean,
  hasPriorValidCognition,
  // P0010.1 Post-Productization REPAIR — Trust links + Lifecycle + Output
  deriveSituationLifecycle,
  SITUATION_LIFECYCLE_LABEL,
  INVESTIGATION_STATUS_LABEL,
  // P0010.2.4 (ADR-060 audit B) — Investigation display state + banners.
  // Replaces the fuzzy `invBlockedRuntimeFailure` string-match logic that
  // used to contradict itself ("auto-recover, no human action" while a
  // clear-block button was shown). All 6 states + their banner copy
  // live in presentation.js — app.js only reads the state and renders.
  deriveInvestigationDisplayState,
  INVESTIGATION_DISPLAY_BANNER,
  deriveObservationCommitment,
  getSourcePopoverData,
  renderSourcePopoverHtml,
  // P0010.1 Final Repair — Area B: vertical timeline renderer.
  renderSituationTimeline,
  timelineEventLabel,
  // P0010.1 Final Repair — Area C.4: intervention-link helpers.
  deriveLatestAgentActivityId,
  flattenRespondsToActivityIds,
} from './presentation.js';

const toastNode = document.getElementById('toast');

// ═══ i18n ═══════════════════════════════════════════════════
const i18n = {
  'zh-CN': {
    'header.role': '运营总监', 'header.team': '电商运营团队',
    'nav.section.discovery': '发现视图', 'nav.section.analysis': '分析视图',
    'nav.product': '商品分析', 'nav.trend': '趋势观察', 'nav.archive': '历史归档', 'nav.runtime': 'Runtime 执行',
    'sidebar.agent': '运营Agent', 'sidebar.running': '运行中',
    'sidebar.version': '版本', 'sidebar.dataTime': '数据时间',
    'sidebar.decisions': '今日决策', 'sidebar.accuracy': '准确率 (近7天)',
    'decision.title': 'Ranking Explainability · 排名解释',
    'decision.placeholder': '点击左侧商品卡片查看当前排名对应的业务追踪（/api/trace/:traceId）。',
    'trace.rankExplain': '排名解释（Ranking Explainability）· 非 Situation 解释',
    'trace.trust': '信任分 Trust Score',
    'trace.contradictions': '矛盾点 Contradictions',
    'trace.evidence': '证据 / Reasoning',
    'trace.ranking': '排名 Ranking',
    'trace.isSupported': '支持度',
    'trace.noTrace': '当前排名没有对应的 business trace',
    'product.title': '商品分析', 'product.search': '搜索', 'product.placeholder': '输入商品 ID 查看完整画像',
    'product.notFound': '未找到该商品', 'product.score': '综合得分', 'product.rank': '排名',
    'trend.title': '趋势观察', 'trend.subtitle': '信号变化与排名漂移时间轴',
    'archive.title': '历史归档',
    'memory.title': 'Memory 成长', 'memory.subtitle': 'Agent 从运营反馈中学习的知识积累',
    'profile.operator': '运营推荐', 'profile.growth': '增长发现', 'profile.sales': '销售排行',
    'label.score': 'Score', 'label.growth': 'Growth', 'label.competition': 'Competition',
    'label.supply': 'Supply', 'label.quality': 'Quality', 'label.conf': 'Conf', 'label.none': '--',
    'label.updated': 'Updated {time}', 'label.loading': 'Loading...', 'label.unavailable': 'Unavailable',
    'toast.ready': 'Agent Workspace 就绪', 'toast.refreshed': '已刷新',
    // Phase 2
    'nav.section.agent': 'AGENT', 'nav.agentSession': 'Agent Session',
    'nav.section.capability': 'CAPABILITY', 'nav.capabilityExplorer': 'Capability Explorer', 'nav.evidenceViewer': 'Evidence Viewer',
    'session.runtimeUnavailable': 'Runtime integration unavailable', 'session.hermesNotConnected': 'HermesAgent events not connected. Agent Activity display requires HermesAgent integration (Phase 3).',
    'session.contractHint': 'Agent Session defines the UI contract for observable events (intent.resolved, capability.selected, data.requested, acquisition.completed, response.ready). These event slots will be populated when HermesAgent integration is complete.',
    'session.placeholder': 'Agent Session 是您与 HermesAgent 协作的工作视图。',
    'session.placeholderHint': '完整功能需要 HermesAgent Runtime 集成 (Phase 3)。当前展示 UI boundary 和 event contract。',
    'session.activityTitle': 'Agent Activity (observable events)',
    'session.awaitingIntegration': '— awaiting HermesAgent integration',
    'session.inputDisabled': 'Type a question for HermesAgent... (Phase 3)',
    'capability.title': 'agentFabric 现在能获取什么数据？',
    'capability.searchPlaceholder': '搜索能力意图...',
    'capability.domainAll': '全部', 'capability.useInSession': '在 Session 中使用',
    'capability.viewDetail': '查看详情', 'capability.backToList': '← 返回列表',
    'capability.canAnswer': '可以回答', 'capability.metrics': '提供指标',
    'capability.provider': '数据来源', 'capability.constraints': '约束',
    'capability.evidence': 'Evidence', 'capability.openEvidence': '查看 Evidence 链 →',
    'capability.footer': '{total} capabilities · {verified} verified · {blocked} blocked',
    
  },
  en: {
    'header.role': 'Ops Director', 'header.team': 'E-commerce Team',
    'nav.section.discovery': 'Discovery', 'nav.section.analysis': 'Analysis',
    'nav.product': 'Products', 'nav.trend': 'Trends', 'nav.archive': 'Archive', 'nav.runtime': 'Runtime',
    'sidebar.agent': 'Ops Agent', 'sidebar.running': 'Running',
    'sidebar.version': 'Version', 'sidebar.dataTime': 'Data Time',
    'sidebar.decisions': 'Decisions', 'sidebar.accuracy': 'Accuracy (7d)',
    'decision.title': 'Ranking Explainability',
    'decision.placeholder': 'Click a product card to view its business trace for the current ranking.',
    'trace.rankExplain': 'Ranking Explainability — not Situation explanation',
    'trace.trust': 'Trust Score',
    'trace.contradictions': 'Contradictions',
    'trace.evidence': 'Evidence / Reasoning',
    'trace.ranking': 'Ranking',
    'trace.isSupported': 'Supported',
    'trace.noTrace': 'No business trace for the current ranking',
    'product.title': 'Product Analysis', 'product.search': 'Search', 'product.placeholder': 'Enter product ID',
    'product.notFound': 'Product not found', 'product.score': 'Score', 'product.rank': 'Rank',
    'trend.title': 'Trend Watch', 'trend.subtitle': 'Signal & ranking drift time series',
    'archive.title': 'Archive',
    'memory.title': 'Memory Growth', 'memory.subtitle': 'Knowledge from operations feedback',
    'profile.operator': 'Operator', 'profile.growth': 'Growth', 'profile.sales': 'Sales',
    'label.score': 'Score', 'label.growth': 'Growth', 'label.competition': 'Competition',
    'label.supply': 'Supply', 'label.quality': 'Quality', 'label.conf': 'Conf', 'label.none': '--',
    'label.updated': 'Updated {time}', 'label.loading': 'Loading...', 'label.unavailable': 'Unavailable',
    'toast.ready': 'Agent Workspace ready', 'toast.refreshed': 'Refreshed',
    // Phase 2
    'nav.section.agent': 'AGENT', 'nav.agentSession': 'Agent Session',
    'nav.section.capability': 'CAPABILITY', 'nav.capabilityExplorer': 'Capability Explorer', 'nav.evidenceViewer': 'Evidence Viewer',
    'session.runtimeUnavailable': 'Runtime integration unavailable', 'session.hermesNotConnected': 'HermesAgent events not connected. Agent Activity display requires HermesAgent integration (Phase 3).',
    'session.contractHint': 'Agent Session defines the UI contract for observable events (intent.resolved, capability.selected, data.requested, acquisition.completed, response.ready). These event slots will be populated when HermesAgent integration is complete.',
    'session.placeholder': 'Agent Session is your workspace for collaborating with HermesAgent.',
    'session.placeholderHint': 'Full functionality requires HermesAgent Runtime integration (Phase 3). Currently displaying UI boundary and event contract.',
    'session.activityTitle': 'Agent Activity (observable events)',
    'session.awaitingIntegration': '— awaiting HermesAgent integration',
    'session.inputDisabled': 'Type a question for HermesAgent... (Phase 3)',
    'capability.title': 'What data can agentFabric fetch?',
    'capability.searchPlaceholder': 'Search capability intents...',
    'capability.domainAll': 'All', 'capability.useInSession': 'Use in Session',
    'capability.viewDetail': 'View Details', 'capability.backToList': '← Back to list',
    'capability.canAnswer': 'Can answer', 'capability.metrics': 'Metrics',
    'capability.provider': 'Provider', 'capability.constraints': 'Constraints',
    'capability.evidence': 'Evidence', 'capability.openEvidence': 'Open Evidence Chain →',
    'capability.footer': '{total} capabilities · {verified} verified · {blocked} blocked',
  },
};

let currentLang = 'zh-CN';
function t(key) { return i18n[currentLang]?.[key] || i18n.en?.[key] || key; }
function tf(key, vars = {}) { let text = t(key); for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, String(v)); return text; }
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
}

// ═══ State ══════════════════════════════════════════════════
const state = {
  activeView: 'inbox', activeFilter: 'all',
  selectedEntityId: null, findingsData: [],
  rankingsCache: [], memoriesCache: [],
  productNames: {},  // product_id → name
  currentTrace: null, // BusinessConclusionTrace loaded for the selected entity
  // P0010.1 REPAIR: stash the open situation's evidence / knownEvidence /
  // interventions here so the popover dispatcher can resolve any [E]/[K]/[H]
  // click to real content.
  situationContext: null,
  currentSituationId: null,
};

function showToast(msg) { toastNode.textContent = msg; toastNode.classList.add('show'); setTimeout(() => toastNode.classList.remove('show'), 1500); }
async function apiGet(path) { const r = await fetch(path); if (!r.ok) throw new Error(`${r.status}`); const j = await r.json(); return j.data || j; }
async function apiPost(path, body) { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`${r.status}`); const j = await r.json(); return j.data || j; }
function clearNode(n) { while (n.firstChild) n.removeChild(n.firstChild); }

/**
 * Resolve a product entity's display name. A raw product id is NEVER a name.
 * - If the entity has a real name (and it differs from the id), use it.
 * - Otherwise return "未知商品 · SKU <id>". This is the only honest fallback
 *   for catalog rows that were projected with the id as the name.
 */
function entityDisplayName(entity) {
  var id = entity && (entity.id || entity.entity_id) ? (entity.id || entity.entity_id) : '';
  var name = entity && entity.name;
  if (name && name !== id) return name;
  return '未知商品 · SKU ' + id;
}

// ═══ Navigation ═════════════════════════════════════════════
function switchView(name, filter = 'all') {
  state.activeView = name; state.activeFilter = filter;
  document.querySelectorAll('.sidebar-item').forEach(item => {
    const itemView = item.dataset.view, itemFilter = item.dataset.filter;
    item.classList.toggle('active', itemView === name && !itemFilter);
  });
  document.querySelectorAll('.view-container').forEach(c => { c.classList.toggle('active', c.id === `view-${name}`); });
  viewLoaders[name]?.(filter);
}

const viewLoaders = { product: loadProduct, trend: loadTrend, archive: loadArchive, memory: loadMemory, runtime: loadRuntime,
  agentSession: loadAgentSession, capabilityExplorer: loadCapabilityExplorer, evidenceViewer: loadEvidenceViewer,
  knowledge: loadKnowledge,
  situations: loadSituationFeed, situationDetail: loadSituationDetail,
  outputs: loadOutputs, outputDetail: loadOutputDetail };

// ═══ Data Loading ══════════════════════════════════════════
async function loadData() {
  try {
    const [rankings, memories, findings, products] = await Promise.all([
      apiGet('/api/ranking/operator_mode'),
      apiGet('/api/memory'),
      apiGet('/api/workspace/findings?profile=operator_mode'),
      apiGet('/api/products'),
    ]);
    state.rankingsCache = Array.isArray(rankings) ? rankings : [];
    state.memoriesCache = Array.isArray(memories) ? memories : [];
    state.findingsData = Array.isArray(findings) ? findings : [];
    // Build product name lookup
    if (Array.isArray(products)) {
      state.productNames = {};
      products.forEach(function(p) { state.productNames[p.product_id] = p.name || p.product_id; });
    }
  } catch { /* keep caches */ }
}
// ═══ Product Analysis ═════════════════════════════════════
async function loadProduct() {
  const ct = document.getElementById('productContent');
  const searchInput = document.getElementById('productSearchInput');
  const searchBtn = document.getElementById('productSearchBtn');

  // Build product lookup from loaded data
  function findProduct(q) {
    if (!q) return null;
    // Direct ID match
    var byId = state.rankingsCache.find(function(r) { return r.entity_id === q; });
    if (byId) return byId;
    // Substring ID match
    var bySubId = state.rankingsCache.find(function(r) { return r.entity_id.includes(q); });
    if (bySubId) return bySubId;
    // Name match (search productNames)
    for (var id in state.productNames) {
      if (state.productNames[id].includes(q)) {
        return state.rankingsCache.find(function(r) { return r.entity_id === id; }) || { entity_id: id };
      }
    }
    return null;
  }

  // Show product selector dropdown
  function renderProductList() {
    var products = state.rankingsCache.map(function(r) {
      return { id: r.entity_id, name: state.productNames[r.entity_id] || r.entity_id, score: r.overall_score };
    }).sort(function(a,b) { return b.score - a.score; });

    var html = '<div style="max-height:60vh;overflow-y:auto;margin-top:8px"><strong>商品列表 (' + products.length + ')</strong><br/><span class="muted" style="font-size:0.75rem">点击选择商品，或输入名称/ID搜索</span>';
    html += '<div style="margin-top:6px">';
    products.forEach(function(p) {
      html += '<div class="product-list-item" data-pid="' + p.id + '" style="cursor:pointer;padding:8px 10px;margin-bottom:2px;background:var(--card-bg);border-radius:4px;display:flex;justify-content:space-between;align-items:center;font-size:0.78rem">';
      html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:8px">' + (p.name || p.id) + '</span>';
      html += '<span style="font-family:var(--font-mono);font-size:0.7rem;color:var(--muted)">' + p.id.slice(-8) + '</span>';
      html += '<span style="margin-left:8px;font-weight:600;font-size:0.75rem">' + (p.score ? p.score.toFixed(3) : '--') + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
    return html;
  }

  async function search() {
    var q = searchInput.value.trim();

    // If empty, show product list
    if (!q) {
      ct.innerHTML = renderProductList();
      // Click handlers
      ct.querySelectorAll('.product-list-item').forEach(function(el) {
        el.addEventListener('click', function() { searchInput.value = el.dataset.pid; search(); });
      });
      return;
    }

    ct.innerHTML = '<p class="muted">搜索中...</p>';
    try {
      var match = findProduct(q);
      if (!match) { ct.innerHTML = '<p class="muted">未找到匹配 "' + q + '" 的商品。清空搜索框查看完整列表。</p>'; return; }

      var pid = match.entity_id;
      var pname = state.productNames[pid] || pid;

      // Show ranking component breakdown + shop-level GMV context
      var signalsHtml = '';
      try {
        // Shop-level enterprise signals for GMV context
        var shopSignals = await apiGet('/api/signals?entity_type=product&entity_id=jd_shop_001');
        if (shopSignals && shopSignals.length) {
          // Focus on daily_summary — most meaningful metric
          var dailySignals = shopSignals.filter(function(s) { return s.signal_name === 'daily_summary'; }).sort(function(a,b) {
            return (b.observed_at||'').localeCompare(a.observed_at||'');
          });

          if (dailySignals.length > 0) {
            var gmvValues = dailySignals.slice(0, 14).reverse().map(function(s) { return s.signal_value || 0; });
            var latestGmv = gmvValues[gmvValues.length-1] || 0;
            var prevGmv = gmvValues[gmvValues.length-2] || latestGmv;
            var gmvChange = prevGmv > 0 ? ((latestGmv - prevGmv) / prevGmv * 100) : 0;
            var gmvMax = Math.max.apply(null, gmvValues) || 1;

            signalsHtml += '<div style="margin-top:14px"><strong>GMV 趋势</strong>';
            signalsHtml += '<span style="margin-left:6px;font-weight:600;color:' + (gmvChange >= 0 ? 'var(--primary)' : 'var(--danger)') + '">¥' + latestGmv.toLocaleString() + '</span>';
            signalsHtml += '<span style="margin-left:4px;font-size:0.72rem;color:' + (gmvChange >= 0 ? 'var(--primary)' : 'var(--danger)') + '">' + (gmvChange >= 0 ? '↑' : '↓') + Math.abs(gmvChange).toFixed(1) + '%</span>';

            // Mini sparkline
            signalsHtml += '<div style="display:flex;align-items:flex-end;gap:2px;height:32px;margin-top:6px">';
            gmvValues.forEach(function(v) {
              var h = Math.max(3, (v / gmvMax) * 30);
              signalsHtml += '<div title=\"¥' + v.toLocaleString() + '\" style=\"flex:1;background:var(--primary);height:' + h + 'px;border-radius:2px 2px 0 0;opacity:' + (0.3+0.7*v/gmvMax) + ';min-width:4px\"></div>';
            });
            signalsHtml += '</div></div>';
          }

          // Count other signal types
          var typeCounts = {};
          shopSignals.forEach(function(s) { typeCounts[s.signal_name] = (typeCounts[s.signal_name]||0) + 1; });
          signalsHtml += '<div style="margin-top:8px;font-size:0.72rem;color:var(--muted)">' + Object.keys(typeCounts).length + ' signal types · ' + shopSignals.length + ' total observations</div>';
        }
      } catch(e2) { /* optional */ }

      var comp = match.component_scores || {};
      // P0010.1: 0.xxx overall_score is the engine's internal scalar — NOT the
      // business main copy. Show strengths/risks/confidence as "why this matters";
      // overall_score is hidden in business mode and exposed only when the user
      // drills into Developer Mode (see renderTracePanel).
      var expl = match.explainability || {};
      var why = [];
      (expl.strengths || []).slice(0, 2).forEach(function (s) { why.push('<span class="finding-strength">✓ ' + escHtml(s) + '</span>'); });
      (expl.risks || []).slice(0, 2).forEach(function (r) { why.push('<span class="finding-risk">⚠ ' + escHtml(r) + '</span>'); });
      if (!why.length) why.push('<span class="muted" style="font-size:0.72rem">基于多维度指标综合评估</span>');
      ct.innerHTML = '<div class="finding-card" style="cursor:pointer;border-left:4px solid var(--primary)" title="点击查看排名解释 (Ranking Explainability)"><div class="finding-body">' +
        '<div class="finding-header"><span class="finding-entity-name" style="font-size:0.9rem">' + escHtml(entityDisplayName({ id: pid, name: pname })) + '</span></div>' +
        '<div class="finding-why">' + why.join(' ') + '</div>' +
        '<div class="finding-metrics" style="grid-template-columns:repeat(4,1fr);margin-top:8px">' +
          '<div class="finding-metric"><div class="finding-metric-value">' + ((comp.growth||0)*100).toFixed(0) + '%</div><div class="finding-metric-label">Growth</div></div>' +
          '<div class="finding-metric"><div class="finding-metric-value">' + ((comp.competition||0)*100).toFixed(0) + '%</div><div class="finding-metric-label">Competition</div></div>' +
          '<div class="finding-metric"><div class="finding-metric-value">' + ((comp.supply_stability||0)*100).toFixed(0) + '%</div><div class="finding-metric-label">Supply</div></div>' +
          '<div class="finding-metric"><div class="finding-metric-value">' + ((match.confidence||0)*100).toFixed(0) + '%</div><div class="finding-metric-label">Confidence</div></div>' +
        '</div>' + signalsHtml + '</div></div>';
      // Explainability/Trust WIRE: clicking the product card opens the decision panel,
      // which consumes /api/trace/:traceId for the CURRENT ranking (real trust/evidence).
      ct.querySelector('.finding-card')?.addEventListener('click', () => {
        selectFinding({ entityId: pid, entityName: pname });
      });

    } catch (e) { ct.innerHTML = '<p class="muted">加载失败 (' + e.message + ')</p>'; }
  }

  searchBtn.onclick = search;
  searchInput.onkeydown = function(e) { if (e.key === 'Enter') search(); };
  // Show product list on initial load
  if (!ct.dataset.init) { ct.dataset.init = '1'; search(); }
}

// ═══ Memory ════════════════════════════════════════════════
async function loadMemory() {
  const ct = document.getElementById('memoryContent');
  try {
    const mem = await apiGet('/api/memory');
    const items = Array.isArray(mem) ? mem : [];
    ct.innerHTML = items.length
      ? `<div class="list">${items.map(m => `<div class="item"><strong>${m.statement||m.memory_id}</strong><br/><span class="muted">${m.memory_type} | Score: ${m.weight?.final_score?.toFixed(3)||'?'} | Status: ${m.status}</span></div>`).join('')}</div>`
      : '<div class="muted placeholder">暂无已验证的业务经验。<br/><small>Memory 来自运营审核反馈 — 在 Inbox 中对 AI 发现进行"批准/拒绝/修改"操作，验证后的经验会自动积累为 Memory。</small></div>';
  } catch { ct.innerHTML = `<p class="muted">${t('label.unavailable')}</p>`; }
}

// ═══ 工作输出 (REPAIR-3) ═══════════════════════════════════
// P0010.1 REPAIR-3: a Workspace collection surface that aggregates
// every WorkItem across all situations, grouped by status. Read-only:
//   - No transport (no Feishu/WeCom/Email/Telegram).
//   - No Hermes bridge.
//   - No Action execution / Approval flow.
//   - Opening this page does NOT change any WorkItem's status to
//     'delivered'. P0010.1 REPAIR-5: the per-situation /mark-delivered
//     side effect was REMOVED entirely. Status transitions are
//     Operator-driven via PATCH on /api/situations/:id/outputs/:oid;
//     collection / detail endpoints are strictly read-only.
//   - No Event Bus / Wake / Scheduler.
//   - Does NOT change Situation.lifecycle.
//
// P0010.1 REPAIR-6: there is exactly ONE source of truth for these
// labels — the schema in `shared/schemas/output.ts` — exposed to the
// vanilla-JS Workspace by `apps/ecommerce/workspace/output-labels.js`
// as `window.WORK_ITEM_STATUS_LABEL` / `window.WORK_ITEM_TYPE_LABEL`,
// loaded by `index.html` BEFORE this `app.js`. The contract test
// `tests/contract/output-labels-sync.test.ts` enforces the JS mirror
// is in sync with the schema. There are no local copies in this file
// any more.
const getOutputStatusLabel = (status) =>
  (window.WORK_ITEM_STATUS_LABEL || {})[status] || status;
const getOutputTypeLabel = (type) =>
  (window.WORK_ITEM_TYPE_LABEL || {})[type] || type || '交付物';
let outputsActiveStatus = ''; // '' = 全部; otherwise WorkItemStatus

async function loadOutputs() {
  const ct = document.getElementById('outputsContent');
  if (!ct) return;
  ct.innerHTML = '<p class="muted placeholder">加载中…</p>';
  try {
    // P0010.1 REPAIR-5: fetch BOTH the filtered list (for the table) and
    // the unfiltered list (for the sidebar badge). The badge must keep
    // a GLOBAL meaning — "all WorkItems, every status" — not the count
    // of whichever tab the operator currently has open. Without this,
    // switching to the "closed" tab would shrink the badge to a small
    // number, and the operator would lose the global signal.
    const filteredUrl = '/api/outputs' + (outputsActiveStatus ? '?status=' + encodeURIComponent(outputsActiveStatus) : '');
    const [filtered, all] = await Promise.all([
      apiGet(filteredUrl),
      apiGet('/api/outputs'),
    ]);
    const items = Array.isArray(filtered) ? filtered : (filtered && Array.isArray(filtered.data) ? filtered.data : []);
    const allItems = Array.isArray(all) ? all : (all && Array.isArray(all.data) ? all.data : []);
    renderOutputsCollection(items);
    updateOutputsBadge(allItems);
  } catch (e) {
    ct.innerHTML = '<p class="muted">加载失败：' + escHtml(e && e.message ? e.message : String(e)) + '</p>';
  }
}

function updateOutputsBadge(items) {
  // P0010.1 REPAIR-5: the badge is a GLOBAL count of ALL WorkItems
  // across all statuses — not the count of the currently filtered tab.
  // The caller is responsible for passing the unfiltered set.
  const badge = document.getElementById('badgeAllOutputs');
  if (badge) {
    badge.textContent = String(items.length);
  }
}

function renderOutputsCollection(items) {
  const ct = document.getElementById('outputsContent');
  if (!ct) return;
  if (!items.length) {
    ct.innerHTML = '<p class="muted placeholder">当前没有' + escHtml(outputsActiveStatus ? getOutputStatusLabel(outputsActiveStatus) : '') + '输出。<br/><small>提示：所有状态的 WorkItem 来自现有 Situation 的 outputs[]，未复制第二套 Store。</small></p>';
    return;
  }
  var html = '<div class="outputs-collection">';
  items.forEach(function (o) {
    html += renderCollectionOutputItem(o);
  });
  html += '</div>';
  ct.innerHTML = html;
}

function renderCollectionOutputItem(o) {
  // Output Workspace v0: this row is operator-facing (交付中心). It
  // deliberately hides raw dev identifiers (outputId / situationId /
  // resultRef: learning_context · ctx_xxx) in business mode. The
  // Output Detail view is where dev/diagnostic info lives, if ever.
  var status = o.status || 'ready';
  var typeLabel = getOutputTypeLabel(o.type);
  var statusLabel = getOutputStatusLabel(status);
  var createdAt = (o.createdAt || '').slice(0, 16).replace('T', ' ');
  var content = o.content || '';
  var sit = o.situation || {};
  var sitId = sit.situationId || o.situationId || '';
  var outputId = o.outputId || '';
  var entityName = sit.entityName || sit.entityId || sitId || '未知来源';
  var entityType = sit.entityType || '';
  var entityPlatform = sit.entityPlatform || '';
  var sitDescription = (sit.description || '').slice(0, 60);

  // "查看交付物" — opens the new Output Detail view (not Situation).
  // Always available; the Output Detail page is the operator-facing
  // record of this deliverable.
  var viewOutputBtn = '<button class="btn primary output-collection-view-output" data-output-action="open-output" data-output-id="' + escHtml(outputId) + '">查看交付物</button>';

  // "查看来源调查" — always available (every Output traces back to a
  // source Situation). Operator-facing copy: the *Situation* name, not
  // the situationId.
  var sitLink = '<a href="#" class="output-source-link" data-output-action="open-situation" data-situation-id="' + escHtml(sitId) + '">' +
    escHtml(entityName) +
    (entityType ? ' <span class="muted">(' + escHtml(entityType) + (entityPlatform ? ' · ' + escHtml(entityPlatform) : '') + ')</span>' : '') +
  '</a>';

  return '<div class="output-collection-item" data-output-id="' + escHtml(outputId) + '" data-output-status="' + escHtml(status) + '">' +
    '<div class="output-row1">' +
      '<span class="output-type">' + escHtml(typeLabel) + '</span>' +
      '<span class="output-content-summary">' + escHtml(content) + '</span>' +
      '<span class="output-status output-status-' + escHtml(status) + '">' + escHtml(statusLabel) + '</span>' +
    '</div>' +
    '<div class="output-meta">' +
      (sitDescription ? '<span class="output-source-summary">' + escHtml(sitDescription) + '</span>' : '') +
      '<span class="output-source">来源：' + sitLink + '</span>' +
      '<span class="output-created-at">生成：' + escHtml(createdAt || '—') + '</span>' +
    '</div>' +
    '<div class="output-actions">' +
      viewOutputBtn +
    '</div>' +
  '</div>';
}

/** Tab click dispatcher (init once). */
let outputsTabsInit = false;
function initOutputsTabs() {
  if (outputsTabsInit) return;
  outputsTabsInit = true;
  const tabs = document.getElementById('outputsTabs');
  if (!tabs) return;
  tabs.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('.feed-tab');
    if (!btn) return;
    ev.preventDefault();
    tabs.querySelectorAll('.feed-tab').forEach(function (t) { t.classList.toggle('active', t === btn); });
    outputsActiveStatus = btn.getAttribute('data-status') || '';
    loadOutputs();
  });
}

/** Output row click dispatcher (init once). */
let outputsCollectionInit = false;
function initOutputsCollectionDispatcher() {
  if (outputsCollectionInit) return;
  outputsCollectionInit = true;
  const ct = document.getElementById('outputsContent');
  if (!ct) return;
  ct.addEventListener('click', function (ev) {
    // 1) "查看交付物" → open the Output Detail view (NOT Situation).
    var openOutput = ev.target.closest && ev.target.closest('[data-output-action="open-output"]');
    if (openOutput) {
      ev.preventDefault();
      var oid = openOutput.getAttribute('data-output-id');
      if (!oid) return;
      if (typeof switchView === 'function') {
        switchView('outputDetail', oid);
      } else if (typeof loadOutputDetail === 'function') {
        loadOutputDetail(oid);
      }
      return;
    }
    // 2) Source link / "查看来源调查" → open the source Situation Detail.
    var a = ev.target.closest && ev.target.closest('[data-output-action="open-situation"]');
    if (!a) return;
    ev.preventDefault();
    var sitId = a.getAttribute('data-situation-id');
    if (!sitId) return;
    // Navigate to the Situation Detail. switchView activates #view-situation-detail
    // and triggers loadSituationDetail via viewLoaders. Without switchView, the
    // data is fetched + rendered into #situationDetailContent but the container
    // stays hidden and the operator still sees the Output collection page.
    if (typeof switchView === 'function') {
      switchView('situationDetail', sitId);
    } else if (typeof loadSituationDetail === 'function') {
      loadSituationDetail(sitId);
    }
  });
}

// ═══ Output Detail (independent view) ═══════════════════════
// P0010.1 Output Workspace v0: clicking "查看交付物" in the collection
// page opens this view — NOT the Situation Detail. The Output is its
// own first-class entity (交付物) and the right pane shows Source /
// Trust (not the Investigation Track). The 4 regions are:
//   A. 交付内容       — type-specific rendered body
//   B. 交付状态       — timestamps + transport honest-state
//   C. 来源与追溯     — Situation link + judgment/recommendation + Trust popover
//   D. 当前可做的操作 — lifecycle transitions ONLY (no transport)
let outputDetailCurrent = null; // last fetched output, used by right pane
async function loadOutputDetail(outputId) {
  const ct = document.getElementById('outputDetailContent');
  if (!ct) return;
  if (!outputId) {
    ct.innerHTML = '<p class="muted placeholder">未提供交付物 ID。</p>';
    return;
  }
  ct.innerHTML = '<p class="muted placeholder">加载中...</p>';
  const decisionPanel = document.getElementById('decisionPanel');
  const decisionContent = document.getElementById('decisionContent');
  if (decisionContent) decisionContent.innerHTML = '';
  if (decisionPanel) decisionPanel.classList.remove('open');

  try {
    const out = await apiGet('/api/outputs/' + encodeURIComponent(outputId));
    outputDetailCurrent = out;
    renderOutputDetail(out);
    renderOutputDetailRightPane(out);
  } catch (e) {
    ct.innerHTML = '<p class="muted">加载失败：' + escHtml(e && e.message ? e.message : String(e)) + '</p>';
  }
}

function renderOutputDetail(out) {
  const ct = document.getElementById('outputDetailContent');
  if (!ct) return;
  if (!out) { ct.innerHTML = '<p class="muted placeholder">交付物不存在。</p>'; return; }

  // P0010.1 REPAIR-5: single source of truth for labels — import from
  // the schema (exposed via window globals in index.html). No more
  // drift between schema and Workspace.
  const status = out.status || 'ready';
  const statusLabel = getOutputStatusLabel(status);
  const typeLabel = getOutputTypeLabel(out.type);
  const createdAt = (out.createdAt || '').slice(0, 16).replace('T', ' ');
  const acknowledgedAt = (out.acknowledgedAt || '').slice(0, 16).replace('T', ' ');
  const closedAt = (out.closedAt || '').slice(0, 16).replace('T', ' ');
  const sit = out.situation || {};
  const sitId = sit.situationId || out.situationId || '';
  const entityName = sit.entityName || sit.entityId || '未知来源';
  const sitDescription = (sit.description || '').slice(0, 100);
  const cs = out.currentSituation || {};
  const judgment = cs.judgment || '';
  const stopReason = cs.stopReason || '';
  const recText = cs.recommendation || '';
  const rationale = cs.recommendationRationale || '';
  const understanding = cs.understanding || '';
  const prov = out.provenance || { hasHuman: false, humanInterventions: [], hasEvidence: false, evidenceLabels: [], hasKnowledge: false, knowledgeLabels: [] };

  // ---- Region A: 交付内容 ----
  var bodyA = '<p class="output-detail-content">' + escHtml(out.content || '') + '</p>';

  // ---- Region B: 交付状态 ----
  // P0010.1 REPAIR-5: removed the "交付时间" row. The schema does not
  // record deliveredAt; we must NOT display a timestamp that is
  // always "—" — that is dishonest. There is no Transport here, so
  // there is no delivery event. We keep the 4 honest rows: current
  // state + created/acknowledged/closed timestamps.
  var bodyB = '<table class="output-status-table">' +
    rowKV('当前状态', '<span class="output-status output-status-' + escHtml(status) + '">' + escHtml(statusLabel) + '</span>') +
    rowKV('生成时间', escHtml(createdAt || '—')) +
    rowKV('确认时间', escHtml(acknowledgedAt || '—')) +
    rowKV('关闭时间', escHtml(closedAt || '—')) +
    rowKV('交付渠道', '<span class="muted">Workspace（当前阶段）</span>') +
    rowKV('外部发送', '<span class="muted">尚未启用 — 无飞书 / 邮件 / 企业微信 / Telegram 通道</span>') +
  '</table>';

  // ---- Region C: 来源与追溯 ----
  var bodyC = '<div class="output-source-block">' +
    '<div class="output-source-line">来源 Situation：' +
      '<a href="#" class="output-source-link" data-output-action="open-situation" data-situation-id="' + escHtml(sitId) + '">' +
        escHtml(entityName) +
      '</a>' +
      (sitDescription ? ' <span class="muted">— ' + escHtml(sitDescription) + '</span>' : '') +
    '</div>' +
    '<div class="output-source-line">' +
      '<button class="btn" data-output-action="open-situation-from-detail" data-situation-id="' + escHtml(sitId) + '">查看原始调查</button>' +
    '</div>' +
  '</div>';

  if (judgment || recText || understanding) {
    bodyC += '<div class="output-judgment-block">' +
      '<h5 class="muted" style="font-size:0.75rem;margin:12px 0 6px">判断依据（当前 Situation 状态）</h5>';
    if (understanding) bodyC += '<p class="muted" style="margin:4px 0"><small>理解：</small>' + escHtml(understanding) + '</p>';
    if (judgment) bodyC += '<p class="muted" style="margin:4px 0"><small>判断：</small>' + escHtml(judgment) + (stopReason ? ' <span class="muted">（停止：' + escHtml(stopReason) + '）</span>' : '') + '</p>';
    if (recText) bodyC += '<p class="muted" style="margin:4px 0"><small>建议：</small>' + escHtml(recText) + '</p>';
    if (rationale) bodyC += '<p class="muted" style="margin:4px 0"><small>理由：</small>' + escHtml(rationale) + '</p>';
    bodyC += '<p class="muted" style="font-size:0.7rem;margin-top:6px">注：以上为当前 Situation 状态，非生成时快照（schema 未快照化）。</p>';
    bodyC += '</div>';
  }

  // ---- Region C (provenance block) ----
  // P0010.1 REPAIR-5: ONLY render source categories for which there
  // is a real record. We must NOT fabricate E/H/K/M tags when the
  // Output does not actually reference any of them. The schema
  // returns `provenance` with concrete facts; we honor that.
  var realSources = [];
  if (prov.hasEvidence) realSources.push({ kind: 'evidence', label: '证据' });
  if (prov.hasHuman) realSources.push({ kind: 'human', label: '人工' });
  if (prov.hasKnowledge) realSources.push({ kind: 'knowledge', label: '知识' });
  if (realSources.length > 0) {
    bodyC += '<div class="output-trust-block">' +
      '<h5 class="muted" style="font-size:0.75rem;margin:12px 0 6px">真实来源</h5>' +
      '<div class="source-tag-row">';
    for (var i = 0; i < realSources.length; i++) {
      var src = realSources[i];
      bodyC += '<span class="source-tag" data-trust="' + escHtml(src.kind) + '">' + escHtml(src.label) + '</span>';
    }
    bodyC += '</div></div>';
  } else {
    bodyC += '<p class="muted" style="font-size:0.7rem;margin-top:6px">本交付物尚无 first-class provenance（无具体证据 / 人工 / 知识记录）。</p>';
  }

  // ---- Region D: 当前可做的操作 ----
  var bodyD = '';
  if (status === 'ready' || status === 'delivered') {
    bodyD += '<button class="btn primary" data-output-action="ack" data-output-id="' + escHtml(out.outputId) + '" data-output-situation-id="' + escHtml(sitId) + '">已知悉 / 确认收到</button>';
  }
  if (status !== 'closed') {
    bodyD += '<button class="btn" data-output-action="close" data-output-id="' + escHtml(out.outputId) + '" data-output-situation-id="' + escHtml(sitId) + '">关闭交付物</button>';
  }
  if (!bodyD) {
    bodyD = '<p class="muted">该交付物已关闭，无可操作项。</p>';
  }
  var forbiddenNote = '<p class="muted" style="font-size:0.7rem;margin-top:8px">当前阶段不允许发送到飞书 / 邮件 / 企业微信 / Telegram；不允许执行业务操作；不允许审批流。</p>';

  ct.innerHTML = '<div class="output-detail-header">' +
    '<a href="#" class="output-back-link" data-output-action="back-to-outputs">← 返回工作输出</a>' +
    '<h2 class="output-detail-title">' + escHtml(typeLabel) + ' <span class="output-status output-status-' + escHtml(status) + '">' + escHtml(statusLabel) + '</span></h2>' +
    '<p class="output-detail-source muted">' + escHtml(entityName) + (sit.entityType ? ' · ' + escHtml(sit.entityType) : '') + (sit.entityPlatform ? ' · ' + escHtml(sit.entityPlatform) : '') + '</p>' +
  '</div>' +
  '<div class="output-detail-region output-detail-region-content">' +
    '<h4 class="output-detail-region-title">📦 交付内容</h4>' +
    bodyA +
  '</div>' +
  '<div class="output-detail-region output-detail-region-status">' +
    '<h4 class="output-detail-region-title">📬 交付状态</h4>' +
    bodyB +
  '</div>' +
  '<div class="output-detail-region output-detail-region-source">' +
    '<h4 class="output-detail-region-title">🔗 来源与追溯</h4>' +
    bodyC +
  '</div>' +
  '<div class="output-detail-region output-detail-region-actions">' +
    '<h4 class="output-detail-region-title">⚙️ 当前可做的操作</h4>' +
    bodyD +
    forbiddenNote +
  '</div>';
}

function rowKV(k, v) {
  return '<tr><td class="output-kv-key muted">' + escHtml(k) + '</td><td class="output-kv-val">' + v + '</td></tr>';
}

function renderOutputDetailRightPane(out) {
  // Output Detail right pane = Source / Trust (NOT Investigation Track).
  // P0010.1 REPAIR-5: only render source categories for which there
  // is a real record (provenance.hasHuman / hasEvidence / hasKnowledge).
  // Never fabricate E/H/K/M tags when no record exists.
  const panel = document.getElementById('decisionPanel');
  const content = document.getElementById('decisionContent');
  const label = document.getElementById('decisionEntityLabel');
  if (!panel || !content) return;
  if (label) label.textContent = '来源 / Trust';
  const sit = (out && out.situation) || {};
  const cs = (out && out.currentSituation) || {};
  const prov = (out && out.provenance) || { hasHuman: false, humanInterventions: [], hasEvidence: false, evidenceLabels: [], hasKnowledge: false, knowledgeLabels: [] };
  const sitId = sit.situationId || '';
  const entityName = sit.entityName || sit.entityId || '—';

  var realSources = [];
  if (prov.hasEvidence) realSources.push({ kind: 'evidence', label: '证据' });
  if (prov.hasHuman) realSources.push({ kind: 'human', label: '人工' });
  if (prov.hasKnowledge) realSources.push({ kind: 'knowledge', label: '知识' });

  var html = '<div class="output-trust-pane">' +
    '<h4 class="muted" style="font-size:0.78rem;margin:0 0 8px">来源</h4>' +
    '<p style="font-size:0.78rem;margin:0 0 12px"><a href="#" data-output-action="open-situation" data-situation-id="' + escHtml(sitId) + '">' + escHtml(entityName) + '</a></p>';
  if (cs.judgment) {
    html += '<h4 class="muted" style="font-size:0.78rem;margin:8px 0">当前判断</h4>' +
      '<p style="font-size:0.78rem;margin:0 0 8px">' + escHtml(cs.judgment) + '</p>';
  }
  if (cs.recommendation) {
    html += '<h4 class="muted" style="font-size:0.78rem;margin:8px 0">当前建议</h4>' +
      '<p style="font-size:0.78rem;margin:0 0 8px">' + escHtml(cs.recommendation) + '</p>';
  }

  if (realSources.length > 0) {
    html += '<h4 class="muted" style="font-size:0.78rem;margin:12px 0 6px">真实来源</h4>' +
      '<div class="source-tag-row">';
    for (var i = 0; i < realSources.length; i++) {
      var src = realSources[i];
      html += '<span class="source-tag" data-trust="' + escHtml(src.kind) + '">' + escHtml(src.label) + '</span>';
    }
    html += '</div>';
  } else {
    html += '<p class="muted" style="font-size:0.7rem;margin-top:12px">本交付物尚无 first-class provenance（无具体证据 / 人工 / 知识记录）。</p>';
  }
  html += '<p class="muted" style="font-size:0.7rem;margin-top:12px">右栏为 Trust / Source 视角；完整调查过程请打开来源 Situation。</p>' +
  '</div>';
  content.style.display = 'block';
  content.innerHTML = html;
  panel.classList.add('open');
}

// ═══ Trend ════════════════════════════════════════════════
var trendProductId = null; // null = all products, string = specific product

async function loadTrend() {
  const ct = document.getElementById('trendContent');
  try {
    // Build product selector
    var products = state.rankingsCache.map(function(r) {
      return { id: r.entity_id, name: state.productNames[r.entity_id] || r.entity_id, score: r.overall_score };
    }).sort(function(a,b) { return b.score - a.score; });

    var selectorHtml = '<div style="margin-bottom:12px"><select id="trendProductSelect" class="input select" style="font-size:0.78rem;max-width:300px">';
    selectorHtml += '<option value="">全部商品 (店铺总览)</option>';
    products.forEach(function(p) {
      var selected = trendProductId === p.id ? ' selected' : '';
      selectorHtml += '<option value="' + p.id + '"' + selected + '>' + (p.name || p.id).slice(0, 40) + ' (' + p.id.slice(-6) + ')</option>';
    });
    selectorHtml += '</select></div>';
    ct.innerHTML = selectorHtml + '<div id="trendChartArea"><p class="muted">加载中...</p></div>';

    // Bind change event
    document.getElementById('trendProductSelect').addEventListener('change', function() {
      trendProductId = this.value || null;
      loadTrend(); // reload with new selection
    });

    var chartArea = document.getElementById('trendChartArea');
    if (!chartArea) return;

    // daily_summary is always shop-level (entity_id=jd_shop_001).
    // Product-level signals are computed metrics (gmv_growth, sales_growth, etc.).
    // Always fetch shop signals for the GMV chart, regardless of product filter.
    var shopUrl = '/api/signals?entity_type=product&entity_id=jd_shop_001';
    var shopSignalsPromise = apiGet(shopUrl);

    // If a product is selected, also fetch its computed signals
    var productSignalsPromise = trendProductId
      ? apiGet('/api/signals?entity_type=product&entity_id=' + trendProductId)
      : Promise.resolve(null);

    var shopSignals = await shopSignalsPromise;
    var productSignals = await productSignalsPromise;

    if (!shopSignals || !shopSignals.length) {
      chartArea.innerHTML = '<p class="muted placeholder">暂无信号数据。请先在 Runtime 页面采集数据。</p>';
      return;
    }

    // Group shop-level daily_summary signals by date (GMV chart)
    var dailyByDate = {};
    shopSignals.forEach(function(s) {
      if (s.signal_name !== 'daily_summary') return;
      var date = (s.observed_at || '').slice(0, 10);
      if (!date) return;
      if (!dailyByDate[date]) dailyByDate[date] = { gmv: 0, orders: 0, count: 0 };
      dailyByDate[date].gmv += s.signal_value || 0;
      var m = s.metrics || {};
      dailyByDate[date].orders += m.orders || 0;
      dailyByDate[date].count++;
    });

    var dates = Object.keys(dailyByDate).sort().reverse();
    var recentDates = dates.slice(0, 14);
    var title = trendProductId ? (state.productNames[trendProductId] || trendProductId) : '店铺总览';
    var subtitle = title + ' · ' + dates.length + ' 天数据';
    if (trendProductId) subtitle += ' (GMV为店铺级数据)';
    var html = '<div style="margin-bottom:8px;font-size:0.8rem;color:var(--muted)">' + subtitle + '</div>';

    // GMV Trend sparkline — always from shop-level daily_summary
    if (Object.keys(dailyByDate).length >= 2) {
      var gmvValues = dates.slice(0, 14).reverse().map(function(d) { return dailyByDate[d] ? dailyByDate[d].gmv : 0; });
      var gmvMax = Math.max.apply(null, gmvValues) || 1;
      var gmvLatest = gmvValues[gmvValues.length - 1] || 0;
      var gmvPrev = gmvValues[gmvValues.length - 2] || gmvLatest;
      var gmvChange = gmvPrev > 0 ? ((gmvLatest - gmvPrev) / gmvPrev * 100) : 0;

      html += '<div style="margin-bottom:16px">';
      html += '<strong>店铺 GMV 趋势 (14天)</strong>';
      html += '<span style="margin-left:8px;font-size:1.1rem;font-weight:600;color:' + (gmvChange >= 0 ? 'var(--primary)' : 'var(--danger)') + '">¥' + gmvLatest.toLocaleString() + '</span>';
      html += '<span style="margin-left:4px;font-size:0.78rem;color:' + (gmvChange >= 0 ? 'var(--primary)' : 'var(--danger)') + '">' + (gmvChange >= 0 ? '↑' : '↓') + Math.abs(gmvChange).toFixed(1) + '% vs 昨日</span>';

      html += '<div style="display:flex;align-items:flex-end;gap:3px;height:48px;margin-top:8px;padding:4px 0">';
      gmvValues.forEach(function(v) {
        var h = Math.max(4, (v / gmvMax) * 44);
        html += '<div title="¥' + v.toLocaleString() + '" style="flex:1;background:var(--primary);height:' + h + 'px;border-radius:3px 3px 0 0;opacity:' + (0.3 + 0.7 * (v/gmvMax)) + ';min-width:6px"></div>';
      });
      html += '</div>';

      var weekGmv = gmvValues.slice(-7).reduce(function(a,b){return a+b;}, 0);
      var prevWeekGmv = gmvValues.slice(-14, -7).reduce(function(a,b){return a+b;}, 0);
      var wowChange = prevWeekGmv > 0 ? ((weekGmv - prevWeekGmv) / prevWeekGmv * 100) : 0;
      html += '<div style="display:flex;gap:12px;margin-top:6px;font-size:0.75rem">';
      html += '<span>近7天 GMV: <strong>¥' + Math.round(weekGmv).toLocaleString() + '</strong></span>';
      html += '<span style="color:' + (wowChange >= 0 ? 'var(--primary)' : 'var(--danger)') + '">环比: ' + (wowChange >= 0 ? '+' : '') + wowChange.toFixed(1) + '%</span>';
      html += '</div>';
      html += '</div>';
    } else {
      html += '<p class="muted">暂无店铺 daily_summary 信号。请先在 Runtime 页面采集数据。</p>';
    }

    // Product-level computed signals (only shown when a product is selected)
    if (trendProductId && productSignals && productSignals.length) {
      var latestProductSignals = {};
      productSignals.forEach(function(s) {
        var key = s.signal_name;
        if (!latestProductSignals[key] || (s.observed_at || '') > (latestProductSignals[key].observed_at || '')) {
          latestProductSignals[key] = s;
        }
      });
      var pKeys = Object.keys(latestProductSignals).sort();
      if (pKeys.length) {
        html += '<div style="margin-bottom:14px"><strong>商品指标 (最新)</strong>';
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;margin-top:6px;font-size:0.75rem">';
        pKeys.forEach(function(k) {
          var v = latestProductSignals[k].signal_value;
          var displayVal = typeof v === 'number' ? (Math.abs(v) < 1 ? (v*100).toFixed(1)+'%' : v.toFixed(3)) : String(v||'--');
          html += '<div style="padding:6px 10px;background:var(--card-bg);border-radius:4px;display:flex;justify-content:space-between">';
          html += '<span class="muted">' + k + '</span>';
          html += '<span style="font-weight:600;font-family:var(--font-mono)">' + displayVal + '</span>';
          html += '</div>';
        });
        html += '</div></div>';
      }
    }

    // Daily detail table — always shop-level daily_summary
    if (recentDates.length > 0) {
      html += '<div style="max-height:50vh;overflow-y:auto"><strong>每日概况 (店铺级)</strong>';
      html += '<div style="margin-top:6px;font-size:0.75rem">';
      recentDates.forEach(function(d) {
        var day = dailyByDate[d];
        var gmv = day ? day.gmv : 0;
        var orders = day ? day.orders : 0;
        var color = gmv > 8000 ? 'var(--primary)' : gmv > 4000 ? 'inherit' : 'var(--muted)';
        html += '<div style="display:flex;justify-content:space-between;padding:6px 10px;margin-bottom:2px;background:var(--card-bg);border-radius:4px;align-items:center">';
        html += '<span style="font-family:var(--font-mono);font-size:0.75rem">' + d.slice(5) + '</span>';
        html += '<span style="color:' + color + ';font-weight:600">¥' + gmv.toLocaleString() + '</span>';
        html += '<span class="muted">' + orders + ' 单</span>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    chartArea.innerHTML = html;
  } catch (e) { ct.innerHTML = '<p class="muted placeholder">趋势数据加载失败 (' + e.message + ')</p>'; }
}

// ═══ Archive ══════════════════════════════════════════════
async function loadArchive() {
  const ct = document.getElementById('archiveTimeline');
  const profile = document.getElementById('archiveProfileSelect')?.value || 'operator_mode';
  try {
    const rankings = await apiGet(`/api/ranking/${profile}`);
    if (!rankings.length) { ct.innerHTML = '<p class="muted placeholder">暂无归档数据 — 运行一次排名计算</p>'; return; }
    let html = '<div class="timeline">';
    rankings.slice(0, 20).forEach((r, i) => {
      // P0010.1: archive (business view) does NOT lead with overall_score. The
      // scalar moves to Developer Mode (renderTracePanel). The archive shows the
      // operator-friendly "why this rank" — confidence + strengths/risks.
      var strengths = (r.explainability?.strengths || []).slice(0, 2).join('，') || '—';
      var conf = Math.round((r.confidence || 0) * 100) + '%';
      html += `<div class="timeline-day ${r.explainability?.risks?.length ? 'changed' : ''}" style="cursor:pointer" data-id="${r.entity_id}">
        <span><strong>#${i + 1}</strong> ${entityDisplayName({ id: r.entity_id, name: state.productNames[r.entity_id] })}</span>
        <span>支持度 ${conf} · ${strengths}</span>
        <span>${(r.explainability?.risks||[]).slice(0,1).join('，') || '无明显风险'}</span>
      </div>`;
    });
    html += '</div>';
    ct.innerHTML = html;
    ct.querySelectorAll('.timeline-day').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        const f = state.findingsData.find(x => (x.entityId||x.entity_id) === id);
        if (f) { selectFinding(f); state.activeView = 'archive'; }
      });
    });
  } catch (e) { ct.innerHTML = `<p class="muted placeholder">加载失败 (${e.message})</p>`; }
}
document.getElementById('archiveProfileSelect')?.addEventListener('change', loadArchive);

	// ═══ Runtime Execution ════════════════════════════════════
	// P0010.2.3 (ADR-059 audit D-2) — Loop state surface.
	// Reads GET /api/runtime/loop and renders running/lastTickAt/tickCount/blockedCount.
	// blockedCount drives the loopBlockedBadge so operators see blocked
	// situations without opening the URL. Renders honest "unknown" placeholders
	// when fields are missing (no fabrication). Errors render an honest
	// "[loop] state unavailable" string — never throw silently.
	async function loadLoopStatus() {
	  const el = document.getElementById('loopStatus');
	  const badge = document.getElementById('loopBlockedBadge');
	  if (!el) return;
	  try {
	    const resp = await apiGet('/api/runtime/loop');
	    const state = resp && (resp.data ?? resp);
	    if (!state) {
	      el.innerHTML = '<span class="muted">[loop] state unavailable</span>';
	      return;
	    }
	    const running = state.running === true ? '✓ 运行中' : (state.running === false ? '✗ 已停止' : '? 未知');
	    const lastTick = state.lastTickAt
	      ? new Date(state.lastTickAt).toLocaleString()
	      : '时间未记录';
	    const tickCount = typeof state.tickCount === 'number' ? state.tickCount : '?';
	    const blockedCount = typeof state.blockedCount === 'number' ? state.blockedCount : 0;
	    el.innerHTML =
	      '<strong>RuntimeLoop</strong> · ' + running +
	      ' · 上次 tick: ' + escapeHtml(lastTick) +
	      ' · 累计 tick: ' + tickCount +
	      ' · <span style="color:' + (blockedCount > 0 ? '#991b1b' : 'inherit') + '">阻塞: ' + blockedCount + '</span>';
	    if (badge) {
	      if (blockedCount > 0) {
	        badge.textContent = '⚠ 阻塞 ' + blockedCount;
	        badge.style.display = 'inline-block';
	      } else {
	        badge.style.display = 'none';
	      }
	    }
	  } catch (e) {
	    el.innerHTML = '<span class="muted">[loop] state unavailable (' + (e && e.message ? e.message : 'unknown') + ')</span>';
	  }
	}

	async function loadRuntime() {
	  // P0010.2.3 (ADR-059 audit D-2) — refresh Loop state alongside the
	  // execution history. No new event / route / router change; this is
	  // the single call site for the view-runtime view.
	  await loadLoopStatus();
	  const list = document.getElementById('runtimeExecutionsList');
	  const countEl = document.getElementById('runtimeExecCount');
	  const status = document.getElementById('runtimeCollectStatus');
	  list.innerHTML = '<p class="muted">Loading execution history...</p>';
	  try {
	    const executions = await apiGet('/api/runtime/executions?platform=jd&limit=366');
	    if (!executions || !executions.length) {
	      list.innerHTML = '<p class="muted placeholder">No execution records. Collect data first from Runtime panel.</p>';
	      if (countEl) countEl.textContent = '';
	      return;
	    }

	    // Summary stats
	    var totalSignals = 0, totalEvidence = 0, completedDays = 0, failedDays = 0;
	    executions.forEach(function(ex) {
	      totalSignals += ex.signalCount || 0;
	      totalEvidence += ex.evidenceCount || 0;
	      if (ex.status === 'completed') completedDays++;
	      else failedDays++;
	    });

	    // Sort by date ascending for timeline display
	    var sorted = executions.slice().sort(function(a,b) { return a.date.localeCompare(b.date); });
	    var firstDate = sorted[0].date;
	    var lastDate = sorted[sorted.length-1].date;

	    if (countEl) countEl.textContent = '(' + executions.length + ' days)';

	    // Summary bar
	    var html = '<div style="display:flex;gap:16px;margin-bottom:14px;flex-wrap:wrap">';
	    html += '<div style="background:var(--card-bg);padding:8px 14px;border-radius:6px"><span class="muted" style="font-size:0.7rem">Total Signals</span><div style="font-weight:600;font-family:var(--font-mono)">' + totalSignals.toLocaleString() + '</div></div>';
	    html += '<div style="background:var(--card-bg);padding:8px 14px;border-radius:6px"><span class="muted" style="font-size:0.7rem">Evidence</span><div style="font-weight:600;font-family:var(--font-mono)">' + totalEvidence.toLocaleString() + '</div></div>';
	    html += '<div style="background:var(--card-bg);padding:8px 14px;border-radius:6px"><span class="muted" style="font-size:0.7rem">Completed</span><div style="font-weight:600;color:var(--primary)">' + completedDays + '/' + executions.length + '</div></div>';
	    if (failedDays > 0) html += '<div style="background:var(--card-bg);padding:8px 14px;border-radius:6px"><span class="muted" style="font-size:0.7rem">Failed</span><div style="font-weight:600;color:var(--danger)">' + failedDays + '</div></div>';
	    html += '<div style="background:var(--card-bg);padding:8px 14px;border-radius:6px"><span class="muted" style="font-size:0.7rem">Date Range</span><div style="font-weight:600;font-family:var(--font-mono);font-size:0.78rem">' + firstDate + ' → ' + lastDate + '</div></div>';

	    // Source stats (P0006.3.2)
	    var srcCounts = { cdp: 0, mock: 0, 'import': 0, none: 0, unknown: 0 };
	    executions.forEach(function(ex) { var s = ex.evidenceSource || 'none'; srcCounts[s] = (srcCounts[s]||0) + 1; });
	    var srcLabels = { cdp: '🟢 Live CDP', mock: '⚪ Mock', 'import': '🟡 Import', none: '⬜ None', unknown: '❓ Unknown' };
	    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;font-size:0.7rem;margin-top:2px">';
	    for (var src in srcCounts) { if (srcCounts[src] > 0) html += '<span style="padding:2px 8px;background:var(--card-bg);border-radius:10px">' + (srcLabels[src]||src) + ': ' + srcCounts[src] + '</span>'; }
	    html += '</div>';
	    html += '</div>';

	    // Timeline — scrollable day-by-day grid
	    html += '<div style="max-height:55vh;overflow-y:auto;margin-bottom:12px">';
	    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:4px">';		    sorted.forEach(function(ex) {
		      var isCompleted = ex.status === 'completed';
		      var bgColor = isCompleted ? 'var(--card-bg)' : '#fff0f0';
		      var borderColor = isCompleted ? 'var(--primary)' : 'var(--danger)';
		      var statusIcon = isCompleted ? '✅' : '❌';
		      var src = ex.evidenceSource || 'none';
		      var srcIcon = src === 'cdp' ? '🟢' : src === 'mock' ? '⚪' : src === 'import' ? '🟡' : '⬜';
		      var dateLabel = ex.date.slice(5);
		      html += '<div class="runtime-timeline-day" data-date="' + ex.date + '" style="cursor:pointer;padding:6px 8px;background:' + bgColor + ';border-left:3px solid ' + borderColor + ';border-radius:4px;font-size:0.72rem" title="' + ex.date + ': ' + ex.signalCount + ' sig | src: ' + src + '">';
		      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
		      html += '<span style="font-family:var(--font-mono)">' + dateLabel + '</span>';
		      html += '<span style="font-size:0.65rem">' + srcIcon + '</span>';
		      html += '</div>';
		      html += '<div class="muted" style="font-size:0.65rem">' + ex.signalCount + ' sig</div>';
		      html += '</div>';
		    });
	    html += '</div></div>';

	    list.innerHTML = html;
	    list.querySelectorAll('.runtime-timeline-day').forEach(function(el) {
	      el.addEventListener('click', function() { loadRuntimeDetail(el.dataset.date); });
	    });
	  } catch (e) {
	    list.innerHTML = '<p class="muted placeholder">Load failed (' + e.message + ')</p>';
	  }
	  if (status) status.textContent = '';
	}

async function loadRuntimeDetail(date) {
  var detail = document.getElementById('runtimeDetail');
  var content = document.getElementById('runtimeDetailContent');
  detail.style.display = 'block';
  content.innerHTML = '<p class="muted">加载 ' + date + ' 详情...</p>';
  try {
    var data = await apiGet('/api/runtime/executions/' + date);
    var signals = data.signals || [];
    var breakdown = data.signalBreakdown || [];
    var html = '<div style="margin-bottom:16px"><strong>日期:</strong> ' + data.date + ' | <strong>状态:</strong> ' + data.status + ' | <strong>信号总数:</strong> ' + data.signalCount + '</div>';
    if (breakdown.length) {
      html += '<div style="margin-bottom:12px"><strong>信号分类:</strong><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">';
      breakdown.forEach(function(b) {
        html += '<span style="background:var(--card-bg);padding:4px 10px;border-radius:12px;font-size:0.75rem;font-family:var(--font-mono)">' + b.signal_name + ': ' + b.count + '</span>';
      });
      html += '</div></div>';
    }
    if (signals.length) {
      var dailySignals = signals.filter(function(s) { return s.signal_name === 'daily_summary'; });
      if (dailySignals.length) {
        html += '<div style="margin-top:12px"><strong>Daily Summary</strong>';
        dailySignals.forEach(function(s) {
          html += '<div style="margin-top:6px;padding:10px 14px;background:var(--card-bg);border-radius:6px;border-left:3px solid var(--primary)">';
          html += '<div style="display:flex;justify-content:space-between;align-items:center">';
          html += '<span style="font-family:var(--font-mono)">' + (s.observed_at||'').slice(0,10) + '</span>';
          html += '<span style="font-weight:600;font-size:1.1rem">¥' + (s.signal_value||0).toLocaleString() + '</span>';
          html += '</div>';
          // P0010.1: no raw signal_id in business UI — show only the support metric.
          // Runtime view is in the "系统 / Advanced" sidebar, but signal_id is still
          // an internal id, not operator language. Support is what the operator reads.
          html += '<div class="muted" style="font-size:0.72rem;margin-top:2px">支持度: ' + Math.round((s.confidence||0)*100) + '%</div>';
          html += '</div>';
        });
        html += '</div>';
      }
      var otherSignals = signals.filter(function(s) { return s.signal_name !== 'daily_summary'; });
      if (otherSignals.length) {
        html += '<div style="margin-top:12px"><strong>Other Signals (' + otherSignals.length + ')</strong>';
        html += '<div class="list" style="margin-top:6px;max-height:40vh;overflow-y:auto">';
        otherSignals.slice(0, 20).forEach(function(s) {
          html += '<div class="item" style="padding:6px 10px;margin-bottom:3px;background:var(--card-bg);border-radius:4px;font-size:0.75rem">';
          html += '<span style="font-weight:600">' + s.signal_name + '</span>';
          html += ' <span style="font-family:var(--font-mono)">' + (s.signal_value||0) + '</span>';
          html += ' <span class="muted">' + (s.signal_unit||'') + '</span>';
          html += '</div>';
        });
        html += '</div></div>';
      }
    }
    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = '<p class="muted placeholder">加载详情失败 (' + e.message + ')</p>';
  }
}
// ═══ P0007.3 Situation Feed ═══════════════════════════════
async function loadSituationFeed(filter) {
  filter = filter || 'all';
  var list = document.getElementById('situationFeedList');
  var subtitle = document.getElementById('situationFeedSubtitle');
  list.innerHTML = '<p class="muted placeholder">加载 Situation 中...</p>';

  // Update tab active state
  document.querySelectorAll('#situationFeedTabs .feed-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.filter === filter);
  });

  try {
    var data = await apiGet('/api/situations');
    var situations = Array.isArray(data) ? data : (data.situations || []);
    if (!situations.length) {
      list.innerHTML = '<p class="muted placeholder">暂无 Situation。运行 CDP 采集后，系统会自动创建 Situation。</p>';
      if (subtitle) subtitle.textContent = '0 个 Situation';
      updateSituationBadges({ all: 0, pending: 0, investigating: 0, observing: 0, needs_human: 0, judgment_ready: 0 });
      return;
    }

    // Filter — P0010.1: mutually-exclusive Agent investigation status
    // (pending / investigating / observing / needs_human / judgment_ready).
    // Each situation maps to EXACTLY one status; counts never overlap.
    var statusOf = function(s) { return (s.investigation && s.investigation.status) || 'pending'; };
    var filtered = situations;
    if (filter === 'pending') filtered = situations.filter(function(s) { return statusOf(s) === 'pending' || statusOf(s) === 'failed'; });
    else if (filter === 'investigating') filtered = situations.filter(function(s) { return statusOf(s) === 'investigating'; });
    else if (filter === 'observing') filtered = situations.filter(function(s) { return statusOf(s) === 'observing'; });
    else if (filter === 'needs_human') filtered = situations.filter(function(s) { return statusOf(s) === 'needs_human'; });
    else if (filter === 'judgment_ready') filtered = situations.filter(function(s) { return statusOf(s) === 'judgment_ready'; });

    var counts = { all: situations.length, pending: 0, investigating: 0, observing: 0, needs_human: 0, judgment_ready: 0 };
    situations.forEach(function(s) {
      var st = statusOf(s);
      if (st === 'pending' || st === 'failed') counts.pending++;
      else if (st === 'investigating') counts.investigating++;
      else if (st === 'observing') counts.observing++;
      else if (st === 'needs_human') counts.needs_human++;
      else counts.judgment_ready++;
    });
    updateSituationBadges(counts);

    if (subtitle) subtitle.textContent = filtered.length + ' 个 Situation';

    var html = '';
    filtered.forEach(function(s) {
      var entity = s.entity || {};
      var temporal = s.temporal || {};
      // P0010.1 REPAIR: drop the legacy "已处理/待处理/待观察" badge (the
      // situations.lifecycle field is now a Content-shape flag, not a
      // business lifecycle). The card now shows the 5-state Situation
      // lifecycle derived from the agent-status-chip + intervention count.
      var inv = s.investigation || null;
      var interventionCount = s.interventionCount || 0;
      var hasAcceptedDecision = !!s.hasAcceptedDecision;
      var lifecycle = deriveSituationLifecycle(inv, interventionCount, hasAcceptedDecision);
      if (lifecycle === 'closed') lifecycle = 'watching';
      var lcLabel = SITUATION_LIFECYCLE_LABEL[lifecycle] || '';
      var lcIcon = lcLabel.split(' ')[0] || '';
      var lcText = lcLabel.replace(/^[^\s]+\s+/, '');
      var badge = '<span class="situation-card-badge lifecycle-' + lifecycle + '">' + escHtml(lcIcon + ' ' + lcText) + '</span>';
      // P0010.1: Agent business status from persisted investigation (never re-computed).
      var inv = s.investigation || null;
      var statusChip = '';
      if (!inv || inv.status === 'pending') {
        statusChip = '<span class="agent-status-chip uninvestigated">待调查</span>';
      } else if (inv.status === 'investigating') {
        statusChip = '<span class="agent-status-chip investigating">调查中</span>';
      } else if (inv.status === 'failed') {
        statusChip = '<span class="agent-status-chip failed">调查未完成</span>';
      } else if (inv.status === 'observing') {
        statusChip = '<span class="agent-status-chip observing">观察中</span>';
      } else if (inv.status === 'needs_human') {
        statusChip = '<span class="agent-status-chip needs-human">需人工核验</span>';
      } else {
        // P0010.1 Final Repair — Area D: "判断已形成" is informational, not
        // triumphal. Autonomous by default — human interruptible, blocking
        // only when necessary. The chip should not read as "case closed".
        statusChip = '<span class="agent-status-chip judgment-ready">判断已形成</span>';
      }
      var judgmentLine = inv && inv.judgment ? '<div class="situation-card-judgment">Agent 判断: ' + escHtml(inv.judgment.slice(0, 70)) + '</div>' : '';
      // P0010.1: strip a leading entity-id from the description so the card
      // title doesn't render "未知商品 · SKU 101 · 101 …" (duplicate id).
      var entityId = (entity && (entity.id || entity.entity_id)) || '';
      var cardDescClean = (s.description || '');
      if (entityId && cardDescClean.indexOf(entityId) === 0) {
        cardDescClean = cardDescClean.slice(entityId.length).replace(/^[\s·,\-，]+/, '');
      }
      cardDescClean = cardDescClean.slice(0, 60);
      var dateLabel = (temporal.observedAt || s.createdAt || '').slice(0, 10);
      html += '<div class="situation-card" data-situation-id="' + escHtml(s.situationId) + '" data-lifecycle="' + escHtml(lifecycle) + '">' +
        '<div class="situation-card-top">' +
          '<span class="situation-card-title">' + escHtml(entityDisplayName(entity)) + ' · ' + escHtml(cardDescClean) + '</span>' +
          badge +
        '</div>' +
        '<div class="situation-card-summary">' + escHtml(cardDescClean.slice(0, 80)) + '</div>' +
        judgmentLine +
        '<div class="situation-card-footer">' +
          statusChip +
          '<span>' + dateLabel + ' · ' + (s.interventionCount || 0) + ' 条反馈</span>' +
          '<span class="situation-card-action">查看详情 →</span>' +
        '</div>' +
      '</div>';
    });
    list.innerHTML = html || '<p class="muted placeholder">当前过滤器下无 Situation。</p>';

    // Click → detail (switch immediately → show "加载中", then load data)
    list.querySelectorAll('.situation-card').forEach(function(card) {
      card.addEventListener('click', function() {
        currentSituationId = card.dataset.situationId;
        switchView('situationDetail');
      });
    });
  } catch (e) {
    list.innerHTML = '<p class="muted placeholder">加载失败 (' + e.message + ')</p>';
  }
}

function updateSituationBadges(counts) {
  var badges = {
    badgeAllSituations: counts.all,
    badgePendingSituations: counts.pending,
    badgeInvestigatingSituations: counts.investigating,
    badgeObservingSituations: counts.observing,
    badgeNeedsHumanSituations: counts.needs_human,
    badgeJudgmentSituations: counts.judgment_ready,
  };
  Object.keys(badges).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.textContent = badges[id] > 0 ? badges[id] : '--'; }
  });
}

// ═══ P0007.3 Situation Detail + Interaction ══════════════
var currentSituationId = null; // track which situation is in the detail view

// ═══ P0007.3 Situation Detail — real analysis/recommendation (Consolidation Pass 2) ═══

// Deterministic recommendation from the situation's metric + direction tags.
var SITUATION_RECOMMENDATIONS = {
  uv: { down: '访客数下降：优先检查流量来源渠道的变化，确认搜索/推荐/投放是否被削弱或分流。', up: '访客数上升：确认流量来源与质量，判断是否为可持续增长而非一次性波动。' },
  cvr: { down: '转化率下降：检查商品详情页、价格、评价与库存状态，定位转化路径的阻断点。', up: '转化率改善：确认改善来源（页面/价格/活动），判断是否为可复制的做法。' },
  gmv: { down: '成交金额下降：结合访客数与转化率，先定位是流量问题还是转化问题。', up: '成交金额上升：确认驱动因素（流量/转化/客单价），判断增长是否健康。' },
  orders: { down: '订单量下降：检查客单价与转化率，确认订单结构是否发生变化。', up: '订单量上升：确认增长来源，判断是否可持续。' },
};

function renderAgentRecommendation(tags) {
  var metric = tags[1] || '';
  var direction = tags[2] || '';
  var rec = SITUATION_RECOMMENDATIONS[metric];
  if (rec && rec[direction]) return rec[direction];
  return '结合访客数、转化率与成交金额的变化，定位当前波动的驱动因素后决定下一步。';
}

// Render the Pattern Engine attribution ("why did this change") as the agent's
// understanding. Falls back to the description when no explanation is available.
function renderAgentUnderstanding(explanation, desc) {
  if (!explanation) return '<p class="muted">暂无归因数据。Agent 分析基于可用信号：' + escHtml(desc) + '</p>';
  var driver = explanation.primary_driver || '未知';
  var conf = explanation.driver_confidence != null ? Math.round(explanation.driver_confidence * 100) + '%' : '—';
  var html = '<p>主要驱动因素: <strong>' + escHtml(driver) + '</strong>（置信度 ' + conf + '）</p>';
  var evidence = explanation.evidence || [];
  if (evidence.length > 0) {
    html += '<ul style="margin:6px 0;padding-left:18px">';
    evidence.slice(0, 3).forEach(function(e) {
      var dir = e.change_pct >= 0 ? '↑' : '↓';
      var cur = typeof e.current_value === 'number' ? e.current_value.toFixed(1) : e.current_value;
      var exp = typeof e.expected_value === 'number' ? e.expected_value.toFixed(1) : e.expected_value;
      html += '<li>' + escHtml(e.metric) + ' ' + dir + ' ' + Math.abs(e.change_pct) + '%（当前 ' + cur + ' vs 基准 ' + exp + '）</li>';
    });
    html += '</ul>';
  }
  if (explanation.historical_recovery_rate != null) {
    html += '<p class="muted">历史同类事件恢复率: ' + Math.round(explanation.historical_recovery_rate * 100) + '%（' + (explanation.similar_events || []).length + ' 个相似事件）</p>';
  }
  return html;
}

// 追问 Agent — send a follow-up question to the Hermes situation-chat bridge.
async function askSituationAgent(situationId) {
  var input = document.getElementById('situationChatInput_' + situationId);
  var log = document.getElementById('situationChatLog_' + situationId);
  if (!input || !log) return;
  var msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  log.innerHTML += '<p><strong>你:</strong> ' + escHtml(msg) + '</p>';
  log.innerHTML += '<p class="muted">Agent 思考中…</p>';
  try {
    var data = await apiPost('/api/situation/' + situationId + '/chat', { message: msg });
    log.innerHTML = log.innerHTML.replace('Agent 思考中…', '');
    log.innerHTML += '<p><strong>Agent:</strong> ' + escHtml((data && data.reply) || '无法处理该请求') + '</p>';
  } catch (e) {
    log.innerHTML = log.innerHTML.replace('Agent 思考中…', '');
    log.innerHTML += '<p class="muted">追问失败: ' + escHtml(e.message) + '</p>';
  }
}

async function loadSituationDetail(situationId) {
  // switchView passes filter value; ignore non-ID values like 'all', 'open' etc.
  if (!situationId || situationId === 'all' || situationId === 'open' || situationId === 'partial' || situationId === 'agent') {
    situationId = currentSituationId;
  }
  if (!situationId) return;
  currentSituationId = situationId;
  var content = document.getElementById('situationDetailContent');
  var badge = document.getElementById('situationLifecycleBadge');
  // P0010.1 Post-Review REPAIR: the Investigation Track is projected into
  // the existing #decisionPanel right pane (the Workspace's natural side
  // column). We open it on entry and clear it on exit; we do NOT add a
  // second right column inside the Situation Detail body — that double-rail
  // promised a "trust/Track" that doesn't exist in this slice.
  var decisionPanel = document.getElementById('decisionPanel');
  var decisionContent = document.getElementById('decisionContent');
  content.innerHTML = '<p class="muted placeholder">加载中...</p>';

  try {
    var raw = await apiGet('/api/situations/' + situationId);
    var entity = raw.entity || {};
    var temporal = raw.temporal || {};
    var interventions = raw.interventions || [];
    var desc = raw.description || '';
    var tags = Array.isArray(raw.tags) ? raw.tags : [];

    // Fetch the pattern-engine attribution for the situation's date (deterministic
    // "why did this change"). Falls back to the description when unavailable.
    var observedDate = (temporal.observedAt || '').slice(0, 10);
    var explanation = null;
    if (observedDate) {
      try {
        var expl = await apiGet('/api/explain?date=' + encodeURIComponent(observedDate));
        explanation = (Array.isArray(expl) && expl.length > 0) ? expl[0] : null;
      } catch { /* explanation unavailable — keep null */ }
    }

    if (badge) {
      // P0010.1 REPAIR: the badge is a place-holder; the authoritative
      // 5-state lifecycle is computed AFTER the investigation loads and
      // the second pass below replaces this.
      badge.textContent = '⏳ 加载中…';
      badge.className = 'situation-lifecycle-badge open';
    }
    var html = '<div class="situation-detail-body">';

    // Title
    // P0010.1: strip a leading entity-id from the description so the title
    // doesn't render "未知商品 · SKU 101 · 101 …" (duplicate id). Legacy
    // situations were generated with the id as the leading token.
    var entityId = (entity && (entity.id || entity.entity_id)) || '';
    var descClean = (desc || '');
    if (entityId && descClean.indexOf(entityId) === 0) {
      descClean = descClean.slice(entityId.length).replace(/^[\s·,\-，]+/, '');
    }
    descClean = descClean.slice(0, 80);
    html += '<h2 class="situation-detail-title">' + escHtml(entityDisplayName(entity)) + ' · ' + escHtml(descClean) + '</h2>';
    html += '<p class="muted" style="font-size:0.78rem;margin-bottom:20px">' + escHtml(temporal.observedAt || '') + ' · ' + escHtml(entity.platform || '') + '</p>';

    // P0010.1 REPAIR-2: Output/WorkItem is a FIRST-CLASS region. It is
    // rendered BEFORE the Lifecycle card so the operator sees the Agent's
    // deliverable (recommendation / analysis / report) immediately on
    // open — without entering Advanced, dev mode, or expanding the
    // Investigation. The section only appears when outputs[] is non-empty
    // (no giant empty card when the Agent has produced nothing yet).
    // Rendered SYNCHRONOUSLY from the data already loaded (raw.outputs /
    // raw.learningContext). P0010.1 REPAIR-5: the previous
    // /mark-delivered side effect was REMOVED — opening this page does
    // NOT change any WorkItem status.
    var initialOutputs = Array.isArray(raw.outputs) ? raw.outputs : [];
    html += '<div id="situationOutputsHost_' + escHtml(situationId) + '">';
    html += renderOutputsSection(initialOutputs, situationId);
    html += '</div>';

    // P0010.1 Final Repair — Area B: vertical lifecycle timeline. Pure renderer
    // over the already-loaded /api/situations/:id data; no extra HTTP call.
    // Renders BEFORE the Lifecycle card so the operator sees the chronological
    // shape of the situation as a primary surface. Returns "" when no events,
    // which is the correct "no timeline yet" state for a fresh situation.
    if (typeof renderSituationTimeline === 'function') {
      html += renderSituationTimeline(raw);
    }

    // P0010.1 REPAIR: 5-state Lifecycle + Observation Commitment hosts.
    // Populated in the second pass after the investigation loads.
    html += '<div id="situationLifecycleHost_' + escHtml(situationId) + '"></div>';
    html += '<div id="situationCommitmentHost_' + escHtml(situationId) + '"></div>';

    // Layer 1: 发生了什么 — P0010.1 Productization: Business Situation language,
    // re-populated after the investigation loads so stopReason / status are
    // reflected (pending → "待调查"; observe → "正常范围"; failed+hasPrior → banner).
    html += '<div class="situation-layer">';
    html += '<h3 class="situation-layer-title">📊 发生了什么</h3>';
    html += '<div class="situation-layer-body" id="situationWhatHappened_' + escHtml(situationId) + '">';
    html += '<p>' + escHtml(businessDescribeSituation({ type: raw.type, description: desc }, null)) + '</p>';
    html += '</div></div>';

    // P0010.1 Productization: Hero — conclusion first. Populated after the
    // investigation loads. When the latest attempt failed but prior valid
    // cognition is preserved, the stale banner is rendered here (not duplicated
    // inside Layer 2).
    html += '<div id="situationHero_' + escHtml(situationId) + '"></div>';

    // Layer 2: 🧠 Agent 当前理解 — the hero business surface.
    html += '<div class="situation-layer">';
    html += '<h3 class="situation-layer-title">🧠 Agent 当前理解</h3>';
    html += '<div class="situation-layer-body" id="situationUnderstanding_' + escHtml(situationId) + '">';
    html += '<p class="muted placeholder">加载中...</p>';
    html += '</div>';
    html += '<button class="btn btn-primary" id="startInvestigation_' + escHtml(situationId) + '" data-action="manual-investigate" style="margin-top:8px;font-size:0.78rem" onclick="startInvestigation(\'' + escHtml(situationId) + '\')">🔍 交给 Agent 调查</button>';
    html += '</div>';

    // Layer 4: 你怎么处理？
    html += '<div class="situation-layer situation-interaction">';
    html += '<h3 class="situation-layer-title">👤 你怎么处理？</h3>';
    html += renderInteractionSurface(situationId);

    // Show existing interventions
    if (interventions.length > 0) {
      html += '<div class="situation-interventions-existing">';
      html += '<h4 style="font-size:0.8rem;margin-bottom:8px">处理记录</h4>';
      // P0010.1 Productization: each intervention record carries a stable
      // [H{n}] source tag (n = 1-based index). The underlying interventionId
      // is intentionally NOT shown in business mode; dev mode reveals it via
      // the title attribute (handled in renderSourceTag).
      interventions.forEach(function(i, idx) {
        // P0010.1 Final Repair — Area C.3: use the typed decision sub-label
        // (accept / reject / defer / override / no_action) instead of the
        // collapsed "决策" string. Falls back to the type itself for unknown
        // types — never to the dead 'action_intent' branch.
        var typeLabel = timelineEventLabel(i.type, i.content || {});
        html += '<div class="intervention-record">' +
          renderSourceTag('human', idx + 1) +
          '<span class="intervention-record-type">' + escHtml(typeLabel) + '</span>' +
          '<span class="intervention-record-summary">' + escHtml(i.summary || '') + '</span>' +
          '<span class="intervention-record-time">' + (i.timestamp || i.createdAt || '').slice(0, 16) + '</span>' +
        '</div>';
      });
      html += '</div>';
    }

    html += '</div>'; // end interaction layer

    // Layer 5: 追问 Agent — wired to the Hermes situation-chat bridge.
    html += '<div class="situation-chat" style="margin-top:20px">';
    html += '<details><summary style="cursor:pointer;font-size:0.85rem;font-weight:600">💬 追问 Agent (关于这个 Situation)</summary>';
    html += '<div style="margin-top:12px">';
    html += '<div id="situationChatLog_' + escHtml(situationId) + '" style="margin-bottom:8px;max-height:240px;overflow-y:auto"></div>';
    html += '<div style="display:flex;gap:6px">';
    html += '<input id="situationChatInput_' + escHtml(situationId) + '" class="input" style="flex:1;font-size:0.8rem" placeholder="追问 Agent，例如：为什么转化率下降？" />';
    html += '<button class="btn primary" onclick="askSituationAgent(\'' + escHtml(situationId) + '\')">发送</button>';
    html += '</div></div>';
    html += '</details></div>';

    // P0010.1 REPAIR-2: Output/WorkItem is rendered FIRST-CLASS (above
    // Lifecycle) and synchronously. REPAIR-5: the previous
    // /mark-delivered side effect is gone — opening this page does
    // NOT change any WorkItem status.

    html += '</div>'; // end detail body
    content.innerHTML = html;

    // Open the Workspace's right pane and clear any prior content (so the
    // situation's Track is the only thing rendered in the right column).
    if (decisionPanel) decisionPanel.classList.add('open');
    if (decisionContent) {
      decisionContent.style.display = 'block';
      decisionContent.innerHTML = '';
    }

    // Load any stored P0010 Investigation (read-only; null when not investigated).
    // The Understanding surface consumes ONLY persisted investigation state — no
    // LLM/Hermes call, no new evidence acquisition. Trace is a secondary drill-down.
    // The Pattern Engine is NEVER presented as "Agent 当前理解" — it only appears
    // as a secondary 信号归因 inside the Trace.
    //
    // P0010.2.2 — also reads `blockedRuntimeFailure` from the API so the
    // "立即调查（恢复）" button only appears in the single state where it
    // is meaningful. In the normal flow (failed / no investigation yet /
    // investigating) the button is hidden because the Runtime is already
    // self-healing on its own tick.
    const uEl = document.getElementById('situationUnderstanding_' + escHtml(situationId));
    const btn = document.getElementById('startInvestigation_' + escHtml(situationId));
    let invData = null;
    let invStatus = 'pending'; // pending | investigating | failed | completed
    let invBlockedRuntimeFailure = false;
    let invConsecutiveFailures = 0;
    try {
      const inv = await apiGet('/api/situation/' + encodeURIComponent(situationId) + '/investigation');
      invData = inv?.investigation ?? null;
      if (invData) {
        if (invData.status === 'investigating') invStatus = 'investigating';
        else if (invData.status === 'failed') invStatus = 'failed';
        else if (invData.status === 'completed' || invData.stopReason) invStatus = 'completed';
      }
      invBlockedRuntimeFailure = inv?.blockedRuntimeFailure === true;
      invConsecutiveFailures = Number(inv?.consecutiveFailures ?? 0);
    } catch { /* keep pending */ }

    // P0010.1 REPAIR: 5-state Lifecycle + Commitment + Outputs (second pass).
    // Compute hasAcceptedDecision from interventions (decision='accept').
    var hasAcceptedDecision = interventions.some(function (i) {
      var c = i && i.content;
      return i && i.type === 'decision' && c && (c.decision === 'accept' || c.type === 'decision_accept');
    });
    var lifeHost = document.getElementById('situationLifecycleHost_' + escHtml(situationId));
    if (lifeHost) lifeHost.innerHTML = renderLifecycleCard(invData, interventions.length, hasAcceptedDecision);
    var commitHost = document.getElementById('situationCommitmentHost_' + escHtml(situationId));
    if (commitHost) commitHost.innerHTML = renderCommitmentCard(invData);
    // Update the top badge to the real lifecycle state.
    var lc = deriveSituationLifecycle(invData, interventions.length, hasAcceptedDecision);
    if (badge) {
      var lcLabel = (SITUATION_LIFECYCLE_LABEL[lc] || lc).replace(/^[^\s]+\s+/, '');
      var lcIcon = (SITUATION_LIFECYCLE_LABEL[lc] || '').split(' ')[0] || '';
      badge.textContent = lcIcon + ' ' + lcLabel;
      badge.className = 'situation-lifecycle-badge lifecycle-' + lc;
    }
    // Stash context for the popover dispatcher (so [E]/[K]/[H] clicks can
    // resolve to real content + the persistent interventionId).
    var evidenceStrings = invData && Array.isArray(invData.evidenceAcquired) ? invData.evidenceAcquired : [];
    var knownEvidence = [];
    if (invData && invData.findings && invData.findings.length > 0) {
      invData.findings.forEach(function (f) {
        if (f && f.knownEvidence) knownEvidence.push(f.knownEvidence);
      });
    }
    if (invData && invData.knownEvidence) knownEvidence.push(invData.knownEvidence);
    state.situationContext = {
      situationId: situationId,
      evidenceStrings: evidenceStrings,
      knownEvidence: knownEvidence,
      interventions: interventions,
      invData: invData,
      // P0010.1 REPAIR-2 + REPAIR-5: outputs are loaded in the first
      // pass. The previous /mark-delivered convenience endpoint has been
      // REMOVED — opening this page does NOT change any WorkItem status.
      // Status transitions are now triggered ONLY by explicit button
      // clicks (已知悉 / 结束) in the Output Detail view.
      outputs: initialOutputs,
    };
    state.currentSituationId = situationId;

    // Project the Investigation Track + secondary Trace into #decisionContent.
    // The Track functions only need a `container` — we feed them throwaway
    // host divs so we don't fight the existing panelBusiness/panelDeveloper
    // contents (those are owned by the Ranking Explainability path).

    // P0010.1 Productization: re-populate Layer 1 ("发生了什么") with the
    // investigation-aware business sentence. Pending cases already render the
    // initial placeholder; this updates once stopReason / status are known.
    const wEl = document.getElementById('situationWhatHappened_' + escHtml(situationId));
    if (wEl) {
      var businessDesc = businessDescribeSituation({ type: raw.type, description: desc }, invData);
      wEl.innerHTML = '<p>' + escHtml(businessDesc) + '</p>';
    }

    // P0010.1 Productization: set the right-pane header to "调查过程 · {name}"
    // so the operator sees the Investigation Track, not Ranking Explainability.
    var entityLabel = document.getElementById('decisionEntityLabel');
    if (entityLabel) {
      var labelName = entityDisplayName(entity);
      if (labelName.length > 28) labelName = labelName.slice(0, 25) + '…';
      entityLabel.textContent = '调查过程 · ' + labelName;
    }

    // P0010.1 REPAIR: when the latest attempt failed but the persisted
    // investigation still carries a previously completed judgment
    // (markInvestigation merged it), we MUST show the real Understanding
    // surface (with the "最新调查未完成" hint) instead of the generic
    // "上次调查未完成" placeholder. The prior valid cognition IS the
    // operator's basis for action; the failure marker only describes the
    // LATEST attempt, not the situation's last known good.
    const hasPriorCognition = invStatus === 'failed'
      && invData
      && (!!invData.judgment || !!invData.currentUnderstanding);
    if ((invStatus === 'completed' || hasPriorCognition) && invData && uEl) {
      renderCurrentUnderstanding(uEl, invData);
      // P0010.1 Productization: Hero (conclusion first) populated here.
      const heroEl = document.getElementById('situationHero_' + escHtml(situationId));
      if (heroEl) heroEl.innerHTML = renderHeroSummary(invData, interventions.length);
      // Track + Trace go to the right pane (single host so they stack).
      if (decisionContent) {
        decisionContent.innerHTML = '';
        const trackHost = document.createElement('div'); trackHost.id = 'situationTrackHost';
        decisionContent.appendChild(trackHost);
        renderInvestigationTrack(trackHost, invData, { humanCount: interventions.length });
        const traceHost = document.createElement('div'); traceHost.id = 'situationTraceHost'; traceHost.style.marginTop = '10px';
        decisionContent.appendChild(traceHost);
        renderInvestigationTrace(traceHost, invData, explanation);
      }
      if (btn) btn.style.display = 'none';
    } else {
      // P0010.2.4 (ADR-060 audit B) — Single source of truth for the
      // banner copy + button visibility. Replaces the previous
      // invStatus / invBlockedRuntimeFailure string-match block that
      // contradicted itself when a Situation was blocked.
      //
      // The runtime drives the state via `deriveInvestigationDisplayState`;
      // the banner copy + showClearBlock flag come from
      // INVESTIGATION_DISPLAY_BANNER (presentation.js). NO inline string
      // matches here.
      const willShow = '<div class="muted" style="font-size:0.75rem;margin-top:6px">完成后将显示：当前判断 / 已确认 / 当前假设 / 还不知道 / 下一步调查 / 建议</div>';
      const displayState = deriveInvestigationDisplayState(
        invData,
        invBlockedRuntimeFailure,
        invConsecutiveFailures,
      );
      const banner = INVESTIGATION_DISPLAY_BANNER[displayState] || INVESTIGATION_DISPLAY_BANNER.pending;
      // P0010.2.4 review repair (ADR-061) — the `blocked` state's
      // detail is a function `(consecutiveFailures, threshold) =>
      // string`. app.js calls it with the live counter so the operator
      // sees the actual count instead of a hard-coded placeholder. All
      // other states have a static `detail` string. Default threshold
      // matches recovery-candidates.ts DEFAULT_MAX_FAILURES=3.
      const detailText = typeof banner.detail === 'function'
        ? banner.detail(invConsecutiveFailures || 0, 3)
        : banner.detail;
      if (uEl) {
        // Blocked state uses warning color; others use muted.
        var colorCss = displayState === 'blocked' ? 'color:var(--warning)' : '';
        uEl.innerHTML =
          '<p class="muted" style="' + colorCss + '">' + banner.headline +
          (detailText ? '<br/><small>' + detailText + '</small>' : '') +
          '</p>' + willShow;
      }
      if (btn) {
        if (banner.showClearBlock) {
          // P0010.2.4 — explicit "解除阻塞并重新调度" copy. The button
          // is ONLY ever shown in the blocked state. It posts to
          // /clear-block which resets the failure counter and lets the
          // next Loop tick re-investigate.
          //
          // P0010.2 closure micro-repair — the dispatch in
          // `startInvestigation` branches on `data-action`, not on
          // Chinese text matching. The same `startInvestigation_<id>`
          // DOM id is reused across states (the click handler is
          // shared), so the dispatcher needs an intent-revealing
          // attribute to pick the right HTTP endpoint. The data-action
          // value travels with the button when the blocked-state copy
          // is applied (here) and when the manual-investigate copy is
          // applied (line 1428).
          btn.style.display = 'block';
          btn.textContent = '解除阻塞并重新调度';
          btn.dataset.action = 'clear-block';
        } else {
          btn.style.display = 'none';
        }
      }
      // Pattern Engine attribution → projected into right pane as collapsed
      // secondary 信号归因 (never the main body).
      if (decisionContent) {
        decisionContent.innerHTML = '';
        const host = document.createElement('div'); host.id = 'situationTraceHost';
        decisionContent.appendChild(host);
        renderSignalAttribution(host, explanation, desc);
      }
    }
  } catch (e) {
    content.innerHTML = '<p class="muted placeholder">加载失败 (' + e.message + ')</p>';
  }
}

// ═══ P0010 Current Understanding Surface (Knowledge-Guided Investigation) ═══
// The PRIMARY business surface: projects persisted LearningContext.investigation
// into operator-readable language. NO LLM/Hermes call for rendering; no new
// evidence acquisition; no second Understanding model. Trace (调查依据) is a
// secondary drill-down, not the hero.

const HYPO_STATUS_LABEL = { supported: '已支持', weakened: '已弱化', proposed: '待验证', rejected: '已排除' };

/** Capability business labels (operator-facing). The Workspace permanently
 *  renders in business language — raw capability ids are never exposed. An
 *  unknown capability is reported honestly as "未识别能力", not as a raw
 *  technical string. */
const CAPABILITY_LABELS = {
  'trade.overview': '交易概览', 'trade.detail': '交易构成', 'traffic.overview': '流量分析',
  'product.overview': '商品表现', 'service.overview': '服务指标', 'industry.benchmark': '行业对标',
  'customer.overview': '客户资产', 'marketing.overview': '营销效果', 'supply_chain.inventory': '库存健康',
  'trade.competition': '竞争分析', 'trade.reports': '数据导出',
};
function capabilityLabel(id) {
  if (!id) return id;
  if (CAPABILITY_LABELS[id]) return CAPABILITY_LABELS[id];
  // Evidence label like "trade.overview 2026-08-13 (周四基准)" — map the leading id.
  for (var k in CAPABILITY_LABELS) {
    if (id.indexOf(k) === 0) return CAPABILITY_LABELS[k] + id.slice(k.length);
  }
  return '未识别能力';
}

/**
 * P0010.1: scrub raw capability ids + English technical literals + internal
 * metric scalars out of the Agent's PROSE. The Workspace permanently runs
 * in business mode, so the raw id/scalar is NEVER the surface. Unknown
 * ids are left as-is rather than inventing a label — the data is what it is.
 *
 * - Hermes → Agent
 * - trade.overview / traffic.overview / ... → 交易概览 / 流量分析 / ...
 * - evidenceId / signal_id / trace_id / ... → 已隐藏（仅运营视图）
 * - 综合得分 0.367 / overall_score 0.367 → 综合表现（数值仅在审计日志中可见）
 */
function scrubCapabilityIdsInProse(text) {
  if (!text) return text;
  var out = text;
  // 1) raw capability ids
  for (var k in CAPABILITY_LABELS) {
    var re = new RegExp('(^|[^A-Za-z0-9_])' + k.replace(/\./g, '\\.') + '(?=$|[^A-Za-z0-9_])', 'g');
    out = out.replace(re, function (m, lead) { return lead + CAPABILITY_LABELS[k]; });
  }
  // 2) English technical literals
  out = out.replace(/\bHermes\b/g, 'Agent');
  out = out.replace(
    /\b(evidenceId|signal_id|trace_id|situationId|capabilityId|taskId|interventionId)\b\s*[:：=]?\s*[A-Za-z0-9_\-]{4,}/g,
    '已隐藏（仅运营视图）',
  );
  // 3) internal metric scalars
  out = out.replace(/(?:综合得分|overall_score|排名分)\s*[:：=]?\s*\d+(?:\.\d+)?/g, '综合表现（数值仅在审计日志中可见）');
  return out;
}

// ═══ P0010.1 Productization Baseline — Human-facing presentation helpers ═══
// baseline §2-§18: present Agent cognition in operator language. These helpers
// are pure presentation functions: NO LLM, NO Hermes call, NO new evidence
// acquisition. They only re-frame already-persisted data.

/**
 * baseline §8 / §9: Source attribution tag. Honest, schema-bound. Kinds:
 *   - 'evidence'  → [证据]   (no number; content_hash is non-persistent)
 *   - 'knowledge' → [规则]   (no number; no first-class Knowledge record)
 *   - 'human'     → [H{n}]   (n is 1-based index in humanInterventions)
 *   - 'memory'    → [记忆]   (no number; Memory is Runtime-owned)
 *   - unknown     → ''       (do not fabricate)
 *
 * DOM-coupled wrapper around the pure `sourceTagLabel` / `sourceTagTooltip`
 * helpers in `./presentation.js`. Adds the refId tooltip resolution and
 * the HTML span. The Workspace permanently runs in business mode, so the
 * raw refId is never exposed in the title attribute — only the
 * kind-specific tooltip is.
 */
function renderSourceTag(kind, refId) {
  var label = sourceTagLabel(kind, refId);
  if (!label) return '';
  var title = sourceTagTooltip(kind);
  // P0010.1 REPAIR: tag is clickable. data-source-* attributes are
  // read by the document-level click handler (initSourcePopoverDispatcher).
  // We store the kind + refId as DOM data; the popover content is computed
  // lazily at click time (so it always reflects the latest evidence/knownEvidence/intervention).
  return '<span class="source-tag source-tag-' + kind + '" title="' + escHtml(title) +
    '" data-source-kind="' + escHtml(kind) + '"' +
    (refId ? ' data-source-ref="' + escHtml(String(refId)) + '"' : '') +
    ' role="button" tabindex="0" aria-label="查看引用详情">' + escHtml(label) + '</span>';
}

/** Dispatcher: any click on a [data-source-kind] opens a popover anchored to
 *  the tag. Reads `state.situationContext` (set by loadSituationDetail) for
 *  the evidence/knownEvidence/interventions arrays. */
function initSourcePopoverDispatcher() {
  if (sourcePopoverDispatcherInit) return;
  sourcePopoverDispatcherInit = true;
  document.addEventListener('click', function (ev) {
    var tag = ev.target.closest && ev.target.closest('.source-tag[data-source-kind]');
    if (!tag) return;
    ev.preventDefault();
    ev.stopPropagation();
    var kind = tag.getAttribute('data-source-kind');
    var refId = tag.getAttribute('data-source-ref');
    openSourcePopover(tag, kind, refId);
  });
  // Esc closes any open popover.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeSourcePopover();
  });
}
let sourcePopoverDispatcherInit = false;

/** Anchor: fixed-positioned popover directly under the tag. */
function openSourcePopover(tag, kind, refId) {
  closeSourcePopover();
  var ctx = state.situationContext || {};
  var data = getSourcePopoverData(
    kind,
    refId ? Number(refId) : null,
    {
      evidenceStrings: ctx.evidenceStrings || [],
      knownEvidence: ctx.knownEvidence || [],
      interventions: ctx.interventions || [],
    },
  );
  if (!data) {
    showToast('该引用暂未关联到具体来源');
    return;
  }
  var popover = document.createElement('div');
  popover.className = 'popover';
  popover.id = 'sourcePopover';
  popover.innerHTML = renderSourcePopoverHtml(data);
  document.body.appendChild(popover);
  // Position under the tag, clamped to viewport.
  var rect = tag.getBoundingClientRect();
  var popRect = popover.getBoundingClientRect();
  var top = rect.bottom + 6;
  var left = rect.left;
  if (left + popRect.width > window.innerWidth - 12) left = window.innerWidth - popRect.width - 12;
  if (left < 12) left = 12;
  if (top + popRect.height > window.innerHeight - 12) top = rect.top - popRect.height - 6;
  popover.style.top = top + 'px';
  popover.style.left = left + 'px';
  // Wire close.
  popover.querySelector('.popover-close').addEventListener('click', closeSourcePopover);
  // Click outside dismisses.
  var overlay = document.createElement('div');
  overlay.className = 'popover-overlay';
  overlay.id = 'sourcePopoverOverlay';
  overlay.addEventListener('click', closeSourcePopover);
  document.body.appendChild(overlay);
}

function closeSourcePopover() {
  var p = document.getElementById('sourcePopover');
  if (p) p.remove();
  var o = document.getElementById('sourcePopoverOverlay');
  if (o) o.remove();
}

// ── P0010.1 REPAIR: 5-state lifecycle card ────────────────────
function renderLifecycleCard(inv, interventionCount, hasAcceptedDecision) {
  var lifecycle = deriveSituationLifecycle(inv, interventionCount, hasAcceptedDecision);
  var label = SITUATION_LIFECYCLE_LABEL[lifecycle] || lifecycle;
  // Detail line — the secondary investigation status, ONLY when it adds information.
  // 'completed' adds nothing (the lifecycle already covers it). 'failed' or
  // 'investigating' DO add information (the operator needs to know the latest
  // attempt is in that state).
  var detail = '';
  if (inv && inv.status && inv.status !== 'completed') {
    detail = INVESTIGATION_STATUS_LABEL[inv.status] || '';
  }
  return '<div class="lifecycle-card lifecycle-' + lifecycle + '" data-lifecycle="' + lifecycle + '">' +
    '<span class="lifecycle-icon">' + (label.split(' ')[0] || '·') + '</span>' +
    '<span class="lifecycle-state">' + escHtml(label.replace(/^[^\s]+\s+/, '')) + '</span>' +
    (detail ? '<span class="lifecycle-detail">· ' + escHtml(detail) + '</span>' : '') +
  '</div>';
}

// ── P0010.1 REPAIR: Observation Commitment card (no engine, no wake) ──
function renderCommitmentCard(inv) {
  var c = deriveObservationCommitment(inv);
  if (!c) return '';
  var reviewAt = c.reviewAt ? new Date(c.reviewAt).toISOString().slice(0, 16).replace('T', ' ') : '（未指定 — 由人工复查触发）';
  var started = c.startedAt ? new Date(c.startedAt).toISOString().slice(0, 16).replace('T', ' ') : '—';
  return '<div class="commitment-card" data-commitment-type="observe">' +
    '<div class="commitment-title">⏳ 观察计划（未完成事务）</div>' +
    '<div class="commitment-row">开始时间：<strong>' + escHtml(started) + '</strong></div>' +
    '<div class="commitment-row">复查时机：<strong>' + escHtml(reviewAt) + '</strong></div>' +
    '<div class="commitment-row">观察重点：<strong>' + escHtml(c.checkpoints.join('、')) + '</strong></div>' +
    '<div class="commitment-row" style="margin-top:4px;font-size:0.72rem">' + escHtml(c.note) + '</div>' +
  '</div>';
}

// ── P0010.1 REPAIR-2: Outputs / WorkItem first-class region ───────────────
//
// Output/WorkItem surface spec:
//   - Renders ONLY when outputs.length > 0 (no giant empty card otherwise).
//   - First-class position (above the Lifecycle card).
//   - Synchronous render from data already loaded by /api/situations/:id —
//     P0010.1 REPAIR-5: there is no /mark-delivered side effect anywhere;
//     opening this page does NOT change any WorkItem status.
//   - Per-Output fields shown: type, content (the deliverable's body),
//     status, createdAt, resultRef.
//   - "查看结果" button is shown ONLY when resultRef.kind+ref describe a
//     resolvable reference (currently: kind=learning_context → scrolls to
//     the Agent understanding section; everything else is hidden to avoid
//     fabricating a link).
//   - Status uses human semantics: 待交付 / 已交付 / 已确认 / 已关闭.
//   - Status transitions are triggered ONLY by explicit button clicks
//     (已知悉 / 结束) — never auto on page open.
//
// Independence: WorkItem.closed does NOT close the Situation. The
// Situation's lifecycle is computed independently in
// deriveSituationLifecycle. Closing a deliverable here is purely a
// per-WorkItem status transition; the Situation keeps its own lifecycle.
//
// P0010.1 REPAIR-6: status / type label constants have been REMOVED
// from this file. The single source of truth is
// `shared/schemas/output.ts` (exposed via `window.WORK_ITEM_*` by
// `output-labels.js`, loaded before this file). All three surfaces
// (Collection, Detail, Situation summary) call `getOutputStatusLabel`
// / `getOutputTypeLabel`, which are defined near the top of the
// Output Workspace section.

function renderOutputsSection(outputs, situationId) {
  // P0010.1 Output Workspace v0: in the Situation Detail body, the Output
  // Surface is a SUMMARY only. The full Output (status timeline + 交付
  // 状态 + 来源与追溯 + 当前可做的操作) lives in the independent Output
  // Detail view. The surface here is a single card with the count + each
  // output as a 2-line preview (type · status + content) + a "查看交付物"
  // button per row, plus a "查看全部输出" link to the collection page.
  if (!Array.isArray(outputs) || outputs.length === 0) return '';
  var html = '<div class="outputs-section" data-first-class="output">' +
    '<h4 class="outputs-title">📤 已产生 ' + outputs.length + ' 个工作输出</h4>' +
    '<p class="muted" style="font-size:0.7rem;margin:-4px 0 8px">完整交付状态请打开"交付物详情"页面</p>';
  outputs.forEach(function (o) {
    html += renderOutputItem(o, situationId);
  });
  html += '<div class="outputs-section-footer">' +
    '<a href="#" class="output-source-link" data-output-action="back-to-outputs">查看全部输出 →</a>' +
  '</div>' +
  '</div>';
  return html;
}

function renderOutputItem(o, situationId) {
  // Summary view used inside Situation Detail. The full Output lives in
  // the independent Output Detail view. We deliberately omit:
  //   - resultRef raw id (e.g. "learning_context · ctx_xxx")
  //   - dev-mode createdAt micro-detail
  //   - the inline "已知悉" / "结束" buttons (those are in Output Detail)
  // to avoid duplicating the Output Detail surface.
  var status = o.status || 'ready';
  var typeLabel = getOutputTypeLabel(o.type);
  var statusLabel = getOutputStatusLabel(status);
  var bodyText = o.content || '';

  return '<div class="output-item output-item-summary" data-output-id="' + escHtml(o.outputId) + '" data-output-status="' + escHtml(status) + '">' +
    '<div class="output-row1">' +
      '<span class="output-type">' + escHtml(typeLabel) + '</span>' +
      '<span class="output-status output-status-' + escHtml(status) + '">' + escHtml(statusLabel) + '</span>' +
    '</div>' +
    (bodyText ? '<div class="output-content">' + escHtml(bodyText) + '</div>' : '') +
    '<div class="output-actions">' +
      '<button class="btn primary" data-output-action="open-output" data-output-id="' + escHtml(o.outputId) + '">查看交付物</button>' +
    '</div>' +
  '</div>';
}

/** Wire the document-level click for output status transitions + view-result. */
function initOutputsDispatcher() {
  if (outputsDispatcherInit) return;
  outputsDispatcherInit = true;
  document.addEventListener('click', async function (ev) {
    var btn = ev.target.closest && ev.target.closest('[data-output-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-output-action');
    var outputId = btn.getAttribute('data-output-id');
    // For actions that don't need outputId (back / open-situation), allow
    // early dispatch without an outputId.
    if (action !== 'back-to-outputs' && action !== 'open-situation' && action !== 'open-situation-from-detail' && !outputId) return;
    ev.preventDefault();

    // Navigation actions (no transport, no API call).
    if (action === 'back-to-outputs') {
      if (typeof switchView === 'function') switchView('outputs');
      return;
    }
    if (action === 'open-output') {
      if (!outputId) return;
      if (typeof switchView === 'function') switchView('outputDetail', outputId);
      return;
    }
    if (action === 'open-situation' || action === 'open-situation-from-detail') {
      var sitId = btn.getAttribute('data-situation-id');
      if (!sitId) return;
      if (typeof switchView === 'function') switchView('situationDetail', sitId);
      return;
    }

    // Resolve situationId: prefer the explicit attribute (Output Detail
    // view), fall back to state.currentSituationId (Situation Detail view).
    var sitIdResolved = btn.getAttribute('data-output-situation-id') || state.currentSituationId;
    if (!sitIdResolved || !outputId) return;

    // "查看结果" — local scroll, no transport / no API call.
    if (action === 'view-result') {
      var understandingEl = document.getElementById('situationUnderstanding_' + sitIdResolved);
      if (understandingEl) {
        understandingEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        understandingEl.style.transition = 'background 0.6s';
        var origBg = understandingEl.style.background;
        understandingEl.style.background = '#fef9c3';
        setTimeout(function () { understandingEl.style.background = origBg; }, 800);
      }
      return;
    }

    var targetStatus = action === 'ack' ? 'acknowledged' : 'closed';
    btn.disabled = true;
    try {
      await apiPost('/api/situations/' + encodeURIComponent(sitIdResolved) + '/outputs/' + encodeURIComponent(outputId),
        { status: targetStatus });
      // Re-render in place. For Output Detail we re-load the detail view;
      // for Situation Detail we re-render the Output Surface host.
      if (typeof switchView === 'function' && state.activeView === 'outputDetail' && outputDetailCurrent) {
        var oid = outputId;
        var refreshed = await apiGet('/api/outputs/' + encodeURIComponent(oid));
        outputDetailCurrent = refreshed;
        renderOutputDetail(refreshed);
        renderOutputDetailRightPane(refreshed);
      } else {
        var sit = await apiGet('/api/situations/' + encodeURIComponent(sitIdResolved));
        var ctx = sit && sit.learningContext ? sit.learningContext : null;
        var outputs = ctx && Array.isArray(ctx.outputs) ? ctx.outputs : [];
        var host = document.getElementById('situationOutputsHost_' + sitIdResolved);
        if (host) host.innerHTML = renderOutputsSection(outputs, sitIdResolved);
      }
    } catch (e) {
      showToast('更新失败：' + (e && e.message ? e.message : e));
      btn.disabled = false;
    }
  });
}
let outputsDispatcherInit = false;

/**
 * baseline §15 / §16: scrub English technical literals + internal-metric
 * scalars out of the Agent's prose in business mode. (This function is now
 * folded into scrubCapabilityIdsInProse — the chain is applied transparently
 * at every existing call site. Kept here as a thin alias for new callers
 * that want a more intent-revealing name.)
 */
function scrubProse(text) { return scrubCapabilityIdsInProse(text); }

/**
 * baseline §5: Hero — conclusion first. One-line "current judgment" +
 * "recommendation" + "stop reason" rendered as a prominent block BEFORE the
 * detailed 6-block layer. Only when there is a completed (or prior-valid)
 * investigation. The stale banner is moved here from Layer 2 so it does not
 * appear twice on failed+has-prior situations.
 */
function renderHeroSummary(inv, interventionCount) {
  if (!inv) return '';
  var hasCognition = inv.judgment || inv.currentUnderstanding;
  if (!hasCognition) return '';
  var html = '';
  if (inv.status === 'failed') {
    var reason = humanizeError(inv.error, 'business');
    html += '<div class="inv-stale-banner" style="margin:0 0 12px;padding:10px 12px;border:1px solid var(--danger,#d9534f);border-left-width:3px;border-radius:6px;background:rgba(217,83,79,0.06)">' +
      '<div style="font-size:0.78rem;font-weight:600;color:var(--danger,#d9534f)">⚠️ 最新调查未完成 — 以下为上一次有效判断</div>' +
      '<div style="font-size:0.72rem;color:var(--muted);margin-top:3px">原因: ' + escHtml(reason) + '</div>' +
      '</div>';
  }
  html += '<div class="hero-block" style="margin:0 0 16px;padding:14px 16px;border:1px solid var(--primary);border-left-width:4px;border-radius:8px;background:var(--primary-light)">';
  if (inv.judgment) {
    var j = scrubCapabilityIdsInProse(inv.judgment);
    if (j.length > 120) j = j.slice(0, 117) + '…';
    html += '<div style="font-size:0.92rem;line-height:1.45;margin:0 0 8px"><strong style="color:var(--primary)">当前判断：</strong>' + escHtml(j) + '</div>';
  }
  if (inv.recommendation && inv.recommendation.recommendation) {
    var r = scrubCapabilityIdsInProse(inv.recommendation.recommendation);
    if (r.length > 120) r = r.slice(0, 117) + '…';
    html += '<div style="font-size:0.88rem;line-height:1.45;margin:0 0 6px"><strong style="color:var(--primary)">建议：</strong>' + escHtml(r) + '</div>';
  }
  var stopLabel = STOP_VERDICT_LABEL[inv.stopReason] || '';
  if (stopLabel) {
    html += '<div style="font-size:0.72rem;color:var(--muted);margin-top:4px">调查状态 · ' + escHtml(stopLabel) +
      (interventionCount > 0 ? ' · ' + interventionCount + ' 条人工反馈' : '') +
      '</div>';
  }
  html += '</div>';
  return html;
}

const STOP_VERDICT_LABEL = {
  judgment: '已形成判断',
  observe: '建议观察，暂不干预',
  missing_capability: '缺少能力（Fabric 无法获取所需证据）',
  ask_human: '需人工确认',
};

/** Surface the capability boundary ONLY from structured data (P0010.2.3 ADR-059 audit F-1).
 *  P0010.1 REPAIR-4 (ADR-054) moved this logic off fuzzy text match onto structured
 *  fields: `inv.status === 'failed' || (inv.stopReason === 'judgment' && rec.humanNeeded.length > 0)`
 *  is what `deriveInvestigationStatus` reads to set the canonical `needs_human` flag.
 *  The legacy text match (人工核验/人工确认/无法获取) is REMOVED here — it never
 *  flipped lifecycle and is the only place still doing string-includes on judgment text. */
function deriveCapabilityBoundary(inv) {
  if (!inv) return null;
  if (inv.stopReason === 'missing_capability') {
    return '当前 Fabric 缺少对应能力，无法获取所需证据——Agent 已停止调查，未猜测原因。';
  }
  if (inv.stopReason === 'ask_human') {
    return '所需业务事实无法由系统获取，需要运营人员人工确认。';
  }
  // P0010.2.3 (ADR-059 audit F-1) — structured-only check. The needs_human
  // flag is set by deriveInvestigationStatus (p0007.ts) from stopReason +
  // recommendation.humanNeeded[]; we honor it directly. No more string match.
  if (inv.needsHuman === true) {
    const req = (inv.requiredEvidence || []).slice(0, 4).join('；');
    return '部分所需证据当前 Fabric 无法获取，需要人工核验' + (req ? '：' + req : '') + '。';
  }
  return null;
}

/** The hero surface: Agent 当前理解 (judgment / confirmed / hypotheses / unknown / next / boundary). */
function renderCurrentUnderstanding(container, inv) {
  if (!inv) { container.innerHTML = '<p class="muted placeholder">尚未调查。</p>'; return; }
  const block = (label, inner) => '<div class="inv-block" style="margin:8px 0"><div class="inv-label" style="font-size:0.72rem;font-weight:600;color:var(--muted);margin-bottom:3px">' + label + '</div>' + inner + '</div>';
  const list = (items) => '<ul style="margin:0;padding-left:16px">' + items.map(i => '<li style="font-size:0.82rem;margin:2px 0">' + i + '</li>').join('') + '</ul>';

  let html = '';

  // P0010.1 Productization Baseline: the stale banner for failed+has-prior is
  // owned by the Hero (renderHeroSummary, baseline §2). Rendering it here too
  // would surface the same red banner twice on the screen, so we removed it
  // from Layer 2. The Hero also localizes the humanized error string —
  // this function no longer reads inv.error.

  // 1) 当前判断 — the Agent's business conclusion (verbatim, operator language).
  // P0010.1: scrub raw capability ids the Agent may have embedded in the prose.
  html += block('当前判断',
    (inv.judgment ? '<p style="margin:0;font-size:0.82rem;white-space:pre-wrap">' + escHtml(scrubCapabilityIdsInProse(inv.judgment)) + '</p>' : '') +
    (inv.stopReason ? '<p style="margin:6px 0 0;font-size:0.75rem;font-weight:600;color:var(--primary)">调查结果 · ' + escHtml(STOP_VERDICT_LABEL[inv.stopReason] || inv.stopReason) + '</p>' : '')
  );

  // 2) 已确认 — evidence-backed findings (readable, not raw JSON).
  // P0010.1: scrub raw capability ids from finding answers + knownEvidence.
  const findings = (inv.findings || []).map(f =>
    '<div style="margin:3px 0;font-size:0.8rem">' +
      '<span class="muted" style="font-size:0.72rem">' + escHtml(scrubCapabilityIdsInProse(f.question || '')) + '</span><br/>' +
      escHtml(scrubCapabilityIdsInProse(f.answer || '')) +
      (f.impactOnHypothesis ? ' <span class="muted" style="font-size:0.72rem">（' + escHtml(scrubCapabilityIdsInProse(f.impactOnHypothesis)) + '）</span>' : '') +
    '</div>');
  const known = (inv.knownEvidence || []).map(function (e) { return escHtml(scrubCapabilityIdsInProse(e)); });
  if (findings.length || known.length) {
    html += block('已确认', findings.join('') +
      (known.length ? '<div class="muted" style="font-size:0.75rem;margin-top:4px">依据: ' + known.join('；') + '</div>' : ''));
  }

  // 3) 当前假设 — competing hypotheses with operator-language status.
  const hyp = (inv.hypotheses || []).map(h =>
    '<li style="font-size:0.82rem;margin:2px 0">' + escHtml(h.statement) +
    ' <span class="muted" style="font-size:0.72rem">[' + escHtml(HYPO_STATUS_LABEL[h.status] || h.status) + ']</span></li>');
  if (hyp.length) html += block('当前假设', '<ul style="margin:0;padding-left:16px">' + hyp.join('') + '</ul>');

  // 4) 还不知道 — what the Agent knows it does not know (missing/required evidence).
  const unknowns = (inv.unknowns || []).map(escHtml);
  const req = (inv.requiredEvidence || []).map(escHtml);
  if (unknowns.length || req.length) {
    html += block('还不知道',
      (unknowns.length ? list(unknowns) : '') +
      (req.length ? '<div class="muted" style="font-size:0.75rem;margin-top:3px">需要证据: ' + req.join('；') + '</div>' : '')
    );
  }

  // 5) 下一步调查 — the real next question / investigation intent (never fabricated).
  // A stopped investigation (observe) is presented as observation, NOT as an
  // active next question — the model's recorded question, if any, is shown as
  // a muted 观察项 so the operator sees it without implying continued investigation.
  if (inv.stopReason === 'observe') {
    html += block('下一步调查',
      '<p style="margin:0;font-size:0.82rem">当前无需继续调查，建议观察后续数据。</p>' +
      (inv.nextQuestion ? '<div class="muted" style="font-size:0.75rem;margin-top:2px">观察项: ' + escHtml(scrubCapabilityIdsInProse(inv.nextQuestion)) + '</div>' : '')
    );
  } else if (inv.nextQuestion) {
    html += block('下一步调查',
      '<p style="margin:0;font-size:0.82rem">' + escHtml(scrubCapabilityIdsInProse(inv.nextQuestion)) + '</p>' +
      (inv.investigationRequest ? '<div class="muted" style="font-size:0.75rem;margin-top:2px">' + escHtml(scrubCapabilityIdsInProse(inv.investigationRequest)) + '</div>' : '')
    );
  } else if (inv.stopReason === 'judgment') {
    html += block('下一步调查', '<p style="margin:0;font-size:0.82rem">调查已形成判断，无需继续。</p>');
  }

  // 6) 能力边界 — only when the Agent itself recognized Fabric cannot get it.
  const boundary = deriveCapabilityBoundary(inv);
  if (boundary) html += block('能力边界', '<p style="margin:0;font-size:0.82rem;color:var(--danger)">⚠ ' + escHtml(boundary) + '</p>');

  // 7) 建议 (Recommendation) — P0010.1: produced ONLY from Judgment.
  //
  // P0010.2 closure (ADR-061 follow-up) — the "建议" affordance is gated
  // on BOTH `!inv.recommendation` AND `inv.status === 'completed'`.
  //
  // Why the status check is required:
  //   `markInvestigation` does a minimum-merge on a failed attempt: the
  //   row keeps the prior valid `judgment` / `currentUnderstanding` /
  //   `findings` (this is the recovery contract — the next successful
  //   turn inherits them). So a row whose LATEST attempt is `status:
  //   'failed'` can still carry a non-null `judgment`, which used to
  //   make the `if (rec)`-only gate render the "已完成调查 / 生成建议"
  //   affordance. Clicking it then called `/recommend`, which accepted
  //   the call and fed the stale judgment into `runRecommendationTurn`.
  //
  // The micro-repair makes both consumers (this UI gate + the route's
  // precondition) strictly require `status === 'completed'`. The prior
  // valid cognition is still shown in the Understanding surface (with
  // a "最新调查未完成" hint) — only the button is suppressed.
  if (inv.status !== 'completed') {
    // Latest attempt is not a completed investigation. Show the prior
    // valid cognition (if any) and an honest state hint, but do NOT
    // offer a "生成建议" action — the recommendation surface only
    // refreshes on a NEW successful investigation turn.
    if (rec) {
      // Stale recommendation: render the body (so the operator can see
      // what was previously recommended) but mark it as historical.
      const list = (items) => items.length ? '<ul style="margin:2px 0;padding-left:16px;font-size:0.78rem">' + items.map(function (i) { return '<li style="margin:1px 0">' + escHtml(scrubCapabilityIdsInProse(i)) + '</li>'; }).join('') + '</ul>' : '';
      let recHtml = '<p style="margin:0;font-size:0.82rem;white-space:pre-wrap"><strong>' + escHtml(scrubCapabilityIdsInProse(rec.recommendation)) + '</strong></p>';
      if (rec.rationale) recHtml += '<div class="muted" style="font-size:0.75rem;margin-top:2px">依据: ' + escHtml(scrubCapabilityIdsInProse(rec.rationale)) + '</div>';
      if (rec.expectedOutcome) recHtml += '<div class="muted" style="margin-top:2px;font-size:0.75rem">预期: ' + escHtml(scrubCapabilityIdsInProse(rec.expectedOutcome)) + '</div>';
      if (rec.risks && rec.risks.length) recHtml += '<div class="muted" style="font-size:0.75rem;margin-top:2px">风险:</div>' + list(rec.risks);
      if (rec.prerequisites && rec.prerequisites.length) recHtml += '<div class="muted" style="font-size:0.75rem;margin-top:2px">前提:</div>' + list(rec.prerequisites);
      if (rec.humanNeeded && rec.humanNeeded.length) recHtml += '<div class="muted" style="font-size:0.75rem;margin-top:2px;color:var(--warning)">需人工:</div>' + list(rec.humanNeeded);
      html += block('建议', recHtml +
        '<div class="muted" style="font-size:0.72rem;margin-top:4px">⚠ 这是上一份调查（已失败）的建议，不是基于当前证据生成的。当前调查完成后才会刷新。</div>'
      );
    } else {
      // No prior recommendation, latest attempt not completed. Do NOT
      // render the misleading "Agent 已完成调查" copy and do NOT
      // offer the "生成建议" button. The honest state is: the
      // investigation is in flight, failed, or otherwise not yet
      // completed — the operator must wait for the next successful
      // turn to surface a new recommendation.
      const statusHint = inv.status === 'failed'
        ? '当前调查失败。请等待 Runtime 调度下一轮调查，调查完成后才能生成建议。'
        : inv.status === 'investigating'
          ? '当前调查进行中。调查完成后才能生成建议。'
          : '当前调查尚未完成。调查完成后才能生成建议。';
      html += block('建议', '<div class="muted" style="font-size:0.75rem">' + escHtml(statusHint) + '</div>');
    }
  } else if (rec) {
    // Completed + has a recommendation: render the recommendation body.
    const list = (items) => items.length ? '<ul style="margin:2px 0;padding-left:16px;font-size:0.78rem">' + items.map(function (i) { return '<li style="margin:1px 0">' + escHtml(scrubCapabilityIdsInProse(i)) + '</li>'; }).join('') + '</ul>' : '';
    let recHtml = '<p style="margin:0;font-size:0.82rem;white-space:pre-wrap"><strong>' + escHtml(scrubCapabilityIdsInProse(rec.recommendation)) + '</strong></p>';
    if (rec.rationale) recHtml += '<div class="muted" style="font-size:0.75rem;margin-top:2px">依据: ' + escHtml(scrubCapabilityIdsInProse(rec.rationale)) + '</div>';
    if (rec.expectedOutcome) recHtml += '<div class="muted" style="margin-top:2px;font-size:0.75rem">预期: ' + escHtml(scrubCapabilityIdsInProse(rec.expectedOutcome)) + '</div>';
    if (rec.risks && rec.risks.length) recHtml += '<div class="muted" style="font-size:0.75rem;margin-top:2px">风险:</div>' + list(rec.risks);
    if (rec.prerequisites && rec.prerequisites.length) recHtml += '<div class="muted" style="font-size:0.75rem;margin-top:2px">前提:</div>' + list(rec.prerequisites);
    if (rec.humanNeeded && rec.humanNeeded.length) recHtml += '<div class="muted" style="font-size:0.75rem;margin-top:2px;color:var(--warning)">需人工:</div>' + list(rec.humanNeeded);
    html += block('建议', recHtml);
  } else {
    // Completed + no recommendation: legitimate "已完成调查 / 可生成建议".
    html += block('建议',
      '<div class="muted" style="font-size:0.75rem;margin-bottom:4px">Agent 已完成调查，可基于当前判断生成处理建议。</div>' +
      '<button class="btn btn-primary" style="font-size:0.72rem;padding:4px 10px" onclick="generateRecommendation(' + JSON.stringify(inv.situationId) + ')">💡 生成建议</button>'
    );
  }

  container.innerHTML = html || '<p class="muted placeholder">Agent 未返回调查内容。</p>';
}

/** P0010.1 Slice 4: generate a Recommendation from the persisted Judgment (same session). */
async function generateRecommendation(situationId) {
  const uEl = document.getElementById('situationUnderstanding_' + escHtml(situationId));
  if (!uEl) return;
  try {
    const resp = await apiPost('/api/situation/' + encodeURIComponent(situationId) + '/recommend', {});
    if (resp.recommendation) {
      // Re-fetch the full investigation to re-render the whole Understanding surface.
      const inv = await apiGet('/api/situation/' + encodeURIComponent(situationId) + '/investigation');
      if (inv && inv.investigation) renderCurrentUnderstanding(uEl, inv.investigation);
    } else {
      const holder = uEl.querySelector('.inv-block:last-child');
      if (holder) holder.innerHTML = '<p class="muted" style="font-size:0.75rem">建议生成未完成' + (resp.error ? ': ' + escHtml(resp.error) : '') + '</p>';
    }
  } catch (e) {
    uEl.innerHTML = '<p class="muted placeholder">建议生成失败: ' + escHtml(e.message) + '</p>';
  }
}

/** Investigation Track — the business process (HOW), derived from persisted contract.
 * NOT Chain-of-Thought: only structured business events already in the contract
 * (question / evidence / finding / hypothesis / judgment / stop). No LLM, no re-computation.
 *
 * opts.humanCount (number, optional) — used by the judgment event to render
 *   [H1]…[Hn] source tags so the operator can see the citation chain.
 */
function renderInvestigationTrack(container, inv, opts) {
  if (!container || !inv) return;
  opts = opts || {};
  const events = [];
  const ev = (label, detail, kind, detailHtml) => events.push({ label, detail, kind, detailHtml });
  // P0010.1: a detailHtml field carries pre-rendered HTML (e.g. the source
  // tag span from renderSourceTag) that the track renderer will emit WITHOUT
  // re-escaping. The plain `detail` field is still escHtml'd so a hostile
  // back-end string can never inject markup into the track body.

  ev('发现', 'Situation 已识别，进入调查', 'start');
  (inv.findings || []).forEach((f) => {
    if (f.question) ev('调查问题', f.question, 'question');
    if (f.answer) ev('发现', f.answer, f.impactOnHypothesis ? '假设更新: ' + f.impactOnHypothesis : null, 'finding');
  });
  // P0010.1: capabilityUsed may be a comma-separated string (the Agent often
  // names 2-3 capabilities in one field). Split on comma before mapping so
  // every capability id is independently translated via capabilityLabel —
  // otherwise a bare "trade.overview" inside the comma string leaks through
  // the prefix-match as a raw suffix.
  const usedList = (inv.capabilityUsed || '')
    .split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  const acquired = [...usedList, ...(inv.evidenceAcquired || [])].filter(Boolean).map(capabilityLabel);
  if (acquired.length) {
    const acquiredText = escHtml(acquired.join('；'));
    ev('获取证据', null, 'evidence', acquiredText + ' ' + renderSourceTag('evidence', null));
  }
  const hypoChanges = (inv.hypotheses || []).filter((h) => h.status !== 'proposed' && h.status);
  if (hypoChanges.length) {
    const hypoText = escHtml(hypoChanges.map((h) => h.statement + ' [' + (HYPO_STATUS_LABEL[h.status] || h.status) + ']').join('；'));
    ev('假设更新', null, 'hypothesis', hypoText + ' ' + renderSourceTag('knowledge', null));
  }
  if (inv.nextQuestion) ev('下一问题', inv.nextQuestion, 'question');
  const boundary = deriveCapabilityBoundary(inv);
  if (boundary) ev('能力边界', boundary, 'boundary');
  if (inv.judgment) {
    // P0010.1 Productization: append "(依据: [证据] + [H1]…[Hn])" to the judgment
    // event so the operator can see what was cited. The count is derived from
    // the persisted findings + humanInterventions already on the record; we do
    // NOT fabricate exact citation ids.
    const findingEvidenceCount = (inv.findings || []).reduce((sum, f) => sum + (f.evidenceRefs || []).filter(Boolean).length, 0);
    const humanCount = opts.humanCount || 0;
    const basis = [];
    if (findingEvidenceCount > 0) basis.push(renderSourceTag('evidence', null));
    if (humanCount > 0) basis.push(renderSourceTag('human', 1) + (humanCount > 1 ? ' … ' + renderSourceTag('human', humanCount) : ''));
    const basisSuffix = basis.length ? ' （依据: ' + basis.join(' + ') + '）' : '';
    ev('判断', null, 'judgment', escHtml(inv.judgment) + basisSuffix);
  }
  if (inv.stopReason) ev('停止', STOP_VERDICT_LABEL[inv.stopReason] || inv.stopReason, 'stop');

  const items = events.map((e, i) =>
    '<div class="track-event track-' + e.kind + '">' +
      '<div class="track-step">' + (i + 1) + '</div>' +
      '<div class="track-body">' +
        '<div class="track-label">' + escHtml(e.label) + '</div>' +
        (e.detailHtml
          ? '<div class="track-detail">' + e.detailHtml + '</div>'
          : (e.detail ? '<div class="track-detail">' + escHtml(e.detail) + '</div>' : '')
        ) +
      '</div>' +
    '</div>').join('');

  container.innerHTML =
    '<h3 class="session-activity-title" style="margin-bottom:6px">调查过程</h3>' +
    '<div class="investigation-track">' + (items || '<p class="muted placeholder">无调查过程记录。</p>') + '</div>';
}

/**
 * Secondary 初始信号归因 (Pattern Engine) — shown ONLY inside the Trace for
 * situations without a completed investigation. It is NEVER presented as
 * "Agent 当前理解", and it does NOT link straight to the Evidence Viewer (that
 * stays in Advanced). The operator's judgement-basis entry is the Investigation
 * Track ("为什么这么判断？/查看调查依据") once an investigation exists.
 */
function renderSignalAttribution(container, explanation, desc) {
  if (!container) return;
  container.innerHTML =
    '<details><summary style="cursor:pointer;font-size:0.78rem;font-weight:600;color:var(--muted)">初始信号归因（辅助信息）</summary>' +
    '<div style="margin-top:8px">' +
      renderAgentUnderstanding(explanation, desc) +
    '</div></details>';
}

/** Secondary drill-down: why did the Agent judge this way (Knowledge/Question/Capability/Evidence). */
function renderInvestigationTrace(container, inv, explanation) {
  if (!container || !inv) return;
  const rows = [];
  if (inv.capabilityUsed) {
    const usedList = inv.capabilityUsed.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    rows.push('获取方式: ' + escHtml(usedList.map(capabilityLabel).join('；')));
  }
  if (inv.evidenceAcquired && inv.evidenceAcquired.length) rows.push('已获取证据: ' + escHtml(inv.evidenceAcquired.map(capabilityLabel).join('；')));
  if (inv.updatedAt) rows.push('调查时间: ' + escHtml(inv.updatedAt));
  const inner = rows.length
    ? '<ul style="margin:4px 0;padding-left:16px;font-size:0.75rem">' + rows.map(r => '<li>' + r + '</li>').join('') + '</ul>'
    : '<p class="muted" style="font-size:0.75rem">（无额外调查记录）</p>';
  container.innerHTML =
    '<details><summary style="cursor:pointer;font-size:0.78rem;font-weight:600;color:var(--muted)">为什么这么判断？ / 查看调查依据</summary>' +
    '<div style="margin-top:8px">' +
      (explanation ? '<div style="font-size:0.75rem" class="muted">信号归因: ' + escHtml(explanation.primary_driver || '未知') + '</div>' : '') +
      inner +
    '</div></details>';
}

async function startInvestigation(situationId) {
  const uEl = document.getElementById('situationUnderstanding_' + escHtml(situationId));
  // P0010.1 Post-Review REPAIR: the Track lives in the existing #decisionPanel
  // right pane now (loaded by loadSituationDetail), not inside this view.
  // We re-project the new investigation into the right pane on success.
  const decisionPanel = document.getElementById('decisionPanel');
  const decisionContent = document.getElementById('decisionContent');
  const btn = document.getElementById('startInvestigation_' + escHtml(situationId));
  if (!uEl) return;

  // P0010.2.4 (ADR-060) — branch on the button's `data-action`
  // attribute (NOT on Chinese text matching). The same `startInvestigation_<id>`
  // DOM id is reused across two distinct intent states, and the
  // dispatcher must read intent from a stable, machine-readable signal
  // rather than from the visible label.
  //
  //   data-action="clear-block"      → POST /clear-block
  //       (operator override in the `blocked` state; resets the
  //        failure counter; the next Loop tick drives the actual
  //        investigation). Set when the button is in the blocked
  //        display state at `app.js` (the renderer around line 1651).
  //
  //   data-action="manual-investigate" → POST /investigate
  //       (legacy manual trigger, kept for the rare case the operator
  //        wants to fire a turn immediately without waiting for the
  //        Loop's tick). Set at the initial render at `app.js:1428`.
  //
  // The previous substring check `indexOf('清除阻塞')` did NOT match the
  // current button text `'解除阻塞并重新调度'`, so the clear-block
  // branch was unreachable. The click always fell through to the
  // legacy /investigate path — and when /investigate returned a
  // completed investigation, the new recommendation gate
  // (P0010.2 closure micro-repair) correctly rendered "生成建议",
  // producing the "instant 生成建议 after 解除阻塞" symptom the user
  // reported. The data-action switch fixes the dispatcher without
  // changing the visible copy.
  var action = btn && btn.dataset ? btn.dataset.action : null;

  if (action === 'clear-block') {
    uEl.innerHTML = '<p class="muted">⏳ 正在重置失败计数，下一轮 Runtime 调度会驱动新一轮调查...</p>';
    if (btn) btn.disabled = true;
    try {
      const resp = await apiPost('/api/situation/' + encodeURIComponent(situationId) + '/clear-block', {});
      if (resp && resp.success) {
        // The next Loop tick (within `tickMs` — default 60s) will
        // re-investigate. We do NOT fire the investigation directly
        // from the UI: that would be a second recovery path, which
        // the runtime is explicitly designed to avoid.
        uEl.innerHTML = '<p class="muted placeholder">✅ 已清除失败阻塞。Runtime 将自动安排下一轮调查（约 1 分钟内）</p>';
        if (btn) btn.style.display = 'none';
      } else {
        uEl.innerHTML = '<p class="muted placeholder">清除失败阻塞失败' +
          (resp && resp.error ? ': ' + escHtml(resp.error) : '') + '</p>';
      }
    } catch (e) {
      uEl.innerHTML = '<p class="muted placeholder">清除失败阻塞出错: ' + escHtml(e.message) + '</p>';
    } finally {
      if (btn) btn.disabled = false;
    }
    return;
  }

  // Legacy manual investigation path. Kept for the rare operator who
  // wants to drive a turn immediately without waiting for the Loop's
  // next tick. The Loop still owns the steady-state cadence; this is
  // a single-shot override.
  uEl.innerHTML = '<p class="muted">🔍 Agent 正在调查：读取专业知识 → 形成当前判断 → 提出下一个问题 → 检查证据 → 获取所需证据 → 更新判断（可能需要几分钟）...</p>';
  if (decisionPanel) decisionPanel.classList.add('open');
  if (decisionContent) {
    decisionContent.style.display = 'block';
    decisionContent.innerHTML = '<p class="muted" style="font-size:0.78rem">正在调查...</p>';
  }
  if (btn) btn.disabled = true;
  try {
    const resp = await apiPost('/api/situation/' + encodeURIComponent(situationId) + '/investigate', {});
    if (resp.investigation) {
      renderCurrentUnderstanding(uEl, resp.investigation);
      // Re-project the Track into the right pane (overwrite the "正在调查..." host).
      if (decisionContent) {
        decisionContent.innerHTML = '';
        const trackHost = document.createElement('div'); trackHost.id = 'situationTrackHost';
        decisionContent.appendChild(trackHost);
        renderInvestigationTrack(trackHost, resp.investigation, { humanCount: 0 });
        const traceHost = document.createElement('div'); traceHost.id = 'situationTraceHost';
        traceHost.style.marginTop = '10px';
        decisionContent.appendChild(traceHost);
        renderInvestigationTrace(traceHost, resp.investigation, null);
      }
      if (btn) btn.style.display = 'none';
    } else {
      uEl.innerHTML = '<p class="muted placeholder">Agent 未返回有效的调查结果' +
        (resp.error ? ': ' + escHtml(resp.error) : '') + '</p>';
    }
  } catch (e) {
    uEl.innerHTML = '<p class="muted placeholder">调查失败: ' + escHtml(e.message) +
      '<br/><small>请确认 Hermes serve 已启动（hermes serve，端口 9119）。</small></p>';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// P0010.2.4 (ADR-060 audit C) — Render the interaction surface as TWO
// clearly-labeled button rows:
//   - "判断反馈" (judgment feedback)     — non-blocking
//   - "建议处理" (recommendation disposition) — non-blocking, NEVER
//     triggers external execution
//
// The grouped options come from `window.groupOptionsBySection()`
// (defined in interaction-grammar.js, which is the single source of
// truth for the 6 buttons). Each row reads its label from
// `INTERACTION_SECTIONS[section].label`.
//
// We index into the flat `INTERACTION_OPTIONS` array (not the grouped
// objects) when calling `handleIntervention` so downstream code keeps
// using a single canonical lookup.
function renderInteractionSurface(situationId) {
  var groups = (window.groupOptionsBySection && window.groupOptionsBySection())
    || { judgment: [], suggestion: [] };
  var sections = window.INTERACTION_SECTIONS || {};
  var options = window.INTERACTION_OPTIONS || [];
  var html = '<div class="interaction-surface">';
  // Iterate in a fixed, section-driven order so the UI never depends
  // on the insertion order of object keys (which is not guaranteed).
  ['judgment', 'suggestion'].forEach(function(section) {
    var sectionOptions = groups[section] || [];
    if (sectionOptions.length === 0) return;
    var meta = sections[section] || { label: section, detail: '' };
    html += '<div class="interaction-group" data-section="' + escHtml(section) + '">' +
      '<div class="interaction-group-label">' +
        '<span class="interaction-label">' + escHtml(meta.label) + '</span>' +
        (meta.detail ? '<span class="interaction-detail muted">' + escHtml(meta.detail) + '</span>' : '') +
      '</div>' +
      '<div class="interaction-buttons">';
    sectionOptions.forEach(function(o) {
      var idx = options.indexOf(o);
      if (idx < 0) return;
      // data-* attributes let a future test or accessibility layer
      // assert that the suggestion row carries executionDisabled=true.
      html += '<button class="interaction-btn" data-section="' + escHtml(section) + '"' +
        ' data-grammar="' + escHtml(o.grammarType) + '"' +
        ' data-execution-disabled="' + (o.executionDisabled === true ? 'true' : 'false') + '"' +
        ' onclick="handleIntervention(\'' + situationId + '\', ' + idx + ')">' +
        escHtml(o.label) + '</button>';
    });
    html += '</div></div>';
  });
  html += '</div>';
  return html;
}

// Handle an interaction button click: prompt for text if required, then submit
// the structured intervention (grammar content + summary).
//
// P0010.2.4 (ADR-060 audit C) — every produced intervention is explicitly
// non-blocking on the UI side. The runtime never pauses on account of a
// judgment/suggestion click; the next Loop tick proceeds normally. The
// structured `content.executionDisabled` and `content.decision` fields
// are passed through to the server so the producer / consumer contract
// is honored end-to-end (see formatPriorHumanGuidance in
// apps/ecommerce/runtime/investigation/prompt.ts).
function handleIntervention(situationId, optionIndex) {
  var option = (window.INTERACTION_OPTIONS || [])[optionIndex];
  if (!option) return;
  var text = '';
  if (option.requiresInput) {
    text = prompt(option.inputPlaceholder || '请描述:', '');
    if (!text || !text.trim()) return; // cancelled
    text = text.trim();
  }
  var content = window.buildInterventionContent(option, text);
  // P0010.1 Final Repair — Area C.4: pre-populate
  // `content.respondsTo.agentActivityIds` from the most recent agent activity
  // we know about for this situation. Today the only stable agent activity we
  // have is the investigation itself (its `startedAt` timestamp is unique per
  // situation). The timeline will show the link even before the producer
  // emits real `agentActivities[]` rows.
  if (option.grammarType === 'response') {
    var agentActivityId = deriveLatestAgentActivityId(state.situationContext);
    if (agentActivityId) {
      content.respondsTo = content.respondsTo || { agentActivityIds: [], signalIds: [], observationIds: [] };
      content.respondsTo.agentActivityIds = [agentActivityId];
    }
  }
  var summary = window.buildInterventionSummary(option, text);
  // Forward the section + summaryKind so the server (and the next-turn
  // consumer) can read them. P0010.2.4 hard scope: the "accept" branch
  // on a suggestion-section intervention records the operator's
  // disposition; it MUST NOT trigger external execution. `section` and
  // `summaryKind` are carried as content metadata for the producer.
  content._section = option.section || null;
  content._summaryKind = option.summaryKind || null;
  submitStructuredIntervention(situationId, option.grammarType, summary, content);
}

// Submit a structured intervention → POST → re-read → re-render.
async function submitStructuredIntervention(situationId, type, summary, content) {
  try {
    // P0010.1 Final Repair — Area C.4: flatten the structured
    // `content.respondsTo.agentActivityIds` into the top-level
    // `respondsToActivityIds` field so the timeline + future Event Bus
    // consumers can join interventions back to the agent activity that
    // produced them. The pure helper is in presentation.js (and unit-tested).
    var respondsToActivityIds = flattenRespondsToActivityIds(type, content);
    var payload = {
      interventionId: 'int_' + Date.now(),
      situationId: situationId,
      actor: { id: 'operator_1', role: 'operator' },
      type: type,
      content: content,
      summary: summary,
      timestamp: new Date().toISOString(),
      respondsToActivityIds: respondsToActivityIds,
    };
    await apiPost('/api/situations/' + situationId + '/interventions', payload);
    // Re-read — don't fake state
    loadSituationDetail(situationId);
    showToast('已记录: ' + summary.slice(0, 30));
  } catch (e) {
    showToast('提交失败: ' + e.message);
  }
}

// ═══ Agent Session (Phase 3.3) ═══════════════════════════
// Event-driven: subscribes to SSE event stream and renders Agent Activity.
// Phase 2 shell (notice + slots + disabled input) → Phase 3.3 live event display.


function loadAgentSession() {
  loadReadiness();
  ensureAgentSessionChatWired();
}

// ── P0009: Runtime Readiness — surface real runtime status ──
function loadReadiness() {
  apiGet('/api/readiness').then(function (data) {
    renderReadiness(data);
    updateStatusBadge(data.workspace === 'ready' ? 'connected' : 'unavailable');
  }).catch(function () {
    updateStatusBadge('unavailable');
  });
}

function renderReadiness(data) {
  var d = data || {};
  var chips = {
    readinessHermes: 'Hermes · ' + (d.workspace === 'ready' ? 'ready' : 'unavailable'),
    readinessCdp: 'JD/CDP · ' + (d.jd_cdp === 'ready' ? 'ready' : d.jd_cdp === 'auth_required' ? '需要登录' : 'unavailable'),
    readinessCapabilities: 'Capabilities · ' + (d.capabilities != null ? d.capabilities : '…'),
    readinessEvidence: 'Evidence · ' + (d.evidence != null ? d.evidence : '…'),
  };
  Object.keys(chips).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.textContent = chips[id];
  });
  // P0010.1: version comes from the server (status.json), not a hardcoded string.
  if (d.version) {
    var v = 'v' + d.version;
    var header = document.getElementById('headerVersion');
    var side = document.getElementById('sidebarVersion');
    if (header) header.textContent = v;
    if (side) side.textContent = v;
  }
}

// ── P0009: canonical Situation Chat wired into the primary Agent Session view ──
function ensureAgentSessionChatWired() {
  if (ensureAgentSessionChatWired._done) return;
  ensureAgentSessionChatWired._done = true;

  var input = document.getElementById('agentSessionInput');
  var sendBtn = document.getElementById('agentSessionSendBtn');
  if (!input || !sendBtn) return;

  var submit = async function () {
    var message = input.value.trim();
    if (!message) return;
    input.value = '';
    appendSessionMessage('user', message);
    var loading = appendSessionMessage('bot', 'Agent 思考中…', true);
    updateSlot('capability.selected', '…');
    updateSlot('evidence.created', '…');
    updateSlot('response.ready', '…');
    try {
      var data = await apiPost('/api/situation/jd_shop_001/chat', { message: message });
      var reply = (data && data.reply) || '无法处理该请求';
      loading.textContent = reply;
      updateSlot('response.ready', '回答已返回');
      updateStatusBadge('connected');
    } catch (e) {
      loading.textContent = 'Agent 响应失败: ' + e.message;
      updateSlot('response.ready', '失败: ' + e.message);
      updateStatusBadge('unavailable');
    }
  };

  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submit();
  });
}

function appendSessionMessage(role, text, isPending) {
  var container = document.getElementById('sessionConversation');
  if (!container) return null;
  var ph = document.getElementById('sessionPlaceholder');
  if (ph) ph.style.display = 'none';
  var el = document.createElement('div');
  el.className = role === 'user' ? 'chat-message-user' : 'chat-message-bot';
  el.style.cssText = role === 'user'
    ? 'text-align:right;margin-bottom:8px;padding:6px 12px;background:var(--card-bg);border-radius:8px;font-size:0.82rem'
    : 'margin-bottom:8px;padding:8px 12px;background:var(--card-bg);border-left:3px solid var(--primary);border-radius:6px;font-size:0.82rem;white-space:pre-wrap';
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function updateSlot(eventType, text) {
  var slot = document.querySelector('.activity-slot[data-slot="' + eventType + '"]');
  if (!slot) return;
  var status = slot.querySelector('.activity-slot-status');
  if (status) {
    status.textContent = text;
    status.className = 'activity-slot-status active';
  }
}

function updateStatusBadge(state) {
  var badge = document.getElementById('sessionStatusBadge');
  if (!badge) return;
  if (state === 'running' || state === 'connected') {
    badge.textContent = '● Connected';
    badge.className = 'session-status-badge connected';
  } else if (state === 'unavailable') {
    badge.textContent = 'Runtime integration unavailable';
    badge.className = 'session-status-badge unavailable';
  }
}

// ═══ Capability Explorer (Phase 2) ═══════════════════════
async function loadCapabilityExplorer() {
  var cardsList = document.getElementById('capabilityCardsList');
  var domainFilters = document.getElementById('capabilityDomainFilters');
  var searchInput = document.getElementById('capabilitySearchInput');
  var summaryFooter = document.getElementById('capabilitySummaryFooter');
  var detailView = document.getElementById('capabilityDetail');

  cardsList.innerHTML = '<p class="muted placeholder">Loading capabilities...</p>';

  try {
    var data = await apiGet('/api/capabilities');
    var capabilities = data.capabilities || [];
    var summary = data.summary || {};
    var domains = data.domains || [];

    // Render domain filter chips
    var allCapabilities = capabilities;
    renderDomainFilters(domainFilters, domains);
    // Render cards
    renderCapabilityCards(cardsList, capabilities, summaryFooter, summary);

    // Domain filter click handler
    domainFilters.addEventListener('click', function(e) {
      var chip = e.target.closest('.capability-domain-chip');
      if (!chip) return;
      var domain = chip.dataset.domain;
      // Toggle active
      domainFilters.querySelectorAll('.capability-domain-chip').forEach(function(c) { c.classList.remove('active'); });
      chip.classList.add('active');
      // Filter
      var filtered = domain === 'all' ? allCapabilities : allCapabilities.filter(function(c) { return c.domain === domain; });
      renderCapabilityCards(cardsList, filtered, summaryFooter, { total_capabilities: filtered.length });
    });

    // Search handler
    searchInput.addEventListener('input', function() {
      var q = searchInput.value.trim().toLowerCase();
      if (!q) {
        renderCapabilityCards(cardsList, allCapabilities, summaryFooter, summary);
        return;
      }
      var filtered = allCapabilities.filter(function(c) {
        var inIntent = (c.intent || []).some(function(i) { return i.toLowerCase().includes(q); });
        var inName = (c.name || '').toLowerCase().includes(q);
        var inDesc = (c.description || '').toLowerCase().includes(q);
        var inOutput = (c.outputs || []).some(function(o) { return o.toLowerCase().includes(q); });
        return inIntent || inName || inDesc || inOutput;
      });
      renderCapabilityCards(cardsList, filtered, summaryFooter, { total_capabilities: filtered.length });
    });

    // Card click → detail view
    cardsList.addEventListener('click', function(e) {
      var card = e.target.closest('.capability-card');
      if (!card) return;
      var capId = card.dataset.capabilityId;
      var cap = allCapabilities.find(function(c) { return c.capability === capId; });
      if (cap && detailView) showCapabilityDetail(detailView, cap, cardsList);
    });

  } catch (e) {
    cardsList.innerHTML = '<p class="muted placeholder">Failed to load capabilities (' + e.message + '). Run <code>npm run cli -- generate-contract</code> first.</p>';
  }
}

function renderDomainFilters(container, domains) {
  var html = '<span class="capability-domain-chip active" data-domain="all">All</span>';
  domains.forEach(function(d) {
    html += '<span class="capability-domain-chip" data-domain="' + d + '">' + d + '</span>';
  });
  container.innerHTML = html;
}

function renderCapabilityCards(container, capabilities, footer, summary) {
  if (!capabilities || capabilities.length === 0) {
    container.innerHTML = '<p class="muted placeholder">No capabilities found.</p>';
    if (footer) footer.innerHTML = '';
    return;
  }

  var statusIcon = { verified: '&#9989;', captured: '&#9888;&#65039;', content_only: '&#9888;&#65039;', pending: '&#11035;', premium_required: '&#128176;', popup_blocked: '&#128683;' };
  var statusClass = { verified: 'verified', captured: 'captured', content_only: 'contracted', pending: 'contracted', premium_required: 'blocked', popup_blocked: 'blocked' };

  var html = '';
  capabilities.forEach(function(cap) {
    var vStatus = (cap.validation && cap.validation.status) || 'pending';
    var icon = statusIcon[vStatus] || '&#11035;';
    var cls = statusClass[vStatus] || '';
    var provider = cap.provider || {};
    var verifiedMetrics = (cap.validation && cap.validation.verified_metrics) || [];
    var verifiedSet = {};
    verifiedMetrics.forEach(function(m) { verifiedSet[m] = true; });

    var intentsHtml = '';
    var intents = (cap.intent || []).slice(0, 3);
    if (intents.length) {
      intentsHtml = '<div class="capability-card-intents"><strong>Intents:</strong><ul>';
      intents.forEach(function(i) { intentsHtml += '<li>' + escHtml(i) + '</li>'; });
      intentsHtml += '</ul></div>';
    }

    var metricsHtml = '';
    var metrics = cap.metrics || [];
    if (metrics.length) {
      metricsHtml = '<div class="capability-card-metrics">';
      metrics.slice(0, 6).forEach(function(m) {
        var tagClass = verifiedSet[m.canonical] ? ' verified' : '';
        metricsHtml += '<span class="capability-card-metric-tag' + tagClass + '">' + escHtml(m.canonical) + '</span>';
      });
      if (metrics.length > 6) metricsHtml += '<span class="capability-card-metric-tag">+' + (metrics.length - 6) + '</span>';
      metricsHtml += '</div>';
    }

    html += '<div class="capability-card" data-capability-id="' + escHtml(cap.capability) + '">' +
      '<div class="capability-card-header">' +
        '<span class="capability-card-status ' + cls + '">' + icon + '</span>' +
        '<span class="capability-card-name">' + escHtml(cap.name) + '</span>' +
      '</div>' +
      '<div class="capability-card-id">' + escHtml(cap.capability) + '</div>' +
      '<div class="capability-card-desc">' + escHtml(cap.description) + '</div>' +
      intentsHtml +
      metricsHtml +
      '<div class="capability-card-footer">' +
        '<span><span class="capability-card-platform">' + escHtml(provider.platform || '') + '</span> &middot; <span class="capability-card-acquisition">' + escHtml(provider.acquisition || '') + '</span></span>' +
        '<button class="capability-card-action">View Details</button>' +
      '</div>' +
    '</div>';
  });
  container.innerHTML = html;

  if (footer) {
    var total = summary.total_capabilities || capabilities.length;
    var verified = summary.verified_capabilities || 0;
    var blocked = summary.blocked_capabilities || 0;
    footer.innerHTML = '<span class="muted" style="font-size:0.72rem">' + total + ' capabilities &middot; ' +
      '<span style="color:var(--success)">' + verified + ' verified</span> &middot; ' +
      '<span style="color:var(--danger)">' + blocked + ' blocked</span></span>';
  }
}

function showCapabilityDetail(container, cap, cardsList) {
  var vStatus = (cap.validation && cap.validation.status) || 'pending';
  var provider = cap.provider || {};
  var verifiedMetrics = (cap.validation && cap.validation.verified_metrics) || [];
  var lastVerified = (cap.validation && cap.validation.last_verified) || '';

  var metricsHtml = '';
  (cap.metrics || []).forEach(function(m) {
    var verifiedBadge = verifiedMetrics.indexOf(m.canonical) >= 0 ? ' &#9989;' : '';
    metricsHtml += '<span style="display:inline-block;padding:4px 10px;background:var(--bg-strong);border-radius:10px;font-family:var(--font-mono);font-size:0.7rem;margin:2px">' + escHtml(m.canonical) + ' <span class="muted">(' + m.unit + ')</span>' + verifiedBadge + '</span>';
  });

  var intentsHtml = '';
  (cap.intent || []).forEach(function(i) {
    intentsHtml += '<li>' + escHtml(i) + '</li>';
  });

  var constraints = cap.constraints || {};
  var constraintNotes = [];
  if (constraints.requires_premium) constraintNotes.push('<span style="color:var(--danger)">&#128176; Requires: ' + escHtml(constraints.premium_tier || 'premium subscription') + '</span>');
  if (constraints.requires_ad_account) constraintNotes.push('<span style="color:var(--warning)">&#9888; Requires ad account</span>');
  if (constraints.is_popup) constraintNotes.push('<span style="color:var(--warning)">&#128683; Opens as popup/modal</span>');
  if (constraints.notes) constraintNotes.push('<span style="color:var(--muted)">' + escHtml(constraints.notes) + '</span>');

  var html = '<div style="position:sticky;top:0;background:var(--bg);z-index:1;padding:8px 0;margin-bottom:16px">' +
    '<button class="btn-icon" onclick="document.getElementById(\'capabilityDetail\').style.display=\'none\';document.getElementById(\'capabilityCardsList\').style.display=\'\';document.getElementById(\'capabilitySummaryFooter\').style.display=\'\'">&#8592; Back to list</button>' +
    '</div>' +
    '<div style="max-width:720px">' +
    '<h2 style="font-family:var(--font-display)">' + escHtml(cap.name) + '</h2>' +
    '<p class="muted" style="font-family:var(--font-mono);font-size:0.8rem;margin-bottom:12px">' + escHtml(cap.capability) + ' &middot; Status: ' + vStatus + '</p>' +
    '<p style="line-height:1.6;margin-bottom:16px">' + escHtml(cap.description) + '</p>' +

    '<h3 style="font-size:0.9rem;margin-bottom:8px">Intents (Agent queries this capability for)</h3>' +
    '<ul style="margin-bottom:16px;line-height:1.6">' + intentsHtml + '</ul>' +

    '<h3 style="font-size:0.9rem;margin-bottom:8px">Metrics (' + (cap.outputs || []).length + ' total)</h3>' +
    '<div style="margin-bottom:16px">' + metricsHtml + '</div>' +

    '<h3 style="font-size:0.9rem;margin-bottom:8px">Dimensions</h3>' +
    '<div style="margin-bottom:16px">' + (cap.dimensions || []).map(function(d) { return '<span style="padding:2px 8px;background:var(--bg-strong);border-radius:8px;font-size:0.72rem;margin:2px">' + escHtml(d) + '</span>'; }).join(' ') + '</div>' +

    '<h3 style="font-size:0.9rem;margin-bottom:8px">Provider</h3>' +
    '<p style="margin-bottom:4px"><strong>Platform:</strong> ' + escHtml(provider.platform || '') + '</p>' +
    '<p style="margin-bottom:4px"><strong>Acquisition:</strong> ' + escHtml(provider.acquisition || '') + '</p>' +
    (lastVerified ? '<p style="margin-bottom:4px"><strong>Last verified:</strong> ' + escHtml(lastVerified) + '</p>' : '') +
    (constraintNotes.length ? '<div style="margin-top:8px">' + constraintNotes.join('<br>') + '</div>' : '') +
    '</div>';

  container.innerHTML = html;
  container.style.display = 'block';
  cardsList.style.display = 'none';
  if (document.getElementById('capabilitySummaryFooter')) document.getElementById('capabilitySummaryFooter').style.display = 'none';
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══ Evidence Viewer (Phase 2) ══════════════════════════
async function loadEvidenceViewer() {
  var select = document.getElementById('evidenceCapabilitySelect');
  var content = document.getElementById('evidenceContent');
  var loadBtn = document.getElementById('evidenceLoadBtn');

  // Populate capability dropdown
  select.innerHTML = '<option value="">— Choose a capability —</option>';
  try {
    var data = await apiGet('/api/capabilities');
    var capabilities = data.capabilities || [];
    capabilities.forEach(function(cap) {
      var label = cap.name + ' (' + cap.capability + ')';
      select.innerHTML += '<option value="' + escHtml(cap.capability) + '">' + escHtml(label) + '</option>';
    });
  } catch (e) {
    select.innerHTML = '<option value="">— Failed to load capabilities —</option>';
  }

  content.innerHTML = '<p class="muted placeholder">Select a capability to view its evidence provenance chain.</p>';

  // Load evidence on button click (onclick assignment - this view loader runs on
  // every navigation, addEventListener would stack duplicate listeners/fetches)
  loadBtn.onclick = async function() {
    var capId = select.value;
    if (!capId) { content.innerHTML = '<p class="muted placeholder">Please select a capability first.</p>'; return; }
    content.innerHTML = '<p class="muted">Loading evidence for ' + escHtml(capId) + '...</p>';
    try {
      var evidence = await apiGet('/api/evidence/' + capId);
      renderProvenanceChain(content, evidence, capId);
    } catch (e) {
      content.innerHTML = '<p class="muted placeholder">Failed to load evidence (' + e.message + ')</p>';
    }
  };
}

// ═══ Knowledge Sources (P0008.4 §10) — Fabric-side control surface ═══
// 专业人员提供资料 → 查看整理状态 → 交给 Agent 整理 → 查看生成的知识。
// 状态只来自 /api/knowledge/status（前端不推断第二套模型）；Ingest 由 Hermes 执行，
// Fabric 只启动 + 原样展示报告 + 诚实区分「Agent 执行」与「文件系统结果」。

const TYPE_LABEL = { text: 'TXT', markdown: 'MD', other: '文件' };

function fmtMtime(ms) {
  if (!ms) return '--';
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');
}

function renderKnowledgeSources(container, status) {
  if (!status || !status.sources) {
    container.innerHTML = '<p class="muted placeholder">无状态数据。</p>';
    return;
  }
  if (status.sources.length === 0) {
    container.innerHTML = '<p class="muted placeholder">还没有知识来源。点击「上传专业资料」添加你的经验资料。</p>';
    return;
  }
  const rows = status.sources.map(s => {
    const badge = s.referenced
      ? '<span class="provenance-status verified">已整理</span>'
      : '<span class="provenance-status unavailable" style="opacity:0.8">未整理</span>';
    const pages = s.referenced ? ' · 生成: ' + escHtml(s.referencedBy.join('、')) : '';
    const ingestBtn = s.referenced
      ? ''
      : '<button class="btn btn-sm" data-source="' + escHtml(s.path) + '" data-file="' + escHtml(s.file) + '" style="margin-left:8px;font-size:0.72rem;padding:2px 8px">整理此份</button>';
    return '<div class="evidence-timeline-item" style="flex-wrap:wrap">' +
      '<span><span class="evidence-timeline-date" style="min-width:0">' + escHtml(s.file) + '</span> ' +
      '<span class="evidence-timeline-meta">' + escHtml(TYPE_LABEL[s.type] || '文件') + ' · ' + (s.size || 0) + ' B · ' + fmtMtime(s.mtimeMs) + pages + '</span></span>' +
      badge + ingestBtn +
      '</div>';
  }).join('');
  container.innerHTML =
    '<div class="knowledge-sources-count muted" style="font-size:0.78rem;margin-bottom:6px">' +
    '共 ' + status.total + ' 份 · 已整理 ' + status.referencedCount + ' · 未整理 ' + status.pendingCount +
    '</div><div class="evidence-timeline">' + rows + '</div>';

  // Per-source "整理此份" → ingest that specific source (REUSE /ingest { source }).
  container.querySelectorAll('[data-source]').forEach(btn => {
    btn.onclick = () => runIngest({ source: btn.dataset.source, label: btn.dataset.file });
  });
}

function renderKnowledgePages(container, status) {
  if (!status || !status.pages) { container.innerHTML = ''; return; }
  if (status.pages.length === 0) {
    container.innerHTML = '<p class="muted placeholder">还没有生成的知识。把资料「交给 Agent 整理」后，这里会显示整理结果。</p>';
    return;
  }
  const cards = status.pages.map(p =>
    '<div class="finding-card" style="padding:10px 12px;margin-bottom:6px;cursor:default">' +
      '<div style="font-size:0.82rem;font-weight:600">' + escHtml(p.title) + '</div>' +
      '<div class="muted" style="font-size:0.72rem;margin-top:2px">来源: ' +
        escHtml(p.sources.join('、')) + '</div>' +
    '</div>'
  ).join('');
  container.innerHTML = cards +
    (status.indexMd
      ? '<details style="margin-top:8px"><summary class="muted" style="font-size:0.75rem;cursor:pointer">查看知识索引 (INDEX)</summary>' +
        '<pre style="white-space:pre-wrap;font-size:0.72rem;background:var(--card-bg);border:1px solid var(--border-color);border-radius:6px;padding:8px 12px;margin-top:6px">' +
        escHtml(status.indexMd.slice(0, 2000)) + '</pre></details>'
      : '');
}

async function refreshKnowledge(status) {
  const sourcesEl = document.getElementById('knowledgeStatus');
  const pagesEl = document.getElementById('knowledgePages');
  if (sourcesEl) renderKnowledgeSources(sourcesEl, status);
  if (pagesEl) renderKnowledgePages(pagesEl, status);
}

async function runIngest(opts) {
  opts = opts || {};
  const result = document.getElementById('knowledgeResult');
  const btn = document.getElementById('knowledgeIngestBtn');
  if (!result) return;
  result.style.display = 'block';
  result.innerHTML = '<p class="muted">🤖 已交给 Agent。Agent 正在阅读资料、组织知识、写入「生成的知识」并更新索引（可能需要几分钟）...</p>';
  if (btn) btn.disabled = true;
  try {
    const body = opts.source ? { source: opts.source } : {};
    const resp = await apiPost('/api/knowledge/ingest', body);
    const report = (resp.reply || '').trim();

    if (resp.success) {
      result.innerHTML =
        '<div class="knowledge-result-head"><strong>Agent 整理报告</strong></div>' +
        '<pre style="white-space:pre-wrap;font-size:0.78rem;background:var(--card-bg);border:1px solid var(--border-color);border-radius:6px;padding:8px 12px">' +
        escHtml(report || '（Agent 未返回文字报告）') +
        '</pre>';
    } else if (resp.agentStatus === 'timeout') {
      // 诚实区分：Agent 执行未确认完成，但文件系统状态是实时的。
      result.innerHTML =
        '<div class="knowledge-result-head"><strong>Agent 执行未确认完成</strong></div>' +
        '<p class="muted" style="font-size:0.78rem">Agent 在等待时间内未返回完成信号（模型处理超时，已知限制）。' +
        '但下方是<strong>实时的文件系统状态</strong>——如果 Agent 实际已写入内容，这里会如实反映：</p>' +
        '<div id="knowledgeResultStatus" style="margin-top:6px"></div>';
      const st = document.getElementById('knowledgeResultStatus');
      if (st) renderKnowledgeSources(st, resp.status);
    } else {
      result.innerHTML = '<p class="muted placeholder">Agent 执行失败: ' + escHtml(resp.error || '未知错误') +
        '<br/><small>请确认 Hermes serve 已启动（hermes serve，端口 9119）。</small></p>';
    }
    // 刷新主状态（含生成的知识）——无论 Agent 状态如何，都以磁盘为准。
    if (resp.status) refreshKnowledge(resp.status);
    else loadKnowledge();
  } catch (e) {
    result.innerHTML = '<p class="muted placeholder">请求失败: ' + escHtml(e.message) +
      '<br/><small>请确认 Hermes serve 已启动（hermes serve，端口 9119）。</small></p>';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadKnowledge() {
  const result = document.getElementById('knowledgeResult');
  const uploadStatus = document.getElementById('knowledgeUploadStatus');
  if (result) { result.style.display = 'none'; result.innerHTML = ''; }
  if (uploadStatus) uploadStatus.textContent = '';
  try {
    const data = await apiGet('/api/knowledge/status');
    refreshKnowledge(data);
  } catch (e) {
    const el = document.getElementById('knowledgeStatus');
    if (el) el.innerHTML = '<p class="muted placeholder">加载知识来源失败: ' + escHtml(e.message) + '</p>';
  }

  // Upload 专业资料 (.txt / .md) → knowledge-sources/raw/（不可变，拒绝覆盖）。
  const uploadBtn = document.getElementById('knowledgeUploadBtn');
  const uploadInput = document.getElementById('knowledgeUploadInput');
  if (uploadBtn && uploadInput) {
    uploadBtn.onclick = () => uploadInput.click();
    uploadInput.onchange = async function() {
      const file = uploadInput.files && uploadInput.files[0];
      if (!file) return;
      if (uploadStatus) uploadStatus.textContent = '读取中 ' + escHtml(file.name) + ' ...';
      try {
        const text = await file.text();
        const resp = await apiPost('/api/knowledge/upload', { filename: file.name, content: text });
        if (uploadStatus) {
          uploadStatus.textContent = resp.success
            ? '✅ 已上传「' + escHtml(file.name) + '」，状态：未整理'
            : '❌ ' + escHtml(resp.error || '上传失败');
        }
        if (resp.status) refreshKnowledge(resp.status);
      } catch (e) {
        if (uploadStatus) uploadStatus.textContent = '❌ 上传失败: ' + escHtml(e.message);
      } finally {
        uploadInput.value = '';
      }
    };
  }

  // 全局「交给 Agent 整理」→ ingest 全部未整理源。
  const btn = document.getElementById('knowledgeIngestBtn');
  if (btn) btn.onclick = () => runIngest({});
}

function renderProvenanceChain(container, evidence, capId) {
  // Field paths match /api/evidence/:capabilityId exactly (runtime.ts):
  // { capability, provider, evidence: { totalRecords, recentRecords }, discovery: { artifacts }, validation }
  var cap = evidence.capability || {};
  var provider = evidence.provider || {};
  var artifacts = (evidence.discovery && evidence.discovery.artifacts) || {};
  var records = (evidence.evidence && evidence.evidence.recentRecords) || [];
  var totalRecords = (evidence.evidence && evidence.evidence.totalRecords) || records.length;
  var validation = evidence.validation || {};

  var html = '<div class="evidence-breadcrumb">' +
    '<span>Agent Session</span> <span class="sep">&gt;</span> ' +
    '<span>' + escHtml(capId) + '</span> <span class="sep">&gt;</span> ' +
    '<span>Evidence</span>' +
    '</div>';

  // Provenance chain
  html += '<div class="provenance-chain">';

  // Node 1: Capability
  html += '<div class="provenance-node">' +
    '<div class="provenance-node-icon">&#128269;</div>' +
    '<div class="provenance-node-body">' +
      '<div class="provenance-node-title">' + escHtml(cap.name || capId) + '</div>' +
      '<div class="provenance-node-subtitle">Capability: ' + escHtml(cap.domain || '') + '</div>' +
      '<div class="provenance-node-detail">' + escHtml(cap.description || '') + '</div>' +
    '</div>' +
    '<span class="provenance-status verified">' + escHtml(provider.platformName || provider.platform || '') + ' &middot; ' +
      escHtml(provider.acquisitionLabel || provider.acquisition || '') +
      (validation.lastVerified ? ' &middot; ' + escHtml(validation.lastVerified.slice(0, 10)) : '') + '</span>' +
  '</div>';

  // Node 2: Discovery artifacts
  var discoveryKeys = Object.keys(artifacts).filter(function(k) { return artifacts[k]; });
  if (discoveryKeys.length) {
    html += '<div class="provenance-node-connector"></div>';
    html += '<div class="provenance-node">' +
      '<div class="provenance-node-icon">&#128218;</div>' +
      '<div class="provenance-node-body">' +
        '<div class="provenance-node-title">Discovery Artifacts</div>' +
        '<div class="provenance-node-subtitle">' + discoveryKeys.length + ' discovery files</div>' +
        '<div class="provenance-node-meta">' + discoveryKeys.map(function(k) { return escHtml(k); }).join(', ') + '</div>';
    discoveryKeys.forEach(function(k) {
      var art = artifacts[k];
      var preview = typeof art === 'object' ? JSON.stringify(art).slice(0, 300) : String(art).slice(0, 300);
      html += '<span class="provenance-node-expand" onclick="var el=this.nextElementSibling;el.style.display=el.style.display===\'block\'?\'none\':\'block\'">&#9654; View ' + escHtml(k) + '</span>' +
        '<pre class="provenance-node-expanded" style="display:none">' + escHtml(preview) + '...</pre>';
    });
    html += '</div></div>';
  }

  // Node 3: Evidence records
  if (records.length) {
    html += '<div class="provenance-node-connector"></div>';
    html += '<div class="provenance-node">' +
      '<div class="provenance-node-icon">&#128260;</div>' +
      '<div class="provenance-node-body">' +
        '<div class="provenance-node-title">Evidence Records</div>' +
        '<div class="provenance-node-subtitle">' + records.length + ' evidence files</div>';

    // Evidence timeline - each item maps 1:1 to an EvidenceRecord from
    // /api/evidence (metadata.acquired_at / data_type / acquisition_method / shop_id).
    html += '<div class="evidence-timeline"><div class="evidence-timeline-title">Timeline</div>';
    records.slice(0, 20).forEach(function(rec) {
      var meta = rec.metadata || {};
      var acquired = meta.acquired_at ? meta.acquired_at.slice(0, 10) : '';
      var dataType = meta.data_type || '';
      var method = meta.acquisition_method || meta.method || 'none';
      var statusClass = method === 'cdp' ? 'cdp' : method === 'mock' ? 'mock' : 'none';
      html += '<div class="evidence-timeline-item">' +
        '<span><span class="evidence-timeline-date">' + escHtml(acquired) + '</span> ' +
        '<span class="evidence-timeline-meta">' + escHtml(dataType) + (meta.shop_id ? ' · ' + escHtml(meta.shop_id) : '') + '</span></span>' +
        '<span class="evidence-timeline-status ' + statusClass + '">' + escHtml(method) + '</span>' +
      '</div>';
    });
    html += '</div>';

    html += '<div class="provenance-node-meta" style="margin-top:8px">' +
      'Total: ' + totalRecords + ' records' +
      '</div>';

    html += '</div></div>';
  }

  html += '</div>'; // end provenance-chain

  container.innerHTML = html;
}

// ═══ Ranking Explainability Panel (real /api/trace/:traceId consumer) ═══
function selectFinding(finding) {
  state.selectedEntityId = finding.entityId || finding.entity_id;
  const eid = state.selectedEntityId;
  document.querySelectorAll('.finding-card').forEach(c => { c.classList.toggle('selected', c.dataset.entityId === eid); });
  const entityName = finding.entityName || state.productNames[eid] || eid;
  document.getElementById('decisionEntityLabel').textContent = entityName;
  document.getElementById('decisionPlaceholder').style.display = 'none';
  document.getElementById('decisionContent').style.display = 'block';

  const ranking = state.rankingsCache.find(r => r.entity_id === eid);
  updatePanel(finding, ranking);
}

async function updatePanel(finding, ranking) {
  const eid = state.selectedEntityId;
  const entityName = finding?.entityName || ranking?.entity_id;
  // Fetch the trace for the CURRENT ranking only. The server attaches trace_id to
  // a ranking only when its ranking_id is still live in ranking_results — dangling
  // historical traces are never requested/displayed. Trace content is consumed
  // exclusively from /api/trace/:traceId (no recompute, no Hermes/LLM).
  let trace = null;
  if (ranking?.trace_id) {
    try {
      trace = await apiGet('/api/trace/' + encodeURIComponent(ranking.trace_id));
    } catch { trace = null; }
  }
  if (state.selectedEntityId !== eid) return; // stale selection — ignore late response
  state.currentTrace = trace;

  // P0010.2 closure — Workspace permanently renders in business mode. The
  // legacy dev-mode trace panel was removed with the 运营/开发模式 toggle;
  // `renderBusinessPanel` is the only render path here.
  renderBusinessPanel(finding, ranking, trace);
}

// ═══ V1 Business Mode: AI Summary + Reasoning + Tool Calls ═══
function renderBusinessPanel(finding, ranking, trace) {
  document.getElementById('panelBusiness').style.display = 'block';
  document.getElementById('panelDeveloper').style.display = 'none';

  const comp = ranking?.component_scores ?? {};
  const dt = ranking?.decision_trace ?? {};
  const signalsUsed = ranking?.signals_used || [];

  // Reasoning from real ranking data + the trace's real trust (consumed, not recomputed).
  const reasons = [];
  if (trace?.alignment) {
    const tScore = Math.round((trace.alignment.trust_score || 0) * 100);
    reasons.push(`信任分: ${tScore}% — ${tScore >= 70 ? '证据充分' : tScore >= 40 ? '中等可信' : '证据稀薄，需人工复核'}${(trace.alignment.contradictions || []).length ? '（' + (trace.alignment.contradictions || []).join('、') + '）' : ''}`);
  }
  if (comp.growth) reasons.push(`增长得分: ${(comp.growth*100).toFixed(0)}% — ${comp.growth >= 0.5 ? '增长势头强劲' : comp.growth >= 0.3 ? '增长稳定' : '增长空间大'}`);
  if (comp.competition) reasons.push(`竞争得分: ${(comp.competition*100).toFixed(0)}% — ${comp.competition >= 0.5 ? '竞争优势明显' : '竞争压力较大'}`);
  if (comp.supply_stability) reasons.push(`供应稳定性: ${(comp.supply_stability*100).toFixed(0)}%`);
  if (comp.quality) reasons.push(`质量得分: ${(comp.quality*100).toFixed(0)}%`);
  if (ranking?.explainability?.strengths?.length) {
    reasons.push('优势: ' + ranking.explainability.strengths.slice(0, 2).join('、'));
  }
  if (ranking?.explainability?.risks?.length) {
    reasons.push('风险: ' + ranking.explainability.risks.slice(0, 2).join('、'));
  }
  if (!reasons.length) reasons.push('基于多维度指标综合评估');

  document.getElementById('decisionReasoningList').innerHTML = reasons.map(r => `
    <div class="reasoning-item"><div class="reasoning-dot"></div><div>
      <div class="reasoning-item-title">${r}</div>
      <div class="reasoning-item-desc">${finding.aiSuggestion || ''}</div>
    </div></div>`).join('');

  // Pipeline steps — describe actual execution flow.
  // P0010.1: 排名输出 step uses the BUSINESS summary (trust + strengths/risks),
  // not the internal overall_score. The scalar is reserved for Developer Mode.
  const tScore = trace?.alignment ? Math.round((trace.alignment.trust_score || 0) * 100) : null;
  const trustVerdict = tScore == null ? '—' : tScore >= 70 ? '证据充分' : tScore >= 40 ? '中等可信' : '证据稀薄';
  const contradictions = trace?.alignment?.contradictions?.length || 0;
  const strengths = ranking?.explainability?.strengths?.length || 0;
  const risks = ranking?.explainability?.risks?.length || 0;
  const steps = [
    { title: '信号计算', desc: `Compute ${signalsUsed.length || 9} signals/product × [3,7,14]d windows` },
    { title: '多维评分', desc: `Growth(${((comp.growth||0)*100).toFixed(0)}%) + Competition(${((comp.competition||0)*100).toFixed(0)}%) + Supply(${((comp.supply_stability||0)*100).toFixed(0)}%) + Quality(${((comp.quality||0)*100).toFixed(0)}%)` },
    { title: '记忆调整', desc: `${ranking?.memory_adjustments?.length || 0} active memory adjustments applied` },
    { title: '排名输出', desc: `信任分 ${tScore == null ? '—' : tScore + '%'} (${trustVerdict}) · 矛盾点 ${contradictions} · 优势 ${strengths} · 风险 ${risks}` },
  ];
  document.getElementById('decisionStepsList').innerHTML = steps.map((s, i) => `
    <div class="execution-step"><div class="step-num">${i+1}</div><div>
      <div class="step-title">${s.title}</div><div class="step-desc">${s.desc}</div>
    </div></div>`).join('');

  // Tool calls — real signal names from ranking data
  const toolNames = signalsUsed.length > 0
    ? signalsUsed.slice(0, 5).map(s => ({ name: s.signal_name || s, status: '成功' }))
    : (dt.top_signals || []).slice(0, 5).map(s => ({ name: s.signal_name || s, status: '成功' }));
  if (!toolNames.length) {
    toolNames.push({ name: 'signal_pipeline', status: '成功' });
    toolNames.push({ name: 'ranking_engine', status: '成功' });
  }
  document.getElementById('decisionToolCalls').innerHTML = toolNames.map(t => `
    <div class="tool-call-item"><span class="tool-call-name">${t.name}</span><span class="tool-call-status">${t.status}</span></div>`).join('');
}

// ═══ Developer Mode: Ranking Explainability — real /api/trace/:traceId consumer ═══
const CONTRADICTION_LABELS = {
  entity_not_in_ranking: '结论实体不在当前榜单',
  no_signals: '该实体没有任何信号输入',
  ranking_decision_missing_signal_support: '排名决策缺少信号支撑',
  memory_decreased_confidence: '记忆调整降低了置信度',
  low_confidence: '置信度低于 0.3',
  low_coverage: '信号覆盖度低于 0.4（当前仅覆盖少数组件）',
  majority_stale_signals: '超过 50% 的信号已过期',
  entity_mismatch: '结论实体与排名实体不一致',
};

function renderTracePanel(trace, entityName, message) {
  const content = document.getElementById('traceContent');
  if (!content) return;

  // Honest empty / error state — never fabricated fallback data.
  if (!trace) {
    content.innerHTML = `
      <div class="trace-step"><span class="trace-step-num">!</span><span class="trace-step-text">${message || t('trace.noTrace')}${entityName ? '（' + entityName + '）' : ''}</span></div>`;
    return;
  }

  const a = trace.alignment || {};
  const st = trace.system_truth || {};
  const ranking = st.ranking || null;
  const conclusion = trace.conclusion || {};
  const comp = ranking?.component_scores || {};
  const trustPct = Math.round((a.trust_score || 0) * 100);
  const trustClass = a.trust_score >= 0.7 ? 'high' : a.trust_score >= 0.4 ? 'medium' : 'low';

  // The trace's ranking entry carries confidence but not coverage (schema). Only
  // render coverage when it is actually present — never a fabricated 0%.
  const coverageChip = typeof ranking?.coverage === 'number'
    ? `<span class="conf-mini ${ranking.coverage>=0.4?'medium':'low'}">Coverage: ${Math.round(ranking.coverage*100)}%</span>`
    : '';

  const contradictions = (a.contradictions || []).map(c =>
    `<div class="trace-step"><span class="trace-step-num">!</span><span class="trace-step-text">${CONTRADICTION_LABELS[c] || c}</span></div>`,
  ).join('') || '<div class="muted">无矛盾</div>';

  const signals = (st.signals || []).map(s =>
    `<div class="data-source-item"><span class="data-source-dot"></span>` +
    `<span style="font-family:var(--font-mono);font-size:0.7rem">${s.signal_name}</span>` +
    `<span class="muted" style="font-size:0.7rem">value=${s.signal_value.toFixed(3)} · ${s.signal_direction} · impact=${s.impact.toFixed(3)} · conf=${Math.round((s.confidence||0)*100)}%</span>` +
    `</div>`,
  ).join('') || '<div class="muted">无信号证据</div>';

  content.innerHTML = `
    <div class="trace-section-title">${t('trace.rankExplain')}</div>
    <div class="trace-step"><span class="trace-step-num">1</span><span class="trace-step-text"><strong>${entityName || conclusion.entity_name || conclusion.entity_id}</strong> · ${conclusion.statement || ''}</span></div>
    <div class="trace-step"><span class="trace-step-num">2</span><span class="trace-step-text">Profile: ${conclusion.profile || '?'} · trace_id: ${(trace.trace_id || '').slice(0, 8)}…</span></div>

    <div class="trace-section-title">${t('trace.trust')}</div>
    <div class="trace-step-conf">
      <span class="conf-mini ${trustClass}">${t('trace.trust')}: ${trustPct}%</span>
      <span class="conf-mini ${a.is_supported ? 'high' : 'low'}">${t('trace.isSupported')}: ${a.is_supported ? 'yes' : 'no'}</span>
      <span class="conf-mini ${(ranking?.confidence||0)>=0.7?'high':'low'}">Conf: ${Math.round((ranking?.confidence||0)*100)}%</span>
      ${coverageChip}
    </div>
    <div class="trace-step"><span class="trace-step-text muted">证据数: ${a.evidence_count ?? 0} · 生成于 ${(trace.created_at || '').slice(0, 19).replace('T', ' ')}</span></div>

    <div class="trace-section-title">${t('trace.contradictions')}</div>
    ${contradictions}

    <div class="trace-section-title">${t('trace.evidence')}</div>
    ${signals}

    <div class="trace-section-title">${t('trace.ranking')}</div>
    ${ranking ? `
      <div class="trace-step"><span class="trace-step-num">R</span><span class="trace-step-text">排名第 ${ranking.rank} · 综合得分 ${ranking.overall_score.toFixed(4)}</span></div>
      <div class="trace-step"><span class="trace-step-num">C</span><span class="trace-step-text">Growth ${(comp.growth||0).toFixed(2)} · Competition ${(comp.competition||0).toFixed(2)} · Supply ${(comp.supply_stability||0).toFixed(2)} · Lifecycle ${(comp.lifecycle||0).toFixed(2)} · Quality ${(comp.quality||0).toFixed(2)}</span></div>
      ${(ranking.top_signals||[]).length ? `<div class="trace-step"><span class="trace-step-text muted">Top signals: ${ranking.top_signals.map(s => s.signal_name + '(' + s.impact.toFixed(3) + ')').join(', ')}</span></div>` : ''}
    ` : '<div class="muted">无排名信息</div>'}
  `;
}

// ═══ Event Bindings ══════════════════════════════════════
// P0007.3: Situation detail back button
document.getElementById('situationBackBtn')?.addEventListener('click', () => {
  switchView('situations', state.activeFilter || 'all');
});
document.getElementById('langToggle')?.addEventListener('change', (e) => {
  currentLang = e.target.value;
  localStorage.setItem('agentfabric-lang', currentLang);
  applyI18n();
  viewLoaders[state.activeView]?.(state.activeFilter);
});
document.querySelectorAll('.sidebar-item').forEach(item => {
  item.addEventListener('click', (e) => { e.preventDefault(); switchView(item.dataset.view, item.dataset.filter || 'all'); });
});
// P0010.2 closure — the legacy 运营/开发模式 toggle was removed. The
// `panelModeToggle` element no longer exists; the listener is gone too.
document.getElementById('decisionCloseBtn')?.addEventListener('click', () => {
  state.selectedEntityId = null;
  state.currentTrace = null;
  document.getElementById('decisionEntityLabel').textContent = '';
  document.getElementById('decisionPlaceholder').style.display = 'flex';
  document.getElementById('decisionContent').style.display = 'none';
  document.querySelectorAll('.finding-card').forEach(c => c.classList.remove('selected'));
});
document.getElementById('runtimeCollectBtn')?.addEventListener('click', async () => {
  const status = document.getElementById('runtimeCollectStatus');
  const btn = document.getElementById('runtimeCollectBtn');
  if (status) status.textContent = '采集进行中...';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 采集中...'; }
  try {
    const result = await apiPost('/api/runtime/collect', { platform: 'jd', shopId: 'jd_shop_001', mock: true });
    if (status) status.textContent = '✅ 采集完成！' + (result.signalCount || 0) + ' 信号, ' + (result.evidenceCount || 0) + ' 证据';
    loadRuntime();
    loadData(); // Refresh sidebar stats
  } catch (e) {
    if (status) status.textContent = '❌ 采集失败: ' + e.message;
  }
  if (btn) { btn.disabled = false; btn.textContent = '🔰 采集数据 (Mock)'; }
});

// Replay
document.getElementById('replayRunBtn')?.addEventListener('click', async () => {
  const from = document.getElementById('replayFrom')?.value;
  const to = document.getElementById('replayTo')?.value;
  const status = document.getElementById('replayStatus');
  const progressDiv = document.getElementById('replayProgress');
  const progressBar = document.getElementById('replayProgressBar');
  const progressText = document.getElementById('replayProgressText');
  const resultDiv = document.getElementById('replayResult');
  const btn = document.getElementById('replayRunBtn');

  if (!from || !to) { if (status) status.textContent = '请选择日期范围'; return; }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Replaying...'; }
  if (status) status.textContent = 'Starting replay...';
  if (progressDiv) progressDiv.style.display = 'block';
  if (resultDiv) resultDiv.innerHTML = '';

  try {
    const result = await apiPost('/api/runtime/replay', { shopId: 'jd_shop_001', from, to });
    if (progressBar) progressBar.style.width = '100%';
    if (progressText) progressText.textContent = result.completed + '/' + result.days + ' days completed';
    if (status) status.textContent = '✅ Replay complete';

    const summaryHtml = '<strong>Replay Result:</strong> ' +
      result.completed + '/' + result.days + ' days · ' +
      result.signals + ' signals · ' +
      result.evidence + ' evidence records' +
      (result.failed > 0 ? ' · ⚠️ ' + result.failed + ' failed' : '');
    if (resultDiv) resultDiv.innerHTML = summaryHtml;

    // Refresh execution history and sidebar
    loadRuntime();
    loadData();
  } catch (e) {
    if (status) status.textContent = '❌ Replay failed: ' + e.message;
    if (resultDiv) resultDiv.innerHTML = '<span style=\"color:var(--danger)\">Replay error: ' + e.message + '</span>';
  }
  if (btn) { btn.disabled = false; btn.textContent = '▶️ Run Replay'; }
  if (progressDiv) progressDiv.style.display = 'none';
});

// ═══ Boot ═════════════════════════════════════════════════
(async function boot() {
  const savedLang = localStorage.getItem('agentfabric-lang');
  if (savedLang && i18n[savedLang]) { currentLang = savedLang; document.getElementById('langToggle').value = savedLang; }
  // Set replay date picker max to today
  var today = new Date().toISOString().slice(0, 10);
  var replayFrom = document.getElementById('replayFrom');
  var replayTo = document.getElementById('replayTo');
  if (replayFrom) { replayFrom.max = today; replayFrom.value = '2026-07-01'; }
  if (replayTo) { replayTo.max = today; replayTo.value = today; }

  // P0010.1 REPAIR: initialize the [E]/[K]/[H] popover dispatcher and the
  // Output status transition dispatcher once on page load. They are
  // document-level — no per-situation re-binding needed.
  initSourcePopoverDispatcher();
  initOutputsDispatcher();
  // REPAIR-3: workspace 工作输出 collection page — tab + row click dispatchers.
  initOutputsTabs();
  initOutputsCollectionDispatcher();

  applyI18n();
  switchView('situations', 'all');
  await loadData();

  // P0010.1: workspace version from the server (status.json), not a hardcoded string.
  try {
    const r = await apiGet('/api/readiness');
    if (r && r.version) {
      var v = 'v' + r.version;
      var header = document.getElementById('headerVersion');
      var side = document.getElementById('sidebarVersion');
      if (header) header.textContent = v;
      if (side) side.textContent = v;
    }
  } catch { /* version stays at markup fallback */ }

  // If no rankings exist yet, auto-compute them (first-time setup)
  if (state.rankingsCache.length === 0) {
    try {
      showToast('正在生成初始分析数据...');
      await apiPost('/api/ranking', { profile: 'operator_mode', persist: true });
      await loadData();
      showToast(t('toast.ready'));
    } catch (e) {
      showToast(t('toast.ready'));
    }
  } else {
    showToast(t('toast.ready'));
  }
  setInterval(loadData, 300000);
})();

// Expose inline-onclick handlers to window — app.js is an ES module, so its
// top-level functions are module-scoped and unreachable from HTML onclick attrs.
window.switchView = switchView;
window.loadEvidenceViewer = loadEvidenceViewer;
window.askSituationAgent = askSituationAgent;
window.handleIntervention = handleIntervention;
window.startInvestigation = startInvestigation;
window.generateRecommendation = generateRecommendation;
