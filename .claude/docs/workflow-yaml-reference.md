# Workflow YAML Reference

> **Purpose**: Complete specification of every field, option, and type in Archon's workflow system.
> **When to use**: Writing or debugging workflow YAML files, understanding execution modes, working on the workflow engine.
> **Size**: ~450 lines — use a scout sub-agent to check relevance before loading.

---

## Overview

Workflows are YAML files discovered from `.archon/workflows/` (recursively) plus bundled defaults. Each must have exactly one execution mode: `steps:`, `loop:` + `prompt:`, or `nodes:`. Parsed by `parseWorkflow()` in `packages/workflows/src/loader.ts:448`.

---

## Top-Level Fields (All Modes)

### `name` (required)
- **Type**: non-empty string
- **Used by**: Router for exact-match lookup; displayed in workflow list
- **Example**: `name: archon-fix-github-issue-dag`

### `description` (required)
- **Type**: non-empty string (multiline supported)
- **Used by**: Router prompt — this is the primary signal the AI uses to select a workflow. Include `Use when:` and `NOT for:` sections.

### `provider` (optional)
- **Type**: `'claude'` | `'codex'`
- **Default**: falls back to `.archon/config.yaml` assistants default (Claude)

### `model` (optional)
- **Type**: string — must be compatible with provider
- **Claude models**: `'sonnet'`, `'opus'`, `'haiku'`, `'inherit'`, or `'claude-*'`
- **Codex models**: anything that does NOT match Claude patterns
- **Validation**: incompatible provider/model fails loading

### `modelReasoningEffort` (optional, Codex only)
- **Type**: `'minimal'` | `'low'` | `'medium'` | `'high'` | `'xhigh'`
- **Default**: from `.archon/config.yaml` `assistants.codex.modelReasoningEffort`

### `webSearchMode` (optional, Codex only)
- **Type**: `'disabled'` | `'cached'` | `'live'`

### `additionalDirectories` (optional, Codex only)
- **Type**: `string[]` — absolute paths to other repos

---

## Steps Mode

```yaml
name: my-workflow
description: Sequential execution example
steps:
  - command: archon-plan
  - command: archon-implement
    clearContext: true
  - parallel:
      - command: archon-review-code
      - command: archon-review-tests
```

### Single Step Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | required | Command file name (`.md` extension added automatically) |
| `clearContext` | boolean | `false` | `true` = fresh AI session for this step |
| `allowed_tools` | string[] | all tools | Claude only. `[]` = no built-in tools (MCP-only) |
| `denied_tools` | string[] | none | Claude only. Removes named tools from default set |
| `idle_timeout` | number (ms) | 300000 (5 min) | Per-step timeout for AI inactivity |

### Parallel Block

```yaml
- parallel:
    - command: task-a
    - command: task-b
```

All steps in a parallel block run concurrently via `Promise.all()`. Each gets a fresh AI session (no session sharing). Nested parallel blocks are rejected.

---

## Loop Mode

```yaml
name: my-loop
description: Iterative autonomous execution
loop:
  until: COMPLETE
  max_iterations: 10
  fresh_context: false
prompt: |
  Work on the task. Signal <promise>COMPLETE</promise> when done.
```

### Loop Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `loop.until` | string | required | Completion signal string |
| `loop.max_iterations` | number | required | Max iterations (>= 1) |
| `loop.fresh_context` | boolean | `false` | `true` = new session each iteration |
| `prompt` | string | required | Prompt template (supports `$VARIABLE` substitution) |

**Signal detection** supports two formats:
- `<promise>SIGNAL</promise>` (recommended, case-insensitive)
- Plain signal at end-of-output or on its own line

---

## DAG Mode

```yaml
name: my-dag
description: Directed acyclic graph execution
provider: claude
nodes:
  - id: classify
    prompt: "Is this a bug? Answer JSON."
    output_format:
      type: object
      properties:
        type: { type: string, enum: ["BUG", "FEATURE"] }
      required: [type]
    allowed_tools: []
  - id: implement
    command: archon-implement
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"
  - id: lint
    bash: "bun run lint"
    depends_on: [implement]
```

