#!/usr/bin/env bun
/**
 * One-shot: scan the maintainer's recent GitHub comments and populate
 * .archon/maintainer-standup/reviewed-prs.json with `{ reviewed_at,
 * gate_verdict, run_id }` entries inferred from comment-body patterns.
 *
 * Use case: after adopting the cross-workflow memory feature, today's
 * morning brief should already mark "✓ reviewed Nd ago" for the PRs that
 * were reviewed before the writer node existed. Without backfill, those
 * markers only appear for runs going forward.
 *
 * Inference patterns (from the maintainer-review-pr output):
 *  - Body contains "## Review Summary"           → gate_verdict: review
 *  - Body contains "isn't a direction we're"     → gate_verdict: decline
 *    OR "Conflicts with `direction.md"
 *  - Body contains "Could you split this"        → gate_verdict: needs_split
 *    OR "split into <N> focused PRs"
 *
 * Behavior:
 *  - Fetches the maintainer's comments authored in the last 7 days.
 *  - Per PR, takes the LATEST matching comment (newer comments win).
 *  - Existing entries (from real workflow runs) take precedence over
 *    backfilled ones — the writer-node record is more authoritative.
 *  - Idempotent: re-running adds nothing new if no new pattern-matching
 *    comments have been authored since.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type GhComment = {
  user?: { login?: string };
  created_at?: string;
  body?: string;
  issue_url?: string;
};

type ReviewedEntry = {
  reviewed_at: string;
  gate_verdict: 'review' | 'decline' | 'needs_split' | 'unclear';
  run_id?: string;
  source?: 'workflow' | 'backfill';
};

const baseDir = resolve(process.cwd(), '.archon/maintainer-standup');

// ── Read gh handle from profile ──
const profilePath = resolve(baseDir, 'profile.md');
if (!existsSync(profilePath)) {
  console.error('No profile.md found — run from repo root, with .archon/maintainer-standup/profile.md present.');
  process.exit(1);
}
const ghHandleMatch = readFileSync(profilePath, 'utf8').match(/^gh_handle:\s*(\S+)/m);
if (!ghHandleMatch) {
  console.error('No gh_handle in profile.md frontmatter');
  process.exit(1);
}
const ghHandle = ghHandleMatch[1];

// ── Resolve owner/repo from the origin remote ──
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
  .toString()
  .trim();
const repoMatch = remote.match(/[:/]([^:/]+)\/([^/]+?)(?:\.git)?$/);
if (!repoMatch) {
  console.error(`Could not parse owner/repo from origin remote: ${remote}`);
  process.exit(1);
}
const [, owner, repo] = repoMatch;

// ── Fetch issue/PR conversation comments since 7 days ago ──
const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
const since = sevenDaysAgo.toISOString();

console.log(`Scanning ${ghHandle}'s comments on ${owner}/${repo} since ${since}...`);

// Default maxBuffer is 1MB which 7 days of paginated comments easily exceeds
// in an active repo (1k+ comments → multi-MB JSON). 64MB is generous and
// well below available memory; if the repo grows past that, switch to
// streaming the gh process and parsing line-by-line.
const allComments = JSON.parse(
  execFileSync(
    'gh',
    [
      'api',
      `repos/${owner}/${repo}/issues/comments?since=${since}&per_page=100`,
      '--paginate',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  ).toString(),
) as GhComment[];

// ── Pattern-match the maintainer's own review/decline comments ──
function inferVerdict(body: string): ReviewedEntry['gate_verdict'] | null {
  if (body.includes('## Review Summary')) return 'review';
  if (
    body.includes("isn't a direction we're") ||
    body.includes('Conflicts with `direction.md') ||
    body.includes('direction.md §')
  )
    return 'decline';
  if (
    body.includes('Could you split this') ||
    body.includes('Could you two coordinate') ||
    /split into \d+ focused PRs/.test(body)
  )
    return 'needs_split';
  return null;
}

function extractPrNumber(issueUrl: string | undefined): string | null {
  if (!issueUrl) return null;
  const m = issueUrl.match(/\/(\d+)$/);
  return m ? m[1] : null;
}

const inferred: Record<string, ReviewedEntry> = {};
let scanned = 0;
let mineMatching = 0;

for (const c of allComments) {
  scanned++;
  const author = c.user?.login;
  if (!author || author.toLowerCase() !== ghHandle.toLowerCase()) continue;
  const body = c.body ?? '';
  const verdict = inferVerdict(body);
  if (!verdict) continue;
  const prNumber = extractPrNumber(c.issue_url);
  if (!prNumber) continue;
  const createdAt = c.created_at ?? '';
  // Latest comment per PR wins (newer reviews supersede older).
  if (!inferred[prNumber] || createdAt > inferred[prNumber].reviewed_at) {
    inferred[prNumber] = {
      reviewed_at: createdAt,
      gate_verdict: verdict,
      source: 'backfill',
    };
  }
  mineMatching++;
}

console.log(
  `Scanned ${scanned} comments. ${mineMatching} authored by ${ghHandle} matched a review/decline pattern. Unique PRs: ${Object.keys(inferred).length}.`,
);

// ── Merge with existing reviewed-prs.json ──
// Existing entries (especially those without source: 'backfill', i.e. written
// by the workflow's record-review node) take precedence — they're more
// authoritative than pattern-matched bodies.
if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
const outPath = resolve(baseDir, 'reviewed-prs.json');
let existing: Record<string, ReviewedEntry> = {};
if (existsSync(outPath)) {
  try {
    existing = JSON.parse(readFileSync(outPath, 'utf8'));
  } catch {
    existing = {};
  }
}

let added = 0;
let skipped = 0;
for (const [num, entry] of Object.entries(inferred)) {
  if (existing[num]) {
    skipped++;
    continue;
  }
  existing[num] = entry;
  added++;
}

writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n');

console.log(
  `Backfilled ${added} new entries (skipped ${skipped} that already had workflow-recorded entries). Total tracked: ${Object.keys(existing).length}.`,
);
console.log(`Written to: ${outPath}`);
