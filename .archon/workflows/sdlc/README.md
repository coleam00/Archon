# Working in the SDLC pack

Conventions for this pack specifically. Project-wide judgment lives in
[`AGENTS.md`](../../../AGENTS.md); the YAML surface is governed by
[`.archon/workflow-language-constitution.md`](../../workflow-language-constitution.md).
How we decide what a workflow should be, agents first, is in
[`CONSTITUTION.md`](CONSTITUTION.md).

## Guards

A guard here must protect an action the node it lives in takes.

**Keep** a guard when it:

- verifies the effect of something this node just did — exit 0 is not proof, and a
  forge can accept a write and silently not apply it; or
- refuses to proceed on a question it asked and could not get an answer to, where
  guessing is irreversible. `archon complete` blocking a branch delete it could not
  prove safe is the shape.

**Cut** a guard when it re-asserts an invariant something else already established.
That belongs where it is established, once — not at each node that depends on it.

**The test: if this pack's fixture suite cannot exercise the guard, it is not a
guard. It is a comment — write it as one.**

That test is mechanical and settles most arguments without debating threat models.
A node the dry run cannot execute — a composed `bash:` node, for instance, which
never receives its caller's `with:` values — can only ever be stubbed, so no
fixture can show the guard working or catch it breaking.

### Why this rule exists

The pack once verified "the checkout is on the branch my PR is on" in three places:
a preflight node before review, the ready flip, and prose inside the correction
prompt for an agent to honour. Three copies, two languages, one of them dependent
on a model's diligence.

None of it was load-bearing. The engine gives a run its worktree, and the pull
request is created in that worktree, so the invariant holds by construction.
Nothing had ever gone wrong — the alarm that prompted the work was investigated
and closed invalid. And the copies did not even cover the steps that would have
suffered most from a drifted checkout: `impl` writes code to that checkout without
checking, and `validate` runs the project's tests against it without checking.

The preflight alone cost 31 lines and a stub in 17 fixtures, for a node no fixture
could ever run. All three copies are gone.

CI is the project's full validation; implementers run only focused checks. Whether
CI is green is judgment, so one agent prompt owns it (`deliver/commands/ci.md`), run
once a round's review passes. It never judges a stale head (it pushes the
checkout's `HEAD` when the pull request is behind it), refuses a head that
conflicts with its base, marks the pull request ready (a
project whose CI skips drafts starts it then), waits however long CI takes, and
answers green, pr_caused, or other. On anything but green it puts the pull request
back to draft before it answers, so a red PR never stays ready. A red the change
caused, or a conflict with the base, goes back to the implementer in the next
round, which merges the base on a conflict, and that correction is reviewed before
CI runs again. A flake or infrastructure failure outside the change gets one re-run
of its failed jobs before the agent answers, recorded as `rerun`; any other red ends
the run not ready, and a defect outside the change becomes a discovery.

A pull request counts as ready only at the commit its review comment stamps. CI never
marks ready a head carrying commits the round's review did not cover. Commits pushed
after a run ends, by a fixer or by hand, are reviewed by a continuation delivery of
that pull request, whose first round reviews the whole change before CI marks it
ready again, or by `archon-review` given the earlier round's `review/report.md` as
`prior_report`.

The rule is not "never defend against what has not happened" — the two Keep cases
above have not happened either, and both are worth their few lines. The question is
whether the guard is protecting *this node's own action*, or restating something
that was already true when the node started.

## Forge source

One switch selects the source for every pull-request and issue read and write
this pack makes. CI is read by the `ci` agent node, not through this switch.
[`.shared/forge.ts`](.shared/forge.ts) owns which one a run selected,
[`.shared/pr.ts`](.shared/pr.ts) owns the pull-request reads and writes, and
[`.shared/issue.ts`](.shared/issue.ts) owns the issue read, each returning the same
shapes from either source:

- **`gh` (default).** The GitHub CLI, acting on the recorded qualified PR. This
  needs only the authenticated `gh` the pack has always used.
