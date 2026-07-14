# Advanced Features: Hooks, MCP, Skills, Retry, Sessions, Typed Artifacts

Hooks, MCP, skills, tool restrictions, `output_format`, `agents`, and Claude SDK options apply to **command and prompt nodes** (including loop_group *body* nodes of those types). `retry` applies to command/prompt by default and to bash/script with an explicit block (see §Retry). Loop/loop_group nodes support none of these directly (`retry` there is a hard error; the rest are silently ignored) — except `model`/`provider`, which they forward to iterations. Bash and script nodes ignore AI-specific fields with a loader warning.

## Provider Compatibility

| Feature | Claude (per-node) | Codex (per-node) | Pi (per-node) | Codex (global) |
|---------|-------------------|------------------|---------------|----------------|
| `hooks` | Supported | Ignored + warn | Not available | Not available |
| `mcp` | Supported | **Supported** (translated to `mcp_servers` config overrides) | Not available | `~/.codex/config.toml` `[mcp_servers.*]` |
| `skills` | Supported | Informational (auto-discovers from `.agents/skills/`) | Supported | `~/.agents/skills/` or `.agents/skills/` |
| `allowed_tools` / `denied_tools` | Supported | Ignored | **Supported** | `enabled_tools` / `disabled_tools` per MCP server in config.toml |
| `output_format` | Enforced | Enforced | Best-effort (validated + up to 3 re-asks) | — |
| `retry` | Supported | Supported | Supported | — |
| `model` / `provider` per-node | Supported | Supported | Supported | — |
| `effort` / `thinking` | Supported | Use `modelReasoningEffort` | Supported (maps to thinking level) | — |
| `agents` / `sandbox` / `maxBudgetUsd` / `fallbackModel` | Supported | No | No | — |

Community providers beyond Pi: **OpenCode** supports per-node `mcp`, `hooks`, `skills`, `agents`, and tool restrictions (effort/thinking via `opencode.json`, not per-node); **Copilot** supports per-node `mcp`, `skills`, `agents`, tool restrictions, and effort/thinking (no hooks). See the five-provider matrix in `parameter-matrix.md` §Providers at a Glance. `sandbox`/`maxBudgetUsd`/`fallbackModel` remain Claude-only.

### Claude vs Codex: How Each Gets MCP and Skills

**Claude**: MCP servers and skills are configured **per-node** in the workflow YAML via `mcp:` and `skills:` fields. Each node can have different MCP servers and skills.

**Codex**: per-node `mcp:` works (Archon translates the JSON config into Codex `mcp_servers` overrides). Skills and instructions are filesystem-global:
- **MCP servers (global alternative)**: Add to `~/.codex/config.toml` (or `.codex/config.toml` in the repo):
  ```toml
  [mcp_servers.github]
  command = "npx"
  args = ["-y", "@modelcontextprotocol/server-github"]
  env = { GITHUB_TOKEN = "your-token" }
  ```
  Manage with: `codex mcp add <name>`, `codex mcp list`
- **Skills**: Place in `~/.agents/skills/<name>/SKILL.md` (user-level) or `.agents/skills/<name>/SKILL.md` (repo-level). Codex discovers them automatically; a node's `skills:` list is informational for Codex.
- **Custom instructions**: Place in `~/.codex/AGENTS.md` (global) or `AGENTS.md` in the repo root.

**Hooks** have no Codex/Pi equivalent — they are a Claude-only SDK feature for intercepting tool calls.

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

