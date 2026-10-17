/**
 * Per-user GitHub token policy for workflow subprocesses.
 *
 * Prevents a workflow run from silently inheriting the shared org (or another
 * user's) GitHub credentials through `process.env`. When per-user GitHub is
 * enabled AND the run was initiated by a specific user, the run's subprocess
 * env is rewritten so:
 *
 *   - User has a personal token → inject it as GH_TOKEN / GITHUB_TOKEN.
 *     COPILOT_GITHUB_TOKEN and the GitHub Enterprise token keys are always
 *     cleared (Copilot is a paid SaaS; an OAuth token does not grant equivalent
 *     access, and the host's GHES token is not the user's).
 *   - User has NO personal token:
 *       - ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK=true → keep the org token
 *         (legacy behavior — opt-in).
 *       - Otherwise (default) → scrub, so `gh` and `git` cannot authenticate as
 *         the org, the operator, or another user (see {@link scrubbedGithubEnv}).
 *
 * Server-initiated runs (no originating userId — GitHub webhooks, cron, CLI)
 * are NOT scrubbed: trusted server context. Per-user mode disabled (solo PAT
 * installs) is NEVER scrubbed — there is no "other user" to leak to.
 *
 * Adapted from the #1774 donor: the KEYCLOAK_URL mode-detector is replaced by an
 * injected `perUserEnabled` flag (resolved from `isPerUserGitHubEnabled()` at
 * the call site) so this module stays pure and dependency-free.
 */
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GH_DOTCOM_TOKEN_KEYS, GH_ENTERPRISE_TOKEN_KEYS } from '@archon/paths/github-token-env';

/**
 * Every env var gh reads a token from: github.com, GitHub Enterprise Server, and
 * Copilot. A per-user run sets each one itself, so none of the host's reaches it.
 */
const SENSITIVE_KEYS = [
  ...GH_DOTCOM_TOKEN_KEYS,
  ...GH_ENTERPRISE_TOKEN_KEYS,
  'COPILOT_GITHUB_TOKEN',
] as const;

/** Where the scrub sends gh and git instead of the host's stored logins. */
const STORED_LOGIN_KEYS = ['GH_CONFIG_DIR', 'GIT_CONFIG_PARAMETERS'] as const;

const clearedTokens = (): Record<string, string> =>
  Object.fromEntries(SENSITIVE_KEYS.map(key => [key, '']));

export function isOrgTokenFallbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK;
  return v === 'true' || v === '1';
}

/**
 * The scrub for a per-user run with no personal token.
 *
 * Emptying the token keys is not enough on its own: `gh` treats an empty GH_TOKEN
 * as unset and falls back to the host's stored login (hosts.yml or the keyring),
 * and git reaches that login, or another stored one, through its credential
 * helpers. So the scrub also:
 *
 *   - points GH_CONFIG_DIR at a path that does not exist. gh then finds no host
 *     login and does not create the directory on read. The path is unique per
 *     resolution, so a run that logs in there cannot hand that login to another
 *     user's run.
 *   - appends `credential.helper=` to GIT_CONFIG_PARAMETERS, the variable git
 *     itself uses to pass `-c` settings to child processes. An empty helper resets
 *     the helper list built from git's config files (osxkeychain, store,
 *     `gh auth git-credential`). Settings already in it are kept. GIT_CONFIG_COUNT
 *     would also work for git, but Codex drops env vars whose names contain `KEY`
 *     from its shells, which would leave a count with no `GIT_CONFIG_KEY_0` and
 *     break every git command there.
 *
 * An existing GIT_CONFIG_PARAMETERS in the host environment (`env`) is kept. A
 * codebase env entry for it is replaced: it is git's internal channel, not
 * project configuration.
 */
function scrubbedGithubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const gitParameters = env.GIT_CONFIG_PARAMETERS?.trim();
  // Typed by STORED_LOGIN_KEYS, so the redirects and the list `loadCliEnv` protects
  // cannot drift apart: a missing or extra key fails to compile.
  const redirects: Record<(typeof STORED_LOGIN_KEYS)[number], string> = {
    GH_CONFIG_DIR: join(tmpdir(), `archon-gh-scrubbed-${randomUUID()}`),
    GIT_CONFIG_PARAMETERS: `${gitParameters ? `${gitParameters} ` : ''}'credential.helper='`,
  };
  return { ...clearedTokens(), ...redirects };
}

/**
 * Resolve the GitHub token overrides to apply on top of process.env for a run.
 *
 * Conventions:
 *   - non-empty value → set this env var
 *   - empty string '' → scrub: `gh`/`git` treat an empty value the same as unset
 *   - key absent      → no opinion; inherit from process.env as-is
 *
 * Empty-string scrub composes with both env-construction styles: subprocess env
 * builders (which spread `...process.env, ...overrides`, so '' wins over the org
 * token) and AI-provider `requestOptions.env` (same merge semantics).
 */
export function resolveGithubTokenOverrides(
  perUserEnabled: boolean,
  userId: string | null | undefined,
  userToken: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (!perUserEnabled) return {};
  if (!userId) return {}; // server-initiated trusted run

  if (userToken) {
    return { ...clearedTokens(), GH_TOKEN: userToken, GITHUB_TOKEN: userToken };
  }

  if (isOrgTokenFallbackAllowed(env)) return {};

  return scrubbedGithubEnv(env);
}

/** Exported for tests + audit logging — never inject these as user data. */
export const GITHUB_TOKEN_KEYS: readonly string[] = SENSITIVE_KEYS;

/**
 * Every key that carries a run's GitHub identity: the tokens and the scrub's
 * stored-login redirects. Inside a run, Archon's env files must not replace any of
 * them (see `loadCliEnv`). Only the token keys are secrets.
 */
export const RUN_GITHUB_IDENTITY_KEYS: readonly string[] = [
  ...SENSITIVE_KEYS,
  ...STORED_LOGIN_KEYS,
];
