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
4. Apply the narrowing above when it is not empty: the checks that cover that package, directory or named check.

You may read files and run read-only commands to find these out — list scripts, check whether dependencies are installed, inspect `git status`. Do not run the checks themselves, and do not modify anything.

## Declare

- `checks` — each check as `{ name, argv }`, in the order to run. `argv` is the command and its arguments as separate strings, run from the repository root with no shell. When a check genuinely needs a shell (a pipeline, `&&`, an environment assignment), name the shell explicitly, as in `["bash", "-c", "<the project's own command>"]`. On Windows, a command installed as a `.cmd` shim (such as `npm` or `pnpm`) also needs a shell to start. The first failing check ends the run, so order matters.
- `quarantine` — see below; usually empty.
- `notes` — one or two sentences: where the gate is defined and why these checks. When the repository genuinely defines no checks, `checks` is empty and `notes` says what you looked at to establish that. An empty list reads as green, so declare it only when there is truly nothing to run, never because the gate looked hard to run.

## The object under validation is the tracked tree

An Archon run injects its own scaffolding into the checkout — the `.archon/` copy, and on some launch paths untracked workflow packages. That is run machinery, not the change under validation, and repository gates that inspect git state (untracked-file refusals, cleanliness checks) will trip on it. When the gate you declared inspects git state that way, and `git status` shows untracked paths under `.archon/` that the run itself injected, list those paths in `quarantine`, relative to the repository root. The runner moves them aside while the checks run and restores them afterwards, and `validation.md` records that it did. It refuses any path outside `.archon/` or any path where git tracks a file. Never list anything the change under validation actually touches.
