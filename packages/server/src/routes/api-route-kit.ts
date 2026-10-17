import type { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createLogger } from '@archon/paths';
// Imported from the pure config module rather than the barrel: route tests mock
// '../auth', and the header name must stay the real implementation under them.
import { DEFAULT_WEB_AUTH_HEADER } from '../auth/config';
import { errorSchema } from './schemas/common.schemas';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
export function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('api');
  return cachedLog;
}

/** Helper to build a JSON error response entry for createRoute configs. */
export function jsonError(description: string): {
  content: { 'application/json': { schema: typeof errorSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorSchema } }, description };
}

/** The identity routes' 401, named after the default trusted header. */
export const WEB_AUTH_REQUIRED = jsonError(
  `Web auth required (${DEFAULT_WEB_AUTH_HEADER} header missing)`
);

export function apiError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503,
  message: string,
  detail?: string
): Response {
  return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
}

/**
 * Register a route with OpenAPI spec generation and input validation.
 * Zod validates inputs (query, params, body) at runtime via defaultHook.
 * Response schemas are used for OpenAPI spec generation only — output is not
 * validated at runtime. The `as never` cast bypasses TypedResponse constraints.
 */
export function openApiRouteRegistrar(
  app: OpenAPIHono
): (
  route: ReturnType<typeof createRoute>,
  handler: (c: Context) => Response | Promise<Response>
) => void {
  return (route, handler) => {
    app.openapi(route, handler as never);
  };
}

/** Access Zod-validated body from a handler registered via registerOpenApiRoute. */
export function getValidatedBody<T>(c: Context, _schema: z.ZodType<T>): T {
  return (c.req as unknown as { valid(k: 'json'): T }).valid('json');
}

/** Access the Zod-validated query from a handler registered via registerOpenApiRoute. */
export function getValidatedQuery<T>(c: Context, _schema: z.ZodType<T>): T {
  return (c.req as unknown as { valid(k: 'query'): T }).valid('query');
}
