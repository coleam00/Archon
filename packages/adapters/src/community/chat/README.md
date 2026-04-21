# Community Chat Adapters

Chat adapter는 polling 또는 WebSocket을 통해 HarneesLab을 Slack, Telegram, Discord 같은 messaging platform에 연결합니다.

## Interface

`@harneeslab/core`의 `IPlatformAdapter`를 구현합니다.

```typescript
import type { IPlatformAdapter } from '@harneeslab/core';

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

각 adapter는 독립된 directory에 둡니다.

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

adapter를 만든 뒤 `packages/server/src/index.ts`에 등록합니다.

```typescript
import { MyAdapter } from '@harneeslab/adapters/community/chat/my-adapter';

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

### Mock isolation (필수)

Bun의 `mock.module()`은 process-global이고 되돌릴 수 없습니다. `mock.restore()`로는 원복되지 않습니다. 같은 batch의 기존 test file과 다른 방식으로 module을 mock한다면, 해당 test file은 반드시 별도 `bun test` invocation에서 실행해야 합니다.

어떤 test file이 같은 batch를 공유하는지는 `packages/adapters/package.json`에서 확인하세요. 같은 module(예: `@harneeslab/paths`)을 다른 export로 mock한다면 별도 batch로 분리합니다.

```json
"test": "... existing batches ... && bun test src/community/chat/your-adapter/adapter.test.ts"
```

### Lazy logger pattern

test mock이 logger 생성 전에 `createLogger`를 가로챌 수 있도록 module-level `cachedLog`와 `getLog()` getter를 사용합니다.

```typescript
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.my-chat');
  return cachedLog;
}
```

## Reference

완성된 예시는 Discord adapter(`discord/`)를 참고하세요.
