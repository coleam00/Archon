#!/usr/bin/env bun
/**
 * Read-side plumbing for repo-triage: fetches every GitHub list the triage
 * nodes need — open + recently-closed issues and PRs, a dedicated server-side
 * STALE slice, the issue/PR templates, the repo slug, and the bot's own login —
 * ONCE, at layer 0, so each judgment node reads a pre-fetched file instead of
 * running its own `gh issue list` / `gh pr list` (the token-heavy, duplicated
 * part of the old mega-prompts). One shared fetch also collapses N× identical
 * list calls across the parallel nodes.
 *
 * Fetch health is recorded, never swallowed: every gh failure (and an empty bot
 * login) is collected into `meta.fetchErrors`, and `meta.fetchOk` is false when
 * any occurred. Consumers MUST abort or flag on `fetchOk === false` rather than
 * treat a degraded fetch as a quiet day (an auth/rate-limit blip would otherwise
 * make the whole triage pass a silent no-op). `meta.capped` lists any fetch that
 * hit its `--limit` so partial coverage is visible in the digest too.
 *
 * Output layout — files under `$ARTIFACTS_DIR/gather/` (same file-based access
 * pattern the old prompts used with `$ARTIFACTS_DIR/*.json`, so nodes read them
 * lazily with the Read tool rather than inlining a huge blob into every prompt):
 *
 *   gather/issues-open.json     gather/issues-closed.json
 *   gather/prs-open.json        gather/prs-closed.json
 *   gather/issues-stale.json    gather/prs-stale.json
 *   gather/issue-templates.md   gather/pr-template.md
 *   gather/meta.json            { now, repoSlug, botLogin, cutoff90d, staleDays,
 *                                 staleCutoff, fetchOk, fetchErrors, capped, counts }
 *
 * A compact manifest (meta + counts + the gather dir path) is also printed to
 * stdout for run-log visibility.
 *
 * Deliberately does NOT read `.archon/state/*.json`: the triage-issues-persist
 * node writes triage-state.json (from triage-issues' emitted state) mid-run, and
 * closed-dedup-check must read that FRESH copy, which a layer-0 snapshot would
 * miss; and each node's corrupt-state ABORT guard must stay exactly where the
 * read happens. State WRITES go through repo-triage-persist (atomic temp+rename).
 * Per-PR diffs are also NOT fetched here — they are large and per-node selective
 * (link-prs / closed-pr-dedup fetch diffs only for the PRs they brief). See
 * repo-triage-block.yaml.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

interface FetchError {
  call: string;
  message: string;
}
const fetchErrors: FetchError[] = [];
const cappedLists: string[] = [];

// Single exec wrapper (used for both gh lists and gh scalar fields, and `date`).
// execFileSync with an argv array — no shell string, so nothing here is exposed
// to shell-quoting hazards. Returns stdout on success, null on failure, and
// records the failure so `meta.fetchOk` can reflect it.
function execOrNull(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    const call = `${file} ${args.join(' ')}`;
    const message = (e as Error).message;
    process.stderr.write(`${call} failed: ${message}\n`);
    fetchErrors.push({ call, message });
    return null;
  }
}

// Parse to an array or null. `gh ... --json` should always yield a JSON array;
// null covers both a parse failure and a wrong shape (e.g. gh exits 0 with an
// error object), so a `.length` access downstream can never crash the node.
function parseJsonArray(s: string | null): unknown[] | null {
  if (s === null) return null;
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// `gh {issue,pr} list --json` does NOT auto-paginate beyond --limit. These caps
// mirror the old prompts (issues 200, open PRs 100, closed windows 200); a hit
// is recorded in `meta.capped` and warned so the truncation is visible, not
// silently dropped from dedup/matching.
const ISSUE_LIMIT = 200;
const PR_OPEN_LIMIT = 100;
const CLOSED_WINDOW_LIMIT = 200;
const STALE_ISSUE_LIMIT = 200;
const STALE_PR_LIMIT = 100;

// Fetch a gh list; record a fetchError on gh failure OR non-array output, note a
// cap hit, and always return an array so the run continues. `meta.fetchOk`
// signals the degradation to consumers.
function fetchList(label: string, args: string[], limit: number): unknown[] {
  const raw = execOrNull('gh', args);
  const parsed = parseJsonArray(raw);
  if (parsed === null) {
    if (raw !== null) {
      // gh exited 0 but the output was not a JSON array (e.g. an error object).
      fetchErrors.push({ call: `gh ${args.join(' ')}`, message: `unexpected non-array output for ${label}` });
    }
    return [];
  }
  if (parsed.length >= limit) {
    cappedLists.push(label);
    process.stderr.write(
      `Warning: hit --limit ${limit} on ${label}. Some entries may be truncated; ` +
        `dedup/matching over the dropped tail will be incomplete. Switch to ` +
        `gh api graphql --paginate if this becomes persistent.\n`,
    );
  }
  return parsed;
}

// Scalar gh field (repo slug, bot login). A failure is recorded via execOrNull
// and returns '' — callers that need it for correctness (e.g. botLogin in the
// reconcile passes) must gate on meta.fetchOk / meta.botLogin.
function ghField(args: string[]): string {
  const raw = execOrNull('gh', args);
  return raw === null ? '' : raw.trim();
}

// N-day cutoff (BSD `date -v` first, GNU `date -d` fallback, JS last resort).
function cutoffDaysAgo(days: number): string {
  for (const args of [
    ['-u', `-v-${days}d`, '+%Y-%m-%d'],
    ['-u', '-d', `${days} days ago`, '+%Y-%m-%d'],
  ]) {
    try {
      const out = execFileSync('date', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      if (out) return out;
    } catch {
      // try next form
    }
  }
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const now = new Date().toISOString();
const repoSlug = ghField(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
const botLogin = ghField(['api', 'user', '--jq', '.login']);
const cutoff = cutoffDaysAgo(90);

// STALE_DAYS matches the stale-nudge node's window (default 60). The stale lists
// are fetched with a server-side `updated:<cutoff>` filter so they return the
// STALEST items regardless of total open count — the old node client-filtered
// the 200-capped open snapshot, so once open issues exceeded 200 the stalest
// items (the oldest tail) silently fell off.
const staleDaysRaw = Number.parseInt(process.env.STALE_DAYS ?? '', 10);
const staleDays = Number.isFinite(staleDaysRaw) && staleDaysRaw > 0 ? staleDaysRaw : 60;
const staleCutoff = cutoffDaysAgo(staleDays);

// ── Lists (field lists mirror the old prompts so downstream parsing is unchanged) ──
const openIssues = fetchList(
  'open issues',
  ['issue', 'list', '--state', 'open',
    '--json', 'number,title,body,author,labels,comments,createdAt,updatedAt',
    '--limit', String(ISSUE_LIMIT)],
  ISSUE_LIMIT,
);

const closedIssues = fetchList(
  'closed issues (90d)',
  ['issue', 'list', '--state', 'closed',
    '--json', 'number,title,body,labels,stateReason,closedAt',
    '--search', `closed:>${cutoff}`, '--limit', String(CLOSED_WINDOW_LIMIT)],
  CLOSED_WINDOW_LIMIT,
);

const openPrs = fetchList(
  'open PRs',
  ['pr', 'list', '--state', 'open',
    '--json', 'number,title,body,headRefName,updatedAt,author,isDraft,labels',
    '--limit', String(PR_OPEN_LIMIT)],
  PR_OPEN_LIMIT,
);

const closedPrs = fetchList(
  'closed PRs (90d)',
  ['pr', 'list', '--state', 'closed',
    '--json', 'number,title,body,state,closedAt,mergedAt',
    '--search', `closed:>${cutoff}`, '--limit', String(CLOSED_WINDOW_LIMIT)],
  CLOSED_WINDOW_LIMIT,
);

// Dedicated stale slices (server-side `updated:<staleCutoff>`), consumed by
// stale-nudge instead of client-filtering the capped open lists.
const staleIssues = fetchList(
  'stale issues',
  ['issue', 'list', '--state', 'open',
    '--json', 'number,title,author,updatedAt,labels',
    '--search', `updated:<${staleCutoff}`, '--limit', String(STALE_ISSUE_LIMIT)],
  STALE_ISSUE_LIMIT,
);

const stalePrs = fetchList(
  'stale PRs',
  ['pr', 'list', '--state', 'open',
    '--json', 'number,title,author,updatedAt,isDraft,labels',
    '--search', `updated:<${staleCutoff}`, '--limit', String(STALE_PR_LIMIT)],
  STALE_PR_LIMIT,
);

// An empty bot login is a correctness hazard for the reconcile passes (they
// distinguish the bot's own comments from human replies), so surface it as a
// fetch error even if the gh call itself exited 0 with empty output.
if (!botLogin) {
  fetchErrors.push({
    call: 'gh api user --jq .login',
    message: 'bot login unavailable — auto-close reconcile cannot distinguish the bot from human replies',
  });
}

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
  staleDays,
  staleCutoff,
  fetchOk: fetchErrors.length === 0,
  fetchErrors,
  capped: cappedLists,
  counts: {
    openIssues: openIssues.length,
    closedIssues: closedIssues.length,
    openPrs: openPrs.length,
    closedPrs: closedPrs.length,
    staleIssues: staleIssues.length,
    stalePrs: stalePrs.length,
  },
};

try {
  writeFileSync(join(gatherDir, 'issues-open.json'), JSON.stringify(openIssues));
  writeFileSync(join(gatherDir, 'issues-closed.json'), JSON.stringify(closedIssues));
  writeFileSync(join(gatherDir, 'prs-open.json'), JSON.stringify(openPrs));
  writeFileSync(join(gatherDir, 'prs-closed.json'), JSON.stringify(closedPrs));
  writeFileSync(join(gatherDir, 'issues-stale.json'), JSON.stringify(staleIssues));
  writeFileSync(join(gatherDir, 'prs-stale.json'), JSON.stringify(stalePrs));
  writeFileSync(join(gatherDir, 'issue-templates.md'), issueTemplates());
  writeFileSync(join(gatherDir, 'pr-template.md'), prTemplate());
  writeFileSync(join(gatherDir, 'meta.json'), JSON.stringify(meta, null, 2));
} catch (e) {
  process.stderr.write(`gather file write failed: ${(e as Error).message}\n`);
  process.exit(1);
}

// Manifest to stdout for run-log visibility (nodes read the files, not this).
console.log(JSON.stringify({ gatherDir, ...meta }));
