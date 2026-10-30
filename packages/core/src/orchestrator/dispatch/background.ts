import { continuationInheritsEstate } from '@archon/workflows/schemas/workflow-run';
import type { ResolvedRunContinuation } from '../../operations/workflow-continuation';
// Background dispatch: run a workflow in a hidden worker conversation, bridged to the
// parent, and return once the run is submitted. Its phases, in order: estate, source and
// AI configuration, worker conversation, pre-created run, worker checkout, announcement,
// then the detached run in background-run.ts.
import { createLogger } from '@archon/paths';
import type { IsolationHints } from '@archon/isolation';
import * as sqlIsolation from '@archon/core/db/isolation-environments';
import { providerRegistry } from '@archon/providers';
import { WORKFLOW_RUN_CONFIG_METADATA_KEY } from '@archon/workflows/run-config';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/run-ai-configuration';
import {
  prepareRunAiConfiguration,
  assertRunCredentials,
  type PreparedRunAiConfiguration,
} from '@archon/workflows/run-preflight';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { requireTerminalStatusWrite } from '@archon/workflows/terminal-status-write';
import {
  prepareWorkflowSource,
  recordSelectedWorkflow,
  withCapturedSource,
  type CapturedSourceOwner,
  type PreparedWorkflowSource,
} from '@archon/workflows/run-source';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import {
  SUBRUN_METADATA_KEYS,
  CONTINUATION_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import type { ResolvedWorkflow, WorkflowSource } from '@archon/workflows/schemas/workflow';
import type { RunModelOverrides } from '@archon/workflows/model-validation';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { IPlatformAdapter, Codebase, Conversation } from '../../types';
import { adoptRegisteredWorktree, type AdoptionLane } from '../../operations/workflow-adoption';
import * as db from '../../db/conversations';
import { getCodebase } from '../../db/codebases';
import { toError } from '../../utils/error';
import { resolveWorkflowSourceRoot } from '../../utils/workflow-source-root';
import { loadConfig } from '../../config/config-loader';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import { createCodebaseChildResolver } from '../../workflows/child-isolation-resolver';
import { withBranchLaunchSource } from '../../workflows/branch-launch-source';
import {
  createRunWorktreeSetupExecutor,
  recordSetupRunSource,
  retainSetupRunSource,
} from '../../workflows/worktree-setup';
import { startRunLiveOwner } from '../../services/run-live-owner';
import { validateAndResolveIsolation } from './isolation-resolver';
import { runInBackground, type BackgroundRun, type WorkerCheckout } from './background-run';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator');
  return cachedLog;
}

/**
 * Context for workflow routing - avoids passing many parameters
 */
