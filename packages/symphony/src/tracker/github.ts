import { Octokit } from '@octokit/rest';
import { createLogger } from '@archon/paths';
import type { CommentOnIssueInput, CreateIssueInput, Issue, Tracker } from './types';
import { TrackerError } from './errors';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('symphony.tracker.github');
  return cachedLog;
}

export interface GitHubTrackerOptions {
  owner: string;
  repo: string;
  token: string;
  /** Issue states the orchestrator considers active. Typically `['open']`. */
  activeStates: string[];
  /** Issue states the orchestrator considers terminal. Typically `['closed']`. */
  terminalStates: string[];
  /** Optional Octokit override (test injection). */
  octokit?: Octokit;
}

interface RawGitHubIssue {
  id: number;
  node_id: string;
  number: number;
  title: string | null;
  body: string | null;
  state: string;
  html_url: string | null;
  labels: (string | { name?: string | null } | null)[];
  pull_request?: unknown;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * GitHubTracker adapts a single `owner/repo` pair to the Symphony Tracker
 * interface. Uses the REST API (issues.listForRepo / issues.get). Pull
 * requests are filtered out — Symphony dispatches against issues only.
 *
 * Identifier shape: `${owner}/${repo}#${number}`. The orchestrator forms
 * `dispatch_key = github:<identifier>`, matching the Phase 1 DB unique-key
 * convention.
 */
export class GitHubTracker implements Tracker {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly activeStates: string[];
  /** Retained for the orchestrator's tracker-config introspection — see snapshot.ts. */
  readonly terminalStates: string[];

  constructor(opts: GitHubTrackerOptions) {
    if (!opts.owner || !opts.repo) {
      throw new TrackerError(
        'missing_tracker_owner_repo',
        'GitHubTracker: owner and repo are required'
      );
    }
    if (!opts.token && !opts.octokit) {
      throw new TrackerError(
        'missing_tracker_token',
        'GitHubTracker: token is required (or pass an Octokit instance)'
      );
    }
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.activeStates = opts.activeStates;
    this.terminalStates = opts.terminalStates;
    this.octokit = opts.octokit ?? new Octokit({ auth: opts.token });
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    if (this.activeStates.length === 0) return [];
    return this.fetchIssuesByStates(this.activeStates);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    const out: Issue[] = [];
    for (const state of this.normalizeStateNames(stateNames)) {
      try {
        const iter = this.octokit.paginate.iterator(this.octokit.rest.issues.listForRepo, {
          owner: this.owner,
          repo: this.repo,
          state,
          per_page: 100,
        });
        for await (const page of iter) {
          for (const raw of page.data) {
            if (raw.pull_request) continue;
            out.push(this.normalize(raw as unknown as RawGitHubIssue));
          }
        }
      } catch (e) {
        throw new TrackerError(
          'github_api_request',
          `GitHub listForRepo failed: ${(e as Error).message}`,
          e
        );
      }
    }
    return out;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const out: Issue[] = [];
    const nodeIds: string[] = [];

    // Split inputs: numeric / `owner/repo#N` go through REST; everything else
    // (notably GitHub GraphQL node IDs like `I_kwDO…`, which is what Issue.id
    // returns) is batched into a single GraphQL `nodes()` lookup.
    for (const id of ids) {
      const number = this.parseIssueNumber(id);
      if (number === null) {
        nodeIds.push(id);
        continue;
      }
      try {
        const res = await this.octokit.rest.issues.get({
          owner: this.owner,
          repo: this.repo,
          issue_number: number,
        });
        if (res.data.pull_request) continue;
        out.push(this.normalize(res.data as unknown as RawGitHubIssue));
      } catch (e) {
        const err = e as Error & { status?: number };
        if (err.status === 404) {
          getLog().warn(
            { owner: this.owner, repo: this.repo, number },
            'symphony.github.issue_not_found'
          );
          continue;
        }
        throw new TrackerError('github_api_request', `GitHub issues.get failed: ${err.message}`, e);
      }
    }

    if (nodeIds.length > 0) {
      try {
        const data = await this.octokit.graphql<GraphqlNodesResponse>(GRAPHQL_NODES_QUERY, {
          ids: nodeIds,
        });
        for (const node of data.nodes ?? []) {
          if (!isGraphqlIssueNode(node)) continue;
          out.push(
            this.normalize({
              id: node.databaseId ?? 0,
              node_id: node.id,
              number: node.number,
              title: node.title,
              body: node.body,
              // GraphQL returns 'OPEN'/'CLOSED'; REST returns 'open'/'closed'.
              // Lowercase here so isStateActive() comparisons remain consistent.
              state: typeof node.state === 'string' ? node.state.toLowerCase() : '',
              html_url: node.url,
              labels: (node.labels?.nodes ?? []).map(l => l?.name ?? null),
              created_at: node.createdAt,
              updated_at: node.updatedAt,
            })
          );
        }
      } catch (e) {
        throw new TrackerError(
          'github_api_request',
          `GitHub graphql nodes failed: ${(e as Error).message}`,
          e
        );
      }
    }
    return out;
  }

