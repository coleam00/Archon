/**
 * Workflow Executor - runs DAG-based workflows
 */
import { mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS } from './deps';
import type { IWorkflowPlatform, WorkflowMessageMetadata } from './deps';
import type { WorkflowDeps } from './deps';
import * as archonPaths from '@archon/paths';
import { createLogger, captureWorkflowInvoked, captureWorkflowCompleted } from '@archon/paths';
import { getDefaultBranch, toRepoPath } from '@archon/git';
import type {
  DagNode,
  IncludeDirective,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowExecutionResult,
  WorkflowSource,
  WorkflowRunNodeSession,
} from './schemas';
import {
  isLoopNode,
  isLoopGroupNode,
  isGateNode,
  isExecNode,
  isApprovalContext,
  isRunBlockedOnChild,
  reRunsOwnNodeOnResume,
  isWorkflowWaitContext,
  isScheduledWorkflowResume,
  isWaitNode,
  SUBRUN_METADATA_KEYS,
  readSubrunMetadata,
  RUN_METADATA_KEYS,
  readIdentityUnresolved,
  CONTINUATION_METADATA_KEY,
  WORKFLOW_SOURCE_METADATA_KEY,
  readWorkflowSourceState,
} from './schemas';
import {
  WorkflowSourceIntegrityError,
  captureWorkflowSource,
  capturedSourceRoots,
  getRunSourceCapturePath,
  loadWorkflowSource,
  recordSelectedWorkflow,
  resolveRunSourceCapture,
  resolveChildDiscoveryRoot,
  type WorkflowSourceManifest,
  type WorkflowSourceConfig,
  type WorkflowSourceRoots,
} from './workflow-source';
import { executeDagWorkflow, childOutcomeFromRun } from './dag-executor';
import type { RunChildWorkflowArgs, ChildWorkflowOutcome, PriorRunUsage } from './dag-executor';
import type { PersistedNodeOutput, WorkflowResumeCursor } from './store';
import { canonicalValueText, type JsonValue } from './output-ref';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import type { WorkflowWithSource, WorkflowLoadError } from './schemas';
import { validateWorkflowOutcomeDeclaration } from './loader';
import { maybeWarnLegacyStatePath, maybeWarnLegacyArtifactsPath } from './state-migration';
import { resolveWorkflowName } from './router';
import { resolveDeclaredInputs, defaultRunInputs } from './workflow-inputs';
import { logWorkflowStart, logWorkflowError } from './logger';
import { formatDuration, parseDbTimestamp } from './utils/duration';
import { keepAwake } from './utils/keep-awake';
import { getWorkflowEventEmitter } from './event-emitter';
import { isRegisteredProvider, getRegisteredProviders } from '@archon/providers';
import type { ExecutionContext } from '@archon/providers/types';
import type { ContainerRunContext } from './container-context';
export type { ContainerRunContext, ContainerWriteBackBackend } from './container-context';
// Re-exported so callers driving the capture-first sequence need only this module.
export { recordSelectedWorkflow, capturedSourceRoots, loadWorkflowSource } from './workflow-source';
export type { WorkflowSourceRoots } from './workflow-source';
import type { ChildIsolationResolver, ChildIsolationResult } from './child-isolation';
export type {
  ChildIsolationResolver,
  ChildIsolationRequest,
  ChildIsolationResult,
} from './child-isolation';
import {
  classifyError,
  toTelemetryErrorClass,
  safeSendMessage,
  runWithAdoptedRunDir,
  type SendMessageContext,
} from './executor-shared';
import { resolveGithubTokenOverrides } from './utils/github-token-policy';
import {
  buildAiProfile,
  applyResolvedRunModelOverrides,
  createRunModelBindingsMetadata,
  hasRunModelOverrides,
  readRunModelBindingsMetadata,
  resolveRunModelOverrides,
  RUN_MODEL_BINDINGS_METADATA_KEY,
  runOverrideAppliesToRef,
} from './model-validation';
import {
  applyWorkflowRunConfigLayer,
  readWorkflowRunConfigMetadata,
  WORKFLOW_RUN_CONFIG_METADATA_KEY,
} from './run-config';
import type { WorkflowRunConfigInput, WorkflowRunConfigMetadata } from './schemas/run-config';
import type {
  ResolvedAiProfile,
  ResolvedRunModelOverrides,
  RunModelBindingsMetadata,
  RunModelOverrides,
} from './model-validation';
import { assistantModelDefaults, resolveWorkflowModelScope } from './node-model-resolution';

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
 * Remove file-delivered credentials left by an earlier invocation of this run.
 * A resume must not keep a readable credential after it has been disconnected
 * or after fresh credential resolution fails.
 */
async function clearManagedProviderCredentialFiles(artifactsDir: string): Promise<void> {
  for (const relativePath of MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS) {
    await rm(join(artifactsDir, relativePath), { force: true });
  }
}

/**
 * Resolve per-user AI-provider credential env (Phase 2) for a run, and write
 * any file-based deliveries (e.g. Codex `CODEX_HOME/auth.json`) under the
 * run's artifacts directory. Returns the env bag to merge LAST into
 * `config.envVars` so a connected user's keys win over file/db/bot-github
 * env, plus exact credential values for failure-path redaction. Returns empty
 * bags when per-user provider keys are disabled, no userId is present, or the
 * deps adapter is absent.
 *
 * Contract: NEVER THROWS. Adapter failures are logged and yield empty bags so the
 * workflow continues with whatever env inheritance was already in place. File
 * write failures also drop the resolved env, but retain the credential values:
 * an earlier file may already contain them and still needs failure-path redaction.
 */
async function resolveUserProviderEnvForWorkflow(
  deps: WorkflowDeps,
  userId: string | undefined,
  artifactsDir: string
): Promise<{ env: Record<string, string>; protectedValues: string[] }> {
  const perUserEnabled = deps.isPerUserProviderKeysEnabled?.() ?? false;
  if (!perUserEnabled || !userId || !deps.getUserProviderEnv) {
    return { env: {}, protectedValues: [] };
  }
  let resolved: Awaited<ReturnType<NonNullable<WorkflowDeps['getUserProviderEnv']>>>;
  try {
    resolved = await deps.getUserProviderEnv(userId, artifactsDir);
  } catch (err) {
    getLog().warn({ err: err as Error, userId }, 'workflow.user_provider_env_resolve_failed');
    return { env: {}, protectedValues: [] };
  }

  const { env, files, protectedValues } = resolved;
  try {
    for (const f of files) {
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.contents, { encoding: 'utf8', mode: 0o600 });
    }
  } catch (err) {
    getLog().warn({ err: err as Error, userId }, 'workflow.user_provider_files_write_failed');
    return { env: {}, protectedValues };
  }

  const envKeys = Object.keys(env);
  if (envKeys.length > 0) {
    getLog().debug({ userId, keys: envKeys }, 'workflow.user_provider_env_injected');
  }
  return { env, protectedValues };
}

/**
 * Whether the run's codebase is a folder project (non-git). Folder projects run
 * in place on a non-git root, so git base-branch auto-detection can only fail
 * (`fatal: not a git repository`) — skip it to avoid the ERROR/WARN log-spam
 * pair on every folder run (#2159). `$BASE_BRANCH` keeps its
 * referenced-but-unresolvable failure semantics (empty string when skipped).
 *
 * Contract: NEVER THROWS. A lookup failure returns `false` so the normal
 * auto-detection path still runs, preserving prior behavior on any DB hiccup.
 */
async function isFolderCodebase(
  deps: WorkflowDeps,
  codebaseId: string | undefined
): Promise<boolean> {
  if (!codebaseId) return false;
  try {
    const codebase = await deps.store.getCodebase(codebaseId);
    return codebase?.kind === 'folder';
  } catch (err) {
    getLog().warn({ err: err as Error, codebaseId }, 'workflow.folder_kind_resolve_failed');
    return false;
  }
}

/** The four run-scoped output directories plus the project root they hang off. */
export interface ResolvedProjectPaths {
  artifactsDir: string;
  logDir: string;
  artifactsRoot: string;
  /** `$STATE_DIR` — per-PROJECT cross-run state, shared by every workflow. */
  stateDir: string;
  /** The project root persisted to `workflow_runs.output_root`. */
  outputRoot: string;
  /**
   * How the run's project identity was determined (#2304). Three states; collapsing
   * any two is a correctness bug:
   *  - `'resolved'`     — `getCodebase` returned a row whose identity resolves to a
   *                      repo / folder / `_local` key.
   *  - `'unregistered'` — `getCodebase` returned a row, but no owner/repo nor a
   *                      `_local` identity could be derived from it; the run still
   *                      gets external storage, keyed on cwd (`codebase_project_identity_unresolved`
   *                      WARN). This is a legitimate outcome of a registered codebase,
   *                      NOT a fault.
   *  - `'faulted'`      — `getCodebase` threw on BOTH retry attempts; the run fell
   *                      through to the cwd fallback (`project_paths_resolve_failed_using_fallback`
   *                      ERROR). The persistence block must NOT write `output_root`
   *                      for these runs — see `executeWorkflow`.
   *
   * Undefined on the persisted-`output_root` short-circuit branch (a resume reading
   * an existing root re-derives nothing and there is nothing to flag).
   */
  identityResolution?: 'resolved' | 'unregistered' | 'faulted';
}

/**
 * Resolve the output directories for a workflow run.
 *
 * Resolution order:
 *  1. A persisted `output_root` (from the run row) wins outright — a run that
 *     already recorded where its output lives must never re-derive it, or a
 *     renamed codebase (#1192) would orphan its artifacts mid-run.
 *  2. Otherwise look the codebase up once and delegate to the single shared
 *     identity→paths resolver in `@archon/paths`, which handles repo,
 *     `_local`, and folder projects.
 *  3. With no codebase (or a lookup failure, or an unresolvable identity) the
 *     run falls back to the `_cwd/<basename>` pseudo-project — still UNDER
 *     `ARCHON_HOME`. This used to write into `<cwd>/.archon/`, i.e. the user's
 *     repository; relocating it is the breaking change accepted in #2200 so
 *     that every run's output survives worktree teardown and is retrievable.
 *
 * `artifactsRoot` is the parent of the `runs/` layout (`.../artifacts`) — the base
 * that run-scoped (`runs/<id>/`) and scope-scoped (`scopes/<workflow>/<scope>/`,
 * #1846) storage both hang off, whichever branch resolved it.
 *
 * Exported for unit testing of the kind-based branch selection.
 */
export async function resolveProjectPaths(
  deps: WorkflowDeps,
  cwd: string,
  workflowRunId: string,
  codebaseId?: string,
  opts?: { persistedOutputRoot?: string | null }
): Promise<ResolvedProjectPaths> {
  if (opts?.persistedOutputRoot) {
    // The engine only ever persists an in-tree root, so an out-of-tree value is
    // corruption or a hand edit. Acting on it would let a relative or
    // whitespace root scatter this run's artifacts AND its shared state under
    // whatever the server's cwd happens to be. Ignore it and re-derive: the run
    // still lands somewhere correct, and the write-once guard means we never
    // overwrite the bad value silently. Readers apply the same boundary.
    if (archonPaths.isInsideArchonHome(opts.persistedOutputRoot)) {
      return composeRunPaths(
        archonPaths.getStoragePathsForRoot(opts.persistedOutputRoot),
        workflowRunId
      );
    }
    getLog().error(
      { workflowRunId, persistedOutputRoot: opts.persistedOutputRoot },
      'workflow.output_root_outside_archon_home'
    );
  }

  let key: archonPaths.ProjectStorageKey | undefined;
  let identityResolution: 'resolved' | 'unregistered' | 'faulted' | undefined;
  if (codebaseId) {
    // Retried once (#2304). A failing lookup drops the run onto the `_cwd/<basename>`
    // pseudo-project. The fallback itself stays — a registry blip must not kill a run.
    // What changed is what happens to the row afterwards: a faulted run no longer
    // has its fault-derived location PERSISTED as `output_root` (so the rename hazard
    // #1192 protects stays scoped to rows with real roots), and the run carries
    // `metadata.identity_unresolved = true` so "unregistered" and "we could not tell"
    // are distinguishable after the fact. See the persistence block in `executeWorkflow`
    // and `ResolvedProjectPaths.identityResolution`.
    //
    // What the retry is worth, honestly, differs by dialect:
    //   • Postgres — it earns its place. A stale or broken pooled connection is exactly
    //     the fault an immediate retry clears by drawing a fresh one, and this is the
    //     only app-level DB retry in the tree. Zero delay is CORRECT here; backoff would
    //     add latency for nothing.
    //   • SQLite (the default install) — weak. `PRAGMA busy_timeout = 5000` means
    //     SQLITE_BUSY cannot surface as a throw until five seconds of sustained
    //     contention have already elapsed, so what reaches us is by construction not
    //     transient, and retrying at that instant retries the moment least likely to
    //     have cleared. Kept because it costs one attempt and cannot make things worse.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const codebase = await deps.store.getCodebase(codebaseId);
        if (codebase) {
          key = archonPaths.resolveProjectStorageKey(codebase, cwd);
          identityResolution = key.kind === 'cwd' ? 'unregistered' : 'resolved';
          if (key.kind === 'cwd') {
            // The codebase exists but neither an owner/repo nor a _local identity
            // could be derived from it — the run still gets external storage, but
            // keyed on the working directory rather than the project. NOT a fault;
            // the persistence block writes the cwd fallback as `output_root` here.
            getLog().warn(
              { codebaseName: codebase.name, cwd: codebase.default_cwd },
              'codebase_project_identity_unresolved'
            );
          }
        }
        break;
      } catch (error) {
        if (attempt === 0) {
          getLog().warn(
            { err: error as Error, codebaseId, cwd },
            'workflow.project_paths_lookup_retrying'
          );
          continue;
        }
        identityResolution = 'faulted';
        getLog().error(
          { err: error as Error, codebaseId, cwd },
          'project_paths_resolve_failed_using_fallback'
        );
      }
    }
  }

  // When the lookup returned null (no codebase row) or no `codebaseId` was provided,
  // `key` is undefined and the cwd fallback is used. Both are legitimate — neither is
  // a fault — so they read as `'unregistered'`. A `'faulted'` outcome overrides this.
  if (identityResolution === undefined) {
    identityResolution = 'unregistered';
  }

  return {
    ...composeRunPaths(
      archonPaths.getProjectStoragePaths(key ?? { kind: 'cwd', cwd }),
      workflowRunId
    ),
    identityResolution,
  };
}

