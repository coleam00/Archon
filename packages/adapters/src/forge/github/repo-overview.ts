/** `repo.overview`: one repository's facts, counts and newest open items, in one GraphQL call. */

import { z } from 'zod';
import {
  REPO_OVERVIEW_DEFAULT_LIMIT,
  type ForgeRequest,
  type ForgeResponse,
  type RepoOverview,
} from '@archon/forge/operations';
import { GRAPHQL_ACTOR_FIELDS, graphqlActor, graphqlActorSchema } from './actor';
import {
  GitHubError,
  githubGraphqlDocument,
  githubGraphqlRefusal,
  githubRepository,
  type Fetch,
} from './api';

type OverviewRequest = Extract<ForgeRequest, { op: 'repo.overview' }>;
type Stat = keyof RepoOverview['stats'];
interface StatList {
  /** The repository page that lists the matches. */
  page: 'issues' | 'pulls';
  qualifiers: string;
}

/** The label a repository marks its bugs with; one without it reports no bug count. */
const BUG_LABEL = 'bug';

/** The stats counted for the account the token acts as, which not every token has. */
const actorStats = [
  'issues_assigned_to_actor',
  'prs_review_requested_from_actor',
] as const satisfies readonly Stat[];

/**
 * Each stat as GitHub search qualifiers. `actor` is `@me` in the query that counts, and the
 * account's login in the link, so the link shows the counted list to whoever opens it.
 */
function statLists(since: string, actor: string): Record<Stat, StatList> {
  return {
    issues_open: { page: 'issues', qualifiers: 'is:issue is:open' },
    issues_unlabeled: { page: 'issues', qualifiers: 'is:issue is:open no:label' },
    issues_bugs: { page: 'issues', qualifiers: `is:issue is:open label:${BUG_LABEL}` },
    issues_assigned_to_actor: {
      page: 'issues',
      qualifiers: `is:issue is:open assignee:${actor}`,
    },
    prs_open: { page: 'pulls', qualifiers: 'is:pr is:open' },
    prs_draft: { page: 'pulls', qualifiers: 'is:pr is:open draft:true' },
    prs_review_requested_from_actor: {
      page: 'pulls',
      qualifiers: `is:pr is:open review-requested:${actor}`,
    },
    prs_merged_since: { page: 'pulls', qualifiers: `is:pr is:merged merged:>=${since}` },
    issues_closed_since: { page: 'issues', qualifiers: `is:issue is:closed closed:>=${since}` },
  };
}
const stats = Object.keys(statLists('', '')) as Stat[];
const isActorStat = (stat: Stat): boolean => (actorStats as readonly Stat[]).includes(stat);

const ITEM_FIELDS = `number title url updatedAt author{${GRAPHQL_ACTOR_FIELDS}} labels(first:20){nodes{name}}`;
const NEWEST = 'states:OPEN,first:$limit,orderBy:{field:UPDATED_AT,direction:DESC}';
const QUERY = `query($owner:String!,$name:String!,$limit:Int!,$actor:Boolean!,${stats
  .map(stat => `$${stat}:String!`)
  .join(',')}){
  viewer @include(if:$actor){login}
  repository(owner:$owner,name:$name){
    nameWithOwner description url stargazerCount forkCount
    defaultBranchRef{name}
    latestRelease{tagName url}
    bugLabel:label(name:"${BUG_LABEL}"){name}
    pullRequests(${NEWEST}){nodes{${ITEM_FIELDS} isDraft}}
    issues(${NEWEST}){nodes{${ITEM_FIELDS}}}
  }
  ${stats
    .map(
      stat =>
        `${stat}:search(query:$${stat},type:ISSUE,first:1)${isActorStat(stat) ? ' @include(if:$actor)' : ''}{issueCount}`
    )
    .join('\n  ')}
}`;

const itemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url(),
  updatedAt: z.iso.datetime({ offset: true }),
  author: graphqlActorSchema,
  labels: z.object({ nodes: z.array(z.object({ name: z.string().min(1) })) }).nullable(),
});
const countSchema = z.object({ issueCount: z.number().int().nonnegative() });
const overviewSchema = z.object({
  viewer: z.object({ login: z.string().min(1) }).optional(),
  repository: z
    .object({
      nameWithOwner: z.string().min(1),
      description: z.string().nullable(),
      url: z.url(),
      stargazerCount: z.number().int().nonnegative(),
      forkCount: z.number().int().nonnegative(),
      defaultBranchRef: z.object({ name: z.string().min(1) }).nullable(),
      latestRelease: z.object({ tagName: z.string().min(1), url: z.url() }).nullable(),
      bugLabel: z.object({ name: z.string() }).nullable(),
      pullRequests: z.object({ nodes: z.array(itemSchema.extend({ isDraft: z.boolean() })) }),
      issues: z.object({ nodes: z.array(itemSchema) }),
    })
    .nullable(),
  // Only the account's own counts may be missing: the query leaves them out for a token
  // with no user account.
  ...(Object.fromEntries(
    stats.map(stat => [stat, isActorStat(stat) ? countSchema.optional() : countSchema])
  ) as Record<Stat, z.ZodOptional<typeof countSchema>>),
});
type Overview = z.infer<typeof overviewSchema>;

/** GitHub's search takes a time to the second; the request's offset becomes UTC. */
function searchTime(since: string): string {
  return new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The overview, without the account's own facts when the token has no user account to
 * ask them for (a GitHub App installation token). GitHub says so with an error on
 * `viewer` or on a search for `@me`, which fails the whole document, so the read is
 * repeated once without those fields. Any other error refuses the read.
 */
async function readOverview(
  request: OverviewRequest,
  fetchImpl: Fetch,
  token: string,
  actor = true
): Promise<Overview> {
  const { owner, repo } = githubRepository(request.repo);
  const lists = statLists(searchTime(request.since), '@me');
  const { data, errors } = await githubGraphqlDocument(fetchImpl, token, request.repo, QUERY, {
    owner,
    name: repo,
    limit: request.limit ?? REPO_OVERVIEW_DEFAULT_LIMIT,
    actor,
    ...Object.fromEntries(
      stats.map(stat => [stat, `repo:${owner}/${repo} ${lists[stat].qualifiers}`])
    ),
  });
  if (errors.length === 0) return overviewSchema.parse(data);
  const actorFields: readonly unknown[] = ['viewer', ...actorStats];
  if (actor && errors.every(error => actorFields.includes(error.path?.[0])))
    return readOverview(request, fetchImpl, token, false);
  throw githubGraphqlRefusal(errors);
}

export async function handleGithubRepoOverview(
  request: OverviewRequest,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const overview = await readOverview(request, fetchImpl, token);
  const repository = overview.repository;
  if (!repository)
    throw new GitHubError(
      { kind: 'not_found', message: `GitHub has no repository ${request.repo.path}` },
      true
    );
  const login = overview.viewer?.login;
  const lists = statLists(searchTime(request.since), login ?? '@me');
  const item = (kind: 'issue' | 'pr', node: z.infer<typeof itemSchema>) => ({
    ref: { repo: request.repo, number: node.number },
    kind,
    url: node.url,
    state: 'open' as const,
    title: node.title,
    updatedAt: node.updatedAt,
    author: graphqlActor(request.repo.host, node.author),
    labels: (node.labels?.nodes ?? []).map(label => label.name),
  });
  const value: RepoOverview = {
    repo: request.repo,
    since: request.since,
    url: repository.url,
    name: repository.nameWithOwner,
    description: repository.description,
    stars: repository.stargazerCount,
    forks: repository.forkCount,
    ...(repository.defaultBranchRef ? { default_branch: repository.defaultBranchRef.name } : {}),
    latest_release: repository.latestRelease && {
      name: repository.latestRelease.tagName,
      url: repository.latestRelease.url,
    },
    ...(login === undefined ? {} : { actor: { login } }),
    stats: Object.fromEntries(
      stats.flatMap(stat => {
        const counted = overview[stat];
        if (counted === undefined || (stat === 'issues_bugs' && repository.bugLabel === null))
          return [];
        const { page, qualifiers } = lists[stat];
        const url = `${repository.url}/${page}?q=${encodeURIComponent(qualifiers)}`;
        return [[stat, { count: counted.issueCount, url }]];
      })
    ),
    pull_requests: repository.pullRequests.nodes.map(node => ({
      ...item('pr', node),
      is_draft: node.isDraft,
    })),
    issues: repository.issues.nodes.map(node => item('issue', node)),
  };
  return { operationId: request.operationId, ok: true, result: { op: request.op, value } };
}
