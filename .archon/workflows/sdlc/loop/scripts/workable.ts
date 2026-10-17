/**
 * Launch gate for the loop: print what a lap could start right now, as JSON.
 *
 * Not a node. A scheduler runs it in the repository checkout before it starts a lap,
 * and starts one only when there is more workable work than laps already looking for
 * some (see `.shared/workable.ts` for the rules). It reads GitHub. Its one write: the
 * scheduler names runs it knows have ended (`INPUTS_ENDED_RUNS`, comma-separated), and
 * a claim one of them still holds is released the way the run's own release step would
 * have, because a run killed before that step never frees its item.
 *
 * Output: `{ "workable": [{kind, number}], "claims": [{kind, number, run}], "ended": [...], "waiting": [...] }`.
 */

import { expiryHours } from '../../.shared/claims.ts';
import { trimmed } from '../../.shared/io.ts';
import { workability, type BoardItem } from '../../.shared/workable.ts';

function gh(args: string[]): unknown {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return JSON.parse(result.stdout.toString());
}

/** A text field gh returned, or empty when it is missing or not text. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function items(raw: unknown): BoardItem[] {
  if (!Array.isArray(raw)) throw new Error('gh returned no list');
  return raw.map((row: Record<string, unknown>) => ({
    number: Number(row.number),
    title: str(row.title),
    body: str(row.body),
    labels: Array.isArray(row.labels)
      ? row.labels.map((label: { name?: unknown }) => str(label.name))
      : [],
    comments: Array.isArray(row.comments)
      ? row.comments.map((comment: { body?: unknown; createdAt?: unknown; url?: unknown }) => ({
          body: str(comment.body),
          createdAt: str(comment.createdAt),
          url: str(comment.url),
        }))
      : [],
  }));
}

const fields = 'number,title,body,labels,comments';
const board = {
  issues: items(gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', fields])),
  pulls: items(gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', fields])),
};
const endedRuns = new Set(
  trimmed(process.env.INPUTS_ENDED_RUNS)
    .split(',')
    .map(run => run.trim())
    .filter(run => run !== '')
);
const result = workability(board, expiryHours(trimmed(process.env.INPUTS_CLAIM_HOURS)), Date.now(), endedRuns);
for (const claim of result.ended) {
  const id = /#issuecomment-(\d+)$/.exec(claim.url)?.[1];
  if (id === undefined) continue;
  gh([
    'api',
    `repos/{owner}/{repo}/issues/comments/${id}`,
    '--method',
    'PATCH',
    '-f',
    `body=Loop claim released: run ${claim.run} ended. Its \`Loop review:\` comment, if any, says what it did. (Released by the scheduler: the run ended without releasing it.)`,
  ]);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
