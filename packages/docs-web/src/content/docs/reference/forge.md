---
title: Forge operations
description: Read and publish qualified pull requests through optional executable plugins.
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

All forge commands emit JSON. `resolve` takes an explicit remote, including `null` for no remote. A local or unclaimed remote returns `{ "kind": "none", "forge": "none" }` inside the success result. It performs no HTTP host probe. `checks` requires a qualified repository and PR number; it never infers them from the checkout.

Exit 0 means a read succeeded, even when checks are red, or a mutation was applied and verified. Exit 1 means the operation or its input failed. Exit 2 means the operation completed but its run audit could not be persisted; stdout retains the actual result.

## Lifecycle operations

Use `archon forge OPERATION --data-file request.json` for authored content. The file contains one JSON object with the operation's fields; the CLI supplies `op` and a fresh `operationId`. `--data` and `--data-file` are mutually exclusive. File input avoids putting a PR body or review report into process arguments.

| Operation | Request fields | Result |
| --- | --- | --- |
| `workitem.view` | `ref: {repo: {host, path}, number}` | Explicit issue/PR kind, title, body and state |
| `pr.view` | `selector: {kind: "number", ref}` or `{kind: "head", repo, headRepo, head, base?}` | PR record, title and body; null when no head match exists; ambiguous matches fail |
| `pr.create` | `repo`, `headRepo`, `head`, `headRevision`, `base`, `title`, `body`, `draft` | Verified PR record |
| `pr.edit-body` | `ref`, `body` | Verified PR record and body digest |
| `pr.ready` | `ref` | Verified open, non-draft PR record |
| `comment.upsert` | `ref`, single-line `marker`, `body` | Verified comment ID, URL and body digest |
| `pr.merge` | `ref`, `method`, `required` | Verified merge record and available landed commit facts |

Repository references always contain `host` and `path`. PR references add `number`. A PR record includes these references, `schemaVersion: 1`, URL, branch names `head` and `base`, separate `head_revision` and `base_revision`, `head_repo`, `is_draft`, lifecycle `state` and `maintainer_can_modify`. Unknown revision or fork facts are null; branch names are never commit IDs.

The SDLC pack's agents prepare publication artifacts. Deterministic publisher nodes create or reuse the PR, synchronize its body and upsert the canonical review comment using the recorded qualified target. The comment marker occupies its own first line; multiple matching comments are an ambiguity, not permission to choose or delete one. The ready node keeps workflow-owned check policy. Delivery does not merge automatically.

### Mutation outcomes and recovery

Applied writes return `ok: true` and `result: {op, value}`; `value.outcome` is `applied`. Other mutation outcomes return `ok: false`, the structured `error`, and a `mutation` record:

| Outcome | What is known | Caller action |
| --- | --- | --- |
| `applied` | The desired result was read back; `changed` distinguishes a write from an already-satisfied state | Continue using the returned evidence |
| `refused` | No write was performed | Correct the rejected input, capability or authorization before retrying |
| `verification_failed` | A write was acknowledged, but the intended result could not be verified | Inspect `leaveBehind` and reconcile the qualified target |
| `outcome_unknown` | Submission or execution may have written, but no reliable outcome was obtained | Read actual remote state before deciding whether another write is appropriate |

Every mutation outcome retains the target and requested/enforced conditions. A process timeout, malformed response or abnormal exit after launch is unknown, even if the process might have stopped before writing. A command that never launches is refused. The CLI does not automatically retry, roll back or delete remote work.

### Conditional merge

A merge requires an explicit method: `merge`, `squash` or `rebase`. The GitHub plugin advertises atomic expected-head enforcement and passes it as the API's `sha`. For example:

```json
{
  "ref": {"repo": {"host": "github.com", "path": "owner/repository"}, "number": 42},
  "method": "squash",
  "required": {"head": "the-observed-full-object-id"}
}
```

