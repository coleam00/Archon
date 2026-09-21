import { resolve } from 'node:path';
import { DEV_SERVER_PORT_ENV, getPort } from '@archon/core/utils/port-allocation';

const REPO_ROOT = resolve(import.meta.dir, '..');

export function createDevEnvironment(
  port: number,
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  const value = String(port);
  return {
    ...env,
    [DEV_SERVER_PORT_ENV]: value,
    VITE_API_PORT: value,
  };
}

async function main(): Promise<number> {
  const port = await getPort();
  const child = Bun.spawn(['bun', '--filter', '*', 'dev'], {
    cwd: REPO_ROOT,
    env: createDevEnvironment(port),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return child.exited;
}

if (import.meta.main) process.exit(await main());
