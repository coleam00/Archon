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

**The test: a guard names the real run it would have saved, or it stands in front
of an irreversible action. Otherwise it is a comment; write it as one.** A guard
does not earn its place by having a fixture that turns it red.

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

Unresolved review threads on the pull request are work too, whoever opened them: a
person, a review bot, or no one in a project without outside reviewers. After CI,
each round's `threads` node lists the unresolved threads in `threads.md`, quoted as
untrusted review data, and puts a ready pull request back to draft while any is
open, so the round ends `threads_open` instead of ready. The next round's
implementer judges each thread like a blocking finding, fixing it or declining it
with evidence; `settle-threads` checks each disposition at the pushed head and
writes the reply, and `threads` posts the replies, resolves those threads, and reads
the pull request back. A thread about code the pull request doesn't change or make
reachable, such as one that arrived with a merge of the default branch, is settled
with a reply saying so; it belongs in its own issue. So is a thread a dated ruling
in the issue body already decided: `settle-threads` reads the work order and the
issue's "Current scope" sections, and its reply names the ruling. A thread no agent
can settle ends the run `ask`.
`settle-threads` runs before CI and a failed one skips it, so the pull request stays
the draft the previous round left; a failed `threads` node puts it back to draft
before the run fails. The
pack's own review verdict is unchanged: threads gate delivery, not the review.

A pull request counts as ready only at the commit its review comment stamps. The
comment's first lines are stamped by `publish-review` from the round's certified
output ([`.shared/review-comment.ts`](.shared/review-comment.ts)): the reviewed commit
and the verdict, which the merge queue's gate reads, and the contract coverage
(`complete` only when the review left nothing open), which the sweep reads before it
lets a merge close the issue. CI never
marks ready a head carrying commits the round's review did not cover. Commits pushed
after a run ends, by a fixer or by hand, are reviewed by a continuation delivery of
that pull request, whose first round reviews the whole change before CI marks it
ready again, or by `archon-review` given the earlier round's `review/report.md` as
`prior_report`.

The rule is not "never defend against what has not happened" — the two Keep cases
above have not happened either, and both are worth their few lines. The question is
whether the guard is protecting *this node's own action*, or restating something
that was already true when the node started.

## Forge

Every pull-request, issue and check read and write this pack makes goes through
`archon forge`. [`.shared/forge.ts`](.shared/forge.ts) is the client,
[`.shared/pr.ts`](.shared/pr.ts) owns the pull-request reads and writes, and
[`.shared/issue.ts`](.shared/issue.ts) owns the issue reads and writes. A run needs a
forge plugin installed for the repository's host, a credential that plugin accepts
(for GitHub, the host tries `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth login`; GitHub
App mode supplies a run token; see the forge reference in the docs), and the
`ARCHON_CLI_COMMAND` host command that the CLI and server publish at startup. When the
plugin cannot answer (no host command, no plugin for the host, no credential, a failed
operation), the node refuses; nothing falls back to another tool. A container
execution receives no `ARCHON_CLI_COMMAND`, so a pack run in a container refuses at
its forge check.

The merge queue's facts, gate and record read through `pr.view`, `pr.merge-state`,
`checks.state`, `checks.commit`, `pr.threads` and `workitem.comments`, the sweep reruns
a pull request's failed checks through `checks.rerun`, and the gate merges through
`pr.merge` pinned to the head; `facts` refuses a plugin missing any of
them before it claims an item. The gate itself doesn't refuse over threads; the sweep
holds a merge only for a thread that raises a defect in code the pull request changes
or makes reachable. Delivery reads, answers and resolves review threads through
`pr.threads`, `pr.thread.reply` and `pr.thread.resolve`.

The build queue finds a dead round's pull request through `pr.view` by head in any
state, which the plugin advertises as `pr.view:any-state`. The build queue has no forge
check, so on a plugin without it the queue refuses, naming that capability, when it
releases a dead claim that recorded a branch.
The metrics workflows read each pull request through `pr.view` and need the
`timestamps` it reports; the test-value judge reads `pr.files` and `repo.file`. A
plugin that omits the timestamps or lacks those operations makes them refuse, naming
what is missing.

Own-PR enrollment lists a maintainer's open pull requests by author, which has no forge
operation yet, so it refuses, naming the missing operation.

Agents read CI job logs with the tools the run has, since the contract has no operation
for them. A red default branch is always raised as a `merge: base` item: `checks.rerun`
acts only on a pull request, so the pack never reruns it.

`archon-ship-block`, `archon-deliver-block`, `archon-upkeep` and `archon-pr` start with a `forge` node
([`.shared/forge-check.ts`](.shared/forge-check.ts)) that proves the plugin can act
after worktree setup and before any agent spends: host metadata must advertise every
operation in `REQUIRED_FORGE_OPERATIONS` in `.shared/forge-check.ts`, then one
authenticated repository read for the repositories the checkout's remotes name, at
least one of which must answer (`pr.view` by head, which every released GitHub plugin
supports). One readable repository is sufficient, including a readable mirror; this
proves read access, not write access, which is first proven by the first write. The
operations still refuse on their own. Run `archon workflow run archon-forge-check` from
a checkout to see the same check's result without starting delivery.

## Public writes belong to a script

