import type { ExecutionContext } from '@archon/provider-contract';
import type { ContainerRunContext } from './container-context';
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
  if (execContext?.kind !== 'container' || !container) {
    return deps.store.releaseRunForUnreadableSource(runId, release);
  }
  let beforePublish: (() => Promise<void>) | undefined;
  let outcome: ContainerSuspendOutcome | undefined;
  try {
    const suspend = await container.backend.prepareSuspend(container.envId);
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
      container,
      execContext,
      runId,
      outcome
    );
  }
  return result;
}
