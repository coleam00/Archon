import {
  continueBlockedRun,
  isFanOutParentReleased,
  maybeResumeParentRun,
  releaseContinuablePauseSlot,
} from './parent-resume';
import { runChildWorkflow } from './child-runs';
import {
  clearManagedProviderCredentialFiles,
  resolveUserProviderEnvForWorkflow,
  resolveWorkflowGithubEnvironment,
} from './run-credential-env';
import { admitWorkflowRun, recordRunCheckoutBaseline } from './run-admission';
import { resolveRunDispatch } from './run-dispatch';
import { prepareRunPaths } from './run-paths';
import {
  assertRunCredentials,
  effectiveDbCredentialValues,
  type PreparedRunAiConfiguration,
} from './run-preflight';
import {
  establishAdoptedRunSource,
  prepareWorkflowSource,
  type CapturedSourceOwner,
  type PreparedWorkflowSource,
} from './run-source';
import type { OwnedWorktree, WorkflowRunOrigin } from './schemas/workflow-run';
export type {
  ChildIsolationRequest,
  ChildIsolationResolver,
  ChildIsolationResult,
} from './child-isolation';
export type { ContainerRunContext, ContainerWriteBackBackend } from './container-context';
/**
 * Workflow Executor - runs DAG-based workflows
 */
import { createLogger } from '@archon/paths';
import type { ExecutionContext } from '@archon/provider-contract';
import type { ChildIsolationResolver } from './child-isolation';
import type { ContainerRunContext } from './container-context';
import { executeDagWorkflow, type PriorRunUsage } from './dag-executor';
import type { ChildWorkflowOutcome, RunChildWorkflowArgs } from './dag/child-run';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { spellWorkflowCommand } from './deps';
import { getWorkflowEventEmitter } from './event-emitter';
import { runWithAdoptedRunDir } from './workflow-variables';
import { withContainerArtifactsRoot } from './artifact-writes';
import { announceRunStart } from './run-start';
import { safeSendMessage, sendCriticalMessage } from './platform-messages';
import { logWorkflowError } from './logger';
import type {
  ResolvedWorkflow,
  WorkflowExecutionResult,
  WorkflowRun,
  WorkflowRunNodeSession,
  WorkflowSource,
} from './schemas';
import {
  SUBRUN_METADATA_KEYS,
  isApprovalContext,
  pendingWorkflowWaitDeadline,
  readSubrunMetadata,
  type ContinuationMode,
} from './schemas';
import type { WorkflowRunConfigInput } from './schemas/run-config';
import { RUN_GRAPH_METADATA_KEY, runGraphSchema } from './schemas/terminal-record';
import { deadlineWaitCursor, type PersistedNodeOutput, type PriorFailedNode } from './store';
import type { ResumeCause } from './run-resume';
import { TerminalStatusWriteError, requireTerminalStatusWrite } from './terminal-status-write';
import { keepAwake } from './utils/keep-awake';
import { defaultRunInputs } from './workflow-inputs';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
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
      /** The prior pass's failures; replayed only when `resumeCause` is `continue_after_wait`. */
      priorFailedNodes?: Map<string, PriorFailedNode>;
      resumeCause?: ResumeCause;
      priorUsage?: PriorRunUsage;
      priorNodeSessions?: readonly WorkflowRunNodeSession[];
    }
  | {
      preCreatedRun?: undefined;
      priorCompletedNodes?: undefined;
      priorFailedNodes?: undefined;
      resumeCause?: undefined;
      priorUsage?: undefined;
      priorNodeSessions?: undefined;
    };

/**
 * Optional parameters for {@link executeWorkflow}. All trailing args live here
 * so call sites stay readable as new options accrue.
 *
 * To resume a prior run, obtain the run, prior outputs, and prior usage from
 * `hydrateResumableRun` from `./run-resume` (or look up via `findResumableRun` and hydrate)
 * and spread them in. The executor never queries the store for a prior run on
 * its own; that decision belongs at the call site.
 */
