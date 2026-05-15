#!/usr/bin/env bun
/**
 * forge-cli.ts — Forge-agnostic CLI wrapper for GitHub, Gitea, and GitLab
 *
 * Routes pr/issue/label/repo commands to the appropriate forge API.
 * Reads FORGE_TYPE, FORGE_API_BASE, and token env vars set by the workflow executor.
 *
 * Usage: forge-cli.ts <resource> <action> [args...]
 *   Resources: pr, issue, label, repo
 *
 * For GitHub, delegates to `gh` CLI. For Gitea/GitLab, uses fetch() against their REST APIs.
 * No external dependencies beyond Bun.
 */

import { execFileSync } from 'child_process';

const FORGE_TYPE = process.env.FORGE_TYPE ?? 'github';
const FORGE_API_BASE = (process.env.FORGE_API_BASE ?? 'https://api.github.com').replace(/\/+$/, '');
const GITEA_TOKEN = process.env.GITEA_TOKEN ?? '';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN ?? '';
const GH_TOKEN = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

// ─── Helpers ───────────────────────────────────────────────────────────────

function getOwnerRepo(): string {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const cleaned = url.replace(/\.git$/, '');

    // SSH protocol URL: ssh://git@host:port/owner/repo or ssh://git@host/owner/repo
    const sshProtoMatch = cleaned.match(/ssh:\/\/[^@]+@[^/]+(\/.*)/);
    if (sshProtoMatch) return sshProtoMatch[1].replace(/^\//, '');

    // HTTPS: https://host/owner/repo or https://token@host/owner/repo
    const httpsMatch = cleaned.match(/https?:\/\/(?:[^@]+@)?[^/]+\/(.+)/);
    if (httpsMatch) return httpsMatch[1];

    // SSH shorthand: git@host:owner/repo
    const sshMatch = cleaned.match(/@[^:]+:(.+)/);
    if (sshMatch) return sshMatch[1];

    throw new Error(`Cannot parse owner/repo from: ${url}`);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}

function authHeaders(): Record<string, string> {
  switch (FORGE_TYPE) {
    case 'github':
      return { Authorization: `token ${GH_TOKEN}` };
    case 'gitea':
      return { Authorization: `token ${GITEA_TOKEN}` };
    case 'gitlab':
      return { 'PRIVATE-TOKEN': GITLAB_TOKEN };
    default:
      console.error(`error: unsupported FORGE_TYPE=${FORGE_TYPE}`);
      process.exit(1);
  }
}

async function apiGet(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPost(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPatch(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

/** Run gh CLI and return stdout */
function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8' });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    // execFileSync includes verbose stderr; extract the useful line
    const stderr = (err.stderr ?? '').trim();
    const firstLine = stderr.split('\n')[0] || err.message || 'gh command failed';
    throw new Error(`gh ${args.join(' ')}: ${firstLine}`);
  }
}

/** Get GitLab project ID from owner/repo path */
async function gitlabProjectId(ownerRepo: string): Promise<string> {
  const encoded = encodeURIComponent(ownerRepo);
  const data = (await apiGet(`${FORGE_API_BASE}/projects/${encoded}`)) as { id: number };
  return String(data.id);
}

/** Parse CLI args into a map */
function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith('--')) {
      const key = args[i];
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(args[i]);
      i += 1;
    }
  }
  return { positional, flags };
}

// ─── Field Normalization ───────────────────────────────────────────────────
// Maps Gitea/GitLab API responses to GitHub-style field names for consistency.
// When --json is specified, only the requested fields are emitted.

type AnyRecord = Record<string, unknown>;

/** Normalize a Gitea PR to GitHub-style fields */
function normalizeGiteaPr(raw: AnyRecord): AnyRecord {
  const user = raw.user as AnyRecord | undefined;
  const head = raw.head as AnyRecord | undefined;
  const base = raw.base as AnyRecord | undefined;
  const labels = raw.labels as AnyRecord[] | undefined;
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    url: raw.html_url ?? raw.url,
    headRefName: head?.ref ?? raw.head_branch,
    baseRefName: base?.ref ?? raw.base_branch,
    state: raw.state,
    isDraft: raw.draft ?? false,
    author: { login: user?.login ?? '' },
    labels: (labels ?? []).map((l) => ({ name: l.name })),
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changed_files,
    files: raw.changed_files_list, // Gitea may not provide per-file details in PR view
    comments: raw.comments,
    mergeable: raw.mergeable,
  };
}

