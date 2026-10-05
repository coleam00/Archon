/**
 * Typed config parsing for Claude provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import { createLogger } from '@archon/paths';
import { parseClaudeSettingSources } from '@archon/paths/skills';
import type { ClaudeProviderDefaults } from '../types';
import {
  assertKnownRunConfigKeys,
  invalidRunConfigValue,
  normalizeRunConfigString,
} from '../shared/run-config';

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

/** Strict counterpart for authored config: `.archon/config.yaml` and per-run layers. */
export function parseClaudeConfigStrict(raw: Record<string, unknown>): ClaudeProviderDefaults {
  assertKnownRunConfigKeys(raw, ['model', 'settingSources', 'claudeBinaryPath']);
  const model = normalizeRunConfigString(raw.model, 'model');
  const claudeBinaryPath = normalizeRunConfigString(raw.claudeBinaryPath, 'claudeBinaryPath');
  if (raw.settingSources !== undefined) {
    if (!Array.isArray(raw.settingSources)) {
      invalidRunConfigValue('settingSources', "an array containing only 'project' or 'user'");
    }
    const invalidIndex = raw.settingSources.findIndex(
      source => source !== 'project' && source !== 'user'
    );
    if (invalidIndex >= 0) {
      invalidRunConfigValue(`settingSources.${invalidIndex}`, "'project' or 'user'");
    }
  }
  const parsed = parseClaudeConfig(raw);
  return {
    ...parsed,
    ...(model === undefined ? {} : { model }),
    ...(claudeBinaryPath === undefined ? {} : { claudeBinaryPath }),
  };
}
