import type { CopilotClientOptions, SessionConfig } from '@github/copilot-sdk';
import {
  EFFORT_LADDER,
  clampEffort,
  snapshotConfigSchema,
  type AssertNever,
  type ProviderConfigScope,
} from '@archon/provider-contract';
import { z } from 'zod';
import { configStringSchema, parseConfigLenient, parseConfigSchema } from '../../shared/run-config';

/**
 * The reasoning-depth rungs Copilot's SDK accepts, weakest → strongest.
 *
 * The SDK does not export `ReasoningEffort` from its barrel, but its public
 * `SessionConfig` retains the union.
 */
type CopilotEffort = NonNullable<SessionConfig['reasoningEffort']>;

export const COPILOT_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly CopilotEffort[];

export type CopilotEffortsAreComplete = AssertNever<
  Exclude<CopilotEffort, (typeof COPILOT_EFFORTS)[number]>
>;

/** Copilot CLI log levels, imported from the SDK's client options. */
type CopilotLogLevel = NonNullable<CopilotClientOptions['logLevel']>;

const COPILOT_LOG_LEVELS = [
  'none',
  'error',
  'warning',
  'info',
  'debug',
  'all',
] as const satisfies readonly CopilotLogLevel[];

export type CopilotLogLevelsAreComplete = AssertNever<
  Exclude<CopilotLogLevel, (typeof COPILOT_LOG_LEVELS)[number]>
>;

const portableFields = {
  /** Default model ref, e.g. 'gpt-5', 'gpt-5-mini', 'claude-sonnet-4.5'. */
  model: configStringSchema.optional(),
  /**
   * Reasoning effort passed to the SDK as `reasoningEffort`. Accepts any rung
   * of Archon's shared ladder, the same vocabulary a workflow's `effort:`
   * takes, and clamps it to the SDK's enum at parse time.
   */
  modelReasoningEffort: z
    .enum(EFFORT_LADDER, { error: 'expected a valid Archon effort level' })
    .transform(effort => clampEffort(effort, COPILOT_EFFORTS))
    .optional(),
};
const localFields = {
  /**
   * Absolute path to the Copilot CLI binary. Required in compiled Archon
   * builds when `COPILOT_BIN_PATH` env var is not set. Dev-mode builds let
   * the SDK resolve from `$PATH`.
   */
  copilotCliPath: configStringSchema.optional(),
  /**
   * Override Copilot's config directory. When unset the SDK uses its own
   * default (typically `~/.copilot`).
   */
  configDir: configStringSchema.optional(),
  /**
   * Opt in to Copilot's config discovery from the repo (MCP servers, skills,
   * etc. declared in the repo's `.copilot/` directory). Disabled by default
   * so arbitrary repos do not implicitly load MCP servers or skills.
   * @default false
   */
  enableConfigDiscovery: z.boolean({ error: 'expected a boolean' }).optional(),
  /**
   * Reuse the CLI's logged-in user credentials (from `copilot login`) when
   * no explicit token is provided via env vars.
   * @default true
   */
  useLoggedInUser: z.boolean({ error: 'expected a boolean' }).optional(),
  /** Copilot CLI log level. When unset the SDK picks its own default. */
  logLevel: z
    .enum(COPILOT_LOG_LEVELS, { error: 'expected none, error, warning, info, debug, or all' })
    .optional(),
};
const fields = { ...portableFields, ...localFields };
export const configSchemas = {
  install: z.strictObject(fields),
  run: z.strictObject(fields),
  snapshot: snapshotConfigSchema(portableFields, localFields),
};

/** Community provider defaults for GitHub Copilot (@github/copilot-sdk). */
export type CopilotProviderDefaults = z.output<typeof configSchemas.install>;

/** Parse raw `assistants.copilot` config into typed defaults, dropping invalid values. */
export function parseCopilotConfig(raw: Record<string, unknown>): CopilotProviderDefaults {
  return parseConfigLenient(configSchemas.install, raw, 'copilot');
}

/** Strict counterpart for authored config: `.archon/config.yaml` and per-run layers. */
export function parseCopilotConfigStrict(
  raw: Record<string, unknown>,
  scope: ProviderConfigScope = 'install'
): CopilotProviderDefaults {
  return parseConfigSchema(configSchemas[scope], raw);
}