/** Project-level roots → the run-scoped view the executor threads downstream. */
function composeRunPaths(
  storage: archonPaths.ProjectStoragePaths,
  workflowRunId: string
): ResolvedProjectPaths {
  return {
    artifactsDir: archonPaths.getRunArtifactsDirForRoot(storage.root, workflowRunId),
    logDir: storage.logsDir,
    artifactsRoot: storage.artifactsRoot,
    stateDir: storage.stateRoot,
    outputRoot: storage.root,
  };
}

/**
 * Resolve the stable cross-invocation artifact scope dir for a run (#1846), or
 * undefined when the feature doesn't apply. Applies only when the workflow uses
 * cross-run session persistence (workflow-level `persist_sessions` or any node
 * `persist_session: true`) AND the run has a conversation scope — the same
 * opt-in + scope key the session store uses. No persistence → no new dirs,
 * default behavior unchanged.
 */
export function resolveScopeArtifactsDir(
  workflow: {
    name: string;
    nodes: readonly (DagNode | IncludeDirective)[];
    persist_sessions?: boolean;
  },
  conversationId: string | null | undefined,
  artifactsRoot: string
): string | undefined {
  if (!conversationId) return undefined;
  const usesPersistence =
    workflow.persist_sessions === true ||
    workflow.nodes.some(n => 'persist_session' in n && n.persist_session === true);
  if (!usesPersistence) return undefined;
  return archonPaths.getScopeArtifactsPath(artifactsRoot, workflow.name, conversationId);
}

/**
 * Resume state may only appear together with `preCreatedRun` — passing prior
 * outputs or usage without the resumed row would silently inject state into a
 * freshly-created run. Lock-token rows (used by `dispatchBackgroundWorkflow`)
 * supply `preCreatedRun` alone.
 */
type ResumePayload =
  | {
      preCreatedRun: WorkflowRun;
      priorCompletedNodes?: Map<string, PersistedNodeOutput>;
      priorUsage?: PriorRunUsage;
      priorNodeSessions?: readonly WorkflowRunNodeSession[];
    }
  | {
      preCreatedRun?: undefined;
      priorCompletedNodes?: undefined;
      priorUsage?: undefined;
      priorNodeSessions?: undefined;
    };

/**
 * Optional parameters for {@link executeWorkflow}. All trailing args live here
 * so call sites stay readable as new options accrue.
 *
 * To resume a prior run, obtain the run, prior outputs, and prior usage from
 * {@link hydrateResumableRun} (or look up via `findResumableRun` and hydrate)
 * and spread them in. The executor never queries the store for a prior run on
 * its own; that decision belongs at the call site.
 */
export type ExecuteWorkflowOptions = ResumePayload & {
  /** Codebase ID for env vars + isolation context. */
  codebaseId?: string;
  /**
   * Caller-provided base branch fallback for `$BASE_BRANCH`, normally the
   * codebase's stored `default_branch`. Repo config still wins when
   * `worktree.baseBranch` is set, and `baseOverride` wins over both; git
   * auto-detection remains the last resort.
   */
  baseBranch?: string;
  /**
   * Per-dispatch base-branch override (CLI `--base <branch>`), the top
   * precedence level for `$BASE_BRANCH` — above repo config and the codebase
   * default. Mirrors `IsolationRequest.baseOverride`, which does the same for
   * the worktree cut-from, so one flag drives both halves of "base". Passing
   * the override through `baseBranch` instead would rank it BELOW
   * `worktree.baseBranch`, so a repo with that config set would cut its
   * worktree from the override while reporting the configured branch here.
   */
  baseOverride?: string;
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
  /**
   * Keys the engine dropped from this workflow's YAML (#2213), as produced by
   * discovery. Recorded on the run as a `workflow_parse_warnings` event at
   * start, so the finding survives independently of whether the chat/console
   * notification could be delivered — and so it exists for CLI- and REST-started
   * runs, which have no conversation to post into. Optional: a caller that
   * doesn't thread it through simply records nothing.
   */
  parseWarnings?: readonly string[];
  /** Parent conversation ID — enables approve/reject auto-resume from chat. */
  parentConversationId?: string;
  /**
   * Archon user UUID for attribution on the workflow_run row. Resolved by
   * chat/forge adapters via findOrCreateUserByPlatformIdentity. Web/CLI paths
   * pass undefined until their own auth surfaces are wired.
   * Ignored when `preCreatedRun` is set — the persisted creator remains both
   * the run attribution and the credential/prefs execution identity on resume.
   */
  userId?: string;
  /**
   * Execution context resolved by the isolation seam: `{ kind: 'host' }` (default)
   * runs on the Archon host; `{ kind: 'container', … }` (folder-project container
   * backend, Phase B) runs provider turns and subprocesses inside the prepared
   * container. Threaded verbatim into `executeDagWorkflow`. Defaults to host when
   * absent, so every existing caller is unchanged.
   */
  execContext?: ExecutionContext;
  /**
   * Container run context (folder-project container backend, Phase C). Present
   * only when `execContext.kind === 'container'`; carries the prepared env id, the
   * write-back policy, and the backend port the engine drives for suspend +
   * write-back. Absent for host runs.
   */
  container?: ContainerRunContext;
  /**
   * Per-child isolation resolver (#2121 slice 2, PR-A). A structural port the
   * engine calls once per `workflow:` child whose node declares
   * `isolation: 'worktree'`, to obtain a per-child worktree cwd + branch. Built by
   * the caller (CLI/orchestrator via `@archon/core`) over `WorktreeProvider` so
   * `@archon/workflows` never imports `@archon/isolation`. Absent → a
   * `isolation: 'worktree'` node fails fast (never a silent shared-checkout
   * fallback). Threaded into the child-spawn closure.
   */
  resolveChildIsolation?: ChildIsolationResolver;
  /**
   * Declared inputs supplied by a DIRECT top-level invocation (#2554) — the CLI's
   * `--input name=value`, the run route's `inputs` map, or the console's run form.
   * Stamped onto the fresh run row's `metadata.inputs`, the same key a `workflow:`
   * parent writes for its child, so every existing delivery path (`$INPUTS.<name>` on
   * AI/prompt surfaces, `INPUTS_<UPPER_SNAKE>` for bash/script) works unchanged and the
   * values survive a cold resume.
   *
   * ALREADY RESOLVED by the invocation gate (`resolveTopLevelInputs`), which validates
   * against the workflow's declared `inputs:` before any worktree, clone, or AI cost —
   * like `baseOverride` and `parseWarnings`, this is a caller-resolved value. The
   * executor does not re-validate: it would run after the cost the gate exists to
   * prevent, and its message would be shaped for the wrong surface.
   *
   * Ignored on a resume: the row already carries the inputs validated at creation.
   */
  inputs?: Readonly<Record<string, string>>;
  /**
   * Between-run continuation (#2747): the terminal run whose estate this run
   * adopted (`--adopt`) or superseded (`--supersedes`). Written once onto the
   * fresh run row's `adopted_from_run_id` — never on resume — and announced on
   * THIS run's event log as `workflow.run_adopted` so the chain renders without
   * joining on the column. The lane itself is resolved by the caller before
   * dispatch; the executor only records provenance.
   */
  adoptedFromRunId?: string;
  /** How `adoptedFromRunId` continues: estate adoption or fresh-lane supersession. */
  continuationMode?: 'adopt' | 'supersede';
  /** One model-binding phase: raw at invocation boundaries, resolved for child runs. */
  modelOverrideLayer?:
    | { kind: 'raw'; overrides: RunModelOverrides }
    | { kind: 'resolved'; overrides: ResolvedRunModelOverrides };
  /** Validated sparse config supplied by a fresh CLI/HTTP workflow invocation. */
  runConfig?: WorkflowRunConfigInput;
  /**
   * The frozen source this run executes, from {@link prepareWorkflowSource}.
   *
   * Callers that run a workflow read off disk MUST prepare one and discover the workflow
   * from it, so the YAML being executed and the commands and scripts beside it are one
   * consistent set of bytes. Omitting it is for in-process callers that build a
   * definition themselves and have no on-disk source to freeze.
   *
   * Ignored on a resume: the run resolves the source it recorded at start.
   */
  preparedSource?: PreparedWorkflowSource;
  /**
   * The owner's adopt/hold handle from the surrounding `withCapturedSource`. When set,
   * `executeWorkflow` calls `adopt()` itself — at the rename success site — so a rename
   * failure leaves the staged directory un-adopted and the wrap's `finally` reclaims
   * it. Optional: omitting it preserves the legacy behavior where callers own adoption
   * (used by `executeWorkflow` paths that move the staged capture themselves, and by
   * tests that mock `executeWorkflow`). Never set by callers that did not wrap
   * themselves in `withCapturedSource`.
   */
  capturedSourceOwner?: CapturedSourceOwner;
  /**
   * Require every cost-bearing result in this run to report finite provider cost.
   * Child runs use this when their parent has a spend ceiling: it keeps the runs'
   * ledgers separate while making the child's rolled-up cost truthful.
   */
  requireReportedCost?: boolean;
};

/**
 * A capture taken BEFORE its workflow was selected, with the run id it is filed under.
 *
 * The reserved id is what makes the ordering possible: the capture has to live at the
 * run's own artifacts path so a container can bind it and cleanup can reclaim it, but it
 * has to exist before discovery — and therefore before the run row. Reserving the id up
 * front is cheaper than inventing a second staging lifecycle for the gap.
 */
export interface PreparedWorkflowSource {
  /** Reserved run id; the caller passes it back so the row and the capture agree. */
  runId: string;
  captureRoot: string;
  origin: string;
  manifest: WorkflowSourceManifest;
  /** Roots to discover from — pass to `discoverWorkflowsWithConfig`. */
  roots: WorkflowSourceRoots;
}

/**
 * How long an unadopted staging directory survives before it is reclaimed.
 *
 * Generous on purpose: it must comfortably exceed the gap between capturing and adopting,
 * which spans discovery, isolation, and — for `--detach` — a child process starting. Not a
 * timeout on anything; adoption MOVES the capture out of staging, so anything still here
 * after this long belongs to no run.
 */
const STAGED_SOURCE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Reclaim staging directories no run ever adopted.
 *
 * The backstop behind {@link withCapturedSource}. That guard covers the paths it wraps;
 * this covers the ones nobody can enumerate — a process killed between capture and run, a
 * crash, a surface added later that forgets. Safe by construction, because adoption moves
 * the capture out of staging, and age-bounded so a concurrent invocation's in-flight
 * capture is never touched.
 *
 * Hygiene only: it never mutates a run and cannot affect one in progress.
 *
 * Throttled by TIME, not by process. Once-per-capture put a directory scan on the spawn
 * path of every fan-out child; once-per-*process* fixed that and broke the server, which
 * is one process for weeks — it swept on the first dispatch after boot and never again,
 * leaving crash debris to accumulate for the lifetime of the install. An interval is
 * correct for both: the CLI sweeps on its first capture, a server keeps sweeping, and no
 * dispatch pays more than one `readdir` an hour.
 */
const STAGED_SOURCE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastStagedSweepAt = 0;
async function sweepStaleStagedSources(): Promise<void> {
  const now = Date.now();
  if (now - lastStagedSweepAt < STAGED_SOURCE_SWEEP_INTERVAL_MS) return;
  lastStagedSweepAt = now;
  const stagingRoot = join(archonPaths.getArchonHome(), 'staged-source');
  try {
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    const cutoff = Date.now() - STAGED_SOURCE_TTL_MS;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(stagingRoot, entry.name);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs >= cutoff) continue;
      await rm(path, { recursive: true, force: true }).catch(() => {
        /* another process may be reclaiming the same entry — losing that race is fine */
      });
      getLog().debug({ path }, 'workflow.source_staging_reclaimed');
    }
  } catch {
    // No staging directory yet, or unreadable. Neither is worth failing a run over.
  }
}

/**
 * Own a prepared capture for the length of an operation: adopt it, or reclaim it.
 *
 * Preparation happens before a workflow is even selected, so the ways OUT are many — an
 * unknown name, a refused input contract, a flag conflict, a gate, an isolation error, a
 * detached dispatch that hands the work to a child. Asking each of those to remember a
 * disposal call is how a dozen of them came not to: a typo'd workflow name leaked a
 * complete frozen tree, unbounded, once per invocation.
 *
 * `adopt()` transfers ownership to a run. Anything else — a return, a throw, a branch
 * nobody has written yet — reclaims. That is the difference between a leak that is fixed
 * and one that cannot recur.
 *
 * ONE mechanism, deliberately. An earlier pass built this, described this exact leak in
 * this exact docblock, and then never called it: the CLI hand-rolled an equivalent, the
 * background dispatch used a manual `dispose` in one catch, and chat — the highest-traffic
 * surface — got neither and kept leaking on five returns. Three shapes for one invariant is
 * how the busiest path ends up with none.
 */
