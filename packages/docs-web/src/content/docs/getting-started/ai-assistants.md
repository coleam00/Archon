---
title: AI Assistants
description: Install, authenticate and configure Claude Code, Codex, Pi, OpenCode and GitHub Copilot for Archon.
category: getting-started
area: clients
audience: [user]
status: current
sidebar:
  order: 4
---

Archon needs at least one AI assistant. You can configure several and mix them in one workflow. This page covers what each provider needs installed, how it authenticates, and its `assistants.<provider>` keys in `.archon/config.yaml`.

Which workflow features each provider supports is in the generated [Provider Capability Matrix](/reference/provider-capabilities/). Every config key, with the other settings around it, is in [Configuration](/reference/configuration/).

## Install a provider

Release binaries (quick install, Homebrew) ship without Claude, Codex and Pi. Add the ones you use:

```bash
archon provider add claude codex pi   # any subset
```

`archon setup` asks which to add and then sets up their authentication. An added provider must match the CLI version, so add it again after you upgrade Archon. Adding a provider connects Archon to the agent; it does not install the agent's own CLI. Your native configuration and login (`~/.claude`, `~/.codex`, Pi's `auth.json`) keep working. Source checkouts and Docker images run Claude, Codex and Pi from source with no add step. See [Installation → Providers](/getting-started/installation/#providers).

## Deprecated providers

OpenCode and GitHub Copilot are deprecated and will be removed in the next minor release, 0.13.0. No Archon maintainer owns them. Both keep working until that release; [#4641](https://github.com/coleam00/Archon/issues/4641) tracks the removal. To keep using one after that, build and own it as a provider plugin: see [Publish a plugin](/guides/publishing-plugins/#provider-plugins) and [Adding a Community Provider](/contributing/adding-a-community-provider/).

In chat, Claude, Codex and Pi launch and manage runs through native `invoke_workflow`, `register_project` and `manage_run` tools. Copilot and OpenCode have no native tools, so after you select a project with `/setproject <name>` they run `archon workflow run <workflow> "<message>" --detach` in its directory and return the run ID. Those runs are headless: they use CLI identity and send no progress or results back to the chat.

Archon shows the deprecation notice only to someone who uses one of them, at most once per command or process. `archon doctor` reports it when one is your default assistant, `archon ai default` prints it when you select one, and the first run in a process that uses one prints it on stderr. The server writes it to its log.

## Structured output guarantees

When a node sets `output_format`, the parsed output is validated against the schema before downstream nodes see it. A node that produces no schema-valid output fails. How hard the provider works to produce valid output depends on its tier, which `GET /api/providers` reports as `capabilities.structuredOutput`:

| Provider | Tier | How it works | On a validation miss |
|---|---|---|---|
| Claude, Codex, OpenCode | enforced | The SDK constrains decoding to the schema. | The node fails. A refusal or `max_tokens` truncation can still bypass the constraint, which is why the output is validated anyway. |
| Pi | best-effort | The schema, which must have `type: object` at its root, becomes the parameters of a `structured_output` tool the prompt asks the model to call. Pi validates each call and returns errors to the model in the same session; after 3 invalid calls the turn ends without output. A model that answers in text instead has JSON extracted from the reply, never from its thinking. The tool call cannot be forced, so the tier stays best-effort. | The executor asks again with the schema errors, up to 3 times, then fails the node. |
| Copilot | best-effort | The schema is appended to the prompt. JSON is extracted from the reply and repaired (trailing commas, single quotes, truncated tails). | The executor asks again with the schema errors, up to 3 times, then fails the node. |

See [Workflow language → `output_format`](/reference/workflow-language/#output_format-for-structured-json) for field access.

## Claude Code

Use Claude Code with a Claude Pro or Max subscription, an OAuth token, or an Anthropic API key.

### Install Claude Code

Archon does not bundle Claude Code. Install it with Anthropic's native installer:

```bash
# macOS / Linux / WSL
curl -fsSL https://claude.ai/install.sh | bash

# Windows (PowerShell)
irm https://claude.ai/install.ps1 | iex
```

Homebrew (`brew install --cask claude-code`), npm (`npm install -g @anthropic-ai/claude-code`) and winget (`winget install Anthropic.ClaudeCode`) work too. See [Anthropic's setup guide](https://code.claude.com/docs/en/setup).

### Binary path configuration (compiled binaries only)

A compiled Archon finds Claude Code in this order:

1. `CLAUDE_BIN_PATH` in the environment.
2. `assistants.claude.claudeBinaryPath` in `~/.archon/config.yaml` or a repository `.archon/config.yaml`.
3. The native installer's path: `~/.local/bin/claude`, or `%USERPROFILE%\.local\bin\claude.exe` on Windows.

If none resolves, the first Claude query fails with install instructions. Run `which claude` (or `where claude` on Windows) to find the path. Archon accepts the native binary, an npm `cli.js` (`$(npm root -g)/@anthropic-ai/claude-code/cli.js`), or an npm platform-package directory such as `@anthropic-ai/claude-code-win32-x64`, which it expands to the `claude` executable inside. The Docker image sets `CLAUDE_BIN_PATH` when the container starts.

A source install (`bun run`) uses the binary bundled with the Claude Agent SDK. Set `CLAUDE_BIN_PATH` or `claudeBinaryPath` only to override it, most often on glibc Linux, where the SDK can pick the musl build first and fail to start. An explicit path that is invalid fails in both modes instead of falling back.

Archon asks Claude Code for session-state events and finishes a node when the session goes idle after its final result. The CLI the bundled SDK ships emits them. A configured binary that does not still works if its process exits after the turn. If the process hangs instead, the node fails at the idle timeout, saying the provider never signalled that its turn settled.

### Authenticate Claude Code

Claude Code authenticates from its environment, or from its own login when the environment has no credential. Pick one:

- **Subscription login.** Run `claude /login` once. This is the default for a solo install.
- **OAuth token.** Run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...` in `~/.archon/.env`.
- **API key.** Create a key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) and set `CLAUDE_API_KEY=sk-ant-...`. Archon hands it to Claude Code as `ANTHROPIC_API_KEY` only when neither `CLAUDE_CODE_OAUTH_TOKEN` nor `ANTHROPIC_API_KEY` is set, so an OAuth token wins over `CLAUDE_API_KEY`.

`CLAUDE_USE_GLOBAL_AUTH=true` tells the server's startup check that you rely on `claude /login`. Claude Code never reads it. The CLI sets it when no Claude token or key is set, and so does the server unless `TOKEN_ENCRYPTION_KEY` is set. With `store: database`, a credential a user connects in Archon takes precedence over these install-wide settings for that user's runs (see [Per-user credentials](#per-user-credentials-and-ai-settings)).

### Claude config keys

```yaml
assistants:
  claude:
    model: sonnet          # sonnet, opus, haiku, a claude-* id, or inherit
    settingSources:        # default: [project, user]
      - project            # <cwd>/.claude/
      - user               # ~/.claude/
    claudeBinaryPath: /absolute/path/to/claude   # optional, see above
```

`settingSources` sets where the Claude Agent SDK discovers `CLAUDE.md`, skills, commands, agents and hooks. Use `[project]` to leave out your personal `~/.claude/`, or `[]` for a node with no setting sources. Discovery only makes a skill eligible: a workflow node activates exactly the skills its `skills:` list names. See [Claude settingSources](/reference/configuration/#claude-settingsources).

## Codex

Use Codex with a ChatGPT subscription login or an OpenAI API key.

### Install the Codex CLI

Archon does not bundle the Codex CLI in a compiled install:

```bash
npm install -g @openai/codex   # any platform; on Windows OpenAI recommends WSL2
brew install codex             # macOS
```

Native binaries are on the [Codex releases page](https://github.com/openai/codex/releases). See [OpenAI's Codex CLI docs](https://developers.openai.com/codex/cli).

A compiled Archon finds Codex in this order:

1. `CODEX_BIN_PATH` in the environment.
2. `assistants.codex.codexBinaryPath` in config.
3. A binary you place at `~/.archon/vendor/codex/codex` (`codex.exe` on Windows).
4. Common npm global locations: `~/.npm-global/bin/codex`, `/opt/homebrew/bin/codex` and `/usr/local/bin/codex`, or `%APPDATA%\npm\codex.cmd` and `%USERPROFILE%\.npm-global\codex.cmd` on Windows. For any other npm prefix, set the path explicitly.

A source install runs the binary from the `@openai/codex` package Archon depends on, unless you set a path.

### Authenticate Codex

By default Codex uses the login in your Codex home (`~/.codex`, or `CODEX_HOME`), exactly as `codex login` left it. Outside Docker, Archon never writes to that directory.

- **Login on the host.** Run `codex login` on the machine that runs Archon. This works for a server too.
- **API key.** Set `CODEX_API_KEY` in Archon's environment, for example `~/.archon/.env`. Archon passes it to the Codex process in memory. Codex does not read `OPENAI_API_KEY`.
- **Copied login tokens, Docker only.** For the Docker image, run `codex login` on another machine and copy the four values from `~/.codex/auth.json` into `.env`:

  ```ini
  ARCHON_CODEX_ID_TOKEN=eyJhbGc...
  ARCHON_CODEX_ACCESS_TOKEN=eyJhbGc...
  ARCHON_CODEX_REFRESH_TOKEN=rt_...
  ARCHON_CODEX_ACCOUNT_ID=6a6a7ba6-...
  ```

  At each start, the container's `setup-auth` step writes them to `~/.codex/auth.json`. Outside Docker nothing reads them at run time: the server's startup check passes, but every Codex run fails with `auth`. Use a host login or `CODEX_API_KEY` there instead. The `ARCHON_` prefix keeps the values from overriding a Codex login, because Codex reads `CODEX_ACCESS_TOKEN` itself. If your `.env` still has the old `CODEX_*` names, run `archon setup` to rename them or rename all four yourself. Until the next release Archon still reads the old names, with a deprecation warning, but only when `CODEX_ID_TOKEN` is set and no `ARCHON_CODEX_*` variable is.
- **Connected credential.** With `store: database`, an `openai` credential connected in Archon (`archon ai key set openai` or `archon ai login openai`) takes precedence over the native login, in workflows and in chat. An API key reaches Codex as `CODEX_API_KEY`; a ChatGPT subscription logs the Codex process in, in memory. A subscription token that expires during a run fails the turn with `auth`, and resuming the run picks up the refreshed token.

### How Archon runs Codex

Each Codex turn runs on its own `codex app-server` process. Your Codex config, hooks and `AGENTS.md` guidance load as they do for `codex` itself. In direct chat your plugins and MCP servers load too. A workflow node loads only the MCP servers its `mcp:` file declares and the plugins its `plugins:` list names, with ChatGPT apps off (see [Plugins](/reference/workflow-language/#plugins)). Failed turns carry a typed failure class from Codex's own error code; the classes are listed under [Error classification](/reference/workflow-language/#error-classification).

Codex chats get Archon's `invoke_workflow` and `register_project` tools, plus `manage_run` in project-scoped chats, through Codex's experimental dynamic-tool API. The tool catalog is fixed when a thread starts. If a chat predates Archon's record of that catalog, or the tools have changed since, Archon asks you to start a new chat before it runs a model turn.

In workflow nodes Archon turns Codex's automatic skill catalog off, so a prompt invokes an installed skill from `.agents/skills/` explicitly with `$skill-name`. Direct chat keeps native discovery. See [Per-Node Skills](/guides/skills/#codex-compatibility).

### Codex config keys

```yaml
assistants:
  codex:
    model: gpt-5.6-sol
    modelReasoningEffort: medium  # minimal, low, medium, high, xhigh, max, ultra or persistent
    webSearchMode: live           # disabled, cached or live
    additionalDirectories:
      - /absolute/path/to/other/repo
    codexBinaryPath: /absolute/path/to/codex   # optional, see above
    toolFreeStructuredOutputModels:            # routes that reject tools and a strict schema together
      - glm-5.3
```

A workflow's `effort:` overrides `modelReasoningEffort`.

Some model routes reject a request that carries both tools and a strict output schema. On a model listed in `toolFreeStructuredOutputModels`, a node with `output_format` runs its tool turn without the schema, then one final turn on the same thread with the schema and no tools. That costs one extra model request per node. The list matches only a model Archon resolves (`assistants.codex.model`, a tier, an alias or the node's `model:`), not one set in Codex's own `config.toml`. The list is read live, so a resumed run uses the current list.

The final turn drops the tools a Codex model catalog entry adds (`tool_mode`, `experimental_supported_tools`, `apply_patch_tool_type`): its process loads a catalog whose only entry is that model with no tools. The entry keeps the context window Codex reported for the tool turn, so Codex compacts the conversation before the final turn at about the size it would for the tool turn. Codex multi-agent is off on these threads, with one limit: Codex keeps a catalog entry's `multi_agent_version: v2` with the thread, so that entry's collaboration tools (`spawn_agent`, `send_message` and the rest) stay on both turns, including the final one. If such a model's route rejects them, drop `multi_agent_version` from that model's entry in the catalog Codex loads (`model_catalog_json` in Codex's `config.toml`; `codex debug models` prints the current one).

## Pi

Pi (`@earendil-works/pi-coding-agent`) is a coding-agent harness the Archon core team maintains alongside Claude and Codex. One `provider: pi` reaches Anthropic, OpenAI, Google (Gemini and Vertex), Groq, Mistral, Cerebras, xAI, OpenRouter, Hugging Face, and local models such as LM Studio, ollama and llamacpp.

### Install Pi

Add Pi with `archon provider add pi`. The provider embeds the Pi SDK, so you need the Pi CLI only to log in with `pi /login` or to refresh the model catalog. Source installs include the provider already. Install the CLI with `npm install -g @earendil-works/pi-coding-agent`.

`archon setup` can configure Pi: pick **Pi**, choose a backend and paste its key. Setup writes the key to `~/.archon/.env` and the model to `~/.archon/config.yaml`.

### Authenticate Pi

Archon reads your Pi credentials from `~/.pi/agent/auth.json`, written by `pi /login`, and from environment variables. Environment variables win per request, so codebase-scoped overrides work. A per-user credential that Archon delivers wins over all of them.

`pi /login` covers these OAuth subscriptions: OpenAI ChatGPT Plus or Pro, GitHub Copilot, Google Gemini CLI and Google Antigravity.

Key-based backends read these variables:

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
| `huggingface` | `HF_TOKEN` |

The full map is generated from the installed Pi SDK (`bun run generate:pi-vendor-map`) and covers every other key-based backend, such as DeepSeek, Together, Fireworks and Azure OpenAI. Amazon Bedrock and Google Vertex use ambient cloud credentials (the AWS chain or gcloud ADC).

For Anthropic models, use `provider: claude` with a Claude subscription, or give Pi an `ANTHROPIC_API_KEY`. Claude Pro or Max OAuth through Pi, including a native `pi /login` session, is not supported: Anthropic can reject Pi's default system prompt on subscription tokens. Archon never delivers its stored Claude subscription to Pi.

Local and custom endpoints need no Archon configuration. Register them in `~/.pi/agent/models.json` as Pi documents, then reference them as `<pi-provider-id>/<model-id>`. With no credential found, Archon continues and Pi connects to the endpoint.

Pi caches the result of an API key stored as `!command` in `auth.json` for the life of the process, keyed by the command text. All Pi nodes in one Archon server share that cache. If the command returns a short-lived token, the server keeps sending it after it expires. Restart the server to run the command again, or use a longer-lived credential. Keys and headers from `models.json` commands are not cached this way.

### Pi config keys

```yaml
assistants:
  pi:
    model: anthropic/claude-haiku-4-5   # <pi-provider-id>/<model-id>
    enableExtensions: true              # default true; false skips extension discovery
    interactive: true                   # default true; false loads extensions with no UI bridge
    extensionFlags:                     # per-extension flags, like Pi's --flag switches
      plan: false
    nodes:                              # per-node extension posture, keyed by node id
      plan: { interactive: true, extensionFlags: { plan: true } }
    env:                                # set in process.env for extensions; shell env wins
      PLANNOTATOR_REMOTE: "1"
    maxConcurrent: 2                    # cap on concurrent Pi prompts in this process
```

`env` and `maxConcurrent` apply to the whole process, so a per-run `--config` layer refuses them. Use codebase env vars, not `assistants.pi.env`, for secrets that vary per project.

Model references can nest slashes, as in `openrouter/qwen/qwen3-coder`. Archon reads Pi's model catalog from `~/.pi/agent/models-store.json`, or `$PI_CODING_AGENT_DIR/models-store.json` when that variable is set. If a model is newer than your catalog, run `pi update --models` and retry. Archon never refreshes the catalog itself and never substitutes another model when a lookup fails.

Pi names Azure models `azure/<model-id>`, including Foundry Chat Completions deployments. If you are upgrading from Pi 1.0.2 or earlier, change `azure-openai-responses` to `azure` in your Archon model references and in Pi's own `auth.json`, `models.json` and `settings.json`. Archon does not rewrite Pi's files. See the [Pi 1.0.3 release notes](https://github.com/earendil-works/pi/releases/tag/v1.0.3).

### Pi settings and context files

Every session starts from `~/.pi/agent/settings.json`, with `<repo>/.pi/settings.json` on top. Edit those files for retries, transport, compaction, thinking budgets and the default model; you do not restate them in Archon's config. Archon never writes to them, and changes made during a session are discarded when it ends. Missing files fall back to Pi's defaults, and a file that fails to parse is logged as `pi.settings_load_error` without stopping the session.

Pi keeps its native context-file discovery: `~/.pi/agent/AGENTS.md`, plus `AGENTS.md` or `CLAUDE.md` in the project and its parent directories. `AGENTS.override.md` replaces the ordinary file in the same directory.

### Extensions

Pi extensions are packages installed with `pi install npm:<package>`, or your own local files, that hook into the agent's lifecycle. They can add tools, intercept tool calls or block for human review. Archon loads them by default.

:::warning[Repo-controlled `.pi/` directories]
Extension discovery includes `<cwd>/.pi/extensions/*.ts` and `<cwd>/.pi/settings.json` in the run's working directory. When you run a workflow against a repository you did not write, anything in its `.pi/` runs with the Archon server's OS permissions. Audit that directory first, or set `enableExtensions: false` globally or on the node.
:::

Set an extension's posture (`enableExtensions`, `interactive`, `extensionFlags`) on the node that needs it, not install-wide. A planning flag set under `assistants.pi` also reaches the implement node, which then starts in planning mode, has its edits blocked and waits for a review nobody asked for. Three layers resolve per node, later ones winning:

1. `assistants.pi.*`, the install-wide default.
2. `assistants.pi.nodes.<nodeId>`, for a workflow you cannot edit. It lives in one machine's config and is keyed by node id, so renaming the node orphans it.
3. A `pi:` block on the node in the workflow YAML. It travels with the workflow and is the one to use.

Each layer's `extensionFlags` merge over the layer below key by key, so a node can turn off an inherited flag with `plan: false`. The `pi:` block works on `prompt`, `command` and `loop` nodes. On a `loop_group` it is ignored with a warning; put it on the body nodes.

For example, with the [plannotator](https://github.com/dmcglinn/plannotator) review extension installed (`pi install npm:@plannotator/pi-extension`), turn planning mode on for the planner only:

```yaml
name: plan-then-build
provider: pi
nodes:
  - id: plan
    prompt: "Draft a plan for: $ARGUMENTS"
    pi:
      interactive: true          # plannotator opens its review server
      extensionFlags: { plan: true }

  - id: implement
    depends_on: [plan]
    loop:
      prompt: "Implement the approved plan. Print DONE when finished."
      until: "DONE"
      max_iterations: 10
    pi:
      interactive: false
      extensionFlags: { plan: false }
```

The `plan` node prints a review URL and blocks until you approve or deny in the browser. Archon flushes that URL to the CLI or chat straight away.

Archon adds neither web search nor MCP to Pi; Pi rejects MCP by design. Both come from extensions that call `pi.registerTool`, such as a search API wrapper or an MCP bridge, and the tools reach workflow nodes with no Archon configuration. A tool's `execute` must return `{ content, details }`; a bare string reaches the model as an empty result. Search the [package ecosystem](https://shittycodingagent.ai/packages) before writing one.

An exception that escapes a detached extension callback, such as a timer or a watcher, fails the Pi node that loaded the extension instead of the Archon process. Archon routes it by the extension path in the stack. If several running Pi nodes loaded that extension, each fails with an error that says so. An escaped error that names no loaded extension still ends the process.

See the [Pi documentation](https://pi.dev) for extensions, the model registry and settings.

## OpenCode

:::caution[Deprecated]
OpenCode will be removed in the next minor release. It keeps working until then. See [Deprecated providers](#deprecated-providers).
:::

Archon runs OpenCode through `@opencode-ai/sdk` as an embedded server that it starts, protects with a random password and stops after its last request. Connecting to an external OpenCode server is not supported.

`@archon/providers` brings the SDK, but not the `opencode` executable. Install the [OpenCode CLI](https://opencode.ai/docs/#install) on the Archon process's `PATH`. In Docker, install it on `appuser`'s `PATH` in a derived image (see [Customizing the image](/deployment/docker/#customizing-the-image)). `archon doctor` checks both without starting the server.

OpenCode handles its own authentication; Archon passes no keys. Run `opencode` and use `/connect`, or store credentials in `~/.config/opencode/opencode.json` with `{env:VAR}` or `{file:PATH}` substitution. Connected credentials persist in `~/.local/share/opencode/auth.json`.

All nodes share one embedded server, so codebase env vars do not reach OpenCode, and Archon warns when a node would have received any.

```yaml
assistants:
  opencode:
    model: anthropic/claude-3-5-sonnet   # required format: <provider>/<model>; list them with `opencode models`
```

## GitHub Copilot

:::caution[Deprecated]
GitHub Copilot will be removed in the next minor release. It keeps working until then. See [Deprecated providers](#deprecated-providers).
:::

Archon drives the Copilot CLI through `@github/copilot-sdk`. You need an active Copilot subscription.

A source install gets the CLI with `bun install`. For a compiled Archon, install it with `npm install -g @github/copilot`. Archon finds it through `COPILOT_BIN_PATH`, then `assistants.copilot.copilotCliPath`, then `~/.archon/vendor/copilot/copilot` (`copilot.exe` on Windows), then common install locations.

Copilot picks its credential in this order:

1. `COPILOT_GITHUB_TOKEN` in the environment.
2. With `useLoggedInUser: false`, a generic `GH_TOKEN` or `GITHUB_TOKEN`.
3. The login from `copilot login`, the default.

Archon ignores `GH_TOKEN` and `GITHUB_TOKEN` unless you opt in, because a classic GitHub token has no Copilot entitlement and fails with a misleading SDK error.

```yaml
assistants:
  copilot:
    model: gpt-5-mini              # for example gpt-5, gpt-5-mini, claude-sonnet-4.5; unset passes auto
    modelReasoningEffort: medium   # any Archon effort, clamped to the SDK's low..max
    copilotCliPath: /absolute/path/to/copilot
    configDir: /absolute/path/to/copilot-config   # default: the SDK's own, usually ~/.copilot
    enableConfigDiscovery: false   # default false; true loads the repo's .copilot/ MCP servers and skills
    useLoggedInUser: true          # default true; false allows GH_TOKEN or GITHUB_TOKEN
    logLevel: error                # none, error, warning, info, debug or all
```

Copilot has no session-fork API. When Archon asks for a fork on retry, it starts a fresh session and posts a warning.

## Per-user credentials and AI Settings

Everything above configures install-wide credentials that every run shares. On a shared Archon server, each user can instead connect their own API key or subscription, so their runs and chats use their account. A solo install does not need this.

The credential vault works on every install. Archon creates a local encryption key at `~/.archon/credential-key` on first use. To manage the key yourself, for example to share it across containers or keep it in a secrets manager, set `TOKEN_ENCRYPTION_KEY` (64 hex characters, `openssl rand -hex 32`) and the key file is not used. Changing the key, or deleting the key file, makes every stored credential unreadable and everyone must reconnect. `archon doctor` then lists each of your credentials as "cannot be used", with the `archon ai login <vendor>` or `archon ai key set <vendor>` command that reconnects it.

### Connect a credential

Credentials are stored per vendor (`anthropic`, `openai`, `github-copilot`, `openrouter` and others), and one credential serves every agent that uses that vendor. Every vendor accepts an API key. `anthropic`, `openai` and `github-copilot` also accept a subscription login. The legacy ids `claude`, `codex` and `copilot` are accepted and normalized.

An `anthropic` subscription runs only on Claude Code. Because one credential is stored per vendor, connecting an Anthropic API key replaces the subscription. To give Pi an Anthropic key while Claude Code uses the subscription, set `ANTHROPIC_API_KEY` in the install or codebase env.

In the console, open **Settings**. The **Agents** section has one card per agent with its credentials and a ready or needs-credential state. The Pi card lists its backends behind **Add backend…** and shows Bedrock and Vertex as status-only rows. OpenCode's backends are install-wide, not per user.

From the CLI ([`archon ai`](/reference/cli/#ai)):

```bash
echo "$MY_KEY" | archon ai key set openrouter   # API key for any vendor
archon ai login anthropic                        # subscription: anthropic, openai or github-copilot
archon ai list
```

### When credentials are checked

A run checks the credentials its AI nodes need before it creates isolation, and again before any node runs when execution starts or resumes. Vendors the run does not use are not checked, and a child workflow checks its own graph when it starts.

- With `store: database`, a connected credential that cannot be read or is rejected blocks the run. Archon never falls back to another account.
- With `store: files`, or with no connected credential, runs use the provider's native or environment account, and a missing login blocks launch. A host run checks that login before isolation; a container run checks it inside the container.
- Claude checks account information in the target directory with each node's setting sources, without a model request. An `apiKeyHelper` must exit successfully with a non-empty credential, unless an environment credential authenticates instead.
- Providers that cannot check without a model session, including Copilot, OpenCode and Claude cloud backends, report "not checked" and may proceed.
- A check that cannot decide (the vendor or the provider's runtime gave no answer, or the 60 s check timed out) does not block the run. The run starts and records a `credential_check_inconclusive` event with the evidence, shown in the Web UI. A bad credential then fails the first AI node as `auth`, without retry. A connected credential is refreshed again when execution starts, and blocks the run then if it still cannot be used.

A key that resolves is only usable; only a model request proves the vendor accepts it.

### Model tiers, aliases and defaults

The `small`, `medium` and `large` tiers map to a provider and model. Only `claude` and `codex` have built-in tier defaults; every other provider must configure each tier it uses. Set tiers and `@alias` references in the console's **Model Tiers** and **Model Aliases** sections, with `archon ai tier set` and `archon ai alias set`, or in the `tiers:` and `aliases:` blocks described in [Configuration](/reference/configuration/). These need no encryption key.

When you are signed in to the web UI, those sections and **Defaults** have a **This install / Just me** toggle. Just-me settings are stored in Archon's database and win over the install config for runs and chats you start. The CLI equivalent is `--scope user`:

```bash
archon ai tier set large claude opus --scope user
archon ai default pi openrouter/minimax/minimax-m2 --scope user   # pin your chat provider and model
```

Chat picks its provider from your personal default, then the conversation's recorded assistant, then the install default. Its model is your personal pin when the pin's provider matches, then the configured `large` tier (yours, then repo, then global), then `assistants.<provider>.model` when no `large` tier is configured, then the built-in default. If chat asks for `large` and only another tier is configured, Archon uses the nearest one and says which. Workflow nodes ignore the chat pin; `model: large` always means the tier.

For a single run, `archon workflow run --model <name>=<spec>` or the console's **Start a new run** card rebinds named tiers or aliases without touching shared config. See [`workflow run`](/reference/cli/#workflow-run-name-message).

## How assistant selection works

A new conversation uses the repository's `assistant` in `.archon/config.yaml`, then `defaultAssistant` in `~/.archon/config.yaml`, then the `DEFAULT_AI_ASSISTANT` environment variable. Each must name a registered provider. Once a conversation starts, its assistant is fixed.

Workflows set `provider` and `model` at the workflow or node level. Tier and alias references resolve from your personal preferences, then repository and global config, then built-in defaults. A literal model id passes unchanged to the provider.
