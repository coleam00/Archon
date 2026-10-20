# Variable Substitution Reference

Variables are placeholders in command files and workflow prompts that get replaced at execution time.

## Variable Table

| Variable | Scope | Description |
|----------|-------|-------------|
| `$ARGUMENTS` | All modes | The user's original message passed to the workflow |
| `$USER_MESSAGE` | All modes | Same as `$ARGUMENTS` — both resolve to the user's message |
| `$WORKFLOW_ID` | All modes | Unique workflow run ID (for tracking and logging) |
| `$ARTIFACTS_DIR` | All modes | Pre-created directory for this workflow run's artifacts. Write outputs here |
| `$BASE_BRANCH` | All modes | The run's resolved or recorded base branch. Throws if referenced but unresolved. See the [Variable Reference](https://archon.diy/reference/variables/#workflow-variables) for resolution and child inheritance rules |
| `$DOCS_DIR` | All modes | Documentation directory (config `docs.path`, default `docs/`). Never throws |
| `$CONTEXT` | All modes | GitHub issue/PR context (if available from platform). Empty string if unavailable |
| `$EXTERNAL_CONTEXT` | All modes | Alias for `$CONTEXT` |
| `$ISSUE_CONTEXT` | All modes | Alias for `$CONTEXT` |
| `$LOOP_USER_INPUT` | Loop / loop_group prompts | **Deprecated** with interactive loop gates; new loops end a `loop_group` body in a `wait: attention` node and read `$LOOP_PREV.<wait-id>.output.text`. Feedback from `/workflow approve <id> <text>` at an interactive loop gate. Populated ONLY on the first iteration after a resume; empty string everywhere else |
| `$LOOP_PREV_OUTPUT` | Loop prompts | Previous iteration's cleaned output (completion tags stripped). Empty on iteration 1. Key tool for `fresh_context: true` loops that need to know what the last pass did |
| `$LOOP_PREV.<nodeId>.output[.field]` | loop_group body prompts and `when:` conditions | Previous iteration's output of a specific body node. Empty on iteration 1. Field access follows the strict contract below (except genuinely-absent prior output → `''`). In a body `when:`, it is a typed condition reference rather than text substitution |
| `$REJECTION_REASON` | Legacy `approval.on_reject` prompts | **Deprecated.** The reason from `/workflow reject <id> <reason>`. Empty string everywhere else. New workflows read an attention wait's `$<wait-id>.output.text` from a node behind `when: "$<wait-id>.output.decision == 'reject'"` |
| `$nodeId.output` | DAG only | Full text output of a completed upstream node. Unknown/skipped producer → `''` |
| `$nodeId.output.field` | DAG only | JSON field access — **strict**: an unresolvable field FAILS the consuming node (see below) |

## Where Variables Are Substituted

