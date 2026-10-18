import {
  continueBlockedRun,
  isFanOutParentReleased,
  maybeResumeParentRun,
  releaseContinuablePauseSlot,
  runChildWorkflow,
} from './child-runs';
import {
  clearManagedProviderCredentialFiles,
  resolveUserProviderEnvForWorkflow,
  resolveWorkflowGithubEnvironment,
} from './run-credential-env';
import { admitWorkflowRun } from './run-admission';
import { resolveRunDispatch } from './run-dispatch';
import { resolveProjectPaths, resolveScopeArtifactsDir } from './run-paths';
import {
  assertRunCredentials,
  effectiveDbCredentialValues,
  type PreparedRunAiConfiguration,
} from './run-preflight';
import {
  prepareWorkflowSource,
  preparedWorkflowSourceRecord,
  type CapturedSourceOwner,
  type PreparedWorkflowSource,
} from './run-source';
import { isContainerRun, type OwnedWorktree, type WorkflowRunOrigin } from './schemas/workflow-run';
export type {
  ChildIsolationRequest,
  ChildIsolationResolver,
  ChildIsolationResult,
} from './child-isolation';
export type { ContainerRunContext, ContainerWriteBackBackend } from './container-context';
/**
 * Workflow Executor - runs DAG-based workflows
 */
