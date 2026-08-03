import type { PiProviderDefaults } from '../../types';

export type { PiProviderDefaults };

/**
 * Per-node override of Pi extension posture, keyed by workflow node id
 * (`nodeConfig.nodeId`). Lets install-wide extension settings be scoped to the
 * node that actually plays that role — e.g. only the planner node gets
 * plannotator's `plan` flag and a UI-capable context, while an `implement`
 * node runs headless without the planning-mode edit guard (issue #2073).
 *
 * The three fields are exactly the extension-posture subset of
 * `PiProviderDefaults`, so we derive rather than re-declare them.
 * `extensionFlags` is shallow-merged over the assistant-level flags (node
 * wins); set a flag to `false` to negate an inherited `true`. Merge and
 * precedence semantics live in {@link resolvePiExtensionSettings}.
 */
export type PiNodeOverride = Pick<
  PiProviderDefaults,
  'enableExtensions' | 'interactive' | 'extensionFlags'
>;

/** parsePiConfig output: assistant-level defaults plus optional per-node overrides. */
export interface ParsedPiConfig extends PiProviderDefaults {
  nodes?: Record<string, PiNodeOverride>;
}

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
  config: ParsedPiConfig,
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

/**
 * Parse the extension-posture fields shared by assistant-level config and
 * per-node overrides (`PiNodeOverride` deliberately mirrors these three
 * `PiProviderDefaults` fields — one validation rule, two config levels).
 */
function parseExtensionPostureFields(raw: Record<string, unknown>): PiNodeOverride {
  const parsed: PiNodeOverride = {};
  if (typeof raw.enableExtensions === 'boolean') {
    parsed.enableExtensions = raw.enableExtensions;
  }
  if (typeof raw.interactive === 'boolean') {
    parsed.interactive = raw.interactive;
  }
  if (
    raw.extensionFlags &&
    typeof raw.extensionFlags === 'object' &&
    !Array.isArray(raw.extensionFlags)
  ) {
    const flags: Record<string, boolean | string> = {};
    for (const [key, value] of Object.entries(raw.extensionFlags as Record<string, unknown>)) {
      if (typeof value === 'boolean' || typeof value === 'string') {
        flags[key] = value;
      }
    }
    if (Object.keys(flags).length > 0) {
      parsed.extensionFlags = flags;
    }
  }
  return parsed;
}

/** Parse one `nodes.<id>` entry; returns undefined when nothing valid is set. */
function parsePiNodeOverride(raw: Record<string, unknown>): PiNodeOverride | undefined {
  const override = parseExtensionPostureFields(raw);
  return Object.keys(override).length > 0 ? override : undefined;
}

/**
 * Parse raw YAML-derived config into typed Pi defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig
 * and parseCodexConfig — never throws, so broken user config can't prevent
 * provider registration or workflow discovery).
 */
export function parsePiConfig(raw: Record<string, unknown>): ParsedPiConfig {
  const result: ParsedPiConfig = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  Object.assign(result, parseExtensionPostureFields(raw));

  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    if (Object.keys(env).length > 0) {
      result.env = env;
    }
  }

  if (
    typeof raw.maxConcurrent === 'number' &&
    Number.isInteger(raw.maxConcurrent) &&
    raw.maxConcurrent > 0
  ) {
    result.maxConcurrent = raw.maxConcurrent;
  }

  if (raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes)) {
    const nodes: Record<string, PiNodeOverride> = {};
    for (const [nodeId, value] of Object.entries(raw.nodes as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const override = parsePiNodeOverride(value as Record<string, unknown>);
      if (override) {
        nodes[nodeId] = override;
      }
    }
    if (Object.keys(nodes).length > 0) {
      result.nodes = nodes;
    }
  }

  return result;
}
