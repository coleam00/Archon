---
title: Architecture
description: Comprehensive guide to Archon's system architecture, packages, interfaces, and data flow.
category: reference
audience: [developer]
status: current
sidebar:
  order: 1
---

Comprehensive guide to understanding and extending Archon.

**Navigation:** [Overview](#system-overview) | [Platforms](#adding-platform-adapters) | [AI Providers](#adding-ai-agent-providers) | [Isolation](#isolation-providers) | [Commands](#command-system) | [Streaming](#streaming-modes) | [Database](#database-schema)

---

## System Overview

Archon is a **platform-agnostic AI coding assistant orchestrator** that connects messaging platforms (Web UI, Telegram, GitHub, Slack, Discord) to AI coding assistants (Claude Code, Codex) via a unified interface. The built-in Web UI provides a complete standalone experience with real-time streaming, tool call visualization, and workflow management.

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

1. **Interface-driven**: Both platform adapters and AI providers implement strict interfaces for swappability
2. **Streaming-first**: All AI responses stream through async generators for real-time delivery
3. **Session persistence**: AI sessions survive container restarts via database storage
4. **Generic commands**: Users define commands in Git-versioned markdown files, not hardcoded
5. **Platform-specific streaming**: Each platform controls whether to stream or batch responses

---

## Adding Platform Adapters

Platform adapters connect messaging platforms to the orchestrator. Implement the `IPlatformAdapter` interface to add new platforms.

### IPlatformAdapter Interface

**Location:** `packages/core/src/types/index.ts`

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

**1. Create adapter file:** `packages/adapters/src/chat/your-platform/adapter.ts` (or `forge/` / `community/chat/` depending on category)

**2. Implement the interface:**

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

**3. Register in main app:** `packages/server/src/index.ts`

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

**4. Add environment variables:** `.env.example`

```ini
# Your Platform
YOUR_PLATFORM_TOKEN=<token>
YOUR_PLATFORM_STREAMING_MODE=stream  # stream | batch
```

### Platform-Specific Considerations

#### Conversation ID Format

Each platform must provide a unique, stable conversation ID:

- **Web UI**: User-provided string or auto-generated UUID
- **Telegram**: `chat_id` (e.g., `"123456789"`)
- **GitHub**: `owner/repo#issue_number` (e.g., `"user/repo#42"`)
- **Slack**: `thread_ts` or `channel_id+thread_ts`
- **CLI**: `cli-{timestamp}-{random}` (e.g., `"cli-1737400000-abc123"`)

#### Message Length Limits

Handle platform-specific message limits in `sendMessage()`:

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

**Reference:** `packages/adapters/src/chat/telegram/adapter.ts`

#### Server-Sent Events (SSE)

**SSE** (Web UI pattern):

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

**Benefits:**
- Real-time streaming without polling overhead
- Automatic reconnection handling in browser
- Message buffering during disconnections
- Structured events (tool calls, workflow progress, lock state)

**Reference:** `packages/server/src/adapters/web/`

#### Polling vs Webhooks

**Polling** (Telegram pattern):

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

**Webhooks** (GitHub pattern):

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

**Reference:** `packages/adapters/src/forge/github/adapter.ts`

---

## Adding AI Agent Providers

AI agent providers wrap AI SDKs and provide a unified streaming interface. Implement the `IAgentProvider` interface to add new providers.

### IAgentProvider Interface

**Location:** `packages/core/src/types/index.ts`

```typescript
export interface IAgentProvider {
  // Send a query and get streaming response
  sendQuery(prompt: string, cwd: string, resumeSessionId?: string): AsyncGenerator<MessageChunk>;

  // Get the assistant type identifier
  getType(): string;
}
```

### MessageChunk Types

```typescript
interface MessageChunk {
  type: 'assistant' | 'result' | 'system' | 'tool' | 'thinking';
  content?: string; // Text content for assistant/system/thinking
  sessionId?: string; // Session ID for result type
  toolName?: string; // Tool name for tool type
  toolInput?: Record<string, unknown>; // Tool parameters
}
```

### Implementation Guide

**1. Create provider file:** `packages/providers/src/your-assistant/provider.ts`

**2. Implement the interface:**

```typescript
import { IAgentProvider, MessageChunk } from '../types';

export class YourAssistantProvider implements IAgentProvider {
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string
  ): AsyncGenerator<MessageChunk> {
    // Initialize or resume session
    let session;
    if (resumeSessionId) {
      log.info({ sessionId: resumeSessionId }, 'session_resumed');
      session = await this.resumeSession(resumeSessionId);
    } else {
      log.info({ cwd }, 'session_started');
      session = await this.startSession(cwd);
    }

    // Send query to AI and stream responses
    for await (const event of this.sdk.streamQuery(session, prompt)) {
      // Map SDK events to MessageChunk types
      if (event.type === 'text_response') {
        yield { type: 'assistant', content: event.text };
      } else if (event.type === 'tool_call') {
        yield {
          type: 'tool',
          toolName: event.tool,
          toolInput: event.parameters,
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
}
```

**3. Register in factory:** `packages/providers/src/factory.ts`

```typescript
import { YourAssistantProvider } from './your-assistant';

export function getAgentProvider(type: string): IAgentProvider {
  switch (type) {
    case 'claude':
      return new ClaudeProvider();
    case 'codex':
      return new CodexProvider();
    case 'your-assistant':
      return new YourAssistantProvider();
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}
```

**4. Add environment variables:** `.env.example`

```ini
# Your Assistant
YOUR_ASSISTANT_API_KEY=<key>
YOUR_ASSISTANT_MODEL=<model-name>
```

### Session Management

**Key concepts:**

- **Immutable sessions**: Sessions are never modified; transitions create new linked sessions
- **Audit trail**: Each session stores `parent_session_id` (previous session) and `transition_reason` (why created)
- **State machine**: Explicit `TransitionTrigger` types define all transition reasons
- **Session ID persistence**: Store `assistant_session_id` in database to resume context

**Transition triggers** (`packages/core/src/state/session-transitions.ts`):
- `first-message` - No existing session
- `plan-to-execute` - Plan phase completed, starting execution (creates new session immediately)
- `isolation-changed`, `codebase-changed`, `reset-requested`, etc. - Deactivate current session

**Orchestrator logic** (`packages/core/src/orchestrator/orchestrator.ts`):

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

Different SDKs use different event types. Map them to MessageChunk types:

**Claude Code SDK** (`packages/providers/src/claude/provider.ts`):

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

**Codex SDK** (`packages/providers/src/codex/provider.ts`):

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

**Wrap SDK calls in try-catch:**

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

**Handle SDK-specific errors:**

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

Isolation providers create isolated working environments (worktrees, containers, VMs) for concurrent workflows. The default implementation uses git worktrees.

### IIsolationProvider Interface

**Location:** `packages/isolation/src/types.ts`

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

**Location:** `packages/isolation/src/providers/worktree.ts`

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

1. Project registered under `workspaces/`? -> `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>/`
2. Legacy fallback -> `~/.archon/worktrees/<owner>/<repo>/<branch>/`
3. Docker detected? -> `/.archon/` prefix instead of `~/.archon/`

### Usage Pattern

**GitHub adapter** (`packages/adapters/src/forge/github/adapter.ts`):

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

**Command handler** (`/worktree create`):

```typescript
const provider = getIsolationProvider();
const env = await provider.create({
  workflowType: 'task',
  identifier: branchName,
  // ...
});
```

### Worktree Adoption

The provider adopts existing worktrees before creating new ones:

1. **Path match**: If worktree exists at expected path -> adopt
2. **Branch match**: If PR's branch has existing worktree -> adopt (skill symbiosis)

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

**Lookup pattern:**

```typescript
const envId = conversation.isolation_env_id;
```

### Adding a New Isolation Provider

**1. Create provider:** `packages/isolation/src/providers/your-provider.ts`

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

**2. Register in factory:** `packages/isolation/src/factory.ts`

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

**See also:** The isolation architecture is documented in `.claude/rules/isolation-patterns.md` for design patterns and safety rules.

---

## Command System

The command system allows users to define custom workflows in Git-versioned markdown files.

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

**Database schema** (JSONB in `remote_agent_codebases` table):

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

**File-based**: Commands are markdown files in the repository, **not** stored in database. Only paths and metadata are stored.

### Command Registration

**Manual registration** (`/command-set`):

```bash
/command-set analyze .archon/commands/analyze.md
```

**Bulk loading** (`/load-commands`):

```bash
/load-commands .archon/commands
# Loads all .md files: prime.md -> prime, plan.md -> plan
```

**Auto-detection** (on `/clone` or GitHub webhook):

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

This registers repo-specific commands. Default commands are loaded at runtime from the app's bundled defaults, not copied to repos.

**Reference:** `packages/paths/src/archon-paths.ts` (`@archon/paths`)

### Variable Substitution

**Supported variables:**

- `$1`, `$2`, `$3`, ... - Positional arguments
- `$ARGUMENTS` - All arguments as single string
- `\$` - Escaped dollar sign (literal `$`)

**Implementation** (`packages/core/src/utils/variable-substitution.ts`):

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

**Example:**

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

**Orchestrator logic** (`packages/core/src/orchestrator/`):

All messages starting with `/` are routed to the Command Handler first. If the command is recognized (deterministic), it is handled directly. Non-slash messages go through the AI router, which discovers available workflows and commands, then routes the user's request to the appropriate one.

**Command categories:**

1. **Deterministic** (handled by Command Handler):
   - `/help`, `/status`, `/getcwd`, `/setcwd`
   - `/clone`, `/repos`, `/repo`, `/repo-remove`
   - `/command-set`, `/load-commands`, `/commands`
   - `/worktree`, `/workflow`
   - `/reset`, `/reset-context`, `/init`

2. **AI-routed** (handled by Orchestrator):
   - Natural language messages are routed to workflows and commands via AI

### Command Handler Implementation

**Reference:** `packages/core/src/handlers/command-handler.ts`

The handler is split into focused functions per command group:

- `handleCommand()` -- Top-level dispatcher (switch on command name)
- `handleRepoCommand()` -- `/repo` (switch repos, pull, auto-load commands)
- `handleRepoRemoveCommand()` -- `/repo-remove` (delete repo + codebase record)
- `handleWorktreeCommand()` -- `/worktree` subcommands (create, list, remove, cleanup, orphans)
- `handleWorkflowCommand()` -- `/workflow` subcommands (list, reload, run, status, cancel, resume, abandon, approve, reject). The status/resume/abandon/approve/reject cases delegate to shared operations in `packages/core/src/operations/workflow-operations.ts`
- `resolveRepoArg()` -- Shared helper for repo lookup by number or name

**Important:** `modified: true` flag on `CommandResult` signals orchestrator to reload conversation state.

---

## Streaming Modes

Streaming modes control how AI responses are delivered to users: real-time (stream) or accumulated (batch).

### Configuration

**Environment variables** (per-platform):

```ini
TELEGRAM_STREAMING_MODE=stream  # Default: stream (real-time chat)
SLACK_STREAMING_MODE=batch      # Default: batch
```

### Mode Comparison

| Mode       | Behavior                                    | Pros                                       | Cons                                  | Best For                         |
| ---------- | ------------------------------------------- | ------------------------------------------ | ------------------------------------- | -------------------------------- |
| **stream** | Send each chunk immediately as AI generates | Real-time feedback, engaging, see progress | Many API calls, potential rate limits | Chat platforms (Telegram, Slack) |
| **batch**  | Accumulate all chunks, send final summary   | Single message, no spam, clean             | No progress indication, longer wait   | Issue trackers (GitHub, Jira)    |

### Implementation

**Orchestrator logic** (`packages/core/src/orchestrator/orchestrator.ts`):

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

**Stream mode**: Display tool calls in real-time

```
BASH
git status

READ
Reading: src/index.ts

EDIT
Editing: src/components/Header.tsx
```

**Batch mode**: Filter out tool indicators from final response

**Reference:** `packages/core/src/orchestrator/orchestrator.ts`

### Tool Formatter Utility

**Location:** `packages/core/src/utils/tool-formatter.ts`

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

Archon uses a 7-table schema with `remote_agent_` prefix. SQLite is the default (zero setup); PostgreSQL is optional for cloud/advanced deployments.

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

**Location:** `packages/core/src/db/`

**Codebases** (`packages/core/src/db/codebases.ts`):

- `createCodebase()` - Create codebase record
- `getCodebase(id)` - Get by ID
- `findCodebaseByRepoUrl(url)` - Find by repository URL
- `registerCommand(id, name, def)` - Add single command
- `updateCodebaseCommands(id, commands)` - Bulk update commands
- `getCodebaseCommands(id)` - Get all commands

**Conversations** (`packages/core/src/db/conversations.ts`):

- `getOrCreateConversation(platform, id)` - Idempotent get/create
- `updateConversation(id, data)` - Update fields (throws if conversation not found)

**Sessions** (`packages/core/src/db/sessions.ts`):

- `createSession(data)` - Create new session (supports `parent_session_id` and `transition_reason`)
- `transitionSession(conversationId, reason, data)` - Create new session linked to previous (immutable sessions)
- `getActiveSession(conversationId)` - Get active session for conversation
- `getSessionHistory(conversationId)` - Get all sessions for conversation (audit trail)
- `getSessionChain(sessionId)` - Walk session chain back to root
- `updateSession(id, sessionId)` - Update `assistant_session_id`
- `updateSessionMetadata(id, metadata)` - Update metadata JSONB
- `deactivateSession(id)` - Mark session inactive

**Error Handling:**

All UPDATE operations verify `rowCount` and throw errors if no rows were affected. This prevents silent failures when attempting to update non-existent records.

```typescript
// Example: updateConversation throws if conversation not found
await updateConversation(id, { codebase_id: '...' });
// Throws: "updateConversation: Conversation not found for id=..."
```

### Session Lifecycle

**Normal flow:**

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

**Plan-to-Execute transition (immutable sessions):**

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

**Reference:** `packages/core/src/orchestrator/orchestrator.ts`, `packages/core/src/state/session-transitions.ts`

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

- [ ] Create `packages/adapters/src/chat/your-platform/adapter.ts`
- [ ] Implement `IPlatformAdapter` interface
- [ ] Handle message length limits in `sendMessage()`
- [ ] Implement conversation ID extraction
- [ ] Set up polling or webhook handling
- [ ] Add to `packages/server/src/index.ts` with environment variable check
- [ ] Add environment variables to `.env.example`
- [ ] Test with both stream and batch modes

### Adding a New AI Agent Provider

- [ ] Create `packages/providers/src/your-assistant/provider.ts`
- [ ] Implement `IAgentProvider` interface
- [ ] Map SDK events to `MessageChunk` types
- [ ] Handle session creation and resumption
- [ ] Implement error handling and recovery
- [ ] Add to `packages/providers/src/factory.ts`
- [ ] Add environment variables to `.env.example`
- [ ] Test session persistence across restarts
- [ ] Test plan-to-execute transition (new session)

### Adding a New Isolation Provider

- [ ] Create `packages/isolation/src/providers/your-provider.ts`
- [ ] Implement `IIsolationProvider` interface
- [ ] Handle `create()`, `destroy()`, `get()`, `list()`, `healthCheck()`
- [ ] Optional: implement `adopt()` for existing environment discovery
- [ ] Register in `packages/isolation/src/factory.ts`
- [ ] Update database columns if needed (`isolation_provider` type)
- [ ] Test creation and cleanup lifecycle
- [ ] Test concurrent environments (multiple conversations)

### Modifying Command System

- [ ] Update `substituteVariables()` for new variable types
- [ ] Add command to Command Handler for deterministic logic
- [ ] Update `/help` command output
- [ ] Add example command file to `.archon/commands/`
- [ ] Test variable substitution with edge cases

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

Context is passed as a dedicated `issueContext` parameter to `handleMessage()`, keeping it separate from the user's message. For workflows, context is injected via `$CONTEXT` / `$ISSUE_CONTEXT` variable substitution in `buildPromptWithContext()`.

**Reference:** `packages/adapters/src/forge/github/adapter.ts`, `packages/core/src/orchestrator/orchestrator.ts`

---

## Key Takeaways

1. **Interfaces enable extensibility**: `IPlatformAdapter`, `IAgentProvider`, and `IIsolationProvider` allow adding platforms, AI providers, and isolation strategies without modifying core logic

2. **Async generators for streaming**: All AI providers return `AsyncGenerator<MessageChunk>` for unified streaming across different SDKs

3. **Session persistence is critical**: Store `assistant_session_id` in database to maintain context across restarts

4. **Platform-specific streaming**: Each platform controls its own streaming mode via environment variables

5. **Commands are file-based**: Store only paths in database, actual commands in Git-versioned files

6. **Plan-to-execute is special**: Only transition requiring new session (prevents token bloat during implementation)

7. **Factory pattern**: `getAgentProvider()` and `getIsolationProvider()` instantiate correct implementations based on configuration

8. **Error recovery**: Always provide `/reset` escape hatch for users when sessions get stuck

9. **Isolation adoption**: Providers check for existing environments before creating new ones (enables skill symbiosis)

---

**For detailed implementation examples, see:**

- Platform adapter: `packages/adapters/src/chat/telegram/adapter.ts`, `packages/adapters/src/forge/github/adapter.ts`
- AI provider: `packages/providers/src/claude/provider.ts`, `packages/providers/src/codex/provider.ts`
- Isolation provider: `packages/isolation/src/providers/worktree.ts`
- Isolation resolver: `packages/isolation/src/resolver.ts`
- Isolation factory: `packages/isolation/src/factory.ts`
- Orchestrator: `packages/core/src/orchestrator/orchestrator.ts`
- Command handler: `packages/core/src/handlers/command-handler.ts`
