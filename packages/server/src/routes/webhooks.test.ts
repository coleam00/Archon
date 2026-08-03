/**
 * Tests for the GitHub webhook route — the seam that forwards the raw payload,
 * signature, and X-GitHub-Delivery GUID into GitHubAdapter.handleWebhook().
 * The adapter's own tests pass deliveryId directly, so only this file catches
 * a silently broken header-forwarding path.
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

const mockHandleWebhook = mock(async (_payload: string, _sig: string, _deliveryId?: string) => {});

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

function postWebhook(
  app: OpenAPIHono,
  headers: Record<string, string>,
  body: string = rawPayload
): Promise<Response> {
  return app.request('/webhooks/github', { method: 'POST', headers, body });
}

describe('POST /webhooks/github', () => {
  beforeEach(() => {
    mockHandleWebhook.mockClear();
    mockHandleWebhook.mockImplementation(async () => {});
  });

  test('forwards raw payload, signature, and X-GitHub-Delivery GUID to the adapter', async () => {
    const app = createWebhookApp();

    const res = await postWebhook(app, {
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': 'sha256=abc123',
      'x-github-delivery': 'guid-1',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
    expect(mockHandleWebhook).toHaveBeenCalledWith(rawPayload, 'sha256=abc123', 'guid-1');
  });

  test('passes deliveryId as undefined when the X-GitHub-Delivery header is omitted', async () => {
    const app = createWebhookApp();

    const res = await postWebhook(app, {
      'x-github-event': 'issue_comment',
      'x-hub-signature-256': 'sha256=abc123',
    });

    expect(res.status).toBe(200);
    expect(mockHandleWebhook).toHaveBeenCalledTimes(1);
    expect(mockHandleWebhook).toHaveBeenCalledWith(rawPayload, 'sha256=abc123', undefined);
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

  test('returns 200 even when async webhook processing rejects (fire-and-forget)', async () => {
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
});
