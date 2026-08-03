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
 *       - Otherwise (default) → scrub GH_TOKEN / GITHUB_TOKEN /
 *         COPILOT_GITHUB_TOKEN so `gh` and `git` cannot authenticate as the
 *         org / another user.
 *
 * Server-initiated runs (no originating userId — GitHub webhooks, cron, CLI)
 * are NOT scrubbed: trusted server context. Per-user mode disabled (solo PAT
 * installs) is NEVER scrubbed — there is no "other user" to leak to.
 *
 * Adapted from the #1774 donor: the KEYCLOAK_URL mode-detector is replaced by an
 * injected `perUserEnabled` flag (resolved from `isPerUserGitHubEnabled()` at
 * the call site) so this module stays pure and dependency-free.
 */

const SENSITIVE_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'] as const;

export function isOrgTokenFallbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK;
  return v === 'true' || v === '1';
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

  return {
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    COPILOT_GITHUB_TOKEN: '',
  };
}

/**
 * Apply token overrides to an owned ProcessEnv (a subprocess env we built
 * ourselves). Empty-string overrides delete the key outright — cleaner than
 * passing an empty value when we control the dict.
 */
export function applyGithubTokenOverridesToProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === '') {
      Reflect.deleteProperty(out, k);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Exported for tests + audit logging — never inject these as user data. */
export const GITHUB_TOKEN_KEYS: readonly string[] = SENSITIVE_KEYS;
