---
title: The Essential Workflows
description: A catalog of the workflows bundled with Archon, with usage examples and guidance on when to use each one.
category: book
part: core-workflows
audience: [user]
sidebar:
  order: 4
---

You now know how Archon works. The question becomes: which workflow do I reach for?

Archon bundles one workflow pack, `sdlc`, that covers the software development lifecycle from an incoming issue to a reviewed pull request. This chapter maps your intent to the right workflow and gives you enough detail to use each one confidently.

---

## Which Workflow Should I Use?

```
What do you want to do?
│
├── Ask a question or explore the codebase
│   └── No workflow: ask in chat and the router answers directly
│
├── Take an issue or request all the way to a reviewed PR
│   └── archon-ship
│
├── Work one stage at a time
│   ├── Decide what an issue needs next          →  archon-triage
│   ├── Find the root cause of a bug             →  archon-investigate
│   ├── Turn decided intent into a plan          →  archon-plan
│   ├── Build decided work (commits, no PR)      →  archon-implement
│   ├── Open a PR for committed work             →  archon-pr
│   └── Take a plan to a ready-to-merge PR       →  archon-deliver
│
├── Review or validate a change
│   ├── Review a PR or the working diff          →  archon-review
│   └── Run the project's own checks             →  archon-validate
│
└── Update one dependency
    └── archon-upkeep
```

---

## Workflow Catalog

### End to end

#### `archon-ship`

Grounds an issue or request against the current repository before spending on it, then takes the least speculative path: investigate an unknown cause, plan an undecided shape, deliver an implementation-ready work order, continue an open PR that already carries the outcome, or stop when no work remains. Every actionable path ends in the same reviewed delivery tail as `archon-deliver`.

**When to use it**: A GitHub issue or request should go from a current-truth check to a reviewed PR. This is your default for bugs, features, and enhancements.

```bash
archon workflow run archon-ship --branch fix/login-crash "#142"
```

**What it produces**: A PR marked ready for review once review findings are closed and CI is green, or an explained stop with the PR left in draft. The stop says whether no work is owed (the outcome already holds, or an investigation found the cause outside this repository) or the requested work was not done and why. The workflow never merges; merging stays with you.

**Delivering one part of a multi-part plan**: When an approved plan splits the work into several PRs, tell the run which part it delivers and which contract items each part owns, quoting each item as the contract states it:

```bash
archon workflow run archon-ship --branch feat/export-csv-api \
  --input part='{"delivers":1,"parts":[{"part":1,"items":["The API returns CSV."]},{"part":2,"items":["The console offers a CSV download.","Users can export their data as CSV."]}]}' \
  "#142"
```

The review then treats an item that only later parts list as deferred: it is neither a blocking finding nor a discovery, and the PR says `Refs #N` instead of closing the issue. The required outcome is an item like any other, so list it under the part that completes it, as the example does with "Users can export their data as CSV." An item the input lists under no part is still reviewed as part of this PR, and the review still reports a change that contradicts a later part. The run never works out part ownership from the plan's prose; without this input, the PR is reviewed against the whole contract.

---

### One stage at a time

#### `archon-triage`

Reconciles an issue, plan, or request with the current code, tracker history, and stated direction, judges whether it is a contract a run can start from, then routes it to investigate, plan, deliver, or no action.

**When to use it**: An item may be stale or may prescribe an unverified solution, and you want to know what it needs next before paying for the work.

```bash
archon workflow run archon-triage "#142"
```

**What it produces**: A verdict with the recommended next step. It leaves the checkout unchanged. Pass `--input publish=true` to write the derived labels to the issue.

---

#### `archon-intake`

The standing front of the pack, started by trigger bindings on issue and label events rather than by hand. A script checks whether the issue's author is on the project's maintainer list (`.archon/sdlc/policy/maintainers.json`) before any model reads the text. A maintainer's issue is triaged and gets a route label; an outside issue gets `archon-needs-maintainer` and starts no agent until a listed maintainer adds `archon-triage` or a route label. With `mode: eval` it writes nothing and returns what it would decide for the issue as it was opened, which is how to try it on real issues.

**When to use it**: You want new issues triaged as they arrive without letting anyone who can open an issue spend tokens. The pack installs no binding; the SDLC pack README's "Intake" section shows the two bindings to add.

**What it produces**: A work item per issue (`archon state get work/<number>`) holding its trust, stage, triage fields, and history, and the labels that mirror it.

