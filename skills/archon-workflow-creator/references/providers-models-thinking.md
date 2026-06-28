# Providers, Models, and Thinking

## Table of Contents

- Provider IDs
- Provider capabilities
- Config locations
- Model references
- Built-in tier defaults
- Provider-specific model and thinking guidance
- Tool and structured-output guidance

## Provider IDs

Common registered provider IDs in this Archon version:

- `claude`
- `codex`
- `pi`
- `opencode`
- `copilot`

Provider identity is validated at workflow load time.
Model strings are not validated by Archon and pass through to provider SDKs.
Always run local validation because community providers can change.

## Provider Capabilities

| Provider   | Session resume | MCP | Hooks | Skills               | Agents | Tool restrictions | Structured output | Effort or thinking                      |
| ---------- | -------------- | --- | ----- | -------------------- | ------ | ----------------- | ----------------- | --------------------------------------- |
| `claude`   | yes            | yes | yes   | yes                  | yes    | yes               | enforced          | yes                                     |
| `codex`    | yes            | yes | no    | filesystem discovery | no     | no                | enforced          | through assistant config or tier preset |
| `pi`       | yes            | no  | no    | yes                  | no     | yes               | best-effort       | yes                                     |
| `opencode` | yes            | yes | yes   | yes                  | yes    | yes               | enforced          | use OpenCode agent config               |
| `copilot`  | yes            | yes | no    | yes                  | yes    | yes               | best-effort       | yes                                     |

The DAG executor sends user-visible warnings when a node sets fields unsupported by the resolved provider.
Treat those warnings as authoring failures unless the ignored behavior is intentional.

## Config Locations

Repo config lives in `.archon/config.yaml`.
Global config lives in `~/.archon/config.yaml`.
Per-user AI preferences can override tiers, aliases, and default provider when enabled.

Typical config:

```yaml
defaultAssistant: claude

assistants:
  claude:
    model: sonnet
    settingSources: [project, user]
  codex:
    model: gpt-5.5
    modelReasoningEffort: high
    webSearchMode: disabled
    additionalDirectories:
      - /absolute/path/to/other/repo
  pi:
    model: anthropic/claude-sonnet-4-6
    maxConcurrent: 2
  opencode:
    model: anthropic/claude-sonnet-4-6
    baseUrl: http://127.0.0.1:4096
    opencode:
      agent: build
  copilot:
    model: gpt-5
    modelReasoningEffort: high

tiers:
  large: { provider: claude, model: opus }
  medium: { provider: codex, model: gpt-5.5, effort: high }
  small: { provider: pi, model: anthropic/claude-haiku-4-5 }

aliases:
  '@cheap-review': { provider: codex, model: gpt-5-mini, effort: low }
  '@deep-plan': { provider: claude, model: opus, effort: max, thinking: adaptive }
```

Custom alias names must start with `@`.
Alias names `small`, `medium`, and `large` are reserved tier names and must not be used as custom aliases.

## Model References

Workflow and node `model:` accepts:

| Form    | Example               | Meaning                                         |
| ------- | --------------------- | ----------------------------------------------- |
| tier    | `small`               | Resolve through tier defaults and config tiers. |
| alias   | `@deep-plan`          | Resolve through config aliases.                 |
| literal | `sonnet` or `gpt-5.5` | Pass directly to resolved provider.             |

Tier and alias entries include `provider` and `model`.
They can change the effective provider even when `provider:` is set elsewhere.
If that happens, Archon warns and uses the model preset provider.

Tier fallback:

| Requested | Fallback order             |
| --------- | -------------------------- |
| `large`   | `large`, `medium`, `small` |
| `medium`  | `medium`, `large`, `small` |
| `small`   | `small`, `medium`, `large` |

Bundled and global workflows should not depend on `@custom` aliases.
Project workflows can use aliases because the project controls `.archon/config.yaml`.

## Built-in Tier Defaults

Built-in defaults by default provider:

| Default provider | small                         | medium                        | large                       |
| ---------------- | ----------------------------- | ----------------------------- | --------------------------- |
| `claude`         | `haiku`                       | `sonnet`                      | `opus`                      |
| `codex`          | `gpt-5.5` with minimal effort | `gpt-5.5` with medium effort  | `gpt-5.5` with high effort  |
| `pi`             | `anthropic/claude-haiku-4-5`  | `anthropic/claude-sonnet-4-6` | `anthropic/claude-opus-4-7` |
| `copilot`        | `gpt-5-mini`                  | `gpt-5`                       | `claude-sonnet-4.5`         |
| `opencode`       | `anthropic/claude-haiku-4-5`  | `anthropic/claude-sonnet-4-6` | `anthropic/claude-opus-4-7` |

Override tiers in config when the install uses different model names.

## Claude

Use Claude for workflows that need the broadest Archon feature support.
Claude supports MCP, hooks, skills, inline agents, tool restrictions, structured output, env injection, cost control, fallback model, sandbox, and native tools.

Workflow or node examples:

```yaml
provider: claude
model: sonnet
effort: high
thinking: adaptive
```