Invoke it with `archon forge pr.merge --data-file merge-request.json`. `required` may request `head`, `base` and `resultTree`; unknown condition names are invalid. GitHub does not offer atomic expected-base or expected-result-tree enforcement through this operation. Either required condition is refused before any write. Observing these facts before or after merging cannot substitute for enforcing them atomically.

Landed `commit`, `tree` and `parents` evidence uses `{available: true, value}` or `{available: false, reason}`. Unavailable facts are not inferred from the current branch. Workflow authors choose approvals, check policy and whether the available merge guarantees are sufficient.

## GitHub credentials and check observations

The GitHub plugin uses `GH_TOKEN` or `GITHUB_TOKEN`. The dispatcher passes the selected value to the child as `ARCHON_FORGE_TOKEN`. Tokens never belong in command arguments, JSON requests or remote URLs.

Checks identify the evaluated revision and each check-run or commit-status unit. GitHub enumeration includes current check runs and the latest status for each context. The plugin preserves distinct runs with the same name. It does not use GitHub's aggregate status as evidence that checks exist.

The summary states are `none`, `pending`, `green`, `red`, `gated` and `unknown`. `none` means zero enumerated units. The summary precedence is red, gated, unknown, pending, then green. `gated` names an explicit action-required conclusion; missing checks are not evidence of an approval gate. Unrecognized vendor states remain unknown with their native value retained.

`required` is null when no authoritative required set was obtained. The current GitHub plugin returns null; it does not infer branch protection from check names. The SDLC pack prefers a supplied required set, otherwise uses the full observation. It waits once for registration when no checks exist and refuses the final ready preflight for pending, red, gated, unknown or failed reads. The workflow owns this policy.

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

`@archon/forge/conformance` exports `runForgeReadConformance` for controlled repository fixtures. Pass the plugin operation function and cases naming the expected revision, state and exact unit identities. The kit validates the response schema, correlation, qualified target, counts and summary. `runForgeMutationConformance(invoke, metadata, cases)` checks mutation correlation, target, requested/enforced guarantees and expected outcomes against controlled fixtures.

The host invokes `PLUGIN metadata` before any operation. Metadata declares integer protocol version 1, plugin name/version, forge family, static hosts, operation capabilities and credential environment names. Protocol incompatibility and unsupported operations fail before operation execution. Merge metadata separately declares supported methods, atomic condition dimensions and read-back facts under `operations["pr.merge"]`. Missing merge details or unsupported required guarantees prevent dispatch.

For an operation, the host invokes `PLUGIN op OPERATION` (for example, `checks.state` or `pr.create`), sends one JSON request on stdin and expects one JSON response on stdout. Write explicit UTF-8 bytes. Diagnostics go to stderr. Exit 0 carries a success response; exit 1 carries a structured operation error. Other exits, malformed JSON and mismatched operation/target identity are process or protocol failures.

The host limits combined output to 16 MiB and kills the process tree on timeout. It supplies selected runtime environment variables and the resolved token, with value-based token redaction on captured output. Windows may inject additional system environment variables. Installed plugin code is trusted code and can access files under its operating-system identity.

On Windows, discovered executables must have an `.exe` extension. `.cmd` and `.bat` are unsupported. Scripts use explicit interpreter argv; no platform invokes a shell to interpret plugin arguments. Windows termination uses `taskkill /T /F`; POSIX termination uses a process group.

## Workflow host integration and audit

The CLI host sets `ARCHON_CLI_COMMAND` to a JSON argv array for its own executable, including the runtime and source entry when applicable. Bundled scripts append command arguments without shell parsing. An SDK or container host must supply an argv array usable inside that execution environment; a host binary path is not assumed to exist in a container.

When `WORKFLOW_ID` is present, the CLI persists an `integration_operation` event through its database host. The forge payload retains operation correlation, qualified target, plugin identity/version, mutation outcome and guarantee evidence, and duration. Read titles and bodies are replaced by a digest and byte count in the audit; mutation results contain PR/comment identity and digests rather than authored content. The engine does not interpret the forge payload. The CLI reports persistence failure separately from the operation's observed outcome.
