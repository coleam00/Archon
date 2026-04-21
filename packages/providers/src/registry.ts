/**
 * Provider Registry
 *
 * Typed registry where each entry is a ProviderRegistration record (factory + metadata).
 * Replaces the hardcoded factory switch from Phase 1.
 *
 * Bootstrap: callers must call registerBuiltinProviders() at process entrypoints
 * (server startup, CLI init) before any provider lookups.
 */
import type {
  IAgentProvider,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
} from './types';
import { ClaudeProvider } from './claude/provider';
import { CodexProvider } from './codex/provider';
import { CLAUDE_CAPABILITIES } from './claude/capabilities';
import { CODEX_CAPABILITIES } from './codex/capabilities';
import { registerCopilotProvider } from './community/copilot/registration';
import { registerPiProvider } from './community/pi/registration';
import { UnknownProviderError } from './errors';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.registry');
  return cachedLog;
}

/** Backing store for registered providers. */
const registry = new Map<string, ProviderRegistration>();

/**
 * Register a provider. Throws on duplicate registration.
 */
export function registerProvider(entry: ProviderRegistration): void {
  if (registry.has(entry.id)) {
    throw new Error(`Provider '${entry.id}' is already registered`);
  }
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

/**
 * Get all registered providers.
 */
export function getRegisteredProviders(): ProviderRegistration[] {
  return [...registry.values()];
}

/**
 * Get API-safe provider info (excludes factory and isModelCompatible).
 */
export function getProviderInfoList(): ProviderInfo[] {
  return getRegisteredProviders().map(({ id, displayName, capabilities, builtIn }) => ({
    id,
    displayName,
    capabilities,
    builtIn,
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
      isModelCompatible: (model: string): boolean => {
        const aliases = ['sonnet', 'opus', 'haiku'];
        return aliases.includes(model) || model.startsWith('claude-') || model === 'inherit';
      },
      builtIn: true,
    },
    {
      id: 'codex',
      displayName: 'Codex (OpenAI)',
      factory: () => new CodexProvider(),
      capabilities: CODEX_CAPABILITIES,
      isModelCompatible: (model: string): boolean => {
        const claudeAliases = ['sonnet', 'opus', 'haiku'];
        return (
          !claudeAliases.includes(model) && !model.startsWith('claude-') && model !== 'inherit'
        );
      },
      builtIn: true,
    },
  ];

  for (const entry of builtins) {
    if (!registry.has(entry.id)) {
      registry.set(entry.id, entry);
      getLog().debug({ provider: entry.id }, 'builtin_provider.registered');
    }
  }
}

/**
 * Register all bundled community providers in one call.
 *
 * Process entrypoints (server, CLI, config-loader) call this once after
 * `registerBuiltinProviders()`. Adding a new community provider means:
 *   1. Drop the implementation under `packages/providers/src/community/<id>/`.
 *   2. Export a `register<Name>Provider()` function from it.
 *   3. Import + call it here.
 *
 * That's the entire cross-cutting change outside the provider's own
 * directory. No entrypoint edits, no config-type edits — just add a line
 * to this function. That's the Phase 2 contract (#1195): community
 * providers are a localized addition.
 *
 * Each `register*Provider` is itself idempotent, so calling this
 * aggregator multiple times (e.g. from both CLI and config-loader paths)
 * is safe. Errors during registration are not caught here — a broken
 * community provider should fail loud at bootstrap, not silently
 * disappear.
 */
export function registerCommunityProviders(): void {
  registerCopilotProvider();
  registerPiProvider();
}

/** @internal Test-only — clears the registry. Not for production use. */
export function clearRegistry(): void {
  registry.clear();
}
