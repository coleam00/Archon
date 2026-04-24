# Troubleshooting Workflows

Where to look when a workflow fails, hangs, or does the wrong thing.

## Log Locations

Workflow run logs are written as JSONL per run:

```
~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl
```

Each line is a structured event. The discriminator is the `type` field. Values (see `packages/workflows/src/logger.ts` for the canonical list):

| `type` | Meaning |
|--------|---------|
| `workflow_start` / `workflow_complete` / `workflow_error` | Run lifecycle |
| `node_start` / `node_complete` / `node_error` / `node_skipped` | Node lifecycle |
| `assistant` | AI assistant message — has `content` field with the full AI output |
| `tool` | SDK tool invocation — has `tool_name`, `tool_input`, `duration_ms`, and optionally `tokens` |
| `validation` | Workflow-level validation event — has `check` and `result` (`pass` / `fail` / `warn` / `unknown`) |

> **Loop iterations and per-attempt retry events are NOT in the JSONL file.** They go through the workflow event emitter (WebSocket / `workflow_events` DB table) under `loop_iteration_started` / `loop_iteration_completed` etc. To see them, query the DB or the Web UI dashboard — not the JSONL log.

Find the run ID from `archon workflow status` (most recent run). Then:

```bash
# Last assistant message (what the AI said before failure)
jq 'select(.type == "assistant") | .content' <log-file> | tail -1

# All error events (node failures + workflow-level failures)
jq 'select(.type == "node_error" or .type == "workflow_error")' <log-file>

# Full event stream
cat <log-file> | jq .
```

Adapter logs (Slack / Telegram / Web / GitHub) are emitted to stderr when `LOG_LEVEL=debug` is set on the server.

## Artifact Locations

```
~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<run-id>/
```

Inspect artifacts when a multi-node workflow produces wrong output. The failing node's upstream artifact is usually where the problem originated.

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

See the Install page on the docs site for full platform-specific install paths.

### Workflow shows `running` for a long time but nothing happens

Three possibilities:

1. **The AI is actually working.** Check `~/.archon/workspaces/<owner>/<repo>/logs/<run-id>.jsonl` — if you see recent `tool` or `assistant` events in the tail, it's fine. Wait.
2. **The server crashed and left an orphan row.** Server startup no longer auto-fails orphaned `running` rows (per the "No Autonomous Lifecycle Mutation" rule — `CLAUDE.md`). Transition it manually:
   - Web UI: Dashboard → Abandon or Cancel button on the run card
   - CLI: `archon workflow abandon <run-id>` — marks the DB row cancelled without killing any subprocess. Right tool for orphans since the subprocess is already gone
   - Chat (Slack / Telegram / Web): `/workflow cancel <run-id>` — actively terminates the subprocess. Use for a still-live run that needs to be interrupted (there is no `archon workflow cancel` CLI subcommand)
3. **A node is past its `idle_timeout`.** The default is 5 minutes. Override with per-node `idle_timeout: 600000` (10 min) for long-running nodes.

### Workflow fails mid-way; how do I resume?

Auto-resume is default — just re-invoke the same workflow at the same cwd:

```bash
archon workflow run my-workflow "original message"
# → "Resuming workflow — skipping N already-completed node(s)"
```

Use `--resume` only when you want to force-reuse the same worktree from a specific failed run. Use `archon workflow resume <run-id>` to force a specific run ID.

**Caveat:** AI session context from prior nodes is NOT restored on resume. If a `context: shared` node depended on in-session memory, re-running it will have fresh context. Artifact-based handoff survives; in-context memory does not.

### Approval gate not appearing on web UI

You set `interactive: true` on the approval node but the workflow still runs in the background and no chat message appears.

**Fix:** Set `interactive: true` at the **workflow level** too. Node-level `interactive` is ignored on web without workflow-level `interactive`. See `references/workflow-dag.md` §Approval Nodes and §Interactive Loops.

### `MCP server connection failed: <plugin>` noise in chat

User-level Claude plugin MCPs (e.g. `telegram`, `notion`) inherited from `~/.claude/` fail to connect in the headless subprocess. This is normal — they're not configured for Archon's worktree context. Archon filters these to debug logs (`dag.mcp_plugin_connection_suppressed`) and surfaces only workflow-configured MCP failures.

If you see a failure for an MCP you DID configure via `mcp:` in the workflow: check the config JSON path, the MCP server's `command`/`args`, and any referenced env vars.

### Node output is empty / `$nodeId.output.field` resolves to empty string

Common causes:

1. Upstream node is an AI node without `output_format` — the output is free-form text, JSON parsing fails, field access returns empty.
2. Upstream node was **skipped** (its `when:` evaluated false). Downstream `when:` with `==` comparisons against a specific value will fail-closed.
3. Bash/script node printed to stderr, not stdout. Only stdout is captured.
4. For script nodes, non-zero exit on a non-existent file / missing import silently drops the output. Check the run log for `node_failed`.

## Useful Diagnostic Commands

```bash
# All active runs as JSON (running / paused / recently finished, depending on retention)
archon workflow status --json | jq '.runs[]'

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
