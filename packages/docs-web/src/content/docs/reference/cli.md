---
title: CLI Reference
description: Every Archon command, what it does beyond its --help text, and the output and exit codes scripts can rely on.
category: reference
area: cli
audience: [user]
status: current
sidebar:
  order: 3
---

`archon --help` lists every command and flag, and `archon <command> --help` shows one command's slice. This page covers what the help text cannot: behavior, output shapes, exit codes and the rules that decide where a command runs.

## Before you start

Install Archon and add a provider; see the [Quickstart](/getting-started/quick-start/). From a source checkout, run `bun run cli` in the repository, or `bun link` inside `packages/cli` to put `archon` on your PATH; see [Installation](/getting-started/installation/#from-source).

The `workflow` subcommands, except `attention`, `test`, `wake` and `signal`, plus `isolation`, `complete`, `validate` and `setup --scope project`, run inside a git repository; a subdirectory resolves to the repository root. A non-git directory also works when it is a registered [folder project](/guides/multi-repo-projects/), or on first use with `--folder`, which registers it and runs in place. Every other command works from any directory. See [Working directory](#working-directory) for how the project is resolved.

## Setup and maintenance

### `setup`

Interactive wizard for credentials and configuration.

```bash
archon setup                      # writes ~/.archon/.env (home scope, the default; applies to every project)
archon setup --scope project      # writes <repo-root>/.archon/.env, overriding home scope; needs a git repository
archon setup --providers codex    # install maintained providers (claude, codex, pi) and skip that question
archon setup --force              # replace the target file instead of merging (a backup is still written)
archon setup --spawn              # open the wizard in a new terminal window
```

Project scope overrides home scope except for CLI `GH_CONFIG_DIR` and inherited workflow identity; see [forge configuration](/reference/forge/#plugin-configuration).

`--providers` takes precedence over `ARCHON_PROVIDERS`; both accept comma-separated IDs and skip the provider selection question. An explicit empty value selects none. Without either, setup asks which maintained providers to install, installs that selection in release binaries, and renders their diagnostics before collecting native authentication and configuration. Source checkouts run maintained providers from source. Selecting none installs nothing and prints `archon provider add <claude|codex|pi>`; setup never silently selects a provider. With multiple selected providers, it asks which should be the default and saves that choice.

Setup never writes to `<cwd>/.env`; that file belongs to the project. It writes one Archon-owned file chosen by `--scope`, merges into its existing content so keys you added survive, and writes a timestamped backup such as `~/.archon/.env.archon-backup-2026-04-20T09-28-11-000Z` before every rewrite.

For GitHub, choose a personal access token (the solo default) or a [GitHub App](/adapters/github-app-setup/) (recommended for teams). App mode collects the App ID, private-key path or inline PEM, webhook secret, and optional slug. When switching modes, setup asks for confirmation before replacing GitHub authentication keys, removes the other mode’s keys, writes the webhook secret you enter when switching to App mode, and, without `--force`, preserves unrelated values and the other webhook settings. With `--force`, setup replaces the target file wholesale after backing it up. With that flag, Add mode asks for credentials again for every existing platform as well as any additions. Same-mode reruns keep existing non-empty values unless `--force` is given. An incomplete App ID/key pair is replaced together after confirmation; Add also collects missing webhook settings and resolves dual-mode settings through the same confirmation. If the other scope supplies conflicting GitHub credentials, setup stops and names that file so you can remove the conflict explicitly. Secrets are saved to the selected env file and are not displayed.

After you pick the default assistant, the wizard offers an optional default chat model for it: a short list (for Claude, `sonnet`, `opus` and `haiku`) plus free text. Press Enter to keep the SDK default. The choice is written to `~/.archon/config.yaml` as `defaultAssistant`, plus `assistants.<provider>.model` when you chose a model, the same write as [`archon ai default <provider> [<model>]`](#ai). Pi skips the model prompt because its backend and model are chosen earlier in the wizard.

### `doctor`

Verify your Archon setup. Runs a checklist of common failure points: installed provider versions and unavailable-plugin reasons, each registered provider's own diagnostics, the configured assistant's native login, OpenCode runtime SDK and executable presence, database reachability, workspace writability, bundled defaults, folder-project detection (contained repos, when run from one), telemetry state, AI credentials connected in Archon, and adapter token pings (Slack/Telegram, best-effort). Doctor exits 1 when any check fails and 0 when every check passes or is skipped. A warning does not change the exit code; the summary line counts warnings instead of reporting that all checks passed. Adapter pings report `skip` on network errors, so a flaky connection does not fail the run. `archon setup` offers to run doctor when it finishes.

```bash
archon doctor
```

Doctor does not check forge access for the bundled SDLC pack. Run `archon workflow run archon-forge-check` from the checkout for that; it names the credential source it used or says why it refused. See the [SDLC pack README](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/README.md).

With no registered providers, doctor fails and prints `archon provider add <claude|codex|pi>`. Stale maintained plugins fail with their installed and CLI versions and the reinstall command. The AI credentials check uses each connected credential the way a database-store run would: it decrypts it and refreshes an expired subscription grant (saving the rotated grant). It prints one line per credential and fails when one cannot be used (it cannot be read, or the vendor rejected the refresh), naming the command that reconnects it. It warns when a credential could not be verified, for example because the vendor was unreachable. An API key is reported usable once it decrypts; only a model request proves the vendor accepts it.

The assistant login check uses the merged configuration and the provider's own runtime, unless that model's vendor already has a credential connected in Archon that the assistant can use. Provider specifics:

- **Pi:** Pi cannot use a connected Claude subscription: with no native Anthropic login, the check fails and names `provider: claude`. When Archon config names no model (Pi then uses its own default), doctor cannot tell which vendor the run uses, so a missing native login is a warning, not a failure, if you have connected a credential the assistant can use. Pi resolves its configured key during the check, so a key command runs during `archon doctor`; a command that prompts can prompt again at run start. The check builds the runtime a run builds, which runs every provider's `!command` key stored in Pi's `auth.json`, not only the configured provider's. For a model in Pi's catalog, a run resolves a `models.json` key command once when a node starts and uses that key for the whole node, so a short-lived token can expire before a long node ends; a model from an extension provider runs its key command on each request. Pi OAuth checks may refresh through Pi's runtime.
- **Codex:** Codex reads its native account through app-server and asks it to refresh the sign-in, so a revoked login fails the check (a run does not make this call); an API key is usable once resolved. When Codex is configured for a model provider that needs no OpenAI login, the check is skipped.
- **Claude:** Claude reads account information through its SDK without sending a model request.
- **Copilot, OpenCode and Claude cloud backends** with externally resolved credentials report "not checked". The OpenCode check verifies that the embedded runtime SDK module resolves and the `opencode` executable is available on the inherited `PATH`. It never boots the runtime, which would spawn a child process and bind a port.

OpenCode and Copilot are bundled but [deprecated](/getting-started/ai-assistants/#deprecated-providers): doctor runs their diagnostics only when one is your default assistant or has settings under `assistants`, and does not count them as installed providers. The provider support check warns when the default assistant is a [deprecated provider](/getting-started/ai-assistants/#deprecated-providers).

`doctor` still inspects SQL credentials and may skip a native login check when a stored credential covers that vendor. Its stored-credential results do not describe authentication for `store: files`: file-store runs ignore stored credentials and check the native or environment account at launch.

In GitHub App mode, doctor validates the App ID and RSA private key from `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH` locally. It reports incomplete, invalid, or conflicting App/PAT configuration as a failed check, without printing secrets. This check does not require `WEBHOOK_SECRET` and does not verify GitHub access remotely.

### `provider add`

Add or replace maintained providers from the matching Archon release:

```bash
archon provider add claude codex pi
```

Adding a provider connects Archon to your agent CLI or SDK; it does not install that CLI.

The command accepts only `claude`, `codex`, and `pi`, pins the first-party repository tag to the CLI version, and uses the plugin installer's checksum verification. Maintained ids cannot be installed from another repository. Remove a receipt with `archon plugin remove coleam00/Archon/plugins/provider-<id>`.

Release binaries ship without Claude, Codex and Pi and load them only from what this command installs. The quick installers run it for the providers you select (`--providers` / `-Providers` / `ARCHON_PROVIDERS`), and `archon setup` runs it for its selection. An installed provider must match the CLI version, so run it again after upgrading Archon. Source checkouts and Docker run these providers from source over the process transport and refuse this add command.

The default provider comes from explicit configuration (`assistant` in project config or `defaultAssistant` in global config), then `DEFAULT_AI_ASSISTANT`, then the only registered provider. With multiple providers and no configured default, a run needing one fails before creating a worktree. A workflow can select its provider explicitly.

### `plugin`

Add and manage plugins published on GitHub. A plugin is `owner/repo[/path]`, the directory holding its `archon-plugin.json`; a version is a tag. Forge plugins, provider plugins, chat plugins, and workflow packs install through this command.

```bash
archon plugin add coleam00/Archon/plugins/forge-github         # forge: latest release
archon plugin add coleam00/Archon/plugins/forge-github@<tag>   # a specific release
archon plugin add owner/repo[/path]                             # workflow pack: default branch head
archon plugin add owner/repo[/path]@<tag>                       # workflow pack: a tag
archon plugin update <id>[@<tag>]
archon plugin remove <id>
archon plugin copy <id>                                             # workflow pack into ./.archon/workflows/
archon plugin list
```

The former plugin `install` verb remains a deprecated alias for `archon plugin add` and prints a warning.

`add` refuses an already-installed plugin (use `update`) and a file it did not install. Every check, including the manifest's `compatibility.archon` range and a provider or chat plugin's staged handshake, runs before installed files or receipts are replaced. Without `@<tag>`, the manifest at the default branch head decides the kind: a workflow pack installs that commit, and a forge, provider, or chat plugin installs its latest release, because its executables exist only as release assets. See [Forge operations](/reference/forge/#install-the-github-plugin) for what a forge install downloads and where it writes.

`list` reports every receipt that cannot be read, parsed, or validated with its file path and error. For a receipt at a valid `owner/repo[/path]` location, `remove <id>` deletes that receipt but leaves the files it named, because they can no longer be identified. `update <id>` installs the plugin again and writes a fresh receipt; it replaces an existing executable only when no other receipt, valid or unreadable, could own it. A binary plugin update must still read the old receipt to back it up. If permissions prevent that, restore read access first, or remove the receipt, then inspect its leftover executable and move or delete it if unused before reinstalling. A stray receipt outside a valid plugin-id location cannot be removed or repaired by these commands; delete the receipt file by hand using the path shown by `list`. `copy <id>` requires a readable workflow-pack receipt for that id and rejects a broken one; run `update <id>` to repair it, or `remove <id>` then reinstall it before copying. `add` of any other plugin refuses until every unreadable receipt is repaired or removed, because the files those receipts own are unknown.

A provider plugin records its descriptor in the receipt and registers on the next CLI invocation or server restart. A workflow names its descriptor id in `provider:`. See [Provider plugins](/guides/publishing-plugins/#provider-plugins) for executable naming, capabilities, credentials, and the process environment.

A chat plugin records its validated descriptor after an initialization-only handshake. On server restart, each usable chat receipt starts one supervised plugin process; a receipt that is unreadable or does not own its executable is logged and skipped until `update <id>` or `remove <id>` repairs it. Install, update, and removal take effect at the next restart. In Docker, `SLACK_BOT_TOKEN` declares offline provisioning of the image-provided Slack plugin: removing it while tokens remain configured reinstalls it on the next boot. Remove the tokens from every effective env source as well to keep Slack removed. Valid installed Slack releases are retained; image upgrades do not update them. See [Chat plugins](/guides/publishing-plugins/#chat-plugins) for release assets, platform-id collisions, and installation behavior.

A workflow pack installs complete at one commit. The command fetches the tag, or the default branch head, with `git fetch --depth 1` into a private repository, reads the plugin directory of that commit, and refuses the pack if that directory holds a symlink, a submodule, a path that escapes it or a file name containing `\` or `:`, if an entrypoint is missing, or if another installed pack has the same owner and `name`. Git's credential setup applies to the fetch, but the manifest is first read unauthenticated from `raw.githubusercontent.com`, so a private repository cannot be installed. The tree is written to `ARCHON_HOME/plugins/packs/<id>/<commit>/` and then the receipt to `ARCHON_HOME/plugins/installed/<id>/receipt.json`, so a reader sees either the previous complete install or the new one. With a readable receipt, `update` replaces the tree and prints the old and new commit; `remove` deletes the receipt and that tree. When repairing an unreadable receipt, `update` prints only the newly installed commit and cannot identify old trees at other commits. Inspect `ARCHON_HOME/plugins/packs/<id>/` and remove old trees manually only after confirming they are unused. Nothing updates in the background. Installed entrypoints run as `owner/plugin:entrypoint`; see [Installed workflow packs](/guides/global-workflows/#installed-workflow-packs) for the pack layout and how runs resolve them.

`copy` writes the installed tree to `.archon/workflows/<name>/` at the root of the repository you run it in (or `--cwd`); in a folder project, the directory itself. It refuses when that directory exists. The copy is an ordinary project workflow pack from then on: you own and edit it, and `update` or `remove` do not touch it.

### `skill add [path]`

Install the bundled `archon-cli` skill into both `.claude/skills/archon-cli/`
(Claude Code) and `.agents/skills/archon-cli/` (Codex). The command overwrites
existing files so both destinations match the current Archon binary. It also
removes the retired `archon` and `manage-run` skill directories.

```bash
# Install into the current directory
archon skill add

# Install into a specific project
archon skill add /path/to/project
```

The unified skill covers running and watching workflows, answering runs that need a
decision, driving the SDLC pack's queues, setup and configuration, authoring, and
prompt guidance. It is also installed automatically during
`archon setup`. The former `skill install` verb is a deprecated alias that prints a warning.

### `serve`

Start the web UI server in the foreground. The same command works from a binary install and from a source checkout. The server runs as a child process.

**Binary installs** automatically download the server executable and web UI from the matching GitHub release on first run. The command announces the version, asset and download size, verifies each against the checksum embedded in the CLI, and starts the server. Later runs use the cached artifacts. Non-serve commands need no server installation.

**Source checkouts** start `packages/server/src/bin.ts` with Bun and serve the web UI you build yourself, at `packages/web/dist`. Run `bun run build:web` from the repo root before your first `archon serve`, and again after frontend changes. Nothing is downloaded, so `--download-only` is refused, and a missing build stops the command with the build command to run instead of serving an empty page.

```bash
# Start web UI server (binary installs download the server and UI on first run)
archon serve

# Override the default port (3090); 1 to 65535
archon serve --port 4000

# Download the server and web UI without starting the server (binary installs only)
archon serve --download-only
```

The server executable is cached at `~/.archon/server/<version>/` and the web UI at `~/.archon/web-dist/<version>/`. Upgrading the CLI downloads matching artifacts on the next `archon serve`. A failed download installs nothing for that asset and exits non-zero with its URL; retry with `archon serve --download-only`. Docker continues to bundle both.

### `version`

Show version, build type, and database info.

```bash
archon version
```

### `telemetry`

- `telemetry status` shows whether anonymous telemetry is enabled, the opt-out reason if not, the install UUID, the PostHog host and the key source. Use it to confirm that an opt-out such as `DO_NOT_TRACK=1`, `ARCHON_TELEMETRY_DISABLED=1`, `CI=true` or `POSTHOG_API_KEY=off` is picked up. It never creates a `telemetry-id` file while you are opted out.
- `telemetry reset` rotates the anonymous install UUID in `ARCHON_HOME/telemetry-id`. The old ID is overwritten and cannot be recovered. It exits 1 when the file cannot be written.
- `telemetry no-match` records an agent's decision that the user asked for work and no available workflow fits. Chat agents on native-tool providers use `report_workflow_no_match`; CLI providers call this command. It emits the anonymous `workflow_no_match` event, respects opt-out and launches nothing. Ordinary questions and missing project or input details are not no-match decisions.

## Workflows

### `workflow list [name]`

List workflows available in the target directory, or inspect one workflow by name.

```bash
# Compact discovery output
archon workflow list --cwd /path/to/repo

# Machine-readable output for scripting
archon workflow list --cwd /path/to/repo --json

# Exact, untouched description for one candidate
archon workflow list archon-review --full --json
```

Discovers flat, one-level grouped, and exact `<pack>/<workflow>/` packaged layouts from `.archon/workflows/` and `~/.archon/workflows/`, plus bundled defaults. See [Global Workflows](/guides/global-workflows/).

The default output is a compact discovery view. Descriptions of at most 160 Unicode code points are returned unchanged. Longer descriptions are whitespace-normalized and reduced to their first sentence when it fits, or to preview content of at most 160 code points at a word boundary. Human-readable output appends ` [truncated]` after a shortened description. JSON keeps the description text separate from its truncation state: `descriptionTruncated` is `true` when content was omitted. Fetch the full description before choosing or launching a workflow when that field is `true`.

The optional `name` resolves like a run does (see [Workflow name matching](#workflow-name-matching)). An ambiguous name fails instead of choosing a workflow.

`--full` returns exact authored descriptions; give it a `name` to see one workflow's full detail. With `--json`, the output is `{ "workflows": [...], "errors": [...] }`, and `--full` sets every `descriptionTruncated` to `false`. Optional fields (`provider`, `model`, `effort`, `webSearchMode`, `parseWarnings`) are omitted when a workflow does not set them. A workflow written with the deprecated `modelReasoningEffort:` reports that value as `effort`, unless it also declares `effort:`, which wins. Each `parseWarnings` entry names a key the engine dropped or deprecated, where it was found and what to write instead; see [Unknown keys](/reference/workflow-language/#unknown-keys-are-reported-not-rejected). Discovery errors remain in the top-level `errors` array when a name filters the workflow list. If the named workflow is missing or ambiguous, the failure envelope is `{ "ok": false, "error": "...", "errors": [...] }`, retaining errors found during the same discovery.

### `workflow test`

Replay the dry-run fixtures declared next to a workflow. A fixture is a `<name>.stubs.yaml` file in the `fixtures/` folder beside the workflow YAML. `workflow test` never creates a run or contacts a provider; [Build your first workflow](/getting-started/first-workflow/#keep-the-routes-as-fixtures) walks through writing them.

```bash
archon workflow test                     # every fixture in the repository
archon workflow test build-change        # one workflow, by name
archon workflow test .archon/workflows/my-team   # a workflow folder or pack, by path
archon workflow test build-change --json
```

A relative path resolves from the invoking directory before the repository root. Every key in a fixture other than the two reserved keys is a node stub, exactly what `workflow run --dry-run --stubs` accepts. The reserved keys are:

| Key | Meaning |
| --- | --- |
| `fixture.expect` | Simulation outcome: `completed` (the default), `failed`, `paused` or `cancelled` |
| `fixture.authored` | Optional authored outcome expectation: `succeeded` or `failed`. A mismatch or an undeclared verdict fails the fixture |
| `fixture.fail-node` | Required when `expect: failed`. A node id, or a list naming the exact failed set (a loop body failure is the node and its group) |
| `fixture.reached` | Nodes that must complete or be stubbed |
| `fixture.inputs` | Values for the workflow's declared inputs |
| `fixture.resolved-text-contains` | Map of node id to a fragment that must appear in that node's resolved text |
| `exec-code` | `true` executes `bash:` and `script:` nodes, in a scratch worktree of `HEAD`, instead of requiring stubs |

The command exits 0 when every fixture passes, including when none are declared. It exits 1 when a fixture fails, a workflow cannot load, or a named target has no fixtures. `--json` prints `{ results, passed, failed, errors }`. Each result can include `nodeFailures: [{ nodeId, reason }]` with the failed nodes' diagnostics. This field can be present when the fixture passes because it correctly expects a node to fail; `failureReason` describes a fixture verdict failure and can be absent in that case.

Fixtures with `exec-code: true` receive the same environment as [executable dry runs](#deterministic-dry-run): inherited process values, file-configured `env`, then registered-project environment values, with later sources winning. Environment lookup happens only for executable fixtures. If lookup fails, that fixture fails with the lookup error; independent stub fixtures still run and workflow-load errors remain in the report.

### `workflow run <name> [message]`

Run a workflow with an optional user message, which the workflow reads as `$ARGUMENTS`.

```bash
# Basic usage
archon workflow run investigate --cwd /path/to/repo "Why does the export job time out?"

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

Except on an execution handoff, foreground completion and failure output prints the run's recorded cost and input and output tokens, even with `--quiet`:

```text
  Usage (recorded totals; completeness unknown):
    Cost: $0.024
    Input tokens: 8420
    Output tokens: 2180
```

These are stored figures, not a certified bill, so the completeness warning is always printed. Provider usage metadata is optional: a missing or malformed value prints `unknown`, and a recorded zero prints `0` (or `$0`). An unknown or malformed token-uncertainty marker makes both token counts unknown. If the persisted run cannot be read, the output shows `Usage: unavailable (persisted run unavailable)` and the execution result is unchanged. [`workflow get`](#workflow-get) shows the same summary for any run.

If another execution takes ownership before the foreground command returns, it prints:

```text
Workflow execution handed off. Observed status: <status>.
```

`<status>` is the status observed at handoff, or `run removed` if the row no longer exists.
This output omits recorded usage and authored outcome. Exit `0` means this execution handed
off without observing `failed` or `cancelled`; it does not prove the workflow completed.
An observed `failed` or `cancelled` status exits non-zero. Use
[`workflow wait <run-id>`](#workflow-wait) to wait for the next terminal or gate transition,
and [`workflow get <run-id>`](#workflow-get) to read current status, usage, and authored outcome.

Progress events (node start/complete/fail/skip, approval gates) are written to stderr during execution. The workflow-start output also names the absolute local path of the run's JSONL transcript. Use [`workflow logs`](#workflow-logs) when you have a run ID and want the content rather than the path.

If the workflow's YAML declares keys the engine ignores, a warning naming each one goes to stderr before the run starts, even under `--json`, so stdout stays exactly the JSON payload. See [Unknown keys](/reference/workflow-language/#unknown-keys-are-reported-not-rejected).

A real run prints a JSON payload only with `--detach`. Without it, `--json` suppresses logs but the command still prints human progress (`Running workflow: …`) to stdout, so do not parse a plain `run --json`. `--dry-run --json` is the other machine-readable form: it prints one complete trace document.

**Flags:**

| Flag | Effect |
|------|--------|
| `--workflow-source <path>` | Read the workflow, its commands, and its scripts from this directory instead of `--cwd`. Lets an **uncommitted** workflow in one checkout run against a different checkout, repository, or folder project, with no commit, push, or merge. Fresh runs only; rejected with `--resume`, because a resumed run executes the source it already captured. See [Running a workflow from another checkout](#running-a-workflow-from-another-checkout). Repo config is not part of the source: the run reads `.archon/config.yaml` from the launch checkout (`--cwd`); see [Where a run reads `.archon/config.yaml`](/reference/configuration/#where-a-run-reads-archonconfigyaml). |
| `--branch`, `-b <name>` | Branch name for the worktree; reuses an existing worktree for it. A worktree created for a named branch is never removed when the run ends; `isolation cleanup --merged` removes it |
| `--from <branch>`, `--from-branch <branch>` | Start point for the new worktree only. Unlike `--base`, it does not change the PR target. |
| `--base-branch <name>` | Choose the project base branch on first registration only. Omit to follow the remote default at use time; no prompt. Rejected for folder projects, existing projects, resume/adoption/supersedes, and dry runs. A reachable remote must advertise the branch. With `--base`, this flag stores the project choice while `--base` overrides only this dispatch. |
| `--base <branch>` | Per-dispatch base override, inherited by fresh shared-checkout children. Sets **both** the worktree cut-from **and** the PR target (`$BASE_BRANCH`), and outranks `worktree.baseBranch` in config plus the codebase default; see [Base branch precedence](#base-branch-precedence) below. The branch **must already exist on the remote**; a missing one is a hard error, not a fallback. Combine with `--from` to drive the two separately. Rejected with `--no-worktree`, `--folder`, and workflows pinning `worktree.enabled: false`. |
| `--project <id\|name>` | Bind a fresh run to an existing registered repository by ID or exact name (for example `owner/repo`); see `archon project list`. Folder projects are unsupported. See `archon workflow run --help` for incompatible flags. |
| `--no-worktree` | Run directly in the live checkout, without isolation |
| `--folder` | Register the current directory, git or not, as a folder project on first use and run in place, without a worktree. Rejects `--branch`, `--from` and `--base`. |
| `--container` | Run a **folder project** inside an overlay-isolated Docker container instead of in place (writes land in an overlay, not the live root, until an approval-gated write-back). Folder-only; a repo project errors. Requires the runner image (`bun run build:runner-image`). Normal gate pauses `docker stop` the container; `--resume`/`approve`/`reject` rediscover and restart it after resume admission. Failed resume setup marks the run failed. Failed setup or suspension can leave its container running and consuming resources; see [Pause economics](/guides/container-isolation/#pause-economics). See the [Container isolation guide](/guides/container-isolation/) and [configuration](/reference/configuration/#container-isolation-folder-projects). |
| `--input <name>=<value>` | Supply one value for the workflow's declared `inputs:`. **Repeat the flag per input.** Splits on the first `=`, so the value may itself contain `=`; `--input name=` supplies an empty string. Omitted inputs take their declared `default:`. A missing **required** input or an **undeclared** name is refused before any worktree, clone, or AI cost, through the same contract a composing `with:` map goes through. Works with `--dry-run` (inputs resolve exactly as in a real run). Rejected with `--resume` (a resume replays the inputs recorded on the run). See [Running a workflow that declares inputs](/reference/workflow-language/#running-a-workflow-that-declares-inputs). |
| `--model <name>=<spec>` | Rebind one `small`, `medium`, `large`, or `@alias` for this run. **Repeat the flag per binding.** An Archon agent prefix selects that agent (`codex/gpt-5.6-sol`); another valid vendor/model ref selects Pi (`openai/gpt-5.6`); an unqualified model keeps the binding's current provider, so binding an `@alias` no config defines (one a workflow's model preference list names, such as `@reviewer`) needs a prefixed model, a tier, or another alias; a tier or alias RHS copies that preset. Unspecified names keep their user → repo → global → built-in values. Literal `model:` pins and nodes that never reference the rebound name do not change. Bare `--model <spec>` is invalid, there is no run-wide `--provider`, and the flag is rejected with `--resume`. Works with `--dry-run`. |
| `--config <path>` | Load one sparse YAML config layer for this fresh run. Relative paths resolve from the directory named by `--cwd`, even when it is a repository subdirectory. Values in the file override persistent config and user AI preferences; explicit `--model` flags then replace only their named bindings. Works with `--dry-run` and `--detach`; the parent validates and seals the layer before handing it to a detached child, so later file edits cannot change that launch. Rejected with `--resume` because a continuation restores the sealed layer recorded when the run started. |
| `--config-from-run <run-id>` | Start this fresh run with the run config layer the named run was started with, as if its `--config` file were passed again. A run started without `--config` contributes nothing, so the new run uses the install's config alone. Use it when one workflow launches another to continue the same work, so the continuation keeps the provider configuration it started on. Exclusive with `--config`, and rejected with `--resume`. Works with `--detach`. |
| `--resume` | Select the newest eligible run by start time for this workflow name and working path: a failed or paused run, or a `running` run whose last activity timestamp is missing or more than one day old. With a SQL store, a `running` run is excluded while its resource-start request is `admitted`; see [trigger inspection](/guides/workflow-triggers/#choose-a-resource-capacity-and-overlap-policy). Resume skips completed nodes and reuses the run's recorded AI configuration. Missing or old activity does not prove the owner is gone; verify that before resuming a `running` run. Rejected with `--branch`. Prefer [`workflow resume <run-id>`](#workflow-resume) when you hold the id of a failed or paused run. |
| `--adopt <run-id>` | Start a new run in a terminal run's exact worktree or branch, with `adopted_from_run_id` provenance and `$ADOPTED_RUN_DIR` access. Inherits its recorded AI configuration; conflicting AI config or model overrides are rejected. Run-id selection is exact; adoption never infers a run from workflow name or prompt text. |
| `--supersedes <run-id>` | Start in a fresh estate while recording that this run replaces a terminal prior run. Unlike `--adopt`, it inherits no checkout. |
| `--quiet`, `-q` | Suppress the progress lines on stderr |
| `--verbose`, `-v` | Also print tool calls (name and duration) in the progress lines, and debug logs |
| `--detach` | Run in a detached background child and return before completion. Human output names the transcript and the child's log file; the `--json` acknowledgement carries `runId`, `transcriptPath` (the run's JSONL transcript) and `logPath` (the child process's stdout and stderr). Follow execution with [`workflow logs <run-id> --follow`](#workflow-logs) and wait for the next terminal or gate transition with [`workflow wait <run-id>`](#workflow-wait). `approve`, `reject`, `respond` and `resume` accept it too; see [Detached control verbs](#detached-control-verbs). |
| `--conversation-id <id>` | Correlation id for the run's messages. It creates no conversation and no `persist_session` scope. |
| `--dry-run` | Simulate deterministic DAG control flow in memory. Creates no run, worktree, session, event, artifact, or provider request. |
| `--stubs <path>` | YAML mapping of node ids to scalar or structured outputs for `--dry-run`. Relative paths resolve from `--cwd`. |
| `--stubs-init <path>` | Write a complete stub scaffold for the expanded workflow and exit. Refuses to overwrite an existing file. Relative paths resolve from `--cwd`. |
| `--default-stubs` | Fill reachable nodes omitted from `--stubs` with schema-valid placeholders. Explicit stubs still win; without this flag, a missing reachable stub remains an error unless the node declares `trigger_rule: all_done`. |
| `--exec-code` | During `--dry-run`, execute trusted `bash:`/`script:` nodes locally instead of requiring stubs. Default is no code execution. |
| `--pause-at-gates` | During `--dry-run`, stop at the first deprecated `approval:` gate instead of auto-approving it. An [attention wait](/reference/workflow-language/#attention-waits) needs no flag: it pauses the simulation unless the stubs answer it. |

Fresh CLI runs do not create a chat conversation, message history, or title. Execution output stays in stdout and the run's transcript, events, and artifacts. Resuming a run with an existing chat origin keeps recording into that conversation.

#### Where the run executes

By default, a run:

- creates a worktree on a generated branch, `archon/task-<workflow>-<timestamp>`;
- registers the codebase on first use in a git repository;
- reads `.archon/config.yaml` from the launch checkout, not the new worktree, so uncommitted and gitignored config applies.

With `--branch <name>`:

- The worktree is `~/.archon/workspaces/<owner>/<repo>/worktrees/<name>/` (or the repo-local path `worktree.path` configures). A healthy existing worktree is reused.
- If the branch already exists but no worktree holds it, checks it out at its current head: the local branch, or `<remote>/<branch>` when that contains the local branch (the local branch is fast-forwarded to it). It never resets an existing branch to the base.
- Fails before any work if the local branch and `<remote>/<branch>` have diverged. Reconcile them, or delete the local branch to start from the remote one.
- To start fresh from the base, delete the branch (`git branch -D <name>`, and the remote branch if there is one) or choose another name.
- `--from` is rejected when the branch already exists, locally or on the remote.

`--no-worktree` runs in the target directory with no isolation and cannot be combined with `--branch`, `--from` or `--base`.

#### Per-run config files

New runs record the resolved assistant, provider defaults, tiers, aliases, and model bindings at launch preparation, reading `.archon/config.yaml` from the launch checkout (the current directory or `--cwd`), including uncommitted and gitignored edits. See [Where a run reads `.archon/config.yaml`](/reference/configuration/#where-a-run-reads-archonconfigyaml). Resume and continuation reuse them even after config or user AI preferences change. New child runs inherit the parent's recorded AI base; existing children keep their own record. Detached launches persist this record before spawning the child. Adoption inherits the prior run's recorded AI policy, while supersession prepares fresh policy. Adoption of a recorded run rejects new `--model` bindings and AI fields in `--config`; non-AI fields remain allowed. Older runs without this record keep today's current-config resolution.

Credentials are checked freshly and are excluded from the AI record. Provider-native settings and guidance remain live, including Claude setting sources, provider binary paths, Codex search and additional directories, and Copilot config directory, discovery, login selection, and logging. Process-owned Pi environment and concurrency settings and non-AI runtime settings also remain live. Workflow source selection still controls the graph and scripts separately from this AI policy.

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
- **Resume needs no source path.** Every continuation (`archon workflow resume <run-id>`, `archon workflow run <name> --resume`, `approve` and `reject`) loads the run's own captured source, which is why `--workflow-source` is refused alongside `--resume`.

The capture lives at `~/.archon/workspaces/<project>/workflow-source/runs/<run-id>/`, beside the run's artifacts, and is kept as long as the run's other output. It is not inside `$ARTIFACTS_DIR`, which is the run's output channel. Its manifest records a content digest and the source-resolution settings, and the run row stores both too. Archon hashes the full capture during discovery, on resume and before every later command, named script or composed-source read, and refuses the read, and any container dispatch, when the capture changed. Start a fresh run to execute the current workflow.

When this host cannot read the capture, or it is missing here, the run never falls back to live source. After admission, Archon releases the run so a host that can read the capture continues it (see [`workflow wake`](#workflow-wake)); if recording that release fails, the run is recorded as failed. Before admission, execution is refused until the capture is readable. A run that started before Archon captured source resumes against the current source with a warning. An older capture without stored source-resolution settings is verified against its digest, and its settings are copied from the manifest to the run row on first resume.

These checks find a mismatch that exists when Archon checks. They do not seal the directory or make execution a security sandbox: another process running as the Archon user can still change a file after a check, and parallel nodes that already started are not cancelled. Inline node bodies and command bodies compiled into an included graph are already in memory. A runtime `workflow:` child captures the live authoring source when the child starts. If the parent's recorded authoring directory has moved or been deleted, Archon refuses to start the child rather than capture a same-named workflow from the target checkout.

A compiled binary writes its embedded bundled workflows, commands and scripts into the capture too, so upgrading Archon between a pause and its resume is safe: the run keeps the bundled content it started with.

For `--container` runs, Archon checks the host capture before dispatch and bind-mounts it read-only at the same absolute path inside the container, so a named script resolves the same way on the host and in the container. `$ARTIFACTS_DIR` is bound the same way, read-write. The read-only bind does not contain a hostile process: native overlay mode has `CAP_SYS_ADMIN`, and a same-UID host process can still race a check. `--workflow-source` is refused with `--container`, because a folder project's source and target are the same directory.

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

The scaffold is derived from the already-expanded workflow, so included top-level nodes use their flattened ids (for example, `review__classify`). Body nodes of a `loop_group` keep their bare ids even inside an included block; only the group node gets the `<includeId>__` prefix. Prefer `--stubs-init` over hand-writing keys: the scaffold is the authoritative source for both spellings. Structured `output_format` values are emitted as YAML objects with native booleans, numbers, arrays, and nested required properties. Loop completion fields are generated as `true`. If Archon cannot prove that a generated value satisfies its JSON Schema, scaffold generation fails before creating the file.

The stub file must contain one YAML mapping. Each value is either a string or an object. Object stubs are preserved as structured output, so downstream `$classify.output.severity` references behave like live structured producers. Coverage is strict by default: a reachable AI, bash, or script node without a stub fails the simulation and appears in `missingStubs`.

The one exception is a `trigger_rule: all_done` join, which runs after its dependencies settle regardless of their result. An interaction in a loop body is an exception: a prior body failure prevents it from starting, even with `all_done` (see [loop failure behavior](/guides/loop-nodes/#how-it-works)). A reachable join gets a generated placeholder and is listed in both `missingStubs` and `toleratedMissingStubs`, and the absent stub alone never fails the simulation or a `workflow test` fixture. It is only listed in `toleratedMissingStubs` once that placeholder exists: a node whose `output_format` cannot produce one still fails, and stays out of the tolerated list. A `loop:` node carrying the same trigger rule is tolerated on the same terms, with one addition: the placeholder must also end the loop, which it does by satisfying the node's own completion channel, so a tolerated loop always completes on its first iteration. If a loop's only completion channel is `until:`, the generated output must carry that sentinel as its final line. A string schema can supply it through `const`, `default`, or `enum`; if the generated output does not carry the sentinel, the node fails and stays out of the tolerated list.

Add `--default-stubs` to fill only omitted reachable nodes with the same schema-aware placeholders used by scaffold generation; explicit values always take precedence. Without `--exec-code`, a reachable `bash:` or `script:` node that arrived through `include:` needs a stub like any other: a stubbed node never runs its body, so the caller's `with:` values are never delivered to it. With `--exec-code` it can run unstubbed and reads those values as described below. Supplied stubs for unknown or unreachable nodes appear in `unusedStubs`, while generated placeholders do not. Whole-output references retain their normal lenient behavior, while invalid strict `$node.output.field` references fail the consuming node exactly as they do in a real run. See [Node Output References](/reference/variables/#node-output-references).

A workflow's declared `inputs:` resolve exactly as in a real run: omitted inputs take their declared `default:`, `--input name=value` binds a value (visible in the trace's resolved text), and a missing **required** input or an **undeclared** name fails at the invocation gate with the same errors a real run gives, before any trace output. With `--exec-code`, bash and script nodes also receive the same `INPUTS_<UPPER_SNAKE>` environment variables a real run delivers: run-level inputs, an included block's own inputs, and a script node's `with:` bindings.

With `--exec-code`, child processes inherit Archon's process environment, then apply file-configured `env`, registered-project environment values, and per-run `env` overrides from `--config`, in that order (later values win). Node input variables and engine-owned variables such as `ARTIFACTS_DIR` take precedence over those layers. Registered-project values come from the project resolved for the invocation's working directory. See [configuration](/reference/configuration/) for file configuration and [managed environment variables](/reference/security/#secrets-handling) for stored credentials. Executable fixtures use the same layers, without per-run CLI overrides.

By default, bash and script nodes are never executed. `--exec-code` is an explicit opt-in for trusted local workflow code and is the only dry-run mode that can cause code-level side effects. An executed node that declares `output_format` is certified exactly as in a real run: stdout must be one JSON document that satisfies the schema, and downstream `$node.output.field` references read that certified value. Executed nodes receive `$ARTIFACTS_DIR` and `$STATE_DIR` under an ephemeral per-simulation directory in `~/.archon/temp/` (honoring `ARCHON_HOME`), created before the first executed node and removed when the simulation ends. A dry run writes nothing inside the repository, and a simulation that executes nothing creates no directory at all. An attention wait pauses the simulation where a real run would pause, unless the stub file gives that wait node a stub; the stub then stands in for its answer and must match the form's output, for example `review: { decision: approve, text: "" }`. Deprecated `approval:` nodes auto-complete unless `--pause-at-gates` is set. Runtime `workflow:` sub-runs are reported as unsupported instead of being launched. Dry-run is incompatible with lifecycle and isolation flags such as `--branch`, `--no-worktree`, `--folder`, `--container`, `--resume`, and `--detach`.

The ordered trace records each node as completed, stubbed, skipped, failed, or paused, including its reason, resolved text, and safe output. The result reports two independent facts. `outcome` is the simulation execution result (`completed`, `failed`, `paused`, or `cancelled`) and still controls the CLI exit code. `authoredOutcome` is `succeeded`, `failed`, or `null`, derived only when the workflow declares `returns:` plus a boolean `outcome_field:` and the return node has a schema-valid structured result supplied by a stub or produced by code executed with `--exec-code`. Generated placeholders from `--default-stubs` or an unstubbed `all_done` node do not invent an authored verdict. A completed simulation can therefore report a failed authored outcome. Human output labels these as `Simulation outcome:` and `Authored outcome:`; simulation JSON always includes both fields. `--stubs-init --json` does not run a simulation and instead returns a scaffold acknowledgement with `workflow`, `stubsPath`, and `nodeCount`.

Every node that takes an AI turn also reports the provider and model it will run on and where each value came from, using the executor's own resolution. This answers what a node in a composed workflow runs on, since a composed workflow runs with the configuration its own file declares:

```text
STUBBED   review__scope (prompt)
  runs on: codex (node) / gpt-5.6-sol (node) [from review-block]
  effort: high (node)
```

The origin in parentheses is one of `node`, `model ref` (a tier keyword or `@alias`), `workflow`, `assistant config`, or `default assistant`. `[from <name>]` names the workflow file a composed node was authored in. A node whose declared `provider:` disagrees with the provider its `model:` ref resolves to also reports the warning a real run would emit. `--json` carries the same values under each trace entry's `resolution` object.

This validates deterministic engine wiring; it does not validate model reasoning.

#### Base branch precedence

"Base branch" means two things, and by default one flag sets both: the **cut-from**
(what `git worktree add` branches off) and the **PR target** (`$BASE_BRANCH`, which
bash nodes pass to `gh pr create --base`). Four sources can supply it, highest first:

| Precedence | Source | Scope |
|------------|--------|-------|
| 1 | `--base <branch>` | one dispatch |
| 2 | `worktree.baseBranch` in `.archon/config.yaml` | the repo |
| 3 | The registered codebase's stored default branch | the repo |
| 4 | Live symbolic HEAD advertised by the selected remote | the repo |

Levels 2 and 3 are project choices; level 4 is resolved live using `worktree.remote`
or the automatically selected remote. Use `--base` for a different base on one dispatch. New registrations store a branch only when explicitly chosen with `--base-branch`.
An unset project branch follows the remote's live HEAD advertisement, including renames;
resolution requires a reachable remote with a known symbolic HEAD and never guesses `main`.
Existing stored branches remain explicit, including values older versions detected from a
local checkout. See [Troubleshooting](/reference/troubleshooting/) to clear a stale choice.

`--base` is the per-dispatch level, which is what makes parallel multi-base
dispatch (epic slices, A/B variants) config-free.

**Scope: isolated children resolve independently.** A `workflow:` node with `isolation: worktree`
creates a worktree for its child run, and that worktree is cut using levels 2--4
only. Parent `--base` and `--from` do **not** change an isolated child's cut-from. A parent
dispatched with `--base release/2.0` still branches its isolated children off the
repo's configured base, and the child's `$BASE_BRANCH` reports that provisioning base.
When reusing an isolated branch without a surviving child run record, its original base
is unavailable: `$BASE_BRANCH` stays unresolved rather than guessing from current config.
A fresh shared-checkout child (`isolation: inherit` or omitted) inherits the parent's
resolved `$BASE_BRANCH`, including a parent `--base` override. Existing child runs keep
their recorded base on resume. See [Choosing the child's
checkout](/reference/workflow-language/#choosing-the-childs-checkout-with-isolation).

**Driving cut-from and PR target separately.** `--from` overrides only the
cut-from, so pairing the two flags splits them:

```bash
# Branch off release/2.0, but open the PR against dev
archon workflow run implement --from origin/release/2.0 --base dev "Backport the fix"
```

`--from` is handed to `git worktree add` verbatim, so a remote ref such as
`origin/release/2.0` works. Note the sync-before-create step refreshes the
`--base` branch, not the `--from` start point, so pass a remote ref when the local
copy of the start point may be stale.

**Where `--base` is rejected** (rather than half-applied): with `--no-worktree`,
against a [folder project](/guides/multi-repo-projects/),
and against a workflow pinning `worktree.enabled: false`. None of these create a
worktree, so the flag could only move the PR target, which would report a base
no worktree was ever cut from.

**When an existing worktree is adopted**, by `--branch` naming a healthy worktree
or `--resume` continuing a prior run, the cut-from is already fixed, so `--base`
changes only the PR target. Archon warns in both cases.

**A continuation keeps the base it started with.** A run records its resolved
`$BASE_BRANCH` when it starts, and every continuation of it (`--resume`, an approved
gate, or the automatic resume of a parent whose sub-run gate was approved) reports that
value rather than re-running levels 2--4 against whatever config and git say later.
Passing `--base` again still retargets the PR, as above. A run started before Archon
recorded this re-resolves through levels 2--4 and logs
`workflow.dispatch_not_recorded_resolving_live` when it does.

#### Continuing an existing estate

Use structured continuation whenever a workflow must work on an existing branch or pull request. If you have the prior run id, `--adopt <run-id>` is the authoritative form. Archon reuses the prior worktree as-is. If the prior worktree is gone, Archon reuses a same-repository checkout already holding that branch, or creates one on the exact local branch. It does not fetch, reset, or synchronize the branch; update it first if the remote advanced.

Every node in the new run uses that selected checkout, including bash/script delivery assertions. A branch name written only in the message is model context; it does not move engine-owned nodes to another checkout.

#### Workflow name matching

`workflow run`, `workflow list <name>` and the chat adapters resolve a workflow name in four tiers, stopping at the first tier that matches:

1. Exact: `archon-investigate` matches `archon-investigate`.
2. Case-insensitive: `Archon-Investigate` matches `archon-investigate`.
3. Suffix: `investigate` matches `archon-investigate` (it looks for `-investigate`).
4. Substring: `vestig` matches `archon-investigate`.

When several workflows match at the same tier, the command fails and lists them:

```
Ambiguous workflow 'review'. Did you mean:
  - archon-review
  - custom-review
```

### `workflow status`

Show active runs (running and paused) for the current project, resolved from `cwd` through its registered checkout, including linked git worktrees. `--all` shows active runs across the install. Under [`--chat-project-id`](#global-options) the selected project is used and `--all` is rejected. For every status, use `workflow runs`.

```bash
archon workflow status
archon workflow status --json
archon workflow status --all       # active runs across all projects
archon workflow status --verbose   # add a per-node summary for each run
archon workflow status --json --verbose
```

If `cwd` is an unregistered Git checkout, the command falls back to install-wide active runs and says so. Every successful JSON result carries `scopeFallback`: `true` for that fallback and `false` for a resolved project or explicit `--all` request. A registry lookup failure fails the command instead of returning install-wide runs under the fallback label. A registered folder project scopes normally; an unregistered non-repository directory is rejected with `Not in a git repository` before status lookup.

The normal human and JSON views include every active node without fetching each run's event
history. In JSON, `active_nodes` is the ordered list of unresolved node starts: `node_started` adds
an identifier and `node_suspended` keeps it active, while `node_completed`, `node_failed`, `node_skipped`, and
`node_skipped_prior_success` remove it. Retries re-add the node in their new start position. This
is node lifecycle state, not evidence that a process owner is alive.

Tool-call advisories appear in nonverbose text and in the JSON `attention` field. The run remains `running`; every overdue tool shows its node, provider, sanitized command/title, and elapsed/no-progress duration. The default is 30 minutes without reported progress; see [workflow attention settings](/reference/configuration/#workflow-attention-and-continuation-settings).

### `workflow runs`

List recent runs of every execution status for the current project, resolved from `cwd` like [`workflow status`](#workflow-status). A separate clone does not resolve to that project, even after a launch with `workflow run --project`. `--open` lists the open-work inbox: failed runs that no later run has adopted or superseded.

```bash
archon workflow runs
archon workflow runs --json
archon workflow runs --json --verbose  # add per-node state and attention to each run
archon workflow runs --status failed   # filter to one status
archon workflow runs --limit 50        # cap rows (default 20)
archon workflow runs --all             # list across all projects
archon workflow runs --open            # failed runs nothing has adopted or superseded
```

If `cwd` is an unregistered Git checkout, the command falls back to a global list and says so; `--json` carries `scopeFallback: true` so a consumer never mistakes a global result for a project-scoped one. A registry lookup failure fails the command, including with `--open`; JSON mode returns `{ok:false,error}` with exit code 1.

After a separate-clone launch, use `archon workflow get <full-run-id>` to inspect the run directly, or run `archon workflow runs` from the registered checkout for a project-scoped list. The global list defaults to 20 rows and may omit the run.

The run-list JSON uses the same `active_nodes` contract as `workflow status`. The retained singular
fields are compatibility fields: `current_step_name` and `current_step_status` are populated only
when exactly one node is active, and are `null` for zero or concurrent active nodes. `total_steps`
is always `null` because lifecycle events do not own a truthful declared DAG total.

`--json --verbose` adds two fields to every run, including `--open` rows:

- `nodes`: every node the run declared, in declared order, followed by any node that ran
  without being declared (a loop body such as `candidates.step`) in the order it first ran. A
  declared node no event has reached is `{ "nodeId": "...", "state": "pending" }`; every other
  entry has the same shape as the `nodes` array of `workflow status`/`get --json --verbose`. A
  run with no recorded graph (it has not started executing, or an older Archon ran it) lists
  only the nodes that ran.
- `attention`: what the run needs from outside, if anything: `null`, or an object whose `kind`
  is `terminal`, `awaiting_response` (an approval or response gate), `attention` (a
  `wait: attention` waiting for its answer), `usage_limit` (node `nodeId` hit a provider
  usage limit, or a rate limit that outlasted its retries; the run continues by itself at `resumeAt`), `blocked_on_child` (the child run is the one to inspect), `blocked_on_children` (a fan-out
  waiting on the listed child runs), `stalled_tool_calls` (still-running
  work with overdue provider tools or reported subtasks), or `unreadable`.
  It is read from the run row alone.

The node events for every listed run are read in one query, so the cost does not grow with
one query per run.

The listing shows short 8-character run ids. Every `<run-id>` command below (`get`, `artifacts`, `logs`, `wait`, `resume`, `cancel`, `abandon`, `approve`, `reject`) accepts these short ids when run from the project directory: a unique prefix resolves to the full id, an ambiguous prefix errors, and full ids keep working from any git repository or registered project folder. Short ids from `--all` rows belonging to *other* projects cannot be resolved; use the full id from `--json` for those.

### `workflow get`

Show detail for a single run by ID, regardless of status (unlike `status`, which is active-only). Use it to inspect both how execution progressed and, when declared, the workflow author's verdict. Exits non-zero when the run is not found.

```bash
archon workflow get <run-id>
archon workflow get <run-id> --json
archon workflow get <run-id> --verbose   # add the per-node summary
archon workflow get <run-id> --json --verbose
```

The text view includes the same [recorded usage summary](#workflow-run-name-message)
for any run status. It reads stored totals without recalculating them or certifying
completeness. `--json` retains the raw usage values in `metadata`, including nulls or
malformed historical values; it adds no formatted usage text.

For a paused gate, human-readable output lists its declared decision IDs and optional
labels, with an exact `archon workflow respond <run-id> <decision> [text]` command
for each choice. JSON exposes these choices in `metadata.approval.decisions`.

Once answered, `metadata.approval` also records the surface the answer came through as
`answeredVia` (`cli`, `api`, `manage_run`, or a chat platform id such as `slack`) and the
time as `answeredAt`. The `approval_received` event carries the same surface as `via`, and
the `occurrence` it answered.
A reject that cancels the run leaves no resumable gate context, so on that path the
`approval_received` event (with its `via`, `occurrence` and timestamp) is the record.
These are audit facts. They never name who answered, and nothing routes on them.

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
presentation. Except on an [execution handoff](#workflow-run-name-message), foreground
`workflow run` uses the same labels when an outcome exists, and its exit code follows execution
success or failure. A handoff reports only the observed status and has the exit meaning described above.

Verbose JSON node summaries include `execution` for newly recorded work. It identifies the
invocation, attempt, provider, requested model and any model the provider reported. Inner retries
share an invocation; each retry has its own attempt. A new loop-group iteration creates new body
invocations. Resuming unfinished work keeps its invocation identity.

The run's starting checkout appears as `checkout_baseline` in JSON and as the `Start:` line
in human output. The engine observes it once, right after the run wins its execution claim
and before the first node, and never rewrites it; a resume keeps it. A Git observation gives
the commit, that commit's tree, whether the worktree was clean or dirty (with staged,
unstaged, and untracked counts), and, when Archon created the run's branch, the commit it was
cut from. `not_git` means the directory is not in a Git repository; `unavailable` means the
engine could not read it. `null` means not recorded: the run predates this field or never
started. Node execution records carry the same observation as `invocation.checkoutStart` and
`attempt.checkoutStart`, so you can see which commit each node started at.

Pressing Ctrl-C on a foreground run stops it without losing it. The process that owns the
run records why it stopped, and the run stays `failed`, which is the resumable status: it is
still found by `workflow run <name> --resume` and accepted by `workflow resume <run-id>`.
For a `failed` run, human output adds a `Stopped:` line naming the interrupt and the
signal, above the usual `Error:` line. JSON carries the same fact as `metadata.stop_reason`, an object with the
categorical `reason` and the `signal` that arrived. Resuming the run clears it, so a run
that resumed and then completed does not keep reporting an interrupt. Runs that stopped
before this field existed carry no `stop_reason`.

After recording why the run stopped, the owner ends the process tree of every `bash:` or
`script:` node still running, including an `until_bash` check, so a resume does not overlap the
interrupted attempt, apart from the escapes below. This applies to foreground `workflow run`, `workflow resume` and
`trigger execute`. A node counts as running until its output closes, so a background job that
still writes to the node's output ends with it. On macOS and Linux those subprocesses run in
their own session during a foreground run, so they have no controlling terminal, and a small
watcher process ends the node's process group if the owner dies before its teardown does (a
terminal hangup, a second Ctrl-C, `kill -9`); a run whose stop was never recorded stays
`running`. A process that starts its own session or process group (`setsid`, a daemon)
escapes this. On Windows the tree is ended from the node's root process, so a descendant whose
root already exited is not reached, and an owner killed before its teardown leaves the tree
running.

Each usage observation is either `{ source: "provider", value: ... }` or unavailable. Reasons
separate unsupported reporting, a supported value not reported, unknown capability, non-provider
work and invalid reported numbers. A reported zero stays zero. Historical nodes omit `execution`
when their rows lack these facts; they do not receive a guessed model or start time.

`timing.durationMs` is elapsed wall time, not active compute time. Resumed loop durations can
include time spent paused; bare approval retains the duration observed before the pause.
`execution.binding.sessionPreview` holds at most eight session-ID characters; the full id is
in the node's `sessionIds`, described below. JSONL
transcripts retain the names `node_start`, `node_complete` and `node_error`; their `execution`
metadata describes the same fact as the durable node event. Suspended nodes remain active and
appear as running until their gate or wait resolves.

A `workflow:` fan-out node whose children did not all complete prints a `Fan-out work:`
line with the tally, then up to 10 unfinished slots (item index, outcome, child run and
error). The rest are counted as `… and N more`; the complete record is
`terminal_record.nodes[].fan_out_outcome` in `--json`, or `nodes[].fanOutOutcome` with
`--json --verbose`. The text view shows it under the terminal record for a finished run and
under the node with `--verbose`. See
[fan-out join semantics](/reference/workflow-language/#a-completed-fan-out-node-is-not-completed-child-work).

Every `workflow get --json` shape includes `terminal_record`. The API detail endpoint,
`GET /api/workflows/runs/:runId`, exposes the same value as `run.terminal_record`.
The engine persists this record with the terminal status transition, including detached
runs and failures before a reporting node. It contains observed node states and skip
causes, the selected `returns:` value or its explicit unavailability, and an artifact
manifest. Historical runs without a record and active resumed runs report `null`.

An event-query failure exits non-zero with `error: "workflow_events_unavailable"` in
JSON; it does not masquerade as a missing historical record.

When the run holds proof that it created its worktree, the record has
`worktree_disposition`; a completed run has it only when that worktree is on the run's own
generated branch (launched without `--branch`). `{ "disposition": "release" }` means the
completed run's checkout was clean and every commit on its HEAD and branch was on a
remote, whether or not the branch was published, so the engine removes it after the
completion write, keeping the local and remote branch. The record is written before the
removal, so a removal that is refused because work appeared in the meantime, or that
fails, leaves the checkout and the run's output says so. Otherwise it is
`{ "disposition": "retained", "reason": ... }` with an optional `detail`. A completed
run whose checkout is kept for uncommitted changes, unpushed commits, another run or a
failed check also prints a warning naming the path:

| Reason | Meaning |
|---|---|
| `resumable` | The run failed and can resume; `workflow abandon` attempts release, retaining owner warnings for inspection, or the stale sweep can release eligible checkouts |
| `cancelled` | The run was cancelled; `workflow abandon` attempts release, retaining checkouts with owner warnings for inspection and retry |
| `workspace_retained` | The originating platform keeps its workspaces |
| `in_use` | Another claimable run uses the checkout; `detail` names it |
| `uncommitted_changes` | The checkout has uncommitted changes |
| `unpushed_commits` | A commit on the HEAD or branch is on no remote; `detail` gives the count |
| `published_branch` | Written by earlier versions: the configured remote had the branch |
| `check_failed` | The check could not run; `detail` gives the error |

The artifact manifest records paths, sizes, and typed metadata observed at termination.
It survives later file deletion, but does not preserve file contents or contain previews.
Its `limitations` array identifies missing roots, unreadable entries, invalid metadata,
and excluded links. The scan is bounded, and each bound is a limitation of kind
`unsupported_entry`:

- `node_modules` and `.git` directories are not walked; each is recorded with code
  `excluded_directory`.
- The scan stops after 10,000 entries. It records code `entry_limit` at the first entry it
  did not list; entries after it in sorted depth-first order are not listed.

The scan runs just before the terminal write, outside its database transaction. Files may
change during the scan, especially during cancellation: this is an observation, not an
atomic filesystem snapshot. When a run's artifacts directory was not scanned before its
terminal write, the manifest is empty and records a `root_unavailable` limitation with code
`not_observed`. The human terminal-record display lists up to 20 non-engine file paths,
counts engine-internal files instead of listing them, and reports truncation and inventory
limitations with their codes. The persisted manifest and `--json` output list every entry the
scan observed within those bounds. The separate leave-behind file listing reflects the
filesystem when you query it.

`leave_behind.artifactFiles` lists the files a person or an agent would open, capped at
200 for display. Each directory contributes its own files before its subdirectories,
sorted by name, so a run's top-level reports lead the list. It excludes the engine's
own `$ARTIFACTS_DIR/.archon/` child: the typed-artifact listings and node-output
spills the engine writes for itself, which on a long run outnumber the reports.
Nothing leaves the list quietly: `leave_behind.artifactFilesOmitted` reports how many
engine-internal files were skipped (`internalFiles`), whether the display cap was
reached (`truncated`), and any directory the walk could not read (`unreadable`). Human
output prints the same facts under the file list. The console run page leaves out the
same child and nothing else, so both show a workflow's own dotfiles.

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
recorded). A node a resume reset for re-running (`always_run`, or a stale cached
success) reads `pending` until its new attempt starts, matching `terminal_record.nodes`.
Nodes whose provider reported a session include `sessionIds`: the full
session id of each attempt and loop iteration, in order. Human `--verbose` output prints
them on a `Session:` or `Sessions:` line, so you can continue a node's conversation in
the provider's own tool, for example with `claude --resume <id>`. Claude Code finds a
session by the directory it ran in, so run it from the node's working directory: the run's
worktree when the run used one.

Add `--events` to `--json --verbose` to return raw `events` rows instead of `nodes` for
debugging. Raw events are not the recommended integration surface.

### `workflow artifacts`

List the files a run left in `$ARTIFACTS_DIR`, or print one of them. Reads the store and filesystem directly; no server needs to be running.

```bash
archon workflow artifacts <run-id>                 # list every artifact file
archon workflow artifacts <run-id> --json
archon workflow artifacts <run-id> review/report.md # print one file's bytes
archon workflow artifacts <run-id> review/report.md --json
```

`<run-id>` accepts the same short ids as `workflow get`: a unique prefix from the project directory, or the full id from any git repository or registered project folder.

The list is uncapped. Files under the engine's own `.archon` child are counted, not listed. `--json` returns `{ "runId", "artifactsDir", "files", "internalFiles", "unreadable" }`, where `artifactsDir` is the absolute directory and `unreadable` names directories the walk could not read. A run that wrote nothing lists no files and exits `0`. A run whose output location cannot be resolved exits `1` instead, so an empty list always means the run wrote nothing.

With a path, the command writes the file's exact bytes to stdout. `--json` returns `{ "runId", "path", "content" }` with the content as UTF-8 text, and fails for a file that is not valid UTF-8; read that one without `--json`. A path that does not exist, names a directory, or resolves outside the run's artifacts (`..`, or a symlink pointing elsewhere) exits `1`. Under `--json` every failure is one `{ "ok": false, "runId", "error" }` document.

### `workflow logs`

Print the run's existing JSONL transcript, or follow it as rows are appended:

```bash
archon workflow logs <run-id>
archon workflow logs <run-id> --follow
archon workflow logs <run-id> --follow --format text
```

Without `--follow`, the command copies the snapshot that exists at invocation time to
stdout and exits. With `--follow`, it announces the resolved local path on stderr, waits
for a live run's file to appear, and streams appended bytes until the run becomes
`completed`, `failed`, or `cancelled`. A paused run is still live: the follower stays
attached across approval gates and resumes, reading the same file. Each resume appends one
`workflow_resume` row (the run's first execution writes `workflow_start`), and each gate
approval or rejection appends a `gate_decision` row with the gate's `step`, the
`decision`, and the operator's comment or rejection reason in `content`.

Stdout is the transcript's exact JSONL, with no log messages or wrapper document. Each
line is one persisted event and fields may be added over time, so consumers should parse
the fields they need and tolerate others.

Provider activity (agent text, thinking, tool calls with their input and output,
warnings, MCP status, compaction, subtasks, hooks and state) is written as
`provider_event` lines: the line frame (`type`, `workflow_id`, `ts`, `step`) plus the
engine envelope `attemptId`, `seq`, `observedAt` and `event`, where `event` is the
provider's object unchanged. `seq` counts one node attempt's events from 0. Transcripts
written before this line type have `assistant` lines (`content`) and `tool` lines
(`tool_name`, `tool_input`) instead, with no step, call id or output. `--json` is invalid because the output is
already JSONL and a live stream cannot satisfy the CLI's one-document JSON contract;
`--events` is also limited to `workflow status/get`.

`--format text` reads the same transcript, with the same snapshot and follow behaviour,
and prints it for a person instead: workflow start, resume, completion and failure; node
start, completion with its duration, failure and skip with its cause; gate waits and
decisions; and each subprocess's retained output with its exit code. Each node is named
by its node id, and a command node's start line also names its command.

A node's provider activity is indented beneath it: agent text in full, thinking on one
line, one line per tool call, and each call's outcome naming the tool with its exit code
and the last lines of its output. Warnings, MCP servers that failed, need auth or are
disabled, compaction, subtask starts and ends, failed or cancelled hooks, and waits on
the user get one line each; progress-only events (running subtasks, started or
successful hooks, connected or pending MCP servers) are left out.
`provider_event` lines record their node, so when parallel nodes interleave a `[node]`
line marks each switch. The older `assistant` and `tool` lines record no node and are
indented without a label. Rows the text view does not render (watchdog renewals,
historical rows, row or event types newer than the CLI, or a line that is not JSON) are
left out; `--format jsonl`, the default, keeps every row.

A missing or empty snapshot exits `1`; for a live run the diagnostic points to
`--follow`. Follow mode waits while the run is live, performs a final read after a
terminal status, and exits `1` if a terminal run never produced content or if the file
shrinks. Stopping the follower only stops the reader. It never resumes, cancels, or
otherwise changes the run.

Transcripts can contain user prompts, tool inputs, and retained subprocess output. Treat
access to the local file as access to the run's input and execution data.

### `workflow wait`

Block until a run reports attention: it finished, awaits a gate response or an answer
to an attention wait, has an overdue live tool call, or lost its execution owner while still
non-terminal. Then print what it needs. This is the intended
partner of `--detach --json`: take the `runId` from the launch ack and wait on it,
instead of polling `workflow get` in a loop.

The answer a pause is waiting for does not have to come from a person. An
orchestrating agent can supply it with `workflow respond` or `workflow answer` just as a
reviewer can; the engine only reports that one is owed, and who answers is the waiting
host's business. Pass the reported `attention.occurrence` back with `--occurrence` on
`approve`, `reject`, `respond` or `answer`. The answer is then refused if the run has moved
to a different pause in the meantime. If the diagnostic read succeeds and the run is
awaiting another answer, the refusal names the current occurrence. Otherwise, fetch the
current item again before retrying.
For an attention wait, the output carries `attention.kind: "attention"`, the authored
message, the paused node id, the `form` and the `options` an answer may choose from.
Answer it with [`workflow answer`](#workflow-answer); use `archon workflow abandon
<run-id>` if the run should not continue.

An overdue tool returns `result: "attention"` with `attention.kind: "stalled_tool_calls"`, `status: "running"`, the affected `runId`, and `calls` naming nodes, providers, tools, sanitized titles, timestamps, `elapsedMs`, and `stalledForMs`. Exit `0` means attention was found; it does not mean the run completed. Inspect with `workflow logs`, request recovery with [`workflow end-turn`](#workflow-end-turn), or explicitly cancel if appropriate. This advisory grants no approve or resume action. Reattaching returns it immediately while active. When a parent waits on a child, the advisory names the child's run id.

```bash
archon workflow wait <run-id>
archon workflow wait <run-id> --json
archon workflow wait <run-id> --json --timeout 900
```

There is no default timeout. Pass `--timeout <seconds>` when the host needs an upper bound.

Exit codes describe the command, not the run:

| Exit | Meaning |
| --- | --- |
| `0` | The run reported something: it finished (`completed`, `failed` or `cancelled`), awaits a response, needs attention, has an overdue tool call while still running, or lost its execution owner. The status is data on stdout. |
| `3` | The timeout passed with the run still live. The `--json` payload carries `observedStatus`. |
| `1` | The wait itself failed: unknown run id, unreachable database, or output that could not be delivered. |

Owner loss is also exit `0`: the wait obtained a typed answer, but Archon did not
invent a terminal status or change the run. Its JSON result is `owner_lost` with the
persisted non-terminal `observedStatus` and no `attention` or terminal `status` field.
A slow or incomplete owner handshake is not evidence of loss; the wait retries until
it can attach, observe attention, or reach an explicit timeout.
After verifying that the run's work has stopped, release its persisted state with
`archon workflow abandon <run-id>`.

The owner endpoint is local to one host and, on POSIX, one user. `owner_lost` is
reported only when the run's recorded execution owner is on this host and user and its
endpoint is gone. When the owner ran on another host or as another user, as with a
PostgreSQL database shared by several machines, or the run records no owner, the wait
cannot tell whether the owner is alive. It says so on its `waiting` line and keeps
watching the run's stored state until it changes or `--timeout` passes. `abandon` prints
the host the run recorded and says when it is not this one. The console applies the same rule from the server's host and user, showing "Running · owner not answering" or "Running · owner unknown" instead of live progress.

`--json` emits one document. On a wake it carries the attention value:

```json
{ "ok": true, "action": "wait", "runId": "…", "result": "attention",
  "attention": { "kind": "terminal", "runId": "…", "status": "completed", "at": "…" } }
```

`attention.kind` is one of:

- `terminal`: the run finished; `status` is `completed`, `failed`, or `cancelled`.
- `awaiting_response`: a gate is waiting for a decision. `respondTo` names the run and
  node where that response is recorded. **That run is not always the one you waited on**:
  a parent blocked on a `workflow:` sub-run wakes when the chain below it reaches a gate,
  and `respondTo.runId` is the child you answer. A parent blocked on a child that is
  merely still running wakes nobody.
- `attention`: a `wait: attention` needs an answer to `message`, in its `form`
  (`message`, `approval`, `select` or `multi_select`). `options` lists the ids an answer may
  choose (none for `message`, `approve` and `reject` for `approval`), and `occurrence`
  identifies this pause. A wait paused before attention waits took answers reports a
  `legacy:<node>` occurrence and the `message` form; it takes no answer and continues
  with `workflow resume <run-id>`.
- `usage_limit`: node `nodeId` hit a provider usage limit, or a rate limit that outlasted
  its retries. Nothing needs an answer: the run continues by itself at `resumeAt`. Resume
  it to try sooner, or cancel or abandon it to stop it.
- `unreadable`: the run is parked but cannot describe itself (corrupt gate metadata, a
  gate type this build does not know, a sub-run pointer with no row). `detail` says which.
  It also reports `reason: source_release_not_continued` for a container paused by a
  host-local captured-source read failure. Resume that container by hand on a host
  that can read its source; see [Operate runs](/getting-started/operate/).

Two pauses deliberately do **not** wake a waiter, because neither is owed a response: a
gate or attention wait that has already been answered and is awaiting continuation, and a
[`wait:` node](/reference/workflow-language/) whose timer or event has not fired.

Once the wait is watching, it says so once on stderr: one plain sentence, or under `--json` the
same envelope with `"result": "waiting"` and the status it attached on:

```json
{ "ok": true, "action": "wait", "runId": "…", "result": "waiting", "observedStatus": "running" }
```

When the owner cannot be checked from this host, the line adds `"ownerLiveness":
"unknown"` and, if the run recorded one, the owner it names:

```json
{ "ok": true, "action": "wait", "runId": "…", "result": "waiting", "observedStatus": "running",
  "ownerLiveness": "unknown", "recordedOwner": { "host": "build-2", "pid": 4242, "uid": 501 } }
```

Until that line the command prints nothing. A run that already has something to report answers on the first read and never prints the line.

The run id may be the short prefix printed by `workflow runs`. Once the wait returns,
inspect the run normally with `workflow get <run-id>`.

### `workflow attention`

List, count, stream or read the [attention queue](/getting-started/operate/): every paused
run that needs an answer or inspection, plus observable provider usage- and rate-limit waits.
Branch on `kind`: `attention` and `awaiting_response` accept answers, `usage_limit`
continues automatically after reset, and `unreadable` needs inspection. Read-only.

```bash
archon workflow attention --json                                   # this project
archon workflow attention --json --all                             # the whole install
archon workflow attention --json --project acme/web --label ci=other
archon workflow attention --json --sort label:urgency
archon workflow attention --json --all --count-by label:class
archon workflow attention <run-id> --json                          # one item
archon workflow attention --watch --json --all                     # stream readable changes
archon workflow attention --watch --json --after <cursor>          # resume a stream
```

The default scope is the current project, resolved from the working directory as [`state`](#state) resolves it. `--all` covers the install. `--project` takes a codebase id, a codebase name, or a project key such as `@cwd/scratch-<digest>`; copy the exact key from `items[].project.key` in `archon workflow attention --all --json`. A run is in scope when its codebase id matches, when both sides have one, and otherwise when its project key matches, so a run paused before its codebase was renamed is still listed under the new name. Under [`--chat-project-id`](#global-options), list, count and watch use the selected project whatever the working directory; `--all` and a `--project` naming another project are rejected.

`--label k=v` filters must all match. `--sort label:<key>` compares the label's value as a plain string and puts items without it last. `--count-by` replaces the list with counts.

`--json` prints `{ ok, action: "attention", scope, items }`, or `counts` in place of
`items` with `--count-by`. With a run id it prints `{ ok, action, runId, item }`, where
`item` is null when there is no queue item; a parent blocked on sub-runs resolves to the
item of the child that holds the pause, or to its own `unreadable` item when its sub-run
tree cannot be read. The list holds the same items. An unknown run id prints `error: "not_found"` and
exits `1`. The item shape is described in the [Operate page](/getting-started/operate/#queue-items).

**`--watch`** streams the queue instead of reading it once: one `attention` line per open
item in scope, then `ready`, then follows changes any process commits, as
`attention`, `resolved`, `unmatched`, `terminal`, `resumed`, `owner_lost` and idle `bookmark` lines.
Every run line carries the run's `workflow` and `parentRunId`, so a consumer can keep
top-level runs or one parent's children, and a failed `terminal` line carries `cause`, the
failed node and its recorded error class ([fields](/getting-started/operate/#stream-the-queue)).
Repeated run-projection failures send an identifier-free `degraded` line with
`reason: "run_unreadable"` and the last handled `cursor`, without exiting. Independent
readable deliveries can continue while unreadable deliveries are omitted. Store-wide
projection outages retain the cursor and retry. Check the operator log and reconnect
after repair to refresh the open set; replay from before the gap for historical transitions.
Later bookmarks do not establish repaired coverage.
With `--json` each line is one compact JSON object; without it, a short sentence per
change. Scope and `--label` work as for the list; `--sort`, `--count-by` and a run id are
refused. **`--after <cursor>`** takes the `cursor` of an earlier line and, after the
snapshot, replays readable feed events strictly after it. Multiple lines can share an
event cursor; resuming after it excludes all of them. For a partially handled event,
replay from an earlier checkpoint as described in the guide. A `degraded` warning means replay may have
gaps; use the repair and replay steps above. The line shapes and the consumer contract are in
the [Operate page](/getting-started/operate/#stream-the-queue). Exit codes: `0` when a signal or a
closed stdout stops the stream (a closed stdout is noticed at the next line), `1` when it
cannot start or an output write fails for another reason, `4` when the store cannot read the stream's cursor, an `--after` cursor this
install did not issue or the stream's own position (with `--json`, the last line is
`{"type":"error","error":"cursor_invalid"}`; rerun without `--after`).

HTTP: `GET /api/runs/attention` takes `project`, `all`, `label` (repeated), `sort` and
`countBy`, and returns `items` beside the console's `runs`, or `{ counts }`. A server has
no working directory, so without `project` it covers the whole install.
`GET /api/runs/<run-id>/attention` reads one item.

### `workflow attention label`

Set or remove labels on the attention wait a run is paused at, without answering it.

```bash
archon workflow attention label <run-id> --occurrence <id> --set class=ci-other --set urgency=high --json
archon workflow attention label <run-id> --occurrence <id> --unset urgency --json
```

A set key replaces the same key; every other label stays. The write is refused when the
run has moved to another pause. If the diagnostic read succeeds and the run is awaiting
another answer, the refusal names the current occurrence. Otherwise, fetch the current
item again before retrying. The write is also refused for a gate or an answered wait:
only `wait: attention` pauses carry labels. Each write bumps the item's
`revision` and commits an `attention_labeled` event, in the same transaction, carrying the
occurrence, the keys set and unset, the surface as `via`, and the new revision. Who may
write is the same as who may answer.

`--json` prints `{ ok, action: "attention_label", runId, occurrence, revision, labels }`.
HTTP: `POST /api/runs/<run-id>/attention/labels` with `{ occurrence, set?, unset? }`. Chat
agents use the `manage_run` action `label`.

### `workflow respond`

Resolve a paused gate with `archon workflow respond <run-id> <decision> [text]`.
When the gate authors `approval.decisions`, only those declared ids are accepted,
including for `approve` and `reject`. An undeclared decision is refused with the
allowed ids, and the run stays paused. Without authored decisions, use `approve`
or `reject`.

### `workflow answer`

Answer a paused [attention wait](/reference/workflow-language/#attention-waits) in the form
it declares. `--occurrence` is required: pass the `occurrence` that `workflow wait --json`
or `workflow get` reports, and an answer meant for an earlier pause is refused, naming
the current one.

```bash
archon workflow answer <run-id> --occurrence <id> --text "Rotated the key"           # message
archon workflow answer <run-id> --occurrence <id> --choose reject --text "Not yet"   # approval
archon workflow answer <run-id> --occurrence <id> --choose use-dev                   # select
archon workflow answer <run-id> --occurrence <id> --choose lint --choose test --json # multi_select
```

`--choose` names a declared option id; repeat it for a `multi_select`, and omit it for a
`message`. `--text` is free text recorded with the answer. An undeclared option, the wrong
number of options, or an option on a `message` wait is refused and the run stays paused.
The next node reads the answer as `$<wait-id>.output`: `{ text }`, `{ decision, text }`, or
`{ decisions, text }`. In the `approval` form `reject` never cancels the run.

The answer records `answeredVia` and `answeredAt` on the run's `metadata.wait`, and a
`wait_answered` event carries the surface as `via` and the `occurrence`. Like `approve`,
human mode continues the run inline, and `--json` records the answer and returns
`{ ok, runId, action: "answer", answer, workflowName, resumable }` without continuing
it; `archon serve` or [`workflow wake`](#workflow-wake) continues it. The HTTP equivalent
is `POST /api/workflows/runs/<run-id>/answer` with `{ occurrence, choose?, text? }`.

`approve`, `reject` and `respond <option>` also answer an attention wait, as shorthand:
`approve [text]` answers a `message` wait with its text, and otherwise each verb chooses
the option of the same id.

### `workflow approve`

Approve a paused workflow run. At an attention wait this is the shorthand described under [`workflow answer`](#workflow-answer). At a deprecated `approval:` gate with authored `approval.decisions`, this command requires `approve` in that list; otherwise it is refused and the run stays paused. An optional comment is available as `$<gate-id>.output.text` for authored decisions, or `$LOOP_USER_INPUT` at a deprecated interactive-loop gate.

**Sub-run child gates:** when a `workflow:` sub-run pauses at its own gate, the parent run pauses "blocked on child". Approve (or reject) the **child** by its own full run id, available from `archon workflow get <parentRunId> --json` at `.metadata.approval.childRunId`, not the parent's. The stored block message contains only a short child label; a surface notice may include the full child command. The parent auto-resumes when the child completes. A child inside a `fan_out:` expansion pauses the same way: it stays paused as its own run, and the parent pauses on a `fan_out` gate listing every unfinished child, then continues once they finish. `approve`/`reject` against the parent's id while it's blocked on a child are refused with a redirect to the child id (every listed child for a fan-out).

**Deprecated interactive-loop gates, finalize or iterate:** when the gate paused on an iteration where any declared completion channel fired (`workflow get <run-id> --json` → `.metadata.approval.completionSignaled` is `true`), approving with **no comment** accepts the completion: the node finalizes from the already-computed output on resume, with no re-run. Approving **with** a comment runs another iteration using it as `$LOOP_USER_INPUT`. When no completion condition met, both forms run another iteration. On the final iteration (`max_iterations`), only a comment runs one more; approving with no comment fails the node with `max_iterations`.

```bash
archon workflow approve <run-id>
archon workflow approve <run-id> "Looks good, proceed"
archon workflow approve <run-id> --comment "Looks good, proceed"
archon workflow approve <run-id> --occurrence <occurrence> --json   # refused if the run moved on
archon workflow approve <run-id> --json   # record approval + ack; does NOT auto-resume inline
```

In human mode `approve`/`reject` auto-resume the run inline. In `--json` mode they record the decision and return an ack **without** resuming. An answered gate is a due continuation, so a running `archon serve` or [`workflow wake`](#workflow-wake) continues it; `workflow resume <run-id>` continues it by hand. Container runs are the exception and need the manual resume.

#### Detached control verbs

`approve`, `reject`, `respond`, and `resume` accept `--detach`. The parent validates the run
**read-only** with the same preconditions the operation itself enforces, so a
wrong-status, missing-context, `child_workflow`-blocked, already-resolved, or
no-working-path run is refused synchronously and nothing is spawned. The parent then
hands the whole command to a detached child that owns all state mutation in its own
process group on POSIX or Job Object on Windows. When launched inside a Windows run,
the child escapes the launching run's job, so cancelling the launcher leaves the child
running and independently owned. A shell that dies mid-flight can no longer wedge the run.

For `resume`, the parent waits for the child's engine admission receipt before
acknowledging success, rather than waiting for workflow completion. Even a run that
immediately pauses again or finishes is acknowledged normally; use `workflow wait`
to learn that outcome. Confirmation is bounded to 60 seconds. If acceptance is not
confirmed, the command reports an error with the available log path. The child may
still continue: inspect the run before retrying. A timeout never stops the child or
changes run state.

Other detached control verbs use the child's startup window. A child that dies during
startup surfaces as an error carrying the tail of its log. A run that finishes inside
that window is acknowledged normally; its outcome belongs to the run.

```bash
archon workflow approve <run-id> --detach
archon workflow approve <run-id> --detach --json
```

**`--detach --json` deliberately differs from bare `--json`.** Bare `--json` records the
decision and withholds the inline auto-resume (a continuation host continues the run).
`--detach --json` spawns a child that takes the ordinary inline path, so the run **is**
driven onward (approve's auto-resume, reject's legacy `on_reject` rework, resume's re-run),
just outside your shell. The ack carries `continues: true` to say so:

```json
{
  "ok": true,
  "runId": "…",
  "action": "approve",
  "detached": true,
  "continues": true,
  "workflowName": "my-workflow",
  "logPath": "~/.archon/logs/detached-run-<id>.log"
}
```

Read `continues` to decide whether your automation still owns continuation. `logPath`
is `null` when the log file could not be opened. The child still runs but its output
is discarded, so do not assume a string. This acknowledgement has no `transcriptPath`;
use its `runId` with `workflow logs <run-id>` or `workflow get <run-id>` to locate the
transcript. Precheck failures follow each verb's existing error contract:
`{ ok: false }` under `--json`, a thrown error otherwise.

### `workflow reject`

Reject a paused run. At an attention wait this is the shorthand described under [`workflow answer`](#workflow-answer): the run continues with `decision: reject` and is not cancelled. At a deprecated `approval:` gate with authored `approval.decisions`, the list must contain `reject`; otherwise the command is refused with the allowed ids and the run stays paused. The optional reason is available as `$<gate-id>.output.text` for authored decisions, or as `$REJECTION_REASON` inside a legacy `on_reject` prompt. Like `approve`, human mode continues the run inline and `--json` only records the decision.

```bash
archon workflow reject <run-id>
archon workflow reject <run-id> --reason "Needs more tests"
archon workflow reject <run-id> --json
```

A reject that cancels a managed container run reclaims its container once no executor can still run in it. If that reclamation fails, the run stays cancelled and the command prints a warning (`cleanupWarnings` with `--json`), as [`workflow cancel`](#workflow-cancel) does.

### `workflow resume`

Resume a failed or paused run by id. Nodes that completed in the earlier attempt are skipped.

```bash
archon workflow resume <run-id>
archon workflow resume <run-id> --detach   # continue in a background child
archon workflow resume <run-id> --json     # validate and acknowledge only
```

With `--json` the command validates that the run is resumable, reports its state and returns without executing, because execution output would corrupt the JSON. To drive the run to completion, use the blocking form or `--detach`.

`--detach` hands the resume to a background child that runs it without `--json`, so the run does continue, outside your shell. The acknowledgement carries `continues: true` and is sent only after the engine accepts the resume and clears the old pause. An immediate `workflow wait` can therefore report a new pause, even repeated attention at the same node, but never the cleared one. See [Detached control verbs](#detached-control-verbs).

Prefer this exact-ID form when you hold the id of a failed or paused run. It rejects all `running` runs, including stale orphans. `workflow run <name> --resume` answers a different question: the newest eligible run by start time for that workflow name and working path, which is a failed or paused run or a `running` run whose last activity timestamp is missing or more than one day old. With a SQL store, a `running` run whose resource-start request is `admitted` is excluded from name-based selection; use `archon trigger inspect <run-id>` and the [trigger recovery guidance](/guides/workflow-triggers/#choose-a-resource-capacity-and-overlap-policy). Missing or old activity does not prove the owner is gone. After verifying that the owner is gone, use `archon workflow run <name> --resume` from the run's recorded working path to select the newest eligible run for that name and path. From another worktree, name-based selection does not find that run.

### `workflow cancel`

Stop a running workflow. Every cancel surface (this command, `/workflow cancel` in
chat, the Web UI's Cancel action, `POST /api/workflows/runs/{runId}/cancel`, the Slack
Cancel button, and the chat agent's `manage_run` tool) does the same thing, decided by
who owns the run:

- **The process handling the cancel executes the run** (a run the server started, cancelled
  from that server): the run is marked `cancelled` and its executor stops at its next
  status check. On macOS and Linux, cooperative cancellation reports possible
  background work for every host run, even when no command appears in its history.
  Commands can start or complete while cancellation is in progress, so history cannot
  establish their absence. The warning appears in `cleanupWarnings` and the cancellation
  event and identifies each known host run and its recorded checkout, including isolated
  child and grandchild checkouts. Inspect descendant checkouts too: new sub-runs can
  appear during cancellation. This warning confirms neither command execution nor survivors.
- **Another live process owns it** (a `--detach` run or a trigger-started run): cancel
  contacts that process and stops its owner before recording the run as `cancelled`.
  On macOS and Linux it first stops unfinished node groups whose leaders remain unreaped,
  then confirms those groups and the owner group are gone. A group whose leader was already
  reaped is never signalled. If a node's output pipes remain held, cancellation still ends
  the run and reports in `cleanupWarnings` and the run's cancellation event that some
  process outside the run's process group holds the output and was not signalled.
  Archon does not identify it; use `lsof` on the run's checkout before reusing or removing
  that checkout. Background jobs left by completed nodes are outside automatic cleanup.
  If an earlier host bash or script command exited, cancellation warns that it may have
  left untracked background work. This warning does not establish that any process
  survived or confirm cleanup; even an ordinary command with no background jobs can
  trigger it. Inspect processes using the checkout (for example with `lsof`), verify
  ownership, and stop any leftovers before reusing or removing it. Windows uses
  the owner's Job Object, including descendants whose parent exited.
- **No owner answers, or the owner cannot be stopped:** cancel fails and leaves the run
  unchanged. When no owner answers, it prints what the run recorded (host, pid, last
  activity) and points you at `abandon`. A foreground `archon workflow run` or a run
  executing in another Archon server answers but cannot be stopped from here; interrupt
  the foreground command, or cancel the run on the server that executes it.

```bash
archon workflow cancel <run-id>
archon workflow cancel <run-id> --json
```

When cancel refuses, it exits nonzero. Under `--json` it also prints `{ "ok": false, "error": ... }`.
`workflow resume` and `workflow abandon` follow the same contract, so a script or bash node can
gate on the exit status.

Refusing is deliberate: `cancelled` releases the run's worktree lock and resource slot,
and a database transition cannot prove that host work stopped. After verifying that the
owner process is gone, use `workflow abandon <run-id>`.

A `workflow:` sub-run normally executes inside its root run's process, and the root's row
keeps the worktree lock and resource slot. When no owner answers for the sub-run itself
but one answers for its root, cancel records `cancelled` and the root's executor stops the
sub-run at its next status check. When no owner answers for the root either, cancel
refuses and points at abandon, as for any other run. A sub-run resumed on its own (after a
durable wait or a scheduled resume) has its own owner, and cancel stops that owner like
any other run's. Only a `running` run can be
cancelled; abandon a paused or failed run instead.

After termination is confirmed, `cancel` records cancellation through the same run-tree
operation as `abandon`. Cancelling a parent therefore attempts descendant cancellation within the
[500-parent expansion bound](/reference/workflow-language/#max_parallel-bounds-concurrency-not-count)
and can report the same cascade failures or blocked parent described below.

On Windows a detached owner runs in a Job Object that every process it starts inherits, so
cancel and abandon stop and confirm the whole tree even when an intermediate process has
already exited. An owner started by an Archon version without this reports no job, and its
tree cannot be confirmed, so cancel and abandon refuse it while it runs: stop the owner
process and its descendants yourself, then use `workflow abandon`.

A detached run that a node launches with `workflow run`, `resume`, `approve`, `reject`,
or `respond` and `--detach` starts outside the launching run's job and owns its own.
Cancelling the launching run leaves it running; stop it with its own `cancel`.
The broker and relayed CLI ignore
`BUN_OPTIONS` and `bunfig.toml` startup hooks, which would execute outside the owner's job.
On POSIX a detached run starts its own process group, so the same holds.

The job grants no other way out: a tool in the run that asks Windows to start a process
outside its job fails to start it. A run that a node starts through `archon trigger` stays
in the launching run's job. Cancelling the launching run kills that run's processes, and
its row stays `running` with no owner until you `workflow abandon` it.

For a detached container run, cancel must also confirm container teardown after stopping
the owner and before recording cancellation. If that teardown fails, cancel fails and
leaves the run's state unchanged, even though the owner process has stopped. With
`--json`, this returns `ok: false` and an error, without `cleanupWarnings`.

Once cancellation is recorded, further managed container reclamation is best-effort. If it fails,
the run stays `cancelled`, but container resources may remain allocated. Every cancel
surface reports a warning identifying the run and environment; inspect the managed
containers before retrying cleanup. Successful `--json` responses include an optional
`cleanupWarnings` array for container reclamation failures, owner-stop cleanup failures,
output pipes still held by an unsignalled process, and possible untracked background
work from started or completed host commands; the field is omitted when there are no
cleanup warnings. Owner-stop warnings retain run scratch and owned checkouts for
inspection. Inspect processes using the checkout, verify ownership, and stop any
leftovers before reusing or removing it. A cleanup warning does not change `ok: true`.

### `workflow abandon`

Discard a workflow run by marking it `cancelled`. `cancelled` releases the run's
worktree lock and resource slot, so abandon first asks the run's live-owner endpoint on
this host:

- **An owner answers:** abandon stops it through the same path as `workflow cancel`
  (proves the owner, stops safely targetable groups, waits), then records `cancelled`.
  The output-holder and possible-leftovers warnings and inspection steps described
  above apply here too; inspect warnings before reusing or removing the checkout.
  Abandon retains owned checkouts
  when owner-stop warnings report held output or possible leftovers, including
  descendant checkouts and their root. Warnings learned after cancellation during
  descendant cleanup or conversation reset are appended to that run as `workflow_cleanup_warning` events.
  If writing a warning event fails, cleanup continues and the command reports the
  persistence failure with the cleanup warnings. Keep that command result: those
  warnings may be missing from the run history.
- **No owner answers:** abandon records `cancelled` and prints what the run recorded:
  the host and pid of the process that last executed it, and its last activity. If that
  host is not this one, or the owner ran as another user on this host, it says so:
  abandon can only reach owners on its own host running as its own user. Nothing
  decides the run is dead from its age or pid.
- **An owner answers but cannot be stopped:** abandon fails with the reason and leaves
  the run unchanged, as cancel does for a foreground `archon workflow run` or a run inside
  a live Archon server. Cancel a server-executed run from that server.

```bash
archon workflow abandon <run-id>
archon workflow abandon <run-id> --json
```

`--json` adds an `owner` object: `{ "outcome": "stopped", "pid": … }`, or
`{ "outcome": "no_owner_answered", "thisHost", "recordedHost", "recordedPid",
"recordedUid", "lastActivityAt" }`.

Abandon also attempts to remove the worktree Archon created for this run, and for each
cancelled `workflow:` sub-run. Owner warnings retain affected checkouts for inspection;
use `lsof` on the checkout when output is still held, then retry abandonment after
resolving the warning. When removal proceeds, it is forced, so
uncommitted, untracked, and ignored files (including copied `.env` files) and
initialized submodules are deleted with it. The branch is kept, so committed work,
pushed or not, stays recoverable. The result lists each removed worktree and its
branch (`releasedWorktrees` in `--json`), and the isolation record is marked `destroyed`.

Only a checkout this run created is removed. Adopted, reused, inherited, and legacy
checkouts without that creation proof stay in place, with a reason. A checkout another
resumable or live run uses, one locked with `git worktree lock`, one whose owner runs on
another host or as another user, or one under a descendant that could not be accounted
for is also kept.

The run is cancelled even when removal fails; the failure is reported as a cleanup
warning. Retry `workflow abandon <run-id>` on that cancelled run to finish removal
without repeating cancellation.

Managed container reclamation and the `cleanupWarnings` array behave as they do for [`workflow cancel`](#workflow-cancel).

**Sub-run trees:** abandoning a parent that spawned `workflow:` sub-runs attempts to cancel discovered descendants except completed and cancelled runs, within the [500-parent expansion bound](/reference/workflow-language/#max_parallel-bounds-concurrency-not-count). Completed and cancelled runs are left alone, but the walk still inspects beneath them. These are database transitions, not process termination; an in-flight host command can continue until it returns. The command reports cascade failures for failed child cancellations, failed lookups, or unresolved subtrees beyond the bound, so you know descendants may still be alive. Conversely, abandoning a **child** that its parent is paused-and-blocked on strands that parent (nothing re-fires the auto-resume hook); the command surfaces the blocked parent's run id so you can `resume` it (which fails the sub-run node cleanly) or abandon it too.

### `workflow end-turn`

Record a request to end the stalled tools or reported background work named by a
running run's `stalled_tool_calls.calls` advisory.

```bash
archon workflow end-turn <run-id>
archon workflow end-turn <run-id> --json
archon workflow wait <run-id> --json
```

Open tools and reported background work remain running when silent. After
`workflows.toolCallAttentionMs` without progress (30 minutes by default), attention
shows their node, provider, sanitized description and idle duration. A silent turn
with no open tool or reported background work still fails after its node's
`idle_timeout` and follows its existing retry policy.

The command records each observed `(streamId, toolCallId, raisedAt)` occurrence.
A live owner checks about every ten seconds and aborts only one of its own current
stalls that matches all three fields by equality. The attempt fails as `timeout`;
its retry policy decides whether to start a fresh attempt. Progress clears an
occurrence, and a later stall gets a new `raisedAt`. The requester's clock is not
used to decide whether a request applies.

Exit `0` means the request was recorded, not that an owner accepted it or the run
progressed. The owner might exit or the run might finish before it reads the request.
Use `workflow wait <run-id>` to inspect attention or the terminal result; it can
return the same advisory while recovery is pending. An `owner_lost` result requires
operator recovery of the run's ownership. The CLI itself kills nothing and does not
cancel the run or answer a gate.

Exit `1` refuses an unknown run, any run outside `running` (including paused runs),
no stalled work, or unreadable attention. `--json` prints
`{ ok: true, runId, action: "end_turn", requestRecorded: true, nodes }`, or
`{ ok: false, runId, action: "end_turn", error }` with `error` one of `not_found`,
`not_running`, `nothing_stalled`, and `unreadable_attention`. Thrown failures use the
same failure envelope with the error message; `runId` is the resolved id, or the
supplied argument if resolution failed.

### `workflow wake`

Without running a server, wake due durable time waits, event deadlines, signaled events, scheduled quota resumes, answered gates, and runs released because their host could not read their frozen source:

```bash
archon workflow wake --json
archon workflow wake --watch --json
```

A pass scans up to 25 due continuations across the configured install database, regardless of the current directory. It awaits each admitted execution segment. A segment can complete, fail, or pause at another wait or gate; later occurrences belong to another pass. A run released for an unreadable source is due 60 seconds after its release and retries the failed source read. This can include restoring the captured source before any node starts. Concurrent CLI and server hosts use the engine's existing occurrence claim, so only one executes a continuation.

In a long-lived `workflow wake --watch` or server process, if a run's frozen source is missing, unreadable, or fails verification (invalid manifest or source record, digest or resolution settings mismatch, or missing captured workflow), automatic continuation stops attempting that occurrence on this host after three failures and logs one warning per run per process naming the run, the path when available, and the operator actions. Resume it on the owning host with `archon workflow resume <run-id>`, or abandon it with `archon workflow abandon <run-id>`. The run's status stays unchanged, and another host can still resume it. The bound lives in process memory and resets on restart. Temporary I/O failures, such as exhausted file descriptors, and other retryable admission failures keep the 60-second retry. A successful manual resume can reach a new wait, gate, or quota occurrence; that occurrence can wake in the same process. One-shot `workflow wake` invocations start a fresh process each time and cannot accumulate this bound. Installed wake schedules run `workflow wake --watch` so repeated passes share the bound.

`--watch` repeats serial passes, sleeping five seconds between completed passes. Its JSON output is JSONL: one document per pass with `ok`, `action`, `accepted`, and per-run `outcomes`. Outcomes distinguish admission from settlement (`completed`, `paused`, or `failed`). Without `--json`, the command prints a summary and run-specific outcomes.

Exit status is 0 for an empty batch, a concurrent claim loser, a completed segment, a legitimate pause, or a run whose resource is full, reported with the run or request that holds it. A paused run stays paused and keeps its place (`waiting_for_capacity`); a later pass continues it once capacity frees. A failed run with a scheduled quota resume stays failed and keeps no place (`resource_busy`, `refusal: "failed"`): it is retried after the 60-second deferral and admitted only after waiting runs and queued requests. Other refusals, execution failures, and deferral failures return 1. Watch continues after failures and returns 1 on shutdown if any pass failed. Retryable prerequisite failures defer the exact occurrence for 60 seconds.

The CLI preserves the run's recorded source, inputs, configuration, user, conversation, and working path. It accepts local CLI/API conversations. Container execution, missing paths or captured source, and external platform origins are refused with the run ID and reason. Use manual `workflow resume` for a container, or the server hosting the external conversation. A run stays parked if no waker runs; age never marks it failed.

SIGINT/SIGTERM stops scheduling new passes and drains admitted segments and owner cleanup. Shutdown can wait for a long executing segment. An abrupt kill retains the existing ambiguous-owner behavior; it does not provide automatic recovery of a running segment. On Windows, SIGTERM ends the process immediately, so it behaves as an abrupt kill rather than a drain.

#### Wake timers

On macOS, install a per-install LaunchAgent:

```bash
archon workflow wake schedule install --interval 5 --json
archon workflow wake schedule remove --json
```

The launch interval is a positive integer in seconds, defaulting to 5. It starts the job again if it has exited; the watch process polls every five seconds. The job invokes `workflow wake --watch --json` as one long-lived process, runs at load, and records an absolute executable, working directory, and `ARCHON_HOME`. Reinstalling identical configuration verifies that its launchd job is registered and fails if registration cannot be verified. Remove then install to change its interval or executable, or to upgrade an existing one-shot wake schedule to watch mode. Native installation is macOS-only; see [workflow trigger scheduling](/guides/workflow-triggers/#macos-scheduling-limits) for login, sleep, environment, and scheduler caveats.

On Linux, use a long-lived systemd user service with `ExecStart=/absolute/path/to/archon workflow wake --watch --json`, `Environment=ARCHON_HOME=/absolute/path/to/.archon`, and `Restart=on-failure`. Enable it with `systemctl --user enable --now <name>.service`.

On Windows Task Scheduler, select the absolute Archon executable, set arguments to `workflow wake --watch --json`, and start the task at login. Disable the task's execution time limit and select “Do not start a new instance” if it is already running. Set `ARCHON_HOME` in the task's environment or invoke a wrapper that sets it, and use that home as the working directory.

### `workflow signal`

Signal an exact event wait occurrence and attempt its execution immediately:

```bash
archon workflow signal <full-run-id> --event checks.complete \
  --occurrence '<metadata.wait.pauseId>' --data '{"conclusion":"success"}' --json
```

Use the event name and `metadata.wait.pauseId` from the run's current state. The full persistent run ID is required; this command does not resolve a short prefix against the invocation directory. `--data` accepts any JSON value and is validated before mutation. Duplicate, expired, mismatched, and non-event signals are rejected without resuming. `--resume-at <ISO timestamp>` remains accepted for compatibility and is required when `--occurrence` is omitted. Without an occurrence, a stale signal cannot be distinguished from a later wait with the same event and deadline. When both selectors are supplied, both must match. Persisted waits without a `pauseId` can still be signaled with `--resume-at`.

The result reports `signaled` separately from admission and settlement. If the signal succeeds but execution is refused or fails, it remains durable, the command returns 1, and a later `workflow wake` can retry after the problem is resolved. A concurrent resume winner after a successful signal is a normal outcome.

### `workflow cleanup`

Delete old terminal workflow run records and prune state-document revisions from the
selected store (files or database). Every latest revision survives, including tombstones:
removing a tombstone would allow revision numbers to repeat and a stale replacement to overwrite recreated state.
The command reports both counts.

```bash
archon workflow cleanup        # Default: 7 days
archon workflow cleanup 30     # Custom threshold
```

### `workflow reset-sessions`

Delete a workflow's persisted per-node AI sessions: the cross-run memory kept by nodes that opt in with `persist_session` (or workflow-level `persist_sessions: true`). Use it when a workflow should forget its earlier conversation.

```bash
archon workflow reset-sessions <workflow-name> --scope <key>      # one scope, usually a conversation UUID
archon workflow reset-sessions <workflow-name> --yes              # every scope
archon workflow reset-sessions <workflow-name> --node <id> --yes  # one node, every scope
archon workflow reset-sessions <workflow-name> --scope <key> --json
```

Without `--scope` the command deletes across every scope, and it refuses unless you pass `--yes`; there is no interactive prompt. `--json` prints `{ workflow, deleted, scope, node }`, with `null` for an omitted filter. Extra positional arguments are rejected rather than reinterpreted; filter by node with `--node <id>`.

### `workflow event emit`

Write a workflow event directly to the database, usually from a loop prompt that records story-level lifecycle events such as `ralph_story_started`.

```bash
archon workflow event emit --run-id <run-id> --type <event-type> [--data <json>]
```

`--run-id` takes the full run ID, or an unambiguous prefix when you run the command from the run's registered project directory or one of its worktrees. `--data` is a JSON string attached to the event; invalid JSON prints a warning and the event is emitted without it.

Node-state events, including completion, failure, skip, and resume-cache changes, and
`workflow.checkout_shared` events print `Event persisted` only after the database write
succeeds. Storage failures exit with code 1. Checkout-sharing data must contain
`parent_run_id`, `parent_node_id`, `working_path`, and `sibling_run_id` as nonempty strings.
Other events print `Event submitted (best-effort)`; check server logs if they appear missing.

Exit code: 0 after persistence or best-effort submission, 1 when a required argument is
missing, the event type is invalid, run-ID prefix resolution fails, required event data is
invalid, or a required event write fails.

### `validate workflows [name]`

Validate workflow YAML definitions and their referenced resources (command files, MCP configs, skill directories).

```bash
archon validate workflows                 # Validate all workflows
archon validate workflows my-workflow     # Validate a single workflow
archon validate workflows my-workflow --json  # Machine-readable JSON output
```

Checks: YAML syntax, DAG structure (cycles, dependency refs), command file existence, MCP config files, skill directories, provider compatibility, tier/alias model refs, and supported static environment reads in inline or named exec sources. An unprovided `INPUTS_*` read is an error when the workflow declares an input contract; other unprovided Python or JavaScript/TypeScript environment reads warn. See [Variables](/reference/variables/#shell-quoting-in-bash-vs-script) for the supported forms and fixes. For bundled and global workflows, validation rejects a bare `@custom` model alias because it isn't portable across projects; use `small`, `medium`, `large`, a literal provider model string, or a preference list that ends in one, such as `['@reviewer', medium]`. Returns actionable error messages with "did you mean?" suggestions for typos.

Exit code: 0 = all valid, 1 = errors found.

### `validate commands [name]`

Validate command files (.md) in `.archon/commands/`.

```bash
archon validate commands                  # Validate all commands
archon validate commands my-command       # Validate a single command
```

Checks: file exists, non-empty, valid name.

Exit code: 0 = all valid, 1 = errors found.

## Worktrees

### `isolation list`

Show all active worktree environments.

```bash
archon isolation list
```

Groups by codebase, shows branch, workflow type, platform, and days since activity.

Also lists active container environments. `run lookup failed` means the listing's
environment-ID lookup failed; `no run (orphan)` means no run matched that lookup
(`metadata.isolation_env_id`). Neither label establishes cleanup eligibility:
cleanup checks wider live ownership through run metadata, conversation links, and
same-codebase checkout paths before removing an environment.

Includes worktrees created for `workflow:` sub-run children that declared `isolation: worktree`
(branch `archon/task-<parentRunId8>-<nodeId>-<hash>-child-<n>`). They are tracked and cleaned
up exactly like top-level run worktrees. Avoid `complete` on one while its run tree is still
resumable: a resume reuses the child's recorded worktree and fails if it has been removed.
`cleanup` removes it only under the run-lock rule below.

### `isolation cleanup [days]`

Remove stale environments: those inactive for more than `[days]` (default 7), or with `--merged`, those whose branch or PR has merged. Worktree cleanup only handles worktree records. Container
cleanup removes eligible containers and their volumes through the container backend,
including when no stale worktrees exist. A missing host folder does not make a container
destroyed. To clean eligible containers without waiting for the default age threshold,
run `archon isolation cleanup 0`; containers owned by resumable runs remain protected.

Project deletion (`DELETE /api/codebases/{id}`) returns `409` while active container
environments remain. The error lists their environment IDs and the cleanup command.
Clean them up explicitly, then retry deletion.

Cleanup continues after individual errors and exits with status `1` if any removal fails;
protected skips exit with status `0`.

Age cleanup uses the originating platform's registered policy.
Both the CLI and server read chat policies from installed plugin receipts without starting
the plugins. A receipt supersedes a bundled chat policy with the same platform id.

If an environment names a platform that is no longer registered, cleanup keeps it and
reports the reason. This also applies to merged branches and missing-path reconciliation:
removing a plugin must not make its historical workspaces eligible for deletion. `isolation list`
shows the cleanup skip reason. Rows with no originating platform keep their existing cleanup
behavior.

Ordinary removal requires a stored creation proof matching
Archon's marker and Git registration in the expected repository. Replacement
repositories and checkouts without matching stored proof, including newly registered
adoptions and older records, are retained for operator inspection. Reusing a registered
checkout sets `adopted: true` while preserving its creation proof, so that checkout
can remain eligible for cleanup. If Git removal leaves a directory behind, cleanup reports it
and keeps the environment active; inspect that path before removing it manually.

Ordinary age-based cleanup deletes an environment's local branch only when Archon
created that branch. It keeps pre-existing local branches and branches on legacy
records that lack branch-creation tracking. Merged cleanup (`--merged`, including
`--include-closed`) and `archon complete` can delete those local branches after
their checks. Completion with `--force` bypasses commit-safety checks, so it can
delete a branch with unmerged commits. Merged cleanup and completion retain
remote branches and warn after local removal. A remote commit ID cannot prove which
registration owns a branch: a replacement may publish the same commit after the
selected registration retires. This refusal also applies with `--force` and with
separate fetch/push URLs. See [recovering remote branch cleanup](#recovering-remote-branch-cleanup).

These ownership checks also apply to `/worktree remove` and `archon complete`;
`--force` never bypasses them.

To explicitly discard a resumable run and attempt removal of the worktree it created, use
`archon workflow abandon <run-id>`. Ordinary cleanup follows the run-lock rule at the end
of this section. Abandon removes a checkout only when the run holds its matching creation
proof, even if the checkout has since been adopted. Owner warnings retain the checkout:
inspect it (`lsof` when output is still held), resolve the warning, then retry abandonment.
When removal proceeds, it deletes uncommitted work there and keeps the branch; see [`workflow abandon`](#workflow-abandon) for what it keeps and how to retry.

```bash
# Default: 7 days
archon isolation cleanup

# Custom threshold
archon isolation cleanup 14

# Remove environments with branches merged into the base branch (retains remote refs for operator inspection)
archon isolation cleanup --merged

# Also remove environments whose PRs were closed without merging
archon isolation cleanup --merged --include-closed
```

Merge detection uses three signals in order: git branch ancestry (fast-forward / merge commit),
patch equivalence (single-commit squash-merge via `git cherry`), and GitHub PR state via the
`gh` CLI. A squash merge of more than one commit is invisible to git here, so PR state is what
recognises it. A merged or closed PR counts only while neither the worktree's HEAD nor the
local branch has anything past the PR's head commit: run branch names get reused, and new
commits on a reused branch or a detached HEAD are not covered by the old PR, so that
environment is kept. The same goes for a merge git detects: the worktree's HEAD must be
merged into the base too, not just the branch. A PR head commit pushed from somewhere
else is fetched from the remote before that comparison; if the fetch fails, the environment is
kept and reported as a failed merge check. The `gh` CLI is optional; without it, only git
signals are used. If `gh` is installed but the lookup fails (auth, rate limit), the environment
is kept and reported as `PR state lookup failed`. The scheduled
sweep uses the same three signals, so both paths agree on what counts as merged. Each
codebase's output names the base ref the comparison used: the configured
`worktree.baseBranch`, or the git-detected default branch when that is unset.

Both git signals read the local branch ref. When that ref is gone but the worktree remains,
the PR decides, checked against the worktree's HEAD; if no PR answers for the branch either, the environment is kept and reported
as `merge state unverifiable` rather than removed on an unverified guess.

By default, branches with a **CLOSED** PR are skipped. Pass `--include-closed` to clean
those up as well. Branches with an **OPEN** PR are always skipped.

A running, pending, or paused run keeps its environment in both modes, regardless of
age or merge state. The scheduled sweep and chat `/worktree cleanup` apply the same
run lock. Stale environments with quiet conversations still pass the activity filter;
the run lock is what keeps them on disk.

A **failed** run keeps its environment only until its outcome is settled:

- `--merged` (and the server's scheduled cleanup) removes it once its branch is merged
  or its PR is merged. `--include-closed` also removes it once its PR is closed.
- The stale sweep removes it once the run has been inactive since it failed for longer
  than the stale window (`[days]` here; `STALE_THRESHOLD_DAYS` for the server and chat).

The output names each failed run whose environment it removed, with the reason:
`merged`, `PR closed`, or `stale`. Removal leaves the run's status unchanged. Resuming
it afterwards fails with `the working path from the run no longer exists`; start a
fresh run. To discard a failed run sooner, use `workflow abandon`.

Age alone never removes work that exists nowhere else. The stale sweep, here and in the
server's scheduled cleanup and chat `/worktree cleanup stale`, keeps any environment whose
worktree HEAD or branch holds a commit on no remote, whether or not a run owns it. It
reports a failed run's environment as `failed run <id> has <n> unpushed commit(s)`, and
any other as `<n> unpushed commit(s); remove it explicitly with archon complete <branch> --force`.
The scheduled cleanup keeps an environment whose checkout is missing the same way while
the branch Archon created for it holds such a commit.

A completed run removes the worktree it created on its own generated branch when it
completes, if the checkout is clean and every commit on its HEAD and branch is on a
remote. A published branch does not keep it. The removal keeps the local and remote
branch, so the run can still be adopted. Otherwise the worktree stays, the run prints a
warning naming the path and what removing it would lose, and the run's
`terminal_record.worktree_disposition` records the reason (see
[`workflow get`](#workflow-get)). A worktree launched with `--branch` is never removed
when its run ends: `--merged` removes it after its branch merges (or its pull request closes, with
`--include-closed`). Nor is a worktree that belongs to a chat conversation, an issue or a
pull request rather than to one run; the merged and age-based cleanups remove it. A
workflow launched from the Web UI runs in its own per-run worktree on a generated branch,
and completion removes it the same way. A failed run keeps its worktree so it
can resume.

#### Recovering remote branch cleanup

Cleanup and completion retain remote refs because ownership cannot be proved after
registration retirement. Retrying either command cannot delete a retired
registration's remote branch. On GitHub, enable **Automatically delete head branches**
in the repository settings if you want merged pull requests' branches removed automatically.

If the ref belongs to a replacement registration or ownership is uncertain, leave
it alone. To remove a ref manually, first ensure no one is reusing or publishing
that branch. From the surviving primary checkout, verify that the branch still
belongs to the completed work and is no longer in use. Use `worktree.remote` (default: `origin`).
The branch reported by cleanup is the local branch; a published remote ref can have
a different name. Cleanup may already have deleted the local branch and does not
report its tip OID. If available, establish the completed tip from a surviving local
branch, a commit recorded in the run's artifacts or logs, the pull request's head
commit history, or a surviving Git reflog. Verify that the commit belongs to the
completed work; a squash or merge commit is not necessarily its original tip.
If that evidence is unavailable, use the candidate-ref inspection below with the
repository owner instead. First check for service overrides or a transport helper:

```bash
remote='<remote>'
git config --get-all "remote.$remote.uploadpack"
git config --get-all "remote.$remote.receivepack"
git config --get-all "remote.$remote.vcs"
```

Either service override or a transport helper can redirect Git to a repository
other than the URL. Before manual cleanup, verify the actual receiving repository
with the service or helper owner.
Use an endpoint whose upload and receive services you have verified target that
repository; do not infer absence from the configured URL or upload service.
The URL procedure below applies only when no service override or transport helper
is configured and the endpoint is known to match the receiver.

Inspect the push destinations:

```bash
git remote get-url --push --all <remote>
```

For each destination you intend to clean, copy its exact URL, including any
leading or trailing spaces, into `push_url`. Run these commands in Bash:

```bash
push_url='<push-url>'
endpoint="archon-cleanup-$$-$RANDOM:"
git_at_endpoint() (
    config_index=${GIT_CONFIG_COUNT:-0}
    export "GIT_CONFIG_KEY_${config_index}=url.${push_url}.insteadOf"
    export "GIT_CONFIG_VALUE_${config_index}=$endpoint"
    export "GIT_CONFIG_KEY_$((config_index + 1))=url.${push_url}.pushInsteadOf"
    export "GIT_CONFIG_VALUE_$((config_index + 1))=$endpoint"
    export GIT_CONFIG_COUNT=$((config_index + 2))
    git "$@"
)
git_at_endpoint ls-remote --symref -- "$endpoint" HEAD 'refs/heads/*'
```

Inspect all advertised branch names and OIDs. Start with the reported local branch's
name; when the completed tip is known, also check differently named non-default refs
containing it. For example,
local `topic` may have been published as `refs/heads/review-name`; an empty query
for `refs/heads/topic` proves only that exact ref is absent. The default branch
normally contains merged work and is not a cleanup target merely for containing
the completed tip.

When the completed tip is known, verify each candidate's ancestry with
`git merge-base --is-ancestor <completed-tip-oid> <advertised-oid>`
(exit 0 means it contains the completed tip; exit 1 means it does not). If commits
are missing, fetch the candidate from the same verified endpoint with
`git_at_endpoint fetch --no-tags -- "$endpoint" '<full-remote-ref>'`, re-read the
advertisement and repeat the check. A failed inspection or unknown ancestry does
not prove absence. Ancestry alone does not prove ownership: confirm that the ref
belongs to the completed work and is no longer in use before deleting it.

If the completed tip cannot be established, do not guess a differently named ref
or treat it as absent. Inspect candidate refs with the repository owner: match the
receiving repository's pull request head-ref and commit history to the completed
run and review the candidate's commits. Fetch candidates from the verified endpoint
with the command above as needed, then inspect their advertised OIDs with
`git show <advertised-oid>` and `git log <advertised-oid>`. A same-name ref can be
inspected this way too; recovering the deleted local tip is not required. Confirm
the candidate's provenance, current ownership, and that no replacement registration
or other user is using or publishing it. If the evidence cannot identify a ref
confidently, retain it. Once verified, re-read the advertisement and use that ref's
current OID for the leased delete below.

Keep the same `push_url` and `endpoint`. Enter the verified full remote ref name
and its advertised OID, independently of the local branch name:

```bash
remote_ref='refs/heads/<verified-remote-branch>'
verified_oid='<verified-oid>'
git_at_endpoint push --force-with-lease="$remote_ref:$verified_oid" -- "$endpoint" ":$remote_ref"
```

The temporary alias maps directly to the resolved URL for both commands, preventing
another `insteadOf` or `pushInsteadOf` rewrite from changing the destination.
Separate config keys and values preserve URLs containing `=`. The destination
listing is line-delimited; if a configured URL contains a newline,
do not split it into destinations. Inspect the NUL-delimited configuration with
`git config --null --list` and verify the exact destination before proceeding.

The explicit lease refuses deletion if the tip changes after inspection. It cannot
detect a same-commit republish, so delete only while no one is reusing or publishing
that branch. If ownership is uncertain, leave the remote branch in place.

### `complete <branch> [branch2 ...]`

Remove a branch's worktree and local branch, and mark its isolation environment as destroyed.
Remote branches are retained with a warning because registration ownership cannot
be proved after local removal. This also applies with `--force`; follow
[recovering remote branch cleanup](#recovering-remote-branch-cleanup) for manual cleanup.

```bash
archon complete feature-auth
archon complete feature-auth other-branch
archon complete feature-auth --force  # skip the uncommitted-change, live-run, open-PR and unmerged or unpushed commit checks; ownership checks still apply
```

Without `--force`, completion refuses an environment a workflow run can still claim, the
same live-run lock `/worktree remove` applies: a running, pending or paused run, or a
failed run that can still be resumed. Unlike `isolation cleanup`, completion never
releases a failed run's lock by merge state or age. If that lookup fails, completion
refuses rather than skipping the check. A failed open-PR query warns and skips that
check; it does not bypass the other safety checks.

Use this after a PR is merged and you no longer need the worktree or branches. If GitHub
has deleted a squash-merged branch, first prune its remote-tracking ref so the local clone
reflects that deletion:

```bash
git fetch --prune origin # replace origin with the configured remote when needed
archon complete feature-auth
```

Without `--force`, completion checks for unique and unpushed commits before deletion. If the
branch's remote-tracking ref is missing, it verifies that any unique commits are patch-equivalent
to the configured base branch or detected remote default branch. With `--force`, these checks
are skipped, so deletion can discard the only reachable copy of commits.

## Identity, credentials and models

### `auth github`

Connect your GitHub identity through the GitHub device flow. Workflow commits then name you as author and keep the ambient Git identity as committer; PR comments and pushes use your connected identity.

```bash
archon auth github
```

The command needs GitHub App mode (`GITHUB_APP_ID` and `GITHUB_APP_CLIENT_ID`) and `TOKEN_ENCRYPTION_KEY`. A solo `GITHUB_TOKEN` install does not need it, and the command exits with an error explaining why.

Your **CLI identity** is `ARCHON_USER_ID` when set, otherwise `$USER` or `$USERNAME`, mapped to a stable Archon user through the `cli` platform identity. `archon ai` uses the same identity.

The command prints a `verification_uri` and a one-time `user_code`; visit the URL, enter the code, and authorize. On success the access and refresh tokens are stored encrypted (AES-256-GCM) in Archon's database. The command exits 1 when per-user GitHub is disabled, the identity cannot be resolved, the code expires or authorization is denied.

### `ai`

Manage per-user AI provider credentials (API keys and subscriptions) and model configuration. `archon ai --help` lists the subcommands.

The credential subcommands (`key set`, `login`, `list`, `logout`) work on any install; the vault is provisioned automatically. They act for your [CLI identity](#auth-github). Credential ids are vendor ids: `anthropic`, `openai`, `github-copilot`, and Pi backends such as `openrouter`. The legacy ids `claude`, `codex` and `copilot` are accepted and normalized with a notice.

- `ai login` connects a subscription for `anthropic`, `openai` (ChatGPT or Codex) or `github-copilot`. The `openai` login is a PKCE flow owned by Archon: authorize in the browser, then paste the authorization code or the full `localhost:1455` redirect URL at the prompt. Nothing needs to listen on that port.
- `ai key set` never reads the key from argv, where it would land in shell history. Pipe it (`echo "$KEY" | archon ai key set openrouter`) or type it at the masked prompt.
- `ai list` prints credential metadata, never secrets.

The config subcommands (`tier`, `alias`, `default`) edit the same `tiers:`, `aliases:` and `defaultAssistant` settings you can write by hand in `~/.archon/config.yaml` (see [Configuration](/reference/configuration/)) or change on the console **AI Settings** page. An unknown provider exits non-zero. `tier unset` returns the tier to its built-in preset, which exists only for `claude` and `codex`; with any other default provider the tier is left unset and must be configured before use. The setup walkthrough is in [Per-user credentials and AI Settings](/getting-started/ai-assistants/#per-user-credentials-and-ai-settings).

`--scope` selects where a config subcommand writes:

- `install` (the default) writes `~/.archon/config.yaml`, shared by everyone on the install.
- `user` writes your personal preferences row in Archon's database. Your tiers, aliases and default then override the install config for runs and chats you start, and nobody else's. It needs a CLI identity but not `TOKEN_ENCRYPTION_KEY`, because model names are not secrets. `ai tier list` and `ai alias list` show both scopes and mark your overrides `[just you]`. The console's "This install / Just me" toggle edits the same scopes.

`ai default <provider> [<model>]` also sets the default **chat** model. At install scope it writes `assistants.<provider>.model`; omitting the model leaves that field alone. At user scope the provider and model are written together, so `archon ai default pi --scope user` clears an earlier model pin. The chat model applies to direct chat only; workflow nodes keep resolving the `large` tier. The model may be an `@alias` or a tier keyword.

`ai capacity` lists provider attempts holding `concurrency.providers` slots. `ai capacity release <attempt-id>` frees one, and is for an attempt whose owner process you have verified is gone.

### `user`

`archon user` manages identities and persisted roles as the local operator. It uses the install's configured database (`DATABASE_URL` for PostgreSQL, otherwise `ARCHON_HOME/archon.db`).

```bash
archon user list                    # Full ids, roles, display names and platform identities
archon user role <id> admin         # Designate an admin using a full Archon user id
archon user role <id> member        # Demote a user
archon user link <id> slack:U123    # Link a platform identity to an existing user
archon user link <id> slack:U123 --move # Reassign an identity from another user
```

Linking requires an existing full user id and a valid platform id. The first colon separates the platform from its opaque user id. A conflicting link fails and names both Archon users unless `--move` is supplied. Moving changes only the identity mapping; both users, their roles and their other data remain unchanged. Linking to the run starter lets chat actions use that user’s existing permissions and record that user as the actor.

Roles must be `admin` or `member`; unknown ids and invalid roles fail with a non-zero exit code. New users are members, while upgrades preserve existing roles. There is no last-admin restriction because the CLI is the operator. Only a run's starter or an admin can act on it; the local operator can always act through the CLI. See [Who can act on a run](/reference/security/#who-can-act-on-a-run) for the action policy and [Users and roles](/reference/security/#users-and-roles) for the upgrade policy and Docker commands.

## Projects, state and integrations

### `project list`

`archon project list` lists every registered project in the install without collapsing duplicate remotes, and needs no server. An invalid stored checkout path makes the command fail; repair that path before listing projects.

```bash
archon project list          # ID, KIND, NAME, KEY and PATH per project
archon project list --json   # { "projects": [ { ...project row, "key" } ] }
```

`key` is the value `workflow attention --project` and `archon state --project` accept. The list is read-only; register and remove projects through the Web UI or chat.

### state

Durable, audited JSON documents. A document lives in a project or in install scope.
The command uses the selected store: files, SQLite or PostgreSQL. Values are read on demand;
the engine never injects them into prompts.

```bash
archon state get review/123
printf '{"seen":[]}' | archon state put review/123 --if-revision 0
printf '{"ops":[{"op":"append","path":"/seen","value":123}]}' | archon state patch review/123
printf '{"ops":[{"op":"set","path":"/owner","value":"b"}]}' | archon state patch review/123 --if-revision 2
archon state log review/123 --limit 100
archon state list --prefix review/
archon state list --prefix review/ --values
archon state delete review/123 --if-revision 3
archon state get notes --install --raw
archon state list --project acme/widgets
```

Every command writes JSON and names the scope it used: `{kind: "project", key}` or
`{kind: "install"}`. `get` returns `{scope, name, revision, value}`; an absent document
returns revision `0` and value `null`. A deleted document returns value `null`,
`deleted: true` and its tombstone revision, which is the revision a recreating `put` must
name. `put`, `patch`, and `delete` return the scope and the new full revision. `log`
returns `{scope, name, revisions}`, newest first (use a positive `--limit` to bound the
result), including tombstones, operation, writer and timestamp. `list` returns
`{scope, documents}`: each document's name, latest revision, `updatedAt`, writer and
`deleted`, ordered by name, without values. `--prefix` keeps names that start with
the given text. `list --values` reads every live document's value in one call instead:
each entry is `{name, revision, value}`, and deleted documents are left out.

`put` requires `--if-revision`: `0` creates a new document; otherwise it replaces exactly
that revision. `delete` accepts the same optional check. `patch` applies `{ops:[...]}` from
stdin to the latest value, initially `{}`. With `--if-revision <n>` it applies only when
`n` is still the latest revision, and otherwise exits `3`. Use it whenever the change was
computed from what you read. Without it, writes to one document are serialized, so a
patch never loses a revision race; it applies to whatever an earlier write left, which
can make it invalid (for example, removing a member another patch already removed). A
revision's recorded operation includes `ifRevision` when the patch named one.
Operations are `set`, `remove`, and `append`, using RFC 6901 JSON Pointer paths. `set`
replaces a value, `remove` deletes an existing member (or array element), and `append`
adds one value to an array, creating it when missing. Missing intermediate objects are
created for `set` and `append`. Array indices must be canonical, in-range integers;
`-` is unsupported. The empty pointer addresses the entire document. Root `null` is
reserved for deletion; nested nulls are ordinary JSON values.

A text document is a JSON string value. `put --raw` stores stdin as that string
unchanged, and `get --raw` prints it without JSON encoding (exit `4` when the value is not
a string). Use plain `get` when you need the revision for a following `put`.

Names contain 1–200 lowercase letters, digits, `.`, `_`, `-`, and slash-separated segments.
Values are limited to 64 KiB of serialized UTF-8 JSON. Exit codes: `0` success, `1` usage
or storage failure, `3` revision conflict, `4` oversized value, invalid patch or non-text
`--raw` value, `5` the CLI opened a store that does not know the calling run. Failures
return `{ok:false, error, code}` and rejected writes append no revision.

Inside a bash/script node, or the shell of an AI node's agent, `WORKFLOW_ID` and
`ARCHON_NODE_EXECUTION` resolve the run's project, and the writer is recorded as `{kind: "run", runId, nodePath}`. A run whose store
does not know it fails with exit `5` naming the opened store kind; a missing project or
node identity also fails. A node reaches only its run's project, or install scope with
`--install`; `--project` is refused inside a run. Outside a run, the current checkout
(auto-registered when needed) or registered folder resolves the project, `--project <key>`
names one directly (the workspace-relative key, such as `owner/repo` or `_folder/ops`),
and `--install` selects install scope. The writer is recorded as
`{kind: "surface", via: "cli"}`: the surface the write came through, not who made it.

`archon workflow cleanup <days>` also prunes old state revisions, keeps each live document's latest
revision, retains the latest tombstone of deleted documents, and reports both counts.
See [Durable state documents](/reference/workflow-language/#durable-state-documents).

### `chat <message>`

Send one message to the orchestrator, print its response and exit. Each invocation creates a new conversation. Multi-turn conversations and project selection through `/setproject <name>` are available in the Web UI and chat adapters. Projectless chat can answer questions; use `archon workflow run <name> --project <owner/repo>` to launch work for a registered repository from the CLI.

```bash
archon chat "What does the orchestrator do?"
```

Chat prints text; `--json` is not supported.

### `trigger`

Start workflows from deployment bindings and inspect durable resource admission; `archon trigger --help` lists the subcommands. A server with `ARCHON_TRIGGER_HOST` set hosts the same bindings without these commands. See [workflow triggers](/guides/workflow-triggers/) for configuration, capacity, overlap policy and recovery.

When a binding fails launch preparation, `trigger fire` exits nonzero and prints the refusal (with `--json`, in `error`). The stored receipt keeps only the failed stage, for example `launch_preparation_failed`. `trigger whoami` prints the Archon user ID of your CLI identity, for a binding's `runAsUserId`.

### `forge`

`archon forge <operation> --data <json>` runs one forge operation through the installed forge plugin; `archon forge --help` lists the operations. Reads return structured observations. Writes report whether they were applied and verified, refused, applied but unverified, or left with an unknown outcome. Pass a request that carries authored text with `--data-file <path>` so it stays out of argv. `archon forge metadata --data '{"host":"github.com"}' --json` inspects the selected plugin's capabilities without credentials or a forge operation.

See [Forge operations](/reference/forge/) for request shapes, plugin configuration, credentials and audit behavior. The bundled SDLC pack uses `gh` by default; set `ARCHON_SDLC_FORGE=forge` to opt into a plugin that implements every operation the pack needs. See [Use the forge path in the SDLC pack](/reference/forge/#use-the-forge-path-in-the-sdlc-pack).

## Global options

These flags apply to every command. Command-specific flags are described under their command and in `archon <command> --help`.

| Option | Effect |
|--------|--------|
| `--cwd <path>` | Run as if started in this directory (default: the current directory) |
| `--quiet`, `-q` | Log warnings and errors only. This is already the default for every command except `archon serve`; on `workflow run` it also hides progress lines |
| `--verbose`, `-v` | Show debug-level logs on stderr (on stdout for `archon serve`) |
| `--json` | Print one machine-readable JSON document and no logs, on commands that support it |
| `--chat-project-id <id>` | Confine run management to one registered project; see below |
| `--help`, `-h` | Show help, scoped to the command and subcommand you name |
| `--version`, `-V` | Show version information (`-v` also works when it is the only argument) |

`--chat-project-id <registered-project-id>` scopes every run lookup to that project, for example `archon workflow get <run-id> --chat-project-id <id> --json`. Copilot and OpenCode chat receive it in their CLI instructions. Every full ID or prefix must match exactly one run in the project before the command reads or changes it, and launches and continuations must belong to it; use `/setproject` to change projects. Run lists, status, open work and attention list, count and watch use the project, subject to each command's directory check, and reject `--all` or an attention `--project` naming another project. An empty or unregistered scope fails instead of falling back to install-wide queries. The scope comes only from the argument, so the working directory and Archon env files cannot change, clear or supply it; `ARCHON_WORKFLOW_CODEBASE_ID` no longer selects a project. Without the argument, full run IDs keep their install-wide operator behavior and short prefixes resolve from the current project. It scopes run lookup, not process permissions.

### Logs

A command's stdout carries only its output, so `archon workflow list --full > out.txt`
captures the listing and nothing else. Engine logs go to stderr, and by default only
warnings and errors appear. `--verbose` (or `LOG_LEVEL=debug`) adds debug logs, still on
stderr. `--json` and `workflow logs` print no logs at all.

`archon serve` is the exception: its logs are its output, so it logs at `info` (or debug with `--verbose`) on stdout,
as the server does when started directly.

Workflow definition problems, such as deprecated or unknown keys, are reported by
`archon validate workflows`, inline under the workflow in `workflow list`, and on stderr
before `workflow run` starts. A file that fails to load is listed with its error by
`workflow list` and `validate workflows`, and `workflow run` names the error. These problems
are logged only at debug, not for every workflow a command happens to discover. An invalid
value for an optional workflow field (for example a malformed `tags:` block) is dropped with
a warning log, because no other report names it.

## Working directory

The CLI starts from `--cwd`, or the current directory. A subdirectory such as `/repo/packages/cli` resolves to the nearest git repository root, `/repo`. A nested repository resolves as its own codebase and registers on first workflow use. Linked worktrees resolve to their registered source codebase. Ordinary subdirectories of registered folder projects continue to resolve to the registered folder. An exact folder registration wins over git detection. `--folder` retains the supplied directory rather than selecting a surrounding git root. Linked Git worktrees do not inherit a folder registration from the primary checkout. Listing commands do not register projects.

When project registration fails, the command fails with the registration error, even with `--no-worktree`. Registering a second clone of an already-registered remote is refused with the registered project's path; use worktrees (`--branch`) for parallel checkouts. To bind a separate clone to the existing project, use its registered ID or exact name:

```bash
archon project list
archon workflow run investigate --project owner/repo --cwd /other/clone --no-worktree "Investigate the failing build"
```

`--project` selects the run's registered identity, managed project environment variables, artifacts and logs. For an ordinary fresh run, `--cwd` supplies workflow source, launch configuration and in-place execution. Adoption retains its existing lane, source and configuration rules. `--workflow-source` can still override the authoring directory. With isolation enabled, execution and worktree creation use the registered checkout, including its remote/ref operations and worktree configuration; branches that exist only in the separate clone are not available there. Use `--no-worktree` to execute in the launch clone. This selector applies only to fresh `workflow run` invocations, requires a registered repository, and does not register a second clone. Unknown, ambiguous, or deleted selections fail before launch.

A new project whose name or storage folder is already taken by a different path registers under the first free suffixed name, such as `_local/api-2` or `my-app-2` for a folder project. This also applies to `/register-project` and URL cloning. Existing project names and storage stay unchanged, so projects that an older version registered into one storage folder keep sharing it.

When using `--branch`, workflows run inside the worktree directory.

> **Commands and workflows load from the working directory at runtime.** The CLI reads directly from disk, including uncommitted changes. The server uses the registered project's saved checkout path, including an existing local checkout or a subdirectory of it. A new webhook registration creates a managed clone at `~/.archon/workspaces/owner/repo/source/`, or at a suffixed path such as `owner/repo-2/source/` when that project name is taken; commit and push edits from another checkout so that clone can receive them when it syncs. Existing-registration webhook readiness skips sync to preserve local changes. Worktree runs use files in their worktree.

Legacy registrations with a relative stored project path fail with a project-named
error. Attempt repair in Archon chat with
`/register-project "project-name" /absolute/path/to/project`; changing the CLI's
working directory does not repair the stored path. Repair refuses a replacement
path or kind that would move managed storage or worktrees. A successful repair
preserves the existing project's identity and history. See
[Stored project path is relative](/reference/troubleshooting/#stored-project-path-is-relative)
for recovery details.

## Environment

On startup, the CLI:

1. Removes from `process.env` every key named in `<cwd>/.env`, `.env.local`, `.env.development` and `.env.production`, whatever its value or source (shell exports and direnv included), plus nested Claude Code session markers. It prints `[archon] stripped N keys from <cwd> (...)` when it removed any. This keeps project API keys from overriding subscription auth, which would bill the API, and from overriding Archon's own environment.
2. Loads `~/.archon/.env` (home scope) with `override: true`.
3. Loads `<cwd>/.archon/.env` (project scope), which overrides home scope except for `GH_CONFIG_DIR` and inherited workflow identity. The CLI keeps the home-scope `GH_CONFIG_DIR`, including its absence; inside a workflow, an inherited login directory takes precedence over both files. See [forge configuration](/reference/forge/#plugin-configuration). Steps 2 and 3 print `[archon] loaded N keys …` only when `ARCHON_VERBOSE_BOOT=1` or `LOG_LEVEL` is `debug` or `trace`.
4. Sets `CLAUDE_USE_GLOBAL_AUTH=true` when neither `CLAUDE_API_KEY` nor `CLAUDE_CODE_OAUTH_TOKEN` is set and the variable is not already set. The variable is only the server's startup-check marker; Claude Code ignores it and uses your `claude /login` session whenever no token or key is set.

A detached run's child process restores Archon's install-context keys (`TOKEN_ENCRYPTION_KEY`, `ARCHON_HOME`, `ARCHON_DOCKER`, `WORKSPACE_PATH`, `HOME` and `USERPROFILE`) from the trusted detached config, never from the project `.env`.

`<cwd>/.env` is never loaded; it belongs to the target project. Put install credentials such as `GH_TOKEN` in `~/.archon/.env`, which passes through to AI subprocesses. See [target repo env isolation](/reference/security/#target-repo-env-isolation) and [`.env` file locations](/reference/configuration/#env-file-locations).

## Database

Without `DATABASE_URL`, the CLI uses SQLite at `~/.archon/archon.db`, created on first run. With `DATABASE_URL` it uses PostgreSQL. See [Database](/reference/database/).
