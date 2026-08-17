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

> **Using defaults as templates:** Archon ships default workflows in `.archon/workflows/defaults/` (21 bundled into the binary; source builds also load them from disk). Browse them for real-world examples, then copy and modify:
> ```bash
> cp .archon/workflows/defaults/archon-fix-github-issue.yaml .archon/workflows/my-fix-issue.yaml
> ```
> Same-named files in `.archon/workflows/` override the bundled defaults.

> **Legacy bundled defaults:** The flat `.archon/workflows/defaults/` and `.archon/commands/defaults/` directories contain Archon's existing bundled files. `defaults` is not a reserved pack name in the packaged layout below; authors may choose any safe pack and workflow directory names.

---

## File Location

Workflows live in `.archon/workflows/` relative to the working directory:

```
.archon/
├── workflows/
│   └── my-pack/                 # Author-chosen pack name
│       └── release/             # Author-chosen workflow folder
│           ├── release.yaml
│           ├── commands/
│           │   └── prepare.md
│           └── scripts/
│               └── publish.ts
```

The two directories form a fixed package boundary: `.archon/workflows/<pack>/<workflow>/`. A packaged workflow contains exactly one YAML definition; bare `command:` and named `script:` references resolve only from its own `commands/` and `scripts/` directories, with no shared or cross-scope fallback. Included workflows retain their own resource folder, so two workflows may reuse names such as `review.md` without collisions.

The same tree works under `~/.archon/workflows/` for home-scoped workflows. Existing flat `.archon/workflows/foo.yaml`, one-level grouped YAML, shared `.archon/commands/`, and shared `.archon/scripts/` remain supported for compatibility.

> **Global workflows:** For workflows that apply to every project, place them in `~/.archon/workflows/`. Global workflows are overridden by same-named repo workflows. See [Global Workflows](/guides/global-workflows/).

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
modelReasoningEffort: medium     # Codex only, workflow level only (no per-node form)
webSearchMode: live              # Codex only, workflow level only (no per-node form)
interactive: true                # Web only: run in foreground instead of background
requires: [github]               # Optional: hard-block invocation unless the triggering
                                 #   user has connected their GitHub identity. Enforced only
                                 #   when per-user GitHub is enabled (App mode + TOKEN_ENCRYPTION_KEY);
                                 #   a no-op for solo PAT / bot-only installs. The block fires
                                 #   BEFORE any worktree/clone/AI cost. Currently the only
                                 #   supported value is `github`; unknown values are rejected
                                 #   at load time.
worktree:                        # Optional: pin isolation behavior regardless of caller
  enabled: false                 #   false = always run in the live checkout (CLI --no-worktree
                                 #           and web both honor it). Use for read-only workflows
                                 #           like triage/reporting. true = must use a worktree;
                                 #           CLI --no-worktree hard-errors. Omit to let the
                                 #           caller decide (current default = worktree).
mutates_checkout: false          # Optional: assert this workflow does not write to its checkout,
                                 #   so the engine skips the path-exclusive lock and N runs of it
                                 #   can share one working directory. Defaults to true (take the
                                 #   lock, serialize runs on the same path). See
                                 #   [Running sub-runs side by side](#running-sub-runs-side-by-side).
tags: [GitLab, Review]           # Optional: explicit Web UI filter tags. Overrides the
                                 #   keyword-based tag inference. An empty list (`tags: []`)
                                 #   suppresses inference and shows no tags. Omit to fall
                                 #   back to inferred tags (the default).
inputs:                          # Optional: declared signature — what this block takes.
  diff: { required: true }       #   A caller supplies values via `with:`; the block reads
  style: { default: strict }     #   them as `$INPUTS.<name>`. See "Workflow Signature".
returns: synthesize              # Optional: the node id whose output IS this block's result.

# Required for DAG-based
nodes:
  - id: classify                 # Unique node ID (used for dependency refs and $id.output)
    command: classify-issue      # Package-local in packaged workflows; shared lookup otherwise
    output_format:               # Optional: structured JSON output. SDK-enforced on Claude/Codex/OpenCode; best-effort (prompt + JSON extraction + repair) on Pi/Copilot. Parsed output is validated against the schema; a node that declares output_format but returns no schema-valid output FAILS.
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
    # mcp: .archon/mcp/servers.json  # Optional: per-node MCP servers (Claude/Codex/Copilot; Codex is additive)
    # skills: [remotion-best-practices]  # Optional: per-node skills (Claude/Pi/Copilot); Codex uses explicit $skill-name
```

### Node Fields

**Node types** — exactly one required per node (mutually exclusive):

| Field | Type | Description |
|-------|------|-------------|
| `command` | string | Command name. Packaged workflows resolve it only from their own `commands/`; legacy workflows use shared repo → home → bundled lookup. |
| `prompt` | string | Inline prompt string |
| `bash` | string | Shell script (no AI). Stdout captured as `$nodeId.output`; successful stdout is also stored in `node_completed.data.node_output` as an audit preview capped at 32 KiB (UTF-8 bytes). Optional `timeout` (ms, default 120000) |
| `script` | string | TypeScript/JavaScript (via `bun`) or Python (via `uv`) — inline code or named reference. Packaged workflows resolve named scripts only from their own `scripts/`; legacy workflows use shared script directories. Stdout captured as `$nodeId.output`. Requires `runtime: bun` or `runtime: uv`. Optional `deps` (uv only) and `timeout` (ms, default 120000). See [Script Nodes](/guides/script-nodes/) |
| `loop` | object | Iterative AI prompt until completion signal. See [Loop Nodes](/guides/loop-nodes/) |
| `loop_group` | object | Multi-node sub-DAG body repeated per iteration until a completion signal. See [Cross-Node Loops](/guides/loop-nodes/#cross-node-loops-with-loop_group) |
| `approval` | object | Pauses workflow for human review. See [Approval Nodes](/guides/approval-nodes/) |
| `cancel` | string | Terminates the workflow run with a reason string. Uses existing cancellation plumbing — in-flight parallel nodes are stopped |
| `include` | string | Name of another workflow whose nodes are inlined into this DAG at load time as a namespaced sub-DAG. See [Reusing a Shared Sub-DAG](#reusing-a-shared-sub-dag-with-include) |
| `workflow` | string | Name of another workflow to run as a governed **child sub-run** at execution time — its own run record, gates, artifacts, and cost. Optional `input` (untyped data string → child's `$ARGUMENTS`) **or** `with:` (named inputs → child's `$INPUTS.<name>`; mutually exclusive with `input`), `isolation` (`'inherit'` \| `'worktree'`), and `fan_out` (one child per item of a runtime list; optional `as:` names the per-item `$INPUTS` channel). See [Composing a Governed Sub-Run](#composing-a-governed-sub-run-with-workflow) and [Workflow Signature](#workflow-signature-inputs-returns-and-inputs) |

**Common fields** — apply to all node types:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | Unique node identifier. Used in `depends_on`, `when:`, and `$id.output` substitution |
| `depends_on` | string[] | `[]` | Node IDs that must complete before this node runs |
| `when` | string | — | Condition expression. Node is skipped if false. See [Condition Syntax](#when-condition-syntax) |
| `trigger_rule` | string | `all_success` | Join semantics when multiple upstreams exist. Distinct from a fan-out node's [`fan_out.join`](#the-four-fields), which reduces one node's N children and defaults to `all_done` |
| `context` | `'fresh'` \| `'shared'` | — | `fresh` = new session; `shared` = inherit from prior node. Defaults to `fresh` for parallel layers, inherited for sequential |
| `idle_timeout` | number | — | Kill node if idle for this many milliseconds |
| `retry` | object | — | Per-node retry configuration. See [Retry Configuration](#retry-configuration) |
| `always_run` | boolean | `false` | Opt out of resume caching: re-run this node on resume even if a prior run completed it. See [Opting Out of Resume Caching](#opting-out-of-resume-caching) |
| `output_type` | string | — | Semantic label for this node's output (e.g. `'plan'`, `'findings'`, `'code'`). When set, the executor writes `$ARTIFACTS_DIR/nodes/<id>.md` + `<id>.meta.json` after the node completes (best-effort) so later nodes and runs can locate output by type instead of guessing filenames. See [The Artifact Chain](#the-artifact-chain) |

**AI node options** — apply to `command` and `prompt` nodes:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | inherited | Per-node provider override (any registered provider, e.g. `'claude'`, `'codex'`) |
| `model` | string | inherited | Per-node model override |
| `output_format` | object | — | JSON Schema for structured output. SDK-enforced on Claude/Codex/OpenCode; best-effort on Pi/Copilot (schema appended to prompt, JSON extracted + repaired). The parsed output is validated against the schema (every provider); a node that declares `output_format` but returns no schema-valid output **fails** rather than degrading silently. |
| `allowed_tools` | string[] | — | Whitelist of built-in tools. `[]` = no tools. All providers except Codex |
| `denied_tools` | string[] | — | Tools to remove. Applied after `allowed_tools`. All providers except Codex |
| `hooks` | object | — | Per-node SDK hook callbacks. Claude only. See [Hooks](/guides/hooks/) |
| `mcp` | string | — | Path to MCP server config JSON file. Claude/Codex/Copilot; Codex adds servers to ambient config rather than replacing it. See [MCP Servers](/guides/mcp-servers/) |
| `skills` | string[] | — | Exact Claude-native skill selection (omission/`[]` selects none); skill declarations for Pi/Copilot. Codex workflow commands/prompts invoke installed skills explicitly with `$skill-name`; OpenCode does not implement this field. See [Skills](/guides/skills/) |
| `agents` | object | — | Inline sub-agent definitions keyed by kebab-case ID. Claude only. See [Inline sub-agents](#inline-sub-agents) |
| `effort` | `'low'`\|`'medium'`\|`'high'`\|`'max'` | — | Reasoning depth. Claude/Pi/Copilot. Also settable at workflow level |
| `thinking` | string \| object | — | Thinking mode: `'adaptive'`, `'disabled'`, or `{type:'enabled', budgetTokens:N}`. Claude/Pi/Copilot. Also settable at workflow level |
| `maxBudgetUsd` | number | — | USD cost cap; node fails if exceeded. Claude only. Per-node only |
| `systemPrompt` | string | — | Override the default `claude_code` system prompt for this node. Claude only. Per-node only |
| `fallbackModel` | string | — | Model to use if primary model fails. Claude only. Also settable at workflow level |
| `betas` | string[] | — | SDK beta feature flags (e.g., `'context-1m-2025-08-07'`). Claude only. Also settable at workflow level |
| `sandbox` | object | — | OS-level filesystem/network restrictions for the Claude subprocess. Claude only. Also settable at workflow level |
| `settingSources` | (`'project'`\|`'user'`)[] | inherited | Which filesystem setting sources Claude discovers (CLAUDE.md, skills, commands, agents). Workflow `skills:` remains the exact active skill set. Overrides the assistant-level default; unset everywhere = `['project', 'user']`. `[]` loads none. Claude only. Per-node only |

### Claude SDK Advanced Options

These fields map directly to Claude Agent SDK options. `maxBudgetUsd`, `systemPrompt`, `fallbackModel`, `betas`, `sandbox`, and `settingSources` are Claude-only — Codex and other providers emit a warning and ignore them. `effort` and `thinking` also apply to Pi and Copilot, which map them to their own reasoning controls (Codex uses `modelReasoningEffort` instead; OpenCode configures reasoning via `opencode.json`). They can be set **per-node** or at the **workflow level** as defaults (per-node takes precedence). `maxBudgetUsd`, `systemPrompt`, and `settingSources` are per-node only (`settingSources` also has an assistant-level default in `.archon/config.yaml`).

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

**settingSources** — control which filesystem setting sources the Claude SDK discovers (project `CLAUDE.md`/`.claude/` skills, commands, agents vs the user-level `~/.claude/`). For workflow skills, this controls eligibility rather than activation: `skills:` selects the exact active set, and a declaration must exist under an enabled source. Loading fewer sources gives a leaner context and a faster node start — a lean reviewer node can skip project context entirely while a writer node in the same workflow keeps it:

```yaml
- id: lean-review
  command: review
  settingSources: []              # no setting sources; skills must be omitted or []

