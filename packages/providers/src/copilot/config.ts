/**
 * Copilot provider configuration parsing
 */
export interface ParsedCopilotConfig {
  model?: string;
}

export function parseCopilotConfig(assistantConfig: Record<string, unknown>): ParsedCopilotConfig {
  const config: ParsedCopilotConfig = {};

  if (typeof assistantConfig.model === 'string') {
    config.model = assistantConfig.model;
  }

  return config;
}
