# Initializing Archon In A Repository For Codex

Use this when the task is to add `.archon/` to a repository so Codex can create
or customize Archon commands and workflows there.

## Directory Structure

Create this in the repository root:

```text
.archon/
├── commands/
├── workflows/
├── mcp/            # optional; mainly relevant for Claude node-local MCP config
└── config.yaml     # optional
```

Minimum setup:

```bash
mkdir -p .archon/commands .archon/workflows
```

## Minimal Repo Config

Create `.archon/config.yaml` only when the repo needs non-default behavior:

```yaml
assistant: codex

worktree:
  baseBranch: main
  copyFiles:
    - .env
    - .env.local

defaults:
  loadDefaultCommands: true
  loadDefaultWorkflows: true
```

Notes:

- `assistant: codex` makes this repo prefer Codex under Archon
- `worktree.copyFiles` is only needed when worktrees need copied local files
- bundled defaults do not need to be copied into the repo to be available

## Bundled Default Behavior

Archon ships bundled workflows and commands. Repo-local files override bundled
files with the same name.

- `archon workflow list` shows discovered workflows
- repo `.archon/workflows/*` overrides bundled workflows with the same name
- repo `.archon/commands/*` overrides bundled commands with the same name

## Optional MCP Directory

Keep `.archon/mcp/` optional in Codex-first guidance.

Why:

- Archon supports node-local `mcp:` for Claude workflows
- Codex does not use `mcp:` as a node-local parity surface
- Codex MCP configuration belongs in Codex config rather than in workflow YAML

## Global Config Reminder

Global config lives at `~/.archon/config.yaml`.

If the goal is a Codex-first Archon environment more broadly, that file can use:

```yaml
defaultAssistant: codex
assistants:
  codex:
    model: gpt-5.4
    modelReasoningEffort: medium
    webSearchMode: live
```

## Verification

After initialization:

```bash
archon workflow list --json
```

The repo should now expose bundled workflows plus any repo-local custom ones.
