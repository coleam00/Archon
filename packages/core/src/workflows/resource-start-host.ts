import type { QueuedResourceStartInspection } from '@archon/workflows/resource-start-store';
import { createRunWorktreeSetupExecutor } from './worktree-setup';
import type { WorktreeSetupExecutor } from '@archon/isolation';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/run-ai-configuration';
import {
  prepareRunAiConfiguration,
  assertRunCredentials,
  WorkflowCredentialPreflightError,
} from '@archon/workflows/run-preflight';
import { requireTerminalStatusWrite } from '@archon/workflows/terminal-status-write';
/**
 * The host side of resource starts: prepare accepted receipt bindings, drain queued
 * requests, and start admitted runs through the engine port.
 *
 * It lives in core, not in a CLI or server, because every host drives the same steps
 * and only differs in how it starts an admitted run: the CLI hands each one to a
 * detached process, the server runs it in-process. Admission, the execution claim
 * fence, and recovery stay behind the supplied store; nothing here declares an owner dead.
 */
import { randomUUID } from 'node:crypto';
import type { OwnedWorktree } from '@archon/workflows/schemas/workflow-run';
import { resolve } from 'node:path';
import { toBranchName, toRepoPath } from '@archon/git';
import { getIsolationProvider, recordWorktreeAdoption } from '@archon/isolation';
import { createLogger, canonicalizeProjectPath } from '@archon/paths';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import {
  finalizeWorkflowSource,
  prepareWorkflowSource,
  preparedWorkflowSourceRecord,
  recordSelectedWorkflow,
  resolveContinuationWorkflow,
  withCapturedSource,
} from '@archon/workflows/run-source';
import { canonicalValueText, type JsonValue } from '@archon/workflows/output-ref';
import { resolveWorkflowName } from '@archon/workflows/router';
import {
  readWorkflowRunConfigMetadata,
  WORKFLOW_RUN_CONFIG_METADATA_KEY,
} from '@archon/workflows/run-config';
import {
  RESOURCE_START_METADATA_KEY,
  ADMISSION_CHECKOUT_GUARD_METADATA_KEY,
  type PreparedWorkflowLaunch,
  type ResourceStartBindingIntent,
  type ResourceStartDisposition,
  type ResourceStartRunMetadata,
} from '@archon/workflows/schemas/resource-start';
import {
  findWorkflowLoadError,
  type WorkflowExecutionResult,
} from '@archon/workflows/schemas/workflow';
import {
  SUBRUN_METADATA_KEYS,
  WORKFLOW_SOURCE_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import { assertWorkflowRequirementsMet } from '@archon/workflows/utils/workflow-requirements';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import {
  resolveDeclaredInputs,
  WorkflowInputContractError,
} from '@archon/workflows/workflow-inputs';
import { loadWorkflowRunConfigFile, unsealWorkflowRunConfig } from '../config/run-config';
import { ResourceSlotCapacityConflictError } from '@archon/workflows/resource-start-store';
import type { Codebase } from '../schemas/codebase';
import type { WorkflowHost } from './host-store';
import { registerRepository } from '../handlers/clone';
import { ensureIsolationConfigured } from '../orchestrator/dispatch/isolation-resolver';
import { resolveCodebaseForPath } from '../services/codebase-checkout-resolver';
import { startRunLiveOwner, type RunLiveOwner } from '../services/run-live-owner';
import { createCodebaseChildResolver } from './child-isolation-resolver';
import { createRegisteredWorktree } from './registered-worktree';

const log = createLogger('resource-start-host');

type PreparationStage = 'run_as_user' | 'run_configuration' | 'launch_preparation';

interface BindingIdentity {
  receiptId: string;
  bindingId: string;
  ownerId: string;
}

async function findOrRegisterCodebase(host: WorkflowHost, cwd: string): Promise<Codebase> {
  const { codebase: found, repoRoot } = await resolveCodebaseForPath(cwd, host.records.codebases);
  if (found) return found;
  const registered = repoRoot
    ? await host.records.codebases.getCodebase(
        (await registerRepository(host.records.codebases, repoRoot)).codebaseId
      )
    : null;
  if (!registered) {
    throw new Error(`Cannot prepare a resource start from '${cwd}': register the project first.`);
  }
  return registered;
}

/**
 * Freeze one binding's workflow source, inputs and run configuration, then commit it to
 * admission. The capture is kept only when admission keeps a promise to run it.
 */
async function prepareBinding(
  host: WorkflowHost,
  intent: ResourceStartBindingIntent,
  identity: BindingIdentity,
  runConfig: Awaited<ReturnType<typeof loadWorkflowRunConfigFile>> | undefined
): Promise<ResourceStartDisposition> {
  const cwd = await canonicalizeProjectPath(intent.launch.cwd);
  const sourceRoot = resolve(intent.launch.discoveryCwd ?? cwd);

  return await withCapturedSource(async owner => {
    let source = await prepareWorkflowSource(host.deps, { sourceRoot });
    owner.hold(source);

    const discovered = await discoverWorkflowsWithConfig(
      cwd,
      host.deps.loadConfig,
      host.deps.providers,
      source.roots
    );
    const workflow = resolveWorkflowName(
      intent.launch.workflowName,
      discovered.workflows.map(entry => entry.workflow)
    );
    if (!workflow) {
      const loadError = findWorkflowLoadError(discovered.errors, intent.launch.workflowName);
      throw new Error(
        loadError
          ? `Workflow '${intent.launch.workflowName}' failed to load: ${loadError.error}`
          : `Workflow '${intent.launch.workflowName}' not found.`
      );
    }
    await recordSelectedWorkflow(source.anchor.root, workflow.name);

    if (host.deps.isPerUserGitHubEnabled?.() && workflow.requires?.length) {
      assertWorkflowRequirementsMet(workflow, {
        githubConnected: Boolean(await host.deps.getUserGithubToken?.(intent.runAsUserId)),
      });
    }
    // `resolveDeclaredInputs` passes inputs through to a workflow without `inputs:`, which
    // operator-written literals rely on. Event inputs carry untrusted source content, so
    // they reach only a workflow that declares them.
    const eventInputNames = Object.keys(intent.eventInputs ?? {});
    if (workflow.inputs === undefined && eventInputNames.length > 0) {
      throw new Error(
        `Workflow '${workflow.name}' declares no inputs; a trigger cannot pass event-mapped ` +
          `input${eventInputNames.length === 1 ? '' : 's'} ` +
          eventInputNames
            .sort()
            .map(name => `'${name}'`)
            .join(', ') +
          ". Declare them under 'inputs:' in the workflow."
      );
    }
    const inputs = { ...intent.launch.inputs, ...intent.eventInputs };
    try {
      resolveDeclaredInputs(
        inputs,
        workflow.inputs,
        `Cannot run workflow '${workflow.name}'`,
        'it'
      );
    } catch (error) {
      if (error instanceof WorkflowInputContractError && error.missingRequired.length > 0) {
        throw new Error(
          `Workflow '${workflow.name}' requires input${error.missingRequired.length === 1 ? '' : 's'} ` +
            error.missingRequired.map(name => `'${name}'`).join(', ') +
            '.'
        );
      }
      throw error;
    }

    const codebase = await findOrRegisterCodebase(host, cwd);
    const requested = intent.launch.isolation;
    const pinned = workflow.worktree?.enabled;
    if (requested.kind === 'in-place' && pinned === true) {
      throw new Error(`Workflow '${workflow.name}' requires worktree isolation.`);
    }
    if (requested.kind === 'worktree' && pinned === false) {
      throw new Error(`Workflow '${workflow.name}' requires in-place execution.`);
    }
    const wantsWorktree =
      requested.kind === 'worktree' ||
      (requested.kind === 'default' && codebase.kind !== 'folder' && pinned !== false);
    if (codebase.kind === 'folder' && (wantsWorktree || pinned === true)) {
      throw new Error(`Folder project '${codebase.name}' does not support worktree isolation.`);
    }
    const isolation: PreparedWorkflowLaunch['execution']['isolation'] = wantsWorktree
      ? { ...(requested.kind === 'worktree' ? requested : {}), kind: 'worktree' }
      : { kind: 'in-place' };

    source = await finalizeWorkflowSource(host.deps, source, {
      cwd,
      codebaseId: codebase.id,
    });
    owner.hold(source);
    const conversationId = `trigger-${source.runId}`;
    const origin: ResourceStartRunMetadata = {
      receiptId: identity.receiptId,
      bindingId: identity.bindingId,
    };
    const preparedAi = await prepareRunAiConfiguration(host.deps, workflow, cwd, {
      codebaseId: codebase.id,
      userId: intent.runAsUserId,
      runConfig,
    });
    const metadata: Record<string, JsonValue> = {
      [RUN_AI_CONFIGURATION_METADATA_KEY]: preparedAi.aiConfigurationSnapshot,
      [WORKFLOW_SOURCE_METADATA_KEY]: preparedWorkflowSourceRecord(source),
      [RESOURCE_START_METADATA_KEY]: { ...origin },
      [ADMISSION_CHECKOUT_GUARD_METADATA_KEY]: workflow.mutates_checkout !== false,
      // Persist only authored inputs; defaults stay derived from the frozen workflow.
      ...(Object.keys(inputs).length > 0
        ? {
            [SUBRUN_METADATA_KEYS.inputs]: Object.fromEntries(
              Object.entries(inputs).map(([name, value]) => [name, canonicalValueText(value)])
            ),
            ...(Object.values(inputs).some(value => typeof value !== 'string')
              ? { [SUBRUN_METADATA_KEYS.inputsValues]: inputs }
              : {}),
          }
        : {}),
      ...(preparedAi.runConfigMetadata
        ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: preparedAi.runConfigMetadata }
        : {}),
    };
    const launch: PreparedWorkflowLaunch = {
      version: 2,
      run: {
        id: source.runId,
        workflow_name: workflow.name,
        origin: { userId: intent.runAsUserId },
        codebase_id: codebase.id,
        // Provenance is `metadata.resource_start`; a trigger supplies no user message.
        user_message: '',
        metadata,
        ...(isolation.kind === 'in-place' ? { working_path: cwd } : {}),
      },
      execution: { cwd, conversationId, isolation },
    };

    const disposition = await host.deps.store.completeStartBindingPreparation({
      ...identity,
      launch,
    });
    if (!disposition) throw new Error('Preparation ownership changed before durable acceptance.');
    if (disposition.status !== 'skipped') owner.adopt();
    return disposition;
  });
}

