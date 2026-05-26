import type { OmpCodingAgentSdk } from './sdk-loader';

import type { NodeConfig } from '../../types';
import type { OmpProviderDefaults } from './config';

export type OmpThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type OmpSkill = Awaited<ReturnType<OmpCodingAgentSdk['discoverSkills']>>['skills'][number];

const OMP_NATIVE_LEVELS: ReadonlySet<OmpThinkingLevel> = new Set<OmpThinkingLevel>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

const ARCHON_FALLBACK_ROLE = 'archon';

export const DEFAULT_OMP_TOOL_NAMES = [
  'ask',
  'bash',
  'eval',
  'calc',
  'ssh',
  'edit',
  'find',
  'search',
  'ast_grep',
  'ast_edit',
  'lsp',
  'read',
  'browser',
  'task',
  'job',
  'todo_write',
  'web_search',
  'write',
  'render_mermaid',
  'inspect_image',
] as const;

const KNOWN_OMP_TOOL_NAMES = new Set<string>([
  ...DEFAULT_OMP_TOOL_NAMES,
  // Extra OMP tools present in SDK registries or loaded conditionally outside
  // the default tool set.
  'debug',
  'github',
  'checkpoint',
  'rewind',
  'recipe',
  'irc',
  'yield',
  'resolve',
  'exit_plan_mode',
  'search_tool_bm25',
  'retain',
  'recall',
  'reflect',
  'report_finding',
  'report_tool_issue',
  'generate_image',
]);

const LEGACY_OMP_TOOL_ALIASES: Record<string, string> = {
  python: 'eval',
  grep: 'search',
  poll: 'job',
  fetch: 'read',
};

