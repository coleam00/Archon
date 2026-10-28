import { resolveRunExecutionMode, type RunExecutionMode } from './container-context';
import { getDefaultBranch, getDefaultRemote, toRepoPath } from '@archon/git';
import { createLogger } from '@archon/paths';
import { requireProvider } from '@archon/provider-contract';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import { safeSendMessage } from './platform-messages';
import { type RunPhase } from './executor-shared';
import { validateRunBudgetShape, validateWorkflowOutcomeDeclaration } from './loader/contracts';
import { hasRunModelOverrides, runOverrideAppliesToRef, selectModelRef } from './model-validation';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from './run-ai-configuration';
import { isFolderCodebase } from './run-paths';
import { prepareRunAiConfiguration, type PreparedRunAiConfiguration } from './run-preflight';
import type {
  DagNode,
  IncludeDirective,
  ResolvedWorkflow,
  WorkflowExecutionResult,
  WorkflowSource,
} from './schemas';
import {
  isIncludeDirective,
  isLoopGroupNode,
  isWaitNode,
  readContinuationMode,
  readRunDispatchMetadata,
  type RunDispatchMetadata,
} from './schemas';
import { isContainerRun, type WorkflowRunOrigin } from './schemas/workflow-run';
import { TerminalStatusWriteError, requireTerminalStatusWrite } from './terminal-status-write';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

/** What a run executes with, settled before its row is created or claimed. */
export interface RunDispatch {
  execution: RunExecutionMode;
  /** The row's owner on a continuation, the invoking user otherwise. */
  executionUserId: string | undefined;
  /** A resume of a run that already started; a pre-created pending row is a fresh dispatch. */
  isContinuation: boolean;
  prepared: PreparedRunAiConfiguration;
  baseBranch: string;
  /** Discovery source for telemetry attribution, as recorded at the run's start. */
  runSource: WorkflowSource | undefined;
  dispatchMetadata: RunDispatchMetadata;
  docsDir: string;
}

/**
 * Validate the dispatch and resolve its configuration: the AI configuration, `$BASE_BRANCH`,
 * the run's discovery source and the workflow-level provider. Throws on a dispatch the
 * engine refuses; stops with a result when a continuation cannot run on this surface.
 */
export async function resolveRunDispatch(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  origin: WorkflowRunOrigin | undefined,
  opts: ExecuteWorkflowOptions
): Promise<RunPhase<RunDispatch>> {
  const { preCreatedRun } = opts;
  const isContinuation =
    preCreatedRun !== undefined &&
    (opts.priorCompletedNodes !== undefined || preCreatedRun.status !== 'pending');
  refuseInvalidDispatch(workflow, opts, isContinuation);
  const containerRefusal = await refuseContainerResumeWithoutBackend(
    deps,
    platform,
    conversationId,
    opts
  );
  if (containerRefusal) return { stopped: true, result: containerRefusal };
  const execution = resolveRunExecutionMode(
    opts.execContext,
    opts.container,
    isContinuation ? preCreatedRun.metadata : undefined
  );

  const executionUserId = preCreatedRun ? (preCreatedRun.user_id ?? undefined) : origin?.userId;
  const prepared = await prepareDispatchAiConfiguration(
    deps,
    workflow,
    cwd,
    opts,
    executionUserId,
    isContinuation
  );
  const { config } = prepared;

  // What the run recorded when it started (#2454). A continuation re-enters with whatever
  // the resuming surface happens to hold — and the in-process auto-resume after a child
  // gate holds nothing — so without the record the run's second half resolves against the
  // environment it is being resumed in rather than the one it started in.
  const recordedDispatch = isContinuation
    ? readRunDispatchMetadata(preCreatedRun.metadata)
    : undefined;
  if (isContinuation && recordedDispatch === undefined) {
    // Started before this build recorded it, died before the stamp landed, or carries a
    // record this build cannot read. Re-resolving is the behavior such a run has always
    // had; say so rather than let a re-derived value pass for a restored one.
    getLog().warn(
      { workflowRunId: preCreatedRun.id },
      'workflow.dispatch_not_recorded_resolving_live'
    );
  }

  const baseBranch = await resolveBaseBranch(deps, cwd, opts, config, recordedDispatch);

  /**
   * Discovery source of the workflow this run started from — telemetry attribution.
   * A record is authoritative even when it holds no source: that dispatch never knew one,
   * and a source the resuming surface resolves now would be a guess passed off as the
   * original. Only a run with no record at all (warned above) takes the live value.
   */
  const runSource = recordedDispatch ? recordedDispatch.source : opts.source;
  const dispatchMetadata: RunDispatchMetadata = {
    base_branch: baseBranch,
    ...(runSource ? { source: runSource } : {}),
  };

  const docsDir = config.docsPath ?? 'docs/';

  logRunModelOverrides(workflow, prepared);
  await resolveWorkflowProvider(deps, platform, conversationId, workflow, prepared);

  const configuredCommandFolder = config.commands.folder;
  if (configuredCommandFolder) {
    getLog().debug({ configuredCommandFolder }, 'command_folder_configured');
  }

  return {
    stopped: false,
    value: {
      execution,
      executionUserId,
      isContinuation,
      prepared,
      baseBranch,
      runSource,
      dispatchMetadata,
      docsDir,
    },
  };
}

