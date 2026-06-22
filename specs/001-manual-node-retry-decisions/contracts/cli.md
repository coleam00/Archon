# CLI Contract: `workflow retry-node`

## Command

```bash
archon workflow retry-node <run-id> <node-id>
```

Repository script equivalent:

```bash
bun run cli workflow retry-node <run-id> <node-id>
```

## Arguments

| Argument    | Required | Notes                                                                                         |
| ----------- | -------- | --------------------------------------------------------------------------------------------- |
| `<run-id>`  | yes      | Full run id or supported resolver input if the CLI already supports prefixes for this command |
| `<node-id>` | yes      | Current workflow DAG node id to retry                                                         |

## Options

`--json` is not supported in v1. If present, the command must fail clearly and tell the user that retry-node streams execution output.

## Behavior

1. Load the run.
2. Require run status `failed`.
3. Require `working_path` to be present.
4. Resolve `working_path` to a canonical real path.
5. Verify the path still identifies the intended repository or Archon-managed worktree using:
   - run `codebase_id`
   - registered codebase `default_cwd`
   - registered codebase `repository_url` when present
   - matching isolation environment `working_path` for Archon-managed worktrees
6. Load current workflow definition from the codebase discovery path when available.
7. Call the same retry preparation operation used by the API.
8. Execute the prepared run inline and stream output like `workflow resume`.

## Error Cases

- Missing run: non-zero exit with "Workflow run not found".
- Non-failed run: non-zero exit with current status.
- Missing/invalid working path: non-zero exit before git mutation.
- Path identity mismatch: non-zero exit before git mutation.
- Target node missing or not failed: non-zero exit before git mutation.
- Setup/reset failure: non-zero exit after restoring run status to `failed`.

## Output

Human output should include:

- workflow name
- run id
- working path
- target node
- retry epoch
- invalidated node list
- safety ref and safety commit SHA when present

Then execution streams as current resume does.
