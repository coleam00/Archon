/**
 * Typed config parsing for Pi provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import type { PiProviderDefaults } from '../types';

// Re-export so consumers can import the type from either location
export type { PiProviderDefaults } from '../types';

/**
 * Parse raw assistantConfig into typed Pi defaults.
 * Defensive: invalid fields are silently dropped.
 */
export function parsePiConfig(raw: Record<string, unknown>): PiProviderDefaults {
  const result: PiProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  return result;
}
