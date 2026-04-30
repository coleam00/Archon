import {
  codingTools,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type BashSpawnContext,
  type BashSpawnHook,
} from '@mariozechner/pi-coding-agent';
import type { ThinkingLevel } from '@mariozechner/pi-ai';

/**
 * Pi's exported `Tool` type is structurally `AgentTool<TSchema>` and isn't
 * re-exported at the package root. Deriving it from the `codingTools` aggregate
 * (which IS re-exported and typed as `Tool[]`) gives us a namespace-free alias
 * that satisfies TS's portable-type requirement.
 */
type PiTool = (typeof codingTools)[number];

import type { NodeConfig } from '../../types';

// ─── Thinking level ────────────────────────────────────────────────────────

/**
 * Pi's ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'.
 * Archon's common surface includes 'off' (from Codex's modelReasoningEffort)
 * and 'max' (from Claude's EffortLevel enum). Map into Pi's vocabulary:
 *  - 'off'    → undefined (no explicit thinkingLevel; Pi's implicit off)
 *  - 'max'    → 'xhigh'  (Archon's EffortLevel doesn't have xhigh)
 *  - others pass through if they're already Pi-native
 *
 * See packages/workflows/src/schemas/dag-node.ts#effortLevelSchema for
 * the Archon schema enum (`low | medium | high | max`). Workflow YAML can
 * only carry Archon-enum values; Pi-native `minimal` / `xhigh` are accepted
 * here for programmatic callers (orchestrator, tests) that bypass the
 * schema validator.
 */
const PI_NATIVE_LEVELS: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function normalizeToThinkingLevel(v: unknown): ThinkingLevel | undefined {
  if (typeof v !== 'string') return undefined;
  if (v === 'max') return 'xhigh';
  if (PI_NATIVE_LEVELS.has(v as ThinkingLevel)) return v as ThinkingLevel;
  return undefined;
}

export interface ResolvedThinkingLevel {
  /** ThinkingLevel to pass to Pi, or undefined for Pi's default (implicit off) */
  level: ThinkingLevel | undefined;
  /** Human-readable warning to surface as a system chunk, if the input shape wasn't usable */
  warning?: string;
}

/**
 * Resolve Archon's `effort` / `thinking` node fields to Pi's `ThinkingLevel`.
 *
 * Precedence: `thinking` > `effort` (when both are set and valid).
 * 'off' on either → `level: undefined` (Pi runs without explicit thinking).
 * Claude-shape `thinking: { type: 'enabled', budget_tokens: N }` object form →
 * warning, not applied.
 */
export function resolvePiThinkingLevel(nodeConfig?: NodeConfig): ResolvedThinkingLevel {
  if (!nodeConfig) return { level: undefined };

  const { thinking, effort } = nodeConfig;

  // Explicit off on either field disables thinking entirely.
  if (thinking === 'off' || effort === 'off') return { level: undefined };

  // thinking takes precedence over effort when both are valid strings.
  const thinkingLevel = normalizeToThinkingLevel(thinking);
  if (thinkingLevel) return { level: thinkingLevel };

  const effortLevel = normalizeToThinkingLevel(effort);
  if (effortLevel) return { level: effortLevel };

  // Claude uses a structured `{ type: 'enabled', budget_tokens: N }` shape —
  // Pi doesn't understand it. Surface the mismatch so users can fix their YAML.
  if (thinking !== undefined && thinking !== null && typeof thinking === 'object') {
    return {
      level: undefined,
      warning:
        'Pi ignored `thinking` (object form is Claude-specific). Use `effort: low|medium|high|max` in YAML (max → xhigh on Pi).',
    };
  }

  // String that isn't a known level (e.g. 'ultra') — warn so users fix it.
  if (typeof thinking === 'string' || typeof effort === 'string') {
    const offender = typeof thinking === 'string' ? thinking : effort;
    return {
      level: undefined,
      warning: `Pi ignored unknown thinking level '${String(offender)}'. Valid: minimal, low, medium, high, xhigh, max, off.`,
    };
  }

  return { level: undefined };
}

// ─── Tool restrictions ─────────────────────────────────────────────────────

/** Pi's seven built-in coding tools. */
const PI_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;
export type PiToolName = (typeof PI_TOOL_NAMES)[number];

/**
 * Build a Pi `spawnHook` that merges managed env vars into every bash
 * subprocess. Matches Claude/Codex precedence: caller-provided env keys
 * override Pi's inherited baseline. Returns undefined when `env` is empty
 * so bash spawns without an unnecessary hook allocation.
 */
function buildBashSpawnHook(env: Record<string, string> | undefined): BashSpawnHook | undefined {
  if (!env || Object.keys(env).length === 0) return undefined;
  return (context: BashSpawnContext): BashSpawnContext => ({
    ...context,
    env: { ...context.env, ...env },
  });
}

