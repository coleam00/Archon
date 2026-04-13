---
title: Web UI
description: Built-in web interface for interacting with Archon -- no tokens or external services required.
category: adapters
area: adapters
audience: [user]
status: current
sidebar:
  order: 1
---

The Web UI is the built-in interface for interacting with Archon. It requires no tokens, API keys, or external services -- just start the server and open your browser.

## Prerequisites

- Archon installed and dependencies resolved (`bun install`)
- An Anthropic API key or Claude Code authentication (see [AI Assistants](/getting-started/ai-assistants/))

## Starting the Web UI

**Development (recommended):**

```bash
# Start both backend + frontend with hot reload
bun run dev
# Web UI: http://localhost:5173
# API server: http://localhost:3090
```

You can also start each piece individually:

```bash
# Backend API server only (port 3090)
bun run dev:server

# Frontend dev server only (port 5173, requires backend running)
bun run dev:web
```

**Production:**

```bash
bun run build    # Build the frontend into static files
bun run start    # Server serves both API and Web UI on port 3090
```

In production mode, the backend serves the compiled frontend at the same port (3090), so there is no separate frontend URL.

**Remote / homelab access:**

The backend binds to `0.0.0.0` by default. The Vite dev server only listens on `localhost`. To expose the frontend on your network:

```bash
bun run dev:web -- --host 0.0.0.0
```

Then start the backend separately with `bun run dev:server`. The Web UI will be reachable at `http://<server-ip>:5173`. Make sure your firewall allows ports 5173 and 3090.

## UI Layout

The Web UI is a dark-themed single-page application with four main areas:

### Left Sidebar

- **Conversations list** -- All your chat conversations, searchable and grouped by project. Click to switch, right-click or hover for rename/delete.
- **Project selector** -- Registered codebases appear here. Select a project to scope conversations and workflows to that repository. You can also register new projects (clone from URL or register a local path) and remove existing ones.
- **Workflow invoker** -- A quick-launch panel for running workflows. Select a workflow from the dropdown, type a message, and hit Run. This creates a new conversation and starts the workflow in one action.

### Main Chat Area

The center of the screen is the chat interface -- this is where you interact with the AI assistant. It works like any chat application, with some additions specific to coding workflows.

### Command Center (Dashboard)

Accessible via the `/dashboard` route, the Command Center shows all workflow runs across your projects. It includes:

- **Status summary bar** -- Counts of running, completed, failed, and paused workflows
- **Workflow run cards** -- Each run shows its status, workflow name, elapsed time, and node progress
- **Actions** -- Resume, cancel, abandon, approve, or reject runs directly from the dashboard
- **History table** -- Paginated list of past runs with date range filtering

### Settings

The `/settings` page lets you configure assistant defaults (model, provider) without editing YAML files.

## Chat Interface

### Creating Conversations

Click the "New Chat" button in the sidebar, or use the workflow invoker to create a conversation that immediately starts a workflow. Each conversation gets a unique ID and persists across page refreshes.

If a project is selected in the sidebar, new conversations are automatically scoped to that codebase.

### Sending Messages

Type in the message input at the bottom and press Enter (or click Send). Messages can be:

- **Natural language** -- The AI assistant responds conversationally, using tools to explore and modify code
- **Slash commands** -- `/status`, `/workflow list`, `/help`, etc. These are handled deterministically without AI
- **Workflow triggers** -- Messages like "fix issue #42" or "review this PR" are routed to the appropriate workflow automatically

### AI Responses and Tool Calls

AI responses stream in real-time. When the assistant uses tools (reading files, running commands, editing code), each tool call appears as a collapsible card showing:

- The tool name and input arguments
- The tool's output or result
- Expandable/collapsible to keep the chat readable

A **lock indicator** appears while the agent is actively working, so you know when it is safe to send another message.

### Connection Status

A status indicator in the UI shows whether the SSE connection to the backend is active. If you see "disconnected", check that the backend is running and refresh the page.

## Workflow Execution

### Running Workflows

There are three ways to run a workflow from the Web UI:

1. **Sidebar workflow invoker** -- Select a workflow, type a message, and click Run
2. **Chat message** -- Describe what you want and the router picks the right workflow (e.g., "review PR #123")
3. **Slash command** -- `/workflow run <name> <message>` for explicit invocation

### Foreground vs Background Execution

By default, workflows run in the background -- the conversation shows a progress card while the workflow executes in a separate worker conversation. You can continue chatting or start other workflows.

