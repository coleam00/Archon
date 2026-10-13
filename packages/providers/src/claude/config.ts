/**
 * Typed config parsing for Claude provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import { snapshotConfigSchema, type ProviderConfigScope } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import { parseClaudeSettingSources } from '@archon/paths/skills';
import type { ClaudeProviderDefaults } from '../types';
import { z } from 'zod';
import { configStringSchema, parseConfigSchema } from '../shared/run-config';

// Re-export so consumers can import the type from either location
export type { ClaudeProviderDefaults } from '../types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('provider.claude.config');
  return cachedLog;
}

/**
 * Parse raw assistantConfig into typed Claude defaults.
 * Defensive: invalid fields are dropped rather than thrown. `settingSources` is
 * a capability control, so dropped entries are logged instead of going silent.
 */
export function parseClaudeConfig(raw: Record<string, unknown>): ClaudeProviderDefaults {
  const result: ClaudeProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  const settingSources = parseClaudeSettingSources(raw.settingSources);
  if (settingSources.value !== undefined) {
    if (settingSources.invalid.length > 0) {
      getLog().warn(
        { invalid: settingSources.invalid, effective: settingSources.value },
        'claude.setting_sources_invalid_entries'
      );
    }
    result.settingSources = settingSources.value;
  }

  if (typeof raw.claudeBinaryPath === 'string') {
    result.claudeBinaryPath = raw.claudeBinaryPath;
  }

  return result;
}

const fields = {
  model: configStringSchema.optional(),
  settingSources: z
    .array(z.enum(['project', 'user'], { error: "expected 'project' or 'user'" }))
    .optional(),
  claudeBinaryPath: configStringSchema.optional(),
};
export const configSchemas = {
  install: z.strictObject(fields),
  run: z.strictObject(fields),
  snapshot: snapshotConfigSchema(
    { model: fields.model },
    { settingSources: fields.settingSources, claudeBinaryPath: fields.claudeBinaryPath }
  ),
};

export function parseClaudeConfigStrict(
  raw: Record<string, unknown>,
  scope: ProviderConfigScope = 'install'
): ClaudeProviderDefaults {
  return parseConfigSchema(configSchemas[scope], raw);
}
