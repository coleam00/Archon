import { getLinkedIssueNumbers } from '@archon/core';
import { toBranchName } from '@archon/git';
import type { IsolationHints } from '@archon/isolation';
import { getLog } from './log';
import type { GitHubApiCall, WebhookEvent } from './types';

interface WebhookTarget {
  owner: string;
  repo: string;
  number: number;
}

type WebhookIssue = WebhookEvent['issue'];
type WebhookPullRequest = WebhookEvent['pull_request'];

/** An issue or PR comment to answer, or a closed issue or PR whose isolation to clean up. */
export type ParsedWebhookEvent =
  | (WebhookTarget & { kind: 'close'; merged: boolean })
  | (WebhookTarget & {
      kind: 'comment';
      comment: string;
      issue?: WebhookIssue;
      pullRequest?: WebhookPullRequest;
    });

/**
 * Parse webhook event and extract relevant data
 *
 * Handles:
 * - issues.closed / pull_request.closed → cleanup
 * - issue_comment.created → bot @mention detection
 *
 * Does NOT handle:
 * - issues.opened / pull_request.opened → returns null (see #96)
 */
export function parseWebhookEvent(
  event: WebhookEvent,
  githubEvent?: string
): ParsedWebhookEvent | null {
  const repository = event.repository;
  if (!repository?.owner) {
    getLog().debug({ githubEvent }, 'github.repositoryless_webhook_ignored');
    return null;
  }
  const owner = repository.owner.login;
  const repo = repository.name;

  if (event.issue && event.action === 'closed') {
    return { kind: 'close', owner, repo, number: event.issue.number, merged: false };
  }

  if (event.pull_request && event.action === 'closed') {
    return {
      kind: 'close',
      owner,
      repo,
      number: event.pull_request.number,
      merged: event.pull_request.merged === true,
    };
  }

  // issue_comment (covers both issues and PRs)
  if (event.comment) {
    const number = event.issue?.number ?? event.pull_request?.number;
    if (!number) return null;
    return {
      kind: 'comment',
      owner,
      repo,
      number,
      comment: event.comment.body,
      issue: event.issue,
      pullRequest: event.pull_request,
    };
  }

  // Note: We intentionally do NOT handle issues.opened or pull_request.opened
  // events here. Issue/PR descriptions often contain example commands or
  // documentation about how to use the bot - these are NOT command invocations.
  // Only actual comments (issue_comment events) trigger bot responses.
  // See issue #96 for details.

  return null;
}

/**
 * Check if text contains @mention for the configured bot
 */
export function hasMention(text: string, botMention: string): boolean {
  const pattern = new RegExp(`@${botMention}[\\s,:;]`, 'i');
  return pattern.test(text) || text.trim().toLowerCase() === `@${botMention.toLowerCase()}`;
}

/**
 * Strip @mention from text for the configured bot
 */
export function stripMention(text: string, botMention: string): string {
  const pattern = new RegExp(`@${botMention}[\\s,:;]+`, 'gi');
  return text.replace(pattern, '').trim();
}

/**
 * Ingest idempotency key. Key on comment identity (id + updated_at), not
 * the delivery GUID: dual subscriptions (repo + App webhooks) deliver the
 * same comment under different GUIDs. Both fields required — id alone
 * would dedup an edit against the original. GUID is the fallback.
 */
export function deliveryDedupKey(
  event: WebhookEvent,
  target: WebhookTarget,
  deliveryId: string | undefined
): string | undefined {
  const { owner, repo, number } = target;
  if (event.comment?.id !== undefined && event.comment.updated_at) {
    return `comment:${owner}/${repo}#${String(number)}:${String(event.comment.id)}:${event.comment.updated_at}`;
  }
  return deliveryId ? `delivery:${deliveryId}` : undefined;
}

/**
 * Build context-rich message for issue
 */
function buildIssueContext(issue: NonNullable<WebhookIssue>, userComment: string): string {
  const labels = issue.labels.map(l => l.name).join(', ');

  return `[GitHub Issue Context]
Issue #${String(issue.number)}: "${issue.title}"
Author: ${issue.user.login}
Labels: ${labels}
Status: ${issue.state}

Description:
${issue.body ?? ''}

---

${userComment}`;
}

/**
 * Build context-rich message for pull request
 */
function buildPRContext(pr: NonNullable<WebhookPullRequest>, userComment: string): string {
  const stats = pr.changed_files
    ? `Changed files: ${String(pr.changed_files)} (+${String(pr.additions ?? 0)}, -${String(pr.deletions ?? 0)})`
    : '';

  return `[GitHub Pull Request Context]
PR #${String(pr.number)}: "${pr.title}"
Author: ${pr.user.login}
Status: ${pr.state}
${stats}

Description:
${pr.body ?? ''}

Use 'gh pr diff ${String(pr.number)}' to see detailed changes.

---

${userComment}`;
}

