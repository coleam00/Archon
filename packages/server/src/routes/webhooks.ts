/**
 * Webhook routes — raw source-to-server ingestion endpoints.
 *
 * Registered outside the OpenAPI surface: webhooks are signed
 * machine-to-machine payloads verified against the raw request body, not part
 * of the published API.
 */

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { GitHubAdapter } from '@archon/adapters';
import type { GiteaAdapter } from '@archon/adapters/community/forge/gitea';
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

// GitHub caps deliveries at 25 MB; leave headroom without changing API body limits.
export const MAX_WEBHOOK_BODY_BYTES = 32 * 1024 * 1024;

type BoundedBody =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'too_large' }
  | { kind: 'read_failed'; error: unknown };

type SignedBody =
  | { kind: 'ok'; body: string }
  | { kind: 'invalid_utf8' }
  | { kind: 'too_large' }
  | { kind: 'read_failed'; error: unknown };

async function cancelOversizedBody(
  body: Pick<ReadableStreamDefaultReader<Uint8Array>, 'cancel'>
): Promise<void> {
  try {
    await body.cancel();
  } catch (error) {
    getLog().warn({ err: error }, 'webhook_body_cancel_failed');
  }
}

async function readBoundedBody(request: Request): Promise<BoundedBody> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    if (request.body) await cancelOversizedBody(request.body);
    return { kind: 'too_large' };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_WEBHOOK_BODY_BYTES) {
          await cancelOversizedBody(reader);
          return { kind: 'too_large' };
        }
        chunks.push(value);
      }
    } catch (error) {
      return { kind: 'read_failed', error };
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', bytes };
}

async function readSignedBody(request: Request): Promise<SignedBody> {
  const body = await readBoundedBody(request);
  if (body.kind !== 'ok') return body;
  try {
    // Signatures cover bytes: preserve the BOM and reject lossy UTF-8 decoding.
    return {
      kind: 'ok',
      body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body.bytes),
    };
  } catch {
    return { kind: 'invalid_utf8' };
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
      if (payload.kind === 'too_large') return c.json({ error: 'Payload too large' }, 413);
      if (payload.kind === 'read_failed') throw payload.error;
      if (payload.kind === 'invalid_utf8') return c.json({ error: 'Body is not UTF-8' }, 400);

      // Conversation handling runs asynchronously without a durable receipt;
      // HTTP 200 does not guarantee that processing will succeed or survive a restart.
      const result = await github.receiveWebhook(payload.body, signature, deliveryId, eventType);
      if (result === 'invalid_signature') return c.json({ error: 'Invalid signature' }, 401);
      if (result === 'malformed') return c.json({ error: 'Malformed payload' }, 400);

      return c.text('OK', 200);
    } catch (error) {
      getLog().error({ err: error as Error, eventType, deliveryId }, 'webhook_endpoint_error');
      return c.json({ error: 'Internal server error' }, 500);
    }
  });
}

/** The slice of GiteaAdapter the webhook route depends on. */
export type GiteaWebhookTarget = Pick<GiteaAdapter, 'handleWebhook'>;

export function registerGiteaWebhookRoute(app: OpenAPIHono, gitea: GiteaWebhookTarget): void {
  app.post('/webhooks/gitea', async c => {
    const eventType = c.req.header('x-gitea-event');

    try {
      const signature = c.req.header('x-gitea-signature');
      if (!signature) {
        return c.json({ error: 'Missing signature header' }, 400);
      }

      const payload = await readBoundedBody(c.req.raw);
      if (payload.kind === 'too_large') return c.json({ error: 'Payload too large' }, 413);
      if (payload.kind === 'read_failed') throw payload.error;

      // Process async (fire-and-forget for fast webhook response)
      gitea.handleWebhook(payload.bytes, signature).catch((error: unknown) => {
        getLog().error({ err: error, eventType }, 'gitea_webhook_processing_error');
      });

      return c.text('OK', 200);
    } catch (error) {
      getLog().error({ err: error, eventType }, 'gitea_webhook_endpoint_error');
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
    try {
      if (!sources.hasSource(sourceInstanceId))
        return c.json({ error: 'Unknown webhook source' }, 404);
      const body = await readSignedBody(c.req.raw);
      if (body.kind === 'too_large') return c.json({ error: 'Payload too large' }, 413);
      if (body.kind === 'read_failed') throw body.error;
      if (body.kind === 'invalid_utf8') return c.json({ error: 'Body is not UTF-8' }, 400);
      const result = await sources.receive(sourceInstanceId, {
        body: body.body,
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
