/**
 * Tests for the GitHub webhook route — the seam that forwards the raw payload,
 * signature, X-GitHub-Delivery GUID, and X-GitHub-Event type into
 * GitHubAdapter.handleWebhook().
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

const { registerGithubWebhookRoute } = await import('./webhooks');
type GithubWebhookTarget = import('./webhooks').GithubWebhookTarget;

const mockHandleWebhook = mock(
  async (_payload: string, _sig: string, _deliveryId?: string, _eventType?: string) => {}
);

function createWebhookApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  const github: GithubWebhookTarget = { handleWebhook: mockHandleWebhook };
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
    mockHandleWebhook.mockClear();
    mockHandleWebhook.mockImplementation(async () => {});
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
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
    expect(mockHandleWebhook).toHaveBeenCalledWith(
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
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
    expect(mockHandleWebhook).toHaveBeenCalledWith(
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
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
    expect(mockHandleWebhook).toHaveBeenCalledWith(
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
    expect(mockHandleWebhook).not.toHaveBeenCalled();
  });

  test('returns 200 when conversational webhook processing later rejects', async () => {
    const app = createWebhookApp();
    mockHandleWebhook.mockImplementation(async () => {
      throw new Error('downstream processing failed');
    });

    const res = await postWebhook(app, {
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': 'sha256=abc123',
      'x-github-delivery': 'guid-1',
    });

    expect(res.status).toBe(200);
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
  });

  test('returns 500 when check-run processing rejects', async () => {
    const app = createWebhookApp();
    mockHandleWebhook.mockImplementation(async () => {
      throw new Error('workflow signal failed');
    });

    const res = await postWebhook(app, {
      'x-github-event': 'check_run',
      'x-hub-signature-256': 'sha256=abc123',
      'x-github-delivery': 'guid-1',
    });

    expect(res.status).toBe(500);
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
  });
});