export interface WorkflowRoutingContext {
  readonly platform: IPlatformAdapter;
  readonly conversationId: string;
  readonly cwd: string;
  readonly originalMessage: string;
  readonly conversationDbId: string;
  readonly codebaseId?: string;
  readonly availableWorkflows: readonly ResolvedWorkflow[];
  /**
   * GitHub issue/PR context built from webhook events.
   * Contains formatted markdown with: issue title, author, labels, and body.
   * Passed to workflow executor for substitution into $CONTEXT variables.
   */
  readonly issueContext?: string;
  /**
   * Isolation environment context for consolidated startup message.
   */
  readonly isolationEnv?: {
    readonly branch_name: string;
  };
  /**
   * Hints for isolation environment (PR review context, etc.)
   */
  readonly isolationHints?: IsolationHints;
  /**
   * Archon user UUID — populated by chat/forge adapters via
   * findOrCreateUserByPlatformIdentity. Propagated to the worker conversation,
   * worker isolation environment, and downstream workflow_run row.
   */
  readonly userId?: string;
  /**
   * Discovery source of the workflow — telemetry only (bundled workflows
   * report their real name, custom ones report "custom"). Optional; defaults
   * to the privacy-safe "custom" treatment when not provided.
   */
  readonly source?: WorkflowSource;
  /**
   * Keys the engine dropped from the workflow's YAML (#2213). Forwarded to the
   * executor so a background (web/console) run records them on the run like any
   * other, independently of the chat notification.
   */
  readonly parseWarnings?: readonly string[];
  /**
   * Declared inputs supplied by the caller (#2554), already validated at the dispatch
   * gate. This path PRE-CREATES the run row (so the UI can fetch it immediately), which
   * means the executor's own row-creation branch never runs — the values are stamped on
   * the pre-created row below, and also passed to `executeWorkflow` for the fallback
   * path where pre-creation failed and the executor creates the row itself.
   */
  readonly inputs?: Readonly<Record<string, string>>;
  /** Sparse tier/@alias rebindings supplied by this invocation (#2481). */
  readonly modelOverrides?: RunModelOverrides;
  /** Validated sparse config content supplied by this fresh invocation. */
  readonly runConfig?: WorkflowRunConfigInput;
  /** Between-run continuation (#2747): adopt/supersede target, if declared. */
  readonly declaredContinuation?: ResolvedRunContinuation;
  /**
   * Adoption lane resolved by `resolveWorkflowAdoption` upstream — the adopting
   * run executes in the adopted run's worktree (reuse) or in one cut from its
   * exact branch (checkout-branch) instead of a fresh worktree from base.
   */
  readonly adoptionLane?: AdoptionLane;
}

type IsolationContext = BackgroundRun['isolationContext'];
type WorkflowDeps = ReturnType<typeof createWorkflowDeps>;
type AdoptedEnvironment = Awaited<ReturnType<typeof adoptRegisteredWorktree>>;
type PreCreatedRun = BackgroundRun['preCreatedRun'];

interface PreparedLaunch {
  workflow: ResolvedWorkflow;
  preparedSource: PreparedWorkflowSource;
  preparedAiConfiguration: PreparedRunAiConfiguration;
}

/** A background launch's estate: its project and, for a reuse adoption, the adopted worktree. */
interface LaunchEstate {
  codebase: Codebase | null;
  adoptedEnvironment: AdoptedEnvironment | undefined;
}

/**
 * Dispatch a workflow in the background, owning any capture it takes.
 *
 * Same owner as the CLI and chat. This path previously reclaimed with a manual dispose in
 * one catch, which covered that one branch and nothing else — three shapes for one
 * invariant is how the busiest surface ended up with none.
 */
export async function dispatchBackgroundWorkflow(
  ctx: WorkflowRoutingContext,
  workflow: ResolvedWorkflow,
  isolationContext?: IsolationContext
): Promise<void> {
  await withCapturedSource(owner =>
    dispatchBackgroundWorkflowOwned(owner, ctx, workflow, isolationContext)
  );
}

/**
 * Dispatch a workflow to run in a background worker conversation.
 * Creates a hidden worker conversation, sets up event bridging from worker to parent,
 * and fires-and-forgets the workflow execution.
 */
