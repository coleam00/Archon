import type { Octokit } from '@octokit/rest';
import type { GitHubAuth } from '@archon/core';

type CreateCommentArgs = NonNullable<Parameters<Octokit['rest']['issues']['createComment']>[0]>;
type ListCommentsArgs = NonNullable<Parameters<Octokit['rest']['issues']['listComments']>[0]>;
type ListComment = Awaited<ReturnType<Octokit['rest']['issues']['listComments']>>['data'][number];
type ListCommentUser = Pick<NonNullable<ListComment['user']>, 'login'>;
type RepositoryData = Awaited<ReturnType<Octokit['rest']['repos']['get']>>['data'];
type PullRequestData = Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];
type PullRequestHead = Pick<PullRequestData['head'], 'ref' | 'sha'> & {
  repo: Pick<NonNullable<PullRequestData['head']['repo']>, 'full_name'> | null;
};

/** The Octokit REST surface the conversational adapter calls. */
export interface GitHubApi {
  rest: {
    issues: {
      createComment(args: CreateCommentArgs): Promise<unknown>;
      listComments(args: ListCommentsArgs): Promise<{
        data: { body?: ListComment['body'] | null; user?: ListCommentUser | null }[];
      }>;
    };
    repos: {
      get(
        args: NonNullable<Parameters<Octokit['rest']['repos']['get']>[0]>
      ): Promise<{ data: Pick<RepositoryData, 'default_branch'> }>;
    };
    pulls: {
      get(args: NonNullable<Parameters<Octokit['rest']['pulls']['get']>[0]>): Promise<{
        data: {
          head: PullRequestHead;
          base: { repo: Pick<PullRequestData['base']['repo'], 'full_name'> };
        };
      }>;
    };
  };
}

/** Runs one API call with the repository's client, refreshing an App token once on 401. */
export type GitHubApiCall = <T>(
  owner: string,
  repo: string,
  fn: (octokit: GitHubApi) => Promise<T>
) => Promise<T>;

type GitHubAppAuth = Extract<GitHubAuth, { kind: 'app' }>;
export type GitHubAdapterAuth =
  | Exclude<GitHubAuth, { kind: 'app' }>
  | {
      kind: 'app';
      provider: Omit<GitHubAppAuth['provider'], 'getOctokitForInstallation'> & {
        getOctokitForInstallation(owner: string, repo: string): Promise<GitHubApi>;
      };
    };

export interface WebhookEvent {
  action: 'opened' | 'closed' | 'created' | 'edited' | 'reopened' | 'labeled' | (string & {});
  issue?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    labels: { name: string }[];
    state: 'open' | 'closed';
    pull_request?: { url: string }; // Present if the issue is actually a PR
  };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    state: 'open' | 'closed';
    merged?: boolean;
    changed_files?: number;
    additions?: number;
    deletions?: number;
  };
  comment?: {
    /** GitHub's numeric comment id */
    id?: number;
    body: string;
    user: { login: string };
    /** ISO timestamp of the comment's last update; GitHub bumps it on edit */
    updated_at?: string;
  };
  repository?: {
    owner: { login: string };
    name: string;
    full_name: string;
    html_url: string;
    default_branch: string;
  };
  sender: { login: string };
  /**
   * GitHub App webhook deliveries include the installation id on every event.
   * Used to short-circuit the per-(owner, repo) installation lookup in App
   * mode — saves one HTTP round trip per inbound event. Absent on PAT-mode
   * "manual webhook" deliveries; the adapter falls back to the lookup path.
   */
  installation?: { id: number };
}

export interface CheckRunCompletedEvent {
  action: 'completed';
  check_run: {
    status: 'completed';
    conclusion: string;
    completed_at: string;
    pull_requests: { number: number }[];
  };
  repository: { full_name: string };
  sender?: { login: string };
  installation?: { id: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCheckRunCompletedEvent(value: unknown): value is CheckRunCompletedEvent {
  if (!isRecord(value) || value.action !== 'completed') return false;
  const checkRun = value.check_run;
  const repository = value.repository;
  if (!isRecord(checkRun) || !isRecord(repository)) return false;
  if (
    checkRun.status !== 'completed' ||
    typeof checkRun.conclusion !== 'string' ||
    checkRun.conclusion === '' ||
    typeof checkRun.completed_at !== 'string' ||
    !Number.isFinite(Date.parse(checkRun.completed_at)) ||
    typeof repository.full_name !== 'string' ||
    repository.full_name === '' ||
    !Array.isArray(checkRun.pull_requests) ||
    checkRun.pull_requests.length === 0
  ) {
    return false;
  }
  return checkRun.pull_requests.every(
    pullRequest =>
      isRecord(pullRequest) &&
      typeof pullRequest.number === 'number' &&
      Number.isInteger(pullRequest.number) &&
      pullRequest.number > 0
  );
}
