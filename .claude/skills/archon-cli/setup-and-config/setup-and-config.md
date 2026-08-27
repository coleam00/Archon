---
name: archon-cli-setup-config
description: Install Archon, verify with doctor, connect provider credentials, and change config.yaml (tiers, aliases, adapters). Read when setting up Archon or changing its configuration.
---

# Setup and Config

Install Archon, verify it, and change its configuration. Run from the repo you
want to work on unless setting up globally.

## First: is it already working?

```bash
archon --version      # CLI present?
archon doctor         # binaries, gh auth, database, adapters
archon doctor --full  # also probes the OpenCode runtime SDK
```

If `doctor` is green, skip to Configuration. Only set up what is actually broken.

## Install

Prerequisites: `git`, and Bun for source installs (a compiled binary needs only
itself). Then either:

```bash
# Source install
git clone <archon-repo> && cd Archon
bun install
cd packages/cli && bun link && cd ../..

# or run from a checkout without linking
bun --cwd packages/cli src/cli.ts --help
```

## Credentials — the setup wizard and its pieces

```bash
archon setup          # interactive wizard: credentials + config + skill install
```

The wizard composes these, which also work standalone:

```bash
archon ai list                      # which providers are connected
archon ai key set anthropic        # API key (prompt/stdin) — anthropic, openai, ...
archon ai login anthropic          # Claude Pro/Max subscription
archon ai login openai             # ChatGPT/Codex subscription
archon ai login github-copilot     # GitHub Copilot subscription
archon auth github                  # GitHub identity via device flow
```

Notes:

- Subscription logins cover Claude Pro/Max, ChatGPT/Codex, and GitHub Copilot.
  API keys remain available through `ai key set`.
- On multi-user installs each human connects their own credentials; runs execute
  on the starter's keys. Solo installs just need one working provider.
- `gh` must be authenticated (`gh auth status`) for any GitHub-touching workflow.

## Config: two scopes, one schema

| Scope | File | Wins |
|---|---|---|
| Repo | `<repo>/.archon/config.yaml` | over global |
| Global/user | `~/.archon/config.yaml` | defaults |

Read both before changing anything; change the narrowest scope that fits the ask.

Key sections:

```yaml
assistants:
  claude:
    model: <default model for claude nodes>
    # provider-specific options live here too
tiers:                     # how much model a step deserves; keywords small/medium/large
  large:
    provider: claude
    model: claude-<...>
    effort: high
aliases:                   # @name shortcuts resolvable in workflows
  "@fast":
    provider: ...
    model: ...
defaults:
  loadDefaultWorkflows: true   # bundled archon-* pack
  loadDefaultCommands: true
docs:
  path: docs/                  # where $DOCS_DIR points
env:                           # per-project env vars injected into execution
```

Prefer the typed commands over hand-editing when they exist — they validate:

```bash
archon ai tier set large claude claude-<model> --effort high
archon ai tier list --json     # configured vs built-in defaults
archon ai alias set @fast pi minimax/MiniMax-M3  # if supported by your build
archon ai key set openai                         # masked prompt, or key via stdin
```

Tier, alias, and default commands write install-wide settings unless you pass
`--scope user`. Use the user scope for one person's preferences on a shared
install; use the install scope for shared defaults.

After edits, confirm with `archon doctor` and one cheap probe:
`archon workflow list` should load with no errors.

## Alternate config layers (per-run model setups)

A user who wants a second model setup — say, a cheap free-model combo or a
premium one — does not need to edit their main config. Create a **sparse YAML
layer** holding only the keys it overrides, and load it per run with `--config`:

```yaml
# e.g. .config.free.yaml at the repo root (operator-local; keep untracked)
tiers:
  small:
    provider: pi
    model: minimax/MiniMax-M3
  large:
    provider: pi
    model: minimax/MiniMax-M3
aliases:
  "@fast":
    provider: pi
    model: minimax/MiniMax-M3
```

Valid layer keys: `assistant` or `defaultAssistant`, `assistants`, `tiers`,
`aliases`, `workflows`, `docs` (with `path`), and `env`. A tier or alias entry
stores the Archon provider separately from the model. For `provider: pi`, the
model is Pi's inner `<vendor>/<model>` reference, such as
`minimax/MiniMax-M3`. The outer `pi/` appears only in a single-string CLI
binding such as `--model large=pi/minimax/MiniMax-M3`.

```bash
archon workflow run archon-ship --branch fix/x "..." --config .config.free.yaml
```

Notes:
- The layer applies to that fresh run and its descendants only; nothing persists.
- Mutually exclusive with resuming an existing run.
- One-off, ad-hoc rebinding without a file: use `--model tier=provider/model`
  instead — see `../manage-run/manage-runs.md`.

To help a user decide scope: persistent default → edit config.yaml (below);
a named alternate setup they will reuse → a config layer;
a one-time experiment → `--model` flags.

## Adapters (Slack / Telegram / GitHub / Discord / Web)

Adapters let platforms drive Archon remotely. Each configures via env vars and is
verified by `doctor`. The web UI is the zero-config surface:

```bash
archon serve            # web console; downloads UI on first run (default port 3090)
```

Set up a chat adapter only when the user actually asks to drive Archon from that
platform — do not proactively configure Slack/Telegram/Discord.

## Project initialization for workflow authoring

Creating `.archon/` content (workflows, commands, scripts) belongs to the authoring
capability: see the sibling `../authoring-workflows/authoring-workflows.md`. Setup only ensures the CLI works.

## Known-stale spots (verify against `--help` when unsure)

The CLI surface grows; this reference summarizes it but `archon --help` and
`archon <command> --help` are authoritative. If a documented flag is rejected,
trust the CLI's own help and report the drift rather than forcing the stale form.
