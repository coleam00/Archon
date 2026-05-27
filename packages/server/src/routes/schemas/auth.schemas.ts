import { z } from '@hono/zod-openapi';

/**
 * /api/auth/me response — either the authenticated user record, or
 * `{ authenticated: false }` when OIDC is not configured (single-user mode).
 *
 * Two shapes intentionally; the web client treats `authenticated === false`
 * as "no current user" without surfacing it as an error.
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

/** Generic `{ ok: true }` confirmation used by the disconnect endpoint. */
export const okResponseSchema = z.object({ ok: z.literal(true) }).openapi('OkResponse');

/** Query params accepted by OIDC + OAuth callback endpoints. */
export const oidcCallbackQuerySchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .openapi('OidcCallbackQuery');

export const githubCallbackQuerySchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
  })
  .openapi('GithubCallbackQuery');
