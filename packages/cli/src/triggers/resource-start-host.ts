import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { drainResourceStartHost } from '@archon/core/workflows/resource-start-host';
import { getArchonHome } from '@archon/paths';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { RUN_JOB_ESCAPE_ENV, spawnTriggerOutsideRunJob } from '../utils/run-job-escape';
import { spawnTriggerProcess, triggerProcessLog } from '../utils/trigger-process';

/** Hand one admitted request to a detached `trigger execute` process with its own log. */
export async function spawnAdmitted(
  host: WorkflowHost,
  requestId: string,
  hostId: string
): Promise<void> {
  const request = await host.deps.store.getResourceStartRequest(requestId);
  if (request?.status !== 'admitted') throw new Error('The admitted start request is unavailable.');
  const launch = {
    requestId,
    hostId,
    cwd: request.launch.execution.cwd,
    archonHome: getArchonHome(),
    env: { ...process.env },
  };
  try {
    const brokerPipe = process.env[RUN_JOB_ESCAPE_ENV];
    if (brokerPipe !== undefined) await spawnTriggerOutsideRunJob(brokerPipe, launch);
    else await spawnTriggerProcess(cliProgramArguments(), launch);
  } catch (error) {
    throw new Error(
      `Admitted request ${requestId} (run ${request.launch.run.id}, host ${hostId}) could not be dispatched: ${error instanceof Error ? error.message : String(error)}. ` +
        `Inspect with archon trigger inspect ${requestId} and archon workflow get ${request.launch.run.id}; ` +
        `check ownership and log ${triggerProcessLog(launch.archonHome, requestId)}. ` +
        `Only after verifying no executor owns the run, retry: archon trigger execute ${requestId} --host ${hostId}. ` +
        `A drain cannot retry an admitted request.`,
      { cause: error }
    );
  }
}

export function drainHost(
  host: WorkflowHost,
  hostId: string,
  dispatch: (requestId: string, hostId: string) => Promise<void>
): Promise<void> {
  return drainResourceStartHost({
    ...host,
    hostId,
    startAdmitted: requestId => dispatch(requestId, hostId),
  });
}
