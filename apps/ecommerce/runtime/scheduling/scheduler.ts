// P0010.1 Slice 3 — minimal Scheduled Acquisition. NOT a scheduler engine.
//
// Purpose: let existing Fabric Capabilities run on a fixed daily schedule so
// evidence keeps flowing in steady state. It REUSES the existing
// Fabric Capability → Acquisition → Evidence Store path (kernel.execute with
// local-first live acquire). The scheduler never makes business judgments,
// never forms hypotheses, never recommends — it only observes the world on a
// schedule. Agent-directed acquisition (Investigation) is a separate concern
// and also lands in the same Evidence Store.
//
// No second acquisition implementation.

import type { Database as Db } from 'better-sqlite3';
import { createRuntimeKernel } from '#app/runtime/kernel/index.js';
import type { RuntimeKernel } from '#app/runtime/kernel/index.js';
import { createEmptyBlueprint } from '#app/runtime/kernel/runtime-executor.js';
import { loadBlueprint } from '#app/connectors/binding/loader.js';
import { createCapabilityAcquire } from '#app/connectors/jd/historical-acquire.js';
import { nowIso } from '#shared/utils/time.js';

/** One configured scheduled acquisition (in-memory config, minimal). */
export interface ScheduledAcquisition {
  capability: string;
  /** Local 24h "HH:MM" daily run time */
  at: string;
  enabled: boolean;
}

export interface AcquisitionRunState {
  lastRunAt: string | null;
  lastStatus: 'pending' | 'completed' | 'failed' | null;
}

let kernel: RuntimeKernel | null = null;
const getKernel = (db: Db): RuntimeKernel => {
  if (kernel) return kernel;
  let blueprint;
  try {
    blueprint = loadBlueprint('jd');
  } catch {
    blueprint = createEmptyBlueprint('jd');
  }
  // P0010.2.11 C1 — scheduler must use the same per-capability dispatch as
  // `/api/fabric/execute`. Bare `createLocalFirstLiveAcquire` would route
  // trade.overview through the OLD snapshot walker.
  kernel = createRuntimeKernel(db, blueprint, createCapabilityAcquire());
  return kernel;
};

/** Reset the kernel singleton (for testing). */
export const resetSchedulerKernel = (): void => {
  kernel = null;
};

export interface ScheduledAcquisitionRunner {
  start(): void;
  stop(): void;
  /** Run one capability now (test/on-demand); returns the fresh run state. */
  runNow(capability: string, date?: string): Promise<AcquisitionRunState>;
  /** Current config + last-run state. */
  list(): Array<ScheduledAcquisition & AcquisitionRunState>;
}

export const createScheduledAcquisitionRunner = (
  db: Db,
  configs: ScheduledAcquisition[],
  onAfterRun?: (date: string) => void,
): ScheduledAcquisitionRunner => {
  const state = new Map<string, AcquisitionRunState>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const runCapability = async (capability: string, date: string): Promise<AcquisitionRunState> => {
    state.set(capability, { lastRunAt: nowIso(), lastStatus: 'pending' });
    try {
      const result = await getKernel(db).execute({
        shopId: 'jd_shop_001',
        mock: false,
        capabilities: [capability],
        date,
      });
      const ok = result.success && result.evidence.length > 0;
      state.set(capability, { lastRunAt: nowIso(), lastStatus: ok ? 'completed' : 'failed' });
      if (ok) onAfterRun?.(date); // feed new evidence into the Situation path
      return state.get(capability)!;
    } catch (err) {
      state.set(capability, { lastRunAt: nowIso(), lastStatus: 'failed' });
      return state.get(capability)!;
    }
  };

  const tick = async (): Promise<void> => {
    const now = nowIso();
    const today = now.slice(0, 10);
    const hhmm = now.slice(11, 16);
    for (const cfg of configs) {
      if (!cfg.enabled) continue;
      const st = state.get(cfg.capability);
      // Run at most once per day per capability (after the configured time).
      if (st?.lastRunAt && st.lastRunAt.slice(0, 10) === today) continue;
      if (hhmm >= cfg.at) {
        await runCapability(cfg.capability, today);
      }
    }
  };

  return {
    start: () => {
      if (!timer) timer = setInterval(() => void tick(), 60_000);
      void tick();
    },
    stop: () => {
      if (timer) { clearInterval(timer); timer = null; }
    },
    runNow: async (capability, date) => runCapability(capability, date ?? nowIso().slice(0, 10)),
    list: () => configs.map((c) => ({ ...c, ...(state.get(c.capability) ?? { lastRunAt: null, lastStatus: null }) })),
  };
};
