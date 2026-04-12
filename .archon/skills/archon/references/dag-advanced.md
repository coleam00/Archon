# Advanced Features: Hooks, MCP, Skills, Retry

These features are available on **command and prompt nodes** (hooks, MCP, skills, tool restrictions) and **command, prompt, and bash nodes** (retry, output_format). Loop nodes do not support these features (`retry` on loop nodes is a hard error; others are silently ignored).

## Provider Compatibility

| Feature | Claude (per-node) | Codex (per-node) | Codex (global) |
|---------|-------------------|------------------|----------------|
| `hooks` | Supported | Ignored | Not available |
| `mcp` | Supported | Ignored | `~/.codex/config.toml` `[mcp_servers.*]` |
| `skills` | Supported | Ignored | `~/.agents/skills/` or `.agents/skills/` |
| `allowed_tools` / `denied_tools` | Supported | Ignored | `enabled_tools` / `disabled_tools` per MCP server in config.toml |
| `output_format` | Supported | Supported | — |
| `retry` | Supported | Supported | — |
| `model` / `provider` per-node | Supported | Supported | — |

### Claude vs Codex: How Each Gets MCP and Skills

**Claude**: MCP servers and skills are configured **per-node** in the workflow YAML via `mcp:` and `skills:` fields. Each node can have different MCP servers and skills.

**Codex**: MCP servers and skills are configured **globally** — they apply to all Codex nodes in the workflow:
- **MCP servers**: Add to `~/.codex/config.toml` (or `.codex/config.toml` in the repo):
  ```toml
  [mcp_servers.github]
  command = "npx"
  args = ["-y", "@modelcontextprotocol/server-github"]
  env = { GITHUB_TOKEN = "your-token" }
  ```
  Manage with: `codex mcp add <name>`, `codex mcp list`
- **Skills**: Place in `~/.agents/skills/<name>/SKILL.md` (user-level) or `.agents/skills/<name>/SKILL.md` (repo-level). Codex discovers them automatically.
- **Custom instructions**: Place in `~/.codex/AGENTS.md` (global) or `AGENTS.md` in the repo root.

The Codex CLI picks up all of these automatically because Archon inherits the full process environment when spawning the CLI. No Archon configuration needed — just set up the Codex CLI config once.

**Hooks** have no Codex equivalent — they are a Claude-only SDK feature for intercepting tool calls.

---

## Hooks

> Claude only. Codex nodes log a warning and ignore hooks.

Hooks intercept tool calls during a node's AI execution. Use them to approve/deny tools, inject context after tool use, or emergency-stop the agent.

### Syntax

```yaml
- id: analyze
  prompt: "Analyze the codebase"
  hooks:
    PreToolUse:
      - matcher: "Bash"                    # Regex on tool name (optional)
        response:                          # Required: SDK SyncHookJSONOutput
          hookSpecificOutput:
            hookEventName: PreToolUse      # Must match the event key
            permissionDecision: deny
            permissionDecisionReason: "No shell access in analysis phase"
        timeout: 30                        # Seconds (optional, default: 60)
    PostToolUse:
      - matcher: "Read"
        response:
          systemMessage: "You just read a file. Stay focused on analysis — do not modify anything."
      - response:                          # No matcher = fires on every tool
          systemMessage: "Verify this output is relevant."
```

### Supported Hook Events

Most commonly used: `PreToolUse`, `PostToolUse`, `Stop`

Full list: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, `Setup`, `TeammateIdle`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`

### Matcher Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `matcher` | string | No | Regex pattern to filter by tool name. Omit to match all |
| `response` | object | **Yes** | The `SyncHookJSONOutput` returned when hook fires |
| `timeout` | number | No | Timeout in **seconds** (default: 60) |

### Response Fields

| Field | Type | Effect |
|-------|------|--------|
| `hookSpecificOutput` | object | Event-specific payload. Must include `hookEventName` matching the outer event key |
| `systemMessage` | string | Inject a message visible to the AI model |
| `continue` | boolean | Set to `false` to stop the agent |
| `stopReason` | string | Reason when stopping |
| `decision` | `approve` / `block` | Top-level approve/block decision |

### PreToolUse hookSpecificOutput

| Field | Effect |
|-------|--------|
| `permissionDecision` | `deny` / `allow` / `ask` |
| `permissionDecisionReason` | Human-readable reason |
| `updatedInput` | Object to replace tool arguments |
| `additionalContext` | Extra context injected into the conversation |

### PostToolUse hookSpecificOutput

| Field | Effect |
|-------|--------|
| `additionalContext` | Context injected after the tool runs |
| `updatedMCPToolOutput` | Replace MCP tool output |

### Common Patterns

**Deny specific tools:**
```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit|Bash"
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: deny
          permissionDecisionReason: "Read-only analysis node"
```

**Inject guidance after file reads:**
```yaml
hooks:
  PostToolUse:
    - matcher: "Read"
      response:
        systemMessage: "Focus on identifying security vulnerabilities in what you just read."
```

**Emergency stop on shell access:**
```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      response:
        continue: false
        stopReason: "Shell access not permitted"
