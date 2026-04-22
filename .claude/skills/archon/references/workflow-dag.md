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

## Workflow-Level Fields

Top-level YAML fields on a workflow object. Per-node overrides (same name under a node) win over workflow-level defaults.

### Core

| Field | Type | Description |
|-------|------|-------------|
| `name` | string (required) | Workflow identifier (used in `archon workflow run <name>`) |
| `description` | string (required) | Human-readable summary. Used for routing; see **Workflow Description Best Practices** in `docs-web/.../authoring-workflows.md` |
| `provider` | string | AI provider (e.g. `claude`, `codex`, `pi`). Default: from `.archon/config.yaml` |
| `model` | string | Model override. Claude: `sonnet` \| `opus` \| `haiku` \| `claude-*` \| `inherit`. Codex: any non-Claude model ID |
| `interactive` | boolean | **Required for web UI** when the workflow has approval gates or `loop.interactive` nodes. Forces foreground execution so gate messages reach the user's chat. Default: `false` (background on web) |

### Isolation

| Field | Type | Description |
|-------|------|-------------|
| `worktree.enabled` | boolean | Pin isolation regardless of caller. `false` = always live checkout (CLI `--branch`/`--from` hard-error). `true` = always worktree (CLI `--no-worktree` hard-errors). Omit = caller decides. Use `false` for read-only workflows (triage, reporting) |

Other worktree config (`baseBranch`, `copyFiles`, `initSubmodules`, `path`) lives in `.archon/config.yaml`, not the workflow YAML — see `references/repo-init.md`.

### Claude SDK Advanced Options

These fields apply to Claude nodes workflow-wide; each can be overridden per-node. Codex nodes ignore them with a warning.

| Field | Type | Description |
|-------|------|-------------|
| `effort` | `'low'` \| `'medium'` \| `'high'` \| `'max'` | Claude Agent SDK reasoning depth. Different from Codex `modelReasoningEffort` below |
| `thinking` | string \| object | Extended thinking. String shorthand: `'adaptive'` \| `'enabled'` \| `'disabled'`. Object form: `{ type: 'enabled', budgetTokens: 8000 }` |
| `fallbackModel` | string | Model to use if the primary model fails (e.g. `claude-haiku-4-5-20251001`) |
| `betas` | string[] | SDK beta feature flags (non-empty array). Example: `['context-1m-2025-08-07']` for 1M-context Claude |
| `sandbox` | object | OS-level filesystem/network restrictions. Nested `network` / `filesystem` sub-objects — see the docs site for the full schema. Layers on top of worktree isolation |

Per-node-only (NOT valid at workflow level): `maxBudgetUsd`, `systemPrompt`.

### Codex-Specific Options

| Field | Type | Description |
|-------|------|-------------|
| `modelReasoningEffort` | `'minimal'` \| `'low'` \| `'medium'` \| `'high'` \| `'xhigh'` | Codex reasoning depth. Separate field from Claude's `effort` |
| `webSearchMode` | `'disabled'` \| `'cached'` \| `'live'` | Codex web search behavior. Default: `disabled` |
| `additionalDirectories` | string[] | Absolute paths Codex can read outside the codebase (shared libraries, docs repos) |

### Complete workflow-level example

```yaml
name: careful-migration
description: |
  Plan a migration, get explicit approval, then implement under strict
  sandbox and cost limits. Used by the ops team before destructive work.
provider: claude
model: sonnet
interactive: true                   # required — this workflow has an approval gate

worktree:
  enabled: true                     # always isolate; reject --no-worktree

effort: high
thinking: adaptive
fallbackModel: claude-haiku-4-5-20251001
betas: ['context-1m-2025-08-07']
sandbox:
  enabled: true
  network:
    allowedDomains: ['api.github.com']
    allowManagedDomainsOnly: true
  filesystem:
    denyWrite: ['/etc', '/usr']

nodes:
  - id: plan
    command: plan-migration
  - id: review
    approval:
      message: "Review the migration plan above."
    depends_on: [plan]
  - id: implement
    command: implement-migration
    depends_on: [review]
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

Gate whether a node runs based on upstream output. A condition that evaluates to `false` skips the node (fail-closed — skipped nodes propagate their skipped state to dependants).

### Operators

**String comparison** (literal string equality):
```yaml
when: "$nodeId.output == 'VALUE'"
when: "$nodeId.output != 'VALUE'"
when: "$nodeId.output.field == 'VALUE'"       # JSON dot notation (requires output_format)
```

**Numeric comparison** (both sides auto-parsed as numbers; fail-closed if either side is not finite):
```yaml
when: "$score.output > '80'"
when: "$score.output >= '0.9'"
when: "$score.output < '100'"
when: "$score.output <= '5'"
when: "$score.output.confidence >= '0.9'"
```

All six operators — `==`, `!=`, `<`, `>`, `<=`, `>=` — are supported. Values are single-quoted strings (even for numeric comparisons).

### Compound Expressions

Combine conditions with `&&` (AND) and `||` (OR). **`&&` binds tighter than `||`.** No parentheses supported — structure expressions with that precedence in mind.

```yaml
when: "$a.output == 'X' && $b.output != 'Y'"
when: "$a.output == 'X' || $b.output == 'Y'"
when: "$score.output > '80' && $flag.output == 'true'"

