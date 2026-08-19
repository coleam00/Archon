# Validate

Run the project's own checks and report the truth. You fix nothing and judge nothing beyond pass or fail — running the gate is the whole job.

Optional narrowing (may be empty — empty means the full applicable gate):

$INPUTS.scope

The run's trigger message, which may add context:

$ARGUMENTS

## Discover, then run

1. Discover the checks from the repository itself: package scripts, task runners, CI workflow definitions, contributor docs. Never invent a generic command the project does not define; never substitute your own idea of a check for the project's.
2. If dependencies are missing, install them with the project's own package manager in locked mode first — a gate that fails on a broken environment is reporting the environment, not the code.
3. Run what applies, in the project's own order where one is documented: type checks, lint, tests, build. Honor any documented aggregate gate (a `validate`/`check` script) over reassembling its pieces by hand.
4. Capture each command and its outcome as you go.

## Not your job

Do not modify source files, fix failures, commit, push, or touch pull requests. Do not skip a failing check to make the verdict green. Do not re-run a flaky-looking check more than once without saying so.

## Report

Write `$ARTIFACTS_DIR/validation.md`: each command run, its outcome, and for failures the decisive output tail — enough for a fixer to act without re-running everything. Concise and factual.

## Declare the verdict

- `green` — true only when every applicable check you ran passed.
- `summary` — a few sentences: what ran, what passed, and for a red verdict the failing checks by name.

If checks cannot run at all — no runnable environment, no defined checks — say so plainly: `green: false` with the reason in `summary` when the gate exists but is unrunnable; `green: true` with the note "no checks defined by this project" only when the repository genuinely defines none. Before declaring, confirm every command you cite actually ran in this session and `validation.md` reflects exactly what happened.
