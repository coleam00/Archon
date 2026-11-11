# SDLC pack

This pack turns issues into merged pull requests. Intake triages each issue, the build
queue takes a triaged issue to a reviewed pull request, the merge queue merges it, and
the discoveries drain files what runs noticed outside their task. A run that reaches a
decision it cannot make pauses as one attention item, with a recommendation, for a
person to answer. Each stage is also a workflow a person can run alone.

This file has two parts. [Set up the pack](#set-up-the-pack) is a guide to install the
pack on one repository, written so a coding agent can follow it for its user.
[Author conventions](#author-conventions) is for people changing the pack.

How the queues behave once they run is on the docs site:

- [Operate the SDLC factory](https://archon.diy/guides/sdlc-operations/): work items and claims, and
  each queue's pickup, decisions, questions and record, including work orders and
  worktree cleanup.
- [SDLC pack workflows](https://archon.diy/reference/sdlc-workflows/): every workflow, its inputs and
  what it produces.
- [SDLC factory metrics](https://archon.diy/guides/sdlc-metrics/): the metrics the pack records.
- [Forge](https://archon.diy/reference/forge/#use-the-forge-path-in-the-sdlc-pack): the plugin, its
  credential and the operations each stage needs.
- [Disposable Docker verification images](https://archon.diy/reference/variables/#disposable-docker-verification-images):
  the image label a run's Docker builds carry, and when the engine removes them.

## Set up the pack

Follow the steps in order, from a clone of the repository the pack will work on. Each
step has a check, and a fix for when the check fails. The pack's settings and bindings
are still being shaped: [`.pack/pack.yaml`](.pack/pack.yaml) declares what exists, and
this guide describes only that.

If you are an agent doing this for a user:

- A step marked **Ask the user** is their decision. Put the question and what each
  choice means to them; do not choose.
- Ask before anything that writes to the tracker or the repository, starts a run, or
  enables a schedule or trigger. The steps say which commands do.
- Everything the pack writes (labels, comments, pushes, merges) is made as the forge
  account whose credential it uses.

### 1. Check Archon

```bash
archon doctor
archon workflow list archon-forge-check
```

`doctor` exits 0 when no check fails. The second command lists the workflow when the
pack is available in this checkout. If `doctor` reports no provider, add one with
`archon provider add <claude|codex|pi>`.

### 2. Install the forge plugin and give it a credential

The pack reaches the forge only through `archon forge` and a forge plugin. Nothing
falls back to another tool.

```bash
archon plugin list
```

The list must show a forge plugin for the repository's host. If it does not, install
one. For github.com:

```bash
archon plugin add coleam00/Archon/plugins/forge-github
```

**Ask the user** which forge account the pack acts as. On GitHub the credential is
`GH_TOKEN`, then `GITHUB_TOKEN`, then the `gh` login (`gh auth login`), in that order.
The [forge reference](https://archon.diy/reference/forge/#use-the-forge-path-in-the-sdlc-pack) covers
the other cases.

### 3. Check the forge

```bash
archon workflow run archon-forge-check
```

It reads only. A pass names the credential source it used. A refusal says what to fix:
a missing plugin, a plugin that lacks an operation the pack needs, or a credential that
cannot read the repository. It proves read access; the first write proves write access.
A run in a container has no path to the forge and refuses here.

### 4. Name the maintainers

The queues read `.archon/sdlc/policy/maintainers.json` from the head of the default
branch on the remote. A local copy does nothing.

```bash
git fetch origin
git show origin/<default-branch>:.archon/sdlc/policy/maintainers.json
```

The file is a JSON array of forge logins, such as `["alice", "bob"]`. With no file,
every author is outside and nothing is triaged or merged.

**Ask the user** who is a maintainer. The list decides two things:

- Whose issues get triaged. Anyone else's issue gets `archon-needs-maintainer` and
  starts no agent until a listed maintainer adds `archon-triage`. That label is how a person
  asks for a triage; route labels are written by the pack and request nothing.
- Whose review verdicts the merge queue trusts. The account from step 2 authors the
  pack's review comments, so it must be on the list, or its verdicts are ignored and
  nothing merges. Intake also treats the issues that account files as outside items
  unless it is listed.

Committing the file to the default branch is a write to the repository: ask first.
Then create it and get it onto the default branch on the remote:

```bash
mkdir -p .archon/sdlc/policy
echo '["alice", "bob"]' > .archon/sdlc/policy/maintainers.json
git add .archon/sdlc/policy/maintainers.json
git commit -m "Name the SDLC pack's maintainers"
git push origin HEAD:<default-branch>
```

The file must reach the default branch on the remote, by a direct push as above or by a
merged pull request, whichever the repository allows. Run the check above again after
it lands.

### 5. Labels

Nothing to set up. The pack creates its own `archon-*` labels in the repository the
first time it writes one, and adds and removes them as a delta, so labels others add
survive.

### 6. Choose the pack settings

A project sets the pack's settings in `.archon/packs/sdlc.yaml`, under `settings:`,
committed so isolated runs see it:

```yaml
settings:
  ci: none
```

**Ask the user** about `ci`: what the merge gate trusts at a pull request's head
besides a Ready review verdict.

- `forge` (the default, with no file): green checks on the forge at the head. Any CI
  provider that reports checks or commit statuses to the forge counts. A repository
  with no checks never merges.
- `none`: for a project with no CI. Delivery's CI agent runs the project's full
  validation itself and records the commit it ran on and whether it passed. The gate
  requires a passing validation at exactly the head it merges. This trusts the agent's
  report of the run, which is weaker than CI.

Check: `.pack/pack.yaml` lists every setting under `inputs:` with its values. A value
it does not declare is refused when a run starts.

### 7. Adjust policy (optional)

The queues decide clear cases on their own and ask about unclear ones. The defaults
are the documents in [`.shared/policy/`](.shared/policy). To change one, put only the
lines to add or override in `.archon/sdlc/policy/<same file name>` in the project. The
project's lines win where the two conflict. **Ask the user** before changing what the
pack may merge or close on its own.

### 8. Run each queue once by hand

Every command here starts a run that writes to the tracker, so ask before each. Run
them from the clone. Replace `42` with an issue a maintainer wrote; its body should
state the problem, why it matters, the desired outcome, the invariants and acceptance.

Start each run with `--detach`, which returns at once and prints the run's id, then
wait for it:

```bash
archon workflow run archon-intake --input number=42 --detach
archon workflow wait <run-id> --json
```

`workflow wait` blocks until the run ends or needs an answer (step 9). If the shell
that called it times out, run it again; never stop a run because a wait was cut short.
Roughly, intake takes about 2 minutes, a build round 15 to 40 minutes, and a merge
sweep about 2 minutes. These are typical times, not limits.

```bash
archon state get work/42
```

Intake labels the issue with its route and records its work item. The work item is
where each stage's outcome is read: `value.stage` is intake's route (`deliver`, `plan`,
`investigate`, or a stage that waits, such as `needs_maintainer`, `needs_contract` or
`blocked`), `value.facts.build.status` is the build queue's (`next`, `asking`, `ready`
or `parked`), and `value.facts.merge.status` is the merge queue's (`waiting`, `asking`,
`merged`, `returned` or `parked`). `archon workflow get <run-id>` shows the run itself:
its status and its artifacts, not the stage's decision.

```bash
archon workflow run archon-build-queue --input number=42 --detach
archon workflow wait <run-id> --json
archon state get work/42
```

The build queue works the issue toward a reviewed pull request, one round per run.

```bash
archon workflow run archon-merge-queue --detach
archon workflow run archon-discoveries --detach
```

The merge queue merges what the build queue finished and the gate allows. The
discoveries drain files, tracks or drops what runs noticed outside their task. After a
merge, the clone's default branch is behind the remote: `git pull` brings the merged
work.

The queues work on the repository the clone's `origin` (or its only remote) names. When
`origin` is a fork, add `--input repo_host=<host> --input repo_path=<owner>/<repo>`.

The stages also run alone, without the queues: `archon-ship` takes an issue or request
to a reviewed pull request, and `archon-triage`, `archon-plan`, `archon-deliver` and
`archon-review` each do one stage. A stage never pauses; it ends with its outcome. To
take one that ended not ready further, start it again in the same worktree with the
item and your note:

```bash
archon workflow run archon-deliver --adopt <run-id> "#42: the flaky test is out of scope; skip it"
```

### 9. Answer what the pack asks

```bash
archon workflow attention
archon workflow respond <run-id> <choice> "why"
```

Each item says what is being decided, the agent's recommendation and its evidence, the
choices and what each does. The reason matters: a build or merge answer is written into
the issue body as a dated "Current scope" section, and later rounds work from it. An
agent answers an item only when the user's stated direction decides it, and otherwise
brings it to the user.

### 10. Let it run on its own

The pack installs no binding and starts nothing by itself. It declares the bindings it
recommends under `bindings:` in `.pack/pack.yaml`:

- `intake-issues` and `intake-labels` start intake on GitHub issue and label events.
- `build-queue`, `split-queue`, `merge-queue` and `discoveries` start the queues on a
  schedule. Intake also starts the build queue for an item it routed, by firing the
  `build-queue` file. The merge queue's schedule is short, and a sweep where nothing
  changed runs no agent.
- `metrics-prs` and `metrics-test-value` refresh the pack's metrics.
- `worktree-cleanup` removes merged worktrees, for an install that runs no server.

**Ask the user** which to enable. Then write them as files:

```bash
archon trigger whoami
archon pack bindings sdlc \
  --repo github.com/acme/widgets \
  --host build-host-1 \
  --run-as <the id whoami printed> \
  --cwd /path/to/the/clone \
  --out /path/for/binding/files \
  --only build-queue,merge-queue,discoveries
```

`--host` is the id of the execution host that starts the runs: a name you choose for
this install, which `archon trigger fire` then serves. Use the one this install already
uses, the `hostId` in a binding file written earlier or the server's
`ARCHON_TRIGGER_HOST`; no command reports it. `--out` has no default: give it a
directory outside the checkout, such as `~/.archon/bindings`, so the binding files do
not show up as changes in it. `--cwd` is the checkout the runs launch in; point
it at one that tracks the default branch. The command writes one file per binding and
prints what registers each. It registers and schedules nothing, and refuses to replace
a file unless `--force`. A binding whose input names another binding's file needs that
binding in `--only` too, or its file already in `--out`.

Registering a file starts runs, so ask first:

- **A schedule binding** is a whole file. Fire it once, check the run, then schedule
  it:

  ```bash
  archon trigger fire --config <file>
  archon workflow runs
  archon trigger schedule install --config <file>   # macOS
  ```

  On Linux or Windows, run the same `trigger fire` command from cron, systemd or Task
  Scheduler. If a queue is already scheduled another way, remove that schedule first.
- **An event binding** is one entry for the GitHub source plugin's `bindings` array on
  a running server with a webhook. See
  [Configure GitHub event starts](https://archon.diy/guides/workflow-triggers/#configure-github-event-starts).
  Until then, run intake by hand for each new issue.

Later changes:

- A generated file is the user's from then on. Write it again with `--force` after the
  pack's declaration changes.
- An installed schedule keeps the interval it was installed with. To change it, run
  `archon trigger schedule remove --config <file>` and install it again.
- A resource keeps the capacity its first start declared; a start declaring another is
  rejected as `resource_capacity_conflict`. To change a capacity, give the resource a
  new name in every binding that shares it.
- To stop, remove the schedules and the webhook bindings, then
  `archon workflow status` and `archon workflow cancel <run-id>` for runs in flight.

### 11. Verify the setup

The setup is complete when all of these hold:

```bash
archon workflow run archon-forge-check                                    # passes
git show origin/<default-branch>:.archon/sdlc/policy/maintainers.json    # lists the pack's account
archon state get work/42                                                  # the item from step 8
archon workflow attention                                                 # lists what waits for the user
archon trigger list                                                       # a receipt per binding fired
```

The last line applies only when step 10 enabled a binding.

## Author conventions

Conventions for changing this pack. Project-wide judgment lives in
[`AGENTS.md`](../../../AGENTS.md); the YAML surface is governed by
[`.archon/workflow-language-constitution.md`](../../workflow-language-constitution.md).
How we decide what a workflow should be, agents first, is in
[`CONSTITUTION.md`](CONSTITUTION.md). When a change alters what the setup guide above
or a docs page says, update it in the same change.

### Guards

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

#### Why this rule exists

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

### Public writes belong to a script

An agent judges and authors; one script node owns each public write and proves it
landed. The node acts on the values the agent before it declared in its typed output,
which the engine certified, writes through the forge, and fails unless the result reads
back. So "the write failed" and "the write may have landed" stay different outcomes, in
the pack as in the forge contract. A new public write gets a script node of its own, or
joins the one that already owns that surface; it does not go into a prompt.

Every forge read and write goes through `archon forge`: `forge()` of the engine's
`archon:script` module is the client, [`.shared/pr.ts`](.shared/pr.ts)
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

### Deterministic scripts

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

- **Read every binding as a literal `input('<name>')`** from `archon:script`, in the
  node's own script. The engine scans each script's own source at load and refuses a
  workflow whose script reads a binding no `with:` clause provides. It matches that
  literal form (and `process.env.INPUTS_<NAME>`) only, and it never follows imports,
  so a helper that built the name would hide every read in the pack from that check,
  and a renamed binding would surface as a wrong result at the end of a paid run
  instead of a refusal before it started. Pass the value to a helper, never the name.
- **Never call `process.exit()`.** Bun leaves without draining stdout: a 500 KB
  write to a pipe arrives as 131072 bytes, silently. Call `refuse()` from
  `archon:script`, which sets `process.exitCode`, and return.
- **Nothing the target project provides is available.** No `package.json`, no
  `node_modules`, no `tsconfig.json`, no npm dependency. Relative imports within
  the pack and the standard library are the whole surface, which is what keeps
  these workflows runnable against a project in any language.

A vocabulary a node declares in YAML has exactly one owner, its `output_format`. A
script that consumes another node's certified value does not restate the list.

### Evidence never carries credentials

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

### The engineering-conventions sidecar

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
merge queue's sweep names `merge.md`, which pull requests merge on their own. Every
agent that can raise an attention item names `attention.md`, what a person needs to
decide without opening the run. Review's lenses and the simplify pass name
`review-lens.md`, how a lens stays read-only and records findings and discoveries.
Review's code and ux lenses name `ui-check.md`, how they start the project's app to use a
user-facing change in a browser through the playwright-cli skill, which their prompts
names rather than a `skills:` entry for the reason the build queue's route does.
Agents interpret
them; anything that must be exact, such as label names, stays in code or typed configuration.

A node's prompt names the defaults as `$PACK_DIR/.shared/policy/`: the engine's
`$PACK_DIR` is this pack's directory in the run's captured source, the same from a
binary's embedded bundle as from a source checkout. The agent reads the default and
the project's file, and no script opens either. The default is a file rather than text in the prompt, so a node
whose decision names no policy carries none of it.

### A stage never pauses for a person

Each stage a person runs is one workflow, and a workflow that composes a stage includes
that same file. A stage ends with its typed outcome as the run's result: whether it got
there, and the report says why not. A stage that fails fails the run at the failed
node. The composer owns what follows a stage's ending and asks through its own
attention item when it needs a person, as the build queue does. A workflow that
includes `archon-deliver` keeps running after a failed delivery, because the report
node completes either way, so it gates what follows on `$deliver.output.ready`.

### A node's streams are the operator's channel

Retention is not the only reader. Anything a node writes to stderr is sent to the
operator as the run happens, even when the node succeeds, and that copy is not
redacted. So a node speaks for itself: capture what the commands inside it print,
and let only your own authored messages reach the streams. Re-emit a command's
output when it failed and its words are the diagnostic; drop it when it is just a
tool narrating itself. Capture a value's stderr separately rather than merging it,
too: a `gh` update notice merged into a read becomes the value.
