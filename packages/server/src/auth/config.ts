/**
 * Boot-time configuration helpers for opt-in web authentication (Better Auth).
 *
 * Web auth is a forge-agnostic login layer mounted in the Hono server at
 * `/api/auth/*`. It is OFF by default: enabled only when BOTH a Postgres
 * `DATABASE_URL` and a `BETTER_AUTH_SECRET` are present. SQLite/solo installs
 * (no `DATABASE_URL`) can never enable it — Better Auth's tables are
 * Postgres-only here. When disabled, `getAuth()` (in ./instance) returns null
 * and every auth code path is a no-op, leaving today's behavior unchanged.
 *
 * MIRRORS the per-user GitHub gate in packages/core/src/github-auth/config.ts
 * (`isPerUserGitHubEnabled` / `assertEncryptionKeyAtBoot`).
 *
 * These helpers are intentionally pure (no Better Auth / pg imports) so they can
 * be unit-tested without constructing a database-backed auth instance.
 */

/** Minimum length for BETTER_AUTH_SECRET (matches `openssl rand -base64 32`). */
export const MIN_BETTER_AUTH_SECRET_LENGTH = 32;

/**
 * Web auth is active only when a Postgres connection AND a signing secret are
 * configured. SQLite installs (no DATABASE_URL) are always opted out.
 */
export function isWebAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DATABASE_URL && env.BETTER_AUTH_SECRET);
}

/**
 * Fail fast at server boot: when web auth is enabled, the signing secret must be
 * long enough to be a real secret. A short/placeholder secret would let an
 * attacker forge sessions, so we throw with an actionable hint rather than
 * silently mounting auth on a weak key.
 */
export function assertWebAuthAtBoot(env: NodeJS.ProcessEnv = process.env): void {
  if (!isWebAuthEnabled(env)) return;
  const secret = env.BETTER_AUTH_SECRET ?? '';
  if (secret.length < MIN_BETTER_AUTH_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET must be at least ${String(MIN_BETTER_AUTH_SECRET_LENGTH)} characters ` +
        'when web auth is enabled. Generate one with: openssl rand -base64 32'
    );
  }
}

/**
 * Parse the signup allowlist from `ARCHON_AUTH_ALLOWED_EMAILS` (comma-separated,
 * lowercased, trimmed, blanks dropped). An empty/unset list does NOT mean open
 * signup — see `getSignupMode` (empty defaults to `disabled` unless
 * `ARCHON_AUTH_OPEN_SIGNUP=true`).
 */
export function parseAllowedEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ARCHON_AUTH_ALLOWED_EMAILS ?? '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Decide whether an email may sign up given a parsed allowlist.
 * Empty allowlist → open (any email allowed). Non-empty → strict membership.
 */
export function isEmailAllowed(email: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.includes(email.trim().toLowerCase());
}

/**
 * Signup posture surfaced to the web UI (`GET /api/auth/status`) and used to set
 * Better Auth's `disableSignUp`:
 *   - `allowlist` — `ARCHON_AUTH_ALLOWED_EMAILS` set → invite-gated.
 *   - `open`      — no allowlist but `ARCHON_AUTH_OPEN_SIGNUP=true` → anyone may register.
 *   - `disabled`  — no allowlist and no open flag → signup off (login only).
 * The default is `disabled`, so enabling web auth without an allowlist never
 * silently exposes open public registration on a reachable URL.
 *
 * Precedence: a non-empty allowlist wins over `ARCHON_AUTH_OPEN_SIGNUP` — set
 * both and the mode is `allowlist` (the invite gate, not open signup).
 */
export function getSignupMode(
  env: NodeJS.ProcessEnv = process.env
): 'allowlist' | 'open' | 'disabled' {
  if (parseAllowedEmails(env).length > 0) return 'allowlist';
  return env.ARCHON_AUTH_OPEN_SIGNUP === 'true' ? 'open' : 'disabled';
}

/**
 * Whether enabling web auth also gates the API server-side: every `/api/*`
 * request must resolve to an identity (except the public allowlist) or get 401.
 * On by default when web auth is enabled; `ARCHON_WEB_AUTH_REQUIRED=false` keeps
 * the login-UI-only posture (e.g. when a reverse proxy already gates access).
 * Always false when web auth is disabled (solo/local installs unaffected).
 */
export function isApiGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isWebAuthEnabled(env) && env.ARCHON_WEB_AUTH_REQUIRED !== 'false';
}

/**
 * Paths under `/api/auth/*` that Archon owns and the Better Auth catch-all must
 * NOT handle. Better Auth's `basePath` is `/api/auth`, so when web auth is on its
 * handler claims every path under that prefix and 404s any it doesn't recognize.
 * The mount falls through (`next()`) for these so Archon's own route handlers
 * (registered later in `registerApiRoutes`) run instead.
 *
 * Keep this in lockstep with the Archon-owned `/api/auth/*` routes:
 *   - `/api/auth/status`            (web-auth status)
 *   - `/api/auth/github` + sub      (per-user GitHub device flow)
 *   - `/api/auth/providers` + sub   (per-user AI-provider keys; sub = PR-3 OAuth)
 *   - `/api/auth/me/ai-prefs` + sub  (per-user AI prefs: tiers/aliases/default)
 *
 * NOTE: only GET/POST go through the catch-all, so PUT/DELETE on these paths are
 * never intercepted regardless — but listing them here keeps the allow-list the
 * single source of truth for "this prefix is Archon's, not Better Auth's".
 */
export function isArchonOwnedAuthPath(path: string): boolean {
  return (
    path === '/api/auth/status' ||
    path === '/api/auth/github' ||
    path.startsWith('/api/auth/github/') ||
    path === '/api/auth/providers' ||
    path.startsWith('/api/auth/providers/') ||
    path === '/api/auth/me/ai-prefs' ||
    path.startsWith('/api/auth/me/ai-prefs/')
  );
}
