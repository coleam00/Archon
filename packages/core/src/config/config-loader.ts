/**
 * Configuration loader for Archon YAML config files
 *
 * Loading order (later overrides earlier):
 * 1. Defaults
 * 2. Global config (~/.archon/config.yaml)
 * 3. Repository config (.archon/config.yaml)
 * 4. Environment variables
 */

import { readFile as fsReadFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import {
  getArchonConfigPath,
  getArchonWorkspacesPath,
  getArchonWorktreesPath,
} from '@archon/paths';

// Wrapper functions for file I/O - allows mocking without polluting fs/promises globally
export async function readConfigFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf-8');
}

export async function writeConfigFile(
  path: string,
  content: string,
  options?: { flag?: string }
): Promise<void> {
  await writeFile(path, content, { encoding: 'utf-8', ...options });
}
import type {
  GlobalConfig,
  RepoConfig,
  MergedConfig,
  SafeConfig,
  AssistantDefaults,
  AssistantDefaultsConfig,
  RawAliasesConfig,
  RawTiersConfig,
} from './config-types';
import { workflowContinuationConfigSchema } from './config-types';
import { createLogger } from '@archon/paths';
import {
  isRegisteredProvider,
  getRegisteredProviders,
  getRegistration,
  InvalidProviderRunConfigError,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { buildAiProfile, TIER_NAMES } from '@archon/workflows/model-validation';
import type { RawAliasEntry, TierName } from '@archon/workflows/model-validation';
import {
  rawAliasesConfigSchema,
  rawTiersConfigSchema,
} from '@archon/workflows/schemas/model-binding';

/**
 * A per-key patch for the `tiers:` config. Unlike `RawTiersConfig`, a tier value
 * may be `null` to explicitly UNSET it (RawTiersConfig can't express removal).
 * Consumed by `updateGlobalConfig({ tiers })`.
 */
export type TiersPatch = Partial<Record<TierName, RawAliasEntry | null>>;

/**
 * A per-key patch for the `aliases:` config — `null` explicitly UNSETS an
 * alias. Consumed by `updateGlobalConfig({ aliases })`.
 */
export type AliasesPatch = Record<string, RawAliasEntry | null>;

/**
 * Populate the provider registry. Idempotent, and called from every config
 * entrypoint because each one validates `assistants.*` against the registry —
 * a loader reached directly (not through `loadConfig`) would otherwise see an
 * empty registry and skip every provider.
 */
function ensureProvidersRegistered(): void {
  registerBuiltinProviders();
  registerCommunityProviders();
}

/**
 * Pure read of registered provider IDs. Registration is guaranteed by
 * `ensureProvidersRegistered()` at each config entrypoint, so this helper must
 * NOT trigger side-effecting registration itself — that hid the ordering
 * coupling and surprised readers.
 */
function getRegisteredProviderNames(): string[] {
  return getRegisteredProviders().map(p => p.id);
}

/**
 * Shallow-merge alias maps. Last-write-wins per key, intentional — repo wins
 * over global, global wins over (currently absent) built-in alias defaults.
 * Reserved-name validation lives in `buildAiProfile()` (model-validation.ts),
 * not here — config-loader is a data-merge layer, not a resolver.
 */
function mergeAliases(
  base: RawAliasesConfig | undefined,
  overrides: RawAliasesConfig | undefined
): RawAliasesConfig | undefined {
  if (!base && !overrides) return undefined;
  return { ...base, ...overrides };
}

/**
 * Shallow-merge tier maps. Last-write-wins per tier: repo wins over global.
 * Tier-name and entry validation lives in `buildAiProfile()`.
 */
function mergeTiers(
  base: RawTiersConfig | undefined,
  overrides: RawTiersConfig | undefined
): RawTiersConfig | undefined {
  if (!base && !overrides) return undefined;
  return { ...base, ...overrides };
}

function mergeAssistantDefaults(
  base: AssistantDefaults,
  overrides?: AssistantDefaultsConfig
): AssistantDefaults {
  // Deep-copy every provider slot present in base. No per-provider listing —
  // adding a new community provider must not require editing this function.
  const merged: AssistantDefaults = { ...base };
  for (const [providerId, providerDefaults] of Object.entries(base)) {
    if (providerDefaults && typeof providerDefaults === 'object') {
      merged[providerId] = { ...providerDefaults };
    }
  }

  if (!overrides) return merged;

  for (const [providerId, providerDefaults] of Object.entries(overrides)) {
    if (!providerDefaults || typeof providerDefaults !== 'object') continue;
    merged[providerId] = {
      ...(merged[providerId] ?? {}),
      ...providerDefaults,
    };
  }

  return merged;
}

/**
 * Per-provider allowlist of fields safe to expose to web clients.
 *
 * **Allowlist (not denylist) by design.** Any field not listed here is
 * dropped on its way out. New sensitive fields on a provider default
 * config (binary paths, credentials, absolute filesystem paths, etc.)
 * are hidden by default — you have to opt in to expose them.
 *
 * Unknown provider IDs (community providers not listed below) fall back
 * to the generic empty allowlist: the web UI sees the provider exists,
 * but none of its defaults. Providers whose defaults are safe to surface
 * register their fields here.
 */
const SAFE_ASSISTANT_FIELDS: Record<string, readonly string[]> = {
  claude: ['model'],
  codex: ['model', 'modelReasoningEffort', 'webSearchMode'],
  // community providers — list each field we're confident is safe to
  // show in the web UI. Unknown providers fall through with no fields.
  opencode: ['model', 'agent'],
  pi: ['model'],
  copilot: ['model'],
};

function toSafeAssistantDefaults(assistants: AssistantDefaults): SafeConfig['assistants'] {
  const safeAssistants: SafeConfig['assistants'] = {};

  for (const [providerId, providerDefaults] of Object.entries(assistants)) {
    if (!providerDefaults || typeof providerDefaults !== 'object') continue;

    const allowed = SAFE_ASSISTANT_FIELDS[providerId] ?? [];
    const safeDefaults: Record<string, unknown> = {};
    for (const field of allowed) {
      const value = (providerDefaults as Record<string, unknown>)[field];
      if (value !== undefined) {
        safeDefaults[field] = value;
      }
    }

    safeAssistants[providerId] = safeDefaults;
  }

  return safeAssistants;
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('config');
  return cachedLog;
}

/**
 * Parse YAML using Bun's native YAML parser
 */
function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
}

