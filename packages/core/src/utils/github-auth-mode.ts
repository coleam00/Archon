export type GitHubAuthModeDecision =
  | { kind: 'app' }
  | { kind: 'pat' }
  | { kind: 'none' }
  | { kind: 'conflict'; message: string };

/** Runtime activation uses raw env truthiness; setup checks nonblank values before skipping collection. */
export function selectGitHubAuthMode(env: NodeJS.ProcessEnv): GitHubAuthModeDecision {
  const hasGitHubApp = Boolean(
    env.GITHUB_APP_ID &&
    (env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH) &&
    env.WEBHOOK_SECRET
  );
  const hasGitHubPat = Boolean(env.GITHUB_TOKEN && env.WEBHOOK_SECRET);

  if (hasGitHubApp && hasGitHubPat) {
    return {
      kind: 'conflict',
      message:
        'GitHub adapter misconfigured: both App mode (GITHUB_APP_ID) and PAT mode ' +
        '(GITHUB_TOKEN) are configured. Pick one — unset GITHUB_TOKEN for App mode, ' +
        'or unset GITHUB_APP_ID for PAT mode.',
    };
  }
  if (hasGitHubApp) return { kind: 'app' };
  if (hasGitHubPat) return { kind: 'pat' };
  return { kind: 'none' };
}
