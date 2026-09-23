/**
 * The host side of resource starts: prepare accepted receipt bindings, drain queued
 * requests, and start admitted runs through the engine port.
 *
 * It lives in core, not in a CLI or server, because every host drives the same steps
 * and only differs in how it starts an admitted run: the CLI hands each one to a
 * detached process, the server runs it in-process. Admission, the execution claim
 * fence, and recovery stay in the database layer; nothing here declares an owner dead.
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { toBranchName, toRepoPath, findRepoRoot } from '@archon/git';
import { getIsolationProvider } from '@archon/isolation';
import { createLogger } from '@archon/paths';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import type { IWorkflowEngine } from '@archon/workflows/engine-port';
import {
  finalizeWorkflowSource,
  prepareWorkflowSource,
  preparedWorkflowSourceRecord,
  recordSelectedWorkflow,
  resolveContinuationWorkflow,
  withCapturedSource,
} from '@archon/workflows/executor';
import { canonicalValueText, type JsonValue } from '@archon/workflows/output-ref';
import { resolveWorkflowName } from '@archon/workflows/router';
import {
  readWorkflowRunConfigMetadata,
  WORKFLOW_RUN_CONFIG_METADATA_KEY,
} from '@archon/workflows/run-config';
import {
  RESOURCE_START_METADATA_KEY,
  type PreparedWorkflowLaunch,
  type ResourceStartBindingIntent,
  type ResourceStartDisposition,
  type ResourceStartRunMetadata,
} from '@archon/workflows/schemas/resource-start';
import type { WorkflowExecutionResult } from '@archon/workflows/schemas/workflow';
import {
  SUBRUN_METADATA_KEYS,
  WORKFLOW_SOURCE_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import {
  assertComposedGateDriveable,
  assertInteractiveClassNotBackgrounded,
  assertWorkflowRequirementsMet,
} from '@archon/workflows/utils/workflow-requirements';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import {
  resolveDeclaredInputs,
  WorkflowInputContractError,
} from '@archon/workflows/workflow-inputs';
import { loadConfig } from '../config/config-loader';
import {
  loadWorkflowRunConfigFile,
  sealWorkflowRunConfig,
  unsealWorkflowRunConfig,
} from '../config/run-config';
import * as codebaseDb from '../db/codebases';
import * as conversationDb from '../db/conversations';
import * as isolationDb from '../db/isolation-environments';
import { ResourceSlotCapacityConflictError } from '../db/resource-slots';
import {
  claimStartBindingPreparation,
  completeStartBindingPreparation,
  drainResourceStarts,
  failStartBindingPreparation,
  getResourceStartRequest,
  listPendingStartBindings,
  listQueuedResourceStartsForHost,
} from '../db/resource-starts';
import { getUserById } from '../db/users';
import { getDecryptedAccessToken } from '../db/user-github-token-store';
import * as workflowDb from '../db/workflows';
import { isPerUserGitHubEnabled } from '../github-auth/config';
import { registerRepository } from '../handlers/clone';
import { ensureIsolationConfigured } from '../orchestrator/orchestrator';
import { startRunLiveOwner, type RunLiveOwner } from '../services/run-live-owner';
import { createChildWorktreeResolver } from './child-isolation-resolver';
import { createWorkflowDeps } from './store-adapter';

const log = createLogger('resource-start-host');

type Codebase = NonNullable<Awaited<ReturnType<typeof codebaseDb.getCodebase>>>;
type PreparationStage = 'run_as_user' | 'run_configuration' | 'launch_preparation';

interface BindingIdentity {
  receiptId: string;
  bindingId: string;
  ownerId: string;
}

async function findOrRegisterCodebase(cwd: string): Promise<Codebase> {
  const found =
    (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
    (await codebaseDb.findCodebaseByPathPrefix(cwd));
  if (found) return found;
  const repoRoot = await findRepoRoot(cwd);
  const registered = repoRoot
    ? await codebaseDb.getCodebase((await registerRepository(repoRoot)).codebaseId)
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
  intent: ResourceStartBindingIntent,
  identity: BindingIdentity,
  runConfig: Awaited<ReturnType<typeof loadWorkflowRunConfigFile>> | undefined
): Promise<ResourceStartDisposition> {
  const cwd = resolve(intent.launch.cwd);
  const sourceRoot = resolve(intent.launch.discoveryCwd ?? cwd);

  return await withCapturedSource(async owner => {
    let source = await prepareWorkflowSource(createWorkflowDeps(), { sourceRoot });
    owner.hold(source);

    const discovered = await discoverWorkflowsWithConfig(cwd, loadConfig, source.roots);
    const workflow = resolveWorkflowName(
      intent.launch.workflowName,
      discovered.workflows.map(entry => entry.workflow)
    );
    if (!workflow) {
      const loadError = discovered.errors.find(
        error => error.filename.replace(/\.ya?ml$/, '') === intent.launch.workflowName
      );
      throw new Error(
        loadError
          ? `Workflow '${intent.launch.workflowName}' failed to load: ${loadError.error}`
          : `Workflow '${intent.launch.workflowName}' not found.`
      );
    }
    await recordSelectedWorkflow(source.anchor.root, workflow.name);

    assertInteractiveClassNotBackgrounded(workflow);
    assertComposedGateDriveable(workflow.nodes);
    if (isPerUserGitHubEnabled() && workflow.requires?.length) {
      assertWorkflowRequirementsMet(workflow, {
        githubConnected: Boolean(await getDecryptedAccessToken(intent.runAsUserId)),
      });
    }
    const inputs = { ...intent.launch.inputs };
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

    const codebase = await findOrRegisterCodebase(cwd);
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

    source = await finalizeWorkflowSource(createWorkflowDeps(), source, {
      cwd,
      codebaseId: codebase.id,
    });
    owner.hold(source);
    const conversationId = `trigger-${randomUUID()}`;
    const conversation = await conversationDb.getOrCreateConversation('cli', conversationId);
    const origin: ResourceStartRunMetadata = {
      receiptId: identity.receiptId,
      bindingId: identity.bindingId,
    };
    // Persist only authored inputs; defaults stay derived from the frozen workflow.
    const metadata: Record<string, JsonValue> = {
      [WORKFLOW_SOURCE_METADATA_KEY]: preparedWorkflowSourceRecord(source),
      [RESOURCE_START_METADATA_KEY]: { ...origin },
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
      ...(runConfig
        ? {
            [WORKFLOW_RUN_CONFIG_METADATA_KEY]: sealWorkflowRunConfig(
              runConfig.layer,
              runConfig.source
            ),
          }
        : {}),
    };
    const launch: PreparedWorkflowLaunch = {
      version: 1,
      run: {
        id: source.runId,
        workflow_name: workflow.name,
        conversation_id: conversation.id,
        codebase_id: codebase.id,
        // Provenance is `metadata.resource_start`; a trigger supplies no user message.
        user_message: '',
        metadata,
        ...(isolation.kind === 'in-place' ? { working_path: cwd } : {}),
        user_id: intent.runAsUserId,
      },
      execution: { cwd, conversationId, isolation },
    };

    const disposition = await completeStartBindingPreparation({ ...identity, launch });
    if (!disposition) throw new Error('Preparation ownership changed before durable acceptance.');
    if (disposition.status !== 'skipped') owner.adopt();
    return disposition;
  });
}

/** Claim, prepare and admit one pending binding. Records a rejection on failure. */
async function prepareClaimedBinding(
  intent: ResourceStartBindingIntent,
  identity: BindingIdentity
): Promise<ResourceStartDisposition> {
  let stage: PreparationStage = 'run_as_user';
  try {
    if (!(await getUserById(intent.runAsUserId))) {
      throw new Error('The configured run-as user no longer exists.');
    }
    stage = 'run_configuration';
    const runConfig = intent.launch.configSource
      ? await loadWorkflowRunConfigFile(intent.launch.configSource)
      : undefined;
    stage = 'launch_preparation';
    return await prepareBinding(intent, identity, runConfig);
  } catch (error) {
    // Unknown failures are not an implicit retry policy; the receipt stays inspectable.
    // Configuration and provider errors can contain secret values, so persist the
    // failed boundary, not the exception text. The original cause reaches the caller.
    await failStartBindingPreparation({
      ...identity,
      retryable: false,
      error:
        error instanceof ResourceSlotCapacityConflictError
          ? 'resource_capacity_conflict'
          : `${stage}_failed`,
    });
    throw error;
  }
}

