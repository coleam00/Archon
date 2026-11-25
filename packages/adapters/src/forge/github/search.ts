/** `workitem.search`: issues and pull requests in one repository that match free text. */

import { z } from 'zod';
import {
  WORKITEM_SEARCH_DEFAULT_LIMIT,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import { GitHubError, githubRepository, githubRequest, location, type Fetch } from './api';
import { issueSchema, itemRecord } from './workitems';

type SearchRequest = Extract<ForgeRequest, { op: 'workitem.search' }>;
type Kind = NonNullable<SearchRequest['kind']>;

/** GitHub refuses a search query longer than 256 characters. */
const QUERY_CHARS = 256;

const pageSchema = z.object({
  total_count: z.number().int(),
  incomplete_results: z.boolean(),
  items: z.array(
    issueSchema
      .pick({
        number: true,
        repository_url: true,
        html_url: true,
        title: true,
        state: true,
        pull_request: true,
      })
      .extend({ updated_at: z.iso.datetime({ offset: true }) })
  ),
});
type Page = z.infer<typeof pageSchema>;

/**
 * The query for one kind. The text is passed to GitHub's search as written, so its
 * matching, qualifiers included, is GitHub's; a qualifier that reaches another
 * repository fails the read when `itemRecord` meets an item from it.
 */
function searchQuery(request: SearchRequest, kind: Kind): string {
  const { owner, repo } = githubRepository(request.repo);
  const state = request.state ?? 'open';
  const query = [
    `repo:${owner}/${repo}`,
    `is:${kind}`,
    ...(state === 'any' ? [] : [`is:${state}`]),
    request.text,
  ].join(' ');
  if (query.length > QUERY_CHARS)
    throw new GitHubError(
      {
        kind: 'invalid_request',
        message: `GitHub search accepts ${String(QUERY_CHARS)} characters; this search is ${String(query.length)}. Search for fewer words.`,
      },
      true
    );
  return query;
}

async function searchKind(
  request: SearchRequest,
  kind: Kind,
  limit: number,
  fetchImpl: Fetch,
  token: string
): Promise<Page> {
  const { root } = location(request.repo);
  const query = encodeURIComponent(searchQuery(request, kind));
  return pageSchema.parse(
    await githubRequest(
      fetchImpl,
      token,
      `${root}/search/issues?q=${query}&sort=updated&order=desc&per_page=${String(limit)}`
    )
  );
}

export async function handleGithubWorkItemSearch(
  request: SearchRequest,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const limit = request.limit ?? WORKITEM_SEARCH_DEFAULT_LIMIT;
  // GitHub's issue search wants one kind per query, so a search of both asks twice.
  // Each answer holds that kind's most recently updated matches, so the newest
  // `limit` of the two together are the newest overall.
  const pages = await Promise.all(
    (request.kind ? [request.kind] : (['issue', 'pr'] as const)).map(kind =>
      searchKind(request, kind, limit, fetchImpl, token)
    )
  );
  const found = pages
    .flatMap(page => page.items)
    .map(item => ({
      ...itemRecord(request.repo, item),
      title: item.title,
      updatedAt: item.updated_at,
    }))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: {
        repo: request.repo,
        text: request.text,
        items: found.slice(0, limit),
        truncated:
          found.length > limit ||
          pages.some(page => page.incomplete_results || page.total_count > page.items.length),
      },
    },
  };
}