function issueReference(issue: NonNullable<WebhookIssue>): string {
  return `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
}

function pullRequestReference(pr: NonNullable<WebhookPullRequest>): string {
  return `GitHub Pull Request #${String(pr.number)}: "${pr.title}"\nUse 'gh pr view ${String(pr.number)}' for full details if needed.`;
}

/**
 * The message handed to the orchestrator and the issue/PR reference appended for workflows.
 * Slash commands are processed deterministically, so they keep only their first line and get
 * the reference alone; other comments carry the full issue or PR context.
 */
export function buildCommentMessage(
  comment: string,
  issue: WebhookIssue,
  pullRequest: WebhookPullRequest
): { message: string; issueContext: string | undefined } {
  if (comment.trim().startsWith('/')) {
    getLog().debug('github.slash_command_processing');
    const message = comment.split('\n')[0].trim();
    if (pullRequest) return { message, issueContext: pullRequestReference(pullRequest) };
    if (issue) return { message, issueContext: issueReference(issue) };
    return { message, issueContext: undefined };
  }
  if (issue) {
    return { message: buildIssueContext(issue, comment), issueContext: issueReference(issue) };
  }
  if (pullRequest) {
    return {
      message: buildPRContext(pullRequest, comment),
      issueContext: pullRequestReference(pullRequest),
    };
  }
  return { message: comment, issueContext: undefined };
}

/**
 * Fetch comment history from issue or PR
 * Returns comments in chronological order (oldest first)
 */
export async function fetchCommentHistory(
  callApi: GitHubApiCall,
  owner: string,
  repo: string,
  number: number
): Promise<string[]> {
  try {
    const { data: comments } = await callApi(owner, repo, octokit =>
      octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: number,
        per_page: 20, // Last 20 comments for context
        sort: 'created',
        direction: 'desc',
      })
    );

    // Reverse to get chronological order (oldest first)
    return [...comments].reverse().map(comment => {
      const author = comment.user?.login ?? 'unknown';
      const body = comment.body ?? '';
      return `${author}: ${body}`;
    });
  } catch (error) {
    getLog().error(
      { err: error, owner, repo, issueNumber: number },
      'github.comment_history_fetch_failed'
    );
    return [];
  }
}

/** Isolation hints for the orchestrator, which makes every isolation decision. */
export async function buildIsolationHints(
  callApi: GitHubApiCall,
  target: WebhookTarget,
  isPR: boolean,
  host: string
): Promise<IsolationHints> {
  const isolationHints: IsolationHints = {
    workflowType: isPR ? 'pr' : 'issue',
    workflowId: String(target.number),
  };
  if (!isPR) return isolationHints;

  // Linked issues let the PR share their worktree
  const linkedIssues = await getLinkedIssueNumbers(target.owner, target.repo, target.number, host);
  if (linkedIssues.length > 0) {
    isolationHints.linkedIssues = linkedIssues;
    getLog().info({ prNumber: target.number, linkedIssues }, 'github.pr_linked_issues');
  }
  await addPullRequestHead(callApi, target, isolationHints);
  return isolationHints;
}

/** Record the PR head branch, SHA and fork status, or mark the fetch failed. */
async function addPullRequestHead(
  callApi: GitHubApiCall,
  { owner, repo, number }: WebhookTarget,
  isolationHints: IsolationHints
): Promise<void> {
  try {
    const { data: prData } = await callApi(owner, repo, octokit =>
      octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
      })
    );
    isolationHints.prBranch = toBranchName(prData.head.ref);
    isolationHints.prSha = prData.head.sha;

    // Detect if PR is from a fork (different repo than base)
    // For fork PRs: head.repo is different from base.repo
    // For same-repo PRs: head.repo.full_name === base.repo.full_name
    // Note: head.repo can be null if the fork was deleted after PR creation
    // In that case, we treat it as a fork (can't push to deleted repo anyway)
    const headRepoFullName = prData.head.repo?.full_name;
    const baseRepoFullName = prData.base.repo.full_name;
    isolationHints.isForkPR = headRepoFullName !== baseRepoFullName;

    getLog().info(
      {
        prNumber: number,
        headRef: prData.head.ref,
        headSha: prData.head.sha.substring(0, 7),
        isFork: isolationHints.isForkPR,
      },
      'github.pr_head_info'
    );
  } catch (error) {
    const err = error as Error;
    // Log at appropriate level based on error type
    const isNonTransient =
      err.message.includes('rate limit') ||
      err.message.includes('403') ||
      err.message.includes('401') ||
      err.message.includes('Bad credentials');

    const logData = { err, owner, repo, prNumber: number };
    if (isNonTransient) {
      getLog().error(logData, 'github.pr_head_fetch_failed');
    } else {
      getLog().warn(logData, 'github.pr_head_fetch_failed');
    }

    // Mark degraded mode - worktree isolation will use fallback naming
    isolationHints.prFetchFailed = true;
  }
}
