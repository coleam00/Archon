---
title: AI Assistants
description: Configure Claude Code, Codex, and Pi as AI assistants for Archon.
category: getting-started
area: clients
audience: [user]
status: current
sidebar:
  order: 4
---

You must configure **at least one** AI assistant. All three can be configured and mixed within workflows.

## Claude Code

**Recommended for Claude Pro/Max subscribers.**

Archon does not bundle Claude Code. Install it separately, then in compiled Archon binaries, point Archon at the executable. In dev (`bun run`), Archon finds it automatically via `node_modules`.

### Install Claude Code

Anthropic's native installer is the primary recommended install path:

**macOS / Linux / WSL:**

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://claude.ai/install.ps1 | iex
```

**Alternatives:**

- macOS via Homebrew: `brew install --cask claude-code`
- npm (any platform): `npm install -g @anthropic-ai/claude-code`
- Windows via winget: `winget install Anthropic.ClaudeCode`

See [Anthropic's setup guide](https://code.claude.com/docs/en/setup) for the full list and auto-update caveats per install path.

### Binary path configuration (compiled binaries only)

Compiled Archon binaries cannot auto-discover Claude Code at runtime. Supply the path via either:

1. **Environment variable** (highest precedence):
   ```ini
   CLAUDE_BIN_PATH=/absolute/path/to/claude
   ```
2. **Config file** (`~/.archon/config.yaml` or a repo-local `.archon/config.yaml`):
   ```yaml
   assistants:
     claude:
       claudeBinaryPath: /absolute/path/to/claude
   ```

If neither is set in a compiled binary, Archon throws with install instructions on first Claude query.

The Claude Agent SDK accepts either the native compiled binary or a JS `cli.js`.

**Typical paths by install method:**

| Install method | Typical executable path |
|---|---|
| Native curl installer (macOS/Linux) | `~/.local/bin/claude` |
| Native PowerShell installer (Windows) | `%USERPROFILE%\.local\bin\claude.exe` |
| Homebrew cask | `$(brew --prefix)/bin/claude` (symlink) |
| npm global install | `$(npm root -g)/@anthropic-ai/claude-code/cli.js` |
| Windows winget | Resolvable via `where claude` |
| Docker (`ghcr.io/coleam00/archon`) | Pre-set via `ENV CLAUDE_BIN_PATH` in the image — no action required |

If in doubt, `which claude` (macOS/Linux) or `where claude` (Windows) will resolve the executable on your PATH after any of the installers above.

### Authentication Options

Claude Code supports three authentication modes via `CLAUDE_USE_GLOBAL_AUTH`:

1. **Global Auth** (set to `true`): Uses credentials from `claude /login`
2. **Explicit Tokens** (set to `false`): Uses tokens from env vars below
3. **Auto-Detect** (not set): Uses tokens if present in env, otherwise global auth

### Option 1: Global Auth (Recommended)

```ini
CLAUDE_USE_GLOBAL_AUTH=true
```

### Option 2: OAuth Token

```bash
# Install Claude Code CLI first: https://docs.claude.com/claude-code/installation
claude setup-token

# Copy the token starting with sk-ant-oat01-...
```

```ini
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xxxxx
```

### Option 3: API Key (Pay-per-use)

1. Visit [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Create a new key (starts with `sk-ant-`)

```ini
CLAUDE_API_KEY=sk-ant-xxxxx
```

### Claude Configuration Options

You can configure Claude's behavior in `.archon/config.yaml`:

```yaml
assistants:
  claude:
    model: sonnet  # or 'opus', 'haiku', 'claude-*', 'inherit'
    settingSources:
      - project      # Default: only project-level CLAUDE.md
      - user         # Optional: also load ~/.claude/CLAUDE.md
    # Optional: absolute path to the Claude Code executable.
    # Required in compiled Archon binaries if CLAUDE_BIN_PATH is not set.
    # claudeBinaryPath: /absolute/path/to/claude
```

The `settingSources` option controls which `CLAUDE.md` files the Claude Code SDK loads. By default, only the project-level `CLAUDE.md` is loaded. Add `user` to also load your personal `~/.claude/CLAUDE.md`.

### Set as Default (Optional)

If you want Claude to be the default AI assistant for new conversations without codebase context, set this environment variable:

```ini
DEFAULT_AI_ASSISTANT=claude
```

## Codex

Archon does not bundle the Codex CLI. Install it, then authenticate.

### Install the Codex CLI

```bash
# Any platform (primary method):
npm install -g @openai/codex

# macOS alternative:
brew install codex

# Windows: npm install works but is experimental.
# OpenAI recommends WSL2 for the best experience.
```

Native prebuilt binaries (`.dmg`, `.tar.gz`, `.exe`) are also published on the [Codex releases page](https://github.com/openai/codex/releases) for users who prefer a direct binary — drop one in `~/.archon/vendor/codex/codex` (or `codex.exe` on Windows) and Archon will find it automatically in compiled binary mode.

See [OpenAI's Codex CLI docs](https://developers.openai.com/codex/cli) for the full install matrix.

### Binary path configuration (compiled binaries only)

In compiled Archon binaries, if `codex` is not on the default PATH Archon expects, supply the path via either:

1. **Environment variable** (highest precedence):
   ```ini
   CODEX_BIN_PATH=/absolute/path/to/codex
   ```
2. **Config file** (`~/.archon/config.yaml`):
   ```yaml
   assistants:
     codex:
       codexBinaryPath: /absolute/path/to/codex
   ```
3. **Vendor directory** (zero-config fallback): drop the native binary at `~/.archon/vendor/codex/codex` (or `codex.exe` on Windows).

Dev mode (`bun run`) does not require any of the above — the SDK resolves `codex` via `node_modules`.

### Authenticate

```bash
codex login

