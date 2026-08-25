---
title: CLI Reference
description: Complete reference for the Archon command-line interface and all available commands.
category: reference
area: cli
audience: [user]
status: current
sidebar:
  order: 3
---

Run AI-powered workflows from your terminal.

## Prerequisites

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/coleam00/Archon
   cd Archon
   bun install
   ```

2. Make CLI globally available (recommended):
   ```bash
   cd packages/cli
   bun link
   ```
   This creates an `archon` command available from anywhere.

3. Authenticate with Claude:
   ```bash
   claude /login
   ```

**Note:** Examples below use `archon` (after `bun link`). If you skip step 2, use `bun run cli` from the repo directory instead.

## Quick Start

```bash
# List available workflows (requires a git repo, a registered folder project, or --folder on first use)
archon workflow list --cwd /path/to/repo

# Run a workflow (auto-creates isolated worktree by default)
archon workflow run assist --cwd /path/to/repo "Explain the authentication flow"

# Explicit branch name for the worktree
archon workflow run plan --cwd /path/to/repo --branch feature-auth "Add OAuth support"

# Opt out of isolation (run in live checkout)
archon workflow run assist --cwd /path/to/repo --no-worktree "Quick question"
```

**Note:** Workflow and isolation commands normally require running from within a git repository (running from subdirectories automatically resolves to the repo root). A non-git directory also works if it's a registered [folder project](/getting-started/concepts/#folder-projects-non-git-workspaces) — or on first use by passing `--folder`, which registers it and runs in place. The `version`, `help`, `chat`, `setup`, `serve`, and `doctor` commands work anywhere.

## Commands

### `chat <message>`

Send a message to the orchestrator for a one-off AI interaction.

```bash
archon chat "What does the orchestrator do?"
```

### `setup`

Interactive setup wizard for credentials and configuration.

```bash
archon setup                      # writes ~/.archon/.env (home scope, default)
archon setup --scope project      # writes <cwd>/.archon/.env instead
archon setup --force              # overwrite instead of merging (backup still written)
archon setup --spawn              # open in a new terminal window
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--scope home` | Write to `~/.archon/.env` (default). Applies to every project. |
| `--scope project` | Write to `<cwd>/.archon/.env`. Overrides user scope for this repo only. |
| `--force` | Overwrite the target file wholesale instead of merging. A timestamped backup is still written. |
| `--spawn` | Open setup wizard in a new terminal window. |

**Write safety**: `archon setup` never writes to `<cwd>/.env` — that file belongs to you. The wizard always targets one archon-owned file chosen by `--scope`, merges into existing content (so user-added keys survive), and writes a timestamped backup before every rewrite (e.g. `~/.archon/.env.archon-backup-2026-04-20T09-28-11-000Z`).

**Default assistant + chat model**: after you pick the default assistant, the wizard offers an optional default chat model for it — a short curated list (e.g. `sonnet`/`opus`/`haiku` for Claude) plus an "Other…" free-text entry. Press Enter to keep the SDK default. Your selection is recorded in `~/.archon/config.yaml` as `defaultAssistant` (plus `assistants.<provider>.model` when you chose a model) — the same write as [`archon ai default <provider> [<model>]`](#ai) — and re-running setup shows the current model. Pi skips the model prompt because its backend/model pair is chosen earlier in the wizard.

### `doctor`

Verify your Archon setup. Runs a checklist of common failure points: Claude binary spawn, Codex binary resolution (env → config → vendor → autodetect, reporting which source resolved), gh CLI auth, Pi auth (when Pi is configured as default), OpenCode runtime SDK presence, database reachability, workspace writability, bundled defaults, folder-project detection (contained repos, when run from one), telemetry state, AI credentials (connected provider count, best-effort), and adapter token pings (Slack/Telegram, best-effort).

```bash
archon doctor
archon doctor --full   # also probe the OpenCode runtime SDK even when it isn't the configured assistant
```

The Codex check skips (never fails) when Codex isn't the configured assistant anywhere and no OpenAI credential is connected, so Claude-only users aren't nagged about a binary they'll never use. The OpenCode check only probes that the embedded runtime SDK module resolves — it never boots the runtime (which spawns a child process and binds a port) — and skips unless OpenCode is the configured assistant or `--full` is passed.

Exit code 0 if all checks pass or are skipped; 1 if any critical check fails. Adapter pings degrade to `skip` on network errors — a flaky connection does not flip the result red.

Also runs automatically at the end of `archon setup` (optional).

### `auth github`

Connect the current CLI user's GitHub identity via the GitHub device flow, so workflow commits, PR comments, and pushes attribute to you instead of the bot.

```bash
archon auth github
```

Only meaningful on **multi-user installs** running GitHub App mode (`GITHUB_APP_ID` + `GITHUB_APP_CLIENT_ID`) with `TOKEN_ENCRYPTION_KEY` set — solo `GITHUB_TOKEN` installs don't need it and the command exits with an explanatory error. Your CLI identity is resolved from `ARCHON_USER_ID` (explicit override) or `$USER` / `$USERNAME`, mapped to a stable Archon user via the `cli` platform identity.

The command prints a `verification_uri` and a one-time `user_code`; visit the URL, enter the code, and authorize. On success the access/refresh tokens are stored encrypted (AES-256-GCM) in Archon's database. Exit code 0 on success; 1 if per-user GitHub is disabled, the identity can't be resolved, the code expires, or authorization is denied.

### `ai`

Manage **per-user AI-provider credentials** (API keys + subscriptions) and **model-tier config**. CLI identity is resolved from `ARCHON_USER_ID` (explicit override) or `$USER` / `$USERNAME`, mapped to a stable Archon user via the `cli` platform identity — the same as [`auth github`](#auth-github).

The credential subcommands (`key set`, `login`, `list`, `logout`) work on **any install** — the vault is auto-provisioned. CLI identity is resolved from `ARCHON_USER_ID` or `$USER`/`$USERNAME`. The config subcommands (`tier`, `alias`, `default`) are **ungated** — they write `~/.archon/config.yaml` and need no identity.

```bash
# --- Provider credentials (any install — vault auto-provisioned) ---
archon ai key set <vendor>       # connect an API key (masked prompt or piped stdin — never argv)
archon ai login <vendor>         # connect a subscription via OAuth (anthropic, openai, or github-copilot)
archon ai list                   # list connected credentials (metadata only, no secrets)
archon ai logout <vendor>        # disconnect a credential

