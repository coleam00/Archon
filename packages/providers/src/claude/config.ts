/**
 * Typed config parsing for Claude provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import { createLogger } from '@archon/paths';
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

export interface ParsedSettingSources {
  /** Recognized entries, in the order given. Undefined when raw was not an array. */
  value?: ('project' | 'user')[];
  /** Entries dropped because they name no known setting source. */
  invalid: string[];
}

/**
 * Normalize a raw `settingSources` value to the entries Claude actually honours.
 *
 * Shared by the provider and by workflow resource validation so the two can
 * never disagree about a node's effective sources — a divergence here means
 * `archon workflow validate` fails a workflow that runs, or passes one that
 * cannot (see the PR #2535 review).
 *
 * Unrecognized entries are dropped rather than widening the result. Dropping
 * narrows, which is the safe direction; keeping the old "leave it unset"
 * behaviour let a single typo fall back to the permissive `['project','user']`
 * default, silently granting the ambient access the author was excluding.
 */
export function parseClaudeSettingSources(raw: unknown): ParsedSettingSources {
  if (!Array.isArray(raw)) return { invalid: [] };

  const value: ('project' | 'user')[] = [];
  const invalid: string[] = [];
  for (const entry of raw) {
    if (entry === 'project' || entry === 'user') value.push(entry);
    else invalid.push(typeof entry === 'string' ? entry : JSON.stringify(entry));
  }
  return { value, invalid };
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

/** Strict counterpart used only for an explicitly selected per-run layer. */
export function parseClaudeRunConfig(raw: Record<string, unknown>): ClaudeProviderDefaults {
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
