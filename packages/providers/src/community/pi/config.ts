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

  return result;
}