async function dispatchBackgroundWorkflowOwned(
  owner: CapturedSourceOwner,
  ctx: WorkflowRoutingContext,
  requestedWorkflow: ResolvedWorkflow,
  isolationContext?: IsolationContext
): Promise<void> {
  const workflowDeps = createWorkflowDeps();
  const engine = new InProcessWorkflowEngine(workflowDeps);
  const estate = await resolveLaunchEstate(ctx, requestedWorkflow);
  const prepare = (preflightCwd: string): Promise<PreparedLaunch | undefined> =>
    prepareLaunch(owner, ctx, requestedWorkflow, estate.codebase, workflowDeps, preflightCwd);
  const prepared =
    ctx.adoptionLane?.kind === 'checkout-branch'
      ? await withBranchLaunchSource(ctx.cwd, ctx.adoptionLane.taskBranch.branch, prepare)
      : await prepare(estate.adoptedEnvironment?.working_path ?? ctx.cwd);
  if (!prepared) return;
  const { workflow, preparedAiConfiguration } = prepared;
  let { preparedSource } = prepared;

  const { workerPlatformId, workerConv } = await createWorkerConversation(ctx);

  // Hold the live-owner lock before publishing the pending run.
  const runLiveOwner = await startRunLiveOwner(preparedSource.runId);
  let runLiveOwnerClose: Promise<void> | undefined;
  const closeRunLiveOwner = (): Promise<void> => {
    runLiveOwnerClose ??= runLiveOwner.close();
    return runLiveOwnerClose;
  };

  // Provisioning events need a durable run before the checkout can be prepared.
  let preCreatedRun: PreCreatedRun;
  try {
    preCreatedRun = await preCreateRun(workflowDeps, ctx, workflow, prepared, workerConv);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName: workflow.name }, 'pre_create_workflow_run_failed');
    await closeRunLiveOwner();
    throw error;
  }

  let executionSubmitted = false;
  try {
    preparedSource = await retainSetupRunSource(
      workflowDeps,
      preCreatedRun,
      preparedSource,
      owner,
      ctx.cwd,
      ctx.codebaseId
    );
    const checkout = await resolveWorkerCheckout({
      ctx,
      workflow,
      estate,
      workflowDeps,
      preCreatedRun,
      preparedAiConfiguration,
      workerPlatformId,
      workerConv,
    });

    if (ctx.adoptionLane?.kind === 'checkout-branch') {
      preparedSource = { ...preparedSource, origin: checkout.cwd };
      await recordSetupRunSource(workflowDeps, preCreatedRun, preparedSource);
    }

    await announceDispatch(ctx, workflow, workerPlatformId);

    const backgroundExecution = runInBackground({
      ctx,
      workflow,
      engine,
      workerPlatformId,
      workerConv,
      preCreatedRun,
      preparedSource,
      preparedAiConfiguration,
      checkout,
      isolationContext,
      closeRunLiveOwner,
    });
    executionSubmitted = true;
    void backgroundExecution;
  } catch (error) {
    if (!executionSubmitted)
      await requireTerminalStatusWrite(
        workflowDeps.store.failWorkflowRun(preCreatedRun.id, toError(error).message, {
          exitReason: 'launch_failed',
        }),
        { workflowRunId: preCreatedRun.id, site: 'background.worktree_setup_failed' }
      );
    throw error;
  } finally {
    if (!executionSubmitted) await closeRunLiveOwner();
  }
}

async function resolveLaunchEstate(
  ctx: WorkflowRoutingContext,
  workflow: ResolvedWorkflow
): Promise<LaunchEstate> {
  const codebase = ctx.codebaseId ? await getCodebase(ctx.codebaseId) : null;
  if (ctx.codebaseId && !codebase) {
    throw new Error(
      `Cannot dispatch workflow "${workflow.name}": codebase ${ctx.codebaseId} not found`
    );
  }
  if (
    ctx.adoptionLane?.kind === 'reuse-worktree' &&
    (!codebase || workflow.worktree?.enabled === false)
  ) {
    throw new Error(
      'Cannot adopt a worktree without a registered project and worktree-enabled workflow'
    );
  }
  const adoptedEnvironment =
    ctx.adoptionLane?.kind === 'reuse-worktree' && codebase
      ? await adoptRegisteredWorktree(sqlIsolation, ctx.adoptionLane, codebase.default_cwd)
      : undefined;
  return { codebase, adoptedEnvironment };
}

/**
 * Capture the run's source and prepare its AI configuration; `undefined` when the
 * capture failed and the user was told nothing started.
 */
