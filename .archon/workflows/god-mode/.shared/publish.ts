/**
 * Publish an approved change as a draft pull request.
 *
 * Every change god mode makes to the repository's own automation (a forged
 * workflow, a revised prompt or policy) ends here, and only after a person
 * approved it. A draft pull request routes it through the project's normal
 * review and merge path, whatever that is; nothing here merges.
 *
 * The pull request opens through the GitHub CLI by default. Set
 * `GOD_MODE_FORGE=forge` to open it through Archon's forge seam instead
 * (`archon forge pr.create`), which reaches any forge an installed plugin serves.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliArgv } from './archon.ts';

export interface Remote {
  host: string;
  path: string;
}

/** The host and `owner/repo` path of a git remote URL, in https or scp-like ssh form. */
export function parseRemote(url: string): Remote {
  const trimmed = url.trim().replace(/\.git$/, '');
  const https = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const scp = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(trimmed);
  const match = https ?? scp;
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`cannot read a host and repository path from the remote URL \`${url}\``);
  }
  return { host: match[1], path: match[2].replace(/^\/+/, '') };
}

function run(cmd: string[], stdin?: string): string {
  const proc = Bun.spawnSync(cmd, {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.slice(0, 3).join(' ')} failed: ${proc.stderr.toString().trim() || proc.stdout.toString().trim()}`);
  }
  return proc.stdout.toString().trim();
}

export function git(args: string[]): string {
  return run(['git', ...args]);
}

export interface Publication {
  branch: string;
  commit: string;
  pr_url: string;
}

export interface PublishRequest {
  /** Paths to commit; anything else in the checkout stays out of the change. */
  paths: string[];
  message: string;
  title: string;
  body: string;
  /** The branch the pull request targets: the run's `$BASE_BRANCH`. */
  base: string;
}

export function publish(req: PublishRequest): Publication {
  if (req.paths.length === 0) throw new Error('there is nothing to publish');
  if (req.base.trim() === '') throw new Error('no base branch to open the pull request against');
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new Error('the checkout is on a detached HEAD; there is no branch to publish');
  if (branch === req.base) throw new Error(`refusing to publish directly on the base branch \`${req.base}\``);

  git(['add', '-A', '--', ...req.paths]);
  const staged = run(['git', 'diff', '--cached', '--name-only']);
  if (staged !== '') git(['commit', '-m', req.message]);
  const commit = git(['rev-parse', 'HEAD']);
  git(['push', '-u', 'origin', branch]);

  const directory = mkdtempSync(join(tmpdir(), 'god-mode-pr-'));
  try {
    const bodyPath = join(directory, 'body.md');
    writeFileSync(bodyPath, req.body, { mode: 0o600 });
    if ((process.env.GOD_MODE_FORGE ?? 'gh').trim() === 'forge') {
      const repo = parseRemote(git(['remote', 'get-url', 'origin']));
      const requestPath = join(directory, 'request.json');
      writeFileSync(
        requestPath,
        JSON.stringify({ repo, headRepo: repo, head: branch, headRevision: commit, base: req.base, title: req.title, body: req.body, draft: true }),
        { mode: 0o600 },
      );
      const out = JSON.parse(run([...cliArgv(), 'forge', 'pr.create', '--json', '--data-file', requestPath])) as {
        ok?: boolean;
        result?: { value?: { pr?: { url?: string } } };
        error?: { message?: string };
      };
      const url = out.result?.value?.pr?.url;
      if (out.ok !== true || typeof url !== 'string') {
        throw new Error(`forge pr.create did not open a pull request: ${out.error?.message ?? JSON.stringify(out)}`);
      }
      return { branch, commit, pr_url: url };
    }
    const url = run(['gh', 'pr', 'create', '--draft', '--base', req.base, '--head', branch, '--title', req.title, '--body-file', bodyPath]);
    return { branch, commit, pr_url: url.split('\n').pop() ?? url };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every path changed since `start`: committed, staged, unstaged, or untracked. */
export function changedSince(start: string): string[] {
  const tracked = git(['diff', '--name-only', start]).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...tracked, ...untracked].map((p) => p.trim()).filter((p) => p !== ''))].sort();
}
