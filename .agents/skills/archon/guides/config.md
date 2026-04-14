# Archon Configuration Guide

Interactive guide for viewing and modifying Archon configuration. Use this when the user wants to change, view, or understand their config — at any point, not just during initial setup.

## Step 1: Determine Scope

Use **AskUserQuestion** to determine what the user wants to configure:

```
Header: "Config scope"
Question: "Which configuration do you want to modify?"
Options:
  1. "Repo config" (Recommended) — Settings for a specific repository (.archon/config.yaml in the repo)
  2. "Global config" — User-wide settings (~/.archon/config.yaml)
  3. "Both" — Review and modify both configs
```

## Step 2: Load Current Config

### For Global Config (~/.archon/config.yaml)

Read the file:
```bash
cat ~/.archon/config.yaml
```

If it doesn't exist, tell the user it will be auto-created on first Archon run with defaults. Offer to create it now.

### For Repo Config (<repo>/.archon/config.yaml)

First determine the target repo. If the current working directory is a git repo (and not the Archon source repo), use it. Otherwise ask:

```
Header: "Target repo"
Question: "Which repository's config do you want to modify?"
Options:
  1. "Current directory" — Use the repo at the current working directory
  2. "I'll provide a path" — Type or paste a repo path
```

Then read the file:
```bash
cat <target-repo>/.archon/config.yaml
```

If it doesn't exist, tell the user: "No repo config found. I can create one — or Archon will use defaults." Offer to create it.

## Step 3: Show Current State

Display the current configuration in a clear format. Show both the current values and what the defaults are, so the user knows what's customized vs default.

Format example:
```
Current repo config (.archon/config.yaml):
  assistant: codex (default: claude)
  worktree.baseBranch: develop (default: auto-detected)
  worktree.copyFiles: [".env"] (default: none)
  defaults.loadDefaultCommands: true (default)
  defaults.loadDefaultWorkflows: true (default)
```

## Step 4: Interactive Modification

Ask the user what they want to change. Use **AskUserQuestion** based on the scope.

### Global Config Options

```
Header: "Global option"
Question: "What would you like to change in the global config?"
Options:
  1. "Bot name" — Display name shown in messages (current: {value}, default: Archon)
  2. "Default assistant" — AI assistant for new repos (current: {value}, default: claude)
  3. "Streaming modes" — How responses are delivered per platform
  4. "Concurrency" — Max concurrent AI conversations (current: {value}, default: 10)
```

If "Streaming modes" is selected, follow up with:
```
Header: "Platform"
Question: "Which platform's streaming mode do you want to change?"
Options:
  1. "Telegram" — Current: {value} (default: stream)
  2. "GitHub" — Current: {value} (default: batch)
  3. "Slack" — Current: {value} (default: batch)
  4. "Discord" — Current: {value} (default: batch)
```

Then for the selected platform:
```
Header: "Mode"
Question: "Which streaming mode for {platform}?"
Options:
  1. "stream" — Send tokens as they arrive (real-time updates)
  2. "batch" — Send complete response at once (cleaner for GitHub/Slack)
```

### Repo Config Options

```
Header: "Repo option"
Question: "What would you like to change in the repo config?"
Options:
  1. "AI assistant" — Which AI to use for this repo (current: {value}, default: claude)
  2. "Worktree settings" — Base branch and file copying
  3. "Default loading" — Whether to load bundled commands/workflows
  4. "Commands folder" — Custom command folder path
```

If "Worktree settings" is selected:
```
Header: "Worktree"
Question: "Which worktree setting?"
Options:
  1. "Base branch" — Branch used as base for worktree creation (current: {value})
  2. "Copy files" — Files to copy into new worktrees (current: {value})
```

For "Copy files", let the user add/remove entries. Show current list and ask:
```
Header: "Copy files"
Question: "Current copyFiles: {list}. What do you want to do?"
Options:
  1. "Add a file" — Add a new file to copy into worktrees
  2. "Remove a file" — Remove one from the list
  3. "Replace all" — Start fresh with a new list
```

