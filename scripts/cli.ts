// CLI entry point. Subcommands: rank, signals, review, collect, db:init.
// Uses node:util parseArgs. Calls domain façades — never business internals.

import { parseArgs } from 'node:util';
import { openDb } from '#platform/storage/connection.js';
import { initDatabase } from '#platform/storage/init.js';
import { listOrders, listProducts } from '#platform/storage/product-repository.js';
import { rankProductsComposition } from '#app/orchestrator.js';
import { SignalFacade } from '#app/analysis/metrics/facade.js';
import type { RankingProfileName } from '#shared/schemas/ranking.js';
import { createRuntimeKernel, createEmptyBlueprint } from '#app/runtime/kernel/index.js';
import { loadBlueprint } from '#app/connectors/binding/loader.js';
import { writeCapabilityContract, createCapabilityRegistry } from '#app/connectors/capability/index.js';

const HELP = `agentFabric CLI
Usage:
  cli db:init                       Initialize the SQLite database
  cli rank [--profile <name>]       Rank all products and print the top result
  cli signals <entityId>            List signals for a product
  cli collect jd <shopId>           Collect JD 商智 data
            [--mode mock|live]      mock=random data (default), live=CDP
            [--date YYYY-MM-DD]     Start date (default: today)
            [--days N]              Number of days (default: 1, mock max:365)

  cli onboard-jd [--cdp-port 9222]  Extract JD auth cookies from Chrome
  cli import-jd [--source <path>]   Import real JD history from agentCMS
  cli discover jd [--date YYYY-MM-DD]  Visit all JD 商智 pages with data, capture all APIs
  cli generate-blueprint [--platform jd]  Generate Connector Blueprint from Discovery
  cli generate-contract [--platform jd]  Generate Capability Contract for agent runtimes
  cli describe-capability <id>           Describe a capability (for LLM context)
Profiles: sales_leaderboard | growth_discovery | operator_mode (default)
`;

const isProfile = (v: string): v is RankingProfileName =>
  v === 'sales_leaderboard' || v === 'growth_discovery' || v === 'operator_mode';

const cmdRank = async (args: string[]): Promise<void> => {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: 'string', default: 'operator_mode' },
    },
  });
  const profile = values.profile ?? 'operator_mode';
  if (!isProfile(profile)) {
    console.error(`Unknown profile: ${profile}`);
    process.exit(1);
  }
  const db = openDb();
  const products = listProducts(db);
  const orders = listOrders(db);
  if (products.length === 0) {
    console.error('No products. Run: npm run migrate:agentcms');
    process.exit(1);
  }
  const result = await rankProductsComposition({ products, orders, profile, db });
  const top = result.rankings[0]!;
  console.log(`\n=== ${profile} 排名榜首 ===`);
  console.log(`商品: ${top.entity_id}`);
  console.log(`综合得分: ${top.overall_score.toFixed(3)}`);
  console.log(`置信度: ${top.confidence.toFixed(2)} | 覆盖度: ${top.coverage.toFixed(2)}`);
  console.log(`优势: ${top.explainability.strengths.join('、') || '无'}`);
  console.log(`风险: ${top.explainability.risks.join('、') || '无'}`);
  console.log(`信任分: ${result.topTrace.alignment.trust_score.toFixed(2)}`);
  console.log(`\nAI 摘要:\n${result.aiSummary}`);
  db.close();
};

const cmdSignals = (args: string[]): void => {
  const entityId = args[0];
  if (!entityId) {
    console.error('Usage: cli signals <entityId>');
    process.exit(1);
  }
  const db = openDb();
  const signals = SignalFacade.list(db, 'product', entityId);
  console.log(`\n=== Signals for ${entityId} (${signals.length}) ===`);
  for (const s of signals) {
    console.log(
      `${s.signal_name.padEnd(28)} ${s.signal_value.toFixed(3).padStart(7)}  ${s.signal_direction.padEnd(5)}  conf=${s.confidence.toFixed(2)}`,
    );
  }
  db.close();
};

