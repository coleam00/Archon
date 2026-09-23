---
title: Forge operations
description: Resolve repositories and read qualified pull-request checks through optional executable plugins.
category: reference
area: cli
audience: [user]
status: current
---

Forge operations load only when a caller invokes `archon forge`. Local workflows and SDK execution do not discover plugins or require forge credentials.

## Install the GitHub plugin

GitHub is an optional, independently executable plugin. Its source is temporarily housed under `packages/adapters/src/forge/github`; the entry point imports the public forge contract and its own vendor code, not Archon's engine or adapter host. The CLI does not inject or require a GitHub implementation.

From an Archon source checkout on POSIX:

```sh
bun run --cwd packages/adapters build:github-plugin
mkdir -p "${ARCHON_HOME:-$HOME/.archon}/plugins"
cp packages/adapters/dist/archon-forge-github "${ARCHON_HOME:-$HOME/.archon}/plugins/"
```

On Windows, compile the same entry point with `bun build --compile packages/adapters/src/forge/github/plugin.ts --outfile <plugin-directory>/archon-forge-github.exe`. The plugin directory must exist. The resulting native executable runs without the source checkout. Alternatively, configure its absolute executable path under `forge.plugins` below.

The eventual single marketplace will distribute forge plugins, agent providers, workflow packs, chat integrations, webhook sources, themes and other plugin kinds. The Archon-maintained GitHub plugin will move to its own repository and install through that marketplace, optionally during setup. That changes packaging and location, not this runtime protocol. The marketplace and a mandatory setup install are not prerequisites today. Other production forges are community-maintained; the existing bundled Gitea/GitLab transition is not settled by this contract.

## Commands

```sh
archon forge resolve --data '{"remote":"git@github.com:owner/repository.git"}'
archon forge checks --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
```

Both commands emit JSON. `resolve` takes an explicit remote, including `null` for no remote. A local or unclaimed remote returns `{ "kind": "none", "forge": "none" }` inside the success result. It performs no HTTP host probe. `checks` requires a qualified repository and PR number; it never infers them from the checkout.

Exit 0 means the observation succeeded, even when checks are red. Exit 1 means the operation or its input failed. Exit 2 means the operation completed but its run audit could not be persisted; stdout retains the actual result.

## GitHub credentials and check observations

The GitHub plugin uses `GH_TOKEN` or `GITHUB_TOKEN`. The dispatcher passes the selected value to the child as `ARCHON_FORGE_TOKEN`. Tokens never belong in command arguments, JSON requests or remote URLs.

Checks identify the evaluated revision and each check-run or commit-status unit. GitHub enumeration includes current check runs and the latest status for each context. The plugin preserves distinct runs with the same name. It does not use GitHub's aggregate status as evidence that checks exist.

The summary states are `none`, `pending`, `green`, `red`, `gated` and `unknown`. `none` means zero enumerated units. The summary precedence is red, gated, unknown, pending, then green. `gated` names an explicit action-required conclusion; missing checks are not evidence of an approval gate. Unrecognized vendor states remain unknown with their native value retained.

`required` is null when no authoritative required set was obtained. The current GitHub plugin returns null; it does not infer branch protection from check names.

## Use forge checks in the SDLC pack

The bundled SDLC deliver pack reads checks through `gh` by default. Forge reads are an explicit opt-in until the GitHub plugin installs through the marketplace. To opt in, install a plugin for the PR's host and set `ARCHON_SDLC_FORGE=forge` in the environment Archon runs with, for example `~/.archon/.env`. A value other than `gh` or `forge` fails the check steps.

With the opt-in, the pack prefers a supplied required set, otherwise it uses the full observation. It classifies each GitHub check the same way through either source and applies the same gate policy: it waits once for registration when no checks exist and refuses the final ready preflight for pending, red, gated, unknown or failed reads. The workflow owns this policy. Archon never switches to the forge path because a plugin is installed, and a selected forge path that cannot answer never falls back to `gh`: the CI probe and the ready flip fail with the reason, for example `no forge plugin claims <host>`.

