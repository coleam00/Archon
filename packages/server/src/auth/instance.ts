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
import { createLogger } from '@archon/paths';
import { isWebAuthEnabled, parseAllowedEmails, isEmailAllowed, getSignupMode } from './config';

const log = createLogger('web-auth');

/** The configured Better Auth instance type (inferred — no hand-written shape). */
export type AuthInstance = ReturnType<typeof betterAuth>;

// `undefined` = not yet resolved; `null` = resolved-as-disabled. This lets a
// disabled install short-circuit without re-checking env on every request.
let cached: AuthInstance | null | undefined;

// The dedicated pg.Pool owned by the Better Auth instance, retained so
// closeAuth() can release it on shutdown. Null when web auth is disabled.
let authPool: Pool | null = null;

/**
 * Resolve the singleton Better Auth instance, or `null` when web auth is
 * disabled. Safe to call on every request — construction happens at most once.
 *
 * A construction failure (e.g. a malformed DATABASE_URL) is logged and cached as
 * `null` so it surfaces as a clear log line and a disabled auth surface, rather
 * than throwing into the request path where the soft seam would swallow it as a
 * generic "session resolve failed".
 */
export function getAuth(env: NodeJS.ProcessEnv = process.env): AuthInstance | null {
  if (cached !== undefined) return cached;
  if (!isWebAuthEnabled(env)) {
    cached = null;
    return cached;
  }
  try {
    cached = buildAuth(env);
    log.info('web_auth.instance_built');
  } catch (err) {
    log.error(
      { err: err as Error },
      'web_auth.instance_build_failed — web auth will be unavailable'
    );
    cached = null;
  }
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

  // The allowlist is static for this install — parse it once at construction
  // rather than on every signup.
  const allowedEmails = parseAllowedEmails(env);
  // Safe default: with no allowlist and no explicit open-signup flag, signup is
  // OFF (login only) rather than silently open on a reachable URL.
  const signupDisabled = getSignupMode(env) === 'disabled';

  // Dedicated small pool; Better Auth requires a real pg.Pool. Retained at module
  // scope so closeAuth() can end it on shutdown.
  authPool = new Pool({ connectionString, max: 5 });

  return betterAuth({
    database: authPool,
    secret,
    // Omit baseURL for same-origin deploys — Better Auth infers it from the
    // request. Set BETTER_AUTH_URL only when behind a proxy with a fixed origin.
    ...(env.BETTER_AUTH_URL ? { baseURL: env.BETTER_AUTH_URL } : {}),
    ...(trustedOrigins.length ? { trustedOrigins } : {}),
    // requireEmailVerification defaults false → simple flow, no email sender.
    // disableSignUp closes self-serve registration when the posture is
    // `disabled` (no allowlist + no ARCHON_AUTH_OPEN_SIGNUP=true). The allowlist
    // hook below is the belt-and-suspenders for `allowlist` mode.
    emailAndPassword: { enabled: true, disableSignUp: signupDisabled },
    user: { modelName: 'remote_agent_auth_user' },
    session: { modelName: 'remote_agent_auth_session' },
    account: { modelName: 'remote_agent_auth_account' },
    verification: { modelName: 'remote_agent_auth_verification' },
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => {
            // Defense in depth: `disableSignUp` (set above from getSignupMode)
            // already blocks registration in `disabled` mode before this hook
            // runs — re-check here so the hook stays correct on its own if that
            // upstream enforcement ever changes.
            if (signupDisabled) {
              throw new APIError('FORBIDDEN', { message: 'Signup is disabled.' });
            }
            // Invite gate (`allowlist` mode): reject signups whose email is not on
            // the allowlist. Throwing APIError surfaces a clean 403 instead of a
            // generic 500. An empty allowlist makes isEmailAllowed() return true,
            // so this hook is a no-op in `open` mode — `disableSignUp` and the
            // posture above are what actually govern whether signup is permitted.
            if (!isEmailAllowed(user.email, allowedEmails)) {
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

/**
 * Release the Better Auth pg.Pool on graceful shutdown. No-op when web auth is
 * disabled (no pool was ever created).
 */
export async function closeAuth(): Promise<void> {
  if (authPool) {
    await authPool.end();
    authPool = null;
  }
}

/** Test-only: clear the cached instance so env changes take effect. */
export function resetAuthForTest(): void {
  cached = undefined;
  authPool = null;
}
