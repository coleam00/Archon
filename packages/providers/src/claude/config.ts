/**
 * Claude provider config: the schema owns the shape, and the defaults type is
 * derived from it.
 */
import { DEFAULT_SETTING_SOURCES, SETTING_SOURCES } from '@archon/paths/skills';
import { snapshotConfigSchema, type ProviderConfigScope } from '@archon/provider-contract';
import { z } from 'zod';
import { configStringSchema, parseConfigLenient, parseConfigSchema } from '../shared/run-config';

const portableFields = {
  model: configStringSchema.optional(),
};
const localFields = {
  /** Claude Code settingSources — controls which sources the SDK loads:
   *  CLAUDE.md, skills, commands, agents, and hooks. Both project-level
   *  (`<cwd>/.claude/`) and user-level (`~/.claude/`) are loaded by default.
   *  Set explicitly to `['project']` to scope a workflow to project-only
   *  resources (e.g. CI, shared environments).
   *  @default ['project', 'user']
   */
  settingSources: z
    .array(z.enum(SETTING_SOURCES, { error: "expected 'project' or 'user'" }))
    .optional(),
  /** Absolute path to the Claude Code SDK's `cli.js`. Required in compiled
   *  Archon builds when `CLAUDE_BIN_PATH` is not set; optional in dev mode
   *  (SDK resolves from node_modules). */
  claudeBinaryPath: configStringSchema.optional(),
};
const fields = { ...portableFields, ...localFields };
export const configSchemas = {
  install: z.strictObject(fields),
  run: z.strictObject(fields),
  snapshot: snapshotConfigSchema(portableFields, localFields),
};

export type ClaudeProviderDefaults = z.output<typeof configSchemas.install>;

/**
 * Parse raw assistantConfig into typed Claude defaults. Invalid values are
 * dropped rather than thrown; an invalid `settingSources` entry drops only that
 * entry, so a typo narrows the sources instead of widening them to the default.
 */
export function parseClaudeConfig(raw: Record<string, unknown>): ClaudeProviderDefaults {
  return parseConfigLenient(configSchemas.install, raw, 'claude');
}

export function parseClaudeConfigStrict(
  raw: Record<string, unknown>,
  scope: ProviderConfigScope = 'install'
): ClaudeProviderDefaults {
  return parseConfigSchema(configSchemas[scope], raw);
}

/** The Claude setting sources a run loads: the node's own, then the provider config's. */
export function resolveSettingSources(
  nodeSettingSources: readonly (typeof SETTING_SOURCES)[number][] | undefined,
  config: ClaudeProviderDefaults
): readonly (typeof SETTING_SOURCES)[number][] {
  return nodeSettingSources ?? config.settingSources ?? DEFAULT_SETTING_SOURCES;
}
