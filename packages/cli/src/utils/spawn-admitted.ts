import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { cliProgramArguments } from './cli-program-arguments';
import { DETACHED_RUN_OWNER_ENV } from './detached-run-control';
import { startTriggerExecutor } from './run-job-escape';

/** Hand one admitted request to a detached `trigger execute` process with its own log. */
export async function spawnAdmitted(
  host: {
    readonly deps: {
      readonly store: Pick<WorkflowHost['deps']['store'], 'getResourceStartRequest'>;
    };
  },
  requestId: string,
  hostId: string
): Promise<void> {
  const request = await host.deps.store.getResourceStartRequest(requestId);
  if (request?.status !== 'admitted') throw new Error('The admitted start request is unavailable.');
  const logDirectory = join(getArchonHome(), 'logs');
  await mkdir(logDirectory, { recursive: true });
  // Inside a Windows run this starts through the run's job broker: the executor is another
  // run's owner and must not end with the run that started it.
  await startTriggerExecutor(
    {
      args: ['trigger', 'execute', requestId, '--host', hostId],
      cwd: request.launch.execution.cwd,
      env: { ...process.env, ARCHON_HOME: getArchonHome(), [DETACHED_RUN_OWNER_ENV]: '1' },
      log: join(logDirectory, `trigger-run-${requestId}.log`),
    },
    cliProgramArguments()
  );
}