async function prepareLaunch(
  owner: CapturedSourceOwner,
  ctx: WorkflowRoutingContext,
  requestedWorkflow: ResolvedWorkflow,
  codebase: Codebase | null,
  workflowDeps: WorkflowDeps,
  preflightCwd: string
): Promise<PreparedLaunch | undefined> {
  const captured = await captureLaunchSource(
    owner,
    ctx,
    requestedWorkflow,
    workflowDeps,
    preflightCwd
  );
  if (!captured) return undefined;
  const { workflow, preparedSource } = captured;

  // A fresh run reads repo config from the project's registered checkout, not from a
  // worktree the parent conversation holds, so uncommitted and gitignored config apply.
  // Adoption stays on its declared estate.
  const launchConfigCwd = ctx.adoptionLane ? preflightCwd : (codebase?.default_cwd ?? preflightCwd);
  const preparedAiConfiguration = await prepareRunAiConfiguration(
    workflowDeps,
    workflow,
    launchConfigCwd,
    {
      codebaseId: ctx.codebaseId,
      userId: ctx.userId,
      aiConfigurationRun:
        ctx.declaredContinuation && continuationInheritsEstate(ctx.declaredContinuation.stamp.mode)
          ? ctx.declaredContinuation.run
          : undefined,
      runConfig: ctx.runConfig,
      ...(ctx.modelOverrides
        ? { modelOverrideLayer: { kind: 'raw', overrides: ctx.modelOverrides } }
        : {}),
    }
  );
  await assertRunCredentials(workflowDeps, preparedAiConfiguration, { cwd: launchConfigCwd });

  return { workflow, preparedSource, preparedAiConfiguration };
}

async function captureLaunchSource(
  owner: CapturedSourceOwner,
  ctx: WorkflowRoutingContext,
  requestedWorkflow: ResolvedWorkflow,
  workflowDeps: WorkflowDeps,
  preflightCwd: string
): Promise<Pick<PreparedLaunch, 'workflow' | 'preparedSource'> | undefined> {
  // Freeze this run's executable source, then re-resolve the workflow FROM the frozen
  // copy so the definition executed and the commands and scripts beside it are one
  // consistent set of bytes. This background path calls `executeWorkflow` directly, so
  // without its own capture it would be the one surface still reading live source.
  //
  // Ordinary worktrees inherit workflow definitions from the canonical checkout.
  // Adoption is different: the selected branch is the declared estate, so its
  // workflow source must stay anchored to that exact checkout.
  const workflowSourceRoot = ctx.adoptionLane
    ? preflightCwd
    : ((await resolveWorkflowSourceRoot(preflightCwd)) ?? preflightCwd);
  let workflow = requestedWorkflow;
  try {
    const preparedSource = await prepareWorkflowSource(workflowDeps, {
      sourceRoot: workflowSourceRoot,
    });
    // From here the owner reclaims it unless a run adopts it, whichever way we leave.
    owner.hold(preparedSource);
    // See `captureFreshSource` in workflow-dispatch.ts: an empty capture means the definition
    // came from a binary's embedded bundled set, which has nothing on disk to re-read.
    if (preparedSource.manifest.scopes.length > 0) {
      const { workflows: capturedWorkflows } = await discoverWorkflowsWithConfig(
        preflightCwd,
        loadConfig,
        providerRegistry,
        preparedSource.roots
      );
      const reResolved = resolveWorkflowName(
        workflow.name,
        capturedWorkflows.map(w => w.workflow)
      );
      if (!reResolved) {
        throw new Error(`workflow '${workflow.name}' is not present in the captured source`);
      }
      workflow = reResolved;
    }
    await recordSelectedWorkflow(preparedSource.anchor.root, workflow.name);
    return { workflow, preparedSource };
  } catch (error) {
    const err = error as Error;
    // Reclaim before returning: this branch is the console's default dispatch path, and
    // leaving the tree behind here leaks one capture per failed dispatch.
    getLog().error({ err, workflowName: workflow.name }, 'workflow.source_capture_failed');
    await ctx.platform.sendMessage(
      ctx.conversationId,
      `Could not capture the workflow source for **${workflow.name}**: ${err.message}. ` +
        'Nothing has been started.'
    );
    return undefined;
  }
}

