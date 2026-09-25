/**
 * Tests for the GitHub webhook route — the seam that forwards the raw payload,
 * signature, X-GitHub-Delivery GUID, and X-GitHub-Event type into
 * GitHubAdapter.receiveWebhook().
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

// Mock logger to suppress noisy output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const { registerGithubWebhookRoute, registerWebhookSourceRoutes } = await import('./webhooks');
type GithubWebhookTarget = import('./webhooks').GithubWebhookTarget;

const mockReceiveWebhook = mock(
  async (
    _payload: string,
    _sig: string,
    _deliveryId?: string,
    _eventType?: string
  ): Promise<'accepted' | 'invalid_signature' | 'malformed'> => 'accepted'
);

function createWebhookApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  const github: GithubWebhookTarget = { receiveWebhook: mockReceiveWebhook };
  registerGithubWebhookRoute(app, github);
  return app;
}

const rawPayload = JSON.stringify({
  action: 'created',
  comment: { id: 1001, body: '@archon help', user: { login: 'user123' } },
});

async function postWebhook(
  app: OpenAPIHono,
  headers: Record<string, string>,
  body: string = rawPayload
): Promise<Response> {
  return await app.request('/webhooks/github', { method: 'POST', headers, body });
}

describe('POST /webhooks/github', () => {
  beforeEach(() => {
    mockReceiveWebhook.mockClear();
    mockReceiveWebhook.mockImplementation(async () => 'accepted');
  });

  test('forwards the raw payload, signature, delivery GUID, and event type', async () => {
    const app = createWebhookApp();

    const res = await postWebhook(app, {
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': 'sha256=abc123',
      'x-github-delivery': 'guid-1',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
    expect(mockReceiveWebhook).toHaveBeenCalledTimes(1);
    expect(mockReceiveWebhook).toHaveBeenCalledWith(
      rawPayload,
      'sha256=abc123',
      'guid-1',
      'issue_comment'
    );
  });

  test('passes deliveryId as undefined when the X-GitHub-Delivery header is omitted', async () => {
    const app = createWebhookApp();

    const res = await postWebhook(app, {
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': 'sha256=abc123',
    });

    expect(res.status).toBe(200);
    expect(mockReceiveWebhook).toHaveBeenCalledTimes(1);
    expect(mockReceiveWebhook).toHaveBeenCalledWith(
      rawPayload,
      'sha256=abc123',
      undefined,
      'issue_comment'
    );
  });

  test('passes the event type as undefined when X-GitHub-Event is omitted', async () => {
    const app = createWebhookApp();

    const res = await postWebhook(app, {
      'x-hub-signature-256': 'sha256=abc123',
      'x-github-delivery': 'guid-1',
    });

    expect(res.status).toBe(200);
    expect(mockReceiveWebhook).toHaveBeenCalledTimes(1);
    expect(mockReceiveWebhook).toHaveBeenCalledWith(
      rawPayload,
      'sha256=abc123',
      'guid-1',
      undefined
    );
  });

  test('rejects a request without a signature header before reaching the adapter', async () => {
    const app = createWebhookApp();

    const res = await postWebhook(app, {
      'x-github-event': 'issue_comment',
      'x-github-delivery': 'guid-1',
    });

    expect(res.status).toBe(400);
    expect(mockReceiveWebhook).not.toHaveBeenCalled();
  });

  test('returns 500 and logs the cause when durable receipt acceptance fails', async () => {
    const app = createWebhookApp();
    const cause = new Error('receipt persistence failed');
    mockReceiveWebhook.mockImplementation(async () => {
      throw cause;
    });
    mockLogger.error.mockClear();

    const res = await postWebhook(app, {
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': 'sha256=abc123',
      'x-github-delivery': 'guid-1',
    });

    expect(res.status).toBe(500);
    expect(mockReceiveWebhook).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: cause, deliveryId: 'guid-1' }),
      'webhook_endpoint_error'
    );
  });

  test('returns 500 when check-run processing rejects', async () => {
    const app = createWebhookApp();
    mockReceiveWebhook.mockImplementation(async () => {
      throw new Error('workflow signal failed');
    });

    const res = await postWebhook(app, {
      'x-github-event': 'check_run',
      'x-hub-signature-256': 'sha256=abc123',
      'x-github-delivery': 'guid-1',
    });

    expect(res.status).toBe(500);
    expect(mockReceiveWebhook).toHaveBeenCalledTimes(1);
  });
  test('does not acknowledge before durable intake completes', async () => {
    let complete: (() => void) | undefined;
    const pending = new Promise<void>(resolve => {
      complete = resolve;
    });
    mockReceiveWebhook.mockImplementation(async () => {
      await pending;
      return 'accepted';
    });
    const response = postWebhook(createWebhookApp(), { 'x-hub-signature-256': 'signed' });
    let acknowledged = false;
    void response.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    complete?.();
    expect((await response).status).toBe(200);
  });

  test.each([
    ['invalid_signature', 401],
    ['malformed', 400],
  ] as const)('returns a truthful %s rejection', async (result, status) => {
    mockReceiveWebhook.mockImplementation(async () => result);
    const response = await postWebhook(createWebhookApp(), { 'x-hub-signature-256': 'signed' });
    expect(response.status).toBe(status);
  });
});

describe('POST /webhooks/sources/:sourceInstanceId', () => {
  test.each([
    ['accepted', 200],
    ['malformed', 400],
    ['unauthenticated', 401],
  ] as const)('maps the durable host result %s to HTTP %s', async (result, status) => {
    const app = new OpenAPIHono();
    const receive = mock(async (_sourceInstanceId: string, _request: unknown) => result);
    const onReceiptAccepted = mock(() => undefined);
    registerWebhookSourceRoutes(
      app,
      { hasSource: id => id === 'configured', receive },
      onReceiptAccepted
    );
    const response = await app.request('/webhooks/sources/configured', {
      method: 'POST',
      headers: { 'x-source-header': 'value' },
      body: 'raw-body',
    });
    expect(response.status).toBe(status);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]?.[0]).toBe('configured');
    expect(receive.mock.calls[0]?.[1]).toMatchObject({
      body: 'raw-body',
      headers: { 'x-source-header': 'value' },
    });
    // Only a committed receipt asks the host to drain.
    expect(onReceiptAccepted).toHaveBeenCalledTimes(result === 'accepted' ? 1 : 0);
  });

  test('does not expose an unconfigured source or read its receiver', async () => {
    const app = new OpenAPIHono();
    const receive = mock(async () => 'accepted' as const);
    registerWebhookSourceRoutes(app, { hasSource: () => false, receive });
    const response = await app.request('/webhooks/sources/missing', {
      method: 'POST',
      body: 'untrusted',
    });
    expect(response.status).toBe(404);
    expect(receive).not.toHaveBeenCalled();
  });

  test('returns 500 and logs the cause when normalization or persistence fails', async () => {
    const app = new OpenAPIHono();
    const cause = new Error('receipt persistence failed');
    const onReceiptAccepted = mock(() => undefined);
    registerWebhookSourceRoutes(
      app,
      {
        hasSource: () => true,
        receive: async () => {
          throw cause;
        },
      },
      onReceiptAccepted
    );
    mockLogger.error.mockClear();
    const response = await app.request('/webhooks/sources/configured', {
      method: 'POST',
      body: 'raw',
    });
    expect(response.status).toBe(500);
    expect(onReceiptAccepted).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: cause, sourceInstanceId: 'configured' }),
      'webhook_source_endpoint_error'
    );
  });
});
