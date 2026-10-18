/**
 * Name what the app check tests, without handing it the builder's account of the change.
 *
 * Given the builder's report or the pull request's description first, the app check anchored
 * on them and tested what they said. So this step reads those only to find the pull request,
 * and passes on facts: the pull request, its head, its base and the files it changes. It also
 * records when the check began, so the evidence check can tell evidence written during the
 * check from files that were already there. An empty `pr` means nothing was delivered.
 */

import { emit, trimmed } from '../../.shared/io.ts';
import { closes } from '../../.shared/workable.ts';

const started = String(Date.now());
const target = trimmed(process.env.INPUTS_TARGET);
const chosen = trimmed(process.env.INPUTS_PR);
const reports = `${trimmed(process.env.INPUTS_BUILDER)}\n${trimmed(process.env.INPUTS_SHIP)}`;

function gh(args: string[]): unknown {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.toString().trim()}`);
  return JSON.parse(result.stdout.toString());
}

function findPr(): string {
  if (chosen !== '') return chosen;
  const named = [...reports.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)].map(m => m[0]);
  if (named.length > 0) return named[named.length - 1];
  const issue = /\/issues\/(\d+)\/?$/.exec(target)?.[1];
  if (issue === undefined) return '';
  const open = gh(['pr', 'list', '--state', 'open', '--search', issue, '--json', 'url,body,updatedAt']) as {
    url: string;
    body: string;
    updatedAt: string;
  }[];
  const closing = open.filter(pr => closes(pr.body ?? '').includes(Number(issue)));
  return closing.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.url ?? '';
}

const pr = findPr();
if (pr === '') {
  emit({ pr: '', head: '', base: '', files: '', started });
} else {
  const view = gh(['pr', 'view', pr, '--json', 'number,headRefOid,baseRefName,files']) as {
    number: number;
    headRefOid: string;
    baseRefName: string;
    files: { path: string }[];
  };
  // The API's head can lag a push made moments ago; git's view of the pull request's ref does not.
  const ref = `refs/remotes/origin/loop-subject-${view.number}`;
  Bun.spawnSync(['git', 'fetch', '--quiet', 'origin', `+refs/pull/${view.number}/head:${ref}`]);
  const fetched = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', ref], { stdout: 'pipe' });
  const head = fetched.exitCode === 0 ? fetched.stdout.toString().trim() : view.headRefOid;
  emit({ pr, head: head || view.headRefOid, base: view.baseRefName, files: view.files.map(f => f.path).join('\n'), started });
}
