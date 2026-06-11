/**
 * Workflow Executor - runs DAG-based workflows
 */
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { IWorkflowPlatform, WorkflowMessageMetadata } from './deps';
import type { WorkflowDeps, WorkflowConfig } from './deps';
import * as archonPaths from '@archon/paths';
import { createLogger, captureWorkflowInvoked, captureWorkflowCompleted } from '@archon/paths';
import { getDefaultBranch, toRepoPath } from '@archon/git';
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowExecutionResult,
  WorkflowSource,
} from './schemas';
import { isLoopNode, isApprovalNode, isScriptNode, isBashNode } from './schemas';
import { executeDagWorkflow } from './dag-executor';
import { logWorkflowStart, logWorkflowError } from './logger';
import { formatDuration, parseDbTimestamp } from './utils/duration';
import { getWorkflowEventEmitter } from './event-emitter';
import { isRegisteredProvider, getRegisteredProviders } from '@archon/providers';
import {
  classifyError,
  toTelemetryErrorClass,
  safeSendMessage,
  type SendMessageContext,
} from './executor-shared';
import { resolveGithubTokenOverrides } from './utils/github-token-policy';
import { buildAiProfile, isLiteralSpec, resolveModelSpec } from './model-validation';
import type { ModelAliasPreset, ResolvedAiProfile } from './model-validation';

/** The per-user prefs layer as returned by `WorkflowDeps.getUserAiPrefs`. */
type UserAiPrefsLayer = Awaited<ReturnType<NonNullable<WorkflowDeps['getUserAiPrefs']>>>;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

/**
 * Delay execution for specified milliseconds
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a critical message with retry logic.
 * Used for failure/completion notifications that the user must receive.
 */
async function sendCriticalMessage(
  platform: IWorkflowPlatform,
  conversationId: string,
  message: string,
  context?: SendMessageContext,
  maxRetries = 3,
  metadata?: WorkflowMessageMetadata
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await platform.sendMessage(conversationId, message, metadata);
      return true;
    } catch (error) {
      const err = error as Error;
      const errorType = classifyError(err);

      getLog().error(
        {
          err,
          conversationId,
          messageLength: message.length,
          errorType,
          platformType: platform.getPlatformType(),
          ...context,
          attempt,
          maxRetries,
        },
        'platform.critical_message_send_failed'
      );

      // Don't retry fatal errors
      if (errorType === 'FATAL') {
        break;
      }

      // Wait before retry (exponential backoff: 1s, 2s, 3s...)
      if (attempt < maxRetries) {
        await delay(1000 * attempt);
      }
    }
  }

  // Log prominently so operators can manually notify user
  getLog().error(
    { conversationId, messagePreview: message.slice(0, 100), ...context },
    'critical_message_delivery_failed'
  );

  return false;
}

/**
 * Parse `owner/repo` from a github.com URL. Returns null for non-GitHub URLs
 * so the caller can fall through to env-inheritance.
 *
 *   https://github.com/owner/repo.git   → { owner, repo }
 *   https://github.com/owner/repo       → { owner, repo }
 *   git@github.com:owner/repo.git       → { owner, repo }
 *   <anything else>                     → null
 */
function parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
  // HTTPS form
  const https = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (https) return { owner: https[1], repo: https[2] };
  // SSH form (git@github.com:owner/repo[.git])
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

/**
 * Resolve a fresh GH_TOKEN/GITHUB_TOKEN pair from the registered bot-token
 * provider, if any. Used at the top of executeWorkflow to inject the token
 * into the workflow's envVars so bash/script subprocesses pick it up.
 *
 * Contract: NEVER THROWS. On any failure (no codebase, non-GitHub URL,
 * provider rejected, network blip) returns {} — the workflow continues with
 * whatever env inheritance was already in place. This matches the
 * resolveBotGitHubToken? contract in deps.ts.
 */
async function resolveBotGitHubEnvForWorkflow(
  deps: WorkflowDeps,
  codebaseId: string | undefined
): Promise<Record<string, string>> {
  if (!codebaseId || !deps.resolveBotGitHubToken) return {};
  try {
    const codebase = await deps.store.getCodebase(codebaseId);
    if (!codebase?.repository_url) return {};
    const parsed = parseGithubRepoUrl(codebase.repository_url);
    if (!parsed) return {};
    const token = await deps.resolveBotGitHubToken(parsed.owner, parsed.repo);
    if (!token) return {};
    getLog().debug(
      { owner: parsed.owner, repo: parsed.repo },
      'workflow.bot_github_token_injected'
    );
    return { GH_TOKEN: token, GITHUB_TOKEN: token };
  } catch (err) {
    // Resolution failure must not block the workflow — log and fall back.
    getLog().warn({ err: err as Error, codebaseId }, 'workflow.bot_github_token_resolve_failed');
    return {};
  }
}