async function prepareClaimedBinding(
  host: WorkflowHost,
  intent: ResourceStartBindingIntent,
  identity: BindingIdentity
): Promise<ResourceStartDisposition> {
  let stage: PreparationStage = 'run_as_user';
  try {
    if (!(await host.records.users.getUserById(intent.runAsUserId))) {
      throw new Error('The configured run-as user no longer exists.');
    }
    stage = 'run_configuration';
    const runConfig = intent.launch.configSource
      ? await loadWorkflowRunConfigFile(intent.launch.configSource)
      : undefined;
    stage = 'launch_preparation';
    return await prepareBinding(host, intent, identity, runConfig);
  } catch (error) {
    // Unknown failures are not an implicit retry policy; the receipt stays inspectable.
    // Configuration and provider errors can contain secret values, so persist the
    // failed boundary, not the exception text. The original cause reaches the caller.
    try {
      await host.deps.store.failStartBindingPreparation({
        ...identity,
        retryable: false,
        error:
          error instanceof ResourceSlotCapacityConflictError
            ? 'resource_capacity_conflict'
            : `${stage}_failed`,
      });
    } catch (statusError) {
      throw new AggregateError(
        [error, statusError],
        `Preparation ${stage}_failed; recording the rejection also failed.`
      );
    }
    throw error;
  }
}