Nodes are sorted topologically (Kahn's algorithm). Nodes in the same layer run concurrently via `Promise.allSettled`.

### Node Fields (All Types)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | Unique identifier. Used in `$nodeId.output` references |
| `depends_on` | string[] | `[]` | IDs of upstream nodes. Determines execution order |
| `when` | string | always run | Condition expression (see below) |
| `trigger_rule` | string | `'all_success'` | Join semantics for upstream states |
| `provider` | string | inherited | Per-node provider override |
| `model` | string | inherited | Per-node model override |
| `idle_timeout` | number (ms) | 300000 | Inactivity timeout |

### Node Types (Mutually Exclusive)

**`command:`** — Named command file, AI-executed
```yaml
- id: plan
  command: archon-create-plan
```

**`prompt:`** — Inline prompt string, AI-executed
```yaml
- id: classify
  prompt: "Classify this issue as BUG or FEATURE"
```

**`bash:`** — Shell script, no AI. Stdout captured as `$nodeId.output`
```yaml
- id: lint
  bash: "bun run lint 2>&1"
  timeout: 120000
```

### AI-Only Fields (command/prompt nodes)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `context` | `'fresh'` | inherited | Forces new AI session |
| `output_format` | object | none | JSON Schema for structured output (Claude only) |
| `allowed_tools` | string[] | all | Tool whitelist (Claude only). `[]` = no tools |
| `denied_tools` | string[] | none | Tool blacklist (Claude only) |

### Bash-Only Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `timeout` | number (ms) | 120000 (2 min) | Total execution timeout for the subprocess |

---

## Trigger Rules

Controls when a node runs based on upstream states:

| Rule | Behavior |
|------|----------|
| `all_success` | All upstreams must be `completed` **(default)** |
| `one_success` | At least one upstream `completed` |
| `none_failed_min_one_success` | No upstream `failed` AND at least one `completed` |
| `all_done` | All upstreams finished (completed, failed, or skipped all count) |

---

## `when:` Condition Syntax

```yaml
when: "$classify.output.type == 'BUG'"
when: "$classify.output.complexity != 'trivial'"
```

**Pattern**: `$nodeId.output[.field] OPERATOR 'value'`
- **Operators**: `==` and `!=` only
- **Field access**: dot-notation into JSON from `output_format` nodes
- **Values**: single-quoted string literals
- **Fail behavior**: unparseable expressions → `false` (node skipped)

---

## Variable Substitution

### Standard Variables (all modes)

| Variable | Replaced With |
|----------|--------------|
| `$ARGUMENTS` | Full user message string |
| `$USER_MESSAGE` | Alias for `$ARGUMENTS` |
| `$WORKFLOW_ID` | Workflow run UUID |
| `$ARTIFACTS_DIR` | Absolute path to run artifacts directory |
| `$BASE_BRANCH` | Base branch from config or auto-detected |
| `$CONTEXT` / `$EXTERNAL_CONTEXT` / `$ISSUE_CONTEXT` | GitHub issue/PR context (empty string if none) |
| `$PLAN` | Previous plan from session metadata |
| `$IMPLEMENTATION_SUMMARY` | Previous execution summary |

### Positional Variables (command handler)

| Variable | Replaced With |
|----------|--------------|
| `$1` through `$9` | Positional arguments split from user message |
| `$ARGUMENTS` | All arguments joined |
| `\$` | Literal `$` (escape) |

### DAG Node Output References

| Variable | Replaced With |
|----------|--------------|
| `$nodeId.output` | Full output string from completed node |
| `$nodeId.output.field` | JSON field value from structured output |

For bash node scripts, substituted values are shell-quoted for safety.

---

## Model Validation

Runs at load time. Invalid combinations fail workflow loading.

```
Claude models: 'sonnet', 'opus', 'haiku', 'inherit', or 'claude-*'
Codex models: anything NOT matching Claude patterns
```

Per-node overrides validated independently. If a node's model implies a provider (e.g., `'haiku'` → Claude), the provider is inferred.

---

## DAG Structural Validation

Four rules enforced at `loader.ts:370-439`:
1. **Unique IDs** — no duplicates
2. **Valid depends_on** — all referenced IDs must exist
3. **No cycles** — Kahn's algorithm; cycles fail with involved IDs
4. **Valid $nodeId.output references** — scanned in `when:` and `prompt:` fields

---

## Discovery & Loading

`discoverWorkflows(searchPaths, config)` in `loader.ts`:

1. Searches all paths recursively for `*.yaml` and `*.yml` files
2. Merges bundled defaults with repo-specific workflows (repo overrides by name)
3. One broken YAML doesn't abort discovery — errors returned in `WorkflowLoadResult.errors`
4. Opt-out: `defaults.loadDefaultWorkflows: false` in `.archon/config.yaml`

---

## Real Workflow Examples

| File | Mode | Key Features |
|------|------|-------------|
| `archon-feature-development.yaml` | `steps:` | Simple two-step sequential |
| `archon-plan-to-pr.yaml` | `steps:` | 11 steps with parallel review block |
| `archon-ralph-fresh.yaml` | `loop:` | `fresh_context: true`, `<promise>COMPLETE</promise>` |
| `archon-smart-pr-review.yaml` | `nodes:` | `output_format`, `when:`, `trigger_rule: one_success` |
| `archon-validate-pr.yaml` | `nodes:` | `idle_timeout: 1800000`, bash nodes, `trigger_rule: all_done` |
| `archon-fix-github-issue-dag.yaml` | `nodes:` | Full lifecycle with all DAG features |

---

## Key Files

| Concern | File |
|---------|------|
| Type definitions | `packages/workflows/src/types.ts` |
| YAML parsing + validation | `packages/workflows/src/loader.ts` |
| Steps + loop execution | `packages/workflows/src/executor.ts` |
| DAG execution | `packages/workflows/src/dag-executor.ts` |
| Condition evaluation | `packages/workflows/src/condition-evaluator.ts` |
| Model compatibility | `packages/workflows/src/model-validation.ts` |
| Variable substitution | `packages/workflows/src/utils/variable-substitution.ts` |
| Idle timeout | `packages/workflows/src/utils/idle-timeout.ts` |
| Router | `packages/workflows/src/router.ts` |