```

### Hooks vs Tool Restrictions

| Mechanism | Granularity | Effect |
|-----------|------------|--------|
| `allowed_tools` | Coarse | Tools not in list are invisible to AI |
| `denied_tools` | Coarse | Listed tools are invisible to AI |
| `hooks.PreToolUse` | Fine | Tool is visible but call can be denied/modified/annotated |

Use `allowed_tools`/`denied_tools` for hard restrictions. Use hooks when you want the AI to know the tool exists but have guardrails on how it's used.

---

## MCP (Model Context Protocol) Servers

> Claude only. Codex nodes log a warning and ignore MCP configuration.

Connect external tool servers to individual nodes.

### Syntax

```yaml
- id: github-analysis
  prompt: "Analyze recent PRs using GitHub MCP tools"
  mcp: .archon/mcp/github.json          # Path relative to repo root
  allowed_tools: []                      # MCP-only mode (no built-in tools)
```

### Config File Format

The JSON file defines one or more MCP servers:

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_TOKEN": "$GITHUB_TOKEN"
    }
  }
}
```

**Transport types:**

stdio (default):
```json
{
  "my-server": {
    "command": "npx",
    "args": ["-y", "@server/package"],
    "env": { "API_KEY": "$MY_API_KEY" }
  }
}
```

HTTP:
```json
{
  "my-server": {
    "type": "http",
    "url": "https://api.example.com/mcp",
    "headers": { "Authorization": "Bearer $API_KEY" }
  }
}
```

SSE:
```json
{
  "my-server": {
    "type": "sse",
    "url": "https://api.example.com/sse"
  }
}
```

### Environment Variable Expansion

`$VAR_NAME` patterns in `env` and `headers` values are expanded from `process.env` at **execution time** (not load time). This keeps secrets out of YAML files.

Missing env vars produce a user-visible warning but don't abort the node.

### Automatic Tool Wildcards

When MCP servers are loaded, `mcp__<serverName>__*` wildcards are automatically added to the node's allowed tools. This means MCP tools work without explicit permission.

### MCP-Only Nodes

Combine `mcp:` with `allowed_tools: []` for nodes that should ONLY use MCP tools:

```yaml
- id: notify
  prompt: "Send a notification that the workflow completed"
  mcp: .archon/mcp/ntfy.json
  allowed_tools: []                    # No built-in tools, MCP only
```

---

## Skills

> Claude only. Codex nodes log a warning and ignore skills.

Preload domain knowledge into a node via Claude Code skills.

### Syntax

```yaml
- id: generate
  prompt: "Create a Remotion animation for: $ARGUMENTS"
  skills:
    - remotion-best-practices          # Must be installed in .claude/skills/
  allowed_tools: [Read, Write, Edit, Glob]
```

### How It Works

When `skills:` is set, the node is wrapped in a Claude SDK `AgentDefinition`:
- The skill content is injected into the agent's context at startup
- The `Skill` tool is automatically added to the node's allowed tools
- The agent gets a system prompt listing the preloaded skills

### Installing Skills

```bash
# From the skills.sh marketplace
npx skills add remotion-dev/skills

# Or create manually
mkdir -p .claude/skills/my-skill
# Write .claude/skills/my-skill/SKILL.md with frontmatter
```

Skills are discovered from:
- `.claude/skills/` (project-level)
- `~/.claude/skills/` (user-level, global)

### Combining Skills with MCP

Skills provide **knowledge** (how to do something). MCP provides **capability** (external tool access). Combine them:

```yaml
- id: smart-github-agent
  prompt: "Triage these issues using GitHub best practices"
  skills:
    - github-triage-guide
  mcp: .archon/mcp/github.json
  allowed_tools: []                    # MCP tools + skill knowledge
```

---

## Retry Configuration

Available on command, prompt, and bash nodes. **Not supported on loop nodes** (hard error at load time).

```yaml
- id: deploy
  bash: "deploy.sh"
  retry:
    max_attempts: 3                    # 1-5 (required when retry is set)
    delay_ms: 5000                     # 1000-60000, default 3000. Doubles each attempt
    on_error: all                      # 'transient' (default) or 'all'
```

### Error Classification

| Category | Examples | Retried? |
|----------|----------|----------|
| **FATAL** | `unauthorized`, `forbidden`, `permission denied`, `invalid token`, `authentication failed`, `auth error`, `401`, `403`, `credit balance` | Never |
| **TRANSIENT** | `timeout`, `etimedout`, `rate limit`, `too many requests`, `429`, `502`, `503`, `econnrefused`, `econnreset`, `network error`, `socket hang up`, `exited with code`, `claude code crash` | By default |
| **UNKNOWN** | Everything else | Only with `on_error: all` |

FATAL patterns take priority over TRANSIENT patterns in the same error message.

### Two-Layer Retry Stack

1. **SDK-level** (automatic): Built-in retry for API errors (behavior managed by the Claude/Codex SDK)
2. **Node-level** (configurable via `retry:`): Wraps the entire SDK call. Default when `retry:` is omitted: 2 retries, 3000ms base delay, transient errors only

### Idle Timeout

Separate from retry — controls how long a node can be idle (no output) before being aborted:

```yaml
- id: long-running
  command: full-analysis
  idle_timeout: 600000                 # 10 minutes (default: 5 minutes / 300000ms)
```

For bash nodes, use `timeout:` instead (controls total script execution time, default: 120000ms).
