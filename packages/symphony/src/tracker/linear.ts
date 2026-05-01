import { GraphQLClient, ClientError } from 'graphql-request';
import type { CommentOnIssueInput, CreateIssueInput, Issue, Tracker } from './types';
import { TrackerError } from './errors';
import { normalizeLinearIssue, type RawLinearIssue } from './normalize';

export interface LinearTrackerOptions {
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  pageSize?: number;
  networkTimeoutMs?: number;
  activeStates: string[];
  terminalStates: string[];
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
`;

const CANDIDATES_QUERY = /* GraphQL */ `
  query SymphonyCandidates($slug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $slug } }
        state: { name: { in: $states } }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }
  }
`;

const STATES_QUERY = /* GraphQL */ `
  query SymphonyByStates($slug: String!, $states: [String!]!, $first: Int!, $after: String) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $slug } }
        state: { name: { in: $states } }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }
  }
`;

const BY_IDS_QUERY = /* GraphQL */ `
  query SymphonyByIds($ids: [ID!]!) {
    issues(filter: { id: { in: $ids } }, first: 250) {
      nodes { ${ISSUE_FIELDS} }
    }
  }
`;

const PROJECT_TEAM_QUERY = /* GraphQL */ `
  query SymphonyProjectTeam($slug: String!) {
    projects(filter: { slugId: { eq: $slug } }, first: 1) {
      nodes {
        id
        teams(first: 1) {
          nodes {
            id
          }
        }
      }
    }
  }
`;

const ISSUE_CREATE_MUTATION = /* GraphQL */ `
  mutation SymphonyIssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { ${ISSUE_FIELDS} }
    }
  }
`;

const COMMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation SymphonyCommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
      }
    }
  }
`;

const ISSUE_UPDATE_MUTATION = /* GraphQL */ `
  mutation SymphonyIssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { ${ISSUE_FIELDS} }
    }
  }
`;

// fetchAllIssues paginates the project's full backlog (no state filter) — used
// by Mission Control's Linear-state kanban to display every issue, not just
// dispatch-eligible ones. Uses a richer fragment than the dispatch path
// because the kanban needs state IDs (for drag-to-state mutations).
const KANBAN_FIELDS = `
  id
  identifier
  title
  priority
  url
  state { id name type }
  updatedAt
`;

const ALL_ISSUES_QUERY = /* GraphQL */ `
  query SymphonyAllIssues($slug: String!, $first: Int!, $after: String) {
    issues(
      first: $first
      after: $after
      filter: { project: { slugId: { eq: $slug } } }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes { ${KANBAN_FIELDS} }
    }
  }
`;

interface PageResponse {
  issues: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawLinearIssue[];
  };
}

interface ByIdsResponse {
  issues: { nodes: RawLinearIssue[] };
}

interface ProjectTeamResponse {
  projects: {
    nodes: {
      id: string;
      teams: { nodes: { id: string }[] };
    }[];
  };
}

interface IssueCreateResponse {
  issueCreate: {
    success: boolean;
    issue: RawLinearIssue | null;
  };
}

interface CommentCreateResponse {
  commentCreate: {
    success: boolean;
    comment: { id: string } | null;
  };
}

interface IssueUpdateResponse {
  issueUpdate: {
    success: boolean;
    issue: RawLinearIssue | null;
  };
}

export interface IssueUpdateInput {
  /** Linear state id (UUID) the issue should transition to. */
  stateId?: string;
  /** Lexicographic-ish sort within state column. */
  sortOrder?: number;
}

/**
 * Lighter-weight issue shape used by the Mission Control kanban. Includes
 * `state.id` (which the dispatch-side `Issue` interface omits) so the
 * frontend can drag-to-state and PATCH with the target stateId.
 */
export interface KanbanIssue {
  id: string;
  identifier: string;
  title: string;
  priority: number | null;
  url: string | null;
  state: { id: string; name: string; type: string } | null;
  updatedAt: string | null;
}

interface RawKanbanIssue {
  id: string;
  identifier: string;
  title?: string | null;
  priority?: number | null;
  url?: string | null;
  state?: { id?: string | null; name?: string | null; type?: string | null } | null;
  updatedAt?: string | null;
}

interface KanbanPageResponse {
  issues: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawKanbanIssue[];
  };
}

