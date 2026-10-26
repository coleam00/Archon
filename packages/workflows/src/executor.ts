import { runChildWorkflow } from './child-runs';
import { layerRunCredentials } from './run-credential-env';
import { admitWorkflowRun, recordRunCheckoutBaseline } from './run-admission';
import { resolveRunDispatch, type RunDispatch } from './run-dispatch';
import { prepareRunPaths, type PreparedRunPaths } from './run-paths';
import type { PreparedRunAiConfiguration } from './run-preflight';
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
import {
  executeDagWorkflow,
  type ExecuteDagWorkflowOptions,
  type PriorRunUsage,
} from './dag-executor';
import type { ChildWorkflowOutcome, RunChildWorkflowArgs } from './dag/child-run';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import type { RunPhase } from './executor-shared';
import { runWithAdoptedRunDir } from './workflow-variables';
import { withContainerArtifactsRoot } from './artifact-writes';
import { announceRunStart } from './run-start';
import { WorkflowExecutionHandoffError } from './engine-port';
import { recordUnhandledRunFailure, settleRunOutcome, type RunExitState } from './run-outcome';
import type {
  ResolvedWorkflow,
  WorkflowExecutionResult,
  WorkflowRun,
  WorkflowRunNodeSession,
  WorkflowSource,
} from './schemas';
import {
  SUBRUN_METADATA_KEYS,
  isTerminalRunStatus,
  readSubrunMetadata,
  type ContinuationMode,
} from './schemas';
import type { WorkflowRunConfigInput } from './schemas/run-config';
import { RUN_GRAPH_METADATA_KEY, runGraphSchema } from './schemas/terminal-record';
import { executionClaim, type PersistedNodeOutput, type PriorFailedNode } from './store';
import type { ResumeCause } from './run-resume';
import { requireTerminalStatusWrite } from './terminal-status-write';
import { enterRunExecution, releaseRunScratch } from './run-scratch';
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
  /** Binds host termination handling to the admitted execution, before any node can publish a pause. */
  onExecutionClaimed?: (claim: string | null) => void;
  /** Transfers scratch cleanup to a host that must drain it after reporting the outcome. */
  deferScratchCleanup?: (cleanup: () => Promise<void>) => void;
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
  if (opts.preCreatedRun?.status === 'running')
    opts.onExecutionClaimed?.(executionClaim(opts.preCreatedRun.metadata));

  const started = await startRun(
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    userMessage,
    origin,
    opts
  );
  if (started.stopped) return started.result;
  const { dispatch, workflowRun, paths, withArtifactWrites } = started.value;

  // Wrap execution in try-catch to ensure workflow is marked as failed on any error.
  //
  // Hold a Windows keep-awake request for the executing window (see
  // utils/keep-awake.ts for the Modern Standby / mid-run-death rationale and
  // best-effort semantics). Source establishment is inside the paired window;
  // its stopped results also release through this try's finally.
  keepAwake.acquire();
  const leaveRunExecution = enterRunExecution(workflowRun.id);
  const exit: RunExitState = { executionStopped: false, terminalStatusWriteFailed: false };
  try {
    const sourced = await establishAdoptedRunSource(
      deps,
      platform,
      conversationId,
      workflowRun,
      paths.workflowSourceDir,
      opts,
      dispatch.isContinuation,
      dispatch.execution
    );
    if (sourced.stopped) {
      exit.executionStopped = true;
      return sourced.result;
    }
    const { workflowSourceRoots } = sourced.value;
    const adoptedRunDir = sourced.value.adoptedRunDir();

    await layerRunCredentials(
      deps,
      dispatch,
      { runId: workflowRun.id, cwd, codebaseId: opts.codebaseId, artifactsDir: paths.artifactsDir },
      withArtifactWrites
    );
    await recordRunGraph(deps, workflow, workflowRun);
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
      paths
    );

    // The adopted-dir scope (#2747) encloses only the DAG: a child sub-run spawned
    // from a node re-enters
    // `executeWorkflow` and scopes its own (absent) adoption.
    const dagResult = await runWithAdoptedRunDir(adoptedRunDir, () =>
      withArtifactWrites(() =>
        executeDagWorkflow(
          dagArgs(deps, platform, conversationId, cwd, workflow, workflowRun, opts, {
            dispatch,
            paths,
            workflowSourceRoots,
          })
        )
      )
    );
    return await settleRunOutcome(
      deps,
      platform,
      conversationId,
      workflowRun,
      dagResult,
      opts,
      exit
    );
  } catch (error) {
    exit.executionStopped ||= error instanceof WorkflowExecutionHandoffError;
    if (exit.executionStopped) throw error;
    return await recordUnhandledRunFailure(
      deps,
      platform,
      conversationId,
      workflow,
      workflowRun,
      paths.logDir,
      error,
      exit
    );
  } finally {
    // Release the keep-awake request FIRST — before the backstop DB calls that
    // may throw — so it always pairs with the acquire above this try, on every
    // exit path (success, thrown error, or backstop failure).
    keepAwake.release();
    leaveRunExecution();
    if (!exit.terminalStatusWriteFailed) {
      if (!exit.executionStopped) await failRunLeftRunning(deps, workflowRun.id);
      await releaseScratchOnExit(deps, workflowRun, opts.deferScratchCleanup);
    }
  }
}

