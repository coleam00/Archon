---
title: Community Provider 추가하기
description: packages/providers/src/community/ 아래에 새 AI agent provider를 추가하는 단계별 가이드.
---

Archon의 provider registry(Phase 2, [#1195](https://github.com/coleam00/Archon/pull/1195))는 community provider를 단일 디렉터리 안의 변경만으로 추가할 수 있도록 설계되어 있습니다. 이 가이드는 Pi provider를 reference implementation으로 삼아 그 패턴을 설명합니다(`packages/providers/src/community/pi/`).

## 구현 Contract

모든 provider는 `@archon/providers/types`의 `IAgentProvider`를 구현합니다.

```typescript
export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk>;

  getType(): string;
  getCapabilities(): ProviderCapabilities;
}
```

Provider는 `MessageChunk` variant stream을 yield합니다(`packages/providers/src/types.ts` 참고). Archon은 모든 backend를 이 shape로 normalize하므로, platform adapter, DAG executor, orchestrator는 상대가 Claude, Codex, Pi, 또는 여러분의 provider인지 알 필요가 없습니다.

## 디렉터리 구조

Community provider는 전체가 `packages/providers/src/community/<your-provider-id>/` 아래에 위치합니다. Pi provider는 다음 구조를 사용합니다.

```
packages/providers/src/community/pi/
├── provider.ts          # PiProvider class (IAgentProvider impl)
├── capabilities.ts      # PI_CAPABILITIES constant
├── config.ts            # parsePiConfig, PiProviderDefaults
├── model-ref.ts         # model-string parsing + compat check
├── event-bridge.ts      # SDK-event → MessageChunk conversion
├── session-resolver.ts  # optional: session lifecycle helpers
├── options-translator.ts  # optional: nodeConfig → SDK-options translation
├── registration.ts      # registerPiProvider()
├── resource-loader.ts   # optional: SDK-specific helpers
├── index.ts             # public exports
└── *.test.ts            # co-located tests
```

각 파일은 한 가지 역할만 맡습니다. Optional file은 변환해야 할 surface가 단순하지 않을 때만 둡니다. 최소 provider라면 `provider.ts` + `capabilities.ts` + `registration.ts` + `index.ts` + 테스트 파일 하나로 충분할 수 있습니다.

## 단계별 절차

### 1. Capabilities (정직하게 시작하기)

실제로 연결한 기능만 선언하세요. workflow node가 provider가 지원하지 않는 기능을 사용할 때 dag-executor는 사용자에게 warning을 냅니다. 적게 선언하면 warning을 통해 바로잡을 수 있지만, 과하게 선언하면 Archon이 configuration을 조용히 버리게 됩니다.

```typescript
// capabilities.ts
import type { ProviderCapabilities } from '../../types';

export const YOUR_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: false,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
```

처음에는 모두 `false`로 시작하세요. 각 translation을 연결할 때마다 하나씩 `true`로 바꾸고, 바꿀 때마다 테스트를 추가합니다.

### 2. Provider class

`IAgentProvider`를 구현합니다. 패턴은 다음과 같습니다.

```typescript
// provider.ts
import { createLogger } from '@archon/paths';
import type { IAgentProvider, MessageChunk, ProviderCapabilities, SendQueryOptions } from '../../types';
import { YOUR_CAPABILITIES } from './capabilities';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog() {
  if (!cachedLog) cachedLog = createLogger('provider.your-id');
  return cachedLog;
}

export class YourProvider implements IAgentProvider {
  async *sendQuery(prompt, cwd, resumeSessionId, options): AsyncGenerator<MessageChunk> {
    // 1. Parse assistantConfig (user-level defaults from .archon/config.yaml)
    // 2. Resolve model (options.model || config default)
    // 3. Resolve auth (options.env → process.env → config)
    // 4. Translate nodeConfig to SDK options (only for capabilities you declared)
    // 5. Invoke SDK, yield normalized MessageChunks
    // 6. Include sessionId in final `result` chunk (for resume)
  }

  getType() { return 'your-id'; }
  getCapabilities() { return YOUR_CAPABILITIES; }
}
```

Retry, fail-fast auth validation, resume fallback까지 포함된 전체 reference는 `packages/providers/src/community/pi/provider.ts`를 보세요.

### 3. Registration

각 community provider는 `register*Provider()` 함수를 export합니다. 이 함수는 idempotent해야 합니다. 여러 bootstrap site에서 호출해도 안전하도록 `isRegisteredProvider(id)`로 guard하세요.

```typescript
// registration.ts
import { isRegisteredProvider, registerProvider } from '../../registry';
import { YOUR_CAPABILITIES } from './capabilities';
import { YourProvider } from './provider';

export function registerYourProvider(): void {
  if (isRegisteredProvider('your-id')) return;
  registerProvider({
    id: 'your-id',
    displayName: 'Your Provider (community)',
    factory: () => new YourProvider(),
    capabilities: YOUR_CAPABILITIES,
    isModelCompatible: (model) => /* pattern check */,
    builtIn: false, // ← important: community providers are NOT built-in
  });
}
```

그 다음 `packages/providers/src/registry.ts`의 aggregator에 한 줄을 추가합니다.

```typescript
export function registerCommunityProviders(): void {
  registerPiProvider();
  registerYourProvider(); // ← add your provider here
}
```

**Cross-cutting change는 이것이 전부입니다.** Entrypoint 수정도, config type 수정도 필요 없습니다. Aggregator는 이미 CLI, server, config-loader bootstrap path에서 호출됩니다.

### 4. Tests

테스트는 코드 옆에 co-locate하세요. Pi 테스트는 다음 isolation pattern을 사용합니다.

- SDK를 mock합니다. 파일 맨 위에서, provider를 import하기 전에 `mock.module`을 호출하세요.
- `mock.module`을 건드리는 테스트는 `packages/providers/package.json`에서 별도의 `bun test` invocation으로 분리합니다. Pi 파일의 기존 entry를 참고하세요. Bun의 `mock.module`은 process-global이고 되돌릴 수 없으므로, 분리해야 cross-file pollution을 막을 수 있습니다.
- Registry test(`packages/providers/src/registry.test.ts`): `builtIn: false`, idempotent registration, `isModelCompatible` 동작을 assertion하는 `describe` block을 추가하세요.

### 5. Capability discipline

추가 capability를 연결할 준비가 되면, 각 translation마다 작은 module을 따로 둡니다. Pi는 다음 파일을 사용합니다.

- `options-translator.ts`: thinking level, tool filter, skills resolution
- `session-resolver.ts`: session create/open/list
- `event-bridge.ts`: SDK-event -> MessageChunk mapping

이렇게 하면 provider class를 읽기 쉽게 유지할 수 있습니다. `provider.ts`는 orchestration만 담당하고, translator들은 SDK 없이 unit test할 수 있습니다.

## 하지 말아야 할 것

- **`packages/core/src/config/config-types.ts`의 `AssistantDefaultsConfig` 또는 `AssistantDefaults`를 수정하지 마세요.** Community provider default는 이 사례를 위해 설계된 generic `[string]` index signature 뒤에 위치합니다. typed slot을 추가하면 Phase 2 contract를 깨고, 이후 provider들도 같은 방식을 따르게 만듭니다.
- **CLI나 server entrypoint에서 `registerProvider()`를 직접 호출하지 마세요.** `registerCommunityProviders()` aggregator를 사용하세요. Entrypoint는 provider별 호출로 커지면 안 됩니다.
- **Capability를 과장해서 선언하지 마세요.** workflow node가 `hooks: [...]`를 사용하지만 provider가 이를 조용히 무시하면 사용자는 아무 feedback도 받지 못합니다. `hooks: false`라고 정직하게 선언하면 dag-executor가 warning을 냅니다.
- **Session state나 credential을 provider의 SDK-managed directory 밖에 쓰지 마세요.** Archon의 config, workspace, session은 다른 곳에서 관리합니다. Provider는 자기 SDK의 storage convention 안에 머물러야 합니다. 예를 들어 Claude는 `~/.claude/`에 쓰고, Codex는 자체 thread store를 사용하는 방식을 참고하세요.

## Reference implementation

`packages/providers/src/community/pi/`의 Pi provider가 표준 예시입니다. 이 구현은 다음을 다룹니다.

- `<pi-provider>/<model-id>` ref를 통한 multi-backend model selection. 한 번 parse하고 syntactic validation을 수행합니다.
- OAuth + API-key passthrough. `~/.pi/agent/auth.json`을 읽고 request별 override를 허용합니다.
- callback 기반 SDK event에서 `AsyncGenerator<MessageChunk>`로 이어지는 async-queue bridge
- `SessionManager.list(cwd)` + `SessionManager.open(path)`를 통한 session resume
- Capability translation: `effort/thinking`, `allowed_tools/denied_tools`, `skills`, `systemPrompt`

`packages/providers/src/community/pi/provider.ts`를 처음부터 끝까지 읽어보세요. 주석이 각 design decision을 짚고 upstream Pi SDK 동작으로 연결해 줍니다.
