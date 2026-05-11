# Community Chat Adapters

Chat adapters connect Archon to messaging platforms (Slack, Telegram, Discord, etc.) via polling or WebSocket.

## Interface

Implement `IPlatformAdapter` from `@archon/core`:

```typescript
import type { IPlatformAdapter } from '@archon/core';

interface MyMessageContext {
  conversationId: string;
  message: string;
}

export class MyChatAdapter implements IPlatformAdapter {
  private messageHandler?: (ctx: MyMessageContext) => Promise<void>;

  onMessage(handler: (ctx: MyMessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    // Send message to platform
  }

  async start(): Promise<void> {
    // Connect to platform, start polling/listening
  }

  stop(): void {
    // Disconnect
  }

  // ... implement remaining IPlatformAdapter methods
}
```

## Directory Structure

Each adapter lives in its own directory:

```
community/chat/
├── discord/        # Reference implementation
│   ├── adapter.ts  # Main adapter class
│   ├── auth.ts     # Platform-specific auth
│   ├── types.ts    # Platform-specific types
│   ├── index.ts    # Barrel export
│   └── adapter.test.ts
└── your-adapter/
    ├── adapter.ts
    ├── auth.ts
    ├── types.ts
    ├── index.ts
    └── adapter.test.ts
```

## Registration

After creating your adapter, register it in `packages/server/src/index.ts`:

```typescript
import { MyAdapter } from '@archon/adapters/community/chat/my-adapter';

// In main():
if (process.env.MY_PLATFORM_TOKEN) {
  const myAdapter = new MyAdapter(process.env.MY_PLATFORM_TOKEN);
  myAdapter.onMessage(async (ctx) => {
    lockManager.acquireLock(ctx.conversationId, async () => {
      await handleMessage(myAdapter, ctx.conversationId, ctx.message);
    }).catch(createMessageErrorHandler('MyPlatform', myAdapter, ctx.conversationId));
  });
  await myAdapter.start();
}
```

## Testing

### Mock isolation (required)

Bun's `mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it. Your test file **must** run in its own `bun test` invocation if it mocks modules differently from existing test files in the same batch.

Check `packages/adapters/package.json` to see which test files share a batch. If your test mocks the same modules (e.g., `@archon/paths`) with different exports, split it into a separate batch:

```json
"test": "... existing batches ... && bun test src/community/chat/your-adapter/adapter.test.ts"
```

### Lazy logger pattern

Always use a module-level `cachedLog` + `getLog()` getter so test mocks can intercept `createLogger` before the logger is instantiated:

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.my-chat');
  return cachedLog;
}
```

## Reference

See the Discord adapter (`discord/`) for a complete working example.