export interface CapturedSourceOwner {
  /**
   * Take responsibility for a capture. Call again if its path changes — a container run
   * finalizes early and moves the capture out of staging, and reclaiming the pre-move path
   * would leave the real one behind while looking like it cleaned up.
   */
  hold: (prepared: Pick<PreparedWorkflowSource, 'captureRoot'>) => void;
  /**
   * A run now owns the bytes and their lifetime; stop tracking them. Called by the
   * caller from `executeWorkflow`'s rename success site (via
   * `ExecuteWorkflowOptions.capturedSourceOwner`) once the staged capture has been moved
   * under the run's artifacts directory. Earlier call sites — before the rename — could
   * leave the staged directory orphaned when the rename itself failed (#2690); adoption
   * at the rename site means a failed move leaves the wrap's `finally` to reclaim.
   */
  adopt: () => void;
}

export async function withCapturedSource<T>(
  body: (owner: CapturedSourceOwner) => Promise<T>
): Promise<T> {
  let held: string | undefined;
  let adopted = false;
  const owner: CapturedSourceOwner = {
    hold: prepared => {
      held = prepared.captureRoot;
    },
    adopt: () => {
      adopted = true;
    },
  };
  try {
    return await body(owner);
  } finally {
    // Adoption MOVES the capture, so reclaiming an adopted one is a no-op even if the
    // flag were wrong. That is what makes running this unconditionally safe.
    if (held && !adopted) {
      await rm(held, { recursive: true, force: true }).catch((err: Error) => {
        getLog().warn({ err, captureRoot: held }, 'workflow.source_capture_dispose_failed');
      });
    }
  }
}

/**
 * The graph a run must continue with, read from the source IT recorded.
 *
 * Every continuation surface goes through here — `/workflow resume`, `approve`, `reject`,
 * the console Resume button, and `workflow run --resume`. That is the point. Before this
 * existed each surface discovered the graph itself and had to remember to pass the
 * capture's roots, and the ones nobody rewrote kept discovering live: the executor then
 * supplied commands and scripts from the frozen capture while the DAG came from whatever
 * the target held now. Editing a workflow between pause and resume silently ran the new
 * graph against the old command bytes.
 *
 * A single entry point makes that unforgettable rather than merely fixed once.
 *
 * Returns `undefined` only for a run created before captures existed — nothing recorded,
 * so the caller keeps its old live behavior. THROWS when a run recorded a source that
 * cannot be read, verified, or no longer contains its workflow: a run that froze its
 * source must continue with that source or stop.
 *
 * The full discovery result comes back with it so a caller that needs the other entries —
 * parse warnings, load errors, source counts — does not run discovery a second time over
 * the same roots.
 */
export async function resolveContinuationWorkflow(
  deps: WorkflowDeps,
  run: Pick<WorkflowRun, 'workflow_name' | 'metadata'>,
  /** Target workspace — owns config; never the source. */
  cwd: string
): Promise<ResolvedContinuation | undefined> {
  // Verifies the digest against the value the RUN recorded, and yields the manifest whose
  // `source_config` decides how those bytes resolve. Reading the root without the config
  // is what made a repo with a custom `commands.folder` re-discover a different DAG.
  const capture = await resolveRunSourceCapture(run.metadata);
  if (!capture) return undefined; // predates capture — the caller keeps live behavior
  const roots = capturedSourceRoots(capture.captureRoot, capture.manifest.source_config);

  const { workflows, errors } = await discoverWorkflowsWithConfig(cwd, deps.loadConfig, roots);
  const workflow = resolveWorkflowName(
    run.workflow_name,
    workflows.map(w => w.workflow)
  );
  if (!workflow) {
    throw new WorkflowSourceIntegrityError(
      `Cannot continue run of '${run.workflow_name}': its captured source at ` +
        `${capture.captureRoot} no longer contains that workflow.`
    );
  }
  return { workflow, roots, workflows, errors };
}

/** What a continuation resolved to, plus the discovery it already paid for. */
export interface ResolvedContinuation {
  workflow: WorkflowDefinition;
  roots: WorkflowSourceRoots;
  workflows: readonly WorkflowWithSource[];
  errors: readonly WorkflowLoadError[];
}

/**
 * Discard a prepared capture that will never become a run.
 *
 * Preparation happens before a workflow is selected, so several ordinary outcomes end
 * without a run: an unknown workflow name, a validation refusal, a detached dispatch that
 * hands the work to a child process. Each of those would otherwise leave a complete tree
 * under `staged-source` that nothing ever reclaims — the capture is only adopted into the
 * run's artifacts once a run exists to own it.
 *
 * Best-effort: a failure to clean up must never mask the reason the run stopped.
 */
export async function disposeWorkflowSource(prepared: { captureRoot: string }): Promise<void> {
  await rm(prepared.captureRoot, { recursive: true, force: true }).catch((err: Error) => {
    getLog().warn(
      { err, captureRoot: prepared.captureRoot },
      'workflow.source_capture_dispose_failed'
    );
  });
}

/**
 * Move a staged capture to its final home under the run's artifacts, early.
 *
 * `executeWorkflow` normally does this itself once it has resolved the run's paths. One
 * caller cannot wait: a container fixes its bind mounts at `docker run`, which happens
 * during isolation preparation — before the run row exists — and mounting the staging
 * path would bind a directory that is about to move. Callers preparing a container
 * finalize here first, then mount the returned path.
 *
 * Idempotent: `executeWorkflow` recomputes the same destination and skips the move.
 */
export async function finalizeWorkflowSource(
  deps: WorkflowDeps,
  prepared: PreparedWorkflowSource,
  opts: { cwd: string; codebaseId?: string }
): Promise<PreparedWorkflowSource> {
  const { artifactsDir } = await resolveProjectPaths(
    deps,
    opts.cwd,
    prepared.runId,
    opts.codebaseId
  );
  const finalRoot = getRunSourceCapturePath(artifactsDir);
  if (finalRoot === prepared.captureRoot) return prepared;
  await mkdir(dirname(finalRoot), { recursive: true });
  await rm(finalRoot, { recursive: true, force: true });
  await rename(prepared.captureRoot, finalRoot);
  return {
    ...prepared,
    captureRoot: finalRoot,
    roots: capturedSourceRoots(finalRoot, prepared.manifest.source_config),
  };
}

/**
 * Freeze a run's executable source and reserve the run id it belongs to, BEFORE the
 * workflow is discovered.
 *
 * Order is the whole point. Discovering first and capturing afterwards leaves a window
 * where the YAML a run executes and the scripts it calls come from two different moments;
 * capturing first and discovering from the capture closes it. Callers should therefore:
 *
 *   1. `prepareWorkflowSource(...)`
 *   2. discover with `discoverWorkflowsWithConfig(cwd, loadConfig, prepared.roots)`
 *   3. `recordSelectedWorkflow(prepared.captureRoot, workflow.name)`
 *   4. `executeWorkflow(..., { preparedSource: prepared })`
 *
 * Throws when the source cannot be frozen. There is no degraded mode: a run with no
 * capture has no established executable source.
 */
export async function prepareWorkflowSource(
  deps: Pick<WorkflowDeps, 'loadConfig'>,
  opts: {
    /** Directory to freeze. */
    sourceRoot: string;
  }
): Promise<PreparedWorkflowSource> {
  // Read the SOURCE's command policy, not the target's. A repo may point `commands.folder`
  // somewhere outside `.archon/commands`; discovery honors that, so a capture that did not
  // would find the command at selection time and lose it at execution time. Resolved here
  // rather than passed in so no caller can forget it.
  let sourceConfig: WorkflowSourceConfig;
  try {
    const config = await deps.loadConfig(opts.sourceRoot);
    sourceConfig = {
      load_default_workflows: config.defaults?.loadDefaultWorkflows ?? true,
      load_default_commands: config.defaults?.loadDefaultCommands ?? true,
      ...(config.commands?.folder !== undefined ? { command_folder: config.commands.folder } : {}),
    };
  } catch (error) {
    // A malformed config would otherwise silently narrow what gets frozen.
    throw new Error(
      `Cannot capture workflow source from ${opts.sourceRoot}: its configuration could not ` +
        `be read (${(error as Error).message}).`
    );
  }
  await sweepStaleStagedSources();
  const runId = randomUUID();
  // Staged, not final. The run's artifacts path depends on its registered project
  // identity, which the caller often has not resolved yet at capture time — and looking
  // it up early would duplicate a lookup the run does properly later. Staging under
  // ARCHON_HOME keeps the capture on the same filesystem, so `executeWorkflow` moves it
  // into `<artifactsDir>/workflow-source` with a rename once the real path is known. The
  // bytes never change, so the digest taken here still describes the final capture.
  const capture = await captureWorkflowSource({
    sourceRoot: opts.sourceRoot,
    captureRoot: join(archonPaths.getArchonHome(), 'staged-source', runId),
    commandFolder: sourceConfig.command_folder,
    sourceConfig,
  });
  return {
    runId,
    captureRoot: capture.captureRoot,
    origin: capture.origin,
    manifest: capture.manifest,
    roots: capturedSourceRoots(capture.captureRoot, capture.manifest.source_config),
  };
}

export interface ResumableRunInspection {
  priorCompletedNodes: Map<string, PersistedNodeOutput>;
  priorUsage: PriorRunUsage;
}

/** Read whether a candidate has state worth resuming without claiming or mutating it. */
export async function inspectResumableRun(
  deps: WorkflowDeps,
  candidate: WorkflowRun
): Promise<ResumableRunInspection | null> {
  const snapshot = await deps.store.getDagResumeSnapshot(candidate.id);
  const priorCompletedNodes = snapshot.completedNodeOutputs;
  const rawApproval = candidate.metadata?.approval;
  const approvalContext = isApprovalContext(rawApproval) ? rawApproval : undefined;
  const hasReRunGateState = reRunsOwnNodeOnResume(approvalContext, candidate.metadata);
  const hasWaitState = isWorkflowWaitContext(candidate.metadata?.wait);
  const hasScheduledResume = isScheduledWorkflowResume(candidate.metadata?.scheduled_resume);
  if (
    priorCompletedNodes.size === 0 &&
    !hasReRunGateState &&
    !hasWaitState &&
    !hasScheduledResume
  ) {
    getLog().info(
      { resumableRunId: candidate.id },
      'workflow.dag_resume_skipped_no_completed_nodes'
    );
    return null;
  }
  return {
    priorCompletedNodes,
    priorUsage: {
      ...(snapshot.tokens !== undefined ? { tokens: snapshot.tokens } : {}),
      costUsd: snapshot.costUsd,
      workUnits: snapshot.workUnits,
    },
  };
}

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
  candidate: WorkflowRun,
  cursor?: WorkflowResumeCursor
): Promise<{
  preCreatedRun: WorkflowRun;
  priorCompletedNodes: Map<string, PersistedNodeOutput>;
  priorUsage: PriorRunUsage;
  priorNodeSessions: WorkflowRunNodeSession[];
} | null> {
  const inspection = await inspectResumableRun(deps, candidate);
  if (inspection === null) return null;
  const { priorCompletedNodes, priorUsage } = inspection;
  // A gate whose node deliberately writes NO node_completed on pause must still be
  // resumable with zero completed nodes: interactive loops, a `workflow:` node
  // blocked on a child (#2121 Phase 2) whose child is the very first node, and a
  // legacy on_reject gate with a genuinely staged rework (#2714) — see
  // reRunsOwnNodeOnResume's doc for the exhaustive per-reason breakdown. A
  // new-mode gate (#2707 step 1) needs no carve-out here: both approve and
  // reject write node_completed immediately.
  const completedNodeIds = new Set(priorCompletedNodes.keys());
  const priorNodeSessions = (await deps.store.listWorkflowRunNodeSessions(candidate.id)).filter(
    row => completedNodeIds.has(row.node_id)
  );
  const preCreatedRun =
    cursor === undefined
      ? await deps.store.resumeWorkflowRun(candidate.id)
      : await deps.store.resumeWorkflowRun(candidate.id, cursor);
  getLog().info(
    { workflowRunId: preCreatedRun.id, priorCompletedCount: priorCompletedNodes.size },
    'workflow.dag_resuming'
  );
  return {
    preCreatedRun,
    priorCompletedNodes,
    priorUsage,
    priorNodeSessions,
  };
}

/** Depth cap on the `workflow:` sub-run tree (D9). A node nested deeper fails fast. */
const CHILD_WORKFLOW_DEPTH_CAP = 5;

/** Safety bound on the descendant walk (guards a corrupted run tree). */
const MAX_DESCENDANT_RUNS = 64;

/**
 * Collect the transitive descendant run ids of `rootId` via a bounded downward walk
 * of `parent_run_id` (#2121 Phase 2). Used to exclude a run's own sub-run children
 * from its path-lock: they share the checkout by design, so a parent resumed while
 * still blocked on a paused child must not self-cancel against that child. Throws
 * are the caller's to handle (it fails closed).
 */
async function gatherDescendantRunIds(deps: WorkflowDeps, rootId: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [rootId];
  const seen = new Set<string>([rootId]);
  let processed = 0;
  while (queue.length > 0 && processed < MAX_DESCENDANT_RUNS) {
    const id = queue.shift();
    if (id === undefined) break;
    processed++;
    const children = await deps.store.findChildRuns(id);
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c.id);
      queue.push(c.id);
    }
  }
  return out;
}

/**
 * Start (or resume a failed) child workflow run in-process for a `workflow:` node
 * (#2121 Phase 2). Reuses the FULL executeWorkflow lifecycle for the child —
 * run-record creation, path-lock, artifacts, credential/model resolution, resume,
 * terminal output — and returns the child's node-facing outcome.
 *
 * The runtime cycle guard + depth cap live here (include:'s guard is load-time and
 * does not cover runtime targets). The child shares the parent's checkout;
 * executeWorkflow derives the ancestor chain from the child's own parent_run_id
 * to exclude it from the path-lock.
 * Never throws — every failure is returned as a `{ status: 'failed' }` outcome so
 * the calling node fails cleanly rather than the whole DAG throwing. (Every step,
 * including the recursive executeWorkflow call, is guarded — keep it that way.)
 */
