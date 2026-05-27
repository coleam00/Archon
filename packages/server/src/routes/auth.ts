/**
 * OIDC / Keycloak and GitHub OAuth authentication routes.
 *
 * All routes are no-ops (404) when KEYCLOAK_URL is not set.
 * The module is always imported; individual handlers check env vars at request time.
 *
 * Routes register through `registerOpenApiRoute(createRoute({...}), handler)` so
 * they show up in the generated OpenAPI spec (`GET /api/openapi.json`) and follow
 * the project-wide convention (CLAUDE.md).
 */
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { randomBytes } from 'crypto';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { OidcUser } from '../middleware/auth';
import { userDb } from '@archon/core';
import { createLogger } from '@archon/paths';
import { errorSchema } from './schemas/common.schemas';
import {
  authMeResponseSchema,
  okResponseSchema,
  oidcCallbackQuerySchema,
  githubCallbackQuerySchema,
} from './schemas/auth.schemas';

/** Retrieve oidcUser set by the OIDC middleware without triggering strict Variables type checks. */
function getOidcUser(c: Context): OidcUser | undefined {
  // The app is created without Variables generics; cast required to access middleware-set vars.
  return (c as unknown as { get(k: string): unknown }).get('oidcUser') as OidcUser | undefined;
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server.auth');
  return cachedLog;
}

function keycloakBase(): string {
  return `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM ?? 'master'}`;
}

function appBase(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): string {
  // Honor reverse-proxy headers so the OIDC redirect_uri matches the public URL
  // (e.g. https://archon.example.com) instead of the internal one (http://app:3000).
  const fwdHost = c.req.header('x-forwarded-host');
  const fwdProto = c.req.header('x-forwarded-proto');
  if (fwdHost) {
    return `${fwdProto ?? 'https'}://${fwdHost}`;
  }
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

// In-memory PKCE state store (sufficient for single-process; TTL via Map entry size)
const pkceStateStore = new Map<string, { codeVerifier: string; expiresAt: number }>();

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(hash).toString('base64url');
}

function cleanExpiredStates(): void {
  const now = Date.now();
  for (const [key, val] of pkceStateStore) {
    if (val.expiresAt < now) pkceStateStore.delete(key);
  }
}

/**
 * Fetch with an abort-controller timeout (default 10s). Throws on timeout or
 * network failure rather than hanging forever — important for IdP/GitHub calls
 * where DNS/TLS stalls would otherwise wedge the request handler.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── OpenAPI route configs ──────────────────────────────────────────────────

function jsonError(description: string): {
  content: { 'application/json': { schema: typeof errorSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorSchema } }, description };
}

/**
 * Mark a 302 redirect response. OpenAPI 3.0 permits empty responses; the actual
 * Location header is set by `c.redirect(url)` at runtime.
 */
function redirectResponse(description: string): { description: string } {
  return { description };
}

const loginRoute = createRoute({
  method: 'get',
  path: '/api/auth/login',
  tags: ['Auth'],
  summary: 'Start OIDC login (redirect to Keycloak with PKCE)',
  responses: {
    302: redirectResponse('Redirect to Keycloak authorization endpoint'),
    404: jsonError('OIDC not configured (KEYCLOAK_URL unset)'),
  },
});

const callbackRoute = createRoute({
  method: 'get',
  path: '/api/auth/callback',
  tags: ['Auth'],
  summary: 'OIDC code-exchange callback',
  request: { query: oidcCallbackQuerySchema },
  responses: {
    302: redirectResponse('Redirect to / on success, or /?auth_error=... on IdP error'),
    400: jsonError('Missing/invalid code or state'),
    404: jsonError('OIDC not configured'),
    502: jsonError('Token exchange failed or IdP unreachable'),
  },
});

const logoutRoute = createRoute({
  method: 'get',
  path: '/api/auth/logout',
  tags: ['Auth'],
  summary: 'Clear session cookie and redirect to Keycloak logout',
  responses: {
    302: redirectResponse('Redirect to Keycloak logout (or / in single-user mode)'),
  },
});

