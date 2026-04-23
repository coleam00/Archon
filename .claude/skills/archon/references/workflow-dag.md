# Workflow Authoring

Archon workflows use a DAG (Directed Acyclic Graph) format: nodes with explicit dependency edges. Independent nodes run in parallel, conditions enable routing, and data flows between nodes via `$nodeId.output`. This is the only workflow format — there are no other workflow types.

## Schema

```yaml
# Required
name: my-workflow
description: What this workflow does

# Optional — workflow-level provider/model (inherited by all nodes)
provider: claude                    # 'claude' or 'codex' (default: from config)
model: sonnet                       # Model override

# Required — the nodes array
nodes:
  - id: node-name                   # Unique identifier
    prompt: "Inline AI prompt"      # OR command: name  OR bash: "script"  OR loop: {...}
    depends_on: [other-node]        # Node IDs that must complete first
```

## Node Types (Mutually Exclusive)

Each node must have exactly ONE of these fields: `command`, `prompt`, `bash`, `script`, `loop`, `approval`, or `cancel`.

### Command Node
Runs a command file from `.archon/commands/`:
```yaml
- id: investigate
  command: investigate-issue         # Loads .archon/commands/investigate-issue.md
```

### Prompt Node
Runs an inline AI prompt:
```yaml
- id: classify
  prompt: |
    Analyze this issue and classify it.
    Issue: $ARGUMENTS
```

### Bash Node
Runs a shell script without AI:
```yaml
- id: fetch-data
  bash: |
    gh issue view 123 --json title,body,labels
  timeout: 30000                    # ms, default: 120000 (2 min)
```

- Script runs via `bash -c`
- **stdout** captured as node output (available as `$fetch-data.output`)
- **stderr** forwarded as warning, does not fail the node
- No AI invoked — AI-specific fields are ignored
- Use `timeout:` (milliseconds) for execution time limit
- `$nodeId.output` substitutions are **auto shell-quoted** (safe to embed)

### Script Node
Runs TypeScript/JavaScript (via `bun`) or Python (via `uv`) without AI. Same stdout/stderr contract as bash nodes.

**Inline script (TypeScript):**
```yaml
- id: parse
  script: |
    const raw = process.argv.slice(2).join(' ') || '{}';
    const data = JSON.parse(raw);
    console.log(JSON.stringify({ items: data.items?.length ?? 0 }));
  runtime: bun                      # REQUIRED: 'bun' or 'uv'
  timeout: 30000                    # ms, default: 120000
```

**Inline script (Python) with uv dependencies:**
```yaml
- id: fetch
  script: |
    import httpx, json
    r = httpx.get("https://api.github.com/repos/anthropics/anthropic-cookbook")
    print(json.dumps({ "stars": r.json()["stargazers_count"] }))
  runtime: uv
  deps: ["httpx>=0.27"]             # Optional — 'uv run --with <dep>'. Ignored for bun.
```

**Named script from `.archon/scripts/`:**
```yaml
- id: analyze
  script: analyze-metrics           # Resolves .archon/scripts/analyze-metrics.py
  runtime: uv                       # Must match file extension (.ts/.js → bun, .py → uv)
  deps: ["pandas>=2.0"]
```