An agent judges and authors; one node owns the public writes and
proves they landed. `publish-pr` pushes the branch and opens or reuses the pull
request; on a pull request the run continues it pushes and opens nothing, and
`prepare` writes no body for it when the caller named the PR or selected no branch. If the caller
selected a branch without naming a PR, prepare writes a body even if it found an
existing PR: publish may need to open one from the selected branch. That body is
used only when opening a PR. In delivery, content the work requires in the
description is written during the round that prepared it, before that round's
review reads the pull request: `prepare` copies it to `pr-description.md`, and
`publish-pr` writes it between `archon-delivery-description` markers, keeps the
rest of the description as it is, and reads it back. Markers in Markdown code
examples and raw HTML containers are literal text; top-level markers are reserved
for the managed section and are refused in prepared content before pushing. The
composed body must expose exactly the intended pair before any description edit;
unclosed fences or HTML containers that hide either delimiter refuse publication.
A blank line separates the closing delimiter from prepared content, including terminal tables;
legacy sections whose closing delimiter follows a table row remain replaceable.
If publication verifies a created or reused PR but a later description edit fails,
the failure report still names that PR from its verified publication record. If writing that record
fails, publication fails and the node error names the verified PR URL and recording
error for explicit continuation. The failure report selects the latest verified publication
by artifact write time across the typed output and creation record, and reports an
unreadable creation record. An unresolved
creation claim reports `pr_create_unresolved`; the build queue refuses to select
another PR or branch until a newer triage settles it: it names the reconciled PR, or
names none and the next round opens one. `update-pr-body` corrects the
description's stale claims and links the issue once the rounds end. A standalone
`archon-pr` leaves a continued pull request's description as its author left it:
its `publish_description` input defaults off. `publish-review` upserts the one marked review
comment, and deliver's `threads` posts the thread replies `settle-threads`
declared and resolves those threads. Every pack label is declared in `.shared/labels.ts`, and every stage writes
labels through its `writeLabels`, which adds and removes them as a delta so labels
another writer adds survive, on both sources. No delivery node files
discoveries: the run's terminal report relays them to the operator, and
[`archon-discoveries`](#discoveries) drains them where a project runs it. In `archon-deliver-block` and
`archon-ship-block` that is the `report` node, which also runs when a node fails, so a
workflow that includes `archon-deliver-block` runs after a failed delivery and must gate
on `$deliver.output.ready`. Each acts on the values the agent
before it declared in its typed output, which the engine certified, writes through
the forge, and fails unless the result reads back — so "the write
failed" and "the write may have landed" stay different outcomes, in the pack as in
the forge contract. Three agents write directly: the structure pass's implementer
pushes its own commit to the pull request's branch with `git`, and CI pushes a
head that was left behind before it judges anything, ending `other` if it cannot;
`update-pr-body` edits the description, because judging which claims are stale and
rewriting them is the whole job; and `ci` marks the pull request ready and back to
draft around its CI wait. The last two act through `archon forge`, after the `forge`
node checked the plugin can. PR publication reads the agent-authored
`pr-body.md` and `pr-description.md` content through certified artifact pointers;
the publisher owns the writes and verifies the description edit.

Which remote holds a repository is decided by its configured URL, never by the
remote's name (`.shared/remote.ts`), so a fork checkout whose `origin` is the fork
and whose `upstream` is the canonical repository fetches the base and pushes the
head where they belong.

## Deterministic scripts

Every `script:` node here is TypeScript on Bun, under its own component's
`scripts/` directory. Logic more than one of them needs lives once in
[`.shared/`](.shared), imported by relative path with the extension written
(`../../.shared/report.ts`). That directory is reserved for modules, for the
pack's default policy documents under `.shared/policy/`, and for `metric-views.json`, the
overview cards the console metrics page shows (see the
[metrics guide](https://archon.diy/guides/metrics/#overview-cards-a-pack-declares)): nothing
in it is a workflow or a named script target, and a node that names one fails at load.

The repository validates them where they live. `.archon/workflows/tsconfig.json`
is the owning configuration — `bun run type-check` compiles that project. Lint
covers every TypeScript file under `.archon/workflows/`, so it needs no globs of its
own. A script placed outside the type-check globs fails `pack-scripts-validation.test.ts`
rather than going quietly unchecked.

The scripts' tool-boundary tests live under `.archon/scripts/__tests__/`. CI runs the
merge-sweep conformance test through `merge-sweep-contract`, and runs the other pack tests and
the workflow fixtures on a pull request that changes the pack. Run them locally with
`bun run test --plan pack` and `bun run validate --only workflow-fixtures`.

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

A vocabulary a node declares in YAML has exactly one owner, its `output_format`. A
script that consumes another node's certified value does not restate the list.

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
[`.shared/policy/`](.shared/policy). A node reads the default first and then
the project's own file, whose lines add to the default and win where the two conflict;
with no project file, the default applies. To change one, write only the lines to add
or override in `.archon/sdlc/policy/<topic>.md`. A policy document may be only a pointer to
documents the project already has, and the agent reads what it points to. A prompt
names only the policy documents its decision needs, through the shared sentence
ending "the SDLC policy files this decision names, at `.archon/sdlc/policy/`,
falling back to the pack's defaults"; triage names `triage.md`, and plan and review
synthesis name `rulings.md`, the answers a project's maintainers have already given,
read before either stops to ask. The build queue's agents name `build.md`, what
the queue may decide on its own, and its route and answer agents `rulings.md` too. The
merge queue's sweep names `merge.md`, which pull requests merge on their own.
Review's code and ux lenses name `ui-check.md`, how they start the project's app to use a
user-facing change in a browser through the playwright-cli skill, which their prompts
names rather than a `skills:` entry for the reason the build queue's route does.
Agents interpret
them; anything that must be exact, such as label names, stays typed configuration.

A node's prompt names the defaults as `$PACK_DIR/.shared/policy/`: the engine's
`$PACK_DIR` is this pack's directory in the run's captured source, the same from a
binary's embedded bundle as from a source checkout. The agent reads the default and
the project's file, and no script opens either. The default is a file rather than text in the prompt, so a node
whose decision names no policy carries none of it.

## A stage pauses where nothing takes it forward

Each stage a person runs, `archon-deliver`, `archon-plan`, `archon-triage`,
`archon-review` and `archon-ship`, is a public entry around a `-block` workflow that
holds the stage's graph. The entry runs the block and then
[`archon-attention`](attention/archon-attention.yaml), whose one `decide` agent judges
whether the ending has a next step. When it has none (a delivery that ended not
ready, a plan or triage stopped on a question for a person, a review that is Ready on
a draft pull request), the run pauses as one `select` attention item labelled
`stage: <workflow>`. It says what ended and why it matters, the agent's
recommendation with its confidence and evidence, the choices and what each does, what
waiting costs, and the links. The run continues on the answer: `rerun` runs the block
again with the item and the person's note added to its work, `ready` takes the pull
request out of draft, and `finish` keeps the outcome as it stands. The entry returns
the block's typed outcome as its last pass left it. A stage that fails raises no item:
the run fails at the failed node, as the block alone would.

A workflow that composes a stage includes its `-block`: the queues, intake, upkeep,
the review eval, and `archon-ship-block` and `archon-deliver-block` themselves. The
composer owns what follows the stage's ending and asks through its own attention item
when it needs a person, so one decision never raises two items.

## Models per stage

Each stage names the concern it serves as a model preference list. The first alias
your config defines wins. When it defines none, the node runs on the size tier it has
always used. A user who sets nothing gets the same models as before.

| Alias | Nodes | Falls back to |
|---|---|---|
| `@triage` | triage | `medium` |
| `@planner` | plan | `large` |
| `@investigator` | investigate | `medium` |
| `@implementer` | implement, including delivery's reshape | `large` |
| `@reviewer` | every agent node of review (scope, lenses, synthesis) and simplify | each node's tier |
| `@review-<lens>` | one lens: `seams`, `code`, `tests`, `errors`, `docs`, `ux` or `simplify` | `@reviewer`, then the lens's tier (`large` for `code` and `ux`, `medium` for the rest) |

Review's lens router stays on `small`, and the queue, attention and delivery judges
keep their tiers. Moving those means rebinding the tier.

Set an alias for every run with `archon ai alias set @reviewer codex gpt-6.1-sol`, or in
`aliases:` in `.archon/config.yaml`. Set it for one run with
`archon workflow run ... --model @reviewer=codex/gpt-6.1-sol`. A lens alias overrides only
its lens: with `@reviewer` on Codex and `@review-seams` on Claude, seams runs on
Claude and every other lens on Codex.

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
Trigger bindings start it on issue events. Each issue has a work item, the state document `work/<number>` in the
project's scope, owned by [`.shared/workitem.ts`](.shared/workitem.ts). The
document is the item's state: its trust, stage, triage fields (the five judged
fields and the related work triage found: overlapping issues, earlier attempts and
merged changes on the same surface, which plan reads), promotion, claim and a short
history. The issue's pack labels mirror it, and a label a person adds is a
request, never the state.

- **Trust.** The `facts` script reads `.archon/sdlc/policy/maintainers.json` at the
  head of the default branch and records once whether the issue's author is on it.
  The file is a JSON array whose entries are forge logins, or objects naming one with
  opt-ins: `["alice", { "login": "bob", "merge_queue": "own-prs" }]`. Every listed
  login is a maintainer. `merge_queue: "own-prs"` also enrolls that maintainer's own
  open pull requests in the merge queue, except one a work item already names or one
  from a `build/` branch in the repository itself, so a hand-made pull request on a
  `build/` branch does not enroll (see Pickup there). Enrollment needs a forge
  operation the contract does not have yet, so it refuses today (see Forge); the merge
  queue notes the refusal on stderr and goes on with the items it already has. No file means an empty list, so every author is outside. Any other
  shape refuses the run.
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
  waiting item that sorts first (most urgent, then most important, then smallest,
  then oldest; an untriaged item sorts after triaged ones, oldest first) with a
  conditional write. Every queue claims in this order. A request that
  arrives while its item is claimed waits for the next intake run. A request label
  whose request no run has claimed may have a request on its way, so a run leaves
  it for the run that claims that request. It waits one pickup; the next pickup
  that still finds no request for it removes it. On a maintainer's item only
  `archon-triage` waits, since a route label is reconciled away either way. An
  open, edit or
  reopen adds no request while another one waits, since the pickup reads the live
  issue; label requests keep the newest 50. A run clears its
  claim only after the item's labels are written. A claim takes the work item's
  engine lease (`archon state put --lease`), and the next pickup releases a claim whose
  lease the engine reports ended: its run completed, was cancelled or abandoned, or was
  deleted. It queues that run's requests again; the item then sorts after every other
  waiting item until an attempt finishes, so one item that cannot be read or labelled
  never starves the rest. A claim whose run is pending, running, paused or failed is
  never released, because a failed run can resume; abandon the run to free its claim.
  A claim with no lease of its run, written before claims took one, is held and named
  by an idle pass; abandoning its run does not free it, so a person clears it by
  writing the document back with `claim` set to `null` through a conditional
  `archon state put <name> --if-revision <n>`. There is no age timeout.
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
  it again; one closed for another reason fails the run before any comment. A demoted item and every other verdict close nothing.
  Intake is the one workflow that closes: `archon-triage` run alone, even with
  `publish`, only labels the item `archon-close`, because inside intake triage runs
  unpublished so the outcome can withhold a verdict judged on text no maintainer
  promoted.
- **Closed issues.** Intake records the event and changes nothing else: no trust
  decision, no stage change, no label write.
- **Inputs.** `label_actor` is the one input that can create a promotion, never
  trust. Only the binding, or someone with access to the install, can supply it.

The pack installs no binding. Two bindings in the GitHub source plugin's configuration start
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
"in": ["archon-triage", "archon-ready", "archon-plan", "archon-investigate", "archon-split"]}]}`, and two
more mappings: `label` from `label.name` and `label_actor` from `label.actor.login`.
The predicate only saves runs; intake ignores any other label. A binding installed before the investigate label was renamed still lists `archon-issue`: replace it with `archon-investigate` in that binding, and in any build-queue binding that selects on it, because `label.name` predicates match exactly.

## Build queue

[`archon-build-queue`](build-queue/archon-build-queue.yaml) takes intake's triaged
items to a reviewed, ready pull request, and stops only for decisions that belong to a
person. It acts on its own when a case is clear and asks when it is not; the default
policy for which is which is [`.shared/policy/build.md`](.shared/policy/build.md),
which a project extends with its own `.archon/sdlc/policy/build.md`.

- **Pickup.** A run claims one item with intake's claim and order. An item waits for the build queue when its work item's stage is a READY
  route (`deliver`, `continue`, `plan` or `investigate`) and the queue has not
  recorded it, or recorded it as waiting for its next round. A `split` item is the
  split queue's, never the build queue's. A re-triage after the
  queue's last decision starts the item over. The build queue's claim takes none of
  the item's intake requests, so an edit or label request recorded while it holds the
  item waits for intake's next pickup. The queue writes no labels; intake's mirror
  stays as it is.
- **A named item.** The `number` input makes the run claim that issue instead of the
  first in order, so an operator chooses what a run builds and, with the launch's
  config, which provider builds it: one launch per issue, such as
  `--input number=123` with the config that selects Codex. An issue that cannot be
  claimed refuses the run before any agent, with why: it has no work item, another
  run holds it, or its stage and build status show it does not wait.
- **Blocked items.** Intake's blocked verdict can go stale while work lands in
  parallel: a blocker's outcome can arrive another way while its issue is still open.
  When `retriage_as` names a maintainer login, a run that names no item also revisits
  the blocked items, beside the item it builds. `blocked` lists the unclaimed blocked
  items not revisited in the last six hours, independently of item pickup and PR
  resolution. An unresolved PR create refuses the item's continuation without
  suppressing these revisits. A scheduled queue does not judge the same items every
  run. One `revisit` agent reads each issue, what it waits on and the default branch, and names the items that no longer look blocked. `retriage` adds
  `archon-triage` to each and starts `archon-intake` detached with that label event,
  recorded as added by `retriage_as`. Intake stays the judge: it re-triages only when
  that login is on the maintainer list, and its verdict decides whether the item now
  waits for the build queue. Every listed item records the revisit.
- **Route.** The `route` agent checks that the issue body is a contract (the six
  elements, with its dated "Current scope" sections), proves a bug's symptom before
  its first round, and writes the brief `archon-ship` starts from. A bug that needs a
  browser is reproduced with the playwright-cli skill, which the prompt names rather
  than a `skills:` entry, because a provider that cannot load named skills refuses a
  whole run that declares one.
- **Rounds.** One round is one included `archon-ship-block` run. The `answer` agent reads how
  it ended and decides: `done` when the pull request's latest review says Ready at its
  head commit and no check no round can run is still outstanding (a dated scope section records such a check as met; otherwise it asks for it once), `continue` with a brief when the contract already answers what stopped
  it (a correctable finding, CI red the change caused, a false blocker naming a later
  step), or `ask`. Before any `continue`, it compares the whole change with the contract's shape, and asks when a correction would add machinery the contract does not name. It never continues a pull request that changed nothing material since its last review, no commits or only cosmetic edits; that round ends as done or ask by the same rules. A Ready, green pull request whose only remaining check no round can run is asked about once rather than continued. It declares the pull request when the round left commits unpushed.
  A `continue` starts the item's next round at once by firing the operator's
  build-queue binding (`build_queue_binding`) with the item's `number`, keyed so one
  run starts at most one next round per item. The binding's resource, capacity and
  overlap policy apply, as for a scheduled pass; when the round is skipped, or no
  binding is set, the item waits for the next queue run.
  Facts reports the open pull request in the item's repository as the candidate, and
  the `route` agent declares whether the round continues it: unless a dated scope
  section or a recorded answer supersedes it. A continued pull request goes to
  `archon-ship` as `pull_request`, and delivery finishes it whichever route triage
  takes, pushing onto its head so the same pull request updates. A superseded one is
  never checked out or pushed to: ship gets `none`, so its triage cannot route the
  round back onto it. The round starts fresh, refusing a checkout that is not on the
  default branch, and its brief asks for the old
  pull request to be closed as superseded once the replacement opens. A round that failed
  after publishing still records its pull request. A round that continues none opens its
  pull request from `build/<issue>-<slug>-<run>`, a name never reused, and facts records
  that branch on the claim. When a pickup releases the claim of a run that ended before
  recording its round, the newest pull request from that branch, open, closed or
  merged, is recorded as the run's round with reason `ended_undecided`, and the next round sees it as its
  candidate. A closed or
  merged pull request, or one from a fork, is asked about; a round launched anyway
  never continues it, since ship gets `none` for it too.
- **Round cap.** When a round ends wanting another and `round_limit` rounds (default 3)
  have run since the item's scope last changed, by a re-triage or a maintainer's
  answer, the `answer` agent also compares their reviews. Each round finding new
  defects asks the scope question instead of running another round.
- **Writes.** The `apply` script refuses an attention item without the choice it
  recommends, pushes the declared commits (never forcing, and reading the remote head
  back), then records the decision on the work item and releases the claim, in one
  conditional write. A run that asks keeps its claim while it is paused.
  When route finds the pull request already reviewed at its current head, apply
  checks that head before and after taking it out of draft. A changed read-back
  head fails readiness and, unless already draft, triggers one draft correction
  through the forge. The failure reports the observed head, state
  and draft status; a failed correction preserves its error and attempts one
  diagnostic read. If verification fails, inspect the PR, restore draft if still
  open and ready, and review its current head before readiness. These observations
  cannot prevent another actor changing it afterwards. The merge queue still owns
  exact-head review and merge checks.
- **Attention.** An unclear decision pauses the run as one `select` attention item
  labelled `build: route`, `build: stop` or `build: scope`. It says what the decision
  is, why it matters, the agent's recommendation with its evidence, confidence and
  what would change it, the choices and what each does, what happens if nobody
  answers, and the links to the evidence. The answer is one declared choice, or
  `other`, which every item offers: its text says what to do instead and becomes the
  ruling, and the item continues from it. The queue never reads the answer's prose for
  a decision. The `ruling` script writes the
  choice's ruling and the person's words into the issue body as one dated "Current
  scope" section, reads it back, and records the answer: a `continue` choice starts
  the item's next round at once through the build-queue binding, as a `continue`
  decision does. A `ready` choice hands the pull
  request to the merge queue as it stands, as after a maintainer finished it by hand;
  the merge gate still checks it, and an item with no pull request refuses the answer.
  A `park` choice stops working the item until a re-triage. If a continue's next round
  does not start, the item waits for the next queue run. A run cancelled while it waits leaves the item asking, and only a
  re-triage starts it over.
- **Record.** The work item's `facts.build` holds the item's status, which says who
  owns it: the build queue (`next`, `asking`), the merge queue (`ready`), or no queue
  (`parked`). It also holds the brief its next round
  starts from, its last ten rounds and its last twenty decisions with any maintainer's
  answer.

The pack installs no binding. A schedule keeps items moving, because a run works one
item and a continuation waits for the next run. Each run includes `archon-ship-block`, which
changes its checkout, so every run needs its own worktree:

```json
{
  "version": 1,
  "sourceInstanceId": "widgets-build-queue",
  "binding": {
    "bindingId": "build-queue",
    "bindingRevision": null,
    "hostId": "build-host-1",
    "runAsUserId": "<archon user id>",
    "resource": "forge:github.com/acme/widgets:build",
    "capacity": 2,
    "overlap": "skip",
    "launch": {
      "cwd": "/srv/archon/widgets",
      "workflowName": "archon-build-queue",
      "inputs": {
        "repo_host": "github.com",
        "repo_path": "acme/widgets",
        "build_queue_binding": "/srv/archon/bindings/widgets-build-queue.json"
      },
      "isolation": { "kind": "worktree" }
    }
  },
  "schedule": { "intervalSeconds": 1800, "runAtLoad": false }
}
```

`build_queue_binding` names this file, so a run's follow-up rounds start through the
same binding: one run of the queue holds a slot of the resource while it fires its
follow-up, so the follow-up needs a free slot, or waits in line under `"overlap":
"queue"`. Without the input, follow-ups wait for the next scheduled run.

To start a run as soon as intake routes an item, add a label binding on the same
resource, with intake's label selector narrowed to the route labels intake writes
(`archon-ready`, `archon-plan`, `archon-investigate`) and the same launch.

### Work orders

A work order is the set of work items an operator approved for the factory, so the
queue's schedule can stay on while the operator chooses what builds. Set
`"orders_only": "true"` in the binding's `launch.inputs`, and a run that names no item
claims only a waiting item that is a member of an open order, in the usual pickup
order. With no open order it claims nothing. A named item (`number`) is claimed either
way, so a member's follow-up rounds still start. The default, `"false"`, picks from
every waiting item.

An order is one state document, `work-order/<id>`, in the project's state scope, whose
key is the repository's `owner/repo`. The operator, or their agent, writes it; nothing
in the pack proposes one yet:

```bash
printf '%s' '{
  "version": 1,
  "members": [123, 130, 131],
  "approved": { "by": "<login>", "at": "2026-11-06T12:00:00Z" },
  "status": "open",
  "done_at": null
}' | archon state put work-order/after-0.14 --if-revision 0 --project acme/widgets
```

`members` are issue numbers whose work items intake has recorded. A member is still
built only once it waits for the build queue: triaged READY and not already decided.
Each member merges on its own, through the merge queue. While `orders_only` is on,
each run first marks done every open order whose members are all finished, setting
`status` to `done` and `done_at`. A member is finished when its work item's latest
decision is a merge: `facts.merge.status: merged`, with no build or re-triage recorded
after it. A member closed without a merge, or with no work item, keeps its order open
until the operator removes it from `members`. To drop an item, or add one, replace the
document at its current revision. A malformed order, including an `open` one with a
`done_at` or a `done` one without, refuses the run with its name, rather than building
something no order chose.

## Split queue

[`archon-split`](split/archon-split.yaml) breaks a large item into the fewest pieces
that each prove something on their own, and files only the piece that comes next. A
large item, such as a PRD, an epic or a bundle of tasks, is built as one work item by
default. Triage routes it `split` only when building it whole would not work, and its
summary says why. The default triage policy,
[`.shared/policy/triage.md`](.shared/policy/triage.md), says when splitting is right,
how each kind splits, and what a PRD is: a release that tests a hypothesis, held to
its hypothesis, its signal with the command that measures it, and its threshold and
window, whether it is split or built whole. A PRD missing any of them gets
`archon-needs-contract`, naming the gap. A project refines the bar in its own
`.archon/sdlc/policy/triage.md`.

- **Pickup.** A run claims one item with intake's claim and order. An item waits for
  the split queue when its stage is `split` and no split finished on it, or a
  re-triage came after the last one. The `number` input claims that issue instead,
  and refuses the run with why when it cannot, as the build queue's does. The claim
  takes none of the item's intake requests.
- **Slice.** One agent reads the issue (written to `split/prd.md`), triage's reason,
  the triage policy, the project's direction and current code. It checks triage's
  judgment first: when one work item would work, it answers `whole` with a build
  route (`plan` or `deliver`) and why. Otherwise it judges the item a PRD, an epic or
  a bundle. A PRD splits into phases, each proving a desired outcome; an epic into
  vertical increments, each leaving the product working; a bundle is not sliced, and
  every task is filed as written. Only the current phase or increment is filed. Each
  later one is listed with what the earlier work must show before it is filed. An
  open issue that already owns a piece is listed as existing instead of being filed
  again.
- **Publish.** The `publish` script files each issue with a hidden first line,
  `<!-- archon-split: <item> <key> -->`. Each filed issue is recorded on the work item
  before the next is filed, and a key already recorded is never filed again; a key
  whose issue was filed but not recorded is recovered by its marker. So a run that
  stops part way, or the next phase's split after a re-triage, files no issue twice.
  Each existing issue the agent listed is read to prove it is an open issue of the
  repository. The item then gets one marked comment listing its issues and the later
  phases. A PRD is labelled `archon-prd` and stays open until its hypothesis has a
  verdict; an epic stays open until its increments merge; a bundle is closed as
  completed. The last write records the split done and releases the claim. An issue
  closed before its split finishes is recorded and files nothing more.
- **Next phase.** When the earlier work shows its signal, re-triage the item. It
  routes `split` again, and the agent files the next phase from the plan in the
  comment, reusing the keys of what is already filed.
- **Build whole.** On a `whole` answer, the item gets the same marked comment with the
  agent's reason, its route label in place of `archon-split`, and the last write moves
  its stage to that route, where the build queue picks it up as one work item.
  Triage reads that comment on a later re-triage. An item an earlier split already
  filed issues from refuses a `whole` answer, since those pieces may be in flight.
- **Record.** The work item's `facts.split` holds the status (`filing`, `done`,
  `whole` or `closed`), whether the item is a `prd`, an `epic` or a `bundle`, every
  issue filed from it by key and title, and the existing issues it adopted with why,
  kept across phases. A `whole` record holds only the route; the reason is in its
  history entry and the comment.
- **The filed issues** come back through intake like any other issue. They are opened
  by the install's own identity, so intake trusts them only when that login is on the
  maintainer list.

The pack installs no binding. A schedule keeps items moving, as for the build queue.
The run reads the checkout and writes only to the tracker and the state store, so it
needs no worktree:

```json
{
  "version": 1,
  "sourceInstanceId": "widgets-split-queue",
  "binding": {
    "bindingId": "split-queue",
    "bindingRevision": null,
    "hostId": "build-host-1",
    "runAsUserId": "<archon user id>",
    "resource": "forge:github.com/acme/widgets:split",
    "capacity": 1,
    "overlap": "skip",
    "launch": {
      "cwd": "/srv/archon/widgets",
      "workflowName": "archon-split",
      "inputs": { "repo_host": "github.com", "repo_path": "acme/widgets" },
      "isolation": { "kind": "default" }
    }
  },
  "schedule": { "intervalSeconds": 1800, "runAtLoad": false }
}
```

To split an item as soon as intake routes it, add a label binding on the same
resource, with intake's label selector narrowed to `archon-split` and the same launch.

## Merge queue

[`archon-merge-queue`](merge-queue/archon-merge-queue.yaml) merges the pull requests
the build queue finished, and stops only for decisions that belong to a person. It
merges on its own when a case is clear and asks when it is not; the default policy for
which is which is [`.shared/policy/merge.md`](.shared/policy/merge.md), which a project
extends with its own `.archon/sdlc/policy/merge.md`: the sweep reads the default and
then the project's file, whose lines win where the two conflict.

- **Pickup.** A run claims every waiting item, up to `limit` (default 10), with
  intake's claim and order. An item waits for the merge queue when its build record is
  `ready` and the merge queue has not settled it: it never decided it, or left it
  waiting or asking. When the build queue readies an item again after the merge queue
  returned or parked it, it waits again. The pull request is the latest one a build
  round recorded, or, when no round recorded one, the one triage routed the item to
  continue. One already merged or closed is recorded without the
  agent. Before claiming, the run enrolls each open, non-draft pull request by a
  maintainer whose `maintainers.json` entry sets `merge_queue: "own-prs"` and that no
  work item names yet: it gets a work item of its own (`facts.own_pr`). A pull request
  a build round recorded, or one triage routed an item to continue, is named by its
  build item and never enrolls. Neither does one from a `build/` branch in the
  repository itself, the namespace every build round opens its pull request from, even
  before the round records it. A hand-made pull request on a `build/` branch therefore
  does not enroll; name the branch something else. An own-PR
  item has no build record of its own, so where another would go back to the build queue
  (no verdict, a stale one, a conflict, a holding thread, red CI the change caused) the
  sweep asks instead, naming what is wrong and the command a maintainer can launch, and
  its question offers no `return`. The record never hands one to the build queue.
  The queue never starts that run itself. An own-PR item answered `park` or `other`
  waits again only when its current head differs from its latest merge decision's
  head. At the same head it stays parked. Merged own-PR items and other kinds of
  settlement, including unreadable and superseded parks, do not recover this way.
- **Facts.** The `facts` script reads each pull request in one GraphQL snapshot: its
  head, how many commits of the default branch it lacks, whether it merges cleanly, CI and unresolved review threads at the
  head, and the review verdict. Only a review comment a listed maintainer wrote
  (`.archon/sdlc/policy/maintainers.json` on the default branch) counts; verdicts
  from other authors are ignored. The login that authors the pack's published review comment
  must be listed in that file on the default branch for its verdict to count.
  This is the forge plugin's credential identity.
  Check the published comment's author when choosing which login to list.
  A failed PR read waits once; a second consecutive failure
  parks the item with the read error recorded until the build queue readies it again.
  Renewed build readiness gives a parked item another first-read wait. A successful
  read resets that sequence even if later work fails. An unreadable own-PR park stays
  parked; it is not an answered park. To reconsider an answered own-PR park, facts
  reads its snapshot before claiming and reuses it in the sweep. A failed recovery
  read leaves that unclaimed item unchanged and reports the error. If the default branch
  cannot be read, facts passes its diagnostic and the batch to record without a sweep.
- **Sweep.** One agent decides every pull request and orders them, least risk first.
  The queue never pushes, never changes its checkout and never waits for CI. A Ready
  pull request with green CI that the forge reports merges cleanly into the default
  branch merges, reshape or not, even when it is behind; the default branch's CI on the
  merge is the next sweep's first fact. Every pull request that can merge in a sweep
  merges in it. What the build queue can fix goes back to it with a brief: a verdict
  that is not Ready or is for another commit (a push after the review), a conflict with
  the default branch (the round merges it in and resolves the conflict, regenerating
  generated files with their owning script), an unresolved thread that raises a defect
  in the change, and red the change caused. Red CI in code a pull request does not touch
  gets one rerun of its failed jobs through `checks.rerun`, counted only when the forge
  reports it applied; the record stores the head it re-ran at, and the
  sweep reads it so it never reruns twice at one head. The sweep measures each diff
  with git against the merge base, not the forge's counts. An unclear pull request is
  asked as soon as its verdict is Ready at its head, even while its CI is pending or it
  conflicts; the approval is pinned to that head and a later sweep merges it once the
  gate passes. An approval carries to a later head only when the sweep judges that
  everything since the approved head is merges of the default branch and their
  conflict resolutions, and the verdict is Ready at the later head; any doubt voids it.
- **Gate.** The sweep merges only through
  [`gate.ts`](merge-queue/scripts/gate.ts), which reads the pull request and the
  default branch fresh and refuses unless the verdict says Ready for the head, CI is
  green at the head, the default branch's CI is not red (pending does not hold a
  merge), and the pull request is open, not a draft, into the default branch, at the
  head the sweep named, and that head contains the default branch's head or the forge
  reports it merges cleanly. Open review threads are the sweep's judgment. It merges
  through `pr.merge` pinned to that head and reads the merge back. A pull request that reads back unmerged, as when the forge
  queues merges, fails the gate.
- **The default branch.** The sweep judges it first. While its CI is red the gate
  refuses every merge, and the sweep always raises it to a maintainer, naming the pull
  requests merged since it was last green. It recommends a revert or fix-forward, or,
  when no recent merge touched the red code, a rerun of the failed jobs by hand: the
  forge's `checks.rerun` acts only on a pull request, so the pack never reruns the
  default branch and never reports that it did. An unreadable default branch permits no sweep or merge;
  independent bookkeeping completes before the run fails with the read diagnostic.
- **Record.** When the default branch could not be read, `record` writes the independent
  settlements, releasing only claims it still owns. Open companions remain unchanged;
  the next pickup releases their claims once the run ends: a failed run keeps them
  until it is resumed and finishes, or is abandoned. It makes no further forge
  reads and fails with the original diagnostic and any settlement write failures.
  Otherwise, the `record` script skips and reports a decision for a pull request this
  run did not claim, because that item belongs to another run. It refuses a
  `return` without a brief, a `return` for an own pull request, an `ask` without its
  question, an `ask` that offers a `return` on an own pull request or with a blank
  brief, and a red default branch the sweep did not raise: the pull
  request waits for the next sweep, and the record fails, naming each, once every
  other decision is written. A claimed pull request
  the sweep left undecided waits for the next sweep, and an ask with no attention item
  waits the same way. It reads every pull request back: the forge, not the sweep, says
  what merged, at the head the forge merged. A sweep that says it merged a pull
  request the forge does not show merged fails the record after every other decision
  is written: that pull request is recorded as waiting, or parked if it was closed,
  and the failure names a red default branch the run could not raise and any work
  item it could not write. A pull
  request that cannot be read waits for the next sweep; a work item that cannot be written is reported, so one bad item never loses
  the rest of the batch's record.
  It writes one decision per item under
  `facts.merge` (status `waiting`, `asking`, `merged`, `returned` or `parked`, any
  approval pinned to the head it approved, and
  the last twenty decisions), and a return sets the build record to `next` with the
  brief, so the build queue picks it up.
- **Merged issues.** A pull request that links its issue with `Refs #N` merges
  without closing it, and the issue keeps its intake stage, so the build queue could
  claim it again. When `retriage_as` names a maintainer login, `retriage` reads the
  issue of each build item whose pull request merged, by the gate this run or before
  it. One still open gets `archon-triage` and an `archon-intake` run started detached
  with that label event, recorded as added by `retriage_as`. Intake stays the judge:
  it re-triages only when that login is on the maintainer list, and closes the issue
  as delivered or keeps it with what is still open. A closed issue and an own pull
  request, which has no issue, are left alone. A failed read, label write or launch
  is named in the node's summary and stops nothing else. Empty `retriage_as`
  re-triages nothing.