## Plugin configuration

Put trusted executable configuration in the user Archon config, `~/.archon/config.yaml` (or the directory selected by `ARCHON_HOME`). Repository configuration does not install or select executable plugins. The CLI captures the user-scoped config path and execution environment before loading repository `.archon/.env` overrides. Repository env may supply a credential named by trusted plugin configuration, but cannot redirect plugin discovery or execution through `ARCHON_HOME`, `PATH` or home-directory overrides.

```yaml
forge:
  hosts:
    github.example.com:
      plugin: github
      token_env: COMPANY_GITHUB_TOKEN
  plugins:
    - plugin: company-forge
      command: /absolute/path/to/python
      args: [/absolute/path/to/plugin.py]
  scanPath: true
```

A host mapping may name a discovered plugin directly, or supply `plugin`, an absolute `command`, interpreter `args`, and `token_env`. The GitHub plugin supports explicitly mapped GitHub Enterprise hosts at `https://HOST/api/v3`.

Discovery examines configured executables, `~/.archon/plugins`, configured `pluginDirs`, and PATH names beginning with `archon-forge-`. Duplicate identities or host claims fail loudly. Failed explicitly configured or host-selected plugins fail discovery. An unrelated automatically scanned candidate with a failed metadata handshake is reported on stderr and skipped when another valid plugin serves the requested host. If no valid plugin serves it and any candidate failed, resolution fails rather than reporting no forge. No forge is injected as an implicit fallback. No remote URL can select an arbitrary executable.

## Executable protocol

The authoritative Zod schemas and derived TypeScript types are exported by `@archon/forge/operations`. Dispatch and configuration are separate exports, `@archon/forge/dispatch` and `@archon/forge/plugin-config`.

`@archon/forge/conformance` exports `runForgeReadConformance` for controlled repository fixtures. Pass the plugin operation function and cases naming the expected revision, state and exact unit identities. The kit validates the response schema, correlation, qualified target, counts and summary.

The host invokes `PLUGIN metadata` before any operation. Metadata declares integer protocol version 1, plugin name/version, forge family, static hosts, operation capabilities and credential environment names. Protocol incompatibility and unsupported operations fail before operation execution.

For an operation, the host invokes `PLUGIN op OPERATION` (`resolve` or `checks.state`), sends one JSON request on stdin and expects one JSON response on stdout. Write explicit UTF-8 bytes. Diagnostics go to stderr. Exit 0 carries a success response; exit 1 carries a structured operation error. Other exits, malformed JSON and mismatched operation/target identity are process or protocol failures.

The host limits combined output to 16 MiB and kills the process tree on timeout. It supplies selected runtime environment variables and the resolved token, with value-based token redaction on captured output. Windows may inject additional system environment variables. Installed plugin code is trusted code and can access files under its operating-system identity.

On Windows, discovered executables must have an `.exe` extension. `.cmd` and `.bat` are unsupported. Scripts use explicit interpreter argv; no platform invokes a shell to interpret plugin arguments. Windows termination uses `taskkill /T /F`; POSIX termination uses a process group.

## Workflow host integration and audit

The CLI and the server both set `ARCHON_CLI_COMMAND` at startup to a JSON argv array for the install's CLI: the executable of a compiled binary, or the Bun runtime and CLI source entry in a source checkout. Runs launched from the CLI, the Web UI or a chat or forge adapter therefore see the same value. Bundled scripts append command arguments without shell parsing. An SDK host must supply its own argv array. A container execution does not receive the variable, because a host binary path is not assumed to exist in a container.

When `WORKFLOW_ID` is present, the CLI persists an `integration_operation` event through its database host. The forge payload retains operation correlation, qualified target, plugin identity/version, exact result and duration. The engine does not interpret the forge payload. The CLI reports persistence failure separately from the operation's observed outcome.
