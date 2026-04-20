/**
 * Typed config parsing for Codex provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import type { CodexProviderDefaults } from '../types';

// Re-export so consumers can import the type from either location
export type { CodexProviderDefaults } from '../types';

/**
 * Parse raw assistantConfig into typed Codex defaults.
 * Defensive: invalid fields are silently dropped.
 */
export function parseCodexConfig(raw: Record<string, unknown>): CodexProviderDefaults {
  const result: CodexProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  const validEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  if (
    typeof raw.modelReasoningEffort === 'string' &&
    validEfforts.includes(raw.modelReasoningEffort)
  ) {
    result.modelReasoningEffort =
      raw.modelReasoningEffort as CodexProviderDefaults['modelReasoningEffort'];
  }

  const validSearchModes = ['disabled', 'cached', 'live'];
  if (typeof raw.webSearchMode === 'string' && validSearchModes.includes(raw.webSearchMode)) {
    result.webSearchMode = raw.webSearchMode as CodexProviderDefaults['webSearchMode'];
  }

  if (Array.isArray(raw.additionalDirectories)) {
    result.additionalDirectories = raw.additionalDirectories.filter(
      (d): d is string => typeof d === 'string'
    );
  }

  if (typeof raw.codexBinaryPath === 'string') {
    result.codexBinaryPath = raw.codexBinaryPath;
  }

  return result;
}
