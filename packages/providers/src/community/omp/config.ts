export interface OmpRetrySettingsDefaults {
  enabled?: boolean;
  maxRetries?: number;
  fallbackChains?: Record<string, string[]>;
  fallbackRevertPolicy?: 'cooldown-expiry' | 'never';
}

export interface OmpCompactionSettingsDefaults {
  enabled?: boolean;
  strategy?: 'context-full' | 'handoff' | 'shake' | 'snapcompact' | 'off';
  supersedeReads?: boolean;
  dropUseless?: boolean;
  thresholdPercent?: number;
  thresholdTokens?: number;
}

export interface OmpModelSettingsDefaults {
  loopGuard?: {
    enabled?: boolean;
    checkAssistantContent?: boolean;
  };
}

export interface OmpContextPromotionSettingsDefaults {
  enabled?: boolean;
}

export interface OmpSnapcompactSettingsDefaults {
  systemPrompt?: 'none' | 'agents-md' | 'all';
  toolResults?: boolean;
  shape?: string;
}

export interface OmpToolsSettingsDefaults {
  approvalMode?: 'always-ask' | 'write' | 'yolo';
  maxTimeout?: number;
}

export interface OmpProvidersSettingsDefaults {
  webSearch?:
    | 'auto'
    | 'perplexity'
    | 'gemini'
    | 'anthropic'
    | 'codex'
    | 'zai'
    | 'exa'
    | 'jina'
    | 'kagi'
    | 'tavily'
    | 'brave'
    | 'kimi'
    | 'parallel'
    | 'synthetic'
    | 'searxng';
  webSearchExclude?: (
    | 'perplexity'
    | 'gemini'
    | 'anthropic'
    | 'codex'
    | 'zai'
    | 'exa'
    | 'jina'
    | 'kagi'
    | 'tavily'
    | 'brave'
    | 'kimi'
    | 'parallel'
    | 'synthetic'
    | 'searxng'
  )[];
  image?: 'auto' | 'openai' | 'antigravity' | 'xai' | 'gemini' | 'openrouter';
}

export interface OmpTaskSettingsDefaults {
  maxConcurrency?: number;
  maxRuntimeMs?: number;
}

export interface OmpMemorySettingsDefaults {
  backend?: 'off' | 'local' | 'hindsight' | 'mnemopi';
}

export interface OmpMnemopiSettingsDefaults {
  autoRecall?: boolean;
  autoRetain?: boolean;
  polyphonicRecall?: boolean;
  enhancedRecall?: boolean;
  noEmbeddings?: boolean;
  debug?: boolean;
}

export interface OmpHindsightSettingsDefaults {
  autoRecall?: boolean;
  autoRetain?: boolean;
  debug?: boolean;
  mentalModelsEnabled?: boolean;
  mentalModelAutoSeed?: boolean;
}

export interface OmpSettingsDefaults {
  retry?: OmpRetrySettingsDefaults;
  compaction?: OmpCompactionSettingsDefaults;
  snapcompact?: OmpSnapcompactSettingsDefaults;
  contextPromotion?: OmpContextPromotionSettingsDefaults;
  model?: OmpModelSettingsDefaults;
  tools?: OmpToolsSettingsDefaults;
  providers?: OmpProvidersSettingsDefaults;
  task?: OmpTaskSettingsDefaults;
  memory?: OmpMemorySettingsDefaults;
  mnemopi?: OmpMnemopiSettingsDefaults;
  hindsight?: OmpHindsightSettingsDefaults;
  modelRoles?: Record<string, string>;
  enabledModels?: string[];
  modelProviderOrder?: string[];
  disabledProviders?: string[];
  disabledExtensions?: string[];
}

/**
 * Community provider defaults for Oh My Pi (@oh-my-pi/pi-coding-agent).
 * Kept inside the OMP provider directory so community-provider config shape
 * does not expand the shared provider contract.
 */