# Follow browser authentication flow
```

### Extract Credentials from Auth File

On Linux/Mac:
```bash
cat ~/.codex/auth.json
```

On Windows:
```cmd
type %USERPROFILE%\.codex\auth.json
```

### Set Environment Variables

Set all four environment variables in your `.env`:

```ini
CODEX_ID_TOKEN=eyJhbGc...
CODEX_ACCESS_TOKEN=eyJhbGc...
CODEX_REFRESH_TOKEN=rt_...
CODEX_ACCOUNT_ID=6a6a7ba6-...
```

### Codex Configuration Options

You can configure Codex's behavior in `.archon/config.yaml`:

```yaml
assistants:
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium  # 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    webSearchMode: live           # 'disabled' | 'cached' | 'live'
    additionalDirectories:
      - /absolute/path/to/other/repo
```

### Set as Default (Optional)

If you want Codex to be the default AI assistant for new conversations without codebase context, set this environment variable:

```ini
DEFAULT_AI_ASSISTANT=codex
```

## Pi (Community Provider)

**One adapter, ~20 LLM backends.** Pi (`@mariozechner/pi-coding-agent`) is a community-maintained coding-agent harness that Archon integrates as the first community provider. It unlocks Anthropic, OpenAI, Google (Gemini + Vertex), Groq, Mistral, Cerebras, xAI, OpenRouter, Hugging Face, and more under a single `provider: pi` entry.

Pi is registered as `builtIn: false` — it validates the community-provider seam rather than being a core-team-maintained option. If it proves stable and valuable it may be promoted to `builtIn: true` later.

### Install

Pi is included as a dependency of `@archon/providers` — no separate install needed. It's available immediately.

### Authenticate

Pi supports both OAuth subscriptions and API keys. Archon's adapter reads your existing Pi credentials from `~/.pi/agent/auth.json` (written by running `pi` → `/login`) AND from env vars — env vars take priority per-request so codebase-scoped overrides work.

**OAuth subscriptions (run `pi /login` locally):**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

**API keys (env vars):**

| Pi provider id | Env var |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `huggingface` | `HUGGINGFACE_API_KEY` |

Additional Pi backends exist (Azure, Bedrock, Vertex, etc.) — file an issue if you need them wired.

### Model reference format

Pi models use a `<pi-provider-id>/<model-id>` format:

```yaml
assistants:
  pi:
    model: anthropic/claude-haiku-4-5       # via Anthropic
    # model: google/gemini-2.5-pro           # via Google
    # model: groq/llama-3.3-70b-versatile   # via Groq
    # model: openrouter/qwen/qwen3-coder    # via OpenRouter (nested slashes allowed)
```

### Usage in workflows

```yaml
name: my-workflow
provider: pi
model: anthropic/claude-haiku-4-5

nodes:
  - id: fast-node
    provider: pi
    model: groq/llama-3.3-70b-versatile   # per-node override — switches backends
    prompt: "..."
    effort: low
    allowed_tools: [read, grep]            # Pi's built-in tools: read, bash, edit, write, grep, find, ls

  - id: careful-node
    provider: pi
    model: anthropic/claude-opus-4-5
    prompt: "..."
    effort: high
    skills: [archon-dev]                   # Archon name refs work — see Pi capabilities below
```

### Pi capabilities

| Feature | Support | YAML field |
|---|---|---|
| Session resume | ✅ | automatic (Archon persists `sessionId`) |
| Tool restrictions | ✅ | `allowed_tools` / `denied_tools` (read, bash, edit, write, grep, find, ls) |
| Thinking level | ✅ | `effort: low\|medium\|high\|max` (max → xhigh) |
| Skills | ✅ | `skills: [name]` (searches `.agents/skills`, `.claude/skills`, user-global) |
| Inline sub-agents | ❌ | `agents:` is Claude-only; ignored with a warning on Pi |
| System prompt override | ✅ | `systemPrompt:` |
| Codebase env vars (`envInjection`) | ✅ | `.archon/config.yaml` `env:` section |
| MCP servers | ❌ | Pi rejects MCP by design |
| Claude-SDK hooks | ❌ | Claude-specific format |
| Structured output | ❌ | uneven across Pi backends; v2 follow-up |
| Cost limits (`maxBudgetUsd`) | ❌ | tracked in result chunk, not enforced |
| Fallback model | ❌ | not native in Pi |
| Sandbox | ❌ | not native in Pi |

Unsupported YAML fields trigger a visible warning from the dag-executor when the workflow runs, so you always know what was ignored.

### See also

- [Adding a Community Provider](../contributing/adding-a-community-provider/) — the contributor-facing guide for extending Archon with your own provider.
- [Pi on GitHub](https://github.com/badlogic/pi-mono) — upstream project.

## How Assistant Selection Works

- Assistant type is set per codebase via the `assistant` field in `.archon/config.yaml` or the `DEFAULT_AI_ASSISTANT` env var
- Once a conversation starts, the assistant type is locked for that conversation
- `DEFAULT_AI_ASSISTANT` (optional) is used only for new conversations without codebase context
- Workflows can override the assistant on a per-node basis with `provider` and `model` fields
- Configuration priority: workflow-level options > config file defaults > SDK defaults
