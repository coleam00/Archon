import type { ExecutionContext } from '@archon/provider-contract';
import { requireContainerRunContext, type ContainerRunContext } from './container-context';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { reportContainerSuspension, type ContainerSuspendOutcome } from './dag/container-gate';
import type { SourceReleaseWrite } from './store';

export async function releaseUnreadableRunSource(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  runId: string,
  release: SourceReleaseWrite,
  execContext?: ExecutionContext,
  container?: ContainerRunContext
): Promise<{ released: boolean }> {
  if (execContext?.kind !== 'container') {
    return deps.store.releaseRunForUnreadableSource(runId, release);
  }
  const containerCtx = requireContainerRunContext(container);
  let beforePublish: (() => Promise<void>) | undefined;
  let outcome: ContainerSuspendOutcome | undefined;
  try {
    // Three Docker calls at most must fit within the file store's 10s lock wait.
    const suspend = await containerCtx.backend.prepareSuspend(containerCtx.envId, 2_000);
    beforePublish = async () => {
      try {
        await suspend();
        outcome = { stopped: true };
      } catch (error) {
        outcome = { stopped: false, error };
      }
    };
  } catch (error) {
    outcome = { stopped: false, error };
  }
  const result = await deps.store.releaseRunForUnreadableSource(runId, release, beforePublish);
  if (result.released && outcome) {
    await reportContainerSuspension(
      deps,
      platform,
      conversationId,
      containerCtx,
      execContext,
      runId,
      outcome
    );
  }
  return result;
}
