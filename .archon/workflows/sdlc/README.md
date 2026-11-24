# SDLC pack

This pack turns a labelled issue into a merged pull request. Each stage is one workflow
that works on the issue's item, `issue-<number>`, ends with an outcome, and leaves a
question on the item when a decision belongs to an operator. The engine starts the next
stage through the pack's bindings. The pack keeps no record of its own: what happened to
an issue is its item's runs, outcomes, asks and answers, which
`archon workflow runs --item issue-<n>` reads.

It is also the reference for building a pack of your own on Archon. Its prompts carry the
judgment; its YAML only wires the stages; it has no scripts and no tests.

An **operator** is whoever runs the pack: a person, or more often that person's agent.

## The stages

| Workflow | What it does | What starts it | What it ends with |
|---|---|---|---|
| `archon-triage` | Grounds the issue against the code and its tracker history, judges whether a run can start from it, and routes it. Posts questions for the author, what a blocked issue waits on, or the close of a duplicate or delivered issue; adds area labels. | A maintainer adds the label `archon-triage`; its own answers | `investigate`, `plan`, `build`, `split`; `questions`, `blocked`, `close`, `not_triaged` (start nothing); `ask` |
| `archon-link` | Decides whether the issue can be built now: checks what it would wait on, records its `depends_on`, `part_of` and `duplicate_of` links itself, and places it, holds it, or asks. | Triage `plan` or `build`; an item it waits on lands, closes, splits or is refuted; its own answers | `plan`, `build`; `waiting`, `fold`, `dropped`, `none` (start nothing); asks with `wait`, `start-anyway`, `drop`, `keep-this`, `keep-other` |
| `archon-investigate` | Proves the causal chain from symptom to root cause and decides the fix. | Triage `investigate`; its own answers | `rooted` (build); `refuted`, `inconclusive` (start nothing); `ask` |
| `archon-split` | Decides whether a large issue is built whole or as pieces, files the next piece as its own issue (once, by a marker), links it `part_of` the item and puts it in triage. | Triage `split`; its own answers | `split` (the pieces come back through triage); `plan`, `build` (built whole); `ask` |
| `archon-plan` | Chooses the approach, breaks it into verifiable steps and names the validation. | Link or split `plan`; build or review `replan`; a `replan` answer; its own answers | `planned` (build); `ask` |
| `archon-build` | Builds the change, commits, pushes and opens a draft pull request; when the change comes back, continues it in the same session on the same branch. | Plan `planned`, investigate `rooted`, link or split `build`; a return from review, host or land; a `send-back` or `one-more-round` answer; its own answers | `built` (review); `replan`; `ask` |
| `archon-review` | Seven lenses (scope, seams, code, tests, errors, docs, ux) and a simplify pass beside them, three verifiers on the blocking findings, and one verdict; a smaller shape simplify names goes back to the builder; posts the report on the pull request. Also reviews any pull request by hand. | Build `built` | `approve` (host); `return` (build); `replan`; `ask`. By hand: `ready`, `not_ready` |
| `archon-host` | Answers the review threads the builder settled, updates the description, checks the merge with the base, reads CI once and takes the pull request out of draft. | Review `approve`; a `take-as-is` answer on a review ask | `ready` (land); `return` (build); `ask` |
| `archon-land` | Judges the pull request against the project's land policy, merges it pinned to the head whose checks it read, and the forge records the merge on the item. | Host `ready`; a `take-as-is` answer on a host ask; a `land` answer | `merged` (discoveries); `return` (build); `ask` |
| `archon-discoveries` | Verifies what the item's runs noticed outside their change, and files, tracks, drops or holds each one. Files at most three issues a pass and labels none. | Land `merged`; its own answers | `decided`; `ask` |

### How the bindings chain them

`.pack/pack.yaml` declares every hand-off under `bindings:`. Four kinds do all the work:

- **A label binding** starts triage when a maintainer adds `archon-triage` to an issue.
  Only someone with triage rights on the repository can add a label, so an issue
  nobody labelled reaches no agent. This is the only intake.
- **Run-ended bindings** start the next stage when a run on the item completes with an
  outcome: `plan-after-link` starts `archon-plan` when link ends `plan`. From build
  on, each stage starts in the checkout the stage before it left (`checkout: ended-run`),
  so the change stays on one branch.