---

#### `archon-build-queue`

The stage after intake, started by a schedule binding. Each run claims one triaged item, launches `archon-ship` on it from a brief, and reads how the run ended. A clear case acts on its own: the item is done when its pull request is reviewed Ready at its head, and a correctable finding or a stop the issue already answers continues it in the next run. An unclear one, or several rounds that each find new defects, pauses as one attention item with the agent's recommendation and declared choices; the answer is written into the issue body as a dated "Current scope" section. With `mode: eval` it launches and writes nothing and replays a recorded run's ending.

**When to use it**: You want triaged issues worked to reviewed pull requests without answering every routine stop yourself. The pack installs no binding; the SDLC pack README's "Build queue" section shows the one to add.

**What it produces**: Pull requests from `archon-ship`, the queue's record on each work item (`facts.build`: status, rounds and decisions), and attention items for the decisions that need a person.

---

#### `archon-merge-queue`

The stage after the build queue, started by a schedule binding. Each run claims the items whose pull requests the build queue made ready, and one agent sweeps them: it orders them, merges the base branch into any behind it, sends a pull request whose review a push made stale to a delta review, hands back what the build queue can fix, and merges what policy allows one at a time. Every merge goes through a gate script that refuses unless the review verdict says Ready at the head, CI is green there, no review thread is unresolved and the head contains the base branch, and merges pinned to that head. After a batch it checks the base branch's CI. An unclear pull request, such as a schema or workflow-language change, or a red base branch pauses as one attention item with the agent's recommendation and declared choices. With `mode: eval` it merges and writes nothing and replays recorded merge decisions.

**When to use it**: You want reviewed, green pull requests merged without merging each by hand, while changes that need a person still wait for one. The pack installs no binding; the SDLC pack README's "Merge queue" section shows the one to add.

**What it produces**: Merged pull requests, the queue's record on each work item (`facts.merge`: status and decisions), and attention items for the decisions that need a person.

---

#### `archon-discoveries`

Drains the discoveries finished runs recorded outside their own scope. One agent verifies each one against the default branch, merges duplicates across runs and with earlier decisions, and decides: file an issue with a full brief, track it on the open issue that already covers it, drop it with a reason, or ask a maintainer. Scripts perform only the writes it declared. With `mode: eval` it writes nothing and returns every decision.

**When to use it**: Runs keep finding defects outside their change and nobody reads their `discoveries.md`. Start it by hand, or add the schedule binding the SDLC pack README's "Discoveries" section shows; the pack installs none.

**What it produces**: Filed issues and evidence comments, and one decision record per discovery (`archon state list --prefix discoveries/decisions/`), so a discovery is decided once and a maintainer's answer is remembered.

---

#### `archon-investigate`

Establishes the proven causal chain for a bug, unexplained behavior, or open question, down to the root cause whose fix prevents the symptom.

**When to use it**: The cause is not yet known and you want it proven before anyone writes a fix.

```bash
archon workflow run archon-investigate "Why does the workflow list spin forever when no workflows exist?"
```

**What it produces**: An evidence-backed report a fixer or planner can act on, with a verdict: `rooted` (a change is owed here and the fix is decided), `refuted` (no change is owed in this repository), or `inconclusive` (the cause is not established yet). The repository is left as it was found.

---

#### `archon-plan`

Turns decided intent, such as a feature request, an investigation report, or an idea, into an implementable plan: the chosen approach with rejected alternatives, verifiable steps, and the validation that proves it.

**When to use it**: You know what to build but not how.

```bash
archon workflow run archon-plan "Add CSV export to the reports page"
```

**What it produces**: A plan artifact. Pass `--input report=<path>` to build on a prior investigation report. The repository is left as it was found. Before it stops on a question for a person, it checks whether the work order, the issue's comments, a project document, or a ruling your maintainers recorded in `.archon/sdlc/policy/rulings.md` already answers it; review synthesis does the same before it returns `replan` or `needs_human`. An addition that leaves every existing value meaning what it meant before is the plan's call, not a person's: the plan lists it under contract additions and the pull request body flags it for the reviewer. Changing what an existing value means, removing something shipped, or changing a persisted shape still stops for a person. The SDLC pack README's sidecar section describes the rulings document.

---

#### `archon-implement`

Implements a change and keeps working until it is complete and the project's own checks pass. It commits as it goes and opens no PR.