const cmdCollect = async (args: string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      mode: { type: 'string', default: 'mock' },
      date: { type: 'string' },
      days: { type: 'string', default: '1' },
    },
    allowPositionals: true,
  });
  const [source, shopId] = positionals as string[] | [];
  if (!source || !shopId) {
    console.error('Usage: cli collect <source> <shopId> [--mode mock|live] [--date YYYY-MM-DD] [--days N]');
    process.exit(1);
  }
  if (source !== 'jd') {
    console.error(`Only JD source is currently supported (got: ${source})`);
    process.exit(1);
  }

  const mock = values.mode !== 'live';
  const days = Math.min(Number(values.days ?? '1'), mock ? 365 : 180);
  const db = openDb();

  // P0005.5: Load blueprint — the single source of truth for runtime execution.
  let blueprint;
  try {
    blueprint = loadBlueprint('jd');
  } catch (err) {
    console.error('✗ Blueprint not found. Run: npm run cli -- generate-blueprint --platform jd');
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    db.close();
    process.exit(1);
  }

  // Create the Runtime Kernel — all execution flows through this single entry point.
  const kernel = createRuntimeKernel(db, blueprint);

  if (!mock) {
    // ── Live CDP mode: kernel handles multi-day CDP session internally ──
    // P0005.6.1: CLI is a pure shell — all business logic (acquire, parse, signal, evidence)
    // lives inside the kernel. Multi-day capture in one Chrome session preserved.
    // P0005 fix: compute startDate and toDate consistently from --date and --days.
    // Without --date: last N days ending yesterday.
    // With --date: N days starting from specified date.
    let startDate: string;
    let toDate: string;
    if (values.date) {
      const s = new Date(values.date);
      startDate = s.toISOString().slice(0, 10);
      s.setDate(s.getDate() + days - 1);
      toDate = s.toISOString().slice(0, 10);
    } else {
      const end = new Date(Date.now() - 86400000);
      toDate = end.toISOString().slice(0, 10);
      end.setDate(end.getDate() - days + 1);
      startDate = end.toISOString().slice(0, 10);
    }

    console.log(`[agentFabric] Collecting JD 商智 data (mode: CDP live, days: ${days}, kernel-driven)`);

    const liveResult = await kernel.executeLiveCDP({
      shopId,
      fromDate: startDate,
      toDate,
    });

    if (!liveResult.success) {
      console.error(`✗ CDP acquisition failed: ${liveResult.errors.join('; ') || 'unknown error'}`);
      console.error('  Make sure:');
      console.error('  1. Chrome is running: open -a "Google Chrome" --args --remote-debugging-port=9222');
      console.error('  2. sz.jd.com is open and logged in');
      console.error('  3. Run onboard first: npm run cli -- onboard-jd');
      db.close();
      process.exit(1);
    }

    for (const dayResult of liveResult.results) {
      const p = dayResult.parsed;
      const hourlyCount = p?.hourly_gmv?.filter((h) => h.gmv > 0).length ?? 0;
      const topCount = p?.top_products?.length ?? 0;
      const gmvStr = p?.summary.gmv ? `¥${p.summary.gmv.toLocaleString()}` : '?';
      console.log(`  ✓ ${dayResult.date}: gmv=${gmvStr} orders=${p?.summary.orders ?? '?'} shop_visitors=${p?.summary.shop_visitors ?? '?'} hourly=${hourlyCount}h top=${topCount} products`);
    }

    console.log(`\nDone: ${liveResult.totalEvidence} evidence files, ${liveResult.totalSignals} signals stored`);
    db.close();
    return;
  }

  // ── Mock mode: blueprint-driven per day via Runtime Kernel ──
  console.log(`[agentFabric] Collecting JD 商智 data (mode: mock, days: ${days}, blueprint-driven)`);

  let totalSignals = 0;
  let totalEvidence = 0;

  for (let d = 0; d < days; d++) {
    const date = values.date
      ? new Date(new Date(values.date).getTime() + d * 86400000).toISOString().slice(0, 10)
      : new Date(Date.now() - (days - 1 - d) * 86400000).toISOString().slice(0, 10);

    console.log(`  ${date}...`);
    const execResult = await kernel.execute({ shopId, date, mock: true });

    if (!execResult.success) {
      console.error(`  ✗ ${date}: ${execResult.errors.join('; ') || 'execution failed'}`);
      continue;
    }

    totalSignals += execResult.signals.length;
    totalEvidence += execResult.evidence.length;

    // Parse summary for display
    const parsedSummary = execResult.parsed?.summary;
    const hourlyCount = execResult.parsed?.hourly_gmv?.filter((h) => h.gmv > 0).length ?? 0;
    const topCount = execResult.parsed?.top_products?.length ?? 0;

    console.log(`  ✓ ${date}: signals=${execResult.signals.length} evidence=${execResult.evidence.length}${parsedSummary ? ` gmv=¥${parsedSummary.gmv.toLocaleString()} orders=${parsedSummary.orders} shop_visitors=${parsedSummary.shop_visitors}` : ''} hourly=${hourlyCount}h top=${topCount} products`);
  }

  console.log(`\nDone: ${totalEvidence} evidence files, ${totalSignals} signals stored`);
  db.close();
};

