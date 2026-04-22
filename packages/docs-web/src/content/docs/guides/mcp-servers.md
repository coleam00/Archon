---
title: Per-Node MCP Servers
description: Attach MCP (Model Context Protocol) servers to individual workflow nodes for external tool access.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 6
---

DAG workflow nodes support a `mcp` field that attaches MCP (Model Context Protocol)
servers to individual nodes. Each node gets exactly the external tools it needs —
GitHub, Linear, Postgres, etc. — without over-provisioning.

**Claude only** — Codex nodes will warn and ignore the `mcp` field.

## Quick Start

1. Create an MCP config file (e.g., `.archon/mcp/github.json`):

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN"
    }
  }
}
```

2. Reference it in your workflow:

```yaml
name: triage-issues
description: Triage GitHub issues using MCP
nodes:
  - id: triage
    prompt: "List open issues and label them by priority"
    mcp: .archon/mcp/github.json
```

That's it. The MCP server starts when the node runs, its tools become available
to the AI, and it shuts down when the node completes.

## Config File Format

MCP config files are JSON objects where each key is a server name and the value
is a server configuration. Three transport types are supported:

### stdio (default)

Runs a local process. This is the most common type.

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'stdio'` | No | Default when omitted |
| `command` | string | Yes | Executable to run |
| `args` | string[] | No | Command arguments |
| `env` | Record<string, string> | No | Environment variables for the process |

### HTTP

Connects to a remote HTTP endpoint.

```json
{
  "api": {
    "type": "http",
    "url": "https://mcp.example.com/v1",
    "headers": {
      "Authorization": "Bearer $API_KEY"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'http'` | Yes | Must be `'http'` |
| `url` | string | Yes | HTTP endpoint URL |
| `headers` | Record<string, string> | No | Request headers |

### SSE (Server-Sent Events)

Connects to an SSE endpoint.

```json
{
  "realtime": {
    "type": "sse",
    "url": "https://mcp.example.com/sse",
    "headers": {
      "Authorization": "Bearer $SSE_TOKEN"
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'sse'` | Yes | Must be `'sse'` |
| `url` | string | Yes | SSE endpoint URL |
| `headers` | Record<string, string> | No | Request headers |

## Environment Variable Expansion

Values in `env` and `headers` fields support `$VAR_NAME` references that are
expanded from `process.env` at execution time.

```json
{
  "db": {
    "command": "npx",
    "args": ["-y", "@mcp/server-postgres"],
    "env": {
      "DATABASE_URL": "$DATABASE_URL",
      "POOL_SIZE": "$DB_POOL_SIZE"
    }
  }
}
```

**Rules:**
- Pattern: `$UPPER_CASE_VAR` (matches `[A-Z_][A-Z0-9_]*`)
- Only `env` and `headers` values are expanded — `command`, `args`, `url` are left untouched
- Undefined vars are replaced with empty string and a warning is shown:
  `Warning: Node 'X' MCP config references undefined env vars: VAR_NAME`
- Expansion happens at execution time, not when the workflow YAML is loaded

**Why file-based?** MCP configs often contain secrets (API tokens, database URLs).
Workflow YAML files are committed to git. By keeping configs in separate JSON files,
you can gitignore them or rely on env var references so secrets never appear in source.

## Multiple Servers Per Node

A single config file can define multiple servers:

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN" }
  },
  "postgres": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-postgres"],
    "env": { "DATABASE_URL": "$DATABASE_URL" }
  }
}
```

## Automatic Tool Wildcards

When a node loads MCP servers, tool wildcards are automatically added to `allowedTools`.
For servers named `github` and `postgres`, the node gets:

- `mcp__github__*`
- `mcp__postgres__*`

This means all tools from those servers are immediately available without manually
listing them. The wildcards merge with any existing `allowed_tools` on the node.

## MCP-Only Nodes

Combine `mcp` with `allowed_tools: []` to create nodes that can only use MCP tools
and have no access to built-in tools (Bash, Read, Write, etc.):

```yaml
nodes:
  - id: query-db
    prompt: "Find all users who signed up in the last 24 hours"
    mcp: .archon/mcp/postgres.json
    allowed_tools: []
