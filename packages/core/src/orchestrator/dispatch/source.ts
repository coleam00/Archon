import { recordWorktreeAdoption } from '@archon/isolation';
import * as sqlIsolation from '@archon/core/db/isolation-environments';
import { providerRegistry } from '@archon/providers';
import { toRepoPath, toWorktreePath, verifyWorktreeOwnership } from '@archon/git';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import { prepareRunAiConfiguration } from '@archon/workflows/run-preflight';
import {
  prepareWorkflowSource,
  recordSelectedWorkflow,
  type CapturedSourceOwner,
} from '@archon/workflows/run-source';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import { loadConfig } from '../../config/config-loader';
import { resolveRegisteredWorktree } from '../../operations/workflow-adoption';
import type { IPlatformAdapter, WorkflowRequest } from '../../types';
import { resolveWorkflowSourceRoot } from '../../utils/workflow-source-root';
import { withBranchLaunchSource } from '../../workflows/branch-launch-source';
import { resolveRunWorkflow } from '../../workflows/resolve-run-workflow';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import { getLog } from '../agent-log';
import type { Continuation } from './request';
import type {
  AdoptedEnvironment,
  AdoptionLane,
  CapturedSource,
  DispatchAdoption,
  DispatchScope,
  PreparedAiConfiguration,
} from './scope';

/** The definition a dispatch executes, and the frozen source it executes from. */
export interface ExecutableSource {
  workflow: ResolvedWorkflow;
  /** Absent for a continuation, which executes the source its run already froze. */
  freshCaptured: CapturedSource | undefined;
  /** The adopted run's worktree, for a reuse-worktree lane. */
  adoptedEnvironment: AdoptedEnvironment | undefined;
  /** The AI configuration a checkout-branch lane prepared from its branch snapshot. */
  branchPrepared: PreparedAiConfiguration | undefined;
}

/**
 * Settle the source a dispatch executes; `undefined` after telling the user it cannot.
 *
 * AFTER resume detection, on purpose. A continuation must execute the source its run
 * already froze; capturing here would freeze current bytes, re-resolve the graph from
 * them, and then hand the executor a run whose recorded capture supplies the commands
 * and scripts — a graph from one moment against resources from another. Capturing a
 * resume also leaves a staging directory nothing adopts.
 *
 * For a fresh run: freeze, then re-resolve the workflow FROM the frozen copy, so the
 * definition executed and the resources beside it are one consistent set of bytes.
 */
export async function prepareExecutableSource(
  scope: DispatchScope,
  request: WorkflowRequest,
  requested: ResolvedWorkflow,
  adoption: DispatchAdoption | undefined,
  { resumableRun, willContinueExistingRun }: Continuation
): Promise<ExecutableSource | undefined> {
  const { platform, conversationId, runCwd, owner } = scope;
  let workflow = requested;
  if (request.kind === 'start' && willContinueExistingRun && resumableRun) {
    const resolved = await resolveRunWorkflow(createWorkflowDeps(), resumableRun, runCwd, platform);
    if (!resolved.ok) {
      await platform.sendMessage(
        conversationId,
        `Cannot continue run \`${resumableRun.id}\`: ${resolved.message}` +
          (resolved.resumeHint ? ` ${resolved.resumeHint}` : '')
      );
      return undefined;
    }
    workflow = resolved.workflow;
  }

  const lane = adoption?.lane;
  const adoptedEnvironment = await inheritAdoptedWorktree(scope, lane);
  if (willContinueExistingRun)
    return { workflow, freshCaptured: undefined, adoptedEnvironment, branchPrepared: undefined };
  if (lane?.kind === 'checkout-branch') {
    const branch = await captureFromTaskBranch(scope, lane, workflow, adoption);
    return branch && { ...branch, adoptedEnvironment };
  }
  const captureCwd = adoptedEnvironment?.working_path ?? runCwd;
  const freshCaptured = await captureFreshSource(
    owner,
    captureCwd,
    workflow,
    conversationId,
    platform,
    lane?.kind === 'reuse-worktree' ? captureCwd : undefined
  );
  if (!freshCaptured) return undefined; // capture failed, message already sent
  return {
    workflow: freshCaptured.workflow,
    freshCaptured,
    adoptedEnvironment,
    branchPrepared: undefined,
  };
}

/**
 * A reuse-worktree lane inherits the adopted run's worktree; its `.archon` belongs to
 * whatever branch that worktree carries, so the frozen source must come from THERE —
 * capturing from the parent checkout would mix vintages exactly as #2660 describes.
 */
async function inheritAdoptedWorktree(
  { platform, codebase }: DispatchScope,
  lane: AdoptionLane | undefined
): Promise<AdoptedEnvironment | undefined> {
  if (lane?.kind !== 'reuse-worktree') return undefined;
  const adoptedEnvironment = await resolveRegisteredWorktree(sqlIsolation, lane);
  if (!adoptedEnvironment) return undefined;
  if (platform.capabilities.defaultWorkflowDispatch === 'background') {
    await verifyWorktreeOwnership(
      toWorktreePath(adoptedEnvironment.working_path),
      toRepoPath(codebase.default_cwd)
    );
  } else {
    await recordWorktreeAdoption(sqlIsolation, adoptedEnvironment, codebase.default_cwd);
  }
  return adoptedEnvironment;
}