// P0005.3: Full JD 商智 discovery — visit all pages with data, capture all APIs.
const cmdDiscover = async (args: string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args,
    options: { date: { type: 'string' } },
    allowPositionals: true,
  });
  const [, shopId] = positionals as string[] | [];
  if (!shopId) {
    console.error('Usage: cli discover jd [shopId] [--date YYYY-MM-DD]');
    process.exit(1);
  }

  const { acquireJdMultiPage } = await import('#app/connectors/jd/acquisition/cdp-client.js');
  const { getDataPages } = await import('#app/connectors/jd/blueprint.js');
  const { saveEvidence } = await import('#app/connectors/evidence/store.js');
  const { parseJdPayload } = await import('#app/connectors/jd/parsers/index.js');
  const { normalizeSignal } = await import('#app/connectors/normalizer.js');
  const { SignalFacade } = await import('#app/analysis/metrics/facade.js');

  const date = values.date ?? new Date().toISOString().slice(0, 10);
  const pages = getDataPages();
  const db = openDb();

  console.log(`[agentFabric] Full JD Discovery: ${pages.length} pages, date=${date}`);
  console.log('');

  const result = await acquireJdMultiPage({ pages, date });

  let totalSignals = 0;
  let totalEvidence = 0;

  for (const r of result.results) {
    const icon = r.success ? '✓' : '✗';
    console.log(`  ${icon} ${r.page.name}: ${r.apiCount} APIs`);
    
    if (r.success && r.payload) {
      // Save evidence per page
      const now = new Date().toISOString();
      for (const [dtype, data] of [['summary', r.payload.summary], ['trend', r.payload.trend], ['productTop', r.payload.productTop]] as const) {
        if (data && Array.isArray(data) && data.length > 0) {
          saveEvidence('jd', shopId, date, `${r.page.id}_${dtype}`, data, {
            acquisition_method: 'cdp', processing_method: 'runtime', processed_at: now,
            tags: [`page:${r.page.id}`, `page_name:${r.page.name}`],
          });
          totalEvidence++;
        }
      }

      // Parse and generate signals
      try {
        const parsed = parseJdPayload({
          date,
          summary: r.payload.summary || [],
          trend: r.payload.trend || [],
          productTop: r.payload.productTop || [],
        });
        if (parsed.summary.gmv > 0) {
          SignalFacade.store(db, [normalizeSignal({
            signal_id: `jd-${r.page.id}-${date}`, source: 'jd', shop_id: shopId,
            signal_type: 'daily_summary', priority: 0.5,
            timestamp: new Date(date).toISOString(),
            // P0010.2.9: uv/cvr map to shop-level (the live page values)
            metrics: { gmv: parsed.summary.gmv, orders: parsed.summary.orders, uv: parsed.summary.shop_visitors, cvr: parsed.summary.shop_conversion_rate },
            confidence: 0.9,
          })]);
          totalSignals++;
        }
      } catch { /* page has no summary-compatible data, skip signal */ }
    }
  }

  console.log('');
  console.log(`Done: ${result.pagesWithData}/${result.pagesVisited} pages, ${totalEvidence} evidence, ${totalSignals} signals`);

  if (result.errors.length > 0) {
    console.log('Errors:');
    for (const e of result.errors) console.log(`  - ${e}`);
  }

  db.close();
};

