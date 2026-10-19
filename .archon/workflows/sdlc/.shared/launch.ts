/**
 * Start another pack workflow detached, from the main checkout: the launching run's
 * worktree can be cleaned up before the new run reads it. Returns the new run's id.
 */

import { dirname } from 'node:path';
import { archonCommand } from './forge.ts';
import { gitOrThrow } from './git.ts';
import { nullableJson } from './io.ts';

export interface LaunchOptions {
  /** Start with the run config this run was started with (`--config-from-run`). */
  readonly configFromRun?: string;
}

export function launchDetached(workflow: string, inputs: Record<string, string>, options: LaunchOptions = {}): string {
  const root = dirname(gitOrThrow('rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  const args = Object.entries(inputs).flatMap(([name, value]) => ['--input', `${name}=${value}`]);
  const config = options.configFromRun === undefined ? [] : ['--config-from-run', options.configFromRun];
  const result = Bun.spawnSync(
    [...archonCommand(), 'workflow', 'run', workflow, '--cwd', root, ...args, ...config, '--detach', '--json'],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) throw new Error(`${workflow} did not start: ${result.stderr.toString().trim()}`);
  const runId = (nullableJson(result.stdout.toString()) as { runId?: unknown } | null)?.runId;
  if (typeof runId !== 'string' || runId === '') throw new Error(`${workflow} acknowledged no run id`);
  return runId;
}
