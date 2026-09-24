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

## The object under validation is the tracked tree

An Archon run injects its own scaffolding into the checkout — the `.archon/` copy, and on some launch paths untracked workflow packages. That is run machinery, not the change under validation, and repository gates that inspect git state (untracked-file refusals, cleanliness checks) will trip on it. When a check fails **only** because of untracked files under `.archon/` that the run itself injected: quarantine them for the gate's duration (move them aside, run the gate, restore them — always restore, even on failure), note the quarantine in your report, and judge the gate's real result. Never quarantine tracked files, or anything the change under validation actually touches.

## Not your job

Do not modify source files, fix failures, commit, push, or touch pull requests. Do not skip a failing check to make the verdict green. Do not re-run a flaky-looking check more than once without saying so.

## Report

Write `$ARTIFACTS_DIR/validation.md`: each command run, its outcome, any applicable check that never ran, and for failures the decisive output tail — enough for a fixer to act without re-running everything. Concise and factual. No one is watching the run — this file and your declared fields are the only record the checks ever ran.

## Declare the verdict

- `green` — true only when every applicable check ran and passed.
- `red_cause` — why the verdict is not green. When a check you ran failed: `introduced`, the change under validation caused it; `inherited`, the same check was already failing at the base this branch came from; `environment`, the machine caused it, not any code — a database or port a parallel process holds, a missing credential, a network fault. `incomplete` when no check you ran failed but not every applicable check ran — you were stopped partway (a usage limit, a killed process) or the gate could not run at all. An unfinished gate is no evidence about the change, and delivery stops there until the run is resumed. A check that ran and failed takes its own cause even when others never ran. Always declared: use the empty string `""` only when `green` is true.
- `summary` — a few sentences: what ran, what passed, and for a red verdict the failing checks by name. For `incomplete`, what stopped validation and which checks ran and passed.

Classifying red never makes it green — `green` stays false either way. But `inherited` and `environment` let delivery continue, so neither is the comfortable answer: declaring one commits you to evidence. Name the exact failing check and the concrete reason the change under validation cannot have caused it — the same named check failed on the exact base revision, or a resource another process demonstrably holds. Disjoint changed paths alone do not prove independence; a check can read a path another change moves. `$ARTIFACTS_DIR/implementation.md` may already record the same red; corroborate it against what you actually ran rather than repeating it. Without that evidence the cause is `introduced`.

If checks cannot run at all — no runnable environment, no defined checks — say so plainly: `green: false`, `red_cause: incomplete`, with the reason in `summary` when the gate exists but is unrunnable; `green: true` with the note "no checks defined by this project" only when the repository genuinely defines none. Before declaring, confirm every command you cite actually ran in this session and `validation.md` reflects exactly what happened.

The optional `comparison` path runs outside this agent: a script records the same project gate on pinned change-alone, incoming-base and composed trees. Only that evidence-backed path can declare `interaction`. It remains red and delivery holds the combination. Ordinary validation must not infer interaction from file overlap, prior green badges, or prose claims.
