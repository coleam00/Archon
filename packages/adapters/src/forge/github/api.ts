/** The GitHub REST boundary shared by this plugin's read and write operations. */

import { z } from 'zod';
import type { ForgeError } from '@archon/forge/operations';
import type { RepoRef } from '@archon/forge';

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class GitHubError extends Error {
  constructor(
    readonly detail: ForgeError,
    /**
     * Whether GitHub decided against the request rather than losing it. A 4xx is
     * GitHub's own answer, so nothing was written; anything else leaves a
     * submitted write's fate unknown.
     */
    readonly definitiveRefusal = false,
    options?: ErrorOptions
  ) {
    super(detail.message, options);
  }
}

export function repositoryPath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts.some(part => part === '' || part === '.' || part === '..')) {
    return null;
  }
  const owner = parts[0];
  const repo = parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1];
  return owner && repo ? { owner, repo } : null;
}

export function apiRoot(host: string): string {
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch (cause) {
    throw new GitHubError(
      { kind: 'invalid_request', message: `Invalid GitHub host: ${host}` },
      true,
      { cause }
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new GitHubError(
      { kind: 'invalid_request', message: `Invalid GitHub host: ${host}` },
      true
    );
  }
  return parsed.hostname.toLowerCase() === 'github.com'
    ? 'https://api.github.com'
    : `https://${parsed.host}/api/v3`;
}

/** The API root and encoded `owner/repo` segment for one qualified repository. */
export function location(repo: RepoRef): { root: string; path: string } {
  const parsed = repositoryPath(repo.path);
  if (!parsed) {
    throw new GitHubError(
      { kind: 'invalid_request', message: `Invalid GitHub repository path: ${repo.path}` },
      true
    );
  }
  return {
    root: apiRoot(repo.host),
    path: `${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
  };
}

/** GraphQL shares the host but not the REST path; only `markPullRequestReadyForReview` needs it. */
export function graphqlEndpoint(root: string): string {
  return root === 'https://api.github.com'
    ? `${root}/graphql`
    : `${root.replace(/\/api\/v3$/, '')}/api/graphql`;
}

/**
 * One GitHub API call.
 *
 * `acknowledge` runs once GitHub has answered with a success status, which is the
 * moment a write stops being merely submitted and becomes one whose effect must
 * be verified rather than guessed at.
 */
export async function githubRequest(
  fetchImpl: Fetch,
  token: string,
  url: string,
  init: RequestInit = {},
  acknowledge?: () => void
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'archon-forge-github',
      },
    });
  } catch (cause) {
    throw new GitHubError({ kind: 'forge_error', message: 'GitHub API request failed' }, false, {
      cause,
    });
  }
  if (!response.ok) {
    throw new GitHubError(
      {
        kind:
          response.status === 404
            ? 'not_found'
            : response.status === 401 || response.status === 403
              ? 'authorization'
              : response.status === 409 || response.status === 422
                ? 'conflict'
                : 'forge_error',
        message: `GitHub API request failed with HTTP ${String(response.status)}`,
        status: response.status,
      },
      response.status >= 400 && response.status < 500
    );
  }
  acknowledge?.();
  try {
    return await response.json();
  } catch (cause) {
    throw new GitHubError(
      { kind: 'forge_error', message: 'GitHub API returned invalid JSON' },
      false,
      { cause }
    );
  }
}

export async function githubPages<T>(
  fetchImpl: Fetch,
  token: string,
  baseUrl: string,
  readPage: (value: unknown) => readonly T[]
): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; ; page++) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const rows = readPage(
      await githubRequest(
        fetchImpl,
        token,
        `${baseUrl}${separator}per_page=100&page=${String(page)}`
      )
    );
    values.push(...rows);
    if (rows.length < 100) return values;
  }
}

export function parseRemote(remote: string | null): RepoRef | null {
  if (remote === null || remote.trim() === '') return null;
  const value = remote.trim();

  if (value.includes('://')) {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause) {
      throw new GitHubError(
        { kind: 'invalid_request', message: 'GitHub remote is not a valid URL' },
        true,
        { cause }
      );
    }
    if (!['https:', 'ssh:'].includes(url.protocol)) return null;
    if (url.password !== '' || (url.protocol === 'https:' && url.username !== '')) {
      throw new GitHubError(
        { kind: 'invalid_request', message: 'GitHub remote must not contain credentials' },
        true
      );
    }
    if (url.search !== '' || url.hash !== '') {
      throw new GitHubError(
        {
          kind: 'invalid_request',
          message: 'GitHub remote must not contain a query or fragment',
        },
        true
      );
    }
    const repository = repositoryPath(decodeURIComponent(url.pathname));
    if (!repository) return null;
    return { host: url.host.toLowerCase(), path: `${repository.owner}/${repository.repo}` };
  }

  // Git's SCP-like SSH form has no URL scheme. Its optional user is transport identity,
  // not an HTTP credential, and is deliberately discarded at this normalization boundary.
  const match = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
  if (!match) return null;
  const repository = repositoryPath(match[2]);
  if (!repository) return null;
  return { host: match[1].toLowerCase(), path: `${repository.owner}/${repository.repo}` };
}

/** Translate a thrown cause into the wire error a caller can act on. */
export function githubErrorDetail(cause: unknown): ForgeError {
  if (cause instanceof GitHubError) return cause.detail;
  if (cause instanceof z.ZodError) {
    return {
      kind: 'forge_error',
      message: `GitHub API response did not match its documented shape: ${cause.issues[0]?.message ?? 'invalid response'}`,
    };
  }
  return {
    kind: 'forge_error',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}