/** Normalize a GitLab MR to GitHub-style fields */
function normalizeGitlabMr(raw: AnyRecord): AnyRecord {
  const author = raw.author as AnyRecord | undefined;
  const labels = raw.labels as string[] | undefined;
  return {
    number: raw.iid,
    title: raw.title,
    body: raw.description,
    url: raw.web_url,
    headRefName: raw.source_branch,
    baseRefName: raw.target_branch,
    state: raw.state === 'opened' ? 'open' : raw.state,
    isDraft: raw.draft ?? (raw.title as string)?.startsWith('Draft:') ?? false,
    author: { login: author?.username ?? '' },
    labels: (labels ?? []).map((name) => ({ name })),
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changes_count,
    comments: raw.user_notes_count,
    mergeable: raw.merge_status === 'can_be_merged',
  };
}

/** Normalize a Gitea issue to GitHub-style fields */
function normalizeGiteaIssue(raw: AnyRecord): AnyRecord {
  const user = raw.user as AnyRecord | undefined;
  const labels = raw.labels as AnyRecord[] | undefined;
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body,
    url: raw.html_url ?? raw.url,
    state: raw.state,
    author: { login: user?.login ?? '' },
    labels: (labels ?? []).map((l) => ({ name: l.name })),
    comments: raw.comments,
  };
}

/** Normalize a GitLab issue to GitHub-style fields */
function normalizeGitlabIssue(raw: AnyRecord): AnyRecord {
  const author = raw.author as AnyRecord | undefined;
  const labels = raw.labels as string[] | undefined;
  return {
    number: raw.iid,
    title: raw.title,
    body: raw.description,
    url: raw.web_url,
    state: raw.state === 'opened' ? 'open' : raw.state,
    author: { login: author?.username ?? '' },
    labels: (labels ?? []).map((name) => ({ name })),
    comments: raw.user_notes_count,
  };
}

/** Filter an object to only include the requested JSON fields */
function filterFields(obj: AnyRecord, jsonFields: string | undefined): AnyRecord {
  if (!jsonFields) return obj;
  const fields = jsonFields.split(',').map((f) => f.trim());
  const result: AnyRecord = {};
  for (const field of fields) {
    if (field in obj) result[field] = obj[field];
  }
  return result;
}

/** Normalize + filter, then output */
function outputNormalized(
  raw: unknown,
  normalize: (_r: AnyRecord) => AnyRecord,
  jsonFields: string | undefined
): void {
  if (Array.isArray(raw)) {
    const items = raw.map((item) => filterFields(normalize(item as AnyRecord), jsonFields));
    console.log(JSON.stringify(items, null, 2));
  } else {
    const normalized = filterFields(normalize(raw as AnyRecord), jsonFields);
    console.log(JSON.stringify(normalized, null, 2));
  }
}

// ─── PR / Merge Request ────────────────────────────────────────────────────

async function prView(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const number = positional[0];
  if (!number) { console.error('error: pr view requires a number'); process.exit(1); }
  const ownerRepo = getOwnerRepo();
  const jsonFields = flags['--json'] as string | undefined;

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['pr', 'view', number];
      if (jsonFields) ghArgs.push('--json', jsonFields);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      const data = await apiGet(`${FORGE_API_BASE}/repos/${ownerRepo}/pulls/${number}`);
      outputNormalized(data, normalizeGiteaPr, jsonFields);
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiGet(`${FORGE_API_BASE}/projects/${pid}/merge_requests/${number}`);
      outputNormalized(data, normalizeGitlabMr, jsonFields);
      break;
    }
  }
}

async function prCreate(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const title = flags['--title'] as string ?? '';
  const body = flags['--body'] as string ?? '';
  const base = flags['--base'] as string ?? '';
  const draft = flags['--draft'] === true;
  const ownerRepo = getOwnerRepo();
  const head = (flags['--head'] as string | undefined)
    ?? execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['pr', 'create', '--title', title, '--body', body];
      if (base) ghArgs.push('--base', base);
      if (flags['--head']) ghArgs.push('--head', head);
      if (draft) ghArgs.push('--draft');
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      const data = await apiPost(`${FORGE_API_BASE}/repos/${ownerRepo}/pulls`, {
        title, body, head, base,
      });
      outputNormalized(data, normalizeGiteaPr, undefined);
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      // GitLab doesn't accept 'draft' as an input param — use title prefix instead
      const gitlabTitle = draft ? `Draft: ${title}` : title;
      const data = await apiPost(`${FORGE_API_BASE}/projects/${pid}/merge_requests`, {
        title: gitlabTitle, description: body, source_branch: head, target_branch: base,
      });
      outputNormalized(data, normalizeGitlabMr, undefined);
      break;
    }
  }
}