async function runChildWorkflow(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  args: RunChildWorkflowArgs,
  resolvedModelOverrides: ResolvedRunModelOverrides,
  runConfig: WorkflowRunConfigInput | undefined,
  resolveChildIsolation?: ChildIsolationResolver
): Promise<ChildWorkflowOutcome> {
  const {
    parentRun,
    nodeId,
    childWorkflowName,
    input,
    cwd,
    conversationId,
    conversationDbId,
    userId,
    codebaseId,
    isolation,
    childIndex,
    itemHash,
    resumeFailedChild,
    inputs,
    requireReportedCost,
  } = args;

  // Every failure below returns a `{ status: 'failed' }` outcome (never throws);
  // `childRunId` defaults to '' for failures before a child row exists.
  const failOutcome = (error: string, childRunId = ''): ChildWorkflowOutcome => {
    // Reclaim the child's staged capture. Several ordinary refusals happen between
    // capturing and creating the child row — an unknown name, a cycle, the depth cap, a
    // contract violation — and each would otherwise strand a complete tree under
    // `staged-source`. Safe after the child HAS started too: `executeWorkflow` moves the
    // capture into the child's artifacts, so the staged path is already gone and this is
    // a no-op. Fire-and-forget because cleanup must never mask the failure being reported.
    if (childSource) void disposeWorkflowSource(childSource);
    return { childRunId, status: 'failed', error };
  };

  // A `workflow:` child freezes its own source AT ITS OWN START, from the parent's
  // AUTHORING directory rather than the parent's frozen copy of it. Both halves matter:
  // taking the bytes now (not at parent start) is what lets an author fix a child
  // workflow — removing a gate, say — and have a resumed parent pick the fix up; and
  // discovering from the capture rather than from the live directory is what stops the
  // child executing one moment's YAML against another moment's scripts.
  const parentSourceRoot = await resolveChildDiscoveryRoot(parentRun.metadata);
  let childSource: PreparedWorkflowSource | undefined;
  try {
    childSource = await prepareWorkflowSource(deps, { sourceRoot: parentSourceRoot ?? cwd });
  } catch (err) {
    return failOutcome(
      `Failed to capture workflow source for sub-run '${childWorkflowName}': ${(err as Error).message}`
    );
  }

  // 1. Resolve the child workflow by NAME (static target — constitution guardrail).
  //    Resolution runs BEFORE the cycle check so a case-variant / suffix / substring
  //    reference to an ancestor (e.g. `workflow: SELFIE` naming its own run) is caught
  //    as a cycle by canonical name, not left to the less-informative depth cap.
  let childWorkflow: WorkflowDefinition | undefined;
  try {
    // DELIBERATE AFFORDANCE — do not "fix" this by adding a load-time existence
    // check for `workflow:` targets. Discovery runs HERE, when the node executes,
    // so a run can author a workflow mid-flight and then execute it as a governed
    // child run; a load-time check would compile, pass every existing test, and
    // silently delete that capability. Recorded in the constitution's case-law
    // table (reference/workflow-language-constitution.md) and locked by
    // `describe('workflow: late resolution is a deliberate affordance')` in
    // subrun.test.ts.
    const { workflows } = await discoverWorkflowsWithConfig(
      cwd,
      deps.loadConfig,
      childSource.roots
    );
    childWorkflow = resolveWorkflowName(
      childWorkflowName,
      workflows.map(w => w.workflow)
    );
    if (childWorkflow) await recordSelectedWorkflow(childSource.captureRoot, childWorkflow.name);
  } catch (err) {
    // resolveWorkflowName throws only on ambiguity.
    return failOutcome(
      `Failed to resolve sub-run '${childWorkflowName}': ${(err as Error).message}`
    );
  }
  if (!childWorkflow) {
    return failOutcome(`Unknown sub-run workflow '${childWorkflowName}'.`);
  }
  // 2. Cycle guard + depth cap (D9), compared against the RESOLVED canonical name.
  //    The child's ancestor chain is the parent plus the parent's ancestors; a
  //    resolved target already in the chain is a cycle.
  let ancestry: WorkflowRun[];
  try {
    ancestry = [parentRun, ...(await deps.store.getRunAncestry(parentRun.id))];
  } catch (err) {
    return failOutcome(
      `Failed to resolve run ancestry for sub-run guard: ${(err as Error).message}`
    );
  }
  if (ancestry.some(a => a.workflow_name === childWorkflow.name)) {
    return failOutcome(
      `Sub-run cycle detected: '${childWorkflow.name}' is already an ancestor of this run.`
    );
  }
  if (ancestry.length >= CHILD_WORKFLOW_DEPTH_CAP) {
    return failOutcome(
      `Sub-run depth cap (${String(CHILD_WORKFLOW_DEPTH_CAP)}) exceeded nesting '${childWorkflow.name}'.`
    );
  }

  // 2b. Enforce the RESOLVED child's declared `inputs:` contract (#2470) — the exact
  //     same resolution `include:` performs at load time, through the same shared
  //     implementation, so a `with:` map accepted by one surface is accepted by the
  //     other. It can only run here (not at load time) because the target is resolved
  //     late by design, so it sits before isolation/worktree creation and before the
  //     child run row exists: a contract violation must never leave an orphan worktree
  //     or a doomed child row behind.
  let childInputs: Record<string, JsonValue> | undefined;
  try {
    const resolved = resolveDeclaredInputs(
      inputs ?? {},
      childWorkflow.inputs,
      `Node '${nodeId}'`,
      `sub-run workflow '${childWorkflow.name}'`
    );
    childInputs = Object.keys(resolved).length > 0 ? resolved : undefined;
  } catch (err) {
    return failOutcome((err as Error).message);
  }

  // 3. Resolve the child's execution cwd (slice 2, PR-A). `isolation: 'worktree'`
  //    runs the child in its own git worktree obtained from the injected resolver.
  //    A resume whose child run row still exists reuses that row's recorded path
  //    instead of resolving again; a resume whose child row is GONE (never written,
  //    or deleted) falls through to the fresh-spawn path and does re-resolve —
  //    safely, because the identifier is deterministic per (parent, node, index)
  //    and the env-row write is an upsert (see child-isolation-resolver.ts).
  //    `inherit` (or undefined) shares the parent's checkout — slice-1 behavior.
  //    Resolving AFTER the name + cycle guards means a bad reference never leaves an
  //    orphan worktree behind. The resolver throwing surfaces as a failed outcome
  //    (never a silent shared-checkout fallback — a parallel write into the shared
  //    checkout is the exact collision worktree isolation prevents).
  let childCwd: string;
  // Populated only when THIS spawn created a fresh isolated worktree — its env id +
  // branch are stamped into the child's metadata (S3; PR-E console grouping reads it).
  let childIsolationEnv: ChildIsolationResult | undefined;
  if (resumeFailedChild) {
    // Reuse the child's own recorded working_path: its worktree for an isolated
    // child, the shared parent checkout for `inherit`. Reaching this branch at all
    // means the child row survived, so there is nothing to re-resolve.
    const priorPath = resumeFailedChild.working_path;
    // An isolated child's worktree can be pruned by `isolation cleanup`/`complete`
    // between its failure and this resume. Reusing a vanished path would surface as a
    // deep ENOENT mid-run; fail fast with the same guidance the top-level CLI resume
    // gives (workflow.ts resume precedent).
    if (priorPath && !existsSync(priorPath)) {
      return failOutcome(
        `Cannot resume sub-run '${childWorkflowName}': its working path no longer exists ` +
          `(${priorPath}). The worktree may have been cleaned up — start a fresh run.`,
        resumeFailedChild.id
      );
    }
    // `working_path` is nullable in the schema, and falling back to the parent's
    // `cwd` here would be the one silent shared-checkout fallback in this function —
    // for an ISOLATED child that is exactly the concurrent-write collision the
    // isolation was requested to prevent. Unreachable today (every child row is
    // created with a real path, see the createWorkflowRun call below), so this is
    // defense-in-depth: fail loudly rather than resume somewhere the author didn't ask for.
    if (!priorPath) {
      return failOutcome(
        `Cannot resume sub-run '${childWorkflowName}': its run row has no recorded working ` +
          'path, so the checkout it ran in is unknown — start a fresh run.',
        resumeFailedChild.id
      );
    }
    childCwd = priorPath;
  } else if (isolation === 'worktree') {
    if (!resolveChildIsolation) {
      return failOutcome(
        `isolation: 'worktree' on sub-run '${childWorkflowName}' requires an injected ` +
          'child-isolation resolver (available for git-repo codebases run via the CLI or ' +
          "orchestrator). Remove the isolation or use 'inherit' (shared checkout)."
      );
    }
    try {
      childIsolationEnv = await resolveChildIsolation.resolve({
        parentRun,
        nodeId,
        childIndex,
        codebaseId,
      });
      childCwd = childIsolationEnv.cwd;
    } catch (err) {
      // The resolver already classified + logged the failure (child-isolation-resolver);
      // prepend the sub-run context for the node-facing outcome.
      return failOutcome(
        `Failed to create isolated worktree for sub-run '${childWorkflowName}': ${(err as Error).message}`
      );
    }
  } else {
    childCwd = cwd;
  }

  // 4. Create the child run row (fresh) or hydrate the failed one (resume path).
  let childOpts: ExecuteWorkflowOptions;
  let childRunId: string;
  // Thread the resolver into every child so a NESTED grandchild `workflow:` node can
  // also request its own worktree (nesting is first-class up to the depth cap) — the
  // recursive executeWorkflow otherwise has no resolver and would fail-fast. (The
  // sibling `container:` context has the same non-propagation gap today; out of scope
  // for this PR, but noted so it isn't mistaken for intentional.)
  try {
    if (resumeFailedChild) {
      const hydrated = await hydrateResumableRun(deps, resumeFailedChild);
      if (hydrated) {
        childOpts = {
          ...hydrated,
          codebaseId,
          resolveChildIsolation,
          preparedSource: childSource,
        };
        childRunId = hydrated.preCreatedRun.id;
      } else {
        // Failed child with no completed nodes — flip it back to running and re-run
        // from the top (nothing to skip). Its failed attempts still consumed budget,
        // so carry their persisted usage even though the generic top-level resume
        // classifier correctly found no resumable node output.
        const snapshot = await deps.store.getDagResumeSnapshot(resumeFailedChild.id);
        const preCreatedRun = await deps.store.resumeWorkflowRun(resumeFailedChild.id);
        childOpts = {
          preCreatedRun,
          priorUsage: {
            ...(snapshot.tokens !== undefined ? { tokens: snapshot.tokens } : {}),
            costUsd: snapshot.costUsd,
            workUnits: snapshot.workUnits,
          },
          codebaseId,
          resolveChildIsolation,
          preparedSource: childSource,
        };
        childRunId = preCreatedRun.id;
      }
    } else {
      const childRun = await deps.store.createWorkflowRun({
        // The id its capture is already filed under (see prepareWorkflowSource).
        id: childSource.runId,
        workflow_name: childWorkflow.name,
        conversation_id: conversationDbId,
        codebase_id: codebaseId,
        user_message: input,
        working_path: childCwd,
        parent_run_id: parentRun.id,
        // Share the parent's parent_conversation_id back-link so approve/reject
        // auto-resume scoping keeps working for the child on chat platforms.
        parent_conversation_id: parentRun.parent_conversation_id ?? undefined,
        user_id: userId,
        metadata: {
          [SUBRUN_METADATA_KEYS.parentNodeId]: nodeId,
          // Fan-out instance index (slice 2, PR-C) — stamped only for a fan-out child so
          // parent resume can re-key the ordered instance set by index (findChildRuns is
          // started_at-ordered, which ≠ items order under max_parallel concurrency). A
          // single (non-fan-out) child carries no child_index. The item-content hash rides
          // alongside so resume can WARN on a non-deterministic producer (same index, new item).
          ...(childIndex !== undefined ? { [SUBRUN_METADATA_KEYS.childIndex]: childIndex } : {}),
          ...(itemHash !== undefined ? { [SUBRUN_METADATA_KEYS.fanOutItemHash]: itemHash } : {}),
          // Named inputs (#2470) — persisted at spawn so the child's `$INPUTS.<name>`
          // resolves from metadata at runtime (resolveRunInputs) and survives a COLD
          // resume: both resume paths (hydrateResumableRun and the zero-completed-node
          // resumeWorkflowRun fallback) reload THIS run row, so the map is intact without
          // re-resolving parent refs that may be out of scope. Stamped only when non-empty.
          // This is the CONTRACT-RESOLVED map (declared defaults applied), not the raw
          // caller map — the child must see exactly what its `inputs:` block promises.
          // `inputs` stays canonical TEXT forever (shipped binaries read a non-string map
          // as corrupt/unset); the logical map rides the additive `inputs_values` sibling
          // (#2637), written only when a value is actually non-string.
          ...(childInputs !== undefined
            ? {
                [SUBRUN_METADATA_KEYS.inputs]: Object.fromEntries(
                  Object.entries(childInputs).map(([k, v]) => [k, canonicalValueText(v)])
                ),
                ...(Object.values(childInputs).some(v => typeof v !== 'string')
                  ? { [SUBRUN_METADATA_KEYS.inputsValues]: childInputs }
                  : {}),
              }
            : {}),
          // Record the child's own worktree env + branch (mirrors the container path's
          // isolation_env_id) so `isolation list` correlation + PR-E console grouping
          // can find it. Absent for `inherit`/shared-checkout children.
          ...(childIsolationEnv
            ? {
                isolation_env_id: childIsolationEnv.envId,
                branch_name: childIsolationEnv.branchName,
              }
            : {}),
        },
      });
      childOpts = {
        preCreatedRun: childRun,
        codebaseId,
        resolveChildIsolation,
        preparedSource: childSource,
        ...(runConfig ? { runConfig } : {}),
      };
      childRunId = childRun.id;
    }
  } catch (err) {
    return failOutcome(
      `Failed to create sub-run '${childWorkflowName}': ${(err as Error).message}`
    );
  }

  // 5. Run the child in-process (reuses the whole lifecycle) in its resolved cwd
  //    (its own worktree when isolated, else the parent's checkout). Its terminal
  //    output + cost + tokens land in the child run metadata on completion.
  //
  //    Wrapped in `withCapturedSource` so the staged capture above is reclaimed by
  //    the wrap's `finally` if `executeWorkflow`'s move-into-artifacts rename fails
  //    (#2690 recursive path). `failOutcome` already covers early-refusal paths
  //    before this point; the rename failure inside the recursive call is the one
  //    path the wrap is the only thing that can see — `executeWorkflow` returns
  //    `{success: false}` from that branch rather than throwing, so without the
  //    wrap the staged directory sits for the hourly age sweep.
  try {
    await withCapturedSource(async owner => {
      owner.hold(childSource);
      await executeWorkflow(
        deps,
        platform,
        conversationId,
        childCwd,
        childWorkflow,
        input,
        conversationDbId,
        {
          ...childOpts,
          capturedSourceOwner: owner,
          modelOverrideLayer: { kind: 'resolved', overrides: resolvedModelOverrides },
          requireReportedCost,
        }
      );
    });

    // 6. Read the child back for the node-facing outcome (status + summary + cost +
    //    tokens). Works for synchronous completion AND a child paused at its gate.
    const finalChild = await deps.store.getWorkflowRun(childRunId);
    if (!finalChild) {
      return failOutcome('Child run row disappeared after execution.', childRunId);
    }
    return childOutcomeFromRun(finalChild);
  } catch (err) {
    // Honor the never-throws contract: executeWorkflow can throw from its early
    // setup (before its own failWorkflowRun catch-all), and the read-back can
    // throw on a DB error — both must surface as a failed node outcome, not an
    // exception unwinding the parent's DAG.
    //
    // Wedge guard (symmetric to maybeResumeParentRun's post-CAS handler): a throw in
    // executeWorkflow's EARLY setup (config load, getCodebaseEnvVars, token
    // resolution) fires BEFORE the status→running flip and BEFORE its own catch-all,
    // stranding the pre-created child at 'pending' (or 'running' on a later window) —
    // a non-terminal row that holds the working-path lock. `cancelWorkflowRun` (NOT
    // failWorkflowRun, whose `WHERE status='running'` would miss the 'pending' case)
    // flips any non-terminal child to 'cancelled' and no-ops on a child that reached
    // completed/cancelled on its own. childRunId is always assigned once step 3 ran.
    await deps.store.cancelWorkflowRun(childRunId).catch((cancelErr: unknown) => {
      getLog().error({ err: cancelErr as Error, childRunId }, 'workflow.child_setup_cancel_failed');
    });
    return failOutcome(
      `Sub-run '${childWorkflowName}' errored: ${(err as Error).message}`,
      childRunId
    );
  }
}

