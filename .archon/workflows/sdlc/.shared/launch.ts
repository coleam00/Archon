/**
 * Start another pack workflow detached, from the main checkout: the launching run's
 * worktree can be cleaned up before the new run reads it. Returns the new run's id.
 */

import { dirname } from 'node:path';
import { archonCommand, type QualifiedPr } from './forge.ts';
import { gitOrThrow } from './git.ts';
import { note, nullableJson } from './io.ts';

/**
 * The inputs a same-queue follow-up keeps: the launching run's own values. Identity and
 * the item targeted come from the item, so these name neither.
 */
export const BUILD_QUEUE_SELECTIONS = ['retriage_as', 'round_limit'] as const;
export type BuildQueueSelections = Record<(typeof BUILD_QUEUE_SELECTIONS)[number], string>;
export const MERGE_QUEUE_SELECTIONS = ['limit', 'merge_method', 'retriage_as'] as const;
export type MergeQueueSelections = Record<(typeof MERGE_QUEUE_SELECTIONS)[number], string>;

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

/**
 * Start an item's next build-queue round now, on the run config and input selections this
 * run started with. A failed launch is noted, and the released item waits for the next queue run.
 */
export function launchNextRound(item: QualifiedPr, runId: string, selections: BuildQueueSelections): string {
  try {
    const next = launchDetached(
      'archon-build-queue',
      { ...selections, repo_host: item.repo.host, repo_path: item.repo.path, number: String(item.number) },
      { configFromRun: runId }
    );
    return `its next round started at once (run ${next})`;
  } catch (error) {
    note(`issue ${String(item.number)}: the next round did not start, so the next queue run picks it up: ${error instanceof Error ? error.message : String(error)}`);
    return 'the next queue run picks it up';
  }
}