- **`forge` (opt-in).** Set `ARCHON_SDLC_FORGE=forge` in the environment Archon
  runs with, for example `~/.archon/.env`. Operations then go through
  `archon forge`, which needs a forge plugin installed for the PR's host (see the
  forge reference in the docs) and the `ARCHON_CLI_COMMAND` host command that the
  CLI and server publish at startup.

The source is never picked from what happens to be installed. When `forge` is
selected and cannot answer (no host command, no plugin for the host, a failed
operation), the node refuses; none of them falls back to `gh`. Any other value of `ARCHON_SDLC_FORGE` refuses too. The
forge source is for host execution: a container execution receives neither
`ARCHON_SDLC_FORGE` nor `ARCHON_CLI_COMMAND`, so a containerized run uses `gh`.

## Public writes belong to a script

An agent judges and authors; the node after it performs the one public write and
proves it landed. `publish-pr` pushes the branch and opens or reuses the pull
request, and `publish-review` upserts the one marked review comment. Every pack
label is declared in `.shared/labels.ts`, and every stage writes labels through its
`writeLabels`, which adds and removes them as a delta so labels another writer adds
survive. On the `forge` source it still writes the whole label set back, because
the forge contract has no single-label add or remove yet. No node files discoveries: the
run's terminal report relays them to the operator. In `archon-deliver` and
`archon-ship` that is the `report` node, which also runs when a node fails, so a
workflow that includes `archon-deliver` runs after a failed delivery and must gate
on `$deliver.output.ready`. Each acts on the values the agent
before it declared in its typed output, which the engine certified, writes through
the selected source, and fails unless the result reads back — so "the write
failed" and "the write may have landed" stay different outcomes, in the pack as in
the forge contract. Three agents write directly with `gh`: the structure pass's
implementer pushes its own commit to the pull request's branch, and CI pushes a
head that was left behind before it judges anything, ending `other` if it cannot;
`update-pr-body` edits the description, because judging which claims are stale and
rewriting them is the whole job; and `ci` marks the pull request ready and back to
draft around its CI wait. No script reads an
agent-written file to find out what to write.

Which remote holds a repository is decided by its configured URL, never by the
remote's name (`.shared/remote.ts`), so a fork checkout whose `origin` is the fork
and whose `upstream` is the canonical repository fetches the base and pushes the
head where they belong.

That split is also what keeps the source switch out of the prompts. A prompt that
branched on `ARCHON_SDLC_FORGE` would be an invented protocol; `forge.ts` reads it
and the agents never see it.

## Deterministic scripts

Every `script:` node here is TypeScript on Bun, under its own component's
`scripts/` directory. Logic more than one of them needs lives once in
[`.shared/`](.shared), imported by relative path with the extension written
(`../../.shared/report.ts`). That directory is reserved for modules and for the
pack's default policy documents under `.shared/policy/`: nothing in it is a workflow
or a named script target, and a node that names one fails at load.

The repository validates them where they live. `.archon/workflows/tsconfig.json`
is the owning configuration — `bun run type-check` compiles that project. Lint
covers every TypeScript file under `.archon/workflows/`, so it needs no globs of its
own. A script placed outside the type-check globs fails `pack-scripts-validation.test.ts`
rather than going quietly unchecked.

Three rules, each protecting something a script cannot get back on its own:

- **Read every binding as a literal `process.env.INPUTS_<NAME>`.** The engine scans
  each script's own source at load and refuses a workflow whose script reads a
  binding no `with:` clause provides. It matches that literal form only, and it never
  follows imports — so a helper that built the key from a name would hide every read
  in the pack from that check, and a renamed binding would surface as a wrong result
  at the end of a paid run instead of a refusal before it started. Pass the value to
  `.shared/io.ts`, never the name.
- **Never call `process.exit()`.** Bun leaves without draining stdout — a 500 KB
  write to a pipe arrives as 131072 bytes, silently. Set `process.exitCode` and
  return; `.shared/io.ts` is the only place that should need to know this.
