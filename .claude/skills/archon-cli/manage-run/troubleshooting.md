# Troubleshooting Workflows

Where to look when a workflow fails, hangs, or does the wrong thing.

## Log Locations

Workflow run logs are written as JSONL per run:

```text
~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl
```

Each line is a structured event. The discriminator is the `type` field. Values (see `packages/workflows/src/logger.ts` for the canonical list):

| `type` | Meaning |
|--------|---------|
| `workflow_start` / `workflow_complete` / `workflow_error` | Run lifecycle |
| `workflow_resume` | A resumed execution picked the run back up here. The first execution writes `workflow_start`; every resume writes one `workflow_resume` instead, so the rows after the n-th one belong to the run's (n+1)-th segment. Transcripts written before this row existed repeat `workflow_start` on resume |
| `node_start` / `node_complete` / `node_error` / `node_skipped` | Node lifecycle |
| `node_suspended` | A node paused the run; `content` names why (a gate kind such as `approval`, or `wait`) |
| `gate_decision` | How a gate was resolved — `step` (the gate node), `decision` (`approved`, `rejected`, or an author-declared decision), and `content` (the operator's comment or rejection reason, as the run's `approval_received` event stores it: an approve without a comment records `Approved`, and the field is absent when the event stores neither). No actor is recorded. Written by the process that approved or rejected, which is often not the one running the workflow |
| `assistant` | AI assistant message — has `content` field with the full AI output |
| `tool` | SDK tool invocation — has `tool_name` and `tool_input` |
| `exec_output` | What a `bash`/`script` node or `until_bash` probe printed — `stdout_tail`, `stderr_tail`, `exit_code` |
| `watchdog_reset` | A streamed chunk renewed a node's idle watchdog — `chunk_type` only, never content. Renewals closer together than `WATCHDOG_RESET_BURST_GAP_MS` form a burst, recorded as its first and last renewal; `chunk_count` is the renewals since the node's previous record (absent on older transcripts, which wrote one row per renewal). A burst's last record can land after later rows, so order by `ts` |
| `validation` | Historical compatibility only; current runs do not emit this type |

> **Loop iteration lifecycle events are NOT in the JSONL file.** `loop_iteration_started` / `loop_iteration_completed` go through the workflow event emitter (WebSocket / `workflow_events` DB table) — query the DB or the Web UI dashboard for those. Per-iteration rows that DO reach the JSONL are keyed `<node-id>-iteration-<n>`: a loop's `node_complete` row, its `watchdog_reset` rows, and the `exec_output` row for each `until_bash` probe.

Find the run ID from `archon workflow runs --status failed` (or `archon workflow runs` for the most recent run of any status; `workflow status` only shows active runs). Then:

```bash
# Last assistant message (what the AI said before failure)
jq -sr 'map(select(.type == "assistant") | .content) | last // empty' <log-file>

# All error events (node failures + workflow-level failures)
jq 'select(.type == "node_error" or .type == "workflow_error")' <log-file>

# What a specific node actually printed (evidence for "did this really do X?")
jq 'select(.type == "exec_output" and .step == "<node-id>")' <log-file>

# Where the run was resumed, and how each gate was decided
jq 'select(.type == "workflow_resume" or .type == "gate_decision")' <log-file>

# When a node's stream last renewed its watchdog, and with what chunk type
jq -s 'map(select(.type == "watchdog_reset" and .step == "<node-id>")) | sort_by(.ts) | last' <log-file>

# Full event stream
cat <log-file> | jq .
```

Adapter logs (Slack / Telegram / Web / GitHub) are emitted to stderr when `LOG_LEVEL=debug` is set on the server.

## Artifact Locations

```text
~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/
```

Inspect artifacts when a multi-node workflow produces wrong output. The failing node's upstream artifact is usually where the problem originated.

Nodes with `output_type:` also get engine-written sidecars under `runs/<run-id>/nodes/` (`<node-id>.md` + `<node-id>.meta.json`), and — for session-persisted workflows — mirrored copies under `artifacts/scopes/<workflow>/<scope>/nodes/` that survive across runs.

```bash
ls ~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/
cat ~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/issues/issue-42.md
```

Artifacts are **external** to the repo on purpose — they don't pollute git.