interface StartedRun {
  dispatch: RunDispatch;
  workflowRun: WorkflowRun;
  paths: PreparedRunPaths;
  /**
   * A container mounts this run's artifacts directory read-write, so engine writes into
   * it are checked against links the container planted. Entered on every run so a
   * child run never inherits its parent's root.
   */
  withArtifactWrites: <T>(operation: () => T) => T;
}

/**
 * Resolve the dispatch, admit the run, prepare its directories and record its checkout
 * baseline. Each phase either hands its value on or ends the execution with a result.
 */
async function startRun(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  userMessage: string,
  origin: WorkflowRunOrigin | undefined,
  opts: ExecuteWorkflowOptions
): Promise<RunPhase<StartedRun>> {
  const dispatched = await resolveRunDispatch(
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    origin,
    opts
  );
  if (dispatched.stopped) return dispatched;
  const dispatch = dispatched.value;

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
  if (admitted.stopped) return admitted;
  const { workflowRun, checkoutBaselineSample } = admitted.value;

  const paths = await prepareRunPaths(
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    workflowRun,
    opts.codebaseId
  );
  if (paths.stopped) return paths;
  const artifactsRoot =
    dispatch.execution.execContext.kind === 'container' ? paths.value.artifactsDir : undefined;
  const withArtifactWrites = <T>(operation: () => T): T =>
    withContainerArtifactsRoot(artifactsRoot, operation);

  if (checkoutBaselineSample !== undefined) {
    const baselineFailure = await withArtifactWrites(() =>
      recordRunCheckoutBaseline(
        deps,
        platform,
        conversationId,
        workflowRun,
        checkoutBaselineSample,
        paths.value.artifactsDir,
        opts.cutFromCommit
      )
    );
    if (baselineFailure) return { stopped: true, result: baselineFailure };
  }
  return {
    stopped: false,
    value: { dispatch, workflowRun, paths: paths.value, withArtifactWrites },
  };
}

/** Capture the loaded graph on both fresh execution and resume before any node runs. */
async function recordRunGraph(
  deps: WorkflowDeps,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun
): Promise<void> {
  const graph = runGraphSchema.parse({
    node_ids: workflow.nodes.map(node => node.id),
    ...(workflow.returns !== undefined ? { returns: workflow.returns } : {}),
  });
  await deps.store.updateWorkflowRun(workflowRun.id, {
    metadata: { [RUN_GRAPH_METADATA_KEY]: graph },
  });
  workflowRun.metadata = { ...workflowRun.metadata, [RUN_GRAPH_METADATA_KEY]: graph };
}

