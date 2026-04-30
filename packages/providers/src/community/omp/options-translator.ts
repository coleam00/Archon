import type { OmpCodingAgentSdk } from './sdk-loader';

import type { NodeConfig } from '../../types';
import type { OmpProviderDefaults } from './config';

export type OmpThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const OMP_NATIVE_LEVELS: ReadonlySet<OmpThinkingLevel> = new Set<OmpThinkingLevel>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export const DEFAULT_OMP_TOOL_NAMES = [
  'read',
  'search',
  'find',
  'bash',
  'edit',
  'write',
  'lsp',
  'notebook',
  'browser',
  'debug',
  'task',
  'irc',
  'todo_write',
  'web_search',
  'ask',
  'ast_grep',
  'ast_edit',
  'yield',
  'resolve',
] as const;

const KNOWN_OMP_TOOL_NAMES = new Set<string>([
  ...DEFAULT_OMP_TOOL_NAMES,
  'github',
  'python',
  'inspect_image',
  'checkpoint',
  'rewind',
  'calc',
  'job',
  'exit_plan_mode',
]);

export interface ResolvedThinkingLevel {
  level: OmpThinkingLevel | undefined;
  warning?: string;
}

function normalizeToThinkingLevel(value: unknown): OmpThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'max') return 'xhigh';
  if (OMP_NATIVE_LEVELS.has(value as OmpThinkingLevel)) return value as OmpThinkingLevel;
  return undefined;
}

export function resolveOmpThinkingLevel(nodeConfig?: NodeConfig): ResolvedThinkingLevel {
  if (!nodeConfig) return { level: undefined };
  const { thinking, effort } = nodeConfig;
  if (thinking === 'off' || effort === 'off') return { level: undefined };

  const thinkingLevel = normalizeToThinkingLevel(thinking);
  if (thinkingLevel) return { level: thinkingLevel };

  const effortLevel = normalizeToThinkingLevel(effort);
  if (effortLevel) return { level: effortLevel };

  if (thinking !== undefined && thinking !== null && typeof thinking === 'object') {
    return {
      level: undefined,
      warning:
        'Oh My Pi ignored `thinking` (object form is Claude-specific). Use `effort: low|medium|high|max` in YAML.',
    };
  }

  if (typeof thinking === 'string' || typeof effort === 'string') {
    const offender = typeof thinking === 'string' ? thinking : effort;
    return {
      level: undefined,
      warning: `Oh My Pi ignored unknown thinking level '${String(offender)}'. Valid: minimal, low, medium, high, xhigh, max, off.`,
    };
  }

  return { level: undefined };
}

export interface ResolvedOmpTools {
  toolNames: string[];
  unknownTools: string[];
}

/** Resolve Archon allowed/denied tools into OMP's tool namespace. */
export function resolveOmpToolNames(
  nodeConfig?: NodeConfig,
  defaults?: Pick<OmpProviderDefaults, 'toolNames'>
): ResolvedOmpTools {
  const base =
    defaults?.toolNames && defaults.toolNames.length > 0
      ? defaults.toolNames
      : [...DEFAULT_OMP_TOOL_NAMES];
  const unknownTools: string[] = [];

  function normalize(name: string): string | undefined {
    const lower = name.toLowerCase();
    if (KNOWN_OMP_TOOL_NAMES.has(lower)) return lower;
    unknownTools.push(name);
    return undefined;
  }

  let selected = nodeConfig?.allowed_tools
    ? nodeConfig.allowed_tools.map(normalize).filter((name): name is string => name !== undefined)
    : base.map(normalize).filter((name): name is string => name !== undefined);

  if (nodeConfig?.denied_tools) {
    const denied = new Set(
      nodeConfig.denied_tools.map(normalize).filter((name): name is string => name !== undefined)
    );
    selected = selected.filter(name => !denied.has(name));
  }

  return { toolNames: [...new Set(selected)], unknownTools: [...new Set(unknownTools)] };
}

export interface ResolvedOmpSkills {
  skills: unknown[];
  missing: string[];
}

export async function resolveOmpSkills(
  sdk: Pick<OmpCodingAgentSdk, 'discoverSkills'>,
  cwd: string,
  skillNames: string[] | undefined,
  agentDir?: string
): Promise<ResolvedOmpSkills> {
  if (!skillNames || skillNames.length === 0) return { skills: [], missing: [] };

  const { skills } = await sdk.discoverSkills(cwd, agentDir);
  const byName = new Map<string, unknown>();
  for (const skill of skills) {
    const name = (skill as { name?: unknown }).name;
    if (typeof name === 'string') byName.set(name, skill);
  }
  const resolved: unknown[] = [];
  const missing: string[] = [];

  for (const rawName of [...new Set(skillNames)]) {
    const skill = byName.get(rawName);
    if (skill) resolved.push(skill);
    else missing.push(rawName);
  }

  return { skills: resolved, missing };
}

export const OMP_PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export function getRuntimeAuthOverride(
  provider: string,
  env: Record<string, string> | undefined
): string | undefined {
  const envName = OMP_PROVIDER_ENV_VARS[provider];
  return envName ? (env?.[envName] ?? process.env[envName]) : undefined;
}
