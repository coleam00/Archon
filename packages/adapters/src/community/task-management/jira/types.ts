// ADF node types

export interface JiraAdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JiraAdfNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface JiraAdfDocument {
  version: 1;
  type: 'doc';
  content: JiraAdfNode[];
}

// Author

export interface JiraCommentAuthor {
  accountId: string;
  displayName: string;
}

// Comment (as it appears in webhook payload)

export interface JiraComment {
  id: string;
  author: JiraCommentAuthor;
  body: JiraAdfDocument;
  created: string;
  updated: string;
}

// Issue fields

export interface JiraIssueFields {
  summary: string;
  description: JiraAdfDocument | null;
  status: { name: string };
  priority: { name: string } | null;
  labels: string[];
}

// Issue

export interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
}

// Webhook event (only comment_created is handled; other types are filtered in handleWebhook)

export interface JiraCommentCreatedEvent {
  webhookEvent: 'comment_created';
  comment: JiraComment;
  issue: JiraIssue;
}

export interface JiraUnknownEvent {
  webhookEvent: string;
}

export type JiraWebhookEvent = JiraCommentCreatedEvent | JiraUnknownEvent;

// API response shape for GET /comment

export interface JiraCommentListResponse {
  comments: {
    author: JiraCommentAuthor;
    body: JiraAdfDocument;
  }[];
}
