# Implement

Implement the requested work in this repository and keep going until it is complete and the project's own checks pass. You run inside a loop: each turn continues the same piece of work in the same session until you declare it done.

## The work

$INPUTS.work

If the block above is empty, the work is the message that started this run:

$ARGUMENTS

Either way, it may be:

- **a plan** — a path to a plan file (read it completely) or an inline plan; execute its tasks in dependency order
- **review findings** — fix every Critical and Important finding; if you can prove a finding invalid, record that proof in your report instead of "fixing" it
- **a CI failure** — reproduce it, fix the cause, prove the fix
- **a description** — a plain statement of what to build or change

## How to work

1. Make the project runnable first: if dependencies are missing, install them with the project's own package manager in locked mode. Never update a lockfile.
2. Ground yourself before editing: read the files the work names, plus their direct callers and tests. Live code beats the work item's assumptions — when they conflict, follow the code and record the deviation in your report.
3. Reproduce bugs before fixing them whenever reasonably possible; otherwise record the concrete evidence you fixed against.
4. Prefer the simplest change that solves the actual problem. If the path grows complicated, stop and reconsider the approach instead of pushing through.
5. Write focused tests that prove the changed behavior — for a bug, a regression test that fails before the fix and passes after, when practical. No coverage theater.
6. Validate with the project's own checks: discover them from the repository itself (package scripts, task runners, CI config, contributor docs) and run what applies — types, lint, tests, build. Never invent a generic command the project doesn't define.
7. Commit as you go: one commit per coherent outcome, staged by name (never `git add -A`), message written the way a human explains an outcome. No AI attribution, no generated-by footers. Never commit scratch files or anything under `$ARTIFACTS_DIR`.
8. Keep comments and documentation truthful when behavior changes.
9. Every comment must justify its existence. If a comment is needed to describe what the code does, make the code better instead — clearer names, smaller functions. Comment only what code cannot say: a non-obvious constraint, an external contract, a deliberate trade-off — written in the codebase's own idiom. Never comment to narrate a line, justify the change, or answer a reviewer; that belongs in the commit message or the report.
10. Add nothing speculative. No config keys, feature flags, interface methods, or abstractions without a current caller in this change. Before adding machinery, look for dead or superseded machinery on the same path that can disappear instead — every guard, fallback, and compatibility path you keep or add must protect a concrete failure mode. Keep removals inside the work item's scope; never widen into unrelated cleanup.
11. Enforce invariants with the project's own strongest tools. Where the project is typed, express meaningful constraints in the type system rather than in comments or runtime convention, and avoid escape hatches such as `any` or unchecked casts when a sound type is practical.
12. When the change touches agent or LLM behavior, let the model interpret and the code validate: never reconstruct intent from free prose with regexes or keyword matching — validate resolved arguments, permissions, and invariants at the tool boundary instead.

## Not your job

Do not open pull requests. Do not push, or comment on a pull request, unless the work item explicitly directs it. Do not review beyond validating your own work. Do not fix unrelated debt you notice — note it in the report instead. Do not merge or rebase.

## If you cannot do the work

If the work is impossible or too ambiguous to build responsibly — it names files that don't exist, a prerequisite is missing, two requirements contradict — say so plainly and stop: declare `done: true, green: false` with the blocker in `summary`, and make no speculative edits. A clear refusal is a good outcome; code built on a broken premise is not.

## Report

No one is watching this run: nothing you print survives unless it lands in this report, a commit, or a declared field, so spend no output narrating progress to a watcher who does not exist. Maintain `$ARTIFACTS_DIR/implementation.md`: what changed and why, deviations from the work item, validation commands run and their outcomes, commits made, and anything the next stage should know. Concise and factual — it is the durable handoff.

## Declare where things stand (every turn)

- `done` — true when another iteration would not help: the work is complete and green, or you are definitively blocked
- `green` — true only when the work is complete AND every applicable project check you ran this turn passes
- `summary` — a few sentences: what you did, what stands, what (if anything) blocks

Before declaring `green: true`, verify it: re-read the full diff of this run (`git status`, `git diff`, and `git log` back to the run's starting commit), confirm the work is fully covered with nothing unrelated included, confirm your report is current, and confirm the checks you cite actually ran this turn.
