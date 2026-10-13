/**
 * Typed config parsing for Codex provider defaults.
 * Validates and narrows the opaque assistantConfig to typed fields.
 */
import type { CodexProviderDefaults } from '../types';
import {
  EFFORT_LADDER,
  snapshotConfigSchema,
  type EffortRung,
  type ProviderConfigScope,
} from '@archon/provider-contract';
import { z } from 'zod';
import { configStringSchema, parseConfigSchema } from '../shared/run-config';

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

const fields = {
  model: configStringSchema.optional(),
  modelReasoningEffort: z
    .enum(CODEX_EFFORTS, { error: `expected ${CODEX_EFFORTS.join(', ')}` })
    .optional(),
  webSearchMode: z.enum(['disabled', 'cached', 'live']).optional(),
  additionalDirectories: z.array(z.string()).optional(),
  codexBinaryPath: configStringSchema.optional(),
};
export const configSchemas = {
  install: z.strictObject(fields),
  run: z.strictObject(fields),
  snapshot: snapshotConfigSchema(
    { model: fields.model, modelReasoningEffort: fields.modelReasoningEffort },
    {
      webSearchMode: fields.webSearchMode,
      additionalDirectories: fields.additionalDirectories,
      codexBinaryPath: fields.codexBinaryPath,
    }
  ),
};

export function parseCodexConfigStrict(
  raw: Record<string, unknown>,
  scope: ProviderConfigScope = 'install'
): CodexProviderDefaults {
  return parseConfigSchema(configSchemas[scope], raw);
}