# --- Model tiers + aliases + default assistant (ungated config) ---
archon ai tier set <small|medium|large> <provider> <model> [--effort <effort>] [--scope user|install]
archon ai tier list [--json]     # show configured tiers (install + yours) vs built-in defaults
archon ai tier unset <small|medium|large> [--scope user|install]
archon ai alias set <@name> <provider> <model> [--effort <effort>] [--scope user|install]
archon ai alias list [--json]    # show @custom aliases (install + yours)
archon ai alias unset <@name> [--scope user|install]
archon ai default <provider> [<model>] [--scope user|install]   # set the default assistant (+ optional chat model)
```

Credential ids are **vendor-keyed** (`anthropic`, `openai`, `github-copilot`, plus the Pi backends like `openrouter`); legacy `claude`/`codex`/`copilot` are accepted and normalized with a printed notice. `ai login` supports subscription login for **`anthropic`**, **`openai`** (ChatGPT/Codex), and **`github-copilot`**. The `openai` login is an Archon-owned PKCE flow ([#1924](https://github.com/coleam00/Archon/issues/1924)): authorize in the browser, then paste the authorization code or the full `localhost:1455` redirect URL back at the prompt — nothing needs to listen on that port. The API key is never read from argv (it would leak into shell history): pipe it (`echo "$KEY" | archon ai key set openrouter`) or type it at the masked prompt.

`ai tier`, `ai alias`, and `ai default` edit the same `tiers:` / `aliases:` / `defaultAssistant` config you can hand-write in `~/.archon/config.yaml` (see [Configuration](/reference/configuration/)) or edit from the console **AI Settings** page. An unknown provider exits non-zero; `tier unset` removes the override so the tier falls back to its built-in preset. The full per-user setup walkthrough is in [Per-user credentials and AI Settings](/getting-started/ai-assistants/#per-user-credentials-and-ai-settings).

**`ai default <provider> [<model>]` (default chat model).** The optional `<model>` sets the default **chat** model alongside the assistant. At `--scope install` it writes `assistants.<provider>.model` in `~/.archon/config.yaml` (omitting the model leaves that field untouched). At `--scope user` the provider and model are written **atomically** to your prefs row — `archon ai default pi --scope user` clears any previous model pin, since a pin is only meaningful for the provider it was set with. Your chat model applies to direct chat only; workflow nodes keep resolving the `large` tier. The model may also be an `@alias` or tier keyword.

**`--scope user` (per-user overrides).** On any of the config subcommands, `--scope user` writes your **personal** prefs row in Archon's database instead of the shared `config.yaml`. Your tiers/aliases/default override the install config for runs and chats *you* start — nobody else's. It needs a resolvable CLI identity (`ARCHON_USER_ID` or `$USER`) but **no** `TOKEN_ENCRYPTION_KEY` (model names aren't secrets). `ai tier list` / `ai alias list` show both scopes, marking your overrides with `[just you]`. The same scopes are editable in the console as the "This install / Just me" toggle on **AI Settings**.

### `telemetry status`

Show the current anonymous telemetry state: whether it is enabled, the opt-out reason if not, the install UUID, the active PostHog host, and the key source.

```bash
archon telemetry status
```

Useful for verifying that an opt-out env var (`DO_NOT_TRACK=1`, `ARCHON_TELEMETRY_DISABLED=1`, `CI=true`, `POSTHOG_API_KEY=off`) is being picked up. Inspecting status never creates a `telemetry-id` file while opted out.

### `telemetry reset`

Rotate the persisted anonymous install UUID at `~/.archon/telemetry-id`. The previous ID is overwritten and not recoverable.

```bash
archon telemetry reset
```

Exit code 0 on success; 1 if the ID file cannot be written.

### `workflow list`

List workflows available in target directory.

```bash
archon workflow list --cwd /path/to/repo

# Machine-readable output for scripting
archon workflow list --cwd /path/to/repo --json
```

Discovers flat, one-level grouped, and exact `<pack>/<workflow>/` packaged layouts from `.archon/workflows/` and `~/.archon/workflows/`, plus bundled defaults. See [Global Workflows](/guides/global-workflows/).

**Flags:**

| Flag | Effect |
|------|--------|
| `--cwd <path>` | Target directory (required for most use cases) |
| `--json` | Output machine-readable JSON instead of formatted text |

With `--json`, outputs `{ "workflows": [...], "errors": [...] }`. Optional fields (`provider`, `model`, `effort`, `webSearchMode`, `parseWarnings`) are omitted when not set on a workflow. A workflow written with the deprecated `modelReasoningEffort:` reports its value as `effort`, which is what it is translated to at load — unless it also declares `effort:`, which wins. Each `parseWarnings` entry is a full warning message naming a key the engine dropped or deprecated, the workflow or node where it was found, and what to write instead — see [Unknown keys](/guides/authoring-workflows/#unknown-keys-are-reported-not-rejected).

### `workflow run <name> [message]`

Run a workflow with an optional user message.

```bash
# Basic usage
archon workflow run assist --cwd /path/to/repo "What does this function do?"

# With isolation
archon workflow run plan --cwd /path/to/repo --branch feature-x "Add caching"

# Supplying a workflow's declared inputs (one flag per input)
archon workflow run review-block --cwd /path/to/repo \
  --input diff="$(git diff)" --input style=terse "focus on the auth changes"

# Rebind only the large tier for this run
archon workflow run issue-to-pr --cwd /path/to/repo \
  --model large=openai/gpt-5.6 "fix #2481"

