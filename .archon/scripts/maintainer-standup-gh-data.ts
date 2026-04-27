#!/usr/bin/env bun
/**
 * Fetches GitHub data for the maintainer-standup synthesis: all open PRs
 * (light metadata), review-requested PRs, authored-by-me PRs, assigned issues,
 * recent unlabeled issues, and recently-closed PRs/issues since the last run.
 *
 * Reads gh_handle from .archon/maintainer-standup/profile.md frontmatter.
 *
 * Output: JSON to stdout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// execFileSync with argv arrays — avoids shell-string interpolation and the
// associated quoting hazards (esp. for handles loaded from profile.md).
function exec(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    process.stderr.write(`${file} command failed: ${file} ${args.join(' ')}\n${(e as Error).message}\n`);
    return '[]';
  }
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ── Load gh_handle from profile.md frontmatter ──
let ghHandle = '';
const profilePath = resolve(process.cwd(), '.archon/maintainer-standup/profile.md');
if (existsSync(profilePath)) {
  const profile = readFileSync(profilePath, 'utf8');
  const match = profile.match(/^gh_handle:\s*(\S+)\s*$/m);
  if (match) ghHandle = match[1];
}
if (!ghHandle) {
  process.stderr.write('Warning: no gh_handle found in profile.md frontmatter\n');
}

// ── Load prior state to scope "recently closed" lookups ──
let lastRunAt = '';
const statePath = resolve(process.cwd(), '.archon/maintainer-standup/state.json');
if (existsSync(statePath)) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { last_run_at?: string };
    lastRunAt = state.last_run_at ?? '';
  } catch {
    // ignore corrupt state
  }
}

// ── Open PRs (full metadata for triage) ──
const prFields = [
  'number',
  'title',
  'author',
  'labels',
  'createdAt',
  'updatedAt',
  'isDraft',
  'mergeable',
  'mergeStateStatus',
  'reviewDecision',
  'headRefName',
  'baseRefName',
  'additions',
  'deletions',
  'changedFiles',
  'reviewRequests',
].join(',');

// `gh pr list --json` does NOT auto-paginate beyond `--limit`. 1000 is the
// practical ceiling for a single GraphQL call and gives ~15× headroom over
// today's open-PR count. The next-run-diff invariant in the synthesis
// command (observed_prs must include every entry in all_open_prs) requires
// completeness here, so we warn loudly if we ever hit the cap.
const PR_LIMIT = 1000;
const allOpenPrs = parseJson<unknown[]>(
  exec('gh', ['pr', 'list', '--state', 'open', '--limit', String(PR_LIMIT), '--json', prFields]),
  [],
);
if (allOpenPrs.length === PR_LIMIT) {
  process.stderr.write(
    `Warning: hit --limit ${PR_LIMIT} on all_open_prs. Some PRs may be silently truncated; ` +
      `next-run "resolved since last run" detection will misclassify the dropped tail. ` +
      `Switch to gh api graphql --paginate when this becomes a persistent issue.\n`,
  );
}

let reviewRequested: unknown[] = [];
let authoredByMe: unknown[] = [];
let issuesAssigned: unknown[] = [];

if (ghHandle) {
  reviewRequested = parseJson<unknown[]>(
    exec('gh', [
      'pr', 'list',
      '--search', `is:open is:pr review-requested:${ghHandle}`,
      '--json', 'number,title,author,createdAt,updatedAt',
    ]),
    [],
  );
  authoredByMe = parseJson<unknown[]>(
    exec('gh', [
      'pr', 'list',
      '--author', ghHandle,
      '--state', 'open',
      '--json', 'number,title,createdAt,updatedAt,reviewDecision,mergeStateStatus',
    ]),
    [],
  );
  issuesAssigned = parseJson<unknown[]>(
    exec('gh', [
      'issue', 'list',
      '--assignee', ghHandle,
      '--state', 'open',
      '--json', 'number,title,labels,createdAt,updatedAt,author',
    ]),
    [],
  );
}

// ── Recent unlabeled issues (last 7 days) ──
const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10);
const recentUnlabeledIssues = parseJson<unknown[]>(
  exec('gh', [
    'issue', 'list',
    '--state', 'open',
    '--search', `no:label created:>${sevenDaysAgoStr}`,
    '--json', 'number,title,createdAt,author',
    '--limit', '30',
  ]),
  [],
);

// ── Recently closed/merged since last run (or last 7 days as fallback) ──
const sinceDate = lastRunAt ? lastRunAt.slice(0, 10) : sevenDaysAgoStr;
const recentlyClosedPrs = parseJson<unknown[]>(
  exec('gh', [
    'pr', 'list',
    '--state', 'closed',
    '--search', `closed:>${sinceDate}`,
    '--json', 'number,title,author,closedAt,mergedAt,state',
    '--limit', '50',
  ]),
  [],
);
const recentlyClosedIssues = parseJson<unknown[]>(
  exec('gh', [
    'issue', 'list',
    '--state', 'closed',
    '--search', `closed:>${sinceDate}`,
    '--json', 'number,title,author,closedAt,state',
    '--limit', '50',
  ]),
  [],
);

// ── Maintainer's recent commits on dev (what you shipped) ──
let myRecentCommits = '';
if (ghHandle) {
  const since = lastRunAt || '7 days ago';
  try {
    myRecentCommits = execFileSync(
      'git',
      ['log', 'origin/dev', `--since=${since}`, `--author=${ghHandle}`, '--no-decorate', '--format=%h %s'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
  } catch {
    myRecentCommits = '';
  }
}

console.log(
  JSON.stringify({
    gh_handle: ghHandle,
    since_date: sinceDate,
    all_open_prs: allOpenPrs,
    review_requested: reviewRequested,
    authored_by_me: authoredByMe,
    issues_assigned: issuesAssigned,
    recent_unlabeled_issues: recentUnlabeledIssues,
    recently_closed_prs: recentlyClosedPrs,
    recently_closed_issues: recentlyClosedIssues,
    my_recent_commits: myRecentCommits,
  }),
);