const meRoute = createRoute({
  method: 'get',
  path: '/api/auth/me',
  tags: ['Auth'],
  summary: 'Return the current authenticated user',
  responses: {
    200: {
      content: { 'application/json': { schema: authMeResponseSchema } },
      description: 'Authenticated user record, or { authenticated: false } in single-user mode',
    },
    401: jsonError('No valid session'),
    404: jsonError('User session valid but no DB record exists'),
  },
});

const githubStartRoute = createRoute({
  method: 'get',
  path: '/api/auth/github',
  tags: ['Auth'],
  summary: 'Start GitHub OAuth flow to connect a per-user token',
  responses: {
    302: redirectResponse('Redirect to GitHub authorize endpoint'),
    401: jsonError('Not authenticated to Archon'),
    404: jsonError('GitHub OAuth not configured'),
  },
});

const githubCallbackRoute = createRoute({
  method: 'get',
  path: '/api/auth/github/callback',
  tags: ['Auth'],
  summary: 'GitHub OAuth callback — exchange code, store encrypted token per user',
  request: { query: githubCallbackQuerySchema },
  responses: {
    302: redirectResponse('Redirect to /?github_connected=1 on success'),
    400: jsonError('Invalid state or missing code'),
    401: jsonError('Not authenticated to Archon'),
    404: jsonError('GitHub OAuth not configured, or user record missing'),
    502: jsonError('GitHub token exchange failed or unreachable'),
  },
});

const githubDisconnectRoute = createRoute({
  method: 'delete',
  path: '/api/auth/github',
  tags: ['Auth'],
  summary: 'Disconnect the current user from GitHub (best-effort revoke + clear DB)',
  responses: {
    200: {
      content: { 'application/json': { schema: okResponseSchema } },
      description: 'Disconnected (idempotent)',
    },
    401: jsonError('Not authenticated'),
    404: jsonError('User record missing'),
  },
});

