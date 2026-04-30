export interface BlockerRef {
  id: string;
  identifier: string;
  state: string;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: Date | null;
  updated_at: Date | null;
}

export interface CreateIssueInput {
  title: string;
  description?: string | null;
  /** Linear priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low. */
  priority?: number | null;
}

export interface CommentOnIssueInput {
  issueId: string;
  body: string;
}

export interface Tracker {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  /** Optional — implementations may throw if creation isn't supported. */
  createIssue?(input: CreateIssueInput): Promise<Issue>;
  /** Optional — post a comment back to the tracker. */
  commentOnIssue?(input: CommentOnIssueInput): Promise<{ id: string }>;
}
