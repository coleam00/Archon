/**
 * Agent Provider Factory
 *
 * Dynamic provider instantiation and static capability lookup.
 * Built-in providers: Claude, Codex, and Pi.
 */
import type { IAgentProvider, ProviderCapabilities } from './types';
import { ClaudeProvider } from './claude/provider';
import { CodexProvider } from './codex/provider';
import { PiProvider } from './pi/provider';
import { CLAUDE_CAPABILITIES } from './claude/capabilities';
import { CODEX_CAPABILITIES } from './codex/capabilities';
import { PI_CAPABILITIES } from './pi/capabilities';
import { UnknownProviderError } from './errors';
import { createLogger } from '@archon/paths';

/** Built-in provider types. */
const REGISTERED_PROVIDERS = ['claude', 'codex', 'pi'] as const;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.factory');
  return cachedLog;
}

/**
 * Get the appropriate agent provider based on type.
 *
 * @param type - Provider type identifier ('claude', 'codex', or 'pi')
 * @returns Instantiated agent provider
 * @throws UnknownProviderError if provider type is not registered
 */
export function getAgentProvider(type: string): IAgentProvider {
  switch (type) {
    case 'claude':
      getLog().debug({ provider: 'claude' }, 'provider_selected');
      return new ClaudeProvider();
    case 'codex':
      getLog().debug({ provider: 'codex' }, 'provider_selected');
      return new CodexProvider();
    case 'pi':
      getLog().debug({ provider: 'pi' }, 'provider_selected');
      return new PiProvider();
    default:
      throw new UnknownProviderError(type, [...REGISTERED_PROVIDERS]);
  }
}

/**
 * Get provider capabilities without instantiating a provider.
 * Used by dag-executor and orchestrator for capability warnings.
 */
export function getProviderCapabilities(type: string): ProviderCapabilities {
  switch (type) {
    case 'claude':
      return CLAUDE_CAPABILITIES;
    case 'codex':
      return CODEX_CAPABILITIES;
    case 'pi':
      return PI_CAPABILITIES;
    default:
      throw new UnknownProviderError(type, [...REGISTERED_PROVIDERS]);
  }
}