export function registerAuthRoutes(app: OpenAPIHono): void {
  /**
   * Local OpenAPI registration helper — matches the pattern in api.ts. The
   * `as never` cast bypasses the TypedResponse generic constraint; response
   * schemas are spec-only and not runtime-validated.
   */
  function registerOpenApiRoute(
    route: ReturnType<typeof createRoute>,
    handler: (c: Context) => Response | Promise<Response>
  ): void {
    app.openapi(route, handler as never);
  }

  // GET /api/auth/login — redirect to Keycloak authorization endpoint.
  registerOpenApiRoute(loginRoute, async c => {
    if (!process.env.KEYCLOAK_URL) {
      return c.json({ error: 'OIDC not configured' }, 404);
    }

    cleanExpiredStates();
    const state = randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    pkceStateStore.set(state, { codeVerifier, expiresAt: Date.now() + 10 * 60 * 1000 });

    const params = new URLSearchParams({
      client_id: process.env.KEYCLOAK_CLIENT_ID ?? '',
      redirect_uri: `${appBase(c)}/api/auth/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return c.redirect(`${keycloakBase()}/protocol/openid-connect/auth?${params}`);
  });

  // GET /api/auth/callback — exchange authorization code for tokens and upsert user.
  registerOpenApiRoute(callbackRoute, async c => {
    if (!process.env.KEYCLOAK_URL) {
      return c.json({ error: 'OIDC not configured' }, 404);
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      getLog().warn(
        { error, description: c.req.query('error_description') },
        'auth.callback_error'
      );
      return c.redirect('/?auth_error=' + encodeURIComponent(error));
    }

    if (!code || !state) {
      return c.json({ error: 'Missing code or state' }, 400);
    }

    const stored = pkceStateStore.get(state);
    if (!stored || stored.expiresAt < Date.now()) {
      pkceStateStore.delete(state);
      return c.json({ error: 'Invalid or expired state' }, 400);
    }
    pkceStateStore.delete(state);

    // Exchange code for tokens. fetch wrapped with a timeout so an unreachable
    // Keycloak doesn't wedge the callback handler.
    let tokenRes: Response;
    try {
      tokenRes = await fetchWithTimeout(`${keycloakBase()}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: process.env.KEYCLOAK_CLIENT_ID ?? '',
          ...(process.env.KEYCLOAK_CLIENT_SECRET
            ? { client_secret: process.env.KEYCLOAK_CLIENT_SECRET }
            : {}),
          redirect_uri: `${appBase(c)}/api/auth/callback`,
          code,
          code_verifier: stored.codeVerifier,
        }),
      });
    } catch (err) {
      getLog().error({ err: (err as Error).message }, 'auth.token_exchange_network_error');
      return c.json({ error: 'Token exchange network error' }, 502);
    }

    if (!tokenRes.ok) {
      // Read but DON'T log the raw IdP body — it can carry sensitive error
      // descriptions or echoed token fragments. Try to extract a safe `error`
      // code, log status + that code only.
      let errorCode: string | undefined;
      try {
        const body = (await tokenRes.json()) as { error?: unknown };
        if (typeof body.error === 'string') errorCode = body.error;
      } catch {
        // body wasn't JSON; ignore
      }
      getLog().error({ status: tokenRes.status, errorCode }, 'auth.token_exchange_failed');
      return c.json({ error: 'Token exchange failed' }, 502);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
      refresh_token?: string;
    };

    // Decode JWT claims (no re-verification needed — came directly from Keycloak)
    const [, payloadB64] = tokens.access_token.split('.');
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      sub: string;
      email?: string;
      preferred_username?: string;
      name?: string;
    };

    // Upsert user record
    const user = await userDb.upsertUser(
      claims.sub,
      claims.email ?? null,
      claims.preferred_username ?? null,
      claims.name ?? null
    );

    getLog().info({ userId: user.id, sub: claims.sub }, 'auth.login_completed');

    // Store the access token in an HTTP-only cookie for subsequent API requests.
    // `secure: true` ensures the cookie is only sent over HTTPS — multi-user mode
    // is expected to terminate TLS at the reverse proxy, so the browser-facing
    // origin is always HTTPS. Without this flag a misconfigured proxy could leak
    // the token over plaintext HTTP.
    setCookie(c, 'archon_access_token', tokens.access_token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 8, // 8 hours
    });

    return c.redirect('/');
  });

  // GET /api/auth/logout — clear cookie and redirect to Keycloak logout.
  registerOpenApiRoute(logoutRoute, c => {
    deleteCookie(c, 'archon_access_token', { path: '/' });

    if (!process.env.KEYCLOAK_URL) {
      return c.redirect('/');
    }

    const params = new URLSearchParams({
      client_id: process.env.KEYCLOAK_CLIENT_ID ?? '',
      post_logout_redirect_uri: appBase(c),
    });
    return c.redirect(`${keycloakBase()}/protocol/openid-connect/logout?${params}`);
  });

  // GET /api/auth/me — return current user info from validated JWT claims.
  registerOpenApiRoute(meRoute, async c => {
    if (!process.env.KEYCLOAK_URL) {
      return c.json({ authenticated: false });
    }

    const oidcUser = getOidcUser(c);
    if (!oidcUser) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const user = await userDb.getUserByKeycloakSub(oidcUser.sub);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.display_name,
      githubConnected: Boolean(user.github_oauth_token),
      githubUsername: user.github_username,
    });
  });

  // GET /api/auth/github — redirect to GitHub OAuth authorization.
  registerOpenApiRoute(githubStartRoute, c => {
    if (!process.env.GITHUB_OAUTH_CLIENT_ID) {
      return c.json({ error: 'GitHub OAuth not configured' }, 404);
    }

    const oidcUser = getOidcUser(c);
    if (!oidcUser) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    const state = randomBytes(16).toString('hex');
    // Store state in cookie for CSRF protection
    setCookie(c, 'github_oauth_state', state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 10 * 60,
    });

    const params = new URLSearchParams({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      redirect_uri: `${appBase(c)}/api/auth/github/callback`,
      scope: 'repo read:user',
      state,
    });

    return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  // GET /api/auth/github/callback — exchange GitHub code, encrypt token, store per user.
  registerOpenApiRoute(githubCallbackRoute, async c => {
    if (!process.env.GITHUB_OAUTH_CLIENT_ID || !process.env.GITHUB_OAUTH_CLIENT_SECRET) {
      return c.json({ error: 'GitHub OAuth not configured' }, 404);
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    const storedState = getCookie(c, 'github_oauth_state');

    deleteCookie(c, 'github_oauth_state', { path: '/' });

    if (!code || !state || state !== storedState) {
      return c.json({ error: 'Invalid OAuth state or missing code' }, 400);
    }

    const oidcUser = getOidcUser(c);
    if (!oidcUser) {
      return c.json({ error: 'Not authenticated' }, 401);
    }

    // Exchange code for token (wrapped with timeout to avoid wedging on
    // network stalls).
    let tokenRes: Response;
    try {
      tokenRes = await fetchWithTimeout('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
          client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
          code,
          redirect_uri: `${appBase(c)}/api/auth/github/callback`,
        }),
      });
    } catch (err) {
      getLog().error({ err: (err as Error).message }, 'auth.github_token_exchange_network_error');
      return c.json({ error: 'GitHub token exchange network error' }, 502);
    }

    if (!tokenRes.ok) {
      getLog().error({ status: tokenRes.status }, 'auth.github_token_exchange_failed');
      return c.json({ error: 'GitHub token exchange failed' }, 502);
    }

    const data = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!data.access_token) {
      // GitHub's `error` field is a short code (e.g. "bad_verification_code") —
      // safe to log. Never log the token-exchange body.
      getLog().error({ errorCode: data.error }, 'auth.github_token_missing');
      return c.json({ error: data.error ?? 'GitHub token exchange failed' }, 502);
    }

    // Fetch GitHub username (also timeout-wrapped).
    let ghUser: { login?: string } = { login: undefined };
    try {
      const ghUserRes = await fetchWithTimeout('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${data.access_token}`, 'User-Agent': 'Archon' },
      });
      if (ghUserRes.ok) {
        ghUser = (await ghUserRes.json()) as { login?: string };
      }
    } catch (err) {
      // Non-fatal: we still have a valid token; we'll just store an empty username.
      getLog().warn({ err: (err as Error).message }, 'auth.github_user_lookup_failed');
    }

    const dbUser = await userDb.getUserByKeycloakSub(oidcUser.sub);
    if (!dbUser) {
      return c.json({ error: 'User record not found' }, 404);
    }

    await userDb.setGithubToken(dbUser.id, data.access_token, ghUser.login ?? '');
    getLog().info({ userId: dbUser.id, githubLogin: ghUser.login }, 'auth.github_connected');

    return c.redirect('/?github_connected=1');
  });

  // DELETE /api/auth/github — disconnect the current user's GitHub OAuth token.
  // Best-effort revokes the token on GitHub (via Apps Revoke endpoint), then
  // clears the encrypted token + username from the user row. Idempotent.
  registerOpenApiRoute(githubDisconnectRoute, async c => {
    const oidcUser = getOidcUser(c);
    if (!oidcUser) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const dbUser = await userDb.getUserByKeycloakSub(oidcUser.sub);
    if (!dbUser) {
      return c.json({ error: 'User record not found' }, 404);
    }

    // Best-effort: revoke the token on GitHub's side so the OAuth app installation
    // count stays accurate and the token is invalidated server-side. Skip silently
    // on failure — clearing our DB is the authoritative action.
    const token = await userDb.getGithubToken(dbUser.id);
    const ghClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    const ghClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    if (token && ghClientId && ghClientSecret) {
      try {
        const auth = Buffer.from(`${ghClientId}:${ghClientSecret}`).toString('base64');
        const revokeRes = await fetchWithTimeout(
          `https://api.github.com/applications/${ghClientId}/grant`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Basic ${auth}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'Archon',
            },
            body: JSON.stringify({ access_token: token }),
          }
        );
        if (!revokeRes.ok && revokeRes.status !== 404) {
          getLog().warn(
            { userId: dbUser.id, status: revokeRes.status },
            'auth.github_revoke_failed'
          );
        }
      } catch (err) {
        getLog().warn(
          { userId: dbUser.id, err: (err as Error).message },
          'auth.github_revoke_error'
        );
      }
    }

    await userDb.clearGithubToken(dbUser.id);
    getLog().info({ userId: dbUser.id }, 'auth.github_disconnected');
    return c.json({ ok: true });
  });
}
