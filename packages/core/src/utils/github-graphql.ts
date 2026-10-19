/**
 * GitHub GraphQL utilities
 * Used for queries not available in REST API
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@archon/paths';
import { GH_DOTCOM_TOKEN_KEYS, ghTokenKeysForHost } from '@archon/paths/github-token-env';
import { resolveGitHubTokenFromEnv } from '../github-auth/config';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('github-graphql');
  return cachedLog;
}

const execFileAsync = promisify(execFile);

/**
 * gh reads an Enterprise Server host's token from its Enterprise keys, not from
 * GH_TOKEN/GITHUB_TOKEN. Hand it the same PAT, unless the operator set one.
 */
function ghEnv(hostname: string): NodeJS.ProcessEnv | undefined {
  const keys = ghTokenKeysForHost(hostname);
  const token = resolveGitHubTokenFromEnv();
  if (keys === GH_DOTCOM_TOKEN_KEYS || !token || keys.some(key => process.env[key])) {
    return undefined;
  }
  return { ...process.env, GH_ENTERPRISE_TOKEN: token };
}

/**
 * Get issue numbers that will be closed when a PR is merged
 * Uses "closingIssuesReferences" from GraphQL API
 *
 * @returns Array of issue numbers linked via closing keywords (fixes, closes, etc.)
 */
export async function getLinkedIssueNumbers(
  owner: string,
  repo: string,
  prNumber: number,
  hostname: string
): Promise<number[]> {
  const query = `
    query ($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          closingIssuesReferences(first: 10) {
            nodes { number }
          }
        }
      }
    }
  `;

  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        'graphql',
        '--hostname',
        hostname,
        '-F',
        `owner=${owner}`,
        '-F',
        `repo=${repo}`,
        '-F',
        `pr=${String(prNumber)}`,
        '-f',
        `query=${query}`,
        '--jq',
        '.data.repository.pullRequest.closingIssuesReferences.nodes[].number',
      ],
      { timeout: 10000, env: ghEnv(hostname) }
    );

    // Parse output: each line is an issue number
    return stdout
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => parseInt(line, 10))
      .filter(num => !isNaN(num));
  } catch (error) {
    // GraphQL query failed (no token, network issue, etc.)
    // Gracefully return empty - we'll create a new worktree
    getLog().warn({ err: error, owner, repo, prNumber }, 'linked_issues_fetch_failed');
    return [];
  }
}
