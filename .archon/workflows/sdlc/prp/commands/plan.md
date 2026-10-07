# Plan

You own this delivery from plan to a reviewed pull request with green CI. This conversation continues through implementation and every correction, so the reasoning you do now is what you will build from. Plan only in this turn: do not edit code, commit, or open a pull request.

## The work

$INPUTS.target

## The operator's request

$ARGUMENTS

Both are in force; the request is the operator's own words and wins where they conflict on task, constraints, or scope. Either may be empty. If both are, there is no work: say so and declare `ready: false`.

## Resolve the input

The work may be an issue or tracker reference, a plan (a path to read completely, or inline), a document, or a description.

- For an issue, read its body and the comments, linked issues and pull requests that can still change the outcome, constraints, or an earlier decision. Separate what the issue requires from what it merely suggests. Stop following links once they no longer change what you would do.
- An existing plan is the plan: check it against current code, record any deviation the code forces, and keep its outcome and acceptance.
- Prose is a claim; the code is the fact. Verify anything load-bearing against the current source.

## Gather evidence

Read the repository's agent guidance, and its `engineering.md` and direction document when they exist (at the root or in a config directory such as `.archon/`). They are the standard this change is judged against and they bound what you may propose. Then read the code the work touches: the owners, their callers and consumers, the closest precedent, and the tests. Find the project's authoritative validation commands from its own guidance, package scripts, task runners, and CI configuration.

For broken behavior, establish the cause before designing the fix: reproduce it when practical, or name the concrete evidence that stands in for a reproduction.

## Decide the smallest truthful change

State the invariant every acceptable solution must preserve. Find the existing primitive that comes closest, and prefer configuration, composition, or a small extension over new state, lifecycle, or abstraction. Before adding machinery, look for dead or superseded machinery on the same path that can disappear. If a simpler shape works, plan that one.

Scale the plan to the risk. A one-line fix, a test-only or docs-only change that touches no wire format, persisted state, isolation, or security surface is tiny: a few lines of plan are enough.

## Stop rather than guess

Declare `ready: false` when the outcome cannot be built responsibly from what you can verify: product intent is materially unclear, two requirements contradict, a prerequisite primitive should exist first, or the work is already done. Say exactly what decision or primitive is missing. An honest stop is a good outcome; a plan built on a broken premise is not.

## Write the plan

Write `$ARTIFACTS_DIR/plan.md`, concise and concrete:

- **Outcome:** problem, invariant, and approach, with the source issue when there is one.
- **Evidence:** the decisive `file:line` references and precedents.
- **Tasks:** in dependency order, each with its files, the behavior to add or change, and the focused test that proves it.
- **Acceptance:** the observable completed behavior.
- **Validation:** the project's own commands, in the order you will run them.
- **Not building:** what is deliberately out of scope.

## Declare

- `ready` — true when the plan is ready to implement; false when you stopped (the reason goes in `summary`).
- `summary` — two or three sentences: the outcome and approach, or the exact blocker.