# Load a saved sparse layer, then replace only its large tier for this run
archon workflow run issue-to-pr --cwd /path/to/repo \
  --config ./config.minimax.yaml \
  --model large=openai/gpt-5.6 "fix #2482"
```

Progress events (node start/complete/fail/skip, approval gates) are written to stderr during execution.

If the workflow's YAML declares keys the engine ignores, a warning naming each one is written to **stderr before the run starts**. This matters to `--detach --json` callers: `--json` silences all logging, so stderr is the only channel left, and it keeps stdout to exactly the JSON payload.

Note that a real `run` emits a JSON payload **only** under `--detach`. Without it, `--json` suppresses logs but the command still prints human progress to stdout (`Running workflow: …`), so do not pipe a plain real `run --json` into a parser. The side-effect-free `--dry-run --json` mode below is the other exception: it emits exactly one complete trace document. See [Unknown keys](/guides/authoring-workflows/#unknown-keys-are-reported-not-rejected).

**Flags:**

| Flag | Effect |
|------|--------|
| `--cwd <path>` | Target directory (required for most use cases) |
| `--workflow-source <path>` | Read the workflow, its commands, and its scripts from this directory instead of `--cwd`. Lets an **uncommitted** workflow in one checkout run against a different checkout, repository, or folder project, with no commit, push, or merge. Fresh runs only -- rejected with `--resume`, because a resumed run executes the source it already captured. See [Running a workflow from another checkout](#running-a-workflow-from-another-checkout). |
| `--branch <name>` | Explicit branch name for the worktree |
| `--from <branch>`, `--from-branch <branch>` | Start-point for the new worktree only -- unlike `--base`, it does not change the PR target |
| `--base <branch>` | Per-dispatch base override for a single run. Sets **both** the worktree cut-from **and** the PR target (`$BASE_BRANCH`), and outranks `worktree.baseBranch` in config plus the codebase default -- see [Base branch precedence](#base-branch-precedence) below. The branch **must already exist on the remote**; a missing one is a hard error, not a fallback. Combine with `--from` to drive the two separately. Rejected with `--no-worktree`, `--folder`, and workflows pinning `worktree.enabled: false`. |
| `--no-worktree` | Opt out of isolation -- run directly in live checkout |
| `--folder` | Register the current non-git directory as a folder project (first use) and run in place -- no worktree. Rejects `--branch`/`--from`/`--base`. |
| `--container` | Run a **folder project** inside an overlay-isolated Docker container instead of in place (writes land in an overlay, not the live root, until an approval-gated write-back). Folder-only; a repo project errors. Requires the runner image (`bun run build:runner-image`). Pauses `docker stop` the container; `--resume`/`approve`/`reject` rediscover and restart it. See the [Container isolation guide](/guides/container-isolation/) and [configuration](/reference/configuration/#container-isolation-folder-projects). |
| `--input <name>=<value>` | Supply one value for the workflow's declared `inputs:`. **Repeat the flag per input.** Splits on the first `=`, so the value may itself contain `=`; `--input name=` supplies an empty string. Omitted inputs take their declared `default:`. A missing **required** input or an **undeclared** name is refused before any worktree, clone, or AI cost, through the same contract a composing `with:` map goes through. Works with `--dry-run` (inputs resolve exactly as in a real run). Rejected with `--resume` (a resume replays the inputs recorded on the run). See [Running a workflow that declares inputs](/guides/authoring-workflows/#running-a-workflow-that-declares-inputs). |
| `--model <name>=<spec>` | Rebind one `small`, `medium`, `large`, or existing `@alias` for this run. **Repeat the flag per binding.** An Archon agent prefix selects that agent (`codex/gpt-5.6-sol`); another valid vendor/model ref selects Pi (`openai/gpt-5.6`); an unqualified model keeps the binding's current provider; a tier or alias RHS copies that preset. Unspecified names keep their user → repo → global → built-in values. Literal `model:` pins and nodes that never reference the rebound name do not change. Bare `--model <spec>` is invalid, there is no run-wide `--provider`, and the flag is rejected with `--resume`. Works with `--dry-run`. |
| `--config <path>` | Load one sparse YAML config layer for this fresh run. Relative paths resolve from the directory named by `--cwd`, even when it is a repository subdirectory. Values in the file override persistent config and user AI preferences; explicit `--model` flags then replace only their named bindings. Works with `--dry-run` and `--detach`; the parent validates and seals the layer before handing it to a detached child, so later file edits cannot change that launch. Rejected with `--resume` because a continuation restores the sealed layer recorded when the run started. |
| `--resume` | Resume from last failed run at the working path (skips completed nodes) |
| `--quiet`, `-q` | Suppress all progress output to stderr |
| `--verbose`, `-v` | Also show tool-level events (tool name and duration) |
| `--detach` | Run in a detached background child and return immediately. The child does all the work; find it later with `workflow runs`/`workflow get`. Child stdout/stderr is captured to `~/.archon/logs/detached-run-<id>.log`. Combine with `--json` for a machine-readable ack. Also available on `approve`/`reject`/`resume` — see [Detached control verbs](#detached-control-verbs). |
| `--dry-run` | Simulate deterministic DAG control flow in memory. Creates no run, worktree, session, event, artifact, or provider request. |
| `--stubs <path>` | YAML mapping of node ids to scalar or structured outputs for `--dry-run`. Relative paths resolve from `--cwd`. |
| `--stubs-init <path>` | Write a complete stub scaffold for the expanded workflow and exit. Refuses to overwrite an existing file. Relative paths resolve from `--cwd`. |
| `--default-stubs` | Fill reachable nodes omitted from `--stubs` with schema-valid placeholders. Explicit stubs still win; without this flag, missing reachable stubs remain an error. |
| `--exec-code` | During `--dry-run`, execute trusted `bash:`/`script:` nodes locally instead of requiring stubs. Default is no code execution. |
| `--pause-at-gates` | During `--dry-run`, stop at the first approval gate instead of auto-approving it. |

#### Per-run config files

A run config is an ordinary YAML file selected explicitly for one invocation. It is useful for reusable choices such as `config.minimax.yaml`, but it is not a registered profile and does not change `.archon/config.yaml`.

```yaml
# config.minimax.yaml
tiers:
  large: { provider: pi, model: minimax/MiniMax-M3 }