async function prComment(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const number = positional[0];
  if (!number) { console.error('error: pr comment requires a number'); process.exit(1); }
  const body = flags['--body'] as string ?? '';
  const ownerRepo = getOwnerRepo();

  switch (FORGE_TYPE) {
    case 'github':
      console.log(gh(['pr', 'comment', number, '--body', body]));
      break;
    case 'gitea': {
      // Gitea uses the issues endpoint for PR comments
      const data = await apiPost(
        `${FORGE_API_BASE}/repos/${ownerRepo}/issues/${number}/comments`,
        { body },
      );
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiPost(
        `${FORGE_API_BASE}/projects/${pid}/merge_requests/${number}/notes`,
        { body },
      );
      console.log(JSON.stringify(data, null, 2));
      break;
    }
  }
}

async function prList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const head = flags['--head'] as string | undefined;
  const ownerRepo = getOwnerRepo();
  const jsonFields = flags['--json'] as string | undefined;

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['pr', 'list'];
      if (head) ghArgs.push('--head', head);
      if (jsonFields) ghArgs.push('--json', jsonFields);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      let url = `${FORGE_API_BASE}/repos/${ownerRepo}/pulls?state=open`;
      if (head) url += `&head=${ownerRepo.split('/')[0]}:${head}`;
      const data = await apiGet(url);
      outputNormalized(data, normalizeGiteaPr, jsonFields);
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      let url = `${FORGE_API_BASE}/projects/${pid}/merge_requests?state=opened`;
      if (head) url += `&source_branch=${head}`;
      const data = await apiGet(url);
      outputNormalized(data, normalizeGitlabMr, jsonFields);
      break;
    }
  }
}

async function prDiff(args: string[]): Promise<void> {
  const number = args[0];
  if (!number) { console.error('error: pr diff requires a number'); process.exit(1); }
  const ownerRepo = getOwnerRepo();

  switch (FORGE_TYPE) {
    case 'github':
      console.log(gh(['pr', 'diff', number]));
      break;
    case 'gitea': {
      const res = await fetch(`${FORGE_API_BASE}/repos/${ownerRepo}/pulls/${number}.diff`, {
        headers: { ...authHeaders(), Accept: 'text/plain' },
      });
      if (!res.ok) {
        throw new Error(`API ${res.status}: ${await res.text()}`);
      }
      console.log(await res.text());
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      // Use raw_diffs endpoint (GitLab 17+) for the actual MR diff,
      // rather than repository/compare which drifts as branches move
      const res = await fetch(
        `${FORGE_API_BASE}/projects/${pid}/merge_requests/${number}/raw_diffs`,
        { headers: { ...authHeaders(), Accept: 'text/plain' } },
      );
      if (!res.ok) {
        throw new Error(`API ${res.status}: ${await res.text()}`);
      }
      console.log(await res.text());
      break;
    }
  }
}

async function prEdit(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const number = positional[0];
  if (!number) { console.error('error: pr edit requires a number'); process.exit(1); }
  const ownerRepo = getOwnerRepo();
  const body = flags['--body'] as string | undefined;
  const title = flags['--title'] as string | undefined;

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['pr', 'edit', number];
      if (body) ghArgs.push('--body', body);
      if (title) ghArgs.push('--title', title);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      const patch: Record<string, string> = {};
      if (body) patch.body = body;
      if (title) patch.title = title;
      const data = await apiPatch(`${FORGE_API_BASE}/repos/${ownerRepo}/pulls/${number}`, patch);
      outputNormalized(data, normalizeGiteaPr, undefined);
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const patch: Record<string, string> = {};
      if (body) patch.description = body;
      if (title) patch.title = title;
      const res = await fetch(`${FORGE_API_BASE}/projects/${pid}/merge_requests/${number}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text}`);
      }
      outputNormalized(await res.json(), normalizeGitlabMr, undefined);
      break;
    }
  }
}

async function prReady(args: string[]): Promise<void> {
  const number = args[0];
  if (!number) { console.error('error: pr ready requires a number'); process.exit(1); }
  const ownerRepo = getOwnerRepo();

  switch (FORGE_TYPE) {
    case 'github':
      console.log(gh(['pr', 'ready', number]));
      break;
    case 'gitea': {
      // Gitea doesn't have a native draft concept — no-op
      console.log('Gitea does not support draft PRs — no action needed.');
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      // Remove "Draft: " prefix from title to mark as ready
      const mr = (await apiGet(
        `${FORGE_API_BASE}/projects/${pid}/merge_requests/${number}`,
      )) as { title: string };
      const newTitle = mr.title.replace(/^Draft:\s*/i, '');
      const res = await fetch(`${FORGE_API_BASE}/projects/${pid}/merge_requests/${number}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text}`);
      }
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }
  }
}

