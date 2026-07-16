#!/usr/bin/env bun
/**
 * Read-side plumbing for repo-triage: fetches every GitHub list the triage
 * nodes need — open + recently-closed issues and PRs, the issue/PR templates,
 * the repo slug, and the bot's own login — ONCE, at layer 0, so each judgment
 * node reads a pre-fetched file instead of running its own `gh issue list` /
 * `gh pr list` (the token-heavy, duplicated part of the old mega-prompts). One
 * shared fetch also collapses N× identical list calls across the parallel nodes.
 *
 * Output layout — files under `$ARTIFACTS_DIR/gather/` (same file-based access
 * pattern the old prompts used with `$ARTIFACTS_DIR/*.json`, so nodes read them
 * lazily with the Read tool rather than inlining a huge blob into every prompt):
 *
 *   gather/issues-open.json     gather/issues-closed.json
 *   gather/prs-open.json        gather/prs-closed.json
 *   gather/issue-templates.md   gather/pr-template.md
 *   gather/meta.json            { now, repoSlug, botLogin, cutoff90d, counts }
 *
 * A compact manifest (meta + counts + the gather dir path) is also printed to
 * stdout for run-log visibility.
 *
 * Deliberately does NOT read `.archon/state/*.json`: triage-issues WRITES
 * triage-state.json mid-run and closed-dedup-check must read the FRESH copy,
 * which a layer-0 snapshot would miss; and each node's corrupt-state ABORT guard
 * must stay exactly where the write happens. State WRITES go through
 * repo-triage-persist (atomic temp+rename). Per-PR diffs are also NOT fetched
 * here — they are large and per-node selective (link-prs / closed-pr-dedup fetch
 * diffs only for the PRs they brief). See repo-triage-block.yaml.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// execFileSync with an argv array — no shell string, so nothing here is
// exposed to shell-quoting hazards.
function exec(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    process.stderr.write(
      `${file} command failed: ${file} ${args.join(' ')}\n${(e as Error).message}\n`,
    );
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

// `gh {issue,pr} list --json` does NOT auto-paginate beyond --limit. These caps
// mirror the old prompts (issues 200, open PRs 100, closed windows 200) and warn
// loudly if hit — a truncated list silently degrades dedup/matching.
const ISSUE_LIMIT = 200;
const PR_OPEN_LIMIT = 100;
const CLOSED_WINDOW_LIMIT = 200;

function warnIfCapped(rows: unknown[], limit: number, label: string): void {
  if (rows.length >= limit) {
    process.stderr.write(
      `Warning: hit --limit ${limit} on ${label}. Some entries may be truncated; ` +
        `dedup/matching over the dropped tail will be incomplete. Switch to ` +
        `gh api graphql --paginate if this becomes persistent.\n`,
    );
  }
}

function ghField(args: string[]): string {
  try {
    return execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (e) {
    process.stderr.write(`gh ${args.join(' ')} failed: ${(e as Error).message}\n`);
    return '';
  }
}

// ── 90-day cutoff (BSD `date -v` first, GNU `date -d` fallback, JS last resort) ──
function cutoff90d(): string {
  for (const args of [
    ['-u', '-v-90d', '+%Y-%m-%d'],
    ['-u', '-d', '90 days ago', '+%Y-%m-%d'],
  ]) {
    try {
      const out = execFileSync('date', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      if (out) return out;
    } catch {
      // try next form
    }
  }
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
}

const now = new Date().toISOString();
const repoSlug = ghField(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
const botLogin = ghField(['api', 'user', '--jq', '.login']);
const cutoff = cutoff90d();

// ── Lists (field lists mirror the old prompts so downstream parsing is unchanged) ──
const openIssues = parseJson<unknown[]>(
  exec('gh', ['issue', 'list', '--state', 'open',
    '--json', 'number,title,body,author,labels,comments,createdAt,updatedAt',
    '--limit', String(ISSUE_LIMIT)]),
  [],
);
warnIfCapped(openIssues, ISSUE_LIMIT, 'open issues');

const closedIssues = parseJson<unknown[]>(
  exec('gh', ['issue', 'list', '--state', 'closed',
    '--json', 'number,title,body,labels,stateReason,closedAt',
    '--search', `closed:>${cutoff}`, '--limit', String(CLOSED_WINDOW_LIMIT)]),
  [],
);
warnIfCapped(closedIssues, CLOSED_WINDOW_LIMIT, 'closed issues (90d)');

const openPrs = parseJson<unknown[]>(
  exec('gh', ['pr', 'list', '--state', 'open',
    '--json', 'number,title,body,headRefName,updatedAt,author,isDraft,labels',
    '--limit', String(PR_OPEN_LIMIT)]),
  [],
);
warnIfCapped(openPrs, PR_OPEN_LIMIT, 'open PRs');

const closedPrs = parseJson<unknown[]>(
  exec('gh', ['pr', 'list', '--state', 'closed',
    '--json', 'number,title,body,state,closedAt,mergedAt',
    '--search', `closed:>${cutoff}`, '--limit', String(CLOSED_WINDOW_LIMIT)]),
  [],
);
warnIfCapped(closedPrs, CLOSED_WINDOW_LIMIT, 'closed PRs (90d)');

// ── Templates (same concatenated shape the old prompts built inline) ──
function issueTemplates(): string {
  const dir = resolve(process.cwd(), '.github/ISSUE_TEMPLATE');
  if (!existsSync(dir)) return '';
  let out = '';
  try {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      out += `### ${name}\n\`\`\`\n${readFileSync(join(dir, name), 'utf8')}\n\`\`\`\n\n`;
    }
  } catch (e) {
    process.stderr.write(`issue-template read failed: ${(e as Error).message}\n`);
  }
  return out;
}

function prTemplate(): string {
  for (const p of ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md']) {
    const full = resolve(process.cwd(), p);
    if (existsSync(full)) {
      try {
        return readFileSync(full, 'utf8');
      } catch (e) {
        process.stderr.write(`pr-template read failed: ${(e as Error).message}\n`);
        return '';
      }
    }
  }
  return '';
}

// ── Write files under $ARTIFACTS_DIR/gather/ (fallback to .archon/state/gather when unset) ──
const artifactsBase = process.env.ARTIFACTS_DIR || resolve(process.cwd(), '.archon/state');
const gatherDir = join(artifactsBase, 'gather');
mkdirSync(gatherDir, { recursive: true });

const meta = {
  now,
  repoSlug,
  botLogin,
  cutoff90d: cutoff,
  counts: {
    openIssues: openIssues.length,
    closedIssues: closedIssues.length,
    openPrs: openPrs.length,
    closedPrs: closedPrs.length,
  },
};

try {
  writeFileSync(join(gatherDir, 'issues-open.json'), JSON.stringify(openIssues));
  writeFileSync(join(gatherDir, 'issues-closed.json'), JSON.stringify(closedIssues));
  writeFileSync(join(gatherDir, 'prs-open.json'), JSON.stringify(openPrs));
  writeFileSync(join(gatherDir, 'prs-closed.json'), JSON.stringify(closedPrs));
  writeFileSync(join(gatherDir, 'issue-templates.md'), issueTemplates());
  writeFileSync(join(gatherDir, 'pr-template.md'), prTemplate());
  writeFileSync(join(gatherDir, 'meta.json'), JSON.stringify(meta, null, 2));
} catch (e) {
  process.stderr.write(`gather file write failed: ${(e as Error).message}\n`);
  process.exit(1);
}

// Manifest to stdout for run-log visibility (nodes read the files, not this).
console.log(JSON.stringify({ gatherDir, ...meta }));