env:
  BENCH_MODE: "1"
```

The layer is sparse: omitted settings keep their normal lower-layer values. In `--config ./config.minimax.yaml --model large=openai/gpt-5.6`, only `large` is replaced by the flag; `small`, `medium`, aliases, and every other omitted setting still fall through. See [Run-scoped configuration](/reference/configuration/#run-scoped-configuration) for the supported keys and fail-fast exclusions.

#### Running a workflow from another checkout

`--cwd` and `--workflow-source` answer two different questions: what the run acts on, and where the workflow itself is read from. They are the same directory unless you say otherwise.

```bash
# Author in ~/dev/archon (uncommitted), run against a clean checkout elsewhere
archon workflow run implement \
  --workflow-source ~/dev/archon \
  --cwd ~/checkouts/archon-target \
  "implement the plan"
```

Every run freezes its workflow source when it starts, whether or not you pass this flag. That means the source directory's `.archon/workflows`, `.archon/commands`, and `.archon/scripts`, plus your home-scoped `~/.archon/` source and Archon's own bundled defaults. Everything a static `include:` can reach is frozen together, so an included global or bundled workflow cannot change shape under a run either. That freeze is what makes the rest predictable:

- **The target stays clean.** Nothing from the source checkout is written into it, so its `git status` and its validators only ever see its own files.
- **A run does not change shape while it is running.** Edit, move, or delete the source checkout after a run starts and a resume still executes what the run began with. Start a new run to pick up the edits.
- **Resume needs no source path.** Every continuation -- `archon workflow resume <run-id>`, `archon workflow run <name> --resume`, `approve`, and `reject` -- loads the run's own captured source, which is why `--workflow-source` is refused alongside `--resume`.

The captured source lives under that run's artifacts (`~/.archon/workspaces/<project>/artifacts/runs/<run-id>/workflow-source/`) and is removed with the rest of the run's artifacts. Its manifest records a content digest, which the run row also stores, and a resume checks both: if the capture is missing, its bytes have changed, or it has been replaced with a different capture, the run **fails** rather than continuing against different source. Start a fresh run to execute the current workflow.

The one exception is a run that started before Archon captured source at all. It has nothing recorded to honor, so it resumes against the current source on disk with a warning. A run whose source record exists but cannot be read is *not* treated that way — it fails, because a run that recorded its source must never quietly execute something else.

**Compiled binaries.** A binary embeds its bundled workflows, commands, and scripts as constants rather than files. Those get written into the capture alongside everything else, so they are covered by the same digest — which means upgrading Archon between pausing and resuming a run is fine: the run keeps executing the bundled content it started with, and a change to those bytes would be caught like any other.

`--container` runs get the same treatment: the capture is bind-mounted **read-only at the same absolute path** inside the container, so a named script resolves identically whether a node runs on the host or in the container, and a container recreated on resume gets the mount back. `--workflow-source` is refused with `--container` — a folder project runs in place, so its source and its target are the same directory by definition.

#### Deterministic dry-run

Use dry-run to test DAG routing, joins, loops, `when:`, strict output fields, and variable substitution without starting a real workflow:

```bash
cat > stubs.yaml <<'YAML'
classify:
  issue_type: bug
  severity: high
investigate: "Root cause: stale cache"
YAML

archon workflow run triage --cwd /path/to/repo \
  --dry-run --stubs stubs.yaml "Issue #2100"

# One complete JSON document, safe to pipe in CI
archon workflow run triage --cwd /path/to/repo \
  --dry-run --stubs stubs.yaml --json | jq '.trace, .outcome'
```

Generate a starting fixture when a composed workflow has many nodes, then keep only the values that drive the path you want to test:

```bash
archon workflow run deliver --cwd /path/to/repo \
  --dry-run --stubs-init fixtures/deliver.yaml

# After editing the load-bearing values in the generated YAML:
archon workflow run deliver --cwd /path/to/repo \
  --dry-run --stubs fixtures/deliver.yaml --default-stubs
```

The scaffold is derived from the already-expanded workflow, so included top-level nodes use their flattened ids (for example, `review__classify`). Structured `output_format` values are emitted as YAML objects with native booleans, numbers, arrays, and nested required properties. Loop completion fields are generated as `true`. If Archon cannot prove that a generated value satisfies its JSON Schema, scaffold generation fails before creating the file.

The stub file must contain one YAML mapping. Each value is either a string or an object. Object stubs are preserved as structured output, so downstream `$classify.output.severity` references behave like live structured producers. Strict coverage remains the default: a reachable AI, bash, or script node without a stub fails the simulation and appears in `missingStubs`. Add `--default-stubs` to fill only omitted reachable nodes with the same schema-aware placeholders used by scaffold generation; explicit values always take precedence. Supplied stubs for unknown or unreachable nodes appear in `unusedStubs`, while generated placeholders do not. Whole-output references retain their normal lenient behavior, while invalid strict `$node.output.field` references fail the consuming node exactly as they do in a real run. See [Node Output References](/reference/variables/#node-output-references).

A workflow's declared `inputs:` resolve exactly as in a real run: omitted inputs take their declared `default:`, `--input name=value` binds a value (visible in the trace's resolved text), and a missing **required** input or an **undeclared** name fails at the invocation gate with the same errors a real run gives — before any trace output. With `--exec-code`, bash and script nodes also receive the run-level inputs as the same `INPUTS_<UPPER_SNAKE>` environment variables a real run delivers (a composed block's own inputs for named scripts are a real-run-only channel).

By default, bash and script nodes are never executed. `--exec-code` is an explicit opt-in for trusted local workflow code and is the only dry-run mode that can cause code-level side effects. Executed nodes receive `$ARTIFACTS_DIR` and `$STATE_DIR` under an ephemeral per-simulation directory in `~/.archon/temp/` (honoring `ARCHON_HOME`), created before the first executed node and removed when the simulation ends — a dry run writes nothing inside the repository, and a simulation that executes nothing creates no directory at all. Approval nodes auto-complete unless `--pause-at-gates` is set. Runtime `workflow:` sub-runs are reported as unsupported instead of being launched. Dry-run is incompatible with lifecycle and isolation flags such as `--branch`, `--no-worktree`, `--folder`, `--container`, `--resume`, and `--detach`.

The ordered trace records each node as completed, stubbed, skipped, failed, or paused, including its reason, resolved text, safe output, and final outcome.

Every node that takes an AI turn also reports **which provider and model it will run on, and where each value came from** — the same resolution the executor performs, not a second implementation of it. This is how you answer "what will this node actually run on" for a workflow that composes others, since a composed workflow runs with the configuration its own file declares:

```text
STUBBED   review__scope (prompt)
  runs on: codex (node) / gpt-5.6-sol (node) [from review-block]
  effort: high (node)