/**
 * After a `workflow:` sub-run reaches a terminal state, re-enter its PARENT run if
 * the parent is paused blocked on THIS child (#2121 Phase 2). This is the D5 hook
 * that turns a child's completion into a parent resume — the cross-run analogue of
 * a human approve, driven in the same process.
 *
 * No-op (guarded) when:
 *  - the parent is not 'paused' (synchronous first-run path: the parent is still
 *    'running' on the call stack — output threads directly from the returned outcome),
 *  - the parent's gate isn't a `child_workflow` gate, or
 *  - a DIFFERENT child of the same parent terminated (childRunId mismatch).
 *
 * Never throws — the child's own result must not be corrupted by a parent-resume
 * failure. Every await is guarded here (a parent-side failure is logged, and a
 * post-CAS failure marks the parent 'failed' so it stays resumable); the caller's
 * `.catch` is a belt-and-braces backstop, not the contract.
 *
 * `resolveChildIsolation` is a plain parameter rather than part of the resume state:
 * {@link ResumePayload} carries what was RECORDED about the prior run, and a resolver
 * is a live capability of the surface driving this process — it cannot be rehydrated
 * from a run row. It has to be forwarded because the parent picks up here *mid-DAG*:
 * a parent whose gated child just finished may still have `isolation: 'worktree'`
 * nodes ahead of it, and re-entering without the resolver fails them with
 * "requires an injected child-isolation resolver" even though the surface wired one.
 * The child's resolver is the right one to pass: a child inherits the parent's
 * `codebase_id`, and the resolver is codebase-bound and rejects a mismatch loudly.
 */
