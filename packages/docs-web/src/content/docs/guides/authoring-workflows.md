---
title: Authoring Workflows
description: Create multi-step YAML workflows with DAG nodes, conditional branching, and parallel execution.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 1
---

This guide explains how to create workflows that orchestrate multiple commands into automated pipelines. Read [Authoring Commands](/guides/authoring-commands/) first — workflows are built from commands.

## What is a Workflow?

A workflow is a **YAML file** that defines a directed acyclic graph (DAG) of commands to execute. Workflows enable:

- **Multi-step automation**: Chain multiple AI agents together
- **Parallel execution**: Independent nodes run concurrently
- **Conditional branching**: Route to different paths based on node output
- **Artifact passing**: Output from one node becomes input for downstream nodes
- **Iterative loops**: Loop nodes repeat until a completion signal

```yaml
name: fix-github-issue
description: Investigate and fix a GitHub issue end-to-end

nodes:
  - id: investigate
    command: investigate-issue

  - id: implement
    command: implement-issue
    depends_on: [investigate]
    context: fresh
```

> **Using defaults as templates:** Archon ships default workflows in `.archon/workflows/defaults/` (12 bundled into the binary, plus additional ones available on disk in source builds). Browse them for real-world examples, then copy and modify:
> ```bash
> cp .archon/workflows/defaults/archon-fix-github-issue.yaml .archon/workflows/my-fix-issue.yaml
> ```
> Same-named files in `.archon/workflows/` override the bundled defaults.

---

## File Location

Workflows live in `.archon/workflows/` relative to the working directory:

```
.archon/
├── workflows/
│   ├── my-workflow.yaml
│   └── review/
│       └── full-review.yaml    # Subdirectories work
└── commands/
    └── [commands used by workflows]
```

Archon discovers workflows recursively - subdirectories are fine. If a workflow file fails to load (syntax error, validation failure), it's skipped and the error is reported via `/workflow list`.

> **Global workflows:** For workflows that apply to every project, place them in `~/.archon/.archon/workflows/`. Global workflows are overridden by same-named repo workflows. See [Global Workflows](/guides/global-workflows/).

> **CLI vs Server:** The CLI reads workflow files from wherever you run it (sees uncommitted changes). The server reads from the workspace clone at `~/.archon/workspaces/owner/repo/`, which only syncs from the remote before worktree creation. If you edit a workflow locally but don't push, the server won't see it.

---

## Workflow Structure

Workflows use DAG-based execution with `nodes:`. Each node runs a command or inline prompt, declares dependencies, and supports conditional branching:

```yaml
name: classify-and-fix
description: Classify issue type, then run the appropriate fix path

nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success
```

Nodes without `depends_on` run immediately. Nodes in the same topological layer run concurrently via `Promise.allSettled`. Skipped nodes (failed `when:` condition or `trigger_rule`) propagate their skipped state to dependants.

> **Note:** The `steps:` (sequential) format has been removed. All workflows use `nodes:` (DAG) format exclusively.

---

## DAG-Based Workflow Schema

```yaml
# Required
name: workflow-name
description: |
  What this workflow does.

# Optional workflow-level configuration
provider: claude
model: sonnet
modelReasoningEffort: medium     # Codex only
webSearchMode: live              # Codex only
interactive: true                # Web only: run in foreground instead of background

# Required for DAG-based
nodes:
  - id: classify                 # Unique node ID (used for dependency refs and $id.output)
    command: classify-issue      # Loads from .archon/commands/classify-issue.md
    output_format:               # Optional: enforce structured JSON output (Claude + Codex)
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]       # Wait for classify to complete
    when: "$classify.output.type == 'BUG'"  # Skip if condition is false

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success  # Run if at least one dep succeeded

  - id: inline-node
    prompt: "Summarize the changes made in $implement.output"  # Inline prompt (no command file)
    depends_on: [implement]
    context: fresh               # Force fresh session for this node
    provider: claude             # Per-node provider override
    model: haiku                 # Per-node model override
    # hooks:                     # Optional: per-node SDK hook callbacks (Claude only) — see hooks guide
    # mcp: .archon/mcp/servers.json  # Optional: per-node MCP servers (Claude only)
    # skills: [remotion-best-practices]  # Optional: per-node skills (Claude only) — see skills guide
```

### Node Fields

