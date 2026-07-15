import type { PiProviderDefaults } from '../../types';

export type { PiProviderDefaults };

/**
 * Per-node override of Pi extension posture, keyed by workflow node id
 * (`nodeConfig.nodeId`). Lets install-wide extension settings be scoped to the
 * node that actually plays that role — e.g. only the planner node gets
 * plannotator's `plan` flag and a UI-capable context, while an `implement`
 * node runs headless without the planning-mode edit guard (issue #2073).
 */
export interface PiNodeOverride {
  /** Override extension discovery for this node. */
  enableExtensions?: boolean;
  /** Override the UIContext binding (`ctx.hasUI`) for this node. */
  interactive?: boolean;
  /**
   * Per-node extension flags, shallow-merged over the assistant-level
   * `extensionFlags` (node wins). Set a flag to `false` to negate a base
   * `true` (extensions check `getFlag(name) === true`).
   */
  extensionFlags?: Record<string, boolean | string>;
}

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
 * Resolve the effective extension posture for a node. Node overrides
 * (`assistants.pi.nodes.<nodeId>`) win over assistant-level defaults; calls
 * without a node id (direct chat) always get the assistant-level defaults.
 * Node ids are matched verbatim across all workflows — treat them as role
 * names (`plan`, `implement`) when scoping extension behavior.
 */
export function resolvePiExtensionSettings(
  config: ParsedPiConfig,
  nodeId: string | undefined
): PiExtensionSettings {
  const override = nodeId !== undefined ? config.nodes?.[nodeId] : undefined;
  const enableExtensions = override?.enableExtensions ?? config.enableExtensions !== false;
  // Clamp to false without extensions: nothing consumes hasUI without a runner.
  const interactive = enableExtensions && (override?.interactive ?? config.interactive !== false);
  const extensionFlags = override?.extensionFlags
    ? { ...config.extensionFlags, ...override.extensionFlags }
    : config.extensionFlags;
  return { enableExtensions, interactive, extensionFlags };
}

/** Parse one `nodes.<id>` entry; returns undefined when nothing valid is set. */
function parsePiNodeOverride(raw: Record<string, unknown>): PiNodeOverride | undefined {
  const override: PiNodeOverride = {};
  if (typeof raw.enableExtensions === 'boolean') {
    override.enableExtensions = raw.enableExtensions;
  }
  if (typeof raw.interactive === 'boolean') {
    override.interactive = raw.interactive;
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
      override.extensionFlags = flags;
    }
  }
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

  if (typeof raw.enableExtensions === 'boolean') {
    result.enableExtensions = raw.enableExtensions;
  }

  if (typeof raw.interactive === 'boolean') {
    result.interactive = raw.interactive;
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
      result.extensionFlags = flags;
    }
  }

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
