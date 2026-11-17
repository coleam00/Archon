import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { getArchonHome } from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { cliProgramArguments } from './cli-program-arguments';
import { DETACHED_RUN_OWNER_ENV } from './detached-run-control';

/** Hand one admitted request to a detached `trigger execute` process with its own log. */
export async function spawnAdmitted(
  host: WorkflowHost,
  requestId: string,
  hostId: string
): Promise<void> {
  const request = await host.deps.store.getResourceStartRequest(requestId);
  if (request?.status !== 'admitted') throw new Error('The admitted start request is unavailable.');
  const [executable, ...prefix] = cliProgramArguments();
  const logDirectory = join(getArchonHome(), 'logs');
  await mkdir(logDirectory, { recursive: true });
  const log = await open(join(logDirectory, `trigger-run-${requestId}.log`), 'a', 0o600);
  try {
    const child = spawn(
      executable,
      [...prefix, 'trigger', 'execute', requestId, '--host', hostId],
      {
        cwd: request.launch.execution.cwd,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        windowsHide: true,
        env: { ...process.env, ARCHON_HOME: getArchonHome(), [DETACHED_RUN_OWNER_ENV]: '1' },
      }
    );
    await new Promise<void>((resolveSpawn, reject) => {
      child.once('error', reject);
      child.once('spawn', resolveSpawn);
    });
    child.unref();
  } finally {
    await log.close();
  }
}
