/**
 * Per-user GitHub token policy for workflow subprocesses.
 *
 * Prevents a workflow run from silently inheriting the shared org (or another
 * user's) GitHub credentials through `process.env`. When per-user GitHub is
 * enabled, the run's subprocess env is rewritten so:
 *
 *   - User has a personal token → inject it as GH_TOKEN / GITHUB_TOKEN.
 *     COPILOT_GITHUB_TOKEN is always cleared (Copilot is a paid SaaS; an OAuth
 *     token does not grant equivalent access).
 *   - User has NO personal token (or userId is absent) → scrub GH_TOKEN /
 *     GITHUB_TOKEN / COPILOT_GITHUB_TOKEN so `gh` and `git` cannot
 *     authenticate as the org / another user.
 *
 * Per-user mode disabled (solo PAT installs) is NEVER scrubbed — there is no
 * "other user" to leak to.
 *
 * Adapted from the #1774 donor: the KEYCLOAK_URL mode-detector is replaced by an
 * injected `perUserEnabled` flag (resolved from `isPerUserGitHubEnabled()` at
 * the call site) so this module stays pure and dependency-free.
 */

const SENSITIVE_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'] as const;

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
  _userId: string | null | undefined,
  userToken: string | null | undefined
): Record<string, string> {
  if (!perUserEnabled) return {};
  // Intentionally no !_userId bail-out: when per-user mode is on, server-initiated
  // runs (cron, CLI) with no userId get tokens scrubbed too. All execution paths
  // that reach here without a userId are expected to have been gated earlier
  // (webhook handler resolves userId or rejects; run-start 403 gate checks token).

  if (userToken) {
    return {
      GH_TOKEN: userToken,
      GITHUB_TOKEN: userToken,
      COPILOT_GITHUB_TOKEN: '',
    };
  }

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

/**
 * Secrets that must NEVER reach an agent/bash/provider subprocess.
 * TOKEN_ENCRYPTION_KEY can decrypt user tokens from the vault. WEBHOOK_SECRET
 * is the HMAC key that verifies inbound GitHub webhooks; an agent that can
 * read it can forge signed events and POST them to the server's local webhook
 * endpoint. DATABASE_URL gives full DB access. Agents authenticate through
 * the injected short-lived GH_TOKEN / GITHUB_TOKEN and the per-worktree git
 * credential helper; they never need — and must never see — these.
 */
export const AGENT_ENV_DENYLIST: readonly string[] = [
  'TOKEN_ENCRYPTION_KEY',
  'DATABASE_URL',
  'WEBHOOK_SECRET',
];

/**
 * Return a copy of `env` with every AGENT_ENV_DENYLIST key removed. Apply this
 * to the base env of every subprocess we spawn that could run agent/model/bash
 * code, BEFORE layering on the run's own overrides (GH_TOKEN, ARTIFACTS_DIR, …).
 */
export function scrubAgentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of AGENT_ENV_DENYLIST) {
    Reflect.deleteProperty(out, k);
  }
  return out;
}
