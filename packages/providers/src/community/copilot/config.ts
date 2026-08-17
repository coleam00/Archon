import type { CopilotProviderDefaults } from '../../types';
import { clampEffort } from '../../shared/effort';

export type { CopilotProviderDefaults };

/** The reasoning-depth rungs Copilot's SDK accepts, weakest → strongest. */
const COPILOT_CONFIG_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly NonNullable<CopilotProviderDefaults['modelReasoningEffort']>[];

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

  // Accept any rung of Archon's shared ladder and clamp it to the SDK's enum
  // (which has neither `minimal` nor `max`), so `assistants.copilot.*` takes
  // the same vocabulary a workflow's `effort:` does. Normalizing at parse time
  // keeps `CopilotProviderDefaults.modelReasoningEffort` SDK-shaped.
  const effort = clampEffort(raw.modelReasoningEffort, COPILOT_CONFIG_EFFORTS);
  if (effort !== undefined) {
    config.modelReasoningEffort = effort;
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