- id: implement
  command: implement
  settingSources: ['project']     # project sources only, skip ~/.claude/
```

Omitting the field inherits the assistant-level `assistants.claude.settingSources` from `.archon/config.yaml`; if that is also unset, the default is `['project', 'user']`.

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

:::note[`trigger_rule` is not `fan_out.join`]
They share value names and have **different defaults**, so it is worth keeping straight:

- **`trigger_rule`** (any node) decides whether *this* node runs, given the states of the
  nodes it `depends_on`. Default `all_success` — don't run if an upstream failed.
- **[`fan_out.join`](#the-four-fields)** (fan-out nodes only) reduces the outcomes of one
  node's N children into that node's single outcome. Default `all_done` — children are
  independent, so one failing still yields the others.

Upstream dependencies are steps you chose to sequence; fan-out children are N instances of
one step. Hence the different defaults.
:::

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

**Declared inputs** (see [Workflow Signature](#workflow-signature-inputs-returns-and-inputs)):
```yaml
when: "$INPUTS.mode == 'fast'"              # branch on a caller's `with:` value
when: "$INPUTS.mode == 'fast' && $check.output.ok == 'true'"
```

- `$nodeId.output` references the full output string of a completed node
- `$nodeId.output.field` accesses a JSON field (for `output_format` nodes)
- `$INPUTS.<name>` references a declared input supplied by a caller's `with:` (or a direct
  run's `--input`). A name this run does not carry **fails the node** — it never quietly
  becomes an empty string. `$INPUTS` is a reserved scope, so it can never name a node.
- Invalid or unparseable expressions default to `false` (fail-closed — node is skipped with a warning)
- Numeric operators fail-closed if either side is not a finite number
- Parentheses are not supported — use standard AND/OR precedence to structure conditions
- Skipped nodes propagate their skipped state to dependants

:::danger[You cannot compare a whole AI output to a literal]
A `when:` that compares the **entire output** of a `prompt:` or `command:` node with no
`output_format` — or of any `loop:`/`loop_group:` node — against a literal is
**rejected at load time**:

```yaml
# REJECTED — $analyze is an AI node with no output_format
- id: analyze
  prompt: "Is this a bug or a feature?"
- id: decide
  depends_on: [analyze]
  when: "$analyze.output == 'BUG'"
```

The model writes `This is a BUG.` and the byte-for-byte comparison is false, so the node
is skipped with no error and the run finishes looking successful having quietly done less
than you asked. Declare the shape you are branching on instead:

```yaml
- id: analyze
  prompt: "Is this a bug or a feature?"
  output_format:
    type: object
    properties:
      status: { type: string, enum: [BUG, FEATURE] }
    required: [status]
- id: decide
  depends_on: [analyze]
  when: "$analyze.output.status == 'BUG'"
```

Unaffected, because their output is author-controlled and exact by construction:
`bash:` and `script:` producers keep whole-output comparison (`when: "$check.output ==
'true'"`), as do `approval:` captures and `workflow:` sub-run results. A field access
(`$analyze.output.status`) is always allowed.

**`loop:` and `loop_group:` have no opt-out.** `output_format` is an *ignored* field on
them (the loader already warns), so declaring one would silence the error without
producing any structure. Compute the decision in a `bash:`/`script:` node — or an
`until_bash` check — and gate on that node's output instead.
:::

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

:::caution[Double-quoting `$node.output` in `bash:` nodes is a silent footgun]
In `bash:` nodes, `$nodeId.output` and `$nodeId.output.field` are injected pre-quoted by Archon. For small outputs, values are **single-quoted inline** — the quoting is already provided by the substitution. For outputs exceeding 32 KB, Archon spills to a temp file and substitutes `$(cat '/tmp/path')` instead. Wrapping the substitution in double quotes breaks the **small (inline) case**: `var="$n.output"` becomes `var="'value'"`, embedding the literal single-quotes as part of the value. (For the large `$(cat ...)` case, double-quoting is harmless — `var="$(cat ...)"` is correct bash — but you can't know the output's size at author time, so the rule is unconditional: never double-quote.)

```bash
# WRONG — produces status="'ok'" (single quotes become part of the value)
status="$emit.output.status"
[ "$status" = "ok" ]   # → always false

# CORRECT — leave unquoted; bash assigns: status=ok
status=$emit.output.status
[ "$status" = "ok" ]   # → true
```

**Rule:** use `var=$node.output.field`, never `var="$node.output.field"`. This applies whether the output is small (single-quoted inline) or large (`$(cat ...)`). Numeric and boolean fields are injected raw (without quotes), so double-quoting accidentally "works" for them — making the bug intermittent and hard to spot.
:::

### `output_format` for Structured JSON

Use `output_format` to enforce JSON output from an AI node. For Claude, the schema is passed via the SDK's `outputFormat` option and `structured_output` is used directly. For Codex (v0.116.0+), the schema is passed via `TurnOptions.outputSchema` and the agent's inline JSON response is used. Both ensure clean JSON for `when:` conditions and `$nodeId.output` substitution:

> **Codex strict-mode normalization.** OpenAI's Structured Outputs validator rejects any object schema that doesn't set `additionalProperties: false`. Archon normalizes Codex schemas before sending them, injecting `additionalProperties: false` on every object node automatically — so write portable schemas and you won't notice. One caveat: an open-record `additionalProperties: { type: 'string' }` (or `additionalProperties: true`) is **replaced** with `false`, closing the object. OpenAI would reject the open form regardless, but the rewrite is logged (`codex.output_format_open_record_closed`) so it isn't silent. Open-record maps aren't supported for Codex structured output.

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
- **Validated + reask + fail-fast.** The parsed output is validated against your schema for *every* provider (a net for refusals / `max_tokens` truncation that bypass even SDK enforcement). On a miss, best-effort providers (Pi/Copilot) re-ask up to 3× with the schema errors appended; enforced providers fail immediately. A node that declares `output_format` but still has no schema-valid output **fails** — it no longer completes-with-prose and silently feeds `''` downstream.
- **Field access is strict.** `$classify.output.type` resolves only when `type` is in the schema. A reference to a field **not declared** in the schema fails the consuming node (a typo no longer silently becomes `''`); a field you declared **optional** but the model omitted resolves to `''`. For schemaless `bash`/`script` nodes, a `.field` ref requires the output to be JSON containing that key — otherwise the consuming node fails, so always emit every key you reference (or use whole-text `$node.output`).

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
- Supported on all providers except Codex — Codex nodes/steps emit a warning and continue (Codex doesn't support per-call tool restrictions)

### Inline sub-agents

Define Claude sub-agents directly in the workflow YAML, without authoring `.claude/agents/*.md` files. The main agent can spawn them in parallel via the `Task` tool — useful for map-reduce patterns where a cheap model (e.g. Haiku) briefs items and a stronger model reduces.

```yaml
nodes:
  - id: triage
    prompt: |
      Fetch open issues via `gh issue list ...`. For each issue, spawn the
      brief-gen sub-agent in parallel (one message, multiple Task tool calls)
      to produce a 2-3 sentence brief. Then cluster briefs for duplicates.
    model: sonnet
    allowed_tools: [Bash, Read, Write, Task]
    agents:
      brief-gen:
        description: Summarises a single GitHub issue in 2-3 sentences
        prompt: |
          You are concise. Read the issue provided in the caller's prompt.
          Return JSON { summary, primarySymptom, affectedArea }.
        model: haiku
        tools: [Bash, Read]
```

Keys:

- Agent IDs must be **kebab-case** (`^[a-z0-9]+(-[a-z0-9]+)*$`)
- Each definition requires `description` and `prompt`; `model`, `tools`, `disallowedTools`, `skills`, and `maxTurns` are optional
- Map is merged with any SDK-level agents and composes independently with native Claude `skills:` selection
- Claude only. Codex and community providers that don't support inline agents emit a warning and ignore the field

**When to use `agents:` vs `.claude/agents/*.md` files:**

- **`agents:` (inline)** — use when the sub-agent is specific to ONE workflow's needs. Keeps the workflow self-contained in a single YAML file; travels cleanly in PRs and forks.
- **`.claude/agents/*.md` (on-disk)** — use when the sub-agent is shared across multiple workflows OR the whole project (for example, a `triage-agent` used by several maintenance workflows). On-disk agents live outside workflow YAMLs and are picked up automatically by the Claude Agent SDK.

Both sources coexist — inline agents and on-disk agents are both available to `Task(subagent_type=...)` at runtime.

---

## Retry Configuration

**AI nodes** (`command:`, `prompt:`) automatically retry on **transient** errors (SDK subprocess crashes, rate limits, network timeouts) using a default configuration: **2 retries** (3 total attempts), **3 s base delay** with exponential backoff. You will see a platform notification before each retry attempt.

**Deterministic nodes** (`bash:`, `script:`) do **not** auto-retry — they run exactly once unless you add an explicit `retry:` block. This keeps side-effectful scripts (deploys, `gh` mutations, external CLIs) from being silently re-run on a transient-looking failure; opt in per node when re-running is safe. `loop:` and `loop_group:` manage their own iteration and don't accept `retry:`.

To enable or customise retry, add a `retry:` block:

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

  - id: deploy               # bash/script only retry when retry: is set
    bash: "./deploy.sh"
    retry:
      max_attempts: 3
      delay_ms: 5000
      on_error: all
```

### Retry Fields

`retry:` is required to enable retry on `bash:`/`script:` nodes; on `command:`/`prompt:` nodes it customises the defaults below.

| Field | Type | Default (AI nodes) | Constraints | Description |
|-------|------|--------------------|-------------|-------------|
| `max_attempts` | number | `2` | 1–5 | Number of retry attempts (not including the initial attempt). `1` = one retry (2 total attempts). No default on `bash:`/`script:` — omitting `retry:` means a single attempt |
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
Node retry (dag-executor)  — AI nodes: default 2 retries, 3 s base backoff;
                             bash/script: only when retry: is set
    ↓ only if all node retries exhausted
Workflow fails → user opts in to resume on next invocation
```

This means a single transient crash may trigger up to **3 SDK retries** before a single node retry attempt is consumed. The SDK layer only applies to AI nodes; `bash:`/`script:` nodes have no SDK layer, so their `retry:` block wraps the raw subprocess directly.

> **DAG resume**: For `nodes:` (DAG) workflows, resume is opt-in — pass `--resume` to `archon workflow run`, run `archon workflow resume <id>`, or use the web UI resume button. Plain `archon workflow run <name>` always starts a fresh run. See [DAG Resume on Failure](#dag-resume-on-failure) below.

---

## DAG Resume on Failure

When a `nodes:` (DAG) workflow fails, the prior run stays in the database as a candidate for resume. Resume is **explicit**: you opt in by flag or button.

**How to resume:**

- **CLI**: `archon workflow run <name> --resume` resumes the most recent failed run for `(workflow_name, cwd)`. Or `archon workflow resume <run-id>` to target a specific run.
- **Chat**: Approving or rejecting a _paused_ workflow auto-resumes from where it left off (the platform already knows the run id). For a prior **failed** (or stale `running`) run, `/workflow run <name>` does **not** silently resume — it shows a prompt offering three choices: resume it, abandon it and run fresh, or start fresh anyway. Pass `--force` to skip the prompt: `/workflow run <name> --force <args>` always starts a fresh run.
- **Web UI**: Resume button on the workflow card.

**What happens on resume:**

1. The CLI / orchestrator looks up the resumable run, loads its `node_completed` events to determine which nodes finished successfully, and transitions the row back to `running`.
2. Completed nodes are skipped; only failed and not-yet-run nodes are executed.
3. You receive a platform message like: `Resuming workflow — skipping 3 already-completed node(s).`

> **Why opt-in?** Earlier versions silently auto-resumed on plain `archon workflow run`, which caused state from prior failed runs (e.g. cached node outputs with stale inputs) to bleed into new invocations of the same workflow at the same path. See #1392 for the bug; now resume is always a user-driven decision.

**Crashed servers / orphaned runs**: Archon does **not** auto-fail `running` rows on server startup — that would kill workflows actively executing in another process (CLI, adapter). If a server crash leaves a row stuck as `running`, it remains visible in the dashboard (the Dashboard nav tab shows a count of running workflows). Transition it to a terminal status explicitly:

- **Web UI**: click the Abandon or Cancel button on the workflow card. Abandon marks the run `cancelled` and keeps completed-node history. Cancel also terminates any in-flight subprocess.
- **CLI**: `archon workflow abandon <run-id>` (equivalent to the dashboard Abandon button). Run IDs are listed by `archon workflow status`.

Once the row reaches a terminal status, you can resume it explicitly via the paths above. Plain `archon workflow run` never resumes implicitly.

> Not to be confused with `archon workflow cleanup [days]`, which **deletes** old terminal runs (`completed`/`failed`/`cancelled`) from the database for disk hygiene. It does not transition `running` rows.

**Known limitation**: AI session context from prior nodes is not restored. If a downstream node relies on in-context knowledge from a prior run's session (rather than artifacts), it may need to re-read those artifacts explicitly.

**Fresh start**: If zero nodes completed in the prior run, Archon starts fresh (no nodes to skip).

### Opting Out of Resume Caching

By default, resume skips any node that completed successfully in the prior run and feeds its cached output to downstream consumers. That's the right behavior when a node's exit code captures the validity of its output (e.g. AI prompts, scripts that produce structured stdout).

It's the wrong behavior when a node's success status doesn't capture output validity — typically a producer whose exit code reports the side effect (a file written, a service called) but whose downstream consumer parses the side effect's contents on every run. If the producer succeeded but wrote garbage, resume will replay the cached "success" forever without ever re-executing the producer.

Set `always_run: true` on the node to force re-execution on resume, even when the prior run marked it completed:

```yaml
nodes:
  - id: fetch-data
    bash: ./scripts/download.sh > $ARTIFACTS_DIR/data.json
    always_run: true        # Re-fetch on resume; download.sh exit code doesn't validate the JSON

  - id: process-data
    prompt: "Summarize $ARTIFACTS_DIR/data.json"
    depends_on: [fetch-data]
```

On resume, `fetch-data` re-runs regardless of prior success, so `process-data` reads a freshly produced file. Normal cached nodes in the same run are still skipped — `always_run` is per-node.

---

## Persistent Sessions Across Re-Runs

Different from resume: when you invoke the same workflow *again* with a follow-up prompt, every AI node normally starts fresh and pays to re-establish context. Set `persist_session: true` on a node to make its provider session ID stick across runs, so subsequent invocations continue the prior conversation for that role.

```yaml
name: feature-dev
description: plan → implement → review with cross-run memory
provider: claude
nodes:
  - id: planner
    prompt: "Plan the implementation for: $ARGUMENTS"
    persist_session: true

  - id: implementer
    depends_on: [planner]
    prompt: "Implement: $planner.output"
    persist_session: true

  - id: reviewer
    depends_on: [implementer]
    prompt: "Review the implementation against the plan."
    persist_session: true
```

Run it once with `"add OAuth login"`, again with `"now add MFA"` — each role continues its prior conversation. The reviewer remembers what it already flagged; the planner remembers it chose Google OAuth.

### Scope

Sessions are keyed by `(workflow_name, node_id, scope_key, provider)`. The default scope is the current conversation's UUID — so each chat thread has its own per-node memory.

Chat and REST reuse a stable conversation across turns, so resume works automatically. The **CLI is different**: each `archon workflow run` mints a fresh conversation UUID, so persisted sessions won't resume between separate invocations unless you pass the same `--conversation-id <id>` on each run.

### Workflow-level default

```yaml
persist_sessions: true   # All AI nodes default to persist_session: true
nodes:
  - id: validator
    persist_session: false   # Opt this node back out
```

### Capability requirement

The resolved provider must declare `sessionResume: true` in its capabilities. The loader rejects workflows that set `persist_session: true` against a non-resume-capable provider at the explicit-provider level; the executor catches the implicit-default-provider case at runtime.

### Supported node types

`persist_session` applies to `command:` and `prompt:` nodes only. Other node types skip it:

- **`bash:` / `script:`** — never invoke a provider, so the field is meaningless. Setting it produces a warning at load time and is ignored.
- **`approval:` / `cancel:`** — same: no AI call, no session to persist.
- **`loop:` / `loop_group:`** — have their own per-iteration session threading. Cross-run persistence isn't wired for them in this release; the field is warn-and-dropped on loop and loop_group nodes. Use a `prompt:` node if you need cross-run memory.

When a workflow-level `persist_sessions: true` is combined with any of these node types, the capability check and persistence logic both skip the non-applicable nodes — no false validation errors, no silent runtime mistakes.

### `context: fresh` overrides

A node with `context: fresh` skips persistence (and in-run threading). The explicit "always fresh" intent wins over `persist_session`.

### Clearing memory

| Surface | Command |
| --- | --- |
| Chat | `/workflow reset-sessions <workflow-name> [<node-id>]` (scoped to current conversation) |
| CLI | `archon workflow reset-sessions <workflow-name> [--scope <key>] [--node <id>] [--yes]` |
| REST | `DELETE /api/workflows/{name}/node-sessions?scope=<key>&node=<id>` |

Cross-scope resets are guarded so a dropped scope can't silently wipe every conversation's memory: the CLI requires `--yes` when `--scope` is omitted, and REST requires `?confirm=all-scopes`. Chat always scopes automatically to the current conversation.

### Cost caveat

Persistent sessions on Codex/Pi replay the full rollout on each turn, so token cost grows with iteration depth. Claude auto-compacts. If a workflow's persistent sessions get expensive, reset them and start fresh.

### When a resume can't be restored

If the stored session is gone (Codex thread expired, Pi JSONL missing or moved, OpenCode session not found), the provider can't resume it. Rather than silently pretending nothing was lost, the provider starts a **fresh** session for that node and the executor surfaces a visible warning:

> ⚠️ Node `planner`: could not resume the prior session — continued with a fresh session, so the earlier context was not restored.

The node still completes on that fresh session, and its new session id is persisted so the *next* run continues from it. The node is **not** re-run — the fresh session is already a clean start, so re-running would only repeat it. Expect this only for `persist_session` nodes whose prior session became unavailable; warm resumes and first-time runs are unaffected.

#### By-reference recovery via scope artifacts

A lost session doesn't have to mean lost context. Workflows that use `persist_session` also get a **stable cross-invocation artifact scope** at `scopes/<workflow>/<scope>/` (a sibling of the per-run `runs/<id>/` directory, under the same artifacts root; the scope is the conversation UUID — the same key sessions use). Whenever a persistence-participating node also declares an `output_type`, the engine mirrors its typed output sidecar (`nodes/<id>.md` + `nodes/<id>.meta.json`) into that scope directory in addition to the run directory.

On a cold resume, the warning then goes further: if the scope directory holds typed artifacts from an *earlier* invocation, the message lists them **by reference** (file paths — never pasted content), so the recovered context can be read on demand:

> Artifacts from the previous invocation are available for recovery (read on demand):
> - plan: `~/.archon/workspaces/acme/widget/artifacts/scopes/feature-dev/<conversation>/nodes/planner.md`

To opt in to recovery, give your `persist_session` nodes an `output_type`:

```yaml
nodes:
  - id: planner
    prompt: "Plan the implementation for: $ARGUMENTS"
    persist_session: true
    output_type: plan   # mirrored to the durable scope → recoverable after a cold resume
```

Notes:

- **Opt-in only.** Workflows without `persist_session` get no scope directory, no mirroring, and no pointer — default behavior is unchanged. Persist nodes without `output_type` keep session continuity but leave nothing behind for recovery.
- **Last writer wins.** Concurrent runs of the same workflow in the same scope write per-node files into the shared scope directory; the most recent run's output for a given node is what a later cold resume sees.
- **CLI caveat.** Each `archon workflow run` mints a fresh conversation UUID (a fresh scope) unless you pass `--conversation-id <id>` — the same caveat as session persistence itself.

### Distinct from `AgentRequestOptions.persistSession`

The Claude Agent SDK also has a `persistSession` flag controlling whether the SDK writes its session transcript to disk. That is a *different* concept — local file persistence inside the SDK. This `persist_session:` field is about Archon's database-stored cross-run session ID for workflow nodes. The two operate at different layers and don't conflict.

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

### Typed Artifacts (`output_type`)

The chain above relies on each node knowing the exact filename its upstream wrote. To locate an output **by type** instead of by guessed filename, declare `output_type` on a node:

```yaml
nodes:
  - id: planner
    command: plan-feature
    output_type: plan        # tag this node's output
```

When a node sets `output_type`, the executor writes a typed sidecar after the node completes:

- `$ARTIFACTS_DIR/nodes/<id>.md` — the node's output text
- `$ARTIFACTS_DIR/nodes/<id>.meta.json` — metadata (`outputType`, `runId`, `producedAt`, `size`, and `sessionId` when available)

This works on **every** node type (`bash`/`script` produce typed outputs too, just without a `sessionId`). The write is **best-effort** — if it fails, the node still succeeds and a warning is logged; the typed sidecar may simply be absent. `output_type` is an open set of labels (`plan`, `findings`, `code`, `summary`, …) — pick a convention and keep casing consistent, since lookup is case-sensitive.

Successful bash stdout is retained by default on the completed run as a bounded audit preview in `node_completed.data.node_output`. Output over 32 KiB (32,768 UTF-8 bytes) ends with a truncation marker, and the event also includes `node_output_truncated: true` plus `node_output_original_bytes`. Because stdout is persisted, never print secrets or credentials from bash nodes. This preview is separate from `output_type`: declaring `output_type` opts into a best-effort file sidecar that may contain the full output and is not required for ordinary bash audit retention.

---

## Cross-Run State with `$STATE_DIR`

`$ARTIFACTS_DIR` is scoped to **one run**. When a workflow needs to remember something
*between* runs — a dedup ledger of issues already commented on, a "last processed" cursor,
a nudge log — write it to `$STATE_DIR`:

```yaml
nodes:
  - id: load-state
    runtime: bun
    script: |
      import { readFile } from 'fs/promises';
      const path = `${process.env.STATE_DIR}/triage/seen.json`;
      let seen: string[] = [];
      try {
        seen = JSON.parse(await readFile(path, 'utf-8'));
      } catch {
        // First run — no ledger yet.
      }
      console.log(JSON.stringify({ seen }));
```

`$STATE_DIR` is `~/.archon/workspaces/<project>/state/`, pre-created before the first node
runs, and delivered to `bash:`/`script:` subprocesses as the `STATE_DIR` environment
variable as well.

**It is scoped per project, not per workflow.** Every workflow in the project sees the same
directory. That is deliberate — it is what lets two cooperating workflows (say a triage pair
that must not both comment on the same issue) share one ledger. If you want isolation,
namespace it yourself: `$STATE_DIR/<workflow-name>/`, exactly as you already organize
subdirectories inside `$ARTIFACTS_DIR`.

### Concurrency: no locking, and what that means

The engine does **no** locking on `$STATE_DIR`. Two runs of the same stateful workflow in
one project — each in its own worktree, so the working-path lock does not serialize them —
share one directory, and the failure mode is a lost update:

1. Run A reads `{1, 2}`
2. Run B reads `{1, 2}`
3. Run A writes `{1, 2, 3}`
4. Run B writes `{1, 2, 4}` — A's entry is gone

For a dedup ledger that means an item gets reprocessed on the next run: a duplicate comment,
a repeated nudge. Note that write-then-rename prevents *torn reads* but does **not** prevent
lost updates — the read happened before either write.

This is an **authoring** concern, not an engine one. Options, in order of preference:

- **Append-only ledger.** Concurrent small `O_APPEND` writes are atomic on POSIX, so each
  run appends its own lines and readers fold the file. This is the fix if lost updates
  matter.
- **Accept last-writer-wins.** Fine when the state is a cache or a cursor that self-corrects.
- **Don't run the workflow concurrently.** A workflow with `worktree: enabled: false` shares
  one working path, and the path lock **rejects** a second run on that path outright — it
  does not queue it. So concurrent state writes cannot arise there in the first place; the
  second invocation fails fast with "This worktree is in use" and the operator re-runs it
  afterwards.

Put the state write in a `script:` node, not in an AI node's Write tool. A `script:` node is
a guarantee; a prompt instructing an AI node to append is a convention it may not follow.

### When you *want* output in the repository

`$STATE_DIR` and `$ARTIFACTS_DIR` both live outside the repo on purpose: run output should
never land in a user's git history, and inside an isolated run anything written to the
worktree is destroyed at cleanup. Three sanctioned ways to get content into git anyway:

1. **It is repo content.** Documentation, generated code, a committed spec — write it into
   the worktree like any other file and let the workflow commit it normally. This is not an
   exception; it is the normal path for anything that *is* source.
2. **An explicit copy node.** Produce the file in `$ARTIFACTS_DIR`, then add a `bash:` node
   that copies exactly what should be versioned into the worktree, and commit it. The copy
   is visible in the DAG, so "why is this in my repo" has an answer.
3. **Traceability without git.** If you only need to *find* the output later, you do not need
   it in the repo at all: the artifact routes (`GET /api/runs/:runId/artifacts`) and
   `output_type` sidecars address a run's output by run id and by type.

## Reusing a Shared Sub-DAG with `include:`

An `include:` node inlines another workflow's nodes into the current DAG. This lets you
factor a shared block of nodes (for example a multi-step review flow) into its own workflow
file and reference it from many workflows, instead of copy-pasting the nodes and letting the
copies drift apart.

```yaml
nodes:
  - id: finalize-pr
    command: archon-finalize-pr

  # Inlines every node from archon-review-block, attached after finalize-pr.
  - id: review
    include: archon-review-block
    depends_on: [finalize-pr]

  - id: summary
    command: archon-workflow-summary
    depends_on: [review]   # resolves to the review block's terminal node
```

The include target (`archon-review-block` here) is an ordinary workflow file discovered by
name, honoring the usual precedence (`bundled` < `~/.archon/workflows/` < repo
`.archon/workflows/`). Only its `nodes:` are inlined — the included file's workflow-level
fields (`provider`, `model`, `worktree`, `persist_sessions`, `requires`, …) are ignored; the
including workflow's defaults govern the inlined nodes. If an included node needs a specific
provider or model, set it **per-node** — per-node fields survive inlining verbatim.

### How expansion works

Expansion happens at **load time (discovery)**, before the workflow ever runs. By the time
the executor sees the DAG there are no include nodes left — the inlined nodes are ordinary
top-level nodes, so runs, events, resume, and approvals all behave exactly as if you had
written the nodes by hand. There is no separate child run.

- **Namespacing.** Each included node `n` becomes a top-level node with id
  `<includeId>__<n.id>` (double underscore). Including `archon-review-block` under
  `id: review` yields `review__verify-pr-base`, `review__sync`, `review__implement-fixes`,
  and so on. These namespaced ids are what appear in the event stream and in
  `archon workflow get <id>`.
- **Edges and command bodies.** Internal `depends_on` edges and `$id.output` references are
  rewired to the namespaced ids automatically. This includes named `command:` and
  `loop.command` files: discovery resolves their bodies and compiles them into the flat DAG
  before namespacing. Compilation recurses through nested `loop_group` bodies. An unresolved
  included command cannot start a fresh execution because its references cannot be proven safe.
  Command nodes fail composition immediately; loop commands retain a private compilation error
  so a paused loop can still resume from its persisted, validated prompt snapshot.
  The include node's own `depends_on` / `when` / `trigger_rule` attach to the block's
  **entry** nodes (those with no upstream inside the block). If both the include and an entry
  define `when:` and either condition contains `||`, loading fails because the grammar cannot
  group them without changing precedence; put the gate only on the include or inside the block.
- **Sink asymmetry (a downstream node depending on the include).** A `depends_on:
  [<includeId>]` on a downstream node fans out to **all** of the block's sink nodes (every
  node with no dependents inside the block), so it waits for the whole block to finish.
  But `$<includeId>.output` resolves to only the **primary** sink — the first sink in
  definition order (the same terminal-selection rule `loop_group` uses). For a
  single-sink block like the review block the two coincide; they differ only when a block
  has multiple leaf nodes.
- **Output.** `$<includeId>.output` in another node resolves to the block's primary sink.
  In the example, `$review.output` is the output of the block's `implement-fixes` node.

### Passing values into an included block

An include can pass an identifier-keyed string map through `with:`. The included block uses
those values through `$INPUTS.<name>` in its inline text:

```yaml
# parent workflow
nodes:
  - id: plan
    prompt: Plan the requested change.

  - id: review
    include: reusable-review
    depends_on: [plan]
    with:
      plan: $plan.output
      base_branch: main
```

```yaml
# reusable-review workflow
nodes:
  - id: inspect
    prompt: Review $INPUTS.plan against $INPUTS.base_branch.
```

Input names must start with a letter or underscore and may then contain letters, numbers,
underscores, or hyphens. Values must be strings and are inserted verbatim during load-time
expansion — they are **never expressions**: nothing is evaluated, computed, or interpreted,
and the value is spliced in as text exactly as written. An inserted `$node.output` reference
remains a reference and resolves through the normal runtime output substitution. A missing
input referenced by the block is a load error. Whether **extra** caller keys are allowed
depends on whether the block declares `inputs:` (see
[Workflow Signature](#workflow-signature-inputs-returns-and-inputs)): a block with no
`inputs:` ignores unrecognized keys; a block that declares `inputs:` rejects an undeclared
key at load.

Substitution applies everywhere the value could reach the model or the shell, including
inside Markdown code fences and inline code spans — `$INPUTS.<name>` has no
documentation-only meaning, so a fenced occurrence is still a live parameter.

#### Command bodies use the same explicit interface

Named `command:` and `loop.command` files are the preferred home for substantial prompts and
can use both workflow-local `$node.output` references and declared `$INPUTS.<name>` values.
For an `include:`, Archon resolves and snapshots the command body during load-time composition,
then applies the same input binding and node-id namespacing as an inline prompt. The authored
workflow stays command-first; the executor receives a deterministic flat DAG.

Every live reference in the command body must belong to the included workflow's lexical node
scope. A direct `$caller.output` reference is rejected whether or not the parent happens to
have a node called `caller`; declare an input and pass it with `with:` instead. Failure to
resolve or read an included command is never a warning or best-effort bypass: a fresh execution
fails before an AI turn. A paused loop remains resumable from its saved prompt snapshot even if
the command is later deleted or made invalid.
Canonical references are live even inside Markdown code fences and inline code because runtime
substitution is syntax-agnostic.

Named `script:` files are different: they are opaque programs, not prompt templates. Archon
does not scan or rewrite their source. An `include:` may bind `$INPUTS` in the YAML `script:`
selector, but flattening does not inject those values into the selected program's environment.
The documented `INPUTS_<UPPER_SNAKE>` environment variables apply to `workflow:` sub-runs,
whose concrete inputs are persisted in child-run metadata.

### Non-goals (Phase 1)

- **No deep access.** A parent can read `$includeId.output` (the terminal) but not the
  output of an individual node inside the block. The block's internal node names are an
  implementation detail.
- **Literal targets only.** `include:` takes a literal workflow name — no
  `include: $something` and no cross-repo includes.
- **Not inside a `loop_group` body.** An include node nested in a `loop_group` body is
  rejected at load time.
- **Depth-capped and cycle-checked.** Includes may nest up to 3 levels deep; cycles
  (`A` includes `B` includes `A`) and over-deep chains are load errors that drop only the
  offending workflow — other workflows still load.

A workflow used purely as a building block (like `archon-review-block`) still appears in
`archon workflow list`. Mark it as a building block in its `description:` so it isn't picked
for a standalone run.

---

## Workflow Signature: `inputs:`, `returns:`, and `$INPUTS`

A workflow can declare a **structural signature** — what it takes and what it returns — so a
reusable block has an explicit, caller-facing contract instead of relying on positional
accidents. Two workflow-level fields:

```yaml
name: review-block
description: Reviews a diff — composes into a parent, and runs on its own
inputs:
  diff:
    required: true
    description: the diff to review
  style:
    default: strict
returns: synthesize          # the node whose output IS this block's result
nodes:
  - id: gather
    prompt: Gather context for $INPUTS.diff (style $INPUTS.style).
  - id: synthesize
    prompt: Synthesize a review from $gather.output.
    depends_on: [gather]
  - id: implement-fixes
    prompt: Apply the fixes.
    depends_on: [synthesize]
```

- **`inputs:`** — a map of input name → `{ required?, default?, description? }`. `required: true`
  and `default:` are mutually exclusive (a required input has no default; declaring both drops
  the key at load with a warning). Values come from `with:` on the `include:`/`workflow:` node
  that references this workflow, or — for a direct run — from `--input name=value` on the CLI or
  the run form in the web console (see [Running a workflow that declares
  inputs](#running-a-workflow-that-declares-inputs)). Whichever channel supplies them, the same
  contract applies: a missing **required** input and an **undeclared** key are both rejected, and
  a declared `default:` fills an omitted input. A workflow with **no** `inputs:` keeps the old
  lenient behavior: supplied keys **pass through unvalidated** — they are recorded on the run
  and still resolve as `$INPUTS.<name>` / `INPUTS_<UPPER_SNAKE>`, they are simply never checked
  against a declaration, because there isn't one.
- **`returns:`** — the **node id** whose output IS the workflow's result. It selects by id, so
  it works for any node type and even a **non-sink** node (a node other nodes depend on). For an
  `include:` block, `$blk.output` resolves to the `returns:` node; `depends_on: [blk]` still
  waits on every terminal node. For a `workflow:` sub-run child, the child's terminal output
  (threaded back as `$node.output`) becomes the `returns:` node's output.

### Binding time: includes resolve at load, runs at runtime

`$INPUTS.<name>` is delivered by **two deliberately separate paths**, and the difference decides
which surfaces can read it:

| Caller | When `$INPUTS` resolves | Reaches `prompt:`/`bash:`/`script:` | Reaches `command:` file bodies |
|--------|-------------------------|-------------------------------------|--------------------------------|
| `include:` | **Load time** (the block and command bodies are compiled into the flat DAG) | Yes | **Yes** — resolved command bodies receive the same input binding before execution |
| `workflow:` sub-run | **Runtime** (values become `$INPUTS` variables on the child run) | Yes | **Yes** — every child node flows through runtime substitution |
| direct run (`--input` / console form) | **Runtime** — the same path as a sub-run; supplied values are persisted to the run's own metadata, so `$INPUTS` reconstitutes on a cold resume | Yes | **Yes** — every node flows through runtime substitution |

Both composition paths support command-backed prompts; their binding time differs. Includes
snapshot and bind the resolved command body at load time, while sub-runs resolve inputs at
runtime. Sub-run inputs are persisted to the child run's metadata at spawn, so `$INPUTS`
reconstitutes on a cold resume.

### `$INPUTS` in `bash:`/`script:` nodes uses env vars

`$INPUTS.<name>` text is substituted only into non-shell (AI/prompt) surfaces — a sub-run's
input value can derive from AI output, exactly the user-controlled class kept out of shell
source. A `bash:`/`script:` node instead reads each input as an **environment variable** named
`INPUTS_<UPPER_SNAKE>`: hyphens become underscores and the name is upper-cased, so `plan` →
`$INPUTS_PLAN` and `base-branch` → `$INPUTS_BASE_BRANCH`. (Because `-` and `_` both fold to `_`,
two input names that collide on one env key — e.g. `foo-bar` and `foo_bar` — are a load error.)

```yaml
# in a workflow: sub-run child
nodes:
  - id: check
    bash: |
      echo "planning: $INPUTS_PLAN"     # NOT $INPUTS.plan — bash reads the env var
```

### `$INPUTS` in `when:` conditions

A node in a `workflow:` sub-run child — or in a workflow started directly with `--input` —
can **branch** on a declared input, not just read one:

```yaml
inputs:
  mode: { default: thorough }
nodes:
  - id: quick-pass
    prompt: "Do the quick pass"
    when: "$INPUTS.mode == 'fast'"
  - id: full-pass
    prompt: "Do the full pass"
    when: "$INPUTS.mode != 'fast'"
```

The condition resolves the name against the run's inputs at evaluation time; the value is
never spliced into the expression, so an input containing a quote or an operator is
compared as data and can never be re-read as syntax. An `$INPUTS.<name>` the run does not
carry **fails the node**, with the same message the prompt surface gives
(`Unknown input '$INPUTS.mdoe'. Did you mean $INPUTS.mode?`) — it never resolves to an
empty string, because a condition that quietly compares nothing is the silent-branch
failure the [`when:` section](#when-condition-syntax) warns about.

:::caution[Inside an `include:` block, put `$INPUTS` on the RIGHT of the comparison]
An include is a **verbatim text** splice at load time, and a `when:` is one of the
surfaces it rewrites. That makes the right-hand form work and the left-hand form break:

```yaml
when: "$probe.output == '$INPUTS.mode'"   # ✅ becomes  $probe.output == 'fast'
when: "$INPUTS.mode == 'fast'"            # ❌ becomes  fast == 'fast'  → unparseable
```

The second is not a condition any more, so the node is skipped with an unparseable-`when:`
warning at run time. The left-hand form is a `workflow:`/direct-run feature: those callers
resolve `$INPUTS` at evaluation time, while an included block is inlined into the caller's
own run and has no input scope left to resolve against.
:::

### Running a workflow that declares inputs

Declaring `inputs:` does not make a workflow callable-only. The same file runs on its own **and**
composes into any number of parents — supply the values at invocation:

```bash
# one flag per input; repeat it
archon workflow run review-block --input diff="$(git diff)" --input style=terse

# the trailing message is still $ARGUMENTS, independent of --input
archon workflow run review-block --input diff=... "focus on the auth changes"
```

In the **web console**, a workflow that declares `inputs:` renders a field per input in the run
card — description as help text, `default:` as the placeholder, `*` on the required ones. The
Start button stays disabled, and says which input it is waiting for, until every required field
has a value. A field left blank is **omitted**, so it falls back to its declared `default:`;
the console therefore cannot send a deliberate empty string, where `--input name=` can.

The grammar is deliberately small:

- `--input name=value` splits on the **first** `=`, so `--input msg=a=b` gives `a=b`.
- Values are plain strings. `--input name=` supplies a deliberate empty string.
- Repeat the flag per input; supplying the same name twice is an error, not last-wins.
- Omit an input to take its `default:`. Omitting one with no default and no `required: true`
  leaves it unset, and a body referencing it fails at the reference site.

Whatever supplies the values, they go through **one contract** — the same code a caller's `with:`
map goes through — so a map accepted when composing is accepted here:

- a **required** input with no value is refused, naming it;
- an **undeclared** key is refused, naming it and listing what the workflow does declare;
- both refusals happen **before any worktree, clone, or AI cost**;
- supplied values are recorded on the run, so a resume replays exactly what the run started with.

One consequence worth knowing on **chat, the run route, and the console** — the surfaces that reuse a
conversation. Invoking a workflow there when a resumable run of it already exists in that
conversation *continues that run* rather than starting a new one, without any resume vocabulary
(see [DAG Resume on Failure](#dag-resume-on-failure)). New `inputs` values passed on such a call are
**not applied** — the continued run keeps what it started with, and Archon says so, naming the
values it ignored. To run fresh with different values, abandon the existing run first
(`/workflow abandon <id>`) and invoke again. The CLI has no such implicit continuation: a plain
`archon workflow run` always starts fresh, and `--input` with `--resume` is rejected outright.

Chat platforms (Slack, Telegram, Discord, GitHub) have **no** channel for inputs yet: they carry
only a trigger message, so a required-input workflow invoked there still refuses up front and
points at the CLI and console. That gap is tracked in
[#2555](https://github.com/coleam00/Archon/issues/2555).

---

## Composing a Governed Sub-Run with `workflow:`

A `workflow:` node runs another workflow as a **child sub-run** — a genuinely separate
`workflow_runs` record with its own artifacts directory, its own approval gates, its own
cost line, and its own audit trail. The child's terminal output threads back into the
parent as `$<nodeId>.output`, exactly like any other node.

```yaml
nodes:
  - id: plan
    prompt: "Plan the change described in $ARGUMENTS."
    context: fresh

  # `workflow:` names any discovered workflow (bundled / global / repo) to run as a
  # child sub-run; `qa-block` here is a placeholder for your own workflow file.
  # Its terminal output becomes $implement-qa.output.
  - id: implement-qa
    workflow: qa-block
    input: "$plan.output"
    depends_on: [plan]

  - id: summarize
    prompt: "Summarize the sub-run result:\n\n$implement-qa.output"
    depends_on: [implement-qa]
    context: fresh
```

A `workflow:` node has **one** input channel per invocation: either the untyped `input:` string
(delivered as the child's `$ARGUMENTS`) **or** the named `with:` map (delivered as the child's
`$INPUTS.<name>` — see [Workflow Signature](#workflow-signature-inputs-returns-and-inputs)).
Setting both on one node is a load error. Use `with:` when the child declares named `inputs:` or
when its `command:` bodies need named values:

```yaml
  - id: implement-qa
    workflow: qa-block
    with:
      plan: "$plan.output"
      mode: fast
    depends_on: [plan]
```

### `include:` vs `workflow:` — which to use

Both reuse another workflow. They differ in **governance**, not syntax:

| | `include:` (load-time) | `workflow:` (run-time) |
|---|---|---|
| Run record | One — the block's nodes flatten into the parent's run | Two — the child gets its own `workflow_runs` row |
| Artifacts / cost / resume | Shared with the parent | The child's own, separate |
| Approval gate | The parent's single gate | The child pauses at **its own** gate, approved by the child's run id |
| Output access | `$includeId.output` (terminal only) | `$nodeId.output` (child's terminal) |
| When to reach for it | Textual reuse of a shared block (e.g. a review sub-DAG) | The block must be a separate **governance object** — separately auditable, gated, and cost-tracked |

Rule of thumb: **`include:` for reuse, `workflow:` for a governed, separately-auditable
sub-pipeline.**

### Gates, failure, and cost

- **Gates pause the whole tree.** When the child hits an approval gate, the child run
  pauses **and** the parent pauses "blocked on child". A reviewer approves the **child** by
  its own run id (`/workflow approve <childRunId>` — shown in the pause message). When the
  child completes, the parent **auto-resumes** in-process, re-runs the `workflow:` node,
  finds the child finished, and threads its output onward. Because the parent pauses at a
  gate, mark a parent that contains a `workflow:` node with `interactive: true` so it runs
  in the foreground on the web UI.
- **Failure & recovery.** A failed child fails the node and the parent run. Recovery is
  resume-through-parent: `/workflow resume <parentRunId>` re-drives the failed child once.
  `retry:` is **not** allowed on a `workflow:` node (a retry would orphan the first child
  run).
- **Cancel cascade.** Abandoning the parent cancels its non-terminal descendants
  cooperatively (their executors abort at the next status check, within ~10s — there is no
  hard subprocess kill yet).
- **Cost roll-up.** The child's total cost rolls up into the `workflow:` node's cost and
  the parent's aggregate, and `parent_run_id` on the child row makes the run tree visible
  in `archon workflow runs` and the console.

### Choosing the child's checkout with `isolation:`

`isolation:` decides which working directory the child run executes in. It is valid **only**
on a `workflow:` node — on any other node type it is rejected at load time, since only a
sub-run has a checkout of its own to choose.

| Value | The child runs in |
|-------|-------------------|
| omitted (the default) | the parent's checkout — same files, same branch |
| `inherit` | identical to omitting it; write it when you want the sharing to be deliberate rather than incidental |
| `worktree` | its own git worktree, on its own branch |

**Archon never infers this.** Nothing about a node — what workflow it names, how many
children it spawns, whether they run concurrently — makes a worktree appear. A child gets
one when, and only when, you write `isolation: worktree`. Whether a step needs its own
checkout is a judgement about what that step *does*, and the author is the one who knows.

Most sub-runs don't need one. A review, a research pass, or a summarizer that writes only to
`$ARTIFACTS_DIR` is better off in the parent's checkout: it sees the parent's uncommitted
work, and there is nothing to create or clean up afterwards.

#### What `isolation: worktree` gives you, and what it costs

```yaml
  - id: refactor-module
    workflow: refactor-block
    input: "$plan.output"
    isolation: worktree        # its own checkout, its own branch
    depends_on: [plan]
```

The child gets a fresh worktree under `~/.archon/workspaces/<owner>/<repo>/worktrees/`, on a
new branch named `archon/task-<parentRunId8>-<nodeId>-<hash>-child-<n>` — for the node above,
`archon/task-3f9a1c2b-refactor-module-6fd3f873-child-0`. The node id is what keeps two
isolated sub-run nodes in one parent from landing in the same worktree; the hash covers node
ids too long to fit in a branch name. Four consequences are worth knowing before you reach
for it:

- **The branch starts from the repo's base branch, not the parent's.** The worktree is cut
  from `origin/<baseBranch>` **in the canonical checkout**, not from the parent's working
  tree. The base is levels 2–4 of the [base-branch precedence
  table](/reference/cli/#base-branch-precedence): `worktree.baseBranch` in
  `.archon/config.yaml`, else the codebase's stored default branch, else git
  auto-detection. Level 1 is missing on purpose — **the per-dispatch `--base` / `--from`
  overrides apply only to the run they were passed to and do not reach its sub-run
  children**, so `archon workflow run parent --base release/2.0` still cuts every isolated
  child from the repo's configured base. An isolated child therefore sees neither the
  parent's uncommitted edits **nor the commits the parent made on its own branch**.
  Everything the child needs has to arrive through `input:`, artifacts, or the repo's base
  branch.
- **Nothing merges it back.** The child's commits stay on the child's branch. Landing them
  is the workflow's job — the child pushes and opens a PR, or a later parent node does. What
  returns automatically is only the child's terminal output, as `$<nodeId>.output`.
- **It becomes a tracked environment with a lifecycle.** Each child worktree registers an
  isolation environment, so it appears in `archon isolation list` next to top-level run
  worktrees and is governed by the same `archon isolation cleanup [--merged]` and
  `archon complete <branch>`. It is **not** removed when the child finishes — the branch
  deliberately outlives the run so you can inspect or land it. Isolate many children and you
  accumulate many worktrees and branches to clean up.
- **Resume reuses it, and fails if it is gone.** As long as the child's run row exists, a
  resume reuses the path recorded on it rather than making a second worktree. If that path
  was cleaned up in between, the node fails with *"its working path no longer exists …
  start a fresh run"* rather than dying on a deep `ENOENT` mid-run. Don't run
  `isolation cleanup` while a sub-run tree is still resumable. (Only if the child's run row
  itself is gone does the node spawn fresh — and it lands on the same branch name, since
  the name is derived from the parent run and the node id.)

Nesting works: a grandchild `workflow:` node can request its own worktree too, up to the
sub-run depth cap.

#### When a worktree can't be created

Creating one needs a git repository and a surface that can make worktrees in it. When the run
has neither, the node **fails fast** — it never quietly falls back to the shared checkout,
because a silent fallback would produce exactly the concurrent-write collision the isolation
was asked for:

```text
isolation: 'worktree' on sub-run '<name>' requires an injected child-isolation resolver
(available for git-repo codebases run via the CLI or orchestrator). Remove the isolation
or use 'inherit' (shared checkout).
```

You get this when:

- the project is a **folder project** — a non-git workspace registered with `--folder`
  ([Multi-Repo Projects](/guides/multi-repo-projects/)). There is no repository to make a
  worktree in. Use `inherit`, or split the work so the writing step targets a real repo.
- the run resolved no codebase at all (for example a background dispatch with no project
  bound, or a database lookup that failed at run start).

Whether the **parent** is isolated makes no difference. A parent started with
`--no-worktree`, running in your live checkout, can still hand an isolated child its own
worktree — which is a reasonable shape when the parent only reads and one step writes.

`archon validate workflows` **cannot** catch this. Whether a worktree can be created is a
property of the run, not of the file, so a workflow using `isolation: worktree` validates
cleanly everywhere and then fails at the node when it is run somewhere it can't be honored.
If a workflow only makes sense against a git repo, say so in its `description:`.

A worktree that fails for an ordinary git reason — no disk space, a permission problem, a
branch that already exists — fails the node the same way, with the underlying git error
classified into a readable message.

### Running sub-runs side by side

Two `workflow:` nodes in the same DAG layer start their children at the same time. What
happens next depends on whether those children share a checkout.

Children **in their own worktrees** (`isolation: worktree`) never interact — separate
directories, separate branches.

Children **sharing the parent's checkout** meet the engine's path-exclusive lock. Every run
takes a lock on its working path at start, and a run that finds the path already held by
another active run **cancels itself**. The lock excludes a run's own ancestors and
descendants — a child never blocks against its own parent — but **siblings are not
excluded**. Two sub-run children in one layer over one checkout are therefore a collision:
the older run keeps the path, the younger one cancels itself, and the parent run fails.

> **Resume does not recover from this.** A parent's resume re-drives a *failed* child, but a
> *cancelled* one is threaded straight through as it stands — so a parent that failed this
> way fails again identically on every resume. The only way out is a fresh run. Avoid the
> collision; don't plan to recover from it.

The way to avoid it is to declare what the child does, on the child workflow itself:

```yaml
# review-block.yaml — reads the repo, writes only to $ARTIFACTS_DIR
name: review-block
description: Reviews the diff and writes findings. Composes into a parent; also runs on its own.
mutates_checkout: false      # skips the path lock: N of these coexist in one checkout
nodes:
  - id: review
    command: review-diff
```

`mutates_checkout: false` is a **workflow-level** field asserting that the run does not write
to its checkout, so the engine skips the path lock for it. It defaults to `true` (take the
lock, serialize runs on the same path). It is author-declared on purpose — the author of a
review or research workflow is the one who knows it only reads. Every child sharing the
checkout has to declare it: a sibling that doesn't still runs the lock query, finds the
others on the path, and cancels itself.

So there are three ways to make concurrent sub-runs work, and picking between them is a
statement about the children:

| The children… | Do this |
|---------------|---------|
| only read the repo (review, research, summarize) | `mutates_checkout: false` on the **child workflow** |
| write to the repo | `isolation: worktree` on each **`workflow:` node** |
| must not overlap at all | sequence them with `depends_on` |

One constraint applies however the checkouts are arranged: **one blocking child gate at a
time.** Two children in the same layer that both pause for approval contend for the parent
run's single approval slot — the second pause fails its node. Sequence gated sub-runs with
`depends_on` until a later slice adds real concurrent gating.

### Fanning out over a list with `fan_out:`

`fan_out:` turns one `workflow:` node into **N child runs** — one per element of a list
produced at run time — and reduces their results back into a single node output. Each
child is a full governance object in its own right: its own run record, artifacts, cost
line and audit trail, exactly like a 1:1 sub-run.

```yaml
nodes:
  - id: pick-files
    bash: |
      git diff --name-only origin/main \
        | jq -R -s -c 'split("\n") | map(select(length > 0))'

  # review-one-file declares `mutates_checkout: false` — see "Isolation" below.
  - id: review-each
    workflow: review-one-file
    depends_on: [pick-files]
    fan_out:
      items: "$pick-files.output"    # must resolve to a JSON array
      max_parallel: 3
      # join defaults to all_done: one file failing to review still yields the rest

  - id: summarize
    prompt: "Summarize these per-file reviews:\n\n$review-each.output"
    depends_on: [review-each]
```

Each item becomes one child's `$ARGUMENTS`. `$review-each.output` is a JSON array of the
children's terminal outputs **in item order**, not completion order — so a downstream node
can line results up against the input list positionally.

#### The four fields

| Field | Default | What it does |
|-------|---------|--------------|
| `items` | required | A `$node.output` (or `$node.output.field`) reference that must resolve to a **JSON array** at run time. Anything else — an object, a bare string, malformed JSON, a dangling ref — fails the node before any child is created. It never fans out over the characters of a string, and never silently degrades to zero items. An empty array is legal: the node completes immediately with `[]`. |
| `as` | — | Names the current item as `$INPUTS.<as>` in each child. It must not collide with a `with:` key. The item also reaches the child as `$ARGUMENTS`. |
| `max_parallel` | `5` | How many children may be **in flight at once**. |
| `join` | `all_done` | How N child outcomes reduce to one node outcome (below). |

The `items` producer must be an upstream dependency — the loader rejects a reference to a
node this one doesn't transitively depend on, so the array can never be read before it is
written.

#### `max_parallel` bounds concurrency, not count

`max_parallel` is a sliding window, not a limit on how many children exist. `items` is
**unbounded**: a 400-element array produces 400 child runs regardless of the window. Two
consequences worth planning for:

- Cost scales with `items.length`, not with `max_parallel`. Bound the list in the producer
  node, not here.
- Abandoning the parent cascade-cancels at most 500 descendant runs (`MAX_CASCADE_RUNS`).
  A fan-out wider than that can leave children uncancelled and still billing; they have to
  be abandoned individually. A run-tree-wide budget ceiling is tracked in
  [#1961](https://github.com/coleam00/Archon/issues/1961).

#### Join semantics

| `join` | The node succeeds when… | `$<id>.output` |
|--------|------------------------|----------------|
| `all_done` (default) | every child reached a terminal state | JSON array in item order, with each failed/cancelled child represented as `{ error, status }` in its slot |
| `all_success` | every child completed | same array; any failed or cancelled child fails the node instead |
| `first_success` | — | Racing: **rejected**, not deferred — see below. Rejected at load rather than silently treated as another join |

**Every child runs to its own terminal state before the join reduces, under both joins.** A
child that fails does not stop its siblings, does not stop later items from being spawned,
and does not change any other child's outcome. `all_success` still fails the node if any
child failed — it just reaches that verdict after everyone has finished rather than by
ending the others early. The failure message names the child that failed.

##### Why `all_done` is the default

Because fan-out children are **independent**. Two research children with different scopes,
or ten triage children over ten issues, are not one job split ten ways — they are ten jobs
that happen to run together, and one of them failing says nothing about the other nine. If
the default were all-or-nothing, a single failed child would discard nine good results at
the join, after you had already paid for them.

So the default treats **failure as data**. Every terminal outcome reaches the aggregate,
failed ones as `{ error, status }` in their slot, and the node succeeds. What to do about
the gaps is then an ordinary decision made by an ordinary node:

```yaml
  - id: triage-each
    workflow: triage-one-issue
    depends_on: [list-issues]
    fan_out:
      items: "$list-issues.output"      # join: all_done — the default

  - id: check
    script: |
      const results = $triage-each.output;
      const ok = results.filter(r => typeof r === 'string');
      console.log(JSON.stringify({ ok: ok.length, total: results.length }));
    runtime: bun
    depends_on: [triage-each]

  - id: report
    prompt: "Summarize the $check.output.ok successful triages:\n\n$triage-each.output"
    depends_on: [check]
    when: "$check.output.ok != '0'"
```

That shape is deliberate, and it is why there is no `join` value meaning *"succeed if at
least K children completed"*. **How many results are enough is judgement about your work,
not a join rule** — it depends on which children failed and why, and it changes between
runs. A script or prompt node reading the aggregate can weigh that; an enum cannot, and
adding a threshold would start a policy language inside a YAML field. `when:` gates whatever
comes next.

Use `all_success` when the children genuinely are one job — when a gap makes the aggregate
meaningless rather than smaller. That is the uncommon case, which is exactly why it is the
one you have to ask for.

##### Why there is no racing join

`join: first_success` — run N children, keep whichever finishes first, drop the rest — is
**rejected**, not postponed. Writing it fails at load with a message saying so.

Racing only works by ending the losers: the moment a winner appears, the others are aborted
and cancelled. That is one child's outcome deciding its siblings', which is precisely the
coupling the independence rule forbids — and it cannot be reshaped, because a race that
lets the losers finish is not a race.

The want underneath it is real: *several genuinely different attempts, best result forward.*
That is served without any mutual cancellation — write the attempts as **separate nodes**,
each with its own model or prompt, all feeding one collector node that picks:

```yaml
  - id: attempt-a
    prompt: "Solve $ARGUMENTS using the existing helper."
    model: large
  - id: attempt-b
    prompt: "Solve $ARGUMENTS from scratch."
    model: medium

  - id: pick
    prompt: "Two attempts. Choose the better and explain why.\n\nA:\n$attempt-a.output\n\nB:\n$attempt-b.output"
    depends_on: [attempt-a, attempt-b]
    trigger_rule: none_failed_min_one_success
```

This is strictly better than racing at what racing was wanted for: the attempts can differ
by **model**, which a fan-out cannot express, every output is preserved for the collector to
weigh instead of thrown away, and selection is a judgement made by a node that can read the
work rather than a stopwatch.

This is a deliberate trade, and the cost is yours to plan for: **a fan-out whose first child
fails still runs every remaining child.** Worst-case spend is `items.length` attempts, not
"until the first failure". `max_parallel` caps how many run at once, never how many run in
total, so a 200-item fan-out over a child that fails on item 1 still costs 200 children.
Bound the list in the producer node if that matters, and treat the abandon-cascade note
above as a real limit rather than a footnote — this is what makes
[#1961](https://github.com/coleam00/Archon/issues/1961)'s budget ceiling load-bearing.

#### Isolation: the same explicit rule, and one sharp edge

Fan-out changes nothing about [`isolation:`](#choosing-the-childs-checkout-with-isolation).
The engine does not infer a worktree from `fan_out:` — how many children a node spawns says
nothing about whether they write. N review or research children over the parent's checkout
is the ordinary case and needs no isolation at all.

But N children sharing one checkout **are siblings of each other**, so they meet the path
lock described in [Running sub-runs side by side](#running-sub-runs-side-by-side): all but
one would cancel themselves, and a lock-cancelled child is not recoverable by resume. So
Archon refuses that expansion **before creating a single child**:

```text
fan_out node 'review-each': up to 3 children of 'review-one-file' would run at once in the
parent checkout, and that workflow does not declare `mutates_checkout: false`. Concurrent
runs on one checkout take a path-exclusive lock, so all but the first would cancel
themselves — and a lock-cancelled child is not recoverable by resume (#2180). Choose one:
add `mutates_checkout: false` to 'review-one-file' if it only reads the repo; set
`isolation: worktree` on 'review-each' if the children write to it; or set
`fan_out.max_parallel: 1` to run them one at a time.
```

Three ways out, and which one is right is a statement about the children:

| The children… | Do this |
|---------------|---------|
| only read the repo (review, research, summarize) | `mutates_checkout: false` on the **child workflow** |
| write to the repo | `isolation: worktree` on the **fan-out node** — every child gets its own worktree and branch, at the [cost described above](#what-isolation-worktree-gives-you-and-what-it-costs), multiplied by N |
| write, but can be serialized | `fan_out.max_parallel: 1` — one child at a time in the parent checkout, so no two ever contend |

The check runs at **spawn** time, not load time: the child target resolves when the node
executes (that is deliberate — it's what lets a workflow generate another workflow and then
run it), so `archon validate workflows` cannot see the child's `mutates_checkout`. What it
can guarantee is that you find out before any child exists and before any money is spent.

#### Gates: around a fan-out, never inside one

A fan-out is an **autonomous** stretch of a run. A parent run has a single approval slot, so
N children cannot each hold it — a child that pauses at a gate fails the fan-out node
instead of pausing the tree ([#2438](https://github.com/coleam00/Archon/issues/2438)).

That is the intended shape, not a missing feature: gates **bracket** the autonomous middle.

- An `approval:` node **before** the fan-out is an ordinary parent gate — approve, then the
  expansion runs.
- An `approval:` node **after** it resumes correctly: the completed fan-out node is skipped
  on resume and `$<id>.output` still holds the full aggregate.
- A gate **inside a 1:1 sub-run** (no `fan_out:`) also works — the child pauses, the tree
  pauses, and approving the child by its run id auto-resumes the parent.

The one asymmetry to know about: the *same* child workflow pauses correctly when spawned
1:1 and hard-fails when fanned out. If you wrap an existing gated workflow in `fan_out:`,
move the gate into the parent DAG around the node.

A paused child is the single case where a fan-out cancels a run it did not have to. A pause
is not a terminal state and the parent cannot hand its one approval slot to N children, so
the child would wait for something it can never be given — cancelling it (tagged
`fan_out_gate`, so removing the gate and resuming re-drives it) is what makes it terminal.
It happens as soon as the pause is seen rather than at the end, because a non-terminal run
still holds its working path: left paused, it would take the path lock out from under the
next sibling on a shared checkout. Its siblings are unaffected either way — they run to
their own terminal states, and the node fails afterwards.

#### Resume, and what `child_index` keys

Children are keyed by their position in the item list (`metadata.child_index`), which is
what makes a parent resume cheap and predictable:

- Completed children are threaded from their existing rows — never re-run, never re-billed.
- Failed children are re-driven in place, in the same row.
- Children Archon itself cancelled — in practice a gate rejection (below) — are tagged and
  re-driven too, so *"remove the gate and resume"* actually completes the node. A child
  **you** cancelled out of band stays cancelled and is never resurrected.
- A child left `running` or `pending` by an interrupted process is **not** auto-cancelled —
  Archon can't tell a crash orphan from a live run elsewhere. The node fails with the child's
  run id and tells you to wait or abandon it.

Because the key is the index, the `items` list changing between attempts matters:

- **The list got shorter** — a child whose index no longer exists is logged and, if still
  running, cancelled as an orphan. It is never silently dropped.
- **An item at some index changed** (a non-deterministic producer) — resume still re-keys by
  index and warns (`workflow.fan_out_item_content_changed`) that a child's item is not the
  one it was spawned with. In the normal case this can't happen: the producer's output is
  cached from the first attempt and replayed on resume. It shows up when the producer node
  is marked `always_run: true`, or when its output genuinely isn't stable.

If you want a fan-out whose item list is guaranteed identical across attempts, keep the
producer deterministic — write the list to `$ARTIFACTS_DIR` and read it back rather than
re-deriving it.

### Non-goals (this slice)

- **Choose one input form** — `input:` sends a single data string as `$ARGUMENTS`;
  `with:` supplies named `$INPUTS` values. The two forms are mutually exclusive.
- **No racing** (`join: first_success`) — rejected outright, not deferred (see [Why there is no racing join](#why-there-is-no-racing-join)).
- **Not inside a `loop_group` body** — a `workflow:` node, fanned out or not, is rejected
  there at load time ([#2439](https://github.com/coleam00/Archon/issues/2439)).
- **Static target only.** `workflow:` takes a literal workflow name — no
  `workflow: $something`. Self-reference and ancestor cycles (`A` → `B` → `A`) are rejected
  at run time, and the sub-run tree is depth-capped.

---

## Model Configuration

Workflows can configure AI models and provider-specific options at the workflow level.

### Configuration Priority

Model and options are resolved in this order:

1. **Workflow-level** - Explicit settings in the workflow YAML
2. **Config defaults** - `assistants.*` in `.archon/config.yaml`
3. **SDK defaults** - Built-in defaults from Claude/Codex SDKs

For the Claude SDK advanced options (`effort`, `thinking`, `fallbackModel`, `betas`, `sandbox`) a per-node value sits above the workflow level: a node uses its own value if set, otherwise it inherits the workflow-level default. See [Claude SDK Advanced Options](#claude-sdk-advanced-options).

### Provider and Model

```yaml
name: my-workflow
provider: claude     # Any registered provider (default: from config)
model: medium        # Tier, alias, or literal model override
```

### Portable Model References

`model:` accepts three shapes:

- `small`, `medium`, or `large` - portable tier refs resolved from built-in defaults plus `tiers:` in `~/.archon/config.yaml` and `.archon/config.yaml`
- `@name` - custom aliases from `aliases:`; use these for project workflows, not bundled or global workflows, because aliases are project-specific
- Any other string - a literal model id passed through to the resolved provider's SDK

Tier and alias refs resolve to a provider, model, and optional provider-specific options such as `effort` or `thinking`. If a workflow or node sets both `provider:` and a model ref that resolves to a different provider, Archon warns and uses the provider from the resolved preset. Literal model strings keep the normal provider chain (`node.provider ?? workflow.provider ?? config.assistant`).

Archon does not keep an internal allow-list for literal model ids because vendor SDKs ship new models faster than this doc can. The provider's API decides whether a literal string is valid at request time.

Common shapes you'll see in practice:

- **Claude (Anthropic):** family aliases (`sonnet`, `opus`, `haiku`), full model IDs (`claude-opus-4-7`, `claude-3-5-sonnet-20241022`), context-window suffixed forms (`opus[1m]`, `claude-opus-4-7[1m]`), or `inherit` to reuse the previous session's model.
- **Codex (OpenAI):** any OpenAI model ID — `gpt-5.6-sol`, `gpt-5.6-terra`, `o5-pro`, etc.
- **Pi (community):** `<backend>/<model-id>` refs — e.g. `google/gemini-2.5-pro`, `openrouter/qwen/qwen3-coder`.
- **Copilot (community):** GitHub Copilot model names — e.g. `gpt-5`, `gpt-5-mini`, `claude-sonnet-4.5`, or `auto`.

If the SDK rejects a literal string at request time, the node fails loudly with the SDK's error message. Use portable tiers for cross-provider workflow defaults, and pair provider-specific literal strings with an explicit `provider:` on the workflow or node.

### Codex-Specific Options

```yaml
name: my-workflow
provider: codex
model: gpt-5.6-sol
modelReasoningEffort: medium    # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
webSearchMode: live             # 'disabled' | 'cached' | 'live'
```

**Model reasoning effort:**
- `minimal`, `low` - Fast, cheaper
- `medium` - Balanced (default)
- `high`, `xhigh` - More thorough, expensive

**Web search mode:** controls Codex's built-in web-search tool. It is not a network
switch — Codex nodes always run with network access enabled, so `disabled` stops Codex
from searching, not from reaching the network.

- `disabled` - No built-in web search (default)
- `cached` - Use cached search results
- `live` - Real-time web search

Both fields are **workflow-level only** — there is no per-node `modelReasoningEffort:` or
`webSearchMode:`. Declaring either on a workflow whose node resolves to a provider other
than Codex logs a warning and applies nothing, the same way any other unsupported option
does. The reverse also holds: `effort:` on a Codex node warns and is ignored, because Codex
takes reasoning depth only through `modelReasoningEffort`.

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

### Provider Validation

Workflows are validated at load time for **provider identity only**:
- Both the workflow-level `provider:` and any per-node `provider:` overrides must name a registered provider (`claude`, `codex`, `pi`, `copilot`).
- Validation errors are shown in `/workflow list`.

Example validation error:
```
Unknown provider 'claud'. Registered: claude, codex, pi, copilot
```

Tier and alias model refs are resolved during workflow validation so malformed `tiers:` / `aliases:` config, unknown aliases, and missing tier presets fail before execution. Literal model strings are not API-validated by Archon; they are forwarded to the SDK and validated by the upstream API at request time.

### Resource Validation (CLI)

To validate that all referenced command files, MCP config files, and skill directories exist on disk, run:

```bash
archon validate workflows <name>
```

This checks resource resolution beyond what load-time validation covers. Bundled and global workflows also reject `@custom` model aliases because those refs are not portable across projects. Use `--json` for machine-readable output. See the [CLI Reference](/reference/cli/) for details.

### Unknown Keys Are Reported, Not Rejected

A key Archon does not recognise is dropped from the parsed workflow — the YAML still loads and the workflow still runs. Because a dropped key can be one an author believed was doing something (the classic case is `interactive: true` on a command node, which reads like a human gate and is not one), Archon reports every dropped key as a **warning** naming the key, where it was found, and what to write instead:

```text
WARNING [unknown_key] Node 'plan': unknown key 'interactive' will be ignored.
  Nothing on this node gates. For a human gate, use an 'approval:' node; to gate
  each iteration of a loop, set BOTH 'loop.interactive: true' and
  'loop.gate_message' ('gate_message' on its own does not gate). Workflow-level
  'interactive:' is a different setting, and only on the web UI — it keeps the
  run in the foreground there; chat platforms already run in the foreground, so
  it does nothing for them.
```

(The `WARNING [unknown_key]` prefix is `archon validate workflows` formatting; the other surfaces below render the same message text differently.)

**What is checked.** The workflow root, every node, the nested config blocks (`approval:`, `approval.on_reject:`, `retry:`, `loop:`, `loop_group:`, `pi:`, each `agents:` entry, `worktree:`, `container:`, `evidence_policy:`), and every node inside a `loop_group` body.

**What is exempt**, because nothing is dropped from these — a key you write is a key that survives:

| Block | Why exempt |
|---|---|
| `output_format:` | Free-form JSON Schema; every key is accepted |
| `sandbox:` | Passthrough — unknown keys are preserved, not stripped |
| `thinking:` | A preprocessed union, not an object shape |
| `hooks:` | Strict — an unknown key is already a hard **error**, not a warning |

**Where the warnings appear.**

| Surface | Where |
|---|---|
| `archon validate workflows` | A `WARNING [unknown_key]` issue (also in `--json`) |
| `archon workflow list` | Inline under the workflow; `parseWarnings` on each `--json` entry |
| `archon workflow run` | On **stderr** before the run starts (`--detach --json` keeps stdout to the payload) |
| Chat (`/workflow list`) | Inline with the workflow that raised it |
| Any run that starts | **Recorded on the run** as a `workflow_parse_warnings` event — always |
| Chat / console (starting a run) | Also posted to the conversation, best-effort |
| Console workflow picker | A ⚠ marker on the row; full text in the tooltip |

**Recorded on the run, whatever started it.** When a run begins, the engine writes
the dropped keys to the run's event log as `workflow_parse_warnings`. This happens
for every run — CLI, chat, console, REST, and sub-runs — not only the ones with a
conversation to post into, and it is written by the engine rather than by the
notification path, so a failed message cannot take the record with it. Read it back
with:

```bash
archon workflow get <run-id> --verbose          # human-readable
archon workflow get <run-id> --verbose --json   # `parseWarnings` on the payload
```

(`--verbose` is required: the plain form returns the run row without reading the
event log.)

The chat/console message at run start is a **notification on top of that record**.
It is sent once and not retried: if the platform call fails (a revoked token, a rate
limit) the run still starts and that message is lost, leaving a `WARN` log line —
failing a run over an undeliverable warning would be worse. The finding is not lost
with it; it is on the run, and still on `validate`, `list`, and the console picker.

**Known gap — `include:`.** Warnings belong to the file that declared the key. If workflow A `include:`s workflow B and B has an unknown key, the warning is reported against **B**, not against A. Running A surfaces nothing. Check the included block directly (`archon validate workflows <block-name>`) when auditing a composed workflow.

### Example: Config Defaults + Workflow Override

**`.archon/config.yaml`:**
```yaml
assistants:
  claude:
    model: haiku  # Fast model for most tasks
  codex:
    model: gpt-5.6-sol
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

See the [Variable Reference](/reference/variables/) for the complete list, including `$LOOP_USER_INPUT`, `$REJECTION_REASON`, substitution order, and context variable behavior.

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

For long workflows, DAG resume lets you skip already-completed nodes — opt in with `--resume`:

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

If the workflow fails at `batch-2`, run `archon workflow run large-migration --resume` to skip `plan` and `batch-1`. Plain `archon workflow run large-migration` (without `--resume`) starts fresh.

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
- **CLI**: `bun run cli workflow approve <run-id>` or `bun run cli workflow reject <run-id>` — auto-resumes
- **Explicit command**: `/workflow approve <run-id>` or `/workflow reject <run-id>` — auto-resumes when issued in the originating conversation
- **Web UI**: Click the Approve/Reject buttons on the dashboard card — auto-resumes for Web-UI-dispatched runs; the Reject dialog includes an optional reason field that flows to `$REJECTION_REASON`
- **API**: `POST /api/workflows/runs/<run-id>/approve` or `/reject`

All four paths auto-resume the workflow from the next node. The user's approval comment is available as `$review-gate.output` in downstream nodes only when `capture_response: true` is set on the approval node. Cross-platform caveat: Web-UI approvals on Slack / Telegram / GitHub-dispatched runs record the decision but do not auto-resume — re-run from the originating platform to continue.

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
| Approval signal | AI emits the completion signal (`<promise>DONE</promise>`); a gate that paused on a signaled iteration finalizes on a bare approve | User explicitly approves or rejects via button/command |
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

The AI runs each iteration, pauses for user input, and the user's text feeds into the next
iteration via `$LOOP_USER_INPUT`. What an approve does depends on the paused iteration:

- If the iteration **emitted the completion signal** (the gate says "Completion signal
  detected"), approving with **no feedback** accepts the result — the node finalizes from
  the already-computed output with no extra iteration. Approving **with** feedback runs
  another iteration instead.
- If it did **not** signal, any approve runs another iteration with your feedback.

For a loop that should complete autonomously on the signal (no gate at all on success —
e.g. a validation that only needs a human on failure), add `signal_completes: true`. See
[Loop Nodes → `interactive` and `gate_message`](/guides/loop-nodes/#interactive-and-gate_message)
and [`signal_completes`](/guides/loop-nodes/#signal_completes--autonomous-completion) for
the full semantics.

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
8. **`allowed_tools` / `denied_tools`** — restrict tools per node (all providers except Codex)
9. **`retry:`** — AI nodes auto-retry transient errors (default: 2 retries / 3 total attempts, 3 s backoff); `bash:`/`script:` retry only with an explicit `retry:` block
10. **`hooks`** — attach SDK hook callbacks to Claude nodes for tool control and context injection
11. **`mcp:`** — attach per-node MCP servers via JSON config (Claude/Codex/Copilot; Codex configuration is additive)
12. **`skills:`** — select exact active skills on Claude and declare skills for Pi/Copilot; Codex workflow bodies use explicit `$skill-name`
13. **`agents:`** — inline Claude sub-agent definitions invokable via the `Task` tool
14. **`effort` / `thinking`** — control reasoning depth and thinking mode per node or workflow (Claude/Pi/Copilot)
15. **`maxBudgetUsd`** — set a USD cost cap per node; fails with error if exceeded (Claude only)
16. **`systemPrompt`** — override the default system prompt per node (Claude only)
17. **`sandbox`** — OS-level filesystem/network restrictions per node or workflow (Claude only)
18. **`output_type`** — tag a node's output with a semantic type; the engine writes a typed sidecar (`$ARTIFACTS_DIR/nodes/<id>.md` + `.meta.json`) for cross-node/cross-run lookup by type (any node type)
19. **Loop nodes** — use `loop:` within a DAG node for iterative execution until completion signal
20. **Defaults as templates** — browse `.archon/workflows/defaults/` for real examples to copy and modify
21. **Test thoroughly** — each command, the artifact flow, and edge cases