import * as archonPaths from '@archon/paths';
import { captureWorkflowInvoked, createLogger } from '@archon/paths';
import type { ExecutionContext } from '@archon/provider-contract';
import { mkdir, rename, rm } from 'fs/promises';
import { dirname } from 'path';
import { recordCheckoutSample } from './checkout-observation';
import type { ChildIsolationResolver } from './child-isolation';
import type { ContainerRunContext } from './container-context';
import { executeDagWorkflow, type PriorRunUsage } from './dag-executor';
import type { ChildWorkflowOutcome, RunChildWorkflowArgs } from './dag/child-run';
import { formatDeprecationNotice } from './deprecation';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { sourceReleaseNotice, spellWorkflowCommand } from './deps';
import { getWorkflowEventEmitter } from './event-emitter';
import {
  runWithAdoptedRunDir,
  safeSendMessage,
  sendCriticalMessage,
  type SendMessageContext,
} from './executor-shared';
import { logWorkflowError, logWorkflowResume, logWorkflowStart } from './logger';
import type {
  ResolvedWorkflow,
  WorkflowExecutionResult,
  WorkflowRun,
  WorkflowRunNodeSession,
  WorkflowSource,
} from './schemas';
import {
  RUN_METADATA_KEYS,
  SUBRUN_METADATA_KEYS,
  WORKFLOW_SOURCE_METADATA_KEY,
  isApprovalContext,
  isExecNode,
  isGateNode,
  isLoopGroupNode,
  isLoopNode,
  pendingWorkflowWaitDeadline,
  persistScopeKey,
  readContinuationMode,
  readIdentityUnresolved,
  readSubrunMetadata,
  readWorkflowSourceState,
  runMayPersistSessions,
  type ContinuationMode,
} from './schemas';
import type { WorkflowRunConfigInput } from './schemas/run-config';
import { RUN_GRAPH_METADATA_KEY, runGraphSchema } from './schemas/terminal-record';
import { maybeWarnLegacyArtifactsPath, maybeWarnLegacyStatePath } from './state-migration';
import {
  CONTINUATION_RETRY_MS,
  deadlineWaitCursor,
  executionClaim,
  type PersistedNodeOutput,
} from './store';
import { workflowTelemetryShape } from './telemetry-shape';
import { TerminalStatusWriteError, requireTerminalStatusWrite } from './terminal-status-write';
import { keepAwake } from './utils/keep-awake';
import { defaultRunInputs } from './workflow-inputs';
import {
  WorkflowSourceUnavailableError,
  capturedSourceRoots,
  isSourceReadFailure,
  resolveRunSourceCapture,
  type WorkflowSourceCapture,
  type WorkflowSourceRoots,
} from './workflow-source';

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
    isolationContext,
    priorCompletedNodes,
    priorUsage,
    priorNodeSessions,
    parseWarnings,
    execContext = { kind: 'host' },
    container: containerCtx,
    resolveChildIsolation,
    preparedSource,
    adoptedFromRunId,
    continuationMode,
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
  const { executionUserId, isContinuation, prepared, baseBranch, runSource, docsDir } = dispatch;
  const {
    config,
    dbEnvVars,
    baseAiProfile,
    aiProfile,
    resolvedModelOverrides,
    scope,
    effectiveRunConfig,
  } = prepared;
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

  // Resolve external artifact, log, and state directories. A resumed run
  // carries its `output_root` and short-circuits identity resolution entirely.
  const {
    artifactsDir,
    workflowSourceDir,
    logDir,
    artifactsRoot,
    stateDir,
    outputRoot,
    identityResolution,
  } = await resolveProjectPaths(deps, cwd, workflowRun.id, codebaseId, {
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
  //   • anyone reading the row can tell "unregistered" apart from "we could not
  //     tell";
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
      await deps.store
        .updateWorkflowRun(workflowRun.id, updates)
        .then(() => {
          // Keep the in-memory row in step with the write, exactly as the faulted arm
          // does for `identity_unresolved`. Every in-run reader of `output_root` — the
          // artifact-pointer gate (#2453) is the first — would otherwise see NULL on the
          // very run that just recorded its own location, and only agree with the
          // database after a resume reloaded the row.
          workflowRun.output_root = outputRoot;
        })
        .catch((err: Error) => {
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
  // workflows, keyed like the session store. Undefined otherwise — zero new dirs.
  const scopeArtifactsDir = resolveScopeArtifactsDir(
    workflow,
    persistScopeKey(workflowRun),
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
    await sendCriticalMessage(
      platform,
      conversationId,
      `❌ **Workflow failed**: Could not create artifacts directory \`${artifactsDir}\`: ${err.message}`
    );
    await requireTerminalStatusWrite(
      deps.store.failWorkflowRun(
        workflowRun.id,
        `Artifacts directory creation failed: ${err.message}`
      ),
      { workflowRunId: workflowRun.id, site: 'workflow.artifacts_dir_fail_db_record_failed' }
    );
    return {
      success: false,
      workflowRunId: workflowRun.id,
      error: `Artifacts directory creation failed: ${err.message}`,
    };
  }
  getLog().debug({ artifactsDir, logDir, stateDir, outputRoot }, 'workflow_paths_resolved');

  if (checkoutBaselineSample !== undefined) {
    // Persisting the baseline is run infrastructure: a run that cannot record where it
    // started fails here, before its first node. An unobservable checkout is not a
    // failure — it is recorded as an `unavailable` observation.
    try {
      workflowRun.checkout_baseline = await deps.store.recordWorkflowRunCheckoutBaseline(
        workflowRun.id,
        await recordCheckoutSample(
          checkoutBaselineSample,
          { runId: workflowRun.id, artifactsDir },
          cutFromCommit !== undefined ? { cutFromCommit } : {}
        )
      );
    } catch (error) {
      const err = error as Error;
      getLog().error(
        { err, workflowRunId: workflowRun.id },
        'workflow.checkout_baseline_persist_failed'
      );
      await sendCriticalMessage(
        platform,
        conversationId,
        '❌ **Workflow failed**: Unable to record the run checkout baseline.'
      );
      await requireTerminalStatusWrite(
        deps.store.failWorkflowRun(
          workflowRun.id,
          `Checkout baseline could not be recorded: ${err.message}`
        ),
        { workflowRunId: workflowRun.id, site: 'workflow.checkout_baseline_fail_db_record_failed' }
      );
      return {
        success: false,
        workflowRunId: workflowRun.id,
        error: `Checkout baseline could not be recorded: ${err.message}`,
      };
    }
  }

  // Between-run continuation (#2747): resolve $ADOPTED_RUN_DIR through the
  // adopted run's persisted `output_root` (rename-safe per #2200) and announce
  // the continuation on THIS run's own event log so the chain renders without a
  // column join. Read-only by contract — this run writes to its own artifacts;
  // stores are never merged, so evidence stays attributable per run.
  // Resolution also runs on resume: a resumed run carries no caller-supplied id,
  // but its row still records the continuation, and every remaining node may
  // reference $ADOPTED_RUN_DIR (only for adoption; supersession has no estate).
  // Only the announcement event stays creation-only — it was written once when
  // the continuation was made.
  const effectiveAdoptedFromRunId = adoptedFromRunId ?? workflowRun.adopted_from_run_id;
  // On a fresh invocation the caller supplies the mode alongside the id. On
  // resume neither is in opts — the executor reads the row's metadata stamp.
  const effectiveContinuationMode =
    continuationMode ?? readContinuationMode(workflowRun.metadata) ?? 'adopt';
  let adoptedRunDir: string | undefined;
  if (effectiveAdoptedFromRunId) {
    // Supersession is metadata-only (#3064): no estate, so skip the output_root
    // gate and the $ADOPTED_RUN_DIR resolution that only adoption needs.
    if (effectiveContinuationMode !== 'supersede') {
      const adopted = await deps.store.getWorkflowRun(effectiveAdoptedFromRunId);
      // Deliberately precedes the resolver below: a missing persisted root is
      // corruption, not relocation, so adoption refuses rather than re-deriving
      // from a codebase row the way the display-only CLI/server readers would.
      if (!adopted?.output_root) {
        throw new Error(
          `Cannot adopt run '${effectiveAdoptedFromRunId}': it has no persisted output root, so its ` +
            'artifact directory cannot be addressed.'
        );
      }
      // #3097 — route the adopted run's persisted output_root through the
      // shared resolver so the same ARCHON_HOME containment check every other
      // persisted-root reader (CLI leave-behind, server artifact route) already
      // applies here. An out-of-tree value is refused unless the adopted run's
      // codebase row can re-derive a root under the current ARCHON_HOME.
      const adoptedCodebase = adopted.codebase_id
        ? await deps.store.getCodebase(adopted.codebase_id)
        : null;
      const adoptedRoot = archonPaths.resolveRunStorageRoot(adopted, adoptedCodebase);
      if (!adoptedRoot) {
        throw new Error(
          `Cannot adopt run '${effectiveAdoptedFromRunId}': its persisted output root is outside ARCHON_HOME and cannot be re-derived, so its artifact directory cannot be addressed.`
        );
      }
      adoptedRunDir = archonPaths.getRunArtifactsDirForRoot(adoptedRoot, effectiveAdoptedFromRunId);
    }
    if (!isContinuation) {
      try {
        await deps.store.createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'workflow.run_adopted',
          data: {
            adopted_from_run_id: effectiveAdoptedFromRunId,
            mode: effectiveContinuationMode,
          },
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
    await sendCriticalMessage(platform, conversationId, `❌ **Workflow failed**: ${message}`);
    await requireTerminalStatusWrite(
      deps.store.failWorkflowRun(workflowRun.id, message, { exitReason: 'source_unavailable' }),
      {
        workflowRunId: workflowRun.id,
        site: 'workflow.source_fail_db_record_failed',
      }
    );
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
    let loaded: WorkflowSourceCapture;
    try {
      const capture = await resolveRunSourceCapture(workflowRun.metadata);
      if (!capture) throw new Error('workflow source record disappeared during resolution');
      loaded = capture;
    } catch (error) {
      if (isSourceReadFailure(error)) {
        const path =
          error instanceof WorkflowSourceUnavailableError ? error.path : recordedSource.root;
        getLog().warn(
          { workflowRunId: workflowRun.id, path, err: error },
          'workflow.source_restore_unreadable'
        );
        const { released } = await deps.store.releaseRunForUnreadableSource(workflowRun.id, {
          claimId: executionClaim(workflowRun.metadata),
          nodeId: 'workflow-source',
          path,
          error: error instanceof Error ? error.message : String(error),
          retryAt: new Date(Date.now() + CONTINUATION_RETRY_MS).toISOString(),
        });
        if (released) {
          await safeSendMessage(
            platform,
            conversationId,
            sourceReleaseNotice(platform, workflowRun.id, {
              path,
              container: isContainerRun(workflowRun),
            })
          );
          return { success: true, paused: true, workflowRunId: workflowRun.id };
        }
        const current = await deps.store.getWorkflowRun(workflowRun.id);
        if (current?.status === 'paused') {
          return { success: true, paused: true, workflowRunId: workflowRun.id };
        }
        if (current?.status === 'completed') {
          return { success: true, workflowRunId: workflowRun.id };
        }
        return {
          success: false,
          workflowRunId: workflowRun.id,
          error: 'Workflow status changed before source release',
        };
      }
      return await failRunOnSource(
        `This run's captured workflow source at ${recordedSource.root} is missing or altered ` +
          `(${(error as Error).message}). The run cannot be resumed against different source; ` +
          'start a fresh run to execute the current workflow.'
      );
    }
    workflowSourceRoots = capturedSourceRoots(loaded.anchor);
    getLog().debug(
      { workflowRunId: workflowRun.id, captureRoot: recordedSource.root },
      'workflow.source_restored'
    );
    if (recordedSource.source_config === undefined) {
      // A run from before the row carried `source_config`. The manifest sits outside
      // the digest, so nothing can prove these settings are the ones the run started
      // with; what pinning them now buys is closing the window. From here on they are
      // held beside the digest, and a later edit to the manifest is refused like any
      // other drift instead of being re-read on every resume for the life of the run.
      const pinned = { ...recordedSource, source_config: loaded.anchor.config };
      workflowRun.metadata = { ...workflowRun.metadata, [WORKFLOW_SOURCE_METADATA_KEY]: pinned };
      await deps.store.updateWorkflowRun(workflowRun.id, {
        metadata: { [WORKFLOW_SOURCE_METADATA_KEY]: pinned },
      });
      getLog().warn(
        { workflowRunId: workflowRun.id, captureRoot: recordedSource.root },
        'workflow.source_config_pinned_from_manifest'
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
    // Move the staged capture to this run's own source directory, so it stops
    // accumulating in a staging directory nothing reclaims. That directory sits BESIDE
    // the run's artifacts, not inside them: `$ARTIFACTS_DIR` is handed to every node and
    // listed as the run's output, and the frozen pack is neither an output nor something
    // a node should reach by that path. Same filesystem, so this is a rename.
    const finalCaptureRoot = workflowSourceDir;
    try {
      if (preparedSource.anchor.root !== finalCaptureRoot) {
        // Unlike `artifactsDir`, nothing earlier in the run creates this parent.
        await mkdir(dirname(finalCaptureRoot), { recursive: true });
        await rm(finalCaptureRoot, { recursive: true, force: true });
        await rename(preparedSource.anchor.root, finalCaptureRoot);
      }
      // The staged capture is now at the run's own source path — the run owns the
      // bytes from this point on. Adopting here (not earlier, at the call site) is
      // what closes the race in #2690: a rename failure above returns without reaching
      // this line, so the wrap's `finally` reclaims the staged directory instead of
      // leaving it to the hourly age-based sweep.
      opts.capturedSourceOwner?.adopt();
    } catch (error) {
      return await failRunOnSource(
        `Could not move this run's captured workflow source into place: ${(error as Error).message}`
      );
    }
    const sourceAnchor = { ...preparedSource.anchor, root: finalCaptureRoot };
    workflowSourceRoots = capturedSourceRoots(sourceAnchor);
    const sourceRecord = preparedWorkflowSourceRecord({
      ...preparedSource,
      anchor: sourceAnchor,
    });
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
    await clearManagedProviderCredentialFiles(artifactsDir);
    await assertRunCredentials(deps, prepared);
    const { env: userProviderEnv, protectedValues } = await resolveUserProviderEnvForWorkflow(
      deps,
      executionUserId,
      artifactsDir,
      prepared.requirements,
      prepared.connectedVendors
    );
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

    getLog().info(
      {
        workflowName: workflow.name,
        workflowRunId: workflowRun.id,
        hasIssueContext: !!issueContext,
        issueContextLength: issueContext?.length ?? 0,
      },
      'workflow_starting'
    );
    // `isContinuation`, not `priorCompletedNodes`: a failed child re-entered without a
    // resumable snapshot is still a resume of an existing run.
    if (isContinuation) {
      await logWorkflowResume(logDir, workflowRun.id, workflow.name);
    } else {
      await logWorkflowStart(logDir, workflowRun.id, workflow.name, userMessage);
    }

    // Register run with emitter and emit workflow_started
    const emitter = getWorkflowEventEmitter();
    emitter.registerRun(workflowRun.id, conversationId);

    const transcriptPath = archonPaths.getRunLogPathForRoot(outputRoot, workflowRun.id);
    emitter.emit({
      type: 'workflow_started',
      runId: workflowRun.id,
      workflowName: workflow.name,
      conversationId: workflowRun.conversation_id,
      transcriptPath,
    });

    // Fire-and-forget anonymous usage telemetry. Categorical only: bundled
    // workflows report their real name, custom ones report "custom". No PII —
    // descriptions/prompts/paths are never sent. Machine context + version ride
    // along as super-properties. Opt out: ARCHON_TELEMETRY_DISABLED=1 / DO_NOT_TRACK=1.
    const telemetryNodes = workflow.nodes;
    captureWorkflowInvoked({
      runId: workflowRun.id,
      isChild: workflowRun.parent_run_id != null,
      workflowName: workflow.name,
      workflowSource: runSource,
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
      usesPersistSession: runMayPersistSessions(workflow),
      usesMcp: telemetryNodes.some(n => n.mcp !== undefined),
      usesSkills: telemetryNodes.some(n => n.skills !== undefined),
      usesFreshContext: telemetryNodes.some(n => isLoopNode(n) && n.loop.fresh_context),
      usedIsolation: isolationContext !== undefined,
      isResume: isContinuation,
      ...workflowTelemetryShape(deps.providers, workflow, runSource),
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
          transcriptPath,
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

    // Deprecated bundled default (#2781). Recorded here like the parse warnings
    // above so every run surface — REST/detached starts included, which have no
    // conversation to post into — carries the removal notice on its durable trace.
    // The chat/web message that mirrors this is best-effort; this record cannot fail.
    const deprecationNotice = formatDeprecationNotice(workflow);
    if (deprecationNotice) {
      deps.store
        .createWorkflowEvent({
          workflow_run_id: workflowRun.id,
          event_type: 'workflow_deprecation_notice',
          data: {
            workflowName: workflow.name,
            notice: deprecationNotice,
          },
        })
        .catch((err: Error) => {
          getLog().error(
            { err, workflowRunId: workflowRun.id, eventType: 'workflow_deprecation_notice' },
            'workflow_event_persist_failed'
          );
        });
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

    // The adopted-dir scope (#2747) encloses only the DAG: a child sub-run spawned
    // from a node re-enters
    // `executeWorkflow` and scopes its own (absent) adoption.
    const dagResult = await runWithAdoptedRunDir(adoptedRunDir, () =>
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
            resolveChildIsolation
          ),
        priorUsage,
        priorNodeSessions,
        // Container runs resolve from the capture like every other run: it is bind-mounted
        // read-only at the SAME absolute path inside the container, so one source-roots
        // value means the same thing on both sides of the boundary.
        workflowSourceRoots,
      })
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
      const backstopStatus = await deps.store.getWorkflowRunStatus(runId).catch(() => null);
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