- **Asks-settled bindings** start a stage when the asks a run left are answered. A
  stage's own asks start that stage again with the answers as decisions made
  (`plan-after-answers`). The asks of review, host and land offer fixed option ids, and
  the option chosen picks the stage: `send-back` the builder, `take-as-is` the next
  stage, `replan` planning, `land` the land stage again, `one-more-round` the builder
  once past its limit; `stop` starts nothing.

- **Linked bindings** start link again on every item that holds a `depends_on` link to an
  item that just landed or ended without landing, so an item that waits goes on by itself.

Every binding passes `answers: { item: answers }`, so each stage reads every decision
an operator made on the item so far. A stage reads what an earlier stage returned with a
`result_of` input (`plan: { result_of: archon-plan }`), so no binding has to carry it.

The builder keeps one session across rounds: its node declares `context: same`, so each
build run on the item continues the session the last one left. A change goes back to its
builder at most three times per way back (from review, host and land) until the item is
planned again. The bindings declare that as `limit: { starts: 3, reset_on: archon-plan }`;
the stage that would send it back past the limit reads where the limit stands and asks
instead ([`rounds.md`](.shared/policy/rounds.md)).

An outcome that ends the item on purpose, such as a closed issue or a waiting one, is listed
in the stage's `returns.final`. Any other outcome that starts nothing and leaves no ask
stops the item: `archon workflow attention` lists it as `stopped`, with the stage's
`returns.summary` as the reason. Triage's `not_triaged` and investigate's `inconclusive`
are such stops on purpose: an operator decides what follows.

`archon pack graph sdlc` draws the stages and the arrows between them for a project.

Every binding holds a resource named `sdlc-<stage>` (`sdlc-build`, `sdlc-land`): its capacity is how many runs of that stage move at once, and `concurrency.resources` in `~/.archon/config.yaml`, keyed by the full resource name the generated binding file holds, overrides it. `sdlc-land` has one slot, so changes land one at a time.

## Set it up

Follow the steps in order, from a clone of the repository the pack works on. If you are
an agent doing this for someone: ask before anything that writes to the tracker or the
repository, starts a run, or registers a binding.

### 1. Check Archon and the forge

```bash
archon doctor
archon validate workflows
archon plugin list
```

`validate workflows` lists every `archon-*` workflow as `ok`. The list of plugins must
show a forge plugin for the repository's host; for github.com,
`archon plugin add <the Archon repository>/plugins/forge-github` (see `archon plugin --help`). The pack acts as the account its
credential resolves to (on GitHub: `GH_TOKEN`, then `GITHUB_TOKEN`, then the `gh` login).

The engine checks the operations `.pack/pack.yaml` lists under `forge:` each time a run
of the pack starts. To check them first:

```bash
archon forge check --json --data '{"repo":{"host":"github.com","path":"<owner>/<name>"},"operations":["pr.view","pr.create","pr.merge","workitem.label.added"]}'
```

Pass the whole list from `.pack/pack.yaml`, plus `workitem.label.added`, which the label
binding reads when no webhook delivers labels.

### 2. Settings and policy

The pack has one setting, in `.archon/packs/sdlc.yaml`:

```yaml
settings:
  ci: forge   # forge: the pull request's checks are the full validation; none: no CI
```

Everything else a project holds an opinion on is policy text. Each stage reads the
pack's default in [`.shared/policy/`](.shared/policy) and then the project's
`.archon/sdlc/policy/<topic>.md`, which adds to it and wins where they conflict:

| Policy | Read by | Says |
|---|---|---|
| `triage.md` | triage, split | when an item is ready, how it is routed, when and how it splits, when it may close |
| `build.md` | build | when the builder acts and when it asks |
| `propose.md` | build, host | how a pull request is written |
| `review-lens.md` | review lenses | how a lens works and reports, and which risks earn full review |
| `merge.md` | land | which pull requests merge by themselves and which are asked, and how they merge |
| `discoveries.md` | discoveries | what is filed, tracked, dropped or held |
| `rulings.md` | plan, review, discoveries | answers the maintainers already gave |
| `asks.md` | every stage | how a question to an operator is written |
| `rounds.md` | review, host, land | how a change's round limit is read |
| `ui-check.md` | the ux lens | how the project's app is started safely |