/** Map a normalized (lowercase) Pi tool name to its Pi-internal factory. */
function buildPiTool(name: PiToolName, cwd: string, spawnHook: BashSpawnHook | undefined): PiTool {
  switch (name) {
    case 'read':
      return createReadTool(cwd);
    case 'bash':
      return spawnHook ? createBashTool(cwd, { spawnHook }) : createBashTool(cwd);
    case 'edit':
      return createEditTool(cwd);
    case 'write':
      return createWriteTool(cwd);
    case 'grep':
      return createGrepTool(cwd);
    case 'find':
      return createFindTool(cwd);
    case 'ls':
      return createLsTool(cwd);
  }
}

export interface ResolvedTools {
  /**
   * The tools array to pass to Pi, or `undefined` to leave Pi's default
   * (read/bash/edit/write) in place. An empty array means "no tools —
   * LLM-only response" which is a valid explicit setting.
   */
  tools: PiTool[] | undefined;
  /** Unknown tool names in allowed_tools / denied_tools (e.g. Claude-specific like WebFetch). */
  unknownTools: string[];
}

/** Pi's default coding-tool set (mirrors `codingTools` export: read/bash/edit/write). */
const PI_DEFAULT_TOOL_NAMES = [
  'read',
  'bash',
  'edit',
  'write',
] as const satisfies readonly PiToolName[];

/**
 * Filter Pi's built-in tool set against Archon's `allowed_tools` /
 * `denied_tools` node config, with managed env injected into any bash tool.
 *
 * Semantics:
 *   - neither allow/deny set, no env → return undefined (Pi's default tools)
 *   - neither allow/deny set, env present → return Pi's default 4 tools with
 *     an env-aware bash, so codebase env vars reach bash subprocesses
 *   - allowed_tools: [] → return [] (explicit no-tools; valid Archon idiom)
 *   - allowed_tools: [X, Y] → only X, Y (normalized to lowercase)
 *   - denied_tools subtracts from allowed_tools (or full set if allowed_tools absent)
 *   - tool names not in Pi's built-in set are silently dropped but reported
 *     via `unknownTools` so the caller can surface a warning.
 *
 * The `env` parameter is the caller's `requestOptions.env` merged with any
 * relevant defaults; when non-empty, it is injected into every bash spawn via
 * a `BashSpawnHook`, matching Claude's `options.env` and Codex's constructor
 * `env` behavior so codebase-scoped env vars reach tool subprocesses.
 */
export function resolvePiTools(
  cwd: string,
  nodeConfig?: NodeConfig,
  env?: Record<string, string>
): ResolvedTools {
  const allowed = nodeConfig?.allowed_tools;
  const denied = nodeConfig?.denied_tools;
  const spawnHook = buildBashSpawnHook(env);

  if (allowed === undefined && denied === undefined) {
    // No restrictions. Match Pi's default tool set unless env injection forces
    // a custom bash tool (Pi's default bashTool is pre-constructed with no
    // spawnHook and there's no way to retrofit env onto it).
    if (!spawnHook) return { tools: undefined, unknownTools: [] };
    return {
      tools: PI_DEFAULT_TOOL_NAMES.map(n => buildPiTool(n, cwd, spawnHook)),
      unknownTools: [],
    };
  }

  const knownSet = new Set<PiToolName>(PI_TOOL_NAMES);
  const unknownTools: string[] = [];

  function classify(name: string): PiToolName | undefined {
    const lower = name.toLowerCase();
    if (knownSet.has(lower as PiToolName)) return lower as PiToolName;
    unknownTools.push(name);
    return undefined;
  }

  let selected: PiToolName[];
  if (allowed !== undefined) {
    selected = allowed.map(classify).filter((n): n is PiToolName => n !== undefined);
  } else {
    selected = [...PI_TOOL_NAMES];
  }

  if (denied !== undefined) {
    const deniedSet = new Set<PiToolName>();
    for (const raw of denied) {
      const norm = classify(raw);
      if (norm) deniedSet.add(norm);
    }
    selected = selected.filter(n => !deniedSet.has(n));
  }

  // Dedupe by name (handles allowed_tools: ['read', 'read'])
  const seen = new Set<PiToolName>();
  const unique = selected.filter(n => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  return {
    tools: unique.map(n => buildPiTool(n, cwd, spawnHook)),
    unknownTools,
  };
}

// ─── Skills ────────────────────────────────────────────────────────────────

// Skill resolution is shared across providers. Re-export `resolvePiSkills` as
// an alias of the shared `resolveSkillDirectories` so existing Pi callers and
// tests keep their import path stable.
export { resolveSkillDirectories as resolvePiSkills } from '../../shared/skills';
export type { ResolvedSkills } from '../../shared/skills';
