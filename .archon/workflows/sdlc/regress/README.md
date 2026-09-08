# Regression diagnosis and issue publication

`archon-regress` validates the current checkout and returns `clean`, `defects`, or
`inconclusive`. It invokes `archon-investigate` only after collecting product-red
evidence. It never fixes, commits, pushes, or merges source. Schedules and autonomy
belong to the caller. Bun and Git must be available; GitHub publication also needs
an authenticated `gh` with issue read/write access.

## Inputs and composition

| Input     | Default | Contract                                                                                                                                                                                              |
| --------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`   | `""`    | Optional project validation scope. Empty selects the full applicable gate. It is data, never interpolated into a command.                                                                             |
| `policy`  | `""`    | Absolute path to an operator-trusted JSON profile outside the checkout, including after symlink resolution. Selecting it authorizes its fixed command. Never accept this path from candidate content. |
| `public_probe_scope` | `""` | Optional scope for a public probe of a configured profile, run only when that profile's full gate returns non-clean. Setting it authorizes only public developer checks and evidence in that scope. Ignored without a `policy`. |
| `publish` | `false` | Only `true` authorizes issue creation, and it authorizes export. A trusted profile contributes its approved public cases; ordinary discovery and a public probe contribute the diagnosis agent's public finding text plus the tracked source locations it proves. No publication capability is given to an agent node. |

```sh
archon workflow run archon-regress --input scope=parser
archon workflow run archon-regress --input policy=/operator/checks/regress.json --input publish=true
archon workflow run archon-regress --input policy=/operator/checks/regress.json \
  --input public_probe_scope='Run bun run lint and bun run test.' --input publish=true
```

Compose with the same input names:

```yaml
- id: regression
  include: archon-regress
  with:
    scope: ''
    policy: /operator/checks/regress.json
    public_probe_scope: ''
    publish: false