function normalizeKanbanIssue(raw: RawKanbanIssue): KanbanIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title ?? '',
    priority: typeof raw.priority === 'number' ? raw.priority : null,
    url: raw.url ?? null,
    state:
      raw.state?.id && raw.state.name
        ? {
            id: raw.state.id,
            name: raw.state.name,
            type: raw.state.type ?? 'unknown',
          }
        : null,
    updatedAt: raw.updatedAt ?? null,
  };
}

export class LinearTracker implements Tracker {
  private readonly client: GraphQLClient;
  private readonly opts: Required<LinearTrackerOptions>;
  private projectIds: { projectId: string; teamId: string } | null = null;

  constructor(opts: LinearTrackerOptions) {
    if (!opts.apiKey) {
      throw new TrackerError('missing_tracker_api_key', 'LinearTracker: apiKey is required');
    }
    if (!opts.projectSlug) {
      throw new TrackerError(
        'missing_tracker_project_slug',
        'LinearTracker: projectSlug is required'
      );
    }
    this.opts = {
      pageSize: 50,
      networkTimeoutMs: 30_000,
      ...opts,
    };
    this.client = new GraphQLClient(this.opts.endpoint, {
      headers: { authorization: this.opts.apiKey },
    });
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    if (this.opts.activeStates.length === 0) return [];
    return this.paginate(CANDIDATES_QUERY, this.opts.activeStates);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    return this.paginate(STATES_QUERY, stateNames);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const data = await this.request<ByIdsResponse>(BY_IDS_QUERY, { ids });
    if (!data?.issues?.nodes) {
      throw new TrackerError(
        'linear_unknown_payload',
        'Linear by-ids response missing issues.nodes'
      );
    }
    return data.issues.nodes.map(normalizeLinearIssue);
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const title = input.title.trim();
    if (!title) {
      throw new TrackerError('missing_title', 'issue title is required');
    }
    const ids = await this.resolveProjectIds();
    const variables: Record<string, unknown> = {
      input: {
        teamId: ids.teamId,
        projectId: ids.projectId,
        title,
        description:
          typeof input.description === 'string' && input.description.trim()
            ? input.description
            : undefined,
        priority:
          typeof input.priority === 'number' &&
          Number.isInteger(input.priority) &&
          input.priority >= 0 &&
          input.priority <= 4
            ? input.priority
            : undefined,
      },
    };
    const data = await this.request<IssueCreateResponse>(ISSUE_CREATE_MUTATION, variables);
    if (!data?.issueCreate?.success || !data.issueCreate.issue) {
      throw new TrackerError(
        'linear_issue_create_failed',
        'Linear rejected issueCreate (success=false or missing issue)'
      );
    }
    return normalizeLinearIssue(data.issueCreate.issue);
  }

  async commentOnIssue(input: CommentOnIssueInput): Promise<{ id: string }> {
    const issueId = input.issueId.trim();
    if (!issueId) {
      throw new TrackerError('missing_issue_id', 'issueId is required');
    }
    const body = input.body.trim();
    if (!body) {
      throw new TrackerError('missing_comment_body', 'comment body is required');
    }
    const data = await this.request<CommentCreateResponse>(COMMENT_CREATE_MUTATION, {
      input: { issueId, body },
    });
    if (!data?.commentCreate?.success || !data.commentCreate.comment?.id) {
      throw new TrackerError(
        'linear_comment_create_failed',
        'Linear rejected commentCreate (success=false or missing comment)'
      );
    }
    return { id: data.commentCreate.comment.id };
  }

  /**
   * Update a Linear issue's state and/or sort order. Used by Mission Control's
   * bidi kanban — drag-to-state-column triggers this. Returns nothing: the
   * caller is expected to refetch (`fetchAllIssues`) on success because the
   * mutation's GraphQL fragment does not include all fields the kanban needs.
   */
  async updateIssue(issueId: string, input: IssueUpdateInput): Promise<void> {
    if (!issueId.trim()) {
      throw new TrackerError('missing_issue_id', 'issueId is required');
    }
    const payload: Record<string, unknown> = {};
    if (typeof input.stateId === 'string' && input.stateId) payload.stateId = input.stateId;
    if (typeof input.sortOrder === 'number') payload.sortOrder = input.sortOrder;
    if (Object.keys(payload).length === 0) {
      throw new TrackerError('empty_issue_update', 'updateIssue called with no fields to change');
    }
    const data = await this.request<IssueUpdateResponse>(ISSUE_UPDATE_MUTATION, {
      id: issueId,
      input: payload,
    });
    if (!data?.issueUpdate?.success) {
      throw new TrackerError(
        'linear_issue_update_failed',
        'Linear rejected issueUpdate (success=false)'
      );
    }
  }

