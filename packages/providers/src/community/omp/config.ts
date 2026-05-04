import type { OmpProviderDefaults, OmpSettingsDefaults } from '../../types';

export type { OmpProviderDefaults };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, keepExplicitEmpty = false): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((item): item is string => typeof item === 'string');
  if (filtered.length > 0) return filtered;
  return keepExplicitEmpty ? [] : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const filtered: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') filtered[key] = item;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function booleanOrStringRecord(value: unknown): Record<string, boolean | string> | undefined {
  if (!isRecord(value)) return undefined;
  const filtered: Record<string, boolean | string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'boolean' || typeof item === 'string') filtered[key] = item;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function retrySettings(value: unknown): OmpSettingsDefaults['retry'] | undefined {
  if (!isRecord(value)) return undefined;

  const retry: NonNullable<OmpSettingsDefaults['retry']> = {};
  if (typeof value.enabled === 'boolean') retry.enabled = value.enabled;
  if (
    typeof value.maxRetries === 'number' &&
    Number.isInteger(value.maxRetries) &&
    value.maxRetries >= 0
  ) {
    retry.maxRetries = value.maxRetries;
  }

  return Object.keys(retry).length > 0 ? retry : undefined;
}

function enabledSetting(value: unknown): { enabled?: boolean } | undefined {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return undefined;
  return { enabled: value.enabled };
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
): void {
  if (value !== undefined) target[key] = value;
}

function settingsObject(value: unknown): OmpSettingsDefaults | undefined {
  if (!isRecord(value)) return undefined;

  const settings: OmpSettingsDefaults = {};
  assignDefined(settings, 'retry', retrySettings(value.retry));
  assignDefined(settings, 'compaction', enabledSetting(value.compaction));
  assignDefined(settings, 'contextPromotion', enabledSetting(value.contextPromotion));
  assignDefined(settings, 'modelRoles', stringRecord(value.modelRoles));

  for (const [sourceKey, targetKey] of [
    ['enabledModels', 'enabledModels'],
    ['modelProviderOrder', 'modelProviderOrder'],
    ['disabledProviders', 'disabledProviders'],
    ['disabledExtensions', 'disabledExtensions'],
  ] as const) {
    assignDefined(settings, targetKey, stringArray(value[sourceKey]));
  }

  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Parse raw YAML-derived config into typed Oh My Pi defaults.
 * Defensive: invalid fields are dropped silently, matching built-in provider
 * config parsers so broken optional fields cannot prevent provider discovery.
 */
export function parseOmpConfig(raw: Record<string, unknown>): OmpProviderDefaults {
  const result: OmpProviderDefaults = {};

  for (const [sourceKey, targetKey] of [
    ['model', 'model'],
    ['agentDir', 'agentDir'],
  ] as const) {
    const value = raw[sourceKey];
    if (typeof value === 'string') result[targetKey] = value;
  }

  for (const [sourceKey, targetKey] of [
    ['enableMCP', 'enableMCP'],
    ['enableLsp', 'enableLsp'],
    ['disableExtensionDiscovery', 'disableExtensionDiscovery'],
    ['interactive', 'interactive'],
  ] as const) {
    const value = raw[sourceKey];
    if (typeof value === 'boolean') result[targetKey] = value;
  }

  assignDefined(result, 'additionalExtensionPaths', stringArray(raw.additionalExtensionPaths));
  assignDefined(result, 'toolNames', stringArray(raw.toolNames, true));
  assignDefined(result, 'extensionFlags', booleanOrStringRecord(raw.extensionFlags));
  assignDefined(result, 'env', stringRecord(raw.env));
  assignDefined(result, 'settings', settingsObject(raw.settings));

  return result;
}