**Node types** — exactly one required per node (mutually exclusive):

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Command name to load from `.archon/commands/` |
| `prompt` | string | Inline prompt string |
| `bash` | string | Shell script (no AI). Stdout captured as `$nodeId.output`. Optional `timeout` (ms, default 120000) |
| `loop` | object | Iterative AI prompt until completion signal. See [Loop Nodes](/guides/loop-nodes/) |
| `approval` | object | Pauses workflow for human review. See [Approval Nodes](/guides/approval-nodes/) |
| `cancel` | string | Terminates the workflow run with a reason string. Uses existing cancellation plumbing — in-flight parallel nodes are stopped |

**Common fields** — apply to all node types:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | Unique node identifier. Used in `depends_on`, `when:`, and `$id.output` substitution |
| `depends_on` | string[] | `[]` | Node IDs that must complete before this node runs |
| `when` | string | — | Condition expression. Node is skipped if false. See [Condition Syntax](#when-condition-syntax) |
| `trigger_rule` | string | `all_success` | Join semantics when multiple upstreams exist |
| `context` | `'fresh'` \| `'shared'` | — | `fresh` = new session; `shared` = inherit from prior node. Defaults to `fresh` for parallel layers, inherited for sequential |
| `idle_timeout` | number | — | Kill node if idle for this many milliseconds |
| `retry` | object | — | Per-node retry configuration. See [Retry Configuration](#retry-configuration) |

**AI node options** — apply to `command` and `prompt` nodes:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | inherited | Per-node provider override (any registered provider, e.g. `'claude'`, `'codex'`) |
| `model` | string | inherited | Per-node model override |
| `output_format` | object | — | JSON Schema for structured output (Claude and Codex) |
| `allowed_tools` | string[] | — | Whitelist of built-in tools. `[]` = no tools. Claude only |
| `denied_tools` | string[] | — | Tools to remove. Applied after `allowed_tools`. Claude only |
| `hooks` | object | — | Per-node SDK hook callbacks. Claude only. See [Hooks](/guides/hooks/) |
| `mcp` | string | — | Path to MCP server config JSON file. Claude only. See [MCP Servers](/guides/mcp-servers/) |
| `skills` | string[] | — | Skills to preload. Claude only. See [Skills](/guides/skills/) |
| `effort` | `'low'`\|`'medium'`\|`'high'`\|`'max'` | — | Reasoning depth. Claude only. Also settable at workflow level |
| `thinking` | string \| object | — | Thinking mode: `'adaptive'`, `'disabled'`, or `{type:'enabled', budgetTokens:N}`. Claude only. Also settable at workflow level |
| `maxBudgetUsd` | number | — | USD cost cap; node fails if exceeded. Claude only. Per-node only |
| `systemPrompt` | string | — | Override the default `claude_code` system prompt for this node. Claude only. Per-node only |
| `fallbackModel` | string | — | Model to use if primary model fails. Claude only. Also settable at workflow level |
| `betas` | string[] | — | SDK beta feature flags (e.g., `'context-1m-2025-08-07'`). Claude only. Also settable at workflow level |
| `sandbox` | object | — | OS-level filesystem/network restrictions for the Claude subprocess. Claude only. Also settable at workflow level |

### Claude SDK Advanced Options

These fields map directly to Claude Agent SDK options. All are Claude-only — Codex nodes emit a warning and ignore them. They can be set **per-node** or at the **workflow level** as defaults (per-node takes precedence). `maxBudgetUsd` and `systemPrompt` are per-node only.

**effort** — reasoning depth:

```yaml
- id: thorough-review
  command: review
  effort: high   # 'low' | 'medium' | 'high' | 'max'
```

**thinking** — extended thinking mode (string shorthand or object form):

```yaml
- id: deep-analysis
  command: analyze
  thinking: adaptive              # 'adaptive' | 'disabled'
  # thinking: { type: enabled, budgetTokens: 8000 }  # object form
```

**maxBudgetUsd** — per-node USD cost cap (node fails with error if exceeded):

```yaml
- id: expensive-step
  command: generate
  maxBudgetUsd: 2.50
```

**systemPrompt** — override the default `claude_code` system prompt:

```yaml
- id: security-review
  prompt: "Review this code for vulnerabilities"
  systemPrompt: "You are a security expert specializing in TypeScript. Focus only on security issues."
```

**fallbackModel** — use a different model if the primary fails:

```yaml
- id: implement
  command: implement
  model: claude-opus-4-5
  fallbackModel: claude-sonnet-4-6
```

**betas** — SDK beta feature flags:

```yaml
- id: long-context-node
  command: summarize
  betas: ['context-1m-2025-08-07']
```

**sandbox** — OS-level filesystem/network restrictions (layers on top of worktree isolation):

```yaml
- id: untrusted-code-analysis
  command: analyze-external
  sandbox:
    enabled: true
    network:
      allowedDomains: []
      allowManagedDomainsOnly: true
    filesystem:
      denyWrite: ['/etc', '/usr']
```

**Workflow-level defaults** (inherited by all Claude nodes unless overridden per-node):

```yaml
name: my-workflow
effort: high         # All Claude nodes use high effort by default
thinking: adaptive   # All Claude nodes use adaptive thinking
fallbackModel: claude-haiku-4-5-20251001
betas: ['context-1m-2025-08-07']
sandbox:
  enabled: true

nodes:
  - id: step1
    command: step1
    # Inherits workflow-level effort, thinking, fallbackModel, betas, sandbox

  - id: step2
    command: step2
    effort: low      # Per-node override — ignores workflow-level effort
```

### `trigger_rule` Values

| Value | Behavior |
|-------|----------|
| `all_success` | Run only if all upstream deps completed successfully (default) |
| `one_success` | Run if at least one upstream dep completed successfully |
| `none_failed_min_one_success` | Run if no deps failed AND at least one succeeded (skipped deps are ok) |
| `all_done` | Run when all deps are in a terminal state (completed, failed, or skipped) |

### `when:` Condition Syntax

Conditions gate whether a node runs based on upstream node outputs.

**String operators** (value compared as string):
```yaml
when: "$nodeId.output == 'VALUE'"
when: "$nodeId.output != 'VALUE'"
when: "$nodeId.output.field == 'VALUE'"    # JSON dot notation for output_format nodes
```

**Numeric operators** (both sides must parse as numbers; fail-closed if not):
```yaml
when: "$nodeId.output > '80'"
when: "$nodeId.output >= '0.9'"
when: "$nodeId.output < '100'"
when: "$nodeId.output <= '5'"
when: "$nodeId.output.score >= '0.9'"      # dot notation + numeric comparison
```

**Compound expressions** (`&&` binds tighter than `||`):
```yaml
when: "$a.output == 'X' && $b.output != 'Y'"
when: "$a.output == 'X' || $b.output == 'Y'"
when: "$score.output > '80' && $flag.output == 'true'"
# Precedence: (A && B) || C
when: "$a.output == 'X' && $b.output == 'Y' || $c.output == 'Z'"
```

- `$nodeId.output` references the full output string of a completed node
- `$nodeId.output.field` accesses a JSON field (for `output_format` nodes)
- Invalid or unparseable expressions default to `false` (fail-closed — node is skipped with a warning)
- Numeric operators fail-closed if either side is not a finite number
- Parentheses are not supported — use standard AND/OR precedence to structure conditions
- Skipped nodes propagate their skipped state to dependants

### `$node_id.output` Substitution

In node prompts and commands, reference the output of any upstream node:

```yaml
nodes:
  - id: classify
    command: classify-issue

  - id: fix
    command: implement-fix
    depends_on: [classify]
    # The command file can use $classify.output or $classify.output.field
```

Variable substitution order:
1. Standard variables (`$WORKFLOW_ID`, `$USER_MESSAGE`, `$ARTIFACTS_DIR`, etc.)
2. Node output references (`$nodeId.output`, `$nodeId.output.field`)

### `output_format` for Structured JSON

Use `output_format` to enforce JSON output from an AI node. For Claude, the schema is passed via the SDK's `outputFormat` option and `structured_output` is used directly. For Codex (v0.116.0+), the schema is passed via `TurnOptions.outputSchema` and the agent's inline JSON response is used. Both ensure clean JSON for `when:` conditions and `$nodeId.output` substitution:

```yaml
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
        severity:
          type: string
          enum: [low, medium, high]
      required: [type]
```

- The output is captured as a JSON string and available via `$classify.output` (full JSON) or `$classify.output.type` (field access)
- Use `output_format` when downstream nodes need to branch on specific values via `when:`

### `allowed_tools` and `denied_tools` for Tool Restrictions

Restrict which built-in tools a node can use without relying on prompt instructions. Restrictions are enforced at the Claude SDK level.

```yaml
nodes:
  - id: review
    command: code-review
    allowed_tools: [Read, Grep, Glob]   # whitelist — only these tools available

  - id: implement
    command: implement-feature
    denied_tools: [WebSearch, WebFetch] # blacklist — remove these tools

  - id: mcp-only
    command: mcp-command
    allowed_tools: []                   # empty list = disable all built-in tools
```

- `allowed_tools: []` disables all built-in tools (useful for MCP-only nodes). Use the `mcp` field on a node to attach per-node MCP servers — see [Node Fields](#node-fields)
- If both are set, `denied_tools` is applied after `allowed_tools`
- `undefined` (field absent) and `[]` have different semantics — absent means use default tool set, `[]` means no tools
- Claude only — Codex nodes/steps emit a warning and continue (Codex doesn't support per-call tool restrictions)

---

## Retry Configuration

Every node automatically retries on **transient** errors (SDK subprocess crashes, rate limits, network timeouts) using a default configuration: **2 retries** (3 total attempts), **3 s base delay** with exponential backoff. You will see a platform notification before each retry attempt.

To customise, add a `retry:` block:

```yaml
nodes:
  - id: flaky-node
    command: flaky-command
    retry:
      max_attempts: 3       # 3 retries = 4 total attempts
      delay_ms: 5000
      on_error: transient

  - id: aggressive-retry
    prompt: "Summarise the output"
    retry:
      max_attempts: 4       # 4 retries = 5 total attempts
      on_error: all         # Retry even non-transient errors (use with caution)
```

### Retry Fields

| Field | Type | Default | Constraints | Description |
|-------|------|---------|-------------|-------------|
| `max_attempts` | number | `2` | 1–5 | Number of retry attempts (not including the initial attempt). `1` = one retry (2 total attempts) |
| `delay_ms` | number | `3000` | 1000–60000 | Base delay in ms before the first retry. Doubles each attempt (exponential backoff) |
| `on_error` | `'transient'` \| `'all'` | `'transient'` | — | Which errors trigger a retry. `'transient'` = SDK crashes, rate limits, network timeouts only. `'all'` = any error including unknown errors (FATAL errors such as auth failures are never retried regardless) |

### Error Classification

Archon classifies errors into three buckets before deciding whether to retry:

| Class | Examples | Retried by default? |
|-------|----------|---------------------|
| **FATAL** | Auth failure, permission denied, credit balance exhausted | Never (even with `on_error: all`) |
| **TRANSIENT** | Process crashed (`exited with code`), rate limit, network timeout | Yes |
| **UNKNOWN** | Unrecognised error messages | No (unless `on_error: all`) |

### Retry Notifications

Before each retry the platform receives a message like:

```
Node `node-id` failed with transient error (attempt 1/3). Retrying in 3s...
```

### Two-Layer Retry Stack

Archon uses two independent retry layers:

```
SDK subprocess retry (claude.ts)  — 3 total attempts, 2 s base backoff
    ↓ only if all SDK retries exhausted
Node retry (dag-executor)  — default 2 retries, 3 s base backoff
    ↓ only if all node retries exhausted
Workflow fails → next invocation auto-resumes completed nodes
```

This means a single transient crash may trigger up to **3 SDK retries** before a single node retry attempt is consumed.

> **DAG resume**: For `nodes:` (DAG) workflows, resume is automatic — the next invocation detects the prior failed run and skips already-completed nodes. No `--resume` flag is needed. See [DAG Resume on Failure](#dag-resume-on-failure) below.

---

## DAG Resume on Failure

When a `nodes:` (DAG) workflow fails (including due to a server restart), the next invocation automatically resumes from where it left off — no `--resume` flag required.

**How it works:**

1. On each invocation, Archon checks for a prior failed run of the same workflow at the same working path.
2. If found, it loads the `node_completed` events from that run to determine which nodes finished successfully.
3. Completed nodes are skipped; only failed and not-yet-run nodes are executed.
4. You receive a platform message like: `Resuming workflow — skipping 3 already-completed node(s).`

**Server restart**: If a server restart leaves runs in `running` status, they are automatically marked as `failed` on the next startup (with `metadata.failure_reason = 'server_restart'`). The next invocation of the same workflow at the same path auto-resumes from completed nodes.

**Known limitation**: AI session context from prior nodes is not restored. If a downstream node relies on in-context knowledge from a prior run's session (rather than artifacts), it may need to re-read those artifacts explicitly.

**Fresh start**: If zero nodes completed in the prior run, Archon starts fresh (no nodes to skip).

---

## The Artifact Chain

Workflows work because **artifacts pass data between nodes**:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Node 1          │     │ Node 2          │     │ Node 3          │
│ investigate     │     │ implement       │     │ create-pr       │
│                 │     │                 │     │                 │
│ Reads: input    │     │ Reads: artifact │     │ Reads: git diff │
│ Writes: artifact│────▶│ Writes: code    │────▶│ Writes: PR      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
  $ARTIFACTS_DIR/         src/feature.ts
  issues/issue-123.md     src/feature.test.ts
```

### Designing Artifact Flow

When creating a workflow, plan the artifact chain:

| Node | Reads | Writes |
|------|-------|--------|
| `investigate-issue` | GitHub issue via `gh` | `$ARTIFACTS_DIR/issues/issue-{n}.md` |
| `implement-issue` | Artifact from `investigate-issue` | Code files, tests |
| `create-pr` | Git diff | GitHub PR |

Each command must know:
- Where to find its input
- Where to write its output
- What format to use

---

## Model Configuration

Workflows can configure AI models and provider-specific options at the workflow level.

### Configuration Priority

Model and options are resolved in this order:

1. **Workflow-level** - Explicit settings in the workflow YAML
2. **Config defaults** - `assistants.*` in `.archon/config.yaml`
3. **SDK defaults** - Built-in defaults from Claude/Codex SDKs

### Provider and Model

```yaml
name: my-workflow
provider: claude     # Any registered provider (default: from config)
model: sonnet        # Model override (default: from config assistants.claude.model)
```

**Claude models:**
- `sonnet` - Fast, balanced (recommended)
- `opus` - Powerful, expensive
- `haiku` - Fast, lightweight
- `claude-*` - Full model IDs (e.g., `claude-3-5-sonnet-20241022`)
- `inherit` - Use model from previous session

**Codex models:**
- Any OpenAI model ID (e.g., `gpt-5.3-codex`, `o5-pro`)
- Cannot use Claude model aliases

### Codex-Specific Options

```yaml
name: my-workflow
provider: codex
model: gpt-5.3-codex
modelReasoningEffort: medium    # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
webSearchMode: live             # 'disabled' | 'cached' | 'live'
additionalDirectories:
  - /absolute/path/to/other/repo
  - /path/to/shared/library
```

**Model reasoning effort:**
- `minimal`, `low` - Fast, cheaper
- `medium` - Balanced (default)
- `high`, `xhigh` - More thorough, expensive

**Web search mode:**
- `disabled` - No web access (default)
- `cached` - Use cached search results
- `live` - Real-time web search

**Additional directories:**
- Codex can access files outside the codebase
- Useful for shared libraries, documentation repos
- Must be absolute paths

### Web Execution Mode

By default, workflows started from the **Web UI** run in the background — execution is
dispatched to an internal worker conversation and results appear only in the workflow run
log, not in the chat window.

Set `interactive: true` to run the workflow in the **foreground** (same as CLI, Slack,
Telegram, and GitHub): all AI output and approval gate messages stream directly to the
user's chat window.

```yaml
name: my-interactive-workflow
interactive: true   # Web UI: foreground execution (output visible in chat)

nodes:
  - id: plan
    prompt: "Create a plan for $USER_MESSAGE"
  - id: review-gate
    approval:
      message: "Does this plan look good?"
    depends_on: [plan]
  - id: implement
    command: implement
    depends_on: [review-gate]
```

**When to use `interactive: true`:**
- Workflows with **approval nodes** — users must see the AI output and respond inline
- Workflows with **interactive loop nodes** (`loop.interactive: true`) — the loop gate pause requires foreground execution to deliver the gate message and run ID to the user
- Multi-turn workflows where the user needs to provide feedback at each step
- Any workflow where the response must appear in the user's active chat thread

**Platforms:** `interactive` only affects the web platform. CLI, Slack, Telegram, and
GitHub always run workflows in foreground mode regardless of this setting.

### Model Validation

Workflows are validated at load time:
- Provider/model compatibility checked
- Invalid combinations fail with clear error messages
- Validation errors shown in `/workflow list`

Example validation error:
```
Model "sonnet" is not compatible with provider "codex"
```

### Resource Validation (CLI)

To validate that all referenced command files, MCP config files, and skill directories exist on disk, run:

```bash
archon validate workflows <name>
```

This checks resource resolution beyond what load-time validation covers. Use `--json` for machine-readable output. See the [CLI Reference](/reference/cli/) for details.

### Example: Config Defaults + Workflow Override

**`.archon/config.yaml`:**
```yaml
assistants:
  claude:
    model: haiku  # Fast model for most tasks
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: low
    webSearchMode: disabled
```

**Workflow with override:**
```yaml
name: complex-analysis
description: Deep code analysis requiring powerful model
provider: claude
model: opus  # Override config default (haiku) for this workflow

nodes:
  - id: analyze
    command: analyze-architecture

  - id: report
    command: generate-report
    depends_on: [analyze]
    context: fresh
```

The workflow uses `opus` instead of the config default `haiku`, but other settings inherit from config.

---

## Workflow Description Best Practices

Write descriptions that help with routing and user understanding:

```yaml
description: |
  Investigate and fix a GitHub issue end-to-end.

  **Use when**: User provides a GitHub issue number or URL
  **NOT for**: Feature requests, refactoring, documentation

  **Produces**:
  - Investigation artifact
  - Code changes
  - Pull request linked to issue

  **Steps**:
  1. Investigate root cause
  2. Implement fix with tests
  3. Create PR
```

Good descriptions include:
- What the workflow does
- When to use it (and when NOT to)
- What it produces
- High-level steps

---

## Variable Substitution

All workflows support variable substitution in prompts and commands. The most commonly used:

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` / `$USER_MESSAGE` | The user's input message that triggered the workflow |
| `$WORKFLOW_ID` | Unique ID for this workflow run |
| `$ARTIFACTS_DIR` | Pre-created artifacts directory for this workflow run |
| `$BASE_BRANCH` | Base branch (auto-detected or configured) |
| `$DOCS_DIR` | Documentation directory path (default: `docs/`) |
| `$CONTEXT` | GitHub issue/PR context (if available) |
| `$nodeId.output` | Output of a completed upstream node |
| `$nodeId.output.field` | JSON field from a structured upstream node output |

See the [Variable Reference](/reference/variables/) for the complete list, including `$LOOP_USER_INPUT`, `$REJECTION_REASON`, positional arguments, substitution order, and context variable behavior.

Example:
```yaml
prompt: |
  Workflow: $WORKFLOW_ID
  Original request: $USER_MESSAGE

  GitHub context:
  $CONTEXT

  [Instructions...]
```

---

## Example Workflows

### Quick Fix

```yaml
name: quick-fix
description: |
  Fast bug fix without full investigation.
  Use when: Simple, obvious bugs.

nodes:
  - id: fix
    command: analyze-and-fix

  - id: pr
    command: create-pr
    depends_on: [fix]
    context: fresh
```

### Investigation Pipeline

```yaml
name: fix-github-issue
description: |
  Full investigation and fix for GitHub issues.
  Use when: User provides issue number/URL

nodes:
  - id: investigate
    command: investigate-issue

  - id: implement
    command: implement-issue
    depends_on: [investigate]
    context: fresh
```

### Parallel Review

```yaml
name: comprehensive-pr-review
description: |
  Multi-agent PR review covering code, comments, tests, and security.

nodes:
  - id: scope
    command: create-review-scope

  - id: code-review
    command: code-review-agent
    depends_on: [scope]
    context: fresh

  - id: comment-review
    command: comment-quality-agent
    depends_on: [scope]
    context: fresh

  - id: test-review
    command: test-coverage-agent
    depends_on: [scope]
    context: fresh

  - id: security-review
    command: security-review-agent
    depends_on: [scope]
    context: fresh

  - id: synthesize
    command: synthesize-reviews
    depends_on: [code-review, comment-review, test-review, security-review]
    context: fresh
```

### Iterative Implementation (Loop Node)

```yaml
name: implement-prd
description: |
  Autonomously implement a PRD, iterating until all stories pass.

nodes:
  - id: implement-loop
    loop:
      prompt: |
        Read PRD from `.archon/prd.md`.
        Read progress from `.archon/progress.json`.
        Implement the next incomplete story with tests.
        Run validation: `bun run validate`.
        Update progress file.
        If ALL stories complete: <promise>COMPLETE</promise>
      until: COMPLETE
      max_iterations: 15
      fresh_context: true
```

### Classify and Route

```yaml
name: classify-and-fix
description: |
  Classify issue type and run the appropriate path.

  Use when: User reports a bug or requests a feature
  Produces: Code fix (bug path) or feature plan (feature path), then PR

nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type:
          type: string
          enum: [BUG, FEATURE]
      required: [type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.type == 'FEATURE'"

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: none_failed_min_one_success

  - id: create-pr
    command: create-pr
    depends_on: [implement]
    context: fresh
```

---

## Common Patterns

### Pattern: Gated Execution

Run different paths based on conditions:

```yaml
name: smart-fix
description: Route to appropriate fix strategy based on issue complexity

nodes:
  - id: analyze
    command: analyze-complexity
    output_format:
      type: object
      properties:
        complexity:
          type: string
          enum: [simple, complex]
      required: [complexity]

  - id: quick-fix
    command: quick-fix
    depends_on: [analyze]
    when: "$analyze.output.complexity == 'simple'"

  - id: deep-fix
    command: deep-investigation
    depends_on: [analyze]
    when: "$analyze.output.complexity == 'complex'"
```

### Pattern: Checkpoint and Resume

For long workflows, DAG resume handles this automatically — completed nodes are skipped on re-invocation:

```yaml
name: large-migration
description: Multi-file migration with automatic checkpoint recovery

nodes:
  - id: plan
    command: create-migration-plan

  - id: batch-1
    command: migrate-batch-1
    depends_on: [plan]
    context: fresh

  - id: batch-2
    command: migrate-batch-2
    depends_on: [batch-1]
    context: fresh

  - id: validate
    command: validate-migration
    depends_on: [batch-2]
    context: fresh
```

If the workflow fails at `batch-2`, the next invocation skips `plan` and `batch-1` automatically.

### Pattern: Human-in-the-Loop

Use an `approval` node to pause for human review before continuing:

```yaml
name: careful-refactor
description: Refactor with human approval gate

nodes:
  - id: propose
    command: propose-refactor

  - id: review-gate
    approval:
      message: "Review the proposed refactor before proceeding. Check the artifacts directory."
    depends_on: [propose]

  - id: execute
    command: execute-approved-refactor
    depends_on: [review-gate]

  - id: pr
    command: create-pr
    depends_on: [execute]
    context: fresh
```

When the workflow reaches `review-gate`, it pauses and notifies you. Approve or reject via:

- **Natural language** (recommended): Just type your response in the conversation — the system detects the paused workflow and auto-resumes
- **CLI**: `bun run cli workflow approve <run-id>` or `bun run cli workflow reject <run-id>`
- **Explicit command**: `/workflow approve <run-id>` or `/workflow reject <run-id>` (records approval; send a follow-up message to resume)
- **Web UI**: Click the Approve/Reject buttons on the dashboard card
- **API**: `POST /api/workflows/runs/<run-id>/approve` or `/reject`

After approval via natural language or CLI, the workflow auto-resumes from the next node. The user's approval comment is available as `$review-gate.output` in downstream nodes only when `capture_response: true` is set on the approval node.

Without `on_reject`: rejecting cancels the workflow.
With `on_reject`: rejecting triggers an AI rework prompt and re-pauses for re-review.
See [Approval Nodes](/guides/approval-nodes/) for full details.

### Pattern: Early Termination with Cancel

Use a `cancel:` node to stop a workflow when a precondition fails — preventing wasted compute on downstream branches:

```yaml
nodes:
  - id: check
    bash: "git merge-base --is-ancestor HEAD origin/main && echo ok || echo blocked"

  - id: stop-if-blocked
    cancel: "PR has merge conflicts — cannot proceed with review"
    depends_on: [check]
    when: "$check.output == 'blocked'"

  - id: review
    prompt: "Review the PR..."
    depends_on: [check]
    when: "$check.output == 'ok'"
```

When a `cancel:` node executes (passes its `when:` gate), it sets the workflow run to `cancelled` with the reason string and stops all in-flight nodes. Unlike node failure, cancellation is intentional — the status is `cancelled`, not `failed`.

### Choosing: Interactive Loop vs Approval with on_reject

Two primitives handle human-in-the-loop iteration. Use the right one for your pattern:

| | Interactive Loop | Approval + on_reject |
|---|---|---|
| YAML | `loop.interactive: true` | `approval.on_reject: { prompt }` |
| User input variable | `$LOOP_USER_INPUT` | `$REJECTION_REASON` |
| How it works | Same prompt runs each iteration, user input injected as variable | Specific on_reject prompt runs only on rejection |
| Best for | **Conversational iteration** — explore, refine, review cycles where the AI and human go back and forth | **Gate-then-fix** — approve to proceed, or reject to trigger a specific corrective action |
| Approval signal | AI detects user intent in its output (`<promise>DONE</promise>`) | User explicitly approves or rejects via button/command |
| Example | PIV loop: explore → user feedback → explore again | Report generation: generate → user rejects → AI revises specific section |

**Interactive loop** (`loop.interactive: true`):

```yaml
- id: refine-plan
  loop:
    prompt: |
      User's feedback: $LOOP_USER_INPUT
      Read the plan, apply feedback, present changes.
    until: PLAN_APPROVED
    max_iterations: 10
    interactive: true
    gate_message: "Review the plan. Provide feedback or say 'approved'."
```

The AI runs each iteration, pauses for user input, user's text feeds into the next iteration via `$LOOP_USER_INPUT`. The AI decides when to emit the completion signal based on the user's response.

**Approval with on_reject** (`approval.on_reject`):

```yaml
- id: review
  approval:
    message: "Review the report. Approve or request changes."
    capture_response: true
    on_reject: { prompt: "Revise based on: $REJECTION_REASON", max_attempts: 5 }
  depends_on: [generate]
```

The workflow pauses at the approval gate. User approves -> workflow continues. User rejects with feedback -> the `on_reject` prompt runs with `$REJECTION_REASON`, then re-pauses at the same gate.

**Rule of thumb**: If the human and AI are having a conversation (exploring, refining, iterating), use an interactive loop. If the workflow should proceed unless the human objects, use an approval gate with `on_reject`.

---

## Debugging Workflows

### Check Workflow Discovery

```bash
bun run cli workflow list
```

### Run with Verbose Output

```bash
bun run cli workflow run {name} "test input"
```

Watch the streaming output to see each step.

### Check Artifacts

After a workflow runs, check the artifacts in the `$ARTIFACTS_DIR` for that run (located at `~/.archon/workspaces/owner/repo/artifacts/runs/{workflow-id}/`).

### Check Logs

Workflow execution logs to:
```
~/.archon/workspaces/owner/repo/logs/{workflow-id}.jsonl
```

Each line is a JSON event (step start, AI response, tool call, etc.).

---

## Workflow Validation

Before deploying a workflow:

1. **Test each command individually**
   ```bash
   bun run cli workflow run {workflow} "test input"
   ```

2. **Verify artifact flow**
   - Does the first node produce what the second expects?
   - Are paths correct?
   - Is the format complete?

3. **Test edge cases**
   - What if the input is invalid?
   - What if a node fails?
   - What if an artifact is missing?

4. **Check iteration limits** (for loops)
   - Is `max_iterations` reasonable?
   - What happens when limit is hit?

---

## Summary

1. **Workflows orchestrate commands** — YAML files defining a DAG of execution nodes
2. **`nodes:` define the graph** — each node runs a command, inline prompt, bash script, or loop
3. **Artifacts are the glue** — commands communicate via files, not in-memory context
4. **`context: fresh`** — forces a fresh AI session for a node (works from artifacts only)
5. **Parallel by default** — nodes in the same topological layer run concurrently
6. **Conditional branching** — `when:` conditions and `trigger_rule` control which nodes run
7. **`output_format`** — enforce structured JSON output from AI nodes for reliable branching
8. **`allowed_tools` / `denied_tools`** — restrict tools per node (Claude only, SDK-enforced)
9. **`retry:`** — auto-retries transient errors (default: 2 retries / 3 total attempts, 3 s backoff); customize per node
10. **`hooks`** — attach SDK hook callbacks to Claude nodes for tool control and context injection
11. **`mcp:`** — attach per-node MCP servers via JSON config (Claude only)
12. **`skills:`** — preload skills into Claude nodes for domain expertise
13. **`effort` / `thinking`** — control reasoning depth and thinking mode per node or workflow (Claude only)
14. **`maxBudgetUsd`** — set a USD cost cap per node; fails with error if exceeded (Claude only)
15. **`systemPrompt`** — override the default system prompt per node (Claude only)
16. **`sandbox`** — OS-level filesystem/network restrictions per node or workflow (Claude only)
17. **Loop nodes** — use `loop:` within a DAG node for iterative execution until completion signal
18. **Defaults as templates** — browse `.archon/workflows/defaults/` for real examples to copy and modify
19. **Test thoroughly** — each command, the artifact flow, and edge cases