  /**
   * Fetch every issue in the configured project (no state filter). Mission
   * Control reads this to populate the bidi kanban; the regular polling loop
   * still uses `fetchCandidateIssues` for dispatch eligibility. Returns the
   * lighter `KanbanIssue` shape (includes state.id needed for drag-to-state
   * mutations).
   */
  async fetchAllIssues(): Promise<KanbanIssue[]> {
    const out: KanbanIssue[] = [];
    let after: string | null = null;
    while (true) {
      const variables: Record<string, unknown> = {
        slug: this.opts.projectSlug,
        first: this.opts.pageSize,
        after,
      };
      const data = await this.request<KanbanPageResponse>(ALL_ISSUES_QUERY, variables);
      const page = data?.issues;
      if (!page?.nodes || !page.pageInfo) {
        throw new TrackerError(
          'linear_unknown_payload',
          'Linear all-issues response missing fields'
        );
      }
      for (const raw of page.nodes) {
        out.push(normalizeKanbanIssue(raw));
      }
      if (!page.pageInfo.hasNextPage) break;
      const cursor = page.pageInfo.endCursor;
      if (!cursor) {
        throw new TrackerError(
          'linear_missing_end_cursor',
          'hasNextPage is true but endCursor is missing'
        );
      }
      after = cursor;
    }
    return out;
  }

  private async resolveProjectIds(): Promise<{ projectId: string; teamId: string }> {
    if (this.projectIds) return this.projectIds;
    const data = await this.request<ProjectTeamResponse>(PROJECT_TEAM_QUERY, {
      slug: this.opts.projectSlug,
    });
    const project = data?.projects?.nodes?.[0];
    if (!project?.id) {
      throw new TrackerError(
        'linear_project_not_found',
        `Linear project not found for slug ${this.opts.projectSlug}`
      );
    }
    const teamId = project.teams?.nodes?.[0]?.id;
    if (!teamId) {
      throw new TrackerError(
        'linear_project_no_team',
        `Linear project ${this.opts.projectSlug} has no associated team`
      );
    }
    this.projectIds = { projectId: project.id, teamId };
    return this.projectIds;
  }

  private async paginate(query: string, states: string[]): Promise<Issue[]> {
    const out: Issue[] = [];
    let after: string | null = null;
    while (true) {
      const variables: Record<string, unknown> = {
        slug: this.opts.projectSlug,
        states,
        first: this.opts.pageSize,
        after,
      };
      const data = await this.request<PageResponse>(query, variables);
      const page = data?.issues;
      if (!page?.nodes || !page.pageInfo) {
        throw new TrackerError(
          'linear_unknown_payload',
          'Linear paginated response missing fields'
        );
      }
      for (const raw of page.nodes) {
        out.push(normalizeLinearIssue(raw));
      }
      if (!page.pageInfo.hasNextPage) break;
      const cursor = page.pageInfo.endCursor;
      if (!cursor) {
        throw new TrackerError(
          'linear_missing_end_cursor',
          'hasNextPage is true but endCursor is missing'
        );
      }
      after = cursor;
    }
    return out;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const signal = AbortSignal.timeout(this.opts.networkTimeoutMs);
    try {
      return (await this.client.request<T>({
        document: query,
        variables,
        signal,
      } as unknown as {
        document: string;
        variables: Record<string, unknown>;
        signal: AbortSignal;
      })) as T;
    } catch (e) {
      if (e instanceof ClientError) {
        const status = e.response?.status ?? 0;
        const errors = e.response?.errors;
        if (errors && errors.length > 0) {
          throw new TrackerError(
            'linear_graphql_errors',
            `Linear GraphQL errors: ${errors.map(er => er.message).join('; ')}`,
            e
          );
        }
        if (status >= 400) {
          throw new TrackerError('linear_api_status', `Linear API returned HTTP ${status}`, e);
        }
      }
      throw new TrackerError(
        'linear_api_request',
        `Linear API request failed: ${(e as Error).message}`,
        e
      );
    }
  }
}