Workflows with `interactive: true` in their YAML definition run in the foreground. This is required for workflows that have approval gates or interactive loop nodes, since those need you to approve/reject steps in real time.

### Workflow Progress Cards

While a workflow runs, a progress card appears in the conversation showing:

- Current status (running, completed, failed, paused)
- Which DAG node is currently executing
- Per-node status indicators
- Elapsed time

For paused workflows (approval gates), the progress card shows **Approve** and **Reject** buttons so you can control the workflow directly from the chat.

### Workflow Result Card

When a workflow reaches a terminal state (completed, failed, or cancelled), the progress card is replaced by a result card in the conversation. The result card shows:

- **Status icon** -- Visual indicator for completed, failed, or cancelled
- **Header** -- "Workflow complete", "Workflow failed", or "Workflow cancelled" depending on outcome
- **Node count** -- How many nodes completed out of the total nodes that reached a terminal state (e.g., `3/4 nodes`)
- **Duration** -- Total elapsed time for the run
- **Artifacts** -- Any files or outputs produced by the workflow, with direct links

Click the arrow button in the result card header to open the full execution detail page.

### Execution Detail Page

Click on a workflow run (from the dashboard or progress card) to open the execution detail page at `/workflows/runs/:runId`. This shows:

- The full DAG graph with per-node status
- Step-by-step logs for each node
- Artifacts produced by the workflow
- Actions to resume, cancel, or abandon the run

## Workflow Builder

The Workflow Builder at `/workflows/builder` provides a visual editor for creating and modifying workflow YAML files. Features include:

- **DAG canvas** -- Drag-and-drop nodes to build your workflow graph visually
- **Node palette** -- Add command, prompt, bash, and loop nodes from a sidebar library
- **Node inspector** -- Click a node to configure its properties (command, prompt text, dependencies, model overrides, hooks, MCP servers, etc.) in a tabbed panel
- **View modes** -- Toggle between Visual, Split, and Code views. Split mode shows the canvas and YAML side by side.
- **Command picker** -- Browse available commands when configuring command nodes
- **Validation panel** -- Real-time validation feedback as you build
- **Undo/redo** -- Full undo/redo stack with keyboard shortcuts
- **Save** -- Saves the workflow YAML to your project's `.archon/workflows/` directory

You can also browse existing workflows on the `/workflows` page and open any of them in the builder to edit.

## SSE Streaming

The Web UI uses Server-Sent Events (SSE) for real-time communication with the backend. When you open a conversation, the frontend opens a persistent connection to `/api/stream/:conversationId`.

Events streamed over SSE include:

| Event Type | Description |
|------------|-------------|
| `text` | AI response text (batched for performance) |
| `tool_call` | Tool invocation with arguments |
| `tool_result` | Tool execution result |
| `workflow_step` | Workflow node status change |
| `workflow_status` | Overall workflow run status update |
| `workflow_dispatch` | Workflow started for this conversation |
| `dag_node` | DAG node progress update |
| `workflow_artifact` | Artifact produced by a workflow |
| `conversation_lock` | Lock/unlock indicator |
| `session_info` | Session metadata |
| `error` | Error message |
| `heartbeat` | Keep-alive signal |

A separate dashboard SSE stream at `/api/stream/__dashboard__` multiplexes workflow events across all conversations, powering the Command Center's live updates.

## Projects and Codebases

### Registering a Project

From the Web UI, you can register codebases in two ways:

1. **Clone from URL** -- Use the `/clone <url>` command in chat, or use the API to POST to `/api/codebases` with a `url` field
2. **Register a local path** -- POST to `/api/codebases` with a `path` field pointing to an existing git repository

Registered codebases appear in the sidebar's project selector.

### Switching Projects

Click a project in the sidebar to scope your conversations and workflows to that codebase. The selected project determines:

- Which `.archon/commands/` and `.archon/workflows/` are loaded
- The working directory for AI tool execution
- Which worktrees and isolation environments are shown

### Removing a Project

Hover over a project in the sidebar and click the delete icon, or use the API to DELETE `/api/codebases/:id`. This removes the registration but does not delete the cloned files.

## Further Reading

- [Getting Started](/getting-started/overview/) -- Full setup guide
- [Configuration](/getting-started/configuration/) -- Customize Archon for your project
- [Authoring Workflows](/guides/authoring-workflows/) -- Create custom workflows
- [API Reference](/reference/api/) -- Full REST API documentation
