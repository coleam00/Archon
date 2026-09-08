---
title: Forge operations
description: Qualified public operations, pinned merges, and the versioned forge plugin protocol.
---

`archon forge resolve --json` resolves `origin` once to a repository with `host` and
`path`. Git's URL rewrite configuration applies. Local remotes and unclaimed hosts
return `forge: "none"`; an unclaimed host retains its parsed repository. Resolve
does not probe the remote host or require a credential.

`archon forge checks --ref '{"repo":{"host":"github.com","path":"owner/repo"},"number":42}' --json`
reads that PR's current head. It never selects a PR from the working directory or
branch. The result contains the observed `head_sha`, state, counts, and up to 100
unit summaries. Counts cover the complete enumeration. A head change during the
read refuses the observation with `verify_failed`.

GitHub checks enumerate check runs and commit statuses, including pagination.
The latest run within each app, suite, and name and the latest status per context
count. Push and PR suites with the same job name remain distinct. No rollup or
Actions workflow count determines the result.

The schema in `@archon/forge` owns identity, protocol, errors and checks vocabulary.
`packages/forge/wire-schema.json` is generated with `bun run generate:forge-schema`
and checked with `bun run check:forge-schema`. Runtime validation also enforces
count totals and aggregation precedence, which JSON Schema does not express.

| State | Meaning |
| --- | --- |
| none | No check units were enumerated; never a green verdict |
| pending | Known queued or running work |
| green | Successful, neutral, or skipped check runs; successful statuses |
| red | Failure, cancellation, timeout, stale runs, or error statuses |
| gated | Action-required conclusions or waiting/requested/pending check-run states |
| unknown | An unmapped status or conclusion |

Aggregation is red, gated, unknown, pending, then green, in that order. Deliver
reports gated and unknown as non-green and retains its registration grace for an
empty set.

GitHub also returns `base_ref` and, when policy is known, a `required` summary.
It queries the exact base ref's legacy `branchProtectionRule` through GraphQL and
paginates [active branch rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch),
including inherited organization rules. GitHub resolves branch matching and legacy
precedence. Required app/context pairs are deduplicated across both sources;
missing required checks are pending. App-bound requirements cannot be satisfied
by another app or by a status whose originating app cannot be verified.

`required.state: none` with zero counts means both policy sources established no
required status checks. An absent `required` means policy is unknown, with
`required_policy_error` explaining the failed read without exposing response bodies.
Permissions errors, GraphQL partial errors, malformed responses and unsupported
required workflow, deployment, code-scanning or unrecognized rules remain unknown. HTTP 404 never means no
policy. A PR head or base-branch change during enumeration refuses the observation.
The result is a current observation, not an atomic lock on remote policy.

The supervised merge queue requires the same pinned head and target base, known
required policy, and green external CI. Absence of CI is accepted only when zero
required checks are known and `.archon/merge-queue-policy.json` at the queue's
original pinned base contains exactly `{"external_ci":"none"}`. A candidate's file,
an agent verdict, and a caller-supplied policy cannot authorize that exception.

## Pinned merge

`archon forge pr merge-pinned --request-file merge.json --json` publishes an exact,
already-tested composition. Use `--request-file -` or `--request -` for stdin;
`--request '<JSON>'` also accepts the request directly. The request is:

```json
{
  "ref": { "repo": { "host": "github.com", "path": "owner/repo" }, "number": 42 },
  "expected_head_ref": "refs/heads/feature",
  "expected_head_sha": "1111111111111111111111111111111111111111",
  "expected_base_ref": "refs/heads/dev",
  "expected_base_sha": "2222222222222222222222222222222222222222",
  "candidate_sha": "3333333333333333333333333333333333333333",
  "checkout": "/absolute/path/to/tested/checkout"
}
```

The checkout must have a matching origin, a clean index and working tree, and HEAD
at `candidate_sha`. The candidate must have exactly two parents, **base first,
head second**. The caller owns composition testing, evidence integrity, approval,
queue ordering, and ensuring exclusive use of its checkout. This operation does
not infer test success or grant approval. Queue scripts call the forge operation;
they must not implement another publisher with `gh` or `git push`.

