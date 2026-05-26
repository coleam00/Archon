import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface OidcUser {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
}

/** Routes that never require authentication, even when OIDC is enabled. */
const PUBLIC_PREFIXES = ['/api/auth/', '/api/health', '/api/openapi.json', '/webhooks/'];

function isPublicPath(path: string): boolean {
  return PUBLIC_PREFIXES.some(p => path === p.replace(/\/$/, '') || path.startsWith(p));
}

function buildJwksUrl(keycloakUrl: string): URL {
  const realm = process.env.KEYCLOAK_REALM ?? 'master';
  return new URL(`${keycloakUrl}/realms/${realm}/protocol/openid-connect/certs`);
}

// Lazily-initialized JWKS fetcher keyed on the URL (so tests can swap KEYCLOAK_URL).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUrl: string | null = null;

function getJwks(keycloakUrl: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks || jwksUrl !== keycloakUrl) {
    jwks = createRemoteJWKSet(buildJwksUrl(keycloakUrl));
    jwksUrl = keycloakUrl;
  }
  return jwks;
}

/**
 * Returns a Hono middleware that validates OIDC Bearer tokens issued by Keycloak.
 *
 * When KEYCLOAK_URL is not set this is a complete no-op — single-user mode is unchanged.
 */
export function oidcMiddleware(): MiddlewareHandler {
  const keycloakUrl = process.env.KEYCLOAK_URL;
  if (!keycloakUrl) {
    return async (_c, next) => next();
  }

  const clientId = process.env.KEYCLOAK_CLIENT_ID;

  return async (c, next) => {
    const publicPath = isPublicPath(c.req.path);

    // Always attempt to validate the cookie/header so handlers like /api/auth/me
    // (which is on a public path so unauth'd users can reach it without 401)
    // can still see the authenticated user when the cookie is valid.
    const authHeader = c.req.header('Authorization');
    const token =
      (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) ??
      getCookie(c, 'archon_access_token') ??
      null;

    if (token) {
      try {
        // Don't constrain `audience` here — Keycloak access tokens default to
        // aud: "account", not the client id. The client id appears in `azp`
        // (authorized party), which we verify below. JWKS signature + issuer
        // checks still prove the token came from our realm.
        const { payload } = await jwtVerify(token, getJwks(keycloakUrl), {
          issuer: `${keycloakUrl}/realms/${process.env.KEYCLOAK_REALM ?? 'master'}`,
        });

        const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
        if (clientId && azp && azp !== clientId) {
          throw new Error(`azp mismatch: expected ${clientId}, got ${azp}`);
        }

        const user: OidcUser = {
          // sub is always present in valid JWTs; empty string is unreachable in practice
          sub: payload.sub ?? '',
          email: payload.email as string | undefined,
          preferred_username: payload.preferred_username as string | undefined,
          name: payload.name as string | undefined,
        };
        // The app is created without Variables generics; cast required to store middleware vars.
        (c as unknown as { set(k: string, v: unknown): void }).set('oidcUser', user);
        await next();
        return;
      } catch {
        // Invalid token: fall through. On public paths we let the request through
        // (handler decides what to do); on private paths we 401 below.
        if (!publicPath) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      }
    } else if (!publicPath) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
    return;
  };
}
