---
title: 아키텍처
description: Archon의 시스템 아키텍처, 패키지, 인터페이스, 데이터 흐름을 다루는 종합 가이드입니다.
category: reference
audience: [developer]
status: current
sidebar:
  order: 1
---

Archon을 이해하고 확장하기 위한 종합 가이드입니다. HarnessLab은 Archon fork를 기반으로 하므로, 이 문서는 upstream Archon의 구조를 이해하고 HarnessLab 실험과 운영에 맞게 확장할 때의 기준점으로 사용할 수 있습니다.

**탐색:** [개요](#system-overview) | [플랫폼](#adding-platform-adapters) | [AI Providers](#adding-ai-agent-providers) | [격리](#isolation-providers) | [명령](#command-system) | [스트리밍](#streaming-modes) | [데이터베이스](#database-schema)

---

## System Overview

Archon은 메시징 플랫폼(Web UI, Telegram, GitHub, Slack, Discord)을 통합 인터페이스를 통해 AI coding assistant(Claude Code, Codex)에 연결하는 **플랫폼 독립적인 AI 코딩 어시스턴트 오케스트레이터**입니다. 내장 Web UI는 실시간 스트리밍, tool call 시각화, workflow 관리를 포함한 완전한 독립 실행 경험을 제공합니다.

### Core Architecture

```
┌─────────────────────────────────────────────┐
│  Platform Adapters (Web UI, Telegram,       │
│         GitHub, Slack, Discord, CLI)        │
│   • IPlatformAdapter interface              │
│   • Web: SSE streaming + REST API           │
│   • Others: Platform-specific messaging     │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│            Orchestrator                     │
│   • Route slash commands → Command Handler  │
│   • Route AI queries → Assistant Clients    │
│   • Manage session lifecycle                │
│   • Stream responses back to platforms      │
│   • Emit workflow events to Web UI          │
└──────────────┬──────────────────────────────┘
               │
       ┌───────┼────────┐
       │       │        │
       ▼       ▼        ▼
┌───────────┐ ┌───────────────┐ ┌───────────────────┐
│ Command   │ │ AI Agent      │ │ Isolation         │
│ Handler   │ │ Providers     │ │ Providers         │
│           │ │               │ │                   │
│ (Slash    │ │ IAgent-       │ │ IIsolationProvider│
│ commands) │ │ Provider      │ │ (worktree, etc.)  │
└─────┬─────┘ └───────┬───────┘ └─────────┬─────────┘
      │               │                   │
      └───────────────┼───────────────────┘
                      ▼
┌─────────────────────────────────────────────┐
│    SQLite (default) / PostgreSQL (7 Tables)  │
│  • Codebases  • Conversations  • Sessions   │
│  • Isolation Envs • Workflow Runs            │
│  • Workflow Events • Messages                │
└─────────────────────────────────────────────┘
```

### Key Design Principles

1. **인터페이스 중심**: 플랫폼 adapter와 AI provider 모두 엄격한 인터페이스를 구현해 교체 가능성을 확보합니다.
2. **스트리밍 우선**: 모든 AI 응답은 실시간 전달을 위해 async generator를 통해 스트리밍됩니다.
3. **세션 영속성**: AI 세션은 데이터베이스 저장을 통해 컨테이너 재시작 이후에도 유지됩니다.
4. **범용 명령**: 명령은 하드코딩하지 않고, 사용자가 Git으로 버전 관리되는 markdown 파일에 정의합니다.
5. **플랫폼별 스트리밍**: 각 플랫폼은 응답을 스트리밍할지 배치로 보낼지 직접 제어합니다.

---

## Adding Platform Adapters

Platform adapter는 메시징 플랫폼을 orchestrator에 연결합니다. 새 플랫폼을 추가하려면 `IPlatformAdapter` 인터페이스를 구현합니다.

### IPlatformAdapter Interface

**위치:** `packages/core/src/types/index.ts`

```typescript
export interface IPlatformAdapter {
  // Send a message to the platform (optional metadata for message type hints)
  sendMessage(conversationId: string, message: string, metadata?: MessageMetadata): Promise<void>;

  // Ensure responses go to a thread, creating one if needed
  // Returns the thread's conversation ID (may be same as original)
  ensureThread(originalConversationId: string, messageContext?: unknown): Promise<string>;

  // Get the configured streaming mode
  getStreamingMode(): 'stream' | 'batch';

  // Get the platform type identifier
  getPlatformType(): string;

  // Start the platform adapter (e.g., begin polling, start webhook server)
  start(): Promise<void>;

  // Stop the platform adapter gracefully
  stop(): void;

  // Optional: Send a structured event (e.g., Web UI rich data)
  sendStructuredEvent?(conversationId: string, event: MessageChunk): Promise<void>;

  // Optional: Retract previously streamed text (workflow routing intercept)
  emitRetract?(conversationId: string): Promise<void>;
}
```

### Implementation Guide

**1. Adapter 파일 생성:** `packages/adapters/src/chat/your-platform/adapter.ts`를 만듭니다. 카테고리에 따라 `forge/` 또는 `community/chat/` 아래에 둘 수도 있습니다.

**2. 인터페이스 구현:**

```typescript
import type { IPlatformAdapter } from '@archon/core';

export class YourPlatformAdapter implements IPlatformAdapter {
  private streamingMode: 'stream' | 'batch';

  constructor(config: YourPlatformConfig, mode: 'stream' | 'batch' = 'stream') {
    this.streamingMode = mode;
    // Initialize your platform SDK/client
  }

  async sendMessage(conversationId: string, message: string): Promise<void> {
    // Platform-specific message sending logic
    // Handle message length limits, formatting, etc.
  }

  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  getPlatformType(): string {
    return 'your-platform'; // Used as platform_type in database
  }

  async start(): Promise<void> {
    // Start polling, webhook server, WebSocket connection, etc.
    // Example: this.client.startPolling();
  }

  stop(): void {
    // Cleanup: stop polling, close connections
  }
}
```

**3. Main app에 등록:** `packages/server/src/index.ts`

```typescript
import { YourPlatformAdapter } from './adapters/your-platform';

// Read environment variables
const yourPlatformToken = process.env.YOUR_PLATFORM_TOKEN;
const yourPlatformMode = (process.env.YOUR_PLATFORM_STREAMING_MODE || 'stream') as
  | 'stream'
  | 'batch';

if (yourPlatformToken) {
  const adapter = new YourPlatformAdapter(yourPlatformToken, yourPlatformMode);

  // Set up message handler
  adapter.onMessage(async (conversationId, message) => {
    await handleMessage(adapter, conversationId, message);
  });

  await adapter.start();
  log.info({ platform: 'your-platform' }, 'adapter_started');
}
```

**4. 환경 변수 추가:** `.env.example`

```ini
# Your Platform
YOUR_PLATFORM_TOKEN=<token>
YOUR_PLATFORM_STREAMING_MODE=stream  # stream | batch
```

### Platform-Specific Considerations

#### Conversation ID Format

각 플랫폼은 고유하고 안정적인 conversation ID를 제공해야 합니다.

- **Web UI**: 사용자가 제공한 문자열 또는 자동 생성 UUID
- **Telegram**: `chat_id` 예: `"123456789"`
- **GitHub**: `owner/repo#issue_number` 예: `"user/repo#42"`
- **Slack**: `thread_ts` 또는 `channel_id+thread_ts`
- **CLI**: `cli-{timestamp}-{random}` 예: `"cli-1737400000-abc123"`

#### Message Length Limits

`sendMessage()`에서 플랫폼별 메시지 길이 제한을 처리합니다.

```typescript
async sendMessage(conversationId: string, message: string): Promise<void> {
  const MAX_LENGTH = 4096; // Telegram's limit

  if (message.length <= MAX_LENGTH) {
    await this.client.sendMessage(conversationId, message);
  } else {
    // Split long messages intelligently (by lines, paragraphs, etc.)
    const chunks = splitMessage(message, MAX_LENGTH);
    for (const chunk of chunks) {
      await this.client.sendMessage(conversationId, chunk);
    }
  }
}
```

**참고:** `packages/adapters/src/chat/telegram/adapter.ts`

#### Server-Sent Events (SSE)

**SSE**(Web UI 패턴):

```typescript
// Web adapter maintains SSE connections per conversation
registerStream(conversationId: string, stream: SSEWriter): void {
  this.streams.set(conversationId, stream);
}

async sendMessage(conversationId: string, message: string): Promise<void> {
  const stream = this.streams.get(conversationId);
  if (stream && !stream.closed) {
    await stream.writeSSE({ data: JSON.stringify({ type: 'text', content: message }) });
  } else {
    // Buffer messages if client disconnected (reconnection recovery)
    this.messageBuffer.set(conversationId, [
      ...(this.messageBuffer.get(conversationId) ?? []),
      message,
    ]);
  }
}

// Structured events for tool calls, workflow progress, errors
async sendStructuredEvent(conversationId: string, event: MessageChunk): Promise<void> {
  await this.emitSSE(conversationId, JSON.stringify(event));
}
```

**장점:**
- polling 오버헤드 없이 실시간 스트리밍 제공
- 브라우저의 자동 재연결 처리
- 연결이 끊긴 동안 메시지 버퍼링
- 구조화 이벤트(tool call, workflow 진행률, lock 상태)

**참고:** `packages/server/src/adapters/web/`

#### Polling vs Webhooks

**Polling**(Telegram 패턴):

```typescript
async start(): Promise<void> {
  this.bot.on('message', async (ctx) => {
    const conversationId = this.getConversationId(ctx);
    const message = ctx.message.text;
    await this.onMessageHandler(conversationId, message);
  });

  await this.bot.launch({ dropPendingUpdates: true });
}
```

**Webhooks**(GitHub 패턴):

```typescript
// In packages/server/src/index.ts, add route
app.post('/webhooks/your-platform', async (req, res) => {
  const signature = req.headers['x-signature'];
  const payload = req.body;

  await adapter.handleWebhook(payload, signature);
  res.sendStatus(200);
});

// In adapter
async handleWebhook(payload: any, signature: string): Promise<void> {
  // Verify signature
  if (!this.verifySignature(payload, signature)) return;

  // Parse event, extract conversationId and message
  const { conversationId, message } = this.parseEvent(payload);

  // Route to orchestrator
  await handleMessage(this, conversationId, message);
}
```

**참고:** `packages/adapters/src/forge/github/adapter.ts`

---

## Adding AI Agent Providers

AI agent provider는 AI SDK를 감싸고 통합 스트리밍 인터페이스를 제공합니다. 새 provider를 추가하려면 `IAgentProvider` 인터페이스를 구현합니다.

> **참고:** 이 섹션은 core 팀이 유지하는 built-in provider(Claude, Codex)를 다룹니다. `packages/providers/src/community/` 아래에 위치하고 `registerCommunityProviders()`를 통해 등록되는 community provider(`builtIn: false`)는 [Adding a Community Provider](../contributing/adding-a-community-provider/)를 참고하세요.

### IAgentProvider Interface

**위치:** `packages/providers/src/types.ts`(contract layer, SDK 의존성 없음)

```typescript
export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk>;

  getType(): string;

  getCapabilities(): ProviderCapabilities;
}
```

### MessageChunk Types

`MessageChunk`는 discriminated union입니다. 각 variant에 해당하는 필드만 존재합니다.

```typescript
export type MessageChunk =
  | { type: 'assistant'; content: string }
  | { type: 'system'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'result';
      sessionId?: string;
      tokens?: TokenUsage;
      structuredOutput?: unknown;
      isError?: boolean;
      errorSubtype?: string;
      cost?: number;
      stopReason?: string;
      numTurns?: number;
      modelUsage?: Record<string, unknown>;
    }
  | { type: 'rate_limit'; rateLimitInfo: Record<string, unknown> }
  | { type: 'tool'; toolName: string; toolInput?: Record<string, unknown>; toolCallId?: string }
  | { type: 'tool_result'; toolName: string; toolOutput: string; toolCallId?: string }
  | { type: 'workflow_dispatch'; workerConversationId: string; workflowName: string };
```

### Implementation Guide

**1. Provider 파일 생성:** `packages/providers/src/your-assistant/provider.ts`

**2. 인터페이스 구현:**

```typescript
import type { IAgentProvider, MessageChunk, ProviderCapabilities, SendQueryOptions } from '../types';

export class YourAssistantProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    // Initialize or resume session
    const session = resumeSessionId
      ? await this.resumeSession(resumeSessionId)
      : await this.startSession(cwd);

    // Send query to AI and stream responses
    for await (const event of this.sdk.streamQuery(session, prompt)) {
      if (event.type === 'text_response') {
        yield { type: 'assistant', content: event.text };
      } else if (event.type === 'tool_call') {
        yield {
          type: 'tool',
          toolName: event.tool,
          toolInput: event.parameters,
          toolCallId: event.id,
        };
      } else if (event.type === 'thinking') {
        yield { type: 'thinking', content: event.reasoning };
      }
    }

    // Yield session ID for persistence
    yield { type: 'result', sessionId: session.id };
  }

  getType(): string {
    return 'your-assistant';
  }

  getCapabilities(): ProviderCapabilities {
    // Declare only what you've actually wired. Under-declaration is honest;
    // the dag-executor warns users if a workflow node uses a feature you
    // declared unsupported.
    return YOUR_ASSISTANT_CAPABILITIES;
  }
}
```

**3. Typed registry를 통해 등록:** `packages/providers/src/registry.ts`

Built-in provider는 `registerBuiltinProviders()`에서 등록됩니다.

```typescript
export function registerBuiltinProviders(): void {
  const builtins: ProviderRegistration[] = [
    {
      id: 'your-assistant',
      displayName: 'Your Assistant',
      factory: () => new YourAssistantProvider(),
      capabilities: YOUR_ASSISTANT_CAPABILITIES,
      isModelCompatible: (model) => /* pattern check */,
      builtIn: true,
    },
    // ...existing entries
  ];
  for (const entry of builtins) {
    if (!registry.has(entry.id)) registry.set(entry.id, entry);
  }
}
```

Community provider는 같은 파일의 `registerCommunityProviders()`를 사용합니다. 이 경로는 [community provider guide](../contributing/adding-a-community-provider/)를 참고하세요.

**4. 환경 변수 추가:** `.env.example`

```ini
# Your Assistant
YOUR_ASSISTANT_API_KEY=<key>
YOUR_ASSISTANT_MODEL=<model-name>
```

### Session Management

**핵심 개념:**

- **불변 세션**: 세션은 수정하지 않습니다. 전환은 새 linked session을 생성합니다.
- **감사 추적**: 각 세션은 `parent_session_id`(이전 세션)와 `transition_reason`(생성 이유)을 저장합니다.
- **상태 머신**: 명시적인 `TransitionTrigger` 타입이 모든 전환 이유를 정의합니다.
- **Session ID 영속성**: 컨텍스트를 이어가기 위해 `assistant_session_id`를 데이터베이스에 저장합니다.

**전환 트리거**(`packages/core/src/state/session-transitions.ts`):
- `first-message` - 기존 세션이 없음
- `plan-to-execute` - 계획 단계가 완료되어 실행을 시작함. 즉시 새 세션 생성
- `isolation-changed`, `codebase-changed`, `reset-requested` 등 - 현재 세션 비활성화

**Orchestrator 로직**(`packages/core/src/orchestrator/orchestrator.ts`):

```typescript
// Detect plan-to-execute transition
const trigger = detectPlanToExecuteTransition(commandName, session?.metadata?.lastCommand);

if (trigger && shouldCreateNewSession(trigger)) {
  // Transition to new session (links to previous via parent_session_id)
  session = await sessionDb.transitionSession(conversationId, trigger, {...});
} else if (!session) {
  // No session exists - create one
  session = await sessionDb.transitionSession(conversationId, 'first-message', {...});
} else {
  // Resume existing session
  log.info({ sessionId: session.id }, 'session_resumed');
}
```

### Streaming Event Mapping

SDK마다 event type이 다릅니다. 이를 `MessageChunk` 타입으로 매핑합니다.

**Claude Code SDK**(`packages/providers/src/claude/provider.ts`):

```typescript
for await (const msg of query({ prompt, options })) {
  if (msg.type === 'assistant') {
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        yield { type: 'assistant', content: block.text };
      } else if (block.type === 'tool_use') {
        yield {
          type: 'tool',
          toolName: block.name,
          toolInput: block.input,
        };
      }
    }
  } else if (msg.type === 'result') {
    yield { type: 'result', sessionId: msg.session_id };
  }
}
```

**Codex SDK**(`packages/providers/src/codex/provider.ts`):

```typescript
for await (const event of result.events) {
  if (event.type === 'item.completed') {
    switch (event.item.type) {
      case 'agent_message':
        yield { type: 'assistant', content: event.item.text };
        break;
      case 'command_execution':
        yield { type: 'tool', toolName: event.item.command };
        break;
      case 'reasoning':
        yield { type: 'thinking', content: event.item.text };
        break;
    }
  } else if (event.type === 'turn.completed') {
    yield { type: 'result', sessionId: thread.id };
    break; // CRITICAL: Exit loop on turn completion
  }
}
```

### Error Handling

**SDK 호출은 try-catch로 감쌉니다.**

```typescript
try {
  for await (const event of this.sdk.streamQuery(...)) {
    yield mapEventToChunk(event);
  }
} catch (error) {
  log.error({ err: error }, 'query_failed');
  throw new Error(`Query failed: ${error.message}`);
}
```

**SDK별 오류 처리:**

```typescript
if (event.type === 'error') {
  // Log but don't crash - some errors are non-fatal
  log.error({ message: event.message }, 'stream_error');

  // Only yield user-facing errors
  if (!event.message.includes('internal')) {
    yield { type: 'system', content: `Warning: ${event.message}` };
  }
}
```

---

## Isolation Providers

Isolation provider는 동시 workflow를 위해 격리된 작업 환경(worktree, container, VM)을 생성합니다. 기본 구현은 git worktree를 사용합니다.

### IIsolationProvider Interface

**위치:** `packages/isolation/src/types.ts`

```typescript
export interface IIsolationProvider {
  readonly providerType: string;
  create(request: IsolationRequest): Promise<IsolatedEnvironment>;
  destroy(envId: string, options?: DestroyOptions | WorktreeDestroyOptions): Promise<DestroyResult>;
  get(envId: string): Promise<IsolatedEnvironment | null>;
  list(codebaseId: string): Promise<IsolatedEnvironment[]>;
  adopt?(path: string): Promise<IsolatedEnvironment | null>;
  healthCheck(envId: string): Promise<boolean>;
}
```

### Request & Response Types

```typescript
interface IsolationRequest {
  codebaseId: string;
  canonicalRepoPath: string; // Main repo path, never a worktree
  workflowType: 'issue' | 'pr' | 'review' | 'thread' | 'task';
  identifier: string; // "42", "feature-auth", etc.
  prBranch?: string; // PR branch name (for adoption and same-repo PRs)
  prSha?: string; // For reproducible PR reviews
  isForkPR?: boolean; // True if PR is from a fork
}

interface IsolatedEnvironment {
  id: string; // Worktree path (for worktree provider)
  provider: 'worktree' | 'container' | 'vm' | 'remote';
  workingPath: string; // Where AI should work
  branchName?: string;
  status: 'active' | 'suspended' | 'destroyed';
  createdAt: Date;
  metadata: Record<string, unknown>;
}

interface DestroyResult {
  worktreeRemoved: boolean;  // Primary operation succeeded
  branchDeleted: boolean;    // Branch cleanup succeeded (true if no branch requested)
  directoryClean: boolean;   // No orphan files remain
  warnings: string[];        // Non-fatal issues during cleanup
}
```

### WorktreeProvider Implementation

**위치:** `packages/isolation/src/providers/worktree.ts`

```typescript
export class WorktreeProvider implements IIsolationProvider {
  readonly providerType = 'worktree';

  async create(request: IsolationRequest): Promise<IsolatedEnvironment> {
    // 1. Check for existing worktree (adoption)
    // 2. Generate branch name from workflowType + identifier
    // 3. Create git worktree at computed path
    // 4. Return IsolatedEnvironment
  }

  async destroy(envId: string, options?: WorktreeDestroyOptions): Promise<DestroyResult> {
    // git worktree remove <path> [--force]
    // git branch -D <branchName> (if provided, tracked via result)
    // Returns DestroyResult with warnings for partial failures
  }
}
```

### Branch Naming Convention

| Workflow           | Identifier      | Generated Branch                |
| ------------------ | --------------- | ------------------------------- |
| issue              | `"42"`          | `issue-42`                      |
| pr (same-repo)     | `"123"`         | `feature/auth` (actual branch)  |
| pr (fork)          | `"123"`         | `pr-123-review`                 |
| task               | `"my-feature"`  | `task-my-feature`               |
| thread             | `"C123:ts.123"` | `thread-a1b2c3d4` (8-char hash) |

### Storage Location

```
PRIMARY: ~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>/
LEGACY:  ~/.archon/worktrees/<owner>/<repo>/<branch>/   (fallback for repos not registered under workspaces/)
DOCKER:  /.archon/workspaces/<owner>/<repo>/worktrees/<branch>/
```

**Path resolution:**

1. 프로젝트가 `workspaces/` 아래에 등록되어 있나요? -> `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>/`
2. Legacy fallback -> `~/.archon/worktrees/<owner>/<repo>/<branch>/`
3. Docker 감지됨? -> `~/.archon/` 대신 `/.archon/` prefix 사용

### Usage Pattern

**GitHub adapter**(`packages/adapters/src/forge/github/adapter.ts`):

```typescript
const provider = getIsolationProvider();

// On @bot mention
const env = await provider.create({
  codebaseId: codebase.id,
  canonicalRepoPath: repoPath,
  workflowType: isPR ? 'pr' : 'issue',
  identifier: String(number),
  prBranch: prHeadBranch,
  prSha: prHeadSha,
});

// Update conversation
await db.updateConversation(conv.id, {
  cwd: env.workingPath,
  isolation_env_id: env.id,
  isolation_provider: env.provider,
});

// On issue/PR close
await provider.destroy(isolationEnvId);
```

**Command handler**(`/worktree create`):

```typescript
const provider = getIsolationProvider();
const env = await provider.create({
  workflowType: 'task',
  identifier: branchName,
  // ...
});
```

### Worktree Adoption

Provider는 새 worktree를 만들기 전에 기존 worktree를 adopt합니다.

1. **Path match**: 예상 경로에 worktree가 있으면 adopt
2. **Branch match**: PR branch에 기존 worktree가 있으면 adopt(skill symbiosis)

```typescript
// Inside create()
const existing = await this.findExisting(request, branchName, worktreePath);
if (existing) {
  return existing; // metadata.adopted = true
}
// ... else create new
```

### Database Fields

```sql
remote_agent_conversations
└── isolation_env_id    -- Provider-assigned ID (worktree path)

remote_agent_isolation_environments
├── id                  -- Unique environment ID
├── codebase_id         -- Link to codebases table
├── working_path        -- Filesystem path to worktree
├── branch_name         -- Git branch name
├── status              -- 'active' | 'destroyed'
└── ...
```

**조회 패턴:**

```typescript
const envId = conversation.isolation_env_id;
```

### Adding a New Isolation Provider

**1. Provider 생성:** `packages/isolation/src/providers/your-provider.ts`

```typescript
export class ContainerProvider implements IIsolationProvider {
  readonly providerType = 'container';

  async create(request: IsolationRequest): Promise<IsolatedEnvironment> {
    // Spin up Docker container with repo mounted
    const containerId = await docker.createContainer({...});
    return {
      id: containerId,
      provider: 'container',
      workingPath: '/workspace',
      status: 'active',
      createdAt: new Date(),
      metadata: { request },
    };
  }

  async destroy(envId: string): Promise<void> {
    await docker.removeContainer(envId);
  }
}
```

**2. Factory에 등록:** `packages/isolation/src/factory.ts`

```typescript
export function getIsolationProvider(type?: string): IIsolationProvider {
  switch (type) {
    case 'container':
      return new ContainerProvider();
    default:
      return new WorktreeProvider();
  }
}
```

**함께 보기:** 격리 아키텍처의 설계 패턴과 안전 규칙은 `.claude/rules/isolation-patterns.md`에도 문서화되어 있습니다.

---

## Command System

Command system은 사용자가 Git으로 버전 관리되는 markdown 파일에 custom workflow를 정의할 수 있게 합니다.

### Architecture

```
User: "Plan adding dark mode to project X"
           |
Orchestrator: Route to workflow via AI router
           |
Read command file: .archon/commands/plan.md
           |
Variable substitution: $ARGUMENTS -> "Add dark mode"
           |
Send to AI client: Injected prompt
           |
Stream responses back to platform
```

### Command Storage

**Database schema**(`remote_agent_codebases` 테이블의 JSONB):

```json
{
  "prime": {
    "path": ".archon/commands/prime.md",
    "description": "Research codebase"
  },
  "plan": {
    "path": ".archon/commands/plan-feature.md",
    "description": "Create implementation plan"
  }
}
```

**File-based**: 명령은 repository 안의 markdown 파일이며, 데이터베이스에 저장하지 않습니다. 데이터베이스에는 경로와 metadata만 저장합니다.

### Command Registration

**수동 등록**(`/command-set`):

```bash
/command-set analyze .archon/commands/analyze.md
```

**일괄 로딩**(`/load-commands`):

```bash
/load-commands .archon/commands
# Loads all .md files: prime.md -> prime, plan.md -> plan
```

**자동 감지**(`/clone` 또는 GitHub webhook에서):

```typescript
// Get command folders from config
const searchPaths = getCommandFolderSearchPaths(config?.commands?.folder);
// Returns: ['.archon/commands'] + configuredFolder if specified

for (const folder of searchPaths) {
  if (await folderExists(join(repoPath, folder))) {
    await autoLoadCommands(folder, codebaseId);
  }
}
```

이 과정은 repo-specific 명령을 등록합니다. Default command는 repository에 복사되지 않고, 앱에 bundle된 defaults에서 runtime에 로딩됩니다.

**참고:** `packages/paths/src/archon-paths.ts`(`@archon/paths`)

### Variable Substitution

**지원 변수:**

- `$1`, `$2`, `$3`, ... - 위치 인자
- `$ARGUMENTS` - 모든 인자를 하나의 문자열로 합친 값
- `\$` - escaped dollar sign, literal `$`

**구현**(`packages/core/src/utils/variable-substitution.ts`):

```typescript
export function substituteVariables(
  text: string,
  args: string[],
  metadata: Record<string, unknown> = {}
): string {
  let result = text;

  // Replace $1, $2, $3, etc.
  args.forEach((arg, index) => {
    result = result.replace(new RegExp(`\\$${index + 1}`, 'g'), arg);
  });

  // Replace $ARGUMENTS
  result = result.replace(/\$ARGUMENTS/g, args.join(' '));

  // Replace escaped dollar signs
  result = result.replace(/\\\$/g, '$');

  return result;
}
```

**예시:**

```markdown
<!-- .archon/commands/analyze.md -->

Analyze the following aspect of the codebase: $1

Focus on: $ARGUMENTS

Provide recommendations for improvement.
```

```
User asks: "Analyze the security of authentication and authorization"
# Orchestrator routes to the `analyze` command
# Variable substitution produces:
# Analyze the following aspect of the codebase: security
# Focus on: security authentication authorization
# Provide recommendations for improvement.
```

### Slash Command Routing

**Orchestrator 로직**(`packages/core/src/orchestrator/`):

`/`로 시작하는 모든 메시지는 먼저 Command Handler로 라우팅됩니다. 인식된 deterministic command는 직접 처리됩니다. Slash command가 아닌 메시지는 AI router를 거치며, AI router는 사용 가능한 workflow와 command를 발견한 뒤 사용자 요청을 적절한 대상으로 라우팅합니다.

**명령 카테고리:**

1. **Deterministic**(Command Handler가 처리):
   - `/help`, `/status`, `/getcwd`, `/setcwd`
   - `/clone`, `/repos`, `/repo`, `/repo-remove`
   - `/command-set`, `/load-commands`, `/commands`
   - `/worktree`, `/workflow`
   - `/reset`, `/reset-context`, `/init`

2. **AI-routed**(Orchestrator가 처리):
   - 자연어 메시지는 AI를 통해 workflow와 command로 라우팅됩니다.

### Command Handler Implementation

**참고:** `packages/core/src/handlers/command-handler.ts`

Handler는 command group별 focused function으로 나뉩니다.

- `handleCommand()` -- 최상위 dispatcher(command name으로 switch)
- `handleRepoCommand()` -- `/repo`(repo 전환, pull, command auto-load)
- `handleRepoRemoveCommand()` -- `/repo-remove`(repo와 codebase record 삭제)
- `handleWorktreeCommand()` -- `/worktree` subcommand(create, list, remove, cleanup, orphans)
- `handleWorkflowCommand()` -- `/workflow` subcommand(list, reload, run, status, cancel, resume, abandon, approve, reject). status/resume/abandon/approve/reject case는 `packages/core/src/operations/workflow-operations.ts`의 shared operation으로 위임합니다.
- `resolveRepoArg()` -- 번호 또는 이름으로 repo를 찾는 shared helper

**중요:** `CommandResult`의 `modified: true` flag는 orchestrator에게 conversation state를 다시 로딩하라는 신호입니다.

---

## Streaming Modes

Streaming mode는 AI 응답을 사용자에게 실시간으로 전달할지(stream), 누적해서 한 번에 보낼지(batch)를 제어합니다.

### Configuration

**환경 변수**(platform별):

```ini
TELEGRAM_STREAMING_MODE=stream  # Default: stream (real-time chat)
SLACK_STREAMING_MODE=batch      # Default: batch
```

### Mode Comparison

| Mode       | Behavior                                    | Pros                                       | Cons                                  | Best For                         |
| ---------- | ------------------------------------------- | ------------------------------------------ | ------------------------------------- | -------------------------------- |
| **stream** | AI가 생성하는 각 chunk를 즉시 전송          | 실시간 피드백, 진행 상황 확인 가능         | API 호출 수 증가, rate limit 가능성   | Chat platforms (Telegram, Slack) |
| **batch**  | 모든 chunk를 누적한 뒤 최종 요약 전송       | 단일 메시지, spam 없음, 깔끔함             | 진행 상황 표시 없음, 더 긴 대기       | Issue trackers (GitHub, Jira)    |

### Implementation

**Orchestrator 로직**(`packages/core/src/orchestrator/orchestrator.ts`):

```typescript
const mode = platform.getStreamingMode();

if (mode === 'stream') {
  // Send each chunk immediately
  for await (const msg of aiClient.sendQuery(...)) {
    if (msg.type === 'assistant' && msg.content) {
      await platform.sendMessage(conversationId, msg.content);
    } else if (msg.type === 'tool' && msg.toolName) {
      const toolMessage = formatToolCall(msg.toolName, msg.toolInput);
      await platform.sendMessage(conversationId, toolMessage);
    }
  }
} else {
  // Batch: Accumulate all chunks
  const assistantMessages: string[] = [];

  for await (const msg of aiClient.sendQuery(...)) {
    if (msg.type === 'assistant' && msg.content) {
      assistantMessages.push(msg.content);
    }
    // Tool calls logged but not sent to user
  }

  // Extract clean summary (filter out tool indicators)
  const finalMessage = extractCleanSummary(assistantMessages);
  await platform.sendMessage(conversationId, finalMessage);
}
```

### Tool Call Formatting

**Stream mode**: Tool call을 실시간으로 표시합니다.

```
BASH
git status

READ
Reading: src/index.ts

EDIT
Editing: src/components/Header.tsx
```

**Batch mode**: 최종 응답에서 tool indicator를 필터링합니다.

**참고:** `packages/core/src/orchestrator/orchestrator.ts`

### Tool Formatter Utility

**위치:** `packages/core/src/utils/tool-formatter.ts`

```typescript
export function formatToolCall(toolName: string, toolInput?: Record<string, unknown>): string {
  let message = `${toolName.toUpperCase()}`;

  // Add context-specific info
  if (toolName === 'Bash' && toolInput?.command) {
    message += `\n${toolInput.command}`;
  } else if (toolName === 'Read' && toolInput?.file_path) {
    message += `\nReading: ${toolInput.file_path}`;
  } else if (toolName === 'Edit' && toolInput?.file_path) {
    message += `\nEditing: ${toolInput.file_path}`;
  }

  return message;
}
```

---

## Database Schema

Archon은 `remote_agent_` prefix를 사용하는 7-table schema를 사용합니다. SQLite가 기본값이며 별도 설정이 필요 없습니다. PostgreSQL은 cloud/advanced deployment용 선택지입니다.

### Schema Overview

```sql
remote_agent_codebases
├── id (UUID)
├── name (VARCHAR)
├── repository_url (VARCHAR)
├── default_cwd (VARCHAR)
├── ai_assistant_type (VARCHAR) -- registered provider identifier (e.g. 'claude', 'codex')
└── commands (JSONB) -- {command_name: {path, description}}

remote_agent_conversations
├── id (UUID)
├── platform_type (VARCHAR) -- 'web' | 'telegram' | 'github' | 'slack'
├── platform_conversation_id (VARCHAR) -- Platform-specific ID
├── codebase_id (UUID -> remote_agent_codebases.id)
├── cwd (VARCHAR) -- Current working directory
├── ai_assistant_type (VARCHAR) -- LOCKED at creation
├── title (VARCHAR) -- User-friendly conversation title (Web UI)
├── deleted_at (TIMESTAMP) -- Soft-delete support
└── UNIQUE(platform_type, platform_conversation_id)

remote_agent_sessions
├── id (UUID)
├── conversation_id (UUID -> remote_agent_conversations.id)
├── codebase_id (UUID -> remote_agent_codebases.id)
├── ai_assistant_type (VARCHAR) -- Must match conversation
├── assistant_session_id (VARCHAR) -- SDK session ID for resume
├── active (BOOLEAN) -- Only one active per conversation
├── parent_session_id (UUID -> remote_agent_sessions.id)
├── transition_reason (TEXT) -- Why this session was created (TransitionTrigger)
└── metadata (JSONB) -- {lastCommand: "plan-feature", ...}

remote_agent_isolation_environments
├── id (UUID)
├── codebase_id (UUID -> remote_agent_codebases.id)
├── workflow_type (VARCHAR)
├── workflow_id (VARCHAR)
├── working_path (VARCHAR)
├── branch_name (VARCHAR)
├── status (VARCHAR) -- 'active' | 'destroyed'
└── metadata (JSONB)

remote_agent_workflow_runs
├── id (UUID)
├── conversation_id (UUID -> remote_agent_conversations.id)
├── codebase_id (UUID -> remote_agent_codebases.id)
├── workflow_name (VARCHAR)
├── status (VARCHAR) -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
├── parent_conversation_id (UUID) -- Parent chat that dispatched this run
└── metadata (JSONB)

remote_agent_workflow_events
├── id (UUID)
├── workflow_run_id (UUID -> remote_agent_workflow_runs.id)
├── event_type (VARCHAR) -- see WorkflowEventType
├── step_index (INTEGER)
├── step_name (VARCHAR)
├── data (JSONB) -- Event-specific data
└── created_at (TIMESTAMP)

remote_agent_messages
├── id (UUID)
├── conversation_id (UUID -> remote_agent_conversations.id)
├── role (VARCHAR) -- 'user' | 'assistant'
├── content (TEXT)
├── metadata (JSONB) -- {toolCalls: [{name, input, duration}], ...}
└── created_at (TIMESTAMP)
```

### Database Operations

**위치:** `packages/core/src/db/`

**Codebases**(`packages/core/src/db/codebases.ts`):

- `createCodebase()` - codebase record 생성
- `getCodebase(id)` - ID로 조회
- `findCodebaseByRepoUrl(url)` - repository URL로 조회
- `registerCommand(id, name, def)` - 단일 command 추가
- `updateCodebaseCommands(id, commands)` - command 일괄 업데이트
- `getCodebaseCommands(id)` - 모든 command 조회

**Conversations**(`packages/core/src/db/conversations.ts`):

- `getOrCreateConversation(platform, id)` - idempotent get/create
- `updateConversation(id, data)` - 필드 업데이트(conversation이 없으면 throw)

**Sessions**(`packages/core/src/db/sessions.ts`):

- `createSession(data)` - 새 session 생성(`parent_session_id`와 `transition_reason` 지원)
- `transitionSession(conversationId, reason, data)` - 이전 session에 연결된 새 session 생성(immutable sessions)
- `getActiveSession(conversationId)` - conversation의 active session 조회
- `getSessionHistory(conversationId)` - conversation의 모든 session 조회(audit trail)
- `getSessionChain(sessionId)` - session chain을 root까지 추적
- `updateSession(id, sessionId)` - `assistant_session_id` 업데이트
- `updateSessionMetadata(id, metadata)` - metadata JSONB 업데이트
- `deactivateSession(id)` - session을 inactive로 표시

**Error Handling:**

모든 UPDATE operation은 `rowCount`를 확인하고, 영향받은 row가 없으면 오류를 던집니다. 존재하지 않는 record를 업데이트하려 할 때 조용히 실패하지 않도록 하기 위함입니다.

```typescript
// Example: updateConversation throws if conversation not found
await updateConversation(id, { codebase_id: '...' });
// Throws: "updateConversation: Conversation not found for id=..."
```

### Session Lifecycle

**일반 흐름:**

```
1. User sends message
   -> getOrCreateConversation()
   -> getActiveSession() // null if first message

2. No session exists
   -> transitionSession(conversationId, 'first-message', {...})
   -> New session created with transition_reason='first-message'

3. Send to AI, get session ID
   -> updateSession(session.id, aiSessionId)

4. User sends another message
   -> getActiveSession() // returns existing
   -> Resume with assistant_session_id

5. User sends /reset
   -> deactivateSession(session.id) // Sets ended_at timestamp
   -> Next message creates new session via transitionSession()
```

**Plan-to-Execute transition(immutable sessions):**

```
1. User: "Plan adding dark mode" -> routed to plan-feature workflow
   -> transitionSession() or resumeSession()
   -> updateSessionMetadata({ lastCommand: 'plan-feature' })

2. User: "Execute the plan" -> routed to execute workflow
   -> detectPlanToExecuteTransition() // Returns 'plan-to-execute' trigger
   -> transitionSession(conversationId, 'plan-to-execute', {...})
   -> New session created, parent_session_id points to planning session
   -> Fresh context for implementation with full audit trail
```

**참고:** `packages/core/src/orchestrator/orchestrator.ts`, `packages/core/src/state/session-transitions.ts`

---

## Message Flow Examples

### Telegram Chat Flow

```
User types: /clone https://github.com/user/repo
         |
TelegramAdapter receives update
         |
Extract conversationId = chat_id
         |
Orchestrator.handleMessage(adapter, chatId, "/clone ...")
         |
Command Handler: /clone
  - Execute git clone
  - Create codebase record
  - Update conversation.codebase_id
  - Detect .archon/commands/
         |
Send response: "Repository cloned! Found: .archon/commands/"
```

```
User types: "Prime the codebase"
         |
Orchestrator: Route via AI router
         |
Load command file: .archon/commands/prime.md
         |
Variable substitution (no args in this case)
         |
Get or create session
         |
ClaudeProvider.sendQuery(prompt, cwd, sessionId)
         |
Stream mode: Send each chunk immediately
         |
Save session ID for next message
```

### GitHub Webhook Flow

```
User comments: @Archon prime the codebase
         |
GitHub sends webhook to POST /webhooks/github
         |
GitHubAdapter.handleWebhook(payload, signature)
  - Verify HMAC signature
  - Parse event: issue_comment.created
  - Extract: owner/repo#42, comment text
  - Check for @Archon mention
         |
First mention on this issue?
  - Yes -> Clone repo, create codebase, detect and register commands
  - No -> Use existing codebase
         |
Strip @Archon from comment
         |
Orchestrator.handleMessage(adapter, "user/repo#42", "prime the codebase")
         |
Load command file, substitute variables
         |
Get or create session
         |
CodexProvider.sendQuery(prompt, cwd, sessionId)
         |
Batch mode: Accumulate all chunks
         |
Extract clean summary (filter tool indicators)
         |
Post single comment on issue with summary
```

---

## Extension Checklist

### Adding a New Platform Adapter

- [ ] `packages/adapters/src/chat/your-platform/adapter.ts` 생성
- [ ] `IPlatformAdapter` interface 구현
- [ ] `sendMessage()`에서 message length limit 처리
- [ ] conversation ID extraction 구현
- [ ] polling 또는 webhook handling 설정
- [ ] 환경 변수 check와 함께 `packages/server/src/index.ts`에 추가
- [ ] `.env.example`에 환경 변수 추가
- [ ] stream mode와 batch mode 모두 테스트

### Adding a New AI Agent Provider

이 checklist는 **built-in** provider 전용입니다. Community provider(`builtIn: false`)는 [Adding a Community Provider](../contributing/adding-a-community-provider/)를 참고하세요. 해당 문서에서 folder layout, registration, capability discipline을 자세히 다룹니다.

- [ ] `packages/providers/src/your-assistant/provider.ts` 생성
- [ ] `IAgentProvider` interface 구현(sendQuery + getType + getCapabilities)
- [ ] SDK event를 `MessageChunk` discriminated union으로 매핑
- [ ] session creation과 resumption 처리
- [ ] `ProviderCapabilities`를 정직하게 선언합니다. 과도하게 약속하기보다 보수적으로 선언하세요.
- [ ] error handling과 retry classification 구현(Claude/Codex pattern 참고)
- [ ] `packages/providers/src/registry.ts`의 `registerBuiltinProviders()`에 등록
- [ ] `.env.example`에 환경 변수 추가
- [ ] restart 이후 session persistence 테스트
- [ ] plan-to-execute transition 테스트(new session)

### Adding a New Isolation Provider

- [ ] `packages/isolation/src/providers/your-provider.ts` 생성
- [ ] `IIsolationProvider` interface 구현
- [ ] `create()`, `destroy()`, `get()`, `list()`, `healthCheck()` 처리
- [ ] 선택 사항: existing environment discovery를 위한 `adopt()` 구현
- [ ] `packages/isolation/src/factory.ts`에 등록
- [ ] 필요하면 database column 업데이트(`isolation_provider` type)
- [ ] creation과 cleanup lifecycle 테스트
- [ ] concurrent environments 테스트(multiple conversations)

### Modifying Command System

- [ ] 새 variable type을 위해 `substituteVariables()` 업데이트
- [ ] deterministic logic용 command를 Command Handler에 추가
- [ ] `/help` command output 업데이트
- [ ] `.archon/commands/`에 example command file 추가
- [ ] edge case와 함께 variable substitution 테스트

---

## Common Patterns

### Idempotent Operations

```typescript
// Get or create - never fails
const conversation = await db.getOrCreateConversation(platform, id);

// Find or create codebase (GitHub adapter pattern)
const existing = await codebaseDb.findCodebaseByRepoUrl(url);
if (existing) return existing;
return await codebaseDb.createCodebase({...});
```

### Session Safety

```typescript
// Always check for active session
const session = await sessionDb.getActiveSession(conversationId);

// Use transitionSession() for immutable session pattern
// Automatically deactivates old session and creates new one with audit trail
const newSession = await sessionDb.transitionSession(
  conversationId,
  'reset-requested', // TransitionTrigger
  { codebase_id, ai_assistant_type }
);
```

### Streaming Error Handling

```typescript
try {
  for await (const msg of aiClient.sendQuery(...)) {
    if (msg.type === 'assistant') {
      await platform.sendMessage(conversationId, msg.content);
    }
  }
} catch (error) {
  log.error({ err: error, conversationId }, 'orchestrator_error');
  await platform.sendMessage(
    conversationId,
    'An error occurred. Try /reset.'
  );
}
```

### Context Injection

```typescript
// GitHub: Pass issue/PR context as separate parameter
let contextToAppend: string | undefined;

if (eventType === 'issue' && issue) {
  contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"
Use 'gh issue view ${String(issue.number)}' for full details if needed.`;
} else if (eventType === 'pull_request' && pullRequest) {
  contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"
Use 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
}

