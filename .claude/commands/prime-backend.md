---
description: Prime agent with Archon backend (core + server) context
---

# Prime Backend: Core and Server Orientation

## Objective

Orient on the backend packages (`packages/core/` and `packages/server/`) before working on
server logic, orchestration, AI clients, slash commands, or API routes.

## Process

### 1. Understand the Core Package Structure

!`ls packages/core/src/`

### 2. Understand Message Flow (Orchestrator)

Read `packages/core/src/orchestrator/orchestrator-agent.ts` — the single entry point for all
platform messages. Maps messages to slash commands (via command-handler) or AI execution. Note
the lazy logger pattern and MAX_BATCH constants.

Read `packages/core/src/orchestrator/orchestrator.ts` first 60 lines — `validateAndResolveIsolation`
and `dispatchBackgroundWorkflow` utilities called by orchestrator-agent.

Read `packages/core/src/orchestrator/prompt-builder.ts` first 40 lines — how system prompts
are assembled with codebase context.

### 3. Understand Slash Command Routing

Read `packages/core/src/handlers/command-handler.ts` first 80 lines — deterministic command
dispatch (no AI). Note the full list of supported slash commands.

### 4. Understand Session State Machine

Read `packages/core/src/state/session-transitions.ts` in full — `TransitionTrigger` union type,
`TRIGGER_BEHAVIOR` record (creates / deactivates / none), and session lifecycle rules.

### 5. Understand AI Client Patterns

List providers:
!`ls packages/core/src/providers/`

Read `packages/core/src/providers/factory.ts` for provider selection logic.
Read `packages/core/src/providers/claude.ts` first 50 lines — `IAgentProvider` implementation
with streaming event loop pattern.

### 6. Understand Database Layer

List DB modules:
!`ls packages/core/src/db/`

Read `packages/core/src/types/index.ts` (or the main types file) first 60 lines for key
interfaces: `IPlatformAdapter`, `IAgentProvider`, `Conversation`, `Session`.

### 7. Understand the Server

Read `packages/server/src/index.ts` first 80 lines — adapter wiring, port allocation logic
(worktree auto-port in 3190–4089 range), Hono app setup.

List API routes:
!`ls packages/server/src/routes/`

Read `packages/server/src/routes/api.ts` first 60 lines for REST endpoint structure.

### 8. Check Recent Backend Activity

!`git log -8 --oneline -- packages/core/ packages/server/`

## Output

Summarize (under 250 words):

### Message Flow
- Platform → `handleMessage()` → orchestrator-agent → command handler OR AI client
- How ConversationLockManager gates concurrency
- Lock statuses: `started` / `queued-conversation` / `queued-capacity`

### Session Lifecycle
- `TransitionTrigger` values and their behaviors
- Only `plan-to-execute` immediately creates a new session; others deactivate first

### AI Providers
- `ClaudeProvider` (claude-agent-sdk) and `CodexProvider` (codex-sdk)
- `IAgentProvider` streaming pattern: `for await (const event of events)`

### Key Database Tables
- conversations, sessions, codebases, isolation_environments, workflow_runs, workflow_events, messages

### Server
- Port allocation: 3090 default, auto-allocated worktree ports
- Adapters wired: Telegram, GitHub, Discord, Slack, Web (SSE)

### Recent Changes
- Last few backend commits