## Common Failure Modes

### "No base branch could be resolved"

A node references `$BASE_BRANCH` in its prompt, but neither git auto-detection nor `worktree.baseBranch` in `.archon/config.yaml` produced a branch.

**Fix:**
1. Set `worktree.baseBranch: main` (or `dev`, or whatever) in `.archon/config.yaml`.
2. Or pass `--from <branch>` on `archon workflow run`.
3. Or remove the `$BASE_BRANCH` reference if the node doesn't actually need it.

### "Claude Code not found" / "Codex CLI binary not found"

Compiled-binary builds of Archon no longer embed Claude Code / Codex — you install them separately and Archon resolves the binary via env var or config.

**Fix (Claude):**
- Install: `curl -fsSL https://claude.ai/install.sh | bash` (or `npm install -g @anthropic-ai/claude-code`)
- Set `CLAUDE_BIN_PATH=/path/to/claude` in `~/.archon/.env`, OR
- Set `assistants.claude.claudeBinaryPath: /absolute/path` in `.archon/config.yaml`
- Autodetect covers `$HOME/.local/bin/claude` (native installer) — no config needed if you used that path

**Fix (Codex):**
- Install: `npm install -g @openai/codex` (or platform-specific instructions)
- Set `CODEX_CLI_PATH=/path/to/codex` or `assistants.codex.codexBinaryPath` in config
- Autodetect covers the standard npm / Homebrew locations per platform

