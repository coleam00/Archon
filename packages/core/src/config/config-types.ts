import type { WorktreeCreateConfig } from '@archon/isolation';
import type { WorkflowStoreKind } from '@archon/workflows/store';
import type { ResolvedWorkflowPolicy } from '@archon/workflows/schemas/run-config';
/**
 * Configuration types for Archon YAML config files
 *
 * Two levels:
 * - Global: ~/.archon/config.yaml (user preferences)
 * - Repository: .archon/config.yaml (project settings)
 */
import { z } from '@hono/zod-openapi';
import { identityPlatformSchema } from '../schemas/user';

export const streamingModeSchema = z.enum(['stream', 'batch']);
export const platformStreamingSchema = z.record(identityPlatformSchema, streamingModeSchema);
export type PlatformStreaming = z.infer<typeof platformStreamingSchema>;

/** An install-level chat route for attention notices. `destination` is opaque to Archon. */
export const attentionNoticeRouteSchema = z.object({
  platform: identityPlatformSchema,
  destination: z.string().min(1),
});
export type AttentionNoticeRoute = z.infer<typeof attentionNoticeRouteSchema>;
/** The id a route's ledger rows and health entry carry; a platform cannot contain ':'. */
export function attentionNoticeRouteId(route: AttentionNoticeRoute): string {
  return `${route.platform}:${route.destination}`;
}
export const attentionNoticeRoutesSchema = z
  .array(attentionNoticeRouteSchema)
  .superRefine((routes, ctx) => {
    const seen = new Set<string>();
    for (const [index, route] of routes.entries()) {
      const id = attentionNoticeRouteId(route);
      if (seen.has(id))
        ctx.addIssue({ code: 'custom', path: [index], message: `duplicate route '${id}'` });
      seen.add(id);
    }
  });

/**
 * Global configuration (non-secret user preferences)
 * Located at ~/.archon/config.yaml
 */

// Provider config defaults — each type is derived from its provider's config
// schema and re-exported through @archon/providers/types.
import type {
  ClaudeProviderDefaults,
  CodexProviderDefaults,
  CopilotProviderDefaults,
  PiProviderDefaults,
  ProviderDefaultsMap,
} from '@archon/providers/types';
import type { RawAliasesConfig, RawTiersConfig } from '@archon/workflows/model-validation';
import {
  workflowRunContinuationConfigSchema,
  type WorkflowRunConfigLayer,
} from '@archon/workflows/schemas/run-config';

export type {
  ClaudeProviderDefaults,
  CodexProviderDefaults,
  CopilotProviderDefaults,
  PiProviderDefaults,
  ProviderDefaultsMap,
};
export type { RawAliasesConfig, RawTiersConfig };

/**
 * Intersection type: generic `ProviderDefaultsMap` (any string key) with
 * typed built-in entries.
 *
 * The built-in entries exist ONLY to give call sites like
 * `config.assistants.claude.model` IDE autocomplete without `as` casts.
 * They do NOT provide parser safety (each provider's `parseXxxConfig`
 * already takes `Record<string, unknown>` and defends itself).
 *
 * Community providers should NOT be added here — they live behind the
 * generic `[string]` index. Adding a new community provider must not
 * require a core-package type change; that's the whole point of Phase 2.
 */
export type AssistantDefaultsConfig = ProviderDefaultsMap & {
  claude?: ClaudeProviderDefaults;
  codex?: CodexProviderDefaults;
};

/**
 * Required variant — built-ins are always present after `loadConfig`.
 *
 * `getDefaults()` seeds every registered provider (built-in + community)
 * with `{}`, so community providers appear in the map too — just typed as
 * `ProviderDefaults` via the generic index rather than a specific shape.
 * `getDefaults()` also seeds claude and codex, so their slots exist even when
 * a release binary has not installed those providers.
 */
export type AssistantDefaults = ProviderDefaultsMap & {
  claude: ClaudeProviderDefaults;
  codex: CodexProviderDefaults;
};

/**
 * Container isolation backend settings (folder projects only). Valid on both
 * global and repo config; repo overrides global per-field. Defaults are applied
 * when the CLI builds the backend config, not here (all fields optional).
 */
export interface ContainerConfig {
  /**
   * Runner image tag. Defaults to `archon-runner:latest` — the `build:runner-image`
   * script tags both `archon-runner:<version>` and `:latest`, and defaulting to
   * `:latest` avoids coupling to the dev-vs-binary version string. Pin an explicit
   * version tag here for reproducibility.
   * @default 'archon-runner:latest'
   */
  image?: string;

  /**
   * Container network mode. `none` disables egress; `bridge` is default NAT.
   * @default 'bridge'
   */
  network?: 'bridge' | 'none';

  /**
   * Hard memory cap in MiB (`docker run --memory <n>m`).
   * @default 4096
   */
  memoryMb?: number;

  /**
   * Process cap (`docker run --pids-limit <n>`) — a fork-bomb guard.
   * @default 512
   */
  pidsLimit?: number;

  /**
   * Opt folder projects into the container backend WITHOUT the `--container`
   * flag. The flag still wins when passed; workflow-level `container.enabled`
   * sits between the flag and this config default.
   * @default false
   */
  enabled?: boolean;
}

