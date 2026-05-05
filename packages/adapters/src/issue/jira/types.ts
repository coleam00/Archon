export interface JiraUser {
  accountId?: string;
  emailAddress?: string;
  displayName?: string;
  name?: string;
  key?: string;
}

export interface JiraAdfNode {
  type?: string;
  text?: string;
  attrs?: {
    text?: string;
    id?: string;
    [key: string]: unknown;
  };
  content?: JiraAdfNode[];
  version?: number;
  [key: string]: unknown;
}

export type JiraDocument = string | JiraAdfNode | null | undefined;

export interface JiraIssue {
  id?: string;
  key: string;
  fields?: {
    summary?: string;
    description?: JiraDocument;
    labels?: string[];
    status?: {
      name?: string;
      statusCategory?: {
        key?: string;
        name?: string;
      };
    };
    issuetype?: {
      name?: string;
    };
    project?: {
      key?: string;
      name?: string;
    };
  };
}

export interface JiraComment {
  id?: string;
  body?: JiraDocument;
  author?: JiraUser;
  updateAuthor?: JiraUser;
}

export interface JiraWebhookEvent {
  timestamp?: number;
  webhookEvent?: string;
  issue_event_type_name?: string;
  user?: JiraUser;
  issue?: JiraIssue;
  comment?: JiraComment;
  changelog?: {
    items?: {
      field?: string;
      fieldId?: string;
      fromString?: string;
      toString?: string;
    }[];
  };
}

export interface JiraCommentsResponse {
  comments: JiraComment[];
}
