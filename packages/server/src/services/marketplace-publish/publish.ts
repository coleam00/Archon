/**
 * Orchestrator for a Marketplace Submission (S5/S6/S7/T6). Composes: resolve
 * credential → parse project origin + capability probe → re-load the workflow
 * from disk (never trust a client-sent definition) → fetch upstream
 * `marketplace.ts` + collision check (BEFORE any write — a collision must cost
 * the submitter nothing) → bundle → pre-flight gates → commit the bundle to
 * the project repo's default branch via the Git Data API → post-commit verify
 * → fork upstream + poll → branch from upstream `dev` → edit the registry file
 * → open a non-draft PR against `dev`.
 *
 * Every I/O seam (Octokit construction, the token store, git read-ops, fs,
 * the workflow loader, the bundle/preflight modules, and sleep) is injected
 * via `PublishDeps` so tests can assert call order and block short-circuits
 * without touching a real DB or GitHub.
 */
import type { Octokit } from '@octokit/rest';
import { join } from 'node:path';
import {
  isPerUserGitHubEnabled,
  getDecryptedAccessToken,
  getUserGithubTokenRecord,
  getUserGithubNoreplyEmail,
  sanitizeCredentials,
} from '@archon/core';
import { findRepoRoot, getRemoteUrl } from '@archon/git';
import { parseWorkflow } from '@archon/workflows/loader';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import { buildMarketplaceBundle, slugify, BundleError, type BundleFile } from './bundle';
import { runPreflightGates, type PreflightResult } from './preflight';
import {
  parseGitHubOrigin,
  probeRepoCapability,
  type GitHubOriginBlockReason,
} from './github-origin';
import {
  parseEntries,
  decideAction,
  applyEdit,
  lintEntry,
  type EntryAction,
  type MarketplaceEntryCandidate,
  type ParsedMarketplaceSource,
} from './entry-edit';

export const UPSTREAM_OWNER = 'coleam00';
export const UPSTREAM_REPO = 'Archon';
export const UPSTREAM_BASE_BRANCH = 'dev';
export const MARKETPLACE_PATH = 'packages/docs-web/src/data/marketplace.ts';

const FORK_POLL_MAX_ATTEMPTS = 10;
const FORK_POLL_INTERVAL_MS = 1500;

/** Marketplace tags a workflow's own `tags:` can map onto (CONTRIBUTING.md / tagConfig). */
const MARKETPLACE_TAG_KEYS = ['development', 'review', 'automation', 'planning'] as const;

export interface SubmitAttestation {
  noExfiltration: boolean;
  noDestructiveOps: boolean;
  rightToShare: boolean;
  shaReviewed: boolean;
}

export interface SubmitParams {
  /** Soft-resolved web user id (undefined on solo/PAT installs). */
  userId: string | undefined;
  cwd: string;
  workflowName: string;
  attestation: SubmitAttestation;
}

export interface SubmitResult {
  prUrl: string;
  slug: string;
  /** Alias of `bundleCommitSha` (response schema convenience field). */
  sha: string;
  bundleCommitSha: string;
  action: 'append' | 'update';
}

export type SubmitBlockReason =
  | { kind: 'no-credential' }
  | { kind: 'origin'; reason: GitHubOriginBlockReason }
  | { kind: 'workflow-not-found'; detail: string }
  | { kind: 'collision'; owner: string }
  | { kind: 'bundle'; message: string }
  | { kind: 'preflight'; gates: PreflightResult['gates'] }
  | { kind: 'branch-protected'; detail: string };

/** A submission was blocked BEFORE any write (or, for `branch-protected`, the one write attempted failed cleanly). */
export class SubmitBlockedError extends Error {
  readonly block: SubmitBlockReason;
  constructor(block: SubmitBlockReason, message: string) {
    super(message);
    this.name = 'SubmitBlockedError';
    this.block = block;
  }
}

/**
 * The bundle commit landed on the project repo, but a later step (fork, PR,
 * registry edit) failed. Callers MUST surface `bundleRepo` + `bundleCommitSha`
 * so the user knows the visible side effect happened.
 */
