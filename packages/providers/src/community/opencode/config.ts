import type { OpencodeProviderDefaults } from '../../types';

export type { OpencodeProviderDefaults };

/**
 * Parse raw YAML-derived config into typed OpenCode defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig,
 * parseCodexConfig, and parsePiConfig — never throws, so broken user config
 * can't prevent provider registration or workflow discovery).
 */
export function parseOpencodeConfig(raw: Record<string, unknown>): OpencodeProviderDefaults {
  const result: OpencodeProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.baseUrl === 'string') {
    result.baseUrl = raw.baseUrl;
  }

  return result;
}
