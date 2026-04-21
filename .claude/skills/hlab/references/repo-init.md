# Initializing HarneesLab in a Repository

Set up the `.archon/` directory structure in any git repository to enable custom workflows and commands.

## Directory Structure

Create the following in your repository root:

```
.archon/
├── commands/         # Custom command files (.md)
├── workflows/        # Workflow definitions (.yaml)
├── mcp/              # MCP server config files (.json) — optional
└── config.yaml       # Repo-specific configuration — optional
```

```bash
mkdir -p .archon/commands .archon/workflows
```

## Minimal config.yaml

Create `.archon/config.yaml` only if you need to override defaults:

```yaml
# AI provider for this repo (default: inherited from global config)
assistant: claude                 # Repo-level key. In ~/.archon/config.yaml, use 'defaultAssistant' instead

# Worktree settings
worktree:
  baseBranch: main                # Branch to create worktrees from (default: auto-detected)
  copyFiles:                      # Git-ignored files to copy into new worktrees
    - .env
    - .env.local

# Control whether bundled defaults are loaded
defaults:
  loadDefaultCommands: true       # Include bundled default commands (default: true)
  loadDefaultWorkflows: true      # Include bundled default workflows (default: true)
```

## How Bundled Defaults Work

HarneesLab ships with built-in commands and workflows (like `archon-assist`, `archon-fix-github-issue`). These are loaded at runtime automatically — no files need to be copied into your repo.

- **To see bundled workflows**: `hlab workflow list`
- **To override a default**: Create a file with the same name in your repo's `.archon/workflows/` or `.archon/commands/`. Repo files take priority.
- **To disable defaults**: Set `defaults.loadDefaultWorkflows: false` or `defaults.loadDefaultCommands: false` in config.

## .gitignore Considerations

Add to your `.gitignore`:

```gitignore
# HarneesLab runtime artifacts (never commit)
.archon/mcp/          # May contain env var references
```

The `.archon/commands/` and `.archon/workflows/` directories should be committed — they are part of your project's workflow definitions.

## Global Configuration

The global config at `~/.archon/config.yaml` applies to all repositories. Use `guides/config.md` for interactive config editing, or create it manually:

```yaml
botName: HarneesLab
defaultAssistant: claude

assistants:
  claude:
    model: sonnet
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium

concurrency:
  maxConversations: 10
```

## Verification

After setting up, verify with:

```bash
# Confirm HarneesLab sees your repo
hlab workflow list

# Should show bundled workflows + any custom ones you've added
```