- **Nothing the target project provides is available.** No `package.json`, no
  `node_modules`, no `tsconfig.json`, no npm dependency. Relative imports within
  the pack and the standard library are the whole surface, which is what keeps
  these workflows runnable against a project in any language.

A vocabulary a node declares in YAML has exactly one owner. A script that routes on
one imports it from `.shared/verdict.ts`; a script that merely consumes another
node's certified value does not restate the list at all.

## Evidence never carries credentials

The engine retains what every exec node prints, so a node's output is the record
whether it set out to keep one or not. Never print a value that can contain a
secret: read it where it is normalized and pass on the normalized form. A remote
URL is the common one — `https://<token>@host/repo` is a perfectly ordinary origin
— so `.shared/remote.ts` reads remote URLs only to normalize them to `host` and
`owner/repo`, and only the remote's name and that identity reach a command line or
a message. Failure messages are the same
surface: interpolating the raw value into one leaks it just as effectively.

That retention is also why a node does not need its own log. The ready flip once
wrote one by hand — every command it ran, echoed into an artifact — which is what
the transcript now holds for free.

## The engineering-conventions sidecar

A repository may declare its architecture in an `architecture.md`, its
engineering conventions in an `engineering.md`, and its product direction in a
direction document, at the root, in a config directory such as `.archon/`, or
wherever its steering files point. The steering files themselves (`AGENTS.md` or
its equivalent) reach every node through the provider's own context, so no
prompt tells a node to read them. Each prompt that judges names the sidecar
documents its decision can depend on, and opens one only when a finding or
decision depends on it, reading the section it cites rather than the whole file.
Implement reads the short `engineering.md` up front. `architecture.md` is named
only where a decision is structural: seams, simplify, plan, investigate, implement,
and triage when fit with the codebase is in question. They are the project's
own values, so a taste finding cites one of them or is left out, and an owner
declines a finding by the same standard. Each read is conditional on the file
existing, so the pack stays portable: a repository without one loses nothing. A
new pack prompt that writes or judges code follows the same rule.

A project's policy for a decision the pack makes, such as what triage accepts, is
one more sidecar document, kept at `.archon/sdlc/policy/<topic>.md`. The pack ships
a default for each policy document a prompt names, in
[`.shared/policy/`](.shared/policy). A project's own file replaces its default
whole; with no project file, the default applies. To change one, copy the default
to `.archon/sdlc/policy/` and reword it. A policy document may be only a pointer to
documents the project already has, and the agent reads what it points to. A prompt
names only the policy documents its decision needs, through the shared sentence
ending "the SDLC policy files this decision names, at `.archon/sdlc/policy/`,
falling back to the pack's defaults"; triage names `triage.md`, and plan and review
synthesis name `rulings.md`, the answers a project's maintainers have already given,
read before either stops for a person. Agents interpret
them; anything that must be exact, such as label names, stays typed configuration.

A node reaches the defaults through its workflow's `policy` script node. A run
captures its source before it starts, from a binary's embedded bundle as from a
source checkout, and runs its scripts from that capture, so
[`.shared/policy-defaults.ts`](.shared/policy-defaults.ts) finds `.shared/policy/`
from its own location and the node binds that directory into the prompt with `with:`. The script hands over
the directory only; the agent chooses between the project's file and the default,
and no script opens either. The default is a file rather than text in the prompt
because a prompt carrying the default would hold it even after a project replaced
it.

## A node's streams are the operator's channel

Retention is not the only reader. Anything a node writes to stderr is sent to the
operator as the run happens, even when the node succeeds — and that copy is not
redacted. So a node speaks for itself: capture what the commands inside it print,
and let only your own authored messages reach the streams. Re-emit a command's
output when it failed and its words are the diagnostic; drop it when it is just a
tool narrating itself. Capture a value's stderr separately rather than merging it,
too — a `gh` update notice merged into a read becomes the value.

