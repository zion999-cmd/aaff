// P0010.2.7 — Dev environment wrapper.
//
// Purpose: ensure the agentFabric dev server always talks to the
// project-chosen Hermes port (9120) without forcing the operator to
// remember an environment variable. Before this wrapper, the dev
// process inherited a `HERMES_WS_URL` that was sometimes unset,
// causing the fallback in `platform/runtime/hermes/resolve-url.ts`
// to be used. The fallback is now 9120 too (not 9119), but the
// wrapper makes the env-var layer explicit at startup so the
// readiness probe, status probe, and the actual agent-turn
// endpoint can be read straight off `process.env` in the logs.
//
// Behaviour (priority order):
//   1. If `HERMES_WS_URL` is already set in the parent env, the
//      wrapper uses it AS-IS. The operator-pinned value always wins.
//   2. Otherwise, the wrapper sets
//      `HERMES_WS_URL=ws://localhost:9120/api/ws` and prints a
//      single prominent startup line so the operator can see which
//      endpoint the dev server is configured for.
//   3. The wrapper then spawns the actual server process (`tsx
//      watch platform/server/index.ts` in dev, or `node` of the
//      compiled entry in prod) with the merged env. The server
//      itself reads from `process.env['HERMES_WS_URL']` via the
//      shared resolve-url.ts helper — no other code needs to know
//      about this wrapper.
//
// What this wrapper deliberately does NOT do:
//   - It does NOT auto-discover via lsof / ps eww. Auto-discovery
//     is a deferred diagnostic mechanism (see ADR-064 +
//     `hermes-auto-discovery-vs-explicit-contract.md`); it cannot
//     override an explicit operator-pinned value. Adding discovery
//     here would re-introduce the same 9119/9120 drift the user
//     screenshotted.
//   - It does NOT modify Hermes itself, the .env file, the project
//     topology, the Hermes model, or any Hermes proxy. It only
//     forwards one env var to the agentFabric child process.
//   - It does NOT spawn Hermes. The operator runs Hermes separately
//     (e.g. `hermes serve --port 9120`) — that boundary is preserved.
//
// Usage:
//   npx tsx scripts/with-hermes-env.ts platform/server/index.ts
//   # dev (watch):
//   npx tsx scripts/with-hermes-env.ts --watch platform/server/index.ts
//   # explicitly override the URL for this run only:
//   HERMES_WS_URL=ws://localhost:9121/api/ws npx tsx scripts/with-hermes-env.ts platform/server/index.ts
//
// The wrapper exits with the same code as the child process. A
// Ctrl-C / SIGTERM is forwarded to the child so the dev server
// shuts down cleanly.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);

// Optional `--watch` flag: forwards to `tsx watch`.
let watch = false;
if (args[0] === '--watch' || args[0] === '-w') {
  watch = true;
  args.shift();
}
if (args.length === 0) {
  console.error('[with-hermes-env] usage: with-hermes-env.ts [--watch] <entry> [...args]');
  process.exit(2);
}

const entry = resolve(process.cwd(), args[0]!);
const restArgs = args.slice(1);

// Operator-pinned URL wins. The wrapper never overrides what the
// operator already chose. This is the explicit-env contract from
// ADR-064: configuration is env-pinned, not auto-discovered.
const parentUrl = process.env['HERMES_WS_URL'];
const effectiveUrl = (parentUrl && parentUrl.trim().length > 0)
  ? parentUrl
  : 'ws://localhost:9120/api/ws';

const usingDefault = !parentUrl || parentUrl.trim().length === 0;
if (usingDefault) {
  // Set only for the child process; do NOT mutate the parent's env.
  process.env['HERMES_WS_URL'] = effectiveUrl;
}

const banner = '═'.repeat(72);
console.log(banner);
console.log('[with-hermes-env] Hermes Session Runtime endpoint:');
console.log(`  HERMES_WS_URL = ${effectiveUrl}`);
console.log(`  source:        ${usingDefault ? 'default (project-chosen 9120)' : 'operator-pinned'}`);
console.log(`  entry:         ${entry}${watch ? ' (tsx watch)' : ''}`);
console.log(banner);
console.log('');

// Spawn the child with the merged env. `stdio: 'inherit'` makes
// the wrapper invisible to the operator — they see exactly the
// same dev server output as before, with the URL banner above it.
const tsxCli = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const child = spawn(
  process.execPath,
  [
    ...(watch ? [tsxCli, 'watch', entry] : [tsxCli, entry]),
    ...restArgs,
  ],
  { stdio: 'inherit', env: process.env },
);

let exiting = false;
const forward = (signal: NodeJS.Signals): void => {
  if (exiting) return;
  exiting = true;
  // SIGINT to a tsx watch process triggers a clean shutdown of
  // both the watch supervisor and the spawned server. We forward
  // the signal rather than killing so the child can run its
  // shutdown hooks.
  if (child.pid) {
    try { process.kill(child.pid, signal); } catch { /* already gone */ }
  }
};
process.on('SIGINT', forward);
process.on('SIGTERM', forward);
process.on('SIGHUP', forward);

child.on('exit', (code, sig) => {
  if (sig) {
    // Process was signalled — exit with the conventional 128+N code
    // so shell pipelines see the same status they would have seen
    // from running the child directly.
    const n = sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 1;
    process.exit(n);
  }
  process.exit(code ?? 0);
});