async function prChecks(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const number = positional[0];
  if (!number) { console.error('error: pr checks requires a number'); process.exit(1); }
  const ownerRepo = getOwnerRepo();

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['pr', 'checks', number];
      if (flags['--json']) ghArgs.push('--json', flags['--json'] as string);
      if (flags['--jq']) ghArgs.push('--jq', flags['--jq'] as string);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      // Gitea: get commit statuses for the PR's head SHA
      const pr = (await apiGet(
        `${FORGE_API_BASE}/repos/${ownerRepo}/pulls/${number}`,
      )) as { head: { sha: string } };
      const statuses = await apiGet(
        `${FORGE_API_BASE}/repos/${ownerRepo}/statuses/${pr.head.sha}`,
      );
      console.log(JSON.stringify(statuses, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const mr = (await apiGet(
        `${FORGE_API_BASE}/projects/${pid}/merge_requests/${number}`,
      )) as { sha: string };
      const pipelines = await apiGet(
        `${FORGE_API_BASE}/projects/${pid}/repository/commits/${mr.sha}/statuses`,
      );
      console.log(JSON.stringify(pipelines, null, 2));
      break;
    }
  }
}

// ─── Issue ──────────────────────────────────────────────────────────────────

async function issueView(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const number = positional[0];
  if (!number) { console.error('error: issue view requires a number'); process.exit(1); }
  const ownerRepo = getOwnerRepo();
  const jsonFields = flags['--json'] as string | undefined;

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['issue', 'view', number];
      if (jsonFields) ghArgs.push('--json', jsonFields);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      const data = await apiGet(`${FORGE_API_BASE}/repos/${ownerRepo}/issues/${number}`);
      outputNormalized(data, normalizeGiteaIssue, jsonFields);
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiGet(`${FORGE_API_BASE}/projects/${pid}/issues/${number}`);
      outputNormalized(data, normalizeGitlabIssue, jsonFields);
      break;
    }
  }
}

async function issueCreate(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const title = flags['--title'] as string ?? '';
  const body = flags['--body'] as string ?? '';
  const ownerRepo = getOwnerRepo();

  // Collect --label flags (can appear multiple times)
  const labels: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--label' && args[i + 1]) labels.push(args[i + 1]);
  }

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['issue', 'create', '--title', title, '--body', body];
      for (const l of labels) ghArgs.push('--label', l);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      // Gitea uses label IDs — resolve from names
      let labelIds: number[] = [];
      if (labels.length > 0) {
        const allLabels = (await apiGet(
          `${FORGE_API_BASE}/repos/${ownerRepo}/labels`,
        )) as { id: number; name: string }[];
        labelIds = labels
          .map((name) => allLabels.find((l) => l.name === name)?.id)
          .filter((id): id is number => id !== undefined);
      }
      const data = await apiPost(`${FORGE_API_BASE}/repos/${ownerRepo}/issues`, {
        title, body, labels: labelIds,
      });
      outputNormalized(data, normalizeGiteaIssue, undefined);
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiPost(`${FORGE_API_BASE}/projects/${pid}/issues`, {
        title, description: body, labels: labels.join(','),
      });
      outputNormalized(data, normalizeGitlabIssue, undefined);
      break;
    }
  }
}

async function issueComment(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const number = positional[0];
  if (!number) { console.error('error: issue comment requires a number'); process.exit(1); }
  const body = flags['--body'] as string ?? '';
  const ownerRepo = getOwnerRepo();

  switch (FORGE_TYPE) {
    case 'github':
      console.log(gh(['issue', 'comment', number, '--body', body]));
      break;
    case 'gitea': {
      const data = await apiPost(
        `${FORGE_API_BASE}/repos/${ownerRepo}/issues/${number}/comments`,
        { body },
      );
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiPost(
        `${FORGE_API_BASE}/projects/${pid}/issues/${number}/notes`,
        { body },
      );
      console.log(JSON.stringify(data, null, 2));
      break;
    }
  }
}