## Intake

[`archon-intake`](intake/archon-intake.yaml) is the front of the label-driven pack.
Trigger bindings start it on issue events; only an eval run (below) is started by
hand. Each issue has a work item, the state document `work/<number>` in the
project's scope, owned by [`.shared/workitem.ts`](.shared/workitem.ts). The
document is the item's state: its trust, stage, triage fields, promotion, claim and
a short history. The issue's pack labels mirror it, and a label a person adds is a
request, never the state.

- **Trust.** The `facts` script reads `.archon/sdlc/policy/maintainers.json` (a JSON
  array of forge logins) at the head of the default branch and records once whether
  the issue's author is on it. No file means an empty list, so every author is
  outside. A file that is not an array of logins refuses the run.
- **Outside items** get `archon-needs-maintainer` and nothing else: no agent node
  runs and nothing is posted.
- **Promotion.** A listed maintainer promotes an outside item by adding
  `archon-triage` or a route label. The label binding maps who added it from the
  forge event (`label.actor.login`); an event without an actor rejects the binding,
  and an empty or unlisted actor promotes nothing. A promotion pins the body's digest
  as it was when intake recorded the request. An edit after that demotes the item
  back to `archon-needs-maintainer`, and the history records both digests.
- **Requests and echoes.** On a maintainer's item, `archon-triage` asks for
  re-triage, and a route label that disagrees with the document is removed. A label
  already in the document's mirror is the pack's own write coming back as an event
  and is ignored. The outcome also refuses to add a request label to an outside item
  no maintainer promoted, so the install's own identity cannot promote anything.
- **Pickup.** Every run records its event as a request on its issue, then claims the
  waiting item that sorts first by the `order` input (default
  `["urgency desc","importance desc","size asc","created asc"]`; an untriaged item
  sorts after triaged ones, oldest first) with a conditional write. A request that
  arrives while its item is claimed waits for the next intake run. A request label
  whose request no run has claimed may have a request on its way, so a run leaves
  it for the run that claims that request. It waits one pickup; the next pickup
  that still finds no request for it removes it. On a maintainer's item only
  `archon-triage` waits, since a route label is reconciled away either way. An
  open, edit or
  reopen adds no request while another one waits, since the pickup reads the live
  issue; label requests keep the newest 50. A run clears its
  claim only after the item's labels are written. The next pickup releases a claim
  whose run the engine reports completed, failed or cancelled and queues that run's
  requests again; the item then sorts after every other waiting item until an
  attempt finishes, so one item that cannot be read or labelled never starves the
  rest. A claim whose run is pending, running, paused or unknown is never released,
  and there is no age timeout.
- **Closing.** When triage's verdict is `NO_ACTION`, the item is a duplicate of
  another open issue or a merged change already delivered it, and the triage policy
  lets it close without a person. Before writing anything, the outcome checks a
  duplicate's declared original: it must be another item, an issue rather than a pull
  request, open, and at the declared URL. When a check fails, the item is stored and
  labelled `BLOCKED` with the reason, for a maintainer to decide. Otherwise the
  outcome writes the work item and labels, then comments on the issue with a link to
  the original or the change and closes it as `duplicate` or `completed`. A
  duplicate's original gets a comment linking back. Each comment is one marked
  comment, so a repeated run edits it rather than adding another. An item already
  closed for the verdict's reason (an earlier run that stopped after its close)
  still records the work item and its labels, but posts no comment and doesn't close
  it again; one closed for another reason fails the run before any comment. A demoted item, an eval run and every other verdict close nothing.
  Intake is the one workflow that closes: `archon-triage` run alone, even with
  `publish`, only labels the item `archon-close`, because inside intake triage runs
  unpublished so the outcome can withhold a verdict judged on text no maintainer
  promoted.
- **Closed issues.** Intake records the event and changes nothing else: no trust
  decision, no stage change, no label write.
