// The one owner of the GitHub host rule: github.com's API lives at
// api.github.com, a GitHub Enterprise Server's at `<origin>/api/v3`.

/** A GitHub host: github.com, or a GitHub Enterprise Server. */
export interface GitHubHost {
  /** Lowercased authority (`host[:port]`) of the web URL. */
  host: string;
  /** Web root without a trailing slash, e.g. `https://github.com`. */
  webUrl: string;
  /** REST API root: `https://api.github.com`, or `<webUrl>/api/v3` on GHES. */
  apiBaseUrl: string;
  /** GraphQL endpoint: `https://api.github.com/graphql`, or `<webUrl>/api/graphql` on GHES. */
  graphqlUrl: string;
}

export const GITHUB_COM_HOST: GitHubHost = {
  host: 'github.com',
  webUrl: 'https://github.com',
  apiBaseUrl: 'https://api.github.com',
  graphqlUrl: 'https://api.github.com/graphql',
};

/**
 * The GitHub host at a bare http(s) origin such as `https://github.example.com`.
 * Returns null for anything else (credentials, a path, a query, a fragment).
 */
export function parseGitHubHost(origin: string): GitHubHost | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  if (url.hostname === GITHUB_COM_HOST.host) return GITHUB_COM_HOST;
  const host = url.host.toLowerCase();
  const webUrl = `${url.protocol}//${host}`;
  return { host, webUrl, apiBaseUrl: `${webUrl}/api/v3`, graphqlUrl: `${webUrl}/api/graphql` };
}

/**
 * The GitHub host `GITHUB_URL` names (GitHub Enterprise Server only). Unset,
 * empty, or github.com means github.com; a value that is not a bare http(s)
 * origin returns null. Paths that also serve other forges (clone credentials,
 * forge detection) skip a null and fall through to the other forges' rules.
 */
export function readGitHubHost(env: NodeJS.ProcessEnv = process.env): GitHubHost | null {
  const raw = env.GITHUB_URL?.trim();
  return raw ? parseGitHubHost(raw) : GITHUB_COM_HOST;
}

/**
 * The GitHub host Archon talks to, for paths bound to GitHub. An invalid
 * `GITHUB_URL` throws, so a typo fails clearly instead of silently sending
 * every call, and every token, to github.com. The value is not echoed: it may
 * carry credentials.
 */
export function resolveGitHubHost(env: NodeJS.ProcessEnv = process.env): GitHubHost {
  const github = readGitHubHost(env);
  if (!github) {
    throw new Error(
      'GITHUB_URL must be the base URL of a GitHub Enterprise Server, e.g. https://github.example.com, with no path, query or credentials.'
    );
  }
  return github;
}