```

The engine's configured `BASE_BRANCH` must resolve locally to a commit. No fetch,
checkout, or guessed branch is performed. HEAD, base name, base revision, and scope
are recorded with evidence. Tracked changes cause an inconclusive result; use a
clean checkout of the intended revision. Untracked run scaffolding is not part of
the revision. Do not introduce untracked product inputs into the check. Regress's
own nodes and the investigation agent declare `mutates_checkout: false` for engine
enforcement. The existing validate block promises advisory behavior in its prompt;
the collector and final script additionally check the recorded revision and tracked
state. Workflow-level `mutates_checkout` declares concurrency safety and remains
owned by the caller when composing with `include`. These checks detect changes; a
worktree is not a security sandbox and cannot prevent a malicious tool's writes.
Use the host's execution isolation for untrusted repositories or commands.

## Ordinary discovery

Without a policy, `archon-validate` discovers the project's own gate and writes
`validation.md`. Regress collects a fresh, nonempty copy into its artifact
directory and records its digest. Missing artifacts, unavailable
tools/services/browser runtimes, no runnable checks, and unproven causes are
inconclusive. Inherited product-red can warrant investigation, but does not by
itself prove this branch introduced the failure.

The model's green/cause fields are claims, so preparation also plants a recorder
and asks archon-validate to run every gate command through it. A public probe uses
the same recorder and the same receipt rules:

```sh
bun "<artifacts>/regress/recordings-*/record.ts" --record bun run test
```

The recorder runs the command in the checkout, streams its output unchanged, exits
with its status, and writes one receipt: the command, its exit status, the revision,
base, and scope it ran under, and whether the tracked tree was still intact
afterwards. Command output never enters a receipt, so no private stream can travel
into evidence, a prompt, or an issue. That requirement reaches archon-validate
through its `scope` input, which regress extends rather than replaces; a caller's
scope is preserved verbatim.

Receipts are the collector's execution proof. No receipts means inconclusive, for
green as much as for red: an unproven gate is not a clean one. A receipt from
another revision, base, scope, or checkout, or one taken against a dirtied tracked
tree, makes the whole collection inconclusive. `clean` needs every recorded command
to have exited zero; `product` needs the model's introduced/inherited classification
and at least one command that ran to a nonzero exit. A command killed before it
completed proves nothing in either direction.

Receipts prove execution against a cooperating agent. They are not a defense against
an agent that sets out to deceive: a node that can run the project's checks can also
write files. The engine's `mutates_checkout: false` and these receipts detect
mutation and fabrication after the fact; use host isolation when the checkout or its
commands are untrusted.

## Publication from ordinary discovery

This is also the route a public probe publishes through; `source` is the only difference.
A discovered finding is publishable only when the diagnosis agent attaches a
`public_proof` and every part of it survives a deterministic re-check:

| Proof field                   | What the final script re-checks                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `root_cause_key`              | A stable lowercase machine key. It identifies a new cause and marks the issue this run files.                                      |
| `existing_issue`              | Zero, or an issue the tracker still returns as an open marked regression issue. Two findings may not name the same one.            |
| `executions`                  | Every cited id is a receipt this run collected, and at least one ran to a completed nonzero exit.                                   |
| `test` and `cause`            | Repository-relative paths whose line ranges exist in `git` at the checked revision, not in the working tree, and never outside it. |
| `completed_product_assertion` | The agent's explicit per-finding claim that the product itself failed, rather than its environment.                                 |

Publication additionally needs product-red evidence, a rooted investigation with a
report, an unchanged checkout and evidence record, `publish=true`, and distinct root
keys across findings. Anything missing leaves the finding local: a diagnosed defect
with `publication: blocked`, never a filed issue.

The issue then carries the agent's public finding fields plus the two verified source
locations and the observed revision. The private material of an ordinary run, meaning
`validation.md`, receipt commands, and artifact and checkout paths, is never copied
into it, and a case whose public text still contains this run's checkout or artifact path
is refused before any request. That is a path containment check, not a secret
detector: everything else rests on the diagnosis prompt and the review of what it
wrote. Read a first issue from a new project before scheduling unattended runs.

### Reusing the issue a cause already has

A trusted profile's `root_cause_key` belongs to the check author and is stable by
construction. A discovered key is not: two runs judging one defect phrase their keys
differently, the markers do not match, and the second run files a duplicate. Keys
therefore identify new causes only. Reuse is decided against the tracker itself.

When `publish=true` and the collected evidence is product-red, the collector reads the
repository's open marked regression issues and returns them as `catalog`: for each one its
number, title, and a bounded, marker-free excerpt of its body. The diagnosis compares its
proven cause against them and sets `existing_issue` to the number that tracks the same
source-owned cause, or `0` for a new one. That comparison is model judgment on untrusted
remote text; every consequence of it is checked deterministically:

- A finding still needs its full `public_proof`. Reuse is not a way to publish something
  the repository does not prove.
- Before each create the publisher re-lists the tracker. An exact marker match wins
  outright, and `existing_issue` is honoured only when that number is still an open issue
  carrying a regress marker in this repository. Anything else stops publication with no
  create, rather than guessing.
- The reused issue is not edited, retitled, reopened, or re-marked. It keeps the marker and
  number it was filed under, and the run's own key is reported beside it as `matched: cause`.
- Two findings cannot name the same issue, and separate causes keep separate keys, so an
  unrelated defect in the same file is still filed on its own.

`catalog.complete` is false when the listing failed, could not be parsed, or holds more than
100 marked open issues. Nothing in it is then a safe negative, so an ordinary publication is
held with its reason rather than filing what may be a duplicate. The configured route is
unaffected: its keys are stable, so it never depended on the catalog.

Catalog text is public tracker content that anyone could have written. It is untrusted
evidence for comparison only: the diagnosis prompt forbids treating it as instructions, and
nothing from it can reach an issue, because issue bodies are built from the finding's own
fields. A wrong match costs a missed filing, never a leak.

## Public probe of a configured full gate

A configured profile can be the only gate an operator trusts and still be unable to
publish anything: a check whose evidence is entirely private reports `public_cases: []`,
so every red run ends inconclusive with nothing to file. `public_probe_scope` is the
operator's way out, and it changes nothing about the gate itself.

The full private gate still runs first and stays mandatory. When it is clean, the run is
clean and no probe happens. When it is non-clean and no probe is configured, the strict
configured behavior is unchanged: only the check author's approved `public_cases` can
support a finding. When it is non-clean and a probe is configured, `archon-validate` runs
once more over the operator's public scope, through the same recorder and the same
receipts ordinary discovery uses, and its evidence arrives with `source: public-probe`.

Setting `public_probe_scope` is the operator's statement that the checks it names, and
everything they emit, are public developer material with no private evaluator sources in
reach. The workflow enforces the rest:

- Only a **proven product-red public probe** continues. A green probe, an unavailable one,
  a probe with no receipts, and a probe whose receipts do not bind to this revision all
  return inconclusive carrying the full gate's refusal. A probe can never turn a failed
  full gate green.
- The probe's findings publish through ordinary discovery's route: `publish=true`, a rooted
  investigation, an unchanged checkout and evidence record, and a `public_proof` whose
  receipts and source references the final script re-checks. The configured route's trusted
  `public_cases` are unreachable from probe evidence ; the evidence source alone decides
  which proof a finding needs.
- Nothing the configured check produced crosses over. Probe evidence is built only from
  `archon-validate`'s own artifact and this run's receipts: no raw check output, no report
  fields, no report path, no `public_cases`. The gate contributes one opaque fact, that it
  was not clean, and the model context, the investigation, and any issue body see only
  the public probe's own material.
- That includes the operator's own `scope`, which is a private brief for the evaluator gate
  and reaches it only through `REGRESS_SCOPE`. A probe answers for `public_probe_scope`, so
  that is the scope its receipts are stamped with and the scope its evidence, investigation
  target, diagnosis, and returned result are bound to. On a probe run the returned `scope`
  is therefore the public one; the configured scope stays with the gate.
- A defect the probe proves is a real defect and a valid issue on its own terms. It is not
  evidence about why the full gate failed, and the diagnosis prompt forbids that claim,
  because the causal link is unknown to this run.

Configuring a probe therefore replaces the trusted-case route on a red gate rather than
adding to it. A check whose `public_cases` already carry publishable evidence does not
need one, and should not have one.

The probe is a second execution of the project's checks. It costs what those checks cost,
and it runs only on a red gate.

## Trusted external check profile

The profile has this exact shape:

```json
{
  "version": 1,
  "argv": ["/operator/bin/check-project", "--regression"],
  "timeout_seconds": 600
}
```

`argv` is a nonempty array passed directly to the executable without shell
interpolation. The profile author owns the command, its arguments, dependencies,
environment setup, and meaning. Use absolute executable/script paths where
appropriate. No dependencies are added to the target project. The command runs in
the checkout with the existing environment plus these bindings:

| Environment key         | Meaning                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `REGRESS_EVIDENCE_PATH` | Fresh external file path where the check must write its JSON report. |
| `REGRESS_REVISION`      | Actual checked-out commit.                                           |
| `REGRESS_BASE`          | Configured base ref.                                                 |
| `REGRESS_BASE_REVISION` | Resolved base commit.                                                |
| `REGRESS_SCOPE`         | Exact requested scope.                                               |

Timeout is an integer from 1 to 7200 seconds. Allow cleanup time beyond a check's own
internal deadline. The check must use scratch resources
for data writes, keep source intact, and clean up any services it starts, including
on termination. It must never write to an inherited live database. The workflow
does not invent project startup commands or parse error prose to classify causes.

The command writes this report, copying the four binding values from its environment:

```json
{
  "revision": "<REGRESS_REVISION>",
  "base": "<REGRESS_BASE>",
  "base_revision": "<REGRESS_BASE_REVISION>",
  "scope": "<REGRESS_SCOPE>",
  "status": "product",
  "public_cases": [
    {
      "id": "empty-input",
      "root_cause_key": "parser/empty-input",
      "title": "Empty input raises instead of returning a result",
      "root_cause": "The parser reads the first item before checking length.",
      "expected": "Empty input returns an empty result.",
      "actual": "Empty input raises an exception.",
      "reproduction": "Run the repository's empty-input parser test.",
      "evidence": ["src/parser.ts:12 reads the first item"]
    }
  ]
}
```

`status` is `clean`, `product`, or `inconclusive`. Clean requires exit 0; product
requires a nonzero exit and a completed product assertion, with a reproducible
failure. Startup or environment failures must produce inconclusive or no report.
A timeout, missing report, inconsistent exit, malformed report, or binding mismatch
is inconclusive. Extra private diagnostic fields may be kept in the report but are
never published. `public_cases` is always an array; use `[]` when there is no
independently publishable proof. Each public field must be nonempty and evidence
must contain concrete observations. Case ids and root keys are lowercase machine
identifiers using letters, digits, `.`, `_`, `/`, or `-`, at most 200 characters.

The check author explicitly approves **all content** in `public_cases` for export.
Populate it from public reproductions, not raw evaluator logs or hidden assertions.
The diagnosis agent must establish the cause using `archon-investigate` before
selecting a case. The publisher copies only the selected trusted case fields;
model-authored text, raw command streams, scope text, profile paths, and private
report fields never become issue content. This is a trust contract with the check
author, not a secret detector or proof against a malicious process.

Keep `root_cause_key` stable for the same cause across revisions, scopes, and repeat
runs. It is not a symptom, run id, title, timestamp, or SHA. Different independently
fixable causes need different keys. Changing a key intentionally changes identity.

## Publication and returned result

Publication judges the evidence before the destination, so a run learns that its
findings are unpublishable rather than hearing about its remote. Only a normalized
`github.com` origin is supported. Other forges and GitHub Enterprise hosts are
reported as unsupported, without guessing a destination.
Repository identity and the root cause key produce a SHA-256 issue marker.
The publisher lists all issue states using paginated GitHub REST, excludes pull
requests, and matches exact markers. An existing issue is reused and read back; it is
never reopened or edited. The canonical issue for a marker is its lowest open one. A
cause whose only issue is closed is reported as that issue rather than filed again:
recurrence after a close, and a closed duplicate, are operator decisions, not something
this workflow reopens or works around. For the same reason a closed issue is never
offered to the diagnosis for reuse. Failed queries never mean no matches.

The catalog is read once, when evidence is collected, and the publisher re-lists the
tracker before each create. An exact-marker duplicate filed in between is therefore still
caught, but an issue another publisher files under a different key in that window was not
in the catalog the diagnosis compared against, and can be duplicated. That is the same
window the lock below narrows for one host and cannot close across hosts.

A repository lock serializes publishers sharing the same system temp directory.
A lock that survives a crash is not timed out or stolen: the operator must confirm
ownership and remove that exact lock directory. Separate hosts can still both
finish listing before either creates an issue. GitHub provides no atomic unique
issue key here, so there is a narrow cross-host list/create race, not exactly-once
publication. Serialize scheduling across hosts when duplicates are unacceptable.
REST listing avoids search-index lag. Failed creates are not retried in that call;
a later run lists again. A transport failure can leave an issue whose URL was not
received. Once a URL is received, it is saved before readback and retained even if
verification fails. A newly created issue must read back with the exact body.

`returns: finish` exposes:

- `status`, `summary`, and `findings` (structured title, cause, expected/actual,
  reproduction, evidence, a selected `public_case_id`, and a `public_proof`).
- `revision`, `base`, `base_revision`, and `scope`.
- `publication`: `disabled`, `not-applicable`, `blocked`, or `published`, with
  `publication_reason`. A defects diagnosis with blocked publication still
  represents a diagnosed defect, not a successfully filed issue.
- `issues`: `{key, number, url, disposition: existing|created, matched: key|cause,
  verified}` records. `matched: cause` means the issue was reused because the diagnosis
  matched this run's cause to it, and it keeps its own marker rather than this run's `key`.

Artifacts live under `$ARTIFACTS_DIR/regress/`: `result.json`, `issues.json` when
publication reaches an issue, a `recordings-*/` directory holding the recorder and its
receipts plus collected `validation.md` for discovery and for a public probe, and a fresh
`check-*/evidence.json` and `private-execution.json` for configured execution. The
configured check's own artifacts stay local; nothing reads them back into a prompt.
Investigation retains the neighboring workflow's `investigation.md` contract.
Model/provider failures can still fail the engine run; an inconclusive result does
not disguise a failed lifecycle as a successful run. Compose serially when sharing
the neighboring validate/investigate report paths within one run.

## Verification

`bun test ./.archon/workflows/sdlc/regress/tests/` exercises the evidence and
publication boundaries, and real script processes, real recorder subprocesses, and
real `git` reference checks against scratch repositories. It is included in
`bun run test`; the root type-check and lint also cover the scripts.
Real script processes also cover the public probe end to end: a configured gate whose
report, stream, approved cases, and operator scope all carry a canary, and a probe route
whose routing, evidence, receipts, and result carry the public scope instead and publish
its own proof without any of it. Duplicate detection is covered against a fake tracker:
a repeat run coining a different key for one cause, an unrelated cause in the same file,
a selection that is unknown, unmarked, closed, or another repository's, two findings
claiming one issue, and an incomplete or malformed catalog. `archon workflow test` picks up the colocated dry-run
fixtures. The unresolved-base fixture executes the real prepare, route, collect, and
finish nodes with stubbed AI and cannot publish; the clean fixture proves the recording
requirement survives the include boundary into archon-validate; the public-probe fixture
proves a red configured gate reaches archon-validate and then ordinary investigation,
while the product fixture proves an unprobed one does not. Other fixtures prove routing. Actual model
quality and live private-repository behavior need operator validation; unit tests
make no claim about them.