- **Inputs.** `label_actor` is the one input that can create a promotion, never
  trust. Only the binding, or someone with access to the install, can supply it.
  `trust: outside` sends the item down the outside path whatever the maintainer
  list says. It only lowers trust a run decides: an item whose trust is already
  recorded as a maintainer's refuses the run, since recorded trust never changes.
  There is no `maintainer` value; `facts` refuses any value but `auto` and
  `outside`, and any `mode` but `live` and `eval`, before it reads or writes
  anything.
- **Eval mode.** `mode: eval` runs intake on the issue named by `number` and
  writes nothing: no request, claim, work item, label or comment. It reads the
  maintainer list and the issue, and decides the issue as a fresh item as it was
  opened, unlabelled and open. Triage is shown only the title and body at creation,
  recovered from GitHub's edit history, without the issue's number, state or links.
  The `forge` source has no edit history and shows the current text; the outcome's
  `evaluation.seen.body_from` says which one triage saw. The outcome returns the
  whole decision as `evaluation`: the trust input, what triage saw, the label delta
  live would write, this run's history entries, and triage's verdict with its five
  fields and, for `NO_ACTION`, the closure live would perform. The triage agent
  keeps its read tools and can still look the issue up, and it reads the run's
  message too, so launch an eval run without a message that names the issue.

The pack installs no binding, and none should be installed on a repository until the
backlog bench passes. Two bindings in the GitHub source plugin's configuration start
it; both share one resource so runs queue rather than overlap:

```json
{
  "bindingId": "intake-issues",
  "hostId": "build-host-1",
  "runAsUserId": "<archon user id>",
  "resource": "forge:github.com/acme/widgets:intake",
  "capacity": 2,
  "overlap": "queue",
  "launch": {
    "cwd": "/srv/archon/widgets",
    "workflowName": "archon-intake",
    "inputs": {},
    "isolation": { "kind": "default" }
  },
  "selector": {
    "kind": "issue.lifecycle",
    "actions": ["opened", "edited", "reopened"],
    "repository": { "host": "github.com", "path": "acme/widgets" }
  },
  "inputMapping": {
    "repo_host": { "source": "field", "field": "repository.host" },
    "repo_path": { "source": "field", "field": "repository.path" },
    "number": { "source": "field", "field": "subject.number" },
    "kind": { "source": "field", "field": "subject.kind" },
    "action": { "source": "field", "field": "event.action" }
  }
}
```

The label binding is the same with `"bindingId": "intake-labels"`, a selector of
`{"kind": "label.changed", "actions": ["added"], "predicates": [{"field": "label.name",
"in": ["archon-triage", "archon-ready", "archon-plan", "archon-issue"]}]}`, and two
more mappings: `label` from `label.name` and `label_actor` from `label.actor.login`.
The predicate only saves runs; intake ignores any other label.

### The backlog bench

[`intake/scripts/bench/bench.ts`](intake/scripts/bench/bench.ts) compares intake and
triage versions on issues whose outcome is already known. Run it with `bun` from a
checkout of the repository; the set, the dispositions file and the output directory
are the operator's and stay outside the pack and the repository.

- **Set.** `select` pins issues closed as duplicates (with the issue they duplicate),
  closed by a merged pull request, closed as not planned, open with a human type
  label, and open issues the operator dispositioned (`--dispositions`, a JSON array
  of `{number, contract, route?, note?}`), each with its title and body at creation.
  It also pins which workflow judges each row: a listed maintainer's issue runs
  through intake in eval mode; an outside author's runs through `archon-triage`
  directly on the same creation text with `publish=false`, because eval intake never
  triages an outside item; and some maintainer issues get a second `trust: outside`
  row, which must take the outside path with no agent node. A group that finds
  fewer issues than its count pins nothing.
- **Versions.** A version file is `{label, pack_sha}` for the baseline, the model
  triage's tier resolves to today, plus `provider` and `model` for any other. Every
  version runs with a config layer pinning that tier, with the baseline's effort, so
  versions differ only in the model. The binding is resolved by a dry run on the
  pack's own `triage/fixtures/deliver.stubs.yaml` at `pack_sha`. A version that
  cannot be resolved refuses the batch before any run.