export interface ResourceStartHost {
  /** The configured host identity. A host only prepares and admits work bound to it. */
  hostId: string;
  /**
   * Start one admitted request. The CLI hands it to a detached process; the server
   * calls `startAdmittedResourceStart` in-process without awaiting the run.
   */
  startAdmitted: (requestId: string) => Promise<void>;
}

/**
 * One host pass: prepare this host's pending receipt bindings, then admit its queued
 * requests while their slots have capacity. Every admitted request is handed to the
 * host. Safe to run concurrently with other hosts and processes: preparation and
 * admission are claimed atomically in the database.
 */
export async function drainResourceStartHost(host: ResourceStartHost): Promise<void> {
  const failures: unknown[] = [];
  const start = async (requestId: string): Promise<void> => {
    try {
      await host.startAdmitted(requestId);
    } catch (error) {
      failures.push(error);
    }
  };

  for (const binding of await listPendingStartBindings({ hostId: host.hostId })) {
    if (!binding.intent) continue;
    const identity = {
      receiptId: binding.receiptId,
      bindingId: binding.bindingId,
      ownerId: randomUUID(),
    };
    if (!(await claimStartBindingPreparation(identity))) continue;
    let disposition: ResourceStartDisposition;
    try {
      disposition = await prepareClaimedBinding(binding.intent, identity);
    } catch (error) {
      failures.push(error);
      continue;
    }
    if (disposition.status === 'admitted') await start(disposition.requestId);
  }

  const queued = await listQueuedResourceStartsForHost(host.hostId);
  for (const resource of new Set(queued.map(request => request.resource))) {
    for (const decision of await drainResourceStarts({ hostId: host.hostId, resource })) {
      if (decision.status === 'admitted') await start(decision.requestId);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${String(failures.length)} resource start(s) failed; inspect their receipt records.`
    );
  }
}

async function worktreeLane(
  lane: Extract<PreparedWorkflowLaunch['execution']['isolation'], { kind: 'worktree' }>,
  codebase: Codebase,
  identifier: string,
  platformType: string,
  userId: string
): Promise<{ cwd: string; envId: string; cutFromCommit?: string }> {
  ensureIsolationConfigured();
  const provider = getIsolationProvider();
  // An explicit branch names one reusable checkout, so repeated starts share it.
  if (lane.branch) {
    const existing = await isolationDb.findActiveByWorkflow(codebase.id, 'task', lane.branch);
    if (existing && (await provider.healthCheck(existing.working_path))) {
      return { cwd: existing.working_path, envId: existing.id };
    }
  }
  const workflowId = lane.branch ?? identifier;
  const fromBranch = lane.fromBranch ? toBranchName(lane.fromBranch) : undefined;
  const env = await provider.create({
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
  });
  const record = await isolationDb.create({
    codebase_id: codebase.id,
    workflow_type: 'task',
    workflow_id: workflowId,
    provider: 'worktree',
    working_path: env.workingPath,
    branch_name: env.branchName,
    created_by_platform: platformType,
    created_by_user_id: userId,
    metadata: {},
  });
  return {
    cwd: env.workingPath,
    envId: record.id,
    ...(!env.metadata.adopted && env.metadata.cutFromCommit !== undefined
      ? { cutFromCommit: env.metadata.cutFromCommit }
      : {}),
  };
}

export interface StartAdmittedResourceStartInput {
  requestId: string;
  hostId: string;
  engine: IWorkflowEngine;
  /** Builds the host's platform for this run's conversation. */
  createPlatform: (conversation: {
    conversationId: string;
    conversationDbId: string;
  }) => IWorkflowPlatform;
  /**
   * Called once this process holds the run's exact live-owner lock, before the engine
   * claims the run. Returns the release called after the run settles. The CLI settles
   * the owned run on a graceful signal here; the server omits it because one process
   * hosts many runs and must not install process-wide handlers per run.
   */
  guardOwnedRun?: (owned: { runId: string; liveOwner: RunLiveOwner }) => () => void;
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
 * A failure before submission leaves the run pending and holding its slot. Only the
 * operator can tell whether to retry it or abandon it, so this never marks it failed.
 */
export async function startAdmittedResourceStart(
  input: StartAdmittedResourceStartInput
): Promise<WorkflowExecutionResult> {
  const request = await getResourceStartRequest(input.requestId);
  if (request?.status !== 'admitted' || request.hostId !== input.hostId) {
    throw new Error('Execution requires an admitted request for this configured host.');
  }
  const { launch } = request;
  const run = await workflowDb.getWorkflowRun(launch.run.id);
  if (run?.status !== 'pending') {
    throw new Error(`Admitted run '${launch.run.id}' is ${run?.status ?? 'missing'}, not pending.`);
  }
  const frozen = await resolveContinuationWorkflow(createWorkflowDeps(), run, launch.execution.cwd);
  if (!frozen) throw new Error(`Admitted run '${run.id}' has no frozen workflow source.`);
  const codebase = await codebaseDb.getCodebase(launch.run.codebase_id);
  if (!codebase) throw new Error(`Admitted run '${run.id}' names a missing project.`);

  const platform = input.createPlatform({
    conversationId: launch.execution.conversationId,
    conversationDbId: run.conversation_id,
  });
  const lane = launch.execution.isolation;
  const execution =
    lane.kind === 'worktree'
      ? await worktreeLane(
          lane,
          codebase,
          `${run.workflow_name}-${run.id.slice(0, 8)}`,
          platform.getPlatformType(),
          launch.run.user_id
        )
      : { cwd: launch.execution.cwd, envId: undefined, cutFromCommit: undefined };
  await conversationDb.updateConversation(run.conversation_id, {
    cwd: execution.cwd,
    codebase_id: codebase.id,
    isolation_env_id: execution.envId ?? null,
  });

  const sealed = readWorkflowRunConfigMetadata(run.metadata);
  const baseBranch = codebase.default_branch?.trim() || undefined;
  const liveOwner = await startRunLiveOwner(run.id, {
    detachedProcessPid: input.detachedProcessPid,
  });
  let releaseGuard: (() => void) | undefined;
  try {
    releaseGuard = input.guardOwnedRun?.({ runId: run.id, liveOwner });
    return await input.engine.submit({
      platform,
      conversationId: launch.execution.conversationId,
      cwd: execution.cwd,
      workflow: frozen.workflow,
      userMessage: run.user_message ?? '',
      conversationDbId: run.conversation_id,
      options: {
        preCreatedRun: run,
        codebaseId: codebase.id,
        userId: launch.run.user_id,
        baseBranch,
        ...(execution.cutFromCommit !== undefined
          ? { cutFromCommit: execution.cutFromCommit }
          : {}),
        ...(lane.kind === 'worktree' && lane.baseOverride
          ? { baseOverride: lane.baseOverride }
          : {}),
        resolveChildIsolation:
          codebase.kind === 'folder'
            ? undefined
            : createChildWorktreeResolver({
                codebaseId: codebase.id,
                codebaseName: codebase.name,
                canonicalRepoPath: codebase.default_cwd,
                baseBranch,
                createdByPlatform: platform.getPlatformType(),
                createdByUserId: launch.run.user_id,
              }),
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
