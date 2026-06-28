# Validation

## Commands

Validate a workflow by name from the target repo:

```bash
bun run cli validate workflows <workflow-name>
```

Validate all workflows:

```bash
bun run cli validate workflows
```

Validate commands:

```bash
bun run cli validate commands
```

Run a workflow manually:

```bash
bun run cli workflow run <workflow-name> "user input"
```

For workflows that must run in the live checkout:

```bash
bun run cli workflow run <workflow-name> --no-worktree "user input"
```

Use `--json` on list and status commands when machine-readable output is needed.

## Validation Checklist

- The file is under `.archon/workflows/` or a supported global workflow directory.
- The filename ends with `.yaml` or `.yml`.
- The root has `name`, `description`, and non-empty `nodes`.
- The workflow uses `nodes`, not `steps`.
- Every node has one action key only.
- Every node ID is unique and safe.
- Every `depends_on` target exists.
- The graph is acyclic unless using `route_loop` for controlled reruns.
- Every command node points to an existing command name.
- Every named script exists in `.archon/scripts/` or `~/.archon/scripts/`.
- Every script node has `runtime: bun` or `runtime: uv`.
- Every `mcp` path exists and is valid JSON object.
- Every `output_format` is valid JSON Schema.
- Every `$node.output.field` reference matches a declared property or schemaless JSON producer.
- Every `when` expression uses supported syntax.
- Route-loop `depends_on[0]` equals `route_loop.from`.
- Route-loop positive and exhausted routes are exit paths.
- Provider IDs are registered locally.
- Provider-specific fields match provider capabilities.
- Human gates set root `interactive: true` when needed.
- Cleanup and final reports use `trigger_rule: all_done` when they must run after failure or skip.

## Common Failures

`Workflow must have 'nodes:' configuration` means the workflow used legacy `steps:` or omitted nodes.
Convert to DAG nodes.

`command, prompt, bash, loop, route_loop, approval, cancel, and script are mutually exclusive` means one node has more than one action key.
Split it into multiple nodes.

`Node '<id>' depends_on unknown node '<dep>'` means the dependency ID is misspelled or missing.
Fix the ID or add the producer node.

`references unknown node '$x.output'` means a prompt, loop prompt, or condition references a node that does not exist.
Fix the reference or add `depends_on` to the correct producer.

`field '<field>' is not declared in output_format.properties` means downstream code references a structured field that the producer did not declare.
Add the property to `output_format.properties` or change the reference.

`Named script '<name>' not found` means the script cannot be discovered by basename.
Create `.archon/scripts/<name>.ts`, `.archon/scripts/<name>.js`, or `.archon/scripts/<name>.py`.

`runtime is required for script nodes` means `runtime: bun` or `runtime: uv` is missing.
Add the runtime.

`retry is not supported on loop nodes` means the node uses a loop action with retry.
Use `max_iterations` and `until_bash` for loop retry behavior.

`when is not supported on route_loop nodes` means the route-loop controller has a condition in the wrong place.
Put the condition under `route_loop.condition`.

`route_loop.condition references field ... but from node must declare output_format.properties` means field routing needs a schema.
Add `output_format` to the `from` node.

`provider does not support ... this will be ignored` means the resolved provider lacks that capability.
Remove the field or switch providers.

`persist_session: true but provider does not support sessionResume` means the provider cannot resume sessions.
Use a provider with session resume or disable persistence.

`$nodeId.output double-quoted` warning means bash output substitution is already shell-quoted.
Use `value=$node.output.field` and then quote the shell variable.

## Review Before Final Response

After editing, report:

- Workflow file path.
- Command files or scripts created.
- Provider and model choices.
- Human approval points.
- Validation command run and result.
- Any validation that could not run and why.

Do not claim the workflow is valid unless local validation passed.