export interface OmpProviderDefaults {
  [key: string]: unknown;
  /** Default model ref in '<omp-provider-id>/<model-id>' format. */
  model?: string;
  /** Advanced override for OMP auth/session/settings root. */
  agentDir?: string;
  /** Enable OMP's own MCP discovery; separate from node-scoped Archon workflow `mcp:` translation. */
  enableMCP?: boolean;
  /** Enable OMP LSP-backed tools and warmup. */
  enableLsp?: boolean;
  /** Disable OMP extension discovery while still allowing explicit paths when set true. */
  disableExtensionDiscovery?: boolean;
  /** Additional OMP extension entrypoints/directories to load. */
  additionalExtensionPaths?: string[];
  /** OMP SDK spawn allowlist expression. Passed through unchanged. */
  spawns?: string;
  /** Explicit OMP built-in tool names to expose. */
  toolNames?: string[];
  /** Bind OMP UI context for interactive tools/extensions; defaults to true. */
  interactive?: boolean;
  /** OMP extension flag values applied before the first prompt. */
  extensionFlags?: Record<string, boolean | string>;
  /**
   * Config-level environment for in-process OMP extensions.
   * Existing process.env values are not overridden; shell env wins.
   */
  env?: Record<string, string>;
  /** In-memory OMP Settings.isolated overrides owned by this provider. */
  settings?: OmpSettingsDefaults;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const OMP_APPROVAL_MODES = ['always-ask', 'write', 'yolo'] as const;
const OMP_WEB_SEARCH_PROVIDERS = [
  'perplexity',
  'gemini',
  'anthropic',
  'codex',
  'zai',
  'exa',
  'jina',
  'kagi',
  'tavily',
  'brave',
  'kimi',
  'parallel',
  'synthetic',
  'searxng',
] as const;
const OMP_WEB_SEARCH_PREFERENCES = ['auto', ...OMP_WEB_SEARCH_PROVIDERS] as const;
const OMP_IMAGE_PROVIDERS = [
  'auto',
  'openai',
  'antigravity',
  'xai',
  'gemini',
  'openrouter',
] as const;
const OMP_MEMORY_BACKENDS = ['off', 'local', 'hindsight', 'mnemopi'] as const;

function enumSetting<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function allowedStringArray<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((item): item is T => enumSetting(item, allowed) !== undefined);
  return filtered.length > 0 ? filtered : undefined;
}

function stringArray(value: unknown, keepExplicitEmpty = false): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (keepExplicitEmpty && value.length === 0) return [];
  const filtered = value.filter((item): item is string => typeof item === 'string');
  return filtered.length > 0 ? filtered : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const filtered: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') filtered[key] = item;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function stringArrayRecord(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const filtered: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    const strings = stringArray(item, true);
    if (strings !== undefined) filtered[key] = strings;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function booleanOrStringRecord(value: unknown): Record<string, boolean | string> | undefined {
  if (!isRecord(value)) return undefined;
  const filtered: Record<string, boolean | string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'boolean' || typeof item === 'string') filtered[key] = item;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function retrySettings(value: unknown): OmpSettingsDefaults['retry'] | undefined {
  if (!isRecord(value)) return undefined;

  const retry: NonNullable<OmpSettingsDefaults['retry']> = {};
  if (typeof value.enabled === 'boolean') retry.enabled = value.enabled;
  if (
    typeof value.maxRetries === 'number' &&
    Number.isInteger(value.maxRetries) &&
    value.maxRetries >= 0
  ) {
    retry.maxRetries = value.maxRetries;
  }
  const fallbackChains = stringArrayRecord(value.fallbackChains);
  if (fallbackChains !== undefined) retry.fallbackChains = fallbackChains;
  if (value.fallbackRevertPolicy === 'cooldown-expiry' || value.fallbackRevertPolicy === 'never') {
    retry.fallbackRevertPolicy = value.fallbackRevertPolicy;
  }

  return Object.keys(retry).length > 0 ? retry : undefined;
}

function enabledSetting(value: unknown): { enabled?: boolean } | undefined {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return undefined;
  return { enabled: value.enabled };
}

