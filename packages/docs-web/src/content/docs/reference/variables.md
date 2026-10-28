---
title: Variable Reference
description: Complete reference for all variable substitutions available in Archon commands and workflows.
category: reference
area: workflows
audience: [user]
sidebar:
  order: 5
---

Archon substitutes variables in command files, inline prompts, bash scripts, and `script:` node bodies before execution — except the user-controlled variables, which reach `bash:` and `script:` nodes as environment variables instead. There are two categories of variables: workflow variables (substituted by the workflow engine) and node output references (DAG workflows only).

## Workflow Variables

These variables are substituted by the workflow executor in all node types (`command:`, `prompt:`, `bash:`, `script:`, `loop:`, `loop_group:`, and a `workflow:` node's `input:` field — which behaves like a `prompt:` body, not a bash-escaped one) — except the user-controlled ones in `bash:` and `script:` nodes, which arrive as environment variables instead (see [Shell quoting in `bash:` vs `script:`](#shell-quoting-in-bash-vs-script)).

They are also substituted in a node's **AI-configuration text** — `systemPrompt:` and each entry's `agents.<id>.prompt` / `agents.<id>.description`. These go straight to the provider, so they resolve exactly as a `prompt:` does: workflow variables and `$nodeId.output` refs. A dangling `$nodeId.output` in any of the three is a load error, exactly as it is in a prompt.

| Variable | Resolves to | Notes |
|----------|-------------|-------|
| `$ARGUMENTS` | The user's input message that triggered the workflow | Primary way to pass user input to commands |
| `$USER_MESSAGE` | Same as `$ARGUMENTS` | Alias |
| `$WORKFLOW_ID` | Unique ID for the current workflow run | Useful for artifact naming and log correlation |
| `$ARTIFACTS_DIR` | Pre-created external artifacts directory (`~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<id>/`) | Always exists before node execution; stored outside the repo to avoid polluting the working tree. **Container runs (`--container`):** this host directory is bind-mounted read-write at the same absolute path inside the container, so a node writes to `$ARTIFACTS_DIR` the same way on either side of the boundary. **Scratch work** (a checkout to bisect or spike against, a dependency install) goes under `$ARTIFACTS_DIR/.archon/scratch/`; create it with `mkdir -p`. Archon deletes that directory once the run is completed, failed or cancelled and its nodes have stopped (for a container run, when its container is removed), so a resumed run starts without it. A run whose nodes Archon cannot confirm stopped (its owner ran on another host, or its owner process is still alive) keeps it, and so does a CLI run stopped by a signal until it is abandoned or its conversation is reset; write evidence a later node or the operator reads anywhere else in `$ARTIFACTS_DIR`, which is kept. The deletion removes files only: remove a scratch worktree with `git worktree remove` (or use `git clone`), or its registration stays behind until `git worktree prune`. |
| `$TYPED_ARTIFACTS_FILE` | Absolute path to the current typed-artifact listing (JSON, inside `$ARTIFACTS_DIR`) | A read-only observation grouped by exact case-sensitive `output_type`. Each agent attempt receives a fresh listing before it starts, including transient retries. Plain `loop` structured-output reasks also receive fresh listings. Ordinary agent structured-output reasks (including agents in a `loop_group` body) reuse their attempt's listing. `bash:` and `script:` nodes receive one before execution. Each `until_bash` check receives a separate listing after the plain loop's agent work or the loop group's body. Also delivered to `bash:`/`script:` as the `TYPED_ARTIFACTS_FILE` environment variable. Referencing it in a context with no listing throws rather than substituting an empty string, except in a `--dry-run` preview, which has no artifacts and substitutes an empty string. See [Typed Artifacts](/reference/workflow-language/#typed-artifacts-output_type). |
| `$STATE_DIR` | Pre-created external cross-run state directory (`~/.archon/workspaces/<project>/state/`) | Scoped per **project** — shared across every workflow, every conversation, and every invocation surface, so cooperating workflows can share memory. Namespace inside it yourself (`$STATE_DIR/<name>/`) if you want isolation. Survives worktree teardown, and never appears in `git status`. Throws if referenced but unresolved, exactly like `$BASE_BRANCH`. **Container runs (`--container`):** unlike `$ARTIFACTS_DIR`, this host path is not mounted into the container, so a node writing there from inside the container writes to the container's ephemeral layer. |
| `$BASE_BRANCH` | Base branch for git operations | For top-level runs, resolved in order: the `--base <branch>` flag on `archon workflow run` (per dispatch), then `worktree.baseBranch` in `.archon/config.yaml`, then the registered codebase's stored default branch, then git auto-detection. Fresh shared-checkout children (`inherit` or omitted) inherit the parent's resolved value, including `--base`. New isolated branches use `worktree.baseBranch`, then the codebase default, then detection, independently of parent flags. If an isolated branch is reused without a surviving child run record, its original base is unavailable; config is not used to guess it. A continuation -- `--resume`, an approved gate, or the automatic resume of a parent whose sub-run gate was approved -- reports the value recorded when the run was first dispatched instead of consulting config, the codebase default, or git again; only a `--base` re-passed to that continuation overrides the recorded value. `--base` sets the worktree cut-from too, so for a newly created top-level branch this variable names the branch the worktree was cut from -- unless `--from` was also passed, which overrides only the cut-from. See [Base branch precedence](/reference/cli/#base-branch-precedence). Throws an error if referenced in a prompt but cannot be resolved |
| `$DOCS_DIR` | Documentation directory path | Configured via `docs.path` in `.archon/config.yaml`. Defaults to `docs/` when not set. Never throws |
| `$CONTEXT` | GitHub issue or PR context, if available | Populated when the workflow is triggered from a GitHub issue/PR. Replaced with empty string when unavailable |
| `$EXTERNAL_CONTEXT` | Same as `$CONTEXT` | Alias |
| `$ISSUE_CONTEXT` | Same as `$CONTEXT` | Alias |
| `$LOOP_USER_INPUT` | **Deprecated.** Feedback from a deprecated interactive loop gate. Replacement: end a `loop_group` body in a `wait: attention` node and read `$LOOP_PREV.<wait-id>.output.text`; see [Pausing to ask inside the body](/guides/loop-nodes/#pausing-to-ask-inside-the-body) | Only populated on the first iteration of a resumed interactive loop. Empty string on all other iterations. On a signal-bearing gate, a bare approve (no feedback) finalizes the node without a new iteration, so the variable is never read |
| `$REJECTION_REASON` | **Deprecated.** The reason given when rejecting a deprecated `approval:` node. Replacement: a node with `when: "$<wait-id>.output.decision == 'reject'"` that reads `$<wait-id>.output.text`; see [Migrating from approval gates](/guides/approval-nodes/#migrating-from-approval-gates) | Only available in `on_reject` prompts. Empty string elsewhere |
| `$LOOP_PREV_OUTPUT` | Cleaned output of the previous loop iteration (loop nodes only) | Empty string on the first iteration. Useful for `fresh_context: true` loops that need to reference the prior pass without carrying the full session history |
| `$LOOP_PREV.<nodeId>.output` | A body node's output from the previous iteration (loop_group body nodes only) | Empty string on iteration 1. `$LOOP_PREV.<nodeId>.output.<field>` accesses structured-output fields with the same strict semantics as `$nodeId.output.field`. In a body `when:`, it is a typed condition reference rather than text substitution. See [Cross-Node Loops](/guides/loop-nodes/#cross-node-loops-with-loop_group) |

### Context Variable Behavior

The three context aliases (`$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT`) all resolve to the same value. When no issue context is available, they are replaced with an empty string to avoid sending the literal `$CONTEXT` text to the AI.

If issue context is present but no context variable appears in the prompt, the context is **appended** to the end of the prompt automatically. This prevents duplicate context when a command explicitly uses `$CONTEXT`.

### `$BASE_BRANCH` Fail-Fast

Referencing `$BASE_BRANCH` in a prompt, `bash:`, or `script:` body **fails the node** when the run has no resolved base. This can happen when no explicit base, configured base, or codebase default is available and git detection fails, or when a folder project has no git base. A shared-checkout child can inherit an unresolved base from its parent.

It also happens when an isolated child reuses an existing branch without its original child run record. The historical base is unknown even if current defaults are configured. Changing config or passing parent `--base` or `--from` cannot recover it. Start a new parent run so the child creates a new isolated branch with a known base.

For a new top-level git run, pass `--base`, configure `worktree.baseBranch`, set the codebase default, or repair git detection. Resuming a run retains its recorded base, including an unresolved value, unless that run is explicitly retargeted with `--base`. Folder workflows that do not have a base should avoid referencing the variable.

If the variable is not referenced, no error occurs even if the base branch cannot be determined.

### `$STATE_DIR` — durable cross-run state

`$STATE_DIR` is the external home for state a workflow needs to remember **between**
runs: a dedup ledger, a "last processed" cursor, a nudge log. It is created before the
first node runs and lives at `~/.archon/workspaces/<project>/state/`, a sibling of
`artifacts/` and `logs/`.

Two properties matter:

- **It is per project, not per workflow.** Two cooperating workflows in one project see
  the same directory, which is what lets a pair of related workflows share one ledger.
  If you want isolation, namespace it yourself: `$STATE_DIR/my-workflow/`.
- **It is outside the repository and outside the worktree.** State written here survives
  worktree teardown and can never be staged into git — which is exactly what the older
  `.archon/state/` convention could not promise (inside an isolated run that path *is*
  the worktree, so it was deleted at cleanup).

Like `$BASE_BRANCH`, referencing `$STATE_DIR` where no state directory could be resolved
**throws** rather than substituting an empty string.

Archon no longer checks or warns about legacy `<repo>/.archon/state/` directories,
and does not read or move their contents. Follow the [manual state migration
steps](/reference/archon-directories/#legacy-archonstate), including the checks for
hidden entries and destination conflicts, then update workflows to use `$STATE_DIR`.

**Concurrency.** The engine does no locking on `$STATE_DIR`. See
[Workflow language](/reference/workflow-language/#cross-run-state-with-state_dir) for
the read-modify-write hazard. Use [durable state documents](/reference/workflow-language/#durable-state-documents) for concurrent, audited JSON updates.

**Name collisions.** The project segment is derived from the project's identity, and distinct
projects can derive the same one — two no-remote local repos both called `api`, or two folder
projects whose display names slugify identically. Registration keeps them apart: a new project
whose segment is taken registers under the first free suffixed name, such as `_local/api-2` or
`my-app-2`. A second clone of an already-registered remote is refused; use worktrees for
parallel checkouts. To start a fresh run in a separate clone under the existing project's
identity and storage, use:

```bash
archon workflow run investigate --project owner/repo --cwd /other/clone --no-worktree
```

Find the registered name or ID with `archon project list`. `--no-worktree` executes in the
clone; isolated execution uses the registered checkout. See [workflow run](/reference/cli/#workflow-run-name-message).

Inspect the run with `archon workflow get <full-run-id>`, or run `archon workflow runs`
from the registered checkout. From the separate clone, `workflow runs` falls back to
an install-wide list limited to 20 rows by default.

Unregistered working directories use `@cwd/<basename>-<digest>`, where the digest is
SHA-256 of the resolved absolute directory path. Distinct directory paths have separate
`$STATE_DIR` roots, even when their folder names match. Moving a directory changes its root.

Legacy `_cwd/<basename>` trees remain untouched. When legacy output exists, a run logs
its location and the new root. Inspect the legacy `state/` directory and manually move
only state belonging to this directory into the new `$STATE_DIR`; legacy state may have
been shared by unrelated directories. New runs do not read or copy legacy state.
Runs with an already recorded output root keep using it when resumed.

## Positional Arguments (not supported)

Archon does **not** support positional arguments (`$1`, `$2`, `$3`, … `$9`).
Command files and workflow prompts receive the user's whole trigger message via
`$ARGUMENTS` / `$USER_MESSAGE` only — there is no whitespace-splitting into
numbered slots, in either direct command invocation or workflow nodes. If you
need structured inputs, parse them out of `$ARGUMENTS` inside the command or
prompt body.

## Node Output References

In DAG workflows, nodes can reference the output of any completed upstream node. They resolve in the same pass as workflow variables (see [Substitution Order](#substitution-order)).

| Pattern | Resolves to | Notes |
|---------|-------------|-------|
| `$nodeId.output` | Full output string of the referenced node | The node must be a declared dependency (in `depends_on`) |
| `$nodeId.output.field` / `$nodeId.output.a.b` | A specific JSON field from the node's output | Works on any JSON-object output; `output_format` adds stricter validation — see notes below |

Dot paths read nested object fields: `$review.output.proposal.action` resolves the
`action` inside `proposal`. The same paths work in templates, scalar `when:`
comparisons, whole-value `with:` bindings, and `$LOOP_PREV.review.output.proposal.action`.
A whole-value binding preserves the logical value, including objects and arrays;
`when:` requires a scalar. Paths cannot index or traverse arrays, use wildcards, or
compute expressions. Shorthand conditions (`$node.field`) remain single-field only.

With `output_format`, each segment must be an explicit `properties` entry. A reference
to an undeclared segment, at any depth, fails validation when the producer's schema is
known locally; otherwise it fails the consuming node at runtime, naming the reference
and segment. `additionalProperties`, array `items`, `$ref`, and schema combinators do not
supply declarations. An object with nullable type can declare child properties.
Authorization checks the entire path before reading values, so a typo fails even under
an absent optional parent. A declared missing or null field or parent resolves to `''`.
The root output must still be a JSON object. For schemaless `bash:`/`script:` producers,
every nested key must exist and intermediate values must be objects; a missing key or
non-object intermediate fails the consuming node.

A `wait:` node's contract is fixed by the engine. A time or event wait declares
`status`, `waited_ms`, `event` and `payload`. An [attention wait](/reference/workflow-language/#attention-waits)
declares its answer by form: `message` declares `text`; `approval` and `select` declare
`decision` and `text`; `multi_select` declares `decisions` (an array of option ids) and
`text`. So `$ask.output.decision` is checked at load time, and in a `loop_group` whose body
ends in the wait, the next iteration reads the answer as `$LOOP_PREV.ask.output.text`.
A wait's `options` may be one whole `$node.output.<field>` reference; it is read as a
logical value when the wait pauses, not substituted as text.

For `workflow:` results, the selected child producer owns the contract. Its declared
paths travel with the result and survive resume; the parent cannot declare an
`output_format` on the `workflow:` node. A child result recorded before nested paths
carries only its top-level fields, so a nested read from it fails as undeclared until
the producer reruns.

During the current run, downstream interpolation and `when:` conditions see the full returned node output. Successful `bash:` and `script:` events store at most a 32 KiB UTF-8 preview. When the output is larger, Archon also writes the full output to `$ARTIFACTS_DIR/.archon/node-output-spills/persisted/<write-id>.nodeoutput`, and a resumed run restores `$nodeId.output` from the file named by the durable event. Each write gets a unique path, so a later execution cannot replace an earlier event's output, even if it writes before its own completion event commits. Ordinary output restoration falls back to the preview, which ends in a `[truncated; original output was N bytes]` marker, when the file was never written, cannot be read (for example, after an operator [removed the run's artifacts](/reference/archon-directories/#user-level-archon)), or its byte length no longer matches the length recorded with the event. Each fallback logs a warning (`db.workflow_dag_node_output_spill_read_failed` or `db.workflow_dag_node_output_spill_stale`); a failed write is logged as `dag.spill_file_write_failed` when the node runs. For an `until_bash` completion check after a terminally paused `loop_group` is answered, the preceding iteration must have complete history and full output bytes. Missing, unreadable, or stale spills fail restoration before the predicate runs; see [loop-group resume](/guides/loop-nodes/#resume). Historical events that used a shared `<node>.nodeoutput` path remain readable. Their length check detects a replacement of a different length, but cannot detect an equal-length replacement that already happened; unique paths do not retroactively recover those bytes.

### Shell Quoting in `bash:` vs `script:`

`$nodeId.output` and `$LOOP_PREV.nodeId.output` references, including their field forms, use two substitution regimes in `bash:` and `until_bash:`. Small string outputs are single-quoted inline. For outputs exceeding 32,768 UTF-16 code units (JavaScript `string.length`), Archon writes an engine-owned `$ARTIFACTS_DIR/.archon/node-output-spills/<write-id>.<node>[.<field>].nodeoutput` file and substitutes `$(cat '<path>')` instead; like any command substitution, it drops trailing newlines. Each substitution gets a unique write ID, so current and previous iteration values always have separate files, even when their contents match. A bare argument works with the inline form, but the unquoted command substitution splits words and expands globs. **Assign, then quote the variable** to handle both regimes safely. These files follow the [run-artifact retention lifecycle](/reference/archon-directories/#user-level-archon). They are **not** shell-quoted when substituted into `script:` bodies — the raw value is embedded as-is. For script nodes, treat substituted values as untrusted input and parse them with language features (e.g. `JSON.parse`), not by interpolating into shell syntax.

Resolved `bash:` bodies and plain-loop and loop-group `until_bash:` completion checks are delivered as UTF-8 through stdin to a fixed `bash -c` evaluator, including executable Bash dry runs. Their aggregate inline size is no longer constrained by the OS argument limit. The 32,768-code-unit cutoff above remains a **per-reference** spill rule; memory, environment, and output limits still apply. `$0` and `BASH_SOURCE` retain their `bash -c` behavior. Authored Bash code sees stdin at EOF after delivery, and `BASH_EXECUTION_STRING` contains the evaluator rather than the authored body.

User-controlled variables (`$ARGUMENTS`, `$USER_MESSAGE`, `$LOOP_USER_INPUT`, `$LOOP_PREV_OUTPUT`, `$REJECTION_REASON`, `$CONTEXT` and its aliases) are delivered to `bash:` and `script:` nodes as subprocess **environment variables** (`ARGUMENTS`, `USER_MESSAGE`, `LOOP_USER_INPUT`, `LOOP_PREV_OUTPUT`, `REJECTION_REASON`, `CONTEXT`/`EXTERNAL_CONTEXT`/`ISSUE_CONTEXT`), never spliced as raw text into executable code — so attacker-influenced input can't inject. A `loop_group` body's `bash:` node is the exception: the loop scope splices the reply (`$LOOP_USER_INPUT`) into its source, shell-quoted, so the reply arrives already quoted. Read the spliced reply as an already-quoted value — assign it and quote the variable (`value=$LOOP_USER_INPUT; printf '%s' "$value"`) — rather than as `"$LOOP_USER_INPUT"`. In `bash:` read an environment-delivered value with `"$ARGUMENTS"`. In `script:` read it via `process.env.ARGUMENTS` (bun) or `os.environ['ARGUMENTS']` (uv/python). A literal `$ARGUMENTS`/`$USER_MESSAGE`/`$CONTEXT` left in a `script:` body is not substituted: the text stays in the source.

At load time, Archon scans inline and named exec sources for static environment reads. The supported forms are `os.environ["NAME"]` and `os.environ.get("NAME", ...)` in Python, `process.env.NAME` and `process.env["NAME"]` in JavaScript/TypeScript, and `$INPUTS_NAME` or `${INPUTS_NAME}` in bash; single quotes work in bracket and call forms too. Within a declared `inputs:` contract, an `INPUTS_*` read is a load error unless it matches a script `with:` binding, a declared workflow input, or an environment name configured in Archon or the project's `.archon/.env`. A workflow with no `inputs:` block keeps the open caller-input contract, so caller-provided names cannot be rejected while loading that workflow in isolation. Other static Python/JavaScript env reads that Archon does not provide produce a parse warning, since project and credential variables may still come from the execution environment. Diagnostics identify the inline `bash`/`script` line or the named script path and line, plus the available binding and input names.

This is a deliberately lexical check, not a language parser. Computed keys, aliases, destructuring, `os.getenv`, and ordinary non-`INPUTS_*` bash variables are outside the supported detection boundary. An exact supported accessor spelling inside a comment or string literal can still be reported.

Keep the reference as the whole, unquoted assignment value, then quote the shell variable wherever you use it:

```bash
value=$emit.output
printf '%s' "$value"

status=$emit.output.status
[ "$status" = "ok" ] && echo pass
```

Assignments suppress word splitting and glob expansion in both regimes. `export value=$emit.output` and `local value=$emit.output` are also safe. Wrapping the reference in double quotes breaks small string values: `status="$emit.output.status"` becomes `status="'ok'"`, preserving the single quotes as data. Single quotes around a reference also produce the wrong value. Numeric and boolean fields are injected raw, but use the same assign-then-quote idiom so a change to a string value remains safe.

`archon validate workflows` warns about quoted references and bare references outside complete assignments in `bash:` and `until_bash:`. Heredoc bodies remain outside this check.

### Example

```yaml
nodes:
  - id: classify
    command: classify-issue
    output_format:
      type: object
      properties:
        type: { type: string, enum: [BUG, FEATURE] }
      required: [type]

  - id: fix
    prompt: |
      The issue was classified as: $classify.output.type
      Full classification: $classify.output
      User's original request: $USER_MESSAGE
    depends_on: [classify]
```

### Node-local `with:` bindings on `command:` and `script:` nodes

A command file and a named script live in their own files, outside the workflow YAML. A
command body gets the same variable substitution as an inline `prompt:`; a named script body
is never rewritten. `with:` on a `command:` or `script:` node binds upstream values **by
name** through the channels those bodies already read: `$INPUTS.<name>` in a command file,
`INPUTS_<UPPER_SNAKE>` env vars in a script.

```yaml
nodes:
  - id: validate
    prompt: Run validation and report the verdict.
    output_format:
      type: object
      properties:
        green: { type: boolean }
      required: [green]

  - id: record
    script: record-verdict          # named script — reads process.env.INPUTS_GREEN
    runtime: bun
    depends_on: [validate]
    with:
      green: $validate.output.green
```

Three value forms, resolved per binding:

| Value | Resolves to |
|-------|-------------|
| A non-string literal (`true`, `42`, `[a, b]`) | The value itself, with its logical type |
| A string that is **exactly one** whole `$node.output`, `$node.output.field`, or `$INPUTS.<name>` reference | The **logical value** — a boolean field arrives as a boolean, an object as an object (env delivery uses its canonical text: strings raw, everything else JSON) |
| Any other string | A text template, substituted like `input:` (workflow vars and `$node.output` refs) |

An object value is reserved for the **binding directive** `{ from, if_skipped }`: `from` is
one whole `$node.output[.field]` reference, and when that producer was **skipped** (a
`when:`-false branch reached through `trigger_rule: all_done`) the binding takes `if_skipped`
instead. A skipped producer with no `if_skipped` fails the node with the fix named — a
binding never silently resolves to an empty string. `if_skipped` is literal data, so
reference-looking text there is neither substituted nor validated as an output reference.

```yaml
  - id: join
    script: read-ready
    runtime: bun
    depends_on: [initial-ready, iteration-ready]
    trigger_rule: all_done
    with:
      initial:   { from: $initial-ready.output.ready,   if_skipped: false }
      iteration: { from: $iteration-ready.output.ready, if_skipped: false }
```

Every referenced producer must be an upstream `depends_on` dependency — the loader rejects
the workflow otherwise, so a binding can never race its producer. Node-local bindings are
the **nearest** input layer: they win over a composed block's inputs, which win over the
run's own `$INPUTS`.

The load-time environment-read check accepts these binding names, declared workflow inputs,
and environment names configured in Archon or the project's `.archon/.env`. Within a declared
`inputs:` contract, an unconfigured `process.env.INPUTS_GREEN` read requires
`with: { green: ... }` on that script node or a declared `green` workflow input.
Engine-owned names such as `ARTIFACTS_DIR`,
`BASE_BRANCH`, `ARGUMENTS`, and `WORKFLOW_ID` are always accepted.

`with:` on other node types: `include:` and `workflow:` nodes keep their existing caller-input
meaning (values may be any JSON value); on `bash:`, `prompt:`, and loop nodes the field is
ignored with a load warning — inline bodies already reference `$node.output` directly.

### Artifact pointers in a result

A node output is a value, not a file. When a node produces something large, write it under
`$ARTIFACTS_DIR` and return a **pointer** to it inside the result:

```json
{ "type": "archon_artifact", "run_id": "01JD…", "path": "review/report.md" }
```

`type: "archon_artifact"` is reserved by the engine. Any object carrying it, at any depth in
a node's logical value, must be a valid pointer: `run_id` and `path` are required non-empty
strings. `path` is relative to the run's own artifacts directory. For how a pointer fits
into a workflow's declared result, see
[Workflow language → Result contracts](/reference/workflow-language/#result-contracts).

Every pointer is checked once, **at the producing node and against its own run**, before the
value is persisted — so a bad one fails the node that produced it rather than surfacing
later as a broken link:

| Rule | Rejected |
|------|----------|
| Own run | A `run_id` other than the producing run's own (`$WORKFLOW_ID`). A result may only point at its own run's artifacts today. |
| Addressable run | A run whose output location was never recorded, or one recorded outside the Archon home directory. |
| Relative path | An absolute path, a `..` segment, or a NUL byte. |
| Containment | A path that resolves lexically outside the run's artifacts directory. |
| Real file | A missing target, or a directory. |

A `workflow:` parent and a fan-out aggregate relay a child's value unchanged: the child
already proved its pointers against the only run it may name. Reachability and real-path
checks belong to the read side by design — whether a reader may see that run, and whether
the path still resolves inside its artifacts directory once symlinks are followed.
`GET /api/artifacts/<run_id>/<path>` does lexical containment on the untrusted request
today; real-path resolution at read time is not yet implemented (#3160).

The value stays a run id plus a relative path in node outputs, events, sub-run results,
fan-out aggregates, and resumed runs. Archon never rewrites it into an absolute path and
never loads the file's contents into a prompt. There is no in-workflow resolver: a pointer
is for machine readers, and a prompt inside the producing run keeps the
`$ARTIFACTS_DIR/<path>` string, which is the same file on disk.

## Substitution Order

A template is substituted in one left-to-right pass. Each reference the template itself
contains resolves once, from its own source, and the value is inserted exactly as it is.
A substituted value is never scanned again: a trigger message, issue context, loop reply,
rejection reason, previous output, or input value that contains `$nodeId.output`,
`$INPUTS.<name>`, a variable name, or `$&` reaches the node as written.

Where two grammars could match at the same `$`, the earlier group in this list wins:

1. **Loop references** (inside a `loop_group` body) -- `$LOOP_PREV.<nodeId>.output`, and the
   group's `$LOOP_USER_INPUT` reply
2. **Workflow variables** -- `$WORKFLOW_ID`, `$ARTIFACTS_DIR`, `$STATE_DIR`, `$ADOPTED_RUN_DIR`, `$TYPED_ARTIFACTS_FILE`, `$BASE_BRANCH`, `$DOCS_DIR`, `$USER_MESSAGE`, `$ARGUMENTS`, `$LOOP_USER_INPUT`, `$REJECTION_REASON`, `$LOOP_PREV_OUTPUT`, `$INPUTS.<name>`, then the context variables `$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT`
3. **Node output references** -- `$nodeId.output`, `$nodeId.output.field`

Issue context that is appended because the template names no context variable is added after
substitution, so it is never scanned either.

Positional arguments (`$1` through `$9`) are **not** supported in any context — `$ARGUMENTS` / `$USER_MESSAGE` deliver the whole trigger message instead.

## Variable Availability by Context

| Variable | Workflow nodes | Direct command invocation | `when:` conditions |
|----------|---------------|--------------------------|-------------------|
| `$ARGUMENTS` / `$USER_MESSAGE` | Yes | Yes (both aliases) | No |
| `$WORKFLOW_ID` | Yes | No | No |
| `$ARTIFACTS_DIR` | Yes | No | No |
| `$TYPED_ARTIFACTS_FILE` | Yes (exec and AI nodes) | No | No |
| `$STATE_DIR` | Yes | No | No |
| `$BASE_BRANCH` | Yes | No | No |
| `$DOCS_DIR` | Yes | No | No |
| `$CONTEXT` / aliases | Yes | No | No |
| `$LOOP_USER_INPUT` (deprecated) | Yes (loop nodes) | No | No |
| `$REJECTION_REASON` (deprecated) | Yes (`on_reject` only) | No | No |
| `$LOOP_PREV_OUTPUT` | Yes (loop nodes) | No | No |
| `$LOOP_PREV.<nodeId>.output` | Yes (loop_group body nodes) | No | Yes (loop_group body nodes) |
| `$nodeId.output` | Yes (DAG nodes) | No | Yes |

Workflow variables and `$nodeId.output` refs both resolve in `systemPrompt:` and `agents.*.prompt` / `agents.*.description` on any AI node.

## Authentication Environment Variables

These are standard environment variables read from `process.env` at clone time. They are **not** workflow-substituted variables. Set them before Archon starts in your shell environment, `~/.archon/.env` for user-wide credentials, or `<cwd>/.archon/.env` for project overrides. The CLI strips keys named in a target repository's `<cwd>/.env`. See [environment file locations and load order](/reference/configuration/#env-file-locations) for precedence and entry-point differences.

| Variable | Description |
|----------|-------------|
| `GH_TOKEN` | GitHub personal access token for authenticated clones from `github.com` or the `GITHUB_URL` host |
| `GITLAB_TOKEN` | GitLab personal or project access token (`glpat-*`) for authenticated clones from `gitlab.com` or the `GITLAB_URL` host |
| `GITEA_TOKEN` | Gitea API token for authenticated clones from `gitea.com` or the `GITEA_URL` or `FORGEJO_URL` host |
| `GITHUB_URL` | Base URL of a GitHub Enterprise Server (e.g. `https://github.example.com`). Clones with this exact scheme, host and port use `GH_TOKEN`, then `GITHUB_TOKEN` |
| `GITLAB_URL` | Base URL of a self-hosted GitLab (e.g. `https://gitlab.example.com`). Clones with this exact scheme, host and port use `GITLAB_TOKEN` |
| `GITEA_URL` | Base URL of a self-hosted Gitea. Clones with this exact scheme, host and port use `GITEA_TOKEN` |
| `FORGEJO_URL` | Base URL of a self-hosted Forgejo. Clones with this exact scheme, host and port use `GITEA_TOKEN` |

A forge token is sent only to the host it is configured for, and only over the scheme it is configured for: HTTPS for `github.com`, `gitlab.com` and `gitea.com`, and the `*_URL`'s own scheme for a self-hosted instance. An `http://` clone of an HTTPS forge gets no token. A hostname that merely contains `github`, `gitlab`, `gitea` or `forgejo` gets no token; set the matching `*_URL` for a self-hosted instance.
