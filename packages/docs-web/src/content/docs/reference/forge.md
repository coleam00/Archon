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
archon plugin add coleam00/Archon/plugins/forge-github
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

Forge plugins, provider plugins, chat plugins, and workflow packs install the same way: `archon plugin add owner/repo[/path][@tag]` reads the repository's `archon-plugin.json`, and no central registry is involved. Other plugin kinds will use the same command when their install path exists. The Archon-maintained GitHub plugin may move to its own repository, which changes the reference you install from, not this runtime protocol. Setup does not install it for you. Other production forges are community-maintained; the existing bundled Gitea/GitLab transition is not settled by this contract.

## Commands

```sh
archon forge resolve --data '{"remote":"git@github.com:owner/repository.git"}'
archon forge checks --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge workitem.view --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":31}}'
archon forge pr.view --data '{"selector":{"kind":"number","ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}}'
archon forge workitem.create --data-file ./issue.json
archon forge workitem.labels.set --data-file ./labels.json
archon forge workitem.label.add --data '{"subject":{"kind":"pr","ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}},"name":"queued"}'
archon forge workitem.label.remove --data '{"subject":{"kind":"issue","ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":31}},"name":"queued"}'
archon forge workitem.list --data '{"repo":{"host":"github.com","path":"owner/repository"},"label":"queued"}'
archon forge repo.labels.list --data-file ./repository.json
archon forge repo.label.ensure --data-file ./label.json
archon forge pr.create --data-file ./create.json
archon forge pr.edit-body --data-file ./body.json
archon forge pr.ready --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge pr.draft --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge comment.upsert --data-file ./comment.json
archon forge workitem.comment.upsert --data-file ./issue-comment.json
archon forge workitem.close --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":31},"reason":"duplicate"}'
archon forge pr.merge --data-file ./merge.json
archon forge checks.rerun --data-file ./rerun.json
archon forge pr.reviews --data-file ./reviews.json
archon forge pr.threads --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge pr.thread.reply --data-file ./thread-reply.json
archon forge pr.thread.resolve --data-file ./thread-resolve.json
archon forge workitem.edit-body --data-file ./issue-body.json
```

Every command emits JSON. When the host selects a credential, it adds `credentialSource` to the CLI response envelope with the source name, never the token. This is host diagnostic metadata; the plugin protocol is unchanged. `resolve` takes an explicit remote, including `null` for no remote. A local or unclaimed remote returns `{ "kind": "none", "forge": "none" }` inside the success result. It performs no HTTP host probe. Every other operation names its target explicitly: a qualified repository for creation, repository-label operations, listing by label and a `pr.view` head selector; a subject `{kind: "issue" | "pr", ref}` for single-label writes and `workitem.comment.upsert`; a qualified repository and number otherwise. None is inferred from the checkout.

The GitHub plugin also resolves HTTP Git remotes. For example, `http://github.example.com:8080/team/repo.git` resolves to host `github.example.com:8080` and path `team/repo` when that exact host and port are explicitly claimed by the plugin. The remote must not contain credentials, a query, or a fragment. Resolution needs no credential or network request; it does not select the API origin.

`pr.view` accepts either selector: `{"kind":"number","ref":…}`, or `{"kind":"head","repo":…,"headRepo":…,"head":"branch"}` with an optional `base`. The head form answers "does this branch have a pull request", so it resolves the **open** one and returns `null` when there is none. A head matching more than one open pull request is a conflict rather than a guess.

`--data-file <path>` reads the same JSON request from a file. Authored content — a pull-request body, a review comment — belongs there rather than in `--data`, so it never appears in any process's argument list.

Exit 0 means the operation succeeded. Exit 1 means it failed. Exit 2 means the operation returned a response but its run audit could not be persisted. Stdout retains that response, which may be a success or a failed write with its mutation outcome; read it before retrying or reconciling, because exit 2 alone does not say whether a write happened.

## What a write reports