- **Batches.** `run` takes the set's n-th five rows and runs every version on them,
  one ordinary run each at one base commit. Each run has its own worktree of the
  checkout, so `--concurrency` never puts two runs on one checkout. Every run
  appends one line, labelled with its version, to `samples.jsonl`. The batch then
  fails if any batch issue or state document of the repository changed, if a
  `trust: outside` row ran an agent node, if any comment was posted, or if a run was
  cancelled, did not finish, or failed before any agent ran; a failed batch is
  reported before anyone evaluates it. A run that failed after its agent ran is the
  version's result, not a batch failure. A `trust: auto`
  run that returns no triage verdict, or a verdict whose transcript is missing so no
  leak check ran, is recorded as failed: it counts against the bars as not right.
  Eval batches are cheap dry checks that the bench works, not fair scored
  comparisons: an eval run can read the issue's current state, including its outcome.
- **Live batches.** Use live batches on scratch copies for scored comparisons.
  `copy` opens copies of a batch's issues in scratch repositories
  the operator prepared, one per version, and `run --live` runs intake for real
  there, reading each verdict from the copy's work item. The work item keeps no
  summary, maintainer recommendation or links, so a live verdict shows none. A
  scratch repository may not be the set's own or another version's. Its remote
  default branch and local checkout must both be at the batch base before `run --live`.
  An empty repository is refused before any run. From the scratch checkout, publish
  the base with `git push origin <base>:refs/heads/bench-base`, then set it with
  `gh repo edit <host/owner/repo> --default-branch bench-base` (use the scratch
  remote's name if it is not `origin`). The preflight prints the repair commands. Each copy holds
  the pinned text, so lookups need no rewriting. Each live line records
  merged pull requests on the base that reference the original issue, for scoring.
  If that evidence is incomplete, the row does not run and its line says why;
  reference histories exceeding the first 100 events are refused. Rows with
  references also require a complete source history: unshallow the source checkout
  before rerunning. Complete empty reference responses need no history check. Older
  live lines without collected evidence keep close proposals pending until rerun or
  marked right or wrong.
- **Evaluation.** `page` serves one batch's page on the loopback interface: each
  row's versions side by side with the verdict, the five fields, any close proposal
  or maintainer recommendation with its links, cost, time and the triage report. The
  operator marks each run right, wrong or partly right, and marks land in
  `marks.jsonl`, so they tally across batches. A mark also overrides the scorer's
  expected answer for false closes and dispositions, not for `type`. The score uses
  these marks; the page shows the selected mark and any note.
- **Score.** `score` prints one column per version from each version's latest line
  per row, with live lines in their own `<label> (live)` column: which workflow
  judged the rows (`archon-triage`, `intake eval` or `intake live`), the hard checks, each bar (the duplicates, fixed and not-planned bars by
  the operator's marks), false closes (a close proposal on an issue that was still
  open, unless the operator dispositioned it closed or marked the run right; a wrong
  mark overrides a close disposition. A merged pull request on the base that only
  references the issue leaves the close bar pending until the operator marks the
  run right or wrong),
  dispositions matched (a right or wrong mark decides), the `type` confusion matrix
  with `enhancement` read as `feature`, leaks (a command, fetch or search that
  looked up the judged issue, left out of the accuracy numbers), cost over the runs in
  which an agent ran (`unreported` when no provider reported one) and wall time, and
  which versions got each disagreement right. A bar with no applicable rows reads
  `not applicable`. It does not choose a winner.

## Composition validation

[archon-validate](validate/README.md) accepts an explicit composition request to run
the same project gate on two pinned parts and their composed tree. Its `interaction`
result remains red; delivery holds it rather than treating it as inherited or
environmental. The report retains revision, tree and check evidence for an existing
merger to consume. It does not install a queue or authorize a merge.
