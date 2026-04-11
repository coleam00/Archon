/**
 * AI Assistant Client Factory
 *
 * Dynamically instantiates the appropriate AI assistant client based on type string.
 * Supports Claude, Codex, and Pi assistants.
 */
import type { IAssistantClient } from '../types';
import { ClaudeClient } from './claude';
import { CodexClient } from './codex';
import { PiClient } from './pi';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('client.factory');
  return cachedLog;
}

/**
 * Get the appropriate AI assistant client based on type
 *
 * @param type - Assistant type identifier ('claude', 'codex', or 'pi')
 * @returns Instantiated assistant client
 * @throws Error if assistant type is unknown
 */
export function getAssistantClient(type: string): IAssistantClient {
  switch (type) {
    case 'claude':
      getLog().debug({ provider: 'claude' }, 'client_selected');
      return new ClaudeClient();
    case 'codex':
      getLog().debug({ provider: 'codex' }, 'client_selected');
      return new CodexClient();
    case 'pi':
      getLog().debug({ provider: 'pi' }, 'client_selected');
      return new PiClient();
    default:
      throw new Error(`Unknown assistant type: ${type}. Supported types: 'claude', 'codex', 'pi'`);
  }
}
