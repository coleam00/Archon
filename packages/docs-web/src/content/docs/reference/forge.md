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

This works the same for the release binary, a source checkout, and [Docker](/deployment/docker/#plugins). Without `@<tag>` it installs from the latest Archon release; `coleam00/Archon/plugins/forge-github@<tag>` pins one. The command:

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

Forge plugins, provider plugins, chat plugins, and workflow packs install the same way: `archon plugin install owner/repo[/path][@tag]` reads the repository's `archon-plugin.json`, and no central registry is involved. Other plugin kinds will use the same command when their install path exists. The Archon-maintained GitHub plugin may move to its own repository, which changes the reference you install from, not this runtime protocol. Setup does not install it for you. Other production forges are community-maintained; the existing bundled Gitea/GitLab transition is not settled by this contract.

## Commands

```sh
archon forge resolve --data '{"remote":"git@github.com:owner/repository.git"}'
archon forge checks --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge workitem.view --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":31}}'
archon forge pr.view --data '{"selector":{"kind":"number","ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}}'
archon forge workitem.create --data-file ./issue.json
archon forge workitem.labels.set --data-file ./labels.json
archon forge repo.labels.list --data-file ./repository.json
archon forge repo.label.ensure --data-file ./label.json
archon forge pr.create --data-file ./create.json
archon forge pr.edit-body --data-file ./body.json
archon forge pr.ready --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge pr.draft --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge comment.upsert --data-file ./comment.json
archon forge pr.merge --data-file ./merge.json
archon forge checks.rerun --data-file ./rerun.json
archon forge pr.reviews --data-file ./reviews.json
```

Every command emits JSON. `resolve` takes an explicit remote, including `null` for no remote. A local or unclaimed remote returns `{ "kind": "none", "forge": "none" }` inside the success result. It performs no HTTP host probe. Every other operation names its target explicitly: a qualified repository for creation and repository-label operations and for a `pr.view` head selector, a qualified repository and number otherwise. None is inferred from the checkout.

`pr.view` accepts either selector: `{"kind":"number","ref":…}`, or `{"kind":"head","repo":…,"headRepo":…,"head":"branch"}` with an optional `base`. The head form answers "does this branch have a pull request", so it resolves the **open** one and returns `null` when there is none. A head matching more than one open pull request is a conflict rather than a guess.

`--data-file <path>` reads the same JSON request from a file. Authored content — a pull-request body, a review comment — belongs there rather than in `--data`, so it never appears in any process's argument list.

Exit 0 means the operation succeeded. Exit 1 means it failed. Exit 2 means the operation returned a response but its run audit could not be persisted. Stdout retains that response, which may be a success or a failed write with its mutation outcome; read it before retrying or reconciling, because exit 2 alone does not say whether a write happened.

## What a write reports

`workitem.create`, `workitem.labels.set`, `repo.label.ensure`, `pr.create`, `pr.edit-body`, `pr.ready`, `pr.draft` and `comment.upsert` each perform at most one write and then read the result back. A valid write request reports exactly one outcome, so a caller never has to guess which happened. A request that fails validation before dispatch is answered with `invalid_request` and no `mutation`; nothing was written.

| Outcome | Shape | What it means |
| --- | --- | --- |
| applied | `ok: true`, `result.value.outcome: "applied"` | The write was performed and read back. `changed: false` means the forge already carried the requested state and nothing was submitted. |
| refused | `ok: false`, `mutation.outcome: "refused"` | Nothing was written. The forge answered with a refusal, or the request was rejected before submission. |
| verification failed | `ok: false`, `mutation.outcome: "verification_failed"` | The write was acknowledged, but the read-back disagreed or could not run. `leaveBehind` names what may remain on the forge. |
| outcome unknown | `ok: false`, `mutation.outcome: "outcome_unknown"` | The request was submitted and its answer was lost, or the plugin's answer cannot show whether the write was applied (see the executable protocol below). Reconcile before retrying. |

A read-back never claims to have *prevented* a wrong write; it only reports what it could and could not confirm. A vendor that accepts a write and silently does not apply it is reported as a verification failure, never as success.

`pr.draft` converts an open pull request to draft and returns its verified PR record. An already-draft PR returns `applied` with `changed: false`; closed or merged PRs are refused with the observed record. A plugin that does not advertise `pr.draft` returns `unsupported_op` before execution. The forge source never falls back to `gh`. The GitHub plugin uses [the GraphQL draft mutation](https://docs.github.com/en/graphql/reference/pulls#convertpullrequesttodraft) and reads the PR back before reporting success.

`comment.upsert` writes the one comment whose first line is the exact `marker`, creating it when absent and replacing it in place when present. A body that does not begin with that marker is refused, and more than one marked comment is a conflict.

## Pinned merges, failed-check reruns and reviews

`pr.merge` takes `{ref, method: "merge" | "squash", conditions: {head, base?, tree?}}`. Every merge requires the caller's approved full head object ID. Missing heads and unsupported conditions are refused before operation execution. The conditions object rejects unknown keys. Plugin metadata declares enforced conditions under `mutationConditions["pr.merge"]`; absence declares none.

The GitHub plugin advertises and atomically enforces **only `head`**, through the REST merge endpoint's `sha` parameter. It refuses `base` and `tree` before writing. Reading the base before merging would not enforce a base condition. A stale head, draft, closed or already merged PR is refused. No head is refreshed or substituted to make a merge proceed.

An applied result includes `pr`, `method`, echoed `conditions`, `enforcedConditions` and `landed: {commit, tree, parents}`. Landed fields come from read-back; unavailable supplemental tree or parents are null. Parent order is preserved. The landed commit can differ from the PR head after a squash or merge. A mismatched PR/head/commit is a verification failure, never a successful merge with guessed evidence.

`checks.rerun` takes `{ref, revision, units: [{unit: {kind, id, name}, rerun: {id, attempt} | null}]}` from a prior `checks.state` observation. Revision and IDs are opaque; names are display facts. Empty selections and duplicate unit identities fail validation. Unsupported units, stale attempts, wrong revisions and ineligible checks are refused before any write, including when another selected unit is eligible.

GitHub associates Actions checks with workflow runs using structured check-suite and app identities. Commit statuses and checks from other apps have `rerun: null`. Eligible completed failed, cancelled or timed-out checks cause one failed-job rerun per distinct owning run. GitHub also reruns dependent jobs, so this can rerun more jobs than the selected units. Attempt checks are preflight evidence, **not an atomic condition** on GitHub's rerun endpoint. Success requires read-back of the same run and revision with a newer attempt for every selected unit.

Multi-run requests can have partial effects. Submission stops at the first failure. After an earlier acknowledged write, a later definitive refusal reports `verification_failed`; a lost submission response reports `outcome_unknown`. Failure evidence retains the requested units and observed newer attempts. Merge failures retain the attempted method and conditions and any landed observation. No operation retries, polls, rolls back or deletes after an uncertain write. Reconcile using reads before taking another action.

`pr.reviews` takes `{ref}` and returns `{ref, items}` with submitted review and root diff-review comment items. Each carries `kind`, `id`, `author`, `commit`, vendor `state`, `createdAt`, `url` and `body`; unavailable facts are null. GitHub excludes pending draft reviews and thread replies, and includes dismissed submissions. Issue-conversation comments are not diff reviews. Bodies remain available to the caller but become digest/byte-count projections in audit events. The operation does not classify findings or choose required reviewers.

## GitHub credentials and check observations

The GitHub plugin uses `GH_TOKEN` or `GITHUB_TOKEN`. The dispatcher passes the selected value to the child as `ARCHON_FORGE_TOKEN`. Tokens never belong in command arguments, JSON requests or remote URLs.

Inside a workflow (`WORKFLOW_ID` is set), a `GH_TOKEN`, `GITHUB_TOKEN` or `COPILOT_GITHUB_TOKEN` the command inherits is the run's credential. Neither `~/.archon/.env` nor the repository's `.archon/.env` replaces it, and an empty value (a credential the run withholds) stays empty. When the run sets no value, or a project `.env` names the key so startup strips it, those files supply the credential as they do outside a workflow.

Checks identify the evaluated revision and each check-run or commit-status unit. GitHub enumeration includes current check runs and the latest status for each context. The plugin preserves distinct runs with the same name. It does not use GitHub's aggregate status as evidence that checks exist.

The summary states are `none`, `pending`, `green`, `red`, `gated` and `unknown`. `none` means zero enumerated units. The summary precedence is red, gated, unknown, pending, then green. `gated` names an explicit action-required conclusion; missing checks are not evidence of an approval gate. Unrecognized vendor states remain unknown with their native value retained.

`approvalPending` is independent of the unit summary. True means explicit approval evidence at the evaluated revision, false means the authoritative lookup found none, and null/absence means it was not established. GitHub reads head-filtered Actions workflow runs, including approval-blocked runs that registered no check units. Thus `summary.state: "none"` can coexist with `approvalPending: true`. Generic waiting states and zero units never imply approval. A failed Actions read or a query exceeding GitHub's 1,000-result search cap fails the observation rather than certifying no approval requirement.

GitHub tokens need repository pull-request and check/status read permissions, plus Actions read permission for check observations and Actions write permission for reruns. Merge requires Contents write permission. An authorization failure stays explicit; there is no CLI fallback.

`required` is null when no authoritative required set was obtained. The current GitHub plugin returns null; it does not infer branch protection from check names.

## Use the forge path in the SDLC pack

The bundled SDLC pack performs its pull-request writes through `gh` by default. The forge path is an explicit opt-in until the GitHub plugin installs through the marketplace. To opt in, install a plugin for the pull request's host and set `ARCHON_SDLC_FORGE=forge` in the environment Archon runs with, for example `~/.archon/.env`. One switch covers both reads and writes on the pull request; a value other than `gh` or `forge` fails the steps that use it. The same switch covers triage labels and discovery filing. A selected non-GitHub plugin must advertise the operations those steps use; an unsupported operation fails without falling back to `gh`.

The pack's pull-request writes are the draft pull request, the body resync, the canonical review comment and the ready mark. Each happens in a deterministic node — `publish-pr`, `publish-pr-body`, `publish-review` and `flip-ready` — that publishes through the selected source and fails unless the result reads back. The agents around them establish the target, author the body and decide the verdict; they never write to the forge themselves. Whether a branch already has a pull request is decided by an open-head lookup, so a second one is never opened for it.

Initial PR publication has a 30-second attempt budget and up to two transient retries, starting with a 20-second backoff. A retry repeats the push, which changes nothing when the remote already has the head, then publishes. Before creating a PR, publish records a durable `pr-create-started` file in the run's artifacts. After a timeout, the next attempt looks for the PR again. If it finds one, it reuses it; if a create was started but no PR is visible, it fails with an unresolved-write message instead of submitting a competing create. Resume can reconcile the PR once it becomes visible. Keep the record while the write is unresolved: stopping a local client does not cancel a request already submitted to the forge.

The pack does not read checks through this switch. Whether CI is green is an agent's judgment: the delivery's `ci` node reads the project's CI with the tools the run has, waits on running checks itself, and `flip-ready` marks the pull request ready only when that node answers green. `flip-ready` reports an already-merged pull request as delivered and refuses one closed without a merge. Archon never switches to the forge path because a plugin is installed, and a selected forge path that cannot answer never falls back to `gh`: the step fails with the reason, for example `no forge plugin claims <host>`.

## Plugin configuration

Put trusted executable configuration in the user Archon config, `~/.archon/config.yaml` (or the directory selected by `ARCHON_HOME`). Repository configuration does not install or select executable plugins. The CLI captures the plugin execution environment before loading repository `.archon/.env` overrides. Repository env may supply a credential named by trusted plugin configuration, but cannot redirect plugin discovery or execution: Archon refuses to start when a repository's `.archon/.env` sets `ARCHON_HOME`, `PATH`, `HOME`, `USERPROFILE`, `ARCHON_DOCKER` or `WORKSPACE_PATH`.

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

The host invokes `PLUGIN metadata` before any operation. Metadata declares integer protocol version 1, plugin name/version, forge family, static hosts, operation capabilities, enforced mutation conditions and credential environment names. Protocol incompatibility and unsupported operations fail before operation execution.

For an operation, the host invokes `PLUGIN op OPERATION` — `resolve`, `checks.state`, `workitem.view`, `workitem.create`, `workitem.labels.set`, `repo.labels.list`, `repo.label.ensure`, `pr.view`, `pr.create`, `pr.edit-body`, `pr.ready`, `pr.draft`, `pr.merge`, `checks.rerun`, `pr.reviews` or `comment.upsert` — sends one JSON request on stdin and expects one JSON response on stdout. Write explicit UTF-8 bytes. Diagnostics go to stderr. Exit 0 carries a success response; exit 1 carries a structured operation error. Other exits, malformed JSON and mismatched operation/target identity are process or protocol failures.

A plugin that fails a write must state which outcome it was under `mutation`, and an applied result must answer the request that asked for it — the same pull request, the same head and draft state for a create, the digest of the body it was given for an edit or comment. The host checks both rather than trusting the claim. A failed write with no stated outcome, or an applied result that does not answer the request, becomes `outcome_unknown`: the plugin ran, so what it did to the forge is no longer knowable from here. A write whose plugin process never started, or whose operation the plugin does not declare, is a refusal.

The host limits combined output to 16 MiB and kills the process tree on timeout. It supplies selected runtime environment variables and the resolved token, with value-based token redaction on captured output. Windows may inject additional system environment variables. Installed plugin code is trusted code and can access files under its operating-system identity.

On Windows, discovered executables must have an `.exe` extension. `.cmd` and `.bat` are unsupported. Scripts use explicit interpreter argv; no platform invokes a shell to interpret plugin arguments. Windows termination uses `taskkill /T /F`; POSIX termination uses a process group.

## Workflow host integration and audit

The CLI sets `ARCHON_CLI_COMMAND` at startup to a JSON argv array for the install's CLI: the compiled CLI executable, or the Bun runtime and CLI source entry in a source checkout. A source server also publishes the source CLI command. A compiled server launched by `archon serve` requires and preserves the launching CLI's value instead of publishing its own executable. Runs launched from the CLI, the Web UI or a chat or forge adapter therefore see the same CLI command. Bundled scripts append command arguments without shell parsing. An SDK host must supply its own argv array. A container execution does not receive the variable, because a host binary path is not assumed to exist in a container.

When `WORKFLOW_ID` is present, the CLI persists an `integration_operation` event through its database host. The forge payload retains operation correlation, qualified target, plugin identity/version, result and duration. Audit records keep identity and content digests only: the title and body a view operation returned, and each review body, are replaced by a digest and a byte count, so authored content never lands in the run's durable event log. The engine does not interpret the forge payload. The CLI reports persistence failure separately from the operation's observed outcome.

## Work-item writes

Pass these request objects through `--data-file`. The host supplies `operationId` and `op`.

- `workitem.create`: `{repo: {host, path}, title, body, marker}`. The one-line marker must be the body's exact first line. The plugin enumerates issues across all states, excluding PRs, and compares the exact first line. A failed lookup or multiple matches refuses before writing. One match is read directly and returned with `changed:false`, including when closed; recovery never edits or reopens it. Otherwise one create is followed by an independent read. Fresh creation proves open state and requested title/body digests; recovery proves issue identity and marker digest while returning existing content digests.
- `workitem.labels.set`: `{ref: {repo: {host, path}, number}, labels: [name]}`. This replaces the complete label set; `[]` clears it. Every name must exist in the repository. It never creates labels. The result carries the independently observed exact set, and equal sets submit no write.
- `repo.labels.list`: `{repo: {host, path}}`. Returns complete repository label names as `{repo, labels: [{name}]}`.
- `repo.label.ensure`: `{repo: {host, path}, name, color, description}`. Explicitly ensure one repository label. Color is six hexadecimal digits. An existing name returns `changed:false` without changing operator metadata. Creation performs one write and verifies name, color and description digest by a separate read.

Work-item mutation evidence contains `{ref, kind:'issue', url, state}`, never authored title/body. Label metadata evidence contains name, color and description digest. `workitem.view` may omit labels for older protocol-1 plugins; triage requires label facts and fails if absent.

Marker recovery guarantees sequential reuse of a visible item, including after an unknown create outcome. It does not provide atomic uniqueness for concurrent creates: GitHub has no marker uniqueness constraint. Callers must reconcile unknown outcomes, never retry automatically inside a call. Whole-set label replacement preserves labels observed before writing, but cannot preserve concurrent edits between that read and the write.

Delivery uses an exact-content SHA-256 marker derived from title, claim, evidence and relation. Run provenance does not affect identity. Semantic duplicate detection is separate work. Triage explicitly ensures only missing wanted pack labels, omits nonexistent area labels, then replaces labels while preserving observed unrelated names. The default `gh` source remains supported; its issue creation retains the existing URL sidecar behavior.
