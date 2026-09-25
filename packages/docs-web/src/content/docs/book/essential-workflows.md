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

Grounds an issue or request against the current repository before spending on it, then takes the least speculative path: investigate an unknown cause, plan an undecided shape, deliver an implementation-ready work order, or stop when no work remains. Every actionable path ends in the same reviewed delivery tail as `archon-deliver`.

**When to use it**: A GitHub issue or request should go from a current-truth check to a reviewed PR. This is your default for bugs, features, and enhancements.

```bash
archon workflow run archon-ship --branch fix/login-crash "#142"
```

**What it produces**: A PR flipped ready for review once review findings are closed and checks pass, or an explained stop when triage finds no work is owed. The workflow never merges; merging stays with you.

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

#### `archon-investigate`

Establishes the proven causal chain for a bug, unexplained behavior, or open question, down to the root cause whose fix prevents the symptom.

**When to use it**: The cause is not yet known and you want it proven before anyone writes a fix.

```bash
archon workflow run archon-investigate "Why does the workflow list spin forever when no workflows exist?"
```

**What it produces**: An evidence-backed report a fixer or planner can act on. The repository is left as it was found.

---

#### `archon-plan`

Turns decided intent, such as a feature request, an investigation report, or an idea, into an implementable plan: the chosen approach with rejected alternatives, verifiable steps, and the validation that proves it.

**When to use it**: You know what to build but not how.

```bash
archon workflow run archon-plan "Add CSV export to the reports page"
```

**What it produces**: A plan artifact. Pass `--input report=<path>` to build on a prior investigation report. The repository is left as it was found.

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

Opens a pull request for the committed work on the current branch. It uses the repository's PR template when one exists and reads the created PR back to verify it.

**When to use it**: A branch has committed work and needs a PR. Run it with `--no-worktree` from the checkout that holds the branch.

```bash
archon workflow run archon-pr --no-worktree --input draft=false
```

**What it produces**: A pull request, draft unless you pass `--input draft=false`. It never sweeps in unrelated changes and never force-pushes.

---

#### `archon-deliver`

The delivery tail: implement the work, gate on green checks, open a draft PR, review it, correct and close the findings, validate, wait for CI, then flip the PR ready for review. There is no approval gate inside the run; your gate is PR review and merge.

**When to use it**: The work is decided, for example an approved plan, and should become a reviewed, ready-to-merge PR.

```bash
archon workflow run archon-deliver --branch feat/export-csv "Deliver the plan in .archon/plans/csv-export.md"
```

**What it produces**: A PR marked ready for review, with one canonical review comment.

---

### Review and validation

#### `archon-review`

Reviews a change through parallel specialist lenses (code, seams, simplification, and tests always; docs when shipped documentation changes; error handling with `--input errors=true`) and produces one evidence-based verdict. It also holds the change to its stated contract, taken from the PR description or a work order you pass: each stated acceptance item and invariant is met with cited evidence or raised as a blocking finding.

**When to use it**: A PR or your working diff needs judging. It is read-only and never edits code.

```bash
archon workflow run archon-review --input scope=87
```

**What it produces**: A synthesized review report. When reviewing a PR, the report is posted as one comment and edited in place on re-review. Leave `scope` empty to review the current branch's PR or the working diff.

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

To keep using one of the old workflows, copy its YAML from [`.archon/workflows/defaults/` at v0.11.1](https://github.com/coleam00/Archon/tree/v0.11.1/.archon/workflows/defaults) (most are in its `legacy/` folder) into your project's `.archon/workflows/`, and the commands it uses from [`.archon/commands/defaults/` at v0.11.1](https://github.com/coleam00/Archon/tree/v0.11.1/.archon/commands/defaults) into `.archon/commands/`.

---

## Discovering More Workflows

To see all workflows available in your current directory:

```bash
archon workflow list
```

The list shows both Archon's bundled workflows and any custom workflows in your repo's `.archon/workflows/` directory. Custom workflows override bundled ones by name: if you create a workflow named `archon-review`, it replaces the bundled one.

Ready to build your own? In [Chapter 7: Creating Your First Workflow →](/book/first-workflow/), you'll build one from scratch, incrementally, version by version, until you have a plan, implement, and review pipeline of your own.

But first, let's cover the isolation system that makes parallel workflows safe. Continue to [Chapter 5: Isolation and Worktrees →](/book/isolation/)