function compactionSettings(value: unknown): OmpSettingsDefaults['compaction'] | undefined {
  if (!isRecord(value)) return undefined;

  const compaction: NonNullable<OmpSettingsDefaults['compaction']> = {};
  if (typeof value.enabled === 'boolean') compaction.enabled = value.enabled;
  if (
    value.strategy === 'context-full' ||
    value.strategy === 'handoff' ||
    value.strategy === 'shake' ||
    value.strategy === 'snapcompact' ||
    value.strategy === 'off'
  ) {
    compaction.strategy = value.strategy;
  }
  if (typeof value.supersedeReads === 'boolean') compaction.supersedeReads = value.supersedeReads;
  if (typeof value.dropUseless === 'boolean') compaction.dropUseless = value.dropUseless;
  if (
    typeof value.thresholdPercent === 'number' &&
    Number.isInteger(value.thresholdPercent) &&
    (value.thresholdPercent === -1 ||
      (value.thresholdPercent >= 0 && value.thresholdPercent <= 100))
  ) {
    compaction.thresholdPercent = value.thresholdPercent;
  }
  if (
    typeof value.thresholdTokens === 'number' &&
    Number.isInteger(value.thresholdTokens) &&
    (value.thresholdTokens === -1 || value.thresholdTokens > 0)
  ) {
    compaction.thresholdTokens = value.thresholdTokens;
  }

  return Object.keys(compaction).length > 0 ? compaction : undefined;
}

function snapcompactSettings(value: unknown): OmpSettingsDefaults['snapcompact'] | undefined {
  if (!isRecord(value)) return undefined;

  const snapcompact: NonNullable<OmpSettingsDefaults['snapcompact']> = {};
  if (
    value.systemPrompt === 'none' ||
    value.systemPrompt === 'agents-md' ||
    value.systemPrompt === 'all'
  ) {
    snapcompact.systemPrompt = value.systemPrompt;
  }
  if (typeof value.toolResults === 'boolean') snapcompact.toolResults = value.toolResults;
  if (typeof value.shape === 'string' && value.shape.trim().length > 0) {
    snapcompact.shape = value.shape;
  }

  return Object.keys(snapcompact).length > 0 ? snapcompact : undefined;
}

function modelSettings(value: unknown): OmpSettingsDefaults['model'] | undefined {
  if (!isRecord(value)) return undefined;

  if (!isRecord(value.loopGuard)) return undefined;
  const loopGuard: NonNullable<NonNullable<OmpSettingsDefaults['model']>['loopGuard']> = {};
  if (typeof value.loopGuard.enabled === 'boolean') loopGuard.enabled = value.loopGuard.enabled;
  if (typeof value.loopGuard.checkAssistantContent === 'boolean') {
    loopGuard.checkAssistantContent = value.loopGuard.checkAssistantContent;
  }

  return Object.keys(loopGuard).length > 0 ? { loopGuard } : undefined;
}

function toolsSettings(value: unknown): OmpSettingsDefaults['tools'] | undefined {
  if (!isRecord(value)) return undefined;

  const tools: NonNullable<OmpSettingsDefaults['tools']> = {};
  const approvalMode = enumSetting(value.approvalMode, OMP_APPROVAL_MODES);
  if (approvalMode !== undefined) tools.approvalMode = approvalMode;
  const maxTimeout = nonNegativeInteger(value.maxTimeout);
  if (maxTimeout !== undefined) tools.maxTimeout = maxTimeout;

  return Object.keys(tools).length > 0 ? tools : undefined;
}

function providersSettings(value: unknown): OmpSettingsDefaults['providers'] | undefined {
  if (!isRecord(value)) return undefined;

  const providers: NonNullable<OmpSettingsDefaults['providers']> = {};
  const webSearch = enumSetting(value.webSearch, OMP_WEB_SEARCH_PREFERENCES);
  if (webSearch !== undefined) providers.webSearch = webSearch;
  const webSearchExclude = allowedStringArray(value.webSearchExclude, OMP_WEB_SEARCH_PROVIDERS);
  if (webSearchExclude !== undefined) providers.webSearchExclude = webSearchExclude;
  const image = enumSetting(value.image, OMP_IMAGE_PROVIDERS);
  if (image !== undefined) providers.image = image;

  return Object.keys(providers).length > 0 ? providers : undefined;
}

function taskSettings(value: unknown): OmpSettingsDefaults['task'] | undefined {
  if (!isRecord(value)) return undefined;

  const task: NonNullable<OmpSettingsDefaults['task']> = {};
  const maxConcurrency = nonNegativeInteger(value.maxConcurrency);
  if (maxConcurrency !== undefined) task.maxConcurrency = maxConcurrency;
  const maxRuntimeMs = nonNegativeInteger(value.maxRuntimeMs);
  if (maxRuntimeMs !== undefined) task.maxRuntimeMs = maxRuntimeMs;

  return Object.keys(task).length > 0 ? task : undefined;
}

