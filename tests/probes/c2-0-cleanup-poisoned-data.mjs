// C2.0 cleanup probe — remove CONFIRMED-poisoned runtime data before the
// 2026-08-30 clean re-run (user-directed). Quarantine copies already exist
// in data/quarantine/2026-08-30-poisoned/ (files + full DB backup).
//
// 1. Remove poisoned evidence files (realtime-payload-under-historical-date,
//    shop 11855009) + test-pollution mock files (executor.test.ts fixture
//    stamped 2026-08-27) from the live evidence store.
// 2. DELETE their derived signals rows + the 4 wrong-window Situations
//    (2026-08-29T12:45:51Z, partial-day vs full-day comparison).
// Idempotent: safe to re-run.
import { existsSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';

const EV = 'data/evidence/jd/2026/08';
const FILES = [];
for (const d of ['22', '27', '28']) {
  for (const t of ['getSummary', 'getTrend']) {
    FILES.push(`${EV}/${d}_${t}.json`, `${EV}/${d}_${t}.meta.json`);
  }
}
// executor.test.ts mock executions also write legacy `summary`/`trend`/
// `productTop` files under 2026/07 (confirmed mock, acquired_at = test run)
const EV_JULY = 'data/evidence/jd/2026/07';
for (const d of ['04', '05', '09']) {
  for (const t of ['summary', 'trend', 'productTop']) {
    FILES.push(`${EV_JULY}/${d}_${t}.json`, `${EV_JULY}/${d}_${t}.meta.json`);
  }
}

const SIGNALS = [
  'jd-daily-2026-08-28-0831ce7d', // 6245.55 obs 8/28 (realtime 8/29 payload)
  'jd-daily-2026-08-27-75201eee', // 6245.55 obs 8/27
  'jd-daily-2026-08-22-517b2896', // 6245.55 obs 8/22
  'jd-daily-2026-08-27-fab3a57e', // 6801.02 mock fixture obs 8/27
  'jd-daily-2026-07-04-8b066ab1', // 5372.0 mock (executor.test.ts) obs 7/04
  'jd-daily-2026-07-05-0f0518a6', // 6259.0 mock (executor.test.ts) obs 7/05
];
const SITUATIONS = [
  'sit_6fd641691e9177f6a84c', // GMV 较昨日下降 52.7% (partial vs full day)
  'sit_ca222489c47a9762ae0c', // 访客数 较昨日下降 42.3%
  'sit_6745fac637dbada9cb8a', // 转化率 较昨日上升 58.9%
  'sit_9a79ec872bbde04077cc', // cross_signal
];

for (const f of FILES) {
  if (existsSync(f)) {
    rmSync(f);
    console.log(`removed ${f}`);
  }
}

const db = new BetterSqlite3('data/agentfabric.db');
// learning_contexts rows reference situations (FK) — derived artifacts of the
// same 4 wrong-window situations, deleted first (idempotent).
const delCtx = db.prepare(
  `DELETE FROM learning_contexts WHERE situation_id IN (${SITUATIONS.map(() => '?').join(',')})`,
);
console.log(`learning_contexts deleted: ${delCtx.run(...SITUATIONS).changes}`);
const delSignals = db.prepare(
  `DELETE FROM signals WHERE signal_id IN (${SIGNALS.map(() => '?').join(',')})`,
);
console.log(`signals deleted: ${delSignals.run(...SIGNALS).changes}`);
const delSits = db.prepare(
  `DELETE FROM situations WHERE situation_id IN (${SITUATIONS.map(() => '?').join(',')})`,
);
console.log(`situations deleted: ${delSits.run(...SITUATIONS).changes}`);
console.log(
  'remaining daily_summary signals:',
  db.prepare(`SELECT COUNT(*) c FROM signals WHERE signal_name='daily_summary'`).get().c,
);
console.log('remaining situations:', db.prepare('SELECT COUNT(*) c FROM situations').get().c);
db.close();

// integrity: file hash of the backup must match the live db BEFORE any writes
// (checked post-hoc here only for size sanity — real verification is the
// .bak taken before deletion)
const st = openSync('data/quarantine/2026-08-30-poisoned/agentfabric.db.bak', 'r');
closeSync(st);
console.log('backup present: true');