**When to use it**: The work is decided and needs building: a plan, review findings, a CI failure, or a plain description.

```bash
archon workflow run archon-implement --branch feat/export-csv "Implement the plan in .archon/plans/csv-export.md"
```

**What it produces**: Commits on the run's branch.

---

#### `archon-pr`

Opens a pull request for the committed work on the current branch. It neither merges the base nor runs checks: CI judges the pushed head. It uses the repository's PR template when one exists, pushes the branch, and reads the created PR back to verify it. It references a linked issue with `Refs #N`, never a closing keyword, because no review has judged the work yet.

**When to use it**: A branch has committed work and needs a PR. Run it with `--no-worktree` from the checkout that holds the branch.

```bash
archon workflow run archon-pr --no-worktree --input draft=false
```

**What it produces**: A pull request, draft unless you pass `--input draft=false`. It never sweeps in unrelated changes, never rebases, and never force-pushes.

---

#### `archon-deliver`

The delivery tail, in capped rounds: implement the work with focused checks on what it changes, push and open (or update) a draft PR, and review it. Once a round's review passes, a structure pass looks for a smaller shape once and the implementer adopts or declines its findings; then an agent marks the PR ready, waits for CI (the full validation) however long it takes, and puts it back in draft if CI is red. A flake or infrastructure failure outside the change gets one re-run of its failed jobs first, and a green re-run delivers. Review findings, CI red the change caused, and a conflict with the base go back to the implementer for another round (it merges the base on a conflict, never rebasing), up to three rounds. Each correction is reviewed on its delta, leaving out code a merge of the base brought in: after review findings, by the general code reviewer plus every lens with a finding still open or whose area the delta touches; after a CI fix, by the general code reviewer alone. Any other ending is not ready, with its reason; a red PR never stays ready. Finally it updates the PR description and relays any discoveries. The description closes its issue (`Closes #N`) only when the last review's contract coverage marks the required outcome and every acceptance item met; otherwise it says `Refs #N` and lists what is left, and so does the run's outcome. `--input pull_request=<number>` continues that open PR instead of opening one. `--input part=<json>` delivers one part of a multi-part plan, as described for `archon-ship`. The run never pauses for approval; your gate is PR review and merge.

**When to use it**: The work is decided, for example an approved plan, and should become a reviewed, ready-to-merge PR.

```bash
archon workflow run archon-deliver --branch feat/export-csv "Deliver the plan in .archon/plans/csv-export.md"
```

**What it produces**: A PR marked ready for review, with one canonical review comment.

---

### Review and validation

#### `archon-review`

Reviews a change through specialist lenses and produces one evidence-based verdict. On every round but a light one, a quick route agent picks the lenses the change earns: seams (on unless the change touches no type, contract, state or boundary), code (which uses the configured `large` model tier), tests, errors, and docs. `--input errors=true` or `false` overrides its errors call. A continuation (`--input prior_report=<path>`) runs the general code reviewer, plus every lens the route agent selects because a finding it raised is still open or the delta touches its area, on the correction delta only (code a merge of the base brought in is left out), judging whether each prior finding was resolved or validly declined; `--input light=true` runs the general code reviewer alone. The review also holds the change to its stated contract, taken from the PR description or a work order you pass: each stated acceptance item and invariant is met with cited evidence or raised as a blocking finding. `--input part=<json>` reviews one part of a multi-part plan, as described for `archon-ship`.

**When to use it**: A PR or your working diff needs judging. It is read-only and never edits code.

```bash
archon workflow run archon-review --input scope=87 --branch fix/login-redirect
```

Replace `fix/login-redirect` with the PR's head branch for a same-repository PR. `--branch` reuses an existing healthy worktree without advancing it. Before rerunning, locate it with `git worktree list` and check for local changes. Only when clean, run `git -C <worktree-path> pull --ff-only <base-clone-url> <PR-head-ref>` with the PR's actual values. Verify its HEAD equals the current PR head SHA before rerunning. Stop on local changes, divergence or an ahead checkout and reconcile them before retrying. For a fork PR, fetch its head into the launch repository first, then start a fresh review branch at that commit:

```bash
git fetch <fork-clone-url> <PR-head-ref>
archon workflow run archon-review --input scope=<PR-URL> --branch <fresh-review-branch> --from <PR-head-SHA>
```