function memorySettings(value: unknown): OmpSettingsDefaults['memory'] | undefined {
  if (!isRecord(value)) return undefined;
  const backend = enumSetting(value.backend, OMP_MEMORY_BACKENDS);
  return backend !== undefined ? { backend } : undefined;
}

function booleanSettings<T extends object>(
  value: unknown,
  keys: readonly (keyof T & string)[]
): T | undefined {
  if (!isRecord(value)) return undefined;

  const settings: Record<string, boolean> = {};
  for (const key of keys) {
    if (typeof value[key] === 'boolean') settings[key] = value[key];
  }

  return Object.keys(settings).length > 0 ? (settings as T) : undefined;
}

function assignDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
): void {
  if (value !== undefined) target[key] = value;
}

function settingsObject(value: unknown): OmpSettingsDefaults | undefined {
  if (!isRecord(value)) return undefined;

  const settings: OmpSettingsDefaults = {};
  assignDefined(settings, 'retry', retrySettings(value.retry));
  assignDefined(settings, 'compaction', compactionSettings(value.compaction));
  assignDefined(settings, 'snapcompact', snapcompactSettings(value.snapcompact));
  assignDefined(settings, 'contextPromotion', enabledSetting(value.contextPromotion));
  assignDefined(settings, 'model', modelSettings(value.model));
  assignDefined(settings, 'tools', toolsSettings(value.tools));
  assignDefined(settings, 'providers', providersSettings(value.providers));
  assignDefined(settings, 'task', taskSettings(value.task));
  assignDefined(settings, 'memory', memorySettings(value.memory));
  assignDefined(
    settings,
    'mnemopi',
    booleanSettings(value.mnemopi, [
      'autoRecall',
      'autoRetain',
      'polyphonicRecall',
      'enhancedRecall',
      'noEmbeddings',
      'debug',
    ] satisfies (keyof OmpMnemopiSettingsDefaults)[])
  );
  assignDefined(
    settings,
    'hindsight',
    booleanSettings(value.hindsight, [
      'autoRecall',
      'autoRetain',
      'debug',
      'mentalModelsEnabled',
      'mentalModelAutoSeed',
    ] satisfies (keyof OmpHindsightSettingsDefaults)[])
  );
  assignDefined(settings, 'modelRoles', stringRecord(value.modelRoles));
  for (const [sourceKey, targetKey] of [
    ['enabledModels', 'enabledModels'],
    ['modelProviderOrder', 'modelProviderOrder'],
    ['disabledProviders', 'disabledProviders'],
    ['disabledExtensions', 'disabledExtensions'],
  ] as const) {
    assignDefined(settings, targetKey, stringArray(value[sourceKey]));
  }

  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Parse raw YAML-derived config into typed Oh My Pi defaults.
 * Defensive: invalid fields are dropped silently, matching built-in provider
 * config parsers so broken optional fields cannot prevent provider discovery.
 */
export function parseOmpConfig(raw: Record<string, unknown>): OmpProviderDefaults {
  const result: OmpProviderDefaults = {};

  for (const [sourceKey, targetKey] of [
    ['model', 'model'],
    ['agentDir', 'agentDir'],
  ] as const) {
    const value = raw[sourceKey];
    if (typeof value === 'string') result[targetKey] = value;
  }

  for (const [sourceKey, targetKey] of [
    ['enableMCP', 'enableMCP'],
    ['enableLsp', 'enableLsp'],
    ['disableExtensionDiscovery', 'disableExtensionDiscovery'],
    ['interactive', 'interactive'],
  ] as const) {
    const value = raw[sourceKey];
    if (typeof value === 'boolean') result[targetKey] = value;
  }

  const spawns = raw.spawns;
  if (typeof spawns === 'string' && spawns.trim().length > 0) result.spawns = spawns;

  assignDefined(result, 'additionalExtensionPaths', stringArray(raw.additionalExtensionPaths));
  assignDefined(result, 'toolNames', stringArray(raw.toolNames, true));
  assignDefined(result, 'extensionFlags', booleanOrStringRecord(raw.extensionFlags));
  assignDefined(result, 'env', stringRecord(raw.env));
  assignDefined(result, 'settings', settingsObject(raw.settings));

  return result;
}