export class PostCommitFailureError extends Error {
  readonly bundleRepo: string;
  readonly bundleCommitSha: string;
  constructor(bundleRepo: string, bundleCommitSha: string, message: string) {
    super(message);
    this.name = 'PostCommitFailureError';
    this.bundleRepo = bundleRepo;
    this.bundleCommitSha = bundleCommitSha;
  }
}

export interface PublishDeps {
  octokitFactory: (token: string) => Octokit;
  isPerUserGitHubEnabled: typeof isPerUserGitHubEnabled;
  getDecryptedAccessToken: typeof getDecryptedAccessToken;
  getUserGithubTokenRecord: typeof getUserGithubTokenRecord;
  getUserGithubNoreplyEmail: typeof getUserGithubNoreplyEmail;
  findRepoRoot: typeof findRepoRoot;
  getRemoteUrl: typeof getRemoteUrl;
  readFile: (path: string) => Promise<string>;
  parseWorkflow: typeof parseWorkflow;
  buildMarketplaceBundle: typeof buildMarketplaceBundle;
  runPreflightGates: typeof runPreflightGates;
  sleep: (ms: number) => Promise<void>;
  /** Archon server's OWN checkout (for finding ITS OWN `.archon/scripts/` — S1). */
  serverCwd: string;
  env: NodeJS.ProcessEnv;
  /** Archon's own version string (`api.ts` appVersion) — drives `archonVersionCompat`. */
  appVersion: string;
}

function deriveTags(workflow: WorkflowDefinition): string[] {
  const matched = (workflow.tags ?? []).filter((t): t is (typeof MARKETPLACE_TAG_KEYS)[number] =>
    (MARKETPLACE_TAG_KEYS as readonly string[]).includes(t)
  );
  // Not spike-verified — MarketplaceEntry.tags has no documented derivation from a
  // workflow's own `tags:`. Fall back to a generic, always-valid default rather than
  // failing the submission outright when nothing matches.
  return matched.length > 0 ? matched : ['automation'];
}

function deriveArchonVersionCompat(appVersion: string): string {
  const match = /^(\d+)\.(\d+)/.exec(appVersion);
  return match ? `>=${match[1]}.${match[2]}.0` : '>=0.0.0';
}

/**
 * `sanitizeCredentials` only scrubs values it can find in real `process.env`
 * (`GH_TOKEN`/`GITHUB_TOKEN`) plus URL-embedded userinfo — it has no idea about
 * a per-user token resolved from the DB. Every error surfaced from this module
 * threads the actually-resolved `token` through here first, so the LITERAL
 * secret can never leak regardless of which credential source it came from.
 */
function redactToken(message: string, token: string): string {
  return sanitizeCredentials(token ? message.split(token).join('[REDACTED]') : message);
}

function originBlockMessage(reason: GitHubOriginBlockReason): string {
  switch (reason) {
    case 'no-origin':
      return 'The project has no GitHub origin remote (or it is not a github.com repository).';
    case 'private':
      return 'The project repository is private. Marketplace submissions require a public repository.';
    case 'archived':
      return 'The project repository is archived.';
    case 'no-push-permission':
      return 'The resolved GitHub credential cannot push to this repository. Connect a GitHub identity with write access, or verify the App installation covers this repository.';
  }
}

async function resolveAuthor(
  deps: PublishDeps,
  octokit: Octokit,
  userId: string | undefined,
  usedPerUserToken: boolean
): Promise<{ login: string; commitAuthor?: { name: string; email: string } }> {
  if (usedPerUserToken && userId) {
    const record = await deps.getUserGithubTokenRecord(userId);
    if (record) {
      const email = await deps.getUserGithubNoreplyEmail(userId);
      return {
        login: record.github_login,
        commitAuthor: email ? { name: record.github_login, email } : undefined,
      };
    }
  }
  const { data } = await octokit.rest.users.getAuthenticated();
  return { login: data.login };
}