- **Attention.** A run raises at most one attention item: a red default branch, whose
  one choice holds merges until it is green, or else the first pull request the sweep
  asked about, labelled `merge: base` or `merge: pr`. It carries the build queue's
  fields: what it is, why it matters, the recommendation with its evidence, confidence
  and what would change it, the declared choices, what happens if nobody answers, and
  links. A build-owned ask with a blank brief still raises its question when it
  offers no `return`. Every pull-request item also offers `other`; for a build item with a nonblank
  brief, it returns the pull request to the build queue with the answer's text as
  the ruling. Without a brief, `other` records the text and parks until the build
  queue readies the item again; no build round starts. A red default branch is only
  ever held, so its item offers `hold` alone. On a pull request, `merge` approves it at the head that was asked about, and
  a sweep the answer starts at once through the merge-queue binding
  (`merge_queue_binding`) merges it once the gate passes there; `return` writes the
  choice's ruling into the issue body as a dated "Current scope" section and hands the
  item back to the build queue, whose next round starts at once through the
  build-queue binding (`build_queue_binding`); `park` stops working it until the build queue readies it
  again. For an own PR, both `park` and `other` stop queue work until a later sweep
  observes a different head from the one asked about. The `other` answer stays on
  the work item as its ruling; it writes no issue body and starts no build round.
  New CI or review results at the same head do not unpark it. Approval remains pinned
  to its approved head, subject to the existing conflict-only carry rule. Any other
  ask waits for a later sweep, which decides it again.

