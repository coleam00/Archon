// How the config layers combine: defaults, then global, then repo, then environment.
import { installedProviders, missingProviderMessage } from '@archon/provider-contract';
import { providerRegistry, getRegisteredProviders, isRegisteredProvider } from '@archon/providers';
import {
  DEFAULT_TOOL_CALL_ATTENTION_MS,
  liveWorkflowPolicy,
} from '@archon/workflows/schemas/run-config';
import { createLogger } from '@archon/paths';
import { getRegisteredPlatformPolicies } from '../platforms/registry';
import type {
  AssistantDefaults,
  AssistantDefaultsConfig,
  GlobalConfig,
  MergedConfig,
  RawAliasesConfig,
  RawTiersConfig,
  RepoConfig,
} from './config-types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('config');
  return cachedLog;
}

/** The host registers providers before loading configuration. */
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

export function mergeAssistantDefaults(
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
 * Get default configuration
 */
export function getDefaults(): MergedConfig {
  const providers = getRegisteredProviders();
  const installed = installedProviders(providerRegistry);
  const registeredAssistants: AssistantDefaults = { claude: {}, codex: {} };
  for (const provider of providers) {
    if (!(provider.id in registeredAssistants)) {
      registeredAssistants[provider.id] = {};
    }
  }

  const streaming: MergedConfig['streaming'] = {};
  for (const policy of getRegisteredPlatformPolicies()) {
    if (policy.streaming) streaming[policy.id] = policy.streaming.defaultMode;
  }

  return {
    botName: 'Archon',
    assistant: installed.length === 1 ? installed[0].id : undefined,
    assistants: registeredAssistants,
    streaming,
    attentionNotices: [],
    concurrency: {
      maxConversations: 10,
    },
    workflows: {
      toolCallAttentionMs: DEFAULT_TOOL_CALL_ATTENTION_MS,
      autoResumeOnQuotaReset: true,
    },
    commands: {
      folder: undefined,
      autoLoad: true,
    },
    defaults: {
      loadDefaultCommands: true,
      loadDefaultWorkflows: true,
    },
  };
}

/**
 * Apply environment variable overrides
 */
export function applyEnvOverrides(
  config: MergedConfig,
  globalConfig?: GlobalConfig,
  repoConfig?: RepoConfig
): MergedConfig {
  // Bot name override
  const envBotName = process.env.BOT_DISPLAY_NAME;
  if (envBotName) {
    config.botName = envBotName;
  }

  const envAssistant = process.env.DEFAULT_AI_ASSISTANT;
  if (envAssistant && envAssistant.length > 0) {
    applyEnvAssistant(config, envAssistant, globalConfig, repoConfig);
  }

  for (const policy of getRegisteredPlatformPolicies()) {
    if (!policy.streaming) continue;
    const mode = process.env[policy.streaming.envVar];
    if (mode === 'stream' || mode === 'batch') config.streaming[policy.id] = mode;
  }

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
 * DEFAULT_AI_ASSISTANT is a fallback default: only applies when no config file
 * has explicitly set the assistant. An explicit save via the Web UI (or a repo
 * .archon/config.yaml) takes precedence over the env var.
 */
function applyEnvAssistant(
  config: MergedConfig,
  envAssistant: string,
  globalConfig?: GlobalConfig,
  repoConfig?: RepoConfig
): void {
  const hasExplicitConfig =
    Boolean(globalConfig?.defaultAssistant) || Boolean(repoConfig?.assistant);
  if (!hasExplicitConfig) {
    if (isRegisteredProvider(envAssistant)) {
      config.assistant = envAssistant;
    } else {
      throw new Error(
        `DEFAULT_AI_ASSISTANT='${envAssistant}': ${missingProviderMessage(providerRegistry, envAssistant)}`
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

/**
 * Merge global config into defaults
 */
export function mergeGlobalConfig(defaults: MergedConfig, global: GlobalConfig): MergedConfig {
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
        `defaultAssistant in global config (~/.archon/config.yaml): ${missingProviderMessage(providerRegistry, global.defaultAssistant)}`
      );
    }
  }

  result.assistants = mergeAssistantDefaults(result.assistants, global.assistants);

  result.aliases = mergeAliases(result.aliases, global.aliases);
  result.tiers = mergeTiers(result.tiers, global.tiers);

  if (global.streaming) {
    result.streaming = { ...result.streaming, ...global.streaming };
  }

  if (global.attentionNotices) result.attentionNotices = global.attentionNotices;

  // Concurrency preferences
  if (global.concurrency?.maxConversations) {
    result.concurrency.maxConversations = global.concurrency.maxConversations;
  }

  if (global.workflows) {
    result.workflows = { ...result.workflows, ...liveWorkflowPolicy(global.workflows) };
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
export function mergeRepoConfig(merged: MergedConfig, repo: RepoConfig): MergedConfig {
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
        `assistant in repo config (.archon/config.yaml): ${missingProviderMessage(providerRegistry, repo.assistant)}`
      );
    }
  }

  result.assistants = mergeAssistantDefaults(result.assistants, repo.assistants);

  result.aliases = mergeAliases(result.aliases, repo.aliases);
  result.tiers = mergeTiers(result.tiers, repo.tiers);

  if (repo.workflows) {
    result.workflows = { ...result.workflows, ...liveWorkflowPolicy(repo.workflows) };
  }

  mergeRepoProjectSettings(result, repo);
  mergeRepoWorktreeSettings(result, repo);

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

/** Commands, default-loading and per-project env vars from repo config. */
function mergeRepoProjectSettings(result: MergedConfig, repo: RepoConfig): void {
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
      loadDefaultCommands: repo.defaults.loadDefaultCommands ?? result.defaults.loadDefaultCommands,
      loadDefaultWorkflows:
        repo.defaults.loadDefaultWorkflows ?? result.defaults.loadDefaultWorkflows,
    };
  }

  // Propagate per-project env vars from repo config
  if (repo.env) {
    result.envVars = { ...result.envVars, ...repo.env };
  }
}

/** Base branch, remote and docs path from the repo's worktree and docs settings. */
function mergeRepoWorktreeSettings(result: MergedConfig, repo: RepoConfig): void {
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
}