```

The origin in parentheses is one of `node`, `model ref` (a tier keyword or `@alias`), `workflow`, `assistant config`, or `default assistant`. `[from <name>]` names the workflow file a composed node was authored in. A node whose declared `provider:` disagrees with the provider its `model:` ref resolves to also reports the warning a real run would emit. `--json` carries the same values under each trace entry's `resolution` object.

This validates deterministic engine wiring; it does not validate model reasoning. It adds no workflow-YAML language surface and follows the [workflow language constitution](/reference/workflow-language-constitution/): YAML coordinates, code computes, and agents judge.

**Default (no flags):**
- Creates worktree with auto-generated branch (`archon/task-<workflow>-<timestamp>`)
- Auto-registers codebase if in a git repo

**With `--branch`:**
- Creates/reuses worktree at `~/.archon/workspaces/<owner>/<repo>/worktrees/<branch>/`
- Reuses existing worktree if healthy

**With `--no-worktree`:**
- Runs in target directory directly (no isolation)
- Mutually exclusive with `--branch`, `--from`, and `--base`

#### Base branch precedence

"Base branch" means two things, and by default one flag sets both: the **cut-from**
(what `git worktree add` branches off) and the **PR target** (`$BASE_BRANCH`, which
bash nodes pass to `gh pr create --base`). Four sources can supply it, highest first:

| Precedence | Source | Scope |
|------------|--------|-------|
| 1 | `--base <branch>` | one dispatch |
| 2 | `worktree.baseBranch` in `.archon/config.yaml` | the repo |
| 3 | The registered codebase's stored default branch | the repo |
| 4 | Git auto-detection (`origin/HEAD`, then `origin/main`) | the repo |

Levels 2--4 are static per repo, so a run that needs a different base than its
neighbours had to edit config -- global, and racy when several runs dispatch at
once. `--base` is the per-dispatch level, which is what makes parallel multi-base
dispatch (epic slices, A/B variants) config-free.

**Scope: the dispatched run only.** A `workflow:` node with `isolation: worktree`
creates a worktree for its child run, and that worktree is cut using levels 2--4
only -- `--base` and `--from` do **not** propagate to sub-run children. A parent
dispatched with `--base release/2.0` still branches its isolated children off the
repo's configured base. See [Choosing the child's
checkout](/guides/authoring-workflows/#choosing-the-childs-checkout-with-isolation).

**Driving cut-from and PR target separately.** `--from` overrides only the
cut-from, so pairing the two flags splits them:

```bash
# Branch off release/2.0, but open the PR against dev
archon workflow run implement --from origin/release/2.0 --base dev "Backport the fix"
```

`--from` is handed to `git worktree add` verbatim, so a remote ref such as
`origin/release/2.0` works. Note the sync-before-create step refreshes the
`--base` branch, not the `--from` start point -- pass a remote ref when the local
copy of the start point may be stale.

**Where `--base` is rejected** (rather than half-applied): with `--no-worktree`,
against a [folder project](/getting-started/concepts/#folder-projects-non-git-workspaces),
and against a workflow pinning `worktree.enabled: false`. None of these create a
worktree, so the flag could only move the PR target -- which would report a base
no worktree was ever cut from.

**When an existing worktree is adopted** -- `--branch` naming a healthy worktree,
or `--resume` continuing a prior run -- the cut-from is already fixed, so `--base`
changes only the PR target. Archon warns in both cases.

**Name Matching:**

Workflow names are resolved using a 4-tier fallback hierarchy. This applies consistently across the CLI and all chat platforms (Slack, Telegram, Web, GitHub, Discord):
1. **Exact match** - `archon-assist` matches `archon-assist`
2. **Case-insensitive** - `Archon-Assist` matches `archon-assist`
3. **Suffix match** - `assist` matches `archon-assist` (looks for `-assist` suffix)
4. **Substring match** - `smart` matches `archon-smart-pr-review`

If multiple workflows match at the same tier, an error lists the candidates:
```
Ambiguous workflow 'review'. Did you mean:
  - archon-review
  - custom-review