/**
 * Commit the bundle to the project repo's default branch via the Git Data API
 * (S5 — one atomic commit, zero local git mutation). Branch protection
 * rejecting `updateRef` surfaces as a `branch-protected` block, not a crash.
 */
async function commitBundleToProjectRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
  bundle: BundleFile[],
  message: string,
  token: string,
  commitAuthor?: { name: string; email: string }
): Promise<string> {
  try {
    const { data: refData } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });
    const baseCommitSha = refData.object.sha;
    const { data: baseCommit } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: baseCommitSha,
    });

    const tree = await Promise.all(
      bundle.map(async file => {
        const { data: blob } = await octokit.rest.git.createBlob({
          owner,
          repo,
          content: file.content,
          encoding: 'utf-8',
        });
        return {
          path: file.repoPath,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blob.sha,
        };
      })
    );

    const { data: treeData } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.tree.sha,
      tree,
    });

    const { data: commitData } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message,
      tree: treeData.sha,
      parents: [baseCommitSha],
      ...(commitAuthor ? { author: commitAuthor } : {}),
    });

    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
      sha: commitData.sha,
    });

    return commitData.sha;
  } catch (err) {
    const message = redactToken(err instanceof Error ? err.message : String(err), token);
    throw new SubmitBlockedError(
      { kind: 'branch-protected', detail: message },
      `Could not commit the marketplace bundle to ${owner}/${repo}@${defaultBranch}: ${message}`
    );
  }
}

async function pollForkReady(
  octokit: Octokit,
  login: string,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  for (let attempt = 0; attempt < FORK_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      await octokit.rest.repos.get({ owner: login, repo: UPSTREAM_REPO });
      return;
    } catch {
      await sleep(FORK_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Fork ${login}/${UPSTREAM_REPO} did not become ready after ${FORK_POLL_MAX_ATTEMPTS} attempts.`
  );
}

/** Create the submission branch on the fork at upstream `dev`'s head SHA (S6). */
async function createForkBranch(
  octokit: Octokit,
  login: string,
  branchName: string,
  targetSha: string
): Promise<void> {
  try {
    await octokit.rest.git.createRef({
      owner: login,
      repo: UPSTREAM_REPO,
      ref: `refs/heads/${branchName}`,
      sha: targetSha,
    });
  } catch {
    // Rare divergent-fork edge (S6) — sync the fork's own dev with upstream once, then retry.
    await octokit.rest.repos.mergeUpstream({
      owner: login,
      repo: UPSTREAM_REPO,
      branch: UPSTREAM_BASE_BRANCH,
    });
    await octokit.rest.git.createRef({
      owner: login,
      repo: UPSTREAM_REPO,
      ref: `refs/heads/${branchName}`,
      sha: targetSha,
    });
  }
}

function buildPrBody(
  candidate: MarketplaceEntryCandidate,
  preflight: PreflightResult,
  action: EntryAction
): string {
  const gateLines = preflight.gates
    .map(g => `- ${g.name}: ${g.passed ? 'passed' : 'FAILED'}`)
    .join('\n');
  return [
    `**${action.kind === 'update' ? 'Update' : 'New submission'}**: \`${candidate.slug}\``,
    '',
    candidate.description,
    '',
    '**Pre-flight gates** (run before this PR was opened, mirroring marketplace CI):',
    gateLines,
    '',
    '**Self-attestation** confirmed by the submitter:',
    '- [x] The workflow does not exfiltrate data, credentials, or secrets',
    '- [x] The workflow does not execute destructive operations without user confirmation',
    '- [x] The submitter has the right to share this workflow publicly',
    '- [x] The pinned SHA points to a reviewed, stable version of the workflow',
    '',
    '_Opened by the Archon Marketplace Submission flow._',
  ].join('\n');
}

/** Narrow an `octokit.repos.getContent` response to the single-file shape we require. */
function asFileContent(data: unknown): { content: string; sha: string } {
  if (
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data) ||
    (data as { type?: string }).type !== 'file'
  ) {
    throw new Error('Expected a single file from getContent, got a directory/symlink/submodule.');
  }
  return data as { content: string; sha: string };
}

