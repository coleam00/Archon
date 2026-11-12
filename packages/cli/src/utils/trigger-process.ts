import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from '@hono/zod-openapi';
import { BUNDLED_IS_BINARY } from '@archon/paths';
import { DETACHED_RUN_OWNER_ENV } from './detached-run-control';
import { RUN_JOB_ESCAPE_BUN_CONFIG_ARG, RUN_JOB_ESCAPE_ENV } from './run-job-escape';

export const triggerProcessLaunchSchema = z
  .object({
    requestId: z.string().uuid(),
    hostId: z.string().min(1),
    cwd: z.string().min(1),
    archonHome: z.string().min(1),
    env: z.record(z.string(), z.string().optional()),
  })
  .strict();
export type TriggerProcessLaunch = z.infer<typeof triggerProcessLaunchSchema>;

export function triggerProcessLog(archonHome: string, requestId: string): string {
  return join(archonHome, 'logs', `trigger-run-${requestId}.log`);
}

export async function spawnTriggerProcess(
  program: readonly [string, ...string[]],
  launch: TriggerProcessLaunch
): Promise<void> {
  const logPath = triggerProcessLog(launch.archonHome, launch.requestId);
  await mkdir(join(launch.archonHome, 'logs'), { recursive: true });
  const log = await open(logPath, 'a', 0o600);
  try {
    const [executable, ...prefix] = program;
    const env = {
      ...launch.env,
      ARCHON_HOME: launch.archonHome,
      BUN_OPTIONS: '',
      [DETACHED_RUN_OWNER_ENV]: '1',
    };
    // The successor starts outside its predecessor's job and claims its own broker.
    Reflect.deleteProperty(env, RUN_JOB_ESCAPE_ENV);
    const child = spawn(
      executable,
      [
        ...(BUNDLED_IS_BINARY ? [] : [RUN_JOB_ESCAPE_BUN_CONFIG_ARG]),
        ...prefix,
        'trigger',
        'execute',
        launch.requestId,
        '--host',
        launch.hostId,
      ],
      {
        cwd: launch.cwd,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        windowsHide: true,
        env,
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
