/**
 * Webhook routes — raw source-to-server ingestion endpoints.
 *
 * Registered outside the OpenAPI surface: webhooks are signed
 * machine-to-machine payloads verified against the raw request body, not part
 * of the published API.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { GitHubAdapter } from '@archon/adapters';
import { createLogger } from '@archon/paths';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type {
  WebhookSourceOutcome,
  WebhookSourcePluginHost,
} from '../services/webhook-source-plugins';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('server');
  return cachedLog;
}

/**
 * The received body as text that re-encodes to the exact received bytes. A signature
 * covers bytes, so the default decoding is wrong twice over: it drops a leading BOM, which
 * lets an unsigned prefix pass, and replaces invalid UTF-8, which lets different bytes
 * share one text. Returns null for a body that is not UTF-8.
 */
async function readSignedBody(request: Request): Promise<string | null> {
  const bytes = await request.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The slice of GitHubAdapter the webhook route depends on. */
export type GithubWebhookTarget = Pick<GitHubAdapter, 'receiveWebhook'>;

export function registerGithubWebhookRoute(app: OpenAPIHono, github: GithubWebhookTarget): void {
  app.post('/webhooks/github', async c => {
    const eventType = c.req.header('x-github-event');
    const deliveryId = c.req.header('x-github-delivery');

    try {
      const signature = c.req.header('x-hub-signature-256');
      if (!signature) {
        return c.json({ error: 'Missing signature header' }, 400);
      }

      const payload = await readSignedBody(c.req.raw);
      if (payload === null) return c.json({ error: 'Body is not UTF-8' }, 400);

      // Receipt acceptance is durable; it does not mean the workflow completed.
      // GitHub requires explicit redelivery/reconciliation after a failed delivery.
      const result = await github.receiveWebhook(payload, signature, deliveryId, eventType);
      if (result === 'invalid_signature') return c.json({ error: 'Invalid signature' }, 401);
      if (result === 'malformed') return c.json({ error: 'Malformed payload' }, 400);

      return c.text('OK', 200);
    } catch (error) {
      getLog().error({ err: error as Error, eventType, deliveryId }, 'webhook_endpoint_error');
      return c.json({ error: 'Internal server error' }, 500);
    }
  });
}

const sourceRejections: Record<
  Exclude<WebhookSourceOutcome, 'accepted'>,
  { status: ContentfulStatusCode; error: string }
> = {
  unauthenticated: { status: 401, error: 'Unauthenticated' },
  malformed: { status: 400, error: 'Malformed payload' },
  conflict: { status: 409, error: 'Delivery ID reused with different content' },
};

export function registerWebhookSourceRoutes(
  app: OpenAPIHono,
  sources: WebhookSourcePluginHost,
  /** Called after a receipt commits, without awaiting, so execution never delays the ACK. */
  onReceiptAccepted?: () => void
): void {
  app.post('/webhooks/sources/:sourceInstanceId', async c => {
    const sourceInstanceId = c.req.param('sourceInstanceId');
    if (!sources.hasSource(sourceInstanceId))
      return c.json({ error: 'Unknown webhook source' }, 404);

    try {
      const body = await readSignedBody(c.req.raw);
      if (body === null) return c.json({ error: 'Body is not UTF-8' }, 400);
      const result = await sources.receive(sourceInstanceId, {
        body,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
        receivedAt: new Date().toISOString(),
      });
      if (result !== 'accepted') {
        const { status, error } = sourceRejections[result];
        return c.json({ error }, status);
      }
      onReceiptAccepted?.();
      return c.text('OK', 200);
    } catch (error) {
      getLog().error(
        { err: error as Error, sourceInstanceId, stage: 'receive' },
        'webhook_source_endpoint_error'
      );
      return c.json({ error: 'Internal server error' }, 500);
    }
  });
}
