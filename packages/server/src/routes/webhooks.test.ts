/**
 * Tests for the GitHub webhook route — the seam that forwards the raw payload,
 * signature, X-GitHub-Delivery GUID, and X-GitHub-Event type into
 * GitHubAdapter.receiveWebhook().
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import createGitHubWebhookSource from '@archon/adapters/forge/github-source-plugin';
import { verifyGitHubWebhookSignature } from '@archon/adapters/forge/github/webhook-signature';
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

const {
  registerGiteaWebhookRoute,
  registerGitlabWebhookRoute,
  registerGithubWebhookRoute,
  registerWebhookSourceRoutes,
  MAX_WEBHOOK_BODY_BYTES,
} = await import('./webhooks');
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

  test('returns 500 and logs the cause when webhook reception fails', async () => {
    const app = createWebhookApp();
    const cause = new Error('webhook reception failed');
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
  test('does not acknowledge before receiveWebhook completes', async () => {
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

  test('verifies the received bytes without dropping a leading BOM', async () => {
    const response = await createWebhookApp().request('/webhooks/github', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'signed' },
      body: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{}')]),
    });
    expect(response.status).toBe(200);
    expect(mockReceiveWebhook.mock.calls[0]?.[0]).toBe('\uFEFF{}');
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
    ['conflict', 409],
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

  test('passes the received bytes through without dropping a leading BOM', async () => {
    const app = new OpenAPIHono();
    const receive = mock(
      async (_sourceInstanceId: string, _request: { body: string }) => 'accepted' as const
    );
    registerWebhookSourceRoutes(app, { hasSource: () => true, receive });
    const response = await app.request('/webhooks/sources/configured', {
      method: 'POST',
      body: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{}')]),
    });
    expect(response.status).toBe(200);
    expect(receive.mock.calls[0]?.[1].body).toBe('\uFEFF{}');
  });

  test('refuses a body that is not UTF-8 before the source reads it', async () => {
    const app = new OpenAPIHono();
    const receive = mock(async () => 'accepted' as const);
    registerWebhookSourceRoutes(app, { hasSource: () => true, receive });
    const response = await app.request('/webhooks/sources/configured', {
      method: 'POST',
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    expect(response.status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
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

const bodyLimit = MAX_WEBHOOK_BODY_BYTES;

function streamedBody(chunks: Uint8Array[], cancelError?: Error) {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
        if (cancelError) throw cancelError;
      },
    },
    { highWaterMark: 0 }
  );
  return {
    body,
    get pulls() {
      return pulls;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

const signingSecret = 'webhook-body-limit-test-secret';
function signBytes(bytes: Uint8Array): string {
  return `sha256=${createHmac('sha256', signingSecret).update(bytes).digest('hex')}`;
}

async function authenticatedApp(route: 'github' | 'sources/configured', bytes: Uint8Array) {
  const app = new OpenAPIHono();
  const assertBytes = (body: string) => {
    expect(Buffer.from(body).equals(bytes)).toBe(true);
  };
  if (route === 'github') {
    registerGithubWebhookRoute(app, {
      async receiveWebhook(body, signature) {
        assertBytes(body);
        return verifyGitHubWebhookSignature(body, signature, signingSecret)
          ? 'accepted'
          : 'invalid_signature';
      },
    });
  } else {
    const envKey = 'ARCHON_BODY_LIMIT_TEST_SECRET';
    const prior = process.env[envKey];
    let plugin: Awaited<ReturnType<typeof createGitHubWebhookSource>>;
    try {
      process.env[envKey] = signingSecret;
      plugin = await createGitHubWebhookSource({
        sourceInstanceId: 'configured',
        config: { version: 1, webhookSecretEnv: envKey, host: 'github.com', bindings: [] },
      });
    } finally {
      if (prior === undefined) delete process.env[envKey];
      else process.env[envKey] = prior;
    }
    registerWebhookSourceRoutes(app, {
      hasSource: () => true,
      async receive(_id, request) {
        assertBytes(request.body);
        const result = await plugin.receive(request);
        if (result.status === 'rejected') return result.reason;
        return result.acceptance.outcome === 'malformed' ? 'malformed' : 'accepted';
      },
    });
  }
  return app;
}

for (const route of ['github', 'sources/configured'] as const) {
  describe(`body admission: /webhooks/${route}`, () => {
    function setup(eligible = true) {
      const app = new OpenAPIHono();
      const receive = mock(async () => 'accepted' as const);
      const drain = mock(() => undefined);
      if (route === 'github') registerGithubWebhookRoute(app, { receiveWebhook: receive });
      else registerWebhookSourceRoutes(app, { hasSource: () => eligible, receive }, drain);
      return { app, receive, drain };
    }

    test.each([33_554_431, 33_554_432])(
      'authenticates all %s bytes at the inclusive boundary',
      async size => {
        const bytes = new TextEncoder().encode('{}' + ' '.repeat(size - 2));
        const signature = signBytes(bytes);
        const app = await authenticatedApp(route, bytes);
        const stream = streamedBody([bytes.subarray(0, size - 1), bytes.subarray(size - 1)]);
        const response = await app.request(`/webhooks/${route}`, {
          method: 'POST',
          headers: { 'x-hub-signature-256': signature },
          body: stream.body,
        });
        expect(response.status).toBe(200);
        expect(stream.pulls).toBe(3);
        expect(stream.cancelled).toBe(false);
        bytes[size - 1] = 0x09;
        const rejected = await app.request(`/webhooks/${route}`, {
          method: 'POST',
          headers: { 'x-hub-signature-256': signature },
          body: bytes,
        });
        expect(rejected.status).toBe(401);
      }
    );

    test('preserves a split BOM and multibyte character for authentication', async () => {
      const bytes = new TextEncoder().encode('\uFEFF{"text":"😀"}');
      const app = await authenticatedApp(route, bytes);
      const stream = streamedBody(Array.from(bytes, byte => new Uint8Array([byte])));
      const response = await app.request(`/webhooks/${route}`, {
        method: 'POST',
        headers: { 'x-hub-signature-256': signBytes(bytes) },
        body: stream.body,
      });
      // The source authenticates the BOM, then JSON.parse rejects it as before.
      expect(response.status).toBe(route === 'github' ? 200 : 400);
      expect(stream.pulls).toBe(bytes.length + 1);
    });

    test.each([true, false])(
      'preserves in-limit rejection precedence (eligible=%s)',
      async eligible => {
        const { app, receive } = setup(eligible);
        const response = await app.request(`/webhooks/${route}`, {
          method: 'POST',
          headers: eligible ? { 'x-hub-signature-256': 'signed' } : {},
          body: new Uint8Array([0xff]),
        });
        expect(response.status).toBe(eligible || route === 'github' ? 400 : 404);
        expect(receive).not.toHaveBeenCalled();
      }
    );

    test('keeps 413 and logs a cancellation failure', async () => {
      const { app, receive } = setup();
      const cause = new Error('cancel failed');
      const stream = streamedBody([new Uint8Array(bodyLimit), new Uint8Array([1])], cause);
      mockLogger.warn.mockClear();
      const response = await app.request(`/webhooks/${route}`, {
        method: 'POST',
        headers: { 'x-hub-signature-256': 'signed' },
        body: stream.body,
      });
      expect(response.status).toBe(413);
      expect(receive).not.toHaveBeenCalled();
      expect(stream.body.locked).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith({ err: cause }, 'webhook_body_cancel_failed');
    });

    test.each([true, false])('preserves stream failure responses (eligible=%s)', async eligible => {
      const { app, receive, drain } = setup(eligible);
      const cause = new Error('read failed');
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(cause);
        },
      });
      mockLogger.error.mockClear();
      const response = await app.request(`/webhooks/${route}`, {
        method: 'POST',
        headers: eligible ? { 'x-hub-signature-256': 'signed' } : {},
        body,
      });
      expect(response.status).toBe(eligible ? 500 : route === 'github' ? 400 : 404);
      expect(await response.json()).toEqual({
        error: eligible
          ? 'Internal server error'
          : route === 'github'
            ? 'Missing signature header'
            : 'Unknown webhook source',
      });
      expect(receive).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
      if (eligible) {
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ err: cause }),
          expect.any(String)
        );
      } else {
        expect(mockLogger.error).not.toHaveBeenCalled();
      }
    });

    test('returns 413 for a chunked HTTP request through Bun', async () => {
      const { app, receive, drain } = setup();
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(request) {
          expect(request.headers.get('content-length')).toBeNull();
          expect(request.headers.get('transfer-encoding')).toBe('chunked');
          return app.fetch(request);
        },
      });
      try {
        const chunk = new Uint8Array(1024 * 1024);
        const stream = streamedBody(Array.from({ length: 34 }, () => chunk));
        const response = await fetch(new URL(`/webhooks/${route}`, server.url), {
          method: 'POST',
          headers: { 'x-hub-signature-256': 'signed' },
          body: stream.body,
        });
        expect(response.status).toBe(413);
        expect(receive).not.toHaveBeenCalled();
        expect(drain).not.toHaveBeenCalled();
        await response.text();
      } finally {
        await server.stop(true);
      }
    });

    test('refuses an ineligible request before reading the body', async () => {
      const { app, receive, drain } = setup(false);
      const stream = streamedBody([new Uint8Array(bodyLimit + 1)]);
      const response = await app.request(`/webhooks/${route}`, {
        method: 'POST',
        headers: { 'content-length': String(bodyLimit + 1) },
        body: stream.body,
      });
      expect(response.status).toBe(route === 'github' ? 400 : 404);
      expect(stream.pulls).toBe(0);
      expect(receive).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
    });

    test('rejects declared oversize before pulling', async () => {
      const { app, receive, drain } = setup();
      const stream = streamedBody([new Uint8Array([1])]);
      const response = await app.request(`/webhooks/${route}`, {
        method: 'POST',
        headers: { 'x-hub-signature-256': 'signed', 'content-length': String(bodyLimit + 1) },
        body: stream.body,
      });
      expect(response.status).toBe(413);
      expect(stream.pulls).toBe(0);
      expect(receive).not.toHaveBeenCalled();
      expect(drain).not.toHaveBeenCalled();
    });

    test.each([undefined, '1'] as const)(
      'stops and cancels on the crossing chunk (Content-Length=%s)',
      async length => {
        const { app, receive, drain } = setup();
        const prefix = new Uint8Array(bodyLimit);
        prefix[0] = 0xff;
        const stream = streamedBody([prefix, new Uint8Array([1]), new Uint8Array([1])]);
        const headers: Record<string, string> = { 'x-hub-signature-256': 'signed' };
        if (length) headers['content-length'] = length;
        const response = await app.request(`/webhooks/${route}`, {
          method: 'POST',
          headers,
          body: stream.body,
        });
        expect(response.status).toBe(413);
        expect(stream.pulls).toBe(2);
        expect(stream.cancelled).toBe(true);
        expect(stream.body.locked).toBe(false);
        expect(receive).not.toHaveBeenCalled();
        expect(drain).not.toHaveBeenCalled();
      }
    );
  });
}

test('source acknowledgement and drain wait for durable intake', async () => {
  const app = new OpenAPIHono();
  const entered = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const drain = mock(() => undefined);
  registerWebhookSourceRoutes(
    app,
    {
      hasSource: () => true,
      async receive() {
        entered.resolve();
        await completed.promise;
        return 'accepted';
      },
    },
    drain
  );
  let acknowledged = false;
  const response = Promise.resolve(
    app.request('/webhooks/sources/configured', { method: 'POST', body: '{}' })
  );
  void response.then(() => {
    acknowledged = true;
  });
  await entered.promise;
  expect(acknowledged).toBe(false);
  expect(drain).not.toHaveBeenCalled();
  completed.resolve();
  expect((await response).status).toBe(200);
  expect(drain).toHaveBeenCalledTimes(1);
});

test('the webhook limit does not apply to other routes', async () => {
  const app = createWebhookApp();
  registerWebhookSourceRoutes(app, { hasSource: () => true, receive: async () => 'accepted' });
  app.post('/unrelated', async c => c.json({ size: (await c.req.raw.arrayBuffer()).byteLength }));
  const response = await app.request('/unrelated', {
    method: 'POST',
    body: new Uint8Array(bodyLimit + 1),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ size: bodyLimit + 1 });
});

describe('POST /webhooks/gitea', () => {
  const secret = 'gitea-route-test-secret';
  const sign = (bytes: Uint8Array) => createHmac('sha256', secret).update(bytes).digest('hex');

  function setup() {
    const app = new OpenAPIHono();
    const handleWebhook = mock(async (_payload: Uint8Array, _signature: string) => undefined);
    registerGiteaWebhookRoute(app, { handleWebhook });
    return { app, handleWebhook };
  }

  test('hands the adapter the exact signed bytes, BOM included', async () => {
    const { app, handleWebhook } = setup();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{}')]);
    const response = await app.request('/webhooks/gitea', {
      method: 'POST',
      headers: { 'x-gitea-signature': sign(bytes) },
      body: bytes,
    });
    expect(response.status).toBe(200);
    const [received, signature] = handleWebhook.mock.calls[0] ?? [];
    expect(received).toEqual(bytes);
    expect(signature).toBe(sign(bytes));
  });

  test('rejects a request without a signature header before reading the body', async () => {
    const { app, handleWebhook } = setup();
    const stream = streamedBody([new Uint8Array([1])]);
    const response = await app.request('/webhooks/gitea', { method: 'POST', body: stream.body });
    expect(response.status).toBe(400);
    expect(stream.pulls).toBe(0);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  test('returns 413 on a declared oversize body before pulling', async () => {
    const { app, handleWebhook } = setup();
    const stream = streamedBody([new Uint8Array([1])]);
    const response = await app.request('/webhooks/gitea', {
      method: 'POST',
      headers: { 'x-gitea-signature': 'signed', 'content-length': String(bodyLimit + 1) },
      body: stream.body,
    });
    expect(response.status).toBe(413);
    expect(stream.pulls).toBe(0);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  test('stops and cancels a streamed body on the chunk that crosses the limit', async () => {
    const { app, handleWebhook } = setup();
    const stream = streamedBody([new Uint8Array(bodyLimit), new Uint8Array([1])]);
    const response = await app.request('/webhooks/gitea', {
      method: 'POST',
      headers: { 'x-gitea-signature': 'signed' },
      body: stream.body,
    });
    expect(response.status).toBe(413);
    expect(stream.cancelled).toBe(true);
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/gitlab', () => {
  function setup() {
    const app = new OpenAPIHono();
    const handleWebhook = mock(async (_payload: string, _token: string) => undefined);
    registerGitlabWebhookRoute(app, { handleWebhook });
    return { app, handleWebhook };
  }

  test('hands the adapter the body and token', async () => {
    const { app, handleWebhook } = setup();
    const response = await app.request('/webhooks/gitlab', {
      method: 'POST',
      headers: { 'x-gitlab-token': 'secret' },
      body: '{"a":1}',
    });
    expect(response.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith('{"a":1}', 'secret');
  });

  test('rejects a request without a token header before reading the body', async () => {
    const { app, handleWebhook } = setup();
    const stream = streamedBody([new Uint8Array([1])]);
    const response = await app.request('/webhooks/gitlab', { method: 'POST', body: stream.body });
    expect(response.status).toBe(400);
    expect(stream.pulls).toBe(0);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  test('returns 413 on a declared oversize body before pulling', async () => {
    const { app, handleWebhook } = setup();
    const stream = streamedBody([new Uint8Array([1])]);
    const response = await app.request('/webhooks/gitlab', {
      method: 'POST',
      headers: { 'x-gitlab-token': 'any', 'content-length': String(bodyLimit + 1) },
      body: stream.body,
    });
    expect(response.status).toBe(413);
    expect(stream.pulls).toBe(0);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  test('stops and cancels a streamed body on the chunk that crosses the limit', async () => {
    const { app, handleWebhook } = setup();
    const stream = streamedBody([new Uint8Array(bodyLimit), new Uint8Array([1])]);
    const response = await app.request('/webhooks/gitlab', {
      method: 'POST',
      headers: { 'x-gitlab-token': 'any' },
      body: stream.body,
    });
    expect(response.status).toBe(413);
    expect(stream.cancelled).toBe(true);
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});