Remind the user about the `"source -> destination"` syntax for renaming (e.g., `".env.example -> .env"`).

If "Default loading" is selected:
```
Header: "Defaults"
Question: "Which default loading option?"
Options:
  1. "Default commands" — Load bundled command templates at runtime (current: {value})
  2. "Default workflows" — Load bundled workflow definitions at runtime (current: {value})
```

## Step 5: Apply Changes

After gathering changes, update the YAML file. Use the Edit tool to modify existing values or Write to create the file if it doesn't exist.

**Rules:**
- Only include non-default values in the file (keep it clean)
- Preserve existing comments
- Preserve any values the user didn't change
- Validate values before writing (e.g., assistant must be "claude" or "codex")

After writing, confirm: "Updated {path}. Changes take effect on the next Archon invocation (no restart needed for CLI)."

If the server is running for non-CLI platforms, note: "Server platforms (Telegram, Slack, GitHub, Discord) require a server restart to pick up config changes."

## Step 6: Offer Further Changes

After applying changes, ask if the user wants to modify anything else:

```
Header: "More changes?"
Question: "Want to change anything else?"
Options:
  1. "Done" — All set
  2. "Change another option" — Go back to Step 4
  3. "View final config" — Show the full config as it stands now
```

Loop back to Step 4 if they want more changes.

---

## Reference: All Configuration Options

### Global Config (~/.archon/config.yaml)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `botName` | string | `Archon` | Bot display name shown in messages |
| `defaultAssistant` | `claude` \| `codex` | `claude` | Default AI assistant for new repos |
| `streaming.telegram` | `stream` \| `batch` | `stream` | Telegram response delivery mode |
| `streaming.discord` | `stream` \| `batch` | `batch` | Discord response delivery mode |
| `streaming.slack` | `stream` \| `batch` | `batch` | Slack response delivery mode |
| `paths.workspaces` | string | `~/.archon/workspaces` | Directory for cloned repositories |
| `paths.worktrees` | string | `~/.archon/worktrees` | Directory for git worktrees |
| `concurrency.maxConversations` | number | `10` | Maximum concurrent AI conversations |

### Repo Config (<repo>/.archon/config.yaml)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `assistant` | `claude` \| `codex` | `claude` | AI assistant for this repo (overrides global) |
| `commands.folder` | string | `.archon/commands` | Custom command folder path (relative to repo root) |
| `commands.autoLoad` | boolean | `true` | Auto-load commands on clone |
| `worktree.baseBranch` | string | auto-detected | Base branch for worktree creation |
| `worktree.copyFiles` | string[] | `[]` | Files to copy into new worktrees (supports `"source -> dest"` renaming) |
| `defaults.loadDefaultCommands` | boolean | `true` | Load bundled default commands at runtime |
| `defaults.loadDefaultWorkflows` | boolean | `true` | Load bundled default workflows at runtime |

### Precedence Order (highest wins)

1. **Environment variables** (`.env` or shell) — always win
2. **Repo config** (`.archon/config.yaml` in repo) — project-specific
3. **Global config** (`~/.archon/config.yaml`) — user-wide preferences
4. **Defaults** — hardcoded sensible values

### Environment Variable Overrides

These env vars override any config file setting:

| Env Var | Overrides |
|---------|-----------|
| `BOT_DISPLAY_NAME` | `botName` |
| `DEFAULT_AI_ASSISTANT` | `defaultAssistant` / `assistant` |
| `TELEGRAM_STREAMING_MODE` | `streaming.telegram` |
| `DISCORD_STREAMING_MODE` | `streaming.discord` |
| `SLACK_STREAMING_MODE` | `streaming.slack` |
| `MAX_CONCURRENT_CONVERSATIONS` | `concurrency.maxConversations` |
| `ARCHON_HOME` | Base directory for all Archon paths |
