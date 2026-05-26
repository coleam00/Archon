/**
 * OIDC / Keycloak and GitHub OAuth authentication routes.
 *
 * All routes are no-ops (404) when KEYCLOAK_URL is not set.
 * The module is always imported; individual handlers check env vars at request time.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { randomBytes } from 'crypto';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { OidcUser } from '../middleware/auth';
import { userDb } from '@archon/core';
import { createLogger } from '@archon/paths';

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

function appBase(c: { req: { url: string } }): string {
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

export function registerAuthRoutes(app: OpenAPIHono): void {
  /**
   * GET /api/auth/login — redirect to Keycloak authorization endpoint.
   */
  app.get('/api/auth/login', async c => {
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

  /**
   * GET /api/auth/callback — exchange authorization code for tokens and upsert user.
   */
  app.get('/api/auth/callback', async c => {
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

    // Exchange code for tokens
    const tokenRes = await fetch(`${keycloakBase()}/protocol/openid-connect/token`, {
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

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      getLog().error({ status: tokenRes.status, body }, 'auth.token_exchange_failed');
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

    // Store the access token in an HTTP-only cookie for subsequent API requests
    setCookie(c, 'archon_access_token', tokens.access_token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 8, // 8 hours
    });

    return c.redirect('/');
  });

  /**
   * GET /api/auth/logout — clear cookie and redirect to Keycloak logout.
   */
  app.get('/api/auth/logout', c => {
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

  /**
   * GET /api/auth/me — return current user info from validated JWT claims.
   */
  app.get('/api/auth/me', async c => {
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

  /**
   * GET /api/auth/github — redirect to GitHub OAuth authorization.
   */
  app.get('/api/auth/github', c => {
    if (!process.env.GITHUB_OAUTH_CLIENT_ID) {
      return c.json({ error: 'GitHub OAuth not configured' }, 404);
    }

    const state = randomBytes(16).toString('hex');
    // Store state in cookie for CSRF protection
    setCookie(c, 'github_oauth_state', state, {
      httpOnly: true,
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

  /**
   * GET /api/auth/github/callback — exchange GitHub code, encrypt token, store per user.
   */
  app.get('/api/auth/github/callback', async c => {
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

    // Exchange code for token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
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

    if (!tokenRes.ok) {
      getLog().error({ status: tokenRes.status }, 'auth.github_token_exchange_failed');
      return c.json({ error: 'GitHub token exchange failed' }, 502);
    }

    const data = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!data.access_token) {
      getLog().error({ error: data.error }, 'auth.github_token_missing');
      return c.json({ error: data.error ?? 'GitHub token exchange failed' }, 502);
    }

    // Fetch GitHub username
    const ghUserRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${data.access_token}`, 'User-Agent': 'Archon' },
    });
    const ghUser = ghUserRes.ok
      ? ((await ghUserRes.json()) as { login?: string })
      : { login: undefined };

    const dbUser = await userDb.getUserByKeycloakSub(oidcUser.sub);
    if (!dbUser) {
      return c.json({ error: 'User record not found' }, 404);
    }

    await userDb.setGithubToken(dbUser.id, data.access_token, ghUser.login ?? '');
    getLog().info({ userId: dbUser.id, githubLogin: ghUser.login }, 'auth.github_connected');

    return c.redirect('/?github_connected=1');
  });
}