GitHub currently supports same-repository PRs on github.com. Fork heads and other
unsupported configurations return `unsupported_op`. The plugin uploads the exact
commit to a fresh temporary tag through an explicit HTTPS URL, with the selected
credential in the Git process environment. It then uses one
[atomic `updateRefs` mutation](https://docs.github.com/en/graphql/reference/git#updaterefs)
to compare both refs: a no-op head guard and a base update, both with `beforeOid`
and `force: false`. GitHub enforces the actor's server policy; the operation requests
no bypass or force update. This is a ref publication, not GitHub's merge queue or
`mergePullRequest` mutation. Policies requiring those mechanisms may refuse it.

Success requires read-back of the exact base commit, ordered parents, PR head,
merged state, and merge commit. A lost response causes reconciliation reads, never
a second publication in the same call. Repeating the identical request returns
`already_merged` only while those exact identities still agree. Any changed base,
head, or merge commit refuses verification. PR metadata itself is not part of the
ref transaction, so callers must serialize retargeting and other lifecycle actions.

Results and relevant errors carry `publication` (`not_attempted`, `unknown`, or
`applied`), the pins, and temporary-ref cleanup evidence. `applied` can accompany a
verification error when the base advanced but the PR read-back is unavailable or
has not converged. Such an error does **not** mean unmerged. After interruption,
retain the original request and reconcile it before creating another candidate.
If the plugin process is terminated, dispatch reports unknown publication with
the original pins; it may not know the temporary ref. Temporary tags use the
`refs/tags/archon-merge-` prefix. Cleanup compares their object identity and deletes
conditionally; failure never changes a verified merge into failure. A retained or
unknown temporary ref requires inspection before operator cleanup.

Offline tests exercise actual Git uploads and atomic ref transactions. The earlier
disposable-ref probe establishes API CAS capability only; full live PR read-back
and branch-protection behavior require a separate isolated integration run.

## Public PR lifecycle

Use `archon forge pr view|create|edit-body|ready --request - --json`,
`archon forge work-item view --request - --json`, or
`archon forge comment upsert --request - --json`. Supply the request JSON on stdin
(or use `--request-file <file>`, `--request-file -`, or inline `--request` JSON). The CLI selects the operation; credentials
never belong in the request. Generated wire schemas document every field.

A PR record contains `ref: {repo: {host, path}, number}`, `url`, `head_repo`,
`head`, `base`, `head_sha`, `is_draft`, `state`, `title` and `body`.
View takes `ref`. Create takes `repo`, `head_repo`, `head`, `base`, `head_sha`,
`title`, `body`, and `is_draft`. The head must already be pushed. Edit-body and
ready take `ref` plus `expected: {head_repo, head, base, head_sha}`; edit-body also
takes `body`. Writes refuse a closed PR or mismatched expected identity.

Create searches the qualified head before creating; a retry after an accepted
write with a lost response reads the existing PR. Reuse preserves its title, body
and draft state. An ambiguous head or a different base, head repository, or SHA
refuses. Content and draft changes require their explicit operations. Body edits
and ready are idempotent. GitHub ready uses
[markPullRequestReadyForReview](https://docs.github.com/en/graphql/reference/mutations#markpullrequestreadyforreview)
and reads the PR back; a successful mutation response with a draft PR still fails.

Comment upsert takes `target`, `marker` and `body`. A PR target is
`{kind: "pr", ref, expected}`; a work-item target is `{kind: "workitem", ref}`.
The marker must look like `<!-- archon-review-report -->` and becomes the first
line. All comments are searched, up to 100 pages of 100, before a write. An
incomplete enumeration or duplicate markers refuses. Read-back verifies target,
comment ID and exact body. Work-item operations reject GitHub PRs at the shared
issues endpoint. Serialize concurrent writers to one marker: GitHub provides no
atomic marker uniqueness constraint; ambiguity is reported rather than hidden.

All writes validate target identity and relevant fields after writing. A response
lost after submission returns `verify_failed` with a possible leave-behind; the
engine does not delete it. Retry the same request to reconcile. GitHub cannot
atomically condition these mutations on a head SHA, so a concurrent push can be
detected by read-back after a write has already happened. The refusal reports this
limit rather than claiming an atomic transaction.

The built-in GitHub plugin supports github.com. Explicit token configuration keeps
precedence. On solo CLI installs without an environment token, the CLI host invokes
[`gh auth token --hostname github.com`](https://cli.github.com/manual/gh_auth_token)
for the OS user's active account, respecting `GH_CONFIG_DIR` and the native keyring.
The token stays in memory and is neither printed nor stored. This lookup is disabled
in Archon's per-user GitHub mode and for explicitly scrubbed tokens: service hosts
must inject the selected user's credential. No provider configuration is replaced.
Self-hosted credentials remain the configured plugin's responsibility.

These are implementation choices for this slice, not approval of all broader
credential, invocation-gate or plugin-distribution designs discussed in #3040.

## Plugins

A plugin responds to `<executable> metadata` and `<executable> op <op-id>`.
Each operation receives its request JSON directly on stdin, without an envelope.
Write exactly one JSON response as explicit UTF-8 bytes to stdout. Diagnostics go
to stderr. Exit 0 means success, 1 means a declared operation error matching the
schema, and another exit means a process failure. Malformed output is a process
failure. Protocol 1 is a small compatibility integer, separate from the plugin
release version. Unknown metadata fields and additive capability strings are
allowed. Undeclared capabilities return `unsupported_op` before execution.

The implemented capabilities include `resolve`, `checks.state`, `pr.merge-pinned`,
`pr.view`, `pr.create`, `pr.edit-body`, `pr.ready`, `workitem.view` and
`comment.upsert`. Resolve is the
protocol root operation; subsequent forge intents use namespaced identifiers.
Plugins receive a qualified repository for resolve and a qualified PR for checks.
Metadata includes `protocol`, `name`, `version`, `forge`, canonical SaaS `hosts`,
`capabilities`, and an optional `token_env` for the family's credential source.
Only canonical public hosts belong in static claims. Self-hosted installations
need explicit configuration; there is no network discovery.

Archon discovers `archon-forge-*` in its home `plugins` directory and PATH, and
includes executables named by explicit configuration. Identical executable/argv
candidates are deduplicated. Distinct duplicate names or host claims fail loudly,
including a claim conflicting with a configured host. No first-on-PATH winner
hides another claimant. The maintained GitHub plugin runs as an internal CLI
subprocess through the same handshake, execution, credential, and validation path.

On Windows discovery requires `.exe` and matches case-insensitively. `.cmd` and
`.bat` are permanently unsupported, including explicit config commands, because
cmd.exe can interpret forge arguments. Use an absolute interpreter executable
with an argument array for a script plugin. Commands never use shell interpolation.

`~/.archon/forge.json` (or `--config <file>`) configures self-hosted mappings:

```json
{
  "hosts": {
    "git.example.com": {
      "plugin": "gitlab",
      "command": "C:\\tools\\bun.exe",
      "args": ["C:\\plugins\\gitlab.ts"],
      "token_env": "MY_GITLAB_TOKEN"
    }
  }
}
```

This is an install-owned forge configuration file for the initial seam. It does
not replace provider settings or credential storage. GitHub accepts
`GH_TOKEN`, then `GITHUB_TOKEN`, from the effective environment. Missing credentials
return `no_credential` after the supported native CLI lookup described above. Tokens
never travel in argv, URLs, or request JSON. Re-entry preserves the host's credential selection
instead of reloading env files and restoring scrubbed tokens.

Plugins are trusted local code, not a sandbox. Installing one permits code execution
during metadata discovery. They can access the user's filesystem and native config.
At launch, Archon passes essential process variables and only the selected token as
`ARCHON_FORGE_TOKEN`; run inputs, other tokens, and provider options are excluded.
Windows may inject additional system variables. Plugin output is bounded to 16 MiB
and selected-token values are redacted before exposure. Timeout and cancellation
terminate the process group on POSIX or explicitly invoke `taskkill /T /F` on Windows.
Escaping a POSIX process group is outside this cooperative process boundary.

`@archon/forge/conformance` exports schemas, checks fixtures, a non-ASCII fixture,
and `checkPluginConformance` for running an author's real executable against
fixture requests and expected responses. The package test suite exercises the
refusals and Windows process behavior without live forge writes.

## Workflow use and audit

Host subprocess nodes receive `ARCHON_EXECUTABLE` plus the JSON argument array
`ARCHON_EXECUTABLE_ARGS`. Invoke them with a subprocess argv API: source installs
need Bun and the source CLI entry, while compiled installs need only the binary.
Container hosts must supply a launch context valid inside the container; a host
path is not injected into a different filesystem.

Forge operations emit structured `forge_op` diagnostics with operation, target,
plugin, outcome and duration. Forward stderr when wrapping the CLI. The existing
engine `exec_output` transcript retains those records with the node's output.
There is no global sidecar log. A separate persisted workflow-event and console
projection are not part of this transcript integration.

Trigger operations remain follow-ups. Per-user/per-host credential storage,
generalized invocation requirements and doctor support are also not implemented
here. The current `requires: [github]` semantics remain in force.