Claude effort values:

- `low`
- `medium`
- `high`
- `max`

Claude thinking forms:

```yaml
thinking: adaptive
```

```yaml
thinking: enabled
```

```yaml
thinking: disabled
```

```yaml
thinking:
  type: enabled
  budgetTokens: 8000
```

Sandbox example:

```yaml
sandbox:
  enabled: true
  network:
    allowedDomains: [api.github.com]
  filesystem:
    allowWrite: ['$ARTIFACTS_DIR']
```

Use `fallbackModel` only with Claude-capable paths.

## Codex

Use Codex for OpenAI-backed coding workflows.
Codex supports session resume, MCP, filesystem-discovered skills, env injection, and enforced structured output.
Codex does not support Archon node-level `effort`, `thinking`, `fallbackModel`, `sandbox`, `hooks`, inline agents, or tool restrictions.

Configure Codex reasoning through assistant config:

```yaml
assistants:
  codex:
    model: gpt-5.5
    modelReasoningEffort: xhigh
    webSearchMode: disabled
```

Or configure tier presets with `effort`:

```yaml
tiers:
  large: { provider: codex, model: gpt-5.5, effort: high }
```

Then use the tier from workflow YAML:

```yaml
provider: codex
model: large
```

Codex reasoning values:

- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

`webSearchMode` values:

- `disabled`
- `cached`
- `live`

The workflow schema accepts root `modelReasoningEffort` and `webSearchMode`.
For reliable runtime behavior, prefer `assistants.codex` config or tier preset `effort`.
There is no per-node `modelReasoningEffort` field.

## Pi

Use Pi for community multi-backend models.
Model refs use `<pi-provider-id>/<model-id>`, such as `google/gemini-2.5-pro` or `anthropic/claude-haiku-4-5`.

Pi supports session resume, skills, tool restrictions, env injection, best-effort structured output, native tools, effort, and thinking control.
Pi does not support MCP, hooks, inline agents, fallback model, or sandbox.

Use YAML `effort` for Pi thinking level:

```yaml
provider: pi
model: anthropic/claude-sonnet-4-6

nodes:
  - id: analyze
    prompt: 'Analyze $ARGUMENTS'
    effort: high
```

YAML effort values are `low`, `medium`, `high`, and `max`.
Pi maps `max` to `xhigh`.
Do not use Claude object-form `thinking` with Pi.

Optional Pi assistant config:

```yaml
assistants:
  pi:
    model: google/gemini-2.5-pro
    enableExtensions: false
    interactive: false
    maxConcurrent: 2
    env:
      PLANNOTATOR_REMOTE: '1'
```

Only enable extensions for trusted repos because extension discovery can load code from the workflow cwd.

## OpenCode

Use OpenCode when the project is already configured for OpenCode or models.dev style providers.
Model refs normally use `<provider>/<model>`, such as `anthropic/claude-sonnet-4-6`.

OpenCode supports session resume, MCP, hooks, skills, agents, tool restrictions, env injection, and enforced structured output.
OpenCode handles effort and thinking through OpenCode agent config rather than Archon node fields.

Example:

```yaml
provider: opencode
model: anthropic/claude-sonnet-4-6

nodes:
  - id: multi
    prompt: 'Run specialist agents and summarize.'
    agents:
      first-agent:
        description: 'Return first finding.'
        prompt: 'Return FIRST.'
      second-agent:
        description: 'Return second finding.'
        prompt: 'Return SECOND.'
```

## Copilot

Use Copilot when GitHub Copilot credentials are available.
Copilot supports session resume, MCP, skills, agents, tool restrictions, env injection, best-effort structured output, effort, and thinking control.
Copilot does not support hooks, fallback model, sandbox, or native tools.

Configure default reasoning:

```yaml
assistants:
  copilot:
    model: gpt-5
    modelReasoningEffort: high
```

Node-level `effort` can set Copilot reasoning:

```yaml
- id: plan
  provider: copilot
  model: gpt-5
  effort: max
  prompt: 'Create the implementation plan.'
```

Copilot maps `max` to `xhigh`.
Use `effort` rather than Claude object-form `thinking`.

## Tool and Structured-output Guidance

Use `allowed_tools: []` for classification, routing, and JSON-only summarization nodes.
Use `denied_tools` for safety constraints on AI nodes that should not mutate files.

Structured output support:

| Provider   | Behavior                                                            |
| ---------- | ------------------------------------------------------------------- |
| `claude`   | Enforced by SDK or backend and validated by Archon.                 |
| `codex`    | Enforced by SDK or backend and validated by Archon.                 |
| `opencode` | Enforced by backend and validated by Archon.                        |
| `pi`       | Best-effort JSON prompt, repair, reask up to 3 attempts, then fail. |
| `copilot`  | Best-effort JSON prompt, repair, reask up to 3 attempts, then fail. |

For best-effort providers, make prompts explicit:

```text
Return only a JSON object matching the schema.
Do not include prose or code fences.
```

Always declare `required` fields in `output_format` when downstream logic depends on them.
