import type { GeminiProviderDefaults } from '../../types';

export type { GeminiProviderDefaults };

/**
 * Parse raw YAML-derived config into typed Gemini defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig,
 * parseCodexConfig, and parsePiConfig — never throws, so broken user config
 * can't prevent provider registration or workflow discovery).
 */
export function parseGeminiConfig(raw: Record<string, unknown>): GeminiProviderDefaults {
  const result: GeminiProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.geminiBinaryPath === 'string') {
    result.geminiBinaryPath = raw.geminiBinaryPath;
  }

  return result;
}
