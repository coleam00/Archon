import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { Codebase } from '@archon/core/schemas/codebase';
import type { ContainerBackend, ExecutionContext } from '@archon/isolation';
import {
  assertRunCredentials,
  type PreparedRunAiConfiguration,
} from '@archon/workflows/run-preflight';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { destroyRunContainer, folderRunsInContainer } from './workflow-isolation';
import type { WorkflowRunOptions } from './workflow-shared';

/**
 * Whether a detached run executes in its launch checkout on the host. Only then can the
 * parent check native authentication before it forks; the child creates a worktree or
 * container and checks there.
 */
export async function detachedRunExecutesInPlace(
  host: WorkflowHost,
  options: WorkflowRunOptions,
  workflow: ResolvedWorkflow,
  target: { codebase: Codebase | null | undefined; isFolder: boolean; wantsIsolation: boolean },
  continuationRun: WorkflowRun | null | undefined
): Promise<boolean> {
  if (!target.isFolder) return options.noWorktree === true || !target.wantsIsolation;
  if (!target.codebase) return false;
  const folderConfig = await host.deps.loadConfig(target.codebase.default_cwd);
  return !folderRunsInContainer(options, workflow, folderConfig, continuationRun);
}

/**
 * Check native authentication where the run executes. A refused fresh container is
 * destroyed here: no run owns it yet, so the teardown after execution never sees it.
 * A resumed run's container belongs to that run and stays.
 */
export async function assertCredentialsWhereRunExecutes(
  host: WorkflowHost,
  prepared: PreparedRunAiConfiguration,
  context: { cwd: string; execContext: ExecutionContext },
  container: {
    backend: ContainerBackend | undefined;
    envId: string | undefined;
    resumable: WorkflowRun | null;
  }
): Promise<void> {
  try {
    await assertRunCredentials(host.deps, prepared, context);
  } catch (error) {
    if (container.backend && container.envId && !container.resumable)
      await destroyRunContainer(host.deps.store, container.backend, container.envId, undefined);
    throw error;
  }
}
