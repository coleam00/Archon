/**
 * Start another pack workflow detached, from the main checkout: the launching run's
 * worktree can be cleaned up before the new run reads it. Returns the new run's id.
 *
 * Re-triage and the build queue's handoff of new work start intake this way; queue
 * follow-ups go through the operator's trigger bindings (`follow-up.ts`).
 */

import { dirname } from 'node:path';
import { archonCommand } from './host.ts';
import { type QualifiedPr } from './identity.ts';
import { nullableJson } from './inputs.ts';
import { gitOrThrow } from './git.ts';
import { enqueue } from './workitem.ts';

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

/**
 * Ask intake to re-triage an item: record this run's own request on the item's work
 * item, naming the run, then start one intake pickup for it. No label is written, so no
 * label event starts a second pickup, and no maintainer is credited with the request.
 * Returns the intake run's id.
 */
export function requestRetriage(subject: QualifiedPr, runId: string): string {
  enqueue(subject, { at: new Date().toISOString(), run_id: runId, action: 'retriage', label: null, actor: null, body_digest: null });
  return launchDetached('archon-intake', {
    repo_host: subject.repo.host,
    repo_path: subject.repo.path,
    number: String(subject.number),
    action: 'retriage',
  });
}