- **Inline vs named**: a `script` value is treated as inline code if it contains a newline or any shell metacharacter (space, or any of: `;` `(` `)` `{` `}` `&` `|` `<` `>` `$` `` ` `` `"` `'`). Otherwise it's a named-script lookup (bare identifier).
- **Named script resolution**: `<cwd>/.archon/scripts/` (wins) → `~/.archon/scripts/`. 1-level subfolder grouping allowed. Extension determines runtime (`.ts`/`.js` → `bun`, `.py` → `uv`) and MUST match the declared `runtime:`
- **Dispatch**:
  - `bun` + inline → `bun --no-env-file -e '<code>'`
  - `bun` + named → `bun --no-env-file run <path>`
  - `uv` + inline → `uv run [--with dep ...] python -c '<code>'`
  - `uv` + named → `uv run [--with dep ...] <path>`
- **`deps`** is uv-only. Bun auto-installs on import; `deps` with `runtime: bun` emits a validator warning
- **stdout** captured as `$nodeId.output` (trailing newline trimmed)
- **stderr** forwarded as warning, does NOT fail the node. Non-zero exit DOES fail it.
- **`bun --no-env-file`** prevents target repo `.env` from leaking into the subprocess
- `$nodeId.output` substitutions are **NOT shell-quoted** in script bodies — parse with `JSON.parse` / `json.loads`, don't interpolate into shell syntax
- AI-specific fields (`model`, `provider`, `hooks`, `mcp`, `skills`, `output_format`, `allowed_tools`, `denied_tools`, `agents`, `effort`, `thinking`, `maxBudgetUsd`, `systemPrompt`, `fallbackModel`, `betas`, `sandbox`) emit a loader warning and are ignored

### Loop Node
Iterates an AI prompt until a completion signal or max iterations:
```yaml
- id: implement
  depends_on: [setup]
  idle_timeout: 600000              # Per-iteration idle timeout (ms)
  loop:
    prompt: |
      Read the PRD and implement the next unfinished story.
      When all stories are done: <promise>COMPLETE</promise>
    until: COMPLETE                 # Completion signal string
    max_iterations: 10              # Hard limit — node fails if exceeded
    fresh_context: true             # true = fresh session each iteration
    until_bash: "bun run test"      # Optional: exit 0 = complete
```

See the dedicated **Loop Nodes** section below for full details.

## Node Base Fields

All node types share these fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | **required** | Unique node identifier |
| `depends_on` | string[] | `[]` | Node IDs that must settle before this node runs |
| `when` | string | — | Condition expression. Node **skipped** when false |
| `trigger_rule` | string | `all_success` | Join semantics for multiple dependencies |
| `idle_timeout` | number (ms) | 300000 | Idle timeout for AI streaming (`command`, `prompt`) and per-iteration idle for `loop`. Accepted but ignored on `bash` and `script` — use `timeout` there |

**Command, prompt, and bash nodes** (silently ignored on loop nodes, except `retry` which is a hard error):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | inherited | Per-node model override |
| `provider` | `claude` / `codex` | inherited | Per-node provider override |
| `context` | `fresh` / `shared` | — | `fresh` = new session; `shared` = inherit from prior node. Defaults to `fresh` for parallel layers, inherited for sequential |
| `output_format` | object | — | JSON Schema for structured output |
| `allowed_tools` | string[] | all | Tool whitelist. `[]` = disable all. Claude only |
| `denied_tools` | string[] | none | Tool blacklist. Claude only |
| `retry` | object | 2 retries, 3s | Retry config. **Hard error on loop nodes** |
| `hooks` | object | — | SDK hooks. Claude only. See `dag-advanced.md` |
| `mcp` | string | — | MCP config path. Claude only. See `dag-advanced.md` |
| `skills` | string[] | — | Skill names. Claude only. See `dag-advanced.md` |

## Dependencies and Parallel Execution

Nodes are grouped into topological layers. All nodes in the same layer run **concurrently**.

```yaml
nodes:
  # Layer 0 — run in parallel
  - id: fetch-issue
    bash: "gh issue view $ARGUMENTS --json title,body"
  - id: fetch-template
    bash: "cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null || echo 'None'"

  # Layer 1 — depends on layer 0
  - id: classify
    prompt: "Classify: $fetch-issue.output"
    depends_on: [fetch-issue]
```

## Trigger Rules

| Value | Behavior |
|-------|----------|
| `all_success` | ALL deps succeeded **(default)** |
| `one_success` | At least ONE dep succeeded |
| `none_failed_min_one_success` | No deps failed AND at least one succeeded (skipped OK) |
| `all_done` | All deps terminal (completed, failed, or skipped) |

## Conditions (`when:`)

```yaml
- id: investigate
  command: investigate-bug
  depends_on: [classify]
  when: "$classify.output.issue_type == 'bug'"
```

**Syntax**: `$nodeId.output OPERATOR 'value'` — operators: `==`, `!=` only. Values single-quoted. Invalid expressions skip the node (fail-closed).

## Node Output Substitution

```yaml
- id: analyze
  prompt: |
    Classification: $classify.output
    Type: $classify.output.issue_type
```

- `$nodeId.output` — full text output
- `$nodeId.output.field` — JSON field from structured output
- In bash scripts, values are auto **shell-quoted**
- Loop node output = **last iteration only**

## Structured Output (`output_format`)

Command/prompt nodes only:

```yaml
- id: classify
  prompt: "Classify: $ARGUMENTS"
  allowed_tools: []
  model: haiku
  output_format:
    type: object
    properties:
      issue_type:
        type: string
        enum: [bug, feature]
    required: [issue_type]
```

Enables `$classify.output.issue_type` field access. SDK-enforced on Claude and Codex; best-effort on Pi (schema is appended to the prompt and JSON is parsed out of the result text).

## Per-Node Provider and Model

Override on command/prompt nodes:

```yaml
nodes:
  - id: classify
    prompt: "Quick classification"
    model: haiku                    # Fast model
  - id: implement
    command: implement-changes      # Inherits workflow-level model
```

Loop nodes accept `provider`/`model` without error but ignore them at runtime.

## Resume on Failure

When a workflow fails, already-completed nodes are skipped on the next run:

```bash
archon workflow run my-workflow --resume
```

---

## Loop Nodes

Loop nodes iterate an AI prompt until a completion condition is met. Use them for autonomous multi-step work: implementing stories from a PRD, iterating until tests pass, or refining output.

### Configuration

```yaml
- id: my-loop
  loop:
    prompt: "..."              # Required. Sent each iteration
    until: COMPLETE            # Required. Completion signal
    max_iterations: 10         # Required. Integer >= 1. Fails if exceeded
    fresh_context: true        # Optional. Default: false
    until_bash: "..."          # Optional. Exit 0 = complete
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | Prompt template. Supports all variable substitution (`$ARGUMENTS`, `$nodeId.output`, etc.) |
| `until` | string | Yes | Completion signal to detect in AI output |
| `max_iterations` | number | Yes | Hard limit. Node **fails** if exceeded |
| `fresh_context` | boolean | No | Default `false`. `true` = fresh AI session each iteration |
| `until_bash` | string | No | Shell script run after each iteration. Exit 0 = complete |

### Completion Detection

Checked after each iteration:
1. **AI signal** — `<promise>SIGNAL</promise>` in output (recommended) or plain signal at end
2. **`until_bash`** — shell script exits 0

Either triggers completion. `<promise>` tags are stripped from output.

### Session Patterns

| `fresh_context` | Behavior | Best for |
|-----------------|----------|----------|
| `true` | Fresh session each iteration. No memory. State on disk. | Multi-story PRDs, long loops |
| `false` (default) | Sessions thread. AI remembers prior iterations. | Fix-iterate cycles, refinement |

First iteration is always fresh regardless.

### What Does NOT Work on Loop Nodes

- `retry` — **hard error** at parse time
- `hooks`, `mcp`, `skills`, `allowed_tools`, `denied_tools`, `output_format` — silently ignored
- `context: fresh` — ignored (use `loop.fresh_context` instead)
- `provider`, `model` — accepted but ignored at runtime

### Loop Output

`$nodeId.output` = last iteration's output only. Accumulate via files in `$ARTIFACTS_DIR`.

### Patterns

**Stateless (Ralph):**
```yaml
- id: implement
  depends_on: [setup]
  idle_timeout: 600000
  loop:
    prompt: |
      FRESH session — no memory. Read tracking file, implement next story,
      validate, commit. When done: <promise>COMPLETE</promise>
      Context: $setup.output
    until: COMPLETE
    max_iterations: 15
    fresh_context: true
```

**Test-fix cycle:**
```yaml
- id: fix-tests
  loop:
    prompt: "Run tests, fix failures. When passing: <promise>PASS</promise>"
    until: PASS
    max_iterations: 8
    until_bash: "bun run test"
    fresh_context: false
```

---

## Validate Before Finishing

Before declaring a workflow complete, validate it:

```bash
archon validate workflows <name>
```

Fix any errors and re-validate until the command returns clean. This checks:
- YAML syntax and required fields
- DAG structure (cycles, missing dependencies, invalid `$nodeId.output` refs)
- All `command:` files exist on disk
- All `mcp:` config files exist and contain valid JSON
- All `skills:` directories exist

Use `--json` for machine-readable output. Use `archon validate commands <name>` to validate individual command files.

## Validation Rules (Load Time)

- All node IDs unique
- All `depends_on` reference existing IDs
- No cycles
- `$nodeId.output` refs in `when:`, `prompt:`, `loop.prompt:` must point to known IDs
- Exactly one of `command`, `prompt`, `bash`, `script`, `loop`, `approval`, `cancel` per node
- Script nodes require `runtime: bun` or `runtime: uv`
- Named scripts must exist in `.archon/scripts/` or `~/.archon/scripts/` with extension matching declared runtime
- `retry` on loop node = hard error
- `steps:` format rejected (deprecated — use `nodes:` only)

## Complete Example

```yaml
name: classify-and-fix
description: Classify a GitHub issue, then route to the appropriate handler

nodes:
  - id: fetch-issue
    bash: "gh issue view $ARGUMENTS --json title,body,labels"
    timeout: 15000

  - id: classify
    prompt: "Classify this issue: $fetch-issue.output"
    depends_on: [fetch-issue]
    model: haiku
    allowed_tools: []
    output_format:
      type: object
      properties:
        issue_type:
          type: string
          enum: [bug, feature]
      required: [issue_type]

  - id: investigate
    command: investigate-bug
    depends_on: [classify]
    when: "$classify.output.issue_type == 'bug'"
    context: fresh

  - id: plan
    command: plan-feature
    depends_on: [classify]
    when: "$classify.output.issue_type == 'feature'"
    context: fresh

  - id: implement
    command: implement-changes
    depends_on: [investigate, plan]
    trigger_rule: one_success
    context: fresh

  - id: create-pr
    command: create-pull-request
    depends_on: [implement]
    context: fresh
```