```

This is useful for sandboxing — the AI can only interact through the MCP server
and cannot touch the filesystem or run shell commands.

## Connection Failure Handling

MCP server connections are established when the node starts executing. If a
server the **workflow** configured via `mcp:` fails to connect, you'll see a
message like:

```
MCP server connection failed: github (failed)
```

The node continues executing but without the tools from the failed server.
Check your config file path, server command, and environment variables if this happens.

User-level Claude plugin MCPs inherited from `~/.claude/` (e.g. `telegram`,
`notion`) routinely fail to connect inside the headless workflow subprocess
and are **not** surfaced here — they're not actionable for the workflow author.
They appear only in debug logs as `dag.mcp_plugin_connection_suppressed`. Run
the CLI with `--verbose` (or set `LOG_LEVEL=debug` on the server) if you need
to see them.

## Workflow Examples

### GitHub Issue Triage

```yaml
name: triage-issues
description: Fetch and label GitHub issues
nodes:
  - id: triage
    prompt: |
      List all open issues in this repo.
      For each issue, add a priority label (P0-P3) based on:
      - P0: Security vulnerabilities, data loss
      - P1: Broken core functionality
      - P2: Important but not blocking
      - P3: Nice to have
    mcp: .archon/mcp/github.json
```

### Database-Informed Code Changes

```yaml
name: schema-aware-feature
description: Build features with live database context
nodes:
  - id: inspect-schema
    prompt: "List all tables and their columns in the database"
    mcp: .archon/mcp/postgres.json
    allowed_tools: []

  - id: implement
    command: implement-feature
    depends_on: [inspect-schema]
```

### Multi-Service Orchestration

```yaml
name: full-stack-fix
description: Fix a bug using GitHub issues, database, and code
nodes:
  - id: fetch-context
    prompt: "Get issue details and related database schema"
    mcp: .archon/mcp/all-services.json
    allowed_tools: []

  - id: fix
    command: implement-fix
    depends_on: [fetch-context]

  - id: verify
    prompt: "Run the relevant query to verify the fix"
    depends_on: [fix]
    mcp: .archon/mcp/postgres.json
    allowed_tools: []
```

### Read-Only Analysis with Hooks

Combine MCP with [hooks](/guides/hooks/) to create nodes that can query external
services but cannot modify the codebase:

```yaml
nodes:
  - id: analyze
    prompt: "Analyze our GitHub PR review patterns"
    mcp: .archon/mcp/github.json
    hooks:
      PreToolUse:
        - matcher: "Write|Edit|Bash"
          response:
            hookSpecificOutput:
              hookEventName: PreToolUse
              permissionDecision: deny
              permissionDecisionReason: "Analysis only — no code changes"
```

## Push Notifications (ntfy)

Some built-in workflows (like `archon-smart-pr-review`) include an optional
notification node that sends a push notification to your phone when the workflow
completes. It's gated behind a `when:` condition — if you haven't configured ntfy,
the node is silently skipped.

### Setup (30 seconds)

1. Install the [ntfy app](https://ntfy.sh/) on your phone (iOS / Android)
2. Open the app, tap "+", subscribe to a topic name (e.g. `archon-yourname-a8f3x`).
   Treat the topic name like a password — anyone who knows it can send you notifications.
3. Create `.archon/mcp/ntfy.json` in your repo:

```json
{
  "ntfy": {
    "command": "npx",
    "args": ["-y", "ntfy-me-mcp"],
    "env": {
      "NTFY_TOPIC": "archon-yourname-a8f3x"
    }
  }
}
```

That's it. The file is gitignored (`.archon/mcp/` is in `.gitignore`), so your
topic stays local.

### How it works in workflows

Workflows use a bash node to check if the config file exists:

```yaml
  - id: check-ntfy
    bash: "test -f .archon/mcp/ntfy.json && echo 'true' || echo 'false'"
    depends_on: [last-work-node]

  - id: notify
    depends_on: [check-ntfy, last-work-node]
    when: "$check-ntfy.output == 'true'"
    mcp: .archon/mcp/ntfy.json
    allowed_tools: []
    prompt: |
      Send a push notification summarizing what was accomplished.
      Keep it under 2 sentences. Use priority 3.
