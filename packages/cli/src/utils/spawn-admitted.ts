import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, getArchonHome } from '@archon/paths';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { StartedExecutor } from '@archon/core/workflows/start-executor';
import { cliProgramArguments } from './cli-program-arguments';
import { DETACHED_RUN_OWNER_ENV } from './detached-run-control';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('cli.spawn-admitted');
  return cachedLog;
}

/**
 * Hand one admitted request to a detached `trigger execute` process with its own log, and
 * name that process. It rejects only before the process starts: once it has started, a
 * rejection would record a hand-off that started nothing (`handOffAdmitted`).
 */
export async function spawnAdmitted(
  host: { deps: { store: Pick<IWorkflowStore, 'getResourceStartRequest'> } },
  requestId: string,
  hostId: string
): Promise<StartedExecutor> {
  const request = await host.deps.store.getResourceStartRequest(requestId);
  if (request?.status !== 'admitted') throw new Error('The admitted start request is unavailable.');
  const [executable, ...prefix] = cliProgramArguments();
  const logDirectory = join(getArchonHome(), 'logs');
  await mkdir(logDirectory, { recursive: true });
  const log = await open(join(logDirectory, `trigger-run-${requestId}.log`), 'a', 0o600);
  let started: { child: ChildProcess; pid: number };
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
    // Node sets `pid` before `spawn` fires, so a missing pid means nothing started.
    const pid = await new Promise<number>((resolveSpawn, reject) => {
      child.once('error', reject);
      child.once('spawn', () =>
        child.pid === undefined
          ? reject(new Error('The spawned executor reported no process id.'))
          : resolveSpawn(child.pid)
      );
    });
    started = { child, pid };
  } catch (error) {
    await log.close();
    throw error;
  }
  started.child.unref();
  // The child holds its own copy of the log descriptor; closing ours cannot undo the start.
  await log.close().catch((error: unknown) => {
    getLog().warn({ err: error as Error, requestId }, 'spawn_admitted.log_close_failed');
  });
  return { pid: started.pid };
}