/**
 * Resolve per-user GitHub token overrides for a run. When per-user mode is on
 * and the run has an originating user, this routes `gh`/`git push` through the
 * user's personal token — or scrubs the org/bot token when they haven't
 * connected (see {@link resolveGithubTokenOverrides}). Returns {} (no opinion)
 * for server-initiated runs and solo installs, leaving the bot env untouched.
 */
async function resolveUserGithubEnvForWorkflow(
  deps: WorkflowDeps,
  userId: string | undefined
): Promise<Record<string, string>> {
  const perUserEnabled = deps.isPerUserGitHubEnabled?.() ?? false;
  if (!perUserEnabled) return {};
  let userToken: string | undefined;
  if (userId && deps.getUserGithubToken) {
    try {
      userToken = await deps.getUserGithubToken(userId);
    } catch (err) {
      getLog().warn({ err: err as Error, userId }, 'workflow.user_github_token_resolve_failed');
    }
  }
  return resolveGithubTokenOverrides(perUserEnabled, userId, userToken);
}

/**
 * Resolve per-user AI-provider credential env (Phase 2) for a run, and write
 * any file-based deliveries (e.g. Codex `CODEX_HOME/auth.json`) under the
 * run's artifacts directory. Returns the env bag to merge LAST into
 * `config.envVars` so a connected user's keys win over file/db/bot-github
 * env. Returns `{}` when per-user provider keys are disabled, no userId is
 * present, or the deps adapter is absent.
 *
 * Contract: NEVER THROWS. Adapter failures are logged and yield `{}` so the
 * workflow continues with whatever env inheritance was already in place.
 */
async function resolveUserProviderEnvForWorkflow(
  deps: WorkflowDeps,
  userId: string | undefined,
  artifactsDir: string
): Promise<Record<string, string>> {
  const perUserEnabled = deps.isPerUserProviderKeysEnabled?.() ?? false;
  if (!perUserEnabled || !userId || !deps.getUserProviderEnv) return {};
  try {
    // TODO(#1891 PR-3): when Codex OAuth delivery is enabled, file-write failures
    // must drop only the affected provider's env keys, not all of them. Move file
    // writes into getUserProviderEnv per-delivery so env + write are atomic
    // per-provider, or wrap each write in a per-file try-catch that strips the
    // matching env keys on failure. Currently safe: no OAuth rows can be created
    // in PR-1 so `files` is always empty and this loop never executes.
    const { env, files } = await deps.getUserProviderEnv(userId, artifactsDir);
    for (const f of files) {
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.contents, { encoding: 'utf8', mode: 0o600 });
    }
    const envKeys = Object.keys(env);
    if (envKeys.length > 0) {
      getLog().debug({ userId, keys: envKeys }, 'workflow.user_provider_env_injected');
    }
    return env;
  } catch (err) {
    getLog().warn({ err: err as Error, userId }, 'workflow.user_provider_env_resolve_failed');
    return {};
  }
}

/**
 * Resolve the artifacts and log directories for a workflow run.
 * Looks up the codebase by ID once, parses owner/repo, and returns project-scoped paths.
 * Falls back to cwd-based paths for unregistered repos.
 */
async function resolveProjectPaths(
  deps: WorkflowDeps,
  cwd: string,
  workflowRunId: string,
  codebaseId?: string
): Promise<{ artifactsDir: string; logDir: string }> {
  if (codebaseId) {
    try {
      const codebase = await deps.store.getCodebase(codebaseId);
      if (codebase) {
        const parsed = archonPaths.parseOwnerRepo(codebase.name);
        if (parsed) {
          return {
            artifactsDir: archonPaths.getRunArtifactsPath(parsed.owner, parsed.repo, workflowRunId),
            logDir: archonPaths.getProjectLogsPath(parsed.owner, parsed.repo),
          };
        }
        getLog().warn({ codebaseName: codebase.name }, 'codebase_name_not_owner_repo_format');
      }
    } catch (error) {
      const fallbackArtifactsDir = join(cwd, '.archon', 'artifacts', 'runs', workflowRunId);
      getLog().error(
        { err: error as Error, codebaseId, fallbackArtifactsDir },
        'project_paths_resolve_failed_using_fallback'
      );
    }
  }
  // Fallback for unregistered repos
  return {
    artifactsDir: join(cwd, '.archon', 'artifacts', 'runs', workflowRunId),
    logDir: join(cwd, '.archon', 'logs'),
  };
}

/**
 * Resume payload. `priorCompletedNodes` may only appear together with
 * `preCreatedRun` — passing completed-node outputs without the resumed row
 * would silently inject node-skip state into a freshly-created run. Lock-token
 * rows (used by `dispatchBackgroundWorkflow`) supply `preCreatedRun` alone.
 */
