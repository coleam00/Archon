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

GitHub is an optional, independently executable plugin. Its source is temporarily housed under `packages/adapters/src/forge/github`; the entry point imports the public forge contract and its own vendor code, not Archon's engine or adapter host. A release binary does not inject or require a GitHub implementation.

A source checkout and [Docker](/deployment/docker/#plugins) run the plugin from that source, the way they run the Claude, Codex and Pi providers, so it always matches the checkout. They need no install step and skip any scanned `archon-forge-github` executable, with a notice on stderr; `archon plugin remove coleam00/Archon/plugins/forge-github` removes an installed one. A `github` plugin configured by name under `forge.plugins` or a host mapping still runs instead of the source plugin.

Each Archon release publishes the plugin as a native executable for every platform the CLI ships on. With a release binary, install it with:

```sh
archon plugin add coleam00/Archon/plugins/forge-github
```

Without `@<tag>` it installs from the latest Archon release; `coleam00/Archon/plugins/forge-github@<tag>` pins one. The command:

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
archon forge resolve --data '{"remote":"https://github.com/owner/repository/pull/42","web":true}'
archon forge checks --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge workitem.view --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":31}}'
archon forge pr.view --data '{"selector":{"kind":"number","ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}}'
archon forge workitem.create --data-file ./issue.json
archon forge workitem.labels.set --data-file ./labels.json
archon forge workitem.label.add --data '{"subject":{"kind":"pr","ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}},"name":"queued"}'
archon forge workitem.label.remove --data '{"subject":{"kind":"issue","ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":31}},"name":"queued"}'
archon forge workitem.list --data '{"repo":{"host":"github.com","path":"owner/repository"},"label":"queued"}'
archon forge workitem.search --data '{"repo":{"host":"github.com","path":"owner/repository"},"text":"retry backoff","state":"any"}'
archon forge repo.labels.list --data-file ./repository.json
archon forge repo.label.ensure --data-file ./label.json
archon forge pr.create --data-file ./create.json
archon forge pr.edit-body --data-file ./body.json
archon forge pr.ready --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge pr.draft --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge pr.close --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge comment.upsert --data-file ./comment.json
archon forge workitem.comment.upsert --data-file ./issue-comment.json
archon forge workitem.close --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":31},"reason":"duplicate"}'
archon forge pr.merge --data-file ./merge.json
archon forge checks.rerun --data-file ./rerun.json
archon forge pr.reviews --data-file ./reviews.json
archon forge pr.threads --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge pr.files --data '{"ref":{"repo":{"host":"github.com","path":"owner/repository"},"number":42}}'
archon forge repo.file --data '{"repo":{"host":"github.com","path":"owner/repository"},"path":"src/app.test.ts","revision":"<commit sha>"}'
archon forge checks.logs --data '{"repo":{"host":"github.com","path":"owner/repository"},"unit":{"kind":"check","id":"71","name":"test (linux)"}}'
archon forge pr.thread.reply --data-file ./thread-reply.json
archon forge pr.thread.resolve --data-file ./thread-resolve.json
archon forge pr.review.submit --data-file ./review.json
archon forge workitem.edit-body --data-file ./issue-body.json
archon forge attachment.put --data-file ./attachment.json
```

`archon forge <operation> --help` prints that operation's request as a type, with its required and optional fields, and a minimal example `--data` value. Both come from the operation's request schema.

Every command emits JSON. When the host selects a credential, it adds `credentialSource` to the CLI response envelope with the source name, never the token. This is host diagnostic metadata; the plugin protocol is unchanged. `resolve` takes an explicit remote, including `null` for no remote. A local or unclaimed remote returns `{ "kind": "none", "forge": "none" }` inside the success result. It performs no HTTP host probe. Every other operation names its target explicitly: a qualified repository for creation, repository-label operations, listing by label, `workitem.search`, `checks.logs` and a `pr.view` head selector; a subject `{kind: "issue" | "pr", ref}` for single-label writes and `workitem.comment.upsert`; a qualified repository and number otherwise. None is inferred from the checkout.

The GitHub plugin also resolves HTTP Git remotes. For example, `http://github.example.com:8080/team/repo.git` resolves to host `github.example.com:8080` and path `team/repo` when that exact host and port are explicitly claimed by the plugin. The remote must not contain credentials, a query, or a fragment. Resolution needs no credential or network request; it does not select the API origin.

With `"web": true`, `resolve` reads the forge's web URL of an issue or a pull request instead of a Git remote, and the result adds `subject`: `{ "kind": "issue" | "pr", "number": n }` in `repo`. The shape of such a URL belongs to the forge, so a caller that holds one asks the plugin rather than parsing it; the SDLC pack does this for a pull request it was handed as a URL. A query or fragment is ignored, and a URL that names no issue or pull request returns `none`. A plugin advertises this with the `resolve:subject` capability, and the host refuses the request on a plugin without it. A `resolved` answer without `subject` is refused as an invalid response.

`pr.view` accepts either selector: `{"kind":"number","ref":…}`, or `{"kind":"head","repo":…,"headRepo":…,"head":"branch"}` with an optional `base`. The head form answers "does this branch have a pull request", so it resolves the **open** one and returns `null` when no open pull request matches the selector, including its `base` when one is given. A head matching more than one open pull request is a conflict rather than a guess. With `"state":"any"` in the head selector, it resolves the newest pull request on that head in any state, open, closed or merged, and returns `null` only when no pull request on that head, in any state, matches the selector and its optional `base`. A plugin declares that it supports this with the `pr.view:any-state` capability; the host refuses the request with `unsupported_op` for a plugin that does not, because an older plugin would ignore the field and answer for the open pull request only.

`--data-file <path>` reads the same JSON request from a file. Authored content — a pull-request body, a review comment — belongs there rather than in `--data`, so it never appears in any process's argument list.

Exit 0 means the operation succeeded. Exit 1 means it failed. Exit 2 means the operation returned a response but the host could not record it: its run audit could not be persisted, or the store refused an applied `pr.merge`'s record on the run's item. Stderr says which. A merge the host did not record because the plugin reported no merge time still exits 0; see [Workflow host integration and audit](#workflow-host-integration-and-audit). Stdout retains that response, which may be a success or a failed write with its mutation outcome; read it before retrying or reconciling, because exit 2 alone does not say whether a write happened.

### Temporary failures and read retries

Two error kinds say a failure is about the forge at that moment, not about the request. `unavailable` means the forge did not answer or answered that it is failing. `rate_limited` means the forge is limiting the caller. A plugin sets them from a status, a documented header or an error code, never from message text. The GitHub plugin reports `unavailable` for a 5xx answer or a request that got no answer, and `rate_limited` for a 429, for a 403 carrying `retry-after` or `x-ratelimit-remaining: 0`, and for a GraphQL `RATE_LIMITED` error. A 403 with neither header stays `authorization`: only its message says "rate limit", and message text is not read.

The host repeats a read that fails with either kind, from its start, up to three times, waiting 1, 2 and 4 seconds. The audit event records the count as `retries`. A read that still fails keeps its kind. The host never repeats a write: a temporary failure can arrive after the forge applied it, so a failed write runs once and reports its `mutation.outcome`.

Every failure message ends with the operation and what it was about, such as `(pr.view on github.com/owner/repository#42, retried 3 times)`.

A host released before these kinds reads them as `invalid_response`, and reports a write that failed with one as `outcome_unknown`. Update the host before, or together with, an installed GitHub plugin that sets them. A plugin that sets neither kind keeps working, and its reads are not retried.

### Check forge access before a run spends

```sh
archon forge check --json --data '{"host":"github.com","operations":["pr.view","pr.create","pr.merge"]}'
```

`check` answers for one forge: which plugin serves it, whether it advertises every name in `operations`, whether its credential resolves, and, for a repository, whether the forge accepts that credential. Name the forge in one of three ways:

- `host`: the plugin, capabilities and credential only. No forge operation runs.
- `remote`, a git remote URL: the plugin is selected exactly as a `resolve` of that remote selects it, and the result's `host` is the claim that selected it. A remote that names no forge host, such as a local path, answers `no_plugin_for_host` without echoing the URL.
- `repo`, such as `{"host":"github.com","path":"owner/repository"}`: the repository itself.

For a `remote` or a `repo`, the check then makes one read with the credential: a `pr.view` of the head `archon-forge-check`, after a `resolve` of a remote to its repository. A forge that rejects the credential answers `authorization`, and a repository the credential cannot see, or that does not exist, answers `not_found`. The read lists the repository's pull requests, so the credential needs pull-request read on it, on GitHub the Pull requests read permission; a credential without it is refused with `authorization` even when the run's listed operations would not need it. The read writes nothing and proves only that the credential may read the repository's pull requests: not that it may write, nor that it may use every listed operation. A plugin that does not advertise `pr.view` has no read to serve, so its check stops after the credential. `operations` takes operation names and any other capability a plugin advertises, such as `resolve:subject`.

The engine runs this check itself when a run of a pack that declares [forge needs](/reference/workflow-language/#pack-forge-needs) starts, so a missing plugin, capability or token refuses before a worktree or any agent. A workflow outside such a pack can still run it in its first node.

On success it exits 0 and the result names the plugin and, when the plugin needs a credential, the source it was found in, never the token:

```json
{
  "operationId": "…",
  "ok": true,
  "result": {
    "op": "check",
    "value": {
      "host": "github.com",
      "plugin": { "name": "github", "version": "0.14.0" },
      "operations": ["pr.view", "pr.create", "pr.merge"],
      "credentialSource": "GH_TOKEN"
    }
  }
}
```

Otherwise it exits 1 with the first reason that applies, in this order:

| `error.kind` | Meaning |
| --- | --- |
| `no_plugin_for_host` | No installed or configured plugin claims the host |
| `unsupported_op` | The plugin lacks at least one named operation; `unsupported` lists every one it lacks |
| `no_credential` | The plugin's credential environment is unset or empty |
| `process_failed` | Plugin discovery failed, or `gh auth token` failed for a GitHub host |
| `authorization` | The forge rejected the credential in the check's read, for example an expired or revoked token, or one without pull-request read on the repository |
| `not_found` | The credential cannot see the repository in the check's read, or the repository does not exist |

Any other failure of the read keeps its own kind, such as `unavailable` after the read's retries.

A `no_plugin_for_host`, `unsupported_op`, `no_credential`, `authorization` or `not_found` failure carries `remedy`, the operator's next step. For `unsupported_op` and `no_credential` it is the plugin's own text when its metadata states one under `remedies`, and otherwise forge's generic step (`archon plugin update`, or the credential variables the plugin reads). The remedy for `authorization` names the credential source, never the token.

The credential is resolved the way an operation resolves it, so for GitHub the check may run `gh auth token`. A `host` check, or one whose plugin does not advertise `pr.view`, makes no read: there a credential that resolves can still be expired or lack access to a repository, which the first operation reports.

### Call the forge from a script

A Bun `script:` node calls an operation with `forge(op, request)` from the `archon:script` module, typed per operation, and gets a `ForgeError` carrying the failure's `kind` and `mutation`. See [The script API](/guides/script-nodes/#the-script-api).

## What a write reports

`workitem.create`, `workitem.labels.set`, `workitem.label.add`, `workitem.label.remove`, `workitem.comment.upsert`, `workitem.close`, `repo.label.ensure`, `pr.create`, `pr.edit-body`, `pr.ready`, `pr.draft`, `pr.close` and `comment.upsert` each perform at most one write and then read the result back. A valid write request reports exactly one outcome, so a caller never has to guess which happened. A request that fails validation before dispatch is answered with `invalid_request` and no `mutation`; nothing was written.

| Outcome | Shape | What it means |
| --- | --- | --- |
| applied | `ok: true`, `result.value.outcome: "applied"` | The write was performed and read back. `changed: false` means the forge already carried the requested state and nothing was submitted. |
| refused | `ok: false`, `mutation.outcome: "refused"` | Nothing was written. The forge answered with a refusal, or the request was rejected before submission. |
| verification failed | `ok: false`, `mutation.outcome: "verification_failed"` | The write was acknowledged, but the read-back disagreed or could not run. `leaveBehind` names what may remain on the forge. |
| outcome unknown | `ok: false`, `mutation.outcome: "outcome_unknown"` | The request was submitted and its answer was lost, or the plugin's answer cannot show whether the write was applied (see the executable protocol below). Reconcile before retrying. |

A read-back never claims to have *prevented* a wrong write; it only reports what it could and could not confirm. A vendor that accepts a write and silently does not apply it is reported as a verification failure, never as success.

In the GitHub plugin, a read-back that disagreed carries `invalid_response`. A read-back that could not run carries the forge's own error kind and message, such as `rate_limited`, `authorization` or `unavailable`, so a lost permission reads differently from an outage. `status` is present when GitHub answered with an HTTP error; a dropped connection or a GraphQL error has none.

`pr.draft` converts an open pull request to draft and returns its verified PR record. An already-draft PR returns `applied` with `changed: false`; closed or merged PRs are refused with the observed record. A plugin that does not advertise `pr.draft` returns `unsupported_op` before execution. Nothing falls back to `gh`. The GitHub plugin uses [the GraphQL draft mutation](https://docs.github.com/en/graphql/reference/pulls#convertpullrequesttodraft) and reads the PR back before reporting success.

`pr.close` closes an open pull request without merging it and returns its verified PR record. An already-closed PR returns `applied` with `changed: false`; a merged PR is refused with the observed record. It never deletes the head branch and writes no comment: a caller that wants to say why writes one with `workitem.comment.upsert`. A plugin that does not advertise `pr.close` returns `unsupported_op` before execution. The GitHub plugin uses [the REST pull request update](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request) with `state: closed` and reads the PR back before reporting success.

`comment.upsert` writes the one comment whose first line is the exact `marker`, creating it when absent and replacing it in place when present. A body that does not begin with that marker is refused, and more than one marked comment is a conflict.

`workitem.comment.upsert` does the same on an issue or a pull request. It takes `{subject: {kind: "issue" | "pr", ref}, marker, body}`, and the subject's kind must match the item, so a mismatch is refused before writing. Its result adds the item's `workitem` record to the `comment`. `comment.upsert` keeps its pull-request `ref` form for existing callers and for installed plugins that predate subjects.

## Pinned merges, failed-check reruns and reviews

`pr.merge` takes `{ref, method: "merge" | "squash", conditions: {head, base?, tree?}}`. Every merge requires the caller's approved full head object ID. Missing heads and unsupported conditions are refused before operation execution. The conditions object rejects unknown keys. Plugin metadata declares enforced conditions under `mutationConditions["pr.merge"]`; absence declares none.

The GitHub plugin advertises and atomically enforces **only `head`**, through the REST merge endpoint's `sha` parameter. It refuses `base` and `tree` before writing. Reading the base before merging would not enforce a base condition. A stale head, draft, closed or already merged PR is refused. No head is refreshed or substituted to make a merge proceed.

An applied result includes `pr`, `method`, echoed `conditions`, `enforcedConditions`, `landed: {commit, tree, parents}` and `merged_at`, when the forge says the change merged, with an offset. Landed fields and `merged_at` come from read-back; unavailable supplemental tree or parents are null. `merged_at` is optional, so a plugin released before it still answers, and a run on an item then records no merge (see [Workflow host integration and audit](#workflow-host-integration-and-audit)). The GitHub plugin fills it from the pull request it reads back after the merge. Parent order is preserved. The landed commit can differ from the PR head after a squash or merge. A mismatched PR/head/commit is a verification failure, never a successful merge with guessed evidence.

`checks.rerun` takes `{ref, revision, units: [{unit: {kind, id, name}, rerun: {id, attempt} | null}]}` from a prior `checks.state` observation. Revision and IDs are opaque; names are display facts. Empty selections and duplicate unit identities fail validation. Unsupported units, stale attempts, wrong revisions and ineligible checks are refused before any write, including when another selected unit is eligible.

GitHub associates Actions checks with workflow runs using structured check-suite and app identities. Commit statuses and checks from other apps have `rerun: null`. Eligible completed failed, cancelled or timed-out checks cause one failed-job rerun per distinct owning run. GitHub also reruns dependent jobs, so this can rerun more jobs than the selected units. Attempt checks are preflight evidence, **not an atomic condition** on GitHub's rerun endpoint. Success requires read-back of the same run and revision with a newer attempt for every selected unit. GitHub accepts a rerun before the run reports its newer attempt, so the plugin repeats that read for up to 15 seconds across the request. When the newer attempt does not appear in that time, the answer is `verification_failed`: GitHub accepted the rerun and it is probably running, so read `checks.state` again before sending another.

Multi-run requests can have partial effects. Submission stops at the first failure. After an earlier acknowledged write, a later definitive refusal reports `verification_failed`; a lost submission response reports `outcome_unknown`. Failure evidence retains the requested units and observed newer attempts. Merge failures retain the attempted method and conditions and any landed observation. No operation retries a write, rolls back or deletes after an uncertain write; only the rerun read-back repeats. Reconcile using reads before taking another action.

`pr.reviews` takes `{ref}` and returns `{ref, items}` with submitted review and root diff-review comment items. Each carries `kind`, `id`, `author`, `commit`, vendor `state`, `createdAt`, `url` and `body`; unavailable facts are null. GitHub excludes pending draft reviews and thread replies, and includes dismissed submissions. Issue-conversation comments are not diff reviews. Bodies remain available to the caller but become digest/byte-count projections in audit events. The operation does not classify findings or choose required reviewers. A review posted through `pr.review.submit`, and each of its diff comments, also carries `submitKey`: the `key` it was submitted with. Leave out items that have a `submitKey` to read only what other reviewers wrote, or find one run's own review by its key. The author account does not tell them apart, because Archon posts with the operator's own credential. `submitKey` marks what was posted through the operation; it is not an authenticated identity, and anyone who copies the marker into a review can make it read as one. It is absent from a plugin released before it.

`pr.review.submit` posts a comment-kind review: the review Archon ran, shown on the pull request where every other review is read. **It is presentation, not a gate.** Nothing gates on it, and no stage reads a verdict from it; the verdict is the run's. It takes `{ref, commit, key, summary, comments: [{path, line, body}]}`. `commit` is the commit reviewed and must be the pull request's head, or the request is refused with `conflict` and the observed PR record, before anything is written. The head check is preflight evidence, not an atomic condition: the head can move before the review is posted, and GitHub still accepts a review on the older commit, so a submitted review does not prove `commit` is still the head. `line` is a line of `path` at `commit`. A comment whose line the diff shows goes on that line; any other, such as an unchanged line or a file the pull request does not change, is written into the review's summary under its path and line, so no finding is dropped. The applied result carries the `review` (`ref`, `id`, `url`, `commit`, `key`, `bodyDigest`) and `comments`, one entry per request comment in order, each `{path, line, placed}` with `placed` either `inline` or `summary`; it holds no authored text. `key` is the caller's identity for the review: pass the run id. A review already posted with the same `key` at the same `commit` and the same summary and comments is answered with `changed: false` and its own placement, and nothing is posted twice. One with the same `key` and `commit` but other content is refused with `conflict` naming it, so a new round's findings are never reported as placed in a review that does not hold them; submit those under another key. The same key at a new commit posts a new review. Submissions under one key are not serialized: two first submissions sent at once can both post, and a later repeat is then refused with `conflict`, so send one at a time per key. The review never approves or requests changes, so the operator's own credential can submit it on their own pull request. The GitHub plugin writes `key` as a hidden first line of the review body, `<!-- archon-review-key: KEY -->`, which GitHub does not render and `pr.reviews` reads back as `submitKey`. A plugin that does not advertise `pr.review.submit` fails `archon forge check` for it with `unsupported_op`, and the call itself is refused with `unsupported_op` before the plugin runs; a pack keeps publishing its comment instead.

`pr.threads` takes `{ref}` and returns `{ref, threads}`: every review thread on the pull request, each with its opaque `id`, `createdAt`, `commit`, `resolved`, `outdated`, `path` and `line` (null when the forge has none), and `comments` with `id`, `author`, `createdAt`, `commit`, `body` and `url`. `createdAt` is an ISO-8601 time; `commit` is the commit the comment was made on, or null when the forge does not record one. Both are absent when a plugin released before them answers, so treat a missing `createdAt` or `commit` as unknown. A thread's `createdAt` and `commit` are those of its opening comment, so comparing a comment's `createdAt` with a reviewed commit's time tells whether it arrived after that review. The GitHub plugin fills `commit` from the comment's original commit, reads every page of threads and of each thread's comments, so a long list is never cut short. Comment bodies become digest/byte-count projections in audit events.

`workitem.comments` takes `{subject: {kind: "issue" | "pr", ref}}` and returns `{workitem, comments}`: the item's record and every conversation comment on it, oldest first, each with `id`, `author` (null for a deleted account), `url` and `body`. A subject whose kind does not match the item is refused. The GitHub plugin reads every page, so a long conversation is never cut short. Comment bodies become digest/byte-count projections in audit events.

`checks.commit` takes `{repo, at: {kind: "revision", revision} | {kind: "default_branch"}}` and returns the same check set as `checks.state` (`units`, `summary`, `approvalPending`) with `{repo, branch, revision}`: `revision` is the commit the checks were read on, and `branch` names the default branch for the `default_branch` form and is null for a given revision. The GitHub plugin resolves the default branch and its head through GraphQL; a repository that reports none is `not_found`.

`pr.merge-state` takes `{ref}` and returns `{ref, head_revision, base_branch, base_revision, behind, mergeable, merge_commit}`. It describes the pull request against its own base branch, never the repository's default branch: `base_branch` is the branch the pull request targets and `base_revision` its head. `behind` counts the commits of `base_branch` at `base_revision` that the head at `head_revision` lacks, and `mergeable` says whether the head merges into that base. A caller that needs the default branch reads it with `checks.commit` at `{"kind": "default_branch"}`, which returns the branch name and its revision; the SDLC merge queue does this to refuse a pull request that targets another branch. A pull request whose base branch was deleted is `not_found`. `mergeable` is `clean`, `conflict` or `unknown`; GitHub computes mergeability lazily, so a first read may be `unknown`. `merge_commit` is the commit the pull request landed as, null until it is merged. The GitHub plugin compares through GraphQL, which accepts a head from a fork, and a failed comparison is an error, never a guessed zero.

`pr.files` takes `{ref}` and returns `{ref, head_revision, files}`. `head_revision` is the pull request's head as the list was read; pass it to `repo.file` to read text at the commit the patches belong to. `files` holds every file the pull request changes, each with `path`, `previous_path` (the path before a rename or copy, else null), `status` (`added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged`) and `patch`, which is null when the forge has no diff for the file, such as a binary or very large one. The GitHub plugin reads every page and refuses with `forge_error` when GitHub lists fewer files than the pull request changes, as it does past 3,000 files, or when the head moves while the list is read, so a partial list or one from another commit never reads as the whole change at `head_revision`.

`repo.file` takes `{repo, path, revision}` and returns `{repo, path, revision, text}`: the file's UTF-8 text at that commit. `path` is repository-relative; a `.` or `..` segment is an invalid request. A path that is not a file at that commit, such as a directory, is `not_found`; a malformed answer is `forge_error`. The GitHub plugin reads through the contents API, so a file over 1 MB, or one that is not UTF-8 text, is refused with `forge_error` rather than returned empty.

Patches and file text become digest/byte-count projections in audit events.

`checks.logs` takes `{repo, unit: {kind, id, name}, maxBytes?}`, where `unit` is one unit exactly as `checks.state` or `checks.commit` reported it, and returns `{repo, unit, log}`. A log is `{kind: "text", text, truncated, totalBytes}`. `maxBytes` bounds `text` in UTF-8 bytes: 65,536 when omitted, at most 1,048,576. A longer log keeps its end, because a failure is at the end, with `truncated: true` and the whole log's size in `totalBytes`; ask again with a larger `maxBytes` to read further back. A unit without a log is an answer, not an error: `{kind: "none", reason}`, where `unit_has_no_log` means this unit never has one, such as a commit status, and `log_unavailable` means the forge does not hold it now, because the unit is still running or the log has expired. A unit the forge does not know is `not_found`. The log is the forge's text as written; nothing in it is redacted, so a plugin must return only the log and never the request it made for it. In audit events the text is a digest and byte count.

The GitHub plugin has a log only for a GitHub Actions check run, whose check-run id is its job id. A commit status and another app's check run answer `unit_has_no_log`. GitHub serves a job log through a short-lived signed URL, which the plugin fetches without the token and never repeats in an error.

`pr.thread.reply` takes `{ref, thread, body}` and posts one reply on that thread; an applied result carries the `thread` and the new `comment` record with its body digest. `pr.thread.resolve` takes `{ref, thread}`; a thread already resolved is applied with `changed: false`. Both refuse, before writing, a thread that does not belong to the pull request `ref`.

`workitem.edit-body` takes `{ref, body}` for an issue and replaces its body; an applied result carries the issue record and the body digest read back. The forge has no conditional body write, so an edit saved between the caller's read and this write is lost. A pull request uses `pr.edit-body`.

## Attach an image to a change

`attachment.put` stores an image with the forge and returns a link that renders it in a comment, such as a screenshot a stage took of a UI change. It is presentation: nothing gates on it. It takes `{repo, contentType, content}`. `contentType` is `image/png`, `image/jpeg`, `image/gif` or `image/webp`; SVG is not accepted. `content` is the image's bytes as base64, from 1 byte to 5 MiB decoded; anything else is refused with `invalid_request` before dispatch. A script reads the file from its run's artifacts and passes the bytes. The forge names the file by the sha256 of its bytes, so no caller-supplied name reaches it; what the image shows is the caller's responsibility, so keep secrets out of the screenshot. The applied result carries `attachment: {url, digest, bytes, contentType}`, where `digest` is the sha256 hex of the bytes. The same bytes sent again are answered with `changed: false` and a link to the file already stored. The request's bytes are not written to the audit log; the result holds none.

Embed the link in any comment or review body:

```markdown
![Console at 1280 wide](https://github.com/owner/repo/blob/<commit>/<digest>.png?raw=true)
```

The GitHub plugin commits the file to the branch `archon-attachments` of `repo`, creating it as an orphan branch with no history of the repository's code. The branch holds only attachments, so a push to it runs no workflow. The link is `<repository URL>/blob/<commit>/<digest>.<ext>?raw=true`, pinned to the commit that added the file, so a later push to the branch cannot change what it shows. The image is exactly as visible as the repository: on a private repository only someone who can read it sees the image. Storing needs push access to `repo`. For a pull request from a fork, target the repository the pull request is proposed to; a token that cannot push there is refused with `authorization` before anything is written. The file is written by one move of the branch. When another writer moves the branch first, GitHub refuses the move, and the put is refused with `conflict` and GitHub's status; nothing was stored, and sending the same bytes again is safe. Nothing prunes the branch. Deleting `archon-attachments` is not guaranteed to make the images unreachable: the links address commits, and GitHub can keep serving commit-addressed content after the branch that held it is gone. Treat an attached image as published to everyone who can read the repository for as long as the repository exists.

A plugin that does not advertise `attachment.put` fails `archon forge check` for it with `unsupported_op`, and the call itself is refused with `unsupported_op` before the plugin runs, so nothing is written. A pack then keeps the image as a run artifact and says so in its report.

## GitHub credentials and check observations

The host resolves `GH_TOKEN`, then `GITHUB_TOKEN`, then the `gh` CLI login for the target host. The dispatcher passes the selected token to the child as `ARCHON_FORGE_TOKEN`. Tokens never belong in command arguments, JSON requests or remote URLs.

Inside a workflow (`WORKFLOW_ID` is set), and in the start-time forge check of a pack that declares `forge:`, a `GH_TOKEN`, `GITHUB_TOKEN` or `COPILOT_GITHUB_TOKEN` the command inherits is the run's credential. Neither `~/.archon/.env` nor the repository's `.archon/.env` replaces it, and an empty value (a credential the run withholds) stays empty. When the run sets no value, or a project `.env` names the key so startup strips it, those files supply the credential as they do outside a workflow.

Checks identify the evaluated revision and each check-run or commit-status unit. GitHub enumeration includes the newest run of each check and the latest status for each context. A check is a name within one Actions workflow, or within one other app: when a commit has several runs of one workflow, such as a cancelled run and the run that replaced it, only the newest run of each check counts, so a cancelled older run does not turn the commit red and a failed newer run keeps it red. Two workflows or apps that share a check name are two checks. An Actions check whose workflow run the plugin cannot identify counts on its own. Distinct runs with the same name in one run of a workflow are all preserved. It does not use GitHub's aggregate status as evidence that checks exist.

The summary states are `none`, `pending`, `green`, `red`, `gated` and `unknown`. `none` means zero enumerated units. The summary precedence is red, gated, unknown, pending, then green. `gated` names an explicit action-required conclusion; missing checks are not evidence of an approval gate. Unrecognized vendor states remain unknown with their native value retained.

`approvalPending` is independent of the unit summary. True means explicit approval evidence at the evaluated revision, false means the authoritative lookup found none, and null/absence means it was not established. GitHub reads head-filtered Actions workflow runs, including approval-blocked runs that registered no check units. Thus `summary.state: "none"` can coexist with `approvalPending: true`. Generic waiting states and zero units never imply approval. A failed Actions read or a query exceeding GitHub's 1,000-result search cap fails the observation rather than certifying no approval requirement.

GitHub tokens need repository pull-request and check/status read permissions, plus Actions read permission for check observations and Actions write permission for reruns. Merge requires Contents write permission. An authorization failure stays explicit; Archon does not switch credential sources or use the CLI to read checks after a plugin failure.

`required` is null when no authoritative required set was obtained. The current GitHub plugin returns null; it does not infer branch protection from check names.

## Use the forge path in the SDLC pack

The bundled SDLC pack reaches the forge only through `archon forge`; it has no other path. For github.com it needs two things:

1. **The plugin.** With the release binary or Homebrew, `archon plugin add coleam00/Archon/plugins/forge-github`, or a plugin you built yourself (see above). A source checkout and Docker run it from source and need nothing installed.
2. **A credential.** The host resolves GitHub credentials in order: `GH_TOKEN`, then `GITHUB_TOKEN`, then the `gh` CLI login via `gh auth token --hostname <forge-host>`. It passes the token to the plugin, including released v0.11.1 plugins. If a source is absent, the host tries the next; a selected token rejected by the forge, or an installed `gh` that fails or returns an empty token, is reported without trying another source. Tokens are never logged. [`archon forge check`](#check-forge-access-before-a-run-spends) names the credential source used.

With the release binary, Homebrew or a source install, an existing `gh auth login` works. Alternatively, put `GH_TOKEN` in Archon's env file, `~/.archon/.env`. In Docker, set `GH_TOKEN` in the compose `.env`, or authenticate `gh` inside the container; the host machine's login is not shared automatically. GitHub App mode supplies each run its token. The run shim refreshes installation tokens through the App credential helper without requiring the real `gh` executable. Prefer `GH_TOKEN` when configuring the forge alone: beside `WEBHOOK_SECRET`, `GITHUB_TOKEN` also switches the server's GitHub adapter into token mode.

An explicitly empty credential with no non-empty alternative refuses instead of using the host login. The engine uses empty values to deny an unconnected user's run access to shared credentials. For a solo install with an empty `GH_TOKEN=` line, remove that line to use `gh auth login`. An explicit `token_env` in trusted forge configuration selects only that variable; it does not consult the default sources. A GitHub plugin advertising custom credential names uses those names in its advertised order, without consulting the host login. The standard GitHub order applies when the plugin advertises only `GH_TOKEN` and/or `GITHUB_TOKEN`.

A [container execution](/guides/container-isolation/) has no host command for the forge, so a pack run in a container refuses when it starts. Delivery reads, answers and resolves a pull request's review threads through `pr.threads`, `pr.thread.reply` and `pr.thread.resolve`. Standalone `archon-review` reads a pull request it is given with `pr.view` and diffs it with `git`. The merge queue reads through `pr.view`, `pr.merge-state`, `checks.state`, `checks.commit`, `pr.threads` and `workitem.comments`, reruns a pull request's failed checks through `checks.rerun`, and merges through `pr.merge` pinned to the head. A selected non-GitHub plugin must advertise the operations those steps use; an unsupported operation fails without falling back to another tool.

The PR and test-value metrics read each pull request's `timestamps` from `pr.view` and refuse a view without them; the test-value judge reads `pr.files` and `repo.file`. The build queue reads a dead round's pull request through `pr.view` by head with `"state":"any"`, which needs `pr.view:any-state`; the pack does not list that capability, so on a plugin without it the queue refuses, naming that capability, when it releases a dead claim that recorded a branch. A red default branch always ends the sweep as a failed outcome for a person to look at, because `checks.rerun` acts only on a pull request.

The pack declares every forge operation its scripts call as its [forge needs](/reference/workflow-language/#pack-forge-needs), in [`.archon/workflows/sdlc/.pack/pack.yaml`](https://github.com/coleam00/Archon/blob/dev/.archon/workflows/sdlc/.pack/pack.yaml). The engine checks them when a run of any pack workflow starts, before a worktree or any agent: [`archon forge check`](#check-forge-access-before-a-run-spends) must answer for the plugin, every listed operation and the credential, for the repository the run names in `repo_host` and `repo_path`, such as a merge-queue binding's, or, when it names none, for one of the checkout's remotes. A missing plugin, operation or token, or a token the forge rejects for that repository, refuses there, naming the remedy, rather than after implementation and review. With per-user GitHub enabled, a run started by a user who has not connected their own GitHub identity has no token and is refused the same way. The check's one read is a `pr.view` by head, so the token needs pull-request read on the repository and is refused at start without it. The read proves the token may read the repository's pull requests; it does not prove what the token may write: each forge call of the run proves only the access it uses. The operations themselves still refuse on their own.

The list is one for the whole pack, so every pack workflow needs a plugin that advertises all of it, including a workflow that calls only some. The merge queue's gate and the PR and test-value metrics also resolve a pull request URL, which needs the `resolve:subject` capability. No release up to v0.14.0 has it; the first release after v0.14.0 does, and a source checkout or Docker always does. The pack does not list `resolve`. On a plugin without `resolve:subject`, the host refuses the resolve, naming the missing support, and the step that called it fails. The build queue resolves a round's pull request URL when it records the round, to store the number; when the resolve fails, the round is still recorded without a number and the run notes why. Its next read of the item's pull request resolves the URL again and refuses there if it still cannot.

The draft pull request and the canonical review comment are written in deterministic nodes — `publish-pr` and `publish-review` — that publish through the forge and fail unless the result reads back. In delivery, `publish-pr` also writes the description content a round prepared, as a marked section of the description, before that round's review. Two agents write through the forge: `update-pr-body` edits the description after review, and the `ci` agent marks the pull request ready and puts it back to draft on red. The correction agent pushes its commit with plain `git`. Whether a branch already has a pull request is decided by an open-head lookup, so a second one is never opened for it.

Initial PR publication has a 180-second node deadline. A push that exits nonzero fails the node; a successful push must still read back the remote ref as HEAD before publication continues. The publication node does not automatically retry a failed push, a timeout or a forge failure. Before creating a PR, publish records a durable `pr-create-started` file in the run's artifacts. On explicit resume, publication pushes again, then looks for the PR. If it finds one, it reuses it; if a create was started but no PR is visible, it fails with an unresolved-write message instead of submitting a competing create. Resume can reconcile the PR once it becomes visible. Keep the record while the write is unresolved: stopping a local client does not cancel a request already submitted to the forge.

What a red check means is an agent's judgment. Under `ci: forge`, the delivery's `ci` node reads the checks once with `checks.state` before it marks the pull request ready. It hands off pending checks, and red checks the pull request did not cause, for the merge queue to judge; a red check the pull request caused sends it back to the implementer, still a draft. Under `ci: none` the agent runs the project's full validation itself and records it. It acts on the pull request `publish-pr` recorded, never one found from the checkout's remote. A red check's log is evidence for that judgment, which the agent reads with `checks.logs`. No workflow preflights `checks.logs` or `workitem.search`, the two reads only agents call: a plugin without one refuses the call with `unsupported_op`, and the agent reports that. A step whose forge operation cannot answer fails with the reason, for example `no forge plugin claims <host>`.

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

Discovery examines configured executables, `~/.archon/plugins`, configured `pluginDirs`, and PATH names beginning with `archon-forge-`. In a source checkout or Docker, the GitHub plugin run from source takes the place of every scanned `archon-forge-github`; if it fails its metadata handshake, discovery fails rather than running an installed copy. Duplicate identities or host claims fail loudly. Failed explicitly configured or host-selected plugins fail discovery. An unrelated automatically scanned candidate with a failed metadata handshake or file inspection (`stat` or POSIX executable `access` check) is reported on stderr and kept as unavailable evidence. Inspection diagnostics include the command, failed check, and original error. Healthy plugins still serve their claimed hosts. A broken link (`stat` ENOENT) keeps the metadata-handshake failure behavior. A file with no execute bits that fails `access` with EACCES is skipped with a notice and adds no unavailable evidence. Other access failures, including EACCES on a file with execute bits, remain unavailable evidence. When a scanned executable is also configured with the same command and arguments, its inspection failure is preserved and discovery fails as it does for other configured-plugin failures. If no valid plugin serves it and any candidate failed, resolution fails rather than reporting no forge. No forge is injected as an implicit fallback. No remote URL can select an arbitrary executable.

## Executable protocol

The authoritative Zod schemas and derived TypeScript types are exported by `@archon/forge/operations`. Dispatch and configuration are separate exports, `@archon/forge/dispatch` and `@archon/forge/plugin-config`.

`@archon/forge/conformance` exports `runForgeReadConformance` for controlled repository fixtures. Pass the plugin operation function and cases naming the expected revision, state and exact unit identities. The kit validates the response schema, correlation, qualified target, counts and summary.

It also exports `runForgeMutationConformance` for write fixtures. Pass the plugin operation function, its metadata, and cases naming the request and the outcome the fixture sets up. The kit validates the response schema, correlation, qualified target, the applied result against the request that asked for it, and that the reported outcome is the expected one.

The host invokes `PLUGIN metadata` before any operation. Metadata declares integer protocol version 1, plugin name/version, forge family, static hosts, capabilities (the operations it supports, plus capability tokens such as `pr.view:any-state` that are not operation names), enforced mutation conditions, credential environment names and, optionally, `remedies`: the operator's next step for an `unsupported_op` or `no_credential` refusal from `forge check`, as text. Protocol incompatibility and unsupported operations fail before operation execution.

For an operation, the host invokes `PLUGIN op OPERATION` — `resolve`, `checks.state`, `checks.commit`, `checks.logs`, `workitem.view`, `workitem.comments`, `workitem.list`, `workitem.label.added`, `workitem.search`, `workitem.create`, `workitem.labels.set`, `workitem.label.add`, `workitem.label.remove`, `workitem.comment.upsert`, `workitem.close`, `repo.labels.list`, `repo.label.ensure`, `pr.view`, `pr.create`, `pr.edit-body`, `pr.ready`, `pr.draft`, `pr.close`, `pr.merge`, `checks.rerun`, `pr.reviews`, `pr.threads`, `pr.merge-state`, `pr.files`, `repo.file`, `pr.thread.reply`, `pr.thread.resolve`, `pr.review.submit`, `workitem.edit-body`, `attachment.put` or `comment.upsert` — sends one JSON request on stdin and expects one JSON response on stdout. Write explicit UTF-8 bytes. Diagnostics go to stderr. Exit 0 carries a success response; exit 1 carries a structured operation error. Other exits, malformed JSON and mismatched operation/target identity are process or protocol failures. A response that fails the operation's result schema is an `invalid_response` whose message names the operation and the failing fields by path and issue code, never their values. A plugin that still answers `pr.merge-state` with the earlier `default_branch` and `default_revision` fields fails this way, naming `result.value.base_branch` and `result.value.base_revision`.

A plugin that fails a write must state which outcome it was under `mutation`, and an applied result must answer the request that asked for it — the same pull request, the same head and draft state for a create, the digest of the body it was given for an edit or comment. The host checks both rather than trusting the claim. A failed write with no stated outcome, or an applied result that does not answer the request, becomes `outcome_unknown`: the plugin ran, so what it did to the forge is no longer knowable from here. A write whose plugin process never started, or whose operation the plugin does not declare, is a refusal.

The host limits combined output to 16 MiB and kills the process tree on timeout. It supplies selected runtime environment variables and the resolved token, with value-based token redaction on captured output. Windows may inject additional system environment variables. Installed plugin code is trusted code and can access files under its operating-system identity.

On Windows, discovered executables must have an `.exe` extension. `.cmd` and `.bat` are unsupported. Scripts use explicit interpreter argv; no platform invokes a shell to interpret plugin arguments. Windows termination uses `taskkill /T /F`; POSIX termination uses a process group.

## Workflow host integration and audit

The CLI sets `ARCHON_CLI_COMMAND` at startup to a JSON argv array for the install's CLI: the compiled CLI executable, or the Bun runtime and CLI source entry in a source checkout. A source server also publishes the source CLI command. A compiled server launched by `archon serve` requires and preserves the launching CLI's value instead of publishing its own executable. Runs launched from the CLI, the Web UI or a chat or forge adapter therefore see the same CLI command. Bundled scripts append command arguments without shell parsing. An SDK host must supply its own argv array. A container execution does not receive the variable, because a host binary path is not assumed to exist in a container; a run of a pack that declares forge needs is therefore refused at start when it would execute in a container.

When `WORKFLOW_ID` is present, the CLI persists an `integration_operation` event through its database host. The forge payload retains operation correlation, qualified target, plugin identity/version, result, the number of read retries and duration. Audit records keep identity and content digests only: the title and body a view operation returned, and each review, thread and conversation comment body, are replaced by a digest and a byte count, so authored content never lands in the run's durable event log. The engine does not interpret the forge payload. The CLI reports persistence failure separately from the operation's observed outcome.

An applied `pr.merge` from a run on an item also records the merge on that item, as [`workflow merged`](/reference/cli/#workflow-merged) does with `via: forge`, and the landing branch, as [`workflow landing`](/reference/cli/#workflow-landing) does. Every fact comes from the merge result: the change is the merged pull request's URL, the commit its `landed.commit`, the time its `merged_at` and the branch its `base`. The CLI response then carries `itemRecord: {recorded: true}`. A merge that is refused, fails, or whose outcome is unknown records nothing, and a run on no item gets no `itemRecord`. A plugin whose result has no `merged_at` leaves the item without either record, since the host does not invent the time: the merge still exits 0, the response carries `itemRecord: {recorded: false, reason: "no_merge_time"}`, and stderr says to update the plugin: find its id with `archon plugin list`, then run `archon plugin update <id>`. `forge()` in `archon:script` passes that line on. A workflow that still calls `recordMerge` and `recordLanding` afterwards keeps the first record.

## Work-item writes

Pass these request objects through `--data-file`. The host supplies `operationId` and `op`.

- `workitem.create`: `{repo: {host, path}, title, body, marker}`. The one-line marker must be the body's exact first line. The plugin enumerates issues across all states, excluding PRs, and compares the exact first line. A failed lookup or multiple matches refuses before writing. One match is read directly and returned with `changed:false`, including when closed; recovery never edits or reopens it. Otherwise one create is followed by an independent read. Fresh creation proves open state and requested title/body digests; recovery proves issue identity and marker digest while returning existing content digests.
- `workitem.labels.set`: `{ref: {repo: {host, path}, number}, labels: [name]}`. This replaces the complete label set; `[]` clears it. Every name must exist in the repository. It never creates labels. The result carries the independently observed exact set, and equal sets submit no write.
- `workitem.label.add`: `{subject: {kind: "issue" | "pr", ref: {repo: {host, path}, number}}, name}`. Adds one label and leaves every other label on the item alone. The subject's kind must match the item: a pull request is labelled by its pull-request reference, and a mismatch is refused before writing. The name must already exist in the repository with exact case; adding never creates a label. An item that already carries the label returns `changed:false` without writing. The result carries the item's complete label set as read back after the write.
- `workitem.label.remove`: the same request shape. Removes one label and leaves the others. An item that does not carry the label returns `changed:false`, including when another writer removed it between this call's read and its write.
- `workitem.list`: `{repo: {host, path}, label}`. Returns `{repo, label, items}`, every open issue and pull request that carries the exact label, each with `{ref, kind, url, state}` and, optionally, `updatedAt`: the forge's time of the item's last change, which a label add changes. A label observer skips the label-event read of an issue whose `updatedAt` it saw unchanged; without it, the issue is read on every pass. The GitHub plugin follows every page and refuses a label name containing a comma, which its filter cannot express.
- `workitem.label.added`: `{subject: {kind, ref}, name}`. Returns `{subject, name, added}`, where `added` is `{id, at, actor}` for the most recent time the exact label was added to the item, by the forge's own label event, or `null` when the forge records none. The event id tells two adds apart, so a label removed and added again reads a new `id`. The GitHub plugin reads every page of the issue's events.
- `workitem.search`: `{repo: {host, path}, text, kind?, state?, limit?}`. A read. Returns `{repo, text, items, truncated}`: the issues and pull requests in that repository that match `text`, most recently updated first, each with `{ref, kind, url, state, title, updatedAt}`. `kind` is `issue` or `pr`, and both when omitted. `state` is `open`, `closed` or `any`, and `open` when omitted; a merged pull request is `closed`. `limit` is at most 100 and 30 when omitted; `truncated` is true when more matched than `items` holds, and there is no next page: narrow the text, kind or state. How `text` matches is the forge's own search, with its own ranking of words, phrases and any qualifiers; the contract promises no query language, so a caller that needs an exact answer reads the items it found. A search index can lag a new item by a minute or more. The words and each title become digest/byte-count projections in audit events. The GitHub plugin passes `text` to GitHub's issue search inside `repo:<owner>/<name>`, asks once per kind, refuses a query over GitHub's 256 characters as `invalid_request`, and fails the read if a match belongs to another repository.
- `workitem.close`: `{ref: {repo: {host, path}, number}, reason}`, where `reason` is `completed`, `not_planned` or `duplicate`. Closes an issue and records the reason; a pull request is refused before writing. An issue already closed for the same reason returns `changed:false` without writing. One closed for another reason is refused as a conflict; a close never rewrites an earlier reason. The result carries the closed `workitem` and the `reason` as read back. A duplicate's link belongs in a comment written with `workitem.comment.upsert`.
- `repo.labels.list`: `{repo: {host, path}}`. Returns complete repository label names as `{repo, labels: [{name}]}`.
- `repo.label.ensure`: `{repo: {host, path}, name, color, description}`. Explicitly ensure one repository label. Color is six hexadecimal digits. An existing name returns `changed:false` without changing operator metadata. Creation performs one write and verifies name, color and description digest by a separate read.

Work-item mutation evidence contains `{ref, kind, url, state}`, never authored title/body. `kind` is `issue` for `workitem.create`, `workitem.labels.set` and `workitem.close`, and the subject's kind for single-label writes and `workitem.comment.upsert`. Label metadata evidence contains name, color and description digest. `workitem.view` may omit labels for older protocol-1 plugins; triage requires label facts and fails if absent.

`workitem.view` and `pr.view` return `author: {host, id, login}` when the plugin reports one. `null` means the forge has no author for the item, such as a deleted account. An older protocol-1 plugin may omit the field.

A forge actor (`author` on `pr.view`, `workitem.view`, `pr.reviews`, `pr.threads` and `workitem.comments`, and `actor` on events) is `{host, id, login, type}`. `type` is `user`, `bot` or `organization`; it is null when the forge does not say or the account is another kind, and absent when a plugin released before it answers, so treat a missing `type` as unknown. The GitHub plugin fills it from `__typename` on review-thread authors and from `type` on REST and webhook users. GraphQL bot logins carry no `[bot]` suffix, so read `type` rather than the login to tell a bot from a person. `id` is the account's numeric id on GitHub wherever the source is read, so it matches across review threads, REST reads and webhook events and survives a rename. GitHub gives one review-thread author kind, an enterprise user account, no numeric id; its `id` is then the account's GraphQL node id.

`pr.view` also returns `timestamps: {created_at, merged_at, closed_at}` when the plugin reports them. An open pull request has neither `merged_at` nor `closed_at`; a merged one has `merged_at`; one closed without merging has `closed_at` and no `merged_at`. The host refuses timestamps that contradict the pull request's `state` as an invalid response. An older protocol-1 plugin may omit the field, so a caller that needs timestamps must refuse a view without them.

Marker recovery guarantees sequential reuse of a visible item, including after an unknown create outcome. It does not provide atomic uniqueness for concurrent creates: GitHub has no marker uniqueness constraint. Callers must reconcile unknown outcomes, never retry automatically inside a call. Whole-set label replacement preserves labels observed before writing, but cannot preserve concurrent edits between that read and the write. Two writers that each need one label should use `workitem.label.add` and `workitem.label.remove`: the GitHub plugin submits one label through GitHub's single-label endpoints, so a concurrent writer's labels survive.

Delivery uses an exact-content SHA-256 marker derived from title, claim, evidence and relation. Run provenance does not affect identity. Semantic duplicate detection is separate work. The SDLC pack's `archon-discoveries` workflow files a discovery with the marker `<!-- archon-discovery <key> -->`, where the key is the one its deciding agent gave the discovery; which discoveries are duplicates is that agent's judgment, not the marker's. Triage explicitly ensures only missing wanted pack labels, omits nonexistent area labels, then replaces labels while preserving observed unrelated names.