// Cache for loaded configs
let cachedGlobalConfig: GlobalConfig | null = null;

/**
 * Default config file content
 */
const DEFAULT_CONFIG_CONTENT = `# Archon Global Configuration
# See: https://github.com/coleam00/Archon/blob/main/docs/configuration.md

# Bot display name (shown in messages)
# botName: Archon

# Default AI assistant (must match a registered provider, e.g. claude, codex)
# defaultAssistant: claude

# Assistant defaults
# assistants:
#   claude:
#     model: sonnet
#   codex:
#     model: gpt-5.6-sol
#     modelReasoningEffort: medium
#     webSearchMode: disabled
#     additionalDirectories:
#       - /absolute/path/to/other/repo

# Model tier presets (usable as model: small / medium / large)
# tiers:
#   large: { provider: claude, model: opus }
#   medium: { provider: codex, model: gpt-5.6-terra, effort: high }
#   small: { provider: pi, model: minimax-m3 }

# Streaming mode per platform (stream or batch)
# streaming:
#   telegram: stream
#   discord: batch
#   slack: batch

# Concurrency settings
# concurrency:
#   maxConversations: 10
#   providers:        # optional cap on simultaneous attempts per provider; unlisted = unlimited
#     pi: 1
`;

/**
 * Log config error with specific message based on error type
 */
function logConfigError(configPath: string, error: unknown): void {
  const err = error as { code?: string; message?: string };
  const message = err.message ?? String(error);

  if (err.code === 'EACCES' || err.code === 'EPERM') {
    getLog().error({ configPath, err: error, code: err.code }, 'config_permission_denied');
  } else if (error instanceof SyntaxError || message.includes('YAML')) {
    getLog().error({ configPath, err: error }, 'config_invalid_yaml');
  } else {
    getLog().error({ configPath, err: error }, 'config_load_error');
  }
}

