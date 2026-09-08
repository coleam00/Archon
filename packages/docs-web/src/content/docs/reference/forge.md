---
title: Forge operations
description: Qualified resolve and checks operations and the versioned forge plugin protocol.
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
empty set. The optional required-check subset is reserved in the contract but is
not queried by this initial GitHub implementation; consumers use the full set.

## Plugins

A plugin responds to `<executable> metadata` and `<executable> op <op-id>`.
Each operation receives its request JSON directly on stdin, without an envelope.
Write exactly one JSON response as explicit UTF-8 bytes to stdout. Diagnostics go
to stderr. Exit 0 means success, 1 means a declared operation error matching the
schema, and another exit means a process failure. Malformed output is a process
failure. Protocol 1 is a small compatibility integer, separate from the plugin
release version. Unknown metadata fields and additive capability strings are
allowed. Undeclared capabilities return `unsupported_op` before execution.

The implemented capabilities are `resolve` and `checks.state`. Resolve is the
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
not replace provider settings or credential storage. GitHub initially accepts
`GH_TOKEN`, then `GITHUB_TOKEN`, from the effective environment. Missing credentials
return `no_credential`. No token is read from `gh` storage or passed in argv, URLs,
or request JSON. Re-entry from a workflow preserves the host's credential selection
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

PR create/view/edit-body/ready, work-item view, marked comment upsert, merge and
trigger operations remain follow-ups. Per-user/per-host credential storage,
generalized invocation requirements and doctor support are also not implemented
here. The current `requires: [github]` semantics remain in force.