/**
 * Declared-input defaults for a run with no caller (#2470). Runtime `$INPUTS` otherwise
 * comes only from `metadata.inputs`, which a parent stamps at spawn — so a workflow
 * started directly (CLI / chat / web) would throw on its own `$INPUTS.<name>` while the
 * identical workflow invoked as a `workflow:` child resolved it. Derived from the
 * definition rather than persisted, so it stays correct across a cold resume and when the
 * defaults are later edited. Any caller-supplied value already on the row wins; only
 * defaults are filled in.
 *
 * The effective map is layered under the LOGICAL sibling key (#2637): defaults may now be
 * typed (`default: true`), and `readSubrunMetadata` prefers `inputs_values`, so the
 * in-memory overlay must not push a non-string value into the legacy text map (a shipped
 * binary reads a non-string `inputs` as corrupt). This overlay is never persisted — it
 * only shapes what resolveRunInputs sees for this execution.
 */
function withDeclaredInputDefaults(
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun
): WorkflowRun {
  const declaredDefaults = defaultRunInputs(workflow.inputs);
  if (!declaredDefaults) return workflowRun;
  const metadata = workflowRun.metadata as Record<string, unknown> | undefined;
  return {
    ...workflowRun,
    metadata: {
      ...metadata,
      [SUBRUN_METADATA_KEYS.inputsValues]: {
        ...declaredDefaults,
        ...(readSubrunMetadata(metadata).inputs ?? {}),
      },
    },
  };
}

function dagArgs(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  opts: ExecuteWorkflowOptions,
  run: {
    dispatch: RunDispatch;
    paths: PreparedRunPaths;
    workflowSourceRoots: ExecuteDagWorkflowOptions['workflowSourceRoots'];
  }
): ExecuteDagWorkflowOptions {
  const { dispatch, paths } = run;
  const { baseBranch, prepared } = dispatch;
  const { config, aiProfile, resolvedModelOverrides, scope, effectiveRunConfig } = prepared;
  return {
    deps,
    platform,
    conversationId,
    cwd,
    workflow,
    workflowRun: withDeclaredInputDefaults(workflow, workflowRun),
    workflowProvider: scope.provider,
    workflowModel: scope.model,
    artifactsDir: paths.artifactsDir,
    stateDir: paths.stateDir,
    logDir: paths.logDir,
    baseBranch,
    docsDir: dispatch.docsDir,
    config,
    configuredCommandFolder: config.commands.folder,
    issueContext: opts.issueContext,
    priorCompletedNodes: opts.priorCompletedNodes,
    // Only a run continued after a pause has moved past its earlier failures.
    replayedFailures:
      opts.resumeCause === 'continue_after_wait' ? opts.priorFailedNodes : undefined,
    aiProfile,
    workflowPreset: scope.preset,
    scopeArtifactsDir: paths.scopeArtifactsDir,
    execContext: dispatch.execution.execContext,
    containerCtx: dispatch.execution.container,
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
        opts.resolveChildIsolation
      ),
    priorUsage: opts.priorUsage,
    priorNodeSessions: opts.priorNodeSessions,
    // Container runs resolve from the capture like every other run: it is bind-mounted
    // read-only at the SAME absolute path inside the container, so one source-roots
    // value means the same thing on both sides of the boundary.
    workflowSourceRoots: run.workflowSourceRoots,
  };
}

// Only an execution that still owns running work may invoke this backstop.
async function failRunLeftRunning(deps: WorkflowDeps, runId: string): Promise<void> {
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

/**
 * The executor releases the scratch of every run it ends or sees ended while executing:
 * a terminal write it did not make (a cooperative cancel, a fan-out cancel) commits while
 * its nodes may still write. They have stopped now. A run released and resumed by another
 * executor names that executor as its owner, so `releaseRunScratch` keeps its scratch
 * while that executor may still run.
 */
async function releaseScratchOnExit(
  deps: WorkflowDeps,
  executed: WorkflowRun,
  deferCleanup?: ExecuteWorkflowOptions['deferScratchCleanup']
): Promise<void> {
  const cleanup = async (): Promise<void> => {
    const run = await deps.store.getWorkflowRun(executed.id).catch((err: unknown) => {
      getLog().warn({ workflowRunId: executed.id, err }, 'executor.exit_scratch_lookup_failed');
      return null;
    });
    if (run && isTerminalRunStatus(run.status)) await releaseRunScratch(run);
  };
  if (deferCleanup) deferCleanup(cleanup);
  else await cleanup();
}
