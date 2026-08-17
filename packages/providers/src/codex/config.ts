/**
 * Typed config parsing for Codex provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import type { ModelReasoningEffort } from '@openai/codex-sdk';
import type { CodexProviderDefaults } from '../types';
import type { AssertNever } from '../shared/effort';

// Re-export so consumers can import the type from either location
export type { CodexProviderDefaults } from '../types';

/**
 * The reasoning-depth rungs the Codex SDK accepts, as a runtime list.
 *
 * `satisfies readonly ModelReasoningEffort[]` is the enforcement `types.ts`
 * cannot provide: that file is the contract layer and may never import an SDK,
 * so `CodexProviderDefaults.modelReasoningEffort` has to restate the union by
 * hand. Pinning the list to the SDK's own type here turns a rename or removal
 * upstream into a compile error instead of a value the SDK rejects at run time,
 * and `isCodexEffort` below narrows without a cast — which is what proves the
 * hand-written union still matches.
 */
export const CODEX_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly ModelReasoningEffort[];

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