# Precedence: (A && B) || C
when: "$a.output == 'X' && $b.output == 'Y' || $c.output == 'Z'"
```

Short-circuit evaluation: `&&` stops at the first false, `||` stops at the first true.

### Dot Notation (JSON Field Access)

`$nodeId.output.field` parses the upstream output as JSON and extracts the named field. Returns empty string if parsing fails or the field is absent — which then fails-closed against any literal value. Requires the upstream node to have `output_format` set (for AI nodes) or to print valid JSON (for bash/script nodes).

### Fail-Closed Rules

- Invalid or unparseable expression → node skipped, warning logged
- Numeric operator with a non-numeric side → node skipped
- `$nodeId.output.field` on non-JSON output → field is empty → comparison fails
- Referenced node did not run (skipped upstream) → substitution is empty → comparison fails

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
    interactive: true          # Optional. Pauses between iterations for user input
    gate_message: "..."        # Required when interactive: true
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | Prompt template. Supports all variable substitution (`$ARGUMENTS`, `$nodeId.output`, `$LOOP_USER_INPUT`, etc.) |
| `until` | string | Yes | Completion signal to detect in AI output |
| `max_iterations` | number | Yes | Hard limit. Node **fails** if exceeded |
| `fresh_context` | boolean | No | Default `false`. `true` = fresh AI session each iteration |
| `until_bash` | string | No | Shell script run after each iteration. Exit 0 = complete. Variable substitution applies; `$nodeId.output` IS shell-quoted here |
| `interactive` | boolean | No | Default `false`. `true` = pause after each non-completing iteration for user feedback via `/workflow approve <id> <text>` |
| `gate_message` | string | **Required when `interactive: true`** | Message shown to the user at each pause. Validated at parse time — a loop with `interactive: true` and no `gate_message` fails to load |

### Interactive Loops

Interactive loops pause between iterations so a human can provide feedback that feeds the next iteration. Use them for guided writing/refinement (e.g. PRD co-authoring, iterative design).

```yaml
name: guided-refine
description: Refine an output with human feedback between iterations
interactive: true                # REQUIRED at the workflow level for web UI

nodes:
  - id: refine
    loop:
      prompt: |
        Review the current draft and improve it based on this feedback:
        $LOOP_USER_INPUT

        When the output is satisfactory, output: <promise>DONE</promise>
      until: DONE
      max_iterations: 5
      interactive: true          # node level — enables the pause
      gate_message: |
        Review the output above. Reply with feedback, or type DONE to finish.
```

The flow:
1. Iteration N runs. AI produces output.
2. If AI signalled completion (`<promise>DONE</promise>`) or `until_bash` exited 0, loop ends.
3. Otherwise: `gate_message` is sent to the user, workflow pauses (status = `paused`).
4. User runs `archon workflow approve <run-id> "<their feedback>"` (or replies naturally in chat platforms).
5. Iteration N+1 runs with `$LOOP_USER_INPUT` substituted to the user's feedback — but **only on that first resumed iteration**. Subsequent iterations in the same resumed session see `$LOOP_USER_INPUT` as empty string.
6. Repeat.

**Workflow-level `interactive: true` is required** for the gate message to reach the user on the web UI (otherwise the workflow dispatches to a background worker that can't deliver chat messages). The loader emits a warning if a node has `interactive: true` without workflow-level `interactive: true`.

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

## Approval Nodes

Approval nodes **pause the workflow** until a human approves or rejects the gate. Use them to insert review steps between AI-driven nodes — for example, reviewing a generated plan before committing to expensive implementation work.

### Configuration

```yaml
- id: review-gate
  approval:
    message: "Review the plan above before proceeding with implementation."
    capture_response: false        # Optional. true = user's comment stored as $review-gate.output
    on_reject:                     # Optional. AI rework on rejection instead of cancel
      prompt: "Revise based on feedback: $REJECTION_REASON"
      max_attempts: 3              # Range 1–10, default 3. After max, workflow is cancelled.
  depends_on: [plan]
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `approval.message` | **Yes** | The message shown to the user when the workflow pauses |
| `approval.capture_response` | No | `true` = user's approval comment stored as `$<node-id>.output` for downstream nodes. Default: `false` (downstream `$<node-id>.output` is empty string) |
| `approval.on_reject.prompt` | No | Prompt run via AI when the user rejects. `$REJECTION_REASON` is substituted with the reject reason. After running, the workflow re-pauses at the same gate |
| `approval.on_reject.max_attempts` | No | Max times the on_reject prompt runs before the workflow is cancelled. Range: 1–10. Default: 3 |

