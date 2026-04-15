/**
 * GitHub GraphQL utilities
 * Used for queries not available in REST API
 */
import { execGhWithAuthPolicy } from '@archon/git';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('github-graphql');
  return cachedLog;
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
  prNumber: number
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
    const { stdout } = await execGhWithAuthPolicy(
      [
        'api',
        'graphql',
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
      {
        preference: 'prefer-stored',
        timeoutMs: 10_000,
      }
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
