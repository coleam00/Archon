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

Only run ordinary project checks. Inspect an aggregate script and what it
delegates to before running it: never launch a coding agent, another workflow,
or a gate that itself judges a change from inside validation. When an aggregate
includes such a step, run the project's declared ordinary checks directly
instead. If no ordinary check can be separated out, report the gate as
unavailable, not healthy.

## The object under validation is the tracked tree

An Archon run injects its own scaffolding into the checkout — the `.archon/` copy, and on some launch paths untracked workflow packages. That is run machinery, not the change under validation, and repository gates that inspect git state (untracked-file refusals, cleanliness checks) will trip on it. When a check fails **only** because of untracked files under `.archon/` that the run itself injected: quarantine them for the gate's duration (move them aside, run the gate, restore them — always restore, even on failure), note the quarantine in your report, and judge the gate's real result. Never quarantine tracked files, or anything the change under validation actually touches.

## Not your job

Do not modify source files, fix failures, commit, push, or touch pull requests. Do not skip a failing check to make the verdict green. Do not re-run a flaky-looking check more than once without saying so.

## Report

Write `$ARTIFACTS_DIR/validation.md`: each command run, its outcome, and for failures the decisive output tail — enough for a fixer to act without re-running everything. Concise and factual. No one is watching the run — this file and your declared fields are the only record the checks ever ran.

## Declare the verdict

- `checks_performed`: true only when at least one ordinary project check actually
  executed. Dependency installation, discovery and failed setup are not checks.
  False for no defined checks or an unavailable gate. Preserve the existing
  `green` distinction: no checks is true; an unavailable gate is false. A partly
  executed gate is never green when applicable ordinary checks remain unrun.

- `green` — true only when every applicable check you ran passed.
- `red_cause` — why the checks are red, required whenever a check you ran failed. `introduced`: the change under validation caused it. `inherited`: the same check was already failing at the base this branch came from. `environment`: the machine caused it, not any code — a database or port a parallel process holds, a missing credential, a network fault. Always declared: use the empty string `""` when `green` is true, and when the gate could not run at all — an unrunnable gate is no evidence about the change, and delivery must stop there.
- `summary` — a few sentences: what ran, what passed, and for a red verdict the failing checks by name.

Classifying red never makes it green — `green` stays false either way. But `inherited` and `environment` let delivery continue, so neither is the comfortable answer: declaring one commits you to evidence. Name the exact failing check and the concrete reason the change under validation cannot have caused it — the failure sits in a subsystem this branch's diff never touches (`git diff` against the base shows you), or a resource another process holds. `$ARTIFACTS_DIR/implementation.md` may already record the same red; corroborate it against what you actually ran rather than repeating it. Without that evidence the cause is `introduced`.

If checks cannot run at all — no runnable environment, no defined checks — say so plainly: `green: false` with the reason in `summary` when the gate exists but is unrunnable; `green: true` with the note "no checks defined by this project" only when the repository genuinely defines none. Before declaring, confirm every command you cite actually ran in this session and `validation.md` reflects exactly what happened.
