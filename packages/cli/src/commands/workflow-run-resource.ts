import {
  admitNativeResourceStart,
  readResourceStartAfterFailure,
} from '@archon/workflows/resource-start-store';
import { retainSetupRunSource } from '@archon/core/workflows/worktree-setup';
import type { OwnedRunLease } from '../utils/owned-run-lease';
import { registerWorkflowPreparationTermination } from '../utils/owned-run-termination';
import { createSetupRun, type ForegroundLaunch } from './workflow-run-launch';

/** Native execution options stay with the CLI while its durable request waits. */
export async function admitForegroundResource(
  launch: ForegroundLaunch,
  lease: OwnedRunLease
): Promise<void> {
  const { request, admission, codebase, workspace } = launch;
  const { workflow } = admission;
  if (!workflow.resource || admission.isContinuation || request.options.stubsInitPath) return;
  if (!codebase || !admission.preparedSource)
    throw new Error('Workflow resource admission requires a project and captured source');
  const { host } = request;
  await lease.start(admission.preCreatedRun?.id ?? admission.preparedSource.runId);
  const run =
    admission.preCreatedRun ??
    (await createSetupRun(launch, codebase, admission.preparedSource.runId));
  admission.preCreatedRun = run;
  lease.setupRun = run;
  admission.preparedSource = await retainSetupRunSource(
    host.deps,
    run,
    admission.preparedSource,
    request.owner,
    codebase.default_cwd,
    codebase.id
  );
  const isolation: Parameters<typeof admitNativeResourceStart>[3]['isolation'] =
    admission.wantsIsolation && !launch.isFolderCodebase
      ? { kind: 'worktree', branch: request.options.branchName }
      : { kind: 'in-place' };
  const termination = registerWorkflowPreparationTermination('Resource admission');
  try {
    const result = await admitNativeResourceStart(
      host.deps.store,
      workflow,
      run,
      { cwd: workspace.workingCwd, conversationId: launch.conversationId, isolation },
      {
        noWait: request.options.noWait,
        signal: termination.signal,
        onWaiting: async (resource, requestId) => {
          lease.setupRun = undefined;
          console.error(`Waiting for resource '${resource}' (request ${requestId}).`);
        },
      }
    );
    if (result.status === 'skipped') {
      lease.setupRun = run;
      throw new Error(
        `Resource '${workflow.resource.name}' is full; --no-wait refused the start (blocked by ${result.blocker.kind} '${result.blocker.id}').`
      );
    }
    lease.setupRun = run;
    termination.signal.throwIfAborted();
  } catch (error) {
    lease.setupRun = undefined;
    const retained = await readResourceStartAfterFailure(host.deps.store, run.id, error);
    lease.setupRun = retained?.status === 'queued' ? undefined : run;
    throw error;
  } finally {
    termination.dispose();
  }
}
