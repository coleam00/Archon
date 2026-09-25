---
title: Forge operations
description: Resolve repositories, read qualified pull-request checks, and perform verified pull-request writes through optional executable plugins.
category: reference
area: cli
audience: [user]
status: current
---

Forge operations load only when a caller invokes `archon forge`. Local workflows and SDK execution do not discover plugins or require forge credentials.

## Install the GitHub plugin

GitHub is an optional, independently executable plugin. Its source is temporarily housed under `packages/adapters/src/forge/github`; the entry point imports the public forge contract and its own vendor code, not Archon's engine or adapter host. The CLI does not inject or require a GitHub implementation.

Each Archon release publishes the plugin as a native executable for every platform the CLI ships on. Install it with:

```sh
archon plugin install coleam00/Archon/plugins/forge-github
```

This works the same for the release binary, a source checkout, and [Docker](/deployment/docker/#forge-plugins). Without `@<tag>` it installs from the latest Archon release; `coleam00/Archon/plugins/forge-github@<tag>` pins one. The command:

- resolves the tag to a commit with `git ls-remote` and reads `plugins/forge-github/archon-plugin.json` at that commit. It calls no GitHub API and needs no token.
- downloads `archon-forge-github-<os>-<arch>[.exe]` from that release and checks it against the release's `checksums.txt`. A mismatch installs nothing.
- writes it to `ARCHON_HOME/plugins/`, where discovery finds it, and records a receipt under `ARCHON_HOME/plugins/installed/`.
- refuses to replace an `archon-forge-github` file that it did not install. Move a hand-built copy away first.

The checksum catches a corrupted download or an asset that does not belong to the release. It does not vouch for the publisher: installing runs code from the repository owner, and the command prints that owner and the commit.

Manage the install with:

```sh
archon plugin list                                                 # id, kind, tag, commit, compatibility
archon plugin update coleam00/Archon/plugins/forge-github          # latest release; add @<tag> to pick one
archon plugin remove coleam00/Archon/plugins/forge-github          # deletes only the files the receipt lists
```

Nothing updates in the background. To build the plugin yourself instead, compile `packages/adapters/src/forge/github/plugin.ts` from a source checkout (`bun run --cwd packages/adapters build:github-plugin`, or `bun build --compile <entry> --outfile archon-forge-github.exe` on Windows) and copy the executable into `ARCHON_HOME/plugins/`, or configure its absolute path under `forge.plugins` below. `archon plugin` leaves such a file alone.

The eventual single marketplace will distribute forge plugins, agent providers, workflow packs, chat integrations, webhook sources, themes and other plugin kinds. The Archon-maintained GitHub plugin will move to its own repository and install through that marketplace, optionally during setup. That changes packaging and location, not this runtime protocol. The marketplace and a mandatory setup install are not prerequisites today. Other production forges are community-maintained; the existing bundled Gitea/GitLab transition is not settled by this contract.

## Commands

```sh
archon forge resolve --data '{"remote":"git@github.com:owner/repository.git"}'
archon forge checks --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge workitem.view --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":31}}'
archon forge pr.view --data '{"selector":{"kind":"number","ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}}'
archon forge pr.create --data-file ./create.json
archon forge pr.edit-body --data-file ./body.json
archon forge pr.ready --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge comment.upsert --data-file ./comment.json
```

Every command emits JSON. `resolve` takes an explicit remote, including `null` for no remote. A local or unclaimed remote returns `{ "kind": "none", "forge": "none" }` inside the success result. It performs no HTTP host probe. Every other operation names its target explicitly: a qualified repository for `pr.create` and for a `pr.view` head selector, a qualified repository and number otherwise. None is inferred from the checkout.

`pr.view` accepts either selector: `{"kind":"number","ref":…}`, or `{"kind":"head","repo":…,"headRepo":…,"head":"branch"}` with an optional `base`. The head form answers "does this branch have a pull request", so it resolves the **open** one and returns `null` when there is none. A head matching more than one open pull request is a conflict rather than a guess.

`--data-file <path>` reads the same JSON request from a file. Authored content — a pull-request body, a review comment — belongs there rather than in `--data`, so it never appears in any process's argument list.

Exit 0 means the operation succeeded. Exit 1 means it failed. Exit 2 means the operation returned a response but its run audit could not be persisted. Stdout retains that response, which may be a success or a failed write with its mutation outcome; read it before retrying or reconciling, because exit 2 alone does not say whether a write happened.

## What a write reports

`pr.create`, `pr.edit-body`, `pr.ready` and `comment.upsert` each perform at most one write and then read the result back. A valid write request reports exactly one outcome, so a caller never has to guess which happened. A request that fails validation before dispatch is answered with `invalid_request` and no `mutation`; nothing was written.

| Outcome | Shape | What it means |
| --- | --- | --- |
| applied | `ok: true`, `result.value.outcome: "applied"` | The write was performed and read back. `changed: false` means the forge already carried the requested state and nothing was submitted. |
| refused | `ok: false`, `mutation.outcome: "refused"` | Nothing was written. The forge answered with a refusal, or the request was rejected before submission. |
| verification failed | `ok: false`, `mutation.outcome: "verification_failed"` | The write was acknowledged, but the read-back disagreed or could not run. `leaveBehind` names what may remain on the forge. |
| outcome unknown | `ok: false`, `mutation.outcome: "outcome_unknown"` | The request was submitted and its answer was lost, or the plugin's answer cannot show whether the write was applied (see the executable protocol below). Reconcile before retrying. |

A read-back never claims to have *prevented* a wrong write; it only reports what it could and could not confirm. A vendor that accepts a write and silently does not apply it is reported as a verification failure, never as success.

`comment.upsert` writes the one comment whose first line is the exact `marker`, creating it when absent and replacing it in place when present. A body that does not begin with that marker is refused, and more than one marked comment is a conflict.

## GitHub credentials and check observations

The GitHub plugin uses `GH_TOKEN` or `GITHUB_TOKEN`. The dispatcher passes the selected value to the child as `ARCHON_FORGE_TOKEN`. Tokens never belong in command arguments, JSON requests or remote URLs.

Checks identify the evaluated revision and each check-run or commit-status unit. GitHub enumeration includes current check runs and the latest status for each context. The plugin preserves distinct runs with the same name. It does not use GitHub's aggregate status as evidence that checks exist.

The summary states are `none`, `pending`, `green`, `red`, `gated` and `unknown`. `none` means zero enumerated units. The summary precedence is red, gated, unknown, pending, then green. `gated` names an explicit action-required conclusion; missing checks are not evidence of an approval gate. Unrecognized vendor states remain unknown with their native value retained.

`required` is null when no authoritative required set was obtained. The current GitHub plugin returns null; it does not infer branch protection from check names.

## Use the forge path in the SDLC pack

The bundled SDLC pack reads checks and performs its pull-request writes through `gh` by default. The forge path is an explicit opt-in until the GitHub plugin installs through the marketplace. To opt in, install a plugin for the pull request's host and set `ARCHON_SDLC_FORGE=forge` in the environment Archon runs with, for example `~/.archon/.env`. One switch covers both reads and writes; a value other than `gh` or `forge` fails the steps that use it.

The pack's writes are the draft pull request, the body resync, the canonical review comment and the ready flip. Each happens in a deterministic node — `publish-pr`, `publish-pr-body`, `publish-review` and `flip-ready` — that publishes through the selected source and fails unless the result reads back. The agents around them establish the target, author the body and decide the verdict; they never write to the forge themselves. Whether a branch already has a pull request is decided by an open-head lookup, so a second one is never opened for it.

For reads, the pack prefers a supplied required set, otherwise the full observation. It classifies each GitHub check the same way through either source and applies the same gate policy: it waits once for registration when no checks exist and refuses the final ready preflight for pending, red, gated, unknown or failed reads. The workflow owns this policy. Archon never switches to the forge path because a plugin is installed, and a selected forge path that cannot answer never falls back to `gh`: the step fails with the reason, for example `no forge plugin claims <host>`.

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

It also exports `runForgeMutationConformance` for write fixtures. Pass the plugin operation function, its metadata, and cases naming the request and the outcome the fixture sets up. The kit validates the response schema, correlation, qualified target, the applied result against the request that asked for it, and that the reported outcome is the expected one.

The host invokes `PLUGIN metadata` before any operation. Metadata declares integer protocol version 1, plugin name/version, forge family, static hosts, operation capabilities and credential environment names. Protocol incompatibility and unsupported operations fail before operation execution.

For an operation, the host invokes `PLUGIN op OPERATION` — `resolve`, `checks.state`, `workitem.view`, `pr.view`, `pr.create`, `pr.edit-body`, `pr.ready` or `comment.upsert` — sends one JSON request on stdin and expects one JSON response on stdout. Write explicit UTF-8 bytes. Diagnostics go to stderr. Exit 0 carries a success response; exit 1 carries a structured operation error. Other exits, malformed JSON and mismatched operation/target identity are process or protocol failures.

A plugin that fails a write must state which outcome it was under `mutation`, and an applied result must answer the request that asked for it — the same pull request, the same head and draft state for a create, the digest of the body it was given for an edit or comment. The host checks both rather than trusting the claim. A failed write with no stated outcome, or an applied result that does not answer the request, becomes `outcome_unknown`: the plugin ran, so what it did to the forge is no longer knowable from here. A write whose plugin process never started, or whose operation the plugin does not declare, is a refusal.

The host limits combined output to 16 MiB and kills the process tree on timeout. It supplies selected runtime environment variables and the resolved token, with value-based token redaction on captured output. Windows may inject additional system environment variables. Installed plugin code is trusted code and can access files under its operating-system identity.

On Windows, discovered executables must have an `.exe` extension. `.cmd` and `.bat` are unsupported. Scripts use explicit interpreter argv; no platform invokes a shell to interpret plugin arguments. Windows termination uses `taskkill /T /F`; POSIX termination uses a process group.

## Workflow host integration and audit

The CLI and the server both set `ARCHON_CLI_COMMAND` at startup to a JSON argv array for the install's CLI: the executable of a compiled binary, or the Bun runtime and CLI source entry in a source checkout. Runs launched from the CLI, the Web UI or a chat or forge adapter therefore see the same value. Bundled scripts append command arguments without shell parsing. An SDK host must supply its own argv array. A container execution does not receive the variable, because a host binary path is not assumed to exist in a container.

When `WORKFLOW_ID` is present, the CLI persists an `integration_operation` event through its database host. The forge payload retains operation correlation, qualified target, plugin identity/version, result and duration. Audit records keep identity and content digests only: the title and body a view operation returned are replaced by a digest and a byte count, so authored content never lands in the run's durable event log. The engine does not interpret the forge payload. The CLI reports persistence failure separately from the operation's observed outcome.
