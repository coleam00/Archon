import { toBranchName } from '@archon/git';
import type { IsolationHints } from '@archon/isolation';
import { gitlabApi } from './api';
import { getLog } from './log';
import type { GitLabClient, GitLabIssue, GitLabMergeRequest, GitLabWebhookEvent } from './types';

interface WebhookTarget {
  projectPath: string;
  iid: number;
  isMR: boolean;
}

/** A note on an issue or MR to answer, or a closed issue or MR whose isolation to clean up. */
export type ParsedWebhookEvent =
  | (WebhookTarget & { kind: 'close'; merged: boolean })
  | (WebhookTarget & {
      kind: 'note';
      comment: string;
      issue?: GitLabIssue;
      mergeRequest?: GitLabMergeRequest;
    });

export function parseWebhookEvent(event: GitLabWebhookEvent): ParsedWebhookEvent | null {
  const projectPath = event.project.path_with_namespace;

  if (event.object_kind === 'issue' && event.object_attributes.action === 'close') {
    return {
      kind: 'close',
      projectPath,
      iid: event.object_attributes.iid,
      isMR: false,
      merged: false,
    };
  }

  if (event.object_kind === 'merge_request') {
    const action = event.object_attributes.action;
    if (action === 'close' || action === 'merge') {
      return {
        kind: 'close',
        projectPath,
        iid: event.object_attributes.iid,
        isMR: true,
        merged: action === 'merge',
      };
    }
  }

  // Note (comment) on issue or MR
  if (event.object_kind === 'note') {
    const isMR = event.object_attributes.noteable_type === 'MergeRequest';
    const iid = isMR ? event.merge_request?.iid : event.issue?.iid;

    if (!iid) return null;

    return {
      kind: 'note',
      projectPath,
      iid,
      comment: event.object_attributes.note,
      isMR,
      issue: event.issue,
      mergeRequest: event.merge_request,
    };
  }

  return null;
}

export function hasMention(text: string, botMention: string): boolean {
  const pattern = new RegExp(`@${botMention}(?:[\\s,:;]|$)`, 'i');
  return pattern.test(text);
}

export function stripMention(text: string, botMention: string): string {
  // `+` consumes all trailing separators (e.g. "@archon, " not just "@archon")
  const pattern = new RegExp(`@${botMention}(?:[\\s,:;]+|$)`, 'gi');
  return text.replace(pattern, '').trim();
}

function buildIssueContext(issue: GitLabIssue, userComment: string): string {
  const labels = issue.labels.map(l => l.title).join(', ');
  return `[GitLab Issue Context]
Issue #${String(issue.iid)}: "${issue.title}"
Labels: ${labels}
Status: ${issue.state}

Description:
${issue.description ?? ''}

---

${userComment}

Use 'glab issue view ${String(issue.iid)}' for full details if needed.`;
}

function buildMRContext(mr: GitLabMergeRequest, userComment: string): string {
  return `[GitLab Merge Request Context]
MR !${String(mr.iid)}: "${mr.title}"
Status: ${mr.state}
Source: ${mr.source_branch} → ${mr.target_branch}

Description:
${mr.description ?? ''}

---

${userComment}

Use 'glab mr view ${String(mr.iid)}' for full details and 'glab mr diff ${String(mr.iid)}' for the diff.`;
}

function issueReference(issue: GitLabIssue): string {
  return `GitLab Issue #${String(issue.iid)}: "${issue.title}"\nUse 'glab issue view ${String(issue.iid)}' for full details if needed.`;
}

function mergeRequestReference(mr: GitLabMergeRequest): string {
  return `GitLab Merge Request !${String(mr.iid)}: "${mr.title}"\nUse 'glab mr view ${String(mr.iid)}' for full details if needed.`;
}

/**
 * The message handed to the orchestrator and the issue/MR reference appended for workflows.
 * Slash commands keep only their first line and get the reference alone; other comments
 * carry the full issue or MR context.
 */
export function buildCommentMessage(
  comment: string,
  isMR: boolean,
  issue: GitLabIssue | undefined,
  mergeRequest: GitLabMergeRequest | undefined
): { message: string; issueContext: string | undefined } {
  const mr = isMR ? mergeRequest : undefined;
  if (comment.trim().startsWith('/')) {
    getLog().debug('gitlab.slash_command_processing');
    const message = comment.split('\n')[0].trim();
    if (mr) return { message, issueContext: mergeRequestReference(mr) };
    if (issue) return { message, issueContext: issueReference(issue) };
    return { message, issueContext: undefined };
  }
  if (mr) return { message: buildMRContext(mr, comment), issueContext: mergeRequestReference(mr) };
  if (issue) {
    return { message: buildIssueContext(issue, comment), issueContext: issueReference(issue) };
  }
  return { message: comment, issueContext: undefined };
}

/** Isolation hints for the orchestrator; an MR's branch info comes from the event payload. */
export function buildIsolationHints(
  target: WebhookTarget,
  mergeRequest: GitLabMergeRequest | undefined
): IsolationHints {
  const isolationHints: IsolationHints = {
    workflowType: target.isMR ? 'pr' : 'issue',
    workflowId: String(target.iid),
  };
  if (!target.isMR || !mergeRequest) return isolationHints;

  isolationHints.prBranch = toBranchName(mergeRequest.source_branch);
  isolationHints.isForkPR = mergeRequest.source_project_id !== mergeRequest.target_project_id;

  getLog().info(
    {
      mrIid: target.iid,
      sourceBranch: mergeRequest.source_branch,
      isFork: isolationHints.isForkPR,
    },
    'gitlab.mr_head_info'
  );
  return isolationHints;
}

export async function fetchCommentHistory(
  client: GitLabClient,
  { projectPath, iid, isMR }: WebhookTarget
): Promise<string[]> {
  try {
    const encodedProject = encodeURIComponent(projectPath);
    const notesPath = isMR
      ? `/projects/${encodedProject}/merge_requests/${String(iid)}/notes?per_page=20&sort=asc`
      : `/projects/${encodedProject}/issues/${String(iid)}/notes?per_page=20&sort=asc`;

    const notes = await gitlabApi<
      { author?: { username?: string } | null; body?: string | null }[]
    >(client, 'GET', notesPath);

    return notes.slice(-20).map(note => {
      const author = note.author?.username ?? 'unknown';
      const body = note.body ?? '';
      return `${author}: ${body}`;
    });
  } catch (error) {
    getLog().error({ err: error, projectPath, iid, isMR }, 'gitlab.comment_history_fetch_failed');
    return [];
  }
}