async function issueList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const search = flags['--search'] as string | undefined;
  const state = (flags['--state'] as string) ?? 'open';
  const ownerRepo = getOwnerRepo();
  const jsonFields = flags['--json'] as string | undefined;

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['issue', 'list', '--state', state];
      if (search) ghArgs.push('--search', search);
      if (jsonFields) ghArgs.push('--json', jsonFields);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      let url = `${FORGE_API_BASE}/repos/${ownerRepo}/issues?state=${state}&type=issues`;
      if (search) url += `&q=${encodeURIComponent(search)}`;
      const data = await apiGet(url);
      outputNormalized(data, normalizeGiteaIssue, jsonFields);
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const glState = state === 'open' ? 'opened' : state;
      let url = `${FORGE_API_BASE}/projects/${pid}/issues?state=${glState}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      const data = await apiGet(url);
      outputNormalized(data, normalizeGitlabIssue, jsonFields);
      break;
    }
  }
}

// ─── Labels ─────────────────────────────────────────────────────────────────

async function labelList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const ownerRepo = getOwnerRepo();
  const jsonFields = flags['--json'] as string | undefined;

  const normalizeLabel = (raw: AnyRecord): AnyRecord => ({
    name: raw.name,
    color: raw.color,
    description: raw.description,
  });

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['label', 'list'];
      if (jsonFields) ghArgs.push('--json', jsonFields);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      const data = await apiGet(`${FORGE_API_BASE}/repos/${ownerRepo}/labels`);
      outputNormalized(data, normalizeLabel, jsonFields);
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiGet(`${FORGE_API_BASE}/projects/${pid}/labels`);
      outputNormalized(data, normalizeLabel, jsonFields);
      break;
    }
  }
}

// ─── Repo ───────────────────────────────────────────────────────────────────

async function repoInfo(): Promise<void> {
  const ownerRepo = getOwnerRepo();

  switch (FORGE_TYPE) {
    case 'github':
      console.log(gh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']));
      break;
    case 'gitea': {
      const data = (await apiGet(`${FORGE_API_BASE}/repos/${ownerRepo}`)) as {
        full_name: string;
        default_branch: string;
      };
      console.log(JSON.stringify({
        nameWithOwner: data.full_name,
        defaultBranch: data.default_branch,
      }, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = (await apiGet(`${FORGE_API_BASE}/projects/${pid}`)) as {
        path_with_namespace: string;
        default_branch: string;
      };
      console.log(JSON.stringify({
        nameWithOwner: data.path_with_namespace,
        defaultBranch: data.default_branch,
      }, null, 2));
      break;
    }
  }
}

// ─── Main Dispatch ──────────────────────────────────────────────────────────

const [resource, action, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  try {
    switch (resource) {
      case 'pr':
        switch (action) {
          case 'view':    await prView(rest); break;
          case 'create':  await prCreate(rest); break;
          case 'comment': await prComment(rest); break;
          case 'list':    await prList(rest); break;
          case 'diff':    await prDiff(rest); break;
          case 'edit':    await prEdit(rest); break;
          case 'ready':   await prReady(rest); break;
          case 'checks':  await prChecks(rest); break;
          default:
            console.error(`error: unknown pr action: ${action}`);
            console.error('Usage: forge-cli.ts pr {view|create|comment|list|diff|edit|ready|checks} [args...]');
            process.exit(1);
        }
        break;
      case 'issue':
        switch (action) {
          case 'view':    await issueView(rest); break;
          case 'create':  await issueCreate(rest); break;
          case 'comment': await issueComment(rest); break;
          case 'list':    await issueList(rest); break;
          default:
            console.error(`error: unknown issue action: ${action}`);
            console.error('Usage: forge-cli.ts issue {view|create|comment|list} [args...]');
            process.exit(1);
        }
        break;
      case 'label':
        if (action === 'list') await labelList(rest);
        else { console.error(`error: unknown label action: ${action}`); process.exit(1); }
        break;
      case 'repo':
        if (action === 'info') await repoInfo();
        else { console.error(`error: unknown repo action: ${action}`); process.exit(1); }
        break;
      default:
        console.error('forge-cli.ts — Forge-agnostic CLI for GitHub, Gitea, and GitLab');
        console.error('');
        console.error('Usage: forge-cli.ts <resource> <action> [args...]');
        console.error('');
        console.error('Resources:');
        console.error('  pr      {view|create|comment|list|diff|edit|ready|checks}');
        console.error('  issue   {view|create|comment|list}');
        console.error('  label   {list}');
        console.error('  repo    {info}');
        console.error('');
        console.error('Environment:');
        console.error('  FORGE_TYPE      github|gitea|gitlab (default: github)');
        console.error('  FORGE_API_BASE  API base URL');
        console.error('  GITEA_TOKEN     Gitea API token (when FORGE_TYPE=gitea)');
        console.error('  GITLAB_TOKEN    GitLab API token (when FORGE_TYPE=gitlab)');
        console.error('  GH_TOKEN        GitHub token (when FORGE_TYPE=github)');
        process.exit(1);
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}

await main();
