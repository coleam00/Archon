/**
 * Copilot provider configuration parsing
 */
export interface CopilotProviderDefaults {
  model?: string;
}

export function parseCopilotConfig(
  assistantConfig: Record<string, unknown>
): CopilotProviderDefaults {
  const config: CopilotProviderDefaults = {};

  if (typeof assistantConfig.model === 'string') {
    config.model = assistantConfig.model;
  }

  return config;
}
