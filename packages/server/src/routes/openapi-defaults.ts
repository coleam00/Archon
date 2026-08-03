/**
 * Shared OpenAPIHono configuration used by both the server and tests.
 */
import type { OpenAPIHono } from '@hono/zod-openapi';

type DefaultHook = NonNullable<ConstructorParameters<typeof OpenAPIHono>[0]>['defaultHook'];

/** Default validation-error hook: formats Zod issues as { error: string } with 400 status. */
export const validationErrorHook: DefaultHook = (result, c): Response | undefined => {
  if (!result.success) {
    const message = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    return c.json({ error: message }, 400);
  }
  return undefined;
};