/** A checkout-branch lane captures a read-only snapshot of its branch before isolation exists. */
async function captureFromTaskBranch(
  scope: DispatchScope,
  lane: Extract<AdoptionLane, { kind: 'checkout-branch' }>,
  requested: ResolvedWorkflow,
  adoption: DispatchAdoption | undefined
): Promise<Omit<ExecutableSource, 'adoptedEnvironment'> | undefined> {
  const { owner, codebase, conversationId, platform } = scope;
  let captured: Omit<ExecutableSource, 'adoptedEnvironment'> | undefined;
  await withBranchLaunchSource(codebase.default_cwd, lane.taskBranch.branch, async snapshot => {
    const freshCaptured = await captureFreshSource(
      owner,
      snapshot,
      requested,
      conversationId,
      platform,
      snapshot
    );
    if (!freshCaptured) return;
    captured = {
      workflow: freshCaptured.workflow,
      freshCaptured,
      branchPrepared: await prepareLaunchAiConfiguration(
        scope,
        adoption,
        freshCaptured.workflow,
        snapshot
      ),
    };
  });
  return captured;
}

/** The AI configuration a fresh run launches with, read from `configCwd`. */
export function prepareLaunchAiConfiguration(
  { codebase, userId, options }: DispatchScope,
  adoption: DispatchAdoption | undefined,
  definition: ResolvedWorkflow,
  configCwd: string
): Promise<PreparedAiConfiguration> {
  return prepareRunAiConfiguration(createWorkflowDeps(), definition, configCwd, {
    codebaseId: codebase.id,
    userId,
    aiConfigurationRun: adoption?.adoptedRun,
    runConfig: options?.runConfig,
    ...(options?.modelOverrides
      ? { modelOverrideLayer: { kind: 'raw', overrides: options.modelOverrides } }
      : {}),
  });
}

/**
 * Freeze the workflow source and re-resolve the workflow FROM the freeze.
 *
 * A fresh run row is created from the captured bytes — commands and scripts beside
 * the DAG come from the same moment as the DAG itself. Without this, an edited
 * workflow would silently run its new graph against pre-edit command bytes; this is
 * the exact shape #2660 exists to remove, and the exact shape that must be avoided in
 * the fresh-run-in-same-worktree fallback (#2686).
 *
 * On success: hands the staged capture to the owner (`hold`), records the selected
 * workflow name, and returns both the prepared source and the freshly resolved graph.
 * The caller adopts when a run takes over.
 *
 * On failure: sends the user-facing message and returns `undefined`. The caller MUST
 * `return` immediately — the owner reclaims any unadopted capture on the way out, so
 * no manual cleanup is needed.
 */
export async function captureFreshSource(
  owner: CapturedSourceOwner,
  runCwd: string,
  workflow: ResolvedWorkflow,
  conversationId: string,
  platform: IPlatformAdapter,
  explicitSourceRoot?: string
): Promise<CapturedSource | undefined> {
  try {
    const workflowSourceRoot = explicitSourceRoot ?? (await resolveWorkflowSourceRoot(runCwd));
    const preparedSource = await prepareWorkflowSource(createWorkflowDeps(), {
      sourceRoot: workflowSourceRoot ?? runCwd,
    });
    // From here the owner reclaims it unless a run adopts it, whichever way we leave.
    owner.hold(preparedSource);
    // Re-resolve only when files were actually frozen. An empty capture means the
    // definition came from the bundled set a binary embeds as constants — immutable for
    // that binary, with nothing on disk to re-read.
    let resolvedWorkflow = workflow;
    if (preparedSource.manifest.scopes.length > 0) {
      const { workflows: capturedWorkflows } = await discoverWorkflowsWithConfig(
        runCwd,
        loadConfig,
        providerRegistry,
        preparedSource.roots
      );
      const reResolved = resolveWorkflowName(
        workflow.name,
        capturedWorkflows.map(w => w.workflow)
      );
      if (!reResolved) {
        // No manual cleanup: the owner reclaims anything unadopted on the way out.
        await platform.sendMessage(
          conversationId,
          `Could not read workflow **${workflow.name}** from this run's captured source. ` +
            'Nothing has been started.'
        );
        return undefined;
      }
      resolvedWorkflow = reResolved;
    }
    await recordSelectedWorkflow(preparedSource.anchor.root, resolvedWorkflow.name);
    return { preparedSource, workflow: resolvedWorkflow };
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName: workflow.name }, 'workflow.source_capture_failed');
    await platform.sendMessage(
      conversationId,
      `Could not capture the workflow source for **${workflow.name}**: ${err.message}. ` +
        'Nothing has been started.'
    );
    return undefined;
  }
}
