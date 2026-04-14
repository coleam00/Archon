/**
 * Typed config parsing for Ollama provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import type { OllamaProviderDefaults } from '../types';

// Re-export so consumers can import the type from either location
export type { OllamaProviderDefaults } from '../types';

/**
 * Parse raw assistantConfig into typed Ollama defaults.
 * Defensive: invalid fields are silently dropped.
 */
export function parseOllamaConfig(raw: Record<string, unknown>): OllamaProviderDefaults {
  const result: OllamaProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.baseUrl === 'string') {
    result.baseUrl = raw.baseUrl;
  }

  return result;
}