`workitem.create`, `workitem.labels.set`, `workitem.label.add`, `workitem.label.remove`, `workitem.comment.upsert`, `workitem.close`, `repo.label.ensure`, `pr.create`, `pr.edit-body`, `pr.ready`, `pr.draft` and `comment.upsert` each perform at most one write and then read the result back. A valid write request reports exactly one outcome, so a caller never has to guess which happened. A request that fails validation before dispatch is answered with `invalid_request` and no `mutation`; nothing was written.

| Outcome | Shape | What it means |
| --- | --- | --- |
| applied | `ok: true`, `result.value.outcome: "applied"` | The write was performed and read back. `changed: false` means the forge already carried the requested state and nothing was submitted. |
| refused | `ok: false`, `mutation.outcome: "refused"` | Nothing was written. The forge answered with a refusal, or the request was rejected before submission. |
| verification failed | `ok: false`, `mutation.outcome: "verification_failed"` | The write was acknowledged, but the read-back disagreed or could not run. `leaveBehind` names what may remain on the forge. |
| outcome unknown | `ok: false`, `mutation.outcome: "outcome_unknown"` | The request was submitted and its answer was lost, or the plugin's answer cannot show whether the write was applied (see the executable protocol below). Reconcile before retrying. |

A read-back never claims to have *prevented* a wrong write; it only reports what it could and could not confirm. A vendor that accepts a write and silently does not apply it is reported as a verification failure, never as success.