async function createWorkerConversation(
  ctx: WorkflowRoutingContext
): Promise<{ workerPlatformId: string; workerConv: Conversation }> {
  const workerPlatformId = `${ctx.platform.getPlatformType()}-worker-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // Propagate userId so the worker row has the same attribution as the parent
  // (matters for "my runs" queries).
  const workerConv = await db.getOrCreateConversation(
    ctx.platform.getPlatformType(),
    workerPlatformId,
    ctx.codebaseId,
    undefined,
    ctx.userId
  );
  await db.updateConversation(workerConv.id, {
    cwd: ctx.cwd,
    codebase_id: ctx.codebaseId ?? null,
    hidden: true,
  });
  return { workerPlatformId, workerConv };
}

function preCreateRun(
  workflowDeps: WorkflowDeps,
  ctx: WorkflowRoutingContext,
  workflow: ResolvedWorkflow,
  { preparedSource, preparedAiConfiguration }: PreparedLaunch,
  workerConv: Conversation
): Promise<PreCreatedRun> {
  return workflowDeps.store.createWorkflowRun({
    // The id its already-written source capture is filed under.
    id: preparedSource.runId,
    workflow_name: workflow.name,
    origin: {
      conversationId: workerConv.id,
      parentConversationId: ctx.conversationDbId,
      userId: ctx.userId,
    },
    codebase_id: ctx.codebaseId,
    user_message: ctx.originalMessage,
    metadata: {
      [RUN_AI_CONFIGURATION_METADATA_KEY]: preparedAiConfiguration.aiConfigurationSnapshot,
      ...(preparedAiConfiguration.runConfigMetadata
        ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: preparedAiConfiguration.runConfigMetadata }
        : {}),
      ...(ctx.issueContext ? { github_context: ctx.issueContext } : {}),
      // Declared inputs supplied by this invocation (#2554). Stamped here because the
      // executor only writes them when IT creates the row, and this path hands it a
      // pre-created one.
      ...(ctx.inputs && Object.keys(ctx.inputs).length > 0
        ? { [SUBRUN_METADATA_KEYS.inputs]: { ...ctx.inputs } }
        : {}),
      ...(ctx.declaredContinuation
        ? { [CONTINUATION_METADATA_KEY]: ctx.declaredContinuation.stamp }
        : {}),
    },
    ...(ctx.declaredContinuation ? { adopted_from_run_id: ctx.declaredContinuation.run.id } : {}),
  });
}

interface WorkerCheckoutInput {
  ctx: WorkflowRoutingContext;
  workflow: ResolvedWorkflow;
  estate: LaunchEstate;
  workflowDeps: WorkflowDeps;
  preCreatedRun: PreCreatedRun;
  preparedAiConfiguration: PreparedRunAiConfiguration;
  workerPlatformId: string;
  workerConv: Conversation;
}

/**
 * Resolve isolation for this worker. Unless the workflow explicitly opts out of
 * worktrees, each background workflow gets its own worktree — and isolation failure
 * is then fatal (never fall back to running in a shared/parent worktree).
 */
async function resolveWorkerCheckout(input: WorkerCheckoutInput): Promise<WorkerCheckout> {
  const { ctx, workflow, estate, workflowDeps } = input;
  const { codebase, adoptedEnvironment } = estate;
  // No codebase — run in parent's cwd (no isolation needed for non-repo workflows)
  if (!codebase) return { cwd: ctx.cwd };
  const baseBranch = codebase.default_branch?.trim() || undefined;
  const resolveChildIsolation = createCodebaseChildResolver(
    sqlIsolation.createIsolationStore(),
    codebase,
    {
      baseBranch,
      createdByPlatform: ctx.platform.getPlatformType(),
      createdByUserId: ctx.userId,
    },
    workflowDeps
  );
  const shared = { baseBranch, resolveChildIsolation };
  if (workflow.worktree?.enabled === false && !adoptedEnvironment) {
    // Respect an explicit worktree opt-out: skip isolation and run in the parent's cwd.
    getLog().info(
      {
        workflowName: workflow.name,
        conversationId: ctx.conversationId,
        codebaseId: ctx.codebaseId,
      },
      'workflow.worktree_disabled_by_policy'
    );
    return { cwd: ctx.cwd, ...shared };
  }
  if (adoptedEnvironment) {
    return { cwd: await inheritAdoptedWorktree(input, adoptedEnvironment), ...shared };
  }
  return { ...(await createWorkerWorktree(input, codebase)), ...shared };
}

/**
 * Adoption lane 2: the adopted run's worktree survives — inherit it dirty-as-is
 * instead of cutting a fresh one from base. Linking the env keeps standard
 * isolation hygiene (list/cleanup/complete) pointed at this checkout.
 */
async function inheritAdoptedWorktree(
  { ctx, workerPlatformId, workerConv }: WorkerCheckoutInput,
  adoptedEnvironment: NonNullable<AdoptedEnvironment>
): Promise<string> {
  const workerCwd = adoptedEnvironment.working_path;
  await db
    .updateConversation(workerConv.id, {
      cwd: workerCwd,
      isolation_env_id: adoptedEnvironment.id,
    })
    .catch((e: unknown) => {
      getLog().warn(
        { err: toError(e), workerPlatformId },
        'orchestrator.worker_cwd_persist_failed'
      );
    });
  await ctx.platform
    .sendMessage(
      ctx.conversationId,
      `Adopting prior run — reusing its worktree at ${workerCwd} (dirty state inherited as-is).`,
      { category: 'workflow_dispatch_status', segment: 'new' }
    )
    .catch(e => {
      getLog().warn(
        { err: toError(e), conversationId: ctx.conversationId },
        'workflow_adoption_notice_failed'
      );
    });
  return workerCwd;
}

async function createWorkerWorktree(
  input: WorkerCheckoutInput,
  codebase: Codebase
): Promise<Pick<WorkerCheckout, 'cwd' | 'cutFromCommit' | 'ownedWorktree'>> {
  const { ctx, workerPlatformId, workerConv } = input;
  // The worker id is unique to this run: a task checkout on its generated branch,
  // which completion removes. An adoption lane checks out the adopted exact branch.
  const hints: IsolationHints =
    ctx.adoptionLane?.kind === 'checkout-branch'
      ? {
          workflowType: 'task',
          workflowId: workerPlatformId,
          taskBranch: ctx.adoptionLane.taskBranch,
        }
      : { workflowType: 'task', workflowId: workerPlatformId };
  const result = await validateAndResolveIsolation(
    workerConv,
    codebase,
    ctx.platform,
    workerPlatformId,
    hints,
    false,
    ctx.userId,
    createRunWorktreeSetupExecutor(
      input.workflowDeps,
      input.preCreatedRun,
      input.preparedAiConfiguration.config
    )
  );
  await db.updateConversation(workerConv.id, { cwd: result.cwd }).catch((e: unknown) => {
    getLog().warn({ err: toError(e), workerPlatformId }, 'orchestrator.worker_cwd_persist_failed');
  });
  return result.status === 'new'
    ? { cwd: result.cwd, cutFromCommit: result.cutFromCommit, ownedWorktree: result.ownedWorktree }
    : { cwd: result.cwd };
}

/** Notify parent chat that workflow is dispatching */
async function announceDispatch(
  ctx: WorkflowRoutingContext,
  workflow: ResolvedWorkflow,
  workerPlatformId: string
): Promise<void> {
  await ctx.platform.sendMessage(
    ctx.conversationId,
    `🚀 Dispatching workflow: **${workflow.name}** (background)`,
    {
      category: 'workflow_dispatch_status',
      segment: 'new',
      workflowDispatch: { workerConversationId: workerPlatformId, workflowName: workflow.name },
    }
  );

  await ctx.platform.sendStructuredEvent?.(ctx.conversationId, {
    type: 'workflow_dispatch',
    workerConversationId: workerPlatformId,
    workflowName: workflow.name,
  });
}