The pack installs no binding. A schedule sweeps the queue. A run never changes its
checkout, and the claim keeps two runs off the same item:

```json
{
  "version": 1,
  "sourceInstanceId": "widgets-merge-queue",
  "binding": {
    "bindingId": "merge-queue",
    "bindingRevision": null,
    "hostId": "build-host-1",
    "runAsUserId": "<archon user id>",
    "resource": "forge:github.com/acme/widgets:merge",
    "capacity": 1,
    "overlap": "queue",
    "launch": {
      "cwd": "/srv/archon/widgets",
      "workflowName": "archon-merge-queue",
      "inputs": {
        "repo_host": "github.com",
        "repo_path": "acme/widgets",
        "merge_queue_binding": "/srv/archon/bindings/widgets-merge-queue.json",
        "build_queue_binding": "/srv/archon/bindings/widgets-build-queue.json"
      }
    }
  },
  "schedule": { "intervalSeconds": 1800, "runAtLoad": false }
}
```

`merge_queue_binding` names this file and `build_queue_binding` the build queue's, so
an answer's follow-up starts through the operator's own binding. The answering run
still holds the merge queue's only slot when it fires the sweep, so the binding uses
`"overlap": "queue"`: the sweep a "merge" answer fires waits in line and starts as soon
as the answering run ends, at the host's next drain (a server drains every few seconds;
a CLI-only host needs `archon trigger drain` scheduled). A scheduled tick that finds a
sweep running also waits in line instead of being dropped. With `"overlap": "skip"`
the answer's sweep would be skipped and the next scheduled sweep would merge the pull
request. Without the inputs, follow-ups wait for the next scheduled run.

