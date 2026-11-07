import type { OwnedRunLease } from '../utils/owned-run-lease';
import { getIsolationProvider, recordWorktreeAdoption } from '@archon/isolation';
import type {
  ExecutionContext,
  IsolationEnvironmentRow,
  TaskBranchSelection,
} from '@archon/isolation';
import * as git from '@archon/git';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { Codebase } from '@archon/core/schemas/codebase';
import { toPersistedMessageMetadata } from '@archon/core/types';
import {
  type AdoptionLane,
  adoptRegisteredWorktree,
} from '@archon/core/operations/workflow-adoption';
import {
  configureWorktreeIsolation,
  createRunWorktreeSetupExecutor,
  recordSetupRunSource,
  retainSetupRunSource,
} from '@archon/core/workflows/worktree-setup';
import {
  createRegisteredWorktree,
  type RegisteredWorktree,
} from '@archon/core/workflows/registered-worktree';
import type { PreparedRunAiConfiguration } from '@archon/workflows/run-preflight';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/run-ai-configuration';
import { WORKFLOW_RUN_CONFIG_METADATA_KEY } from '@archon/workflows/run-config';
import {
  CONTINUATION_METADATA_KEY,
  SUBRUN_METADATA_KEYS,
  type OwnedWorktree,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { CLIAdapter } from '../adapters/cli-adapter';
import {
  destinationCorrelationId,
  getLog,
  resolveRunDestination,
  type RunDestination,
} from './workflow-shared';
import {
  assertCodebaseResolvedForIsolation,
  assertInheritedWorkflowExecutionCwd,
  assertNoWorktreeOptionsForFolder,
  assertWorkflowNotWorktreePinnedForFolder,
  folderRunsInContainer,
  prepareFolderExecution,
  resolveRunCodebase,
  warnBaseOverrideOnReuse,
  warnOnReusedWorktree,
  type FolderExecution,
} from './workflow-isolation';
import { assertContainerRunCredentials, runExecutesInContainer } from './workflow-native-auth';
import {
  buildNoResumableRunError,
  buildResumeLookupFailureError,
  resolveContinuationDeclaration,
  type ContinuationDeclaration,
} from './workflow-run-preflight';
import { launchDetachedRun } from './workflow-detach';
import {
  prepareLaneAiConfiguration,
  type LaneConfigSource,
  type OwnedRunAdmission,
  type OwnedRunRequest,
} from './workflow-run-admission';

/**
 * Preflight before handing execution to a detached child. Refusals must reach the
 * caller before `Started`, rather than disappearing into the child's log (#2872).
 * The parent creates a queryable run; worktree provisioning and execution belong
 * to the child, which revalidates against the live checkout.
 */
export async function launchDetachedOwnedRun(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission
): Promise<void> {
  const { host, cwd, options } = request;
  const childDestination = await resolveRunDestination(host, options, admission.continuationRun);

  // The run row needs `codebase_id` and adoption cannot be judged without it, so this is
  // the same resolution the run path performs. Registration is idempotent, so the
  // child's own call finds what this one registered.
  const detachResolved = await resolveRunCodebase(host, cwd, options);
  const detachCodebase = detachResolved.codebase;
  // Never on `--json`: stdout carries one machine-readable document and nothing else.
  if (detachResolved.registeredFolder && !options.json) {
    console.log(
      `Registered folder project "${detachResolved.registeredFolder.name}" ` +
        `(${detachResolved.registeredFolder.defaultCwd})`
    );
  }
  // Refuse before forking; provisioning in the child would fail after the parent
  // already printed `Started` (#2872).
  if (!options.noWorktree && admission.wantsIsolation) {
    assertCodebaseResolvedForIsolation(detachResolved);
  }
  // Never pin a worktree branch on the child for a folder project. The --folder flag
  // declares it; an already-registered folder project is read off the resolution.
  const detachIsFolder = options.folder === true || detachCodebase?.kind === 'folder';
  // Surface worktree-option conflicts synchronously in the parent rather than
  // letting the child fail after fork.
  assertNoWorktreeOptionsForFolder(detachIsFolder, options);

  // Adoption resolution is read-only; the child re-resolves against the live checkout.
  const declaration = await resolveContinuationDeclaration(host, options, detachCodebase);
  if (declaration && 'lane' in declaration) admission.aiConfigurationRun = declaration.adoptedRun;
  const adoptionLane = declaration && 'lane' in declaration ? declaration.lane : undefined;
  if (
    detachCodebase?.kind !== 'folder' &&
    adoptionLane?.kind !== 'checkout-branch' &&
    (!admission.wantsIsolation || adoptionLane?.kind === 'reuse-worktree')
  ) {
    await assertInheritedWorkflowExecutionCwd(
      host,
      adoptionLane?.kind === 'reuse-worktree'
        ? adoptionLane.environment.working_path
        : (admission.continuationRun?.working_path ?? cwd)
    );
  }
  const prepared = await prepareLaneAiConfiguration(
    request,
    admission,
    detachedLaneConfig(request, admission, declaration, detachCodebase),
    await runExecutesInContainer(
      host,
      options,
      admission.workflow,
      detachCodebase,
      admission.continuationRun
    )
  );

  await launchDetachedRun({
    host,
    cwd,
    workflowName: request.workflowName,
    userMessage: request.userMessage,
    options,
    workflow: admission.workflow,
    isContinuation: admission.isContinuation,
    continuationRun: admission.continuationRun,
    resumeLookupError: admission.resumeLookupError,
    cliUserId: admission.cliUserId,
    codebase: detachCodebase,
    isFolder: detachIsFolder,
    wantsIsolation: admission.wantsIsolation,
    destination: childDestination,
    declaration,
    prepared,
    resolvedInputs: admission.resolvedInputs,
    runConfig: admission.runConfig,
  });
}

function detachedLaneConfig(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission,
  declaration: ContinuationDeclaration | undefined,
  codebase: Codebase | null
): LaneConfigSource {
  const lane = declaration && 'lane' in declaration ? declaration.lane : undefined;
  if (lane?.kind === 'checkout-branch' && codebase) {
    return { kind: 'branch', codebase, branch: lane.taskBranch.branch };
  }
  // A fresh launch reads repo config from the launch checkout, not from a worktree
  // --branch would reuse; the child inherits what this records before the fork.
  if (lane?.kind === 'reuse-worktree') {
    return {
      kind: 'checkout',
      cwd: lane.environment.working_path,
      recapture: true,
      codebaseId: codebase?.id,
    };
  }
  return {
    kind: 'checkout',
    cwd: admission.continuationRun?.working_path ?? request.cwd,
    recapture: false,
    codebaseId: codebase?.id,
  };
}

type RunConversation = Extract<RunDestination, { kind: 'conversation' }>['conversation'];

/** Where the run executes. Adoption and resume bind it; provisioning completes it. */
export interface RunWorkspace {
  workingCwd: string;
  isolationEnvId: string | undefined;
  /** Set only when this invocation created the run's branch (#3305). */
  cutFromCommit: string | undefined;
  ownedWorktree: OwnedWorktree | undefined;
  /**
   * Repo/worktree and folder-in-place both run on the host; the folder-backend seam sets
   * this and is where `--container` flips it to a container context.
   */
  execContext: ExecutionContext;
  /**
   * A folder-project container run's backend — held so the CLI tears it down after a
   * TERMINAL run (a PAUSED run keeps its suspended container for resume). The engine
   * drives suspend + the write-back gate through the same backend; the CLI only
   * prepares/resumes and destroys.
   */
  container: FolderExecution['container'];
}

/** The between-run continuation (#2747) this launch records and the lane it chose. */
interface LaunchContinuation {
  declaration: ContinuationDeclaration | undefined;
  adoptedTaskBranch: Extract<TaskBranchSelection, { kind: 'existing' }> | undefined;
  /**
   * Set when the adopt lane executes inside a checkout whose `.archon` may differ from
   * this process's cwd — the trigger for recaptureForLane once the path is final.
   */
  runsIsolatedCheckout: boolean;
}

/** A foreground run, settled up to provisioning its workspace. */
export interface ForegroundLaunch {
  readonly request: OwnedRunRequest;
  readonly admission: OwnedRunAdmission;
  readonly destination: RunDestination;
  readonly conversationId: string;
  readonly conversation: RunConversation | undefined;
  readonly adapter: CLIAdapter;
  readonly codebase: Codebase | null;
  readonly isFolderCodebase: boolean;
  /**
   * The codebase's stored default branch, used as the base-branch fallback when repo
   * config sets no worktree.baseBranch (reuse validation, worktree creation, and
   * $BASE_BRANCH resolution all derive from this one value).
   */
  readonly codebaseDefaultBranch: string | undefined;
  readonly continuation: LaunchContinuation;
  /** The prior run `--resume` continues; the executor performs no implicit resume detection. */
  readonly resumable: WorkflowRun | null;
  /**
   * Branch of the prior run's worktree, from the isolation record the resume path
   * matches. Only a worktree-isolated run has one; the no-completed-nodes refusal
   * names it in the relaunch command it suggests (#3154).
   */
  readonly resumeBranch: string | undefined;
  /** Only an explicit --branch looks one up. */
  readonly existingBranchEnv: IsolationEnvironmentRow | null | undefined;
  readonly preparedAiConfiguration: PreparedRunAiConfiguration;
  readonly workspace: RunWorkspace;
}

/** Resolve the run's destination, project, lane, and AI configuration, in that order. */
export async function prepareForegroundLaunch(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission
): Promise<ForegroundLaunch> {
  const { host, cwd, workflowName, options } = request;
  console.log(`Running workflow: ${workflowName}`);
  console.log(`Working directory: ${cwd}`);
  console.log('');

  const destination = await resolveRunDestination(host, options, admission.continuationRun);
  const conversation = destination.kind === 'conversation' ? destination.conversation : undefined;
  const { codebase, registeredFolder } = await resolveRunCodebase(host, cwd, options);
  if (registeredFolder) {
    console.log(
      `Registered folder project "${registeredFolder.name}" (${registeredFolder.defaultCwd})`
    );
  }

  const workspace: RunWorkspace = {
    workingCwd: cwd,
    isolationEnvId: undefined,
    cutFromCommit: undefined,
    ownedWorktree: undefined,
    execContext: { kind: 'host' },
    container: undefined,
  };
  const continuation = await bindContinuationLane(request, admission, codebase, workspace);
  const { resumable, resumeBranch } = await bindResumableRun(
    request,
    admission,
    codebase,
    workspace
  );
  if (!admission.wantsIsolation && codebase?.kind !== 'folder') {
    await assertInheritedWorkflowExecutionCwd(host, workspace.workingCwd);
  }
  const existingBranchEnv =
    admission.wantsIsolation && codebase && options.branchName
      ? await host.records.isolation.findActiveByWorkflow(codebase.id, 'task', options.branchName)
      : undefined;
  const preparedAiConfiguration = await prepareLaneAiConfiguration(
    request,
    admission,
    foregroundLaneConfig(continuation, codebase, workspace),
    await runExecutesInContainer(host, options, admission.workflow, codebase, resumable)
  );

  const isFolderCodebase = codebase?.kind === 'folder';
  assertLaunchTargetsFolderRules(request, admission, isFolderCodebase);

  return {
    request,
    admission,
    destination,
    conversationId: destinationCorrelationId(destination),
    conversation,
    adapter: createRunAdapter(host, conversation),
    codebase,
    isFolderCodebase,
    codebaseDefaultBranch: codebase?.default_branch?.trim() || undefined,
    continuation,
    resumable,
    resumeBranch,
    existingBranchEnv,
    preparedAiConfiguration,
    workspace,
  };
}

function createRunAdapter(
  host: WorkflowHost,
  conversation: RunConversation | undefined
): CLIAdapter {
  return new CLIAdapter({
    recordMessage: conversation
      ? async (_id, message, metadata): Promise<void> => {
          await host.records.messages.addMessage(
            conversation.id,
            'assistant',
            message,
            toPersistedMessageMetadata(metadata)
          );
        }
      : undefined,
  });
}

/**
 * Between-run continuation (#2747): resolve the declared adoption BEFORE any lane
 * decision — it dictates the lane, fail-loud (never a silent fresh start). Supersede
 * validates existence/terminality only; it deliberately inherits nothing.
 */
async function bindContinuationLane(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission,
  codebase: Codebase | null,
  workspace: RunWorkspace
): Promise<LaunchContinuation> {
  const { host, options } = request;
  const declaration = await resolveContinuationDeclaration(host, options, codebase);
  const continuation: LaunchContinuation = {
    declaration,
    adoptedTaskBranch: undefined,
    runsIsolatedCheckout: false,
  };
  if (declaration && 'lane' in declaration && codebase) {
    admission.aiConfigurationRun = declaration.adoptedRun;
    await bindAdoptionLane(request, admission, declaration, codebase, workspace, continuation);
  } else if (declaration && 'superseded' in declaration) {
    console.log(`Superseding run ${declaration.superseded.id} — fresh lane, provenance recorded.`);
  }
  return continuation;
}

async function bindAdoptionLane(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission,
  declaration: Extract<ContinuationDeclaration, { lane: AdoptionLane }>,
  codebase: Codebase,
  workspace: RunWorkspace,
  continuation: LaunchContinuation
): Promise<void> {
  const { adoptedRun, lane } = declaration;
  if (lane.kind === 'reuse-worktree') {
    const env = await adoptRegisteredWorktree(
      request.host.records.isolation,
      lane,
      codebase.default_cwd
    );
    workspace.workingCwd = env.working_path;
    workspace.isolationEnvId = env.id;
    continuation.runsIsolatedCheckout = true;
    // The reuse lane IS the isolation: run in the inherited worktree as-is.
    // Leaving wantsIsolation set would fall through to worktree creation
    // and silently cut a fresh worktree from base over the inherited one.
    admission.wantsIsolation = false;
    console.log(
      `Adopting run ${adoptedRun.id} — reusing its worktree at ${lane.environment.working_path} (dirty state inherited as-is).`
    );
  } else if (lane.kind === 'checkout-branch') {
    // Adopting a branch whose worktree is gone forces isolation ON to cut a fresh
    // worktree FROM that branch.
    continuation.adoptedTaskBranch = lane.taskBranch;
    admission.wantsIsolation = true;
    continuation.runsIsolatedCheckout = true;
    console.log(
      `Adopting run ${adoptedRun.id} — its worktree is gone; checking out its existing branch '${lane.taskBranch.branch}'.`
    );
  } else {
    console.log(
      `Adopting run ${adoptedRun.id} — folder projects run in place; adoption carries provenance and $ADOPTED_RUN_DIR access only.`
    );
  }
}

/** Handle --resume: bind the prior run and reuse its worktree. */
async function bindResumableRun(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission,
  codebase: Codebase | null,
  workspace: RunWorkspace
): Promise<{ resumable: WorkflowRun | null; resumeBranch: string | undefined }> {
  const { host, cwd, workflowName, options } = request;
  if (!options.resume) return { resumable: null, resumeBranch: undefined };
  if (!codebase) {
    throw new Error(
      'Cannot resume: Not in a git repository.\n' +
        'Either run from a git repo or use /clone first.'
    );
  }
  if (admission.resumeLookupError) {
    throw buildResumeLookupFailureError(admission.resumeLookupError);
  }
  // Located during selection, because the graph this run executes had to be chosen from it.
  const resumable = admission.continuationRun;
  if (!resumable) throw buildNoResumableRunError(workflowName, cwd);

  getLog().info(
    { workflowRunId: resumable.id, workflowName, workingPath: resumable.working_path },
    'workflow.resume_found_resumable'
  );

  // A container run IS resumable (Phase C): the overlay lives on a persisted volume the
  // resume rediscovers and restarts (`prepareFolderExecution` calls backend.resumeEnv
  // when `resumable.metadata.isolation` is 'container').

  // Reuse the working path from the resumable run (checked to exist during selection).
  if (resumable.working_path) workspace.workingCwd = resumable.working_path;

  // Look up the isolation environment that owns this working path (if any)
  const allEnvs = await host.records.isolation.listByCodebase(codebase.id);
  const matchingEnv = allEnvs.find(e => e.working_path === workspace.workingCwd);
  if (matchingEnv) {
    await recordWorktreeAdoption(host.records.isolation, matchingEnv, codebase.default_cwd);
    workspace.isolationEnvId = matchingEnv.id;
    getLog().info(
      { envId: workspace.isolationEnvId, workingPath: workspace.workingCwd },
      'workflow.resume_env_found'
    );
  }

  console.log(`Resuming workflow run: ${resumable.id}`);
  console.log(`Working path: ${workspace.workingCwd}`);
  console.log('');

  // --resume adopts the prior run's worktree, so --base is half-applied here exactly as
  // it is on --branch reuse: the cut-from is already fixed, but flagBase still rides
  // opts.baseOverride into $BASE_BRANCH.
  if (admission.flagBase) warnBaseOverrideOnReuse(workspace.workingCwd, admission.flagBase);
  return { resumable, resumeBranch: matchingEnv?.branch_name };
}

function foregroundLaneConfig(
  continuation: LaunchContinuation,
  codebase: Codebase | null,
  workspace: RunWorkspace
): LaneConfigSource {
  if (continuation.adoptedTaskBranch && codebase) {
    return { kind: 'branch', codebase, branch: continuation.adoptedTaskBranch.branch };
  }
  // Still the launch checkout (or an adopted run's worktree): repo config comes from
  // where the operator launched, including uncommitted and gitignored edits, even when
  // --branch reuses an existing worktree for the code.
  return {
    kind: 'checkout',
    cwd: workspace.workingCwd,
    recapture: continuation.runsIsolatedCheckout,
    codebaseId: codebase?.id,
  };
}

function assertLaunchTargetsFolderRules(
  request: OwnedRunRequest,
  admission: OwnedRunAdmission,
  isFolderCodebase: boolean
): void {
  const { options } = request;
  // Container isolation is folder-project-only in v1. A repo-kind project (or a
  // bare git repo / unregistered non-git cwd) with --container fails fast rather
  // than silently running a worktree/in-place — no surprising isolation downgrade.
  if (options.container && !isFolderCodebase) {
    throw new Error(
      'Container isolation is folder-project-only for now. Run --container against a ' +
        'registered folder project (or add --folder to register this directory as one). ' +
        'Repo projects use worktree isolation.'
    );
  }
  // Authoritative folder guards for an already-registered folder project run
  // WITHOUT the --folder flag (admission's flag-based guards only fire when the
  // caller declared intent). Fail fast before any worktree work.
  assertNoWorktreeOptionsForFolder(isFolderCodebase, options);
  assertWorkflowNotWorktreePinnedForFolder(
    isFolderCodebase,
    admission.pinnedEnabled,
    admission.workflow.name
  );
}

/** Provision the workspace the run executes in: folder seam, worktree, or the checkout itself. */
export async function provisionWorkspace(
  launch: ForegroundLaunch,
  lease: OwnedRunLease,
  resumable = launch.resumable
): Promise<void> {
  const { request, admission, codebase, workspace } = launch;
  if (launch.isFolderCodebase && codebase) {
    await provisionFolder(launch, codebase, resumable);
  } else if (admission.wantsIsolation && codebase) {
    await provisionWorktree(launch, codebase, lease);
  } else if (request.options.noWorktree) {
    getLog().info({ cwd: request.cwd }, 'workflow.running_without_isolation');
  } else if (admission.wantsIsolation) {
    // Isolation was expected (default) but codebase is unavailable — fail fast. The
    // `--detach` pre-flight enforces the same refusal before the fork.
    assertCodebaseResolvedForIsolation({ codebase });
  }

  await assertContainerRunCredentials(
    request.host,
    launch.preparedAiConfiguration,
    { cwd: workspace.workingCwd, execContext: workspace.execContext },
    {
      backend: workspace.container?.backend,
      envId: workspace.container?.envId,
      resumable,
    }
  );

  const { preparedSource } = admission;
  if (
    launch.continuation.runsIsolatedCheckout &&
    request.options.discoveryCwd === undefined &&
    preparedSource
  ) {
    admission.preparedSource = { ...preparedSource, origin: workspace.workingCwd };
    if (lease.setupRun) {
      await recordSetupRunSource(request.host.deps, lease.setupRun, admission.preparedSource);
    }
  }
}

export function defersContainerResume(launch: ForegroundLaunch): boolean {
  return (
    launch.isFolderCodebase &&
    launch.request.options.resume === true &&
    folderRunsInContainer(
      launch.request.options,
      launch.admission.workflow,
      undefined,
      launch.resumable
    )
  );
}

async function provisionFolder(
  launch: ForegroundLaunch,
  codebase: Codebase,
  resumable: WorkflowRun | null
): Promise<void> {
  const { request, admission, workspace } = launch;
  const folder = await prepareFolderExecution({
    host: request.host,
    codebase,
    options: request.options,
    workflow: admission.workflow,
    resumable,
    preparedSource: admission.preparedSource,
    owner: request.owner,
    workingCwd: workspace.workingCwd,
  });
  workspace.workingCwd = folder.workingCwd;
  workspace.execContext = folder.execContext;
  admission.preparedSource = folder.preparedSource;
  if (folder.container) {
    workspace.container = folder.container;
    workspace.isolationEnvId = folder.container.envId;
  }
}

async function provisionWorktree(
  launch: ForegroundLaunch,
  codebase: Codebase,
  lease: OwnedRunLease
): Promise<void> {
  const { request, admission, workspace } = launch;
  const { host, options } = request;
  // Auto-generate branch identifier from workflow name + timestamp when --branch not provided
  const branchIdentifier = options.branchName ?? `${request.workflowName}-${Date.now()}`;

  // Configure isolation with repo config loader (same as orchestrator)
  configureWorktreeIsolation();

  const existingEnv = launch.existingBranchEnv;
  if (existingEnv && (await getIsolationProvider().healthCheck(existingEnv.working_path))) {
    const actualBranch = await git.getCurrentBranchStrict(
      git.toWorktreePath(existingEnv.working_path)
    );
    if (actualBranch !== branchIdentifier) {
      throw new Error(
        `Cannot reuse worktree at '${existingEnv.working_path}': expected branch ` +
          `'${branchIdentifier}', found '${actualBranch ?? 'detached HEAD'}'.`
      );
    }
    await warnOnReusedWorktree(
      existingEnv,
      codebase,
      options,
      admission.flagBase,
      launch.codebaseDefaultBranch
    );
    await recordWorktreeAdoption(host.records.isolation, existingEnv, codebase.default_cwd);
    workspace.workingCwd = existingEnv.working_path;
    workspace.isolationEnvId = existingEnv.id;
    return;
  }

  getLog().info({ branch: branchIdentifier, fromBranch: options.fromBranch }, 'worktree_creating');
  let created: RegisteredWorktree;
  try {
    created = await createRunWorktree(launch, codebase, lease, branchIdentifier);
  } catch (createError) {
    getLog().error({ err: createError, branch: branchIdentifier }, 'worktree.create_failed');
    throw createError;
  }
  workspace.workingCwd = created.env.workingPath;
  workspace.isolationEnvId = created.envId;
  workspace.ownedWorktree = created.ownedWorktree;
  workspace.cutFromCommit = created.cutFromCommit;
  getLog().info({ path: workspace.workingCwd }, 'worktree_created');
}

/**
 * Cut the run's worktree. Setup runs inside the run, so its row exists first: the
 * detached launcher's pending row, or a fresh one under the capture's reserved id.
 */
async function createRunWorktree(
  launch: ForegroundLaunch,
  codebase: Codebase,
  lease: OwnedRunLease,
  branchIdentifier: string
): Promise<RegisteredWorktree> {
  const { request, admission } = launch;
  const { host, options } = request;
  const { preparedSource } = admission;
  if (!preparedSource) throw new Error('Worktree setup requires a captured workflow source');
  await lease.start(admission.preCreatedRun?.id ?? preparedSource.runId);
  const setupRun =
    admission.preCreatedRun ?? (await createSetupRun(launch, codebase, preparedSource.runId));
  admission.preCreatedRun = setupRun;
  lease.setupRun = setupRun;
  admission.preparedSource = await retainSetupRunSource(
    host.deps,
    setupRun,
    preparedSource,
    request.owner,
    codebase.default_cwd,
    codebase.id
  );
  const { codebaseDefaultBranch } = launch;
  return createRegisteredWorktree(host.records.isolation, {
    request: {
      workflowType: 'task',
      identifier: branchIdentifier,
      taskBranch: worktreeTaskBranch(options, launch.continuation.adoptedTaskBranch),
      baseBranch: codebaseDefaultBranch ? git.toBranchName(codebaseDefaultBranch) : undefined,
      baseOverride: admission.flagBase ? git.toBranchName(admission.flagBase) : undefined,
      codebaseId: codebase.id,
      // owner/repo name lets resolveOwnerRepo use the registered identity
      // instead of the _local/<basename> path fallback (#2022, #2227)
      codebaseName: codebase.name,
      canonicalRepoPath: git.toRepoPath(codebase.default_cwd),
      description: `CLI workflow: ${request.workflowName}`,
    },
    setupExecutor: createRunWorktreeSetupExecutor(
      host.deps,
      setupRun,
      launch.preparedAiConfiguration.config
    ),
    createdByPlatform: 'cli',
  });
}

function createSetupRun(
  launch: ForegroundLaunch,
  codebase: Codebase,
  runId: string
): Promise<WorkflowRun> {
  const { request, admission, conversation, preparedAiConfiguration, continuation } = launch;
  const { declaration } = continuation;
  return request.host.deps.store.createWorkflowRun({
    id: runId,
    workflow_name: admission.workflow.name,
    origin: {
      ...(conversation ? { conversationId: conversation.id } : {}),
      userId: admission.cliUserId,
    },
    codebase_id: codebase.id,
    user_message: request.userMessage,
    metadata: {
      [RUN_AI_CONFIGURATION_METADATA_KEY]: preparedAiConfiguration.aiConfigurationSnapshot,
      ...(preparedAiConfiguration.runConfigMetadata
        ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: preparedAiConfiguration.runConfigMetadata }
        : {}),
      ...(admission.resolvedInputs
        ? { [SUBRUN_METADATA_KEYS.inputs]: admission.resolvedInputs }
        : {}),
      ...(declaration ? { [CONTINUATION_METADATA_KEY]: declaration.stamp } : {}),
    },
    ...(declaration ? { adopted_from_run_id: declaration.runId } : {}),
  });
}