```

### `workflow status`

Show **active** workflow runs (running and paused) across all worktrees. For full history (all statuses) scoped to the current project, use `workflow runs`.

```bash
archon workflow status
archon workflow status --json
archon workflow status --verbose   # add a per-node summary for each run
archon workflow status --json --verbose
```

### `workflow runs`

List recent runs of **every** status (completed, failed, cancelled, running, paused) for the current project. The project is resolved from `cwd` the same way `workflow run` does. Complements `workflow status` (which is active-only).

```bash
archon workflow runs
archon workflow runs --json
archon workflow runs --status failed   # filter to one status
archon workflow runs --limit 50        # cap rows (default 20)
archon workflow runs --all             # list across all projects (ignore cwd scope)
```

If `cwd` is not a registered project, the command falls back to a global list and says so — `--json` carries this as a `scopeFallback: true` field so a consuming agent never mistakes a global result for a project-scoped one.

The listing shows short 8-character run ids. Every `<run-id>` command below (`get`, `resume`, `cancel`, `abandon`, `approve`, `reject`) accepts these short ids when run from the project directory: a unique prefix resolves to the full id, an ambiguous prefix errors, and full ids keep working from any directory. Short ids from `--all` rows belonging to *other* projects can't be resolved — use the full id from `--json` for those.

### `workflow get`

Show detail for a single run by ID, regardless of status (unlike `status`, which is active-only). Use it to answer "did that run pass?" for a completed/failed run. Exits non-zero when the run is not found.

```bash
archon workflow get <run-id>
archon workflow get <run-id> --json
archon workflow get <run-id> --verbose   # add the per-node summary
archon workflow get <run-id> --json --verbose
```

For both commands, `--json --verbose` adds a `nodes` array. Nodes are ordered by the
first appearance of each node in the deterministically ordered event stream. Every
entry includes `nodeId` and `state`; nodes with a start event include the original ISO
`startedAt`, and terminal nodes with both start and end events include `durationMs`.
Completed nodes may include an `outputPreview`, truncated after 200 characters with
ASCII `...`, while failed nodes include `error` (or `Unknown error` when none was
recorded).

Add `--events` to `--json --verbose` to return raw `events` rows instead of `nodes` for
debugging. Raw events are not the recommended integration surface.

### `workflow resume`

Resume a failed or paused workflow run. Re-executes the workflow, automatically skipping nodes that completed in the prior run.

```bash
archon workflow resume <run-id>
archon workflow resume <run-id> --json   # validate + ack only; does NOT re-execute inline
```

In `--json` mode the command is a non-blocking control-plane ack: it validates the run is resumable and reports its state but does **not** re-execute inline (execution streams output to stdout, which would corrupt the JSON). To actually drive a resumable run to completion, use the blocking form or `workflow resume <run-id> --detach`.

When you already hold a run id, prefer that exact-id form. `workflow run <name> --resume --detach` selects the newest resumable run of that workflow **in the current checkout**, which is a different question — from another worktree it correctly finds nothing, and in a checkout with several historical runs it expresses less than the id you already have. Keep the name form for the case you actually mean: "the latest failed run of this workflow, here."

Adding `--detach` **inverts** that: the child is re-invoked without `--json`, so it takes the inline path and does re-execute the run — just outside your shell. The ack carries `continues: true` to say so. See [Detached control verbs](#detached-control-verbs).

### `workflow cancel`

Actively stop a running workflow started by the CLI with `--detach`. The command
contacts the live process that owns that exact run, terminates its host process tree,
confirms termination, and only then records the run as `cancelled`.

```bash
archon workflow cancel <run-id>
archon workflow cancel <run-id> --json
```

If the detached owner cannot be reached or its process tree cannot be stopped, the
command fails and leaves the run state unchanged. This is deliberate: a database
transition cannot prove that host work stopped. After separately verifying that the
owner process is gone, use `workflow abandon <run-id>` to clean up an orphaned row.

`workflow cancel` applies only to a live detached CLI owner. Foreground runs remain
owned by their terminal and should be interrupted there.

After termination is confirmed, `cancel` records cancellation through the same run-tree
operation as `abandon`. Cancelling a parent therefore cancels every non-terminal
descendant and can report the same cascade failures or blocked parent described below.

### `workflow abandon`

Discard a workflow run by marking it `cancelled`. This is a state-only operation: it
does not stop a live host process or subprocess. Use it for paused runs and for orphaned
rows after verifying that their owner is gone. To stop a live `--detach` run, use
`workflow cancel`.

```bash
archon workflow abandon <run-id>
archon workflow abandon <run-id> --json
```

**Sub-run trees (#2121 Phase 2):** abandoning a parent that spawned `workflow:` sub-runs cascade-cancels every non-terminal descendant (children and grandchildren; already-terminal runs are left alone). These are database transitions, not process termination; an in-flight host command can continue until it returns. If part of the tree could not be reached, the command reports the count so you know descendants may still be alive. Conversely, abandoning a **child** that its parent is paused-and-blocked on strands that parent (nothing re-fires the auto-resume hook); the command surfaces the blocked parent's run id so you can `resume` it (which fails the sub-run node cleanly) or abandon it too.

### `workflow approve`

Approve a paused workflow run at an interactive approval gate. Optionally provide a comment that is available to the workflow via `$LOOP_USER_INPUT`.

**Sub-run child gates (#2121 Phase 2):** when a `workflow:` sub-run pauses at its own gate, the parent run pauses "blocked on child". Approve (or reject) the **child** by its own run id — the id shown in the parent's block message — not the parent's; the parent auto-resumes when the child completes. A child gate is the exception: it works for a 1:1 sub-run, but a child that pauses inside a `fan_out:` expansion **fails the node** instead — a parent has one approval slot and cannot hand it to N children, so gate before or after the fan-out node rather than inside a child of it. `approve`/`reject` against the parent's id while it's blocked on a child are refused with a redirect to the child id.

**Interactive-loop gates — finalize vs iterate:** when the gate paused on an iteration where any declared completion channel fired (`workflow get <run-id> --json` → `.metadata.approval.completionSignaled` is `true`), approving with **no comment** accepts the completion — the node finalizes from the already-computed output on resume, with no re-run. Approving **with** a comment runs another iteration using it as `$LOOP_USER_INPUT`. When no completion condition met, both forms run another iteration.

```bash
archon workflow approve <run-id>
archon workflow approve <run-id> "Looks good, proceed"
archon workflow approve <run-id> --comment "Looks good, proceed"
archon workflow approve <run-id> --json   # record approval + ack; does NOT auto-resume inline
```

In human mode `approve`/`reject` auto-resume the run inline. In `--json` mode they record the decision and return an ack **without** resuming (the run is left resumable for a backgrounded `resume`/`run --resume`).

#### Detached control verbs

`approve`, `reject`, and `resume` accept `--detach`. The parent validates the run
**read-only** with the same preconditions the operation itself enforces, so a
wrong-status, missing-context, `child_workflow`-blocked, already-resolved, or
no-working-path run is refused synchronously and nothing is spawned. The parent then
hands the whole command to a detached child that owns all state mutation in its own
process group. A shell that dies mid-flight can no longer wedge the run.

The parent also waits out the child's startup window before acking, so a child that
dies immediately surfaces as an error carrying the tail of its log rather than as a
success you only discover was false minutes later.

```bash
archon workflow approve <run-id> --detach
archon workflow approve <run-id> --detach --json
```

**`--detach --json` deliberately differs from bare `--json`.** Bare `--json` records the
decision and withholds the inline auto-resume (you drive continuation separately).
`--detach --json` spawns a child that takes the ordinary inline path, so the run **is**
driven onward — approve's auto-resume, reject's `on_reject` rework, resume's re-run —
just outside your shell. The ack carries `continues: true` to say so:

```json
{
  "ok": true,
  "runId": "…",
  "action": "approve",
  "detached": true,
  "continues": true,
  "workflowName": "assist",
  "logPath": "~/.archon/logs/detached-run-<id>.log"
}
```

Read `continues` to decide whether your automation still owns continuation. `logPath`
is `null` when the log file could not be opened — the child still runs, but its output
is discarded, so do not assume a string. Precheck failures follow each verb's existing
error contract: `{ ok: false }` under `--json`, a thrown error otherwise.

### `workflow reject`

Reject a paused workflow run at an approval gate. Optionally provide a reason that is available to the workflow via `$REJECTION_REASON`.

```bash
archon workflow reject <run-id>
archon workflow reject <run-id> --reason "Needs more tests"
archon workflow reject <run-id> --json
```

### `workflow cleanup`

Delete old terminal workflow run records from the database.

```bash
archon workflow cleanup        # Default: 7 days
archon workflow cleanup 30     # Custom threshold
```

### `workflow reset-sessions`

Clear persisted per-node AI sessions for a workflow — the cross-run memory stored by
nodes that opt in via `persist_session` (or workflow-level `persist_sessions: true`).
Use it when a workflow should forget its prior conversation and start fresh.

```bash
archon workflow reset-sessions <workflow-name> --yes             # ALL scopes (cross-scope wipe)
archon workflow reset-sessions <workflow-name> --scope <key>     # one scope only
archon workflow reset-sessions <workflow-name> --node <id> --yes # single node, still all scopes → needs --yes
archon workflow reset-sessions <workflow-name> --scope <key> --json
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--scope` | No | Scope key to reset — typically the conversation UUID. Omitting it wipes **every** scope and requires `--yes`. |
| `--node` | No | Restrict the reset to a single node id. |
| `--yes` | Only for cross-scope wipes | Confirm a wipe across all scopes (when `--scope` is omitted). |
| `--json` | No | Machine-readable output (`{ success, deleted }`). |

Extra positional arguments are rejected rather than silently reinterpreted — use `--node <id>`
to filter by node, since this is a destructive command.

### `workflow event emit`

Emit a workflow event directly to the database. Primarily used inside workflow loop prompts to record story-level lifecycle events.

```bash
archon workflow event emit --run-id <run-id> --type <event-type> [--data <json>]
```

`<run-id>` accepts either the full ID or an unambiguous prefix from `workflow runs`.
A prefix resolves only from the originating registered project's directory, including
its worktrees; use the full ID elsewhere.

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--run-id` | Yes | Full workflow run ID, or an unambiguous prefix used from the originating registered project's directory or one of its worktrees; use the full ID elsewhere |
| `--type` | Yes | Event type (e.g., `ralph_story_started`, `node_completed`) |
| `--data` | No | JSON string attached to the event. Invalid JSON prints a warning and is ignored. |