- **Command files** (`.archon/commands/*.md`) — the core set (`$ARGUMENTS`/`$USER_MESSAGE`, `$WORKFLOW_ID`, `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$DOCS_DIR`, `$CONTEXT` family), plus `$nodeId.output[.field]` when the command runs as a DAG node. A command file referenced by `loop.command` or a `loop_group` body receives the same populated loop variables as an inline loop prompt. Ordinary DAG command nodes receive `''` for loop/rejection variables. `$REJECTION_REASON` is populated only in an `approval.on_reject` prompt
- **Inline `prompt:` fields** — in DAG prompt nodes, loop prompts, and loop_group body prompts
- **`bash:` scripts** — SPECIAL: user-controlled variables (`$ARGUMENTS`, `$USER_MESSAGE`, `$LOOP_USER_INPUT`, `$LOOP_PREV_OUTPUT`, `$REJECTION_REASON`, `$CONTEXT`) are **NOT text-substituted** into the script (shell-injection guard). They arrive as **environment variables** instead: `ARGUMENTS`, `USER_MESSAGE`, `LOOP_USER_INPUT`, `LOOP_PREV_OUTPUT`, `REJECTION_REASON`, `CONTEXT` (+ `EXTERNAL_CONTEXT`/`ISSUE_CONTEXT`), plus `ARTIFACTS_DIR`, `LOG_DIR`, `BASE_BRANCH` — use `"$ARGUMENTS"` as normal shell env access. `$nodeId.output` refs ARE substituted: small string values are single-quoted inline; values exceeding 32,768 UTF-16 code units (JavaScript `string.length`) spill to a file and substitute as unquoted `$(cat '<path>')`, which drops trailing newlines; the command substitution splits words and expands globs when used as a bare argument. Assign first (`value=$nodeId.output`), then quote the shell variable (`printf '%s' "$value"`) to handle both forms. See [Shell quoting guidance](https://archon.diy/reference/variables/#shell-quoting-in-bash-vs-script).
- **`script:` bodies** — like `bash:`, user-controlled variables (`$ARGUMENTS`, `$USER_MESSAGE`, `$LOOP_USER_INPUT`, `$LOOP_PREV_OUTPUT`, `$REJECTION_REASON`, `$CONTEXT`) are **NOT text-substituted** into the source (injection guard, #2115). They arrive as **environment variables** — `ARGUMENTS`, `USER_MESSAGE`, `LOOP_USER_INPUT`, `LOOP_PREV_OUTPUT`, `REJECTION_REASON`, `CONTEXT` (+ `EXTERNAL_CONTEXT`/`ISSUE_CONTEXT`), plus `ARTIFACTS_DIR`, `LOG_DIR`, `BASE_BRANCH` and managed per-project env — read via `process.env.ARGUMENTS` (bun) / `os.environ['ARGUMENTS']` (uv/python) — env vars are the general injection-safe channel for untrusted values. A literal `$ARGUMENTS`/`$USER_MESSAGE`/`$CONTEXT` left in the source is not substituted and resolves to nothing. `$nodeId.output` values are still substituted **raw** (not shell-quoted). Direct assignment (`const data = $nodeId.output;`) is safe **only with `runtime: bun` when the producer uses `output_format`**. JSON booleans and nulls are not Python literals, so a `runtime: uv` script should bind the value with `with: { data: "$nodeId.output" }` and parse `os.environ['INPUTS_DATA']` with `json.loads`. For arbitrary-text producers (bash/script stdout or prose), use the same environment binding instead of embedding the raw value in source, then parse defensively only if the text is expected to contain JSON. **Avoid wrapping `$nodeId.output` in a `String.raw` template literal** — it silently breaks when the output contains a backtick (common in AI-generated markdown and `output_format` payloads)

## Substitution Order

A template is substituted in one pass. Each reference written in the template resolves once, and the value is inserted exactly as written: a message, issue context, loop reply, rejection reason, previous output, or input value that contains `$nodeId.output`, `$INPUTS.<name>`, a variable name, or `$&` reaches the node unchanged. Where two grammars match at the same `$`, the earlier group wins:

1. Loop references inside a `loop_group` body (`$LOOP_PREV.<nodeId>.output`, the group's `$LOOP_USER_INPUT`)
2. Workflow variables (`$WORKFLOW_ID`, `$ARGUMENTS`, `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$DOCS_DIR`, `$INPUTS.<name>`, `$CONTEXT`, loop/rejection vars)
3. Node output references (`$nodeId.output`, `$nodeId.output.field`) — DAG mode only

## Context Auto-Append

If `$CONTEXT` / `$EXTERNAL_CONTEXT` / `$ISSUE_CONTEXT` is NOT present anywhere in the prompt template but context exists (e.g., from a GitHub issue), it is automatically appended at the end after a `---` separator.

## NOT Supported: `$1` … `$9` Positional Arguments

Despite older docs suggesting otherwise, positional `$1`…`$9` are **not substituted** by the workflow engine — command files and prompts receive the whole message only, via `$ARGUMENTS`/`$USER_MESSAGE`. (A legacy positional-substitution helper exists in the codebase but is not wired into the execution path.) Parse arguments inside the prompt or with a `bash:`/`script:` node instead.

## Node Output Details (DAG Only)

`$nodeId.output` resolves to the full text output of the upstream node. If the node used `output_format:` (structured output), the output is the JSON-stringified validated result. Bash/script output without `output_format` is stdout with the trailing newline trimmed; with it, stdout is certified as JSON under the same result contract (see `node-reference.md` → Result contracts). Loop/loop_group output is the final iteration's output with completion-signal tags stripped. An attention wait outputs its answer by form: `{text}` for `message`, `{decision, text}` for `approval` and `select`, `{decisions, text}` for `multi_select`; read fields as `$ask.output.decision` and `$ask.output.text`. A deprecated gate with authored `approval.decisions` also outputs JSON `{decision, text}`. A deprecated gate without authored decisions keeps the old behavior: its approval comment is output only when `capture_response: true`, otherwise `''`. Unknown or skipped producers resolve to an empty string (with a warning logged).

`$nodeId.output.field` and nested paths such as `$nodeId.output.proposal.action` are **strict** (no-silent-drop) — they either resolve or **fail the consuming node**. Paths are object field names only: no array indexing, wildcards or expressions. The same paths work in templates, `when:` (which needs a scalar), whole-value `with:` bindings and `$LOOP_PREV.<id>.output.a.b`. Do not flatten a producer's schema to reach a nested field.

- Producer has `output_format`: every segment must be a declared `properties` entry; a declared field or parent that is absent or null resolves to `''` (declared-optional). An undeclared segment, at any depth, fails `archon validate workflows` when the producer's schema is known at load, and fails the consumer otherwise (typo protection).
- Schemaless producer (no `output_format` on the producing node): the output must be a JSON object containing every key on the path, with an object at each intermediate step — anything else (non-JSON output, missing key, a scalar or array mid-path) fails the consumer.
- Producer skipped or pending: fails the consumer — guard the reference with `when:` or a permissive `trigger_rule`.

Values: strings pass through; numbers/booleans stringify; objects/arrays are JSON-stringified.

For `workflow:` results, these field rules use the child's `returns:` node's
schema, whose declared paths travel with the value and survive cold resume. The
caller cannot add or narrow the contract. An `include:` alias uses its selected
producer directly after flattening.

### Artifact pointers

Return a small JSON value containing a pointer when a machine consumer needs a
file result. The reserved shape is:

```json
{"type":"archon_artifact","run_id":"<producing run id>","path":"review/report.md"}
```

Use the actual `WORKFLOW_ID` value for `run_id`, not the literal variable name.
The producer must first write the file under its `$ARTIFACTS_DIR`. Sibling keys
on the pointer are allowed. Before persisting the result, the engine validates
tagged pointers against the producing run: its own run id, a nonempty relative
path with no `..` segment or NUL, lexical containment, and an existing regular
file. Absolute/escaping paths, directories, missing files, and another run's id
fail the producer.

A `workflow:` parent and fan-out aggregate relay pointers unchanged without
revalidating them against the parent. Events and resume retain the run id and
relative path. The engine does not expand the pointer into an absolute path,
read its contents into a prompt, or provide an in-workflow resolver. For prompt
handoffs inside the producing run, keep using `$ARTIFACTS_DIR/<path>`.

The reader owns authorization, run reachability, and realpath containment at
read time. Producer validation is not a read-side symlink guarantee; the artifact
API's outstanding realpath check is tracked in #3160. Full semantics live in
the repository's `reference/variables.md` → Artifact pointers in a result.
