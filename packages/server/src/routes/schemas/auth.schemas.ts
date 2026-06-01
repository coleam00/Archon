/**
 * Zod schemas for the GitHub device-flow connect endpoints.
 */
import { z } from '@hono/zod-openapi';

/** POST /api/auth/github/device/start response — codes shown to the user. */
export const deviceStartResponseSchema = z
  .object({
    device_code: z.string(),
    user_code: z.string(),
    verification_uri: z.string(),
    interval: z.number(),
    expires_in: z.number(),
  })
  .openapi('GithubDeviceStartResponse');

/** POST /api/auth/github/device/poll request — echoes the device_code from start. */
export const devicePollBodySchema = z
  .object({ device_code: z.string().min(1) })
  .openapi('GithubDevicePollBody');

/** POST /api/auth/github/device/poll response. */
export const devicePollResponseSchema = z
  .object({
    status: z.enum(['pending', 'connected', 'expired', 'denied', 'error']),
    githubLogin: z.string().optional(),
    detail: z.string().optional(),
  })
  .openapi('GithubDevicePollResponse');

/** GET /api/auth/github response — current connection status. */
export const githubConnectionStatusSchema = z
  .object({
    connected: z.boolean(),
    githubLogin: z.string().nullable(),
  })
  .openapi('GithubConnectionStatus');

/** DELETE /api/auth/github response. */
export const githubDisconnectResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('GithubDisconnectResponse');

// ---------------------------------------------------------------------------
// Keycloak / OIDC schemas (fork-specific; used by routes/auth.ts).
// Reinstated after the dev merge replaced auth.schemas.ts with dev's
// device-flow-only version. Independent of the device-flow schemas above.
// ---------------------------------------------------------------------------

/**
 * /api/auth/me response — either the authenticated user record, or
 * `{ authenticated: false }` when OIDC is not configured (single-user mode).
 */
export const authMeAuthenticatedSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().nullable(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    githubConnected: z.boolean(),
    githubUsername: z.string().nullable(),
  })
  .openapi('AuthMeAuthenticated');

export const authMeUnauthenticatedSchema = z
  .object({ authenticated: z.literal(false) })
  .openapi('AuthMeUnauthenticated');

export const authMeResponseSchema = z
  .union([authMeAuthenticatedSchema, authMeUnauthenticatedSchema])
  .openapi('AuthMeResponse');

/** Generic `{ ok: true }` confirmation used by disconnect/logout endpoints. */
export const okResponseSchema = z.object({ ok: z.literal(true) }).openapi('OkResponse');

/** Query params accepted by OIDC callback endpoints. */
export const oidcCallbackQuerySchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .openapi('OidcCallbackQuery');

/** Query params accepted by the fork's GitHub OAuth callback endpoint. */
export const githubCallbackQuerySchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
  })
  .openapi('GithubCallbackQuery');
