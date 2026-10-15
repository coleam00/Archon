/**
 * Per-user GitHub token policy for workflow subprocesses.
 *
 * Prevents a workflow run from silently inheriting the shared org (or another
 * user's) GitHub credentials through `process.env`. When per-user GitHub is
 * enabled AND the run was initiated by a specific user, the run's subprocess
 * env is rewritten so:
 *
 *   - User has a personal token → inject it as GH_TOKEN / GITHUB_TOKEN.
 *     COPILOT_GITHUB_TOKEN is always cleared (Copilot is a paid SaaS; an OAuth
 *     token does not grant equivalent access).
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

const SENSITIVE_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'] as const;

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
 *   - appends `credential.helper=` through GIT_CONFIG_COUNT. An empty helper
 *     resets the helper list built from git's config files (osxkeychain, store,
 *     `gh auth git-credential`). Entries already in GIT_CONFIG_COUNT are kept.
 */
function scrubbedGithubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const gitConfigCount = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
  const helperIndex = Number.isInteger(gitConfigCount) && gitConfigCount > 0 ? gitConfigCount : 0;
  return {
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    COPILOT_GITHUB_TOKEN: '',
    GH_CONFIG_DIR: join(tmpdir(), `archon-gh-scrubbed-${randomUUID()}`),
    GIT_CONFIG_COUNT: String(helperIndex + 1),
    [`GIT_CONFIG_KEY_${String(helperIndex)}`]: 'credential.helper',
    [`GIT_CONFIG_VALUE_${String(helperIndex)}`]: '',
  };
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
    return {
      GH_TOKEN: userToken,
      GITHUB_TOKEN: userToken,
      COPILOT_GITHUB_TOKEN: '',
    };
  }

  if (isOrgTokenFallbackAllowed(env)) return {};

  return scrubbedGithubEnv(env);
}

/** Exported for tests + audit logging — never inject these as user data. */
export const GITHUB_TOKEN_KEYS: readonly string[] = SENSITIVE_KEYS;
