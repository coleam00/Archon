# Discover the checks

Find the project's own checks and declare them. You do not run the gate: a script runs exactly what you declare, for as long as it takes, and records every exit status. Your declaration is the whole of what gets validated, so it must be the project's gate and nothing else.

Optional narrowing (may be empty — empty means the full applicable gate):

$INPUTS.scope

The run's trigger message, which may add context:

$ARGUMENTS

## Discover

1. Read the checks from the repository itself: package scripts, task runners, CI workflow definitions, contributor docs. Never invent a generic command the project does not define; never substitute your own idea of a check for the project's.
2. Honor a documented aggregate gate (a `validate`/`check` script) over reassembling its pieces by hand. Declare it as one check in one group. Declare separate checks only when the project has no aggregate gate, and then in the project's own order where one is documented: type checks, lint, tests, build.
3. Find the independent gates. A project with several independently built parts — a service in one language beside a web app in another, per-module or per-crate gates — has one group per part, so a failure in one never hides another's results. Checks that belong to one gate share a group, in order.
4. If dependencies are missing, declare the project's own install command in locked mode as the first check (for example a frozen lockfile flag). A gate that fails on a broken environment is reporting the environment, not the code.
5. Apply the narrowing above when it is not empty: the checks that cover that package, directory or named check.

You may read files and run read-only commands to find these out — list scripts, check whether dependencies are installed, inspect `git status`. Do not run the checks themselves, and do not modify anything.

## Declare

- `checks` — each check as `{ name, argv, group }`, in the order to run. `argv` is the command and its arguments as separate strings, run from the repository root with no shell. When a check genuinely needs a shell (a pipeline, `&&`, an environment assignment), name the shell explicitly, as in `["bash", "-c", "<the project's own command>"]`. On Windows, a command installed as a `.cmd` shim (such as `npm` or `pnpm`) also needs a shell to start. `group` names the independent gate the check belongs to; within a group order matters and the first failing check ends that group, while every group runs. A project with one gate puts every check in one group. An install step goes first in each group that needs it, so a failed install stops exactly the gates that depend on it; a locked install that already holds is quick to repeat.
- `notes` — one or two sentences: where the gate is defined and why these checks. When the repository genuinely defines no checks, `checks` is empty and `notes` says what you looked at to establish that. An empty list reads as green, so declare it only when there is truly nothing to run, never because the gate looked hard to run.
