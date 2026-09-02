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

`ai tier`, `ai alias`, and `ai default` edit the same `tiers:` / `aliases:` / `defaultAssistant` config you can hand-write in `~/.archon/config.yaml` (see [Configuration](/reference/configuration/)) or edit from the console **AI Settings** page. An unknown provider exits non-zero; `tier unset` removes the override so the tier falls back to its built-in preset — claude and codex only; for any other default provider the tier is left unset and must be reconfigured before use. The full per-user setup walkthrough is in [Per-user credentials and AI Settings](/getting-started/ai-assistants/#per-user-credentials-and-ai-settings).

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

### `conversations`

The upgrade step for an install that **turns web auth on** and finds its history gone.

Operator conversations are private to their owning user, and ownership is fail-closed: a row Archon cannot attribute is reachable by nobody (see [Security](/reference/security/)). Every `web` and `cli` conversation written before you enabled auth has no owner, so the console shows an empty list even though the rows are still there. These two commands attach them to a real user.

```bash
# What a claim would take, before taking it
archon conversations list --unowned [--platform web|cli] [--limit <n>]

# Take it
archon conversations claim --user <archon-user-id> [--platform web|cli] [--before <iso>] [--dry-run] [--yes]
```

```text
$ archon conversations list --unowned
2 unowned web/cli conversations:

PLATFORM  ID          LAST ACTIVITY        TITLE
web       web-1-abc   2026-08-30 11:02:13  Fix the login bug
cli       cli-1-xyz   2026-08-29 09:41:55  (no title)

$ archon conversations claim --user 4f1c1f2e-… --dry-run
Unowned on web/cli:
  conversations: 2
  workflow runs: 2

--dry-run: nothing was written.
```

The target is a **`remote_agent_users` id** — what the console shows in Settings. It is not a login email and not a CLI identity. An id that does not exist is refused before anything is written, so a typo cannot strand rows on a user nobody can sign in as.

The command lives in the shell, not the console, and that is deliberate: an unowned row has no owner to authenticate against, so claiming over HTTP would mean the first user to click takes everyone else's history on a shared install. Shell access is the strongest available assertion of "I run this install".

**Claiming can never take a conversation away from someone who owns it.** The `WHERE` clause is `user_id IS NULL`, so a second operator running the same command claims only what is still unowned — the worst outcome of a mistake is rows landing on the wrong user and needing to be moved again. Nothing is written without `--yes`; `--dry-run` reports the same counts and exits 0.

**Flags:**

| Flag | Effect |
|------|--------|
| `--unowned` | Required on `list`. The only view: conversations no Archon user owns |
| `--platform <web\|cli>` | Narrow to one operator surface (default: both). Chat and forge platforms are refused — privacy does not cover them, so an owner there would only decide who may act on their runs |
| `--limit <n>` | `list` only: rows to print (default 20). The total is always reported |
| `--user <id>` | Required on `claim`. The `remote_agent_users` id rows are claimed for |
| `--before <iso>` | Only rows older than this date, compared against the database's own clock |
| `--dry-run` | Report both counts and write nothing |
| `--yes` | Apply. Without it the command reports the counts and refuses |

Workflow runs are claimed alongside conversations, because run *actions* are owned too: a run with no `user_id` whose conversation has no owner either can be approved, resumed, or cancelled by nobody. A run is matched through the conversation it is answerable to — its dispatching parent, else its own — so `--platform` scopes runs the same way it scopes conversations. Hidden worker conversations of past workflow runs are included; they carry the same operator's work.

### `workflow list [name]`

List workflows available in the target directory, or inspect one workflow by name.

```bash
# Compact discovery output
archon workflow list --cwd /path/to/repo

# Machine-readable output for scripting
archon workflow list --cwd /path/to/repo --json

# Exact, untouched description for one candidate
archon workflow list archon-fix-github-issue-codex --full --json
```

Discovers flat, one-level grouped, and exact `<pack>/<workflow>/` packaged layouts from `.archon/workflows/` and `~/.archon/workflows/`, plus bundled defaults. See [Global Workflows](/guides/global-workflows/).

The default output is a compact discovery view. Descriptions of at most 160 Unicode code points are returned unchanged. Longer descriptions are whitespace-normalized and reduced to their first sentence when it fits, or to preview content of at most 160 code points at a word boundary. Human-readable output appends ` [truncated]` after a shortened description. JSON keeps the description text separate from its truncation state: `descriptionTruncated` is `true` when content was omitted. Fetch the full description before choosing or launching a workflow when that field is `true`.

The optional `name` uses the same exact, case-insensitive, suffix, and substring resolution as workflow invocation. Ambiguous names fail instead of choosing a workflow; exact names copied from the discovery output are deterministic.

**Flags:**

| Flag | Effect |
|------|--------|
| `--cwd <path>` | Target directory (required for most use cases) |
| `--json` | Output machine-readable JSON instead of formatted text |
| `--full` | Return exact authored descriptions; combine with `name` for one workflow's full detail |

With `--json`, outputs `{ "workflows": [...], "errors": [...] }`. Each workflow has a `description` and `descriptionTruncated` boolean. `--full` returns the exact authored description and sets `descriptionTruncated` to `false`. Optional fields (`provider`, `model`, `effort`, `webSearchMode`, `parseWarnings`) are omitted when not set on a workflow. A workflow written with the deprecated `modelReasoningEffort:` reports its value as `effort`, which is what it is translated to at load — unless it also declares `effort:`, which wins. Each `parseWarnings` entry is a full warning message naming a key the engine dropped or deprecated, the workflow or node where it was found, and what to write instead — see [Unknown keys](/guides/authoring-workflows/#unknown-keys-are-reported-not-rejected). Discovery errors remain in the top-level `errors` array when a name filters the workflow list. If the named workflow is missing or ambiguous, the failure envelope is `{ "ok": false, "error": "...", "errors": [...] }`, retaining errors found during the same discovery.

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

# Continue the exact estate left by a terminal run
archon workflow run archon-ship --cwd /path/to/repo \
  --adopt 6d5066ca-47b4-4ee8-8d1d-2f3db8039190 "finish the delivery"
```

Progress events (node start/complete/fail/skip, approval gates) are written to stderr during execution. The workflow-start output also names the absolute local path of the run's JSONL transcript. Use [`workflow logs`](#workflow-logs) when you have a run ID and want the content rather than the path.

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
| `--adopt <run-id>` | Start a new run in a terminal run's exact worktree or branch, with `adopted_from_run_id` provenance and `$ADOPTED_RUN_DIR` access. Run-id selection is exact; adoption never infers a run from workflow name or prompt text. |
| `--supersedes <run-id>` | Start in a fresh estate while recording that this run replaces a terminal prior run. Unlike `--adopt`, it inherits no checkout. |
| `--quiet`, `-q` | Suppress all progress output to stderr |
| `--verbose`, `-v` | Also show tool-level events (tool name and duration) |
| `--detach` | Run in a detached background child and return immediately. The child does all the work; find it later with `workflow runs`/`workflow get`. For `workflow run`, human output names both files and the `--json` acknowledgement carries `runId`, `transcriptPath` (the structured per-run JSONL), and `logPath` (the detached child process's stdout/stderr capture). These paths are intentionally distinct. Use [`workflow logs <run-id> --follow`](#workflow-logs) for execution events and [`workflow wait <run-id>`](#workflow-wait) when a host needs the next terminal or gate transition. Also available on `approve`/`reject`/`resume`; their acknowledgement differs — see [Detached control verbs](#detached-control-verbs). |
| `--dry-run` | Simulate deterministic DAG control flow in memory. Creates no run, worktree, session, event, artifact, or provider request. |
| `--stubs <path>` | YAML mapping of node ids to scalar or structured outputs for `--dry-run`. Relative paths resolve from `--cwd`. |
| `--stubs-init <path>` | Write a complete stub scaffold for the expanded workflow and exit. Refuses to overwrite an existing file. Relative paths resolve from `--cwd`. |
| `--default-stubs` | Fill reachable nodes omitted from `--stubs` with schema-valid placeholders. Explicit stubs still win; without this flag, a missing reachable stub remains an error unless the node declares `trigger_rule: all_done`. |
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

The captured source lives beside that run's artifacts, at `~/.archon/workspaces/<project>/workflow-source/runs/<run-id>/`, and stays as long as the run's other output does. It is deliberately not inside `$ARTIFACTS_DIR`: that directory is the run's output channel, handed to every node and listed for inspection, and the frozen source is neither. Its manifest records a content digest and source-resolution settings, which the run row also stores. Archon checks those pinned values during initial discovery, on resume, and immediately before every later filesystem-backed command, named script, or composed-source read, hashing the full capture each time. If the capture is missing, changed, or replaced, the read and any container dispatch are refused. Start a fresh run to execute the current workflow.

These checks detect a mismatch present when Archon checks; they do not seal the directory or turn workflow execution into a security sandbox. Another process running as the Archon user can still change a file after a check, and already-started parallel nodes are not cancelled. Inline node bodies and command bodies compiled into an included graph are already in memory. A runtime `workflow:` child deliberately captures the live authoring source when that child starts, then receives its own pinned capture. If the parent's recorded authoring directory has moved or been deleted, Archon refuses to start the child instead of capturing a same-named workflow from the target checkout.

The one exception is a run that started before Archon captured source at all. It has nothing recorded to honor, so it resumes against the current source on disk with a warning. A run whose source record exists but cannot be read is *not* treated that way — it fails, because a run that recorded its source must never quietly execute something else.

An older captured run may have a digest in its run row but no out-of-band copy of its source-resolution settings. Archon still verifies its tree against that digest, reads the settings from the manifest, and on the first resume records them on the run row beside the digest, with a warning. Nothing can prove those settings are the ones the run started with, since the manifest is outside the digest; pinning them closes the window, so a later edit to the manifest is refused like any other change.

**Compiled binaries.** A binary embeds its bundled workflows, commands, and scripts as constants rather than files. Those get written into the capture alongside everything else, so they are covered by the same digest — which means upgrading Archon between pausing and resuming a run is fine: the run keeps executing the bundled content it started with, and a change to those bytes would be caught like any other.

`--container` runs get the same treatment: Archon checks the host capture before dispatch, then bind-mounts the capture **read-only at the same absolute path** inside the container. A named script therefore resolves identically whether a node runs on the host or in the container, and a container recreated on resume gets the mount back. `$ARTIFACTS_DIR` is bound the same way but read-write, so a node's outputs land on the host. The read-only bind is not hostile-process containment: native overlay mode has `CAP_SYS_ADMIN`, and a same-UID host process can still race a check. `--workflow-source` is refused with `--container` — a folder project runs in place, so its source and its target are the same directory by definition.

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
  --dry-run --stubs stubs.yaml --json | jq '.trace, .outcome, .authoredOutcome'
```

Generate a starting fixture when a composed workflow has many nodes, then keep only the values that drive the path you want to test:

```bash
archon workflow run deliver --cwd /path/to/repo \
  --dry-run --stubs-init fixtures/deliver.yaml

# After editing the load-bearing values in the generated YAML:
archon workflow run deliver --cwd /path/to/repo \
  --dry-run --stubs fixtures/deliver.yaml --default-stubs
```

The scaffold is derived from the already-expanded workflow, so included top-level nodes use their flattened ids (for example, `review__classify`) — while `loop_group` BODY nodes keep their bare ids even inside an included block (the group node gets the `<includeId>__` prefix; its body does not). Prefer `--stubs-init` over hand-writing keys: the scaffold is the authoritative source for both spellings. Structured `output_format` values are emitted as YAML objects with native booleans, numbers, arrays, and nested required properties. Loop completion fields are generated as `true`. If Archon cannot prove that a generated value satisfies its JSON Schema, scaffold generation fails before creating the file.

The stub file must contain one YAML mapping. Each value is either a string or an object. Object stubs are preserved as structured output, so downstream `$classify.output.severity` references behave like live structured producers. Strict coverage remains the default: a reachable AI, bash, or script node without a stub fails the simulation and appears in `missingStubs`. The one exception is a `trigger_rule: all_done` join — it runs whatever its upstream did, so a real run reaches it regardless of stub data. It gets a generated placeholder and is listed in both `missingStubs` and `toleratedMissingStubs`, and the absent stub alone never fails the simulation or a `workflow test` fixture. It is only listed in `toleratedMissingStubs` once that placeholder exists: a node whose `output_format` cannot produce one still fails, and stays out of the tolerated list. A `loop:` node carrying the same trigger rule is tolerated on the same terms, with one addition — the placeholder must also end the loop, which it does by satisfying the node's own completion channel, so a tolerated loop always completes on its first iteration. The one loop shape it cannot end is an `output_format` whose only completion channel is a prose `until:`, because the generated JSON never carries the sentinel; that node still fails and stays out of the tolerated list. Add `--default-stubs` to fill only omitted reachable nodes with the same schema-aware placeholders used by scaffold generation; explicit values always take precedence. A reachable `bash:` or `script:` node that arrived through `include:` must always be stubbed: the simulation does not deliver the caller's `with:` values to it, so a body that reads its inputs fails rather than running. Supplied stubs for unknown or unreachable nodes appear in `unusedStubs`, while generated placeholders do not. Whole-output references retain their normal lenient behavior, while invalid strict `$node.output.field` references fail the consuming node exactly as they do in a real run. See [Node Output References](/reference/variables/#node-output-references).

A workflow's declared `inputs:` resolve exactly as in a real run: omitted inputs take their declared `default:`, `--input name=value` binds a value (visible in the trace's resolved text), and a missing **required** input or an **undeclared** name fails at the invocation gate with the same errors a real run gives — before any trace output. With `--exec-code`, bash and script nodes also receive the run-level inputs as the same `INPUTS_<UPPER_SNAKE>` environment variables a real run delivers (a composed block's own inputs for named scripts are a real-run-only channel).

By default, bash and script nodes are never executed. `--exec-code` is an explicit opt-in for trusted local workflow code and is the only dry-run mode that can cause code-level side effects. Executed nodes receive `$ARTIFACTS_DIR` and `$STATE_DIR` under an ephemeral per-simulation directory in `~/.archon/temp/` (honoring `ARCHON_HOME`), created before the first executed node and removed when the simulation ends — a dry run writes nothing inside the repository, and a simulation that executes nothing creates no directory at all. Approval nodes auto-complete unless `--pause-at-gates` is set. Runtime `workflow:` sub-runs are reported as unsupported instead of being launched. Dry-run is incompatible with lifecycle and isolation flags such as `--branch`, `--no-worktree`, `--folder`, `--container`, `--resume`, and `--detach`.

The ordered trace records each node as completed, stubbed, skipped, failed, or paused, including its reason, resolved text, and safe output. The result reports two independent facts. `outcome` is the simulation execution result (`completed`, `failed`, `paused`, or `cancelled`) and still controls the CLI exit code. `authoredOutcome` is `succeeded`, `failed`, or `null`, derived only when the workflow declares `returns:` plus a boolean `outcome_field:` and the fixture supplies that structured result. Generated placeholders from `--default-stubs` or an unstubbed `all_done` node do not invent an authored verdict. A completed simulation can therefore report a failed authored outcome. Human output labels these as `Simulation outcome:` and `Authored outcome:`; simulation JSON always includes both fields. `--stubs-init --json` does not run a simulation and instead returns a scaffold acknowledgement with `workflow`, `stubsPath`, and `nodeCount`.

Every node that takes an AI turn also reports **which provider and model it will run on, and where each value came from** — the same resolution the executor performs, not a second implementation of it. This is how you answer "what will this node actually run on" for a workflow that composes others, since a composed workflow runs with the configuration its own file declares:

```text
STUBBED   review__scope (prompt)
  runs on: codex (node) / gpt-5.6-sol (node) [from review-block]
  effort: high (node)
```

The origin in parentheses is one of `node`, `model ref` (a tier keyword or `@alias`), `workflow`, `assistant config`, or `default assistant`. `[from <name>]` names the workflow file a composed node was authored in. A node whose declared `provider:` disagrees with the provider its `model:` ref resolves to also reports the warning a real run would emit. `--json` carries the same values under each trace entry's `resolution` object.

This validates deterministic engine wiring; it does not validate model reasoning. It adds no workflow-YAML language surface: YAML coordinates, code computes, and agents judge.

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

#### Continuing an existing estate

Use structured continuation whenever a workflow must work on an existing branch or pull request. If you have the prior run id, `--adopt <run-id>` is the authoritative form. Archon reuses the prior worktree as-is. If the prior worktree is gone, Archon reuses a same-repository checkout already holding that branch, or creates one on the exact local branch. It does not fetch, reset, or synchronize the branch; update it first if the remote advanced.

Every node in the new run uses that selected checkout, including bash/script delivery assertions. A branch name written only in the message is model context; it does not move engine-owned nodes to another checkout.

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

Show **active** workflow runs (running and paused) for the current project. The project is resolved from `cwd` through the registered checkout, including linked git worktrees. Use `--all` for install-wide active runs. For full history (all statuses), use `workflow runs`.

```bash
archon workflow status
archon workflow status --json
archon workflow status --all      # active runs across all projects
archon workflow status --verbose   # add a per-node summary for each run
archon workflow status --json --verbose
```

If `cwd` is an unregistered Git checkout, the command falls back to install-wide active runs and says so. Every successful JSON result carries `scopeFallback`: `true` for that fallback and `false` for a resolved project or explicit `--all` request. A registry lookup failure fails the command instead of returning install-wide runs under the fallback label. A registered folder project scopes normally; an unregistered non-repository directory is rejected with `Not in a git repository` before status lookup.

The normal human and JSON views include every active node without fetching each run's event
history. In JSON, `active_nodes` is the ordered list of unresolved node starts: `node_started` adds
an identifier, while `node_completed`, `node_failed`, `node_skipped`, and
`node_skipped_prior_success` remove it. Retries re-add the node in their new start position. This
is node lifecycle state, not evidence that a process owner is alive.

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

The run-list JSON uses the same `active_nodes` contract as `workflow status`. The retained singular
fields are compatibility fields: `current_step_name` and `current_step_status` are populated only
when exactly one node is active, and are `null` for zero or concurrent active nodes. `total_steps`
is always `null` because lifecycle events do not own a truthful declared DAG total.

The listing shows short 8-character run ids. Every `<run-id>` command below (`get`, `logs`, `wait`, `resume`, `cancel`, `abandon`, `approve`, `reject`) accepts these short ids when run from the project directory: a unique prefix resolves to the full id, an ambiguous prefix errors, and full ids keep working from any directory. Short ids from `--all` rows belonging to *other* projects can't be resolved — use the full id from `--json` for those.

### `workflow get`

Show detail for a single run by ID, regardless of status (unlike `status`, which is active-only). Use it to inspect both how execution progressed and, when declared, the workflow author's verdict. Exits non-zero when the run is not found.

```bash
archon workflow get <run-id>
archon workflow get <run-id> --json
archon workflow get <run-id> --verbose   # add the per-node summary
archon workflow get <run-id> --json --verbose
```

`workflow status`, `workflow runs`, and `workflow get` report two independent facts:

- **Execution status** (`pending`, `running`, `paused`, `completed`, `failed`, or `cancelled`)
  controls terminality, resume and cancellation, filters, and CLI exit behavior.
- **Authored outcome** (`succeeded` or `failed`) is the workflow's declared verdict from
  `outcome_field`. Human output labels it separately when present. JSON always carries it as the
  nullable `outcome` field beside `status`.

The axes may disagree without either being rewritten: `completed` with authored outcome `failed`
means execution finished normally but the workflow judged the work unsuccessful; `failed` or
`paused` with authored outcome `succeeded` records a successful verdict before execution later
failed or paused. A null outcome means the workflow did not declare one, the selected node has not
authored it yet, or the run predates the field. In that case human output keeps its status-only
presentation. Foreground `workflow run` uses the same labels when an outcome exists, but its exit
code remains driven by execution success or failure.

Human output includes `Transcript: <path>`. Every successful JSON shape includes the
same value as `transcript_path`, including verbose node summaries and raw events. A
historical run whose storage location can no longer be resolved remains inspectable and
reports `null` (human output says `(unavailable)`) instead of guessing a path from the
current directory.

For both commands, `--json --verbose` adds a `nodes` array. Nodes are ordered by the
first appearance of each node in the deterministically ordered event stream. Every
entry includes `nodeId` and `state`; nodes with a start event include the original ISO
`startedAt`, and terminal nodes with both start and end events include `durationMs`.
Completed nodes may include an `outputPreview`, truncated after 200 characters with
ASCII `...`, while failed nodes include `error` (or `Unknown error` when none was
recorded).

Add `--events` to `--json --verbose` to return raw `events` rows instead of `nodes` for
debugging. Raw events are not the recommended integration surface.

### `workflow logs`

Print the run's existing JSONL transcript, or follow it as rows are appended:

```bash
archon workflow logs <run-id>
archon workflow logs <run-id> --follow
```

Without `--follow`, the command copies the snapshot that exists at invocation time to
stdout and exits. With `--follow`, it announces the resolved local path on stderr, waits
for a live run's file to appear, and streams appended bytes until the run becomes
`completed`, `failed`, or `cancelled`. A paused run is still live: the follower stays
attached across approval gates and resumes, reading the same file.

Stdout is the transcript's exact JSONL, with no log messages or wrapper document. Each
line is one persisted event and fields may be added over time, so consumers should parse
the fields they need and tolerate others. `--json` is invalid because the output is
already JSONL and a live stream cannot satisfy the CLI's one-document JSON contract;
`--events` is also limited to `workflow status/get`.

A missing or empty snapshot exits `1`; for a live run the diagnostic points to
`--follow`. Follow mode waits while the run is live, performs a final read after a
terminal status, and exits `1` if a terminal run never produced content or if the file
shrinks. Stopping the follower only stops the reader. It never resumes, cancels, or
otherwise changes the run.

Transcripts can contain user prompts, tool inputs, and retained subprocess output. Treat
access to the local file as access to the run's input and execution data.

### `workflow wait`

Block until a run reaches a state it will not leave on its own — it finished, parked
on a gate awaiting a response, or paused for an outside action — then print what it needs. This is the intended
partner of `--detach --json`: take the `runId` from the launch ack and wait on it,
instead of polling `workflow get` in a loop.

The response a gate is waiting for does not have to come from a person. An
orchestrating agent can supply it with `workflow respond` just as a reviewer can; the
engine only reports that one is owed, and who answers is the waiting host's business.
For an action-required wait, the output carries `attention.kind: "action_required"`,
the authored message, and the paused node id. Complete the action, then run
`archon workflow resume <run-id>`; use `archon workflow abandon <run-id>` if the run
should not continue.

```bash
archon workflow wait <run-id>
archon workflow wait <run-id> --json
archon workflow wait <run-id> --json --timeout 900
```

There is no default timeout. A run reports when it is done, and a wait that ended on
its own clock would be answering a question only the run can answer. `--timeout
<seconds>` is there for a host that needs an upper bound anyway.

**Exit codes describe the command, not the run.**

| Exit | Meaning |
| --- | --- |
| `0` | The run said something — it finished (`completed`, `failed`, or `cancelled`), is waiting for a response, or needs an outside action. The status is data on stdout. |
| `3` | The timeout passed with the run still live. The `--json` payload carries `observedStatus`. |
| `1` | The wait itself failed — unknown run id, database unreachable, or output that could not be delivered. |

A `failed` or `cancelled` run is still exit `0`: mapping run state onto the process
exit code would make a legitimately cancelled run look like a broken command.

`--json` emits one document. On a wake it carries the attention value:

```json
{ "ok": true, "action": "wait", "runId": "…", "result": "attention",
  "attention": { "kind": "terminal", "runId": "…", "status": "completed", "at": "…" } }
```

`attention.kind` is one of:

- `terminal` — the run finished; `status` is `completed`, `failed`, or `cancelled`.
- `awaiting_response` — a gate is waiting for a decision. `respondTo` names the run and
  node where that response is recorded. **That run is not always the one you waited on**:
  a parent blocked on a `workflow:` sub-run wakes when the chain below it reaches a gate,
  and `respondTo.runId` is the child you answer. A parent blocked on a child that is
  merely still running wakes nobody.
- `action_required` — the run needs the outside action described by `message`. Once it is
  complete, resume `runId`; use the node id to identify the paused workflow step.
- `unreadable` — the run is parked but cannot describe itself (corrupt gate metadata, a
  gate type this build does not know, a sub-run pointer with no row). `detail` says which.

Two pauses deliberately do **not** wake a waiter, because neither is owed a response: a
gate that has already been approved or rejected and is awaiting auto-resume, and a
[`wait:` node](/guides/authoring-workflows/) whose timer or event has not fired.

Once the wait is watching, it says so once on **stderr** — one plain sentence, or the
same envelope with `"result": "waiting"` and the status it attached on under `--json`:

```json
{ "ok": true, "action": "wait", "runId": "…", "result": "waiting", "observedStatus": "running" }
```

Until that line the command is completely silent, so a host cannot tell a watch that
has begun from one still resolving the id. It is on stderr precisely so stdout keeps
carrying exactly one document. A run that already has something to say answers on the
first read, and never prints it.

The run id may be the short prefix printed by `workflow runs`. Once the wait returns,
inspect the run normally with `workflow get <run-id>`.

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
dies before it starts the run surfaces as an error carrying the tail of its log rather
than as a success you only discover was false minutes later. A run that simply finishes
inside that window — a short workflow, or one that fails on its first node — is acked
normally; its outcome belongs to the run, and `workflow get <run-id>` reports it.

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
is discarded, so do not assume a string. This acknowledgement has no `transcriptPath`;
use its `runId` with `workflow logs <run-id>` or `workflow get <run-id>` to locate the
transcript. Precheck failures follow each verb's existing error contract:
`{ ok: false }` under `--json`, a thrown error otherwise.

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

An environment a workflow run can still claim is never removed by either mode,
regardless of age or merge state — the same live-run lock the scheduled sweep applies.
That covers running, pending and paused runs, and also **failed** runs: a failed run
stays resumable, and removing its environment deletes the local branch that
`workflow run --resume` and `--adopt` need. Stale environments with quiet
conversations still pass the activity filter; the live-run lock is what keeps them on
disk until no run can claim them.

### `validate workflows [name]`

Validate workflow YAML definitions and their referenced resources (command files, MCP configs, skill directories).

```bash
archon validate workflows                 # Validate all workflows
archon validate workflows my-workflow     # Validate a single workflow
archon validate workflows my-workflow --json  # Machine-readable JSON output
```

Checks: YAML syntax, DAG structure (cycles, dependency refs), command file existence, MCP config files, skill directories, provider compatibility, tier/alias model refs, and supported static environment reads in inline or named exec sources. An unprovided `INPUTS_*` read is an error when the workflow declares an input contract; other unprovided Python or JavaScript/TypeScript environment reads warn. See [Variables](/reference/variables/#shell-quoting-in-bash-vs-script) for the supported forms and fixes. For bundled and global workflows, validation rejects `@custom` model aliases because they are not portable across projects; use `small`, `medium`, `large`, or a literal provider model string instead. Returns actionable error messages with "did you mean?" suggestions for typos.

Exit code: 0 = all valid, 1 = errors found.

### `validate commands [name]`

Validate command files (.md) in `.archon/commands/`.

```bash
archon validate commands                  # Validate all commands
archon validate commands my-command       # Validate a single command
```

Checks: file exists, non-empty, valid name.

Exit code: 0 = all valid, 1 = errors found.

### Removed: `continue <branch> [message]`

`archon continue` inferred a run from a branch name and injected a prose preamble of git history, pull-request text, and prior artifacts. Continuation that inherits prior work is identified by exact run id instead:

```bash
archon workflow runs --open                       # find the prior run id
archon workflow run archon-ship --adopt <run-id> "resolve the remaining review finding"
```

`workflow run <name> --adopt <run-id>` reuses a terminal run's exact worktree or branch, records `adopted_from_run_id` provenance, and exposes prior artifacts through `$ADOPTED_RUN_DIR`. The orchestrating agent owns choosing the next workflow and writing the input; see [`--adopt <run-id>`](#workflow-run-name-message).

### `complete <branch> [branch2 ...]`

Remove a branch's worktree, local branch, and remote branch, and mark its isolation environment as destroyed.

```bash
archon complete feature-auth
archon complete feature-auth --force  # bypass safety checks
```

**Flags:**

| Flag | Effect |
|------|--------|
| `--force` | Skip safety checks |

Use this after a PR is merged and you no longer need the worktree or branches. If GitHub
has deleted a squash-merged branch, first prune its remote-tracking ref so the local clone
reflects that deletion:

```bash
git fetch --prune origin # replace origin with the configured remote when needed
archon complete feature-auth
```

Completion verifies its patches are already on the configured or detected remote default branch
before removing it. Accepts multiple branch names in one call.

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

Install the bundled `archon-cli` skill into both `.claude/skills/archon-cli/`
(Claude Code) and `.agents/skills/archon-cli/` (Codex). The command overwrites
existing files so both destinations match the current Archon binary. It also
removes the retired `archon` and `manage-run` skill directories.

```bash
# Install into the current directory
archon skill install

# Install into a specific project
archon skill install /path/to/project
```

The unified skill covers workflow execution, run management, setup, configuration,
authoring, and prompt guidance. It is also installed automatically during
`archon setup`.

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
| `--json` | Output machine-readable JSON (workflow `list`, `status`, `runs`, `get`, `wait`, and the write commands `approve`/`reject`/`abandon`/`resume`). Implies log suppression so stdout is exactly the JSON payload. |
| `--timeout <seconds>` | For `workflow wait`: give up after N seconds and exit `3`. Omitted means wait indefinitely. |
| `--follow` | For `workflow logs`: wait for the transcript and stream appended rows until the run ends. |
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
