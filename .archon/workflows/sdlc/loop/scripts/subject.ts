/**
 * Name what the app check tests, without handing it the builder's account of the change.
 *
 * The app check is meant to find out what a change does by running it. Given the builder's
 * report or the pull request's description first, it anchored on them and tested what they
 * said. So this step reads those only to find the pull request, and passes on facts: the pull
 * request, its head commit, the files it changes, and how it stands against the current
 * default branch (how far behind, and whether it merges cleanly). It also records when the
 * check began, so the evidence check after it can tell evidence written during the check
 * from files that were already there.
 *
 * An empty `pr` means nothing was delivered this run; the app check then reports `NO PR`.
 */

import { emit, trimmed } from '../../.shared/io.ts';
import { closes } from '../../.shared/workable.ts';

const started = String(Date.now());
const target = trimmed(process.env.INPUTS_TARGET);
const chosen = trimmed(process.env.INPUTS_PR);
const builder = trimmed(process.env.INPUTS_BUILDER);
const ship = trimmed(process.env.INPUTS_SHIP);

function run(cmd: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function gh(args: string[]): unknown {
  const result = run(['gh', ...args]);
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.err.trim()}`);
  return JSON.parse(result.out);
}

const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

function findPr(): string {
  if (chosen !== '') return chosen;
  const named = [...`${builder}\n${ship}`.matchAll(PR_URL)].map(m => m[0]);
  if (named.length > 0) return named[named.length - 1];
  const issue = /\/issues\/(\d+)\/?$/.exec(target)?.[1];
  if (issue === undefined) return '';
  const open = gh([
    'pr',
    'list',
    '--state',
    'open',
    '--search',
    issue,
    '--json',
    'url,body,updatedAt',
  ]) as { url: string; body: string; updatedAt: string }[];
  const closing = open
    .filter(pr => closes(pr.body ?? '').includes(Number(issue)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return closing[0]?.url ?? '';
}

const pr = findPr();
if (pr === '') {
  emit({ pr: '', head: '', base: '', behind: '0', conflicts: 'false', files: '', started });
} else {
  const view = gh([
    'pr',
    'view',
    pr,
    '--json',
    'number,headRefOid,headRefName,baseRefName,files,state',
  ]) as {
    number: number;
    headRefOid: string;
    baseRefName: string;
    files: { path: string }[];
    state: string;
  };
  const base = view.baseRefName;
  // Bring both tips into this checkout without touching its working tree. The fetched ref
  // is the head as git has it now; the API's head can lag a push made moments ago.
  const ref = `refs/remotes/origin/loop-subject-${view.number}`;
  run(['git', 'fetch', '--quiet', 'origin', base, `+refs/pull/${view.number}/head:${ref}`]);
  const fetched = run(['git', 'rev-parse', '--verify', '--quiet', ref]);
  const head = fetched.code === 0 && fetched.out.trim() !== '' ? fetched.out.trim() : view.headRefOid;
  const behindResult = run(['git', 'rev-list', '--count', `${head}..origin/${base}`]);
  const behind = behindResult.code === 0 ? behindResult.out.trim() : 'unknown';
  // merge-tree exits 1 when the two tips conflict and writes nothing to the checkout.
  const merge = run(['git', 'merge-tree', '--write-tree', '--name-only', `origin/${base}`, head]);
  const conflicts = merge.code === 1 ? 'true' : merge.code === 0 ? 'false' : 'unknown';
  emit({
    pr,
    head,
    base,
    behind,
    conflicts,
    files: view.files.map(file => file.path).join('\n'),
    started,
  });
}
