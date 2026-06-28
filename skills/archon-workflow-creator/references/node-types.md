# Node Types

## Table of Contents

- Common node fields
- Prompt nodes
- Command nodes
- Bash nodes
- Script nodes
- Loop nodes
- Route-loop nodes
- Approval nodes
- Cancel nodes
- Conditions and trigger rules
- Retry, hooks, MCP, skills, and agents

## Common Node Fields

Every node requires `id`.
Node IDs must match `[A-Za-z_][A-Za-z0-9_-]{0,63}`.
Node IDs must not be `__proto__`, `prototype`, or `constructor`.
Prefer lowercase kebab-case even though the schema allows more.

Each node must define exactly one action key:

- `prompt`
- `command`
- `bash`
- `script`
- `loop`
- `route_loop`
- `approval`
- `cancel`

Common fields:

| Field          | Applies to                                | Notes                                                |
| -------------- | ----------------------------------------- | ---------------------------------------------------- |
| `depends_on`   | all nodes                                 | Array of upstream node IDs.                          |
| `when`         | most nodes except `route_loop`            | Conditional expression evaluated after dependencies. |
| `trigger_rule` | most nodes except `route_loop`            | Defaults to `all_success`.                           |
| `retry`        | most nodes except `loop` and `route_loop` | Retries transient or all errors.                     |
| `idle_timeout` | AI and loop nodes                         | Milliseconds without output before timeout handling. |
| `always_run`   | all nodes                                 | Opt out of resume skip caching.                      |
| `output_type`  | all nodes                                 | Writes typed sidecar artifact under run artifacts.   |

AI-oriented fields:

| Field             | Notes                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| `provider`        | Node-level provider override.                                                        |
| `model`           | Node-level model override.                                                           |
| `context`         | `fresh` or `shared`; `fresh` disables session inheritance and cross-run persistence. |
| `output_format`   | JSON Schema for structured output.                                                   |
| `allowed_tools`   | Tool allowlist; use `[]` for no tools.                                               |
| `denied_tools`    | Tool denylist.                                                                       |
| `mcp`             | Path to MCP JSON config.                                                             |
| `hooks`           | Static provider hook responses.                                                      |
| `skills`          | Skill names available to supporting providers.                                       |
| `agents`          | Inline sub-agent definitions for supporting providers.                               |
| `effort`          | `low`, `medium`, `high`, `max`.                                                      |
| `thinking`        | Claude-style thinking config.                                                        |
| `maxBudgetUsd`    | Claude cost cap.                                                                     |
| `systemPrompt`    | Non-empty system prompt string.                                                      |
| `fallbackModel`   | Claude fallback model.                                                               |
| `betas`           | Non-empty Claude beta header list.                                                   |
| `sandbox`         | Claude sandbox settings.                                                             |
| `persist_session` | Cross-run node session persistence for eligible AI nodes.                            |

AI-oriented fields on bash and script nodes are stripped or ignored.
AI-oriented fields on loop nodes are mostly ignored except `provider` and `model`.

## Prompt Nodes

Use a prompt node for inline AI work.
Use it for classification, investigation, synthesis, code changes, PR creation, or report writing.

```yaml
- id: classify
  prompt: |
    Classify this request: $ARGUMENTS
  model: small
  allowed_tools: []
  output_format:
    type: object
    properties:
      kind:
        type: string
        enum: [bug, feature, question]
    required: [kind]
```

Prompt nodes can use every AI-oriented field.
Use `context: fresh` when the node must not inherit prior sequential AI context.

## Command Nodes

Use a command node when the prompt should live in `.archon/commands/<name>.md`.
The `command` value is a command name without `.md`.

```yaml
- id: implement
  command: archon-implement
  model: large
  depends_on: [plan]
  context: fresh
```

Command nodes use the same AI-oriented fields as prompt nodes.
Use command files for reusable, long, or independently validated prompts.

## Bash Nodes

Use a bash node for deterministic shell work with no AI call.
Stdout becomes `$nodeId.output`.
Stderr is surfaced as a warning.
Default timeout is 120000 ms.

```yaml
- id: inspect
  bash: |
    set -euo pipefail
    git status --short
  timeout: 60000
```

Use bash for simple git checks, package commands, file existence checks, and glue logic.
Avoid complex JSON transforms in bash.
Use a script node instead.