> Claude, Codex, OpenCode, and Copilot all accept per-node `mcp:` (translated to each SDK's server config). Only Pi lacks MCP — Pi nodes log a warning and ignore it.

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

> Claude, Pi, OpenCode, and Copilot support per-node `skills:` injection. Codex discovers skills from the filesystem (`.agents/skills/`) — a node's `skills:` list is informational there.

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

Available on command and prompt nodes (default-on for transient errors), and on bash/script nodes **only with an explicit `retry:` block**. **Not supported on loop/loop_group nodes** (hard error at load time — the loop manages its own iteration).

> **Version note (#2088):** on builds before the #2088 fix, `retry:` on bash/script nodes was accepted by the schema but never executed at runtime — only command/prompt nodes actually retried. Check `archon version` / CHANGELOG if a bash retry appears to be ignored.

```yaml
- id: deploy
  bash: "deploy.sh"
  retry:
    max_attempts: 3                    # 1-5 (required when retry is set)
    delay_ms: 5000                     # 1000-60000, default 3000. Doubles each attempt
    on_error: all                      # 'transient' (default) or 'all'
```

For deterministic bash/script failures (a script that exits 1 reproducibly), retrying is pointless — `retry:` there is for flaky externals (network fetches, rate-limited APIs). Classification detail: a bash/script failure message is formatted `<node> failed [exit N]: <stderr>`, so the classifier runs on your script's **stderr text** — the `exited with code` TRANSIENT pattern in the table below targets AI-CLI crash messages and does NOT match a bash/script non-zero exit. A subprocess `timeout` DOES classify TRANSIENT. Practical rule: rely on the default `on_error: transient` when failures surface as timeouts/rate-limit text on stderr; use `on_error: all` when the flaky failure mode produces generic stderr.

### Error Classification

| Category | Examples | Retried? |
|----------|----------|----------|
| **FATAL** | `unauthorized`, `forbidden`, `permission denied`, `invalid token`, `authentication failed`, `auth error`, `401`, `403`, `credit balance` | Never |
| **TRANSIENT** | `timeout`, `etimedout`, `rate limit`, `too many requests`, `429`, `502`, `503`, `econnrefused`, `econnreset`, `network error`, `socket hang up`, `exited with code`, `claude code crash` | By default |
| **UNKNOWN** | Everything else | Only with `on_error: all` |

FATAL patterns take priority over TRANSIENT patterns in the same error message.

### Two-Layer Retry Stack

1. **SDK-level** (automatic): Built-in retry for API errors (behavior managed by the Claude/Codex SDK)
2. **Node-level** (configurable via `retry:`): Wraps the entire SDK call. Default when `retry:` is omitted: AI nodes get 2 retries, 3000ms base delay, transient errors only; bash/script nodes get a single attempt (no default retries)

Retried AI attempts fork the session — a retry never corrupts the original session, and structured-output re-asks (a separate mechanism, up to 3 for best-effort providers) run in fresh sessions.

### Idle Timeout

Separate from retry — controls how long a node can be **silent** (no streamed output) before being aborted. It's a deadlock detector, not a work limiter: the timer resets on every message, so it only fires when the subprocess goes completely quiet.

```yaml
- id: long-running
  command: full-analysis
  idle_timeout: 3600000                # 60 minutes (default: 30 minutes / 1800000ms)
```

For bash/script nodes, use `timeout:` instead (controls total script execution time, default: 120000ms).

---

## Session Persistence (`persist_session`)

Persist a node's AI session **across runs** of the same workflow, so a later run's node resumes with the earlier conversation's context. This is cross-RUN memory — distinct from `context: shared` (within-run session threading between sequential nodes).

```yaml
name: standup-report
persist_sessions: true        # workflow-level default for all eligible nodes

nodes:
  - id: gather
    bash: "git log --since=yesterday --oneline"
  - id: report
    prompt: "Yesterday's commits: $gather.output. Write the standup update, consistent with prior days."
    depends_on: [gather]
    persist_session: true     # node-level (redundant here — workflow default covers it)
```

Mechanics:
- Only `command`/`prompt` nodes are eligible. Not bash/script/approval/cancel/loop/loop_group (and not loop_group *body* nodes — body sessions reset per iteration).
- Sessions are keyed by `(workflow name, node id, scope, provider)`. The scope is the **conversation** — chat threads each get their own memory; CLI runs share a per-invocation-context scope.
- Requires a provider with the `sessionResume` capability (Claude/Codex/Pi/OpenCode all have it). A `persist_session: true` node on a non-resumable provider fails at load or run time — never silently downgrades.
- `context: 'fresh'` on the node opts it back out.
- **Cold resume**: if the provider can't restore the session (transcript gone, server restart), the node still runs — fresh — with a warning, plus pointers to prior typed artifacts (see below) so the agent can re-read what it lost. It does not fail and does not re-run.
- Clear persisted memory with `archon workflow reset-sessions <workflow> [--node <id>] [--scope <key>]` (chat: `/workflow reset-sessions <name> [<node-id>]`, auto-scoped to the conversation).

## Typed Output Artifacts (`output_type`)

Any node can declare `output_type: <label>` (e.g. `plan`, `report`, `diff-summary`). After the node completes, the engine writes sidecars (best-effort — a write failure never fails the node):

```text
$ARTIFACTS_DIR/nodes/<node-id>.md          # the node's output text
$ARTIFACTS_DIR/nodes/<node-id>.meta.json   # { nodeId, outputType, path, runId, producedAt, size }
```

Why: downstream nodes and **later runs** can locate output by type instead of hardcoding filenames. When a workflow uses session persistence, typed artifacts are additionally mirrored to a cross-run scope directory (`artifacts/scopes/<workflow>/<conversation>/`), which is what cold-resume recovery points at.

Prefer `output_type` over ad-hoc "write to $ARTIFACTS_DIR/plan.md" conventions when a later run (not just the next node) needs to find the output.