## Discoveries

[`archon-discoveries`](discoveries/archon-discoveries.yaml) drains the discoveries
finished runs recorded outside their own scope. A run's discoveries are its latest
review verdict's certified records plus any raw `discoveries/*.json` record a node
wrote after that review ([`.shared/report.ts`](.shared/report.ts)), the same set its
terminal report lists.

- **Queue.** A pass lists this project's runs that ended (completed, failed or
  cancelled) inside `since` and `until`, oldest first, and claims up to `limit` of
  them that still have undecided records. A run's state document
  `discoveries/runs/<run-id>` is its memory and its work item: the refs a pass decided
  for it, the questions a pass asked about it with their answers, and the claim of the
  pass working it. A record is decided once its run's document lists it. Every run
  document is read in one call. A claim takes the document's engine lease and is
  taken over only when the engine reports that lease ended (the claiming run
  completed, was cancelled or abandoned, or was deleted), never on age. A failed pass
  keeps its claims, since it can resume. A run whose records cannot be read is
  left queued and named on the pass's stderr.
- **Decisions.** One agent decides every queued record, under the project's direction
  document and the policy files `discoveries.md`, `triage.md` and `rulings.md`. It
  verifies each claim against the default branch's head with `git show` and
  `git grep`, merges duplicates across runs, and searches the tracker before filing.
  There is no store of decisions across runs: a defect a later run finds again is
  judged again against the tracker. Each discovery ends in one decision: `file` an
  issue with a full brief, `track` it on the open issue that already covers it (with
  one marked evidence comment per key, only when it adds something), `drop` it with a
  reason, or `ask` a maintainer.
