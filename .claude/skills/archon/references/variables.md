# Variable Substitution Reference

Variables are placeholders in command files and workflow prompts that get replaced at execution time.

## Variable Table

| Variable | Scope | Description |
|----------|-------|-------------|
| `$ARGUMENTS` | All modes | The user's original message passed to the workflow |
| `$USER_MESSAGE` | All modes | Same as `$ARGUMENTS` — both resolve to the user's message |
| `$WORKFLOW_ID` | All modes | Unique workflow run ID (for tracking and logging) |
| `$ARTIFACTS_DIR` | All modes | Pre-created directory for this workflow run's artifacts. Write outputs here |
| `$BASE_BRANCH` | All modes | Base branch name. Auto-detected from git, or set via `worktree.baseBranch` in config. Throws if referenced but unresolvable |
| `$DOCS_DIR` | All modes | Documentation directory (config `docs.path`, default `docs/`). Never throws |
| `$CONTEXT` | All modes | GitHub issue/PR context (if available from platform). Empty string if unavailable |
| `$EXTERNAL_CONTEXT` | All modes | Alias for `$CONTEXT` |
| `$ISSUE_CONTEXT` | All modes | Alias for `$CONTEXT` |
| `$LOOP_USER_INPUT` | Loop / loop_group prompts | User feedback from `/workflow approve <id> <text>` at an interactive loop gate. Populated ONLY on the first iteration after a resume; empty string everywhere else |
| `$LOOP_PREV_OUTPUT` | Loop prompts | Previous iteration's cleaned output (completion tags stripped). Empty on iteration 1. Key tool for `fresh_context: true` loops that need to know what the last pass did |
| `$LOOP_PREV.<nodeId>.output[.field]` | loop_group body prompts | Previous iteration's output of a specific body node. Empty on iteration 1. Field access follows the strict contract below (except genuinely-absent prior output → `''`). NOT substituted into body `when:` conditions |
| `$REJECTION_REASON` | `approval.on_reject` prompts | Reviewer feedback from `/workflow reject <id> <reason>`. Empty string everywhere else |
| `$nodeId.output` | DAG only | Full text output of a completed upstream node. Unknown/skipped producer → `''` |
| `$nodeId.output.field` | DAG only | JSON field access — **strict**: an unresolvable field FAILS the consuming node (see below) |

## Where Variables Are Substituted

- **Command files** (`.archon/commands/*.md`) — the core set (`$ARGUMENTS`/`$USER_MESSAGE`, `$WORKFLOW_ID`, `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$DOCS_DIR`, `$CONTEXT` family), plus `$nodeId.output[.field]` when the command runs as a DAG node. Loop/approval variables (`$LOOP_USER_INPUT`, `$LOOP_PREV_OUTPUT`, `$LOOP_PREV.*`, `$REJECTION_REASON`) resolve to `''` here — they are only populated inside inline `loop:`/`loop_group:` prompts and `approval.on_reject` prompts
- **Inline `prompt:` fields** — in DAG prompt nodes, loop prompts, and loop_group body prompts
- **`bash:` scripts** — SPECIAL: user-controlled variables (`$ARGUMENTS`, `$USER_MESSAGE`, `$LOOP_USER_INPUT`, `$LOOP_PREV_OUTPUT`, `$REJECTION_REASON`, `$CONTEXT`) are **NOT text-substituted** into the script (shell-injection guard). They arrive as **environment variables** instead: `ARGUMENTS`, `USER_MESSAGE`, `LOOP_USER_INPUT`, `LOOP_PREV_OUTPUT`, `REJECTION_REASON`, `CONTEXT`, plus `ARTIFACTS_DIR`, `LOG_DIR`, `BASE_BRANCH` — use `"$ARGUMENTS"` as normal shell env access. `$nodeId.output` refs ARE substituted, auto shell-quoted; values >32KB spill to a file and substitute as `$(cat <path>)`
- **`script:` bodies** — `$nodeId.output` values are substituted **raw** (not shell-quoted). Assign directly (`const data = $nodeId.output;`) — JSON is valid JS expression syntax. **Avoid `String.raw\`$nodeId.output\``** — it silently breaks when the output contains a backtick (common in AI-generated markdown and `output_format` payloads). Env: script subprocesses get FEWER env vars than bash — only `ARTIFACTS_DIR`, `LOG_DIR`, `BASE_BRANCH` (+ managed per-project env); `process.env.ARGUMENTS` is NOT available. **Footgun**: unlike bash, script bodies do NOT use the shell-safe path — a literal `$ARGUMENTS` / `$USER_MESSAGE` / `$CONTEXT` in the script source IS text-substituted **raw and unescaped** into the code (user text spliced into TS/Python source — a quoting/injection hazard). Prefer `$nodeId.output` refs (or a `bash:` node reading env vars) for user-controlled values

## Substitution Order

1. Standard workflow variables (`$WORKFLOW_ID`, `$ARGUMENTS`, `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$DOCS_DIR`, `$CONTEXT`, loop/rejection vars)
2. Node output references (`$nodeId.output`, `$nodeId.output.field`, `$LOOP_PREV.*`) — DAG mode only

## Context Auto-Append

If `$CONTEXT` / `$EXTERNAL_CONTEXT` / `$ISSUE_CONTEXT` is NOT present anywhere in the prompt template but context exists (e.g., from a GitHub issue), it is automatically appended at the end after a `---` separator.

## Escaped Dollar Signs

Use `\$` to produce a literal `$` in command files (prevents variable substitution).

## NOT Supported: `$1` … `$9` Positional Arguments

Despite older docs suggesting otherwise, positional `$1`…`$9` are **not substituted** by the workflow engine — command files and prompts receive the whole message only, via `$ARGUMENTS`/`$USER_MESSAGE`. (A legacy positional-substitution helper exists in the codebase but is not wired into the execution path.) Parse arguments inside the prompt or with a `bash:`/`script:` node instead.

## Node Output Details (DAG Only)

`$nodeId.output` resolves to the full text output of the upstream node. If the node used `output_format:` (structured output), the output is the JSON-stringified validated result. Bash/script output is stdout with the trailing newline trimmed. Loop/loop_group output is the final iteration's output with completion-signal tags stripped. An approval node's output is the approver's comment when `capture_response: true`, else `''`. Unknown or skipped producers resolve to an empty string (with a warning logged).

`$nodeId.output.field` is **strict** (no-silent-drop) — it either resolves or **fails the consuming node**:

- Producer has `output_format`: a field **declared** in the schema resolves to its value, or `''` if absent (declared-optional). A field **not in the schema** fails the consumer (typo protection).
- Schemaless producer (bash/script/prose): the output must be a JSON object containing the key — anything else (non-JSON output, missing key) fails the consumer.
- Producer skipped or pending: fails the consumer — guard the reference with `when:` or a permissive `trigger_rule`.

Values: strings pass through; numbers/booleans stringify; objects/arrays are JSON-stringified.