const cmdDbInit = (): void => {
  const db = openDb();
  initDatabase(db);
  console.log(`[agentFabric] database initialized at ${process.env.DB_PATH ?? './data/agentfabric.db'}`);
  db.close();
};

const main = async (): Promise<void> => {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'db:init':
      cmdDbInit();
      break;
    case 'rank':
      await cmdRank(rest);
      break;
    case 'signals':
      cmdSignals(rest);
      break;
    case 'collect':
      await cmdCollect(rest);
      break;
    case 'discover':
      await cmdDiscover(rest);
      break;
    case 'onboard-jd': {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const cdpPortIdx = rest.indexOf('--cdp-port');
      const port = cdpPortIdx >= 0 ? parseInt(rest[cdpPortIdx + 1] ?? '9222', 10) : 9222;
      const authDir = resolve('.collector-auth');

      console.log('[onboard] JD 商智授权提取');
      console.log(`  CDP Port: ${port}`);
      console.log(`  Auth Dir: ${authDir}`);

      // Check CDP
      let wsUrl: string | null = null;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        const data = (await res.json()) as { webSocketDebuggerUrl?: string };
        wsUrl = data.webSocketDebuggerUrl ?? null;
      } catch {
        console.error(`\n✗ Chrome CDP not available on port ${port}.`);
        console.error('  Start Chrome with: open -a "Google Chrome" --args --remote-debugging-port=9222');
        process.exit(1);
      }
      if (!wsUrl) { console.error('Could not get CDP WebSocket URL'); process.exit(1); }

      // Load playwright-core
      let pw: { chromium: { connectOverCDP(u: string): Promise<{ contexts(): Array<{ cookies(urls: string[]): Promise<Array<{ domain: string; name: string; value: string }>> }>; close(): Promise<void> }> } };
      try {
        pw = await import(String('playwright-core')) as unknown as typeof pw;
      } catch {
        console.error('\n✗ playwright-core not installed. Run: npm install playwright-core');
        process.exit(1);
      }

      const browser = await pw.chromium.connectOverCDP(wsUrl);
      const ctx = browser.contexts()[0];
      if (!ctx) { console.error('No browser context. Open sz.jd.com in Chrome first.'); await browser.close(); process.exit(1); }

      const DOMAINS = ['https://shop.jd.com', 'https://passport.shop.jd.com', 'https://www.jd.com', 'https://passport.jd.com', 'https://sz.jd.com'];
      const allCookies: Record<string, string> = {};
      for (const domain of DOMAINS) {
        try {
          const cookies = await ctx.cookies([domain]);
          for (const c of cookies) { allCookies[`${c.domain}:${c.name}`] = c.value; }
          console.log(`  ${domain}: ${cookies.length} cookies`);
        } catch { /* ok */ }
      }

      if (Object.keys(allCookies).length === 0) {
        console.error('\n✗ No JD cookies found. Open sz.jd.com and log in first.');
        await browser.close(); process.exit(1);
      }

      const pairs = Object.entries(allCookies).map(([k, v]) => `${k.split(':').pop() ?? k}=${v}`);
      const profile = { platform: 'jd', extracted_at: new Date().toISOString(), cookies: allCookies, cookieHeader: pairs.join('; ') };
      mkdirSync(authDir, { recursive: true });
      const filePath = resolve(authDir, 'jd.json');
      writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
      console.log(`\n✓ Saved: ${filePath} (${Object.keys(allCookies).length} cookies)`);
      console.log('Next: npm run cli -- collect jd jd_shop_001 --mode live --days 30');
      await browser.close();
      break;
    }
    case 'generate-blueprint': {
      const { runGenerationPipeline } = await import('#app/connectors/capability/blueprint-generator.js');
      const { generateCoverageReport, formatCoverageSummary } = await import('#app/connectors/capability/coverage.js');
      // Accept both positional and --platform flag
      const platformIdx = rest.indexOf('--platform');
      const platform = platformIdx >= 0 ? rest[platformIdx + 1] ?? 'jd' : (rest[0] ?? 'jd');
      console.log(`[agentFabric] Generating Connector Blueprint for ${platform}...`);
      const blueprint = runGenerationPipeline(platform);
      console.log(`  Platform: ${blueprint.platform}`);
      console.log(`  APIs discovered: ${blueprint.discovery_api_count}`);
      console.log(`  Capabilities: ${blueprint.capabilities.map((c) => c.capability).join(', ')}`);
      console.log(`  Parser rules: ${blueprint.parser_plan.rules.length}`);
      console.log(`  Normalizer rules: ${blueprint.normalizer_plan.rules.length}`);
      console.log(`  Business contexts: ${blueprint.manifest.business_context.join(', ')}`);
      console.log(`  Blueprint written to: generated/`);
      const coverage = generateCoverageReport(blueprint);
      console.log(`\n${formatCoverageSummary(coverage)}`);
      break;
    }
    case 'generate-contract': {
      const contract = writeCapabilityContract();
      console.log(`Capability Contract: ${contract.platform_name} (${contract.platform})`);
      console.log(`  Version: ${contract.version}`);
      console.log(`  Generated: ${contract.generated_at}`);
      console.log(`  Capabilities: ${contract.summary.total_capabilities}`);
      console.log(`  Metrics: ${contract.summary.total_metrics}`);
      console.log(`  Verified: ${contract.summary.verified_capabilities} | Captured: ${contract.summary.captured_capabilities} | Blocked: ${contract.summary.blocked_capabilities}`);
      console.log(`  Domains: ${contract.summary.domains.join(', ')}`);
      console.log(`\n  Contract written to: generated/capability-contract.json`);
      break;
    }
    case 'describe-capability': {
      const capId = rest[0];
      if (!capId) {
        console.error('Usage: cli describe-capability <id>');
        console.error('  e.g. cli describe-capability traffic.overview');
        process.exit(1);
      }
      // Load the contract and describe
      const { existsSync, readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const contractPath = resolve(process.cwd(), 'generated', 'capability-contract.json');
      if (!existsSync(contractPath)) {
        console.error('Contract not found. Run: cli generate-contract --platform jd');
        process.exit(1);
      }
      const registry = createCapabilityRegistry();
      registry.loadContract(JSON.parse(readFileSync(contractPath, 'utf-8')));
      const desc = registry.describe(capId);
      if (!desc) {
        console.error(`Capability "${capId}" not found.`);
        console.error('Available:');
        for (const cap of registry.listAll()) {
          console.error(`  ${cap.capability} — ${cap.name}`);
        }
        process.exit(1);
      }
      console.log(desc);
      break;
    }
    case 'import-jd': {
      const { existsSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const sourceIdx = rest.indexOf('--source');
      const defaultSource = resolve(process.cwd(), '..', 'agentCMS', 'data', 'daily_records.json');
      const sourcePath = sourceIdx >= 0 ? rest[sourceIdx + 1]! : defaultSource;
      if (!existsSync(sourcePath)) {
        console.error(`File not found: ${sourcePath}`);
        console.error('Specify with: cli import-jd --source /path/to/agentCMS/data/daily_records.json');
        process.exit(1);
      }
      console.log(`Reading: ${sourcePath}`);

      const db = openDb();

      // P0005.6.1: Blueprint-driven import via kernel.
      // Falls back to empty blueprint (legacy mode) if blueprint not yet generated.
      let bp;
      try {
        bp = loadBlueprint('jd');
      } catch {
        console.log('  (blueprint not found — using legacy import path. Run generate-blueprint for full capability.)');
        bp = createEmptyBlueprint('jd');
      }

      const kernel = createRuntimeKernel(db, bp);
      const result = await kernel.executeImport({ sourcePath });

      if (!result.success) {
        console.error(`✗ Import failed: ${result.errors.join('; ')}`);
        db.close();
        process.exit(1);
      }

      console.log(`Done: ${result.totalEvidence} evidence files, ${result.totalSignals} signals stored (${result.firstDate} ~ ${result.lastDate})`);
      db.close();
      break;
    }
    case undefined:
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(1);
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
