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
 * Whether the run will execute in a container. Only then is native authentication
 * checked after isolation: every other run executes on the host, where the launch
 * checkout and any worktree cut from it see the same login.
 */
export async function runExecutesInContainer(
  host: WorkflowHost,
  options: Pick<WorkflowRunOptions, 'container' | 'resume'>,
  workflow: Pick<ResolvedWorkflow, 'container'>,
  codebase: Pick<Codebase, 'kind' | 'default_cwd'> | null | undefined,
  resumable: WorkflowRun | null | undefined
): Promise<boolean> {
  if (codebase?.kind !== 'folder') return false;
  const folderConfig = await host.deps.loadConfig(codebase.default_cwd);
  return folderRunsInContainer(options, workflow, folderConfig, resumable);
}

/**
 * Check native authentication inside the run's container. A refused fresh container is
 * destroyed here: no run owns it yet, so the teardown after execution never sees it.
 * A resumed run's container belongs to that run and stays. Host runs were checked
 * before isolation.
 */
export async function assertContainerRunCredentials(
  host: WorkflowHost,
  prepared: PreparedRunAiConfiguration,
  context: { cwd: string; execContext: ExecutionContext },
  container: {
    backend: ContainerBackend | undefined;
    envId: string | undefined;
    resumable: WorkflowRun | null;
  }
): Promise<void> {
  if (context.execContext.kind !== 'container') return;
  try {
    await assertRunCredentials(host.deps, prepared, context);
  } catch (error) {
    if (container.backend && container.envId && !container.resumable)
      await destroyRunContainer(host.deps.store, container.backend, container.envId, undefined);
    throw error;
  }
}
