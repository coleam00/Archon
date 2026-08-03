/**
 * GitLab webhook event types
 *
 * GitLab uses `object_kind` to discriminate events (unlike GitHub's action + X-GitHub-Event header).
 * Field naming: `iid` (project-scoped) instead of `number`, `username` instead of `login`.
 */

// --- Shared sub-types ---

export interface GitLabUser {
  username: string;
  name: string;
}

export interface GitLabProject {
  id: number;
  path_with_namespace: string;
  default_branch: string;
  web_url: string;
  http_url_to_repo: string;
}

export interface GitLabLabel {
  title: string;
}

// --- Note (comment) event ---

export interface GitLabNoteAttributes {
  noteable_type: 'Issue' | 'MergeRequest';
  note: string;
  noteable_id: number;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  labels: GitLabLabel[];
}

export interface GitLabMergeRequest {
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'merged';
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
}

export interface GitLabNoteEvent {
  object_kind: 'note';
  event_type: 'note';
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: GitLabNoteAttributes;
  issue?: GitLabIssue;
  merge_request?: GitLabMergeRequest;
}

// --- Issue lifecycle event ---

export interface GitLabIssueAttributes {
  iid: number;
  action: 'open' | 'close' | 'reopen' | 'update' | (string & {});
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  labels: GitLabLabel[];
}

export interface GitLabIssueEvent {
  object_kind: 'issue';
  event_type: 'issue';
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: GitLabIssueAttributes;
}

// --- Merge Request lifecycle event ---

export interface GitLabMergeRequestAttributes {
  iid: number;
  action: 'open' | 'close' | 'merge' | 'reopen' | 'update' | (string & {});
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'merged';
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  merge_status: string;
}

export interface GitLabMergeRequestEvent {
  object_kind: 'merge_request';
  event_type: 'merge_request';
  user: GitLabUser;
  project: GitLabProject;
  object_attributes: GitLabMergeRequestAttributes;
}

// --- Discriminated union ---

export type GitLabWebhookEvent = GitLabNoteEvent | GitLabIssueEvent | GitLabMergeRequestEvent;