Exit code: 0 on submission, 1 when a required argument is missing, the event type is invalid, or run-ID prefix resolution fails. Event persistence is best-effort (non-throwing) -- check server logs if events appear missing.

### `isolation list`

Show all active worktree environments.

```bash
archon isolation list
```

Groups by codebase, shows branch, workflow type, platform, and days since activity.

Includes worktrees created for `workflow:` sub-run children that declared `isolation: worktree`
(branch `archon/task-<parentRunId8>-<nodeId>-<hash>-child-<n>`) — they are tracked and cleaned
up exactly like top-level run worktrees. Avoid `cleanup`/`complete` on one while its run tree
is still resumable: a resume reuses the child's recorded worktree and fails if it has been
removed.

### `isolation cleanup [days]`

Remove stale environments.

```bash
# Default: 7 days
archon isolation cleanup

# Custom threshold
archon isolation cleanup 14

# Remove environments with branches merged into main (also deletes remote branches)
archon isolation cleanup --merged

# Also remove environments whose PRs were closed without merging
archon isolation cleanup --merged --include-closed
```

Merge detection uses three signals in order: git branch ancestry (fast-forward / merge commit),
patch equivalence (squash-merge via `git cherry`), and GitHub PR state via the `gh` CLI.
The `gh` CLI is optional — if absent, only git signals are used.

By default, branches with a **CLOSED** PR are skipped. Pass `--include-closed` to clean
those up as well. Branches with an **OPEN** PR are always skipped.

### `validate workflows [name]`

Validate workflow YAML definitions and their referenced resources (command files, MCP configs, skill directories).

```bash
archon validate workflows                 # Validate all workflows
archon validate workflows my-workflow     # Validate a single workflow
archon validate workflows my-workflow --json  # Machine-readable JSON output
```

Checks: YAML syntax, DAG structure (cycles, dependency refs), command file existence, MCP config files, skill directories, provider compatibility, and tier/alias model refs. For bundled and global workflows, validation rejects `@custom` model aliases because they are not portable across projects; use `small`, `medium`, `large`, or a literal provider model string instead. Returns actionable error messages with "did you mean?" suggestions for typos.

