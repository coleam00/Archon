/**
 * GitHub Copilot CLI community provider — config parser.
 *
 * Parses raw YAML-derived assistantConfig into typed CopilotProviderDefaults.
 * Defensive: invalid/unknown fields are dropped (never throws, so broken user
 * config can't prevent provider registration or workflow discovery).
 */
import type { CopilotProviderDefaults } from '../../types';

export type { CopilotProviderDefaults };

function isValidTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Parse raw YAML-derived config into typed Copilot defaults.
 * All fields are optional and validated defensively.
 */
export function parseCopilotConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  const result: CopilotProviderDefaults = {};

  if (typeof raw.copilotBinaryPath === 'string') {
    result.copilotBinaryPath = raw.copilotBinaryPath;
  }

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.noAskUser === 'boolean') {
    result.noAskUser = raw.noAskUser;
  }

  if (typeof raw.allowAllTools === 'boolean') {
    result.allowAllTools = raw.allowAllTools;
  }

  if (typeof raw.allowAll === 'boolean') {
    result.allowAll = raw.allowAll;
  }

  if (typeof raw.allowAllPaths === 'boolean') {
    result.allowAllPaths = raw.allowAllPaths;
  }

  if (typeof raw.allowAllUrls === 'boolean') {
    result.allowAllUrls = raw.allowAllUrls;
  }

  if (isValidTimeoutMs(raw.firstEventTimeoutMs)) {
    result.firstEventTimeoutMs = Math.trunc(raw.firstEventTimeoutMs);
  }

  if (isValidTimeoutMs(raw.processTimeoutMs)) {
    result.processTimeoutMs = Math.trunc(raw.processTimeoutMs);
  }

  // String arrays
  for (const key of [
    'extraArgs',
    'allowTools',
    'denyTools',
    'addDirs',
    'allowUrls',
    'denyUrls',
    'secretEnvVars',
  ] as const) {
    const value = raw[key];
    if (Array.isArray(value)) {
      const strings = value
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map(v => v.trim());
      if (strings.length > 0) {
        (result as Record<string, unknown>)[key] = strings;
      }
    }
  }

  return result;
}
