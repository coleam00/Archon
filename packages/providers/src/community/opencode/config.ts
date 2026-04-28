import type { OpencodeProviderDefaults } from '../../types';

export type { OpencodeProviderDefaults };

/**
 * Parse raw YAML-derived config into typed opencode defaults.
 * Defensive: invalid fields are dropped silently (matches parsePiConfig and
 * parseCodexConfig — never throws, so broken user config can't prevent
 * provider registration or workflow discovery).
 */
export function parseOpencodeConfig(raw: Record<string, unknown>): OpencodeProviderDefaults {
  const result: OpencodeProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.opencodeBinaryDir === 'string') {
    result.opencodeBinaryDir = raw.opencodeBinaryDir;
  }

  return result;
}

/**
 * Parse an opencode model string into providerID and modelID.
 * opencode models use '<providerID>/<modelID>' format (e.g. 'ollama/qwen3:8b').
 * Returns undefined when the format is invalid.
 */
export function parseOpencodeModel(
  model: string
): { providerID: string; modelID: string } | undefined {
  const idx = model.indexOf('/');
  if (idx <= 0 || idx === model.length - 1) return undefined;
  return {
    providerID: model.slice(0, idx),
    modelID: model.slice(idx + 1),
  };
}