type ResumePayload =
  | { preCreatedRun: WorkflowRun; priorCompletedNodes?: Map<string, string> }
  | { preCreatedRun?: undefined; priorCompletedNodes?: undefined };

/**
 * Optional parameters for {@link executeWorkflow}. All trailing args live here
 * so call sites stay readable as new options accrue.
 *
 * To resume a prior run, obtain `preCreatedRun` + `priorCompletedNodes` from
 * {@link hydrateResumableRun} (or look up via `findResumableRun` and hydrate)
 * and spread them in. The executor never queries the store for a prior run on
 * its own; that decision belongs at the call site.
 */
export type ExecuteWorkflowOptions = ResumePayload & {
  /** Codebase ID for env vars + isolation context. */
  codebaseId?: string;
  /**
   * GitHub issue/PR context. When provided:
   * - Stored in `WorkflowRun.metadata` as `{ github_context }`
   * - Substituted into `$CONTEXT` / `$EXTERNAL_CONTEXT` / `$ISSUE_CONTEXT` variables
   * - Appended to prompts that reference none of those variables
   * Expected format: Markdown with title, author, labels, and body.
   */
  issueContext?: string;
  /** Worktree / branch metadata for isolation-aware nodes. */
  isolationContext?: {
    branchName?: string;
    isPrReview?: boolean;
    prSha?: string;
    prBranch?: string;
  };
  /**
   * Discovery source of the workflow (bundled / global / project). Used only
   * for anonymous telemetry — bundled workflows report their real name, custom
   * ones report `"custom"`. Optional: defaults to the `"custom"`/project
   * treatment when a caller doesn't thread it through.
   */
  source?: WorkflowSource;
  /** Parent conversation ID — enables approve/reject auto-resume from chat. */
  parentConversationId?: string;
  /**
   * Archon user UUID for attribution on the workflow_run row. Resolved by
   * chat/forge adapters via findOrCreateUserByPlatformIdentity. Web/CLI paths
   * pass undefined until their own auth surfaces are wired.
   * Ignored when `preCreatedRun` is set — the original creator's attribution
   * is preserved on resume.
   */
  userId?: string;
};

/**
 * Hydrate an already-located resumable `WorkflowRun` candidate into the form
 * {@link executeWorkflow} expects. Returns `null` when the candidate has no
 * completed nodes and no interactive-loop gate state — nothing worth resuming.
 *
 * The return shape is spread-compatible with {@link ExecuteWorkflowOptions}
 * so callers can write `executeWorkflow(..., { ...hydrated, codebaseId })`.
 *
 * Throws on database errors; callers decide whether to surface or fall
 * through. The executor itself never performs this lookup — silent fallback
 * inside the executor was the cross-invocation auto-resume bug, so it stays
 * at the call site.
 */
export async function hydrateResumableRun(
  deps: WorkflowDeps,
  candidate: WorkflowRun
): Promise<{ preCreatedRun: WorkflowRun; priorCompletedNodes: Map<string, string> } | null> {
  const priorCompletedNodes = await deps.store.getCompletedDagNodeOutputs(candidate.id);
  const hasInteractiveLoopState =
    candidate.metadata?.approval !== undefined &&
    (candidate.metadata.approval as Record<string, unknown>).type === 'interactive_loop';
  if (priorCompletedNodes.size === 0 && !hasInteractiveLoopState) {
    getLog().info(
      { resumableRunId: candidate.id },
      'workflow.dag_resume_skipped_no_completed_nodes'
    );
    return null;
  }
  const preCreatedRun = await deps.store.resumeWorkflowRun(candidate.id);
  getLog().info(
    { workflowRunId: preCreatedRun.id, priorCompletedCount: priorCompletedNodes.size },
    'workflow.dag_resuming'
  );
  return { preCreatedRun, priorCompletedNodes };
}

/**
 * Execute a complete DAG-based workflow.
 *
 * Required positional args carry identity and dependencies. Everything else
 * lives in `opts` ({@link ExecuteWorkflowOptions}). To resume a prior run,
 * call {@link hydrateResumableRun} first and spread its result into `opts` —
 * the executor does not perform resume detection on its own.
 */