Exit code: 0 = all valid, 1 = errors found.

### `validate commands [name]`

Validate command files (.md) in `.archon/commands/`.

```bash
archon validate commands                  # Validate all commands
archon validate commands my-command       # Validate a single command
```

Checks: file exists, non-empty, valid name.

Exit code: 0 = all valid, 1 = errors found.

### `complete <branch> [branch2 ...]`

Remove a branch's worktree, local branch, and remote branch, and mark its isolation environment as destroyed.

```bash
archon complete feature-auth
archon complete feature-auth --force  # bypass uncommitted-changes check
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--force` | Skip uncommitted-changes guard |

Use this after a PR is merged and you no longer need the worktree or branches. Accepts multiple branch names in one call.

### `serve`

Start the web UI server. On first run, downloads a pre-built web UI tarball from the matching GitHub release, verifies the SHA-256 checksum, and extracts it. Subsequent runs use the cached copy.

**Binary installs only** — in development, use `bun run dev` instead.

```bash
# Start web UI server (downloads on first run)
archon serve

# Override the default port
archon serve --port 4000

# Download the web UI without starting the server
archon serve --download-only
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--port <port>` | Override server port (default: 3090, range: 1–65535) |
| `--download-only` | Download and cache the web UI, then exit without starting the server |

The cached web UI is stored at `~/.archon/web-dist/<version>/`. Each version is cached independently, so upgrading the binary automatically downloads the matching web UI.

### `skill install [path]`

Install the bundled Archon skills into both `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex) directories of a project. Always overwrites existing files to ensure the latest version shipped with the current Archon binary is installed.

```bash
# Install into the current directory
archon skill install

# Install into a specific project
archon skill install /path/to/project
```

Two skills are installed: **`archon`**, which teaches the assistant how to work with Archon workflows, commands, and project conventions; and **`manage-run`**, a focused skill for inspecting and controlling workflow runs via the `archon` CLI. Each skill is written to both `.claude/skills/<skill>/` (Claude Code) and `.agents/skills/<skill>/` (Codex's canonical project-level skill path). Both are also installed automatically during `archon setup`.

### `version`

Show version, build type, and database info.

```bash
archon version
```

## Global Options

| Option | Effect |
|--------|--------|
| `--cwd <path>` | Override working directory (default: current directory) |
| `--quiet`, `-q` | Reduce log verbosity to warnings and errors only |
| `--verbose`, `-v` | Show debug-level output |
| `--json` | Output machine-readable JSON (workflow `list`, `status`, `runs`, `get`, and the write commands `approve`/`reject`/`abandon`/`resume`). Implies log suppression so stdout is exactly the JSON payload. |
| `--events` | With verbose JSON workflow `status`/`get`, return raw event rows instead of ordered node summaries. |
| `--help`, `-h` | Show help message |

## Working Directory

The CLI determines where to run based on:

1. `--cwd` flag (if provided)
2. Current directory (default)

Running from a subdirectory (e.g., `/repo/packages/cli`) automatically resolves to the git repository root (e.g., `/repo`).

When using `--branch`, workflows run inside the worktree directory.

> **Commands and workflows are loaded from the working directory at runtime.** The CLI reads directly from disk, so it picks up uncommitted changes immediately. This is different from the server (Telegram/Slack/GitHub), which reads from the workspace clone at `~/.archon/workspaces/` -- that clone only syncs from the remote before worktree creation, so changes must be pushed to take effect there.

## Environment

At startup, the CLI strips all Bun-auto-loaded CWD `.env` keys and nested Claude Code session markers from `process.env`, then loads two archon-owned env files with `override: true`. Keys in archon-owned files pass through to AI subprocesses — no allowlist filtering.

On startup, the CLI:
1. Strips `<cwd>/.env*` keys + `CLAUDECODE` markers from `process.env` (via `stripCwdEnv`). Emits `[archon] stripped N keys from <cwd> (...)` when N > 0.
2. Loads `~/.archon/.env` (user scope). Emits `[archon] loaded N keys …` when N > 0 **and** `ARCHON_VERBOSE_BOOT=1` or `LOG_LEVEL=debug/trace` is set.
3. Loads `<cwd>/.archon/.env` (project scope, overrides user scope). Same verbosity gate as step 2.
4. Auto-enables global Claude auth if no explicit tokens are set.

`<cwd>/.env` is never loaded — it belongs to the target project. See [Configuration Reference: `.env` File Locations](/reference/configuration/#env-file-locations) for the full three-path model.

## Database

- **Without `DATABASE_URL` (default):** Uses SQLite at `~/.archon/archon.db` -- zero setup, auto-initialized on first run
- **With `DATABASE_URL`:** Uses PostgreSQL (optional, for cloud/advanced deployments)

Both work transparently. Most users never need to configure a database.

## Examples

```bash
# One-off AI chat
archon chat "How does error handling work in this codebase?"

# Interactive setup wizard
archon setup

# Quick question (auto-isolated in archon/task-assist-<timestamp>)
archon workflow run assist --cwd ~/projects/my-app "How does error handling work here?"

# Quick question without isolation
archon workflow run assist --cwd ~/projects/my-app --no-worktree "How does error handling work here?"

# Plan a feature (auto-isolated)
archon workflow run plan --cwd ~/projects/my-app "Add rate limiting to the API"

# Implement with explicit branch name
archon workflow run implement --cwd ~/projects/my-app --branch feature-rate-limit "Add rate limiting"

# Branch from a specific source branch instead of auto-detected default
archon workflow run implement --cwd ~/projects/my-app --branch test-adapters --from feature/extract-adapters "Test adapter changes"

# Approve or reject a paused workflow
archon workflow approve <run-id> "Ship it"
archon workflow reject <run-id> --reason "Missing test coverage"

# Check worktrees after work session
archon isolation list

# Clean up old worktrees
archon isolation cleanup
```
