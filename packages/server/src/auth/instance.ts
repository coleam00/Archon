/**
 * Better Auth instance (lazy singleton).
 *
 * `getAuth()` returns a configured Better Auth instance when web auth is enabled
 * (see ./config `isWebAuthEnabled`), otherwise `null`. The instance owns its own
 * small pg.Pool — Better Auth needs a raw `pg.Pool`, whereas core's `pool`
 * export is a thin query shim, not a real pool. Keeping a dedicated pool also
 * keeps the auth module self-contained.
 *
 * Better Auth owns four tables, renamed to the `remote_agent_auth_*` prefix via
 * `modelName` so they sit alongside Archon's other `remote_agent_*` tables. The
 * CANONICAL Archon user stays `remote_agent_users`; a Better Auth session is
 * mapped to it elsewhere via `findOrCreateUserByPlatformIdentity('web', …)`.
 *
 * Module-singleton pattern mirrors `registeredGitHubAppAuthProvider`.
 */
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { Pool } from 'pg';
import { isWebAuthEnabled, parseAllowedEmails, isEmailAllowed } from './config';

/** The configured Better Auth instance type (inferred — no hand-written shape). */
export type AuthInstance = ReturnType<typeof betterAuth>;

// `undefined` = not yet resolved; `null` = resolved-as-disabled. This lets a
// disabled install short-circuit without re-checking env on every request.
let cached: AuthInstance | null | undefined;

/**
 * Resolve the singleton Better Auth instance, or `null` when web auth is
 * disabled. Safe to call on every request — construction happens at most once.
 */
export function getAuth(env: NodeJS.ProcessEnv = process.env): AuthInstance | null {
  if (cached !== undefined) return cached;
  cached = isWebAuthEnabled(env) ? buildAuth(env) : null;
  return cached;
}

function buildAuth(env: NodeJS.ProcessEnv): AuthInstance {
  // isWebAuthEnabled guarantees both are present; locals avoid `!` assertions.
  const connectionString = env.DATABASE_URL ?? '';
  const secret = env.BETTER_AUTH_SECRET ?? '';
  const trustedOrigins = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return betterAuth({
    // Dedicated small pool; Better Auth requires a real pg.Pool.
    database: new Pool({ connectionString, max: 5 }),
    secret,
    // Omit baseURL for same-origin deploys — Better Auth infers it from the
    // request. Set BETTER_AUTH_URL only when behind a proxy with a fixed origin.
    ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
    ...(trustedOrigins.length ? { trustedOrigins } : {}),
    // requireEmailVerification defaults false → simple flow, no email sender.
    emailAndPassword: { enabled: true },
    user: { modelName: 'remote_agent_auth_user' },
    session: { modelName: 'remote_agent_auth_session' },
    account: { modelName: 'remote_agent_auth_account' },
    verification: { modelName: 'remote_agent_auth_verification' },
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => {
            // Invite gate: reject signups whose email is not on the allowlist.
            // Throwing APIError surfaces a clean 403 to the client instead of a
            // generic 500. An empty allowlist means open signup.
            if (!isEmailAllowed(user.email, parseAllowedEmails(env))) {
              throw new APIError('FORBIDDEN', {
                message: 'This email is not on the invite allowlist.',
              });
            }
            return { data: user };
          },
        },
      },
    },
  });
}

/** Test-only: clear the cached instance so env changes take effect. */
export function resetAuthForTest(): void {
  cached = undefined;
}
