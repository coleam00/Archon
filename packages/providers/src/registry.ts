/**
 * Provider Registry
 *
 * Typed registry where each entry is a ProviderRegistration record (factory + metadata).
 * Replaces the hardcoded factory switch from Phase 1.
 *
 * Bootstrap: callers must register their providers at process entrypoints
 * (server startup, CLI init) before any provider lookups.
 */
import type {
  IAgentProvider,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
} from './types';
import { createLogger } from '@archon/paths';
import {
  EFFORT_LADDER,
  type ProviderRegistry,
  parseProviderRunModel as parseRegisteredRunModel,
  UnknownProviderError,
  missingProviderMessage,
} from '@archon/provider-contract';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.registry');
  return cachedLog;
}

/** Backing store for registered providers. */
const registry = new Map<string, ProviderRegistration>();

const unavailableProviders = new Map<string, string>();

export function markProviderUnavailable(id: string, reason: string): void {
  unavailableProviders.set(id, reason);
}

export const providerRegistry: ProviderRegistry = {
  unavailable: id => unavailableProviders.get(id),
  get: id => registry.get(id),
  list: () => [...registry.values()],
};

/** Deprecated providers whose notice this process already logged. */
const deprecationNoticed = new Set<string>();

function assertValidCapabilities(entry: ProviderRegistration): void {
  if (entry.capabilities.sessionFork === true && !entry.capabilities.sessionResume) {
    throw new Error(`Provider '${entry.id}' cannot advertise sessionFork without sessionResume`);
  }
}

export function assertProviderRegistrationAllowed(
  entry: ProviderRegistration,
  existing: Iterable<ProviderRegistration>
): void {
  const registrations = [...existing];
  if (registrations.some(provider => provider.id === entry.id)) {
    throw new Error(`Provider '${entry.id}' is already registered`);
  }
  const owner = registrations.find(provider => provider.ownsUnprefixedModelRefs);
  if (entry.ownsUnprefixedModelRefs && owner) {
    throw new Error(`Provider '${owner.id}' already owns unprefixed model refs`);
  }
  assertValidCapabilities(entry);
}

/**
 * Register a provider. Throws on duplicate registration.
 */
export function registerProvider(entry: ProviderRegistration): void {
  assertProviderRegistrationAllowed(entry, registry.values());
  registry.set(entry.id, entry);
  unavailableProviders.delete(entry.id);
  getLog().debug({ provider: entry.id, builtIn: entry.builtIn }, 'provider.registered');
}

/**
 * Get an instantiated agent provider by ID.
 * @throws UnknownProviderError if not registered
 */
export function getAgentProvider(id: string): IAgentProvider {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(
      id,
      [...registry.keys()],
      missingProviderMessage(providerRegistry, id)
    );
  }
  getLog().debug({ provider: id }, 'provider_selected');
  // Every node and turn resolves its provider here, so the notice is gated per process.
  if (entry.deprecationNotice && !deprecationNoticed.has(id)) {
    deprecationNoticed.add(id);
    getLog().warn({ provider: id, notice: entry.deprecationNotice }, 'provider.deprecated');
  }
  return entry.factory();
}

/**
 * Get the full registration entry for a provider.
 * @throws UnknownProviderError if not registered
 */
export function getRegistration(id: string): ProviderRegistration {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(
      id,
      [...registry.keys()],
      missingProviderMessage(providerRegistry, id)
    );
  }
  return entry;
}

/**
 * Get provider capabilities without instantiating a provider.
 * @throws UnknownProviderError if not registered
 */
export function getProviderCapabilities(id: string): ProviderCapabilities {
  return getRegistration(id).capabilities;
}

/** Validate and normalize a run-owned model through the provider's strict parser. */
export function parseProviderRunModel(id: string, model: string): string {
  return parseRegisteredRunModel(getRegistration(id), model);
}

/**
 * Get all registered providers.
 */
export function getRegisteredProviders(): ProviderRegistration[] {
  return [...registry.values()];
}

/**
 * Get API-safe provider info (excludes the factory).
 */
export function getProviderInfoList(): ProviderInfo[] {
  return getRegisteredProviders().map(({ id, displayName, capabilities, builtIn }) => ({
    id,
    displayName,
    capabilities,
    builtIn,
    ...(capabilities.effortControl ? { effortLevels: EFFORT_LADDER } : {}),
  }));
}

/**
 * Check if a provider is registered.
 */
export function isRegisteredProvider(id: string): boolean {
  return registry.has(id);
}

/** @internal Test-only — clears the registry. Not for production use. */
export function clearRegistry(): void {
  registry.clear();
  unavailableProviders.clear();
  deprecationNoticed.clear();
}
