/**
 * Agent Provider Factory
 *
 * Dynamically instantiates the appropriate agent provider based on type string.
 * Built-in providers only: Claude, Codex, and Copilot.
 */
import type { IAgentProvider } from './types';
import { ClaudeProvider } from './claude/provider';
import { CodexProvider } from './codex/provider';
import { CopilotProvider } from './copilot/provider';
import { UnknownProviderError } from './errors';
import { createLogger } from '@archon/paths';

/** Built-in provider types. */
const REGISTERED_PROVIDERS = ['claude', 'codex', 'copilot'] as const;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.factory');
  return cachedLog;
}

/**
 * Get the appropriate agent provider based on type.
 *
 * @param type - Provider type identifier ('claude' or 'codex')
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
    case 'copilot':
      getLog().debug({ provider: 'copilot' }, 'provider_selected');
      return new CopilotProvider();
    default:
      throw new UnknownProviderError(type, [...REGISTERED_PROVIDERS]);
  }
}