```

If `.archon/mcp/ntfy.json` doesn't exist, `check-ntfy` outputs `false`, the
`when:` condition skips the notify node, and the workflow runs exactly as before.

### Adding notifications to your own workflows

Add the two nodes above (check-ntfy + notify) to the end of any DAG workflow.
The notify node's prompt should reference upstream node outputs (e.g. `$synthesize.output`)
to generate a meaningful summary.

### Quick test

```bash
# Verify your phone receives notifications
curl -d "Hello from Archon" ntfy.sh/YOUR_TOPIC_NAME

# Run a workflow with notifications
bun run cli workflow run archon-smart-pr-review "Review PR #123"
```

## MCP vs allowed_tools/denied_tools vs hooks

| Feature | `mcp` | `allowed_tools`/`denied_tools` | `hooks` |
|---------|-------|-------------------------------|---------|
| Add external tools | Yes | No | No |
| Remove built-in tools | No | Yes | Yes |
| Inject context | No | No | Yes |
| Modify tool input | No | No | Yes |
| Sandbox to MCP only | `mcp` + `allowed_tools: []` | — | — |

## Limitations

- **Claude only** — Codex nodes warn and ignore the `mcp` field. Configure MCP
  servers globally in the Codex CLI config instead.
- **Haiku model** — Tool search (lazy loading for many tools) is not supported on
  Haiku. You'll see a warning. Consider using Sonnet or Opus for MCP nodes.
- **No load-time validation** — The MCP config file is read at execution time, not
  when the workflow YAML is loaded. A typo in the path won't surface until the node runs.
- **No inline config** — MCP configs must be in a separate JSON file, not inline in YAML.
  This is intentional — it keeps secrets out of version-controlled workflow files.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `MCP config file not found` | Wrong path or file doesn't exist | Check the path relative to your repo root (cwd) |
| `MCP config file is not valid JSON` | Syntax error in JSON | Validate with `cat .archon/mcp/config.json \| python3 -m json.tool` |
| `MCP config must be a JSON object` | Top-level value is array or string | Wrap in `{ "server-name": { ... } }` |
| `undefined env vars: VAR_NAME` | Environment variable not set | Export the variable or add it to your `.env` |
| `MCP server connection failed` | Server process crashed or URL unreachable | Check command/URL, test the server standalone |
| Plugin MCP missing from workflow output | User-level plugin MCPs (from `~/.claude/`) are filtered out of workflow warnings | Run with `--verbose` and look for `dag.mcp_plugin_connection_suppressed` |
| `mcp config but uses Codex` | Node resolved to Codex provider | Set `provider: claude` on the node or switch default |
| `Haiku model with MCP servers` | Haiku doesn't support tool search | Use `model: sonnet` or `model: opus` instead |

## Finding MCP Servers

Popular MCP servers for common integrations:

- **GitHub**: `@modelcontextprotocol/server-github`
- **PostgreSQL**: `@modelcontextprotocol/server-postgres`
- **Filesystem**: `@modelcontextprotocol/server-filesystem`
- **Slack**: `@modelcontextprotocol/server-slack`
- **Google Drive**: `@modelcontextprotocol/server-gdrive`
- **Brave Search**: `@modelcontextprotocol/server-brave-search`

Browse the full directory at [modelcontextprotocol.io/servers](https://modelcontextprotocol.io/servers).
