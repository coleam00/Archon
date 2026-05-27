/**
 * Multi-user GitHub token policy.
 *
 * Prevents a workflow run from silently inheriting another user's (or the
 * shared org's) GitHub credentials through `process.env`.
 *
 * Multi-user mode is detected by KEYCLOAK_URL being set. When in multi-user
 * mode AND the run was initiated by a specific user (workflow_runs.created_by_user_id
 * is set), the run's subprocess env is rewritten so:
 *
 *   - If the user has a personal GitHub OAuth token: inject it as
 *     GH_TOKEN / GITHUB_TOKEN. COPILOT_GITHUB_TOKEN is always cleared in
 *     this case — Copilot is a paid SaaS and an OAuth token does not grant
 *     equivalent access.
 *
 *   - If the user has NO personal token:
 *       - ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK=true → keep the org token
 *         (legacy behavior — opt-in).
 *       - Otherwise (default) → scrub GH_TOKEN, GITHUB_TOKEN, and
 *         COPILOT_GITHUB_TOKEN so `gh` and `git` cannot authenticate as
 *         the org / another user.
 *
 * Server-initiated runs (no created_by_user_id — e.g. GitHub webhooks, cron,
 * CLI) are NOT scrubbed: those are trusted server-context runs.
 *
 * Single-user mode (KEYCLOAK_URL unset) is NEVER scrubbed — there is no
 * "other user" to leak to.
 */

const SENSITIVE_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'] as const;

export function isMultiUserMode(): boolean {
  return Boolean(process.env.KEYCLOAK_URL);
}

export function isOrgTokenFallbackAllowed(): boolean {
  const v = process.env.ARCHON_ALLOW_ORG_GITHUB_TOKEN_FALLBACK;
  return v === 'true' || v === '1';
}

/**
 * Resolve the GitHub token overrides to apply on top of process.env for a
 * given workflow run.
 *
 * Returned record uses these conventions:
 *   - non-empty string value → set this env var to that value
 *   - empty string ('')      → scrub: remove this env var (or override to '',
 *                              which `gh`/`git` treat the same as unset)
 *   - key absent             → no opinion, inherit from process.env as-is
 *
 * Designed so callers in two different env-construction styles can apply it
 * uniformly: subprocess env builders (where we own the dict and can delete)
 * AND provider `requestOptions.env` (where empty string acts as scrub via
 * the provider's `{ ...process.env, ...requestOptions.env }` merge).
 */
export function resolveGithubTokenOverrides(
  userId: string | null | undefined,
  userToken: string | null | undefined
): Record<string, string> {
  if (!isMultiUserMode()) return {};
  if (!userId) return {}; // server-initiated trusted run

  if (userToken) {
    return {
      GH_TOKEN: userToken,
      GITHUB_TOKEN: userToken,
      COPILOT_GITHUB_TOKEN: '',
    };
  }

  if (isOrgTokenFallbackAllowed()) return {};

  return {
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    COPILOT_GITHUB_TOKEN: '',
  };
}

/**
 * Apply token overrides to an owned ProcessEnv (e.g. a subprocess env we
 * built ourselves). Empty-string overrides delete the key outright (cleaner
 * than passing an empty value to the subprocess).
 */
export function applyGithubTokenOverridesToProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string>
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === '') {
      // Reflect.deleteProperty avoids the `no-dynamic-delete` lint rule
      // and behaves identically to `delete out[k]`.
      Reflect.deleteProperty(out, k);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Exported for tests + audit logging — never inject these as user data. */
export const GITHUB_TOKEN_KEYS: readonly string[] = SENSITIVE_KEYS;
