import { toBranchName } from '@archon/git';
import type { IsolationHints } from '@archon/isolation';
import { getLog } from './log';
import type { GiteaClient, WebhookEvent } from './types';

interface WebhookTarget {
  owner: string;
  repo: string;
  number: number;
  isPR: boolean;
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
 * - pull_request_comment.created → bot @mention detection on PR review comments
 *
 * Does NOT handle:
 * - issues.opened / pull_request.opened → returns null (descriptions are not commands)
 */
export function parseWebhookEvent(event: WebhookEvent): ParsedWebhookEvent | null {
  const owner = event.repository.owner.login;
  const repo = event.repository.name;

  if (event.issue && event.action === 'closed' && !event.issue.pull_request) {
    return { kind: 'close', owner, repo, number: event.issue.number, isPR: false, merged: false };
  }

  if (event.pull_request && event.action === 'closed') {
    return {
      kind: 'close',
      owner,
      repo,
      number: event.pull_request.number,
      isPR: true,
      merged: event.pull_request.merged === true,
    };
  }

  // issue_comment (covers both issues and PRs in Gitea)
  if (event.comment) {
    const number = event.issue?.number ?? event.pull_request?.number;
    if (!number) return null;

    return {
      kind: 'comment',
      owner,
      repo,
      number,
      // In Gitea, issue.pull_request is an object (not null) when comment is on a PR
      isPR: !!event.issue?.pull_request || !!event.pull_request,
      comment: event.comment.body,
      issue: event.issue,
      pullRequest: event.pull_request,
    };
  }

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
 * Build context-rich message for issue.
 * Includes a hint to use the `tea` CLI for full issue details.
 */
function buildIssueContext(issue: NonNullable<WebhookIssue>, userComment: string): string {
  const labels = issue.labels.map(l => l.name).join(', ');

  return `[Gitea Issue Context]
Issue #${String(issue.number)}: "${issue.title}"
Author: ${issue.user.login}
Labels: ${labels}
Status: ${issue.state}

Description:
${issue.body ?? ''}

---

${userComment}

Use 'tea issue view ${String(issue.number)}' for full details if needed.`;
}

/**
 * Build context-rich message for pull request.
 * Includes a hint to use the `tea` CLI for full PR details and diff.
 */
function buildPRContext(pr: NonNullable<WebhookPullRequest>, userComment: string): string {
  const stats = pr.changed_files
    ? `Changed files: ${String(pr.changed_files)} (+${String(pr.additions ?? 0)}, -${String(pr.deletions ?? 0)})`
    : '';

  return `[Gitea Pull Request Context]
PR #${String(pr.number)}: "${pr.title}"
Author: ${pr.user.login}
Status: ${pr.state}
${stats}

Description:
${pr.body ?? ''}

---

${userComment}

Use 'tea pr view ${String(pr.number)}' for full details if needed.`;
}

function issueReference(issue: NonNullable<WebhookIssue>): string {
  return `Gitea Issue #${String(issue.number)}: "${issue.title}"\nUse 'tea issue view ${String(issue.number)}' for full details if needed.`;
}

function pullRequestReference(pr: NonNullable<WebhookPullRequest>): string {
  return `Gitea Pull Request #${String(pr.number)}: "${pr.title}"\nUse 'tea pr view ${String(pr.number)}' for full details if needed.`;
}

/**
 * The message handed to the orchestrator and the issue/PR reference appended for workflows.
 * Slash commands are processed deterministically, so they keep only their first line and get
 * the reference alone; other comments carry the full issue or PR context.
 */
export function buildCommentMessage(
  comment: string,
  isPR: boolean,
  issue: WebhookIssue,
  pullRequest: WebhookPullRequest
): { message: string; issueContext: string | undefined } {
  const pr = isPR ? pullRequest : undefined;
  if (comment.trim().startsWith('/')) {
    getLog().debug('slash_command_processing');
    const message = comment.split('\n')[0].trim();
    if (pr) return { message, issueContext: pullRequestReference(pr) };
    if (issue) return { message, issueContext: issueReference(issue) };
    return { message, issueContext: undefined };
  }
  if (pr) return { message: buildPRContext(pr, comment), issueContext: pullRequestReference(pr) };
  if (issue) {
    return { message: buildIssueContext(issue, comment), issueContext: issueReference(issue) };
  }
  return { message: comment, issueContext: undefined };
}

/** Isolation hints for the orchestrator; a PR's branch info comes from the event payload. */
export function buildIsolationHints(
  target: WebhookTarget,
  pullRequest: WebhookPullRequest
): IsolationHints {
  const isolationHints: IsolationHints = {
    workflowType: target.isPR ? 'pr' : 'issue',
    workflowId: String(target.number),
  };
  if (!target.isPR || !pullRequest?.head) return isolationHints;

  isolationHints.prBranch = toBranchName(pullRequest.head.ref);
  isolationHints.prSha = pullRequest.head.sha;

  // Detect if PR is from a fork
  const headRepoFullName = pullRequest.head.repo?.full_name;
  const baseRepoFullName = pullRequest.base?.repo?.full_name;
  isolationHints.isForkPR = headRepoFullName !== baseRepoFullName;

  getLog().info(
    {
      prNumber: target.number,
      headRef: pullRequest.head.ref,
      headSha: pullRequest.head.sha?.substring(0, 7),
      isFork: isolationHints.isForkPR,
    },
    'pr_head_info'
  );
  return isolationHints;
}

/**
 * Fetch comment history from issue or PR
 * Returns comments in chronological order (oldest first)
 */
export async function fetchCommentHistory(
  client: GiteaClient,
  owner: string,
  repo: string,
  number: number
): Promise<string[]> {
  try {
    const url = `${client.baseUrl}/api/v1/repos/${owner}/${repo}/issues/${String(number)}/comments`;
    const response = await fetch(url, {
      headers: {
        Authorization: `token ${client.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Gitea API error: ${String(response.status)}`);
    }

    const comments = (await response.json()) as {
      user?: { login: string } | null;
      body?: string | null;
    }[];

    // Gitea returns comments in chronological order by default
    // Take last 20 for context
    return comments.slice(-20).map(comment => {
      const author = comment.user?.login ?? 'unknown';
      const body = comment.body ?? '';
      return `${author}: ${body}`;
    });
  } catch (error) {
    getLog().error(
      { err: error, owner, repo, issueNumber: number },
      'comment_history_fetch_failed'
    );
    return [];
  }
}