export async function executeWorkflow(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: WorkflowDefinition,
  userMessage: string,
  conversationDbId: string,
  opts: ExecuteWorkflowOptions = {}
): Promise<WorkflowExecutionResult> {
  const {
    codebaseId,
    issueContext,
    isolationContext,
    parentConversationId,
    preCreatedRun,
    priorCompletedNodes,
    userId,
    source,
  } = opts;
  // Load config once for the entire workflow execution
  const fileConfig = await deps.loadConfig(cwd);
  const dbEnvVars = codebaseId ? await deps.store.getCodebaseEnvVars(codebaseId) : {};
  // Resolve a fresh bot GitHub token once at workflow start when:
  //   (a) the codebase URL is a github.com repo, and
  //   (b) deps.resolveBotGitHubToken is registered (App mode).
  // Injected into envVars so bash/script subprocesses authenticate `gh` and
  // initial `git push` via inherited GH_TOKEN. Workflows that run >1h still
  // need the credential helper for live token rotation (handled at clone
  // time in the GitHub adapter), but the env injection is enough for the
  // typical <1h workflow.
  const botGitHubEnv = await resolveBotGitHubEnvForWorkflow(deps, codebaseId);
  const userGitHubEnv = await resolveUserGithubEnvForWorkflow(deps, userId);
  const config: WorkflowConfig = {
    ...fileConfig,
    // Order: file < db < bot-token < per-user. Per-codebase env vars are
    // operator-set; the injected bot token is system-set; the per-user override
    // wins last so a run routes through the originating human's token (or scrubs
    // the org/bot token when they haven't connected). Empty-string values from
    // the per-user policy scrub the corresponding key via the subprocess merge.
    envVars: { ...fileConfig.envVars, ...dbEnvVars, ...botGitHubEnv, ...userGitHubEnv },
  };
  const configuredCommandFolder = config.commands.folder;

  // Auto-detect base branch when not configured. Config takes priority.
  // If detection fails, leave empty — substituteWorkflowVariables throws only if $BASE_BRANCH is referenced.
  let baseBranch: string;
  if (config.baseBranch) {
    baseBranch = config.baseBranch;
  } else {
    try {
      baseBranch = await getDefaultBranch(toRepoPath(cwd));
    } catch (error) {
      // Intentional fallback: auto-detection failure is non-fatal.
      // substituteWorkflowVariables throws if $BASE_BRANCH is actually referenced in a prompt.
      getLog().warn(
        { err: error as Error, errorType: (error as Error).constructor.name, cwd },
        'workflow.base_branch_auto_detect_failed'
      );
      baseBranch = '';
    }
  }

  const docsDir = config.docsPath ?? 'docs/';

  // Per-user AI prefs (Phase 3): the originating user's tiers/aliases/default-
  // assistant override install config (highest precedence). The dep contract is
  // non-throwing, but a third-party deps impl might throw anyway — guard so a
  // prefs failure can never abort a run; `{}` keeps config-only behavior.
  let userAiPrefs: UserAiPrefsLayer = {};
  if (userId && deps.getUserAiPrefs) {
    try {
      userAiPrefs = await deps.getUserAiPrefs(userId);
    } catch (error) {
      getLog().warn({ err: error as Error, userId }, 'workflow.user_ai_prefs_resolve_failed');
    }
  }
  if (userAiPrefs.tiers || userAiPrefs.aliases || userAiPrefs.defaultProvider) {
    getLog().debug(
      {
        userId,
        tierKeys: Object.keys(userAiPrefs.tiers ?? {}),
        aliasKeys: Object.keys(userAiPrefs.aliases ?? {}),
        defaultProvider: userAiPrefs.defaultProvider,
      },
      'workflow.user_ai_prefs_applied'
    );
  }
  let aiProfile: ResolvedAiProfile;
  try {
    aiProfile = buildAiProfile(userAiPrefs.defaultProvider ?? config.assistant, {
      repoTiers: config.tiers,
      repoAliases: config.aliases,
      userTiers: userAiPrefs.tiers,
      userAliases: userAiPrefs.aliases,
    });
  } catch (error) {
    // Structurally invalid STORED prefs (corrupt DB row) must not kill the run
    // before its record exists — degrade to config-only. A broken config layer
    // still fails fast: the rebuild below rethrows the same error.
    getLog().error({ err: error as Error, userId }, 'workflow.user_ai_prefs_profile_invalid');
    aiProfile = buildAiProfile(config.assistant, {
      repoTiers: config.tiers,
      repoAliases: config.aliases,
    });
  }

  // Resolve provider and model once (used by all nodes). Literal model strings
  // keep the existing workflow/provider/config chain; tier and @alias refs use
  // the resolved preset provider/model so bundled workflows are portable.
  let resolvedProvider: string = workflow.provider ?? config.assistant;
  let resolvedModel: string | undefined;
  let workflowPreset: ModelAliasPreset | undefined;
  let providerSource = workflow.provider ? 'workflow definition' : 'config';
  if (workflow.model) {
    const workflowModelSpec = resolveModelSpec(aiProfile, workflow.model);
    if (isLiteralSpec(workflowModelSpec)) {
      resolvedModel = workflowModelSpec.literal;
    } else {
      workflowPreset = workflowModelSpec;
      if (workflow.provider && workflow.provider !== workflowModelSpec.provider) {
        getLog().warn(
          {
            workflowName: workflow.name,
            configuredProvider: workflow.provider,
            resolvedProvider: workflowModelSpec.provider,
            modelRef: workflow.model,
          },
          'workflow.model_provider_conflict'
        );
        const delivered = await safeSendMessage(
          platform,
          conversationId,
          `Warning: Workflow '${workflow.name}' sets provider '${workflow.provider}' but model '${workflow.model}' resolves to provider '${workflowModelSpec.provider}' — using '${workflowModelSpec.provider}'.`
        );
        if (!delivered) {
          getLog().error(
            { workflowName: workflow.name, conversationId },
            'workflow.model_provider_conflict_warning_delivery_failed'
          );
        }
      }
      resolvedProvider = workflowModelSpec.provider;
      resolvedModel = workflowModelSpec.model;
      providerSource = `model preset '${workflow.model}'`;
    }
  }

  if (!isRegisteredProvider(resolvedProvider)) {
    throw new Error(
      `Workflow '${workflow.name}': unknown provider '${resolvedProvider}'. ` +
        `Registered: ${getRegisteredProviders()
          .map(p => p.id)
          .join(', ')}`
    );
  }
  const assistantDefaults = config.assistants[resolvedProvider];
  resolvedModel ??= assistantDefaults?.model as string | undefined;

  getLog().info(
    {
      workflowName: workflow.name,
      provider: resolvedProvider,
      providerSource,
      model: resolvedModel,
    },
    'workflow_provider_resolved'
  );

  if (configuredCommandFolder) {
    getLog().debug({ configuredCommandFolder }, 'command_folder_configured');
  }

  // Workflow run + resume state. Caller decides whether to resume by passing
  // preCreatedRun (from hydrateResumableRun) + priorCompletedNodes via opts.
  // When both are absent the executor creates a fresh row below.
  const dagPriorCompletedNodes = priorCompletedNodes;
  let workflowRun: WorkflowRun | undefined = preCreatedRun;

  if (preCreatedRun && priorCompletedNodes !== undefined) {
    const resumeMsg =
      priorCompletedNodes.size > 0
        ? `▶️ **Resuming** workflow \`${workflow.name}\` — skipping ${String(priorCompletedNodes.size)} already-completed node(s).\n\nNote: AI session context from prior nodes is not restored. Nodes that depend on prior context may need to re-read artifacts.`
        : `▶️ **Resuming** workflow \`${workflow.name}\` — continuing interactive loop.`;
    await safeSendMessage(platform, conversationId, resumeMsg);
  }

  if (!workflowRun) {
    // Create workflow run record
    try {
      workflowRun = await deps.store.createWorkflowRun({
        workflow_name: workflow.name,
        conversation_id: conversationDbId,
        codebase_id: codebaseId,
        user_message: userMessage,
        working_path: cwd,
        metadata: issueContext ? { github_context: issueContext } : {},
        parent_conversation_id: parentConversationId,
        user_id: userId,
      });
    } catch (error) {
      const err = error as Error;
      getLog().error(
        { err, workflowName: workflow.name, conversationId },
        'db_create_workflow_run_failed'
      );
      await sendCriticalMessage(
        platform,
        conversationId,
        '❌ **Workflow failed**: Unable to start workflow (database error). Please try again later.'
      );
      return { success: false, error: 'Database error creating workflow run' };
    }
  }

  // Path-lock guard: ensure no other workflow run holds this working_path.
  //
  // Skipped when `workflow.mutates_checkout` is false — the author asserts
  // that concurrent runs will not race (e.g. all writes are per-run-scoped).
  //
  // Runs after workflowRun is finalized (pre-created, resumed, or freshly
  // created) so we always have self-ID + started_at for the deterministic
  // older-wins tiebreaker. The query treats `pending` rows older than 5 min
  // as orphaned, so leaks from crashed dispatches or resume orphans don't
  // permanently block the path.
  if (workflow.mutates_checkout !== false) {
    try {
      const activeWorkflow = await deps.store.getActiveWorkflowRunByPath(cwd, {
        id: workflowRun.id,
        startedAt: new Date(parseDbTimestamp(workflowRun.started_at)),
      });
      if (activeWorkflow) {
        // The lock query found another active row that wins the older-wins
        // tiebreaker. Mark our own row terminal so it falls out of the
        // active set immediately — without this, our row sits as
        // pending/running and blocks the path until the 5-min stale window
        // (or never, if we'd already promoted it to running via resume).
        await deps.store
          .updateWorkflowRun(workflowRun.id, { status: 'cancelled' })
          .catch((cleanupErr: Error) => {
            getLog().warn(
              { err: cleanupErr, workflowRunId: workflowRun?.id, cwd },
              'workflow.guard_self_cancel_failed'
            );
          });

        const elapsedMs = Date.now() - parseDbTimestamp(activeWorkflow.started_at);
        const duration = formatDuration(elapsedMs);
        const shortId = activeWorkflow.id.slice(0, 8);

        // Status-aware copy. The lock query returns running, paused, and
        // fresh-pending rows — telling the user to "wait for it to finish"
        // is wrong for `paused` (waiting on user action via approve/reject).
        let stateLine: string;
        let actionLines: string;
        if (activeWorkflow.status === 'paused') {
          stateLine = `paused waiting for user input (${duration} since started, run \`${shortId}\`)`;
          actionLines =
            `• Approve it: \`/workflow approve ${shortId}\`\n` +
            `• Reject it: \`/workflow reject ${shortId}\`\n` +
            `• Cancel it: \`/workflow cancel ${shortId}\`\n` +
            '• Use a different branch: `--branch <other>`';
        } else {
          const verb = activeWorkflow.status === 'pending' ? 'starting' : 'running';
          stateLine = `${verb} ${duration}, run \`${shortId}\``;
          actionLines =
            '• Wait for it to finish: `/workflow status`\n' +
            `• Cancel it: \`/workflow cancel ${shortId}\`\n` +
            '• Use a different branch: `--branch <other>`';
        }
        await sendCriticalMessage(
          platform,
          conversationId,
          `❌ **This worktree is in use** by \`${activeWorkflow.workflow_name}\` ` +
            `(${stateLine}).\n${actionLines}`
        );
        return {
          success: false,
          error: `Workflow already active on this path (${activeWorkflow.status}): ${activeWorkflow.workflow_name}`,
        };
      }
    } catch (error) {
      const err = error as Error;
      getLog().error(
        { err, conversationId, cwd, pendingRunId: workflowRun.id },
        'db_active_workflow_check_failed'
      );
      // Release the lock token. workflowRun is finalized at this point
      // (pre-created or resumed or freshly created) and would otherwise sit
      // as pending/running, blocking the path. For pending the 5-min stale
      // window would clear it eventually; for a row already promoted to
      // running (e.g., resumed), nothing would clear it without manual
      // intervention.
      await deps.store
        .updateWorkflowRun(workflowRun.id, { status: 'cancelled' })
        .catch((cleanupErr: Error) => {
          getLog().warn(
            { err: cleanupErr, workflowRunId: workflowRun?.id },
            'workflow.guard_query_failure_cleanup_failed'
          );
        });
      await sendCriticalMessage(
        platform,
        conversationId,
        '❌ **Workflow blocked**: Unable to verify if another workflow is running (database error). Please try again in a moment.'
      );
      return { success: false, error: 'Database error checking for active workflow' };
    }
  }

  // Resolve external artifact and log directories
  const { artifactsDir, logDir } = await resolveProjectPaths(deps, cwd, workflowRun.id, codebaseId);

  // Pre-create the artifacts directory so commands can write to it immediately
  try {
    await mkdir(artifactsDir, { recursive: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    getLog().error(
      { err, artifactsDir, workflowRunId: workflowRun.id },
      'workflow.artifacts_dir_create_failed'
    );
    await deps.store
      .failWorkflowRun(workflowRun.id, `Artifacts directory creation failed: ${err.message}`)
      .catch((dbErr: Error) => {
        getLog().error(
          { err: dbErr, workflowRunId: workflowRun.id },
          'workflow.artifacts_dir_fail_db_record_failed'
        );
      });
    await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Workflow failed**: Could not create artifacts directory \`${artifactsDir}\`: ${err.message}`
    );
    return {
      success: false,
      workflowRunId: workflowRun.id,
      error: `Artifacts directory creation failed: ${err.message}`,
    };
  }
  getLog().debug({ artifactsDir, logDir }, 'workflow_paths_resolved');

  // Per-user AI-provider credentials (Phase 2). Resolved AFTER artifactsDir is
  // created because file-based deliveries (Codex `CODEX_HOME/auth.json`) live
  // under it. Merged LAST into config.envVars so the originating user's keys
  // win over file/db/bot-github env — preserves the GitHub merge order and
  // keeps the no-key path byte-for-byte unchanged (resolveUserProviderEnvForWorkflow
  // returns {} when the feature is disabled or no userId is present).
  const userProviderEnv = await resolveUserProviderEnvForWorkflow(deps, userId, artifactsDir);
  config.envVars = { ...config.envVars, ...userProviderEnv };

  // Wrap execution in try-catch to ensure workflow is marked as failed on any error
  try {
    getLog().info(
      {
        workflowName: workflow.name,
        workflowRunId: workflowRun.id,
        hasIssueContext: !!issueContext,
        issueContextLength: issueContext?.length ?? 0,
      },
      'workflow_starting'
    );
    await logWorkflowStart(logDir, workflowRun.id, workflow.name, userMessage);

    // Register run with emitter and emit workflow_started
    const emitter = getWorkflowEventEmitter();
    emitter.registerRun(workflowRun.id, conversationId);

    emitter.emit({
      type: 'workflow_started',
      runId: workflowRun.id,
      workflowName: workflow.name,
      conversationId: conversationDbId,
    });

    // Fire-and-forget anonymous usage telemetry. Categorical only: bundled
    // workflows report their real name, custom ones report "custom". No PII —
    // descriptions/prompts/paths are never sent. Machine context + version ride
    // along as super-properties. Opt out: ARCHON_TELEMETRY_DISABLED=1 / DO_NOT_TRACK=1.
    captureWorkflowInvoked({
      workflowName: workflow.name,
      workflowSource: source,
      platform: platform.getPlatformType(),
      provider: resolvedProvider,
      model: resolvedModel,
      nodeCount: workflow.nodes.length,
      usesLoop: workflow.nodes.some(isLoopNode),
      usesApproval: workflow.nodes.some(isApprovalNode),
      usesScript: workflow.nodes.some(isScriptNode),
      usesBash: workflow.nodes.some(isBashNode),
      usesOutputFormat: workflow.nodes.some(n => n.output_format !== undefined),
      usesOutputType: workflow.nodes.some(n => n.output_type !== undefined),
      usesPersistSession:
        workflow.persist_sessions === true || workflow.nodes.some(n => n.persist_session === true),
      usesMcp: workflow.nodes.some(n => n.mcp !== undefined),
      usesSkills: workflow.nodes.some(n => n.skills !== undefined),
      usesFreshContext: workflow.nodes.some(n => isLoopNode(n) && n.loop.fresh_context),
      interactive: workflow.interactive ?? false,
      usedIsolation: isolationContext !== undefined,
      isResume: dagPriorCompletedNodes !== undefined,
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'workflow_started',
        data: { workflowName: workflow.name },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'workflow_started' },
          'workflow_event_persist_failed'
        );
      });

    // Set status to running now that execution has started (skip for resumed runs — already running)
    if (!dagPriorCompletedNodes) {
      try {
        await deps.store.updateWorkflowRun(workflowRun.id, { status: 'running' });
      } catch (dbError) {
        getLog().error(
          { err: dbError as Error, workflowRunId: workflowRun.id },
          'db_workflow_status_update_failed'
        );
        await sendCriticalMessage(
          platform,
          conversationId,
          'Workflow blocked: Unable to update status. Please try again.'
        );
        return { success: false, error: 'Database error setting workflow to running' };
      }
    }

    // Context for error logging
    const workflowContext: SendMessageContext = {
      workflowId: workflowRun.id,
    };

    // Build startup message
    let startupMessage = '';

    // Add isolation context to startup message
    if (isolationContext) {
      const { isPrReview, prSha, prBranch, branchName } = isolationContext;

      if (isPrReview && prSha && prBranch) {
        startupMessage += `Reviewing PR at commit \`${prSha.substring(0, 7)}\` (branch: \`${prBranch}\`)\n\n`;
      } else if (branchName) {
        const repoName = cwd.split(/[/\\]/).pop() || 'repository';
        await sendCriticalMessage(
          platform,
          conversationId,
          `📍 ${repoName} @ \`${branchName}\``,
          workflowContext,
          2,
          { category: 'isolation_context', segment: 'new' }
        );
      } else {
        getLog().warn(
          {
            workflowId: workflowRun.id,
            hasFields: {
              isPrReview: !!isPrReview,
              prSha: !!prSha,
              prBranch: !!prBranch,
              branchName: !!branchName,
            },
          },
          'isolation_context_incomplete'
        );
      }
    }

    // Add workflow start message (step details omitted from text notification)
    // Strip routing metadata from description (Use when:, Handles:, NOT for:, Capability:, Triggers:)
    const cleanDescription = (workflow.description ?? '')
      .split('\n')
      .filter(
        line =>
          !/^\s*(Use when|Handles|NOT for|Capability|Triggers)[:\s]/i.test(line) && line.trim()
      )
      .join('\n')
      .trim();
    const descriptionText = cleanDescription || workflow.name;
    startupMessage += `🚀 **Starting workflow**: \`${workflow.name}\`\n\n> ${descriptionText}`;

    // Send consolidated message - use critical send with limited retries (1 retry max)
    // to avoid blocking workflow execution while still catching transient failures
    const startupSent = await sendCriticalMessage(
      platform,
      conversationId,
      startupMessage,
      workflowContext,
      2, // maxRetries=2 means 2 total attempts (1 initial + 1 retry), 1s max delay
      { category: 'workflow_status', segment: 'new' }
    );
    if (!startupSent) {
      getLog().error(
        { workflowId: workflowRun.id, conversationId },
        'startup_message_delivery_failed'
      );
      // Continue anyway - workflow is already recorded in database
    }

    // Execute the DAG workflow
    const dagSummary = await executeDagWorkflow(
      deps,
      platform,
      conversationId,
      cwd,
      workflow,
      workflowRun,
      resolvedProvider,
      resolvedModel,
      artifactsDir,
      logDir,
      baseBranch,
      docsDir,
      config,
      configuredCommandFolder,
      issueContext,
      dagPriorCompletedNodes,
      source,
      aiProfile,
      workflowPreset
    );

    // executeDagWorkflow throws on fatal errors; check DB status for result
    const finalStatus = await deps.store.getWorkflowRun(workflowRun.id);
    if (finalStatus?.status === 'completed') {
      return { success: true, workflowRunId: workflowRun.id, summary: dagSummary };
    } else if (finalStatus?.status === 'paused') {
      return { success: true, paused: true, workflowRunId: workflowRun.id };
    } else {
      return {
        success: false,
        workflowRunId: workflowRun.id,
        error: 'Workflow did not complete successfully',
      };
    }
  } catch (error) {
    // Top-level error handler: ensure workflow is marked as failed
    const err = error as Error;
    getLog().error(
      { err, workflowName: workflow.name, workflowId: workflowRun.id },
      'workflow_execution_unhandled_error'
    );

    // Record failure in database (non-blocking - log but don't re-throw on DB error)
    try {
      await deps.store.failWorkflowRun(workflowRun.id, err.message);
    } catch (dbError) {
      getLog().error(
        { err: dbError as Error, workflowId: workflowRun.id, originalError: err.message },
        'db_record_failure_failed'
      );
    }

    // Log to file (separate from database - non-blocking)
    try {
      await logWorkflowError(logDir, workflowRun.id, err.message);
    } catch (logError) {
      getLog().error(
        { err: logError as Error, workflowId: workflowRun.id },
        'workflow_error_log_write_failed'
      );
    }

    // Emit workflow_failed event
    const emitter = getWorkflowEventEmitter();
    emitter.emit({
      type: 'workflow_failed',
      runId: workflowRun.id,
      workflowName: workflow.name,
      error: err.message,
    });
    // Anonymous telemetry for the unhandled-throw failure path. The DAG-internal
    // failure paths (no/partial completion) fire their own captureWorkflowCompleted
    // and return without throwing, so this only covers genuine unhandled errors —
    // no double-count. Duration/node-counts are not in scope here.
    captureWorkflowCompleted({
      outcome: 'failed',
      workflowName: workflow.name,
      workflowSource: source,
      provider: resolvedProvider,
      exitReason: 'unhandled_error',
      // Categorical class only (fatal/transient/unknown) — err.message never leaves.
      errorClass: toTelemetryErrorClass(classifyError(err)),
    });
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'workflow_failed',
        data: { error: err.message },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'workflow_failed' },
          'workflow_event_persist_failed'
        );
      });
    emitter.unregisterRun(workflowRun.id);

    // Notify user about the failure
    const delivered = await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Workflow failed**: ${err.message}`
    );
    if (!delivered) {
      getLog().error(
        { workflowId: workflowRun.id, originalError: err.message },
        'user_failure_notification_failed'
      );
    }
    // Return failure result instead of re-throwing
    return { success: false, workflowRunId: workflowRun.id, error: err.message };
  } finally {
    // Defensive backstop: if the workflow run is still 'running' after all
    // normal and exceptional code paths, flip it to 'failed' to prevent zombie
    // accumulation. Guards against any future code path that exits without
    // calling failWorkflowRun (e.g. a generator cleanup that exits without
    // throwing). Only fires when the process stays alive long enough to run
    // this finally — see #1561 for the originating zombie-state incident.
    if (workflowRun) {
      const runId = workflowRun.id;
      const backstopStatus = await deps.store.getWorkflowRunStatus(runId).catch(() => null);
      if (backstopStatus === 'running') {
        getLog().warn({ workflowRunId: runId }, 'executor.backstop_triggered');
        await deps.store
          .failWorkflowRun(runId, 'Workflow exited without finalizing — see logs')
          .catch((err: unknown) => {
            getLog().error({ err, workflowRunId: runId }, 'executor.backstop_fail_failed');
          });
      }
    }
  }
}
