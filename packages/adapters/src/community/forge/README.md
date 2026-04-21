# Community Forge Adapters

Forge adapter는 webhook을 통해 HarneesLab을 GitHub, GitLab 같은 code hosting platform에 연결합니다.

## Interface

`@harneeslab/core`의 `IPlatformAdapter`를 구현합니다.

```typescript
import type { IPlatformAdapter } from '@harneeslab/core';

export class MyForgeAdapter implements IPlatformAdapter {
  async handleWebhook(payload: string, signature: string): Promise<void> {
    // 1. Verify webhook signature
    // 2. Parse event (issue comment, PR review, etc.)
    // 3. Check authorization
    // 4. Route to handleMessage or command handler
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    // Post comment on issue/PR
  }

  async start(): Promise<void> {
    // Initialize API client
  }

  stop(): void {
    // Cleanup
  }

  // ... implement remaining IPlatformAdapter methods
}
```

## Chat Adapter와 다른 점

- **Webhook-driven**: event는 polling이 아니라 HTTP POST로 들어옵니다.
- **더 무거운 lifecycle**: repo, codebase, isolation environment를 함께 다룹니다.
- **Conversation ID**: 일반적으로 `owner/repo#number` 형식입니다.
- **Auth**: webhook signature verification과 user allowlist를 함께 사용합니다.

## Directory Structure

```
community/forge/
└── your-adapter/
    ├── adapter.ts      # Main adapter class
    ├── auth.ts         # Webhook signature + user auth
    ├── types.ts        # Webhook event types
    ├── index.ts        # Barrel export
    └── adapter.test.ts
```

## Registration

`packages/server/src/index.ts`에 webhook route와 함께 등록합니다.

```typescript
import { MyForgeAdapter } from '@harneeslab/adapters/community/forge/my-forge';

// In main():
const myForge = new MyForgeAdapter(token, secret, lockManager);
await myForge.start();

// Add webhook endpoint
app.post('/webhooks/my-forge', async (c) => {
  const signature = c.req.header('x-signature');
  if (!signature) return c.json({ error: 'Missing signature' }, 400);
  const payload = await c.req.text();
  myForge.handleWebhook(payload, signature).catch(/* error handler */);
  return c.text('OK', 200);
});
```

## Testing

### Mock isolation (필수)

Bun의 `mock.module()`은 process-global이고 되돌릴 수 없습니다. `mock.restore()`로는 원복되지 않습니다. 다른 test를 오염시키지 않도록 이 test file은 반드시 별도 `bun test` invocation에서 실행해야 합니다.

test file을 추가했다면 `packages/adapters/package.json`에 별도 batch를 추가합니다.

```json
"test": "... existing batches ... && bun test src/community/forge/your-adapter/adapter.test.ts"
```

같은 module(예: `@harneeslab/paths`, `@harneeslab/git`)을 다른 방식으로 mock하는 기존 batch에 새 test를 추가하지 마세요.

### Lazy logger pattern

test mock이 logger 생성 전에 `createLogger`를 가로챌 수 있도록 module-level `cachedLog`와 `getLog()` getter를 사용합니다.

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.my-forge');
  return cachedLog;
}
```

### Log event naming

`{domain}.{action}_{state}` convention을 따릅니다. 표준 state는 `_started`, `_completed`, `_failed`입니다. `_started`는 항상 `_completed` 또는 `_failed`와 짝을 맞춥니다.

```typescript
// ✅ CORRECT
getLog().info({ conversationId }, 'adapter.comment_post_completed');
getLog().error({ err, conversationId }, 'adapter.comment_post_failed');

// ❌ WRONG
getLog().info({ conversationId }, 'comment_posted');
getLog().error({ err }, 'error_posting');
```

## Reference

완성된 예시는 GitHub adapter(`packages/adapters/src/forge/github/`)를 참고하세요.
