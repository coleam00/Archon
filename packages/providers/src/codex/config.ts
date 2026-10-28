/**
 * Codex provider config: the schema owns the shape, and the defaults type is
 * derived from it.
 */
import {
  EFFORT_LADDER,
  snapshotConfigSchema,
  type ProviderConfigScope,
} from '@archon/provider-contract';
import { z } from 'zod';
import { configStringSchema, parseConfigLenient, parseConfigSchema } from '../shared/run-config';
import type { WebSearchMode } from './protocol/WebSearchMode';

/**
 * Codex accepts every rung of the shared ladder. Its protocol types the effort as a plain
 * string, so there is no closed vendor vocabulary to check the ladder against.
 */
export const CODEX_EFFORTS = EFFORT_LADDER;

/** The web-search modes Archon exposes; Codex's protocol also has `indexed`. */
const CODEX_WEB_SEARCH_MODES = [
  'disabled',
  'cached',
  'live',
] as const satisfies readonly WebSearchMode[];

const portableFields = {
  model: configStringSchema.optional(),
  modelReasoningEffort: z
    .enum(CODEX_EFFORTS, { error: `expected ${CODEX_EFFORTS.join(', ')}` })
    .optional(),
};
const localFields = {
  webSearchMode: z.enum(CODEX_WEB_SEARCH_MODES).optional(),
  additionalDirectories: z.array(z.string()).optional(),
  /** Path to the Codex CLI binary. Overrides auto-detection in compiled Archon builds. */
  codexBinaryPath: configStringSchema.optional(),
  /**
   * Models whose route rejects tools and a strict output schema in one request. On these, a
   * node with `output_format` runs its tools without the schema, then one tool-free turn on
   * the same thread with it. Codex multi-agent is off on their threads, except that a model
   * catalog entry with `multi_agent_version: v2` keeps its collaboration tools on both turns.
   */
  toolFreeStructuredOutputModels: z.array(configStringSchema).optional(),
};
const fields = { ...portableFields, ...localFields };
export const configSchemas = {
  install: z.strictObject(fields),
  run: z.strictObject(fields),
  snapshot: snapshotConfigSchema(portableFields, localFields),
};

export type CodexProviderDefaults = z.output<typeof configSchemas.install>;

/** Parse raw assistantConfig into typed Codex defaults, dropping invalid values. */
export function parseCodexConfig(raw: Record<string, unknown>): CodexProviderDefaults {
  return parseConfigLenient(configSchemas.install, raw, 'codex');
}

export function parseCodexConfigStrict(
  raw: Record<string, unknown>,
  scope: ProviderConfigScope = 'install'
): CodexProviderDefaults {
  return parseConfigSchema(configSchemas[scope], raw);
}
