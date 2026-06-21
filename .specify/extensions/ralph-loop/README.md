# Spec-Kit Ralph Loop

`ralph-loop` is a Spec Kit extension that converts a feature's `tasks.md`
into Ralph-style run artifacts, lets an external bash loop drive one agent
iteration at a time, then syncs passed task IDs back into `tasks.md`.

The current extension exposes these Spec Kit commands:

- `/speckit.ralph-loop.tasks-to-ralph`
- `/speckit.ralph-loop.sync-back`

## What This Project Contains

```
spec-kit-ralph/
|-- extension.yml
|-- commands/
|   |-- speckit-tasks-to-ralph.md
|   `-- speckit-ralph-sync-back.md
|-- scripts/bash/
|   |-- tasks-to-prd.sh
|   `-- sync-passes-to-tasks.sh
|-- ralph.sh
|-- ralph-config.yml
|-- ralph-config.template.yml
|-- install-extension.sh
`-- README.md
```

## Prerequisites

- A Spec Kit project initialized with `specify init`.
- A feature branch. `scripts/bash/tasks-to-prd.sh` refuses to run on
  `main` or `master`.
- A feature directory under `specs/` with a `tasks.md` file.
- `git` and `jq` on `PATH`.
- `claude` on `PATH`, because `extension.yml` declares it as required.
- The selected loop tool installed and authenticated. `ralph.sh` supports
  `claude`, `codex`, `amp`, `test-gpt5.5-codex`, and `ccs-bp`.

Runtime prompt files are also required by the shell script:

- `ralph.sh` reads `CLAUDE.md` from the installed extension directory for
  `claude`, `codex`, `test-gpt5.5-codex`, and `ccs-bp`.
- `ralph.sh` reads `prompt.md` from the installed extension directory for
  `amp`.

This checkout currently does not include `CLAUDE.md` or `prompt.md`. If those
files are absent in the installed extension directory, the loop fails before it
can start the selected agent CLI.

## Install Into a Spec Kit Project

From the target Spec Kit project, install this checkout as a local development
extension:

```bash
specify extension add --dev /absolute/path/to/spec-kit-ralph --priority 10
specify extension list
```

After installation, the extension files live under:

```text
.specify/extensions/ralph-loop/
```

This checkout also includes `install-extension.sh`, which stages a clean copy of
the extension and installs or updates it in one or more local Spec Kit projects:

```bash
./install-extension.sh --repo /path/to/spec-kit-project
./install-extension.sh --dry-run --repo /path/to/spec-kit-project
```

If no repo is passed, the script uses the default repo hardcoded in
`install-extension.sh`.

## End-to-End Use

Run these commands from the target Spec Kit project, not from this extension
source directory.

### 1. Prepare Ralph Artifacts

Use the Spec Kit command:

```text
/speckit.ralph-loop.tasks-to-ralph <feature-dir-or-prefix>
```

Or call the script directly:

```bash
bash .specify/extensions/ralph-loop/scripts/bash/tasks-to-prd.sh <feature-dir-or-prefix>
```

The feature argument can be a full directory name such as
`004-sessions-memory-auth` or a unique prefix such as `004`. If no feature is
passed, the command and script try to read `feature_directory` from
`.specify/feature.json`.

This step:

- Resolves exactly one matching `specs/<feature>*` directory.
- Reads unchecked task lines matching `- [ ] TNNN ...`.
- Groups tasks by `## Phase N: ...` and, when present, `### ...`
  subsections.
- Writes `specs/<feature>/prd.json`.
- Writes `specs/<feature>/progress.txt`.
- Updates `.specify/feature.json` with `ralph_prd_file` and
  `ralph_progress_file` when that file exists.
- Does not edit `tasks.md`.

### 2. Run the External Loop

Run `ralph.sh` from a separate terminal in the target Spec Kit project:

```bash
RALPH_I_UNDERSTAND_DANGEROUS=1 bash .specify/extensions/ralph-loop/ralph.sh 50
```

The numeric argument is the maximum iteration count. If omitted, `ralph.sh`
uses `max_iterations` from `ralph-config.yml`.

Override the configured tool with `--tool`:

```bash
RALPH_I_UNDERSTAND_DANGEROUS=1 bash .specify/extensions/ralph-loop/ralph.sh --tool claude 50
RALPH_I_UNDERSTAND_DANGEROUS=1 bash .specify/extensions/ralph-loop/ralph.sh --tool codex 50
```

The script requires an explicit danger consent because it runs the selected
agent with permission bypass flags. Any one of these consent paths works:

```bash
export RALPH_I_UNDERSTAND_DANGEROUS=1
touch .specify/extensions/ralph-loop/.consent
```

Or set this in `.specify/extensions/ralph-loop/ralph-config.yml`:

```yaml
ralph_i_understand_dangerous: 1
```

During the loop, `ralph.sh` resolves `prd.json` and `progress.txt` in this
order:

1. `RALPH_PRD_FILE` and `RALPH_PROGRESS_FILE` environment variables.
2. `.specify/feature.json` keys written by `tasks-to-prd.sh`.
3. Legacy fallback files next to `ralph.sh`.

The loop exits successfully when every batch has `completed:true`, every nested
task has `passes:true`, or the agent emits a standalone
`<promise>COMPLETE</promise>` line near the end of its output.

### 3. Sync Results Back to Spec Kit

After `ralph.sh` exits, run:

```text
/speckit.ralph-loop.sync-back <feature-dir-or-prefix>
```

Or call the script directly:

```bash
bash .specify/extensions/ralph-loop/scripts/bash/sync-passes-to-tasks.sh <feature-dir-or-prefix>
```

This step:

- Reads `specs/<feature>/prd.json`.
- Finds nested tasks with `passes:true`.
- Flips matching `- [ ] TNNN` lines to `- [X] TNNN` in `tasks.md`.
- Leaves unmatched IDs as warnings.
- Archives `prd.json` and `progress.txt` under
  `specs/<feature>/archive/<UTC timestamp>/`.

## Configuration

The active config file is installed at:

```text
.specify/extensions/ralph-loop/ralph-config.yml
```

Current config keys:

```yaml
max_iterations: 100
tool: codex
model: gpt-5.3-codex
reasoning_effort: xhigh
ralph_i_understand_dangerous: 1
```

`ralph.sh` requires `tool`, `model`, and `reasoning_effort` to be set before it
runs. In the current script, the CLI can override only:

- `tool`, with `--tool <name>` or `--tool=<name>`.
- `max_iterations`, with a positional number such as `50`.

## Task Format Expected by the Converter

`tasks-to-prd.sh` only converts unchecked Spec Kit task lines with `TNNN`
identifiers:

```markdown
## Phase 1: Build foundation

- [ ] T001 Create the shared module
- [ ] T002 [P] Add tests for the shared module
- [X] T003 Already completed tasks are skipped

### API

- [ ] T004 Implement the endpoint
```

Completed `[X]` tasks are skipped when generating `prd.json`.

## Development Checks

The checked shell scripts can be syntax-checked without starting the loop:

```bash
for file in ralph.sh scripts/bash/*.sh; do
  bash -n "$file"
done
```

Do not use the old README commands such as `/speckit.ralph.run`,
`.specify/extensions/ralph/scripts/...`, or `SPECKIT_RALPH_*` environment
variables. Those names are not present in the current source tree.

## License

[MIT](LICENSE)
