#!/usr/bin/env bun
/**
 * Fetches origin/dev, optionally fast-forwards local dev, and reports new
 * commits + diff stat since the last run's recorded SHA.
 *
 * Output: JSON to stdout with shape:
 *   {
 *     current_dev_sha, prior_dev_sha, current_branch, is_dirty,
 *     pull_status: 'pulled' | 'fetch_only' | 'pull_failed' | 'not_on_dev' | 'dirty',
 *     new_commits, diff_stat
 *   }
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// execFileSync (argv array, no shell) — defense-in-depth for git invocations.
// All args are hardcoded literals or values from `git` output (SHAs); using
// execFileSync removes any need to reason about shell metacharacters.
function git(args: string[]): { stdout: string; ok: boolean } {
  try {
    const out = execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { stdout: out, ok: true };
  } catch {
    return { stdout: '', ok: false };
  }
}

let priorSha = '';
const stateFile = resolve(process.cwd(), '.archon/maintainer-standup/state.json');
if (existsSync(stateFile)) {
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { last_dev_sha?: string };
    priorSha = state.last_dev_sha ?? '';
  } catch {
    // ignore corrupt state — first-run-like behavior
  }
}

git(['fetch', 'origin', 'dev']);

const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
const isDirty = git(['status', '--porcelain']).stdout.trim().length > 0;

let pullStatus: 'pulled' | 'fetch_only' | 'pull_failed' | 'not_on_dev' | 'dirty';
if (currentBranch !== 'dev') {
  pullStatus = 'not_on_dev';
} else if (isDirty) {
  pullStatus = 'dirty';
} else {
  const result = git(['pull', '--ff-only', 'origin', 'dev']);
  pullStatus = result.ok ? 'pulled' : 'pull_failed';
}

const currentDevSha = git(['rev-parse', 'origin/dev']).stdout.trim();

let newCommits = '';
let diffStat = '';
if (priorSha && priorSha !== currentDevSha) {
  // %h short SHA, %an author name, %s subject
  const log = git(['log', `${priorSha}..origin/dev`, '--no-decorate', '--format=%h %an: %s']);
  if (log.ok) {
    newCommits = log.stdout;
    diffStat = git(['diff', '--stat', `${priorSha}..origin/dev`]).stdout;
  } else {
    newCommits = '(prior SHA not found locally — full diff unavailable)';
  }
}

console.log(
  JSON.stringify({
    current_dev_sha: currentDevSha,
    prior_dev_sha: priorSha,
    current_branch: currentBranch,
    is_dirty: isDirty,
    pull_status: pullStatus,
    new_commits: newCommits,
    diff_stat: diffStat,
  }),
);
