// Database initialization: open + apply schema + seed defaults.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { applySchema } from './schema.js';
import { applyJdSchema } from './jd-persistence.js';
import { applyP0007Schema } from './p0007-schema.js';
import { applyP0013Schema } from './p0013-schema.js';
import { initMemoryStore } from '#app/memory/store.js';
import { DEFAULT_SIGNAL_WEIGHTS, RANKING_PROFILES } from './seed.js';
import { nowIso } from '#shared/utils/time.js';
import { openDb } from './connection.js';

/** Seed JD Shangzhi dataset metadata from blueprint.yaml. */
const seedJdDatasets = (db: Db): void => {
  const stmt = db.prepare(
    `INSERT INTO jd_dataset_metadata (
       dataset_id, dataset_name, source_page, grain, columns, row_count,
       update_frequency, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dataset_id) DO UPDATE SET
       dataset_name = excluded.dataset_name,
       source_page = excluded.source_page,
       grain = excluded.grain,
       columns = excluded.columns,
       row_count = excluded.row_count,
       update_frequency = excluded.update_frequency,
       updated_at = excluded.updated_at`,
  );

  const datasets = [
    {
      id: 'ProductRanking',
      name: '热销商品排行榜',
      page: '首页',
      grain: 'sku_day',
      columns: JSON.stringify(['排名', '商品信息', '成交金额', '访客数', '成交转化率']),
      rowCount: 6,
      frequency: 'daily',
    },
    {
      id: 'ChannelRanking',
      name: '渠道排行',
      page: '首页',
      grain: 'channel_day',
      columns: JSON.stringify(['排名', '渠道名称', '引入成交金额', '引入商详访客数', '访客-成交转化率']),
      rowCount: 1,
      frequency: 'daily',
    },
    {
      id: 'ShopRanking',
      name: '店铺排行',
      page: '首页',
      grain: 'shop_day',
      columns: JSON.stringify(['排名', '店铺', '成交金额', '访客数', '成交单量']),
      rowCount: 1,
      frequency: 'daily',
    },
    {
      id: 'SalesTarget',
      name: '销售目标对比',
      page: '首页',
      grain: 'month',
      columns: JSON.stringify(['月份', '2025年销售额', '2026年目标值', '增长率', '2026年销售额']),
      rowCount: 1,
      frequency: 'monthly',
    },
    {
      id: 'BrandComposition',
      name: '品牌构成',
      page: '交易',
      grain: 'brand_day',
      columns: JSON.stringify(['品牌', '成交金额', '成交金额占比', '成交商品件数', '成交单量', '成交客户数', '操作']),
      rowCount: 3,
      frequency: 'daily',
    },
    {
      id: 'SearchKeyword',
      name: '搜索关键词',
      page: '流量',
      grain: 'keyword_day',
      columns: JSON.stringify(['关键词', '引入访客数', '引入成交金额']),
      rowCount: 6,
      frequency: 'daily',
    },
    {
      id: 'TrafficSource',
      name: '流量来源',
      page: '流量',
      grain: 'product_day',
      columns: JSON.stringify(['商品信息', '引入访客数', '引入成交金额']),
      rowCount: 6,
      frequency: 'daily',
    },
    {
      id: 'ProductTrafficRanking',
      name: '商品流量排行',
      page: '流量',
      grain: 'product_day',
      columns: JSON.stringify(['排名', '商品信息', '商品访客数', '商品访客数占比', '成交金额']),
      rowCount: 9,
      frequency: 'daily',
    },
    {
      id: 'BrandRanking',
      name: '品牌排行',
      page: '市场',
      grain: 'brand_day',
      columns: JSON.stringify(['排名', '品牌名称', '成交金额', '成交单量', '成交商品件数', '浏览量', '访客数', '搜索点击次数']),
      rowCount: 11,
      frequency: 'weekly',
    },
    {
      id: 'ReportDownload',
      name: '报表下载列表',
      page: '报表',
      grain: 'report',
      columns: JSON.stringify(['文件名称', '来源类型', '创建时间', '下载状态', '操作']),
      rowCount: 2,
      frequency: 'on_demand',
    },
  ];

  const now = nowIso();
  for (const d of datasets) {
    stmt.run(
      d.id, d.name, d.page, d.grain, d.columns, d.rowCount,
      d.frequency, now, now,
    );
  }
};

/** Seed default signal weights (upsert). */
const seedSignalWeights = (db: Db): void => {
  const stmt = db.prepare(
    `INSERT INTO signal_weights (signal_name, weight, source, updated_at)
     VALUES (?, ?, 'default', ?)
     ON CONFLICT(signal_name) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at`,
  );
  for (const [name, weight] of Object.entries(DEFAULT_SIGNAL_WEIGHTS)) {
    stmt.run(name, weight, nowIso());
  }
};

/** Seed the three ranking profiles (upsert). */
const seedRankingProfiles = (db: Db): void => {
  const stmt = db.prepare(
    `INSERT INTO ranking_profiles (name, weights, signal_mapping, goal, description)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       weights = excluded.weights,
       signal_mapping = excluded.signal_mapping,
       goal = excluded.goal,
       description = excluded.description`,
  );
  for (const profile of Object.values(RANKING_PROFILES)) {
    stmt.run(
      profile.name,
      JSON.stringify(profile.weights),
      JSON.stringify(profile.signal_mapping),
      profile.goal,
      profile.description,
    );
  }
};

/**
 * Initialize a database: ensure dir, open, apply schema, seed.
 * Returns the open handle (caller is responsible for closing).
 */
export const initDatabase = (db: Db): void => {
  applySchema(db);
  applyJdSchema(db);
  applyP0007Schema(db); // P0007.2: situations, learning_contexts, human_interventions
  applyP0013Schema(db); // P0013: replay_runs, replay_run_steps, replay_run_evidence_refs, replay_run_cognitive_snapshots, replay_monthly_reviews (+ 2 nullable columns on evidence_observations)
  initMemoryStore(db); // P0007.3.1

  const seedWeights = db.prepare('SELECT 1 FROM signal_weights LIMIT 1').get();
  if (!seedWeights) seedSignalWeights(db);

  const seedProfiles = db.prepare('SELECT 1 FROM ranking_profiles LIMIT 1').get();
  if (!seedProfiles) seedRankingProfiles(db);

  const seedJdDatasetsResult = db.prepare('SELECT 1 FROM jd_dataset_metadata LIMIT 1').get();
  if (!seedJdDatasetsResult) seedJdDatasets(db);
};

// CLI entry: `npm run db:init`
const main = (): void => {
  const path = process.env.DB_PATH ?? './data/agentfabric.db';
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  initDatabase(db);
  // eslint-disable-next-line no-console
  console.log(`[agentFabric] database initialized at ${path}`);
  db.close();
};

// ES module guard: run main only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
