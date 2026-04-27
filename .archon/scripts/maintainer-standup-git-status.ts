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
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function run(cmd: string): { stdout: string; ok: boolean } {
  try {
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
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

run('git fetch origin dev');

const currentBranch = run('git rev-parse --abbrev-ref HEAD').stdout.trim();
const isDirty = run('git status --porcelain').stdout.trim().length > 0;

let pullStatus: 'pulled' | 'fetch_only' | 'pull_failed' | 'not_on_dev' | 'dirty';
if (currentBranch !== 'dev') {
  pullStatus = 'not_on_dev';
} else if (isDirty) {
  pullStatus = 'dirty';
} else {
  const result = run('git pull --ff-only origin dev');
  pullStatus = result.ok ? 'pulled' : 'pull_failed';
}

const currentDevSha = run('git rev-parse origin/dev').stdout.trim();

let newCommits = '';
let diffStat = '';
if (priorSha && priorSha !== currentDevSha) {
  // %h short SHA, %an author name, %s subject
  const log = run(`git log ${priorSha}..origin/dev --no-decorate --format="%h %an: %s"`);
  if (log.ok) {
    newCommits = log.stdout;
    diffStat = run(`git diff --stat ${priorSha}..origin/dev`).stdout;
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
