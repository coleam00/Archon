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
import type { ModelReasoningEffort, WebSearchMode } from '../types';

export interface AssistantDefaults {
  model?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  webSearchMode?: WebSearchMode;
  additionalDirectories?: string[];
  /** Path to the Codex CLI binary. Overrides auto-detection in compiled Archon builds.
   *  Only relevant for the Codex provider; ignored for Claude. */
  codexBinaryPath?: string;
}

export interface ClaudeAssistantDefaults {
  model?: string;
  /** Claude Code settingSources — controls which CLAUDE.md files are loaded.
   *  @default ['project']
   *  @see https://github.com/anthropics/claude-agent-sdk */
  settingSources?: ('project' | 'user')[];
}

/**
 * Defaults for the Ollama assistant provider.
 * Configured under `assistants.ollama` in `.archon/config.yaml`.
 */
export interface OllamaAssistantDefaults {
  model?: string;
  /** Ollama server base URL. Overrides OLLAMA_BASE_URL env var.
   *  @default 'http://localhost:11434' */
  baseUrl?: string;
}

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
  defaultAssistant?: 'claude' | 'codex' | 'ollama';

  /**
   * Assistant-specific defaults (model, reasoning effort, etc.)
   */
  assistants?: {
    claude?: ClaudeAssistantDefaults;
    codex?: AssistantDefaults;
    ollama?: OllamaAssistantDefaults;
  };

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

  /**
   * Bypass the env-leak gate globally. When true, Archon will not refuse to
   * register or spawn subprocesses for codebases whose auto-loaded .env files
   * contain sensitive keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc).
   *
   * WARNING: Weakens the env-leak gate. Keys in the target repo's .env will
   * be auto-loaded by Bun subprocesses (Claude/Codex) and bypass Archon's
   * env allowlist. Use only on trusted machines.
   *
   * YAML key: `allow_target_repo_keys`
   * @default false
   */
  allow_target_repo_keys?: boolean;
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
  assistant?: 'claude' | 'codex' | 'ollama';

  /**
   * Assistant-specific defaults for this repository
   */
  assistants?: {
    claude?: ClaudeAssistantDefaults;
    codex?: AssistantDefaults;
    ollama?: OllamaAssistantDefaults;
  };

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
   * Per-repo override for the env-leak gate bypass. Repo value wins over global.
   * YAML key: `allow_target_repo_keys`
   */
  allow_target_repo_keys?: boolean;

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
  assistant: 'claude' | 'codex' | 'ollama';
  assistants: {
    claude: ClaudeAssistantDefaults;
    codex: AssistantDefaults;
    ollama: OllamaAssistantDefaults;
  };
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

  /**
   * Effective value of the env-leak gate bypass. When true, the env scanner
   * is skipped during registration and pre-spawn. Repo-level override wins
   * over global (explicit `false` at repo level re-enables the gate).
   * @default false
   */
  allowTargetRepoKeys: boolean;
}

/**
 * Safe subset of MergedConfig suitable for sending to web clients.
 * Excludes filesystem paths and any other server-internal fields.
 */
export interface SafeConfig {
  botName: string;
  assistant: 'claude' | 'codex' | 'ollama';
  /** Providers that are configured and available on this server. */
  availableAssistants: ('claude' | 'codex' | 'ollama')[];
  assistants: {
    claude: Pick<ClaudeAssistantDefaults, 'model'>;
    codex: Pick<AssistantDefaults, 'model' | 'modelReasoningEffort' | 'webSearchMode'>;
    ollama: Pick<OllamaAssistantDefaults, 'model' | 'baseUrl'>;
  };
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