The default land policy merges clear changes without asking. A project that wants every
merge asked says so in its `merge.md`; this repository's does.

### 3. Models

Every agent step names an alias that falls back to a tier (`small`, `medium`, `large`):
`@triage`, `@link`, `@investigator`, `@split`, `@planner`, `@implementer`, `@reviewer` and the
lens aliases `@review-<lens>` (`@review-simplify` among them) and `@review-route`, `@settle-threads`, `@update-pr-body`,
`@ci`, `@merge`, `@discoveries`. Nothing needs setting for a first run.

```bash
archon ai tier list
archon ai alias set @planner claude opus --effort high
```

A builder session is continued only on the model it started on: set models before an
item starts, not between its rounds.

### 4. Run one issue by hand

Every stage runs by hand on an item. Start triage on an issue and follow it:

```bash
archon workflow run archon-triage --item issue-<n> --input issue=<n>
archon workflow runs --item issue-<n>
```

Without bindings, start each next stage the same way, with `--input issue=<n>`. A
stage that continues the change runs on its branch: start it with `--branch <head-branch>`
(or `--adopt <run-id>`), as the stage's description says. A review by hand of any pull
request runs on the pull request's own item:

```bash
archon workflow run archon-review --item pr-<n> --input pr=<n> --branch <head-branch>
```

Answer what a stage asks:

```bash
archon workflow attention
archon workflow answer --ref ask:<id> --choose <option>
```

### 5. Install the bindings

```bash
archon trigger whoami                       # the run-as user id
archon pack bindings sdlc --repo github.com/<owner>/<name> --host <host-id> \
  --run-as <user-id> --out ./sdlc-bindings
```

It writes one file per binding, outcome and option, and prints what to do with each:
`archon trigger add <file>` for every run-ended and asks-settled file, and the label
binding's object into the `bindings` of the GitHub source plugin's config in the file
`ARCHON_WEBHOOK_SOURCES` names. Then:

```bash
archon trigger check
```

reports no problems when every file matches the workflows. An install that receives no
webhooks reads labels by observing: give the source `"observe": { "everySeconds": 60 }`
and run `archon workflow wake schedule install`, which keeps `workflow wake --watch`
running ([workflow triggers](https://archon.diy/guides/workflow-triggers/#label-an-issue-or-pull-request-without-a-webhook)).
A label already on an issue when the binding is first seen starts nothing; add it again.

To see an item's progress on the issue itself, turn on the item tracker in
`~/.archon/config.yaml` (`itemTracker`): the engine keeps a status comment on the issue
and posts each ask and the result.

## Build your own

The pack is a pattern, not a framework. To build a pack of your own:

1. **One workflow per stage.** A stage is one job an agent can do in one run, with a
   prompt that says what good looks like. Give it `mutates_checkout: false` when it only
   judges.
2. **End with a named outcome.** `returns: { node: <id>, outcome: outcome, asks: asks }`
   on the node whose output decides. The outcome is what a binding starts the next stage
   on; the asks are what an operator decides. List the outcomes that end the item on
   purpose in `final:`, and name a one-line reason in `summary:`. A stage never pauses mid-run.
3. **Read, don't carry.** Declare `result_of: <stage>` inputs for what an earlier stage
   returned, and pass `answers: { item: answers }` on every binding.
4. **Wire it in `.pack/pack.yaml`.** A `run_ended:` binding per hand-off, an
   `asks_settled:` binding per answer, `checkout: ended-run` where the next stage
   continues the same change, and a `limit:` on every way back.
5. **Put opinions in policy text**, read from `$PACK_DIR/.shared/policy/` and the
   project's override, and typed values only where a value must be exact.
6. **Write a script only where an agent cannot do the job**: a plain fact read at a
   boundary, or a write that must come from the forge's own record. This pack has none:
   a merge an agent makes through the forge records itself on the item.

7. **Keep your names your own.** Another pack may run on the same install. A run-ended
   binding matches the ended run's workflow name alone, so a stage named `plan` in two
   packs would start each other's next stages: prefix your workflow names, as this pack
   does with `archon-`. Name your resources after your pack too (`sdlc-plan`), so two
   packs never share a stage's slots.

How the pack is written, and why, is in [`CONSTITUTION.md`](CONSTITUTION.md).
