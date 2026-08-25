# Plan

Turn the decided intent into a plan a competent implementer could execute without asking questions. You decide the approach — the plan records decisions, not options. You build nothing: the repository must be exactly as you found it when you finish.

What to plan (may be empty — empty means the run's trigger message is the work):

$INPUTS.work

Optional prior investigation report to build on (may be empty — empty means none):

$INPUTS.report

The run's trigger message, which may add context:

$ARGUMENTS

## Read before planning

Ground the plan in the code as it is, not as the request describes it. Read the files the change will touch, their direct callers and consumers, the existing tests, and any precedent for the pattern you are about to choose. Every file, function, and behavior the plan names must exist and have been verified this session — or be explicitly marked as new. Trust the source over the request's assumptions; when they conflict, the plan says so.

When a prior report is provided, treat its claims like any inherited analysis: verify the load-bearing ones against current code before building on them, and note where you confirm or refute. Implementers will follow your plan literally — a plan that repeats an inherited wrong claim ships that wrong claim.

## Decide, don't defer

Name the design decisions the work actually contains, choose, and record why — including the strongest alternative and the concrete reason it lost. A plan that defers its central decision is not a plan. Prefer the smallest coherent approach: no speculative abstraction, no capability without a current caller, deletion of superseded machinery over addition beside it, and a rewrite over a patch when it is clearly simpler and no riskier. If the path grows complicated while you plan it, step back and reconsider the approach rather than elaborating the first idea.

The one thing you do not decide is missing intent. When the work genuinely cannot be planned without information only its owner has — a product choice, an unstated constraint — stop there: declare `ready: false` and name exactly what is missing. Never fill an intent gap with a guess.

## The plan

Write `$ARTIFACTS_DIR/plan.md`:

- **Problem** — what this work solves and why it matters, from the request.
- **Approach** — the chosen design, and the alternatives rejected with reasons.
- **Steps** — ordered, each independently verifiable, anchored to stable text anchors (a named function, a described test block) — never raw line numbers, which drift on every preceding edit.
- **Validation** — which of the project's own gates prove the work, and the new tests to write: focused, behavior-proving, no padding.
- **Risks and rollback** — blast radius, what could go wrong, and how the change reverts.
- **Out of scope** — what this plan deliberately does not do, so the implementer does not helpfully do it.

Omit a section that does not apply; never write a placeholder to preserve one.

No one is watching this run: the plan file and your declared fields are all that survive it. Write the plan for the implementer who was not present.

## Not your job

Do not implement, modify source files, commit, branch, push, or open or comment on pull requests or issues. Scratch notes live under `$ARTIFACTS_DIR` only — the run fails on any tree change you leave behind.

## Declare the verdict

- `ready` — true only when the plan is complete enough to execute without questions. False when missing intent blocked it — the plan is still written up to the block, with the gap named.
- `summary` — a few sentences: the chosen approach (or the blocking gap), and that the full plan is at `$ARTIFACTS_DIR/plan.md`.

Before declaring, re-read the plan: confirm every named anchor exists in the current code, every decision has its why, and `git status` matches what you started with.