await handleMessage(adapter, conversationId, finalMessage, contextToAppend);
```

Context는 `handleMessage()`의 별도 `issueContext` parameter로 전달되며, 사용자 메시지와 분리됩니다. Workflow에서는 `buildPromptWithContext()` 안의 `$CONTEXT` / `$ISSUE_CONTEXT` variable substitution을 통해 context가 주입됩니다.

**참고:** `packages/adapters/src/forge/github/adapter.ts`, `packages/core/src/orchestrator/orchestrator.ts`

---

## Key Takeaways

1. **Interface는 확장성을 가능하게 합니다**: `IPlatformAdapter`, `IAgentProvider`, `IIsolationProvider`를 통해 core logic을 수정하지 않고 platform, AI provider, isolation strategy를 추가할 수 있습니다.

2. **Streaming에는 async generator를 사용합니다**: 모든 AI provider는 서로 다른 SDK를 통합하기 위해 `AsyncGenerator<MessageChunk>`를 반환합니다.

3. **Session persistence는 핵심입니다**: restart 이후에도 context를 유지하려면 `assistant_session_id`를 데이터베이스에 저장합니다.

4. **Platform-specific streaming**: 각 플랫폼은 환경 변수를 통해 자체 streaming mode를 제어합니다.

5. **Command는 file-based입니다**: 데이터베이스에는 path만 저장하고, 실제 command는 Git으로 버전 관리되는 file에 둡니다.

6. **Plan-to-execute는 특별합니다**: 새 session이 필요한 유일한 transition이며, implementation 중 token bloat를 방지합니다.

7. **Factory pattern**: `getAgentProvider()`와 `getIsolationProvider()`는 configuration에 따라 올바른 구현을 instantiate합니다.

8. **Error recovery**: session이 막혔을 때 사용자가 빠져나갈 수 있도록 항상 `/reset` escape hatch를 제공합니다.

9. **Isolation adoption**: Provider는 새 environment를 만들기 전에 기존 environment를 확인합니다. 이를 통해 skill symbiosis가 가능합니다.

---

**자세한 구현 예시는 다음 파일을 참고하세요.**

- Platform adapter: `packages/adapters/src/chat/telegram/adapter.ts`, `packages/adapters/src/forge/github/adapter.ts`
- AI provider: `packages/providers/src/claude/provider.ts`, `packages/providers/src/codex/provider.ts`
- Isolation provider: `packages/isolation/src/providers/worktree.ts`
- Isolation resolver: `packages/isolation/src/resolver.ts`
- Isolation factory: `packages/isolation/src/factory.ts`
- Orchestrator: `packages/core/src/orchestrator/orchestrator.ts`
- Command handler: `packages/core/src/handlers/command-handler.ts`