`pr.draft` converts an open pull request to draft and returns its verified PR record. An already-draft PR returns `applied` with `changed: false`; closed or merged PRs are refused with the observed record. A plugin that does not advertise `pr.draft` returns `unsupported_op` before execution. The forge source never falls back to `gh`. The GitHub plugin uses [the GraphQL draft mutation](https://docs.github.com/en/graphql/reference/pulls#convertpullrequesttodraft) and reads the PR back before reporting success.

`comment.upsert` writes the one comment whose first line is the exact `marker`, creating it when absent and replacing it in place when present. A body that does not begin with that marker is refused, and more than one marked comment is a conflict.

`workitem.comment.upsert` does the same on an issue or a pull request. It takes `{subject: {kind: "issue" | "pr", ref}, marker, body}`, and the subject's kind must match the item, so a mismatch is refused before writing. Its result adds the item's `workitem` record to the `comment`. `comment.upsert` keeps its pull-request `ref` form for existing callers and for installed plugins that predate subjects.

## Pinned merges, failed-check reruns and reviews

`pr.merge` takes `{ref, method: "merge" | "squash", conditions: {head, base?, tree?}}`. Every merge requires the caller's approved full head object ID. Missing heads and unsupported conditions are refused before operation execution. The conditions object rejects unknown keys. Plugin metadata declares enforced conditions under `mutationConditions["pr.merge"]`; absence declares none.

The GitHub plugin advertises and atomically enforces **only `head`**, through the REST merge endpoint's `sha` parameter. It refuses `base` and `tree` before writing. Reading the base before merging would not enforce a base condition. A stale head, draft, closed or already merged PR is refused. No head is refreshed or substituted to make a merge proceed.

An applied result includes `pr`, `method`, echoed `conditions`, `enforcedConditions` and `landed: {commit, tree, parents}`. Landed fields come from read-back; unavailable supplemental tree or parents are null. Parent order is preserved. The landed commit can differ from the PR head after a squash or merge. A mismatched PR/head/commit is a verification failure, never a successful merge with guessed evidence.

`checks.rerun` takes `{ref, revision, units: [{unit: {kind, id, name}, rerun: {id, attempt} | null}]}` from a prior `checks.state` observation. Revision and IDs are opaque; names are display facts. Empty selections and duplicate unit identities fail validation. Unsupported units, stale attempts, wrong revisions and ineligible checks are refused before any write, including when another selected unit is eligible.

GitHub associates Actions checks with workflow runs using structured check-suite and app identities. Commit statuses and checks from other apps have `rerun: null`. Eligible completed failed, cancelled or timed-out checks cause one failed-job rerun per distinct owning run. GitHub also reruns dependent jobs, so this can rerun more jobs than the selected units. Attempt checks are preflight evidence, **not an atomic condition** on GitHub's rerun endpoint. Success requires read-back of the same run and revision with a newer attempt for every selected unit.

Multi-run requests can have partial effects. Submission stops at the first failure. After an earlier acknowledged write, a later definitive refusal reports `verification_failed`; a lost submission response reports `outcome_unknown`. Failure evidence retains the requested units and observed newer attempts. Merge failures retain the attempted method and conditions and any landed observation. No operation retries, polls, rolls back or deletes after an uncertain write. Reconcile using reads before taking another action.

`pr.reviews` takes `{ref}` and returns `{ref, items}` with submitted review and root diff-review comment items. Each carries `kind`, `id`, `author`, `commit`, vendor `state`, `createdAt`, `url` and `body`; unavailable facts are null. GitHub excludes pending draft reviews and thread replies, and includes dismissed submissions. Issue-conversation comments are not diff reviews. Bodies remain available to the caller but become digest/byte-count projections in audit events. The operation does not classify findings or choose required reviewers.

`pr.threads` takes `{ref}` and returns `{ref, threads}`: every review thread on the pull request, each with its opaque `id`, `resolved`, `outdated`, `path` and `line` (null when the forge has none), and `comments` with `id`, `author`, `body` and `url`. The GitHub plugin reads every page of threads and of each thread's comments, so a long list is never cut short. Comment bodies become digest/byte-count projections in audit events.

`workitem.comments` takes `{subject: {kind: "issue" | "pr", ref}}` and returns `{workitem, comments}`: the item's record and every conversation comment on it, oldest first, each with `id`, `author` (null for a deleted account), `url` and `body`. A subject whose kind does not match the item is refused. The GitHub plugin reads every page, so a long conversation is never cut short. Comment bodies become digest/byte-count projections in audit events.

`checks.commit` takes `{repo, at: {kind: "revision", revision} | {kind: "default_branch"}}` and returns the same check set as `checks.state` (`units`, `summary`, `approvalPending`) with `{repo, branch, revision}`: `revision` is the commit the checks were read on, and `branch` names the default branch for the `default_branch` form and is null for a given revision. The GitHub plugin resolves the default branch and its head through GraphQL; a repository that reports none is `not_found`.

`pr.merge-state` takes `{ref}` and returns `{ref, head_revision, default_branch, default_revision, behind, mergeable, merge_commit}`. `behind` counts the commits of the default branch at `default_revision` that the head at `head_revision` lacks. `mergeable` is `clean`, `conflict` or `unknown`; GitHub computes mergeability lazily, so a first read may be `unknown`. `merge_commit` is the commit the pull request landed as, null until it is merged. The GitHub plugin compares through GraphQL, which accepts a head from a fork, and a failed comparison is an error, never a guessed zero.

`pr.thread.reply` takes `{ref, thread, body}` and posts one reply on that thread; an applied result carries the `thread` and the new `comment` record with its body digest. `pr.thread.resolve` takes `{ref, thread}`; a thread already resolved is applied with `changed: false`. Both refuse, before writing, a thread that does not belong to the pull request `ref`.

`workitem.edit-body` takes `{ref, body}` for an issue and replaces its body; an applied result carries the issue record and the body digest read back. The forge has no conditional body write, so an edit saved between the caller's read and this write is lost. A pull request uses `pr.edit-body`.

## GitHub credentials and check observations

The host resolves `GH_TOKEN`, then `GITHUB_TOKEN`, then the `gh` CLI login for the target host. The dispatcher passes the selected token to the child as `ARCHON_FORGE_TOKEN`. Tokens never belong in command arguments, JSON requests or remote URLs.

Inside a workflow (`WORKFLOW_ID` is set), a `GH_TOKEN`, `GITHUB_TOKEN` or `COPILOT_GITHUB_TOKEN` the command inherits is the run's credential. Neither `~/.archon/.env` nor the repository's `.archon/.env` replaces it, and an empty value (a credential the run withholds) stays empty. When the run sets no value, or a project `.env` names the key so startup strips it, those files supply the credential as they do outside a workflow.

Checks identify the evaluated revision and each check-run or commit-status unit. GitHub enumeration includes current check runs and the latest status for each context. The plugin preserves distinct runs with the same name. It does not use GitHub's aggregate status as evidence that checks exist.

The summary states are `none`, `pending`, `green`, `red`, `gated` and `unknown`. `none` means zero enumerated units. The summary precedence is red, gated, unknown, pending, then green. `gated` names an explicit action-required conclusion; missing checks are not evidence of an approval gate. Unrecognized vendor states remain unknown with their native value retained.

`approvalPending` is independent of the unit summary. True means explicit approval evidence at the evaluated revision, false means the authoritative lookup found none, and null/absence means it was not established. GitHub reads head-filtered Actions workflow runs, including approval-blocked runs that registered no check units. Thus `summary.state: "none"` can coexist with `approvalPending: true`. Generic waiting states and zero units never imply approval. A failed Actions read or a query exceeding GitHub's 1,000-result search cap fails the observation rather than certifying no approval requirement.

GitHub tokens need repository pull-request and check/status read permissions, plus Actions read permission for check observations and Actions write permission for reruns. Merge requires Contents write permission. An authorization failure stays explicit; Archon does not switch credential sources or use the CLI to read checks after a plugin failure.

`required` is null when no authoritative required set was obtained. The current GitHub plugin returns null; it does not infer branch protection from check names.

## Use the forge path in the SDLC pack

The bundled SDLC pack uses `gh` by default. Set `ARCHON_SDLC_FORGE=forge` to opt into the forge plugin. The default will change only after a released plugin supports every operation the pack uses and has been tested on a real PR. For github.com the opt-in needs two things:

1. **The plugin.** With the release binary or Homebrew, `archon plugin add coleam00/Archon/plugins/forge-github`. In a source checkout, `bun run cli plugin add coleam00/Archon/plugins/forge-github`, or a plugin you built yourself (see above). In Docker, `docker compose exec -u appuser app bun run cli plugin add coleam00/Archon/plugins/forge-github`.
2. **A credential.** The host resolves GitHub credentials in order: `GH_TOKEN`, then `GITHUB_TOKEN`, then the `gh` CLI login via `gh auth token --hostname <forge-host>`. It passes the token to the plugin, including released v0.11.1 plugins. If a source is absent, the host tries the next; a selected token rejected by the forge, or an installed `gh` that fails or returns an empty token, is reported without trying another source. Tokens are never logged. Run `archon workflow run archon-forge-check` from the checkout to run the pack's preflight on its own, including the required-operation check. It names the credential source used. A logged-out `gh` refusal offers the forge alternative only when an installed plugin advertises every required operation.

With the release binary, Homebrew or a source install, an existing `gh auth login` works. Alternatively, put `GH_TOKEN` in Archon's env file, `~/.archon/.env`. In Docker, set `GH_TOKEN` in the compose `.env`, or authenticate `gh` inside the container; the host machine's login is not shared automatically. GitHub App mode supplies each run its token. On the forge path, the run shim refreshes installation tokens through the App credential helper without requiring the real `gh` executable. Prefer `GH_TOKEN` when configuring the forge alone: beside `WEBHOOK_SECRET`, `GITHUB_TOKEN` also switches the server's GitHub adapter into token mode.

An explicitly empty credential with no non-empty alternative refuses instead of using the host login. The engine uses empty values to deny an unconnected user's run access to shared credentials. For a solo install with an empty `GH_TOKEN=` line, remove that line to use `gh auth login`. An explicit `token_env` in trusted forge configuration selects only that variable; it does not consult the default sources. A GitHub plugin advertising custom credential names uses those names in its advertised order, without consulting the host login. The standard GitHub order applies when the plugin advertises only `GH_TOKEN` and/or `GITHUB_TOKEN`.

To select the default explicitly, set `ARCHON_SDLC_FORGE=gh` in the environment Archon runs with, for example `~/.archon/.env`. A [container execution](/guides/container-isolation/) receives only the project's configured env, never `~/.archon/.env`, and has no host command for the forge path, so select `gh` for it in the repository's `.archon/config.yaml` with `env: { ARCHON_SDLC_FORGE: gh }`. One switch covers the pack's reads and writes, except the ones this paragraph names as using `gh`: standalone `archon-review` given a pull-request number, URL or branch, or run on a branch with an open pull request, still reads that pull request with `gh pr view` and `gh pr diff`; inside delivery it reviews the recorded pull request and reads nothing from the forge. Delivery reads, answers and resolves a pull request's review threads through the selected source: on the forge path through `pr.threads`, `pr.thread.reply` and `pr.thread.resolve`. The merge queue reads through `pr.view`, `pr.merge-state`, `checks.state`, `checks.commit`, `pr.threads` and `workitem.comments`, merges through `pr.merge` pinned to the head, and refuses a plugin missing any of them before claiming work; its own-PR enrollment runs only on `gh`, and its sweep agent's issue read, failed-job reruns, log reads and closing-reference body edit still use `gh`. A value other than `forge` or `gh` fails the steps that use it. A selected non-GitHub plugin must advertise the operations those steps use; an unsupported operation fails without falling back to `gh`.

`archon-ship`, `archon-deliver`, `archon-upkeep` and `archon-pr` run a `forge` node that checks the selected source can act before any agent runs: on the forge path, host metadata inspection (`archon forge metadata --data '{"host":"github.com"}' --json`) must first advertise every required operation, then an authenticated pull-request read (`pr.view` by head, which every released GitHub plugin supports) for the repositories the checkout's remotes name, which proves the token can read the repository but not that it can write: the run's log says so, and write access is first proven by the run's first write; with `gh`, active authentication (`gh auth status --active --hostname <host>`) plus a repository read (`gh api --hostname <host> repos/<path>`) for the repositories the remotes name. One readable repository, including a readable mirror, is sufficient. This proves read access only; the first write proves write access. A missing plugin or token refuses there, naming both steps, rather than after implementation and review. With per-user GitHub enabled, a run started by a user who has not connected their own GitHub identity has no token, and the refusal names the connect step (`archon auth github` or the Web UI Settings page). With `gh` selected for github.com or a `*.ghe.com` host, an empty `GH_TOKEN` with no `GITHUB_TOKEN` set is refused rather than letting `gh` fall back to the host's own login; the refusal names both causes, a per-user run whose user has not connected and an empty `GH_TOKEN=` line in an env file (remove the line to use the `gh auth login` login). Other Enterprise hosts use `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` for that check; an empty public-host token does not refuse a valid Enterprise credential. When one remote repository fails but another is readable, the successful diagnostic includes the failed repository and its error. The operations themselves still refuse on their own. The run's worktree exists by then: the engine creates it before the first node.

The forge opt-in requires `pr.view`, `pr.create`, `pr.edit-body`, `pr.ready`, `pr.draft`, `comment.upsert`, `checks.state`, `checks.rerun`, `workitem.view`, `repo.labels.list`, `repo.label.ensure`, `workitem.labels.set`, `workitem.comment.upsert`, `workitem.close` and `workitem.create`. The GitHub plugin advertises all of them from v0.12.1; earlier releases lack some and cannot run the pack. Preflight names missing operations and refuses before AI. Host metadata inspection uses trusted plugin discovery without credentials or a plugin operation; it does not change the forge protocol.

The draft pull request and the canonical review comment are written in deterministic nodes — `publish-pr` and `publish-review` — that publish through the selected source and fail unless the result reads back. In delivery, `publish-pr` also writes the description content a round prepared, as a marked section of the description, before that round's review. Two agents write through the source the `forge` node checked: `update-pr-body` edits the description after review, and the `ci` agent marks the pull request ready and puts it back to draft on red. The correction agent pushes its commit with plain `git`. Whether a branch already has a pull request is decided by an open-head lookup, so a second one is never opened for it.

Initial PR publication has a 180-second node deadline. A push that exits nonzero is retried once after 20 seconds; a successful push must still read back the remote ref as HEAD before publication continues. The publication node does not automatically retry timeouts or forge failures. Before creating a PR, publish records a durable `pr-create-started` file in the run's artifacts. On explicit resume, publication pushes again, then looks for the PR. If it finds one, it reuses it; if a create was started but no PR is visible, it fails with an unresolved-write message instead of submitting a competing create. Resume can reconcile the PR once it becomes visible. Keep the record while the write is unresolved: stopping a local client does not cancel a request already submitted to the forge.

Whether CI is green is an agent's judgment: the delivery's `ci` node marks the pull request ready, reads its checks through the selected source (`checks.state` on the forge path), and returns it to draft unless CI is green. It acts on the pull request `publish-pr` recorded, never one found from the checkout's remote. Job logs are evidence, not the check read, so the agent reads them with the tools the run has. Archon never picks a path because a plugin is installed, and a selected path that cannot answer never falls back to the other: the step fails with the reason, for example `no forge plugin claims <host>`.

## Plugin configuration

Put trusted executable configuration in the user Archon config, `~/.archon/config.yaml` (or the directory selected by `ARCHON_HOME`). Repository configuration does not install or select executable plugins. The CLI captures the plugin execution environment before loading repository `.archon/.env` overrides. In the CLI, a workflow's inherited `GH_CONFIG_DIR` takes precedence over the user env file. Repository `.archon/.env` cannot redirect the CLI's stored gh login, including for nested workflow commands; set `GH_CONFIG_DIR` in the process environment, user env file, or workflow configuration instead. The standalone server follows the general env load order: repository `.archon/.env` can override the user-scope `GH_CONFIG_DIR`, and host subprocesses inherit that directory. Repository env may supply a credential named by trusted plugin configuration, but cannot redirect plugin discovery or execution: Archon refuses to start when a repository's `.archon/.env` sets `ARCHON_HOME`, `PATH`, `HOME`, `USERPROFILE`, `ARCHON_DOCKER` or `WORKSPACE_PATH`.

```yaml
forge:
  hosts:
    github.example.com:8080:
      plugin: github
      token_env: COMPANY_GITHUB_TOKEN
  plugins:
    - plugin: company-forge
      command: /absolute/path/to/python
      args: [/absolute/path/to/plugin.py]
  scanPath: true
```

A host mapping may name a discovered plugin directly, or supply `plugin`, an absolute `command`, interpreter `args`, and `token_env`. Its key must match the repository's exact `host[:port]`.

HTTPS remotes with explicit `:443` first use that exact claim; if it is absent, resolution may use the bare-host claim. When resolution uses the bare claim, the repository retains its `host:443` authority and includes the presence marker `hostClaim: true`. Pass the complete repository reference to subsequent operations: dispatch validates the marked authority and uses its derived bare host for both plugin and credential selection. A qualified `host:443` reference without `hostClaim` still requires an exact claim. HTTP and SSH remotes do not receive this HTTPS exception.

The GitHub plugin supports explicitly mapped GitHub Enterprise hosts at `https://HOST/api/v3`. Set `GITHUB_URL` to a bare HTTP(S) origin, such as `http://github.example.com:8080` for the mapping above, to preserve its scheme and port for REST and GraphQL calls to that matching host and port. Other hosts keep HTTPS, and github.com always uses its canonical HTTPS endpoints. Invalid `GITHUB_URL` values fail before API dispatch.

Discovery examines configured executables, `~/.archon/plugins`, configured `pluginDirs`, and PATH names beginning with `archon-forge-`. Duplicate identities or host claims fail loudly. Failed explicitly configured or host-selected plugins fail discovery. An unrelated automatically scanned candidate with a failed metadata handshake is reported on stderr and skipped when another valid plugin serves the requested host. If no valid plugin serves it and any candidate failed, resolution fails rather than reporting no forge. No forge is injected as an implicit fallback. No remote URL can select an arbitrary executable.

## Executable protocol

The authoritative Zod schemas and derived TypeScript types are exported by `@archon/forge/operations`. Dispatch and configuration are separate exports, `@archon/forge/dispatch` and `@archon/forge/plugin-config`.

`@archon/forge/conformance` exports `runForgeReadConformance` for controlled repository fixtures. Pass the plugin operation function and cases naming the expected revision, state and exact unit identities. The kit validates the response schema, correlation, qualified target, counts and summary.

It also exports `runForgeMutationConformance` for write fixtures. Pass the plugin operation function, its metadata, and cases naming the request and the outcome the fixture sets up. The kit validates the response schema, correlation, qualified target, the applied result against the request that asked for it, and that the reported outcome is the expected one.

The host invokes `PLUGIN metadata` before any operation. Metadata declares integer protocol version 1, plugin name/version, forge family, static hosts, operation capabilities, enforced mutation conditions and credential environment names. Protocol incompatibility and unsupported operations fail before operation execution.

For an operation, the host invokes `PLUGIN op OPERATION` — `resolve`, `checks.state`, `checks.commit`, `workitem.view`, `workitem.comments`, `workitem.list`, `workitem.create`, `workitem.labels.set`, `workitem.label.add`, `workitem.label.remove`, `workitem.comment.upsert`, `workitem.close`, `repo.labels.list`, `repo.label.ensure`, `pr.view`, `pr.create`, `pr.edit-body`, `pr.ready`, `pr.draft`, `pr.merge`, `checks.rerun`, `pr.reviews`, `pr.threads`, `pr.merge-state`, `pr.thread.reply`, `pr.thread.resolve`, `workitem.edit-body` or `comment.upsert` — sends one JSON request on stdin and expects one JSON response on stdout. Write explicit UTF-8 bytes. Diagnostics go to stderr. Exit 0 carries a success response; exit 1 carries a structured operation error. Other exits, malformed JSON and mismatched operation/target identity are process or protocol failures.

A plugin that fails a write must state which outcome it was under `mutation`, and an applied result must answer the request that asked for it — the same pull request, the same head and draft state for a create, the digest of the body it was given for an edit or comment. The host checks both rather than trusting the claim. A failed write with no stated outcome, or an applied result that does not answer the request, becomes `outcome_unknown`: the plugin ran, so what it did to the forge is no longer knowable from here. A write whose plugin process never started, or whose operation the plugin does not declare, is a refusal.

The host limits combined output to 16 MiB and kills the process tree on timeout. It supplies selected runtime environment variables and the resolved token, with value-based token redaction on captured output. Windows may inject additional system environment variables. Installed plugin code is trusted code and can access files under its operating-system identity.

On Windows, discovered executables must have an `.exe` extension. `.cmd` and `.bat` are unsupported. Scripts use explicit interpreter argv; no platform invokes a shell to interpret plugin arguments. Windows termination uses `taskkill /T /F`; POSIX termination uses a process group.

## Workflow host integration and audit

The CLI sets `ARCHON_CLI_COMMAND` at startup to a JSON argv array for the install's CLI: the compiled CLI executable, or the Bun runtime and CLI source entry in a source checkout. A source server also publishes the source CLI command. A compiled server launched by `archon serve` requires and preserves the launching CLI's value instead of publishing its own executable. Runs launched from the CLI, the Web UI or a chat or forge adapter therefore see the same CLI command. Bundled scripts append command arguments without shell parsing. An SDK host must supply its own argv array. A container execution does not receive the variable, because a host binary path is not assumed to exist in a container.

When `WORKFLOW_ID` is present, the CLI persists an `integration_operation` event through its database host. The forge payload retains operation correlation, qualified target, plugin identity/version, result and duration. Audit records keep identity and content digests only: the title and body a view operation returned, and each review, thread and conversation comment body, are replaced by a digest and a byte count, so authored content never lands in the run's durable event log. The engine does not interpret the forge payload. The CLI reports persistence failure separately from the operation's observed outcome.

## Work-item writes

Pass these request objects through `--data-file`. The host supplies `operationId` and `op`.

- `workitem.create`: `{repo: {host, path}, title, body, marker}`. The one-line marker must be the body's exact first line. The plugin enumerates issues across all states, excluding PRs, and compares the exact first line. A failed lookup or multiple matches refuses before writing. One match is read directly and returned with `changed:false`, including when closed; recovery never edits or reopens it. Otherwise one create is followed by an independent read. Fresh creation proves open state and requested title/body digests; recovery proves issue identity and marker digest while returning existing content digests.
- `workitem.labels.set`: `{ref: {repo: {host, path}, number}, labels: [name]}`. This replaces the complete label set; `[]` clears it. Every name must exist in the repository. It never creates labels. The result carries the independently observed exact set, and equal sets submit no write.
- `workitem.label.add`: `{subject: {kind: "issue" | "pr", ref: {repo: {host, path}, number}}, name}`. Adds one label and leaves every other label on the item alone. The subject's kind must match the item: a pull request is labelled by its pull-request reference, and a mismatch is refused before writing. The name must already exist in the repository with exact case; adding never creates a label. An item that already carries the label returns `changed:false` without writing. The result carries the item's complete label set as read back after the write.
- `workitem.label.remove`: the same request shape. Removes one label and leaves the others. An item that does not carry the label returns `changed:false`, including when another writer removed it between this call's read and its write.
- `workitem.list`: `{repo: {host, path}, label}`. Returns `{repo, label, items}`, every open issue and pull request that carries the exact label, each with `{ref, kind, url, state}`. The GitHub plugin follows every page and refuses a label name containing a comma, which its filter cannot express.
- `workitem.close`: `{ref: {repo: {host, path}, number}, reason}`, where `reason` is `completed`, `not_planned` or `duplicate`. Closes an issue and records the reason; a pull request is refused before writing. An issue already closed for the same reason returns `changed:false` without writing. One closed for another reason is refused as a conflict; a close never rewrites an earlier reason. The result carries the closed `workitem` and the `reason` as read back. A duplicate's link belongs in a comment written with `workitem.comment.upsert`.
- `repo.labels.list`: `{repo: {host, path}}`. Returns complete repository label names as `{repo, labels: [{name}]}`.
- `repo.label.ensure`: `{repo: {host, path}, name, color, description}`. Explicitly ensure one repository label. Color is six hexadecimal digits. An existing name returns `changed:false` without changing operator metadata. Creation performs one write and verifies name, color and description digest by a separate read.

Work-item mutation evidence contains `{ref, kind, url, state}`, never authored title/body. `kind` is `issue` for `workitem.create`, `workitem.labels.set` and `workitem.close`, and the subject's kind for single-label writes and `workitem.comment.upsert`. Label metadata evidence contains name, color and description digest. `workitem.view` may omit labels for older protocol-1 plugins; triage requires label facts and fails if absent.

`workitem.view` and `pr.view` return `author: {host, id, login}` when the plugin reports one. `null` means the forge has no author for the item, such as a deleted account. An older protocol-1 plugin may omit the field.

Marker recovery guarantees sequential reuse of a visible item, including after an unknown create outcome. It does not provide atomic uniqueness for concurrent creates: GitHub has no marker uniqueness constraint. Callers must reconcile unknown outcomes, never retry automatically inside a call. Whole-set label replacement preserves labels observed before writing, but cannot preserve concurrent edits between that read and the write. Two writers that each need one label should use `workitem.label.add` and `workitem.label.remove`: the GitHub plugin submits one label through GitHub's single-label endpoints, so a concurrent writer's labels survive.

Delivery uses an exact-content SHA-256 marker derived from title, claim, evidence and relation. Run provenance does not affect identity. Semantic duplicate detection is separate work. The SDLC pack's `archon-discoveries` workflow files a discovery with the marker `<!-- archon-discovery <key> -->`, where the key is the one its deciding agent gave the discovery; which discoveries are duplicates is that agent's judgment, not the marker's. The `gh` source performs the same lookup across all issue states before it creates one. Triage explicitly ensures only missing wanted pack labels, omits nonexistent area labels, then replaces labels while preserving observed unrelated names. The `gh` source remains supported; its issue creation retains the existing URL sidecar behavior.