/**
 * Create default config file if it doesn't exist
 */
async function createDefaultConfig(configPath: string): Promise<void> {
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeConfigFile(configPath, DEFAULT_CONFIG_CONTENT, { flag: 'wx' }); // wx = fail if exists
    getLog().info({ configPath }, 'default_config_created');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') {
      // Only log if it's not a "file exists" error
      getLog().warn({ err, configPath }, 'default_config_create_failed');
    }
  }
}

/**
 * A config value the validators refuse. `updateGlobalConfig` throws it before
 * writing, which is how the settings API tells a refused value (the caller's to
 * fix) from a server fault. `summary` names the refused key without the
 * server's filesystem path, so it is safe to return to a web client; `message`
 * adds the path for logs and the CLI.
 */
export class InvalidConfigError extends Error {
  readonly summary: string;

  constructor(label: string, configPath: string, detail: string) {
    super(`${label} in '${configPath}': ${detail}`);
    this.name = 'InvalidConfigError';
    this.summary = `${label}: ${detail}`;
  }
}

function validateWorkflowContinuationConfig(parsed: unknown, configPath: string): void {
  if (typeof parsed !== 'object' || parsed === null || !('workflows' in parsed)) return;
  const config = parsed as { workflows?: unknown };
  if (config.workflows === undefined) return;
  const result = workflowContinuationConfigSchema.safeParse(config.workflows);
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new InvalidConfigError('Invalid workflows config', configPath, issues);
  }
  config.workflows = result.data;
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate `assistants.<provider>` through that provider's own strict parser —
 * the same one an explicitly selected `--config` run layer uses, so a value is
 * accepted or refused identically on both paths.
 *
 * Deliberately NOT inside the loaders' degrade-and-log `catch`: a setting the
 * provider would drop must refuse to load, because the run reports it as the
 * value the node ran at (#2582). Values are checked, not rewritten — narrowing
 * stays with the defensive parsers at the execution boundary.
 *
 * Entries for unregistered providers pass through untouched. There is no owner
 * to validate them and their current handling is to be ignored, not rejected.
 */
function validateAssistantDefaults(parsed: unknown, configPath: string): void {
  if (!isConfigRecord(parsed)) return;
  const { assistants } = parsed;
  // A key written with nothing under it parses to null, which YAML gives no way
  // to tell from the key being absent. Both mean "no defaults here".
  if (assistants === undefined || assistants === null) return;
  const label = 'Invalid assistants config';
  if (!isConfigRecord(assistants)) {
    throw new InvalidConfigError(
      label,
      configPath,
      "'assistants' must be a map of provider settings."
    );
  }
  for (const [provider, defaults] of Object.entries(assistants)) {
    if (defaults === undefined || defaults === null) continue;
    if (!isRegisteredProvider(provider)) continue;
    if (!isConfigRecord(defaults)) {
      throw new InvalidConfigError(
        label,
        configPath,
        `'assistants.${provider}' must be an object.`
      );
    }
    try {
      getRegistration(provider).parseConfig(defaults, 'install');
    } catch (error) {
      if (!(error instanceof InvalidProviderRunConfigError)) throw error;
      const suffix = error.fieldPath ? `.${error.fieldPath}` : '';
      throw new InvalidConfigError(
        label,
        configPath,
        `'assistants.${provider}${suffix}': ${error.message}.`
      );
    }
  }
}

function validateModelBindingConfig(parsed: unknown, configPath: string): void {
  if (typeof parsed !== 'object' || parsed === null) return;
  const config = parsed as Record<string, unknown>;
  for (const [field, schema] of [
    ['tiers', rawTiersConfigSchema],
    ['aliases', rawAliasesConfigSchema],
  ] as const) {
    if (config[field] === undefined) continue;
    const result = schema.safeParse(config[field]);
    if (!result.success) {
      const issues = result.error.issues
        .map(issue => `${field}.${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new InvalidConfigError('Invalid model binding config', configPath, issues);
    }
    config[field] = result.data;
  }
}

/**
 * Read ~/.archon/config.yaml, degrading to an empty config when it is missing
 * or unreadable. A missing file is created from the documented template; any
 * other failure — permissions, YAML syntax, a rejected `tiers`/`aliases` or
 * `workflows` block — is logged and the install falls back to defaults.
 */
async function readGlobalConfigOrDegrade(configPath: string): Promise<GlobalConfig> {
  try {
    const content = await readConfigFile(configPath);
    const parsed = parseYaml(content);
    validateWorkflowContinuationConfig(parsed, configPath);
    validateModelBindingConfig(parsed, configPath);
    return (parsed as GlobalConfig | null) ?? {};
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ENOENT') {
      // File doesn't exist - create default config
      await createDefaultConfig(configPath);
    } else {
      // Log specific error message based on error type
      logConfigError(configPath, error);
    }
    return {};
  }
}

/**
 * Load global config from ~/.archon/config.yaml
 * Creates default config if file doesn't exist
 *
 * Throws when `assistants.*` names a setting the provider cannot honour; every
 * other failure degrades to defaults.
 */
export async function loadGlobalConfig(forceReload = false): Promise<GlobalConfig> {
  if (cachedGlobalConfig && !forceReload) {
    return cachedGlobalConfig;
  }

  ensureProvidersRegistered();
  const configPath = getArchonConfigPath();
  const parsed = await readGlobalConfigOrDegrade(configPath);
  validateAssistantDefaults(parsed, configPath);
  cachedGlobalConfig = parsed;
  return cachedGlobalConfig;
}

/**
 * Coerce `recommendedWorkflows` to a clean `string[]` of trimmed non-empty
 * entries. Non-array values, non-string entries, and empties are dropped.
 * Advisory data — never throws.
 */
function sanitizeRecommendedWorkflows(raw: unknown, configPath: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    getLog().debug(
      { configPath, rawType: typeof raw },
      'config.recommended_workflows_not_array_ignored'
    );
    return undefined;
  }
  const cleaned: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      cleaned.push(entry.trim());
    } else {
      getLog().debug({ configPath, entry }, 'config.recommended_workflows_entry_ignored');
    }
  }
  return cleaned;
}

/** Read .archon/config.yaml, degrading to an empty config when it is missing or unreadable. */
async function readRepoConfigOrDegrade(configPath: string): Promise<RepoConfig> {
  try {
    const content = await readConfigFile(configPath);
    const raw = parseYaml(content);
    validateWorkflowContinuationConfig(raw, configPath);
    validateModelBindingConfig(raw, configPath);
    const parsed = (raw as RepoConfig | null) ?? {};
    const recommendedWorkflows = sanitizeRecommendedWorkflows(
      (parsed as { recommendedWorkflows?: unknown }).recommendedWorkflows,
      configPath
    );
    if (recommendedWorkflows !== undefined) {
      parsed.recommendedWorkflows = recommendedWorkflows;
    } else {
      delete parsed.recommendedWorkflows;
    }
    return parsed;
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ENOENT') {
      // File doesn't exist - expected, use defaults
      return {};
    }
    // Log specific error message based on error type
    logConfigError(configPath, error);
    return {};
  }
}

/**
 * Load repository config from .archon/config.yaml
 * Returns empty object if no config found
 *
 * Throws when `assistants.*` names a setting the provider cannot honour; every
 * other failure degrades to defaults.
 */
export async function loadRepoConfig(repoPath: string): Promise<RepoConfig> {
  ensureProvidersRegistered();
  const configPath = join(repoPath, '.archon', 'config.yaml');
  const parsed = await readRepoConfigOrDegrade(configPath);
  validateAssistantDefaults(parsed, configPath);
  return parsed;
}

/**
 * Get default configuration
 */
function getDefaults(): MergedConfig {
  // Seed one empty entry per registered provider — built-in OR community.
  // No per-provider listing here: adding a new provider must not require
  // editing this function. `registerBuiltinProviders()` + any community
  // registrations run at process bootstrap (see `packages/providers/src/
  // registry.ts#registerCommunityProviders`), so by the time this runs the
  // registry is populated.
  const providers = getRegisteredProviders();
  const registeredAssistants: AssistantDefaults = { claude: {}, codex: {} };
  for (const provider of providers) {
    if (!(provider.id in registeredAssistants)) {
      registeredAssistants[provider.id] = {};
    }
  }

  return {
    botName: 'Archon',
    assistant: providers.find(p => p.builtIn)?.id ?? 'claude',
    assistants: registeredAssistants,
    streaming: {
      telegram: 'stream',
      discord: 'batch',
      slack: 'batch',
    },
    paths: {
      workspaces: getArchonWorkspacesPath(),
      worktrees: getArchonWorktreesPath(),
    },
    concurrency: {
      maxConversations: 10,
    },
    workflows: {
      autoResumeOnQuotaReset: false,
      quotaMaxAttempts: 1,
      quotaDeadlineMs: 24 * 60 * 60 * 1000,
    },
    commands: {
      folder: undefined,
      autoLoad: true,
    },
    defaults: {
      copyDefaults: true,
      loadDefaultCommands: true,
      loadDefaultWorkflows: true,
    },
  };
}

/**
 * Apply environment variable overrides
 */
function applyEnvOverrides(
  config: MergedConfig,
  globalConfig?: GlobalConfig,
  repoConfig?: RepoConfig
): MergedConfig {
  // Bot name override
  const envBotName = process.env.BOT_DISPLAY_NAME;
  if (envBotName) {
    config.botName = envBotName;
  }

  // DEFAULT_AI_ASSISTANT is a fallback default: only applies when no config file
  // has explicitly set the assistant. An explicit save via the Web UI (or a repo
  // .archon/config.yaml) takes precedence over the env var.
  const envAssistant = process.env.DEFAULT_AI_ASSISTANT;
  if (envAssistant && envAssistant.length > 0) {
    const hasExplicitConfig =
      Boolean(globalConfig?.defaultAssistant) || Boolean(repoConfig?.assistant);
    if (!hasExplicitConfig) {
      if (isRegisteredProvider(envAssistant)) {
        config.assistant = envAssistant;
      } else {
        throw new Error(
          `DEFAULT_AI_ASSISTANT='${envAssistant}' is not a registered provider. ` +
            `Available providers: ${getRegisteredProviderNames().join(', ')}`
        );
      }
    } else if (!isRegisteredProvider(envAssistant)) {
      // Config file takes precedence, but warn that the env var value is unknown —
      // a typo here would go undetected if we don't surface it.
      getLog().warn(
        { envAssistant, available: getRegisteredProviderNames() },
        'config.env_assistant_unknown_ignored'
      );
    }
  }

  // Streaming overrides
  const streamingModes = ['stream', 'batch'] as const;
  const telegramMode = process.env.TELEGRAM_STREAMING_MODE;
  if (telegramMode && streamingModes.includes(telegramMode as 'stream' | 'batch')) {
    config.streaming.telegram = telegramMode as 'stream' | 'batch';
  }

  const discordMode = process.env.DISCORD_STREAMING_MODE;
  if (discordMode && streamingModes.includes(discordMode as 'stream' | 'batch')) {
    config.streaming.discord = discordMode as 'stream' | 'batch';
  }

  const slackMode = process.env.SLACK_STREAMING_MODE;
  if (slackMode && streamingModes.includes(slackMode as 'stream' | 'batch')) {
    config.streaming.slack = slackMode as 'stream' | 'batch';
  }

  // Path overrides (these come from archon-paths.ts which already checks env vars)
  // No need to re-apply here since getDefaults() uses those functions

  // Concurrency override
  const maxConcurrent = process.env.MAX_CONCURRENT_CONVERSATIONS;
  if (maxConcurrent) {
    const parsed = parseInt(maxConcurrent, 10);
    if (!isNaN(parsed) && parsed > 0) {
      config.concurrency.maxConversations = parsed;
    }
  }

  return config;
}

/**
 * Merge global config into defaults
 */
function mergeGlobalConfig(defaults: MergedConfig, global: GlobalConfig): MergedConfig {
  const result: MergedConfig = {
    ...defaults,
    assistants: mergeAssistantDefaults(defaults.assistants),
  };

  // Bot name preference
  if (global.botName) {
    result.botName = global.botName;
  }

  // Assistant preference — validate against registry
  if (global.defaultAssistant) {
    if (isRegisteredProvider(global.defaultAssistant)) {
      result.assistant = global.defaultAssistant;
    } else {
      throw new Error(
        `defaultAssistant: '${global.defaultAssistant}' in global config (~/.archon/config.yaml) ` +
          `is not a registered provider. Available: ${getRegisteredProviderNames().join(', ')}`
      );
    }
  }

  result.assistants = mergeAssistantDefaults(result.assistants, global.assistants);

  result.aliases = mergeAliases(result.aliases, global.aliases);
  result.tiers = mergeTiers(result.tiers, global.tiers);

  // Streaming preferences
  if (global.streaming) {
    if (global.streaming.telegram) result.streaming.telegram = global.streaming.telegram;
    if (global.streaming.discord) result.streaming.discord = global.streaming.discord;
    if (global.streaming.slack) result.streaming.slack = global.streaming.slack;
  }

  // Path preferences
  if (global.paths) {
    if (global.paths.workspaces) result.paths.workspaces = global.paths.workspaces;
    if (global.paths.worktrees) result.paths.worktrees = global.paths.worktrees;
  }

  // Concurrency preferences
  if (global.concurrency?.maxConversations) {
    result.concurrency.maxConversations = global.concurrency.maxConversations;
  }

  if (global.workflows) {
    result.workflows = { ...result.workflows, ...global.workflows };
  }

  // Container backend defaults (folder projects)
  if (global.container) {
    result.container = { ...global.container };
  }

  return result;
}

/**
 * Merge repo config into merged config
 */
function mergeRepoConfig(merged: MergedConfig, repo: RepoConfig): MergedConfig {
  const result: MergedConfig = {
    ...merged,
    assistants: mergeAssistantDefaults(merged.assistants),
  };

  // Assistant override (repo-level takes precedence) — validate against registry
  if (repo.assistant) {
    if (isRegisteredProvider(repo.assistant)) {
      result.assistant = repo.assistant;
    } else {
      throw new Error(
        `assistant: '${repo.assistant}' in repo config (.archon/config.yaml) ` +
          `is not a registered provider. Available: ${getRegisteredProviderNames().join(', ')}`
      );
    }
  }

  result.assistants = mergeAssistantDefaults(result.assistants, repo.assistants);

  result.aliases = mergeAliases(result.aliases, repo.aliases);
  result.tiers = mergeTiers(result.tiers, repo.tiers);

  if (repo.workflows) {
    result.workflows = { ...result.workflows, ...repo.workflows };
  }

  // Commands config
  if (repo.commands) {
    result.commands = {
      ...result.commands,
      folder: repo.commands.folder ?? result.commands.folder,
      autoLoad: repo.commands.autoLoad ?? result.commands.autoLoad,
    };
  }

  // Defaults config
  if (repo.defaults) {
    result.defaults = {
      ...result.defaults,
      copyDefaults: repo.defaults.copyDefaults ?? result.defaults.copyDefaults,
      loadDefaultCommands: repo.defaults.loadDefaultCommands ?? result.defaults.loadDefaultCommands,
      loadDefaultWorkflows:
        repo.defaults.loadDefaultWorkflows ?? result.defaults.loadDefaultWorkflows,
    };
  }

  // Propagate base branch for $BASE_BRANCH substitution in workflow commands
  if (repo.worktree?.baseBranch?.trim()) {
    result.baseBranch = repo.worktree.baseBranch.trim();
  }

  // Pass remote to callers for git fetch/push operations
  if (repo.worktree?.remote?.trim()) {
    result.remote = repo.worktree.remote.trim();
  }

  // Propagate docs path for $DOCS_DIR substitution in workflow commands
  if (repo.docs?.path !== undefined) {
    const trimmed = repo.docs.path.trim();
    if (trimmed) {
      result.docsPath = trimmed;
    } else {
      getLog().warn({ rawValue: repo.docs.path }, 'config.docs_path_whitespace_ignored');
    }
  }

  // Propagate per-project env vars from repo config
  if (repo.env) {
    result.envVars = { ...result.envVars, ...repo.env };
  }

  // Container backend settings — repo overrides global per-field.
  if (repo.container) {
    result.container = {
      ...result.container,
      ...Object.fromEntries(
        Object.entries(repo.container).filter(([, value]) => value !== undefined)
      ),
    };
  }

  return result;
}

/**
 * Load fully merged configuration
 *
 * @param repoPath - Optional repository path for repo-level config
 * @returns Merged configuration with all overrides applied
 */
export async function loadConfig(repoPath?: string): Promise<MergedConfig> {
  ensureProvidersRegistered();

  // 1. Start with defaults
  let config = getDefaults();

  // 2. Apply global config
  const globalConfig = await loadGlobalConfig();
  config = mergeGlobalConfig(config, globalConfig);

  // 3. Apply repo config if path provided
  let repoConfig: RepoConfig | undefined;
  if (repoPath) {
    repoConfig = await loadRepoConfig(repoPath);
    config = mergeRepoConfig(config, repoConfig);
  }

  // 4. Apply environment overrides — DEFAULT_AI_ASSISTANT is a fallback:
  //    explicit config-file settings take precedence over the env var.
  config = applyEnvOverrides(config, globalConfig, repoConfig);

  return config;
}

/**
 * Clear cached global config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedGlobalConfig = null;
}

/**
 * Log current configuration (for startup)
 */
export function logConfig(config: MergedConfig): void {
  getLog().info(
    {
      assistant: config.assistant,
      streaming: config.streaming,
    },
    'config_loaded'
  );
}

/**
 * Read ~/.archon/config.yaml for a settings write: the file's actual parsed
 * content, unvalidated, so a patch can repair a bad value and every unrelated
 * key survives. Unlike the loaders this never degrades — merging into a
 * fallback `{}` would replace the operator's whole file with just the patch.
 * Only a missing file starts empty; an unreadable file or invalid YAML throws.
 */
async function readGlobalConfigForUpdate(configPath: string): Promise<GlobalConfig> {
  let content: string;
  try {
    content = await readConfigFile(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot update '${configPath}': it is not valid YAML (${reason}).`, {
      cause: error,
    });
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isConfigRecord(parsed)) {
    throw new Error(`Cannot update '${configPath}': its top level is not a map of settings.`);
  }
  return parsed as GlobalConfig;
}

/**
 * Apply a `tiers`/`aliases` patch per key: `null` unsets, a value sets, an
 * absent key keeps the existing entry as-is. Collapses to `undefined` when
 * nothing is left, so no empty block is serialized.
 */
function mergeBindingPatch<T>(
  existing: unknown,
  patch: Record<string, T | null | undefined>
): Record<string, T> | undefined {
  // Existing entries are unvalidated file content (see readGlobalConfigForUpdate);
  // the caller validates the merged result before it is written.
  const kept = isConfigRecord(existing) ? (existing as Record<string, T>) : {};
  const next: Record<string, T> = {};
  for (const [name, entry] of Object.entries(kept)) {
    if (patch[name] === undefined) next[name] = entry;
  }
  for (const [name, entry] of Object.entries(patch)) {
    if (entry !== null && entry !== undefined) next[name] = entry;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Update global config (~/.archon/config.yaml) with partial updates.
 * Reads current config, deep-merges updates, and writes back to YAML.
 * Invalidates the cached config so next loadConfig() picks up changes.
 */
export async function updateGlobalConfig(
  updates: Partial<Omit<GlobalConfig, 'tiers' | 'aliases'>> & {
    tiers?: TiersPatch;
    aliases?: AliasesPatch;
  }
): Promise<void> {
  const configPath = getArchonConfigPath();

  try {
    ensureProvidersRegistered();
    const current = await readGlobalConfigForUpdate(configPath);

    // Deep-merge: only overwrite defined keys
    const merged: GlobalConfig = { ...current };

    if (updates.botName !== undefined) merged.botName = updates.botName;
    if (updates.defaultAssistant !== undefined) merged.defaultAssistant = updates.defaultAssistant;

    if (updates.assistants) {
      merged.assistants = mergeAssistantDefaults(
        mergeAssistantDefaults(getDefaults().assistants, current.assistants),
        updates.assistants
      );
      // mergeAssistantDefaults skips a non-object slot, which would let the
      // built-in default silently replace it. Keep what is on disk for every
      // provider the patch does not touch so validation below refuses it.
      if (isConfigRecord(current.assistants)) {
        for (const [provider, existing] of Object.entries(current.assistants)) {
          if (existing === null || isConfigRecord(existing)) continue;
          if (updates.assistants[provider] === undefined) merged.assistants[provider] = existing;
        }
      }
    }

    if (updates.streaming) {
      merged.streaming = { ...current.streaming, ...updates.streaming };
    }

    if (updates.concurrency) {
      merged.concurrency = { ...current.concurrency, ...updates.concurrency };
    }

    if (updates.workflows) {
      merged.workflows = {
        ...(isConfigRecord(current.workflows) ? current.workflows : {}),
        ...updates.workflows,
      };
    }

    if (updates.tiers) {
      // Per-key merge: `null` unsets a tier, a value sets it, and an absent key
      // (`undefined`) preserves the existing entry — including one that is not a
      // valid tier, which validation below then refuses rather than dropping.
      merged.tiers = mergeBindingPatch(current.tiers, updates.tiers);
    }

    if (updates.aliases) {
      merged.aliases = mergeBindingPatch(current.aliases, updates.aliases);
    }

    // Refuse to persist what the loaders would then refuse to read or silently
    // degrade: a bad value from the settings UI would otherwise brick every later
    // config load, and a bad block already on disk must be repaired, not kept.
    validateWorkflowContinuationConfig(merged, configPath);
    validateModelBindingConfig(merged, configPath);
    validateAssistantDefaults(merged, configPath);

    // Serialize to YAML and write
    const yaml = Bun.YAML.stringify(merged);
    await mkdir(dirname(configPath), { recursive: true });
    await writeConfigFile(configPath, yaml);

    // Invalidate cache so next loadConfig() re-reads
    cachedGlobalConfig = null;

    getLog().info({ configPath }, 'config.update_completed');
  } catch (error) {
    const err = error as { code?: string; message?: string };

    if (error instanceof InvalidConfigError) {
      getLog().warn({ configPath, err: error }, 'config.update_refused');
    } else if (err.code === 'EACCES' || err.code === 'EPERM') {
      getLog().error({ configPath, err: error, code: err.code }, 'config.update_permission_denied');
    } else {
      getLog().error({ configPath, err: error }, 'config.update_failed');
    }

    throw error;
  }
}

/**
 * Built-in tier presets (small/medium/large) for a provider, from
 * tier-defaults.json via buildAiProfile. Lets the settings UI show what an
 * unset tier resolves to. Never throws — an unknown/odd provider (or a throw)
 * yields `undefined` (every consumer uses optional chaining).
 */
function tierDefaultsFor(provider: string): RawTiersConfig | undefined {
  try {
    const profile = buildAiProfile(provider);
    const out: RawTiersConfig = {};
    for (const tier of TIER_NAMES) {
      const preset = profile.aliases[tier];
      if (preset) {
        out[tier] = {
          provider: preset.provider,
          model: preset.model,
          ...(preset.effort !== undefined ? { effort: preset.effort } : {}),
        };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch (error) {
    getLog().warn({ provider, err: error }, 'config.tier_defaults_failed');
    return undefined;
  }
}

/**
 * Project a MergedConfig to a SafeConfig suitable for sending to web clients.
 * Strips filesystem paths and any other server-internal fields.
 */
export function toSafeConfig(config: MergedConfig): SafeConfig {
  return {
    botName: config.botName,
    assistant: config.assistant,
    assistants: toSafeAssistantDefaults(config.assistants),
    streaming: {
      telegram: config.streaming.telegram,
      discord: config.streaming.discord,
      slack: config.streaming.slack,
    },
    concurrency: { maxConversations: config.concurrency.maxConversations },
    defaults: {
      copyDefaults: config.defaults.copyDefaults,
      loadDefaultCommands: config.defaults.loadDefaultCommands,
      loadDefaultWorkflows: config.defaults.loadDefaultWorkflows,
    },
    tiers: config.tiers,
    tierDefaults: tierDefaultsFor(config.assistant),
    aliases: config.aliases,
  };
}
