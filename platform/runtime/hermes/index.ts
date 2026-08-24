// Hermes client factory. Selects subprocess or stub based on env.
// Tests force HERMES_CLIENT=stub so the project runs without Python/Hermes installed.

import { SubprocessHermesClient } from './subprocess-client.js';
import { StubHermesClient } from './stub-client.js';
import type { HermesClient } from './types.js';

export * from './types.js';
export { HermesRuntimeAdapter } from './adapter.js';
export { createCapabilityBridge, resetCapabilityBridge } from './capability-bridge.js';
export type { CapabilityBridge, CapabilityDiscoveryResult } from './capability-bridge.js';
export { HermesSessionClient, HermesAuthError } from './session-client.js';
export type { HermesEvent, HermesSessionClientOptions, CreateSessionParams, CreateSessionResult } from './session-client.js';
export { resolveHermesSessionToken, resetTokenCache } from './token-resolver.js';
export type { ResolveOptions } from './token-resolver.js';

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

/**
 * Create a HermesClient. Default: subprocess in prod, stub in tests.
 * Override with HERMES_CLIENT=stub|subprocess.
 */
export const createHermesClient = (): HermesClient => {
  const mode = process.env.HERMES_CLIENT ?? (isTest ? 'stub' : 'subprocess');
  if (mode === 'stub') return new StubHermesClient();
  return new SubprocessHermesClient();
};
