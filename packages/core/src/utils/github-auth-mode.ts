export const GITHUB_APP_PRIVATE_KEY_KEYS = [
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
] as const;
export const GITHUB_APP_CREDENTIAL_KEYS = [
  'GITHUB_APP_ID',
  ...GITHUB_APP_PRIVATE_KEY_KEYS,
] as const;

export { GH_DOTCOM_TOKEN_KEYS as GITHUB_PAT_KEYS } from '@archon/paths/github-token-env';

export type GitHubAuthModeDecision =
  | { kind: 'app' }
  | { kind: 'pat' }
  | { kind: 'none' }
  | { kind: 'conflict'; message: string };

/** Runtime activation uses raw env truthiness; setup checks nonblank values before skipping collection. */
export function selectGitHubAuthMode(env: NodeJS.ProcessEnv): GitHubAuthModeDecision {
  const hasGitHubApp = Boolean(
    env.GITHUB_APP_ID &&
      GITHUB_APP_PRIVATE_KEY_KEYS.some(key => Boolean(env[key])) &&
      env.WEBHOOK_SECRET
  );
  const hasGitHubPat = Boolean(env.GITHUB_TOKEN && env.WEBHOOK_SECRET);

  const hasAppCredential = GITHUB_APP_CREDENTIAL_KEYS.some(key => Boolean(env[key]));
  if (hasAppCredential && env.GITHUB_TOKEN) {
    return {
      kind: 'conflict',
      message:
        'GitHub adapter misconfigured: both App mode (GITHUB_APP_ID) and PAT mode ' +
        '(GITHUB_TOKEN) are configured. Pick one — unset GITHUB_TOKEN for App mode, ' +
        'or unset GITHUB_APP_ID and its private key for PAT mode.',
    };
  }
  if (hasGitHubApp) return { kind: 'app' };
  if (hasGitHubPat) return { kind: 'pat' };
  return { kind: 'none' };
}
