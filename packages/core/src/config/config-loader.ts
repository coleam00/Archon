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
import type { GlobalConfig, RepoConfig, MergedConfig, SafeConfig } from './config-types';
import { createLogger } from '@archon/paths';

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

# Default AI assistant (claude or codex)
# defaultAssistant: claude

# Assistant defaults
# assistants:
#   claude:
#     model: sonnet
#   codex:
#     model: gpt-5.3-codex
#     modelReasoningEffort: medium
#     webSearchMode: disabled
#     additionalDirectories:
#       - /absolute/path/to/other/repo

# Streaming mode per platform (stream or batch)
# streaming:
#   telegram: stream
#   discord: batch
#   slack: batch

# Concurrency settings
# concurrency:
#   maxConversations: 10
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
 * Load global config from ~/.archon/config.yaml
 * Creates default config if file doesn't exist
 */
export async function loadGlobalConfig(forceReload = false): Promise<GlobalConfig> {
  if (cachedGlobalConfig && !forceReload) {
    return cachedGlobalConfig;
  }

  const configPath = getArchonConfigPath();

  try {
    const content = await readConfigFile(configPath);
    cachedGlobalConfig = parseYaml(content) as GlobalConfig;
    return cachedGlobalConfig ?? {};
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ENOENT') {
      // File doesn't exist - create default config
      await createDefaultConfig(configPath);
    } else {
      // Log specific error message based on error type
      logConfigError(configPath, error);
    }
    cachedGlobalConfig = {};
    return cachedGlobalConfig;
  }
}

/**
 * Load repository config from .archon/config.yaml
 * Returns empty object if no config found
 */
export async function loadRepoConfig(repoPath: string): Promise<RepoConfig> {
  const configPath = join(repoPath, '.archon', 'config.yaml');

  try {
    const content = await readConfigFile(configPath);
    return (parseYaml(content) as RepoConfig) ?? {};
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
 * Get default configuration
 */
function getDefaults(): MergedConfig {
  return {
    botName: 'Archon',
    assistant: 'claude',
    assistants: {
      claude: {},
      codex: {},
    },
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
function applyEnvOverrides(config: MergedConfig): MergedConfig {
  // Bot name override
  const envBotName = process.env.BOT_DISPLAY_NAME;
  if (envBotName) {
    config.botName = envBotName;
  }

  // Assistant override
  const envAssistant = process.env.DEFAULT_AI_ASSISTANT;
  if (envAssistant === 'claude' || envAssistant === 'codex') {
    config.assistant = envAssistant;
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
    assistants: {
      claude: { ...defaults.assistants.claude },
      codex: { ...defaults.assistants.codex },
    },
  };

  // Bot name preference
  if (global.botName) {
    result.botName = global.botName;
  }

  // Assistant preference
  if (global.defaultAssistant) {
    result.assistant = global.defaultAssistant;
  }

  if (global.assistants?.claude?.model) {
    result.assistants.claude.model = global.assistants.claude.model;
  }
  if (global.assistants?.claude?.settingSources) {
    result.assistants.claude.settingSources = global.assistants.claude.settingSources;
  }
  if (global.assistants?.codex) {
    result.assistants.codex = {
      ...result.assistants.codex,
      ...global.assistants.codex,
    };
  }

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

  return result;
}

/**
 * Merge repo config into merged config
 */
function mergeRepoConfig(merged: MergedConfig, repo: RepoConfig): MergedConfig {
  const result: MergedConfig = {
    ...merged,
    assistants: {
      claude: { ...merged.assistants.claude },
      codex: { ...merged.assistants.codex },
    },
  };

  // Assistant override (repo-level takes precedence)
  if (repo.assistant) {
    result.assistant = repo.assistant;
  }

  if (repo.assistants?.claude?.model) {
    result.assistants.claude.model = repo.assistants.claude.model;
  }
  if (repo.assistants?.claude?.settingSources) {
    result.assistants.claude.settingSources = repo.assistants.claude.settingSources;
  }
  if (repo.assistants?.codex) {
    result.assistants.codex = {
      ...result.assistants.codex,
      ...repo.assistants.codex,
    };
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

  return result;
}

/**
 * Load fully merged configuration
 *
 * @param repoPath - Optional repository path for repo-level config
 * @returns Merged configuration with all overrides applied
 */
export async function loadConfig(repoPath?: string): Promise<MergedConfig> {
  // 1. Start with defaults
  let config = getDefaults();

  // 2. Apply global config
  const globalConfig = await loadGlobalConfig();
  config = mergeGlobalConfig(config, globalConfig);

  // 3. Apply repo config if path provided
  if (repoPath) {
    const repoConfig = await loadRepoConfig(repoPath);
    config = mergeRepoConfig(config, repoConfig);
  }

  // 4. Apply environment overrides (highest precedence)
  config = applyEnvOverrides(config);

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
 * Update global config (~/.archon/config.yaml) with partial updates.
 * Reads current config, deep-merges updates, and writes back to YAML.
 * Invalidates the cached config so next loadConfig() picks up changes.
 */
export async function updateGlobalConfig(updates: Partial<GlobalConfig>): Promise<void> {
  const configPath = getArchonConfigPath();

  try {
    // Force reload to get fresh state
    const current = await loadGlobalConfig(true);

    // Deep-merge: only overwrite defined keys
    const merged: GlobalConfig = { ...current };

    if (updates.botName !== undefined) merged.botName = updates.botName;
    if (updates.defaultAssistant !== undefined) merged.defaultAssistant = updates.defaultAssistant;

    if (updates.assistants) {
      merged.assistants = {
        claude: { ...current.assistants?.claude, ...updates.assistants.claude },
        codex: { ...current.assistants?.codex, ...updates.assistants.codex },
      };
    }

    if (updates.streaming) {
      merged.streaming = { ...current.streaming, ...updates.streaming };
    }

    if (updates.concurrency) {
      merged.concurrency = { ...current.concurrency, ...updates.concurrency };
    }

    // Serialize to YAML and write
    const yaml = Bun.YAML.stringify(merged);
    await mkdir(dirname(configPath), { recursive: true });
    await writeConfigFile(configPath, yaml);

    // Invalidate cache so next loadConfig() re-reads
    cachedGlobalConfig = null;

    getLog().info({ configPath }, 'config.update_completed');
  } catch (error) {
    const err = error as { code?: string; message?: string };

    if (err.code === 'EACCES' || err.code === 'EPERM') {
      getLog().error({ configPath, err: error, code: err.code }, 'config.update_permission_denied');
    } else {
      getLog().error({ configPath, err: error }, 'config.update_failed');
    }

    throw error;
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
    assistants: {
      claude: {
        model: config.assistants.claude.model,
      },
      codex: {
        model: config.assistants.codex.model,
        modelReasoningEffort: config.assistants.codex.modelReasoningEffort,
        webSearchMode: config.assistants.codex.webSearchMode,
      },
    },
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
  };
}