### Web UI Requirement

Approval gates delivered on the Web UI require `interactive: true` at the **workflow level** — otherwise the workflow dispatches to a background worker and the gate message never reaches the user's chat window.

```yaml
name: plan-approve-implement
interactive: true   # REQUIRED for approval gates on web UI
nodes:
  - id: plan
    command: plan-feature
  - id: review-gate
    approval:
      message: "Approve the plan to proceed."
    depends_on: [plan]
  - id: implement
    command: implement
    depends_on: [review-gate]
```

### Approve and Reject Commands

```bash
# From the CLI
archon workflow approve <run-id>
archon workflow approve <run-id> --comment "looks good"
archon workflow reject <run-id>
archon workflow reject <run-id> --reason "plan needs more test coverage"

# Cross-platform (Slack / Telegram / Web / GitHub chat)
/workflow approve <run-id> <optional comment>
/workflow reject <run-id> <optional reason>

# Natural language (all platforms except CLI — auto-detects paused workflow)
User: "Looks good, proceed"
# → auto-approves. With capture_response: true, the message becomes $review-gate.output
```

### What Does NOT Work on Approval Nodes

AI-specific fields (`model`, `provider`, `hooks`, `mcp`, `skills`, `output_format`, `allowed_tools`, `denied_tools`, `context`, `effort`, `thinking`, etc.) are accepted by the parser but emit a loader warning and are ignored — no AI runs during the pause. (Note: `on_reject.prompt` DOES run AI, using the workflow's default provider/model.)

`retry`, `when`, `trigger_rule`, `depends_on`, `idle_timeout` all work.

---

## Cancel Nodes

Cancel nodes **terminate the workflow run** with a reason string. Useful for guarded exits — a `cancel:` node with a `when:` condition stops the workflow cleanly when preconditions aren't met.

### Configuration

```yaml
- id: gate-branch
  cancel: "Refusing to run on main — this workflow modifies files."
  when: "$check-branch.output == 'main'"
  depends_on: [check-branch]
```

When a cancel node runs, Archon:
- Marks the workflow run as `cancelled` (not `failed`)
- Stops in-flight parallel nodes via the existing cancellation plumbing
- Records the reason string in the run's metadata
- Emits a `node_completed` event for the cancel node itself

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `cancel` | **Yes** | Non-empty reason string shown to the user and recorded in metadata |

Standard DAG fields (`id`, `depends_on`, `when`, `trigger_rule`, `idle_timeout`) all work. AI-specific fields emit a loader warning and are ignored — cancel nodes don't invoke AI.

### When to use `cancel` vs failing a `bash:` check

- **Use `cancel:`** when the precondition failure is **expected** (e.g., wrong branch, required file missing, feature flag disabled). The run shows as `cancelled`, which doesn't trigger the DAG auto-resume path.
- **Use a `bash:` node that exits non-zero** when the check itself fails (e.g., network error, tool missing). The run shows as `failed`, which auto-resumes on the next invocation.

### Typical Patterns

**Gate on upstream classification:**
```yaml
- id: classify
  prompt: "Is the input safe to proceed? Output 'SAFE' or 'UNSAFE'."
  allowed_tools: []

- id: stop-if-unsafe
  cancel: "Refusing to proceed: input flagged UNSAFE by classifier."
  depends_on: [classify]
  when: "$classify.output != 'SAFE'"

- id: do-work
  command: the-work
  depends_on: [classify]
  when: "$classify.output == 'SAFE'"
```

**Stop before expensive step unless precondition met:**
```yaml
- id: check-budget
  bash: |
    spent=$(gh api /meta --jq '.rate.used // 0')
    echo "$spent"

- id: abort-if-over
  cancel: "Aborting — GH API quota exhausted."
  depends_on: [check-budget]
  when: "$check-budget.output > '4500'"

- id: run-api-heavy-work
  command: heavy-work
  depends_on: [check-budget]
  when: "$check-budget.output <= '4500'"
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
- `approval.message` required and non-empty
- `cancel` reason required and non-empty
- Approval `on_reject.max_attempts` must be 1–10 if set
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