See [archon.diy/getting-started/installation/](https://archon.diy/getting-started/installation/) for full platform-specific install paths.

### Workflow shows `running` for a long time but nothing happens

Three possibilities:

1. **The AI is actually working.** Check `~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl` — if you see recent `tool` or `assistant` events in the tail, it's fine. Wait.
2. **The server crashed and left an orphan row.** Server startup no longer auto-fails orphaned `running` rows (per the "No Autonomous Lifecycle Mutation" rule — `CLAUDE.md`). Transition it manually:
   - Any cancel (Web UI Cancel, `archon workflow cancel <run-id>`, chat `/workflow cancel [id]`) stops a live owner process before marking the row cancelled, and refuses when no owner answers — an orphan row gets that refusal, with the host and pid it recorded
   - Verified orphan: `archon workflow abandon <run-id>` (or Abandon in the Web UI after the refused Cancel, or `/workflow abandon <id>` in chat) — marks the row cancelled
3. **A node is past its `idle_timeout`.** The default is 30 minutes of complete silence (the timer resets on every streamed message — it's a deadlock detector, not a work limiter). Override with per-node `idle_timeout` (ms) if a node legitimately goes quiet for longer.

### Workflow fails mid-way; how do I resume?

Find the failed run, then resume it explicitly:

```bash
archon workflow runs
archon workflow get <run-id>
archon workflow resume <run-id>
```

`archon workflow resume <run-id>` targets that exact run and reuses its recorded working path/worktree. As a convenience, `archon workflow run my-workflow --resume` resumes the most recent resumable run for that workflow at the invocation cwd. A bare `archon workflow run my-workflow` starts a fresh run.

**Session caveat:** A cold resume does not reconstruct the ambient sequential
`context: shared` cursor. Explicit `context: { resume: node-id }` ancestry is
restored from saved run-scoped handles, and an interactive loop with
`fresh_context: false` resumes its pre-pause session when the provider supports
it. Artifact-based handoff remains the provider-independent path.

### Approval gate not appearing on web UI

The workflow has an approval node but still runs in the background and no chat message appears.

**Fix:** Set `interactive: true` at the **workflow level**. Node-level `interactive` is not a supported field; the loader ignores it and warns that the key is unknown.

### `MCP server connection failed: <plugin>` noise in chat

User-level Claude plugin MCPs (e.g. `telegram`, `notion`) inherited from `~/.claude/` fail to connect in the headless subprocess. This is normal — they're not configured for Archon's worktree context. Archon filters these to debug logs (`dag.mcp_plugin_connection_suppressed`) and surfaces only workflow-configured MCP failures.

If you see a failure for an MCP you DID configure via `mcp:` in the workflow: check the config JSON path, the MCP server's `command`/`args`, and any referenced env vars.

### A node was skipped and I don't know why

Skips carry a **reason** in the persisted `node_skipped` event (`archon workflow get <run-id> --verbose --json`, or the `workflow_events` table):

| Reason | Meaning | Fix |
|--------|---------|-----|
| `trigger_rule` | Upstream states didn't satisfy the join rule (default `all_success` — a skipped upstream counts as not-success and cascades) | Use `one_success` / `none_failed_min_one_success` / `all_done` on merge nodes after `when:`-gated branches |
| `when_condition` | The `when:` expression evaluated false | Expected behavior — check the upstream output it compared against |
| `when_condition_parse_error` | The `when:` expression has invalid SYNTAX — fail-closed skip | Fix the expression (six operators, `&&`/`\|\|`, no parentheses) |
| `prior_success` | Resume: the node completed in a prior run | Expected; use `always_run: true` to force re-execution |

### Node FAILED with an `OutputRefError`-style message about `$node.output.field`

Not a skip — strict field access failed loudly: the field isn't in the producer's `output_format` schema (typo), the schemaless producer's output isn't JSON / lacks the key, or the producer never ran. Fix the reference, add the field to the schema, or guard with `when:`/`trigger_rule`. (Only whole-text `$node.output` degrades silently to `''`.)

### Node output is empty / a declared-optional field resolves to empty string

Common causes:

1. Upstream node was **skipped** — whole-text `$node.output` is `''` for skipped producers.
2. The field is declared in the producer's `output_format` but was absent/null in the actual output (declared-optional → `''` by design).
3. Bash/script node printed to stderr, not stdout. Only stdout is captured.
4. For script nodes, non-zero exit on a non-existent file / missing import fails the node. Check the run log for `node_error` entries.

### A workflow-level field seems to have no effect

Invalid values for optional workflow-level fields (`interactive`, `effort`, `sandbox`, `fallbackModel`, `betas`, `tags`, `worktree.enabled`, `mutates_checkout`) are **warn-and-drop**: the workflow still loads and runs, the field is discarded, and a warn-level `*_ignored` loader log is written (stderr for CLI commands, the server log for `archon serve`). AI-only fields on bash/script nodes, unknown keys, and deprecations are parse warnings instead: run `archon validate workflows` or `archon workflow list` to see them, or set `LOG_LEVEL=debug` to see them in the logs. Check both before assuming the field is broken.

### Persisted session didn't restore (cold resume)

A `persist_session` node whose provider couldn't restore the prior session runs FRESH with a warning (it does not fail). The warning includes pointers to prior typed artifacts (`output_type` sidecars in the cross-run scope dir) so the prompt/agent can re-read lost context. If sessions are repeatedly cold, check server logs; clear broken state with `archon workflow reset-sessions <workflow>`.

## Useful Diagnostic Commands

```bash
# Environment sanity first: binaries, gh auth, DB, adapters
archon doctor

# One run, any status, with raw events — the fastest "why did node X skip/fail"
archon workflow get <run-id> --verbose --events --json | jq '.events[]'

# Recent runs for this project, all statuses ("did the review pass?")
archon workflow runs --json | jq '.runs[]'

# Recent runs of any status (find a failed run's ID)
archon workflow runs --status failed --limit 10

# Active runs for this project (running / paused only — finished runs never appear here)
archon workflow status --json | jq '.runs[]'

# Active runs across all projects
archon workflow status --all --json | jq '.runs[]'

# Human-readable status of any active runs
archon workflow status

# Active worktrees and their last activity
archon isolation list

# Validate a specific workflow before running
archon validate workflows my-workflow

# Validate a specific command
archon validate commands my-command

# Dump the last 50 lines of a workflow's log
tail -n 50 ~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl | jq .

# Increase log verbosity (workflow run)
archon workflow run my-workflow --verbose "..."

# Increase server log verbosity
LOG_LEVEL=debug bun run start
```

## Escalation: when nothing makes sense

1. Run `archon version` and note the version.
2. Run `archon validate workflows <name>` and capture the output.
3. Grab the last ~50 lines of the run's JSONL log.
4. Check the `CHANGELOG.md` for known issues / recent changes to the subsystem you're hitting.
5. File an issue at https://github.com/coleam00/Archon/issues with version, validate output, log tail, and the YAML.
