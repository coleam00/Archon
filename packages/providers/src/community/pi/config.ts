import type { PiProviderDefaults } from '../../types';

export type { PiProviderDefaults };

/**
 * Parse raw YAML-derived config into typed Pi defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig
 * and parseCodexConfig — never throws, so broken user config can't prevent
 * provider registration or workflow discovery).
 */
export function parsePiConfig(raw: Record<string, unknown>): PiProviderDefaults {
  const result: PiProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.enableExtensions === 'boolean') {
    result.enableExtensions = raw.enableExtensions;
  }

  if (typeof raw.interactive === 'boolean') {
    result.interactive = raw.interactive;
  }

  if (
    raw.extensionFlags &&
    typeof raw.extensionFlags === 'object' &&
    !Array.isArray(raw.extensionFlags)
  ) {
    const flags: Record<string, boolean | string> = {};
    for (const [key, value] of Object.entries(raw.extensionFlags as Record<string, unknown>)) {
      if (typeof value === 'boolean' || typeof value === 'string') {
        flags[key] = value;
      }
    }
    if (Object.keys(flags).length > 0) {
      result.extensionFlags = flags;
    }
  }

  return result;
}