Use the fork's actual clone URL, head ref and full head SHA, and choose a review branch absent locally, on the configured remote and from existing worktrees. `--from` only applies to a new branch; `--branch` alone cannot resolve a fork-only ref and would create it from the base. If the checkout commit differs from the PR head, the run stops before routing or any review lens and returns the exact rerun command, including the fetch prerequisite for a fork.

**What it produces**: A synthesized review report when the checkout matches the PR head. When reviewing a PR, the report is posted as one comment and edited in place on re-review. Empty `scope` selects the current branch's open PR first, otherwise the working diff.

---

#### `archon-validate`

Discovers and runs the project's own checks, such as types, lint, tests, and build, and reports a structured verdict. It judges nothing and fixes nothing.

**When to use it**: You want to know whether your checkout is green.

```bash
archon workflow run archon-validate --no-worktree
```

**What it produces**: A structured verdict on the project's checks. Pass `--input scope=<package or check>` to narrow the run.

---

### Maintenance

#### `archon-upkeep`

Keeps one dependency current. It grounds the update against the repository (locked version, blast radius, breaking changes that touch real usage), then either stops with the reason or takes the bump through the reviewed delivery tail.

**When to use it**: A dependency update or security advisory should become a reviewed PR. One target per run.

```bash
archon workflow run archon-upkeep "Address the undici advisory"
```

**What it produces**: A PR marked ready for review, or an explained stop when the locked version is already current.

---

## Quick Reference

| Workflow | Use When | Creates PR? | Changes code? |
|----------|----------|-------------|---------------|
| `archon-ship` | Issue or request to reviewed PR | Yes | Yes |
| `archon-triage` | Decide what an item needs next | No | No |
| `archon-intake` | Triage new issues as they arrive (trigger-started) | No | No |
| `archon-build-queue` | Work triaged issues to reviewed PRs (trigger-started) | Yes (through `archon-ship`) | Yes (through `archon-ship`) |
| `archon-merge-queue` | Merge reviewed, green PRs the build queue finished (trigger-started) | No | Yes (merges the base into a conflicting PR) |
| `archon-discoveries` | File, track or drop what finished runs discovered | No | No |
| `archon-investigate` | Root-cause a bug or question | No | No |
| `archon-plan` | Plan decided intent | No | No |
| `archon-implement` | Build decided work | No | Yes (commits) |
| `archon-pr` | Open a PR for committed work | Yes | No |
| `archon-deliver` | Decided work to reviewed PR | Yes | Yes |
| `archon-review` | Review a PR or the working diff | No (comments on a PR) | No |
| `archon-validate` | Run the project's checks | No | No |
| `archon-upkeep` | Update one dependency | Yes | Yes |

---

## Workflows that no longer ship

Archon 0.12.0 stopped bundling the older `archon-*` workflows, such as `archon-fix-github-issue`, `archon-idea-to-pr`, `archon-smart-pr-review`, and `archon-assist`. Most have an `sdlc` replacement: use `archon-ship` for issue fixing and idea-to-PR work, `archon-review` for PR review, `archon-plan` followed by `archon-deliver` for plan-to-PR, and `archon-validate` for running checks. For questions, ask in chat.

To keep using one of the old workflows, copy its YAML from [`.archon/workflows/defaults/` at v0.11.1](https://github.com/coleam00/Archon/tree/v0.11.1/.archon/workflows/defaults) (most are in its `legacy/` folder) into your project's `.archon/workflows/`, and the commands it uses from [`.archon/commands/defaults/` at v0.11.1](https://github.com/coleam00/Archon/tree/v0.11.1/.archon/commands/defaults) into `.archon/commands/`. `archon-idea-to-pr`, `archon-plan-to-pr` and `archon-issue-review-full` also need `archon-review-block.yaml` from the same `legacy/` folder, because they include it.

---

## Discovering More Workflows

To see all workflows available in your current directory:

```bash
archon workflow list
```

The list shows both Archon's bundled workflows and any custom workflows in your repo's `.archon/workflows/` directory. Custom workflows override bundled ones by name: if you create a workflow named `archon-review`, it replaces the bundled one.

Ready to build your own? In [Chapter 7: Creating Your First Workflow →](/book/first-workflow/), you'll build one from scratch, incrementally, version by version, until you have a plan, implement, and review pipeline of your own.

But first, let's cover the isolation system that makes parallel workflows safe. Continue to [Chapter 5: Isolation and Worktrees →](/book/isolation/)
