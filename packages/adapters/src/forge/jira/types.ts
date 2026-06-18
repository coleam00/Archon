/**
 * Jira Cloud webhook + REST types (only the fields the adapter consumes).
 *
 * We model just the `comment_created` webhook event and the subset of the
 * issue-fetch (`GET /rest/api/3/issue/{key}`) response we read for context.
 */

/** Minimal ADF node shape (recursive). Comment bodies may arrive as ADF docs. */
export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: { type: string }[];
}

/** Top-level ADF document. */
export interface AdfDoc {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

/** A Jira comment body can be a plain string (classic) or an ADF object (v3). */
export type JiraCommentBody = string | AdfNode | AdfDoc;

export interface JiraUser {
  accountId?: string;
  emailAddress?: string;
  displayName?: string;
}

export interface JiraComment {
  id?: string;
  author?: JiraUser;
  body?: JiraCommentBody;
}

/**
 * Jira webhook payload. We only act on `webhookEvent === 'comment_created'`.
 * The shape is intentionally permissive — Jira sends many more fields we ignore.
 */
export interface JiraWebhookEvent {
  webhookEvent?: string;
  issue?: {
    id?: string;
    key?: string;
    fields?: JiraIssueFields;
  };
  comment?: JiraComment;
}

/** Subset of issue fields read for orchestrator context. */
export interface JiraIssueFields {
  summary?: string;
  description?: JiraCommentBody | null;
  issuetype?: { name?: string };
  status?: { name?: string };
}

/** Response shape of `GET /rest/api/3/issue/{key}`. */
export interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

/** Response shape of `GET /rest/api/3/issue/{key}/comment`. */
export interface JiraCommentList {
  comments: JiraComment[];
}
