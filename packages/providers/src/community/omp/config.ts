import type { OmpProviderDefaults } from '../../types';

export type { OmpProviderDefaults };

/**
 * Parse raw YAML-derived config into typed OMP defaults.
 * Defensive: invalid fields are dropped silently — matches parsePiConfig
 * and parseClaudeConfig behavior so broken user config can't prevent
 * provider registration or workflow discovery.
 */
export function parseOmpConfig(raw: Record<string, unknown> | undefined): OmpProviderDefaults {
  const result: OmpProviderDefaults = {};
  if (!raw) return result;

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (raw.enableExtensions === true) {
    result.enableExtensions = true;
  }

  if (raw.interactive === true) {
    result.interactive = true;
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

  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    if (Object.keys(env).length > 0) {
      result.env = env;
    }
  }

  return result;
}
