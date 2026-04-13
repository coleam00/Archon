/**
 * Configuration types for Archon YAML config files
 *
 * Two levels:
 * - Global: ~/.archon/config.yaml (user preferences)
 * - Repository: .archon/config.yaml (project settings)
 */

/**
 * Global configuration (non-secret user preferences)
 * Located at ~/.archon/config.yaml
 */

// Provider config defaults — canonical definitions live in @archon/providers/types.
// Imported and re-exported here so existing consumers don't break.
import type {
  ClaudeProviderDefaults,
  CodexProviderDefaults,
  ProviderDefaultsMap,
} from '@archon/providers/types';

export type { ClaudeProviderDefaults, CodexProviderDefaults, ProviderDefaultsMap };

/**
 * Intersection type: generic ProviderDefaultsMap (any string key) with typed built-in entries.
 * Built-in keys are typed so parseClaudeConfig/parseCodexConfig get type safety without casts.
 * Community providers use the generic [string] index. This is intentional — removing the
 * built-in intersection would force `as` casts everywhere built-in config is accessed.
 */
export type AssistantDefaultsConfig = ProviderDefaultsMap & {
  claude?: ClaudeProviderDefaults;
  codex?: CodexProviderDefaults;
};

/** Required variant — built-ins always present after config merge (registerBuiltinProviders guarantees it). */
export type AssistantDefaults = ProviderDefaultsMap & {
  claude: ClaudeProviderDefaults;
  codex: CodexProviderDefaults;
};

export interface GlobalConfig {
  /**
   * Bot display name (shown in messages)
   * @default 'Archon'
   */
  botName?: string;

  /**
   * Default AI assistant when no codebase-specific preference
   * @default 'claude'
   */
  defaultAssistant?: string;

  /**
   * Assistant-specific defaults (model, reasoning effort, etc.)
   */
  assistants?: AssistantDefaultsConfig;

  /**
   * Platform streaming preferences (can be overridden per conversation)
   */
  streaming?: {
    telegram?: 'stream' | 'batch';
    discord?: 'stream' | 'batch';
    slack?: 'stream' | 'batch';
  };

  /**
   * Directory preferences (usually not needed - defaults work well)
   */
  paths?: {
    /**
     * Override workspaces directory
     * @default '~/.archon/workspaces'
     */
    workspaces?: string;

    /**
     * Override worktrees directory
     * @default '~/.archon/worktrees'
     */
    worktrees?: string;
  };

  /**
   * Concurrency limits
   */
  concurrency?: {
    /**
     * Maximum concurrent AI conversations
     * @default 10
     */
    maxConversations?: number;
  };
}

/**
 * Repository configuration (project-specific settings)
 * Located at .archon/config.yaml in any repository
 */
export interface RepoConfig {
  /**
   * AI assistant preference for this repository
   * Overrides global default
   */
  assistant?: string;

  /**
   * Assistant-specific defaults for this repository
   */
  assistants?: AssistantDefaultsConfig;

  /**
   * Commands configuration
   */
  commands?: {
    /**
     * Custom command folder path (relative to repo root)
     * @default '.archon/commands'
     */
    folder?: string;

    /**
     * Auto-load commands on clone
     * @default true
     */
    autoLoad?: boolean;
  };

  /**
   * Worktree settings for this repository
   */
  worktree?: {
    /**
     * Base branch for worktrees (e.g., 'main', 'develop')
     * @default auto-detected from repo
     */
    baseBranch?: string;

    /**
     * Git-ignored files/directories to copy from main repo to new worktrees.
     * Tracked files are already in worktrees — only use this for git-ignored files.
     * @example [".env", ".archon", "data/fixtures/"]
     */
    copyFiles?: string[];
  };

  /**
   * Documentation directory settings
   */
  docs?: {
    /**
     * Path to documentation directory (relative to repo root)
     * @default 'docs/'
     */
    path?: string;
  };

  /**
   * Per-project environment variables injected into Claude SDK subprocess env.
   * Values here override process.env for workflow node execution.
   * Sensitive — do not commit actual secrets to version-controlled repos.
   */
  env?: Record<string, string>;

  /**
   * Default commands/workflows configuration
   */
  defaults?: {
    /**
     * Copy bundled default commands and workflows on clone
     * Set to false to skip copying defaults
     * @default true
     * @deprecated Use loadDefaultCommands/loadDefaultWorkflows instead
     */
    copyDefaults?: boolean;

    /**
     * Load app's bundled default commands at runtime
     * Set to false to only use repo-specific commands
     * @default true
     */
    loadDefaultCommands?: boolean;

    /**
     * Load app's bundled default workflows at runtime
     * Set to false to only use repo-specific workflows
     * @default true
     */
    loadDefaultWorkflows?: boolean;
  };
}

/**
 * Merged configuration (global + repo + env vars)
 * Environment variables take precedence
 */
export interface MergedConfig {
  botName: string;
  assistant: string;
  assistants: AssistantDefaults;
  streaming: {
    telegram: 'stream' | 'batch';
    discord: 'stream' | 'batch';
    slack: 'stream' | 'batch';
  };
  paths: {
    workspaces: string;
    worktrees: string;
  };
  concurrency: {
    maxConversations: number;
  };
  commands: {
    /**
     * Additional command folder to search (relative to repo root)
     * Searched after .archon/commands/ but before .claude/commands/
     */
    folder?: string;
    autoLoad: boolean;
  };
  defaults: {
    copyDefaults: boolean;
    loadDefaultCommands: boolean;
    loadDefaultWorkflows: boolean;
  };
  /**
   * Base branch from repo config (worktree.baseBranch).
   * Used for $BASE_BRANCH substitution in workflow commands.
   * When undefined, workflows referencing $BASE_BRANCH will fail with an error.
   */
  baseBranch?: string;
  /**
   * Docs directory path from repo config (docs.path).
   * Used for $DOCS_DIR substitution in workflow commands.
   * @default 'docs/'
   */
  docsPath?: string;
  /**
   * Merged per-project env vars from .archon/config.yaml env: section.
   * DB env vars (from Web UI) are merged on top by executeWorkflow.
   * Undefined when no env vars are configured.
   */
  envVars?: Record<string, string>;
}

/**
 * Safe subset of MergedConfig suitable for sending to web clients.
 * Excludes filesystem paths and any other server-internal fields.
 */
export interface SafeConfig {
  botName: string;
  assistant: string;
  assistants: ProviderDefaultsMap;
  streaming: {
    telegram: 'stream' | 'batch';
    discord: 'stream' | 'batch';
    slack: 'stream' | 'batch';
  };
  concurrency: {
    maxConversations: number;
  };
  defaults: {
    copyDefaults: boolean;
    loadDefaultCommands: boolean;
    loadDefaultWorkflows: boolean;
  };
}