- **Writes.** The `outcome` script checks before any write that every queued record is
  decided exactly once and that a tracking issue is open. Then it makes the public
  writes. A filed issue's body begins with `<!-- archon-discovery <key> -->`, and the
  create looks for that marker across every issue first; the evidence comment carries
  the same marker and is replaced in place. So a pass run again after a stop, or a key
  filed twice, never opens a second issue, nor a second comment except as [Intake](#intake)
  describes. Last it records the decided refs
  and the questions on each run's document. Filed issues carry no labels: intake
  triages them like any other issue, which it does only when the install's forge
  identity is on `maintainers.json`.
- **Questions.** Every `ask` in a pass becomes one attention item labelled
  `discoveries: question`. The answer is stored on the asking run's document. The runs
  those records came from stay claimed by the asking run until it ends, so no other
  pass asks again; the next pass then decides them with the answer beside the records.

The pack installs no binding, so the workflow runs only when started by hand until an
operator adds one. A native schedule starts a pass every few hours; `overlap: skip`
skips a start while a pass still runs, and a pass paused on a question gives its slot
back:

```json
{
  "version": 1,
  "sourceInstanceId": "build-host-discoveries",
  "binding": {
    "bindingId": "discoveries",
    "bindingRevision": null,
    "hostId": "build-host-1",
    "runAsUserId": "<archon user id>",
    "resource": "discoveries:github.com/acme/widgets",
    "capacity": 1,
    "overlap": "skip",
    "launch": {
      "cwd": "/srv/archon/widgets",
      "workflowName": "archon-discoveries",
      "inputs": { "repo_host": "github.com", "repo_path": "acme/widgets" },
      "isolation": { "kind": "default" }
    }
  },
  "schedule": { "intervalSeconds": 14400, "runAtLoad": false }
}
```

## Metrics

[`archon-metrics-prs`](metrics-prs/archon-metrics-prs.yaml) records the outcomes of the
pull requests the build queue opened, for `archon metrics` to aggregate:

| Metric | Kind | Unit | One record per pull request, at |
|---|---|---|---|
| `sdlc.prs_opened` | count | `prs` | its creation |
| `sdlc.prs_merged` | count | `prs` | its merge |
| `sdlc.prs_abandoned` | count | `prs` | its close (1) when it closed without merging; else its merge or creation (0) |
| `sdlc.pr_merge_rate` | score | `ratio` | its merge (1) or its close without merging (0) |

A pull request still open counts as opened and has no merge rate yet. Abandoned means
closed without merging, whoever closed it. Every pull request records 0 or 1 for
abandoned, so a reopened pull request replaces its earlier 1; the abandoned value counts
abandoned pull requests, and its `n` counts every pull request measured.

The pull requests come from the build rounds on the work items: a factory pull request is
one a round opened from a `build/` branch in the repository itself. A pull request a round
only continued, such as a contributor's, counts in no metric and is listed in the node's
`skipped` output. Each record names its pull request as the subject and the build-queue
runs that built it as its producing runs, so it lands in the cohort of those runs, not of
the day the metric ran:

```bash
archon metrics sdlc.pr_merge_rate --compare <when this checkout picked up a pack change>
```

Records whose build runs started on both sides of the cut are counted as straddling and
left out of both sides. The comparison is observational: anything else that changed
around the cut is mixed in.

Cost per merged pull request is the cost `archon metrics sdlc.prs_opened` reports
(`cost.usd` with `--json`), divided by the `sdlc.prs_merged` value over the same window.
It covers the build-queue runs that built a pull request; queue runs that built none are
not attributed to any. The console metrics page's Cost per PR card shows this figure. It is a floor: runs on a provider that reports no cost add nothing
and are counted instead.

Two kinds of factory pull request are missed, and both are mostly ones closed without
merging, so the abandoned count is low and the merge rate high:

- A round is recorded when its run reaches the queue's decision. A run cancelled after
  it opened a pull request records no round, so that pull request is missed.
- A work item keeps its last ten rounds. A pull request whose rounds all fell out of that
  record is missed, and one whose early rounds fell out is attributed to its later runs
  only, so it can land in a later cohort with a lower cost.

The workflow holds no state and reads every pull request again on each run; a re-run
replaces the earlier records. It reads each pull request by number through `pr.view`,
whose `timestamps` give the creation, merge and close times; a plugin that does not
report them makes it refuse. Run it on demand:

```bash
archon workflow run archon-metrics-prs
```

The pack installs no binding. A native schedule refreshes the records daily:

```json
{
  "version": 1,
  "sourceInstanceId": "widgets-metrics-prs",
  "binding": {
    "bindingId": "metrics-prs",
    "bindingRevision": null,
    "hostId": "build-host-1",
    "runAsUserId": "<archon user id>",
    "resource": "metrics-prs:widgets",
    "capacity": 1,
    "overlap": "skip",
    "launch": {
      "cwd": "/srv/archon/widgets",
      "workflowName": "archon-metrics-prs",
      "inputs": {},
      "isolation": { "kind": "default" }
    }
  },
  "schedule": { "intervalSeconds": 86400, "runAtLoad": false }
}
```

### Test value

[`archon-metrics-test-value`](metrics-test-value/archon-metrics-test-value.yaml) judges
the tests in each factory pull request merged since its `since` input, one
[`archon-metrics-test-value-judge`](metrics-test-value-judge/archon-metrics-test-value-judge.yaml)
run per pull request, and records per pull request:

| Metric | Kind | Unit | Meaning |
|---|---|---|---|
| `sdlc.tests_added` | count | `tests` | tests the pull request added or changed, as the judge listed them |
| `sdlc.tests_unprotective` | count | `tests` | those that protect nothing on their own merits: no plausible regression fails them that another test the judge was shown would not catch |

Both are the judge's counts: a test the judge leaves out is in neither, and calibration
scores such omissions as disagreements. Both are attributed to the build-queue runs that
built the pull request, at its merge time, like the PR metrics. A pull request whose
judge run failed has no record and is listed in the node's `skipped` output. Each pull
request costs one judge run on the `large` tier, so the window sets the cost.

The judge reads the pull request's changed files through `pr.files`, and the text of
each changed file that holds test code at the head that list was read at through
`repo.file`. The `prs` node refuses before any judge runs when the plugin lacks either.
A file holding test code that the forge does not return as text, such as one over 1 MB
on GitHub, fails that pull request's judge run, so the pull request is listed in
`skipped`.

The judge applies the review pack's test lens
([`review/commands/review-tests.md`](review/commands/review-tests.md)), read when it runs,
for its standard of what a valuable test is. The lens anchors on what a change promises;
the judge's prompt overrides that anchor and adds its own rules. The judge sees the pull
request's patches and the full text of the files that hold changed test code, so
redundancy is judged only against those tests: a duplicate of an unchanged test elsewhere
in the suite counts as protective. It records no metric of its own. On Claude it runs
with no tools; Codex does not enforce the restriction and can read the checkout.

**Calibration.** A judged count is only as good as the judge.
[`archon-metrics-test-value-calibrate`](metrics-test-value-calibrate/archon-metrics-test-value-calibrate.yaml)
runs the same judge over the pull requests the project labeled by hand in
`.archon/sdlc/metrics/test-value-cases.json`, read from the checkout the run starts in,
and scores it, one 0/1 record per labeled test:

- `sdlc.tests_unprotective_judge_agreement`: the verdict matches the label.
- `sdlc.tests_unprotective_judge_catch_rate`: for tests labeled unprotective only, the
  judge flagged it. A judge that calls every test protective scores 0 here, however high
  its agreement.

A labeled test the judge did not list counts as a disagreement. The node's
`disagreements` output lists every test it got wrong, with the judge's reason. The run
refuses when the file is missing or empty, and when the judge failed on any case, since
agreement over a different set of cases is not comparable. Each record's `n` and interval
say how much the labels can tell; a handful of cases gives a wide interval. The pack ships
no labels: they are the project's own pull requests.

The file is a list with one case per pull request:

```json
[
  {
    "pr": "<pull request URL>",
    "tests": [{ "file": "<path>", "name": "<suite> > <test>", "protects": true }]
  }
]
```

`name` is the test's suite titles and own title joined by ` > `. Placeholders such as `%s`
or `${value}` are ignored when labels and verdicts are matched. Label by hand: labels a
model drafted calibrate the judge against itself.

**One judge, one identity.** All four records name the same instrument: a hash of the
judge workflow's files and the criteria text it inlines. The engine adds the models that
ran the judge node, so `archon metrics` reports one entry per judge and model, and never
averages two. Editing the judge's prompt, the test lens or anything in the judge's
directory, including the rule in `scripts/test-code.ts` that picks which files it reads
in full, or remapping the `large` tier to another model, starts a new identity. Run
the calibration again before trusting the counts it produces. Compare the agreement the
two models reached after calibrating with each:

```bash
archon metrics sdlc.tests_unprotective_judge_agreement --by-model judge
```

`since` takes an ISO date or a number of days back, such as `7d`:

```bash
archon workflow run archon-metrics-test-value --input since=7d
```

The pack installs no binding. A native schedule judges the last day's merges daily; a
pull request judged twice keeps its latest record:

```json
{
  "version": 1,
  "sourceInstanceId": "widgets-metrics-test-value",
  "binding": {
    "bindingId": "metrics-test-value",
    "bindingRevision": null,
    "hostId": "build-host-1",
    "runAsUserId": "<archon user id>",
    "resource": "metrics-test-value:widgets",
    "capacity": 1,
    "overlap": "skip",
    "launch": {
      "cwd": "/srv/archon/widgets",
      "workflowName": "archon-metrics-test-value",
      "inputs": { "since": "1d" },
      "isolation": { "kind": "default" }
    }
  },
  "schedule": { "intervalSeconds": 86400, "runAtLoad": false }
}
```

## Worktree cleanup

[`archon-worktree-cleanup`](cleanup/archon-worktree-cleanup.yaml) runs the host CLI's
`archon isolation cleanup --merged` across every project registered on the install. It
removes each merged worktree with its local branch, including a branch the worktree
adopted rather than created. Git ancestry or patch equivalence proves a merge without a
pull request; otherwise the branch's merged pull request does. Remote
branches are retained with a warning: after registration retirement, a Git commit
ID cannot prove whether the branch belongs to a replacement registration. Force
does not bypass this refusal. For manual cleanup, follow the
[remote branch recovery procedure](https://archon.diy/reference/cli/#recovering-remote-branch-cleanup)
in the CLI reference. It covers destination inspection, ownership verification and leased deletion.
On GitHub, enable **Automatically delete head branches** in repository settings to have
GitHub remove merged pull requests' branches automatically.

A worktree with uncommitted changes, a run
that can still claim it, or a commit the merge does not cover stays and is reported. With `include_closed: "true"`
it also removes worktrees whose pull request was closed without merging. It runs in place
and creates no worktree of its own.

Who removes each checkout:

- Intake, triage, discoveries, the merge queue, forge check and this workflow create no
  worktree. They run in the launch checkout as it stands, so point a binding's `cwd` at a
  checkout that tracks the default branch.
- A run that creates a worktree on its own run-named branch, such as a build round,
  removes it when the run completes if the checkout is clean and every commit is on a
  remote; its pushed branch counts. The branch stays. Otherwise the run reports what
  removing it would lose, and the checkout stays listed by `archon isolation list`.
- A worktree launched with `--branch` waits for this workflow's merged sweep.

A server already runs a merged sweep on its cleanup schedule, so this binding is for
installs that run only the CLI. The pack installs no binding. A native schedule starts a
pass every few hours:

```json
{
  "version": 1,
  "sourceInstanceId": "build-host-worktree-cleanup",
  "binding": {
    "bindingId": "worktree-cleanup",
    "bindingRevision": null,
    "hostId": "build-host-1",
    "runAsUserId": "<archon user id>",
    "resource": "worktree-cleanup:build-host-1",
    "capacity": 1,
    "overlap": "skip",
    "launch": {
      "cwd": "/srv/archon/widgets",
      "workflowName": "archon-worktree-cleanup",
      "inputs": { "include_closed": "false" },
      "isolation": { "kind": "default" }
    }
  },
  "schedule": { "intervalSeconds": 21600, "runAtLoad": false }
}
```

## Docker verification

For disposable verification images, use `docker build --label "archon.run_id=$WORKFLOW_ID" -t "verify-$WORKFLOW_ID:check" .` (or the same `--label` with `docker buildx build --load`). Give each run unique tags and use the same Docker context as the Archon host. A child run uses its own `$WORKFLOW_ID`. Remove verification containers when the check finishes, including stopped containers.

Cleanup is a one-shot attempt after a completed or non-recoverable cancelled run stops writing. Failed runs (including SIGINT/SIGTERM interruptions) and recoverable fan-out-cancelled children retain their images because they can resume under the same run ID. Failed runs can release their images through explicit abandonment or safe manual recovery. Recoverable fan-out-cancelled children require the safe manual recovery below; explicit abandonment does not release their images. Container-used images and ambiguous/live owners retain their images too. There is no watcher for containers removed later. Docker errors are reported; terminal run status is unchanged.

If the initial verification-image inventory fails on a host run, Archon preserves the run's own exit code and reports a run-named warning with manual recovery guidance, regardless of the failure's cause. Cleanup is inconclusive; images may remain. Restore access to the intended Docker context and use the recovery steps below. Failures after inventory (inspection, container-use checks, or removal) still fail an otherwise successful foreground command, as do container-run cleanup failures. Host runs skip optional image cleanup only when Docker is absent at both host setup and cleanup. Container runs always require Docker.

Use one tag per image. Cleanup deletes immutable image IDs without force or parent pruning; Docker refuses IDs with multiple repository references. Those images require manual cleanup under exclusive control of their tags. After removing late test containers and confirming the run cannot resume or write, list its images with `docker image ls --all --no-trunc --filter "label=archon.run_id=<run-id>"`, inspect each full ID with `docker image inspect <full-id>`, and check all containers with `docker container ls --all --filter ancestor=<full-id>`. For a confirmed owned, unused image, use `docker image rm --no-prune <full-id>`. If multiple tags prevent removal, verify and remove those references manually only while no other build or operator can reassign them. Never force removal or prune shared images/cache.

Unlabelled images and other runs' images are left alone. Shared build cache is retained: Docker cannot filter it by this image label.
