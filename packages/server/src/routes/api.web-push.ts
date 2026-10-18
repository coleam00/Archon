import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { deleteWebPushSubscription } from '@archon/core/db/web-push-subscriptions';
import {
  webPushSubscriptionSchema,
  webPushDeleteSchema,
  webPushKeySchema,
  webPushSuccessSchema,
} from '@archon/core/schemas/web-push';
import { WebPushDestination } from '../services/web-push';
import { requireWebUser } from './api-request-auth';
import { apiError, getLog, getValidatedBody, openApiRouteRegistrar } from './api-route-kit';

const getWebPushKeyRoute = createRoute({
  method: 'get',
  path: '/api/web-push/key',
  tags: ['Alerts'],
  summary: 'Browser push public key',
  responses: {
    200: {
      content: { 'application/json': { schema: webPushKeySchema } },
      description: 'VAPID public key',
    },
  },
});
const addWebPushRoute = createRoute({
  method: 'post',
  path: '/api/web-push/subscriptions',
  tags: ['Alerts'],
  summary: 'Opt this browser into push',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: webPushSubscriptionSchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: webPushSuccessSchema } },
      description: 'Subscribed',
    },
  },
});
const deleteWebPushRoute = createRoute({
  method: 'delete',
  path: '/api/web-push/subscriptions',
  tags: ['Alerts'],
  summary: 'Opt this browser out of push',
  request: {
    body: { required: true, content: { 'application/json': { schema: webPushDeleteSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: webPushSuccessSchema } },
      description: 'Unsubscribed',
    },
  },
});

export function registerWebPushRoutes(
  app: OpenAPIHono,
  attention?: { webPush: WebPushDestination }
): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  const webPush = attention?.webPush ?? new WebPushDestination();
  registerOpenApiRoute(getWebPushKeyRoute, c => c.json({ publicKey: webPush.publicKey() }));
  registerOpenApiRoute(addWebPushRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      await webPush.subscribe(web.userId, getValidatedBody(c, webPushSubscriptionSchema));
      return c.json({ success: true as const });
    } catch (err) {
      getLog().error(
        {
          err: {
            name: err instanceof Error ? err.name : 'UnknownError',
            code: err instanceof Error && 'code' in err ? err.code : undefined,
          },
        },
        'web_push.subscribe_failed'
      );
      return apiError(c, 500, 'Could not subscribe this browser');
    }
  });
  registerOpenApiRoute(deleteWebPushRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      await deleteWebPushSubscription(
        getValidatedBody(c, webPushDeleteSchema).endpoint,
        web.userId
      );
      return c.json({ success: true as const });
    } catch (err) {
      getLog().error(
        {
          err: {
            name: err instanceof Error ? err.name : 'UnknownError',
            code: err instanceof Error && 'code' in err ? err.code : undefined,
          },
        },
        'web_push.unsubscribe_failed'
      );
      return apiError(c, 500, 'Could not unsubscribe this browser');
    }
  });
}