export interface ResourceStartHost extends WorkflowHost {
  /** The configured host identity. A host only prepares and admits work bound to it. */
  hostId: string;
  /**
   * Start one admitted request. The CLI hands it to a detached process; the server
   * calls `startAdmittedResourceStart` in-process without awaiting the run.
   */
  startAdmitted: (requestId: string) => Promise<void>;
}

/**
 * A preparation, dispatch, resource drain, or damaged receipt failure. Unknown or untrusted
 * receipt origins omit `receiptId`.
 */
export interface ResourceStartDrainFailure {
  receiptId?: string;
  error: unknown;
}

/**
 * A drain's failures, each tagged with the receipt it belongs to, so a caller that fired
 * one receipt reports its own failures apart from other pending work on the host.
 */
export class ResourceStartDrainError extends AggregateError {
  constructor(readonly failures: readonly ResourceStartDrainFailure[]) {
    super(
      failures.map(failure => failure.error),
      `${String(failures.length)} resource start operation(s) failed; inspect their receipts or resources.`
    );
    this.name = 'ResourceStartDrainError';
  }
}

function receiptIdOfLaunch(launch: PreparedWorkflowLaunch | undefined): string | undefined {
  const origin = launch?.run.metadata?.[RESOURCE_START_METADATA_KEY];
  if (typeof origin !== 'object' || origin === null || Array.isArray(origin)) return undefined;
  return typeof origin.receiptId === 'string' ? origin.receiptId : undefined;
}

