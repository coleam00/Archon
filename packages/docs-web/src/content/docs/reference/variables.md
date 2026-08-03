---
title: Variable Reference
description: Complete reference for all variable substitutions available in Archon commands and workflows.
category: reference
area: workflows
audience: [user]
sidebar:
  order: 5
---

Archon substitutes variables in command files, inline prompts, bash scripts, and `script:` node bodies before execution. There are two categories of variables: workflow variables (substituted by the workflow engine) and node output references (DAG workflows only).

## Workflow Variables

These variables are substituted by the workflow executor in all node types (`command:`, `prompt:`, `bash:`, `script:`, `loop:`, `loop_group:`, and a `workflow:` node's `input:` field — which behaves like a `prompt:` body, not a bash-escaped one).

| Variable | Resolves to | Notes |
|----------|-------------|-------|
| `$ARGUMENTS` | The user's input message that triggered the workflow | Primary way to pass user input to commands |
| `$USER_MESSAGE` | Same as `$ARGUMENTS` | Alias |
| `$WORKFLOW_ID` | Unique ID for the current workflow run | Useful for artifact naming and log correlation |
| `$ARTIFACTS_DIR` | Pre-created external artifacts directory (`~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<id>/`) | Always exists before node execution; stored outside the repo to avoid polluting the working tree. **Container runs (`--container`):** this host path is **not mounted into the container**, so a node that writes *directly* to `$ARTIFACTS_DIR` from inside the container will fail — write to the workspace instead. Engine-written typed-output sidecars still work (they are written on the host from captured stdout). |
| `$STATE_DIR` | Pre-created external cross-run state directory (`~/.archon/workspaces/<project>/state/`) | Scoped per **project** — shared across every workflow, every conversation, and every invocation surface, so cooperating workflows can share memory. Namespace inside it yourself (`$STATE_DIR/<name>/`) if you want isolation. Survives worktree teardown, and never appears in `git status`. Throws if referenced but unresolved, exactly like `$BASE_BRANCH`. **Container runs (`--container`):** same caveat as `$ARTIFACTS_DIR` — the host path is not mounted into the container, so a node writing there from inside the container writes to the container's ephemeral layer. |
| `$BASE_BRANCH` | Base branch for git operations | Resolved in order: the `--base <branch>` flag on `archon workflow run` (per dispatch), then `worktree.baseBranch` in `.archon/config.yaml`, then the registered codebase's stored default branch, then git auto-detection. `--base` sets the worktree cut-from too, so this variable always names the branch the worktree was actually cut from -- unless `--from` was also passed, which overrides only the cut-from. See [Base branch precedence](/reference/cli/#base-branch-precedence). Throws an error if referenced in a prompt but cannot be resolved |
| `$DOCS_DIR` | Documentation directory path | Configured via `docs.path` in `.archon/config.yaml`. Defaults to `docs/` when not set. Never throws |
| `$CONTEXT` | GitHub issue or PR context, if available | Populated when the workflow is triggered from a GitHub issue/PR. Replaced with empty string when unavailable |
| `$EXTERNAL_CONTEXT` | Same as `$CONTEXT` | Alias |
| `$ISSUE_CONTEXT` | Same as `$CONTEXT` | Alias |
| `$LOOP_USER_INPUT` | User feedback from an interactive loop approval gate | Only populated on the first iteration of a resumed interactive loop. Empty string on all other iterations. On a signal-bearing gate, a bare approve (no feedback) finalizes the node without a new iteration, so the variable is never read |
| `$REJECTION_REASON` | Reviewer feedback from an approval node rejection | Only available in `on_reject` prompts. Empty string elsewhere |
| `$LOOP_PREV_OUTPUT` | Cleaned output of the previous loop iteration (loop nodes only) | Empty string on the first iteration. Useful for `fresh_context: true` loops that need to reference the prior pass without carrying the full session history |
| `$LOOP_PREV.<nodeId>.output` | A body node's output from the previous iteration (loop_group body nodes only) | Empty string on iteration 1. `$LOOP_PREV.<nodeId>.output.<field>` accesses structured-output fields with the same strict semantics as `$nodeId.output.field`. See [Cross-Node Loops](/guides/loop-nodes/#cross-node-loops-with-loop_group) |

### Context Variable Behavior

The three context aliases (`$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT`) all resolve to the same value. When no issue context is available, they are replaced with an empty string to avoid sending the literal `$CONTEXT` text to the AI.

If issue context is present but no context variable appears in the prompt, the context is **appended** to the end of the prompt automatically. This prevents duplicate context when a command explicitly uses `$CONTEXT`.

### `$BASE_BRANCH` Fail-Fast

Unlike other variables, `$BASE_BRANCH` will cause the workflow to **fail immediately** if:
- The variable is referenced in a prompt, AND
- `worktree.baseBranch` is not set in `.archon/config.yaml`, AND
- The registered codebase has no stored default branch, AND
- Auto-detection from git fails

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

If Archon finds a legacy `<repo>/.archon/state/` directory when a run starts, it logs one
warning with the exact `mv` command and moves nothing.

**Concurrency.** The engine does no locking on `$STATE_DIR`. See
[Authoring Workflows](/guides/authoring-workflows/#cross-run-state-with-state_dir) for
the read-modify-write hazard and how to avoid it.

**Name collisions.** The project segment is derived from the project's identity, and distinct
projects can derive the same one — two no-remote local repos both called `api`, or two folder
projects whose display names slugify identically. Artifacts and logs are keyed by run id, so a
collision is harmless there. `$STATE_DIR` has no run-id segment, so colliding projects
genuinely **share** their state files. If that matters, register one of them under a distinct
name, or namespace inside `$STATE_DIR`.

## Positional Arguments (not supported)

Archon does **not** support positional arguments (`$1`, `$2`, `$3`, … `$9`).
Command files and workflow prompts receive the user's whole trigger message via
`$ARGUMENTS` / `$USER_MESSAGE` only — there is no whitespace-splitting into
numbered slots, in either direct command invocation or workflow nodes. If you
need structured inputs, parse them out of `$ARGUMENTS` inside the command or
prompt body.

## Node Output References

In DAG workflows, nodes can reference the output of any completed upstream node. These are substituted after workflow variables.

| Pattern | Resolves to | Notes |
|---------|-------------|-------|
| `$nodeId.output` | Full output string of the referenced node | The node must be a declared dependency (in `depends_on`) |
| `$nodeId.output.field` | A specific JSON field from the node's output | Works on any JSON-object output; `output_format` adds stricter validation — see notes below |

A `.field` reference **fails the consuming node** when the producer's output is not a JSON object — whether or not the producer declared an `output_format`. Declaring a schema buys you a stricter check on the field *name* (an undeclared field fails the consuming node with a named error rather than resolving to a silent empty), and lets a declared-but-absent field resolve to `''`; it never makes a broken producer quieter. This matters most for `workflow:` sub-run nodes, where `output_format` populates the accessible field names but is **not** validated against what the child actually returns.

During the current run, downstream interpolation and `when:` conditions see the full returned node output. Successful bash events retain only a 32 KiB UTF-8 audit preview, so after a process boundary a resumed run rehydrates that persisted preview rather than the full output. If a large gate verdict must survive a restart intact, store it through a deliberately managed artifact contract instead of relying on the event preview.

### Shell Quoting in `bash:` vs `script:`

`$nodeId.output` values are **auto shell-quoted** when substituted into `bash:` scripts, so the value is always safe to embed in a shell command. For small outputs, values are single-quoted inline. For outputs exceeding 32 KB, Archon spills to a temp file and substitutes `$(cat '/tmp/path')` instead — the unquoted assignment form is correct in both cases. They are **not** shell-quoted when substituted into `script:` bodies — the raw value is embedded as-is. For script nodes, treat substituted values as untrusted input and parse them with language features (e.g. `JSON.parse`), not by interpolating into shell syntax.

User-controlled variables (`$ARGUMENTS`, `$USER_MESSAGE`, `$LOOP_USER_INPUT`, `$LOOP_PREV_OUTPUT`, `$REJECTION_REASON`, `$CONTEXT` and its aliases) are delivered to `bash:` and `script:` nodes as subprocess **environment variables** (`ARGUMENTS`, `USER_MESSAGE`, `LOOP_USER_INPUT`, `LOOP_PREV_OUTPUT`, `REJECTION_REASON`, `CONTEXT`/`EXTERNAL_CONTEXT`/`ISSUE_CONTEXT`), never spliced as raw text into executable code — so attacker-influenced input can't inject. In `bash:` read them as `"$ARGUMENTS"`; in `script:` read them via `process.env.ARGUMENTS` (bun) or `os.environ['ARGUMENTS']` (uv/python). A literal `$ARGUMENTS`/`$USER_MESSAGE`/`$CONTEXT` left in a `script:` body no longer resolves and logs a one-release migration warning.

Because `bash:` substitutions arrive pre-quoted, wrapping them in double quotes is a silent footgun for small (inline) values:

```bash
# WRONG — for a small value, $emit.output.status is injected as 'ok' (single-quoted),
# so status="$emit.output.status" becomes status="'ok'" — the quotes become data.
status="$emit.output.status"
[ "$status" = "ok" ] && echo pass   # → silently fails ($status is 'ok', not ok)

# CORRECT — leave the substitution unquoted; Archon's quoting is the quoting.
status=$emit.output.status          # → status='ok' → bash assigns: ok
[ "$status" = "ok" ] && echo pass   # → passes
```

For **large** outputs (>32 KB) the substitution is `$(cat '/path')`, where `var="$(cat ...)"` is correct bash — but you can't know the size at author time, so the rule is unconditional. Numeric and boolean **fields** are injected raw (no quotes), so double-quoting accidentally "works" for them — which makes the bug intermittent. Always use `var=$node.output.field`, never `var="$node.output.field"`.

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

## Substitution Order

Variables are substituted in a defined order:

1. **Workflow variables** -- `$WORKFLOW_ID`, `$USER_MESSAGE`, `$ARGUMENTS`, `$ARTIFACTS_DIR`, `$STATE_DIR`, `$BASE_BRANCH`, `$DOCS_DIR`, `$LOOP_USER_INPUT`, `$REJECTION_REASON`, `$LOOP_PREV_OUTPUT`
2. **Context variables** -- `$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT`
3. **Node output references** -- `$nodeId.output`, `$nodeId.output.field`

Inside a `loop_group` body, `$LOOP_PREV.<nodeId>.output` refs are resolved
first (before `$LOOP_USER_INPUT` is spliced in, so user-provided text is never
re-processed as a workflow ref), then the node's normal substitution runs.

Positional arguments (`$1` through `$9`) are **not** supported in any context — `$ARGUMENTS` / `$USER_MESSAGE` deliver the whole trigger message instead.

## Variable Availability by Context

| Variable | Workflow nodes | Direct command invocation | `when:` conditions |
|----------|---------------|--------------------------|-------------------|
| `$ARGUMENTS` / `$USER_MESSAGE` | Yes | Yes (both aliases) | No |
| `$WORKFLOW_ID` | Yes | No | No |
| `$ARTIFACTS_DIR` | Yes | No | No |
| `$STATE_DIR` | Yes | No | No |
| `$BASE_BRANCH` | Yes | No | No |
| `$DOCS_DIR` | Yes | No | No |
| `$CONTEXT` / aliases | Yes | No | No |
| `$LOOP_USER_INPUT` | Yes (loop nodes) | No | No |
| `$REJECTION_REASON` | Yes (`on_reject` only) | No | No |
| `$LOOP_PREV_OUTPUT` | Yes (loop nodes) | No | No |
| `$LOOP_PREV.<nodeId>.output` | Yes (loop_group body nodes) | No | No |
| `$nodeId.output` | Yes (DAG nodes) | No | Yes |

## Authentication Environment Variables

These are standard environment variables read from `process.env` at clone time. They are **not** workflow-substituted variables — they must be set in your shell environment or `.env` file before Archon starts.

| Variable | Description |
|----------|-------------|
| `GH_TOKEN` | GitHub personal access token for authenticated clone operations |
| `GITLAB_TOKEN` | GitLab personal or project access token (`glpat-*`) for authenticated GitLab clones |
| `GITEA_TOKEN` | Gitea API token for authenticated Gitea/Forgejo clones |
