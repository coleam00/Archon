/**
 * Webhook routes — raw forge-to-server ingestion endpoints.
 *
 * Registered outside the OpenAPI surface: webhooks are signed
 * machine-to-machine payloads verified against the raw request body, not part
 * of the published API.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { GitHubAdapter } from '@archon/adapters';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
}

/** The slice of GitHubAdapter the webhook route depends on. */
export type GithubWebhookTarget = Pick<GitHubAdapter, 'handleWebhook'>;

export function registerGithubWebhookRoute(app: OpenAPIHono, github: GithubWebhookTarget): void {
  app.post('/webhooks/github', async c => {
    const eventType = c.req.header('x-github-event');
    const deliveryId = c.req.header('x-github-delivery');

    try {
      const signature = c.req.header('x-hub-signature-256');
      if (!signature) {
        return c.json({ error: 'Missing signature header' }, 400);
      }

      // CRITICAL: Use c.req.text() for raw body (signature verification)
      const payload = await c.req.text();

      // Process async (fire-and-forget for fast webhook response)
      // Note: github.handleWebhook() has internal error handling that notifies users
      // This catch is a fallback for truly unexpected errors (e.g., signature verification bugs)
      github.handleWebhook(payload, signature, deliveryId).catch((error: unknown) => {
        getLog().error({ err: error, eventType, deliveryId }, 'webhook_processing_error');
      });

      return c.text('OK', 200);
    } catch (error) {
      getLog().error({ err: error, eventType, deliveryId }, 'webhook_endpoint_error');
      return c.json({ error: 'Internal server error' }, 500);
    }
  });
}