export interface GlobalConfig {
  store?: WorkflowStoreKind;
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
   * Named model aliases accessible in workflow/node `model:` fields.
   * Keys must use `@<name>` prefix (e.g. `@cheap`) — bare names are not
   * reachable as aliases. Reserved names (enforced at runtime): small, medium, large.
   */
  aliases?: RawAliasesConfig;

  /**
   * Cross-provider model tier presets accessible as small/medium/large in
   * workflow/node `model:` fields.
   */
  tiers?: RawTiersConfig;

  /**
   * Platform streaming preferences
   */
  streaming?: PlatformStreaming;

  /**
   * Chat routes that receive a notice when a run needs attention, and a follow-up
   * when it ends. Global only: repository config never carries routes.
   */
  attentionNotices?: AttentionNoticeRoute[];

  /**
   * Concurrency limits
   */
  concurrency?: {
    /**
     * Maximum concurrent AI conversations
     * @default 10
     */
    maxConversations?: number;
    /**
     * Opt-in install-wide cap on simultaneous provider attempts, keyed by provider
     * registration ID (e.g. `claude: 4`). Pi also honors `assistants.pi.maxConcurrent`.
     * Read fresh and strictly at every attempt by `loadProviderConcurrencyCaps`.
     */
    providers?: Record<string, number>;
  };

  /**
   * Container isolation backend defaults (folder projects). Repo config
   * overrides these per-field.
   */
  container?: ContainerConfig;

  /** Operator policy for live tool attention and quota continuation. */
  workflows?: WorkflowContinuationConfig;
}

// Ordinary global/repo config remains forward-compatible: unlike the explicitly
// selected run layer, it strips extension keys it does not understand yet.
export const workflowContinuationConfigSchema = workflowRunContinuationConfigSchema.strip();
export type WorkflowContinuationConfig = NonNullable<WorkflowRunConfigLayer['workflows']>;

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

  /** Repo-level model aliases — override global aliases with same name. */
  aliases?: RawAliasesConfig;

  /** Repo-level model tier presets — override global tiers with same name. */
  tiers?: RawTiersConfig;

  /** Project override for live tool attention and quota continuation. */
  workflows?: WorkflowContinuationConfig;

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
  worktree?: WorktreeCreateConfig;

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
   * Container isolation backend settings for this repo (folder projects).
   * Overrides global `container` per-field.
   */
  container?: ContainerConfig;

  /**
   * Per-project environment variables injected into Claude SDK subprocess env.
   * Values here override process.env for workflow node execution.
   * Sensitive — do not commit actual secrets to version-controlled repos.
   */
  env?: Record<string, string>;

  /**
   * Repo-owner-curated list of recommended workflow names, in display order.
   * The console new-run picker shows these under "Recommended for this project"
   * and remaining choices under "Other workflows". Names not matching any
   * discovered workflow are silently ignored (advisory).
   */
  recommendedWorkflows?: string[];

  /**
   * Default commands/workflows configuration
   */
  defaults?: {
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
  assistant: string | undefined;
  assistants: AssistantDefaults;
  /**
   * Merged aliases (repo > global). Used by buildAiProfile at execution time.
   * Undefined when no aliases are configured anywhere.
   */
  aliases?: RawAliasesConfig;
  /**
   * Merged model tiers (repo > global). Used by buildAiProfile at execution time.
   * Undefined when no tiers are configured anywhere.
   */
  tiers?: RawTiersConfig;
  streaming: PlatformStreaming;
  attentionNotices: AttentionNoticeRoute[];
  concurrency: {
    maxConversations: number;
  };
  workflows: ResolvedWorkflowPolicy;
  commands: {
    /**
     * Additional command folder to search (relative to repo root)
     * Searched after .archon/commands/ but before .claude/commands/
     */
    folder?: string;
    autoLoad: boolean;
  };
  defaults: {
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
   * Git remote name from repo config (worktree.remote).
   * When undefined, callers auto-detect at runtime via getDefaultRemote()
   * or fall back to 'origin'.
   */
  remote?: string;
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
   * Merged container backend settings (repo `container` over global `container`,
   * per-field). Raw optional fields — defaults are applied where the container
   * config is consumed (CLI folder branch). Undefined when nothing is configured.
   */
  container?: ContainerConfig;
}

/**
 * Safe subset of MergedConfig suitable for sending to web clients.
 * Excludes filesystem paths and any other server-internal fields.
 */
export interface SafeConfig {
  botName: string;
  assistant: string | undefined;
  assistants: ProviderDefaultsMap;
  streaming: PlatformStreaming;
  concurrency: {
    maxConversations: number;
  };
  defaults: MergedConfig['defaults'];
  /** Configured small/medium/large tier presets (merged repo > global). */
  tiers?: RawTiersConfig;
  /**
   * Built-in tier presets for the current default provider (from
   * tier-defaults.json via buildAiProfile). Lets the editor show what an
   * unset tier resolves to without the web bundle importing @archon/workflows.
   */
  tierDefaults?: RawTiersConfig;
  /** Configured @custom model aliases (merged repo > global). Not secrets. */
  aliases?: RawAliasesConfig;
}
