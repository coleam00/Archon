# Working in the SDLC pack

Conventions for this pack specifically. Project-wide judgment lives in
[`AGENTS.md`](../../../AGENTS.md); the YAML surface is governed by
[`.archon/workflow-language-constitution.md`](../../workflow-language-constitution.md).
How we decide what a workflow should be, agents first, is in
[`CONSTITUTION.md`](CONSTITUTION.md).

## Guards

A guard here must protect an action the node it lives in takes.

**Keep** a guard when it:

- verifies the effect of something this node just did: exit 0 is not proof, and a
  forge can accept a write and silently not apply it; or
- refuses to proceed on a question it asked and could not get an answer to, where
  guessing is irreversible. `archon complete` blocking a branch delete it could not
  prove safe is the shape.

**Cut** a guard when it re-asserts an invariant something else already established.
That belongs where it is established, once, not at each node that depends on it.

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
Nothing had ever gone wrong: the alarm that prompted the work was investigated
and closed invalid. And the copies did not even cover the steps that would have
suffered most from a drifted checkout: `impl` writes code to that checkout without
checking, and `validate` runs the project's tests against it without checking.

The preflight alone cost 31 lines and a stub in 17 fixtures, for a node no fixture
could ever run. All three copies are gone.

The rule is not "never defend against what has not happened": the two Keep cases
above have not happened either, and both are worth their few lines. The question is
whether the guard is protecting *this node's own action*, or restating something
that was already true when the node started.

## Public writes belong to a script

An agent judges and authors; one script node owns each public write and proves it
landed. The node acts on the values the agent before it declared in its typed output,
which the engine certified, writes through the forge, and fails unless the result reads
back. So "the write failed" and "the write may have landed" stay different outcomes, in
the pack as in the forge contract. A new public write gets a script node of its own, or
joins the one that already owns that surface; it does not go into a prompt.

Every forge read and write goes through `archon forge`:
[`.shared/forge.ts`](.shared/forge.ts) is the client, [`.shared/pr.ts`](.shared/pr.ts)
owns the pull-request operations and [`.shared/issue.ts`](.shared/issue.ts) the issue
operations. Nothing falls back to another tool when the plugin cannot answer. Every
pack label is declared in [`.shared/labels.ts`](.shared/labels.ts), and every stage
writes labels through its `writeLabels`, which adds and removes them as a delta so
labels another writer adds survive.

Two agents write directly, because the judgment is the write: delivery's `ci` agent
pushes a head that was left behind and flips the pull request between draft and ready,
and `update-pr-body` rewrites the description's stale claims. Their forge writes still
go through `archon forge`, after the `forge` node checked the plugin can act.

Which remote holds a repository is decided by its configured URL, never by the
remote's name ([`.shared/remote.ts`](.shared/remote.ts)).

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
is the owning configuration: `bun run type-check` compiles that project. Lint
covers every TypeScript file under `.archon/workflows/`, so it needs no globs of its
own. A script placed outside the type-check globs fails `pack-scripts-validation.test.ts`
rather than going quietly unchecked.

`.shared/outputs.generated.ts` holds the type of every node output and the values of every
enum, generated from the workflows' `output_format` schemas. A script reads a node's
output as `NodeOutput<'<workflow>', '<node>'>` instead of restating the shape. After
changing an `output_format`, run `bun run generate:workflow-output-types`; CI's
`generated-files` check fails while the file is stale.

The scripts' tool-boundary tests live under `.archon/scripts/__tests__/`. CI runs the pack
tests and the workflow fixtures on a pull request that changes the pack. Run them locally with
`bun run test --plan pack` and `bun run validate --only workflow-fixtures`.

Three rules, each protecting something a script cannot get back on its own:

- **Read every binding as a literal `process.env.INPUTS_<NAME>`.** The engine scans
  each script's own source at load and refuses a workflow whose script reads a
  binding no `with:` clause provides. It matches that literal form only, and it never
  follows imports, so a helper that built the key from a name would hide every read
  in the pack from that check, and a renamed binding would surface as a wrong result
  at the end of a paid run instead of a refusal before it started. Pass the value to
  `.shared/io.ts`, never the name.
- **Never call `process.exit()`.** Bun leaves without draining stdout: a 500 KB
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
URL is the common one, since `https://<token>@host/repo` is a perfectly ordinary
origin, so `.shared/remote.ts` reads remote URLs only to normalize them to `host` and
`owner/repo`, and only the remote's name and that identity reach a command line or
a message. Failure messages are the same
surface: interpolating the raw value into one leaks it just as effectively.

That retention is also why a node does not need its own log. The ready flip once
wrote one by hand, every command it ran echoed into an artifact, which is what
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

## A stage never pauses for a person

Each stage a person runs is one workflow, and a workflow that composes a stage includes
that same file. A stage ends with its typed outcome as the run's result: whether it got
there, and the report says why not. A stage that fails fails the run at the failed
node. The composer owns what follows a stage's ending and asks through its own
attention item when it needs a person, as the build queue does. A workflow that
includes `archon-deliver` keeps running after a failed delivery, because the report
node completes either way, so it gates what follows on `$deliver.output.ready`.

## A node's streams are the operator's channel

Retention is not the only reader. Anything a node writes to stderr is sent to the
operator as the run happens, even when the node succeeds, and that copy is not
redacted. So a node speaks for itself: capture what the commands inside it print,
and let only your own authored messages reach the streams. Re-emit a command's
output when it failed and its words are the diagnostic; drop it when it is just a
tool narrating itself. Capture a value's stderr separately rather than merging it,
too: a `gh` update notice merged into a read becomes the value.

## Operator documentation

How the pack behaves for the person running it is documented on the docs site, not
here. Update the page when a change alters what it says.

- [Set up the SDLC factory](https://archon.diy/getting-started/sdlc-factory/): the
  first run on a repository, policy files, model aliases and what the pack writes.
- [Operate the SDLC factory](https://archon.diy/guides/sdlc-operations/): pack
  settings, bindings, work items and claims, and each queue's pickup, decisions,
  questions and record, including work orders.
- [SDLC pack workflows](https://archon.diy/reference/sdlc-workflows/): every workflow,
  its inputs and what it produces, and how to continue a stage that ended not ready.
- [SDLC factory metrics](https://archon.diy/guides/sdlc-metrics/): the metrics the
  pack records and how the test-value judge is calibrated.
- [Forge](https://archon.diy/reference/forge/#use-the-forge-path-in-the-sdlc-pack):
  the plugin, its credential and the operations each stage needs.
- [Disposable Docker verification images](https://archon.diy/reference/variables/#disposable-docker-verification-images):
  the image label a run's Docker builds carry, and when the engine removes them.
