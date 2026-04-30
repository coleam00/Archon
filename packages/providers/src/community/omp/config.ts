import type { OmpProviderDefaults } from '../../types';

export type { OmpProviderDefaults };

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((item): item is string => typeof item === 'string');
  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Parse raw YAML-derived config into typed Oh My Pi defaults.
 * Defensive: invalid fields are dropped silently, matching built-in provider
 * config parsers so broken optional fields cannot prevent provider discovery.
 */
export function parseOmpConfig(raw: Record<string, unknown>): OmpProviderDefaults {
  const result: OmpProviderDefaults = {};

  if (typeof raw.model === 'string') result.model = raw.model;
  if (typeof raw.agentDir === 'string') result.agentDir = raw.agentDir;
  if (typeof raw.enableMCP === 'boolean') result.enableMCP = raw.enableMCP;
  if (typeof raw.enableLsp === 'boolean') result.enableLsp = raw.enableLsp;
  if (typeof raw.disableExtensionDiscovery === 'boolean') {
    result.disableExtensionDiscovery = raw.disableExtensionDiscovery;
  }

  const additionalExtensionPaths = stringArray(raw.additionalExtensionPaths);
  if (additionalExtensionPaths) result.additionalExtensionPaths = additionalExtensionPaths;

  const toolNames = stringArray(raw.toolNames);
  if (toolNames) result.toolNames = toolNames;

  return result;
}
