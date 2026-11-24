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

The `workflow` subcommands, except `attention`, `notice`, `test`, `wake`, `signal` and the `--item-of` forms of `runs`, `link`, `merged` and `landing`, plus `complete`, `validate` and `setup --scope project`, run inside a git repository; a subdirectory resolves to the repository root. A non-git directory also works when it is a registered [folder project](/guides/multi-repo-projects/), or on first use with `--folder`, which registers it and runs in place. Every other command works from any directory. See [Working directory](#working-directory) for how the project is resolved.

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

Doctor does not check forge access for the bundled SDLC pack. The engine checks it when a run of a pack workflow starts, and [`archon forge check`](/reference/forge/#check-forge-access-before-a-run-spends) answers the same question without starting one. See [Use the forge path in the SDLC pack](/reference/forge/#use-the-forge-path-in-the-sdlc-pack).

Without a resolved default provider, doctor checks discoverable workflows using the runtime provider resolver. If a workflow needs a default, doctor fails and names `archon ai default <provider>` and `archon setup`. Workflows that explicitly select their providers remain supported without a default. When every workflow file loads and no workflow needs a provider (including an empty workflow set), a healthy empty provider inventory is skipped. Otherwise, no registered providers fails and prints `archon provider add <claude|codex|pi>`. The Workflow files check discovers workflows whether or not a default provider is set and fails naming each file that does not load. Broken installed plugins still fail. Stale maintained plugins fail with their installed and CLI versions and the reinstall command.

The AI credentials check uses each connected credential the way a database-store run would: it decrypts it and refreshes an expired subscription grant (saving the rotated grant only if the credential it refreshed is still stored). It prints one line per credential and fails when one cannot be used (it cannot be read, the vendor rejected the refresh, or the refresh replaced the refresh token and the new grant could not be saved), naming the command that reconnects it. It warns when a credential could not be verified, for example because the vendor was unreachable or a concurrent credential change superseded the refresh. Run doctor again to verify the replacement. An API key is reported usable once it decrypts; only a model request proves the vendor accepts it.

The assistant login check uses the merged configuration and the provider's own runtime, unless that model's vendor already has a credential connected in Archon that the assistant can use. Provider specifics:

- **Pi:** Pi cannot use a connected Claude subscription: with no native Anthropic login, the check fails and names `provider: claude`. When Archon config names no model (Pi then uses its own default), doctor cannot tell which vendor the run uses, so a missing native login is a warning, not a failure, if you have connected a credential the assistant can use. Pi resolves its configured key during the check, so a key command runs during `archon doctor`; a command that prompts can prompt again at run start. The check builds the runtime a run builds, which runs every provider's `!command` key stored in Pi's `auth.json`, not only the configured provider's. For a model in Pi's catalog, a run resolves a `models.json` key command once when a node starts and uses that key for the whole node, so a short-lived token can expire before a long node ends; a model from an extension provider runs its key command on each request. Pi OAuth checks may refresh through Pi's runtime.
- **Codex:** Codex reads its native account through app-server and asks it to refresh the sign-in (a turn does not make this call). If Codex reports no account, Archon rechecks once in a fresh process under the same deadline. The recheck still requests a refresh; a login that remains unavailable blocks the run. When the second read returns a status, the `codex.native_login_rechecked` event records the resulting credential state without account or token values. An API key is usable once resolved. When Codex is configured for a model provider that needs no OpenAI login, the check is skipped.
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

Release binaries ship without Claude, Codex and Pi and load them only from what this command installs. The quick installers run it for the providers you select (`--providers` / `-Providers` / `ARCHON_PROVIDERS`), and `archon setup` runs it for its selection. An installed provider must match the CLI version, so run it again after upgrading Archon: `archon provider add claude codex pi` replaces all three in one command. Readable same-ID older-protocol receipts can establish ownership without moving the executables aside, including when several old providers are installed. Source checkouts and Docker run these providers from source over the process transport and refuse this add command.

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

`list` reports unreadable or malformed receipts with their file path and error. A well-formed provider receipt using a different protocol is listed as `unavailable`, with both protocol versions and a repair command. Release binaries use `archon provider add` for maintained providers; source checkouts and Docker already run these providers from source, so remove their obsolete installed receipt with `archon plugin remove <id>`. They also run the GitHub forge plugin from source and skip an installed `archon-forge-github`; `list` still shows its receipt until you remove it. Community providers use `archon plugin update`. For maintained providers with an older protocol, `provider add` and `plugin update` can replace the existing executable directly when the same-ID receipt names the canonical provider executable and records the exact target filename (including `.exe` on Windows). Every other unusable receipt must also be a validated older-protocol provider receipt that does not claim that file, treating names that differ only in case as ambiguous on every platform. Malformed, unreadable, misplaced, future-protocol, or competing receipts still block this allowance. Community providers retain the existing conservative repair behavior. If ownership remains ambiguous, inspect the named executable and move it aside before retrying; keep it aside until the upgrade succeeds. These providers cannot run and do not count as workflow-load errors. `workflow list --json` and `workflow test --json` keep their normal stdout payload and report this notice on stderr. For a receipt at a valid `owner/repo[/path]` location, `remove <id>` deletes that receipt but leaves the files it named, because their ownership cannot be verified. `update <id>` installs the plugin again and writes a fresh receipt; it replaces an existing executable only when no other receipt, valid or unusable, could own it. The existing sole broken-self-receipt repair, including malformed or future-protocol receipts, remains supported when no other receipt could own the executable. A binary plugin update must still read the old receipt to back it up. If permissions prevent that, restore read access first, or remove the receipt, then inspect its leftover executable and move or delete it if unused before reinstalling. A stray receipt outside a valid plugin-id location cannot be removed or repaired by these commands; delete the receipt file by hand using the path shown by `list`. `copy <id>` requires a readable workflow-pack receipt for that id and rejects a broken one; run `update <id>` to repair it, or `remove <id>` then reinstall it before copying. `add` of any other plugin refuses until every unusable receipt, including an incompatible provider receipt, is repaired or removed, because file ownership cannot be verified.

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

Show version, platform, build type, database, and the Archon commit it was built or started from. The commit line is left out when that commit is unknown.

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

The optional `name` resolves like a run does (see [Workflow name matching](#workflow-name-matching)). A name without an exact match fails with suggestions instead of choosing a workflow.

`--full` returns exact authored descriptions; give it a `name` to see one workflow's full detail. With `--json`, the output is `{ "workflows": [...], "errors": [...] }`, and `--full` sets every `descriptionTruncated` to `false`. Optional fields (`provider`, `model`, `effort`, `webSearchMode`, `parseWarnings`) are omitted when a workflow does not set them. A workflow written with the deprecated `modelReasoningEffort:` reports that value as `effort`, unless it also declares `effort:`, which wins. Each `parseWarnings` entry names a key the engine dropped or deprecated, where it was found and what to write instead; see [Unknown keys](/reference/workflow-language/#unknown-keys-are-reported-not-rejected). Discovery errors remain in the top-level `errors` array when a name filters the workflow list. If the exact workflow name is missing, the failure envelope is `{ "ok": false, "error": "...", "errors": [...] }`, retaining errors found during the same discovery.

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
| `fixture.authored` | Optional authored outcome expectation: `succeeded` or `failed` for a boolean outcome, or the value of a named one. A mismatch or an undeclared outcome fails the fixture |
| `fixture.fail-node` | Required when `expect: failed`. A node id, or a list naming the exact failed set (a loop body failure is the node and its group) |
| `fixture.reached` | Nodes that must complete or be stubbed |
| `fixture.inputs` | Values for the workflow's declared inputs |
| `fixture.resolved-text-contains` | Map of node id to a fragment that must appear in that node's resolved text |
| `exec-code` | `true` executes `bash:` and `script:` nodes, in a scratch worktree of `HEAD`, instead of requiring stubs |

The command exits 0 when every fixture passes, including when none are declared. It exits 1 when a fixture fails, a workflow cannot load, or a named target has no fixtures. `--json` prints `{ results, passed, failed, errors }`. Each result can include `nodeFailures: [{ nodeId, reason }]` with the failed nodes' diagnostics. This field can be present when the fixture passes because it correctly expects a node to fail; `failureReason` describes a fixture verdict failure and can be absent in that case.

A failed fixture also prints a per-node trace under `trace:`, the status lines `workflow run --dry-run` prints: each node stubbed, completed, skipped with its reason, paused or failed. With `--json` the failed result carries the same entries as `trace: [{ nodeId, nodeType, state, iteration?, reason? }]`. The trace carries no resolved text, outputs or skip conditions; a failed node's diagnostic stays in `nodeFailures`. A passing fixture prints no trace and its JSON has no `trace` field. The trace needs no configured provider.

Fixtures with `exec-code: true` receive the same environment as [executable dry runs](#deterministic-dry-run): inherited process values, file-configured `env`, then registered-project environment values, with later sources winning. Environment lookup happens only for executable fixtures. If lookup fails, that fixture fails with the lookup error; independent stub fixtures still run and workflow-load errors remain in the report.

### `workflow types`

Generate TypeScript from the [`output_format`](/reference/workflow-language/#typescript-for-output_format) of a workflow's nodes, so scripts read node outputs through generated types instead of restating each schema by hand. The file holds, for every node that declares `output_format`, its output type (`NodeOutput<'<workflow>', '<node>'>`) and, for every `enum` in those schemas, its values as an `as const` tuple (`OUTPUT_ENUMS`). It contains no imports.

```bash
archon workflow types my-team                          # a pack of this project, by name
archon workflow types .archon/workflows/my-team        # the same pack, by directory path
archon workflow types my-team --check                  # write nothing; exit 1 when stale
archon workflow types build-change --out src/build-change.gen.ts   # one workflow
```

| Target | Written to |
| --- | --- |
| A pack: its name under `.archon/workflows/`, or its directory path | `<pack>/.shared/outputs.generated.ts`, unless `--out` names another file |
| One workflow: its name, its YAML file, or its folder | The `--out` file, which is required |

A relative path target and `--out` resolve from the invoking directory. A workflow file can live anywhere, inside or outside the project. A name resolves in the project's `.archon/workflows/` only; bundled, global and installed workflows are not targets. The generated file's header names the command that regenerates it, with paths relative to the project root.

| Flag | Effect |
| --- | --- |
| `--out <file>` | The file to write |
| `--check` | Compare instead of writing. Exits 1 naming the file when it is missing or its content differs. CRLF line endings in the file are read as LF, so a checkout that converts line endings stays current |
| `--json` | Print `{ ok, path, status, workflows, nodes }`; `status` is `written`, `unchanged`, `current` or `stale` |

Output is deterministic: workflows sorted by name, nodes and fields in YAML order. The command exits 1 without writing when a workflow of the pack does not load, when no node declares `output_format`, or when a schema uses a keyword the generator cannot state as a type; that error names the workflow, the node and the keyword. See [the supported keywords](/reference/workflow-language/#typescript-for-output_format).

### `script types`

Print the TypeScript declaration of `archon:script`, the module Archon provides to every Bun `script:` node. It declares the module's functions and the request and result type of every forge operation, so an editor or `tsc` checks a pack's scripts with no `node_modules`. See [The script API](/guides/script-nodes/#the-script-api).

```bash
archon script types                                   # print the declaration
archon script types --out types/archon-script.d.ts    # write it to a file
archon script types --out types/archon-script.d.ts --check   # write nothing; exit 1 when stale
```

| Flag | Effect |
| --- | --- |
| `--out <file>` | The file to write, relative to the invoking directory. Without it the declaration goes to stdout |
| `--check` | Compare instead of writing. Exits 1 naming the file when it is missing or its content differs. Needs `--out` |
| `--json` | Print `{ ok, path, status }`; `status` is `written`, `unchanged`, `current` or `stale`. Needs `--out` |

The declaration is embedded in Archon and describes the module that version provides. Write the file again after an upgrade.

### `script preload`

Write the preload file that provides `archon:script`, so a workflow script or its tests run outside a run. It is the file Archon passes to every Bun `script:` node, and it needs nothing else: the module's source is inside it. See [The script API](/guides/script-nodes/#the-script-api).

```bash
archon script preload --out test/archon-script.preload.ts           # write it
archon script preload --out test/archon-script.preload.ts --check   # write nothing; exit 1 when stale
bun --preload ./test/archon-script.preload.ts scripts/triage.ts     # run a script with it
```

| Flag | Effect |
| --- | --- |
| `--out <file>` | The file to write, relative to the invoking directory. Required |
| `--check` | Compare instead of writing. Exits 1 naming the file when it is missing or its content differs |
| `--json` | Print `{ ok, path, status }`; `status` is `written`, `unchanged`, `current` or `stale` |

The file is written with LF line endings on every platform, and describes the Archon that wrote it: write it again after an upgrade.

### `workflow run <name> [message]`

Run a workflow with an optional user message, which the workflow reads as `$ARGUMENTS`.

```bash
# Basic usage
archon workflow run archon-investigate --cwd /path/to/repo "Why does the export job time out?"

# With isolation
archon workflow run archon-plan --cwd /path/to/repo --branch feature-x "Add caching"

# Supplying a workflow's declared inputs (one flag per input)
archon workflow run review-block --cwd /path/to/repo \
  --input diff="$(git diff)" --input style=terse "focus on the auth changes"

# Supplying a large input from a file
archon workflow run review-block --cwd /path/to/repo \
  --input-file diff=changes.diff "focus on the auth changes"

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
| `--workflow-source <path>` | Read the workflow, its commands, and its scripts from this checkout root instead of `--cwd`. `<path>` is the directory that contains `.archon/`: Archon reads `<path>/.archon/workflows`, `.archon/commands`, and `.archon/scripts`. `<path>` may also be a pack's own folder, the directory holding its workflow-pack `archon-plugin.json`: it is read as the project pack named by the manifest `name` (see [A pack folder as the source](#a-pack-folder-as-the-source)). The named workflow must be found there, or the run is refused before it starts. Lets an **uncommitted** workflow in one checkout run against a different checkout, repository, or folder project, with no commit, push, or merge. Fresh runs only: a resumed run executes the source it already captured. Without it, a worktree run reads its definitions from the base branch with `--cwd`'s uncommitted changes on top. See [Running a workflow from another checkout](#running-a-workflow-from-another-checkout). Repo config is not part of an explicit source: the run reads `.archon/config.yaml` from the launch checkout (`--cwd`); see [Where a run reads `.archon/config.yaml`](/reference/configuration/#where-a-run-reads-archonconfigyaml). |
| `--branch`, `-b <name>` | Branch name for the worktree; reuses a healthy active task worktree registered in Archon for the project and branch, or a usable checkout at the configured target path. If another path holds the branch and was not reused, check for a live Archon run before freeing it and retrying. A worktree created for a named branch is never removed when the run ends; `isolation cleanup --merged` removes it |
| `--from <branch>`, `--from-branch <branch>` | Start point for the new worktree only. An existing worktree whose history lacks it is refused, not reused; see [Where the run executes](#where-the-run-executes). Unlike `--base`, it does not change the PR target. |
| `--base-branch <name>` | Choose the project base branch on first registration only. Omit to follow the remote default at use time; no prompt. Rejected for folder projects, existing projects, adoption/supersedes, dry runs, and every subcommand other than `workflow run` and [`project add`](#project-add). A reachable remote must advertise the branch. With `--base`, this flag stores the project choice while `--base` overrides only this dispatch. |
| `--base <branch>` | Per-dispatch base override, inherited by fresh shared-checkout children. Sets **both** the worktree cut-from **and** the PR target (`$BASE_BRANCH`), and outranks the item's [landing branch](#workflow-landing), `worktree.baseBranch` in config and the codebase default; see [Base branch precedence](#base-branch-precedence) below. The branch **must already exist on the remote** (in a repository with no remote, as a local branch); a missing one is a hard error, not a fallback. Combine with `--from` to drive the two separately. Rejected with `--no-worktree`, `--folder`, and workflows pinning `worktree.enabled: false`. |
| `--project <id\|name>` | Bind a fresh run to an existing registered repository by ID or exact name (for example `owner/repo`); see `archon project list`. Folder projects are unsupported. See `archon workflow run --help` for incompatible flags. |
| `--no-worktree` | Run directly in the live checkout, without isolation |
| `--folder` | Register the current directory, git or not, as a folder project on first use and run in place, without a worktree. Rejects `--branch`, `--from` and `--base`. |
| `--container` | Run a **folder project** inside an overlay-isolated Docker container instead of in place (writes land in an overlay, not the live root, until an approval-gated write-back). Folder-only; a repo project errors. Requires the runner image (`bun run build:runner-image`). Normal gate pauses `docker stop` the container; `workflow resume`/`approve`/`reject` rediscover and restart it after resume admission. Failed resume setup marks the run failed. Failed setup or suspension can leave its container running and consuming resources; see [Pause economics](/guides/container-isolation/#pause-economics). See the [Container isolation guide](/guides/container-isolation/) and [configuration](/reference/configuration/#container-isolation-folder-projects). |
| `--input <name>=<value>` | Supply one value for the workflow's declared `inputs:`. **Repeat the flag per input.** Splits on the first `=`, so the value may itself contain `=`; `--input name=` supplies an empty string. Omitted inputs take their declared `default:`. A missing **required** input or an **undeclared** name is refused before any worktree, clone, or AI cost, through the same contract a composing `with:` map goes through. Works with `--dry-run` (inputs resolve exactly as in a real run). A continuation (`workflow resume`, `approve`, `reject`, `respond`, `answer`) keeps the inputs recorded on the run and refuses `--input`. A value that looks like a path stays that string; for a large value, use `--input-file`. See [Running a workflow that declares inputs](/reference/workflow-language/#running-a-workflow-that-declares-inputs). |
| `--input-file <name>=<path>` | Supply one declared input from a file. **Repeat the flag per input.** The value is the file's exact contents read as UTF-8, trailing newline included (unlike `$(cat file)`), and the run records it exactly as it would record the same value given with `--input`. A relative path resolves from `--cwd`, like `--config`. A missing or unreadable file is refused before any worktree, clone, or AI cost, naming the input and the path; so is a name given by both `--input` and `--input-file`, naming the input. Only `workflow run` takes it; any other command refuses it. The launching command reads the file once: a `--detach` child takes the inputs recorded on its run, so the file may be removed as soon as the command returns. Works with `--dry-run`; continuations refuse it like `--input`. Use it for a large value: on Linux a single command-line argument over 128 KiB fails with "Argument list too long", and an argument shows in process listings and shell history. `trigger fire --inputs <file>` takes a different shape on purpose: one JSON object of event inputs that the binding maps onto its workflow, not the workflow's declared inputs. |
| `--model <name>=<spec>` | Rebind one `small`, `medium`, `large`, or `@alias` for this run. **Repeat the flag per binding.** An Archon agent prefix selects that agent (`codex/gpt-6.1-sol`); another valid vendor/model ref selects Pi (`openai/gpt-5.6`); an unqualified model keeps the binding's current provider, so binding an `@alias` no config defines (one a workflow's model preference list names, such as `@reviewer`) needs a prefixed model, a tier, or another alias; a tier or alias RHS copies that preset. Unspecified names keep their user → repo → global → built-in values. Literal `model:` pins and nodes that never reference the rebound name do not change. Bare `--model <spec>` is invalid and there is no run-wide `--provider`. A resume keeps the run's own bindings. Works with `--dry-run`. |
| `--config <path>` | Load one sparse YAML config layer for this fresh run. Relative paths resolve from the directory named by `--cwd`, even when it is a repository subdirectory. Values in the file override persistent config and user AI preferences; explicit `--model` flags then replace only their named bindings. Works with `--dry-run` and `--detach`; the parent validates and seals the layer before handing it to a detached child, so later file edits cannot change that launch. A continuation restores the sealed layer recorded when the run started instead. A fresh start on an [item](#items) given neither `--config` nor `--config-from-run` runs on the config the item's most recent run was started with. |
| `--config-from-run <run-id>` | Start this fresh run with the run config layer the named run was started with, as if its `--config` file were passed again. A run started without `--config` contributes nothing, so the new run uses the install's config alone. Use it when one workflow launches another to continue the same work, so the continuation keeps the provider configuration it started on. Exclusive with `--config`. Works with `--detach`. |
| `--adopt <run-id>` | Start a new run in a terminal run's exact worktree or branch, with `adopted_from_run_id` provenance and `$ADOPTED_RUN_DIR` access. Inherits its recorded AI configuration; conflicting AI config or model overrides are rejected. A unique run-id prefix resolves within the launch project; ambiguous prefixes fail with candidate IDs unless `--chat-project-id` scopes selection. With that flag, use a longer prefix or full ID. Adoption never infers a run from workflow name or prompt text. |
| `--supersedes <run-id>` | Start in a fresh estate while recording that this run replaces a terminal prior run. Accepts a unique prefix within the launch project; ambiguous prefixes fail with candidate IDs unless `--chat-project-id` scopes selection. With that flag, use a longer prefix or full ID. Full IDs select the exact run, including another project unless `--chat-project-id` restricts selection. Unlike `--adopt`, it inherits no checkout. Given with no workflow name (`archon workflow run --supersedes <run-id>`), it starts that run again from its record: the same workflow, message, inputs and definitions source, on the same item, in the run's project wherever it is invoked from. A run whose definitions were read from a base branch starts on that branch again, as though `--base <branch>` were passed; an explicit `--base` wins. A restart invoked outside the run's project starts from the project's registered checkout. Inputs are passed as the text the run recorded, as `--input` would pass them, so a number or boolean a trigger binding supplied arrives as its text. A run started on another run's checkout adopts that run when it continued the checkout, or cuts a fresh worktree at the hand-off's commit when it worked on a copy. Any other run starts in a fresh worktree, also when the first start used `--no-worktree`; pass `--no-worktree` again to run in place. This form refuses `--input`, `--input-file`, `--workflow-source`, `--adopt`, `--from` and `--from-branch`, which the record supplies, and `--detach`; name the workflow to pass them. |
| `--item <key>` | Name the [item](#items) this fresh run belongs to. Without it, a run started with `--adopt` or `--supersedes` belongs to the item of the run it continues. A resumed run keeps its own. |
| `--quiet`, `-q` | Suppress the progress lines on stderr |
| `--verbose`, `-v` | Also print tool calls (name and duration) in the progress lines, and debug logs |
| `--detach` | Run in a detached background child and return before completion. Human output names the transcript and the child's log file; the `--json` acknowledgement carries `runId`, `transcriptPath` (the run's JSONL transcript) and `logPath` (the child process's stdout and stderr). Follow execution with [`workflow logs <run-id> --follow`](#workflow-logs) and wait for the next terminal or gate transition with [`workflow wait <run-id>`](#workflow-wait). A refusal the launch can decide from current state is the command's result, before the acknowledgement: a registered `--branch` worktree on another branch or without `--from` in its history, a broken run-ended binding for an `--item` run, or a workflow that declares `returns.asks` started without `--item`. A failure the child meets later, such as creating the worktree or waiting for a resource, is recorded on the run; read it with `workflow get <run-id>`. `approve`, `reject`, `respond` and `resume` accept it too; see [Detached control verbs](#detached-control-verbs). |
| `--no-wait` | Refuse to start, naming the resource, when the workflow declares a `resource:` that is full, or naming the holding run when another run of the workflow on the same `--item` is not terminal ([one run of a workflow per item](/guides/workflow-triggers/#one-run-of-a-workflow-per-item)). Also refuses, naming who set it and when, while the [install hold](#hold) is set, and while the install's [run limit](/reference/configuration/#run-limit) is full. Without it the run waits as `pending` and starts when the hold clears: it prints `Waiting for resource '<name>'` until a slot frees, `Waiting for item '<key>'` until the holding run ends, `Waiting for the install hold` until it is lifted, or `Waiting for the run limit` until a run ends. See [Workflows that declare a resource](/guides/workflow-triggers/#workflows-that-declare-a-resource) for where the capacity comes from. |
| `--conversation-id <id>` | Correlation id for the run's messages. It creates no conversation and no `persist_session` scope. |
| `--dry-run` | Simulate deterministic DAG control flow in memory. Creates no run, worktree, session, event, artifact, or provider request. |
| `--stubs <path>` | YAML mapping of node ids to scalar or structured outputs for `--dry-run`. Relative paths resolve from `--cwd`. |
| `--stubs-init <path>` | Write a stub scaffold for the expanded workflow and exit. Omits child-workflow nodes; add their stubs manually as described [below](#deterministic-dry-run). Refuses to overwrite an existing file. Relative paths resolve from `--cwd`. |
| `--default-stubs` | Fill reachable AI, bash, and script nodes omitted from `--stubs` with schema-valid placeholders. Never substitutes for child-workflow stubs. With `--exec-code`, unstubbed bash/script nodes execute locally instead of receiving placeholders. Explicit stubs still win; without either flag, a missing reachable AI, bash, or script stub remains an error unless that node declares `trigger_rule: all_done`. Reached child-workflow nodes require authored stubs unless fan-out items resolve to `[]`; skipped branches need no stubs. |
| `--exec-code` | During `--dry-run`, execute trusted unstubbed `bash:`/`script:` nodes locally, even with `--default-stubs`. Explicit stubs still win. Default is no code execution. |
| `--pause-at-gates` | During `--dry-run`, stop at the first deprecated `approval:` gate instead of auto-approving it. An [attention wait](/reference/workflow-language/#attention-waits) needs no flag: it pauses the simulation unless the stubs answer it. |

Fresh CLI runs do not create a chat conversation, message history, or title. Execution output stays in stdout and the run's transcript, events, and artifacts. Resuming a run with an existing chat origin keeps recording into that conversation.

#### Where the run executes

By default, a run:

- creates a worktree on a generated branch, `archon/task-<workflow>-<run id>` (identifiers longer than 50 slug characters use a shortened prefix and a digest of the full identifier), so starts of one workflow at the same instant each get their own branch and worktree;
- registers the codebase on first use in a git repository;
- reads its workflows, commands, scripts and `.archon/config.yaml` from the base branch as fetched now, with the launch checkout's uncommitted and gitignored files on top, and cuts the worktree from that same commit. A local edit applies to the run without entering the worktree; changes committed on the checkout's own branch do not. A file changed both locally and on the base branch refuses the run. See [Where a run reads `.archon/config.yaml`](/reference/configuration/#where-a-run-reads-archonconfigyaml).

With `--branch <name>`:

- Archon first looks for a healthy active task worktree registered for that project and branch. It reuses the registered path without advancing it, even if it differs from the configured target.
- Without a healthy registration, worktree creation uses `~/.archon/workspaces/<owner>/<repo>/worktrees/<name>/` (or the repo-local path `worktree.path` configures). A usable existing checkout at that target path is reused without advancing it.
- Before either reuse path, Archon verifies the checkout is on the requested branch. A different branch or detached HEAD fails with the requested branch, actual branch, and checkout path, leaving the checkout unchanged.
- If no healthy active task registration was reused and another path holds the branch, the run fails with `branch_checked_out`, naming the holder, whether or not it is registered in Archon. Check whether a live Archon run still needs that checkout before freeing the branch. Once it is safe, preserve its changes, then detach it with `git -C <holder-path> switch --detach` or remove it before retrying.
- If the branch already exists but no worktree holds it, checks it out at its current head: the local branch, or `<remote>/<branch>` when that contains the local branch (the local branch is fast-forwarded to it). It never resets an existing branch to the base.
- Fails before any work if the local branch and `<remote>/<branch>` have diverged. Reconcile them, or delete the local branch to start from the remote one.
- To start fresh from the base, delete the branch (`git branch -D <name>`, and the remote branch if there is one) or choose another name.
- If a new worktree must be created, `--from` is rejected when the branch already exists, locally or on the remote. Reusing an existing worktree, registered or found at the target path, leaves its checkout unchanged, so `--from` must already be in its history: its HEAD or an ancestor of it. `--from` resolves in the repository, as it does on creation, so `--from HEAD` means the repository's HEAD, not the worktree's. Otherwise the run is refused before it starts, naming the worktree, its base (where its history meets `--from`, or that they share none) and the requested start point, and nothing is changed. Omit `--from` to continue in the worktree, or remove the worktree and delete the branch to start fresh from `--from`. For a registered worktree, `--detach` makes this refusal its result (exit 1, `{ "ok": false, "error" }` under `--json`). For a checkout found only at the target path, the detached child makes it and records it on the run, read with `workflow get`.

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
archon workflow run archon-implement \
  --workflow-source ~/dev/archon \
  --cwd ~/checkouts/archon-target \
  "implement the plan"
```

`--workflow-source` takes a checkout root, the directory that contains `.archon/`, or [a pack's own folder](#a-pack-folder-as-the-source). The workflow named on the command line must resolve from that directory's `.archon/workflows` (a pack in `.archon/workflows/<pack>/` counts). If it does not, the run is refused before it starts. The error names the directory searched, and the scope the name would otherwise have resolved from when another scope has it. Archon never silently runs a bundled, global, or installed workflow of the same name in its place. Commands, scripts, and `include:` or `workflow:` children the named workflow uses may still resolve from your home-scoped or bundled source as usual, so a source can override some of a pack's files only if it holds the pack's named workflow. A run that resolves from the source records `project` as its `metadata.dispatch.source`.

Every run freezes its workflow source when it starts, whether or not you pass this flag. That means the source directory's `.archon/workflows`, `.archon/commands`, and `.archon/scripts`, plus your home-scoped `~/.archon/` source and Archon's own bundled defaults. Without this flag, a run that gets a worktree takes those directories, and `.archon/config.yaml`, from the base branch as fetched at its start, with the uncommitted files of the checkout it was launched from laid on top; see [Where a run reads `.archon/config.yaml`](/reference/configuration/#where-a-run-reads-archonconfigyaml). Everything a static `include:` can reach is frozen together, so an included global or bundled workflow cannot change shape under a run either. That freeze is what makes the rest predictable:

- **The target stays clean.** Nothing from the source checkout is written into it, so its `git status` and its validators only ever see its own files.
- **A run does not change shape while it is running.** Edit, move, or delete the source checkout after a run starts and a resume still executes what the run began with. Start a new run to pick up the edits.
- **Resume needs no source path.** Every continuation (`archon workflow resume <run-id>`, `approve` and `reject`) loads the run's own captured source.

#### A pack folder as the source

A pack author can run a pack from its own repository without installing it. When `--workflow-source` is a directory whose root holds an `archon-plugin.json` with `"kind": "workflow-pack"`, Archon reads that directory as a project pack named by the manifest `name`, exactly as if it sat at `.archon/workflows/<name>/`:

```bash
archon workflow run review --workflow-source ~/dev/review-kit --cwd ~/checkouts/widgets "review the change"
```

The local copy runs under project naming: its workflows by their YAML `name:` (`review`), and the pack as `review-kit` in `pack graph` and `pack bindings`. An installed copy of the same pack keeps its own name (`acme/review-kit:review`, pack `acme.review-kit`) and is never changed. A run starts by printing which copy of the workflow's pack it loaded and from where, and names any other copy in reach with how to run it. With `--json` those lines go to stderr, so stdout stays the JSON payload. An installed workflow is refused under `--workflow-source`, so to run the installed copy, drop the flag and name it in full.

A run freezes what an install of the folder would hold: in a git checkout, its tracked files and the untracked ones git does not ignore, so ignored files such as `node_modules` or build output stay out; outside git, the whole folder. A `.env` file is never frozen, and the folder's own `.archon/` is frozen as for any project (its workflows, commands and scripts). The folder is read live, as any explicit `--workflow-source` is; a worktree run without the flag reads its definitions from the base branch, which covers only the `.archon/` definition paths, so pass the flag to run a pack folder.

A pack folder that also holds `.archon/workflows/<name>/` has two copies of one pack, and neither loads. An invalid manifest fails the same way. Either is reported as that pack's load error, and the project's other workflows still run. A manifest of another kind (provider, forge) does not make its directory a pack folder.

The capture lives at `~/.archon/workspaces/<project>/workflow-source/runs/<run-id>/`, beside the run's artifacts, and is kept as long as the run's other output. It is not inside `$ARTIFACTS_DIR`, which is the run's output channel. Its manifest records a content digest and the source-resolution settings, and the run row stores both too. Archon hashes the full capture during discovery, on resume and before every later command, named script or composed-source read, and refuses the read, and any container dispatch, when the capture changed. Start a fresh run to execute the current workflow.

When this host cannot read the capture, or it is missing here, the run never falls back to live source. After admission, Archon releases the run so a host that can read the capture continues it (see [`workflow wake`](#workflow-wake)); if recording that release fails, the run is recorded as failed. Before admission, execution is refused until the capture is readable. A run that started before Archon captured source resumes against the current source with a warning. An older capture without stored source-resolution settings is verified against its digest, and its settings are copied from the manifest to the run row on first resume.

These checks find a mismatch that exists when Archon checks. They do not seal the directory or make execution a security sandbox: another process running as the Archon user can still change a file after a check, and parallel nodes that already started are not cancelled. Inline node bodies and command bodies compiled into an included graph are already in memory. A runtime `workflow:` child captures the live authoring source when the child starts. Under a parent whose definitions came from the base branch, that is the parent's captured definitions with the definition files the parent's checkout changed since it started laid on top. If the parent's recorded authoring directory has moved or been deleted, Archon refuses to start the child rather than capture a same-named workflow from the target checkout.

A compiled binary writes its embedded bundled workflows, commands and scripts into the capture too, so upgrading Archon between a pause and its resume is safe: the run keeps the bundled content it started with.

For `--container` runs, Archon checks the host capture before dispatch and bind-mounts it read-only at the same absolute path inside the container, so a named script resolves the same way on the host and in the container. `$ARTIFACTS_DIR` is bound the same way, read-write. The read-only bind does not contain a hostile process: native overlay mode has `CAP_SYS_ADMIN`, and a same-UID host process can still race a check. `--workflow-source` is refused with `--container`, because a folder project's source and target are the same directory.

#### Deterministic dry-run

Use dry-run to test DAG routing, joins, loops, `when:`, strict output fields, and variable substitution without starting a real workflow. It selects its definitions as the real start does: the registered project, an item's landing branch with `--item`, then the base branch as fetched now with the checkout's uncommitted changes on top (see [Where a run reads `.archon/config.yaml`](/reference/configuration/#where-a-run-reads-archonconfigyaml)), and it refuses what the start refuses, a conflicting local change or a base it cannot read. A folder project and a workflow that pins `worktree.enabled: false` read the checkout as it is. To preview without the project registry or a remote, name the source with `--workflow-source`, which is read as it is:

```bash
cat > stubs.yaml <<'YAML'
classify:
  issue_type: bug
  severity: high
investigate: "Root cause: stale cache"
YAML

archon workflow run archon-triage --cwd /path/to/repo \
  --dry-run --stubs stubs.yaml "Issue #2100"

# One complete JSON document, safe to pipe in CI
archon workflow run archon-triage --cwd /path/to/repo \
  --dry-run --stubs stubs.yaml --json | jq '.trace, .outcome, .authoredOutcome'
```

Generate a starting stub file when a composed workflow has many nodes, then keep the values that drive the path you want to test and manually add any required child-workflow stubs:

```bash
archon workflow run archon-deliver --cwd /path/to/repo \
  --dry-run --stubs-init stubs.yaml

# After editing the generated YAML and adding required child-workflow stubs:
archon workflow run archon-deliver --cwd /path/to/repo \
  --dry-run --stubs stubs.yaml --default-stubs
```

The scaffold is derived from the already-expanded workflow, so included top-level nodes use their flattened ids (for example, `review__classify`). Body nodes of a `loop_group` keep their bare ids even inside an included block; only the group node gets the `<includeId>__` prefix. The scaffold omits runtime `workflow:` nodes, including fan-outs. Add those entries manually: use the node's YAML `id` for a top-level child and prefix it with the enclosing include id for an included child (for example, `review__review-each`). Nested includes add each enclosing prefix in order (for example, `delivery__review__review-each`). Structured `output_format` values are emitted as YAML objects with native booleans, numbers, arrays, and nested required properties. Loop completion fields are generated as `true`. If Archon cannot prove that a generated value satisfies its JSON Schema, scaffold generation fails before creating the file.

The stub file must contain one YAML mapping. Each value can be a string, object, array, number, boolean, or `null`. Strings become output text; when a node declares `output_format`, a string must contain one JSON document matching that schema. Objects, arrays, numbers, booleans, and `null` are preserved as structured output and serialized as JSON for output text, so downstream `$classify.output.severity` references behave like live structured producers. Authored values must satisfy the node's `output_format` when declared. An explicit `null` is an authored value, not a missing stub. Coverage is strict by default: a reachable AI, bash, or script node without a stub fails the simulation and appears in `missingStubs`.

Reached runtime `workflow:` sub-runs require an authored stub instead of being launched; skipped branches need no stubs. `--default-stubs` cannot stand in for child runs. For `workflow:` + `fan_out:`, supply a YAML array with one result per item, in item order, for example `review-each: [{ approved: true }, { approved: false }]` for two items. A non-array stub or a result count that differs from the resolved item count fails. Item expressions and static `with:` inputs resolve before the stub is accepted. When items resolve to `[]`, the node completes with `[]` without consuming or requiring a stub. Composed `include:` + `fan_out:` nodes remain unsupported in dry-run, even with a stub.

For AI, bash, and script nodes, the exception to strict stub coverage is a `trigger_rule: all_done` join, which runs after its dependencies settle regardless of their result. An interaction in a loop body is an exception: a prior body failure prevents it from starting, even with `all_done` (see [loop failure behavior](/guides/loop-nodes/#how-it-works)). A reachable join gets a generated placeholder and is listed in both `missingStubs` and `toleratedMissingStubs`, and the absent stub alone never fails the simulation or a `workflow test` fixture. It is only listed in `toleratedMissingStubs` once that placeholder exists: a node whose `output_format` cannot produce one still fails, and stays out of the tolerated list. A `loop:` node carrying the same trigger rule is tolerated on the same terms, with one addition: the placeholder must also end the loop, which it does by satisfying the node's own completion channel, so a tolerated loop always completes on its first iteration. If a loop's only completion channel is `until:`, the generated output must carry that sentinel as its final line. A string schema can supply it through `const`, `default`, or `enum`; if the generated output does not carry the sentinel, the node fails and stays out of the tolerated list.

Add `--default-stubs` to fill omitted reachable AI, bash, and script nodes with the same schema-aware placeholders used by scaffold generation. With `--exec-code`, unstubbed bash/script nodes execute locally instead of receiving placeholders. Explicit values always take precedence. Reached child-workflow nodes still require authored stubs unless fan-out items resolve to `[]`; skipped branches need no stubs. Without `--exec-code`, a reachable `bash:` or `script:` node that arrived through `include:` needs a stub like any other: a stubbed node never runs its body, so the caller's `with:` values are never delivered to it. With `--exec-code` it can run unstubbed and reads those values as described below. Supplied stubs for unknown or unreachable nodes appear in `unusedStubs`, while generated placeholders do not. Whole-output references retain their normal lenient behavior, while invalid strict `$node.output.field` references fail the consuming node exactly as they do in a real run. See [Node Output References](/reference/variables/#node-output-references).

A workflow's declared `inputs:` resolve exactly as in a real run: omitted inputs take their declared `default:`, `--input name=value` binds a value (visible in the trace's resolved text), and a missing **required** input or an **undeclared** name fails at the invocation gate with the same errors a real run gives, before any trace output. With `--exec-code`, bash and script nodes also receive the same `INPUTS_<UPPER_SNAKE>` environment variables a real run delivers: run-level inputs, an included block's own inputs, and a script node's `with:` bindings.

With `--exec-code`, child processes inherit Archon's process environment, then apply file-configured `env`, registered-project environment values, and per-run `env` overrides from `--config`, in that order (later values win). Node input variables and engine-owned variables such as `ARTIFACTS_DIR` take precedence over those layers. Registered-project values come from the project resolved for the invocation's working directory. See [configuration](/reference/configuration/) for file configuration and [managed environment variables](/reference/security/#secrets-handling) for stored credentials. Executable fixtures use the same layers, without per-run CLI overrides.

By default, bash and script nodes are never executed. `--exec-code` is an explicit opt-in for trusted local workflow code and is the only dry-run mode that can cause code-level side effects. An executed node that declares `output_format` is certified exactly as in a real run: stdout must be one JSON document that satisfies the schema, and downstream `$node.output.field` references read that certified value. Executed nodes receive `$ARTIFACTS_DIR` and `$STATE_DIR` under an ephemeral per-simulation directory in `~/.archon/temp/` (honoring `ARCHON_HOME`), created before the first executed node and removed when the simulation ends. A dry run writes nothing inside the repository, and a simulation that executes nothing creates no directory at all. An attention wait pauses the simulation where a real run would pause, unless the stub file gives that wait node a stub; the stub then stands in for its answer and must match the form's output, for example `review: { decision: approve, text: "" }`. Deprecated `approval:` nodes auto-complete unless `--pause-at-gates` is set. Dry-run is incompatible with lifecycle and isolation flags such as `--branch`, `--no-worktree`, `--folder`, `--container`, and `--detach`.

An attention wait's question, referenced options and recommendation, and labels are resolved and validated with the same code a real pause uses, before the dry run checks for an answer stub. Invalid asks fail on the wait with the real run's reason, including when no answer is supplied. A legal unanswered wait still pauses the simulation, while its `resolvedText` and structured `attentionAsk` show the resolved question, form, options, recommendation, labels, and reserved `other` option. A fixture can assert one wait's complete resolved label map with `fixture.wait-labels.<node-id>`; equality is exact. Failed fixture summaries retain only their narrow trace projection, not the resolved ask values.

The ordered trace records each node as completed, stubbed, skipped, failed, or paused, including its reason, resolved text, and safe output. The result reports two independent facts. `outcome` is the simulation execution result (`completed`, `failed`, `paused`, or `cancelled`) and still controls the CLI exit code. `completedOutcome` is the outcome the run would complete with, or `null`: set only when the simulation completed, the workflow declares `returns: { node, outcome }`, and the return node has a schema-valid structured result supplied by a stub or produced by code executed with `--exec-code`. It is `succeeded` or `failed` for a boolean outcome and the value for a named one; `authoredOutcome` carries the boolean form only, as the run row's `outcome` column would, and `declaresOutcome` says whether the workflow declares one. Generated placeholders from `--default-stubs` or an unstubbed `all_done` node do not invent an outcome. A completed simulation can therefore report a failed outcome. Human output labels these as `Simulation outcome:` and `Authored outcome:`; simulation JSON always includes the fields. `--stubs-init --json` does not run a simulation and instead returns a scaffold acknowledgement with `workflow`, `stubsPath`, and `nodeCount`.

Every node that takes an AI turn also reports the provider and model it will run on and where each value came from, using the executor's own resolution. This answers what a node in a composed workflow runs on, since a composed workflow runs with the configuration its own file declares:

```text
STUBBED   review__scope (prompt)
  runs on: codex (node) / gpt-6.1-sol (node) [from review-block]
  effort: high (node)
```

The origin in parentheses is one of `node`, `model ref` (a tier keyword or `@alias`), `workflow`, `assistant config`, or `default assistant`. `[from <name>]` names the workflow file a composed node was authored in. A node whose declared `provider:` disagrees with the provider its `model:` ref resolves to also reports the warning a real run would emit. `--json` carries the same values under each trace entry's `resolution` object.

This validates deterministic engine wiring; it does not validate model reasoning.

#### Base branch precedence

"Base branch" means two things, and by default one flag sets both: the **cut-from**
(what `git worktree add` branches off) and the **PR target** (`$BASE_BRANCH`, which
bash nodes pass to `gh pr create --base`). Five sources can supply it, highest first:

| Precedence | Source | Scope |
|------------|--------|-------|
| 1 | `--base <branch>` | one dispatch |
| 2 | The item's [landing branch](#workflow-landing): its own, else that of the nearest item it is `part_of` | every fresh run on the item |
| 3 | `worktree.baseBranch` in `.archon/config.yaml` | the repo |
| 4 | The registered codebase's stored default branch | the repo |
| 5 | Live symbolic HEAD advertised by the selected remote; with no remote, the checkout's current branch | the repo |

Level 2 applies to a fresh run on an item: `--item <key>`, or the item of the run that
`--supersedes` or `--adopt` names, and every [trigger start](/guides/workflow-triggers/#land-an-items-runs-on-its-own-branch)
on an item. A run on no item, or on an item where neither it nor anything it is part of
records a branch, skips it. Levels 3 and 4 are project choices; level 5 is resolved live using `worktree.remote`
or the automatically selected remote. Use `--base` for a different base on one dispatch. New registrations store a branch only when explicitly chosen with `--base-branch`.
An unset project branch follows the remote's live HEAD advertisement, including renames;
resolution requires a reachable remote with a known symbolic HEAD and never guesses `main`.
A repository with no remote fetches nothing: its worktree is cut from the local branch
level 1, 3 or 4 names, else from the branch checked out in it, and the run records that
base. A detached HEAD with none of those set is refused. A landing branch (level 2) needs
a remote, so a run on an item that records one is refused there. A later run that reuses
a worktree Archon cut (the same `--branch`, `--adopt`, a trigger lane's `branch` or
hand-off, or a chat conversation's worktree) reports the base that worktree was cut from,
unless `--base` or a landing branch names another.
Existing stored branches remain explicit, including values older versions detected from a
local checkout. See [Troubleshooting](/reference/troubleshooting/) to clear a stale choice.

`--base` is the per-dispatch level, which is what makes parallel multi-base
dispatch (epic slices, A/B variants) config-free.

**Scope: isolated children resolve independently.** A `workflow:` node with `isolation: worktree`
creates a worktree for its child run, and that worktree is cut using levels 3--5
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
archon workflow run archon-implement --from origin/release/2.0 --base dev "Backport the fix"
```

`--from` is handed to `git worktree add` verbatim, so a remote ref such as
`origin/release/2.0` works. Note the sync-before-create step refreshes the
`--base` branch, not the `--from` start point, so pass a remote ref when the local
copy of the start point may be stale.

**Where `--base` is rejected** (rather than half-applied): with `--no-worktree`,
against a [folder project](/guides/multi-repo-projects/),
and against a workflow pinning `worktree.enabled: false`. None of these create a
worktree, so the flag could only move the PR target, which would report a base
no worktree was ever cut from. For the same reason a run on an item with a landing branch
is refused in these cases (and when it runs in a folder project) before it starts, naming
the branch. `--adopt` on such an item continues the adopted run's checkout and proposes
against the landing branch.

**When an existing worktree is adopted** by `--branch` reusing a healthy Archon
registration or a usable checkout at the configured target path, the cut-from is already
fixed, so `--base` or the item's landing branch changes only the PR target. Archon warns,
naming which of the two it was.

**A continuation keeps the base it started with.** A run records its resolved
`$BASE_BRANCH` when it starts, and every continuation of it (`workflow resume`, an approved
gate, or the automatic resume of a parent whose sub-run gate was approved) reports that
value rather than re-running levels 2--5 against whatever config, items and git say later.
Continuations refuse `--base`, and recording a new landing branch on the item does not move
a run already started. A run started before Archon
recorded this re-resolves through levels 3--5 and logs
`workflow.dispatch_not_recorded_resolving_live` when it does.

#### Continuing an existing estate

Use structured continuation whenever a workflow must work on an existing branch or pull request. If you have the prior run id, `--adopt <run-id>` is the authoritative form. Archon reuses the prior worktree as-is. If the prior worktree is gone, Archon reuses a same-repository checkout already holding that branch, or creates one on the exact local branch. It does not fetch, reset, or synchronize the branch; update it first if the remote advanced.

Every node in the new run uses that selected checkout, including bash/script delivery assertions. A branch name written only in the message is model context; it does not move engine-owned nodes to another checkout.

#### Workflow name matching

`workflow run`, the workflow query commands and the chat adapters require an exact,
case-sensitive workflow name. Use `archon-review`, not `review` or `Archon-Review`.
Qualified installed names such as `owner/plugin:entrypoint` must also match exactly.
The same rule applies to YAML `workflow:` and `include:` targets, composed fan-outs,
resource starts and run continuation.

On a miss, CLI and chat errors suggest nearby names without selecting one:

```
Workflow 'review' not found.

Did you mean:
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

Each run carries the latest [notice](#workflow-notice) it emitted, which says what the run
is about: a `Notice:` line in text, and `notice` (`{ at, node, text, labels }` or null) in
JSON. `archon workflow status --all` therefore answers "what is running right now, and on what".

The normal human and JSON views include every active node without fetching each run's event
history. In JSON, `active_nodes` is the ordered list of unresolved node starts: `node_started` adds
an identifier and `node_suspended` keeps it active, while `node_completed`, `node_failed`, `node_skipped`, and
`node_skipped_prior_success` remove it. Retries re-add the node in their new start position. This
is node lifecycle state, not evidence that a process owner is alive.

Tool-call advisories appear in nonverbose text and in the JSON `attention` field. The run remains `running`; every overdue tool shows its node, provider, sanitized command/title, and elapsed/no-progress duration. The default is 30 minutes without reported progress; see [workflow attention settings](/reference/configuration/#workflow-attention-and-continuation-settings).

While the [install hold](#hold) is set, the text view starts with who set it and when, and lists the starts it keeps. JSON always carries `hold` (`{ setBy, setAt }`, or null) and `heldStarts`, empty while no hold is set. Each held start has a `kind`: `trigger` (`{ receiptId, bindingId, hostId, workflow, cwd, itemKey, receivedAt }`), a binding start not yet prepared, listed install-wide because it has no project until it is prepared; `queued` (`{ requestId, hostId, resource, workflow, queuedAt }`), a request that was already waiting for capacity, its item or its checkout; or `run` (`{ runId, workflow }`), a hand start in scope waiting in the process that started it. `workflow` is null when the stored binding or launch does not read.

### `workflow runs`

List recent runs of every execution status for the current project, resolved from `cwd` like [`workflow status`](#workflow-status). A separate clone does not resolve to that project, even after a launch with `workflow run --project`. `--open` lists the open-work inbox: failed runs that no later run has adopted or superseded.

```bash
archon workflow runs
archon workflow runs --json
archon workflow runs --json --verbose  # add per-node state and attention to each run
archon workflow runs --status failed   # filter to one status
archon workflow runs --limit 50        # cap rows (default 20)
archon workflow runs --throughput      # effective output tok/s by run and model
archon workflow runs --throughput --json --verbose
archon workflow runs --all             # list across all projects
archon workflow runs --open            # failed runs nothing has adopted or superseded
archon workflow runs --item issue-42   # one item: its runs, links, open questions, answers and rulings
archon workflow runs --item-of <run-id> --json  # the item a run belongs to
```

`--throughput` adds effective output throughput per listed run and an aggregate grouped
by exact provider + requested model across **only the listed runs**. It prints the sample's
run count, including runs without measurements. Project scope, `--all`, `--status`, `--open`
and `--limit` still select the page (default 20); increase `--limit` to expand the sample.
This is not an install-wide total. In JSON, each run gains `throughput` with attempt rows
and a summary; the top-level `throughput` contains `runIds`, `runCount` and `models`.
`--json --verbose` keeps its node/attention fields and reuses the event read. Throughput
reads events in batches of up to 20 runs; without the flag, listing costs are unchanged.
Unreadable history or invalid typed execution metadata fails the opted-in request rather
than returning a partial report.

`--item <key>` reads one [item](#items) in the current project and ignores the other filters. Under its name it prints the merge recorded on it, if any, and the branch it lands on with where that came from (`Lands on: feat/order (own)`, or `(part_of WO-12)` when it is the branch of an item it is part of). Then it prints these sections: the item's runs (id, workflow, status, authored outcome, start and end, and for a start waiting behind another run of its workflow on the item, that run), oldest first; its starts still waiting to start, in queue order, each with its full request id (what `trigger inspect` and `trigger withdraw` take), workflow, resource, and what it waits behind: how many queued starts of that resource and host are ahead of it, or, with none ahead, a free slot on the resource; the host that drains it; when it queued; the run of its workflow on the item it waits behind, when one holds it; and what will admit it: the next run end or [`workflow wake`](#workflow-wake) pass on this install, with `trigger drain --host` to try it now (a drain admits it only once its slot, checkout and item are free), or, for a host no trigger file on this install names, the wake watcher's next pass for a start from an observed label while the label is on the item, and otherwise that host's own drain. Trigger starts not yet prepared are listed first by receipt, waiting for the install hold or for their host's drain the same way; its refused starts when there are any (starts its binding's `overlap: skip` refused, with the run each was refused for); the item's start limits when a binding counted any, each with its starts used of those allowed, what was granted, since when it counts and how many are left; its [links](#workflow-link), active ones first, each with its id, its kind and an arrow for its direction (`this item depends_on → issue-3` for a link from this item, `← issue-9 duplicate_of this item` for a link to it), and ended ones after them, marked with who ended them and when; then, oldest first, the questions open in those runs or their sub-runs and the asks open on the item, and the answers recorded in them (attention answers and gate decisions, with the run, node, time and surface) together with the item's [rulings](#workflow-rule) (text, time, surface, who when they said, and when it was withdrawn). A sub-run is not listed as a run; its question or answer names its own run id, and `workflow get` on the parent shows it. The read reports recorded facts only; it computes no stage for the item. A start's count ahead is queue order, not a promise: a start whose checkout or item is held is passed over. It needs a registered project.

While the [install hold](#hold) is set, the waiting section says so and lists first the item's trigger starts that the hold keeps before they are prepared, each with its receipt, binding, workflow and when it was received. While the install's [run limit](/reference/configuration/#run-limit) is full, the waiting section says so with how many run trees count against it. A queued start that only the limit holds now (the next drain of its host would admit it on its resource) says `waits for the run limit` with the count in place of its place in the queue.

`--json` prints `{ item, runs, queued, skipped, hold, held, runLimit, startLimits, waits, questions, answers, links, merged, landing, degraded }`: `hold` is the install hold (`{ setBy, setAt }`) or null, and `held` lists the item's trigger starts not yet prepared as `{ receiptId, bindingId, hostId, workflow, receivedAt }`: kept by the hold while it is set, otherwise waiting for their host's next drain; `runLimit` is the [run limit](/reference/configuration/#run-limit) with how many run trees count against it now, `{ limit, live }`, full when `live` reaches `limit`, or null when none is set; `startLimits` lists each [start limit](/guides/workflow-triggers/#limit-how-often-a-stage-starts-on-an-item) a binding counted on the item, `{ name, starts, resetOn, since, granted, used, left }`: `since` is when its `resetOn` workflow last completed on the item, or null, and at `left: 0` the binding's next start on the item is refused; `item` is `{ id, projectKey, key }`; each run is `{ id, workflow, status, outcome, startedAt, completedAt, cause, awaitingExecution, startLimit, heldBehind, operatorPause, spend }`, where `startLimit` names the start limit its start counted under, or is null, where `awaitingExecution` is null unless the run's start is admitted and no executor has claimed it, and then `{ requestId, hostId, state, executor }`: `state` is `starting` when its executor answers as the run's owner, `unowned` when nothing can be running it (its hand-off started nothing, or the process it was handed to is gone from this host; run it once with `archon trigger execute <requestId> --host <hostId>`), or `unknown` when this process cannot tell, and `executor` is the process the start was recorded as handed to, `{ host, pid, uid }`, or null; `spend` is `{ usd, inputTokens, outputTokens }` as recorded on the run, each null when the run recorded none, and `operatorPause` is null, or `{ state, requested, pausedAt }` for a [pause](#workflow-pause): `state` is `requested` while the run finishes its running nodes and `paused` once it stopped, `requested` is `{ at, via, by, fromRun }`; each queued start is `{ requestId, workflow, resource, hostId, queuedAt, ahead, heldBehind, waitsForRunLimit }`, where `ahead` is read when the item is read, `workflow` is null when the stored launch does not read, and `waitsForRunLimit` is true when only the run limit holds the start now; each skipped start is `{ requestId, workflow, resource, heldBehind }`. `heldBehind` is null, or the run of the same workflow on the item that the start waits behind, was skipped for, or was refused for (a cancelled `--no-wait` start keeps it after that run ends): `{ runId, workflow, status, owner }`, where `owner` is what this process observes about that run's execution owner while it is running (`reachable`, `unreachable` when it is gone and only `workflow resume` or `workflow abandon` moves it, or `unknown`), and null otherwise. A queued start with a null `heldBehind` waits for capacity or its checkout; each question is the attention queue item `workflow attention --json` lists; each answer has `kind` `attention` (with `answer`, `by`, `fromRun`) or `gate` (with `decision`, and `text` for its comment or rejection reason), and `runId`, `node`, `occurrence`, `at`, `via`, null where the row does not record them; or `kind` `ruling`, with `id`, `text`, `at`, `via`, `by`, `fromRun` and `withdrawn` (null, or `{ at, via, by, fromRun }`), and no run. Each link is `{ id, kind, direction, other, at, via, by, fromRun, ended }` in recording order: `direction` is `outgoing` when this item is the one that depends on, is part of, or is a duplicate of `other`, and `incoming` when `other` points at this item; `other` is `{ id, projectKey, key }`; `ended` is null while the link is active, or `{ at, via, by, fromRun }`. An [ask](/reference/workflow-language/#asks-decisions-a-run-leaves-on-its-item) a completed run left reads as `kind` `ask`, with its `ref`, the `question` it asked, `answer` (null for a withdrawal), `chosen` (the chosen option's `id` and what it `does`, or null), `withdrawn`, `by` and `fromRun`, and `runId` naming the run that left it; `kind` `asks_settled` records that the last open ask of that run's set closed, with `answered` and `withdrawn` counts, at the time of that close; a set with an ask row that could not be read does not settle, and `degraded` names its run. Both are read from the item's asks, so they stay after the run that left them is deleted. Open asks on the item are among its questions. `merged` is the merge [recorded on the item](#workflow-merged), `{ change, commit, at, recordedAt, via, fromRun }`, or null. `landing` is the branch a fresh run on the item is cut from and proposes against, `{ branch, from }`, where `from` is `{ kind: "own" }` for the item's own [landing branch](#workflow-landing) or `{ kind: "part_of", item }` for that of the nearest item it is part of; null when neither records one. The read does not check that the branch is on the remote; a run does when it starts. `degraded` names each part that could not be read: a run in the item's tree, one of its own runs or a paused child (`reason: "run_unreadable"`, `runId`), a ruling (`reason: "ruling_unreadable"`, `rulingId`), a link (`reason: "link_unreadable"`, `linkId`), the merge (`reason: "merge_unreadable"`, `itemId`), or where the item lands (`reason: "landing_unresolved"`, `message`: a landing or link row on the way could not be read, or two items it is part of at the same distance land on different branches; a run on the item is refused for the same reason); the rest of the item still reads. An item named with no run yet reads with empty sections but for its queued and skipped starts, rulings and links; a key nothing has named exits 1, and with `--json` prints `{ "ok": false, "error": "not_found", "item": "<key>" }`.

`--item-of <run-id>` reads the item a run belongs to, the item of its top-level run when it is a `workflow:` sub-run, in whichever project the run is, from any directory. It prints the same read as `--item`. A run on no item, or one the store does not know, exits 1, and with `--json` prints `{ "ok": false, "error": "not_found", "run": "<run-id>" }`. It is the host command behind the `archon:script` [`item()`](/reference/workflow-language/#reading-the-item-a-run-belongs-to) export.

With the SQL store, the recent-run list rejects the entire result if a returned row or a
status-count group contains an unsupported persisted status; it never returns a partial
list or silently drops that row. Counts cover the project scope before `--status` and
`--limit`, so narrowing either option cannot bypass a bad row in that scope. The command
fails with the offending run ID and exact stored value; `--json` returns `{ok:false,error}`
with exit code 1. The error is also logged. `--open` uses a separate failed-run query rather
than these counts.

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

Without `--throughput`, the node events for every listed run are read in one query.
With `--throughput`, events are read in batches of 20 runs as described above, and the
same reads supply the verbose node summaries.

The listing shows short 8-character run ids. `workflow run --adopt` and `--supersedes` also resolve unique prefixes within the launch project and reject ambiguous prefixes. Full IDs select the exact run; adoption still requires the same project, and `--chat-project-id` restricts both flags to the selected project. Every `<run-id>` command below (`get`, `artifacts`, `logs`, `wait`, `pause`, `resume`, `cancel`, `abandon`, `approve`, `reject`) accepts these short ids when run from the project directory: a unique prefix resolves to the full id, an ambiguous prefix errors, and full ids keep working from any git repository or registered project folder. Short ids from `--all` rows belonging to *other* projects cannot be resolved; use the full id from `--json` for those.

### `workflow get`

Show detail for a single run by ID, regardless of status (unlike `status`, which is active-only). Use it to inspect both how execution progressed and, when declared, the workflow author's verdict. Exits non-zero when the run is not found.

```bash
archon workflow get <run-id>
archon workflow get <run-id> --json
archon workflow get <run-id> --verbose   # add the per-node summary and loop rounds
archon workflow get <run-id> --json --verbose
archon workflow get <run-id> --throughput
archon workflow get <run-id> --throughput --json
```

The text view includes the same [recorded usage summary](#workflow-run-name-message)
for any run status. It reads stored totals without recalculating them or certifying
completeness. `--json` retains the raw usage values in `metadata`, including nulls or
malformed historical values; it adds no formatted usage text.

`--throughput` adds **effective output throughput**, not model decode speed, beside the
usage summary: output tokens divided by execution duration in seconds (`tok/s`). Each
terminal agent attempt has its own row identified by node path, invocation, loop iteration
path and attempt ID. Failed attempts count too. Run and model totals divide summed output
tokens by the summed durations of those same eligible attempts, rather than averaging
rates. Tool work and thinking within an attempt are included; durable waits, approval
pauses and wrapper durations are excluded. Concurrent attempts each contribute their own
duration, so this measures model work rather than scheduler throughput. Only attempts
physically recorded on the run count; child runs are separate rows in `workflow runs`.
Running and paused runs show terminal agent attempts and exclusions for terminal or
suspended loop attempts recorded so far, without estimating unfinished work.

Only provider-reported output tokens with a positive usable duration enter the calculation.
`N nodes without token data` counts excluded attempts, including recognizable historical
agent rows without explicit token-source provenance. Missing or invalid durations have a
separate exclusion count; missing tokens take precedence so the counts do not overlap.
Unavailable rates display `unavailable` (JSON `null`); provider-reported zero is `0 tok/s`.
All own terminal and suspended `loop:` attempts are excluded and counted as
`N loop nodes not measured` on run and model summaries (`loopNodesNotMeasured` in JSON). Their persisted durations can
include approval pauses, and the records do not distinguish safe durations. This exclusion
takes precedence over missing tokens or duration. A suspended attempt that later completes
or fails counts once; feedback that starts a new attempt counts separately. Historical
aggregate restatements do not count as attempts. Historical rows that cannot be identified as agent or loop executions
are outside the sample.
Historical rows retain their recorded provider and requested model (`model_usage.requested`,
then `model`); resolved-only model names are not substituted. Typed execution bindings
remain authoritative. Missing provider/model binding components remain distinct
`not recorded` groups. These rates inherit the stored counts and their limitations, including Codex's resumed-turn
first-snapshot accounting edge case; they do not repair old capture errors or establish
benchmark decode performance.

JSON adds a top-level `throughput` report with `nodes` and `summary`, retaining unrounded
rates, eligible `outputTokens`/`durationMs`, `measuredExecutions`, `nodesWithoutTokenData`,
`nodesWithoutDuration` and `loopNodesNotMeasured`. It combines with `--verbose` and
`--events` without replacing the existing `nodes`, `events` or metadata usage fields. No new persistence is written.

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
- **Authored outcome** is the outcome a completed run declared through `returns.outcome`:
  `succeeded` or `failed` for a boolean, the value for a named outcome. Only the write that
  completes the run records it, so a run that has not completed shows none. Human output labels
  it separately when present. JSON carries it as the nullable `completed_outcome` field beside
  `status`, and the boolean form also as the older nullable `outcome` field.
- **Reason** is why a run that ended needs a look, in up to two short lines: for a failed
  outcome, what the `returns:` node said (its first lines, or its text fields as `key: text`);
  for a failed run, the first line of its first failed node's error, falling back to the
  run's own error when no failed-node error is available, including launch failures. A failed
  node's recorded kind leads its line, as in `(schema_unmet) the answer was rejected`. `workflow get` prints
  it as `Reason:` under the status and carries it as `reason` in `--json`; both are omitted
  when the record holds no reason text. The full value stays in `terminal_record`.

The axes may disagree without either being rewritten: `completed` with authored outcome `failed`
means execution finished normally but the workflow judged the work unsuccessful. A null outcome
means the workflow did not declare one, the run has not completed, or the run predates the field.
What the `returns:` node said before a later failure or pause stays in its `node_completed` event. In that case human output keeps its status-only
presentation. Except on an [execution handoff](#workflow-run-name-message), foreground
`workflow run` uses the same labels when an outcome exists, and its exit code follows execution
success or failure. A handoff reports only the observed status and has the exit meaning described above.

Verbose JSON node summaries include `execution` for newly recorded work. It identifies the
invocation, attempt, provider, requested model and any model the provider reported. Inner retries
share an invocation; each retry has its own attempt. A new loop-group iteration creates new body
invocations. Resuming unfinished work keeps its invocation identity.

`nodes` holds each loop body node once, with its latest round. For a run that entered a
`loop_group`, `--verbose` also prints a `Rounds:` block, and `--json --verbose` adds
`loop_rounds`: one entry per round, in order, each with its `loop_group_path` (frames
outermost first, iterations from 1) and the body nodes it reached, with `state`, `error`, `failure_kind` (a failed node's recorded kind),
`started_at` (the invocation's first attempt), `duration_ms` (every attempt's recorded duration summed,
so a retry counts, the wait between attempts does not; absent until the last attempt ends),
`output` (bounded as stored, with `output_truncated`): a completed node's output, or the
stdout a failed `bash:` or `script:` node recorded, and a completed node's `structured_output`. A round still running lists the node it is in;
nodes it has not reached are absent. A nested loop's rounds are separate entries whose path
extends the outer round's. The field is absent for a run that ran no loop, and under `--events`.
The API's `GET /api/workflows/runs/{runId}` serves the same rounds as `run.loop_rounds`.

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
accepted by `workflow resume <run-id>`.
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

A completed run's record has `result_commit`: `{ "held": true, "commit": "<sha>" }` when
the checkout was clean at that commit when the run's `returns:` node completed and when the
run completed, the commit its result holds at, or `{ "held": false, "reason": ... }` with
`dirty`, `not_git`, `unavailable`, `unborn`, `moved` (HEAD moved after the `returns:`
node completed, even to another commit and back, or a `mutates_checkout: false` run ended on
a commit other than its start or saw HEAD move since its first pass began), `concurrent`
(another node of its layer ran, or could still start, beside the `returns:` node) or
`unobserved` (no `returns:` node completed in the pass that completed the run, HEAD or its
branch keeps no reflog to show it did not move, or a `mutates_checkout: false` run has no git commit or
mark recorded for its start, as on a resume after an earlier pass completed a node). Runs
completed before it was recorded have none and hold at no commit. See [the result that holds
at this run's commit](/reference/workflow-language/#the-result-that-holds-at-this-runs-commit).

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
own `$ARTIFACTS_DIR/.archon/` child: the typed-artifact and node-outcome listings and
node-output spills the engine writes for itself, which on a long run outnumber the reports.
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
A failed node includes `failureKind`, the recorded kind a `retry.on_error` policy targets
(such as `schema_unmet`), and the text views print it before the error as
`Error:  (schema_unmet) ...`.
Completed nodes with recorded output include `output` (the full persisted text),
`outputTruncated` (whether persistence truncated it), and `outputPreview` (the first
200 characters followed by ASCII `...` when longer). These fields also apply to
replayed prior successes and to `workflow runs --json --verbose`. Empty output is
`output: ""`; nodes without recorded output omit these fields. `outputTruncated: true`
means the persisted text is incomplete, even though `output` returns all of that text.
Successful bash and script output stays bounded to 32 KiB in persistence; this view
does not load spill files. Human output keeps the short preview. Failed nodes include
`error` (or `Unknown error` when none was recorded). Failed `bash:` and `script:` nodes
also include `exitCode` (the numeric process exit code, absent for spawn failures,
timeouts, and cancellations) and, when the subprocess wrote to stdout before failing,
`output`, `outputTruncated`, and `outputPreview`. Unlike a completed node, a failed
node keeps only the last 2,000 characters of stdout, exactly as written, and
`outputTruncated: true` means earlier text was dropped. A node a resume reset for re-running (`always_run`, or a stale cached success)
reads `pending` until its new attempt starts, matching `terminal_record.nodes`.
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
message, the paused node id, the `form`, the `options` an answer may choose from (with
each option's `does` when the wait declares it), and the `recommendation` when there is one.
Answer it with [`workflow answer`](#workflow-answer); use `archon workflow abandon
<run-id>` if the run should not continue.

An overdue tool returns `result: "attention"` with `attention.kind: "stalled_tool_calls"`, `status: "running"`, the affected `runId`, and `calls` naming nodes, providers, tools, sanitized titles, timestamps, `elapsedMs`, and `stalledForMs`. Exit `0` means attention was found; it does not mean the run completed. Inspect with `workflow logs`, request recovery with [`workflow end-turn`](#workflow-end-turn), or explicitly cancel if appropriate. This advisory grants no approve or resume action. Reattaching returns it immediately while active. When a parent waits on a child, the advisory names the child's run id.

```bash
archon workflow wait <run-id>
archon workflow wait <run-id> --json
archon workflow wait <run-id> --json --timeout 900
```

There is no default timeout. Pass `--timeout <seconds>` when the host needs an upper bound.

`archon workflow wait --item <key>` waits on an [item](#items) instead of one run. It
watches every run on the item that has not ended at call time, plus every run that starts
on the item while it waits, and returns when the first of them reports something, as
`workflow wait <run-id>` would for that run. Runs that had already ended are history and
do not end the wait, unless one is resumed in place while waiting; it is then watched
too, and reported even when it has already ended again by the time the wait looks. Each result names its run: one line per run, or
under `--json` one `{ "ok", "action": "wait", "item", "results": [...] }` document whose
`results` hold exactly what `workflow wait <run-id> --json` prints for each run, and whose
`ok` is false when the exit status is `1`. Runs that reported together are all listed. An
item with no live run is refused rather than waited on (`reason: "no_run"`, exit `1`,
listing the item's runs). Exit codes are as above: `0` when a run reported, `3` when the
timeout passed with every watched run still live.

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
  choose (none for `message`, `approve` and `reject` for `approval`), each with its `does`
  text and `value` when the wait declares them; `recommendation` is the option the wait
  recommends, when it declares one; and `occurrence`
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

List, count, stream or read the [attention queue](/getting-started/operate/): readable paused
runs that need an answer or inspection, plus observable provider usage- and rate-limit waits.
Batch reads report unreadable stored rows and affected paused parents through `degraded` warnings, described below.
Branch on `kind`: `attention` and `awaiting_response` accept answers, `usage_limit`
continues automatically after reset, and `unreadable` needs inspection. `stopped` is an
item whose last run ended in an outcome nothing starts from and left no ask; it takes no
answer, and a new run on the item closes it ([kinds](/getting-started/operate/)). Read-only.

```bash
archon workflow attention --json                                   # this project
archon workflow attention --json --all                             # the whole install
archon workflow attention --json --project acme/web --label ci=other
archon workflow attention --json --sort label:urgency
archon workflow attention --json --all --count-by label:class
archon workflow attention --json --count-by label:class --since 30d
archon workflow attention --json --count-by answerer --since 30d
archon workflow attention <run-id> --json                          # one item
archon workflow attention ask:<id> --json                          # one ask a completed run left
archon workflow attention --watch --json --all                     # what needs someone, as it happens
archon workflow attention --watch --json --label stage=merge       # one queue's questions
archon workflow attention --watch --notices --json                 # also runs that ended or resumed, and notices
archon workflow attention --notices --since 24h --json             # the notices runs emitted in a window
archon workflow attention --notices --since 24h --count-by label:kind
archon workflow attention --watch --protocol --json                # the full sync protocol, for programs
archon workflow attention --watch --protocol --json --after <cursor>  # resume it
```

The default scope is the current project, resolved from the working directory as [`state`](#state) resolves it. `--all` covers the install. `--project` takes a codebase id, a codebase name, or a project key such as `@cwd/scratch-<digest>`; copy the exact key from `items[].project.key` in `archon workflow attention --all --json`. A run is in scope when its codebase id matches, when both sides have one, and otherwise when its project key matches, so a run paused before its codebase was renamed is still listed under the new name. Under [`--chat-project-id`](#global-options), list, count and watch use the selected project whatever the working directory; `--all` and a `--project` naming another project are rejected.

`--label k=v` filters must all match. `--sort label:<key>` compares the label's value as a plain string and puts items without it last. `--count-by` replaces the list with counts.

`--count-by` counts the items open now. Add `--since` to count the attention waits opened in a window instead, whether each has been answered or is still open, so a class of question that recurs stays visible after its runs continue. `--since` takes a duration in minutes, hours, days or weeks back from now (`40m`, `24h`, `7d`, `2w`) or an ISO date or time. Scope and `--label` filters apply as they do to the open count. This count reads each wait's `wait_started` event, so it uses the labels the wait opened with and ignores later [`attention label`](#workflow-attention-label) writes. A wait opened by an Archon version that did not record labels on that event counts under no label (`value: null`, shown as `(no '<key>' label)`). Gates, usage-limit waits and waits of deleted runs are not counted. `--since` needs `--count-by`.

Each group of a `--since` count also carries `recommendations: { asked, answered, followed }`: the waits that opened with a recommendation, those of them that were answered, and those answers that chose the recommended option. Text output prints them after the group when any wait carried one. `--count-by answerer`, which needs `--since`, groups the waits by who answered: each entry has `answeredBy`, which is `{ declared }` for a name given with [`--as`](#workflow-answer), `{ userId }` for an answer through a chat platform, and null for waits still open and answers that named nobody. The count groups on `answeredBy` alone: the run an answer was given from (`fromRun`) forms no group, so an answer from inside a run without `--as` counts under null. These numbers come from the `wait_started` and `wait_answered` events alone. `wait_started` records the wait's `occurrence`, `form`, the `options` ids offered, `other` when the reserved option is offered, and the recommendation's `option` and `confidence`; it never records the message, an option's label or the recommendation's reason. A wait opened by an Archon version that did not record them counts as carrying no recommendation.

`--json` prints `{ ok, action: "attention", scope, items }`, or `counts` in place of
`items` with `--count-by`. With a run id it prints `{ ok, action, runId, item }`, where
`item` is null when there is no queue item; a parent blocked on sub-runs resolves to the
item of the child that holds the pause, or to its own `unreadable` item for a missing
child, a revisited run, or a tree exceeding 500 runs. A descendant with unreadable stored
origin data can instead make a single read fail. Batch lists omit a parent blocked on an
unreadable paused descendant and report that child through `degraded`; if the descendant
is not paused, they report the affected paused parent instead. An absent parent does not
mean its block has cleared. An unknown run id prints `error: "not_found"` and
exits `1`. With an ask's ref (`ask:<id>`) it prints `{ ok, action, ref, item }`: the open
ask, or null once it was answered, withdrawn or replaced; an unknown ref prints
`error: "not_found"` and exits `1`. The item shape is described in the [Operate page](/getting-started/operate/#queue-items).

Batch list and count reads add an optional `degraded` array when a paused row or a descendant
needed to project its attention item cannot be read. Each entry has the shape
`{ "type": "degraded", "reason": "run_unreadable", "runId": "<id>" }`.
`runId` identifies the unreadable paused row, or an affected readable paused parent when
its unreadable descendant is not paused. It is present only for install-wide reads;
the unreadable row's project membership cannot be established.
Warnings survive label and project filters. Readable items remain available, counts cover only
readable matches, and mixed reads still exit `0`. Text output prints a repair advisory per warning.
Healthy JSON omits `degraded`. Operator logs retain safe run IDs without stored origin contents;
use the logged unreadable run ID to locate the data to repair, since a warning may name its
readable parent instead. Read again after repair.

**`--watch`** streams the queue instead of reading it once, and writes a line only when
someone has to act: `attention` for an item that takes an answer or a look (the open
items first, each with its message, options and recommendation), `resolved` or
`unmatched` when an item it wrote closes or leaves the `--label` filter, `terminal` for a
run that failed or that completed with `outcome: "failed"`, `owner_lost`, `degraded` when
a run could not be read, and `error`. It writes nothing for a run that completed with any
other outcome, was cancelled or resumed, and it has no
heartbeat, so a silent stream does not prove it is reading. Every JSON line carries
`needs`: `answer`, `look` or `nothing`. The watch writes the first two, and the close of an
item it wrote, which needs `nothing`
([what each means](/getting-started/operate/#stream-the-queue)). Combine it with `--label k=v`
to watch one queue or class of question. With `--json` each line is one compact JSON
object. Without it each line is text a reader can act on: an ask is a short block with its
labels, the question's first line, the recommendation and its reason, each option with what
it does, and the commands that answer that occurrence, including the `--recommended` form
when a recommendation exists; a failed run, a lost owner and an unreadable item name the run and the reason a failed outcome gave, and the
command that shows more; a lost owner also names the item the run holds, if any (`item` on the JSON line), and gives `resume` beside `abandon`; the close of an ask is one line. The list prints the same blocks,
and `workflow attention <run-id>` prints the whole message. An open ask a completed run left
is headed by its ref, `open ask`, its project and item key, and when it opened, and prints
its whole question and context in every form, since its run is no longer paused. Read the watch unfiltered: a
filter in the pipe can hold lines until the watch ends. Scope and `--label` work as for the list;
`--sort`, `--count-by` and a run id are refused. See
[Stream the queue](/getting-started/operate/#stream-the-queue).

**`--notices`**, with `--watch`, also writes the `needs: "nothing"` lines that say what
happened to work: a run that completed, was cancelled or resumed, a usage-limit wait
opening or closing, and each [`workflow notice`](#workflow-notice) a run emits. It leaves
out `ready` and `bookmark`. It cannot be combined with `--protocol`.

**`--notices --since <40m|24h|7d|2w|ISO>`**, without `--watch`, lists the notices runs emitted
in the window, oldest first, one line each: time, text, labels. Scope and
`--label` apply as for the list. `--count-by project|label:<key>` counts them instead.
`--json` prints `{ ok, action: "attention", scope, since, notices }`. A run id, `--sort`
and `--count-by answerer` are refused.

**`--protocol`**, with `--watch`, writes the full sync protocol, for a program that keeps its
own copy of the open set: one `attention` line per open
item in scope and an identifier-free `degraded` warning for each batch report of an affected
paused run (an unreadable row or a readable parent whose descendant cannot be read),
then `ready`, then follows changes any process commits, as
`attention`, `resolved`, `unmatched`, `terminal`, `resumed`, `owner_lost` and idle `bookmark` lines.
Every run line carries the run's `workflow` and `parentRunId`, so a consumer can keep
top-level runs or one parent's children. A failed `terminal` line carries `cause` with the
failed node and its recorded error class when available; `cause` is null for failures
outside a node, including launch failures, and for runs without terminal records. A recorded
`launch_failed` event carries `reason: ["launch failed before the first node"]` and the
run ID, without error text. Read the full error with `archon workflow get <run-id>` or
`archon trigger inspect <receipt-or-request-id>`
([fields](/getting-started/operate/#the-full-protocol-for-programs)).
Repeated run-projection failures send an identifier-free `degraded` line with
`reason: "run_unreadable"` and the last handled `cursor`, without exiting. Independent
readable deliveries can continue while unreadable deliveries are omitted. An open ask whose row turns unreadable stays open, with one `degraded` line, rather than reading as `resolved`. Store-wide
projection outages retain the cursor and retry. Check the operator log and reconnect
after repair to refresh the open set; replay from before the gap for historical transitions.
Later bookmarks do not establish repaired coverage.
With `--json` each line is one compact JSON object; without it, a short sentence per
change. Scope and `--label` work as for the list; `--sort`, `--count-by` and a run id are
refused. **`--after <cursor>`**, valid only with `--protocol`, takes the `cursor` of an earlier line and, after the
snapshot, replays readable feed events strictly after it. Multiple lines can share an
event cursor; resuming after it excludes all of them. For a partially handled event,
replay from an earlier checkpoint as described in the guide. A `degraded` warning means replay may have
gaps; use the repair and replay steps above. The line shapes and the consumer contract are in
the [Operate page](/getting-started/operate/#the-full-protocol-for-programs). Exit codes: `0` when a signal or a
closed stdout stops the stream (a closed stdout is noticed at the next line), `1` when it
cannot start or an output write fails for another reason, `4` when the store cannot read the stream's cursor, an `--after` cursor this
install did not issue or the stream's own position (with `--json`, the last line is
`{"type":"error","error":"cursor_invalid","needs":"look"}`; rerun without `--after`).

HTTP: `GET /api/runs/attention` takes `project`, `all`, `label` (repeated), `sort` and
`countBy` (`project` or `label:<key>`; it counts open items, so not `answerer`), and returns `items` beside the console's `runs`, or `{ counts }`. A server has
no working directory, so without `project` it covers the whole install.
`GET /api/runs/<run-id>/attention` reads one item.

### `workflow notice`

Say what a run did, from inside one of its nodes, for whoever watches attention with
`--notices`. The run does not pause and nobody can answer. See
[Notices](/getting-started/operate/#notices-what-the-work-did).

```bash
archon workflow notice "Merged pull request 7 into dev" --label kind=merged --label pr=7
```

| Flag | Effect |
| --- | --- |
| `--label <k=v>` | A label readers filter and count by; repeatable, at most 16, each value at most 200 characters |
| `--json` | Print `{ ok, action: "notice", runId, count, limit }`, or `{ ok: false, error }` with `reason` when the engine refused the notice itself |

The text is one line of at most 300 characters with no control characters, which labels
may not contain either, and a run may emit 50 notices. The command
exits 1 without recording anything when the text or labels are outside those bounds
(`reason: "invalid"`), when the run has reached its limit (`run_limit`), when the run is
not running (`run_not_running`), and, with no `reason`, when a label is not `key=value` or
it is not called from a workflow node: it reads
`WORKFLOW_ID` and `ARCHON_NODE_EXECUTION` from the node's environment, and the two must
name the same run. Put the text after `--` when it may start with a dash.

### `workflow rule`

Record a ruling on an item of the current project: a decision made about the item without
a question having been asked, such as "leave the chat readers for a follow-up". Every later
read of the item shows it with the answers, and a run on the item can read it through
[`item()`](/reference/workflow-language/#reading-the-item-a-run-belongs-to). The engine
stores the text and never reads it.

```bash
archon workflow rule --item issue-42 --as triage-agent -- "Leave the chat readers for a follow-up"
archon workflow rule --withdraw <ruling-id>
```

| Flag | Effect |
| --- | --- |
| `--item <key>` | The item the ruling is on, in the project the working directory belongs to, as [`runs --item`](#workflow-runs) finds it. A key nothing has named yet is written as a new item, as a start would write it |
| `--withdraw <ruling-id>` | Withdraw a ruling instead. The ruling stays in the item read with `withdrawn` set; a ruling is withdrawn once. Under [`--chat-project-id`](#global-options) the ruling must be on an item of the selected project; without it the id alone names the ruling, in any project |
| `--as <name>` | The name you declare for yourself, recorded as a claim nothing checks |
| `--json` | Print the ruling as the item read lists it, or `{ ok: false, error }` |

The text goes after `--`, and must not be blank. Called from inside a workflow node, the
ruling records the node's run and node as `fromRun`, read from the node's environment. The
command prints the ruling's id. It exits 1 for blank text, for a directory with no
registered project, for a ruling id that names no ruling (`error: "not_found"`), for one
already withdrawn (`error: "already_withdrawn"`), and under `--chat-project-id` for one on
another project's item (`error: "outside_project"`), which stays as it was. Rulings need the database store.
`POST /api/items/rulings` and `POST /api/items/rulings/{rulingId}/withdraw` do the same over
HTTP; see the [API reference](/reference/api/).

### `workflow link`

Record a link from one item of the current project to another, or end one. A link is a
directed relation the engine stores and reports; it ranks, holds or starts nothing because
of a link by itself. A trigger file can start a stage on an item when the items linked to it
end a workflow; see [start a stage on an item when the items
it links to end](/guides/workflow-triggers/#start-a-stage-on-an-item-when-the-items-it-links-to-end).
An active `part_of` gives an item that records no [landing branch](#workflow-landing) the
branch of the item it is part of. Both items' reads show it
([`runs --item`](#workflow-runs)), and a run on either item can read it through
[`item()`](/reference/workflow-language/#reading-the-item-a-run-belongs-to).

```bash
archon workflow link --item issue-42 --kind depends_on --to issue-17
archon workflow link --item issue-42 --kind part_of --to order-3 --as triage-agent
archon workflow link --end <link-id>
```

| Kind | Read from `--item` to `--to` |
| --- | --- |
| `depends_on` | `--item` waits for `--to` |
| `part_of` | `--item` is a piece of the whole `--to` |
| `duplicate_of` | `--item` goes away; `--to` stays |

| Flag | Effect |
| --- | --- |
| `--item <key>` | The item the link is from, in the project the working directory belongs to, as [`runs --item`](#workflow-runs) finds it |
| `--item-of <run-id>` | In place of `--item`: the item the run is on (its root run's, for a `workflow:` child), in that item's project whatever the working directory. With `--to` the link is from it; with `--from <key>` it is to it, from that item of the same project |
| `--kind <kind>` | `depends_on`, `part_of` or `duplicate_of` |
| `--to <key>` | The item the link points at, in the same project |
| `--end <link-id>` | End a link instead. The link stays in both items' reads with `ended` set; a link is ended once. Under [`--chat-project-id`](#global-options) the link must be from an item of the selected project; without it the id alone names the link, in any project |
| `--as <name>` | The name you declare for yourself, recorded as a claim nothing checks |
| `--json` | Print the link as `{ id, kind, from, to, at, via, by, fromRun, ended, created }`, or `{ ok: false, error }` |

A key nothing has named yet is written as a new item, as a start would write it. Recording a
link that is already active, with the same kind from the same item to the same item, leaves
the one link and prints `already recorded` (`created: false`); the opposite direction is a
different link. Once a link is ended, recording it again writes a new link. Called from
inside a workflow node, the link records the node's run and node as `fromRun`. The command
prints the link's id. It exits 1 for a kind outside the three (`error: "unknown_kind"`), for
a link from an item to itself (`error: "self_link"`), for a directory with no registered
project, for a link id that names no link (`error: "not_found"`), for one already ended
(`error: "already_ended"`), and under `--chat-project-id` for one from another project's
item (`error: "outside_project"`), which stays as it was. With `--item-of` it exits 1 for a
run on no item (`error: "no_item"`) before writing anything. Links need the database store.

### `workflow items`

Read the items of the current project that had a run in a window, a page at a time. Each
item is read whole, as [`runs --item`](#workflow-runs) reads it: all of its runs in start
order, not only those in the window, its open questions, its answers and rulings, its
merge and its `degraded` parts.

```bash
archon workflow items                       # the last 30 days
archon workflow items --since 7d --json
archon workflow items --after <cursor> --json
```

| Flag | Effect |
| --- | --- |
| `--since <40m\|7d\|24h\|2w\|ISO>` | Start of the window, as [`metrics`](#metrics-name) takes it; default 30 days before `--until` |
| `--until <ISO>` | End of the window, exclusive; default now |
| `--limit <n>` | Items a page, 1 to 100; default 20 |
| `--after <cursor>` | Read the page after the one that returned this cursor. It carries the project and the window, so it cannot be passed with `--since` or `--until` |
| `--json` | Print the page, or `{ ok: false, error }` |

An item is in the window when one of its own runs (not a `workflow:` sub-run) started in
`[since, until)`. Items are ordered by their id. The order carries no meaning; it is what a
cursor resumes from, so following each page's cursor returns every remaining item once,
over the window the first page fixed. The project is found as `runs --item` finds it.

`--json` prints `{ window: { since, until }, items, next }`, where each entry of `items` is
the document `runs --item --json` prints and `next` is the cursor of the following page, or
null on the last. It exits 1 for a directory with no registered project, a malformed window
or limit, and a cursor that is not one this read returned or is for another project. Items
need the database store. It is the host command behind the `archon:script`
[`items()`](/reference/workflow-language/#reading-a-projects-items-over-a-window) export, and
`GET /api/items/window` returns the same page over HTTP.

### `workflow merged`

Record that an item's change merged, as the forge reported it. The caller decides which
change belongs to which item, typically the step that merged the pull request or read it
back from the forge; the engine stores the fact and never reads the forge for it.

```bash
archon workflow merged --item issue-42 --change https://github.com/acme/web/pull/12 \
  --at 2026-11-02T10:00:00Z --commit <sha> --json
```

| Flag | Effect |
| --- | --- |
| `--item <key>` | The item whose change merged, in the project the working directory belongs to |
| `--item-of <run-id>` | In place of `--item`: the item the run is on (its root run's, for a `workflow:` child), in that item's project whatever the working directory |
| `--change <ref>` | The merged change as the forge names it, such as its pull request URL; 1 to 2048 characters, never parsed |
| `--at <ISO>` | When the forge says it merged, with an offset |
| `--commit <sha>` | The merge commit, a full lowercase hash, when the forge reported one |
| `--json` | Print `{ merge, recorded }`, or `{ ok: false, error }` |

The fact is recorded once. A second report keeps the first and prints it with
`recorded: false`, so a caller can see a different `change`. Called from inside a workflow
node, it records the node's run and node as `fromRun`. It exits 1 for a key no run or ruling
has named in the project (`error: "not_found"`: a merge never creates an item), a run on no
item under `--item-of` (`error: "no_item"`), a malformed flag, or a directory with no
registered project. Every later item read carries the fact as
`merged`. It needs the database store.

A run that merges through [`archon forge pr.merge`](/reference/forge/#workflow-host-integration-and-audit)
records the merge on its item by itself (`via: forge`) when the forge plugin reports the
merge time (`merged_at`), so a later `workflow merged` for that item keeps the forge's
record. So does one the forge refuses because the pull request is already merged, from the
facts of the earlier merge the refusal carries. An item that already has a merge keeps it;
for that same change it only gains the landing branch when it has none.
With a plugin that omits the merge time, nothing is recorded and the merge still succeeds.

### `workflow landing`

Record the branch an item's change lands on. Every fresh run on the item is then cut from
that branch and proposes against it (`$BASE_BRANCH`), as [`--base`](#base-branch-precedence)
makes one run do, and so is every fresh run on an item that is [`part_of`](#workflow-link)
it and records no branch of its own. A work order made of several items records its branch
once, links its members to it, and their changes land together on that branch.

```bash
# The project's remote is origin here; name your remote's tracking branch.
archon workflow landing --item WO-12 --branch feat/checkout-redesign --from origin/main
archon workflow link --item issue-42 --kind part_of --to WO-12
```

| Flag | Effect |
| --- | --- |
| `--item <key>` | The item, in the project the working directory belongs to. A key nothing has named yet writes the item |
| `--item-of <run-id>` | In place of `--item`: the item the run is on (its root run's, for a `workflow:` child), in that item's project whatever the working directory. A run on no item exits 1 with `error: "no_item"` |
| `--branch <name>` | The branch it lands on; must be a valid branch name |
| `--from <start-point>` | Create the branch on the project's remote from this start point before recording it (alias `--from-branch`) |
| `--json` | Print `{ branch, recordedAt, fromRun }`, with `create` added when `--from` is given, or `{ ok: false, error }` |

Recording again replaces the branch. A run already started keeps the base it recorded. A
run that merges through `archon forge pr.merge` records the merged pull request's base
branch as its item's landing by itself, together with the merge and under the same
conditions (the forge plugin reports `merged_at`, and the item has no merge yet or a merge
of that change), and only when the item has no landing yet, so later fresh runs on the
merged item stay on the branch it landed on. A landing already recorded, such as one set
with this command before the merge, is never replaced this way.

Without `--from`, the command only records, and does not check the remote, so a branch may
be recorded before it exists. With `--from`, it creates the branch on the remote first and
records it second. The item key and the calling node are checked before the push, so a
create that fails, or a record that would be refused, leaves the remote and the item as they
were. The remote is the one runs use: `worktree.remote`, else the automatically selected one.
A folder project, or a project with no remote, is refused. The start point resolves in the
project's repository after a fetch of that remote, as
[`workflow run --from`](#workflow-run-name-message) does: a commit, a local branch, or a
remote-tracking branch. Name `<remote>/main` for that remote's tip of `main`, such as
`origin/main`, or `upstream/main` when `worktree.remote` is `upstream`. Only that remote is
fetched, so another remote's tracking branch may be stale. There is no implicit default. A branch the remote already has is left where it is, never moved, and is
still recorded. `create` in the JSON output is `{ remote, status: "created", commit }` or
`{ remote, status: "exists" }`. Nothing else creates a landing branch: a start never does.

A run checks the branch when it starts: a branch the project's remote does not have refuses
the run before its first node, naming the branch, the remote, where the branch came from, and
the command that creates it (`archon workflow landing --cwd <checkout> --item <key> --branch
<name> --from <start-point>`, filled in with the project's checkout and the item that records
it, each value shell-quoted when it needs quoting). `--cwd` keeps the command on that project
when it is run from another directory, as after a `--project` start. It never falls back to
the base branch.

The branch a run takes is found in this order: `--base` on the dispatch; the item's own
branch; the branch of the item it is `part_of` through an active link, nearest first (a
member of a member of `WO-12` lands on `WO-12`'s branch when the member between records none).
Two items at the same distance with different branches refuse the run, naming both; record
the branch on the item itself to settle it. Then come the existing sources: a trigger
binding's `launch.isolation.baseOverride`, `worktree.baseBranch`, the codebase default and
the remote's HEAD. Called from inside a workflow node, it records the node's run and node as
`fromRun`. It exits 1 for an invalid branch name, a directory with no registered project, a
`--from` that names no commit, or a create the remote refused.
`workflow runs --item <key>` shows the branch and where it came from. It needs the database store;
with `store: files`, `--from` is refused before anything is pushed.

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
or `reject`. The `reject` decision follows [`workflow reject`](#workflow-reject), including cancellation of a legacy gate without authored decisions or `on_reject`. When the answer leaves a resumable run, human mode continues it as [`approve`](#workflow-approve) does, including when a continuation host claims it first.

`archon workflow respond <run-id> --recommended --occurrence <id> [--text <text>]` answers an
attention wait with the option it recommends, as
[`workflow answer --recommended`](#workflow-answer) does. `--occurrence` is required, so a
run that has moved to another pause refuses instead of accepting a recommendation the
answerer never read. `--recommended` takes the place of the decision: a positional
decision or text beside it is refused. It takes no `--detach`. `--as <name>` declares who is
answering, as on `answer`.

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
archon workflow answer <run-id> --occurrence <id> --recommended --as triage-agent    # accept the recommendation
```

`--choose` names a declared option id; repeat it for a `multi_select`, and omit it for a
`message`. `--text` is free text recorded with the answer. An undeclared option, the wrong
number of options, or an option on a `message` wait is refused and the run stays paused.
The next node reads the answer as `$<wait-id>.output`: `{ text }`, `{ decision, text }`, or
`{ decisions, text }`. In the `approval` form `reject` never cancels the run.

`--recommended` takes the place of `--choose` and chooses the option the wait's
recommendation names. It records the same answer as naming that option and passes the
same validation. It is refused, and the run stays paused, when the wait has no
recommendation, and when the wait's form is `message` or `multi_select`.

`--as <name>` records the name the answerer declares for itself, 1 to 64 characters on
one line. It is a claim: Archon does not check it and no permission depends on it. Use
it to tell an agent's answers from a person's. `approve`, `reject` and `respond` take it
too; it is recorded when they answer an attention wait. A gate's answer records the
surface only, so `--as` is refused at a gate and the run stays paused.

The answer records `answeredVia` and `answeredAt` on the run's `metadata.wait`, and
`answeredBy` when the answerer is known: `{ declared }` is the name `--as` claimed, and
`{ userId }` is the Archon user that Archon resolved a chat platform's sender to. A
`wait_answered` event carries the surface as `via`, the `occurrence`, the answer, and the
answerer as `by`. When the command runs inside a workflow node, the event also carries
`fromRun: { runId, nodePath }`, the run and node that answered. No flag sets it and `--as`
does not replace it: Archon reads it from the run identity it put in the node's
environment. A node process can change its own environment and Archon does not verify
the value, so it is attribution, not proof: do not let an approval or a permission rule
depend on it. Like `approve`,
human mode continues the run inline unless a continuation host claims it first, and `--json` records the answer and returns
`{ ok, runId, action: "answer", answer, workflowName, resumable }` without continuing
it; `archon serve` or [`workflow wake`](#workflow-wake) continues it. The HTTP equivalent
is `POST /api/workflows/runs/<run-id>/answer` with
`{ occurrence, choose?, recommended?, text?, as? }`, where `recommended: true` takes the
place of `choose`.

#### Answering by ref

`--ref <ref>` takes the place of `<run-id> --occurrence <id>`: it answers the item the
[attention queue](#workflow-attention) lists under that `ref`, through the same answer
operation the API and the chat tool use. It is the only way to answer an
[ask](/reference/workflow-language/#asks-decisions-a-run-leaves-on-its-item) a completed run
left, which has no paused run to name. For an item a paused run holds the ref works too, and
the run is not continued from here. `--withdraw <ref>` closes an ask unanswered, or, with a
`wait:<run-id>` ref, the [waits](/reference/workflow-language/#waits-what-an-item-waits-for-outside-archon)
that run left open, which then start nothing.

```bash
archon workflow answer --ref ask:<id> --choose keep --as planner --json   # answer an ask
archon workflow answer --ref ask:<id> --recommended --text "Agreed"       # accept its recommendation
archon workflow answer --ref ask:<id> --choose other --text "Split it"   # none of its options
archon workflow answer --withdraw ask:<id> --json                         # withdraw an ask
archon workflow answer --withdraw wait:<run-id>                           # withdraw overdue waits
```

An ask is a `select` question that also offers `other`, answered with text. `--recommended` is refused
on an ask that has no recommendation, and the ask stays open: choose one of its options. Who may answer or
withdraw it is the rule of the run that left it: its starter, or an admin; the operator always.
`--as` and `fromRun` are recorded as for any answer. The same answer to an answered ask, or a
second withdrawal, changes nothing; a different answer to an answered ask, withdrawing an
answered one, or either on an ask a newer run replaced, is refused. The write that closes the
last open ask of a run's set records `asks_settled` once, and writes the start of each
[asks-settled binding](/guides/workflow-triggers/#start-a-stage-again-when-its-asks-are-answered)
that settlement matches; the command then prepares it, as the end of a run prepares a run-ended
binding, and reports each start by where its preparation stands: prepared, waiting for its
host's next drain, or not started, with its receipt and how to start it by hand. A settlement
no binding matches, such as an answer choosing an option no binding names, says that nothing was
started. The answer is
recorded either way. A trigger file that cannot be read refuses the close that would settle the
set, naming the file. An answer recorded through the server (the Web UI, the API or chat) writes
the start the same way, but the server prepares only starts on the host its
`ARCHON_TRIGGER_HOST` names; a start on any other host waits for that host's next drain. See
[who prepares the start](/guides/workflow-triggers/#who-prepares-the-start).

`--json` prints `{ ok: true, ref, action, settled?, nothingStarted?, unchanged?, waiting?, notStarted?, startsUnread? }`:
`action` is `answer` or `withdraw`, `settled` is true when this write settled the set,
`nothingStarted: true` when it settled the set and no binding matched, so nothing was started
(the text says so too), `unchanged: true` when nothing changed, `waiting` lists `{ receiptId, bindingId, hostId, servedHere }` for
each start left for its host's drain, where `servedHere` is true when a trigger file on this install names the host, so this install's next run end or `workflow wake` pass drains it, and `notStarted` lists `{ receiptId, bindingId, reason }`
for each binding the settlement matched that could not start. When the starts were recorded
but could not be read back, `startsUnread` holds `{ receiptIds, error }` instead; the answer
still stands, and `archon trigger inspect <receipt>` shows each start. An answer to a run-held item prints `runId`, `cancelled` and `continues`
instead of `settled`. A refusal exits 1 and prints `{ ok: false, error, message }`, where
`error` is `unknown` (nothing the caller may answer has the ref), `closed`, `moved`,
`takes_no_answer` (an overdue wait is withdrawn, not answered), `already_answered`,
`already_replaced`, `already_met` (waits an event already met), `not_an_ask` (a
`--withdraw` of an item a paused run holds) or `error`. Withdrawing an ask or waits that are
already withdrawn is not a refusal: it exits 0 with `{ ok: true, action: "withdraw",
unchanged: true }`. The HTTP equivalents are
`POST /api/attention/answer` and `POST /api/attention/withdraw`.

`approve`, `reject` and `respond <option>` also answer an attention wait, as shorthand:
`approve [text]` answers a `message` wait with its text, and otherwise each verb chooses
the option of the same id.

### `workflow approve`

Approve a paused workflow run. At an attention wait this is the shorthand described under [`workflow answer`](#workflow-answer). At a deprecated `approval:` gate with authored `approval.decisions`, this command requires `approve` in that list; otherwise it is refused and the run stays paused. An optional comment is available as `$<gate-id>.output.text` for authored decisions, or `$LOOP_USER_INPUT` at a deprecated interactive-loop gate.

**Sub-run child gates:** when a `workflow:` sub-run pauses at its own gate, the parent run pauses "blocked on child". Approve (or reject) the **child** by its own full run id, available from `archon workflow get <parentRunId> --json` at `.metadata.approval.childRunId`, not the parent's. The stored block message contains only a short child label; a surface notice may include the full child command. The parent auto-resumes when the child completes. A child inside a `fan_out:` expansion pauses the same way: it stays paused as its own run, and the parent pauses on a `fan_out` gate listing every unfinished child, then continues once they finish. `approve`/`reject` against the parent's id while it's blocked on a child are refused with a redirect to the child id (every listed child for a fan-out).

**Deprecated interactive-loop gates, finalize or iterate:** when the gate paused on an iteration where any declared completion channel fired (`workflow get <run-id> --json` → `.metadata.approval.completionSignaled` is `true`), approving with **no comment** accepts the completion: the node finalizes from the already-computed output on resume, with no re-run. Approving **with** a comment runs another iteration using it as `$LOOP_USER_INPUT`. When no completion condition met, both forms run another iteration. On the final iteration (`max_iterations`), only a comment runs one more; approving with no comment fails the node with `max_iterations`, or completes it with the paused iteration's text output when the loop sets `on_exhausted: complete`.

```bash
archon workflow approve <run-id>
archon workflow approve <run-id> "Looks good, proceed"
archon workflow approve <run-id> --comment "Looks good, proceed"
archon workflow approve <run-id> --occurrence <occurrence> --json   # refused if the run moved on
archon workflow approve <run-id> --json   # record approval + ack; does NOT auto-resume inline
```

In human mode `approve` and a `reject` that leaves the run resumable attempt to resume it inline, unless a running `archon serve` or [`workflow wake`](#workflow-wake) on the same database claims it first. The command then returns with `Run <run-id> is already continuing in another process.` if that host is still running it, or `Run <run-id> has already continued in another process and is completed.` if it has finished. `respond` and `answer` behave the same way for resumable answers. Rejecting a legacy `approval:` gate without authored decisions or `on_reject` cancels the run instead. In `--json` mode they record the decision and return an ack **without** resuming. An answered gate is a due continuation, so a running `archon serve` or [`workflow wake`](#workflow-wake) continues it; `workflow resume <run-id>` continues it by hand. Container runs are the exception and need the manual resume.

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

Reject a paused run. At an attention wait this is the shorthand described under [`workflow answer`](#workflow-answer): the run continues with `decision: reject` and is not cancelled. At a deprecated `approval:` gate with authored `approval.decisions`, the list must contain `reject`; otherwise the command is refused with the allowed ids and the run stays paused. The optional reason is available as `$<gate-id>.output.text` for authored decisions, or as `$REJECTION_REASON` inside a legacy `on_reject` prompt. A legacy `approval:` gate without authored decisions or `on_reject` cancels the run immediately on rejection. With `on_reject`, rejection stages rework until the attempt limit is reached, when it cancels the run. When rejection leaves the run resumable, human mode attempts to continue it inline as [`approve`](#workflow-approve) does, unless a continuation host claims it first. With `--json`, the command records the rejection and returns without inline execution, whether it cancels the run or leaves it resumable.

```bash
archon workflow reject <run-id>
archon workflow reject <run-id> --reason "Needs more tests"
archon workflow reject <run-id> --json
```

A reject that cancels a managed container run reclaims its container once no executor can still run in it. If that reclamation fails, the run stays cancelled and the command prints a warning (`cleanupWarnings` with `--json`), as [`workflow cancel`](#workflow-cancel) does.

### `workflow pause`

Request a pause of a running run before its next node. The nodes running now finish and the run starts no node after them: it waits paused until you resume it, or completes when no node is left to start.

```bash
archon workflow pause <run-id>
archon workflow pause <run-id> --as ops   # record who asked
archon workflow pause <run-id> --json
```

The command records the request and returns at once. The process that executes the run honours it: before the next layer of the graph starts, or before the next node of a layer it runs one node at a time, it moves the run to `paused`. Until then the run reads `pause requested` in `workflow status`, `workflow get` and `workflow runs`. A pause never interrupts an agent mid-turn or a command mid-execution. A `loop`, `loop_group` or `workflow:` node counts as one node: the pause waits for the whole node to end. A request that arrives when no node is left to start lets the run complete.

A paused run keeps its checkout and worktree, the results of the nodes it finished, its resource slot and its hold on its item, so no other run of its workflow starts on that item meanwhile. It asks nothing, appears in no attention queue, and nothing continues it on its own, also after a restart. `workflow get` and the item read show who paused it, through which surface, and when.

End the pause with [`workflow resume`](#workflow-resume), which starts the next node with the earlier nodes' output, or with [`workflow abandon`](#workflow-abandon). `workflow cancel` refuses a paused run.

Pause refuses, and leaves the run unchanged, when:

- the run is not running: paused at a gate or a wait, already paused by an operator, pending, completed, failed or cancelled. The message says which;
- the run is a sub-run: it runs inside a node of its root run, so pause the root, which pauses when that node ends;
- no live owner answers for the run on this host: nothing would reach a node boundary. If its process is gone, `workflow resume` or `workflow abandon` it;
- the recorded owner runs on another host or as another user: pause it from there.

A second pause of a run that already has one pending changes nothing and reports the first request, provided its owner still answers; otherwise it is refused like the first. A request that a gate or wait overtakes ends when that pause is resumed; pause the run again if you still want it paused.

`--json` prints `{ "ok": true, "runId", "action": "pause", "state": "requested", "alreadyRequested", "requestedAt" }`, or `{ "ok": false, "runId", "action": "pause", "error" }` with exit code 1. `--as <name>` records the name you declare as who asked; it is a claim, never checked.

### `workflow resume`

Resume a run by id: a failed or paused run, or a run its killed process left `running`. Nodes that completed in the earlier attempt are skipped. A run [paused by an operator](#workflow-pause) continues at the next node, as if it had not stopped. Resume never picks a run for you; find the id with `archon workflow runs` (`--item <key>` narrows it to one item).

```bash
archon workflow resume <run-id>
archon workflow resume <run-id> --detach   # continue in a background child
archon workflow resume <run-id> --json     # validate and acknowledge only
```

A run that failed before its checkout was prepared, such as a trigger start whose worktree could not be created, has nothing to resume, and resume refuses it. The refusal prints the command that starts it again: `archon workflow run --supersedes <run-id>`. With no workflow name, [`--supersedes`](#workflow-run-name-message) takes the workflow, message, inputs, definitions source, item and checkout hand-off from the run's record, so the line holds nothing a shell would need quoted.

A `cancelled` run, such as one [`workflow abandon`](#workflow-abandon) ended, is refused too: abandon removes its worktree, so there is no checkout left to continue. That refusal prints the same command, which starts the run fresh from its record, without its completed nodes. With `--json`, either refusal's `{ "ok": false }` line carries the command as `restartCommand`. A `workflow:` sub-run gets no command: restarting it alone would run it outside its parent, so resume or abandon the parent instead.

With `--json` the command validates that the run is resumable, reports its state and returns without executing, because execution output would corrupt the JSON. To drive the run to completion, use the blocking form or `--detach`.

`--detach` hands the resume to a background child that runs it without `--json`, so the run does continue, outside your shell. The acknowledgement carries `continues: true` and is sent only after the engine accepts the resume and clears the old pause. An immediate `workflow wait` can therefore report a new pause, even repeated attention at the same node, but never the cleared one. See [Detached control verbs](#detached-control-verbs).

**A run still marked `running`.** A process that is killed (a closed terminal, a `kill`, a crashed server) leaves its run `running`. Resume asks whether an owner still answers for it, the way [`workflow cancel`](#workflow-cancel) does, and acts on the answer rather than on how old the run's activity is:

- **No owner answers on this host**: the run resumes from its completed nodes. A run admitted through a resource keeps the slot it already holds.
- **An owner answers** (the run, or the root run of a sub-run, is still executing): resume refuses, names the owner's host and pid, and leaves the run unchanged. To resume it, wait for that process to exit or stop that process yourself, then run resume again. [`workflow cancel`](#workflow-cancel) is not that step: it ends the run as `cancelled`, and resume refuses a cancelled run.
- **The recorded owner ran on another host or as another user**: this host cannot ask it, so resume refuses and leaves the run unchanged. Resume it from that host and user, or [`workflow abandon`](#workflow-abandon) it if its process is gone.

Two resumes of the same run cannot both start it. The first one admitted changes the run's execution claim and records its own process as the run's owner in the same update, so a second resume is refused whether it read the run before that update or after, on this host or another.

### `workflow cancel`

Stop a running workflow, or withdraw a `pending` one before it starts. Every cancel
surface (this command, `/workflow cancel` in chat, the Web UI's Cancel action,
`POST /api/workflows/runs/{runId}/cancel`, the Slack Cancel button, and the chat agent's
`manage_run` tool) does the same thing, decided by the run's status and who owns it:

- **The run is `pending` and no process holds it** (an admitted start, or a detached
  launch, that no process has picked up; for a `workflow:` sub-run, no owner answers for
  any of its ancestor runs either): cancel takes the run's owner lock, records it
  `cancelled` while it is still pending, and releases the lock. A starter takes the same
  lock and checks the run is still pending before it prepares a checkout, so the start
  never runs and its resource slot frees. Cancel stops no process and prints no
  host-command or checkout warning. A checkout an earlier, failed start already prepared
  is left in place. A pending run that a live process is starting, or one that starts
  while cancel records it, is refused and left unchanged; cancel it again once it is
  running. A start still `queued` for its resource has no run yet;
  withdraw it with `archon trigger withdraw <request-id>`.

  The owner lock and endpoint cancel checks live on this machine. A starter on another
  machine that shares the same database holds its own lock there, and cancel cannot see
  it. Cancel then records the run `cancelled` and frees its slot while that machine keeps
  preparing the checkout and running setup. Until Archon records preparation in the
  shared store, cancel a pending run only when no other machine starts runs from the same
  database.
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
- **A running run whose owner does not answer, or cannot be stopped:** cancel fails and
  leaves the run unchanged. When no owner answers, it prints what the run recorded (host, pid, last
  activity) and points you at `abandon`. A foreground `archon workflow run` or a run
  executing in another Archon server answers but cannot be stopped from here; interrupt
  the foreground command, or cancel the run on the server that executes it.

```bash
archon workflow cancel <run-id>
archon workflow cancel <run-id> --json
archon workflow cancel --item <key> [--all-runs]
```

With `--item <key>`, cancel acts on the [item's](#items) run that is `pending` or
`running`, through the same path as `workflow cancel <run-id>`, so a live owner is handled
the same way. Archon never chooses between runs: when several runs on the item are pending
or running, cancel
refuses and lists them; name one by id, or pass `--all-runs` to cancel each in start
order. With `--all-runs`, one run's failure does not stop the rest, every run is
reported, and the command exits `1` if any failed. Cancel also refuses an item with no
pending or running run, and an item one of whose runs cannot be read, since that run may be the one
to act on. Under `--json` the command prints one
`{ "ok", "action": "cancel", "item", "results": [...] }` document whose `results` hold
exactly what the run-id form prints for each run. A refusal prints
`{ "ok": false, "action", "item", "reason", "error", "runs"? }`, where `reason` is
`no_project`, `not_found`, `unreadable`, `no_run` or `several_runs`, and `runs` lists the
runs to choose from.

Under `--json` a cancel prints `{ "ok": true, "runId", "action": "cancel", "status": "cancelled",
"previousStatus", "processStopped", "workflowName", "cleanupWarnings"?, "cascadeFailures"?,
"blockedParentRunId"? }`. `previousStatus` is
`pending` for a run withdrawn before it started and `running` otherwise; `processStopped` says
whether cancel stopped another process that owned the run.

When cancel refuses, it exits nonzero. Under `--json` it also prints `{ "ok": false, "error": ... }`.
`workflow resume` and `workflow abandon` follow the same contract, so a script or bash node can
gate on the exit status.

Refusing a running run with no answering owner is deliberate: `cancelled` releases the
run's worktree lock and resource slot, and a database transition cannot prove that host
work stopped. After verifying that the owner process is gone, use
`workflow abandon <run-id>`. A pending run with no owner needs no abandon; cancel ends it
as described above.

A running `workflow:` sub-run normally executes inside its root run's process, and the
root's row keeps the worktree lock and resource slot. When no owner answers for the sub-run
itself but one answers for its root, cancel records `cancelled` and the root's executor
stops the sub-run at its next status check. When no owner answers for the root either,
cancel refuses and points at abandon, as for any other running run. A sub-run resumed on its own (after a
durable wait or a scheduled resume) has its own owner, and cancel stops that owner like
any other run's. Only a `pending` or `running` run can be
cancelled; abandon a paused or failed run instead.

After termination is confirmed, `cancel` records cancellation through the same run-tree
operation as `abandon`. Cancelling a parent therefore attempts descendant cancellation within the
[500-parent expansion bound](/reference/workflow-language/#max_parallel-bounds-concurrency-not-count)
and can report the same cascade failures or blocked parent described below.

On Windows a detached owner runs in a Job Object that every process it starts inherits, so
cancel and abandon stop and confirm the whole tree even when an intermediate process has
already exited. The job ends with its owner: when the owner process exits for any reason,
including a normal finish, a failure or a pause at an approval, Windows ends every process
still in it, so background work a node left running does not outlive the owner. An owner
started by an Archon version without this reports no job, and its
tree cannot be confirmed, so cancel and abandon refuse it while it runs: stop the owner
process and its descendants yourself, then use `workflow abandon`.

A detached run that a node launches with `workflow run`, `resume`, `approve`, `reject`,
or `respond` and `--detach` starts outside the launching run's job and owns its own. So
does a run started through a trigger, whether a node fires it or the launching run's end
starts it as a follow-up. Cancelling or ending the launching run leaves it running; stop
it with its own `cancel`.
The broker and relayed CLI ignore
`BUN_OPTIONS` and `bunfig.toml` startup hooks, which would execute outside the owner's job.
On POSIX a detached run starts its own process group, so the same holds.

The job grants no other way out: a tool in the run that asks Windows to start a process
outside its job fails to start it.

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
  descendant checkouts and their root. Owner-check warnings learned after cancellation
  during descendant cleanup or conversation reset are appended to that run as
  `workflow_cleanup_warning` events. If writing a warning event fails, cleanup continues
  and the command reports the persistence failure with the cleanup warnings.
  Verification-image inventory warnings are returned in the immediate result only;
  they are not saved as cleanup events. Keep that result for recovery guidance and
  any warnings missing from the run history.
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
archon workflow abandon --item <key> [--all-runs]
```

`--item <key>` works as it does for [`workflow cancel`](#workflow-cancel), for the item's
run that is `pending`, `running` or `paused`. A failed run, or a cancelled run whose
worktree removal you are retrying, is abandoned by id.

Abandon prints the command that starts the run again from its record, without its
completed nodes: `archon workflow run --supersedes <run-id>` (see
[`workflow resume`](#workflow-resume), which refuses a cancelled run). A `workflow:`
sub-run gets none; its parent is the run to resume or abandon.

`--json` adds an `owner` object: `{ "outcome": "stopped", "pid": … }`, or
`{ "outcome": "no_owner_answered", "thisHost", "recordedHost", "recordedPid",
"recordedUid", "lastActivityAt" }`, and `restartCommand`, the command above, except for
a sub-run.

Abandon also attempts to remove the worktree Archon created for this run, and for each
cancelled `workflow:` sub-run. Owner warnings retain affected checkouts for inspection;
use `lsof` on the checkout when output is still held, then retry abandonment after
resolving the warning. When removal proceeds, it is forced, so
uncommitted, untracked, and ignored files (including copied `.env` files) and
initialized submodules are deleted with it. A branch with commits of its own is kept,
so committed work, pushed or not, stays recoverable. A branch Archon generated for the
run that is still at the commit it was cut from is deleted with the worktree; a branch
the launch named is always kept. The result lists each removed worktree, its branch,
and whether the branch was deleted (`releasedWorktrees[].branchDeleted` in `--json`), and the isolation record is marked `destroyed`.

When the selected run is a sub-run and no owner answers at its own endpoint,
Archon retains its subtree's owned checkouts. A sub-run can execute inside an enclosing
run without publishing its own endpoint; silence does not establish that execution
stopped. Cancellation still succeeds, with cleanup warnings. A separately resumed
sub-run whose exact owner is stopped without warnings can release its owned checkout.
Each descendant needs its own owner check. A silent descendant retains its checkout
and the selected root's checkout even if the root's owner stopped.
Conversation reset also retains a silent sub-run's checkout, even if another run with
matching host, PID, and user metadata stops: those fields cannot identify a process
incarnation. Retention follows the checkout ID; a separate checkout can still release
after its owner stops. Inspect the owning execution
and stop or abandon it only if you intend to stop its whole scope. Repeated child-only
abandonment may continue retaining the checkout even after its enclosing execution stops.

Only a checkout this run created is removed. Adopted, reused, inherited, and legacy
checkouts without that creation proof stay in place, with a reason. A checkout another
resumable or live run uses, one locked with `git worktree lock`, one whose owner runs on
another host or as another user, or one under a descendant that could not be accounted
for is also kept.

The run is cancelled even when removal fails; the failure is reported as a cleanup
warning. Retry `workflow abandon <run-id>` on that cancelled run to retry removal
without repeating cancellation; unresolved sub-run ownership still retains the checkout.

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

Before a result, open tools and reported background work remain running when silent. After
`workflows.toolCallAttentionMs` without progress (30 minutes by default), attention
shows their node, provider, sanitized description and idle duration. A silent turn
with no open tool or reported background work still fails after its node's
`idle_timeout` and follows its existing retry policy. After a result, silence also
counts toward `idle_timeout` while waiting for settlement, even with live work;
the node can fail before the attention threshold. A new running wake turn or
newly started tool or subtask restores live-work protection until its next result.

Before that, the engine sends the stalled session up to `workflows.stallMessageLimit`
messages (2 by default) stating how long the work has shown no progress, without ending
the call; `workflow status` shows the latest under the run, and `workflow logs` prints
each with its text, or the provider's refusal. An agent that continues needs no
request. See [workflow attention settings](/reference/configuration/#workflow-attention-and-continuation-settings).

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

Without running a server, wake due durable time waits, event deadlines, signaled events, scheduled quota resumes, answered gates, and runs released because their host could not read their frozen source, and meet open item waits that a source observes:

```bash
archon workflow wake --json
archon workflow wake --watch --json
```

A pass scans up to 25 due continuations across the configured install database, regardless of the current directory. It awaits each admitted execution segment. A segment can complete, fail, or pause at another wait or gate; later occurrences belong to another pass. A run released for an unreadable source is due 60 seconds after its release and retries the failed source read. This can include restoring the captured source before any node starts. Concurrent CLI and server hosts use the engine's existing occurrence claim, so only one executes a continuation.

Once it has tried to admit its due continuations, so a due paused run takes a freed slot before a queued new start, and without waiting for them to finish, each pass also drains every trigger host this install serves, as a CLI run end does ([`trigger`](#trigger)): the hosts its trigger files in `ARCHON_HOME/triggers` name. `ARCHON_TRIGGER_HOST` does not add a host. A start whose admitting process died, after a run end or an answer, is admitted at the next pass. Each admitted start runs in its own detached `trigger execute` process. A drain that fails, or a trigger file that does not read, makes the pass fail: its one result has `ok: false` and lists each failure, redacted, under `drainErrors` (printed to stderr without `--json`); the other hosts still drain.

In a long-lived `workflow wake --watch` or server process, if a run's frozen source is missing, unreadable, or fails verification (invalid manifest or source record, digest or resolution settings mismatch, or missing captured workflow), automatic continuation stops attempting that occurrence on this host after three failures and logs one warning per run per process naming the run, the path when available, and the operator actions. Resume it on the owning host with `archon workflow resume <run-id>`, or abandon it with `archon workflow abandon <run-id>`. The run's status stays unchanged, and another host can still resume it. The bound lives in process memory and resets on restart. Temporary I/O failures, such as exhausted file descriptors, and other retryable admission failures keep the 60-second retry. A successful manual resume can reach a new wait, gate, or quota occurrence; that occurrence can wake in the same process. One-shot `workflow wake` invocations start a fresh process each time and cannot accumulate this bound. Installed wake schedules run `workflow wake --watch` so repeated passes share the bound.

When `ARCHON_WEBHOOK_SOURCES` names a source with `observe`, `wake` also observes the open item waits and the [label bindings](/guides/workflow-triggers/#label-an-issue-or-pull-request-without-a-webhook) through it, once per its `everySeconds`, and starts the stages the met waits and the newly labelled issues and pull requests name on their hosts, each in a detached `trigger execute` process as `trigger fire` does ([Without a webhook](/guides/workflow-triggers/#without-a-webhook)). A source with no `observe` is never read, and with no open wait and no label binding nothing reads the forge. A watch first writes `{"ok":true,"action":"wake","observe":[{"source","everySeconds"}]}` (one `wake: observing source <id> every <n>s` line each without `--json`). A pass that read waits or labels, or whose source has label bindings it cannot observe, writes `{"ok","action":"observe","source","waits","labels","reads","started","conflicts","unserved","unservedBindings"}`, with `error` when a read or an admission failed: `waits` the open waits it passed the source, `labels` the label reads its bindings name, `reads` the commits, pull requests, label lists and items' label events it read from the forge (an unchanged item whose earlier answer a watch reuses is not a read), `started` the starts first recorded, `conflicts` the deliveries refused for reusing an id with other content, `unserved` each wait it cannot observe with `reason`, and `unservedBindings` each label binding it cannot observe as `{bindingId, reason}`. A host whose drain fails writes `{"ok":false,"action":"observe","drain","error","hint"}`. A watch drains it again on its next pass. After a one-shot wake or a restart, every wake pass still drains it when one of this install's trigger files names that host. Each pass also drains the host of every label start it observes again, so while the label is on the item, a start on that host queued at capacity, or whose drain failed, is admitted once its slot frees, also after a restart; any other host named only by a source binding needs `archon trigger drain --host <id>`. Observation runs in its own loop beside the continuation passes, so a resumed run that takes a long time does not delay it; a one-shot `wake` observes once. A failed observation or drain makes the command exit 1.

`--watch` repeats serial passes, sleeping five seconds between completed passes. Its JSON output is JSONL: one document per pass with `ok`, `action`, `accepted`, and per-run `outcomes`. Outcomes distinguish admission from settlement (`completed`, `paused`, or `failed`). Without `--json`, the command prints a summary and run-specific outcomes.

A watch keeps running the Archon it loaded at start, so every run it resumes, including the run's hand-off at its end, would run that code until the process restarts. It therefore records the installed engine when it starts: the checkout's commit for a source install, or the executable file for a compiled binary. Before each pass it reads it again. When it differs, the watch writes `{"ok":true,"action":"wake","restart":"engine changed","loaded":…,"current":…}` (one line without `--json`), runs no further pass, continuation or observation, and exits with status 75, so its supervisor starts it again on the updated code. So no pass starts on code older than the install. A run the watch is already executing when Archon updates finishes on the code it loaded; if its hand-off then refuses a trigger file that only the updated install understands, the run fails naming the file, and `archon workflow resume <run-id>` hands it off on current code. A compiled binary reached through a symlink to a versioned file, as Homebrew installs it, is read as that versioned file, which an upgrade leaves in place, so the watch does not see the upgrade: restart it after upgrading. When the engine cannot be read at start, the watch writes `{"ok":true,"action":"wake","engine":"unknown"}` and must be restarted by hand after an update. `archon serve` resumes continuations in its own process and has no such check; restart it after updating Archon, or runs it resumes keep its old code.

Exit status is 0 for an empty batch, a concurrent claim loser, a completed segment, a legitimate pause, or a run whose resource is full, reported with the run or request that holds it. A paused run stays paused and keeps its place (`waiting_for_capacity`); a later pass continues it once capacity frees. A failed run with a scheduled quota resume stays failed and keeps no place (`resource_busy`, `refusal: "failed"`): it is retried after the 60-second deferral and admitted only after waiting runs and queued requests. A run refused because the install's [run limit](/reference/configuration/#run-limit) is full (`run_limit_full`) keeps its state, also exits 0, and is retried after the deferral. Other refusals, execution failures, and deferral failures return 1. Watch continues after failures and returns 1 on shutdown if any pass failed, or 75 when Archon was updated under it. Retryable prerequisite failures defer the exact occurrence for 60 seconds.

The CLI preserves the run's recorded source, inputs, configuration, user, conversation, and working path. It accepts local CLI/API conversations. Container execution, missing paths or captured source, and external platform origins are refused with the run ID and reason. Use manual `workflow resume` for a container, or the server hosting the external conversation. A run stays parked if no waker runs; age never marks it failed.

SIGINT/SIGTERM stops scheduling new passes and drains admitted segments and owner cleanup. Shutdown can wait for a long executing segment. An abrupt kill retains the existing ambiguous-owner behavior; it does not provide automatic recovery of a running segment. On Windows, SIGTERM ends the process immediately, so it behaves as an abrupt kill rather than a drain.

#### Wake timers

Install a per-install job that keeps `workflow wake --watch --json` running, on macOS, Linux and Windows:

```bash
archon workflow wake schedule install --json
archon workflow wake schedule status --json
archon workflow wake schedule remove --json
```

The job is the same native schedule `trigger schedule install` writes (see [trigger schedules](#trigger-schedules) for the files on each platform): a LaunchAgent on macOS, a systemd user timer and the oneshot service it starts on Linux, and a `\Archon\<label>` Task Scheduler task on Windows. Each scheduler starts the command at an interval and never starts it while it is still running, so the job holds one long-lived watch per install, and the interval is how soon a watch that exited is started again: after a crash, after a kill, or after an update to a source install or to a binary replaced in place, when the watch exits with 75 so it starts again on the new code. The watch process itself polls every five seconds. `--interval <seconds>`, on `install` only, sets that interval: a positive integer, defaulting to 5, or on Windows a whole number of minutes, defaulting to 60, because Task Scheduler repeats a task in whole minutes. The job id is keyed on `ARCHON_HOME`, so each install on the machine gets its own job.

The job runs at load and at login, and records an absolute executable, working directory, `ARCHON_HOME`, and the installing shell's `PATH`. When the installing shell sets `ARCHON_WEBHOOK_SOURCES` and `ARCHON_HOME/.env` does not, the job passes that file, as an absolute path, to the watch with `--sources <file>`, so the job's watch observes it while a server on the same `ARCHON_HOME` does not have to: a value in `ARCHON_HOME/.env` is loaded by every process on the install and wins over a process's own environment. Without it, the watch reads `ARCHON_WEBHOOK_SOURCES` from `ARCHON_HOME/.env` as any process does. The job's watch stops when the sources file it loaded changes or is removed, so the job starts it again on the new file within its interval. Its output is discarded, so each pass of the job's watch is recorded in `ARCHON_HOME/schedules/<job id>.last-pass.json` instead: `at`, `pid`, `ok`, per loop (`wake` for continuations and drains, `observe` for sources) the time, `ok` and `errors` of its latest pass, `lastFailure` (the time and errors of this watch's latest failed pass, kept after later passes succeed, because a watch reuses what it read of an unchanged issue, so a label start it failed to record may not be tried again until it restarts), and `sources`, the file it loaded. A job-started watch that fails before its first pass, such as on a sources file that does not load, records that as a failed pass. A watch with no job installed records nothing. The job records the resolved executable path, which for Homebrew is the versioned file, so after `brew upgrade archon` remove and install the schedule again; otherwise the scheduler keeps starting the old version, or nothing once it is removed. Reinstalling identical configuration loads the job when the scheduler has not. Remove then install to change its interval, executable, or `PATH`, to add `PATH` to a schedule installed before it was recorded, or to upgrade an existing one-shot wake schedule to watch mode.

`remove` takes the job off the scheduler and deletes its files. Only launchd stops a running watch when its job is removed, so a watch that found the job's definition file when it started stops itself within one poll once that file is gone or is a different file, such as the one a later `install` writes. A remove then install therefore leaves one watch, on the new configuration. A watch started by hand while no job was installed is not affected. `status` prints `{"installed": false}`, or `"installed": true` with `path` (the job's definition file), `registered` (the scheduler has it loaded) and, once the job's watch has run a pass, `lastPass`, the record above; without `--json` it says when the last pass ran and what it failed on. A job that is installed but not registered is loaded again by `install`. `remove` also deletes the last-pass record. On Linux the watch shows as `activating` in `systemctl --user status <label>.service` for as long as it runs. On Windows, a launcher failure is appended to `ARCHON_HOME\schedules\<label>.log`, and Task Scheduler shows the task's last run result as `0x800710E0` ("the operator or administrator has refused the request") once a minute while the watch runs: that is the scheduler declining to start a second copy, as the job intends, not a failure. See [workflow trigger scheduling](/guides/workflow-triggers/#scheduling-limits) for login, sleep, environment, and scheduler caveats, and [`trigger check`](#trigger) for the report of observing sources that no installed watch reads.

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
A run that left asks or waits open on its item is kept, and so is a run with a `workflow:`
sub-run, at any depth, that has not ended: deleting it would split the run tree the
[run limit](/reference/configuration/#run-limit) counts as one. A run that a run which has
not ended continues from is kept too, because an adopter reads its artifacts. A later
cleanup removes it once they have closed or ended.

Each deleted run's artifacts directory, log and frozen workflow source are removed with it
(see [a run's files on disk](/reference/database/#a-runs-files-on-disk)). The command
reports the runs deleted, the disk space their files took and the state revisions pruned.
It prints each path it could not remove with the error to stderr and exits 1. The rows
stay deleted, and once the cause is fixed a later `--orphans --yes` removes those paths.
A removal that failed part way has just changed its path, and `--orphans` waits until a
path is 6 hours past its last change, so the message gives the time after which the retry
lists them.
A path whose directory links outside `$ARCHON_HOME/workspaces` is reported and never removed.

```bash
archon workflow cleanup              # Default: 7 days
archon workflow cleanup 30           # Custom threshold
archon workflow cleanup --orphans    # List files of runs deleted earlier
archon workflow cleanup --orphans --yes
```

`--orphans` deletes no rows. It lists run-id paths under every project whose run has no
row in the selected store, with each size and the total. It leaves a path that changed in
the last 6 hours, because a container run's frozen source can exist before its row does.
It says how many paths it left this way and when to run it again to list them. Only
`--yes` removes the listed paths. `--yes` is refused while this `ARCHON_HOME` also holds
the other store's history, because those runs have no row here. Moving that history out of
`ARCHON_HOME` does not make its runs' files safe to remove: they still belong to its rows.

A PostgreSQL database leaves nothing in `ARCHON_HOME` to detect. When the command opened
SQLite or the file store, it says that it could not check a PostgreSQL database. If runs of
this home live in one, run `--orphans` with that `DATABASE_URL` set: from a shell without
it, every PostgreSQL run's files are listed, and `--yes` removes them.

### `workflow reset-sessions`

Delete a workflow's persisted per-node AI sessions: the cross-run memory kept by nodes that opt in with `persist_session` (or workflow-level `persist_sessions: true`) or `context: same`. Use it when a workflow should forget its earlier conversation. A `context: same` node's sessions are scoped `item:<item_id>`, and its `--node` id is the node's path (`<group>.<node>` inside a `loop_group`).

```bash
archon workflow reset-sessions <workflow-name> --scope <key>      # one scope: a conversation UUID, or item:<item_id>
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

Validate workflow YAML definitions, project pack settings, and referenced resources (command files, MCP configs, skill directories).

```bash
archon validate workflows                 # Validate all workflows
archon validate workflows my-workflow     # Validate a single workflow
archon validate workflows my-workflow --json  # Machine-readable JSON output
```

Checks: YAML syntax, DAG structure (cycles, dependency refs), command file existence, MCP config files, skill directories, provider compatibility, tier/alias model refs, and supported static environment reads in inline or named exec sources. An unprovided `INPUTS_*` read is an error when the workflow declares an input contract; other unprovided Python or JavaScript/TypeScript environment reads warn. See [Variables](/reference/variables/#shell-quoting-in-bash-vs-script) for the supported forms and fixes. For bundled and global workflows, validation rejects a bare `@custom` model alias because it isn't portable across projects; use `small`, `medium`, `large`, a literal provider model string, or a preference list that ends in one, such as `['@reviewer', medium]`. Returns actionable error messages with "did you mean?" suggestions for typos.

Project pack settings in `.archon/packs/<pack>.yaml` are checked against each discovered workflow's pack declaration using the same value rules as run start. Errors name the file and setting, including allowed values for enum settings. Validation checks values present in the file; required values that an invocation can supply are checked at run start.

A pack that declares [forge needs](/reference/workflow-language/#pack-forge-needs) gets a `pack_forge` warning for each listed capability no installed forge plugin advertises, and for a plugin that could not be discovered. It is a warning, not an error: which plugins are installed is a fact about this install, and a run of the pack is refused at start until one serves it.

When the directory you run it in holds an `archon-plugin.json` (a plugin root, also one inside a repository), each key its manifest kind does not declare gets a `manifest_unknown_key` warning under the result named `archon-plugin.json`, with or without a workflow name, such as `unknown key 'compatibility.min' is ignored`. Archon ignores such keys when it installs or loads a plugin, so a manifest written for a newer Archon still works here; the warning is how a misspelled key shows up.

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

Remove eligible worktrees by inactivity and eligible containers by age since the container
environment was created. The threshold is `[days]` (default 7). Recent activity does not
reset a container environment's creation age; containers a running, pending, or paused run
can claim remain protected. With `--merged`, remove worktrees whose existing local
tips are covered by Git integration or an eligible PR head instead. Worktree cleanup only handles
worktree records. Container cleanup removes eligible containers and their volumes
through the container backend,
including when no stale worktrees exist. A missing host folder does not make a container
destroyed. To clean eligible containers without waiting for the default age threshold,
run `archon isolation cleanup 0`; containers owned by resumable runs remain protected.

Project deletion (`DELETE /api/codebases/{id}`) returns `409` while active container
environments remain. The error lists their environment IDs and the cleanup command.
Clean them up explicitly, then retry deletion.

Cleanup continues after individual errors and exits with status `1` if any removal fails;
protected skips exit with status `0`. After container teardown, cleanup attempts image
release for every associated run. Image lookup/removal failures count as errors even when
the container was successfully removed.

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
records that lack branch-creation tracking. Merged cleanup (`--merged`) and
`archon complete` can delete those local branches after their checks. Completion with `--force` bypasses commit-safety checks, so it can
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
When removal proceeds, it deletes uncommitted work there and keeps a branch that holds commits; see [`workflow abandon`](#workflow-abandon) for what it keeps and how to retry.

```bash
# Default: 7 days
archon isolation cleanup

# Custom threshold
archon isolation cleanup 14

# Remove environments covered by a merged PR (retains remote refs for operator inspection)
archon isolation cleanup --merged
```

Merged cleanup accepts ancestry into the configured base branch or patch equivalence
through `git cherry`. Patch equivalence cannot cover a tip with merge commits outside
that base's history, because `git cherry` omits their conflict resolutions. Both the
recorded branch ref and worktree HEAD must be covered.
When Git cannot prove integration, one merged PR head must cover every existing local
tip: each must equal that head or be an ancestor of it. Pass `--include-closed` to
also accept a closed but unmerged PR with the same coverage check.

The PR path first checks the PR found by the local branch name. If it cannot prove
coverage, cleanup discovers PRs associated with the worktree's HEAD, then the local
branch tip when it is different. This also finds work published under another name.
An open branch PR does not suppress an independently covering merged PR. When no
merged candidate proves coverage and every inspected local commit was found in the
configured repository, an open PR keeps the environment as active review.
Coverage from different PR heads is never combined. With no local tips remaining,
a merged branch PR can settle the registration on its own.

Missing PR heads are fetched by SHA from the configured remote. A failed comparison
stops the judgment, reports the error, and keeps the environment. A failed PR lookup
(auth, rate limit, or unreadable response) keeps the environment and reports
`PR state lookup failed`. The optional `gh` CLI currently supplies GitHub PR evidence;
without it, or on unsupported remotes, merged cleanup retains unproven environments.
For commit association lookups, an error-free GitHub object query distinguishes a
local commit not found in the configured repository from a lookup failure. This does
not establish whether the commit exists in another repository. Without covering
evidence, cleanup reports
`no pull request covers all local work — a local commit was not found in the configured repository`
and keeps the environment, including during scheduled cleanup.

When a project's checkout directory no longer exists, for example a checkout under a
temporary directory a restart emptied or a disk that is not mounted, `--merged` does not
check that project's worktree environments. It reports the missing directory once, lists
each environment with its worktree path, and keeps every record. These environments are not
failures and do not change the exit status. Archon does not judge whether the project was
deleted or the disk is only unmounted. To release a record, delete its worktree directory once
nothing in it is needed, then run `archon isolation list`, which retires a record whose worktree
is missing unless a run can still claim it; the next cleanup pass does the same. A checkout that exists but cannot be read
still fails the pass.

With `--json`, `--merged` prints one document, `{ "codebases": [...] }`. Each entry carries
`codebaseId`, `repositoryUrl`, `path`, and a `kind`: `swept` with the sweep's `result`
(`removed`, `skipped`, `warnings`, `releasedFailedRuns`, `errors`); `repository-gone` with
`environments` (`branchName`, `workingPath`); or `failed` with `error`. The exit status is
the same as without `--json`.

Manual `--merged` cleanup reports ordinary retained work as
`no cleanup evidence covers all local tips`. A missing branch ref with no discovered PR is
reported as `merge state unverifiable`. The scheduled sweep uses the same merged
judgment and keeps unavailable or failed inspections out of its stale sweep.
Ordinary unmerged work can still reach scheduled stale cleanup, subject to its age
and unpushed-commit checks. Git integration checks use `worktree.baseBranch` or default-branch discovery.
A base inspection failure stops the judgment and retains the worktree, even when
a PR could otherwise prove coverage.

Cleanup does not coordinate with direct Git commits or other operator edits. Do not
modify a worktree or its branch while cleanup runs; a commit after inspection can
otherwise lose its checkout and branch reference.

A running, pending, or paused run keeps its environment in both modes, regardless of
age or merge state. The scheduled sweep and chat `/worktree cleanup` apply the same
run lock. Stale environments with quiet conversations still pass the activity filter;
the run lock is what keeps them on disk.

A start handed another run's worktree (`checkout: "ended-run"` or `"asking-run"`, see
[workflow triggers](/guides/workflow-triggers/)) keeps that worktree the same way while
it waits: still being prepared, or queued for its resource. Its run then keeps it once
admitted. The skip reason names the start; `archon trigger withdraw <request-id>`
withdraws a queued one. A start that was withdrawn, skipped or refused keeps nothing. A
run that left asks for a `checkout: "asking-run"` binding keeps its worktree at completion
(`retained`, `in_use`), but nothing holds it while the asks are open: cleanup may remove
it, and the start its answers cause is then refused, naming the worktree, whether it is
removed before the asks settle or before the start runs.

A **failed** run keeps its environment only until its outcome is settled:

- `--merged` (and the server's scheduled merged cleanup) removes it once Git integration
  or one merged PR covers both existing local tips. Manual `--include-closed` also
  accepts a covering closed PR.
- The stale sweep removes it once the run has been inactive since it failed for longer
  than the stale window (`[days]` here; `STALE_THRESHOLD_DAYS` for the server and chat).

The output names each failed run whose environment it removed, with the reason:
`merged`, `PR closed` or `stale`. Removal leaves the run's status unchanged. Resuming
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
when its run ends: `--merged` removes it once Git integration or a merged PR covers its local tips.
Nor is a worktree that belongs to a chat conversation, an issue or a pull request rather than to one run; the merged and age-based cleanups remove it. A
workflow launched from the Web UI runs in its own per-run worktree on a generated branch,
and completion removes it the same way. A failed run keeps its worktree for resume
until merged or stale cleanup removes it under the rules above.

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

### `isolation cleanup schedule`

Install a host timer that runs `isolation cleanup --merged` on an install that runs no
server. A server already sweeps merged worktrees on its cleanup schedule, so do not
install the timer beside one. Nothing installs it but this command:

```bash
archon isolation cleanup schedule install --interval 21600 --json
archon isolation cleanup schedule status --json
archon isolation cleanup schedule remove --json
```

The interval is a positive integer in seconds, defaulting to 21600 (6 hours, the server's
default). The job runs at load and then every interval, from the Archon home, and records
an absolute executable, `ARCHON_HOME`, and the installing shell's `PATH`, which must
contain `git` and `gh`. There is one job per install: one pass covers every project
registered there, and the scheduler never starts a pass while the previous one runs.
Reinstalling identical configuration loads the job when the scheduler has not; to
change the interval, executable or `PATH`, remove it and install again. `install`
refuses a file-store install, because merged cleanup needs the database.

The timer is the one [`trigger schedule`](#trigger-schedules) installs, on the same
platforms and with the same files: a LaunchAgent on macOS, a systemd user timer on Linux,
and a Task Scheduler task on Windows, where the interval must be a whole number of
minutes. Its output is appended to `ARCHON_HOME/schedules/<label>.log`. `install --json`
prints `path` (the job's definition file) and `log`; `status --json` prints `installed`
and, for an installed job, `path`, `registered` (the scheduler has it loaded), `log` and
`lastRunAt`. On a host with no supported scheduler, `install` prints the command to
schedule by hand.

`isolation` commands act on every registered project, so they run from any directory,
including one that is not a git repository. See
[workflow trigger scheduling](/guides/workflow-triggers/#scheduling-limits) for login,
sleep, and environment caveats.

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
failed run that can still be resumed, or a start handed its worktree that still waits.
Unlike `isolation cleanup`, completion never
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

`key` is the value `workflow attention --project` and `archon state --project` accept. The list is read-only; register a project with [`project add`](#project-add), and remove one through the Web UI or chat.

### `project add`

`archon project add [path]` registers a project before anything runs in it, so a setup step can register the project and check it before the first run. It is the same registration a first `workflow run` or `trigger fire` performs in an unregistered checkout: the same row and the same key. `path` resolves against `--cwd` or the current directory and defaults to it. A subdirectory of a git repository registers the repository root. A directory that is not a git checkout needs `--folder`, which registers the directory itself as a [folder project](/guides/multi-repo-projects/); `--folder` on a git checkout registers it as a folder project too, as `workflow run --folder` does. `--base-branch <name>` stores the project base branch, with the same checks as on a first `workflow run`.

Run again on a registered project, it changes nothing, says the project is already registered, and exits 0. It refuses, with exit 1, a missing directory, a non-git directory without `--folder`, `--folder` on a project registered as a repository, `--base-branch` on a folder or an already registered project, a second clone of a registered remote, and a base branch the remote does not advertise. It needs no server.

```bash
archon project add                       # register this checkout
archon project add ../notes --folder     # register a non-git directory as a folder project
archon project add --json                # { "project": { ...project row, "key" }, "registered": true|false }
```

The text output names the project, then its ID, kind, key and path. In JSON, `project` is the row `project list` prints and `registered` is `false` when the project was already registered.

### `project config`

`archon project config <id|name>` shows one registered project's merged config: defaults, `~/.archon/config.yaml` and the project's own `.archon/config.yaml`, in that order of precedence. It prints the view `GET /api/codebases/{id}/config` serves, plus a `project` field with the matched project's ID and name. Secrets are removed: assistant settings are limited to their safe fields, paths are left out, and `envKeys` lists the keys of the project's `env:` block without their values. The command writes no config file, not even a missing `~/.archon/config.yaml`, and needs no server. Like every CLI command, it opens the project store, so on a fresh install it creates `~/.archon/archon.db`.

```bash
archon project config acme/widget          # YAML
archon project config <project-id> --json  # { "project": { "id", "name" }, "config": { ... }, "envKeys": [ ... ] }
```

The project is matched by ID, then by exact name; a name shared by several projects is refused with their IDs. An unknown project, an ambiguous name and an invalid config file exit 1.

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
# inside a run: claim the document in the same write, and give it back with the outcome
printf '{"stage":"building"}' | archon state put work/7 --if-revision 4 --lease
printf '{"stage":"done"}' | archon state put work/7 --if-revision 5 --release-lease
# inside a run: write only while this run holds the lease
printf '{"ops":[{"op":"append","path":"/log","value":"built"}]}' | archon state patch work/7 --held
# inside a run: take the first document that is still claimable
printf '[{"name":"work/7","ifRevision":4},{"name":"work/9","ifRevision":2}]' | archon state claim
```

Every command writes JSON and names the scope it used: `{kind: "project", key}` or
`{kind: "install"}`. `get` returns `{scope, name, revision, value, lease}`; an absent document
returns revision `0` and value `null`. A deleted document returns value `null`,
`deleted: true` and its tombstone revision, which is the revision a recreating `put` must
name. `put`, `patch`, and `delete` return the scope and the new full revision. `log`
returns `{scope, name, revisions}`, newest first (use a positive `--limit` to bound the
result), including tombstones, operation, writer and timestamp. `list` returns
`{scope, documents}`: each document's name, latest revision, `updatedAt`, writer, lease and
`deleted`, ordered by name, without values. `--prefix` keeps names that start with
the given text. `list --values` reads every live document's value in one call instead:
each entry is `{name, revision, value, lease}`, and deleted documents are left out.

**Leases.** Inside a run, `put` and `patch` accept `--lease`, which takes the document's
lease for the calling run in the same write, or `--release-lease`, which gives it back. Every
revision a read returns carries `lease`: `null`, or `{runId, nodePath, takenAt, live}`.
`live` is computed when you read: a lease is live while its run is `pending`, `running`,
`paused` or `failed`, and has ended once the run is `completed` or `cancelled` (including
through `workflow abandon`) or has been deleted. A failed run keeps its leases because it
can resume. Nothing ends a lease on age or inactivity; to free a lease held by a run that
will not continue, abandon that run. A take or release while another run's lease is live
exits `3` naming the holder and writes nothing. Taking an ended lease, or one the run
already holds, succeeds. A write without a lease flag keeps the document's lease unchanged,
whoever writes it, and `delete` clears it. The lease flags are refused outside a run.

**Writing under a lease.** Inside a run, `put`, `patch` and `delete` accept `--held`. The
write is made only if the calling run holds the document's live lease; the store checks
that in the same step as the write. Otherwise it exits `3` with `reason: "lease_not_held"`
and writes nothing. A document with no lease, or with an ended one, is held by nobody.
`--held` combines with `--if-revision` and with the lease flags, so
`put --held --release-lease` records an outcome and gives the lease back only if the run
still owns it. `--held` is refused outside a run.

Every exit `3` carries a `reason` beside `error` and `code`: `revision_moved` (the
document is at another revision than `--if-revision` named), `lease_held` (a take or release against another run's live lease) or `lease_not_held`.

**Claiming one of several documents.** Inside a run, `archon state claim` reads a JSON
array of `{"name", "ifRevision"}` candidates from stdin and tries them in the order given.
It takes the lease of the first document that is still at the named revision and whose
lease is free, ended or already the run's own, and stops there. A claim adds a revision:
the lease is part of a revision, and the next conditional write must name the new number.
That revision repeats the value unchanged and `state log` shows its operation as
`{"op": "claim"}`, so the log tells a claim from a `put`, `patch` or `delete`. The output
is `{scope, claimed, skipped}`: `claimed` is that new revision, and `skipped` lists every
earlier candidate with a `reason`, named as a refused write names it:

| `reason` | Meaning | Extra field |
| --- | --- | --- |
| `missing` | No document has this name, or it was deleted | |
| `revision_moved` | The document is at another revision | `revision`: the current one |
| `lease_held` | Another run's lease is live | `holder`: `{runId, nodePath, takenAt}` |

When no candidate can be claimed, `claimed` is `null` and the command exits `2`. Order the
candidates yourself: the engine does not rank or filter them. `claim` is refused outside a
run.

An Archon binary from before `state claim` existed does not know the `claim` operation. On
a document whose revisions it reads include a claim, it exits `1` on `state get`, `log`,
`list --values` and any write. On SQLite and PostgreSQL a plain `state list` still works,
because it does not read the operation; on the files store `list` fails too. Once a store
holds a claim, use only binaries that have `state claim` on it. A source checkout and an
installed release can share one Archon home: after the first claim, the older of the two
fails on that document, so update both.

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
or storage failure, `3` revision conflict or a lease another live run holds, `4` oversized value, invalid patch or non-text
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
revision, retains the latest tombstone of deleted documents, and reports how many it pruned.
See [Durable state documents](/reference/workflow-language/#durable-state-documents).

### `metrics [name]`

Aggregate the metric records nodes returned under their reserved `metrics` output key.
See the [metrics guide](/guides/metrics/) for how to emit them.

```bash
archon metrics
archon metrics factory.prs_merged --since 7d
archon metrics factory.prs_merged --since 2026-10-01 --until 2026-10-22 --json
archon metrics sdlc.tests_unprotective --subject https://github.com/acme/widgets/pull/12
archon metrics --project acme/widgets
archon metrics sdlc.pr_merge_rate --since 60d --compare 2026-10-15T09:30:00Z
archon metrics sdlc.pr_merge_rate --since 60d --by-model ship__deliver__rounds.review__code
archon metrics sdlc.issues_merged --since 30d --by-dimension route
```

The window is `[--since, --until)`. `--until` defaults to now and takes an ISO date or a
time with an offset; a date alone is UTC midnight. `--since` takes the same, or a duration in minutes, hours, days or weeks
(`40m`, `24h`, `7d`, `2w`) counted back from `--until`, and defaults to 30 days. `--subject` keeps
records about one subject. `--project <id|name|key>` keeps records from one registered
codebase. A name's definition is install-wide either way: a record another codebase
stored first still fixes it. `--compare <ISO>` takes an ISO date or a time with an offset
and splits each instrument's records by when their producing runs started: before the cut,
or at or after it. `--by-model <node>` splits them instead by the model label that ran
`<node>` in their producing runs and the runs below them, and cannot be combined with
`--compare`. `--by-dimension <key>` splits them by the value each record carries for `<key>`
in its output's `metric_dimensions`; with `--compare`, each value is compared on its own. `--by-model` and
`--by-dimension` cannot be combined.

Text output prints one line per metric for its newest instrument: name, kind and unit,
`value` (the sum for a `count`, the mean for a `score`), `n`, the 95% interval for a score
of at least two records, the latest record, and the instrument with the models that ran its
`instrument_node`, such as `[judge-v1 on claude/claude-opus-5-5@high]`. An indented line
gives the cost and tokens of the producing runs, with how many runs recorded no cost, no
tokens, only partial cost, or no longer exist. Other instruments follow with the same
lines, indented further. With `--compare` and no `--by-dimension`, each
entry adds the `before` and `after` cohorts with their value, `n` and interval, the delta
with its 95% interval, whether that interval excludes zero (`separated`), and how many
records were `straddling` the cut or `unattributed`, and the output ends with a line that
the comparison is observational. With `--by-model`, each entry adds one line per model label,
then `(mixed)` and `(none)`, with its value, `n`, interval, its difference from the other
model labels combined (`vs rest`, with its interval and `separated`), the requested models
it merges, and its cost, and the output ends with a line that the split is observational.
With `--by-dimension`, each entry adds a `by <key>:` line, then one line per value and
`(none)` with the same figures but no models; with `--compare`, an indented `compare` and
`delta` line follows each value, and the output ends with both observational lines. `--json` prints one `MetricsReport` document, the same
shape `GET /api/metrics` returns, with names and instruments in sorted order.

A record that conflicts with its name's first definition is left out and reported on
stderr as `error: metric <name> is <definition>; run <id> node <node> offered
<definition>`, where each `<definition>` is `<kind>/<unit>`, followed by
` calibrates <metric>` for a score that calibrates another metric. A stored output the record schema rejects is reported the same way when
no name is given. Exit codes: `0` success, `1` usage (including a malformed window or
`--compare`, an empty `--by-model`, a malformed `--by-dimension` key, or `--by-model` with
`--compare` or `--by-dimension`), `2` the window has existing producing runs and
none ran the `--by-model` node, with the AI node ids they did run (at most 50) on stderr
(with no existing producing run the node is not checked and the query exits `0`: a window
with no records reports none, and records whose runs were all deleted are `unattributed`),
or the window has records and none carries the `--by-dimension` key, with the keys they do
carry (at most 50) on stderr, `4` the report refused a record.

With `--project` and none of `--subject`, `--compare`, `--by-model` or `--by-dimension`, the report also
evaluates the [item metrics](/guides/metrics/#item-metrics-a-pack-declares) the project's
packs declare, over every item with a run in the same window; a positional `[name]` keeps
only that metric. Text output adds a block of their figures per pack. `--json` adds
`item_metrics`: `{ project, window, items, degraded_items, packs, errors }`, where each pack
lists its metrics' figures and `errors` names a declaration that could not be read, also
reported on stderr. `item_metrics` is null without `--project`, with one of those four
flags, and on the file store, which says so on stderr. A bad declaration does not change the
exit code.

### `tracker`

Bring the [item tracker](/guides/workflow-triggers/#show-progress-on-the-items-tracker) up to date without a running server. Needs the SQL store.

```bash
archon tracker sync [--json]
archon tracker release <project> [--json]
```

`tracker sync` runs one pass over every project in the `itemTracker` config: it posts the status, question, ask, ruling and result comments each item is owed. It is the same pass the server runs every 5 seconds and a CLI process that changed a run runs before it exits. With no `itemTracker` block it says nothing is tracked and exits 0. Text output prints one line per project. `--json` prints `{ ok, projects }`, one entry per project with its `project` and `outcome`:

- `scanned`: `posted` lists each comment written as `{ item, marker }`, and `notPosted` each one the forge did not take as `{ item, marker, errorKind, retried }`. `retried` is true when the next pass tries the write again. What was not posted stays owed.
- `held`: another process is running the project's pass. `heldBy` (`host`, `pid`, `instance`) and `since` name it. It was asked to run one more pass, which shows what this one would have.
- `misconfigured`: the project's forge plugin check failed. `errorKind` names why, and `unsupported` the operations the plugin lacks.
- `failed`: the pass threw; `error` carries the message, and `posted` and `notPosted` what it wrote before it threw. What it did not write stays owed.

It exits 1 only when a project could not be scanned at all (`misconfigured` or `failed`), and then `ok` is false. A `held` project is not a failure.

`tracker release <project>` lets go of a project's pass when its holder is a process this host cannot prove gone, such as one on another host or in a container recreated under another hostname. It refuses, exiting 1, when the holder runs on this host and is still alive, and when the project is not in the `itemTracker` config. It cannot check a holder on another host: release only after confirming that process is gone, since a holder still running its pass overlaps the next one and can post a comment twice or edit the status comment out of order. A pass held by a gone process on the same host needs no release: the next pass takes it over.

### `chat <message>`

Send one message to the orchestrator, print its response and exit. Each invocation creates a new conversation. Multi-turn conversations and project selection through `/setproject <name>` are available in the Web UI and chat adapters. Projectless chat can answer questions; use `archon workflow run <name> --project <owner/repo>` to launch work for a registered repository from the CLI.

```bash
archon chat "What does the orchestrator do?"
```

Chat prints text; `--json` is not supported.

### `trigger`

Start workflows from deployment bindings and inspect durable resource admission; `archon trigger --help` lists the subcommands. A server with `ARCHON_TRIGGER_HOST` set hosts the same bindings without these commands. See [workflow triggers](/guides/workflow-triggers/) for configuration, capacity, overlap policy and recovery.

`trigger fire` refuses a file with `on.runEnded.checkout` or `on.asksSettled.checkout`: a fire has no ended or asking run to take the checkout from, and the stage must never start on the base branch. The message names `workflow run --adopt`, which starts the stage on a run's checkout by hand; for an asks-settled file it names the run to adopt as the one that holds the checkout, `metadata.asks_checkout.handoff.runId` of the asking run (after a read-only asking stage, the run it was given), and lists the inputs the file maps, which adoption does not carry and must be passed with `--input`. When an answer settles a set and a bound stage does not start, `workflow answer` prints the `--adopt` command with that run filled in, or says to run the asking workflow again when no checkout is left.

When a binding fails launch preparation, `trigger fire` exits nonzero and prints the refusal (with `--json`, in `error`). The stored receipt keeps only the failed stage, for example `launch_preparation_failed`. When another process is already preparing the fired binding, `trigger fire` waits for it and reports that preparation's outcome with the same exit code; the refusal itself is printed by that process. If the binding is still preparing after a minute, `trigger fire` exits 0 and prints it with `"status": "preparing"` and that process's `ownerId`, and stderr names `trigger recover-preparation` for when that process has stopped. A binding refused for its [pack's forge needs](/reference/workflow-language/#pack-forge-needs) also stores `forgeRefusal`: `{ pack, failures }`, each failure `{ remote, reason, message, unsupported, remedy }`, with the remote named, never its URL; it is null for every other failure. A worktree start without a named `branch` that is already known to fail is refused here too, before it takes a slot: a project with several remotes and no `origin` or `worktree.remote`, or a project with no remote whose base branch is missing or has no commit. With a remote, the base is fetched when the run starts, and the item's landing branch can replace it then, so a base the remote lacks is admitted and fails on its run. For each admitted or queued start, `trigger fire` prints a note on stderr naming the run or request to watch and saying its checkout is still to be prepared. `trigger whoami` prints the Archon user ID of your CLI identity, for a binding's `runAsUserId`.

`trigger add <file>` places one trigger file in `ARCHON_HOME/triggers/` under its own name, replacing a file of that name, and prints `{"added": <path>}`. It copies the file under a `.tmp` name, which the engine does not read, and renames it into place, so a run that completes meanwhile never reads part of it. It refuses a name that does not end in `.json`, because the engine would never read it, and does not check the file's contents; run `trigger check` after it. Remove a file from the directory to turn it off.

`trigger check` lists every binding with `on` that is active: each file in `ARCHON_HOME/triggers/` with `on.runEnded`, under `runEnded`, or `on.asksSettled`, under `asksSettled`. For each it prints the file, source, binding, host, the trigger it starts on, the workflow it starts, and its `problems`, from checking it against the workflows of the project it launches in. Those are the definitions a start of the binding reads without an item: the binding's base, else the project's default branch, as fetched now, with the launch checkout's uncommitted changes on top (`launch.discoveryCwd`, an in-place binding and a folder project read their directory as it is). The output's `definitions` says so. When a run on an item starts, it checks every binding it may fire against the definitions it captured itself, which come from the item's landing branch when the item records one; it fetches nothing more. For a run-ended binding, the ended workflow exists and declares that outcome and every input the binding reads from it; for an asks-settled binding, the asking workflow exists and declares `returns.asks` and every input the binding reads from it, and, when it declares `returns.options`, the binding's `option` is one of them or `other`. The started workflow exists and accepts the binding's inputs as a start validates them: every input in `launch.inputs` or mapped by the binding is declared, and every required input is supplied by one of them; with `launch.discoveryCwd`, it must resolve from that directory's `.archon/workflows`, as a start requires. For a run-ended binding with `checkout: "ended-run"`, or an asks-settled binding with `checkout: "asking-run"`, neither workflow may pin `worktree.enabled: false`. It also reports what no run is refused for: a `launch.cwd` that does not exist (the binding never starts), a run-ended binding without `linked` that starts the workflow whose end fires it (a loop), and two files that bind the same outcome, or the same settlement, to the same stage in one project with the same `linked` `kind` and `holder`, whatever `items` they name (the stage starts once per file). An asks-settled binding that starts the workflow whose asks settled is not reported: running the same work again with the answers is what the form is for, and it stops when a run leaves no asks. Under `bindings` it lists every other binding: each file in `ARCHON_HOME/triggers/` without `on`, and the config file of each `trigger fire` timer `trigger schedule install` installed for this `ARCHON_HOME`, wherever that file is, read back from the job definitions the scheduler holds. Each entry has the file, source, binding, host, workflow, `cwd`, `schedule`, `timer` (the installed job's definition file, or null) and `problems`, checked against the same definitions: the started workflow exists and accepts the binding's inputs, a timer must supply every required input in `launch.inputs`, and a fire-only file may leave one to `trigger fire --inputs`. A timer whose config file is gone or invalid is listed with that problem and the scheduler command that removes the job by hand. When `ARCHON_WEBHOOK_SOURCES` names sources that declare `observe` (event bindings on an install that receives no webhooks), `observing` lists each as `source`, `everySeconds` and the `labels` its bindings read (`bindingId`, `repo`, `label`), with `watcher`: `installed` and `registered` for this install's [wake job](#wake-timers), or `supported: false` on a host with no scheduler Archon manages. `unwatched` is true when no registered wake job reads them, and `fix` then names the command that installs one. When a registered job's watch has recorded a pass, `watcher.lastPass` holds it, and a failed last pass, or a `lastFailure` of the running watch, adds `problem`, naming when it ran and what it failed on, such as a binding whose run-as user this install does not know. Without `ARCHON_WEBHOOK_SOURCES` in its own environment, the check reads the sources file the job's watch recorded. That is a report, not a problem: a server started with `ARCHON_WEBHOOK_SOURCES` observes too, and the check cannot tell whether one runs for this install, so it does not change the exit code. Without observing sources the field is absent. Under `stops` it lists, as `{ project, workflow, outcome }`, each outcome of a workflow a listed binding names, ended or asking in an `on` file or started by any binding, including a fire-only file or an installed timer, after which a run on an item would [stop the item](/guides/workflow-triggers/#when-nothing-follows-a-run): it is not in the workflow's `returns.final`, no run-ended file in that project binds it, and the workflow declares neither `returns.asks` nor `returns.waits`; `stopsExplained` says so. `stops` is a report, not a problem. The command reads only; it starts, registers and changes nothing. It exits nonzero when any binding has a problem or a file cannot be read. See [check bindings after an update](/guides/workflow-triggers/#check-bindings-after-an-update), [start a stage when a run on an item ends](/guides/workflow-triggers/#start-a-stage-when-a-run-on-an-item-ends) and [start a stage again when its asks are answered](/guides/workflow-triggers/#start-a-stage-again-when-its-asks-are-answered).

A CLI process that ends a run starts the starts its own completion wrote, each on the host its binding names, so a hand `workflow run` needs no trigger host for the next stage to start. Then it drains every host this install serves: the hosts its trigger files in `ARCHON_HOME/triggers` name. A `trigger execute --host <hostId>` process also drains `<hostId>`, since a drain of that host handed it its run; `ARCHON_TRIGGER_HOST` adds no host to a CLI process. So a start queued behind any run that ends on this install, hand-started or not, is admitted when it ends. A host named only by work in the database is another machine's and is left to its own drain. Each [`workflow wake`](#workflow-wake) pass drains the same hosts.

`trigger list` prints each receipt with `itemKey`, the item the start named or null, and `awaitingExecution`: its starts that are admitted but whose run no executor has claimed, as `{requestId, hostId, state, executor}`, read as on [`workflow runs --item`](#workflow-runs). A start reads `unowned` only when nothing can be running it: its hand-off recorded that it started nothing, or the process it was handed to is gone from this host; run it once with `trigger execute <requestId> --host <hostId>`. A start whose admitting process died before recording its hand-off reads `unknown`, as does one whose executor is still booting; check it with `trigger inspect <requestId>` before running it. Each receipt also carries `hold`: the [install hold](#hold) (`{ setBy, setAt }`) while it is set and the receipt has a start it keeps (a binding not yet prepared, or a queued request), else null. `trigger fire` adds the same `hold` to the receipt it prints, and says on stderr that the start waits until the hold is lifted. Each receipt also carries `runLimit`: the [run limit](/reference/configuration/#run-limit) (`{ limit, live }`) while one of the receipt's queued requests waits only for it (the next drain of its host would admit it on its resource), else null. `refusedBindings` lists each binding whose preparation was refused or failed, as `{bindingId, status, error, forgeRefusal}`; a start refused at its binding's [start limit](/guides/workflow-triggers/#limit-how-often-a-stage-starts-on-an-item) is `rejected` with an `error` naming the limit, the item and the starts used.

Run from inside a workflow node, `trigger fire` records the calling run and node as the receipt's `sourceActor` (`{source: "archon-run", id: <run id>, display: <node path>}`); outside a run it records none. A set `WORKFLOW_ID` makes `fire` act as a call from that node: it then requires a matching `ARCHON_NODE_EXECUTION`, and refuses a run the opened store does not know before a receipt is written, so a shell left with a stale `WORKFLOW_ID` fails instead of firing. `trigger inspect <request-id>` and `workflow get <run-id> --json` always carry the requesting run, as `requestedBy` and `requested_by` (`{runId, nodePath}`, or `null` when no run asked for the start), and the plain `workflow get` view prints a `Requested by` line when there is one. The started run still acts as its binding's `runAsUserId`; the requesting run is provenance only.

#### Trigger schedules

`trigger schedule` registers a timer binding with the operating system's own scheduler, so the binding fires with no Archon process running:

```bash
archon trigger schedule install --config <timer-binding.json>
archon trigger schedule status --config <timer-binding.json>
archon trigger schedule remove --config <timer-binding.json>
```

The job runs `archon trigger fire --config <absolute file>` every `schedule.intervalSeconds`, and once when the scheduler loads it if `schedule.runAtLoad` is true: at install and at each login. It runs as the installing user, from the binding's `launch.cwd`, with exactly two variables set: `ARCHON_HOME`, and the `PATH` of the shell that ran `install`. No other variables and no credentials are copied. The job's name is `com.archon.trigger.<id>`, where the id is derived from the Archon home, the source instance and the binding.

| Platform | Scheduler | Files `install` writes |
| --- | --- | --- |
| macOS | launchd, in the user's GUI domain | `~/Library/LaunchAgents/<label>.plist` |
| Linux | a systemd user timer | `<label>.timer` and `<label>.service` in `$XDG_CONFIG_HOME/systemd/user` (default `~/.config/systemd/user`) |
| Windows | Task Scheduler, task `\Archon\<label>` | `<label>.xml` (the task definition) and `<label>.cmd` (the wrapper that sets `ARCHON_HOME` and `PATH`) in `ARCHON_HOME\schedules` |

On every platform the job's standard output and error are appended to `ARCHON_HOME/schedules/<label>.log`. The log is never rotated, and `remove` keeps it.

- `install` is idempotent. An identical job that is loaded is left alone, and one the scheduler has not loaded is loaded. A different job under the same name, for example after `PATH` changed or an upgrade changed the rendered job, is refused with the `remove` command to run first. A macOS timer installed before the log existed is refused this way once.
- `remove` unloads the job and deletes only the files `install` wrote. It succeeds for a job the scheduler has not loaded, and prints `{"bindingId", "schedule": "remove"}` whether or not a job was installed.
- `status` prints `{"bindingId", "schedule": "status", "installed": false}`, or for an installed job `"installed": true` with `path` (the plist, the `.timer` unit or the task XML), `registered` (the scheduler has the job loaded), `log`, and `lastRunAt`: the log's last write time, or null before the job has written to it. A run the scheduler cannot start at all, such as one whose executable is gone, writes nothing to the log, so `lastRunAt` does not move. Read that failure from the scheduler's own record: `launchctl print gui/$(id -u)/<label>` on macOS, `systemctl --user status <label>.service` on Linux, and on Windows the task's history in Task Scheduler, which shows that `conhost.exe` started but not whether `archon` did, so when `lastRunAt` stops moving, check that the `archon` path in the task's action still exists.

`remove` and `status` need no `schedule` in the file, so a timer installed before the file lost it can still be managed.

Platform rules:

- **macOS**: the user must be logged in to a GUI session.
- **Linux**: the timer needs a reachable systemd user manager. It runs while the user has a session; `loginctl enable-linger` keeps it running without one. The service is a `Type=oneshot` unit with `KillMode=process`, so the run `trigger fire` hands to a background process survives `fire`'s exit.
- **Windows**: the task runs as the logged-on user and only while that user is logged on, so it keeps access to the Credential Manager. The task's action is `conhost.exe --headless` running the installing `archon`, which starts the wrapper on a separate desktop (`WinSta0\ArchonSchedules`), so neither the tick nor any process its run starts should show a window, and a prompt a run waits on is never seen. The windowless result is not yet confirmed on a real Windows desktop. When the launcher cannot start the wrapper, it appends a line naming the failed Windows call to the log. The task's last result in Task Scheduler is conhost's, which does not carry the launcher's or the job's exit code, so read failures from the log. A timer installed before this behaviour differs from the one `install` renders now, so `install` refuses it until it is removed. The interval must be a whole number of minutes from 1 minute to 31 days, a path or `PATH` entry, including the path of the `archon` that installs the task, must not contain a double quote, and neither `ARCHON_HOME` nor that `archon` path may contain `%`. A tick that comes while the previous tick's `trigger fire` is still going is skipped; the workflow that `fire` started is not part of the task, so a start from a later tick follows the binding's overlap policy.

On any other host, or on Linux without a reachable `systemctl --user`, `install` refuses and prints the command to schedule by hand, with its interval; see [drive the same commands from another scheduler](/guides/workflow-triggers/#drive-the-same-commands-from-another-scheduler).

To undo an install by hand: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`; `systemctl --user disable --now <label>.timer`, then delete the two unit files; or `schtasks /Delete /TN \Archon\<label> /F`, then delete the two files.

#### Items

An item is the durable thing runs are about: a key within a project, such as an issue reference. The engine gives the key no meaning and never parses it; it is 1 to 200 characters. The one reader that does is the [item tracker](/guides/workflow-triggers/#show-progress-on-the-items-tracker), and only by the key rules the deployment configures. `trigger fire --item <key>` and `workflow run --item <key>` name the item of the run they start, and that run's `item_id` points at it. The item is created the first time a start or run names it, before a queued start is admitted; naming the same key again in the same project is the same item, and the same key in another project is a different one.

A `trigger fire` from inside a run that names no item inherits that run's item, so follow-up starts stay on it; from inside a `workflow:` sub-run it inherits the item of the top-level run. Inheritance stays inside the item's project. When the binding starts its run in another project, the fire is refused before anything is recorded or started, with a message that names both projects: pass `--item <key>` to name the item in that project, or `--no-item` to start it on none. A named item is always accepted, and names the item with that key in the started run's own project. `--no-item` starts the run on no item, from inside a run or outside one; it cannot be combined with `--item`. A [script](/guides/script-nodes/#the-script-api) passes the same choice as `trigger.fire`'s `item` option.

A binding can also [map its item from its event](/guides/workflow-triggers/#put-a-start-on-the-item-its-event-names): a field of the fire's `--inputs`, or of a webhook event, with an optional fixed prefix. A fire's item is chosen in this order: `--item`, then the binding's mapping, then the calling run's item. A binding that maps its item never inherits one, and a fire whose inputs lack the mapped field is refused before anything is recorded, naming the binding and the field.

A continuation started with `--adopt <run-id>` or `--supersedes <run-id>` and no `--item` belongs to the item of the run it continues, so a fix round or a rerun stays in the item's history. `--item <key>` names another item instead, and a continuation of a run with no item has none. `--supersedes` can name a run of another project by its full id; that run's item cannot be inherited, so the continuation is refused before it starts unless it passes `--item`. The same holds when the continuation has no registered project. A continuation of a run with no item starts in every case.

A fresh start on an item runs on the [run config](#per-run-config-files) the item's most recent run was started with, so a later round keeps the config the item was started on. This holds for a binding start (`trigger fire`, a run-ended or an asks-settled binding) and for `workflow run` on an item, by `--item` or inherited through `--supersedes`, that passes neither `--config` nor `--config-from-run`. That item is the one in the project the run starts in, so `workflow run --project <name> --item <key>` reads the item in the selected project, the one the run is written onto. An `--adopt` start inherits the adopted run's AI configuration instead. The new run records where that config came from: its `metadata.run_config.source.label` reads `run <id> (<label>)`, naming the run it was carried from, one level more for each run it is carried through. A binding start on an item applies the binding's own `launch.configSource` only while the item's most recent run recorded no config, or the item has no run yet; with neither, it runs on the install's config, as before. A binding start on no item applies `launch.configSource` as before. To change an item's config, start a run on it with `workflow run --item <key> --config <file>`; later starts carry that one. A `--config` file with no keys returns the item to the install's config. When the item's most recent run cannot be read, the start is refused: a binding start is rejected as `run_configuration_failed`, and `workflow run` exits with an error naming the run. It never falls back to an older run or to the install's config. A start on no item reads no earlier run.

A run started with no item, and no run to inherit one from, has none. One item is worked by at most one run of a workflow at a time: a start of a workflow on an item waits, or is skipped or refused, while another run of that workflow on the item is not terminal. See [one run of a workflow per item](/guides/workflow-triggers/#one-run-of-a-workflow-per-item). `archon workflow runs --item <key>` reads an item: its runs, open questions, and answers with rulings. Each run carries its `cause`: the run whose end started it, the run whose asks settling started it, the run and node that fired it, the trigger source that started it, or `null` for a start by hand, and `hasResult`: whether it completed with a readable `returns:` value, which `archon workflow get <id> --json` shows at `terminal_record.returns.value` and a later run on the item reads through a [`result_of` input](/reference/workflow-language/#reading-an-earlier-runs-result), and `resultCommit`: the commit that result holds at, which an [`at: checkout`](/reference/workflow-language/#the-result-that-holds-at-this-runs-commit) input matches, or `null`. `GET /api/items?project=<project>&key=<key>` is the same read over HTTP. `workflow wait`, `cancel` and `abandon` also accept `--item <key>` and never choose between an item's runs: `wait` reports every run that settled, and `cancel` and `abandon` refuse when more than one run applies unless `--all-runs` is passed.

`archon workflow items` reads every item of the project that had a run in a window, a page at a time ([`workflow items`](#workflow-items)).

The merge of an item's change is the one fact about it that comes from outside the engine. The caller that saw the forge report it records it once with [`workflow merged`](#workflow-merged), and every read of the item carries it as `merged`. A merge a run on the item makes through `archon forge pr.merge` is recorded by itself, with its landing branch, when the forge plugin reports the merge time.

A ruling is a decision recorded on the item without a question having been asked ([`workflow rule`](#workflow-rule)). It is a fact about the item, like an answer, and needs no run: recording one on a key nothing has named writes the item. Withdrawing a ruling keeps the record and marks it withdrawn. A workflow reads its item's answers and rulings through `archon:script` [`item()`](/reference/workflow-language/#reading-the-item-a-run-belongs-to); the engine passes them to no node on its own.

The branch an item's change lands on is a fact of the item too, recorded with [`workflow landing`](#workflow-landing). Every fresh run on the item, and on an item `part_of` it that records none, is cut from that branch and proposes against it.

A link is a directed relation from one item to another: `depends_on`, `part_of` or `duplicate_of` ([`workflow link`](#workflow-link)). Only accepted links are recorded. Both items' reads show it, with its direction. Ending a link keeps the record with who ended it and when. The engine acts on a link only as [`workflow link`](#workflow-link) describes. Otherwise what a link means for an item is for a reading node to judge.

Items need the database store and a registered project. With `store: files`, or in a directory with no project, naming, reading or listing an item fails; it is never read as empty.

### `hold`

Hold all new work on the install, and lift the hold. The hold is a row in the install's database, so every process that uses that database sees it, and it stays set through restarts until someone lifts it. Nothing lifts it on a timer.

```bash
archon hold set          # no new run starts until the hold is lifted
archon hold lift         # lift it and start what it kept
archon hold set --json   # { hold: { setBy, setAt }, alreadySet }
archon hold lift --json  # { lifted, drainedHosts, failures, elsewhere }
```

`hold set` records your CLI identity (`ARCHON_USER_ID`, else `$USER`) and the time. Setting it again keeps the first hold and says who set it. While it is set, admission admits no new run from any source:

- A timer, a webhook or poll, a `trigger fire`, a run that ends with a [run-ended](/guides/workflow-triggers/#start-a-stage-when-a-run-on-an-item-ends) hand-off it owes, and an [asks-settled](/guides/workflow-triggers/#start-a-stage-again-when-its-asks-are-answered) hand-off still record their receipt, but the binding is not prepared: it stays pending and nothing is admitted, queued or skipped.
- Requests already queued for capacity are not admitted; they keep their places. `trigger drain` drains nothing and prints `{ hostId, drained: false, hold }`; without the hold it prints `{ hostId, drained: true, hold: null }`.
- A hand start (`workflow run`, chat, Web or API) creates its `pending` run and waits for the lift in the process that started it, printing `Waiting for the install hold`. With `--no-wait` it is refused and its run cancelled. A start that waits dies with its process, as a start waiting for a full resource does.

Runs already running or paused are not touched: they finish, pause, resume and take answers as usual. A run admitted before the hold, and a `workflow:` child of a running run, still start.

`hold lift` removes the hold, then drains every host this install serves (the hosts its trigger files name), as [`trigger drain`](#trigger) does: each held binding is prepared in arrival order (its workflow source and run configuration are captured now, not when it fired) and then admitted, queued or skipped by its binding's `overlap`, so an `overlap: skip` start is skipped only for capacity, its item or its checkout, never for the hold. Each start is admitted at most once. Waiting hand starts start on their next poll, and a server hosting triggers picks the rest up on its next pass. Held work on a host no trigger file on this install names is another machine's: the lift leaves it for that host's own drain and lists the host under `elsewhere`. A host whose drain fails is named on stderr with the `trigger drain --host` command to retry, and the command exits 1; the hold is lifted either way.

The hold needs the database store; with `store: files` setting it is refused. A binary older than the hold does not read it and admits as before, so every process on the install must run a version that knows it.

### `pack graph`

Show how a pack's stages connect in this install: each stage with the outcomes it can end with and its nodes, and every arrow between them: [run-ended](/guides/workflow-triggers/#start-a-stage-when-a-run-on-an-item-ends) and [asks-settled](/guides/workflow-triggers/#start-a-stage-again-when-its-asks-are-answered).

```bash
archon pack graph <pack> [--cwd <checkout>] [--workflow-source <dir>] [--json]
```

- `<pack>` is discovered from `--cwd` as `pack bindings` discovers it, and the arrows are those of that checkout's project. With `--workflow-source`, the pack is discovered from there instead, as a binding's `launch.discoveryCwd` discovers it, including [a pack's own folder](#a-pack-folder-as-the-source); the arrows are still those of `--cwd`'s project.
- The output starts with the copy of the pack it read and that copy's directory, then every other copy of the same pack in reach under another name, such as the installed `<owner>.<name>` beside a local `<name>`, with the name that reads it. For an installed copy found under `--workflow-source`, the hint says to drop the flag: a binding discovered from that source refuses an installed workflow. `--json` has them as `loaded` and `otherCopies`, each `{ source, key, dir }`.
- Each active arrow is checked as a run is checked before it starts. A file that check refuses is shown as `[active, refused: <problem>]`: every run of its source stage on an item is refused until the file is fixed. A file whose `launch.cwd` no longer exists is shown refused too, because the end of a run never starts it.
- A declared binding that names a workflow which did not load as a stage is shown with that problem after its arrow, and the load error is listed with the other workflows that failed to load.
- An arrow from a run-ended binding prints as `<stage>:<outcome> -> <stage>`, and one from an asks-settled binding as `<stage>:asks(<settled>) -> <stage>`; in `--json` its `from` is `{ stage, settled }` in place of `{ stage, outcome }`. A linked arrow adds `linked <kind> <holder>`, then `, items <pointer>` when it names its items and `, <input> from entry <pointer>` for each input read from the started item's own entry; in `--json` that is the arrow's `linked` with its `entries`, `null` for an arrow that starts on the ended run's own item.
- An arrow the pack declares as a [`run_ended:` or `asks_settled:` binding](/reference/workflow-language/#pack-bindings) is `active` when a trigger file in `ARCHON_HOME/triggers/` launches it in this project, and declared and inactive when none does. A trigger file the pack does not declare is an active arrow with `declared: null`.
- Each outcome value has `startsNothing` when no active arrow without problems leaves it, and `final` when the stage lists it in `returns.final`. The text output lists the values that start nothing and are not final, marking `(item stops)` each of a stage that declares neither `asks` nor `waits`: a run on an item that ends in one stops the item, which `workflow attention` lists.
- `--json` prints the read, the same shape as [`GET /api/packs/{pack}/graph`](/reference/api/#workflows). The guide shows [the shape and how to draw an item's path with it](/guides/workflow-triggers/#see-how-a-packs-stages-connect).

Workflows that failed to load are listed after the graph, because a stage among them is missing from it. An invalid trigger file fails the command, as it fails item runs. With `store: files`, any run-ended or asks-settled file in the triggers directory is refused, as `trigger check` refuses it.

### `pack bindings`

Write the [trigger bindings a pack declares](/reference/workflow-language/#pack-bindings) as files for one repository. The command registers and schedules nothing; it prints what registers each file.

```bash
archon pack bindings <pack> \
  --repo <host>/<owner>/<name> \
  --host <host-id> \
  --run-as <user-id> \
  --out <dir> \
  [--cwd <checkout>] [--config <file>] [--workflow-source <dir>] \
  [--only <id,...>] [--force]
```

- `<pack>` is the pack's folder name (`sdlc`), or `<owner>.<name>` for an installed pack. It is discovered from `--cwd` as a run there would find it, so a project's copy of a pack wins over the bundled one. With `--workflow-source`, it is discovered from there instead, including [a pack's own folder](#a-pack-folder-as-the-source). The output names the copy it read and any other copy in reach, as `pack graph` does; `--json` carries them as `loaded` and `otherCopies`.
- `--repo` is the repository the bindings act on, such as `github.com/acme/widgets`.
- `--host` is the execution host the starts are assigned to: the server's `ARCHON_TRIGGER_HOST`, or the host you pass to `trigger drain`.
- `--run-as` is the Archon user the runs act as; `archon trigger whoami` prints yours. The command does not check that the user exists; `trigger schedule install` and a webhook delivery do.
- `--cwd` is the checkout the runs launch in (default: the current directory). It is written as an absolute path.
- `--config` is the default [run config](#per-run-config-files) of the written bindings' starts, written as `launch.configSource`. It is how model aliases reach a start without the pack naming a model. The file is loaded once before anything is written, so a bad path fails here. A start on an item whose most recent run recorded a config carries that run's config instead, so editing this file does not change items already in flight; `workflow run --item <key> --config <file>` changes an item's config (see [Items](#items)).
- `--workflow-source` is the directory the pack's workflows are discovered from when the pack does not live in the checkout, written as `launch.discoveryCwd`, as `workflow run --workflow-source` uses it. When its workflow does not resolve from `<dir>/.archon/workflows`, every start of the binding is refused, whatever starts it; a bundled, global or installed workflow of the same name never runs in its place. `archon trigger check` reports such a binding once its file is in the triggers directory or an installed timer fires it.
- `--out` is where the files go. Each is named `<pack>-<owner>-<name>-<binding id>-<digest>.json`, where the digest is of the pack, repository host and path, and binding ID, so two packs or repositories never share a name. That name without `.json` is its binding ID and its `sourceInstanceId`.
- `--only` writes the listed bindings. A binding whose input names another binding's file needs that binding listed too, or its file already in `--out`.
- `--force` replaces existing files. Without it, one existing file refuses the whole set and nothing is written.

A timer binding is written as a complete `trigger fire --config` file. A fire-only binding is the same file without `schedule`, with the binding's `item` mapping when it declares one; the command lists it under its own heading with the `trigger fire` command that starts it, and `trigger schedule install` refuses it. An event binding, with its `item` mapping and its `wake` (the waiting workflow, the wait, `about` as `{ "field" }`, and the `{ wait: true }` input's name as `input`), is written as one object for the `bindings` array of the GitHub source plugin's `config`, in the file `ARCHON_WEBHOOK_SOURCES` names, because the plugin reads bindings only from there. The plugin accepts `github.com` repositories, so the command refuses to write an event binding for another host. A [run-ended binding](/guides/workflow-triggers/#start-a-stage-when-a-run-on-an-item-ends) is written as one trigger file per outcome it declares, named `<pack>-<owner>-<name>-<binding id>-<outcome>-<digest>.json`. The command prints the `trigger add` that registers each and runs none of them: the engine reads `ARCHON_HOME/triggers/` at every completion, so a file added there is active at once, `archon trigger check` lists it, and deleting it turns it off. Because one invalid file there fails item runs on the whole install, every run-ended file is checked as `trigger check` checks it (the ended workflow declares the outcome and every input read from it, the started workflow accepts the inputs mapped to it and the binding's `launch.inputs` as a start would, `launch.cwd` exists, and the binding does not start the workflow whose end fires it unless it is `linked`) before any file is written. A duplicate of a file already in the triggers directory, or of one in another checkout of the same project, is left to `trigger check`, which reads the install's projects, and the command refuses run-ended bindings on `store: files`. An [asks-settled binding](/guides/workflow-triggers/#start-a-stage-again-when-its-asks-are-answered) is written as one trigger file per `option` it lists, named with the option as a run-ended file is with its outcome, or as one file when it lists none. They are registered and checked the same way before any file is written: the asking workflow declares `returns.asks` and every input read from it (and each listed option, when it declares `returns.options`), the started workflow accepts the inputs mapped to it, including `{ answers: true }` and `{ item: answers }` ones, and its `launch.inputs`, `launch.cwd` exists, and no two files would both start when one option is chosen. A run-ended binding's `linked` is written into the file's `on.runEnded`. A `checkout` on either form is written into the file's `on`, and with it neither workflow may pin `worktree.enabled: false`. Every file is checked against the schema of the loader that will read it before any is written. `--json` prints `{"pack", "written": [{"id", "kind", "path"}]}`, where `kind` is `timer`, `event`, `fire`, `run_ended` or `asks_settled`, a `run_ended` entry also has its `outcome`, and an `asks_settled` entry that names an option has its `option`.

```bash
archon pack bindings sdlc --repo github.com/acme/widgets --host build-host-1 \
  --run-as 2a568f73-e217-40ca-b17d-a784d19fd43a --cwd /srv/archon/widgets --out /srv/archon/bindings
# the build-queue path the command printed; another repository's file names a different one
BINDING=/srv/archon/bindings/sdlc-acme-widgets-build-queue-0297fdfa94d5.json
archon trigger fire --config "$BINDING"
archon trigger schedule install --config "$BINDING"
```

### `forge`

`archon forge <operation> --data <json>` runs one forge operation through the installed forge plugin; `archon forge --help` lists the operations. Reads return structured observations. Writes report whether they were applied and verified, refused, applied but unverified, or left with an unknown outcome. Pass a request that carries authored text with `--data-file <path>` so it stays out of argv. `archon forge metadata --data '{"host":"github.com"}' --json` inspects the selected plugin's capabilities without credentials or a forge operation.

`archon forge check --data '{"host":"github.com","operations":["pr.view","pr.merge"]}' --json` answers, before a workflow spends on agents, whether a plugin serves the host, supports every named operation and has a credential. Pass `remote` (a git remote URL) instead of `host` to select the plugin a `resolve` of that remote would, or `repo` (`{"host":…,"path":…}`) to name a repository. A `host` check runs no forge operation; a `remote` or `repo` check whose plugin advertises `pr.view` also makes one read with the credential, a `pr.view` by head that needs pull-request read on the repository, and refuses `authorization` for a credential the forge rejects or that lacks that permission and `not_found` for a repository it cannot see. It exits 1 with a typed reason and, for a reason the operator fixes, a `remedy`. The engine runs it at the start of every run of a pack that declares forge needs. See [Check forge access before a run spends](/reference/forge/#check-forge-access-before-a-run-spends).

A Bun `script:` node calls these operations through `forge(op, request)` from the `archon:script` module; see [`script types`](#script-types).

See [Forge operations](/reference/forge/) for request shapes, plugin configuration, credentials and audit behavior. The bundled SDLC pack reaches the forge only through a plugin that implements every operation it needs. See [Use the forge path in the SDLC pack](/reference/forge/#use-the-forge-path-in-the-sdlc-pack).

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

`--chat-project-id <registered-project-id>` scopes every run lookup to that project, for example `archon workflow get <run-id> --chat-project-id <id> --json`. Copilot and OpenCode chat receive it in their CLI instructions. Every full ID or prefix must match exactly one run in the project before the command reads or changes it, and launches and continuations must belong to it; use `/setproject` to change projects. Run lists, status, open work and attention list, count and watch use the project, subject to each command's directory check, and reject `--all` or an attention `--project` naming another project. `workflow rule` records on the selected project's items, and `--withdraw` refuses a ruling on another project's item. An empty or unregistered scope fails instead of falling back to install-wide queries. The scope comes only from the argument, so the working directory and Archon env files cannot change, clear or supply it; `ARCHON_WORKFLOW_CODEBASE_ID` no longer selects a project. Without the argument, full run IDs keep their install-wide operator behavior and short prefixes resolve from the current project. It scopes run lookup, not process permissions.

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

The CLI starts from `--cwd`, or the current directory. A subdirectory such as `/repo/packages/cli` resolves to the nearest git repository root, `/repo`. A nested repository resolves as its own codebase and registers on first workflow use, or earlier with [`project add`](#project-add). Linked worktrees resolve to their registered source codebase. Ordinary subdirectories of registered folder projects continue to resolve to the registered folder. An exact folder registration wins over git detection. `--folder` retains the supplied directory rather than selecting a surrounding git root. Linked Git worktrees do not inherit a folder registration from the primary checkout. Listing commands do not register projects.

When project registration fails, the command fails with the registration error, even with `--no-worktree`. Registering a second clone of an already-registered remote is refused with the registered project's path; use worktrees (`--branch`) for parallel checkouts. To bind a separate clone to the existing project, use its registered ID or exact name:

```bash
archon project list
archon workflow run archon-investigate --project owner/repo --cwd /other/clone --no-worktree "Investigate the failing build"
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
3. Loads `<cwd>/.archon/.env` (project scope), which overrides home scope except for `GH_CONFIG_DIR` and inherited workflow identity. The CLI keeps the home-scope `GH_CONFIG_DIR`, including its absence; inside a workflow, and in the start-time forge check of a pack that declares `forge:`, an inherited login directory takes precedence over both files. See [forge configuration](/reference/forge/#plugin-configuration). Steps 2 and 3 print `[archon] loaded N keys …` only when `ARCHON_VERBOSE_BOOT=1` or `LOG_LEVEL` is `debug` or `trace`.
4. Sets `CLAUDE_USE_GLOBAL_AUTH=true` when neither `CLAUDE_API_KEY` nor `CLAUDE_CODE_OAUTH_TOKEN` is set and the variable is not already set. The variable is only the server's startup-check marker; Claude Code ignores it and uses your `claude /login` session whenever no token or key is set.

A detached run's child process restores Archon's install-context keys (`TOKEN_ENCRYPTION_KEY`, `ARCHON_HOME`, `ARCHON_DOCKER`, `WORKSPACE_PATH`, `HOME` and `USERPROFILE`) from the trusted detached config, never from the project `.env`.

`<cwd>/.env` is never loaded; it belongs to the target project. Put install credentials such as `GH_TOKEN` in `~/.archon/.env`, which passes through to AI subprocesses. See [target repo env isolation](/reference/security/#target-repo-env-isolation) and [`.env` file locations](/reference/configuration/#env-file-locations).

## Database

Without `DATABASE_URL`, the CLI uses SQLite at `~/.archon/archon.db`, created on first run. With `DATABASE_URL` it uses PostgreSQL. See [Database](/reference/database/).