export type ExecuteWorkflowOptions = ResumePayload & {
  ownedWorktree?: OwnedWorktree;
  preparedAiConfiguration?: PreparedRunAiConfiguration;
  /** Codebase ID for env vars + isolation context. */
  codebaseId?: string;
  /**
   * Caller-provided base branch fallback for `$BASE_BRANCH`, normally the
   * codebase's stored `default_branch`. Repo config still wins when
   * `worktree.baseBranch` is set, and `baseOverride` wins over both; git
   * auto-detection remains the last resort.
   */
  baseBranch?: string;
  /** Already resolved checkout base, including unresolved empty; recorded resumes take priority. */
  resolvedBaseBranch?: string;
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
  continuationMode?: ContinuationMode;
  /** One model-binding phase: raw at invocation boundaries, resolved for child runs. */
  modelOverrideLayer?: import('./run-preflight').RunAiConfigurationOptions['modelOverrideLayer'];
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
   * The commit the run's worktree branch was cut from, supplied only by a caller whose
   * isolation step created that branch for this run (#3305). Recorded on the run's
   * checkout baseline; never inferred when absent. Ignored on a resume.
   */
  cutFromCommit?: string;
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
};

/**
 * Execute a complete DAG-based workflow.
 *
 * Required positional args carry identity and dependencies. Everything else
 * lives in `opts` ({@link ExecuteWorkflowOptions}). To resume a prior run,
 * call `hydrateResumableRun` (`./run-resume`) first and spread its result into `opts` —
 * the executor does not perform resume detection on its own.
 */
export async function executeWorkflow(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  userMessage: string,
  origin?: WorkflowRunOrigin,
  opts: ExecuteWorkflowOptions = {}
): Promise<WorkflowExecutionResult> {
  const {
    codebaseId,
    issueContext,
    priorCompletedNodes,
    priorFailedNodes,
    resumeCause,
    priorUsage,
    priorNodeSessions,
    resolveChildIsolation,
    cutFromCommit,
  } = opts;

  const dispatched = await resolveRunDispatch(
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    origin,
    opts
  );
  if (dispatched.stopped) return dispatched.result;
  const dispatch = dispatched.value;
  const { execContext, container: containerCtx } = dispatch.execution;
  const { executionUserId, isContinuation, prepared, baseBranch, docsDir } = dispatch;
  const { config, dbEnvVars, aiProfile, resolvedModelOverrides, scope, effectiveRunConfig } =
    prepared;
  const configuredCommandFolder = config.commands.folder;
  const { provider: resolvedProvider, model: resolvedModel, preset: workflowPreset } = scope;

  const admitted = await admitWorkflowRun(
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    userMessage,
    origin,
    opts,
    dispatch
  );
  if (admitted.stopped) return admitted.result;
  const { workflowRun, checkoutBaselineSample } = admitted.value;

  const paths = await prepareRunPaths(
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    workflowRun,
    codebaseId
  );
  if (paths.stopped) return paths.result;
  const { artifactsDir, workflowSourceDir, logDir, stateDir, outputRoot, scopeArtifactsDir } =
    paths.value;
  // A container mounts this run's artifacts directory read-write, so engine writes into
  // it are checked against links the container planted. Entered on every run so a
  // child run never inherits its parent's root.
  const withArtifactWrites = <T>(operation: () => T): T =>
    withContainerArtifactsRoot(
      execContext.kind === 'container' ? artifactsDir : undefined,
      operation
    );

  if (checkoutBaselineSample !== undefined) {
    const baselineFailure = await withArtifactWrites(() =>
      recordRunCheckoutBaseline(
        deps,
        platform,
        conversationId,
        workflowRun,
        checkoutBaselineSample,
        artifactsDir,
        cutFromCommit
      )
    );
    if (baselineFailure) return baselineFailure;
  }

  const sourced = await establishAdoptedRunSource(
    deps,
    platform,
    conversationId,
    workflowRun,
    workflowSourceDir,
    opts,
    isContinuation,
    dispatch.execution
  );
  if (sourced.stopped) return sourced.result;
  const { workflowSourceRoots } = sourced.value;

  // Wrap execution in try-catch to ensure workflow is marked as failed on any error.
  //
  // Hold a Windows keep-awake request for the executing window (see
  // utils/keep-awake.ts for the Modern Standby / mid-run-death rationale and
  // best-effort semantics). Placed HERE, not at function top, so the
  // early-return validation paths above never leak an unpaired acquire; the
  // matching release is the first statement of this try's finally.
  keepAwake.acquire();
  // Set by every path that observes a rejected terminal status write — one arriving
  // from the DAG or a sub-run (the catch below), and the catch's own recovery write.
  // The finally-block backstop reads it: a second write over a channel that just
  // failed would either fail again or mask the real error.
  let terminalStatusWriteFailed = false;
  let sourceExecutionStopped = false;
  try {
    const adoptedRunDir = sourced.value.adoptedRunDir();

    // The environment stays fixed for this execution; resumed segments resolve again
    // through the provider's refresh cache. Resolve inside the run's failure boundary.
    Object.assign(
      config,
      await resolveWorkflowGithubEnvironment(deps, codebaseId, executionUserId, config)
    );
    const protectedEnvKeys = new Set(config.protectedEnvKeys);

    // Per-user AI-provider credentials (Phase 2). Resolved AFTER artifactsDir is
    // created because file-based deliveries (Pi's `auth.json`) live under it.
    // Clear files from an earlier invocation first, including the Codex
    // `auth.json` older builds wrote: a disconnected credential or failed refresh
    // must not leave stale secrets readable on resume.
    // Merged LAST into config.envVars so the originating user's keys
    // win over file/db/bot-github env — preserves the GitHub merge order and
    // keeps the no-key path byte-for-byte unchanged (resolveUserProviderEnvForWorkflow
    // returns empty bags when the feature is disabled or no userId is present).
    const { env: userProviderEnv, protectedValues } = await withArtifactWrites(async () => {
      await clearManagedProviderCredentialFiles(artifactsDir);
      await assertRunCredentials(deps, prepared, { cwd, execContext });
      return resolveUserProviderEnvForWorkflow(
        deps,
        executionUserId,
        artifactsDir,
        prepared.requirements,
        prepared.connectedVendors
      );
    });
    config.envVars = { ...config.envVars, ...userProviderEnv };
    config.userCredentialEnvKeys = Object.keys(userProviderEnv);
    for (const key of Object.keys(userProviderEnv)) {
      protectedEnvKeys.add(key);
    }
    if (protectedEnvKeys.size > 0) {
      config.protectedEnvKeys = [...protectedEnvKeys];
    }
    // Recomputed rather than appended to preflight's list: GitHub and provider credentials
    // layered above may have replaced a database value, which is then no longer delivered.
    config.protectedCredentialValues = [
      ...new Set([...effectiveDbCredentialValues(dbEnvVars, config.envVars), ...protectedValues]),
    ];

    // Capture the loaded graph on both fresh execution and resume before any node runs.
    const graph = runGraphSchema.parse({
      node_ids: workflow.nodes.map(node => node.id),
      ...(workflow.returns !== undefined ? { returns: workflow.returns } : {}),
    });
    await deps.store.updateWorkflowRun(workflowRun.id, {
      metadata: { [RUN_GRAPH_METADATA_KEY]: graph },
    });
    workflowRun.metadata = { ...workflowRun.metadata, [RUN_GRAPH_METADATA_KEY]: graph };

    await announceRunStart(
      deps,
      platform,
      conversationId,
      cwd,
      workflow,
      workflowRun,
      userMessage,
      opts,
      dispatch,
      { logDir, outputRoot }
    );

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

    // The adopted-dir scope (#2747) encloses only the DAG: a child sub-run spawned
    // from a node re-enters
    // `executeWorkflow` and scopes its own (absent) adoption.
    const dagResult = await runWithAdoptedRunDir(adoptedRunDir, () =>
      withArtifactWrites(() =>
        executeDagWorkflow({
          deps,
          platform,
          conversationId,
          cwd,
          workflow,
          workflowRun: runForDag,
          workflowProvider: resolvedProvider,
          workflowModel: resolvedModel,
          artifactsDir,
          stateDir,
          logDir,
          baseBranch,
          docsDir,
          config,
          configuredCommandFolder,
          issueContext,
          priorCompletedNodes,
          // Only a run continued after a pause has moved past its earlier failures.
          replayedFailures: resumeCause === 'continue_after_wait' ? priorFailedNodes : undefined,
          aiProfile,
          workflowPreset,
          scopeArtifactsDir,
          execContext,
          containerCtx,
          // Sub-run closure (#2121 Phase 2): captures executeWorkflow (this module — no
          // import cycle) so a `workflow:` node can spawn a governed child run in-process.
          // Also captures the per-child isolation resolver (slice 2, PR-A) so an
          // `isolation: 'worktree'` child gets its own worktree cwd.
          runChildWorkflow: (childArgs: RunChildWorkflowArgs): Promise<ChildWorkflowOutcome> =>
            runChildWorkflow(
              deps,
              platform,
              childArgs,
              resolvedModelOverrides,
              effectiveRunConfig,
              baseBranch,
              resolveChildIsolation
            ),
          priorUsage,
          priorNodeSessions,
          // Container runs resolve from the capture like every other run: it is bind-mounted
          // read-only at the SAME absolute path inside the container, so one source-roots
          // value means the same thing on both sides of the boundary.
          workflowSourceRoots,
        })
      )
    );

    if (typeof dagResult === 'object') {
      // After release another executor may own even a running row; the backstop has no authority.
      sourceExecutionStopped = true;
      if (dagResult.released) return { success: true, paused: true, workflowRunId: workflowRun.id };
    }
    const dagSummary = typeof dagResult === 'string' ? dagResult : undefined;

    // executeDagWorkflow throws on fatal errors; check DB status for result
    const finalStatus = await deps.store.getWorkflowRun(workflowRun.id);
    // Sub-run re-entry (#2121 Phase 2): if this run is a `workflow:` child that just
    // reached a terminal state, re-enter its paused parent in-process. Guarded to be
    // a no-op on the synchronous first-run path (parent still 'running').
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
        finalStatus,
        // The parent resumes mid-DAG and may still have isolated sub-run nodes ahead
        // of it; without this it would fail them for a missing resolver the surface
        // did inject. Same resolver the child ran with — it is codebase-bound and the
        // child shares the parent's codebase.
        resolveChildIsolation
      );
    }
    // A fan-out parent builds its gate from a fresh read of its children, then commits
    // its pause. A child that finished in between saw this run still `running`, so its
    // hook stood down; check again now that the pause is committed. Whichever side reads
    // second sees the other, and the resume claim lets only one of them continue.
    if (finalStatus?.status === 'paused') {
      const notifyStuck = async (reason: string): Promise<void> => {
        await safeSendMessage(
          platform,
          conversationId,
          `⚠️ Run \`${workflowRun.id.slice(0, 8)}\`'s sub-runs finished, but it couldn't ` +
            `continue (${reason}). Resume it manually: ` +
            `\`${spellWorkflowCommand(platform, `resume ${workflowRun.id}`)}\``
        );
      };
      let released = false;
      try {
        released =
          isApprovalContext(finalStatus.metadata.approval) &&
          finalStatus.metadata.approval.type === 'fan_out' &&
          (await isFanOutParentReleased(deps, finalStatus));
      } catch (err) {
        getLog().error(
          { err: err as Error, workflowRunId: workflowRun.id },
          'workflow.parent_resume_children_lookup_failed'
        );
        await notifyStuck('its sub-runs could not be looked up');
      }
      if (released) {
        const continued = await continueBlockedRun(
          deps,
          platform,
          conversationId,
          finalStatus,
          notifyStuck,
          {},
          resolveChildIsolation
        );
        if (continued !== undefined) return continued;
      }
    }
    if (finalStatus?.status === 'completed') {
      return { success: true, workflowRunId: workflowRun.id, summary: dagSummary };
    } else if (finalStatus?.status === 'paused') {
      const wait = pendingWorkflowWaitDeadline(finalStatus);
      const waitCursor = wait ? deadlineWaitCursor(wait) : undefined;
      await releaseContinuablePauseSlot(deps, finalStatus);
      return {
        success: true,
        paused: true,
        workflowRunId: workflowRun.id,
        ...(waitCursor ? { waitCursor } : {}),
      };
    } else {
      return {
        success: false,
        workflowRunId: workflowRun.id,
        error: 'Workflow did not complete successfully',
      };
    }
  } catch (error) {
    if (sourceExecutionStopped) throw error;
    if (error instanceof TerminalStatusWriteError) {
      terminalStatusWriteFailed = true;
      throw error;
    }

    // Top-level error handler: ensure workflow is marked as failed
    const err = error as Error;
    getLog().error(
      { err, workflowName: workflow.name, workflowId: workflowRun.id },
      'workflow_execution_unhandled_error'
    );

    // The log file and the user's notification are independent of the terminal write and
    // precede it, so a rejection cannot silence them. The live event follows the write:
    // it announces only a failure this call committed. Terminal telemetry is reported by
    // the run store after the write commits.
    //
    // Log to file (separate from database - non-blocking)
    try {
      await logWorkflowError(logDir, workflowRun.id, err.message);
    } catch (logError) {
      getLog().error(
        { err: logError as Error, workflowId: workflowRun.id },
        'workflow_error_log_write_failed'
      );
    }

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

    // A terminal status write is part of the result: if it fails, reject instead of
    // reporting a completed process for a row that still says running. Record that it
    // failed so the finally-block backstop below does not fire a second write over a
    // write channel that just proved unreliable — that write would mask this error.
    const emitter = getWorkflowEventEmitter();
    try {
      const { failed } = await requireTerminalStatusWrite(
        deps.store.failWorkflowRun(workflowRun.id, err.message, { exitReason: 'unhandled_error' }),
        {
          workflowRunId: workflowRun.id,
          site: 'db_record_failure_failed',
        }
      );
      // A run another writer already finished keeps that writer's outcome and announcement.
      if (failed) {
        emitter.emit({
          type: 'workflow_failed',
          runId: workflowRun.id,
          workflowName: workflow.name,
          error: err.message,
        });
      }
    } catch (writeError) {
      terminalStatusWriteFailed = true;
      throw writeError;
    } finally {
      emitter.unregisterRun(workflowRun.id);
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
    if (workflowRun && !terminalStatusWriteFailed && !sourceExecutionStopped) {
      const runId = workflowRun.id;
      const backstopStatus = await deps.store.getWorkflowRunStatus(runId).catch((err: unknown) => {
        // A failed lookup leaves status unknown, not missing or finalized. Preserve the
        // prior result/error rather than guessing a terminal transition from this read.
        getLog().warn(
          {
            workflowRunId: runId,
            operation: 'getWorkflowRunStatus',
            err,
            recovery:
              'The finalization check could not run. Restore store access and inspect the run ' +
              'with archon workflow get <run-id>. After checking ownership, use ' +
              'archon workflow abandon <run-id> only if the run should be stopped or discarded.',
          },
          'executor.backstop_status_read_failed'
        );
        return null;
      });
      if (backstopStatus === 'running') {
        getLog().warn({ workflowRunId: runId }, 'executor.backstop_triggered');
        await requireTerminalStatusWrite(
          deps.store.failWorkflowRun(runId, 'Workflow exited without finalizing — see logs', {
            exitReason: 'not_finalized',
          }),
          { workflowRunId: runId, site: 'executor.backstop_fail_failed' }
        );
      }
    }
  }
}
