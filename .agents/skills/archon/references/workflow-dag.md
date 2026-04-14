# Workflow Authoring For Codex

Archon workflows use a DAG format: nodes with explicit dependencies. This is a
shared Archon surface for both Claude and Codex, but some node fields behave
differently by provider.

## Schema

```yaml
name: my-workflow
description: What this workflow does

provider: codex                  # optional; 'claude' or 'codex'
model: gpt-5.4                   # optional model override

nodes:
  - id: first-node
    command: my-command
  - id: second-node
    prompt: "Use the output: $first-node.output"
    depends_on: [first-node]
```

## Seven Node Types

Each node must define exactly one of:

- `command`
- `prompt`
- `bash`
- `script`
- `loop`
- `approval`
- `cancel`

### Command Node

```yaml
- id: investigate
  command: investigate-issue
```

### Prompt Node

```yaml
- id: classify
  prompt: "Classify this issue: $ARGUMENTS"
```

### Bash Node

```yaml
- id: fetch-data
  bash: "gh issue view 42 --json title,body"
  timeout: 15000
```

### Script Node

```yaml
- id: summarize
  script: scripts/summarize_issue.py
  runtime: uv
  deps:
    - pyyaml
```

### Loop Node

```yaml
- id: implement
  loop:
    prompt: "Implement the next task. When complete: <promise>DONE</promise>"
    until: DONE
    max_iterations: 10
    fresh_context: true
    until_bash: "bun run test"
```

### Approval Node

```yaml
- id: approve-plan
  approval:
    message: "Approve the plan draft?"
    capture_response: true
    on_reject:
      prompt: "Revise the plan using this feedback: $REJECTION_REASON"
```

### Cancel Node

```yaml
- id: stop-run
  cancel: "Human rejected the proposal"
```

## Shared Node Fields

| Field | Description |
| --- | --- |
| `id` | unique node identifier |
| `depends_on` | upstream node IDs |
| `when` | condition expression |
| `trigger_rule` | join semantics for dependencies |
| `context` | `fresh` or `shared` assistant-session behavior |
| `idle_timeout` | per-node or per-iteration idle timeout |

## Provider-Aware Node Fields

These fields are shared and meaningful for Codex:

| Field | Codex status | Notes |
| --- | --- | --- |
| `provider` | supported | workflow-level or node-level |
| `model` | supported | workflow-level and node-level, including loop nodes |
| `output_format` | supported | structured output works on Codex |
| `retry` | supported except loop nodes | loop-node retry is still a hard error |

These fields are not Codex per-node parity features:

| Field | Codex status | Notes |
| --- | --- | --- |
| `hooks` | ignored | Claude-only node control |
| `mcp` | ignored per-node | Codex MCP is global, not node-local |
| `skills` | ignored per-node | Codex skill discovery is global or repo-level |
| `allowed_tools` | ignored | Claude-only node control |
| `denied_tools` | ignored | Claude-only node control |

## Workflow-Level Codex Fields

These are workflow-level controls, not node-level controls:

| Field | Codex status | Notes |
| --- | --- | --- |
| `interactive` | supported | workflow-level switch for approval delivery and interactive loop behavior |
| `modelReasoningEffort` | parsed but not runtime-effective per workflow | current execution still uses `assistants.codex.modelReasoningEffort` from Archon config |
| `webSearchMode` | parsed but not runtime-effective per workflow | current execution still uses `assistants.codex.webSearchMode` from Archon config |
| `additionalDirectories` | parsed but not runtime-effective per workflow | current execution still uses `assistants.codex.additionalDirectories` from Archon config |

## Conditions

Use `when:` for simple routing:

```yaml
- id: investigate
  command: investigate-bug
  depends_on: [classify]
  when: "$classify.output.issue_type == 'bug'"
```

Supported operators in workflow conditions remain the same regardless of
provider.

## Structured Output

Structured output is a real Codex-safe feature:

```yaml
- id: classify
  prompt: "Classify this issue"
  output_format:
    type: object
    properties:
      issue_type:
        type: string
        enum: [bug, feature]
    required: [issue_type]
```

This enables downstream references such as `$classify.output.issue_type`.

## Loop Notes

Loop nodes support:

- `loop.prompt`
- `until`
- `max_iterations`
- `fresh_context`
- `interactive`
- `gate_message`
- `until_bash`

Do not treat loop nodes as a place for advanced per-node Codex controls. Fields
such as `hooks`, `mcp`, `skills`, tool restrictions, and retry either do not
apply or are ignored.

## Approval And Cancel Notes

- `approval` pauses the workflow for human input
- `approval.on_reject.prompt` can use `$REJECTION_REASON`
- `approval.capture_response` preserves the reviewer response for downstream use
- `cancel` ends the workflow intentionally with a human-readable reason

## Resume On Failure

```bash
archon workflow run my-workflow --resume
```

Completed nodes are skipped on resume.

## Validation

Before treating a workflow as done, validate it:

```bash
archon validate workflows <name>
```

This checks YAML structure, dependency references, command existence, and
provider compatibility warnings.

## Authoring Rule For Codex

If a workflow depends on per-node hooks, per-node MCP, per-node skills, or
per-node tool restrictions, do not present it as Codex-safe. Use a Codex
variant or document the degraded behavior explicitly.

## Example

See `examples/dag-workflow.yaml` for a Codex-safe reference workflow that keeps
to shared or explicitly supported Codex surfaces.