// Mirrors @oh-my-pi/pi-ai@15.3.2 stream.ts serviceProviderMap for providers
// whose credentials can be represented as environment variables.
const OMP_PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
  'alibaba-coding-plan': ['ALIBABA_CODING_PLAN_API_KEY'],
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  brave: ['BRAVE_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_AI_GATEWAY_API_KEY'],
  cursor: ['CURSOR_ACCESS_TOKEN'],
  deepseek: ['DEEPSEEK_API_KEY'],
  exa: ['EXA_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  firepass: ['FIREPASS_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  'gitlab-duo': ['GITLAB_TOKEN'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  groq: ['GROQ_API_KEY'],
  huggingface: ['HUGGINGFACE_HUB_TOKEN', 'HF_TOKEN'],
  jina: ['JINA_API_KEY'],
  kagi: ['KAGI_API_KEY'],
  kilo: ['KILO_API_KEY'],
  'llama.cpp': ['LLAMA_CPP_API_KEY'],
  litellm: ['LITELLM_API_KEY'],
  'lm-studio': ['LM_STUDIO_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-code': ['MINIMAX_CODE_API_KEY'],
  'minimax-code-cn': ['MINIMAX_CODE_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  nanogpt: ['NANO_GPT_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  ollama: ['OLLAMA_API_KEY'],
  'ollama-cloud': ['OLLAMA_CLOUD_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'opencode-zen': ['OPENCODE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'openai-codex': ['OPENAI_CODEX_OAUTH_TOKEN'],
  openrouter: ['OPENROUTER_API_KEY'],
  parallel: ['PARALLEL_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  qianfan: ['QIANFAN_API_KEY'],
  'qwen-portal': ['QWEN_OAUTH_TOKEN', 'QWEN_PORTAL_API_KEY'],
  synthetic: ['SYNTHETIC_API_KEY'],
  tavily: ['TAVILY_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  venice: ['VENICE_API_KEY'],
  vllm: ['VLLM_API_KEY'],
  xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  zai: ['ZAI_API_KEY'],
  zenmux: ['ZENMUX_API_KEY'],
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
  const normalized = LEGACY_OMP_TOOL_ALIASES[lower] ?? lower;
  if (normalized.startsWith('mcp__')) return normalized;
  if (KNOWN_OMP_TOOL_NAMES.has(normalized)) return normalized;
  unknownTools.push(name);
  return undefined;
}

/** Resolve Archon allowed/denied tools into OMP's tool namespace. */
export function resolveOmpToolNames(
  nodeConfig?: NodeConfig,
  defaults?: Pick<OmpProviderDefaults, 'toolNames'>
): ResolvedOmpTools {
  const base = defaults?.toolNames !== undefined ? defaults.toolNames : [...DEFAULT_OMP_TOOL_NAMES];
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
  skills: OmpSkill[];
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
  const byName = new Map<string, OmpSkill>();
  for (const skill of skills) {
    byName.set(skill.name, skill);
  }

  const resolved: OmpSkill[] = [];
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

export interface OmpFallbackModelOverride {
  primaryModel: string;
  fallbackModel: string;
}

function assertNoReservedFallbackRole(
  modelRoles: Record<string, string> | undefined,
  fallbackChains: Record<string, string[]> | undefined
): void {
  if (modelRoles?.[ARCHON_FALLBACK_ROLE] !== undefined) {
    throw new Error(
      `Oh My Pi fallbackModel cannot be combined with assistants.omp.settings.modelRoles.${ARCHON_FALLBACK_ROLE}; the '${ARCHON_FALLBACK_ROLE}' role is reserved by Archon.`
    );
  }
  if (fallbackChains?.[ARCHON_FALLBACK_ROLE] !== undefined) {
    throw new Error(
      `Oh My Pi fallbackModel cannot be combined with assistants.omp.settings.retry.fallbackChains.${ARCHON_FALLBACK_ROLE}; the '${ARCHON_FALLBACK_ROLE}' fallback chain is reserved by Archon.`
    );
  }
}

export function buildOmpSettingsOverrides(
  config: OmpProviderDefaults,
  fallback?: OmpFallbackModelOverride
): Record<string, unknown> {
  const settings = config.settings;
  if (!settings && !fallback) return {};

  const retry = settings?.retry;
  const modelRoles = settings?.modelRoles !== undefined ? { ...settings.modelRoles } : undefined;
  const fallbackChains =
    retry?.fallbackChains !== undefined ? { ...retry.fallbackChains } : undefined;

  if (fallback !== undefined) assertNoReservedFallbackRole(modelRoles, fallbackChains);

  const effectiveModelRoles =
    fallback !== undefined
      ? { [ARCHON_FALLBACK_ROLE]: fallback.primaryModel, ...modelRoles }
      : modelRoles;
  const effectiveFallbackChains =
    fallback !== undefined
      ? { [ARCHON_FALLBACK_ROLE]: [fallback.fallbackModel], ...fallbackChains }
      : fallbackChains;

  const overrides: Record<string, unknown> = {};
  for (const [key, value] of [
    ['retry.enabled', retry?.enabled],
    ['retry.maxRetries', retry?.maxRetries],
    ['retry.fallbackChains', effectiveFallbackChains],
    ['retry.fallbackRevertPolicy', retry?.fallbackRevertPolicy],
    ['compaction.enabled', settings?.compaction?.enabled],
    ['contextPromotion.enabled', settings?.contextPromotion?.enabled],
    ['modelRoles', effectiveModelRoles],
    ['enabledModels', settings?.enabledModels],
    ['modelProviderOrder', settings?.modelProviderOrder],
    ['disabledProviders', settings?.disabledProviders],
    ['disabledExtensions', settings?.disabledExtensions],
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

function envFlagEnabled(envName: string, env: Record<string, string> | undefined): boolean {
  const value = env?.[envName] ?? process.env[envName];
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function getRuntimeAuthOverride(
  provider: string,
  env: Record<string, string> | undefined
): string | undefined {
  if (provider === 'anthropic' && envFlagEnabled('CLAUDE_CODE_USE_FOUNDRY', env)) {
    return findEnvValue(['ANTHROPIC_FOUNDRY_API_KEY', ...OMP_PROVIDER_ENV_VARS.anthropic], env);
  }

  const envNames = OMP_PROVIDER_ENV_VARS[provider];
  if (!envNames) return undefined;
  return findEnvValue(envNames, env);
}
