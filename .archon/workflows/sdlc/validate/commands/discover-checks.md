# Discover the checks

Find the project's own checks and declare them. You do not run the gate: a script runs exactly what you declare, for as long as it takes, and records every exit status. Your declaration is the whole of what gets validated, so it must be the project's gate and nothing else.

Optional narrowing (may be empty — empty means the full applicable gate):

$INPUTS.scope

The run's trigger message, which may add context:

$ARGUMENTS

## Discover

1. Read the checks from the repository itself: package scripts, task runners, CI workflow definitions, contributor docs. Never invent a generic command the project does not define; never substitute your own idea of a check for the project's.
2. Honor a documented aggregate gate (a `validate`/`check` script) over reassembling its pieces by hand. Declare it as one check. Declare separate checks only when the project has no aggregate gate, and then in the project's own order where one is documented: type checks, lint, tests, build.
3. If dependencies are missing, declare the project's own install command in locked mode as the first check (for example a frozen lockfile flag). A gate that fails on a broken environment is reporting the environment, not the code.
4. Apply the narrowing above when it is not empty: the checks that cover that package, directory or named check. The narrowing and the trigger message may exclude expensive project-specific stages; never silently drop a check that stays inside the declared scope.
5. Declare every applicable check the project defines, including bounded AI integration tests when the project genuinely has them.
6. Never declare a check that re-enters this validation, the delivery workflow around it, or any other command whose purpose is to run the same validation or delivery orchestration again. Read an aggregate script and what it delegates to before declaring it. When an aggregate would re-enter that orchestration, declare its separable project checks directly instead. When no applicable check can be separated from it, the gate is unavailable, not healthy: declare one check that says so and exits non-zero, such as `["bash", "-c", "echo 'validation gate unavailable: <why>' >&2; exit 1"]`.

The workflow records the verdict, together with the scope, the context and a fingerprint of the tracked tree, in `$ARTIFACTS_DIR/validation-evidence.json`. Never create or edit that file, or `validation.md`.

You may read files and run read-only commands to find these out — list scripts, check whether dependencies are installed, inspect `git status`. Do not run the checks themselves, and do not modify anything.

## Declare

- `checks` — each check as `{ name, argv }`, in the order to run. `argv` is the command and its arguments as separate strings, run from the repository root with no shell. When a check genuinely needs a shell (a pipeline, `&&`, an environment assignment), name the shell explicitly, as in `["bash", "-c", "<the project's own command>"]`. On Windows, a command installed as a `.cmd` shim (such as `npm` or `pnpm`) also needs a shell to start. The first failing check ends the run, so order matters.
- `notes` — one or two sentences: where the gate is defined and why these checks. When the repository genuinely defines no checks, `checks` is empty and `notes` says what you looked at to establish that. An empty list reads as green, so declare it only when there is truly nothing to run, never because the gate looked hard to run.

## Processes

Stop only processes this node started, by the process ID it recorded. Never kill by
image or process name (`taskkill /IM`, `pkill`, `killall`, `Stop-Process -Name`): the
machine runs other work, including other runs' builds and tests. Never wait on a
background command without a bound: give every wait a timeout, and if the thing waited
on was stopped or vanished, report that instead of waiting again (seen live: a reviewer
killed every `dotnet` by name, including its own test run, then waited for that run's
output until the run was cancelled).
