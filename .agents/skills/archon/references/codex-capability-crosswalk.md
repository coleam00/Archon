# Codex Capability Crosswalk For Archon

Use this document when the question is not "how do I write workflow YAML?" but
"what actually survives the Claude-to-Codex translation?"

This is a capability crosswalk, not a feature-sales guide. Treat it as the
truth table for Codex-safe Archon authoring.

## Crosswalk

| Feature | Claude in workflow YAML | Codex in workflow YAML | Codex real surface | Meaning |
| --- | --- | --- | --- | --- |
| `provider` | supported | supported | workflow or node field | real parity |
| `model` | supported | supported | workflow or node field | real parity, including loop node provider/model overrides |
| `output_format` | supported | supported | workflow YAML | real parity with structured-output caveats |
| `retry` | supported | supported | workflow YAML | real parity except loop-node retry stays invalid |
| `hooks` | supported per-node | ignored | none | no parity |
| `mcp` | supported per-node | ignored per-node | Codex global config | global-only, not equivalent |
| `skills` | supported per-node | ignored per-node | global or repo `.agents/skills/` | global/repo discovery, not equivalent |
| `allowed_tools` | supported per-node | ignored | Codex config / MCP config | global-only, not equivalent |
| `denied_tools` | supported per-node | ignored | Codex config / MCP config | global-only, not equivalent |
| `modelReasoningEffort` | not the same field | supported for Codex | command/prompt node, workflow YAML, or Archon config | command/prompt node override with workflow/config fallback; loop nodes stay workflow-level |
| `webSearchMode` | not the same field | supported for Codex | workflow YAML or Archon config | workflow-level override with config fallback |
| `additionalDirectories` | not the same field | supported for Codex | workflow YAML or Archon config | workflow-level override with config fallback |

## Feature Notes

### `provider` and `model`

These are real workflow controls for Codex.

- node-level `provider` and `model` overrides are honored for normal nodes
- loop nodes also resolve and pass node-level `provider` and `model` overrides
  into loop execution

That means the parity boundary is not "loops ignore model overrides." The real
boundary is in Claude-only controls such as hooks, per-node MCP, per-node
skills, and node-level tool restrictions.

### `output_format`

This is real Codex parity, not a degraded fallback.

Archon maps workflow `output_format:` to the Codex client's structured-output
path. Downstream field references such as `$node.output.field` are valid when
Codex returns structured output as expected.

Operational nuance:

- if Codex returns non-JSON output, Archon warns that field-based downstream
  conditions may misbehave
- this is still a supported feature, but not a promise that every prompt will
  always produce clean structured output

### `retry`

This remains a shared workflow feature for command, prompt, and bash nodes.
Loop-node retry is still not valid.

### `modelReasoningEffort`, `webSearchMode`, and `additionalDirectories`

These are real Codex tuning fields, but they do not all resolve at the same
scope.

`modelReasoningEffort` is node-capable for normal Codex AI nodes:

- `command` and `prompt` nodes can override `modelReasoningEffort`
- if a `command` or `prompt` node omits it, execution falls back to workflow
  `modelReasoningEffort`
- if the workflow omits it, execution falls back to
  `config.assistants.codex.modelReasoningEffort`
- loop nodes do not get node-level reasoning support in this slice; they stay
  on the workflow/config path

Current `modelReasoningEffort` precedence for Codex:

1. `command` or `prompt` node
2. workflow YAML
3. `config.assistants.codex.modelReasoningEffort`
4. SDK defaults

`webSearchMode` and `additionalDirectories` remain workflow-level controls:

- if the workflow sets them, execution uses the workflow value
- if the workflow omits them, execution falls back to
  `config.assistants.codex.*`
- normal nodes and loop nodes do not get per-node overrides for either field

Current `webSearchMode` and `additionalDirectories` precedence:

1. workflow YAML
2. `config.assistants.codex.*`
3. SDK defaults

Archon config still matters as the default source when the workflow does not
set these fields:

- `assistants.codex.modelReasoningEffort`
- `assistants.codex.webSearchMode`
- `assistants.codex.additionalDirectories`

### `hooks`

There is no Codex node-level equivalent in Archon. If a workflow depends on
hooks for guardrails or tool interception, do not call it Codex-safe.

### `mcp`

Important distinction:

- Claude: `mcp:` is a node-level workflow surface
- Codex: Archon ignores `mcp:` on a node

For Codex, MCP belongs in Codex configuration rather than workflow YAML. That
means the workflow cannot assume one node has one MCP setup and another node has
a different one in the same fine-grained way.

### `skills`

Important distinction:

- Claude: `skills:` is a node-level workflow surface
- Codex: Archon ignores `skills:` on a node

Codex skill discovery is global or repo-local, not a workflow node isolation
mechanism.

### `allowed_tools` and `denied_tools`

These are Claude node-level controls. Archon warns and ignores them on Codex.

If the desired effect is tool restriction for Codex, that belongs in Codex's
own configuration surface, not in Archon workflow YAML as a per-node contract.

## Codex Global Surfaces That Are Real

These are real Codex-side configuration surfaces even though they are not node
parity features:

- global or repo skill discovery under `.agents/skills/`
- Codex MCP configuration in Codex config
- Codex assistant defaults in Archon config:
  - `assistants.codex.model`
  - `assistants.codex.modelReasoningEffort`
  - `assistants.codex.webSearchMode`
  - `assistants.codex.additionalDirectories`
  - `assistants.codex.codexBinaryPath`

## Authoring Rules

1. If a workflow depends on per-node hooks, per-node MCP, per-node skills, or
   per-node tool restrictions, do not present it as Codex-safe.
2. If Codex has a global-only equivalent, document that boundary explicitly.
3. Prefer a dedicated `-codex` workflow when the original workflow depends on
   Claude-oriented node controls.
4. Treat this crosswalk as code-backed contract, not as an aspirational parity
   promise.
