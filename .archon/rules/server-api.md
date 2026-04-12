---
paths:
  - "packages/server/**/*.ts"
---

# Server API Conventions

## Hono Framework

```typescript
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';

// CORS: allow-all for single-developer tool (override with WEB_UI_ORIGIN)
app.use('/api/*', cors({ origin: process.env.WEB_UI_ORIGIN || '*' }));

// Error response helper pattern
function apiError(c: Context, status: 400 | 404 | 500, message: string): Response {
  return c.json({ error: message }, status);
}
```

## SSE Streaming

Always check `stream.closed` before writing. Use `stream.onAbort()` for cleanup. Hono's `streamSSE` callback receives an SSE writer:

```typescript
app.get('/api/stream/:id', (c) => {
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      transport.removeStream(conversationId, writer);
    });
    // Write events:
    if (!stream.closed) {
      await stream.writeSSE({ data: JSON.stringify(event) });
    }
  });
});
```

`SSETransport` in `src/adapters/web/transport.ts` manages the stream registry. `removeStream()` accepts an `expectedStream` reference to prevent race conditions (StrictMode double-mount).

## Webhook Signature Verification

```typescript
// ALWAYS use c.req.text() for raw webhook body — JSON.parse separately
const payload = await c.req.text();
const signature = c.req.header('X-Hub-Signature-256') ?? '';

// timingSafeEqual prevents timing attacks
const hmac = createHmac('sha256', webhookSecret);
const digest = 'sha256=' + hmac.update(payload).digest('hex');
const isValid = timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
```

Return 200 immediately for webhook events; process async. Never log the full signature.

## Auto Port Allocation (Worktrees)

`getPort()` from `@archon/core` returns:
- Main repo: `PORT` env var or `3090`
- Worktrees: hash-based port in range 3190–4089 (deterministic per worktree path)

Same worktree always gets same port. Override with `PORT=4000` env var.

## Static SPA Fallback

```typescript
// Serve web dist; fall back to index.html for client-side routing
app.use('/*', serveStatic({ root: path.join(import.meta.dir, '../../web/dist') }));
app.get('*', (c) => c.html(/* index.html */));
```

Use `import.meta.dir` (absolute) NOT relative paths — `bun --filter @archon/server start` changes CWD to `packages/server/`.

## Graceful Shutdown

```typescript
process.on('SIGTERM', () => {
  stopCleanupScheduler();
  void pool.close();
  process.exit(0);
});
```

## Key API Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/conversations` | List conversations |
| POST | `/api/conversations` | Create conversation |
| POST | `/api/conversations/:id/message` | Send message |
| GET | `/api/stream/:id` | SSE stream |
| GET | `/api/workflows` | List workflows |
| POST | `/api/workflows/validate` | Validate YAML (in-memory) |
| GET | `/api/workflows/:name` | Get single workflow |
| PUT | `/api/workflows/:name` | Save workflow |
| DELETE | `/api/workflows/:name` | Delete workflow |
| GET | `/api/commands` | List commands |
| POST | `/webhooks/github` | GitHub webhook |

## Anti-patterns

- Never use `c.req.json()` for webhooks — signature must be verified against raw body
- Never expose API keys in JSON error responses
- Never serve static files with relative paths (use `import.meta.dir`)
- Never skip the `stream.closed` check before writing SSE
- Never call platform adapters directly from route handlers — use `handleMessage()` + lock manager
