/**
 * Typed config parsing for Codex provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import type { ModelReasoningEffort } from '@openai/codex-sdk';
import type { CodexProviderDefaults } from '../types';
import { EFFORT_LADDER, type AssertNever } from '@archon/paths/effort';
import {
  assertKnownRunConfigKeys,
  invalidRunConfigValue,
  normalizeRunConfigString,
} from '../shared/run-config';

// Re-export so consumers can import the type from either location
export type { CodexProviderDefaults } from '../types';

/**
 * Bind the shared ladder to the Codex SDK vocabulary in both directions.
 */
export const CODEX_EFFORTS = EFFORT_LADDER satisfies readonly ModelReasoningEffort[];

/** Coverage, which `satisfies` above cannot express — a rung the SDK gains must
 *  be added here rather than silently clamped away. See `AssertNever`. */
export type CodexEffortsAreComplete = AssertNever<
  Exclude<ModelReasoningEffort, (typeof CODEX_EFFORTS)[number]>
>;

function isCodexEffort(value: unknown): value is ModelReasoningEffort {
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

/** Strict counterpart used only for an explicitly selected per-run layer. */
export function parseCodexRunConfig(raw: Record<string, unknown>): CodexProviderDefaults {
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
  return {
    ...parsed,
    ...(model === undefined ? {} : { model }),
    ...(codexBinaryPath === undefined ? {} : { codexBinaryPath }),
  };
}
