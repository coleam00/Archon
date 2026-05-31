import type { CursorProviderDefaults } from '../../types';

export type { CursorProviderDefaults };

const VALID_MODES = new Set(['agent', 'plan']);
const VALID_RUNTIMES = new Set(['local', 'cloud']);
const VALID_SETTING_SOURCES = new Set(['project', 'user', 'team', 'mdm', 'plugins', 'all']);

/**
 * Parse raw `assistants.cursor` config into typed defaults.
 * Invalid fields are omitted rather than throwing.
 */
export function parseCursorConfig(raw: Record<string, unknown>): CursorProviderDefaults {
  const config: CursorProviderDefaults = {};

  if (typeof raw.model === 'string' && raw.model.trim().length > 0) {
    config.model = raw.model.trim();
  }

  if (typeof raw.apiKey === 'string' && raw.apiKey.length > 0) {
    config.apiKey = raw.apiKey;
  }

  if (typeof raw.mode === 'string' && VALID_MODES.has(raw.mode)) {
    config.mode = raw.mode as CursorProviderDefaults['mode'];
  }

  if (typeof raw.runtime === 'string' && VALID_RUNTIMES.has(raw.runtime)) {
    config.runtime = raw.runtime as CursorProviderDefaults['runtime'];
  }

  if (typeof raw.enableSandbox === 'boolean') {
    config.enableSandbox = raw.enableSandbox;
  }

  if (
    raw.modelParams !== undefined &&
    typeof raw.modelParams === 'object' &&
    raw.modelParams !== null
  ) {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.modelParams as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) {
        params[key] = value;
      }
    }
    if (Object.keys(params).length > 0) {
      config.modelParams = params;
    }
  }

  if (Array.isArray(raw.settingSources)) {
    const sources = raw.settingSources.filter(
      (s): s is NonNullable<CursorProviderDefaults['settingSources']>[number] =>
        typeof s === 'string' && VALID_SETTING_SOURCES.has(s)
    );
    if (sources.length > 0) {
      config.settingSources = sources;
    }
  }

  if (Array.isArray(raw.cloudRepos)) {
    const repos: NonNullable<CursorProviderDefaults['cloudRepos']> = [];
    for (const entry of raw.cloudRepos) {
      if (typeof entry !== 'object' || entry === null) continue;
      const url = (entry as { url?: unknown }).url;
      if (typeof url !== 'string' || url.trim().length === 0) continue;
      const startingRef = (entry as { startingRef?: unknown }).startingRef;
      repos.push({
        url: url.trim(),
        ...(typeof startingRef === 'string' && startingRef.length > 0 ? { startingRef } : {}),
      });
    }
    if (repos.length > 0) {
      config.cloudRepos = repos;
    }
  }

  return config;
}
