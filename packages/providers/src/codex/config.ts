/**
 * Typed config parsing for Codex provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import type { CodexProviderDefaults } from '../types';
import {
  EFFORT_LADDER,
  type EffortRung,
  type ProviderConfigScope,
} from '@archon/provider-contract';
import {
  assertKnownRunConfigKeys,
  invalidRunConfigValue,
  normalizeRunConfigString,
} from '../shared/run-config';

// Re-export so consumers can import the type from either location
export type { CodexProviderDefaults } from '../types';

/**
 * Codex accepts every rung of the shared ladder. Its protocol types the effort as a plain
 * string, so there is no closed vendor vocabulary to check the ladder against.
 */
export const CODEX_EFFORTS = EFFORT_LADDER;

function isCodexEffort(value: unknown): value is EffortRung {
  return typeof value === 'string' && (CODEX_EFFORTS as readonly string[]).includes(value);
}

/**
 * Parse raw assistantConfig into typed Codex defaults.
 * Defensive: invalid fields are silently dropped.
 */
export function parseCodexConfig(raw: Record<string, unknown>): CodexProviderDefaults {
  const result: CodexProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (isCodexEffort(raw.modelReasoningEffort)) {
    result.modelReasoningEffort = raw.modelReasoningEffort;
  }

  const validSearchModes = ['disabled', 'cached', 'live'];
  if (typeof raw.webSearchMode === 'string' && validSearchModes.includes(raw.webSearchMode)) {
    result.webSearchMode = raw.webSearchMode as CodexProviderDefaults['webSearchMode'];
  }

  if (Array.isArray(raw.additionalDirectories)) {
    result.additionalDirectories = raw.additionalDirectories.filter(
      (d): d is string => typeof d === 'string'
    );
  }

  if (typeof raw.codexBinaryPath === 'string') {
    result.codexBinaryPath = raw.codexBinaryPath;
  }

  return result;
}

/** Strict counterpart for authored config: `.archon/config.yaml` and per-run layers. */
export function parseCodexConfigStrict(
  raw: Record<string, unknown>,
  scope: ProviderConfigScope = 'install'
): CodexProviderDefaults {
  assertKnownRunConfigKeys(raw, [
    'model',
    'modelReasoningEffort',
    'webSearchMode',
    'additionalDirectories',
    'codexBinaryPath',
  ]);
  const model = normalizeRunConfigString(raw.model, 'model');
  const codexBinaryPath = normalizeRunConfigString(raw.codexBinaryPath, 'codexBinaryPath');
  if (raw.modelReasoningEffort !== undefined && !isCodexEffort(raw.modelReasoningEffort)) {
    invalidRunConfigValue('modelReasoningEffort', CODEX_EFFORTS.join(', '));
  }
  if (
    raw.webSearchMode !== undefined &&
    (typeof raw.webSearchMode !== 'string' ||
      !['disabled', 'cached', 'live'].includes(raw.webSearchMode))
  ) {
    invalidRunConfigValue('webSearchMode', 'disabled, cached, or live');
  }
  if (raw.additionalDirectories !== undefined) {
    if (!Array.isArray(raw.additionalDirectories)) {
      invalidRunConfigValue('additionalDirectories', 'an array of strings');
    }
    const invalidIndex = raw.additionalDirectories.findIndex(value => typeof value !== 'string');
    if (invalidIndex >= 0) {
      invalidRunConfigValue(`additionalDirectories.${invalidIndex}`, 'a string');
    }
  }
  const parsed = parseCodexConfig(raw);
  if (scope === 'snapshot') {
    return {
      ...(model === undefined ? {} : { model }),
      ...(parsed.modelReasoningEffort === undefined
        ? {}
        : { modelReasoningEffort: parsed.modelReasoningEffort }),
    };
  }
  return {
    ...parsed,
    ...(model === undefined ? {} : { model }),
    ...(codexBinaryPath === undefined ? {} : { codexBinaryPath }),
  };
}
