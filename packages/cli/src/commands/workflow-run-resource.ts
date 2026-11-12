import { awaitResourceStartAdmission } from '@archon/workflows/resource-start-store';
import {
  ADMISSION_CHECKOUT_GUARD_METADATA_KEY,
  preparedWorkflowLaunchSchema,
} from '@archon/workflows/schemas/resource-start';
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
  const metadata = { [ADMISSION_CHECKOUT_GUARD_METADATA_KEY]: workflow.mutates_checkout !== false };
  await host.deps.store.updateWorkflowRun(run.id, { metadata });
  run.metadata = { ...run.metadata, ...metadata };
  const isolation =
    admission.wantsIsolation && !launch.isFolderCodebase
      ? { kind: 'worktree', branch: request.options.branchName }
      : { kind: 'in-place' };
  const prepared = preparedWorkflowLaunchSchema.parse({
    version: 2,
    run: {
      id: run.id,
      workflow_name: run.workflow_name,
      codebase_id: run.codebase_id,
      user_message: run.user_message,
      origin: run.origin ?? undefined,
      metadata: run.metadata,
      ...(isolation.kind === 'in-place' ? { working_path: workspace.workingCwd } : {}),
    },
    execution: { cwd: workspace.workingCwd, conversationId: launch.conversationId, isolation },
  });
  const termination = registerWorkflowPreparationTermination('Resource admission');
  try {
    const result = await awaitResourceStartAdmission(host.deps.store, workflow.resource, prepared, {
      noWait: request.options.noWait,
      signal: termination.signal,
      onWaiting: async (resource, requestId) => {
        lease.setupRun = undefined;
        console.error(`Waiting for resource '${resource}' (request ${requestId}).`);
      },
    });
    if (result.status === 'skipped') {
      lease.setupRun = run;
      throw new Error(
        `Resource '${workflow.resource.name}' is full; --no-wait refused the start (blocked by ${result.blocker.kind} '${result.blocker.id}').`
      );
    }
    lease.setupRun = run;
    termination.signal.throwIfAborted();
  } catch (error) {
    const retained = await host.deps.store.getResourceStartRequest(run.id);
    lease.setupRun = retained?.status === 'queued' ? undefined : run;
    throw error;
  } finally {
    termination.dispose();
  }
}
