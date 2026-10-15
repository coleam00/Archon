import {
  snapshotConfigSchema,
  type PiExtensionPosture,
  type ProviderConfigScope,
} from '@archon/provider-contract';
import { z } from 'zod';
import { parseConfigLenient, parseConfigSchema } from '../../shared/run-config';
import { piModelRefSchema } from './model-ref';

/**
 * Per-node override of Pi extension posture, keyed by workflow node id
 * (`nodeConfig.nodeId`). Lets install-wide extension settings be scoped to the
 * node that actually plays that role — e.g. only the planner node gets
 * plannotator's `plan` flag and a UI-capable context, while an `implement`
 * node runs headless without the planning-mode edit guard (issue #2073).
 *
 * The overrides share the SDK-free `PiExtensionPosture` contract.
 * `extensionFlags` is shallow-merged over the assistant-level flags (node
 * wins); set a flag to `false` to negate an inherited `true`. Merge and
 * precedence semantics live in {@link resolvePiExtensionSettings}.
 */
export type PiNodeOverride = PiExtensionPosture;

/** Effective extension posture for one sendQuery call. */
export interface PiExtensionSettings {
  enableExtensions: boolean;
  interactive: boolean;
  extensionFlags: Record<string, boolean | string> | undefined;
}

/**
 * Resolve the effective extension posture for a node across three layers, in
 * ascending precedence:
 *   1. assistant-level defaults (`assistants.pi.*`)
 *   2. install-level config override (`assistants.pi.nodes.<nodeId>`, #2124)
 *   3. portable node-YAML override (the workflow node's `pi:` block, #2133)
 *
 * The node-YAML layer wins because it travels with the workflow and is what the
 * author actually sees; the config map stays as the per-install escape hatch.
 * Calls without a node id (direct chat) get only the assistant-level defaults
 * and ignore both override layers — `nodeYaml` is undefined there too.
 *
 * Node ids are matched verbatim across all workflows for the config-map layer —
 * treat them as role names (`plan`, `implement`) when scoping extension behavior.
 */
export function resolvePiExtensionSettings(
  config: PiProviderDefaults,
  nodeId: string | undefined,
  nodeYaml?: PiNodeOverride
): PiExtensionSettings {
  const configOverride = nodeId !== undefined ? config.nodes?.[nodeId] : undefined;
  const enableExtensions =
    nodeYaml?.enableExtensions ??
    configOverride?.enableExtensions ??
    config.enableExtensions !== false;
  // Clamp to false without extensions: nothing consumes hasUI without a runner.
  const interactive =
    enableExtensions &&
    (nodeYaml?.interactive ?? configOverride?.interactive ?? config.interactive !== false);
  // Shallow-merge flags across all three layers, later layers winning per key —
  // so a node-YAML `plan: false` negates an assistant-level `plan: true`.
  const merged = {
    ...config.extensionFlags,
    ...configOverride?.extensionFlags,
    ...nodeYaml?.extensionFlags,
  };
  const extensionFlags = Object.keys(merged).length > 0 ? merged : undefined;
  return { enableExtensions, interactive, extensionFlags };
}

const extensionFields = {
  enableExtensions: z.boolean().optional(),
  interactive: z.boolean().optional(),
  extensionFlags: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
};
const portableFields = {
  /** Default model ref in '<pi-provider-id>/<model-id>' format, e.g. 'google/gemini-2.5-pro' */
  model: piModelRefSchema.optional(),
  ...extensionFields,
  nodes: z.record(z.string(), z.strictObject(extensionFields)).optional(),
};
const processFields = {
  /**
   * Environment variables injected into `process.env` at session start so
   * in-process extensions (which read `process.env` directly) pick them up.
   * Existing `process.env` entries are NOT overridden — shell env wins over
   * config. Use for extension-config vars like `PLANNOTATOR_REMOTE=1` that
   * must be present before the extension's `session_start` hook runs.
   *
   * Note: this differs from `requestOptions.env` (codebase-scoped env vars),
   * which is per-request and only injected into bash subprocesses. Use
   * codebase env vars for secrets that vary per project; use `assistants.pi.env`
   * for extension wiring that's global to the Pi provider.
   */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Maximum number of concurrent Pi `session.prompt()` calls allowed.
   * When this limit is reached, additional calls queue and wait rather than
   * fail. Pi/Minimax does not throttle concurrent requests at the SDK layer
   * (unlike the Claude SDK), so this prevents cascading 429/rate-limit failures
   * when many parallel workflow nodes invoke Pi simultaneously.
   *
   * Set to a positive integer matching your Pi API tier's concurrency limit.
   * Omit for unlimited (not recommended for production batches).
   */
  maxConcurrent: z.number().int().positive().optional(),
};
export const configSchemas = {
  install: z.strictObject({ ...portableFields, ...processFields }),
  run: z.strictObject({
    ...portableFields,
    env: z
      .never({ error: 'Pi extension environment mutates process.env and is process-scoped' })
      .optional(),
    maxConcurrent: z
      .never({ error: 'Pi concurrency is initialized once for the process lifetime' })
      .optional(),
  }),
  snapshot: snapshotConfigSchema(portableFields, processFields),
};

/** Assistant-level Pi defaults plus optional per-node overrides (`nodes.<id>`). */
export type PiProviderDefaults = z.output<typeof configSchemas.install>;

/** Parse raw assistantConfig into typed Pi defaults, dropping invalid values. */
export function parsePiConfig(raw: Record<string, unknown>): PiProviderDefaults {
  return parseConfigLenient(configSchemas.install, raw, 'pi');
}

export function parsePiConfigStrict(
  raw: Record<string, unknown>,
  scope: ProviderConfigScope
): PiProviderDefaults {
  return parseConfigSchema(configSchemas[scope], raw);
}