/**
 * One host pass: prepare this host's pending receipt bindings, then admit its queued
 * requests while their slots have capacity. Every admitted request is handed to the
 * host. A damaged receipt is reported after the pass instead of stopping it. Safe to run concurrently with other hosts and processes: preparation and
 * admission are claimed atomically by the store.
 */
export async function drainResourceStartHost(host: ResourceStartHost): Promise<void> {
  const failures: ResourceStartDrainFailure[] = [];
  const start = async (requestId: string, receiptId?: string): Promise<void> => {
    try {
      await host.startAdmitted(requestId);
    } catch (error) {
      failures.push({ receiptId, error });
    }
  };

  for (const binding of await host.deps.store.listPendingStartBindings({ hostId: host.hostId })) {
    if ('document' in binding) {
      failures.push({ error: binding.error });
      continue;
    }
    if (!binding.intent) continue;
    const identity = {
      receiptId: binding.receiptId,
      bindingId: binding.bindingId,
      ownerId: randomUUID(),
    };
    if (!(await host.deps.store.claimStartBindingPreparation(identity))) continue;
    let disposition: ResourceStartDisposition;
    try {
      disposition = await prepareClaimedBinding(host, binding.intent, identity);
    } catch (error) {
      failures.push({ receiptId: binding.receiptId, error });
      continue;
    }
    if (disposition.status === 'admitted') await start(disposition.requestId, binding.receiptId);
  }

  const queued = await host.deps.store.listQueuedResourceStartsForHost(host.hostId);
  const drain = async (resource: string): Promise<void> => {
    let decisions: ResourceStartDisposition[];
    try {
      decisions = await host.deps.store.drainResourceStarts({ hostId: host.hostId, resource });
    } catch (error) {
      const receiptIds = new Set(
        queued
          .filter(request => request.resource === resource)
          .map(request =>
            'error' in request ? request.receiptId : receiptIdOfLaunch(request.launch)
          )
      );
      const failure = new Error(
        `Resource '${resource}' drain failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
      for (const receiptId of receiptIds) failures.push({ receiptId, error: failure });
      return;
    }
    for (const decision of decisions) {
      if (decision.status === 'admitted') {
        // A queued request names its receipt in the run metadata written at preparation.
        const request = queued.find(item => item.id === decision.requestId);
        const launch = request && !('error' in request) ? request.launch : undefined;
        await start(decision.requestId, receiptIdOfLaunch(launch));
      }
    }
  };
  for (const resource of queuedDrainResources(queued, failures)) await drain(resource);

  if (failures.length > 0) {
    throw new ResourceStartDrainError(failures);
  }
}

function queuedDrainResources(
  queued: readonly QueuedResourceStartInspection[],
  failures: ResourceStartDrainFailure[]
): string[] {
  for (const request of queued) {
    if (!('error' in request)) continue;
    failures.push({
      receiptId: request.receiptId,
      error: new Error(`Queued request '${request.id}' is invalid`, {
        cause: request.error,
      }),
    });
  }
  return [...new Set(queued.flatMap(request => ('error' in request ? [] : [request.resource])))];
}

async function worktreeLane(
  host: WorkflowHost,
  lane: Extract<PreparedWorkflowLaunch['execution']['isolation'], { kind: 'worktree' }>,
  codebase: Codebase,
  identifier: string,
  platformType: string,
  userId: string | undefined,
  setupExecutor: WorktreeSetupExecutor
): Promise<{ cwd: string; envId: string; cutFromCommit?: string; ownedWorktree?: OwnedWorktree }> {
  ensureIsolationConfigured();
  const provider = getIsolationProvider();
  // An explicit branch names one reusable checkout, so repeated starts share it.
  if (lane.branch) {
    const existing = await host.records.isolation.findActiveByWorkflow(
      codebase.id,
      'task',
      lane.branch
    );
    if (existing && (await provider.healthCheck(existing.working_path))) {
      await recordWorktreeAdoption(host.records.isolation, existing, codebase.default_cwd);
      return { cwd: existing.working_path, envId: existing.id };
    }
  }
  const workflowId = lane.branch ?? identifier;
  const fromBranch = lane.fromBranch ? toBranchName(lane.fromBranch) : undefined;
  const created = await createRegisteredWorktree(host.records.isolation, {
    request: {
      workflowType: 'task',
      identifier: workflowId,
      taskBranch:
        lane.branch || fromBranch
          ? {
              kind: 'new',
              ...(lane.branch ? { branch: toBranchName(lane.branch) } : {}),
              ...(fromBranch ? { fromBranch } : {}),
            }
          : undefined,
      baseBranch: codebase.default_branch?.trim()
        ? toBranchName(codebase.default_branch.trim())
        : undefined,
      baseOverride: lane.baseOverride ? toBranchName(lane.baseOverride) : undefined,
      codebaseId: codebase.id,
      codebaseName: codebase.name,
      canonicalRepoPath: toRepoPath(codebase.default_cwd),
      description: `Resource start: ${identifier}`,
    },
    setupExecutor,
    createdByPlatform: platformType,
    ...(userId ? { createdByUserId: userId } : {}),
  });
  return {
    cwd: created.env.workingPath,
    envId: created.envId,
    ...(created.ownedWorktree ? { ownedWorktree: created.ownedWorktree } : {}),
    ...(created.cutFromCommit !== undefined ? { cutFromCommit: created.cutFromCommit } : {}),
  };
}

export interface StartAdmittedResourceStartInput {
  requestId: string;
  hostId: string;
  host: WorkflowHost;
  /** Builds delivery for a run; correlation does not imply chat history. */
  createPlatform: (run: {
    runId: string;
    conversationId: string;
    origin: import('@archon/workflows/schemas/workflow-run').WorkflowRunOrigin | null;
  }) => IWorkflowPlatform;
  /**
   * Called once this process holds the run's exact live-owner lock, before the engine
   * claims the run. Returns the release called after the run settles. The CLI settles
   * the owned run on a graceful signal here; the server omits it because one process
   * hosts many runs and must not install process-wide handlers per run.
   */
  guardOwnedRun?: (owned: {
    runId: string;
    liveOwner: RunLiveOwner;
    getExecutionClaim: () => string | null | undefined;
  }) => () => void;
  /**
   * The PID of a detached process that executes only this run and leads its own process
   * group. Registering it lets `archon workflow cancel` terminate that tree. The server
   * omits it: its process hosts many runs and must never be the target of a stop.
   */
  detachedProcessPid?: number;
}

/**
 * Start one admitted pending run through the engine port. The engine's pending claim
 * is the execution fence: if another starter already claimed the run, or its request
 * was withdrawn from the slot, the engine refuses before any node runs.
 *
 * Credential refusals fail under live ownership before isolation. Other failures
 * before submission leave the run pending for an explicit retry or abandonment.
 */
export async function startAdmittedResourceStart(
  input: StartAdmittedResourceStartInput
): Promise<WorkflowExecutionResult> {
  const { host } = input;
  const request = await host.deps.store.getResourceStartRequest(input.requestId);
  if (request?.status !== 'admitted' || request.hostId !== input.hostId) {
    throw new Error('Execution requires an admitted request for this configured host.');
  }
  const { launch } = request;
  const run = await host.deps.store.getWorkflowRun(launch.run.id);
  if (run?.status !== 'pending') {
    throw new Error(`Admitted run '${launch.run.id}' is ${run?.status ?? 'missing'}, not pending.`);
  }
  const frozen = await resolveContinuationWorkflow(host.deps, run, launch.execution.cwd);
  if (!frozen) throw new Error(`Admitted run '${run.id}' has no frozen workflow source.`);
  const codebase = await host.records.codebases.getCodebase(launch.run.codebase_id);
  if (!codebase) throw new Error(`Admitted run '${run.id}' names a missing project.`);

  const platform = input.createPlatform({
    conversationId: launch.execution.conversationId,
    runId: run.id,
    origin: run.origin,
  });
  const sealed = readWorkflowRunConfigMetadata(run.metadata);
  const liveOwner = await startRunLiveOwner(run.id, {
    detachedProcessPid: input.detachedProcessPid,
  });
  let ownedExecutionClaim: string | null | undefined;
  let releaseGuard: (() => void) | undefined;
  try {
    releaseGuard = input.guardOwnedRun?.({
      runId: run.id,
      liveOwner,
      getExecutionClaim: () => ownedExecutionClaim,
    });
    const deps = host.deps;
    const preparedAiConfiguration = await prepareRunAiConfiguration(
      deps,
      frozen.workflow,
      launch.execution.cwd,
      {
        aiConfigurationRun: run,
        inheritAiConfiguration: true,
        userId: run.user_id ?? undefined,
        codebaseId: codebase.id,
        ...(sealed
          ? { runConfig: { layer: unsealWorkflowRunConfig(sealed), source: sealed.source } }
          : {}),
      }
    );
    try {
      await assertRunCredentials(deps, preparedAiConfiguration, { cwd: launch.execution.cwd });
    } catch (error) {
      if (error instanceof WorkflowCredentialPreflightError) {
        await requireTerminalStatusWrite(deps.store.failWorkflowRun(run.id, error.message), {
          workflowRunId: run.id,
          site: 'resource_start.credential_preflight_failed',
        });
        return { success: false, workflowRunId: run.id, error: error.message };
      }
      throw error;
    }
    const lane = launch.execution.isolation;
    const execution =
      lane.kind === 'worktree'
        ? await worktreeLane(
            host,
            lane,
            codebase,
            `${run.workflow_name}-${run.id.slice(0, 8)}`,
            platform.getPlatformType(),
            run.user_id ?? undefined,
            createRunWorktreeSetupExecutor(host.deps, run, preparedAiConfiguration.config)
          )
        : {
            cwd: launch.execution.cwd,
            envId: undefined,
            cutFromCommit: undefined,
            ownedWorktree: undefined,
          };
    if (run.conversation_id)
      await host.records.conversations.updateConversation(run.conversation_id, {
        cwd: execution.cwd,
        codebase_id: codebase.id,
        isolation_env_id: execution.envId ?? null,
      });

    const baseBranch = codebase.default_branch?.trim() || undefined;
    return await host.engine.submit({
      platform,
      conversationId: launch.execution.conversationId,
      cwd: execution.cwd,
      workflow: frozen.workflow,
      userMessage: run.user_message ?? '',
      origin: run.origin ?? undefined,
      options: {
        preCreatedRun: run,
        onExecutionClaimed: claim => {
          ownedExecutionClaim = claim;
        },
        preparedAiConfiguration,
        codebaseId: codebase.id,
        baseBranch,
        ownedWorktree: execution.ownedWorktree,
        ...(execution.cutFromCommit !== undefined
          ? { cutFromCommit: execution.cutFromCommit }
          : {}),
        ...(lane.kind === 'worktree' && lane.baseOverride
          ? { baseOverride: lane.baseOverride }
          : {}),
        resolveChildIsolation: createCodebaseChildResolver(
          host.records.isolation,
          codebase,
          {
            baseBranch,
            createdByPlatform: platform.getPlatformType(),
            createdByUserId: run.user_id ?? undefined,
          },
          host.deps
        ),
        // A fresh claim reseals caller configuration, so restore the one sealed at intake.
        ...(sealed
          ? { runConfig: { layer: unsealWorkflowRunConfig(sealed), source: sealed.source } }
          : {}),
      },
    });
  } finally {
    releaseGuard?.();
    await liveOwner.close().catch((error: unknown) => {
      log.error({ err: error as Error, runId: run.id }, 'resource_start.live_owner_close_failed');
    });
  }
}
