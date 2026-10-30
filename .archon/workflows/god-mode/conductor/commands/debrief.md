# Debrief a God-Mode Run

The missions have finished. Write the debrief a person reads first, and decide what
god mode should remember. Read only: change nothing in the repository.

## What happened

All missions succeeded: $INPUTS.all_succeeded

Trust ladder before this run: $INPUTS.trust

$INPUTS.report

The plan and the brief are in `$ARTIFACTS_DIR/plan.md`.

## Write `$ARTIFACTS_DIR/debrief.md`

1. The verdict, one line.
2. Per mission: what was achieved, on which branch, and what a person should do next
   (review and merge, re-scope, or drop it).
3. What went wrong and the root cause, where anything did. Not "it was flaky".

## Decide what to remember

Return up to five `lessons`: durable, specific advice that would have made THIS run
better and will apply to future runs in this project. For example, "the web package's
tests need `bun run build:web` first", not "be careful". Return none rather than
filler. Every mission reads these lessons, so a wrong one costs every future run.

Reply with `summary` (two or three sentences) and `lessons`.
