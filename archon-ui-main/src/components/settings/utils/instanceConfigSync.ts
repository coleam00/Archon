/**
 * Utility functions for syncing LLM instance configurations
 */

export interface InstanceConfig {
  name: string;
  url: string;
  useAuth: boolean;
  authToken: string;
}

/**
 * Creates an embedding instance config synced from the LLM instance config.
 * Used when "Use same host for embedding instance" is checked.
 *
 * Copies: name, url, useAuth, authToken (all settings)
 */
export function syncEmbeddingFromLLM(
  llmConfig: InstanceConfig,
  defaultName: string = 'Default Ollama'
): InstanceConfig {
  return {
    name: llmConfig.name || defaultName,
    url: llmConfig.url,
    useAuth: llmConfig.useAuth,
    authToken: llmConfig.authToken,
  };
}