function worktreeTaskBranch(
  options: OwnedRunRequest['options'],
  adoptedTaskBranch: LaunchContinuation['adoptedTaskBranch']
): TaskBranchSelection | undefined {
  if (adoptedTaskBranch) return adoptedTaskBranch;
  const fromBranch = options.fromBranch?.trim();
  if (options.branchName) {
    return {
      kind: 'new',
      branch: git.toBranchName(options.branchName),
      ...(fromBranch ? { fromBranch: git.toBranchName(fromBranch) } : {}),
    };
  }
  return fromBranch ? { kind: 'new', fromBranch: git.toBranchName(fromBranch) } : undefined;
}

/** Chat-origin runs keep their history; a fresh CLI invocation has no chat record. */
export async function recordConversationLaunch(launch: ForegroundLaunch): Promise<void> {
  const { request, conversation, codebase, workspace } = launch;
  if (conversation === undefined) return;
  const { host } = request;
  // Update conversation with cwd and isolation info
  try {
    await host.records.conversations.updateConversation(conversation.id, {
      cwd: workspace.workingCwd,
      codebase_id: codebase?.id ?? null,
      isolation_env_id: workspace.isolationEnvId ?? null,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to update conversation: ${err.message}`);
  }

  // Persist user message for Web UI history.
  try {
    await host.records.messages.addMessage(
      conversation.id,
      'user',
      request.userMessage,
      undefined,
      launch.admission.cliUserId
    );
  } catch (error) {
    getLog().warn(
      { err: error as Error, conversationId: conversation.id },
      'cli_user_message_persist_failed'
    );
  }
}
