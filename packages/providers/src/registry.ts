/**
 * Provider Registry
 *
 * Typed registry where each entry is a ProviderRegistration record (factory + metadata).
 * Replaces the hardcoded factory switch from Phase 1.
 *
 * Bootstrap: callers must call registerBuiltinProviders() at process entrypoints
 * (server startup, CLI init) before any provider lookups.
 */
import { singleVendorCatalog } from './credential-catalog';
import type {
  IAgentProvider,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
} from './types';
import { ClaudeProvider } from './claude/provider';
import { CodexProvider } from './codex/provider';
import { parseClaudeConfigStrict } from './claude/config';
import { parseCodexConfigStrict } from './codex/config';
import { CLAUDE_CAPABILITIES } from './claude/capabilities';
import { CODEX_CAPABILITIES } from './codex/capabilities';
import { registerCopilotProvider } from './community/copilot/registration';
import { registerOpencodeProvider } from './community/opencode/registration';
import { registerPiProvider } from './community/pi/registration';
import { createLogger } from '@archon/paths';
import {
  EFFORT_LADDER,
  type ProviderRegistry,
  parseProviderRunModel as parseRegisteredRunModel,
  UnknownProviderError,
} from '@archon/provider-contract';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.registry');
  return cachedLog;
}

/** Backing store for registered providers. */
const registry = new Map<string, ProviderRegistration>();

export const providerRegistry: ProviderRegistry = {
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
  getLog().debug({ provider: entry.id, builtIn: entry.builtIn }, 'provider.registered');
}

/**
 * Get an instantiated agent provider by ID.
 * @throws UnknownProviderError if not registered
 */
export function getAgentProvider(id: string): IAgentProvider {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
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
    throw new UnknownProviderError(id, [...registry.keys()]);
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

/**
 * Register built-in providers (Claude, Codex). Idempotent — skips already-registered IDs.
 * Must be called at process entrypoints (server, CLI) before any provider lookups.
 */
export function registerBuiltinProviders(): void {
  const builtins: ProviderRegistration[] = [
    {
      id: 'claude',
      displayName: 'Claude (Anthropic)',
      factory: () => new ClaudeProvider(),
      capabilities: CLAUDE_CAPABILITIES,
      builtIn: true,
      parseConfig: parseClaudeConfigStrict,
      credentials: singleVendorCatalog({
        vendor: 'anthropic',
        displayName: 'Anthropic',
        kinds: ['api_key', 'subscription'],
      }),
    },
    {
      id: 'codex',
      displayName: 'Codex (OpenAI)',
      factory: () => new CodexProvider(),
      capabilities: CODEX_CAPABILITIES,
      builtIn: true,
      parseConfig: parseCodexConfigStrict,
      credentials: singleVendorCatalog({
        // Subscription (ChatGPT) login runs Archon's own PKCE flow —
        // see @archon/core credentials/openai-oauth.ts (#1924).
        vendor: 'openai',
        displayName: 'OpenAI',
        kinds: ['api_key', 'subscription'],
      }),
    },
  ];

  for (const entry of builtins) {
    if (!registry.has(entry.id)) {
      registerProvider(entry);
    }
  }
}

/** Register the remaining bundled providers; new community providers install as plugins. */
export function registerCommunityProviders(): void {
  registerOpencodeProvider();
  registerPiProvider();
  registerCopilotProvider();
}

/** @internal Test-only — clears the registry. Not for production use. */
export function clearRegistry(): void {
  registry.clear();
  deprecationNoticed.clear();
}
