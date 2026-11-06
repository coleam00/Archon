/**
 * Start another pack workflow detached, from the main checkout: the launching run's
 * worktree can be cleaned up before the new run reads it. Returns the new run's id.
 *
 * Only re-triage still starts intake this way; queue follow-ups go through the
 * operator's trigger bindings (`follow-up.ts`).
 */

import { dirname } from 'node:path';
import { archonCommand } from './forge.ts';
import { gitOrThrow } from './git.ts';
import { nullableJson } from './io.ts';

export function launchDetached(workflow: string, inputs: Record<string, string>): string {
  const root = dirname(gitOrThrow('rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  const args = Object.entries(inputs).flatMap(([name, value]) => ['--input', `${name}=${value}`]);
  const result = Bun.spawnSync(
    [...archonCommand(), 'workflow', 'run', workflow, '--cwd', root, ...args, '--detach', '--json'],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' }
  );
  if (result.exitCode !== 0) throw new Error(`${workflow} did not start: ${result.stderr.toString().trim()}`);
  const runId = (nullableJson(result.stdout.toString()) as { runId?: unknown } | null)?.runId;
  if (typeof runId !== 'string' || runId === '') throw new Error(`${workflow} acknowledged no run id`);
  return runId;
}
