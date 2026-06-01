import type { KiroProviderDefaults } from '../../types';

export type { KiroProviderDefaults };

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
}

export function parseKiroConfig(raw: Record<string, unknown>): KiroProviderDefaults {
  const result: KiroProviderDefaults = {};

  if (typeof raw.model === 'string') result.model = raw.model;
  if (typeof raw.binaryPath === 'string') result.binaryPath = raw.binaryPath;
  if (typeof raw.agent === 'string') result.agent = raw.agent;
  if (typeof raw.trustAllTools === 'boolean') result.trustAllTools = raw.trustAllTools;
  if (typeof raw.requireMcpStartup === 'boolean') {
    result.requireMcpStartup = raw.requireMcpStartup;
  }

  const trustTools = stringArray(raw.trustTools);
  if (trustTools) result.trustTools = trustTools;

  const additionalArgs = stringArray(raw.additionalArgs);
  if (additionalArgs) result.additionalArgs = additionalArgs;

  return result;
}
