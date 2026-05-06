import type { CopilotProviderDefaults } from '../../types';

export type { CopilotProviderDefaults };

/**
 * Parse raw YAML-derived config into typed Copilot defaults.
 * Defensive: invalid fields are dropped silently — never throws, so broken
 * user config can't prevent provider registration or workflow discovery.
 */
export function parseCopilotConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  const result: CopilotProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.cliPath === 'string') {
    result.cliPath = raw.cliPath;
  }

  if (typeof raw.githubToken === 'string') {
    result.githubToken = raw.githubToken;
  }

  return result;
}