  async createIssue(_input: CreateIssueInput): Promise<Issue> {
    throw new TrackerError(
      'github_unsupported_operation',
      'GitHubTracker.createIssue not supported in v1'
    );
  }

  async commentOnIssue(_input: CommentOnIssueInput): Promise<{ id: string }> {
    throw new TrackerError(
      'github_unsupported_operation',
      'GitHubTracker.commentOnIssue not supported in v1'
    );
  }

  /**
   * Accepts ids as `owner/repo#NN`, plain `NN`, or the full identifier; returns
   * the issue number or null if unparseable.
   */
  private parseIssueNumber(id: string): number | null {
    const trimmed = id.trim();
    if (!trimmed) return null;
    const hashIdx = trimmed.lastIndexOf('#');
    const tail = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : trimmed;
    const n = Number(tail);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  private normalizeStateNames(stateNames: string[]): ('open' | 'closed' | 'all')[] {
    const out: ('open' | 'closed' | 'all')[] = [];
    let sawOpen = false;
    let sawClosed = false;
    for (const s of stateNames) {
      const lower = s.toLowerCase();
      if (lower === 'open') sawOpen = true;
      else if (lower === 'closed') sawClosed = true;
      else if (lower === 'all') return ['all'];
    }
    if (sawOpen && sawClosed) return ['all'];
    if (sawOpen) out.push('open');
    if (sawClosed) out.push('closed');
    return out;
  }

  private normalize(raw: RawGitHubIssue): Issue {
    const labels: string[] = [];
    for (const lbl of raw.labels ?? []) {
      if (typeof lbl === 'string') labels.push(lbl.toLowerCase());
      else if (lbl && typeof lbl.name === 'string') labels.push(lbl.name.toLowerCase());
    }
    return {
      id: raw.node_id,
      identifier: `${this.owner}/${this.repo}#${raw.number}`,
      title: typeof raw.title === 'string' ? raw.title : '',
      description: typeof raw.body === 'string' ? raw.body : null,
      priority: null,
      state: typeof raw.state === 'string' ? raw.state : '',
      branch_name: null,
      url: typeof raw.html_url === 'string' ? raw.html_url : null,
      labels,
      blocked_by: [],
      created_at: parseDate(raw.created_at),
      updated_at: parseDate(raw.updated_at),
    };
  }
}

function parseDate(input: string | null | undefined): Date | null {
  if (typeof input !== 'string') return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

const GRAPHQL_NODES_QUERY = `
  query SymphonyIssueNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Issue {
        id
        databaseId
        number
        title
        body
        state
        url
        labels(first: 50) { nodes { name } }
        createdAt
        updatedAt
      }
    }
  }
`;

interface GraphqlIssueNode {
  __typename: 'Issue';
  id: string;
  databaseId: number | null;
  number: number;
  title: string | null;
  body: string | null;
  state: string;
  url: string | null;
  labels: { nodes: ({ name: string | null } | null)[] } | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface GraphqlNodesResponse {
  nodes: (GraphqlIssueNode | { __typename: string } | null)[];
}

function isGraphqlIssueNode(
  node: GraphqlIssueNode | { __typename: string } | null
): node is GraphqlIssueNode {
  return node !== null && node.__typename === 'Issue';
}