export async function submitToMarketplace(
  deps: PublishDeps,
  params: SubmitParams
): Promise<SubmitResult> {
  // 1. Resolve token — tri-state, no silent broadening (S7).
  const perUserToken =
    params.userId && deps.isPerUserGitHubEnabled()
      ? await deps.getDecryptedAccessToken(params.userId)
      : null;
  const token = perUserToken ?? deps.env.GITHUB_TOKEN ?? deps.env.GH_TOKEN ?? null;
  if (!token) {
    throw new SubmitBlockedError(
      { kind: 'no-credential' },
      'No GitHub credential available. Connect GitHub in Settings, or set GITHUB_TOKEN on the server.'
    );
  }
  const octokit = deps.octokitFactory(token);

  // 2. Parse the project's origin + capability probe — BEFORE any write.
  const projectRepoRoot = await deps.findRepoRoot(params.cwd);
  const remoteUrl = projectRepoRoot ? await deps.getRemoteUrl(projectRepoRoot) : null;
  const origin = remoteUrl ? parseGitHubOrigin(remoteUrl) : null;
  if (!origin) {
    throw new SubmitBlockedError(
      { kind: 'origin', reason: 'no-origin' },
      originBlockMessage('no-origin')
    );
  }
  const capabilityResult = await probeRepoCapability(octokit, origin.owner, origin.repo);
  if (!capabilityResult.ok) {
    throw new SubmitBlockedError(
      { kind: 'origin', reason: capabilityResult.reason },
      originBlockMessage(capabilityResult.reason)
    );
  }
  const { defaultBranch } = capabilityResult.capability;

  // 3. Re-load + parse the workflow from disk — server never trusts a client-sent definition.
  const workflowPath = join(params.cwd, '.archon', 'workflows', `${params.workflowName}.yaml`);
  let yamlContent: string;
  try {
    yamlContent = await deps.readFile(workflowPath);
  } catch {
    throw new SubmitBlockedError(
      { kind: 'workflow-not-found', detail: workflowPath },
      `Workflow file not found: ${workflowPath}`
    );
  }
  const parsedWorkflow = deps.parseWorkflow(yamlContent, `${params.workflowName}.yaml`);
  if (!parsedWorkflow.workflow) {
    throw new SubmitBlockedError(
      { kind: 'workflow-not-found', detail: parsedWorkflow.error.error },
      `Workflow "${params.workflowName}" failed to parse: ${parsedWorkflow.error.error}`
    );
  }
  const workflow = parsedWorkflow.workflow;

  // 4. Resolve author + fetch upstream registry, collision check FIRST (before bundle/preflight/commit).
  const author = await resolveAuthor(deps, octokit, params.userId, perUserToken !== null);
  const slug = slugify(params.workflowName);

  const { data: upstreamFileRaw } = await octokit.rest.repos.getContent({
    owner: UPSTREAM_OWNER,
    repo: UPSTREAM_REPO,
    path: MARKETPLACE_PATH,
    ref: UPSTREAM_BASE_BRANCH,
  });
  const upstreamFile = asFileContent(upstreamFileRaw);
  const upstreamSource = Buffer.from(upstreamFile.content, 'base64').toString('utf-8');
  const parsedRegistry: ParsedMarketplaceSource = parseEntries(upstreamSource);
  const action = decideAction(parsedRegistry.entries, slug, author.login);
  if (action.kind === 'collision') {
    throw new SubmitBlockedError(
      { kind: 'collision', owner: action.existing.author },
      `Slug "${slug}" is already registered by a different author ("${action.existing.author}"). Choose a different workflow name.`
    );
  }

  // 5. Bundle.
  let bundle: BundleFile[];
  try {
    bundle = await deps.buildMarketplaceBundle({
      cwd: params.cwd,
      workflowName: params.workflowName,
      yamlContent,
      workflow,
    });
  } catch (err) {
    if (err instanceof BundleError) {
      throw new SubmitBlockedError({ kind: 'bundle', message: err.message }, err.message);
    }
    throw err;
  }

  // 6. Pre-flight gates — against Archon's OWN repo checkout (S1), not the project's.
  const preflight = await deps.runPreflightGates(bundle, deps.serverCwd);
  if (!preflight.passed) {
    throw new SubmitBlockedError(
      { kind: 'preflight', gates: preflight.gates },
      `Pre-flight gates failed: ${preflight.gates
        .filter(g => !g.passed)
        .map(g => g.name)
        .join(', ')}`
    );
  }

  // ---- WRITES START HERE. Any failure past this point must report the
  // bundle's landed location (PostCommitFailureError) — the visible side
  // effect already happened. ----
  const commitMessage = `feat(marketplace): ${action.kind === 'update' ? 'update' : 'submit'} ${slug}`;
  const bundleCommitSha = await commitBundleToProjectRepo(
    octokit,
    origin.owner,
    origin.repo,
    defaultBranch,
    bundle,
    commitMessage,
    token,
    author.commitAuthor
  );
  const bundleRepoLabel = `${origin.owner}/${origin.repo}`;

  try {
    // Post-commit verify.
    await octokit.rest.repos.getContent({
      owner: origin.owner,
      repo: origin.repo,
      path: `.archon/marketplace/${slug}`,
      ref: bundleCommitSha,
    });

    const candidate: MarketplaceEntryCandidate = {
      slug,
      name: params.workflowName,
      author: author.login,
      description: workflow.description,
      sourceUrl: `https://github.com/${origin.owner}/${origin.repo}/tree/${bundleCommitSha}/.archon/marketplace/${slug}`,
      sha: bundleCommitSha,
      tags: deriveTags(workflow),
      archonVersionCompat: deriveArchonVersionCompat(deps.appVersion),
    };

    const existingSlugs = parsedRegistry.entries.filter(e => e.slug !== slug).map(e => e.slug);
    const lintIssues = lintEntry(candidate, existingSlugs);
    if (lintIssues.length > 0) {
      throw new Error(`Generated marketplace entry failed validation: ${lintIssues.join('; ')}`);
    }

    const editedSource = applyEdit(upstreamSource, parsedRegistry, action, candidate);

    await octokit.rest.repos.createFork({ owner: UPSTREAM_OWNER, repo: UPSTREAM_REPO });
    await pollForkReady(octokit, author.login, deps.sleep);

    const { data: upstreamDevRef } = await octokit.rest.git.getRef({
      owner: UPSTREAM_OWNER,
      repo: UPSTREAM_REPO,
      ref: `heads/${UPSTREAM_BASE_BRANCH}`,
    });
    const branchName = `marketplace/${slug}`;
    await createForkBranch(octokit, author.login, branchName, upstreamDevRef.object.sha);

    await octokit.rest.repos.createOrUpdateFileContents({
      owner: author.login,
      repo: UPSTREAM_REPO,
      path: MARKETPLACE_PATH,
      message: `feat(marketplace): ${action.kind === 'update' ? 'update' : 'add'} ${slug}`,
      content: Buffer.from(editedSource, 'utf-8').toString('base64'),
      sha: upstreamFile.sha,
      branch: branchName,
      ...(author.commitAuthor
        ? { committer: author.commitAuthor, author: author.commitAuthor }
        : {}),
    });

    const { data: pr } = await octokit.rest.pulls.create({
      owner: UPSTREAM_OWNER,
      repo: UPSTREAM_REPO,
      title: `feat(marketplace): ${action.kind === 'update' ? 'update' : 'add'} ${slug}`,
      head: `${author.login}:${branchName}`,
      base: UPSTREAM_BASE_BRANCH,
      body: buildPrBody(candidate, preflight, action),
      draft: false,
    });

    return {
      prUrl: pr.html_url,
      slug,
      sha: bundleCommitSha,
      bundleCommitSha,
      action: action.kind === 'update' ? 'update' : 'append',
    };
  } catch (err) {
    if (err instanceof SubmitBlockedError) throw err;
    const message = redactToken(err instanceof Error ? err.message : String(err), token);
    throw new PostCommitFailureError(bundleRepoLabel, bundleCommitSha, message);
  }
}
