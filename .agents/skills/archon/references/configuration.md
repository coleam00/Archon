# Archon Configuration Guide For Codex

Use this guide when the user wants to view, explain, create, or modify Archon
configuration for Codex-first usage.

## Configuration Levels

Archon has two config levels:

- global config: `~/.archon/config.yaml`
- repo config: `<repo>/.archon/config.yaml`

Precedence is:

1. environment variables
2. repo config
3. global config
4. built-in defaults

## When To Use Which Level

Use repo config when the change is project-specific:

- prefer Codex only in one repo
- set one repo's base branch
- set one repo's `copyFiles`
- disable bundled defaults for one repo
- add repo-specific Codex defaults

Use workflow YAML when one Codex workflow should run with its own tuning:

- set workflow-specific `modelReasoningEffort`
- set workflow-specific `webSearchMode`
- set workflow-specific `additionalDirectories`

Use global config when the change is user-wide:

- prefer Codex by default across repos
- set default Codex model or reasoning effort
- set global Codex `webSearchMode`
- set global `additionalDirectories`
- set global streaming or bot preferences

## Reading Current Config

Global config:

```bash
sed -n '1,220p' ~/.archon/config.yaml
```

Repo config:

```bash
sed -n '1,220p' .archon/config.yaml
```

If a file does not exist:

- global config is auto-created on first Archon run
- repo config is optional; Archon falls back to defaults

## Most Important Codex Settings

### Global config example

```yaml
defaultAssistant: codex

assistants:
  codex:
    model: gpt-5.4
    modelReasoningEffort: medium
    webSearchMode: live
    additionalDirectories:
      - /absolute/path/to/other/repo
    codexBinaryPath: /absolute/path/to/codex
```

### Repo config example

```yaml
assistant: codex

assistants:
  codex:
    model: gpt-5.4
    modelReasoningEffort: high
    webSearchMode: live

worktree:
  baseBranch: main
  copyFiles:
    - .env
    - .env.local

commands:
  folder: .archon/commands

defaults:
  loadDefaultCommands: true
  loadDefaultWorkflows: true
```

## Key Fields

### Global config fields

| Field | Meaning |
| --- | --- |
| `defaultAssistant` | default assistant when a repo does not override it |
| `assistants.codex.model` | default Codex model |
| `assistants.codex.modelReasoningEffort` | default Codex reasoning effort |
| `assistants.codex.webSearchMode` | default Codex web search mode |
| `assistants.codex.additionalDirectories` | extra writable directories for Codex sessions |
| `assistants.codex.codexBinaryPath` | explicit Codex CLI path, mainly relevant in compiled Archon builds |
| `botName` | bot display name |
| `streaming.*` | platform response mode |
| `concurrency.maxConversations` | max parallel conversations |

### Repo config fields

| Field | Meaning |
| --- | --- |
| `assistant` | repo-level assistant override |
| `assistants.codex.*` | repo-level Codex defaults |
| `commands.folder` | extra command folder search path |
| `worktree.baseBranch` | base branch used for worktree creation and `$BASE_BRANCH` |
| `worktree.copyFiles` | ignored files copied into new worktrees |
| `defaults.loadDefaultCommands` | whether bundled commands are loaded at runtime |
| `defaults.loadDefaultWorkflows` | whether bundled workflows are loaded at runtime |
| `docs.path` | repo docs path used by workflow surfaces that care about docs |
| `env` | per-project env vars merged into workflow execution config; most relevant when a workflow surface consumes `config.envVars` |

## Workflow-Level Codex Overrides

For Codex, these workflow YAML fields override Archon config for that workflow:

- `modelReasoningEffort`
- `webSearchMode`
- `additionalDirectories`

Runtime precedence for those fields is:

1. workflow YAML
2. `assistants.codex.*` in Archon config
3. SDK defaults

That means:

- use Archon config for shared defaults across many Codex workflows
- use workflow YAML when one workflow needs a different execution profile
- do not expect node-level versions of those fields

## Editing Guidance

When modifying config:

- preserve unrelated keys
- keep repo config focused on non-default behavior
- use repo config for project-specific overrides instead of widening the global
  config unnecessarily
- do not confuse `assistant` with `defaultAssistant`
  - `assistant` is repo-level
  - `defaultAssistant` is global

## Environment Variable Overrides

These override config files:

| Env Var | Overrides |
| --- | --- |
| `DEFAULT_AI_ASSISTANT` | assistant preference |
| `BOT_DISPLAY_NAME` | `botName` |
| `TELEGRAM_STREAMING_MODE` | `streaming.telegram` |
| `DISCORD_STREAMING_MODE` | `streaming.discord` |
| `SLACK_STREAMING_MODE` | `streaming.slack` |
| `MAX_CONCURRENT_CONVERSATIONS` | `concurrency.maxConversations` |
| `ARCHON_HOME` | Archon base path |

## Operational Notes For Codex

- Codex MCP configuration is not controlled by Archon workflow `mcp:` node
  fields
- Codex skill discovery is not controlled by Archon workflow `skills:` node
  fields
- if the user wants those behaviors, route them through Codex config and the
  Codex capability crosswalk instead of pretending repo config creates node
  parity

## Validation

After a config change, verify the expected behavior with readback:

```bash
archon workflow list --json
```

For repo-specific changes, read the effective repo config again and confirm the
intended keys are present with the expected values.
