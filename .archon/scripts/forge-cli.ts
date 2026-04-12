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

    // HTTPS: https://host/owner/repo or https://token@host/owner/repo
    const httpsMatch = cleaned.match(/https?:\/\/(?:[^@]+@)?[^/]+\/(.+)/);
    if (httpsMatch) return httpsMatch[1];

    // SSH: git@host:owner/repo
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
  return execFileSync('gh', args, { encoding: 'utf8' });
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

// ─── PR / Merge Request ────────────────────────────────────────────────────

async function prView(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const number = positional[0];
  if (!number) { console.error('error: pr view requires a number'); process.exit(1); }
  const ownerRepo = getOwnerRepo();

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['pr', 'view', number];
      if (flags['--json']) ghArgs.push('--json', flags['--json'] as string);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      const data = await apiGet(`${FORGE_API_BASE}/repos/${ownerRepo}/pulls/${number}`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiGet(`${FORGE_API_BASE}/projects/${pid}/merge_requests/${number}`);
      console.log(JSON.stringify(data, null, 2));
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
  const head = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['pr', 'create', '--title', title, '--body', body];
      if (base) ghArgs.push('--base', base);
      if (draft) ghArgs.push('--draft');
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      const data = await apiPost(`${FORGE_API_BASE}/repos/${ownerRepo}/pulls`, {
        title, body, head, base,
      });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiPost(`${FORGE_API_BASE}/projects/${pid}/merge_requests`, {
        title, description: body, source_branch: head, target_branch: base, draft,
      });
      console.log(JSON.stringify(data, null, 2));
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

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['pr', 'list'];
      if (head) ghArgs.push('--head', head);
      if (flags['--json']) ghArgs.push('--json', 'number,url,headRefName,state');
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      let url = `${FORGE_API_BASE}/repos/${ownerRepo}/pulls?state=open`;
      if (head) url += `&head=${ownerRepo.split('/')[0]}:${head}`;
      const data = await apiGet(url);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      let url = `${FORGE_API_BASE}/projects/${pid}/merge_requests?state=opened`;
      if (head) url += `&source_branch=${head}`;
      const data = await apiGet(url);
      console.log(JSON.stringify(data, null, 2));
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
      console.log(await res.text());
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const mr = (await apiGet(
        `${FORGE_API_BASE}/projects/${pid}/merge_requests/${number}`,
      )) as { source_branch: string; target_branch: string };
      const compare = (await apiGet(
        `${FORGE_API_BASE}/projects/${pid}/repository/compare?from=${mr.target_branch}&to=${mr.source_branch}`,
      )) as { diffs: Array<{ old_path: string; new_path: string; diff: string }> };
      for (const d of compare.diffs) {
        console.log(`diff --git a/${d.old_path} b/${d.new_path}\n${d.diff}`);
      }
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

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['issue', 'view', number];
      if (flags['--json']) ghArgs.push('--json', flags['--json'] as string);
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      const data = await apiGet(`${FORGE_API_BASE}/repos/${ownerRepo}/issues/${number}`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiGet(`${FORGE_API_BASE}/projects/${pid}/issues/${number}`);
      console.log(JSON.stringify(data, null, 2));
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
        )) as Array<{ id: number; name: string }>;
        labelIds = labels
          .map((name) => allLabels.find((l) => l.name === name)?.id)
          .filter((id): id is number => id !== undefined);
      }
      const data = await apiPost(`${FORGE_API_BASE}/repos/${ownerRepo}/issues`, {
        title, body, labels: labelIds,
      });
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiPost(`${FORGE_API_BASE}/projects/${pid}/issues`, {
        title, description: body, labels: labels.join(','),
      });
      console.log(JSON.stringify(data, null, 2));
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

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['issue', 'list', '--state', state];
      if (search) ghArgs.push('--search', search);
      if (flags['--json']) ghArgs.push('--json', 'number,title,url,labels,state');
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      let url = `${FORGE_API_BASE}/repos/${ownerRepo}/issues?state=${state}&type=issues`;
      if (search) url += `&q=${encodeURIComponent(search)}`;
      const data = await apiGet(url);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const glState = state === 'open' ? 'opened' : state;
      let url = `${FORGE_API_BASE}/projects/${pid}/issues?state=${glState}`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      const data = await apiGet(url);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
  }
}

// ─── Labels ─────────────────────────────────────────────────────────────────

async function labelList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const ownerRepo = getOwnerRepo();

  switch (FORGE_TYPE) {
    case 'github': {
      const ghArgs = ['label', 'list'];
      if (flags['--json']) ghArgs.push('--json', 'name');
      console.log(gh(ghArgs));
      break;
    }
    case 'gitea': {
      const data = await apiGet(`${FORGE_API_BASE}/repos/${ownerRepo}/labels`);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'gitlab': {
      const pid = await gitlabProjectId(ownerRepo);
      const data = await apiGet(`${FORGE_API_BASE}/projects/${pid}/labels`);
      console.log(JSON.stringify(data, null, 2));
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
          default:
            console.error(`error: unknown pr action: ${action}`);
            console.error('Usage: forge-cli.ts pr {view|create|comment|list|diff} [args...]');
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
        console.error('  pr      {view|create|comment|list|diff}');
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