/** Refuse a dispatch the engine does not run: an invalid definition or an unsupported combination. */
function refuseInvalidDispatch(
  workflow: ResolvedWorkflow,
  opts: ExecuteWorkflowOptions,
  isContinuation: boolean
): void {
  const outcomeDeclarationError = validateWorkflowOutcomeDeclaration(workflow);
  if (outcomeDeclarationError !== null) {
    throw new Error(`Invalid workflow '${workflow.name}': ${outcomeDeclarationError}`);
  }
  const runBudgetShapeError = validateRunBudgetShape(workflow);
  if (runBudgetShapeError !== null) {
    throw new Error(`Invalid workflow '${workflow.name}': ${runBudgetShapeError}`);
  }

  const { preCreatedRun, priorNodeSessions, modelOverrideLayer } = opts;
  if (
    isContinuation &&
    modelOverrideLayer?.kind === 'raw' &&
    modelOverrideLayer.overrides !== undefined
  ) {
    throw new Error('Cannot supply model overrides when resuming an existing workflow run.');
  }
  if (isContinuation && opts.runConfig !== undefined) {
    throw new Error('Cannot supply a run config when resuming an existing workflow run.');
  }

  const containsWait = (nodes: readonly (DagNode | IncludeDirective)[]): boolean =>
    nodes.some(node => {
      if (isIncludeDirective(node)) return false;
      if (isWaitNode(node)) return true;
      return isLoopGroupNode(node) && containsWait(node.loop_group.nodes);
    });
  // Fresh dispatch only — a resume of a run that already committed to this shape has
  // nothing left to refuse. `isContinuation`, not `preCreatedRun === undefined`: a row
  // pre-created by a launching process (#2872) is still a fresh dispatch and must meet
  // the same refusal.
  if (!isContinuation && opts.execContext?.kind === 'container' && containsWait(workflow.nodes)) {
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
}

async function refuseContainerResumeWithoutBackend(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  { preCreatedRun, container }: ExecuteWorkflowOptions
): Promise<WorkflowExecutionResult | undefined> {
  // Guard: a container run MUST be resumed with its container rewired (the CLI does
  // this via backend.resumeEnv, threading a `container` context). A resume that
  // reaches here for a container run WITHOUT that context — e.g. approving a
  // --container run from chat/web, which has no docker backend wired — would run
  // host-side and SILENTLY skip the write-back apply, losing the approved changes.
  // Fail loudly and point at the CLI instead; the run stays resumable (failed) so
  // the CLI can rediscover the container and apply.
  if (preCreatedRun && isContainerRun(preCreatedRun) && !container) {
    const msg =
      `Run '${preCreatedRun.id}' executed inside an isolation container. Resume it from the ` +
      'CLI in the same project (`archon workflow approve/reject/resume <id>`), where the ' +
      'container is rediscovered — chat/web resume cannot rewire it.';
    getLog().warn({ workflowRunId: preCreatedRun.id }, 'workflow.container_resume_without_backend');
    await safeSendMessage(platform, conversationId, `⚠️ ${msg}`);
    await requireTerminalStatusWrite(deps.store.failWorkflowRun(preCreatedRun.id, msg), {
      workflowRunId: preCreatedRun.id,
      site: 'workflow.container_resume_guard_fail_failed',
    });
    return { success: false, workflowRunId: preCreatedRun.id, error: msg };
  }
  return undefined;
}

async function findAdoptedAiRun(
  deps: WorkflowDeps,
  opts: ExecuteWorkflowOptions,
  isContinuation: boolean,
  recorded: boolean
) {
  const { preCreatedRun } = opts;
  const aiAncestorId = opts.adoptedFromRunId ?? preCreatedRun?.adopted_from_run_id;
  const aiContinuationMode = opts.continuationMode ?? readContinuationMode(preCreatedRun?.metadata);
  return !isContinuation && !recorded && aiAncestorId && aiContinuationMode !== 'supersede'
    ? await deps.store.getWorkflowRun(aiAncestorId)
    : undefined;
}

/**
 * A run with a recorded AI configuration restores it, and a fresh adoption inherits its
 * ancestor's; only otherwise does a caller-prepared configuration apply as is.
 */
async function prepareDispatchAiConfiguration(
  deps: WorkflowDeps,
  workflow: ResolvedWorkflow,
  cwd: string,
  opts: ExecuteWorkflowOptions,
  executionUserId: string | undefined,
  isContinuation: boolean
): Promise<PreparedRunAiConfiguration> {
  const { preCreatedRun } = opts;
  try {
    const recorded =
      preCreatedRun && Object.hasOwn(preCreatedRun.metadata, RUN_AI_CONFIGURATION_METADATA_KEY);
    const adoptedAiRun = await findAdoptedAiRun(deps, opts, isContinuation, !!recorded);
    const inherited =
      adoptedAiRun && Object.hasOwn(adoptedAiRun.metadata, RUN_AI_CONFIGURATION_METADATA_KEY);
    if (!recorded && !inherited && opts.preparedAiConfiguration) {
      return opts.preparedAiConfiguration;
    }
    return await prepareRunAiConfiguration(deps, workflow, cwd, {
      codebaseId: opts.codebaseId,
      userId: executionUserId,
      runConfig: opts.runConfig,
      modelOverrideLayer: opts.modelOverrideLayer,
      ...(isContinuation ? { continuationRun: preCreatedRun } : {}),
      aiConfigurationRun: recorded ? preCreatedRun : (adoptedAiRun ?? undefined),
      ...(recorded ? { inheritAiConfiguration: true } : {}),
    });
  } catch (error) {
    if (error instanceof TerminalStatusWriteError) throw error;
    if (preCreatedRun)
      await requireTerminalStatusWrite(
        deps.store.failWorkflowRun(preCreatedRun.id, (error as Error).message),
        { workflowRunId: preCreatedRun.id, site: 'workflow.configuration_fail_db_record_failed' }
      );
    throw error;
  }
}

async function resolveBaseBranch(
  deps: WorkflowDeps,
  cwd: string,
  opts: ExecuteWorkflowOptions,
  config: WorkflowConfig,
  recordedDispatch: RunDispatchMetadata | undefined
): Promise<string> {
  // The per-dispatch override takes priority, then what this run
  // recorded at its start, then an already resolved checkout base, repo config, the codebase default,
  // then git auto-detection.
  // The override must outrank config so `--base` reports the same branch the
  // worktree was cut from (WorktreeProvider applies the same order); it also outranks the
  // record, because re-passing `--base` to a resume is a deliberate retarget of THIS
  // continuation (the CLI warns that only that half of it applies).
  // If detection fails, leave empty — substituteWorkflowVariables throws only if $BASE_BRANCH is referenced.
  const overrideBaseBranch = opts.baseOverride?.trim();
  if (overrideBaseBranch) return overrideBaseBranch;
  if (recordedDispatch) return recordedDispatch.base_branch;
  if (opts.resolvedBaseBranch !== undefined) return opts.resolvedBaseBranch;
  if (config.baseBranch) return config.baseBranch;
  const fallbackBaseBranch = opts.baseBranch?.trim();
  if (fallbackBaseBranch) return fallbackBaseBranch;
  // Folder projects leave git to the user and agent. $BASE_BRANCH stays
  // unresolved and throws only if a prompt actually references it.
  if (await isFolderCodebase(deps, opts.codebaseId)) return '';
  try {
    const repoPath = toRepoPath(cwd);
    const remote = config.remote?.trim() || (await getDefaultRemote(repoPath));
    if (!remote) throw new Error('Set worktree.remote to select a git remote.');
    return await getDefaultBranch(repoPath, remote);
  } catch (error) {
    // Intentional fallback: auto-detection failure is non-fatal.
    // substituteWorkflowVariables throws if $BASE_BRANCH is actually referenced in a prompt.
    getLog().warn(
      { err: error as Error, errorType: (error as Error).constructor.name, cwd },
      'workflow.base_branch_auto_detect_failed'
    );
    return '';
  }
}

function logRunModelOverrides(
  workflow: ResolvedWorkflow,
  { resolvedModelOverrides, modelBindingsMetadata }: PreparedRunAiConfiguration
): void {
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
}

async function resolveWorkflowProvider(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  workflow: ResolvedWorkflow,
  { resolvedModelOverrides, scope, aiProfile }: PreparedRunAiConfiguration
): Promise<void> {
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
  const { provider: resolvedProvider, model: resolvedModel, preset: workflowPreset } = scope;
  const workflowRef = selectModelRef(workflow.model, aiProfile);
  const providerSource = runOverrideAppliesToRef(resolvedModelOverrides, workflowRef)
    ? 'run-override'
    : scope.providerOrigin === 'model ref'
      ? `model preset '${workflowRef ?? ''}'`
      : scope.providerOrigin === 'workflow'
        ? 'workflow definition'
        : 'config';

  if (workflow.provider && workflowPreset && workflow.provider !== workflowPreset.provider) {
    getLog().warn(
      {
        workflowName: workflow.name,
        configuredProvider: workflow.provider,
        resolvedProvider: workflowPreset.provider,
        modelRef: workflowRef,
      },
      'workflow.model_provider_conflict'
    );
    const delivered = await safeSendMessage(
      platform,
      conversationId,
      `Warning: Workflow '${workflow.name}' sets provider '${workflow.provider}' but model '${workflowRef ?? ''}' resolves to provider '${workflowPreset.provider}' — using '${workflowPreset.provider}'.`
    );
    if (!delivered) {
      getLog().error(
        { workflowName: workflow.name, conversationId },
        'workflow.model_provider_conflict_warning_delivery_failed'
      );
    }
  }

  if (resolvedProvider !== undefined) requireProvider(deps.providers, resolvedProvider);

  getLog().info(
    {
      workflowName: workflow.name,
      provider: resolvedProvider,
      providerSource,
      model: resolvedModel,
    },
    'workflow_provider_resolved'
  );
}
