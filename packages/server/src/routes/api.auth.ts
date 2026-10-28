import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  isPerUserGitHubEnabled,
  loadDeviceFlowConfig,
  startDeviceFlow,
  pollDeviceFlowOnce,
  persistGithubConnection,
  DeviceFlowError,
  GithubIdentityConflictError,
  getUserGithubTokenRecord,
  deleteUserGithubToken,
} from '@archon/core';
import { isWebAuthEnabled, getSignupMode } from '../auth';
import {
  apiError,
  getLog,
  getValidatedBody,
  jsonError,
  openApiRouteRegistrar,
  WEB_AUTH_REQUIRED,
} from './api-route-kit';
import { requireWebUser } from './api-request-auth';
import { mapDeviceFlowErrorToPollStatus } from './auth-poll-status';
import {
  authStatusResponseSchema,
  deviceStartResponseSchema,
  devicePollBodySchema,
  devicePollResponseSchema,
  githubConnectionStatusSchema,
  githubDisconnectResponseSchema,
} from './schemas/auth.schemas';

const authStatusRoute = createRoute({
  method: 'get',
  path: '/api/auth/status',
  tags: ['Auth'],
  summary: 'Web auth availability + signup posture (no auth required)',
  responses: {
    200: {
      content: { 'application/json': { schema: authStatusResponseSchema } },
      description: 'Auth status',
    },
  },
});

const githubDeviceStartRoute = createRoute({
  method: 'post',
  path: '/api/auth/github/device/start',
  tags: ['Auth'],
  summary: 'Start the GitHub device flow for the current web user',
  responses: {
    200: {
      content: { 'application/json': { schema: deviceStartResponseSchema } },
      description: 'Device + user codes',
    },
    401: WEB_AUTH_REQUIRED,
    500: jsonError('Device flow not configured or failed'),
  },
});

const githubDevicePollRoute = createRoute({
  method: 'post',
  path: '/api/auth/github/device/poll',
  tags: ['Auth'],
  summary: 'Poll the GitHub device flow once for the current web user',
  request: {
    body: { content: { 'application/json': { schema: devicePollBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: devicePollResponseSchema } },
      description: 'Poll status',
    },
    401: WEB_AUTH_REQUIRED,
    500: jsonError('Device flow not configured or failed'),
  },
});

const githubConnectionStatusRoute = createRoute({
  method: 'get',
  path: '/api/auth/github',
  tags: ['Auth'],
  summary: 'GitHub connection status for the current web user',
  responses: {
    200: {
      content: { 'application/json': { schema: githubConnectionStatusSchema } },
      description: 'Connection status',
    },
    401: WEB_AUTH_REQUIRED,
  },
});

const githubDisconnectRoute = createRoute({
  method: 'delete',
  path: '/api/auth/github',
  tags: ['Auth'],
  summary: 'Disconnect the current web user’s GitHub identity',
  responses: {
    200: {
      content: { 'application/json': { schema: githubDisconnectResponseSchema } },
      description: 'Disconnected',
    },
    401: WEB_AUTH_REQUIRED,
  },
});

export function registerAuthRoutes(app: OpenAPIHono): void {
  const registerOpenApiRoute = openApiRouteRegistrar(app);

  // GET /api/auth/status - web auth availability + signup posture.
  // Public (no identity required): the web UI calls this before login to decide
  // whether to render the login gate at all. When web auth is enabled the
  // /api/auth/* mount explicitly next()s Archon-owned paths (this one included)
  // before Better Auth's handler runs, so the request reaches here untouched
  // (see mountWebAuth in server-routes.ts).
  registerOpenApiRoute(authStatusRoute, c => {
    return c.json({ enabled: isWebAuthEnabled(), signup: getSignupMode() });
  });

  // ---- GitHub device-flow connect endpoints ----
  registerOpenApiRoute(githubDeviceStartRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect GitHub');
    if ('error' in web) return web.error;
    if (!isPerUserGitHubEnabled()) {
      return apiError(c, 500, 'Per-user GitHub is not enabled on this install');
    }
    try {
      const { clientId } = loadDeviceFlowConfig();
      const device = await startDeviceFlow(clientId);
      return c.json({
        device_code: device.device_code,
        user_code: device.user_code,
        verification_uri: device.verification_uri,
        interval: device.interval,
        expires_in: device.expires_in,
      });
    } catch (err) {
      getLog().error({ err: err as Error }, 'auth.github_device_start_failed');
      return apiError(c, 500, 'Failed to start GitHub device flow');
    }
  });

  registerOpenApiRoute(githubDevicePollRoute, async c => {
    const web = await requireWebUser(c, 'Web authentication required to connect GitHub');
    if ('error' in web) return web.error;
    if (!isPerUserGitHubEnabled()) {
      return apiError(c, 500, 'Per-user GitHub is not enabled on this install');
    }
    const { device_code: deviceCode } = getValidatedBody(c, devicePollBodySchema);
    try {
      const { clientId } = loadDeviceFlowConfig();
      const result = await pollDeviceFlowOnce(clientId, deviceCode);
      if (result.status === 'pending' || result.status === 'slow_down') {
        return c.json({ status: 'pending' as const });
      }
      if (result.status === 'error') {
        // Terminal device-flow codes → client-visible status (testable helper).
        return c.json({ status: mapDeviceFlowErrorToPollStatus(result.code), detail: result.code });
      }
      // authorized
      const { githubLogin } = await persistGithubConnection(web.userId, result.token);
      return c.json({ status: 'connected' as const, githubLogin });
    } catch (err) {
      if (err instanceof GithubIdentityConflictError) {
        return c.json({ status: 'error' as const, detail: err.message });
      }
      if (err instanceof DeviceFlowError) {
        return c.json({ status: 'error' as const, detail: err.code });
      }
      getLog().error(
        { err, userId: web.userId, platform: 'github' },
        'auth.github_device_poll_failed'
      );
      return apiError(c, 500, 'Failed to poll GitHub device flow');
    }
  });

  registerOpenApiRoute(githubConnectionStatusRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      const record = await getUserGithubTokenRecord(web.userId);
      return c.json({ connected: record !== null, githubLogin: record?.github_login ?? null });
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.github_status_failed');
      return apiError(c, 500, 'Failed to read GitHub connection status');
    }
  });

  registerOpenApiRoute(githubDisconnectRoute, async c => {
    const web = await requireWebUser(c);
    if ('error' in web) return web.error;
    try {
      await deleteUserGithubToken(web.userId);
      return c.json({ success: true });
    } catch (err) {
      getLog().error({ err: err as Error, userId: web.userId }, 'auth.github_disconnect_failed');
      return apiError(c, 500, 'Failed to disconnect GitHub');
    }
  });
}
