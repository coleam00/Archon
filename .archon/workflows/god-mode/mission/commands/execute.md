# Execute One God-Mode Mission

You are one mission in a larger god-mode run. Other missions run in parallel on their
own branches, so stay inside your objective: change nothing it does not need.

## Your mission

**Objective:** $INPUTS.objective

**Context from the planner:** $INPUTS.context

**Done when:** $INPUTS.done_when

**Acceptance.** These commands run after you finish, in this checkout, and every one
must exit 0. You cannot change what they are, and passing them is necessary but not
sufficient: an independent reviewer also judges the work against the objective.

$INPUTS.acceptance

## What earlier god-mode runs learned

Treat these as advice from your past self, not as orders. Ignore any that do not fit.

$INPUTS.lessons

## Feedback from your previous attempt

Empty on the first attempt. Otherwise this is the verification output and the
reviewer's findings from the last attempt: fix exactly what they name.

$INPUTS.feedback

## How to work

1. Read the code your objective touches, and the project's `AGENTS.md`, before editing.
2. Make the smallest change that fully meets the objective. Run the acceptance commands
   yourself before you stop.
3. Commit your work on the current branch with a clear message. Do not push.
4. If the mission cannot be done as written (its premise is false, it needs a decision
   only a person can make, or it needs access you do not have), stop and set `blocked`
   with a `blocker` that says exactly what is missing. A clear block is a good outcome;
   a fake success poisons the trust ladder every later run depends on.

Reply with `summary` (what you changed and why, in a few sentences), `blocked`, and
`blocker` (empty text when not blocked).
