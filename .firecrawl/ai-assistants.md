[Skip to content](https://archon.diy/getting-started/ai-assistants/#_top)

[Archon](https://archon.diy/)

Search `CtrlK`

Cancel

Clear

[GitHub](https://github.com/coleam00/Archon)

Select themeDarkLightAuto

- The Book of Archon
  - [The Book of Archon](https://archon.diy/book/)
  - [What Is Archon?](https://archon.diy/book/what-is-archon/)
  - [Your First Five Minutes](https://archon.diy/book/first-five-minutes/)
  - [How Archon Actually Works](https://archon.diy/book/how-it-works/)
  - [The Essential Workflows](https://archon.diy/book/essential-workflows/)
  - [Isolation and Worktrees](https://archon.diy/book/isolation/)
  - [Creating Your First Command](https://archon.diy/book/first-command/)
  - [Creating Your First Workflow](https://archon.diy/book/first-workflow/)
  - [DAG Workflows](https://archon.diy/book/dag-workflows/)
  - [Hooks and Quality Loops](https://archon.diy/book/hooks-and-quality/)
  - [Quick Reference](https://archon.diy/book/quick-reference/)

- Getting Started
  - [Installation](https://archon.diy/getting-started/installation/)
  - [Getting Started](https://archon.diy/getting-started/overview/)
  - [Core Concepts](https://archon.diy/getting-started/concepts/)
  - [Quick Start](https://archon.diy/getting-started/quick-start/)
  - [Configuration](https://archon.diy/getting-started/configuration/)
  - [AI Assistants](https://archon.diy/getting-started/ai-assistants/)

- Guides
  - [Guides](https://archon.diy/guides/)
  - [Authoring Workflows](https://archon.diy/guides/authoring-workflows/)
  - [Authoring Commands](https://archon.diy/guides/authoring-commands/)
  - [Loop Nodes](https://archon.diy/guides/loop-nodes/)
  - [Approval Nodes](https://archon.diy/guides/approval-nodes/)
  - [Per-Node Hooks](https://archon.diy/guides/hooks/)
  - [Per-Node MCP Servers](https://archon.diy/guides/mcp-servers/)
  - [Per-Node Skills](https://archon.diy/guides/skills/)
  - [Global Workflows](https://archon.diy/guides/global-workflows/)
  - [Remotion Video Generation Workflow](https://archon.diy/guides/remotion-workflow/)

- Adapters
  - [Platform Adapters](https://archon.diy/adapters/)
  - [Web UI](https://archon.diy/adapters/web/)
  - [Slack](https://archon.diy/adapters/slack/)
  - [Telegram](https://archon.diy/adapters/telegram/)
  - [GitHub](https://archon.diy/adapters/github/)
  - community
    - [Discord](https://archon.diy/adapters/community/discord/)
    - [Gitea](https://archon.diy/adapters/community/gitea/)
    - [GitLab](https://archon.diy/adapters/community/gitlab/)

- Deployment
  - [Deployment Overview](https://archon.diy/deployment/)
  - [Local Development](https://archon.diy/deployment/local/)
  - [Docker Guide](https://archon.diy/deployment/docker/)
  - [Cloud Deployment](https://archon.diy/deployment/cloud/)
  - [Windows Setup](https://archon.diy/deployment/windows/)
  - [E2E Testing](https://archon.diy/deployment/e2e-testing/)
  - [E2E Testing on WSL](https://archon.diy/deployment/e2e-testing-wsl/)

- Reference
  - [Reference](https://archon.diy/reference/)
  - [Architecture](https://archon.diy/reference/architecture/)
  - [Archon Directories](https://archon.diy/reference/archon-directories/)
  - [CLI Reference](https://archon.diy/reference/cli/)
  - [Commands Reference](https://archon.diy/reference/commands/)
  - [Database](https://archon.diy/reference/database/)
  - [Variable Reference](https://archon.diy/reference/variables/)
  - [API Reference](https://archon.diy/reference/api/)
  - [Configuration Reference](https://archon.diy/reference/configuration/)
  - [Troubleshooting](https://archon.diy/reference/troubleshooting/)
  - [Security](https://archon.diy/reference/security/)

- Contributing
  - [Contributing](https://archon.diy/contributing/)
  - [New Developer Guide](https://archon.diy/contributing/new-developer-guide/)
  - [CLI Internals](https://archon.diy/contributing/cli-internals/)
  - [Releasing](https://archon.diy/contributing/releasing/)
  - [DX Quirks](https://archon.diy/contributing/dx-quirks/)

[GitHub](https://github.com/coleam00/Archon)

Select themeDarkLightAuto

On this page

- [Overview](https://archon.diy/getting-started/ai-assistants/#_top)
- [Claude Code](https://archon.diy/getting-started/ai-assistants/#claude-code)
  - [Authentication Options](https://archon.diy/getting-started/ai-assistants/#authentication-options)
  - [Option 1: Global Auth (Recommended)](https://archon.diy/getting-started/ai-assistants/#option-1-global-auth-recommended)
  - [Option 2: OAuth Token](https://archon.diy/getting-started/ai-assistants/#option-2-oauth-token)
  - [Option 3: API Key (Pay-per-use)](https://archon.diy/getting-started/ai-assistants/#option-3-api-key-pay-per-use)
  - [Claude Configuration Options](https://archon.diy/getting-started/ai-assistants/#claude-configuration-options)
  - [Set as Default (Optional)](https://archon.diy/getting-started/ai-assistants/#set-as-default-optional)
- [Codex](https://archon.diy/getting-started/ai-assistants/#codex)
  - [Authenticate with Codex CLI](https://archon.diy/getting-started/ai-assistants/#authenticate-with-codex-cli)
  - [Extract Credentials from Auth File](https://archon.diy/getting-started/ai-assistants/#extract-credentials-from-auth-file)
  - [Set Environment Variables](https://archon.diy/getting-started/ai-assistants/#set-environment-variables)
  - [Codex Configuration Options](https://archon.diy/getting-started/ai-assistants/#codex-configuration-options)
  - [Set as Default (Optional)](https://archon.diy/getting-started/ai-assistants/#set-as-default-optional-1)
- [How Assistant Selection Works](https://archon.diy/getting-started/ai-assistants/#how-assistant-selection-works)

## On this page

- [Overview](https://archon.diy/getting-started/ai-assistants/#_top)
- [Claude Code](https://archon.diy/getting-started/ai-assistants/#claude-code)
  - [Authentication Options](https://archon.diy/getting-started/ai-assistants/#authentication-options)
  - [Option 1: Global Auth (Recommended)](https://archon.diy/getting-started/ai-assistants/#option-1-global-auth-recommended)
  - [Option 2: OAuth Token](https://archon.diy/getting-started/ai-assistants/#option-2-oauth-token)
  - [Option 3: API Key (Pay-per-use)](https://archon.diy/getting-started/ai-assistants/#option-3-api-key-pay-per-use)
  - [Claude Configuration Options](https://archon.diy/getting-started/ai-assistants/#claude-configuration-options)
  - [Set as Default (Optional)](https://archon.diy/getting-started/ai-assistants/#set-as-default-optional)
- [Codex](https://archon.diy/getting-started/ai-assistants/#codex)
  - [Authenticate with Codex CLI](https://archon.diy/getting-started/ai-assistants/#authenticate-with-codex-cli)
  - [Extract Credentials from Auth File](https://archon.diy/getting-started/ai-assistants/#extract-credentials-from-auth-file)
  - [Set Environment Variables](https://archon.diy/getting-started/ai-assistants/#set-environment-variables)
  - [Codex Configuration Options](https://archon.diy/getting-started/ai-assistants/#codex-configuration-options)
  - [Set as Default (Optional)](https://archon.diy/getting-started/ai-assistants/#set-as-default-optional-1)
- [How Assistant Selection Works](https://archon.diy/getting-started/ai-assistants/#how-assistant-selection-works)

# AI Assistants

You must configure **at least one** AI assistant. Both can be configured if desired.

## Claude Code

[Section titled “Claude Code”](https://archon.diy/getting-started/ai-assistants/#claude-code)

**Recommended for Claude Pro/Max subscribers.**

### Authentication Options

[Section titled “Authentication Options”](https://archon.diy/getting-started/ai-assistants/#authentication-options)

Claude Code supports three authentication modes via `CLAUDE_USE_GLOBAL_AUTH`:

1. **Global Auth** (set to `true`): Uses credentials from `claude /login`
2. **Explicit Tokens** (set to `false`): Uses tokens from env vars below
3. **Auto-Detect** (not set): Uses tokens if present in env, otherwise global auth

### Option 1: Global Auth (Recommended)

[Section titled “Option 1: Global Auth (Recommended)”](https://archon.diy/getting-started/ai-assistants/#option-1-global-auth-recommended)

```
CLAUDE_USE_GLOBAL_AUTH=true
```

### Option 2: OAuth Token

[Section titled “Option 2: OAuth Token”](https://archon.diy/getting-started/ai-assistants/#option-2-oauth-token)

Terminal window

```
# Install Claude Code CLI first: https://docs.claude.com/claude-code/installation

claude setup-token

# Copy the token starting with sk-ant-oat01-...
```

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
```

### Option 3: API Key (Pay-per-use)

[Section titled “Option 3: API Key (Pay-per-use)”](https://archon.diy/getting-started/ai-assistants/#option-3-api-key-pay-per-use)

1. Visit [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Create a new key (starts with `sk-ant-`)

```
CLAUDE_API_KEY=sk-ant-xxxxx
```

### Claude Configuration Options

[Section titled “Claude Configuration Options”](https://archon.diy/getting-started/ai-assistants/#claude-configuration-options)

You can configure Claude’s behavior in `.archon/config.yaml`:

```
assistants:

  claude:

    model: sonnet  # or 'opus', 'haiku', 'claude-*', 'inherit'

    settingSources:

      - project      # Default: only project-level CLAUDE.md

      - user         # Optional: also load ~/.claude/CLAUDE.md
```

The `settingSources` option controls which `CLAUDE.md` files the Claude Code SDK loads. By default, only the project-level `CLAUDE.md` is loaded. Add `user` to also load your personal `~/.claude/CLAUDE.md`.

### Set as Default (Optional)

[Section titled “Set as Default (Optional)”](https://archon.diy/getting-started/ai-assistants/#set-as-default-optional)

If you want Claude to be the default AI assistant for new conversations without codebase context, set this environment variable:

```
DEFAULT_AI_ASSISTANT=claude
```

## Codex

[Section titled “Codex”](https://archon.diy/getting-started/ai-assistants/#codex)

### Authenticate with Codex CLI

[Section titled “Authenticate with Codex CLI”](https://archon.diy/getting-started/ai-assistants/#authenticate-with-codex-cli)

Terminal window

```
# Install Codex CLI first: https://docs.codex.com/installation

codex login

# Follow browser authentication flow
```

### Extract Credentials from Auth File

[Section titled “Extract Credentials from Auth File”](https://archon.diy/getting-started/ai-assistants/#extract-credentials-from-auth-file)

On Linux/Mac:

Terminal window

```
cat ~/.codex/auth.json
```

On Windows:

Terminal window

```
type %USERPROFILE%\.codex\auth.json
```

### Set Environment Variables

[Section titled “Set Environment Variables”](https://archon.diy/getting-started/ai-assistants/#set-environment-variables)

Set all four environment variables in your `.env`:

```
CODEX_ID_TOKEN=eyJhbGc...

CODEX_ACCESS_TOKEN=eyJhbGc...

CODEX_REFRESH_TOKEN=rt_...

CODEX_ACCOUNT_ID=6a6a7ba6-...
```

### Codex Configuration Options

[Section titled “Codex Configuration Options”](https://archon.diy/getting-started/ai-assistants/#codex-configuration-options)

You can configure Codex’s behavior in `.archon/config.yaml`:

```
assistants:

  codex:

    model: gpt-5.3-codex

    modelReasoningEffort: medium  # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

    webSearchMode: live           # 'disabled' | 'cached' | 'live'

    additionalDirectories:

      - /absolute/path/to/other/repo
```

### Set as Default (Optional)

[Section titled “Set as Default (Optional)”](https://archon.diy/getting-started/ai-assistants/#set-as-default-optional-1)

If you want Codex to be the default AI assistant for new conversations without codebase context, set this environment variable:

```
DEFAULT_AI_ASSISTANT=codex
```

## How Assistant Selection Works

[Section titled “How Assistant Selection Works”](https://archon.diy/getting-started/ai-assistants/#how-assistant-selection-works)

- Assistant type is set per codebase via the `assistant` field in `.archon/config.yaml` or the `DEFAULT_AI_ASSISTANT` env var
- Once a conversation starts, the assistant type is locked for that conversation
- `DEFAULT_AI_ASSISTANT` (optional) is used only for new conversations without codebase context
- Workflows can override the assistant on a per-node basis with `provider` and `model` fields
- Configuration priority: workflow-level options > config file defaults > SDK defaults

[Edit page](https://github.com/coleam00/Archon/edit/main/packages/docs-web/src/content/docs/getting-started/ai-assistants.md)

[Previous \\
\\
Configuration](https://archon.diy/getting-started/configuration/) [Next \\
\\
Guides](https://archon.diy/guides/)