async function maybeResumeParentRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  conversationDbId: string,
  childRun: WorkflowRun,
  resolveChildIsolation?: ChildIsolationResolver
): Promise<void> {
  const parentRunId = childRun.parent_run_id;
  if (!parentRunId) return;

  // Surface a reconciliation failure to the user with a manual-recovery pointer
  // (per the repo's surface-ambiguous-state principle): the child terminated but the
  // parent stayed paused, so a log-only return leaves a stale "blocked on sub-run"
  // gate with no signal. Guarded (safeSendMessage never throws) so it honors the
  // never-throws contract. Only called once we've confirmed the parent IS blocked on
  // THIS child — never for the synchronous no-op or a different-child terminal.
  const notifyStuck = async (reason: string): Promise<void> => {
    await safeSendMessage(
      platform,
      conversationId,
      `⚠️ Sub-run \`${childRun.id.slice(0, 8)}\` finished, but its parent run ` +
        `\`${parentRunId.slice(0, 8)}\` couldn't auto-resume (${reason}). ` +
        `Resume it manually: \`/workflow resume ${parentRunId}\``
    );
  };

  let parent: WorkflowRun | null;
  try {
    parent = await deps.store.getWorkflowRun(parentRunId);
  } catch (err) {
    getLog().error(
      { err: err as Error, parentRunId, childRunId: childRun.id },
      'workflow.parent_resume_lookup_failed'
    );
    await notifyStuck('the parent run could not be looked up');
    return;
  }
  if (parent?.status !== 'paused') return; // synchronous no-op, or already resumed

  // The core "parent blocked on THIS child" invariant lives in one shared predicate
  // (isRunBlockedOnChild) so this hook and the abandon-strand detector can't drift.
  if (!isRunBlockedOnChild(parent, childRun.id)) {
    // Paused but not blocked on this child. Distinguish a MALFORMED child_workflow
    // gate (missing childRunId — an invariant violation that would wedge the parent
    // forever; make it loud) from a normal different-child / non-child gate (silent).
    const approval = isApprovalContext(parent.metadata?.approval)
      ? parent.metadata.approval
      : undefined;
    if (approval?.type === 'child_workflow' && !approval.childRunId) {
      getLog().error(
        { parentRunId, childRunId: childRun.id },
        'workflow.parent_resume_malformed_gate_missing_child_run_id'
      );
    }
    return;
  }

  const parentCwd = parent.working_path;
  if (!parentCwd) {
    getLog().warn(
      { parentRunId, childRunId: childRun.id },
      'workflow.parent_resume_no_working_path'
    );
    await notifyStuck('the parent has no recorded working path');
    return;
  }

  let parentWorkflow: WorkflowDefinition | undefined;
  try {
    // Reload the parent's graph from the source IT started with. Rediscovering from
    // `parentCwd` is how a mid-run authoring edit used to change an already-running
    // parent's DAG, so stored node output could be reinterpreted by a different node.
    //
    // Through the shared entry point like every other continuation surface. This spot
    // hand-rolled the same sequence and read the capture twice for it, which is how the
    // fifth surface quietly ends up behaving differently from the other four. Throws when
    // the recorded capture no longer verifies; the catch below leaves the parent resumable
    // rather than silently running other source.
    const continuation = await resolveContinuationWorkflow(deps, parent, parentCwd);
    if (continuation) {
      parentWorkflow = continuation.workflow;
    } else {
      // No recorded source: a parent predating capture, which resumes live as it always did.
      const { workflows } = await discoverWorkflowsWithConfig(parentCwd, deps.loadConfig);
      parentWorkflow = resolveWorkflowName(
        parent.workflow_name,
        workflows.map(w => w.workflow)
      );
    }
  } catch (err) {
    getLog().error({ err: err as Error, parentRunId }, 'workflow.parent_resume_discovery_failed');
    await notifyStuck('workflow discovery failed');
    return;
  }
  if (!parentWorkflow) {
    getLog().warn(
      { parentRunId, workflowName: parent.workflow_name },
      'workflow.parent_resume_workflow_not_found'
    );
    await notifyStuck(`the parent workflow '${parent.workflow_name}' could not be found`);
    return;
  }

  let hydrated: Awaited<ReturnType<typeof hydrateResumableRun>>;
  try {
    hydrated = await hydrateResumableRun(deps, parent);
  } catch (err) {
    // Nothing has been mutated yet on a pre-CAS throw (resumeWorkflowRun's CAS is
    // hydrate's last step; a lost CAS throws WorkflowNotResumableError instead) —
    // the parent stays 'paused' and manually resumable, so log and stand down.
    if (err instanceof Error && err.name === 'WorkflowNotResumableError') {
      // Benign race: a concurrent (manual or duplicate) resume won the CAS and
      // now owns the parent. Not an error — no user-facing message (it IS resuming).
      getLog().info(
        { parentRunId, childRunId: childRun.id },
        'workflow.parent_auto_resume_lost_race'
      );
    } else {
      getLog().error({ err: err as Error, parentRunId }, 'workflow.parent_resume_hydrate_failed');
      await notifyStuck('preparing the parent for resume failed');
    }
    return;
  }
  if (!hydrated) {
    // A parent paused on a child_workflow gate is always resumable (see the
    // child_workflow branch in hydrateResumableRun), so null here is unexpected.
    getLog().warn({ parentRunId }, 'workflow.parent_resume_nothing_to_resume');
    await notifyStuck('the parent had no resumable state');
    return;
  }

  getLog().info(
    { parentRunId, childRunId: childRun.id, childStatus: childRun.status },
    'workflow.parent_auto_resume_started'
  );
  try {
    await executeWorkflow(
      deps,
      platform,
      conversationId,
      parentCwd,
      parentWorkflow,
      parent.user_message ?? '',
      conversationDbId,
      {
        ...hydrated,
        codebaseId: parent.codebase_id ?? undefined,
        resolveChildIsolation,
      }
    );
  } catch (err) {
    // The hydrate CAS above already flipped the parent paused→running, and
    // executeWorkflow's own failWorkflowRun catch-all doesn't cover its early
    // setup (config load, env/credential resolution). Without this handler a
    // throw there would strand the parent at 'running' — a non-terminal status
    // resumeWorkflow refuses, leaving destructive abandon as the only exit.
    // Land it in 'failed' instead so it stays resumable.
    getLog().error(
      { err: err as Error, parentRunId, childRunId: childRun.id },
      'workflow.parent_auto_resume_execute_failed'
    );
    await deps.store
      .failWorkflowRun(parentRunId, `Auto-resume after sub-run failed: ${(err as Error).message}`)
      .catch((failErr: unknown) => {
        getLog().error(
          { err: failErr as Error, parentRunId },
          'workflow.parent_auto_resume_fail_mark_failed'
        );
      });
  }
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
  const outcomeDeclarationError = validateWorkflowOutcomeDeclaration(workflow);
  if (outcomeDeclarationError !== null) {
    throw new Error(`Invalid workflow '${workflow.name}': ${outcomeDeclarationError}`);
  }

  const {
    codebaseId,
    issueContext,
    isolationContext,
    parentConversationId,
    preCreatedRun,
    priorCompletedNodes,
    priorUsage,
    priorNodeSessions,
    userId,
    source,
    parseWarnings,
    baseBranch: callerBaseBranch,
    baseOverride: callerBaseOverride,
    execContext = { kind: 'host' },
    container: containerCtx,
    resolveChildIsolation,
    inputs: suppliedInputs,
    modelOverrideLayer,
    runConfig: callerRunConfig,
    preparedSource,
    adoptedFromRunId,
    continuationMode = 'adopt',
    requireReportedCost = false,
  } = opts;

  const executionUserId = preCreatedRun ? (preCreatedRun.user_id ?? undefined) : userId;
  const modelOverrides =
    modelOverrideLayer?.kind === 'raw' ? modelOverrideLayer.overrides : undefined;
  const callerResolvedModelOverrides =
    modelOverrideLayer?.kind === 'resolved' ? modelOverrideLayer.overrides : undefined;
  const isContinuation =
    preCreatedRun !== undefined &&
    (priorCompletedNodes !== undefined || preCreatedRun.status !== 'pending');
  if (isContinuation && modelOverrides !== undefined) {
    throw new Error('Cannot supply model overrides when resuming an existing workflow run.');
  }
  if (isContinuation && callerRunConfig !== undefined) {
    throw new Error('Cannot supply a run config when resuming an existing workflow run.');
  }

  const containsWait = (nodes: readonly (DagNode | IncludeDirective)[]): boolean =>
    nodes.some(node => {
      if (!('kind' in node)) return false;
      if (isWaitNode(node)) return true;
      return isLoopGroupNode(node) && containsWait(node.loop_group.nodes);
    });
  if (
    preCreatedRun === undefined &&
    execContext.kind === 'container' &&
    containsWait(workflow.nodes)
  ) {
    throw new Error(
      `Workflow '${workflow.name}' contains a durable wait, which is not supported in container isolation because server continuation cannot rewire the container. Run it without container isolation.`
    );
  }

  if (preCreatedRun !== undefined) {
    const foreignPriorNodeSession = priorNodeSessions?.find(
      row => row.workflow_run_id !== preCreatedRun.id
    );
    if (foreignPriorNodeSession !== undefined) {
      throw new Error(
        `Cannot resume workflow run '${preCreatedRun.id}' with session state from run '${foreignPriorNodeSession.workflow_run_id}' (node '${foreignPriorNodeSession.node_id}')`
      );
    }
  }

  // Guard: a container run MUST be resumed with its container rewired (the CLI does
  // this via backend.resumeEnv, threading a `container` context). A resume that
  // reaches here for a container run WITHOUT that context — e.g. approving a
  // --container run from chat/web, which has no docker backend wired — would run
  // host-side and SILENTLY skip the write-back apply, losing the approved changes.
  // Fail loudly and point at the CLI instead; the run stays resumable (failed) so
  // the CLI can rediscover the container and apply.
  if (preCreatedRun?.metadata?.isolation === 'container' && !containerCtx) {
    const msg =
      `Run '${preCreatedRun.id}' executed inside an isolation container. Resume it from the ` +
      'CLI in the same project (`archon workflow approve/reject/resume <id>`), where the ' +
      'container is rediscovered — chat/web resume cannot rewire it.';
    getLog().warn({ workflowRunId: preCreatedRun.id }, 'workflow.container_resume_without_backend');
    await deps.store.failWorkflowRun(preCreatedRun.id, msg).catch((err: unknown) => {
      getLog().error(
        { err, workflowRunId: preCreatedRun.id },
        'workflow.container_resume_guard_fail_failed'
      );
    });
    await safeSendMessage(platform, conversationId, `⚠️ ${msg}`);
    return { success: false, workflowRunId: preCreatedRun.id, error: msg };
  }

  let runConfigMetadata: WorkflowRunConfigMetadata | undefined;
  let effectiveRunConfig: WorkflowRunConfigInput | undefined;
  try {
    if (isContinuation) {
      runConfigMetadata = readWorkflowRunConfigMetadata(preCreatedRun.metadata);
      if (runConfigMetadata) {
        if (!deps.unsealRunConfig) {
          throw new Error('This Archon build cannot restore persisted workflow run config.');
        }
        effectiveRunConfig = {
          layer: deps.unsealRunConfig(runConfigMetadata),
          source: runConfigMetadata.source,
        };
      }
    } else {
      effectiveRunConfig = callerRunConfig;
      if (effectiveRunConfig) {
        if (!deps.sealRunConfig) {
          throw new Error('This Archon build cannot persist workflow run config.');
        }
        runConfigMetadata = deps.sealRunConfig(effectiveRunConfig.layer, effectiveRunConfig.source);
      }
    }
  } catch (error) {
    if (preCreatedRun) {
      await deps.store
        .failWorkflowRun(preCreatedRun.id, (error as Error).message)
        .catch((dbError: Error) => {
          getLog().error(
            { err: dbError, workflowRunId: preCreatedRun.id },
            'workflow.run_config_fail_db_record_failed'
          );
        });
    }
    throw error;
  }

  // Load shared config once, then add this invocation's sparse layer at the
  // executor boundary. DB values remain below the run layer; protected
  // Archon-managed credentials are added later and keep their authority.
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
  const userGitHubEnv = await resolveUserGithubEnvForWorkflow(deps, executionUserId);
  const config = applyWorkflowRunConfigLayer(
    {
      ...fileConfig,
      // Order before the run layer: file < db. Per-codebase env vars are
      // operator-set; an explicit run config is the operator's final runtime
      // choice. Bot/user credentials remain protected and are merged after it.
      envVars: { ...fileConfig.envVars, ...dbEnvVars },
    },
    effectiveRunConfig?.layer
  );
  config.envVars = {
    ...config.envVars,
    // The injected bot token is system-set; the per-user override
    // wins last so a run routes through the originating human's token (or scrubs
    // the org/bot token when they haven't connected). Empty-string values from
    // the per-user policy scrub the corresponding key via the subprocess merge.
    ...botGitHubEnv,
    ...userGitHubEnv,
  };
  const protectedEnvKeys = new Set([...Object.keys(botGitHubEnv), ...Object.keys(userGitHubEnv)]);
  if (protectedEnvKeys.size > 0) {
    config.protectedEnvKeys = [...protectedEnvKeys];
  }
  const configuredCommandFolder = config.commands.folder;

  // Resolve base branch: the per-dispatch override takes priority, then repo
  // config, then the caller-provided codebase default, then git auto-detection.
  // The override must outrank config so `--base` reports the same branch the
  // worktree was cut from (WorktreeProvider applies the same order).
  // If detection fails, leave empty — substituteWorkflowVariables throws only if $BASE_BRANCH is referenced.
  const overrideBaseBranch = callerBaseOverride?.trim();
  const fallbackBaseBranch = callerBaseBranch?.trim();
  let baseBranch: string;
  if (overrideBaseBranch) {
    baseBranch = overrideBaseBranch;
  } else if (config.baseBranch) {
    baseBranch = config.baseBranch;
  } else if (fallbackBaseBranch) {
    baseBranch = fallbackBaseBranch;
  } else if (await isFolderCodebase(deps, codebaseId)) {
    // Folder projects run on a non-git root — auto-detection can only fail and
    // emit ERROR/WARN noise on every run (#2159). Leave empty; $BASE_BRANCH
    // stays unresolved and throws only if a prompt actually references it.
    baseBranch = '';
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
  if (executionUserId && deps.getUserAiPrefs) {
    try {
      userAiPrefs = await deps.getUserAiPrefs(executionUserId);
    } catch (error) {
      getLog().warn(
        { err: error as Error, userId: executionUserId },
        'workflow.user_ai_prefs_resolve_failed'
      );
    }
  }
  if (userAiPrefs.tiers || userAiPrefs.aliases || userAiPrefs.defaultProvider) {
    getLog().debug(
      {
        userId: executionUserId,
        tierKeys: Object.keys(userAiPrefs.tiers ?? {}),
        aliasKeys: Object.keys(userAiPrefs.aliases ?? {}),
        defaultProvider: userAiPrefs.defaultProvider,
      },
      'workflow.user_ai_prefs_applied'
    );
  }
  let baseAiProfile: ResolvedAiProfile;
  try {
    baseAiProfile = buildAiProfile(
      effectiveRunConfig?.layer.assistant ?? userAiPrefs.defaultProvider ?? fileConfig.assistant,
      {
        repoTiers: fileConfig.tiers,
        repoAliases: fileConfig.aliases,
        userTiers: userAiPrefs.tiers,
        userAliases: userAiPrefs.aliases,
        runTiers: effectiveRunConfig?.layer.tiers,
        runAliases: effectiveRunConfig?.layer.aliases,
      }
    );
  } catch (error) {
    // Structurally invalid STORED prefs (corrupt DB row) must not kill the run
    // before its record exists — degrade to config-only. A broken config layer
    // still fails fast: the rebuild below rethrows the same error.
    getLog().error(
      { err: error as Error, userId: executionUserId },
      'workflow.user_ai_prefs_profile_invalid'
    );
    baseAiProfile = buildAiProfile(effectiveRunConfig?.layer.assistant ?? fileConfig.assistant, {
      repoTiers: fileConfig.tiers,
      repoAliases: fileConfig.aliases,
      runTiers: effectiveRunConfig?.layer.tiers,
      runAliases: effectiveRunConfig?.layer.aliases,
    });
  }

  let persistedModelBindings: RunModelBindingsMetadata | undefined;
  let resolvedModelOverrides: ResolvedRunModelOverrides;
  try {
    persistedModelBindings = isContinuation
      ? readRunModelBindingsMetadata(preCreatedRun.metadata)
      : undefined;
    resolvedModelOverrides =
      persistedModelBindings?.overrides ??
      callerResolvedModelOverrides ??
      resolveRunModelOverrides(baseAiProfile, modelOverrides);
  } catch (error) {
    // HTTP/background dispatch pre-creates a pending row before this shared semantic
    // gate runs. An invalid explicit binding must not leave that row holding the path
    // lock indefinitely just because validation happens before the executor's main
    // lifecycle catch.
    if (preCreatedRun) {
      await deps.store
        .failWorkflowRun(preCreatedRun.id, (error as Error).message)
        .catch((dbError: Error) => {
          getLog().error(
            { err: dbError, workflowRunId: preCreatedRun.id },
            'workflow.model_overrides_fail_db_record_failed'
          );
        });
    }
    throw error;
  }
  const aiProfile = applyResolvedRunModelOverrides(baseAiProfile, resolvedModelOverrides);
  const modelBindingsMetadata = createRunModelBindingsMetadata(resolvedModelOverrides, aiProfile);
  if (hasRunModelOverrides(resolvedModelOverrides)) {
    getLog().info(
      {
        workflowName: workflow.name,
        tierKeys: Object.keys(resolvedModelOverrides.tiers ?? {}),
        aliasKeys: Object.keys(resolvedModelOverrides.aliases ?? {}),
        effective: modelBindingsMetadata.effective.aliases,
      },
      'workflow.run_model_overrides_applied'
    );
  }

  // Resolve the workflow-level provider/model fallbacks once (used by all nodes) through
  // the SAME pure function the dry run reports from, so `--dry-run` cannot disagree with
  // what the run does. Everything the pure function must not do — warn the user, throw —
  // stays here, mirroring how `resolveNodeProviderAndModel` wraps `resolveNodeModel` one
  // level down.
  //
  // Note that a workflow which came through discovery carries NO workflow-level provider
  // or model: composition collapses them onto its own nodes and removes the layer (#1764),
  // so this normally resolves to `config.assistant`. It still has to behave correctly for
  // a programmatic caller that hands over an unexpanded definition.
  const scope = resolveWorkflowModelScope(
    workflow,
    config.assistant,
    assistantModelDefaults(config),
    aiProfile
  );
  const resolvedProvider = scope.provider;
  const resolvedModel = scope.model;
  const workflowPreset = scope.preset;
  const providerSource = runOverrideAppliesToRef(resolvedModelOverrides, workflow.model)
    ? 'run-override'
    : scope.providerOrigin === 'model ref'
      ? `model preset '${workflow.model ?? ''}'`
      : scope.providerOrigin === 'workflow'
        ? 'workflow definition'
        : 'config';

  if (workflow.provider && workflowPreset && workflow.provider !== workflowPreset.provider) {
    getLog().warn(
      {
        workflowName: workflow.name,
        configuredProvider: workflow.provider,
        resolvedProvider: workflowPreset.provider,
        modelRef: workflow.model,
      },
      'workflow.model_provider_conflict'
    );
    const delivered = await safeSendMessage(
      platform,
      conversationId,
      `Warning: Workflow '${workflow.name}' sets provider '${workflow.provider}' but model '${workflow.model ?? ''}' resolves to provider '${workflowPreset.provider}' — using '${workflowPreset.provider}'.`
    );
    if (!delivered) {
      getLog().error(
        { workflowName: workflow.name, conversationId },
        'workflow.model_provider_conflict_warning_delivery_failed'
      );
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
  const dagPriorUsage = priorUsage;
  let workflowRun: WorkflowRun | undefined = preCreatedRun;

  if (preCreatedRun && priorCompletedNodes !== undefined) {
    const resumeMsg =
      priorCompletedNodes.size > 0
        ? `▶️ **Resuming** workflow \`${workflow.name}\` — skipping ${String(priorCompletedNodes.size)} already-completed node(s).`
        : `▶️ **Resuming** workflow \`${workflow.name}\` — continuing interactive loop.`;
    await safeSendMessage(platform, conversationId, resumeMsg);
  }

  if (!workflowRun) {
    // Create workflow run record
    try {
      workflowRun = await deps.store.createWorkflowRun({
        // Reserved by `prepareWorkflowSource` so the row and its already-written source
        // capture share one id; absent for callers that prepared nothing.
        ...(preparedSource ? { id: preparedSource.runId } : {}),
        workflow_name: workflow.name,
        conversation_id: conversationDbId,
        codebase_id: codebaseId,
        user_message: userMessage,
        working_path: cwd,
        // Record container isolation on the run itself so a later resume — a
        // SEPARATE process with no --container flag in hand — can detect it and
        // rediscover the container. `isolation_env_id` is the handle the resume
        // path passes to `backend.resumeEnv()` (Phase C).
        metadata: {
          ...(issueContext ? { github_context: issueContext } : {}),
          ...(execContext.kind === 'container' ? { isolation: 'container' } : {}),
          ...(containerCtx ? { isolation_env_id: containerCtx.envId } : {}),
          // Declared inputs supplied by a direct top-level invocation (#2554), already
          // validated by the invocation gate. Written here — inside `if (!workflowRun)` —
          // so a resume, which arrives with `preCreatedRun` set and never enters this
          // branch, can never re-stamp or clobber what the original invocation supplied.
          ...(suppliedInputs && Object.keys(suppliedInputs).length > 0
            ? { [SUBRUN_METADATA_KEYS.inputs]: { ...suppliedInputs } }
            : {}),
          // Between-run continuation (#2747): the mode stamp rides the same
          // creation write as `adopted_from_run_id` so both are write-once.
          ...(adoptedFromRunId ? { [CONTINUATION_METADATA_KEY]: { mode: continuationMode } } : {}),
          [RUN_MODEL_BINDINGS_METADATA_KEY]: modelBindingsMetadata,
          ...(runConfigMetadata ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: runConfigMetadata } : {}),
        },
        parent_conversation_id: parentConversationId,
        user_id: userId,
        ...(adoptedFromRunId ? { adopted_from_run_id: adoptedFromRunId } : {}),
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

  if (preCreatedRun && !isContinuation) {
    try {
      await deps.store.updateWorkflowRun(preCreatedRun.id, {
        metadata: {
          [RUN_MODEL_BINDINGS_METADATA_KEY]: modelBindingsMetadata,
          ...(runConfigMetadata ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: runConfigMetadata } : {}),
        },
      });
    } catch (error) {
      const err = error as Error;
      getLog().error(
        { err, workflowRunId: preCreatedRun.id },
        'workflow.invocation_metadata_persist_failed'
      );
      await deps.store
        .failWorkflowRun(preCreatedRun.id, 'Database error recording workflow invocation settings')
        .catch((dbError: Error) => {
          getLog().error(
            { err: dbError, workflowRunId: preCreatedRun.id },
            'workflow.invocation_metadata_failure_record_failed'
          );
        });
      await sendCriticalMessage(
        platform,
        conversationId,
        '❌ **Workflow failed**: Unable to record the run invocation settings. Please try again later.'
      );
      return {
        success: false,
        workflowRunId: preCreatedRun.id,
        error: 'Database error recording workflow invocation settings',
      };
    }
    workflowRun = {
      ...preCreatedRun,
      metadata: {
        ...preCreatedRun.metadata,
        [RUN_MODEL_BINDINGS_METADATA_KEY]: modelBindingsMetadata,
        ...(runConfigMetadata ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: runConfigMetadata } : {}),
      },
    };
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
      // A `workflow:` sub-run and its children share ONE checkout (#2121), so the
      // path-lock must not treat another run in this run's OWN vertical tree line as
      // a conflict. Exclude both directions:
      //   • ANCESTORS (upward via parent_run_id) — a child must not self-block against
      //     its own running/paused parent on that path.
      //   • DESCENDANTS (downward via a bounded walk) — a parent resumed while still
      //     blocked on a paused child must re-pause on it, not self-cancel against it.
      // Siblings are intentionally NOT excluded (see #2180). The ancestor lookup fails
      // OPEN (skip the best-effort lock) — a false self-collision against the parent is
      // worse than a briefly-unenforced lock; the descendant lookup fails CLOSED (run
      // the lock with whatever we have) — most runs have no descendants, so a lost set
      // only risks a legitimate-looking collision, never a self-collision.
      const pathLockExclude: string[] = [];
      let skipPathLock = false;
      if (workflowRun.parent_run_id) {
        try {
          const ancestry = await deps.store.getRunAncestry(workflowRun.id);
          pathLockExclude.push(...ancestry.map(a => a.id));
        } catch (err) {
          getLog().error(
            { err: err as Error, workflowRunId: workflowRun.id, cwd },
            'workflow.path_lock_ancestry_lookup_failed'
          );
          skipPathLock = true;
        }
      }
      if (!skipPathLock) {
        try {
          const descendantIds = await gatherDescendantRunIds(deps, workflowRun.id);
          pathLockExclude.push(...descendantIds);
        } catch (err) {
          getLog().warn(
            { err: err as Error, workflowRunId: workflowRun.id, cwd },
            'workflow.path_lock_descendant_lookup_failed'
          );
        }
      }
      const activeWorkflow = skipPathLock
        ? null
        : await deps.store.getActiveWorkflowRunByPath(cwd, {
            id: workflowRun.id,
            startedAt: new Date(parseDbTimestamp(workflowRun.started_at)),
            ...(pathLockExclude.length > 0 ? { excludeRunIds: pathLockExclude } : {}),
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

  // Resolve external artifact, log, and state directories. A resumed run
  // carries its `output_root` and short-circuits identity resolution entirely.
  const { artifactsDir, logDir, artifactsRoot, stateDir, outputRoot, identityResolution } =
    await resolveProjectPaths(deps, cwd, workflowRun.id, codebaseId, {
      persistedOutputRoot: workflowRun.output_root,
    });

  // Record the resolved root ONCE, so every later reader (artifact routes, CLI)
  // addresses this run's output by a durable pointer instead of re-deriving it
  // from a codebase name that may since have been renamed (#1192). Never
  // overwritten — a resumed run already has one, and the store additionally
  // enforces write-once via COALESCE.
  //
  // Faulted-identity exception (#2304): when `resolveProjectPaths` returned the
  // cwd fallback BECAUSE both `getCodebase` attempts threw (not because a registered
  // codebase simply lacked an owner/repo or `_local` identity), the cwd location is
  // fault-shaped — persisting it here would pin this run's `output_root` AND
  // `$STATE_DIR` to that empty, fault-derived tree for the run's whole life. We
  // instead leave `output_root` NULL and stamp `metadata.identity_unresolved = true`,
  // so:
  //   • a later resume re-derives once the registry is healthy and the
  //     `!workflowRun.output_root` guard above writes the now-correct root;
  //   • the state-preflight gate (#2200), maintainer-triage, and anyone reading the
  //     row can tell "unregistered" apart from "we could not tell";
  //   • the write-once invariant is preserved everywhere else (a row with a
  //     resolved or unregistered identity is still protected across a #1192
  //     rename — only the empty faulted shape is scoped differently).
  //
  // A failure to persist here is NOT retried: the guard is `if (!output_root)`, so
  // this run keeps a NULL pointer for its whole lifetime and permanently stays on
  // the re-derive path — the exact orphaning #1192 makes possible. That does not
  // justify failing an otherwise healthy run (re-derivation works today), but it
  // is a durable per-run degradation, so the healed-arm persist failure below
  // (`workflow.output_root_persist_failed`) logs at ERROR rather than WARN. The
  // faulted arm's two logs stay at WARN by design: the underlying fault was
  // already logged at ERROR inside `resolveProjectPaths`, so these only report a
  // secondary bookkeeping failure (stamping the flag, noting the skipped persist),
  // not the fault itself.
  if (!workflowRun.output_root) {
    if (identityResolution === 'faulted') {
      workflowRun.metadata = {
        ...workflowRun.metadata,
        [RUN_METADATA_KEYS.identityUnresolved]: true,
      };
      try {
        await deps.store.updateWorkflowRun(workflowRun.id, {
          metadata: { [RUN_METADATA_KEYS.identityUnresolved]: true },
        });
      } catch (err) {
        getLog().warn(
          { err: err as Error, workflowRunId: workflowRun.id },
          'workflow.identity_unresolved_flag_persist_failed'
        );
      }
      getLog().warn(
        { workflowRunId: workflowRun.id, outputRoot },
        'workflow.output_root_not_persisted_identity_faulted'
      );
    } else {
      const updates: Parameters<typeof deps.store.updateWorkflowRun>[1] = {
        output_root: outputRoot,
      };
      // The faulted arm stamped `identity_unresolved = true`; this is the heal
      // half of the same write — once a later resume's identity lookup succeeds,
      // a row that has healed must stop reading as faulted. The `false` rides the
      // same atomic metadata merge as the faulted arm's `true`.
      if (readIdentityUnresolved(workflowRun.metadata) === true) {
        updates.metadata = { [RUN_METADATA_KEYS.identityUnresolved]: false };
      }
      await deps.store.updateWorkflowRun(workflowRun.id, updates).catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, outputRoot },
          'workflow.output_root_persist_failed'
        );
      });
    }
  }

  // Detect (never move) legacy repo-local `.archon/` output directories. State was a
  // prompt convention; artifacts/logs the engine wrote itself on the unregistered-cwd
  // fallback (#2311) — the case Archon caused must not be the quieter of the two.
  // The run's ACTUAL posture, not the workflow's declared policy. `worktree.enabled`
  // is only one input to the real decision (`pinnedEnabled ?? (!resume && !noWorktree)`,
  // resolved in the CLI), so a workflow that leaves `worktree` unset and is run with
  // `--no-worktree` executes IN PLACE while the declared policy still reads as isolated.
  // That is the one case where this warning is actionable — the legacy files are sitting
  // in the user's real repository — and it is exactly the case the declared policy gets
  // backwards. A managed worktree always lives under ARCHON_HOME; an in-place checkout
  // never does, so the cwd answers the question the policy cannot.
  const isolated = archonPaths.isInsideArchonHome(cwd);
  await maybeWarnLegacyStatePath(cwd, stateDir, isolated);
  await maybeWarnLegacyArtifactsPath(cwd, artifactsRoot, isolated);

  // Stable cross-invocation artifact scope (#1846): only for persist_session
  // workflows with a conversation scope. Undefined otherwise — zero new dirs.
  const scopeArtifactsDir = resolveScopeArtifactsDir(
    workflow,
    workflowRun.conversation_id,
    artifactsRoot
  );

  // Pre-create the artifacts directory so commands can write to it immediately
  // (and the durable scope dir, when the workflow opted into one — same disk,
  // same failure mode, same fatal treatment). `stateDir` is pre-created here
  // too so `$STATE_DIR` is usable from the first node without an mkdir, and an
  // unwritable state dir fails the run rather than silently degrading.
  try {
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    if (scopeArtifactsDir) await mkdir(scopeArtifactsDir, { recursive: true });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    getLog().error(
      { err, artifactsDir, stateDir, workflowRunId: workflowRun.id },
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
  getLog().debug({ artifactsDir, logDir, stateDir, outputRoot }, 'workflow_paths_resolved');

  // Between-run continuation (#2747): resolve $ADOPTED_RUN_DIR through the
  // adopted run's persisted `output_root` (rename-safe per #2200) and announce
  // the adoption on THIS run's own event log so the chain renders without a
  // column join. Read-only by contract — this run writes to its own artifacts;
  // stores are never merged, so evidence stays attributable per run.
  // Resolution also runs on resume: a resumed run carries no caller-supplied id,
  // but its row still records the adoption, and every remaining node may reference
  // $ADOPTED_RUN_DIR. Only the announcement event stays creation-only — it was
  // written once when the adoption was made.
  const effectiveAdoptedFromRunId = adoptedFromRunId ?? workflowRun.adopted_from_run_id;
  let adoptedRunDir: string | undefined;
  if (effectiveAdoptedFromRunId) {
    const adopted = await deps.store.getWorkflowRun(effectiveAdoptedFromRunId);
    if (!adopted?.output_root) {
      throw new Error(
        `Cannot adopt run '${effectiveAdoptedFromRunId}': it has no persisted output root, so its ` +
          'artifact directory cannot be addressed.'
      );
    }
    adoptedRunDir = archonPaths.getRunArtifactsDirForRoot(
      adopted.output_root,
      effectiveAdoptedFromRunId
    );
    if (!isContinuation) {
      try {
        await deps.store.createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'workflow.run_adopted',
          data: { adopted_from_run_id: effectiveAdoptedFromRunId },
        });
      } catch (err) {
        getLog().warn(
          { err: err as Error, workflowRunId: workflowRun.id, adoptedFromRunId },
          'workflow.run_adopted_event_persist_failed'
        );
      }
    }
  }

  // ── Executable source ──────────────────────────────────────────────────────
  //
  // Freeze the workflow's own commands and scripts into this run's artifacts, and
  // resolve them from there for the rest of the run. Two things follow: the target
  // workspace never receives authoring files (it used to get a whole `.archon` copy,
  // `.env` and all), and the run stops changing shape when the authoring checkout is
  // edited, moved, or deleted underneath it.
  //
  // Order matters. A run that already RECORDED a source uses it, always — that is what
  // makes a resume deterministic. Only a run with no record captures, so a resume can
  // never recapture and quietly pull in edits made since it paused.
  //
  // This path FAILS CLOSED. A capture that cannot be taken, recorded, or verified means
  // the run's executable source cannot be established, and running anyway would execute
  // something other than what the run is supposed to be — the exact drift the capture
  // exists to remove. The sole exception is a run created before captures existed, which
  // has no record to honor.
  const recordedSourceState = readWorkflowSourceState(workflowRun.metadata);
  const isResume = priorCompletedNodes !== undefined;
  let workflowSourceRoots: WorkflowSourceRoots | undefined;

  const failRunOnSource = async (message: string): Promise<WorkflowExecutionResult> => {
    getLog().error({ workflowRunId: workflowRun.id, message }, 'workflow.source_unavailable');
    await deps.store.failWorkflowRun(workflowRun.id, message).catch((dbErr: Error) => {
      getLog().error(
        { err: dbErr, workflowRunId: workflowRun.id },
        'workflow.source_fail_db_record_failed'
      );
    });
    await sendCriticalMessage(platform, conversationId, `❌ **Workflow failed**: ${message}`);
    return { success: false, workflowRunId: workflowRun.id, error: message };
  };

  if (recordedSourceState.kind === 'unreadable') {
    // The run recorded SOMETHING this build cannot parse. Not the legacy case: treating
    // it as one would resume against whatever is on disk now.
    return await failRunOnSource(
      "This run's workflow source record cannot be read by this build " +
        `(${recordedSourceState.detail}). It may have been written by a newer Archon. ` +
        'Start a fresh run to execute the current workflow.'
    );
  } else if (recordedSourceState.kind === 'recorded') {
    const recordedSource = recordedSourceState.record;
    // Verifies the digest against the one the RUN recorded — not merely that the
    // directory exists, and not merely that the capture agrees with itself.
    try {
      const loaded = await loadWorkflowSource(recordedSource.root, recordedSource.digest);
      // The settings frozen WITH the capture, not the target's. Without this a resume
      // would re-read `commands.folder` and `defaults:` from the workspace it acts on and
      // reinterpret the frozen bytes through them.
      workflowSourceRoots = capturedSourceRoots(recordedSource.root, loaded.manifest.source_config);
      getLog().debug(
        { workflowRunId: workflowRun.id, captureRoot: recordedSource.root },
        'workflow.source_restored'
      );
    } catch (error) {
      return await failRunOnSource(
        `This run's captured workflow source at ${recordedSource.root} is missing or altered ` +
          `(${(error as Error).message}). The run cannot be resumed against different source; ` +
          'start a fresh run to execute the current workflow.'
      );
    }
  } else if (isResume) {
    // Created before source capture existed. Its original bytes were never recorded and
    // cannot be reconstructed, so it resumes the way it always did — against live source.
    // This is the ONLY warning-and-continue path, and it retires with those runs.
    getLog().warn({ workflowRunId: workflowRun.id }, 'workflow.source_legacy_live');
    await safeSendMessage(
      platform,
      conversationId,
      '⚠️ This run started before Archon captured workflow source, so there is nothing ' +
        'recorded to resume from. Continuing against the current source on disk, which may ' +
        'differ from what the run originally executed.'
    );
  } else if (preparedSource) {
    // The normal fresh path: the caller captured BEFORE selecting a workflow and
    // discovered from that capture, so the YAML being executed and the commands and
    // scripts beside it are one consistent set of bytes.
    //
    // Move the staged capture under this run's artifacts, so it lives and dies with the
    // rest of the run's output instead of accumulating in a staging directory nothing
    // reclaims. Same filesystem, so this is a rename.
    const finalCaptureRoot = getRunSourceCapturePath(artifactsDir);
    try {
      if (preparedSource.captureRoot !== finalCaptureRoot) {
        await rm(finalCaptureRoot, { recursive: true, force: true });
        await rename(preparedSource.captureRoot, finalCaptureRoot);
      }
      // The staged capture is now under the run's artifacts directory — the run owns
      // the bytes from this point on. Adopting here (not earlier, at the call site) is
      // what closes the race in #2690: a rename failure above returns without reaching
      // this line, so the wrap's `finally` reclaims the staged directory instead of
      // leaving it to the hourly age-based sweep.
      opts.capturedSourceOwner?.adopt();
    } catch (error) {
      return await failRunOnSource(
        `Could not move this run's captured workflow source into place: ${(error as Error).message}`
      );
    }
    workflowSourceRoots = capturedSourceRoots(
      finalCaptureRoot,
      preparedSource.manifest.source_config
    );
    const sourceRecord = {
      version: 1 as const,
      root: finalCaptureRoot,
      origin: preparedSource.origin,
      captured_at: preparedSource.manifest.captured_at,
      digest: preparedSource.manifest.digest,
      file_count: preparedSource.manifest.file_count,
      byte_count: preparedSource.manifest.byte_count,
    };
    // Mirror the record onto the IN-MEMORY run as well as the row. `workflowRun` is what
    // gets handed to child, fan-out, and `workflow:` dispatch, and those read the record
    // to find the parent's authoring origin — a stale in-memory copy sends them to the
    // target `cwd`, where the authoring workflows may not exist at all. Mutated rather
    // than reassigned so the row object stays one identity for the rest of the run; the
    // value written here is the same one the row is about to receive.
    workflowRun.metadata = {
      ...workflowRun.metadata,
      [WORKFLOW_SOURCE_METADATA_KEY]: sourceRecord,
    };
    try {
      await deps.store.updateWorkflowRun(workflowRun.id, {
        metadata: { [WORKFLOW_SOURCE_METADATA_KEY]: sourceRecord },
      });
    } catch (error) {
      // Without the pointer the run is unresumable in the only way that matters: a later
      // resume would find no record and fall through the legacy branch, executing live
      // source. Fail now, while the failure is attributable.
      return await failRunOnSource(
        `Could not record this run's workflow source: ${(error as Error).message}`
      );
    }
    getLog().info(
      {
        workflowRunId: workflowRun.id,
        origin: preparedSource.origin,
        captureRoot: finalCaptureRoot,
        digest: preparedSource.manifest.digest.slice(0, 12),
        fileCount: preparedSource.manifest.file_count,
        byteCount: preparedSource.manifest.byte_count,
      },
      'workflow.source_captured'
    );
  } else {
    // A fresh run whose caller did not prepare a capture. In-process callers that hand
    // the executor a definition they built themselves (tests, programmatic embedders)
    // land here; they have no on-disk source to freeze, so there is nothing to record
    // and nothing that can drift. Resolution stays live under `cwd`, unchanged.
    getLog().debug({ workflowRunId: workflowRun.id }, 'workflow.source_unprepared_live');
  }

  // Per-user AI-provider credentials (Phase 2). Resolved AFTER artifactsDir is
  // created because file-based deliveries (Codex `CODEX_HOME/auth.json`) live
  // under it. Clear files from an earlier invocation first: a disconnected
  // credential or failed refresh must not leave stale secrets readable on resume.
  // Merged LAST into config.envVars so the originating user's keys
  // win over file/db/bot-github env — preserves the GitHub merge order and
  // keeps the no-key path byte-for-byte unchanged (resolveUserProviderEnvForWorkflow
  // returns empty bags when the feature is disabled or no userId is present).
  try {
    await clearManagedProviderCredentialFiles(artifactsDir);
  } catch (error) {
    const err = error as Error;
    const message = `Could not safely prepare provider credentials: ${err.message}`;
    getLog().error(
      { err, workflowRunId: workflowRun.id },
      'workflow.user_provider_files_cleanup_failed'
    );
    await deps.store.failWorkflowRun(workflowRun.id, message).catch((dbErr: Error) => {
      getLog().error(
        { err: dbErr, workflowRunId: workflowRun.id },
        'workflow.user_provider_files_cleanup_fail_db_record_failed'
      );
    });
    await sendCriticalMessage(
      platform,
      conversationId,
      'Workflow blocked: Unable to safely prepare provider credentials. Please retry.'
    );
    return { success: false, workflowRunId: workflowRun.id, error: message };
  }

  const { env: userProviderEnv, protectedValues } = await resolveUserProviderEnvForWorkflow(
    deps,
    executionUserId,
    artifactsDir
  );
  config.envVars = { ...config.envVars, ...userProviderEnv };
  for (const key of Object.keys(userProviderEnv)) {
    protectedEnvKeys.add(key);
  }
  if (protectedEnvKeys.size > 0) {
    config.protectedEnvKeys = [...protectedEnvKeys];
  }
  const effectiveDbCredentialValues = Object.entries(dbEnvVars).flatMap(([key, value]) =>
    config.envVars?.[key] === value ? [value] : []
  );
  const protectedCredentialValues = [
    ...new Set([...effectiveDbCredentialValues, ...protectedValues]),
  ];
  if (protectedCredentialValues.length > 0) {
    config.protectedCredentialValues = protectedCredentialValues;
  }

  // Wrap execution in try-catch to ensure workflow is marked as failed on any error.
  //
  // Hold a Windows keep-awake request for the executing window (see
  // utils/keep-awake.ts for the Modern Standby / mid-run-death rationale and
  // best-effort semantics). Placed HERE, not at function top, so the
  // early-return validation paths above never leak an unpaired acquire; the
  // matching release is the first statement of this try's finally.
  keepAwake.acquire();
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
    // Already-expanded — the run is about to execute this workflow, so `workflow.nodes`
    // never actually holds an `IncludeDirective` here even though the type admits one
    // for the general pre-expansion case (#2486).
    const telemetryNodes = workflow.nodes as DagNode[];
    captureWorkflowInvoked({
      workflowName: workflow.name,
      workflowSource: source,
      platform: platform.getPlatformType(),
      provider: resolvedProvider,
      model: resolvedModel,
      nodeCount: telemetryNodes.length,
      usesLoop: telemetryNodes.some(isLoopNode),
      usesLoopGroup: telemetryNodes.some(isLoopGroupNode),
      usesApproval: telemetryNodes.some(isGateNode),
      usesScript: telemetryNodes.some(n => isExecNode(n) && n.runtime !== 'sh'),
      usesBash: telemetryNodes.some(n => isExecNode(n) && n.runtime === 'sh'),
      usesOutputFormat: telemetryNodes.some(n => n.output_format !== undefined),
      usesOutputType: telemetryNodes.some(n => n.output_type !== undefined),
      usesPersistSession:
        workflow.persist_sessions === true || telemetryNodes.some(n => n.persist_session === true),
      usesMcp: telemetryNodes.some(n => n.mcp !== undefined),
      usesSkills: telemetryNodes.some(n => n.skills !== undefined),
      usesFreshContext: telemetryNodes.some(n => isLoopNode(n) && n.loop.fresh_context),
      interactive: workflow.interactive ?? false,
      usedIsolation: isolationContext !== undefined,
      isResume: dagPriorCompletedNodes !== undefined,
    });

    let isolationMode: 'container' | 'worktree' | 'in-place' = 'in-place';
    if (execContext.kind === 'container') {
      isolationMode = 'container';
    } else if (isolationContext) {
      isolationMode = 'worktree';
    }

    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'workflow_started',
        data: {
          workflowName: workflow.name,
          defaultAssistant: baseAiProfile.defaultProvider,
          provider: resolvedProvider,
          model: resolvedModel ?? null,
          isolationMode,
          baseBranch,
          userId: workflowRun.user_id ?? null,
          userMessage: workflowRun.user_message,
          origin: workflowRun.parent_run_id ? 'workflow' : platform.getPlatformType(),
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'workflow_started' },
          'workflow_event_persist_failed'
        );
      });

    // Keys the engine dropped from this run's YAML (#2213). Recorded here rather
    // than at the chat/console dispatch site for two reasons: every run reaches
    // this line whatever surface started it (CLI and REST included, which have no
    // conversation to post into), and the record is therefore written by a path
    // that a failed `platform.sendMessage` cannot touch. That notification stays
    // best-effort; this is the durable trace behind it, readable via
    // `archon workflow get <id> --verbose` and the events API.
    if (parseWarnings && parseWarnings.length > 0) {
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'workflow_parse_warnings',
          data: {
            workflowName: workflow.name,
            warnings: [...parseWarnings],
          },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'workflow_parse_warnings' },
            'workflow_event_persist_failed'
          );
        });
    }

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

    // Declared-input defaults for a run with no caller (#2470). Runtime `$INPUTS`
    // otherwise comes only from `metadata.inputs`, which a parent stamps at spawn — so a
    // workflow started directly (CLI / chat / web) would throw on its own
    // `$INPUTS.<name>` while the identical workflow invoked as a `workflow:` child
    // resolved it. Derived from the definition rather than persisted, so it stays
    // correct across a cold resume and when the defaults are later edited. Any caller-
    // supplied value already on the row wins; only defaults are filled in.
    const declaredDefaults = defaultRunInputs(workflow.inputs);
    // The effective map is layered under the LOGICAL sibling key (#2637): defaults may
    // now be typed (`default: true`), and `readSubrunMetadata` prefers `inputs_values`,
    // so the in-memory overlay must not push a non-string value into the legacy text
    // map (a shipped binary reads a non-string `inputs` as corrupt). This overlay is
    // never persisted — it only shapes what resolveRunInputs sees for this execution.
    const runForDag: WorkflowRun = declaredDefaults
      ? {
          ...workflowRun,
          metadata: {
            ...(workflowRun.metadata as Record<string, unknown> | undefined),
            [SUBRUN_METADATA_KEYS.inputsValues]: {
              ...declaredDefaults,
              ...(readSubrunMetadata(workflowRun.metadata as Record<string, unknown> | undefined)
                .inputs ?? {}),
            },
          },
        }
      : workflowRun;

    // Execute the DAG workflow. Already-expanded (see `telemetryNodes` above) — the
    // executor's own `DagNode[]` parameter type is correctly narrow; this boundary
    // cast reflects that invariant, not a new one. The adopted-dir scope (#2747)
    // encloses only the DAG: a child sub-run spawned from a node re-enters
    // `executeWorkflow` and scopes its own (absent) adoption.
    const dagSummary = await runWithAdoptedRunDir(adoptedRunDir, () =>
      executeDagWorkflow(
        deps,
        platform,
        conversationId,
        cwd,
        { ...workflow, nodes: telemetryNodes },
        runForDag,
        resolvedProvider,
        resolvedModel,
        artifactsDir,
        stateDir,
        logDir,
        baseBranch,
        docsDir,
        config,
        configuredCommandFolder,
        issueContext,
        dagPriorCompletedNodes,
        source,
        aiProfile,
        workflowPreset,
        scopeArtifactsDir,
        execContext,
        containerCtx,
        // Sub-run closure (#2121 Phase 2): captures executeWorkflow (this module — no
        // import cycle) so a `workflow:` node can spawn a governed child run in-process.
        // Also captures the per-child isolation resolver (slice 2, PR-A) so an
        // `isolation: 'worktree'` child gets its own worktree cwd.
        (childArgs: RunChildWorkflowArgs): Promise<ChildWorkflowOutcome> =>
          runChildWorkflow(
            deps,
            platform,
            childArgs,
            resolvedModelOverrides,
            effectiveRunConfig,
            resolveChildIsolation
          ),
        dagPriorUsage,
        priorNodeSessions,
        // Container runs resolve from the capture like every other run: it is bind-mounted
        // read-only at the SAME absolute path inside the container, so one source-roots
        // value means the same thing on both sides of the boundary.
        workflowSourceRoots,
        requireReportedCost
      )
    );

    // executeDagWorkflow throws on fatal errors; check DB status for result
    const finalStatus = await deps.store.getWorkflowRun(workflowRun.id);
    // Sub-run re-entry (#2121 Phase 2): if this run is a `workflow:` child that just
    // reached a terminal state, re-enter its paused parent in-process. Guarded to be
    // a no-op on the synchronous first-run path (parent still 'running'). Wrapped in
    // catch — a parent-resume failure must not corrupt the child's own result.
    if (
      finalStatus?.parent_run_id &&
      (finalStatus.status === 'completed' ||
        finalStatus.status === 'failed' ||
        finalStatus.status === 'cancelled')
    ) {
      await maybeResumeParentRun(
        deps,
        platform,
        conversationId,
        conversationDbId,
        finalStatus,
        // The parent resumes mid-DAG and may still have isolated sub-run nodes ahead
        // of it; without this it would fail them for a missing resolver the surface
        // did inject. Same resolver the child ran with — it is codebase-bound and the
        // child shares the parent's codebase.
        resolveChildIsolation
      ).catch((err: unknown) => {
        getLog().error(
          {
            err: err as Error,
            childRunId: workflowRun.id,
            parentRunId: finalStatus.parent_run_id,
          },
          'workflow.parent_auto_resume_failed'
        );
      });
    }
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
    // Release the keep-awake request FIRST — before the backstop DB calls that
    // may throw — so it always pairs with the acquire above this try, on every
    // exit path (success, thrown error, or backstop failure).
    keepAwake.release();
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
