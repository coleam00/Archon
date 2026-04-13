/**
 * Typed config parsing for Claude provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import type { ClaudeProviderDefaults } from '../types';

// Re-export so consumers can import the type from either location
export type { ClaudeProviderDefaults } from '../types';

/**
 * Parse raw assistantConfig into typed Claude defaults.
 * Defensive: invalid fields are silently dropped (not thrown).
 */
export function parseClaudeConfig(raw: Record<string, unknown>): ClaudeProviderDefaults {
  const result: ClaudeProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (Array.isArray(raw.settingSources)) {
    const valid = raw.settingSources.filter(
      (s): s is 'project' | 'user' => s === 'project' || s === 'user'
    );
    if (valid.length > 0) {
      result.settingSources = valid;
    }
  }

  return result;
}
