/**
 * Typed config parsing for MiniMax provider defaults.
 */

export interface MiniMaxProviderDefaults {
  [key: string]: unknown;
  model?: string;
  baseURL?: string;
}

// Re-export so consumers can import the type from either location
export type { MiniMaxProviderDefaults as MiniMaxConfig };

/**
 * Parse raw assistantConfig into typed MiniMax defaults.
 * Defensive: invalid fields are silently dropped.
 */
export function parseMiniMaxConfig(raw: Record<string, unknown>): MiniMaxProviderDefaults {
  const result: MiniMaxProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.baseURL === 'string') {
    result.baseURL = raw.baseURL;
  }

  return result;
}
