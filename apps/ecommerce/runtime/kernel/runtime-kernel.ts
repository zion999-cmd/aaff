// Runtime Kernel — single entry point for all connector execution.
// P0005.5: The kernel that converges CLI Legacy Path + Blueprint Path + Binding Layer
// into ONE runtime. Blueprint is the single source of truth for all execution.
// P0005.6.1: Adds executeLiveCDP + executeImport — CLI is now a pure shell.
//
// Usage:
//   const kernel = createRuntimeKernel(db, loadBlueprint('jd'));
//   const result = await kernel.execute({ shopId: 'jd_shop_001', date: '2026-07-04' });
//   const liveResult = await kernel.executeLiveCDP({ shopId: '...', fromDate: '...', toDate: '...' });
//   const importResult = await kernel.executeImport({ sourcePath: '/path/to/daily_records.json' });

import type { Database as Db } from 'better-sqlite3';
import type { BoundCapabilityModel } from '#app/connectors/binding/types.js';
import type { AcquireFunction } from '#app/connectors/binding/executor.js';
import {
  executeRuntimePipeline,
  executeLiveCDPPipeline,
  executeImportPipeline,
} from './runtime-executor.js';
import type {
  RuntimeExecuteOptions,
  RuntimeExecuteResult,
  RuntimeLiveCDPOptions,
  RuntimeLiveCDPResult,
  RuntimeImportOptions,
  RuntimeImportResult,
} from './runtime-executor.js';
import { acquireJdData } from '#app/connectors/jd/acquisition/index.js';
import { normalizeFabricShopId } from '#app/connectors/jd/shop-identity.js';

// ---- Kernel Interface ----

export interface RuntimeKernel {
  /** Platform identifier */
  platform: string;
  /** The loaded blueprint — single source of truth */
  blueprint: BoundCapabilityModel;
  /**
   * Execute the full runtime pipeline for one day (mock or single-day live).
   * Plan → Acquire → Parse → Normalize → Signal → Evidence
   */
  execute: (options: RuntimeExecuteOptions) => Promise<RuntimeExecuteResult>;
  /**
   * Execute multi-day live CDP acquisition in ONE Chrome session.
   * All business logic (acquire, parse, signal, evidence) stays inside the kernel.
   */
  executeLiveCDP: (options: RuntimeLiveCDPOptions) => Promise<RuntimeLiveCDPResult>;
  /**
   * Import historical JD data from an agentCMS daily_records.json export.
   * Handles both blueprint-driven and legacy signal generation internally.
   */
  executeImport: (options: RuntimeImportOptions) => Promise<RuntimeImportResult>;
}

// ---- Factory ----

/**
 * Create a RuntimeKernel bound to a specific blueprint and database.
 *
 * The kernel is the single entry point for all connector execution.
 * CLI and other entry points go through the kernel — never directly to
 * acquireJdData, processDay, or SignalFacade.
 *
 * @param db - Open SQLite database connection
 * @param blueprint - Loaded and validated ConnectorBlueprint
 * @param acquireFn - Optional custom acquire function (defaults to JD acquireJdData)
 */
export const createRuntimeKernel = (
  db: Db,
  blueprint: BoundCapabilityModel,
  acquireFn?: AcquireFunction,
): RuntimeKernel => {
  // Default acquire function: wraps acquireJdData to match AcquireFunction signature
  const defaultAcquire: AcquireFunction = async (shopId, _endpoints, opts) => {
    const acqOpts: {
      shopId?: string;
      date?: string;
      mock?: boolean;
      blueprint: BoundCapabilityModel;
    } = {
      shopId,
      mock: opts?.mock ?? true,
      blueprint,
    };
    if (opts?.date) acqOpts.date = opts.date;

    const result = await acquireJdData(acqOpts);

    if (!result.success) {
      throw new Error(result.error ?? 'JD acquisition failed');
    }

    // Return data in the shape executor expects: Record<endpoint, payload>
    const data: Record<string, unknown> = {};
    if (result.rawPayload) {
      // rawPayload from JD acquisition is { summary, trend, productTop }
      const raw = result.rawPayload;
      if (raw['summary'] !== undefined) data['summary'] = raw['summary'];
      if (raw['trend'] !== undefined) data['trend'] = raw['trend'];
      if (raw['productTop'] !== undefined) data['productTop'] = raw['productTop'];
    }
    return data;
  };

  const acquire = acquireFn ?? defaultAcquire;

  return {
    platform: blueprint.platform,
    blueprint,
    // P0010: normalize every incoming shopId to the canonical Fabric key
    // before any evidence write — the Investigation agent historically
    // re-acquired with the provider internal id (blueprint.shop_id), splitting
    // Evidence away from the key the producer reads. Unknown ids fail fast.
    execute: (options: RuntimeExecuteOptions) => {
      const shopId = normalizeFabricShopId(options.shopId);
      return executeRuntimePipeline(blueprint, acquire, db, { ...options, shopId });
    },
    executeLiveCDP: (options: RuntimeLiveCDPOptions) => {
      const shopId = normalizeFabricShopId(options.shopId);
      return executeLiveCDPPipeline(blueprint, db, { ...options, shopId });
    },
    executeImport: (options: RuntimeImportOptions) =>
      executeImportPipeline(blueprint, db, options),
  };
};

// Re-export types for convenience
export type {
  RuntimeExecuteOptions,
  RuntimeExecuteResult,
  RuntimeLiveCDPOptions,
  RuntimeLiveCDPResult,
  RuntimeImportOptions,
  RuntimeImportResult,
};
