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
  'ssh',
  'render_mermaid',
  'search_tool_bm25',
]);

const OMP_PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  huggingface: ['HUGGINGFACE_HUB_TOKEN', 'HF_TOKEN'],
  deepseek: ['DEEPSEEK_API_KEY'],
};

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

function unknownThinkingWarning(thinking: unknown, effort: unknown): string | undefined {
  if (thinking !== undefined && thinking !== null && typeof thinking === 'object') {
    return 'Oh My Pi ignored `thinking` (object form is Claude-specific). Use `effort: low|medium|high|max` in YAML.';
  }

  const offender =
    typeof thinking === 'string' ? thinking : typeof effort === 'string' ? effort : undefined;
  if (offender === undefined) return undefined;
  return `Oh My Pi ignored unknown thinking level '${offender}'. Valid: minimal, low, medium, high, xhigh, max, off.`;
}

export function resolveOmpThinkingLevel(nodeConfig?: NodeConfig): ResolvedThinkingLevel {
  if (!nodeConfig) return { level: undefined };

  const { thinking, effort } = nodeConfig;
  if (thinking === 'off' || effort === 'off') return { level: undefined };

  const level = normalizeToThinkingLevel(thinking) ?? normalizeToThinkingLevel(effort);
  if (level) return { level };

  return { level: undefined, warning: unknownThinkingWarning(thinking, effort) };
}

export interface ResolvedOmpTools {
  toolNames: string[];
  unknownTools: string[];
}

function normalizeToolName(name: string, unknownTools: string[]): string | undefined {
  const lower = name.toLowerCase();
  if (KNOWN_OMP_TOOL_NAMES.has(lower)) return lower;
  unknownTools.push(name);
  return undefined;
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

  const normalize = (name: string): string | undefined => normalizeToolName(name, unknownTools);
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

function assignOverride(overrides: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) overrides[key] = value;
}

export function buildOmpSettingsOverrides(config: OmpProviderDefaults): Record<string, unknown> {
  const settings = config.settings;
  if (!settings) return {};

  const overrides: Record<string, unknown> = {};
  for (const [key, value] of [
    ['retry.enabled', settings.retry?.enabled],
    ['retry.maxRetries', settings.retry?.maxRetries],
    ['compaction.enabled', settings.compaction?.enabled],
    ['contextPromotion.enabled', settings.contextPromotion?.enabled],
    ['modelRoles', settings.modelRoles],
    ['enabledModels', settings.enabledModels],
    ['modelProviderOrder', settings.modelProviderOrder],
    ['disabledProviders', settings.disabledProviders],
    ['disabledExtensions', settings.disabledExtensions],
  ] as const) {
    assignOverride(overrides, key, value);
  }

  return overrides;
}

export function applyConfigEnv(
  env: Record<string, string> | undefined,
  targetEnv: Record<string, string | undefined> = process.env
): string[] {
  if (!env) return [];

  const applied: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
      applied.push(key);
    }
  }

  return applied;
}

export function restoreConfigEnv(
  appliedKeys: readonly string[],
  targetEnv: Record<string, string | undefined> = process.env
): void {
  for (const key of appliedKeys) {
    Reflect.deleteProperty(targetEnv, key);
  }
}

function findEnvValue(
  envNames: readonly string[],
  env: Record<string, string> | undefined
): string | undefined {
  for (const envName of envNames) {
    const value = env?.[envName];
    if (value) return value;
  }

  for (const envName of envNames) {
    const value = process.env[envName];
    if (value) return value;
  }

  return undefined;
}

export function getRuntimeAuthOverride(
  provider: string,
  env: Record<string, string> | undefined
): string | undefined {
  const envNames = OMP_PROVIDER_ENV_VARS[provider];
  if (!envNames) return undefined;
  return findEnvValue(envNames, env);
}
