import type { CopilotProviderDefaults } from '../../types';

export type { CopilotProviderDefaults };

/**
 * Parse raw `assistants.copilot` config into a typed `CopilotProviderDefaults`.
 *
 * Fallback behavior: fields with unexpected types (or enum values outside the
 * declared set) are silently omitted rather than throwing. A broken user
 * config must not prevent provider registration or workflow discovery.
 * Callers that want strict validation should validate upstream.
 */
export function parseCopilotConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  const config: CopilotProviderDefaults = {};

  if (typeof raw.model === 'string') {
    config.model = raw.model;
  }

  if (typeof raw.modelReasoningEffort === 'string') {
    const v = raw.modelReasoningEffort;
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh') {
      config.modelReasoningEffort = v;
    } else if (v === 'max') {
      // Accept Archon's workflow-schema alias for the top tier. Normalizing
      // at parse time keeps `CopilotProviderDefaults.modelReasoningEffort`
      // aligned with the SDK's enum (which has no 'max').
      config.modelReasoningEffort = 'xhigh';
    }
  }

  if (typeof raw.copilotCliPath === 'string') {
    config.copilotCliPath = raw.copilotCliPath;
  }

  if (typeof raw.configDir === 'string') {
    config.configDir = raw.configDir;
  }

  if (typeof raw.enableConfigDiscovery === 'boolean') {
    config.enableConfigDiscovery = raw.enableConfigDiscovery;
  }

  if (typeof raw.useLoggedInUser === 'boolean') {
    config.useLoggedInUser = raw.useLoggedInUser;
  }

  if (
    raw.logLevel === 'none' ||
    raw.logLevel === 'error' ||
    raw.logLevel === 'warning' ||
    raw.logLevel === 'info' ||
    raw.logLevel === 'debug' ||
    raw.logLevel === 'all'
  ) {
    config.logLevel = raw.logLevel;
  }

  return config;
}
