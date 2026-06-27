# Ralph Reference Guide

This reference guide provides essential information for troubleshooting and understanding Ralph's autonomous development loop.

In bmalph-managed projects, start Ralph with `bmalph run`. When you need direct loop flags such as `--reset-circuit` or `--live`, invoke `bash .ralph/ralph_loop.sh ...` from the project root.

## Table of Contents

1. [Configuration Files](#configuration-files)
2. [Project Configuration (.ralph/.ralphrc)](#project-configuration-ralphralphrc)
3. [Session Management](#session-management)
4. [Circuit Breaker](#circuit-breaker)
5. [Exit Detection](#exit-detection)
6. [Live Streaming](#live-streaming)
7. [Troubleshooting](#troubleshooting)

---

## Configuration Files

Ralph uses several files within the `.ralph/` directory, plus an optional legacy fallback config at the project root:

| File                                       | Purpose                                                          |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `.ralph/PROMPT.md`                         | Main prompt that drives each loop iteration                      |
| `.ralph/@fix_plan.md`                      | Prioritized task list that Ralph follows                         |
| `.ralph/@AGENT.md`                         | Build and run instructions maintained by Ralph                   |
| `.ralph/status.json`                       | Real-time status tracking (JSON format)                          |
| `.ralph/logs/`                             | Execution logs for each loop iteration                           |
| `.ralph/.ralph_session`                    | Current session state                                            |
| `.ralph/.circuit_breaker_state`            | Circuit breaker state                                            |
| `.ralph/live.log`                          | Live streaming output file for monitoring                        |
| `.ralph/.loop_start_sha`                   | Git HEAD SHA captured at loop start for progress detection       |
| `.ralph/.ralphrc`                          | Project-specific configuration installed by bmalph               |
| `.ralphrc` (project root, legacy fallback) | Optional legacy configuration for older standalone Ralph layouts |

### Rate Limiting

- Default: 100 API calls per hour (configurable via `--calls` flag or `.ralph/.ralphrc`)
- Automatic hourly reset with countdown display
- Call tracking persists across script restarts

---

## Project Configuration (.ralph/.ralphrc)

In bmalph-managed projects, Ralph reads `.ralph/.ralphrc` for per-project settings.
For backward compatibility with older standalone Ralph layouts, it also falls back to a project-root `.ralphrc` when the bundled config file is missing.

### Precedence

Environment variables > Ralph config file > script defaults

### Available Settings

| Variable                      | Default                                                                                                              | Description                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `PROJECT_NAME`                | `my-project`                                                                                                         | Project name for prompts and logging                                                                                     |
| `PROJECT_TYPE`                | `unknown`                                                                                                            | Project type (javascript, typescript, python, rust, go)                                                                  |
| `MAX_CALLS_PER_HOUR`          | `100`                                                                                                                | Rate limit for API calls                                                                                                 |
| `CLAUDE_TIMEOUT_MINUTES`      | `15`                                                                                                                 | Timeout per loop driver invocation                                                                                       |
| `CLAUDE_OUTPUT_FORMAT`        | `json`                                                                                                               | Output format (json or text)                                                                                             |
| `ALLOWED_TOOLS`               | `Write,Read,Edit,MultiEdit,Glob,Grep,Task,TodoWrite,WebFetch,WebSearch,EnterPlanMode,ExitPlanMode,NotebookEdit,Bash` | Claude Code only. Ignored by codex, cursor, and copilot                                                                  |
| `CLAUDE_PERMISSION_MODE`      | `bypassPermissions`                                                                                                  | Claude Code only. Prevents interactive approval workflows from blocking unattended loops without relying on beta headers |
| `PERMISSION_DENIAL_MODE`      | `continue`                                                                                                           | How Ralph responds to permission denials: continue, halt, or threshold                                                   |
| `SESSION_CONTINUITY`          | `true`                                                                                                               | Maintain context across loops                                                                                            |
| `SESSION_EXPIRY_HOURS`        | `24`                                                                                                                 | Session expiration time                                                                                                  |
| `RALPH_VERBOSE`               | `false`                                                                                                              | Enable verbose logging                                                                                                   |
| `CB_NO_PROGRESS_THRESHOLD`    | `3`                                                                                                                  | Loops with no progress before circuit opens                                                                              |
| `CB_SAME_ERROR_THRESHOLD`     | `5`                                                                                                                  | Loops with same error before circuit opens                                                                               |
| `CB_OUTPUT_DECLINE_THRESHOLD` | `70`                                                                                                                 | Output decline percentage threshold                                                                                      |
| `CB_COOLDOWN_MINUTES`         | `30`                                                                                                                 | Minutes before OPEN auto-recovers to HALF_OPEN                                                                           |
| `CB_AUTO_RESET`               | `false`                                                                                                              | Reset circuit to CLOSED on startup                                                                                       |
| `TASK_SOURCES`                | `local`                                                                                                              | Where to import tasks from (local, beads, github)                                                                        |

### Generation

bmalph copies `ralphrc.template` to `.ralph/.ralphrc` during `bmalph init`. Untouched managed configs are updated on upgrade, while customized `.ralph/.ralphrc` files are preserved.

---

## Session Management

Ralph maintains session continuity across loop iterations using `--resume` with explicit session IDs.

### Session Continuity

Ralph uses `--resume <session_id>` instead of `--continue` to resume sessions. This ensures Ralph only resumes its own saved sessions and avoids hijacking unrelated active sessions.

This applies to every driver that exposes resumable IDs today:

- Claude Code
- OpenAI Codex
- Cursor

### Session Files

| File                            | Purpose                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `.ralph/.ralph_session`         | Current Ralph session state (active or reset/inactive)                                                       |
| `.ralph/.ralph_session_history` | History of last 50 session transitions                                                                       |
| `.ralph/.claude_session_id`     | Persisted driver session ID (shared filename for historical reasons; used by Claude Code, Codex, and Cursor) |

### Session Lifecycle

Sessions are automatically reset when:

- Circuit breaker opens (stagnation detected)
- Manual interrupt (Ctrl+C / SIGINT)
- Project completion (graceful exit)
- Manual circuit breaker reset (`bash .ralph/ralph_loop.sh --reset-circuit`)
- Manual session reset (`bash .ralph/ralph_loop.sh --reset-session`)

### Session Expiration

Sessions expire after 24 hours (configurable via `SESSION_EXPIRY_HOURS` in `.ralph/.ralphrc`). When expired:

- A new session is created automatically
- Previous context is not preserved
- Session history records the transition

### Session State Structure

Active session payload:

```json
{
  "session_id": "uuid-string",
  "created_at": "ISO-timestamp",
  "last_used": "ISO-timestamp"
}
```

Reset/inactive payload:

```json
{
  "session_id": "",
  "reset_at": "ISO-timestamp",
  "reset_reason": "reason string"
}
```

---

## Circuit Breaker

The circuit breaker prevents runaway loops by detecting stagnation.

### States

| State         | Description               | Action                    |
| ------------- | ------------------------- | ------------------------- |
| **CLOSED**    | Normal operation          | Loop continues            |
| **HALF_OPEN** | Monitoring after recovery | Testing if issue resolved |
| **OPEN**      | Halted due to stagnation  | Loop stops                |

### Thresholds

| Threshold                        | Default | Description                                        |
| -------------------------------- | ------- | -------------------------------------------------- |
| `CB_NO_PROGRESS_THRESHOLD`       | 3       | Open circuit after N loops with no file changes    |
| `CB_SAME_ERROR_THRESHOLD`        | 5       | Open circuit after N loops with repeated errors    |
| `CB_OUTPUT_DECLINE_THRESHOLD`    | 70%     | Open circuit if output declines by >N%             |
| `CB_PERMISSION_DENIAL_THRESHOLD` | 2       | Open circuit after N loops with permission denials |
| `CB_COOLDOWN_MINUTES`            | 30      | Minutes before OPEN auto-recovers to HALF_OPEN     |
| `CB_AUTO_RESET`                  | false   | Reset to CLOSED on startup (bypasses cooldown)     |

### Permission Denial Detection

When the active driver is denied permission to execute commands, Ralph:

1. Detects permission denials from the JSON output
2. Applies `PERMISSION_DENIAL_MODE` from `.ralph/.ralphrc`
3. Keeps `last_action: permission_denied` visible in the status file and dashboard

`PERMISSION_DENIAL_MODE` behavior:

- `continue` keeps looping and logs the denial
- `halt` stops immediately with reason `permission_denied`
- `threshold` keeps looping until `CB_PERMISSION_DENIAL_THRESHOLD` opens the circuit breaker

### Auto-Recovery Cooldown

After `CB_COOLDOWN_MINUTES` (default: 30) in OPEN state, the circuit auto-transitions to HALF_OPEN. From HALF_OPEN, if progress is detected, circuit goes to CLOSED; otherwise back to OPEN.

Set `CB_AUTO_RESET=true` in `.ralph/.ralphrc` to bypass cooldown entirely and reset to CLOSED on startup.

### Circuit Breaker State Structure

```json
{
  "state": "CLOSED|HALF_OPEN|OPEN",
  "consecutive_no_progress": 0,
  "consecutive_same_error": 0,
  "consecutive_permission_denials": 0,
  "last_progress_loop": 5,
  "total_opens": 0,
  "reason": "string (when OPEN)",
  "opened_at": "ISO-timestamp (when OPEN)",
  "current_loop": 10
}
```

### Recovery

To reset the circuit breaker:

```bash
bash .ralph/ralph_loop.sh --reset-circuit
```

---

## Exit Detection

Ralph uses multiple mechanisms to detect when to exit the loop.

### Exit Conditions

| Condition                           | Threshold | Description                              |
| ----------------------------------- | --------- | ---------------------------------------- |
| Consecutive done signals            | 2         | Exit on repeated completion signals      |
| Test-only loops                     | 3         | Exit if too many test-only iterations    |
| Fix plan complete                   | All [x]   | Exit when all tasks are marked complete  |
| EXIT_SIGNAL + completion_indicators | Both      | Dual verification for project completion |

### EXIT_SIGNAL Gate

The `completion_indicators` exit condition requires dual verification:

| completion_indicators | EXIT_SIGNAL | Result                             |
| --------------------- | ----------- | ---------------------------------- |
| >= 2                  | `true`      | **Exit** ("project_complete")      |
| >= 2                  | `false`     | **Continue** (agent still working) |
| >= 2                  | missing     | **Continue** (defaults to false)   |
| < 2                   | `true`      | **Continue** (threshold not met)   |

**Rationale:** Natural language patterns like "done" or "complete" can trigger false positives during productive work. By requiring an explicit `EXIT_SIGNAL` confirmation, Ralph avoids exiting mid-iteration.

When the agent outputs `STATUS: COMPLETE` with `EXIT_SIGNAL: false`, the explicit `false` takes precedence. This allows marking a phase complete while indicating more phases remain.

### RALPH_STATUS Block

The coding agent should include this status block at the end of each response:

```
---RALPH_STATUS---
STATUS: IN_PROGRESS | COMPLETE | BLOCKED
TASKS_COMPLETED_THIS_LOOP: 0 | 1
FILES_MODIFIED: <number>
TESTS_STATUS: PASSING | FAILING | NOT_RUN
WORK_TYPE: IMPLEMENTATION | TESTING | DOCUMENTATION | REFACTORING
EXIT_SIGNAL: false | true
RECOMMENDATION: <one line summary of what to do next>
---END_RALPH_STATUS---
```

### When to Set EXIT_SIGNAL: true

Set EXIT_SIGNAL to **true** when ALL conditions are met:

1. All items in `@fix_plan.md` are marked `[x]`
2. All tests are passing (or no tests exist for valid reasons)
3. No errors or warnings in the last execution
4. All requirements from specs/ are implemented
5. Nothing meaningful left to implement

### Progress Detection

Ralph detects progress through both uncommitted file changes AND git commits made within a loop. Before each loop, Ralph captures `git rev-parse HEAD`; if HEAD changes during the loop, committed files count as progress alongside working tree changes.

---

## Live Streaming

Ralph supports real-time streaming output with the `--live` flag.

### Usage

```bash
bash .ralph/ralph_loop.sh --live           # Live streaming output
bash .ralph/ralph_loop.sh --monitor --live # Live streaming with tmux monitoring
```

### How It Works

- Live mode switches the active driver to its structured streaming format and pipes the stream through `jq`
- Cursor background loop execution stays on `json` output and switches to `stream-json` for live display
- Claude Code also uses `stream-json` for live display, while Codex streams its native JSONL events directly
- Shows text deltas and tool invocations in real-time
- Requires `jq` and `stdbuf` (from coreutils); falls back to background mode if unavailable

### Monitoring Layout

When using `--monitor` with `--live`, tmux creates a 3-pane layout:

- **Left pane:** Ralph loop with live streaming
- **Right-top pane:** `tail -f .ralph/live.log` (live driver output)
- **Right-bottom pane:** status dashboard (`bmalph watch` when available)

---

## Troubleshooting

### Common Issues

#### Ralph exits too early

**Symptoms:** Loop stops before work is complete

**Causes:**

- EXIT_SIGNAL set to true prematurely
- completion_indicators triggered by natural language
- All `@fix_plan.md` items marked complete

**Solutions:**

1. Ensure EXIT_SIGNAL is only true when genuinely complete
2. Add remaining tasks to `@fix_plan.md`
3. Check `.ralph/.response_analysis` for exit reasons

#### Ralph doesn't exit when complete

**Symptoms:** Loop continues with busywork

**Causes:**

- EXIT_SIGNAL not being set to true
- `@fix_plan.md` has unmarked items
- completion_indicators threshold not met

**Solutions:**

1. Ensure RALPH_STATUS block is included in responses
2. Set EXIT_SIGNAL: true when all work is done
3. Mark all completed items in `@fix_plan.md`

#### Circuit breaker opens unexpectedly

**Symptoms:** "OPEN - stagnation detected" message

**Causes:**

- Same error recurring across loops
- No file changes for multiple loops
- Output volume declining significantly

**Solutions:**

1. Check `.ralph/logs/` for the recurring error
2. Fix the underlying issue causing the error
3. Reset circuit breaker: `bash .ralph/ralph_loop.sh --reset-circuit`

#### Permission denied blocks progress

**Symptoms:** "OPEN - permission_denied" message

**Causes:**

- The active driver denied permission to run commands
- `ALLOWED_TOOLS` in `.ralph/.ralphrc` too restrictive for Claude Code
- The active non-Claude driver rejected a tool under its native permission model

**Solutions:**

1. For Claude Code, update `ALLOWED_TOOLS` in `.ralph/.ralphrc` to include needed tools
2. For Claude Code unattended loops, keep `CLAUDE_PERMISSION_MODE="bypassPermissions"` in `.ralph/.ralphrc`
3. For codex, cursor, and copilot, review the driver's native permission settings; `ALLOWED_TOOLS` is ignored
4. If you want unattended behavior, keep `PERMISSION_DENIAL_MODE="continue"` in `.ralph/.ralphrc`
5. Reset circuit breaker if needed: `bash .ralph/ralph_loop.sh --reset-circuit`

#### Session expires mid-project

**Symptoms:** Context lost, session age > 24h

**Causes:**

- Long gaps between loop iterations
- Session not being refreshed

**Solutions:**

1. Sessions are designed to expire after 24h (configurable via `SESSION_EXPIRY_HOURS`)
2. Start a new session with `bash .ralph/ralph_loop.sh --reset-session`
3. Context will be rebuilt from `@fix_plan.md` and `specs/`

#### Cursor preflight fails

**Symptoms:** `bmalph doctor` or `bmalph run --driver cursor` fails before the loop starts

**Causes:**

- `command -v jq` fails in the bash environment Ralph uses
- `command -v cursor-agent` fails in that same bash environment
- `cursor-agent status` reports an authentication problem

**Solutions:**

1. Run `command -v jq` in the same bash shell Ralph uses and install `jq` if missing
2. Run `command -v cursor-agent` and ensure the official Cursor CLI is on the bash `PATH`
3. Run `cursor-agent status` and sign in to Cursor before starting Ralph

### Diagnostic Commands

```bash
# Check Ralph status
bash .ralph/ralph_loop.sh --status

# Check circuit breaker state
bash .ralph/ralph_loop.sh --circuit-status

# Reset circuit breaker
bash .ralph/ralph_loop.sh --reset-circuit

# Auto-reset circuit breaker (bypasses cooldown)
bash .ralph/ralph_loop.sh --auto-reset-circuit

# Reset session
bash .ralph/ralph_loop.sh --reset-session

# Enable live streaming
bash .ralph/ralph_loop.sh --live

# Live streaming with monitoring
bash .ralph/ralph_loop.sh --monitor --live
```

### Log Files

Loop execution logs are stored in `.ralph/logs/`:

- Each loop iteration creates a timestamped log file
- Logs contain Claude's output and status information
- Use logs to diagnose issues with specific iterations

### Status File Structure

`.ralph/status.json`:

```json
{
  "timestamp": "ISO-timestamp",
  "loop_count": 10,
  "calls_made_this_hour": 25,
  "max_calls_per_hour": 100,
  "last_action": "description",
  "status": "running|completed|halted|paused|stopped|success|graceful_exit|error",
  "exit_reason": "reason (if exited)",
  "next_reset": "timestamp for rate limit reset"
}
```

`bmalph status` normalizes these raw bash values to `running`, `blocked`, `completed`, `not_started`, or `unknown`.

---

## Error Detection

Ralph uses two-stage error filtering to eliminate false positives.

### Stage 1: JSON Field Filtering

Filters out JSON field patterns like `"is_error": false` that contain the word "error" but aren't actual errors.

### Stage 2: Actual Error Detection

Detects real error messages:

- Error prefixes: `Error:`, `ERROR:`, `error:`
- Context-specific: `]: error`, `Link: error`
- Occurrences: `Error occurred`, `failed with error`
- Exceptions: `Exception`, `Fatal`, `FATAL`

### Multi-line Error Matching

Ralph verifies ALL error lines appear in ALL recent history files before declaring a stuck loop, preventing false negatives when multiple distinct errors occur.

---

## Further Reading

- [BMAD-METHOD Documentation](https://github.com/bmad-code-org/BMAD-METHOD)
- [Ralph Repository](https://github.com/snarktank/ralph)