Do not double-quote `$node.output` references in bash bodies.
Archon injects those substitutions already quoted.

Correct:

```yaml
bash: |
  status=$classify.output.kind
  printf 'status=%s\n' "$status"
```

Risky:

```yaml
bash: |
  status="$classify.output.kind"
```

## Script Nodes

Use a script node for deterministic TypeScript, JavaScript, or Python.
Script nodes have no AI call.
Stdout becomes `$nodeId.output`.
Stderr is surfaced as a warning.
Default timeout is 120000 ms.

Required fields:

| Field     | Values                       |
| --------- | ---------------------------- |
| `script`  | Inline code or named script. |
| `runtime` | `bun` or `uv`.               |

Optional fields:

| Field     | Notes                                                                     |
| --------- | ------------------------------------------------------------------------- |
| `deps`    | Dependency list for `uv` inline or named Python scripts; ignored for Bun. |
| `timeout` | Positive timeout in milliseconds.                                         |

Inline Bun:

```yaml
- id: parse
  script: |
    const input = $classify.output;
    console.log(JSON.stringify({ kind: input.kind.toUpperCase() }));
  runtime: bun
```

Inline Python:

```yaml
- id: parse-python
  script: |
    import json
    data = json.loads("""$classify.output""")
    print(json.dumps({"kind": data["kind"].upper()}))
  runtime: uv
  deps: []
```

Named script:

```yaml
- id: summarize
  script: summarize-run
  runtime: bun
  timeout: 30000
```

Named scripts resolve from `.archon/scripts/` or `~/.archon/scripts/`.
The validator expects `runtime` to match the discovered script extension.

## Loop Nodes

Use a loop node when an AI task must repeat until it emits a completion signal or a deterministic bash check passes.
Loop nodes manage their own per-iteration AI sessions.
`retry` is not supported on loop nodes.

```yaml
- id: refine
  loop:
    prompt: |
      Improve the plan.
      Original request: $ARGUMENTS
      Previous output: $LOOP_PREV_OUTPUT
      User feedback: $LOOP_USER_INPUT
      Emit PLAN_READY only when complete.
    until: PLAN_READY
    max_iterations: 5
    fresh_context: false
```

Loop config fields:

| Field            | Required         | Meaning                                                  |
| ---------------- | ---------------- | -------------------------------------------------------- |
| `prompt`         | yes              | Prompt repeated each iteration.                          |
| `until`          | yes              | Completion signal string detected in AI output.          |
| `max_iterations` | yes              | Positive integer.                                        |
| `fresh_context`  | no               | Start each iteration fresh; defaults to false.           |
| `until_bash`     | no               | Bash command run after each iteration; exit 0 completes. |
| `interactive`    | no               | Pause between iterations for user input.                 |
| `gate_message`   | when interactive | Message shown at pause.                                  |

Interactive loop:

```yaml
- id: explore
  loop:
    prompt: |
      Discuss the request.
      Latest user input: $LOOP_USER_INPUT
      Emit READY_TO_PLAN only when the user explicitly says ready.
    until: READY_TO_PLAN
    max_iterations: 10
    interactive: true
    gate_message: 'Reply with more details or say ready.'
```

Set root `interactive: true` when using interactive loops from user-facing surfaces.

## Route-loop Nodes

Use `route_loop` for deterministic routing after a review or check node.
It chooses one of three target nodes: `positive`, `negative`, or `exhausted`.
It is different from a normal loop because it reruns a DAG path rather than repeating a single prompt.

Required structure:

```yaml
- id: review
  depends_on: [fix]
  prompt: |
    Review the fix and return JSON.
  output_format:
    type: object
    properties:
      result:
        type: string
        enum: [positive, negative]
    required: [result]

- id: review-router
  depends_on: [review]
  route_loop:
    from: review
    condition: "$review.output.result == 'positive'"
    max_iterations: 3
    routes:
      positive: done
      negative: fix
      exhausted: escalation
```

Route-loop validation rules:

- The route-loop node must declare exactly one `depends_on`.
- That dependency must equal `route_loop.from`.
- `route_loop.from` must reference an existing node.
- The `from` node must not declare `when`.
- Route targets must exist.
- A route target must not be the route-loop node itself.
- `positive` and `exhausted` routes must be exit paths.
- `negative` can route back to the rerun path.
- If the negative rerun path has dependencies, they must be self-contained inside that path.
- `when`, `trigger_rule`, and `retry` are not supported on the route-loop node.
- `route_loop.condition` may only reference the `from` node.
- Field references in `condition` require the `from` node to declare `output_format.properties`.

Route-loop condition supports the same atom grammar as `when`.
Use field references for robust routing.

## Approval Nodes

Use approval nodes for human-in-the-loop gates.
Approval nodes pause the workflow.
On approval, the node completes and later nodes can continue.

```yaml
- id: approve-plan
  approval:
    message: |
      Review the generated plan:
      $plan.output
    capture_response: true
  depends_on: [plan]
```

Approval config:

| Field                    | Meaning                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `message`                | Required non-empty message shown to the user.                   |
| `capture_response`       | When true, approval text becomes node output.                   |
| `on_reject.prompt`       | AI prompt to run after rejection before showing the gate again. |
| `on_reject.max_attempts` | Integer 1 through 10; defaults to 3.                            |

Rejection prompt example:

```yaml
approval:
  message: 'Approve the plan.'
  capture_response: true
  on_reject:
    prompt: |
      The reviewer rejected the plan for this reason:
      $REJECTION_REASON
      Revise the plan and summarize changes.
    max_attempts: 3
```

Set root `interactive: true` when using approval nodes from user-facing surfaces.

## Cancel Nodes

Use cancel nodes to terminate the workflow with a reason.
The reason supports `$node.output` substitution.

```yaml
- id: abort-if-invalid
  cancel: |
    Preconditions failed.
    Details: $preflight.output
  depends_on: [preflight]
  when: '$preflight.output.ok == false'
```

Cancel nodes can use `depends_on`, `when`, `trigger_rule`, and `retry`.
They do not call an AI provider.

## Conditions and Trigger Rules

`when` expressions support:

- `$node.output == 'text'`
- `$node.output.field == 'value'`
- `$node.field == 'value'` as shorthand for `$node.output.field`
- `==`, `!=`, `<`, `<=`, `>`, `>=`
- quoted string right-hand values
- unquoted numeric and boolean right-hand values
- `&&` and `||` without parentheses

Malformed `when` expressions fail closed and skip the node.
Unresolvable field references throw and fail the consuming node.

Trigger rules:

| Rule                          | Runs when                                      |
| ----------------------------- | ---------------------------------------------- |
| `all_success`                 | All dependencies completed.                    |
| `one_success`                 | At least one dependency completed.             |
| `none_failed_min_one_success` | At least one completed and none failed.        |
| `all_done`                    | Dependencies are no longer pending or running. |

Use `all_done` for cleanup, reporting, and final summaries that must run after failures or skips.

## Retry, Hooks, MCP, Skills, and Agents

Retry config:

```yaml
retry:
  max_attempts: 2
  delay_ms: 5000
  on_error: transient
```

`max_attempts` is 1 through 5 and does not include the initial attempt.
`delay_ms` is 1000 through 60000.
`on_error` is `transient` or `all`.
Fatal errors are not retried.

Hooks are keyed by provider hook event name:

```yaml
hooks:
  PreToolUse:
    - matcher: 'Bash'
      response:
        hookSpecificOutput:
          hookEventName: PreToolUse
          permissionDecision: deny
          permissionDecisionReason: 'No shell access here'
```

Supported hook event keys include `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, `Setup`, `TeammateIdle`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, and `InstructionsLoaded`.

MCP config:

```yaml
mcp: .archon/mcp/github.json
```

The file must exist and be valid JSON object.

Skills:

```yaml
skills:
  - bmad-code-review
```

Archon validates skill names against `.claude/skills/<name>/SKILL.md` and `~/.claude/skills/<name>/SKILL.md`.

Inline agents:

```yaml
agents:
  brief-gen:
    description: 'Create a concise issue brief.'
    prompt: 'Return JSON only.'
    model: haiku
    tools: [Bash, Read]
    skills: []
    maxTurns: 3
```

Agent IDs must be kebab-case with lowercase letters, digits, and hyphens.
Each agent requires `description` and `prompt`.
Avoid using `dag-node-skills` as an agent ID because Archon reserves it for the skills wrapper.
